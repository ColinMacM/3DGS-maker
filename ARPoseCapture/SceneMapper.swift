import ARKit
import CoreImage
import CoreML
import os
import SceneKit
import Vision

/// RGB-only point cloud: Depth Anything V2 depth for every saved picture, scaled to metres with ARKit's
/// feature points and back-projected into ARKit's world frame as coloured points.
///
/// Threading: `addPicture` and `reset` are called on the capture manager's frame queue; `pointsRoot` and
/// `onSummary` belong to the main thread; depth runs on a private queue. Camera images are shrunk to the
/// model's input size on the frame queue, so ARKit's own buffers are never held while the model runs.
final class SceneMapper {
    enum ModelState: Equatable {
        case notLoaded
        case loading
        case ready
        case failed
    }

    /// What the depth pipeline has produced so far in the current capture.
    struct Summary {
        var model = ModelState.notLoaded
        /// Pictures saved but not through depth yet (waiting for the model, or running).
        var pending = 0
        var picturesWithDepth = 0
        var picturesWithoutDepth = 0
        /// Dense points from depth.
        var points = 0
        /// ARKit's own tracked feature points, plotted for every picture as soon as it is taken.
        var featurePoints = 0
        /// Why the most recent picture without depth failed.
        var lastFailure: DepthFailure?
    }

    /// Points from the saved pictures: per picture one node of ARKit feature points, then one of depth points.
    let pointsRoot = SCNNode()

    /// Called on the main thread whenever the summary changes.
    var onSummary: ((Summary) -> Void)?

    /// Model input size, and the grid over it: one cell per 4 × 4 input pixels.
    private static let modelWidth = 518
    private static let modelHeight = 392
    private static let gridWidth = 129
    private static let gridHeight = 98
    private static let pointStride = 2

    private let log = Logger(subsystem: "ARPoseCapture", category: "depth")
    private let frameQueue: DispatchQueue
    /// Depth now runs once per picture, so it can have the priority of something the user waits for.
    private let depthQueue = DispatchQueue(label: "ARPoseCapture.depth", qos: .userInitiated)
    private let ciContext = CIContext()
    private let inputPool: CVPixelBufferPool?

    /// frameQueue. Bumped by reset() so results from an earlier capture are dropped.
    private var generation = 0

    // depthQueue
    private var request: VNCoreMLRequest?
    private var modelLoadAttempted = false
    private var rng = SystemRandomNumberGenerator()

    // main thread
    private var mainGeneration = 0
    private var summary = Summary()

    init(frameQueue: DispatchQueue) {
        self.frameQueue = frameQueue
        var pool: CVPixelBufferPool?
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: Self.modelWidth,
            kCVPixelBufferHeightKey: Self.modelHeight,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
        inputPool = pool
    }

    /// Starts loading the depth model if it is not loaded yet; called at app start. The first launch after
    /// install compiles it for the Neural Engine (3.6 s on an M-series Mac); Core ML caches that, so later
    /// launches load it in well under a second.
    func prepare() {
        depthQueue.async { [self] in loadModelIfNeeded() }
    }

    /// Drops all pictures and points (frameQueue).
    func reset() {
        generation += 1
        let generation = generation
        DispatchQueue.main.async { [self] in
            mainGeneration = generation
            pointsRoot.childNodes.forEach { $0.removeFromParentNode() }
            summary = Summary(model: summary.model)
            onSummary?(summary)
        }
    }

    /// Plots the picture's ARKit feature points right away, then estimates depth and adds its points
    /// (frameQueue).
    func addPicture(_ frame: ARFrame) {
        let generation = generation
        let featurePoints = frame.rawFeaturePoints?.points ?? []
        let featureNode = featurePoints.isEmpty ? nil : SCNNode(geometry: Self.pointGeometry(
            featurePoints, Array(repeating: Self.featurePointColor, count: featurePoints.count),
            size: 0.01, maxRadius: 4))
        let input = makeInput(frame)
        let hasInput = input != nil
        DispatchQueue.main.async { [self] in
            guard generation == mainGeneration else { return }
            if let featureNode { pointsRoot.addChildNode(featureNode) }
            summary.featurePoints += featurePoints.count
            if hasInput {
                summary.pending += 1
            } else {
                summary.picturesWithoutDepth += 1
                summary.lastFailure = .imageCopyFailed
            }
            onSummary?(summary)
        }
        guard let input else { return }

        depthQueue.async { [self] in
            let result = metricDepth(input)
            var node: SCNNode?
            var pointCount = 0
            switch result {
            case .success(let shot):
                let cloud = DepthMap.points(of: shot, colors: gridColors(input.image), stride: Self.pointStride)
                pointCount = cloud.points.count
                log.info("Picture depth: \(pointCount) points, median \(DepthMap.medianDepth(shot) ?? 0) m")
                node = SCNNode(geometry: Self.pointGeometry(cloud.points, cloud.colors,
                                                            size: pointSize(shot, stride: Self.pointStride),
                                                            maxRadius: 8))
            case .failure(let failure):
                log.error("Picture without depth: \(failure.description, privacy: .public)")
            }
            DispatchQueue.main.async { [self] in
                guard generation == mainGeneration else { return }
                summary.pending -= 1
                switch result {
                case .success:
                    summary.picturesWithDepth += 1
                    summary.points += pointCount
                    if let node { pointsRoot.addChildNode(node) }
                case .failure(let failure):
                    summary.picturesWithoutDepth += 1
                    summary.lastFailure = failure
                }
                onSummary?(summary)
            }
        }
    }

    /// depthQueue → main.
    private func publishModelState(_ state: ModelState) {
        DispatchQueue.main.async { [self] in
            summary.model = state
            onSummary?(summary)
        }
    }

    // MARK: - Depth

    /// What the depth pipeline needs from a frame: the camera image shrunk to the model's input size
    /// (stretched, so it covers the whole sensor image), the camera, and ARKit's feature points.
    private struct Input {
        let image: CVPixelBuffer
        let camera: GridCamera
        let featurePoints: [SIMD3<Float>]
    }

    /// frameQueue. The resize is a short GPU pass; afterwards nothing references ARKit's buffer.
    private func makeInput(_ frame: ARFrame) -> Input? {
        guard let inputPool else { return nil }
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, inputPool, &buffer) == kCVReturnSuccess, let buffer
        else { return nil }
        let source = CIImage(cvPixelBuffer: frame.capturedImage)
        let scaled = source.transformed(by: CGAffineTransform(
            scaleX: CGFloat(Self.modelWidth) / source.extent.width,
            y: CGFloat(Self.modelHeight) / source.extent.height))
        ciContext.render(scaled, to: buffer)
        let size = frame.camera.imageResolution
        let camera = GridCamera(cameraToWorld: frame.camera.transform, intrinsics: frame.camera.intrinsics,
                                sensorWidth: Int(size.width), sensorHeight: Int(size.height),
                                gridWidth: Self.gridWidth, gridHeight: Self.gridHeight)
        return Input(image: buffer, camera: camera, featurePoints: frame.rawFeaturePoints?.points ?? [])
    }

    /// depthQueue.
    private func metricDepth(_ input: Input) -> Result<DepthShot, DepthFailure> {
        loadModelIfNeeded()
        guard let request else { return .failure(.modelUnavailable) }
        guard let relative = relativeInverseDepth(input.image, request: request) else {
            return .failure(.inferenceFailed)
        }
        return DepthMap.metricShot(camera: input.camera, relative: relative,
                                   featurePoints: input.featurePoints, using: &rng)
    }

    /// depthQueue.
    private func loadModelIfNeeded() {
        guard !modelLoadAttempted else { return }
        modelLoadAttempted = true
        publishModelState(.loading)
        let start = Date()
        do {
            let configuration = MLModelConfiguration()
            // Off the GPU, which ARKit and SceneKit are using; on the Neural Engine it is as fast.
            configuration.computeUnits = .cpuAndNeuralEngine
            // 6-bit palettized weights: 19 MB instead of 50 MB, half the first-launch compile, and output
            // within 1% of the 16-bit model.
            let model = try VNCoreMLModel(for: DepthAnythingV2SmallF16P6(configuration: configuration).model)
            let request = VNCoreMLRequest(model: model)
            request.imageCropAndScaleOption = .scaleFill
            self.request = request
            log.info("Depth model loaded in \(Date().timeIntervalSince(start)) s")
            publishModelState(.ready)
        } catch {
            log.error("Depth model failed to load: \(error.localizedDescription, privacy: .public)")
            publishModelState(.failed)
        }
    }

    /// Depth Anything's relative inverse depth, sampled at each grid cell's centre (depthQueue).
    private func relativeInverseDepth(_ image: CVPixelBuffer, request: VNCoreMLRequest) -> [Float]? {
        do {
            try VNImageRequestHandler(cvPixelBuffer: image, orientation: .up).perform([request])
        } catch {
            log.error("Depth inference failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        guard let output = (request.results?.first as? VNPixelBufferObservation)?.pixelBuffer,
              CVPixelBufferGetPixelFormatType(output) == kCVPixelFormatType_OneComponent16Half
        else { return nil }
        CVPixelBufferLockBaseAddress(output, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(output, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(output) else { return nil }
        let width = CVPixelBufferGetWidth(output)
        let height = CVPixelBufferGetHeight(output)
        let rowBytes = CVPixelBufferGetBytesPerRow(output)
        var grid = [Float](repeating: 0, count: Self.gridWidth * Self.gridHeight)
        for y in 0..<Self.gridHeight {
            let sy = Int((Float(y) + 0.5) / Float(Self.gridHeight) * Float(height))
            let row = (base + sy * rowBytes).assumingMemoryBound(to: Float16.self)
            for x in 0..<Self.gridWidth {
                let sx = Int((Float(x) + 0.5) / Float(Self.gridWidth) * Float(width))
                grid[y * Self.gridWidth + x] = Float(row[sx])
            }
        }
        return grid
    }

    /// The camera image averaged down to one RGB colour per grid cell.
    private func gridColors(_ image: CVPixelBuffer) -> [SIMD3<Float>] {
        let source = CIImage(cvPixelBuffer: image)
        let scaled = source.transformed(by: CGAffineTransform(
            scaleX: CGFloat(Self.gridWidth) / source.extent.width,
            y: CGFloat(Self.gridHeight) / source.extent.height))
        var bytes = [UInt8](repeating: 0, count: Self.gridWidth * Self.gridHeight * 4)
        ciContext.render(scaled, toBitmap: &bytes, rowBytes: Self.gridWidth * 4,
                         bounds: CGRect(x: 0, y: 0, width: Self.gridWidth, height: Self.gridHeight),
                         format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        return (0..<(Self.gridWidth * Self.gridHeight)).map { i in
            SIMD3(Float(bytes[i * 4]), Float(bytes[i * 4 + 1]), Float(bytes[i * 4 + 2])) / 255
        }
    }

    // MARK: - Geometry

    /// World-space size of one sample spacing at the shot's median depth, so dots roughly tile the surface.
    private func pointSize(_ shot: DepthShot, stride: Int) -> CGFloat {
        CGFloat((DepthMap.medianDepth(shot) ?? 1) * Float(stride) / shot.camera.fx)
    }

    /// ARKit feature points have no colour of their own; cyan keeps them apart from the RGB depth points.
    private static let featurePointColor = SIMD3<Float>(0.3, 0.9, 1)

    /// Vertex colours drawn unlit. Shared by every cloud, so a new picture adds no new material.
    private static let pointMaterial: SCNMaterial = {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = UIColor.white
        return material
    }()

    /// `size` is the world-space point size; on screen each point stays between 1.5 and `maxRadius` points.
    private static func pointGeometry(_ points: [SIMD3<Float>], _ colors: [SIMD3<Float>], size: CGFloat,
                                      maxRadius: CGFloat) -> SCNGeometry {
        let stride = MemoryLayout<SIMD3<Float>>.stride
        let vertices = SCNGeometrySource(
            data: points.withUnsafeBytes { Data($0) }, semantic: .vertex, vectorCount: points.count,
            usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: stride)
        let vertexColors = SCNGeometrySource(
            data: colors.withUnsafeBytes { Data($0) }, semantic: .color, vectorCount: colors.count,
            usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: stride)
        let element = SCNGeometryElement(indices: Array(0..<UInt32(points.count)), primitiveType: .point)
        element.pointSize = size
        element.minimumPointScreenSpaceRadius = 1.5
        element.maximumPointScreenSpaceRadius = maxRadius
        let geometry = SCNGeometry(sources: [vertices, vertexColors], elements: [element])
        geometry.materials = [pointMaterial]
        return geometry
    }
}
