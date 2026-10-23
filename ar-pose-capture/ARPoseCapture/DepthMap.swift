import Foundation
import simd

/// Pinhole camera on a coarse grid laid over the full sensor image, in ARKit's world frame.
/// Grid coordinates are continuous: cell (i, j) spans [i, i + 1) × [j, j + 1), row 0 at the image top.
struct GridCamera {
    /// ARKit sensor camera-to-world (X right, Y up, Z backward, looking down -Z).
    let cameraToWorld: simd_float4x4
    let worldToCamera: simd_float4x4
    let width: Int
    let height: Int
    let fx: Float
    let fy: Float
    let cx: Float
    let cy: Float

    init(cameraToWorld: simd_float4x4, intrinsics k: simd_float3x3, sensorWidth: Int, sensorHeight: Int,
         gridWidth: Int, gridHeight: Int) {
        self.cameraToWorld = cameraToWorld
        worldToCamera = cameraToWorld.inverse
        width = gridWidth
        height = gridHeight
        let sx = Float(gridWidth) / Float(sensorWidth)
        let sy = Float(gridHeight) / Float(sensorHeight)
        // simd is column-major: k[column][row]
        fx = k[0][0] * sx
        fy = k[1][1] * sy
        cx = k[2][0] * sx
        cy = k[2][1] * sy
    }

    /// World point at grid position (x, y) and distance `depth` along the view direction.
    func worldPoint(x: Float, y: Float, depth: Float) -> SIMD3<Float> {
        let p = SIMD4<Float>((x - cx) / fx * depth, -(y - cy) / fy * depth, -depth, 1)
        let w = cameraToWorld * p
        return SIMD3(w.x, w.y, w.z)
    }

    /// Grid position and depth of a world point, or nil when it is behind the camera.
    func project(_ world: SIMD3<Float>) -> (x: Float, y: Float, depth: Float)? {
        let p = worldToCamera * SIMD4<Float>(world, 1)
        let depth = -p.z
        guard depth > 1e-3 else { return nil }
        return (fx * p.x / depth + cx, fy * -p.y / depth + cy, depth)
    }
}

/// Metric depth for one camera on its grid; 0 means unknown.
struct DepthShot {
    let camera: GridCamera
    /// Metres along the view direction, row-major, top row first.
    let depth: [Float]

    func depth(atX x: Int, y: Int) -> Float { depth[y * camera.width + x] }
}

/// Why a picture got no metric depth.
enum DepthFailure: Error, CustomStringConvertible {
    case modelUnavailable
    case imageCopyFailed
    case inferenceFailed
    /// Fewer ARKit feature points in view than the scale fit needs.
    case tooFewFeaturePoints(Int)
    /// Feature points in view, but too few of them agree on one scale.
    case inconsistentScale(samples: Int, inliers: Int)

    var description: String {
        switch self {
        case .modelUnavailable: "depth model failed to load"
        case .imageCopyFailed: "could not copy the camera image for depth"
        case .inferenceFailed: "depth model failed on this picture"
        case .tooFewFeaturePoints(let n): "only \(n) tracked feature points in view (need \(DepthMap.minSamples))"
        case .inconsistentScale(let samples, let inliers): "only \(inliers) of \(samples) feature points agree on a scale"
        }
    }
}

enum DepthMap {
    /// Depths beyond this are dropped; monocular depth is unreliable far away.
    static let maxDepth: Float = 8
    /// Neighbouring cells whose depths differ by more than this fraction straddle an edge.
    static let edgeTolerance: Float = 0.06
    /// Feature points needed in view, and agreeing on one scale, to fit depth.
    static let minSamples = 12

    /// Fits metric inverse depth = a · relative + b to sparse metric samples, as Depth Anything predicts
    /// inverse depth only up to scale and shift. RANSAC over sample pairs, then a least-squares refit on
    /// the inliers minimising relative error.
    static func fitInverseDepth<G: RandomNumberGenerator>(relative: [Float], metricDepth: [Float],
                                                         using generator: inout G)
        -> Result<(a: Float, b: Float), DepthFailure> {
        let n = relative.count
        guard n >= minSamples else { return .failure(.tooFewFeaturePoints(n)) }
        let inverse = metricDepth.map { 1 / $0 }
        let threshold: Float = 0.1

        func inliers(a: Float, b: Float) -> [Int] {
            (0..<n).filter { i in
                let predicted = a * relative[i] + b
                return predicted > 0 && abs(predicted - inverse[i]) < threshold * inverse[i]
            }
        }

        var best: [Int] = []
        for _ in 0..<200 {
            let i = Int.random(in: 0..<n, using: &generator)
            let j = Int.random(in: 0..<n, using: &generator)
            let dr = relative[i] - relative[j]
            guard abs(dr) > 1e-4 else { continue }
            let a = (inverse[i] - inverse[j]) / dr
            let b = inverse[i] - a * relative[i]
            let candidate = inliers(a: a, b: b)
            if candidate.count > best.count { best = candidate }
        }
        guard best.count >= max(minSamples, Int(Float(n) * 0.4)) else {
            return .failure(.inconsistentScale(samples: n, inliers: best.count))
        }

        // Weighted least squares of (a·r + b − w) / w over the inliers.
        var srr = 0.0, sr = 0.0, s1 = 0.0, srw = 0.0, sw = 0.0
        for i in best {
            let weight = 1 / Double(inverse[i] * inverse[i])
            let r = Double(relative[i]), w = Double(inverse[i])
            srr += weight * r * r
            sr += weight * r
            s1 += weight
            srw += weight * r * w
            sw += weight * w
        }
        let det = srr * s1 - sr * sr
        guard abs(det) > 1e-12 else { return .failure(.inconsistentScale(samples: n, inliers: best.count)) }
        let a = (srw * s1 - sr * sw) / det
        let b = (srr * sw - sr * srw) / det
        return .success((Float(a), Float(b)))
    }

    /// Converts a relative inverse-depth grid to metric depth with ARKit feature points (world positions
    /// seen in the same frame) as the scale reference.
    static func metricShot<G: RandomNumberGenerator>(camera: GridCamera, relative: [Float],
                                                    featurePoints: [SIMD3<Float>],
                                                    using generator: inout G) -> Result<DepthShot, DepthFailure> {
        var sampleRelative: [Float] = []
        var sampleDepth: [Float] = []
        for point in featurePoints {
            guard let p = camera.project(point), p.depth < maxDepth,
                  p.x >= 0, p.y >= 0, p.x < Float(camera.width), p.y < Float(camera.height) else { continue }
            sampleRelative.append(relative[Int(p.y) * camera.width + Int(p.x)])
            sampleDepth.append(p.depth)
        }
        let fit: (a: Float, b: Float)
        switch fitInverseDepth(relative: sampleRelative, metricDepth: sampleDepth, using: &generator) {
        case .success(let value): fit = value
        case .failure(let failure): return .failure(failure)
        }
        let depth = relative.map { r -> Float in
            let inverse = fit.a * r + fit.b
            guard inverse > 1 / maxDepth else { return 0 }
            return 1 / inverse
        }
        return .success(DepthShot(camera: camera, depth: depth))
    }

    /// True when the cell's depth is known and none of its 4-neighbours sits across a depth edge,
    /// which is where monocular depth smears foreground into background.
    static func isStable(_ shot: DepthShot, x: Int, y: Int) -> Bool {
        let d = shot.depth(atX: x, y: y)
        guard d > 0 else { return false }
        for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
        where nx >= 0 && ny >= 0 && nx < shot.camera.width && ny < shot.camera.height {
            let n = shot.depth(atX: nx, y: ny)
            if n <= 0 || abs(n - d) > edgeTolerance * d { return false }
        }
        return true
    }

    /// World points of every `stride`-th stable cell, with the matching entry of `colors`
    /// (one per grid cell, same layout as the depth).
    static func points(of shot: DepthShot, colors: [SIMD3<Float>], stride: Int)
        -> (points: [SIMD3<Float>], colors: [SIMD3<Float>]) {
        var points: [SIMD3<Float>] = []
        var pointColors: [SIMD3<Float>] = []
        for y in Swift.stride(from: stride / 2, to: shot.camera.height, by: stride) {
            for x in Swift.stride(from: stride / 2, to: shot.camera.width, by: stride) where isStable(shot, x: x, y: y) {
                points.append(shot.camera.worldPoint(x: Float(x) + 0.5, y: Float(y) + 0.5,
                                                     depth: shot.depth(atX: x, y: y)))
                pointColors.append(colors[y * shot.camera.width + x])
            }
        }
        return (points, pointColors)
    }

    /// Median known depth, used to size points on screen.
    static func medianDepth(_ shot: DepthShot) -> Float? {
        let known = shot.depth.filter { $0 > 0 }.sorted()
        return known.isEmpty ? nil : known[known.count / 2]
    }
}
