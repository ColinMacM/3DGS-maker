import ARKit
import CoreImage
import Network
import SceneKit
import Security
import simd

/// Runs camera-only ARKit world tracking and manually captures portrait JPEGs with matching
/// poses.txt, intrinsics.txt, reference.csv and quaternion.txt, locally or over USB or Wi-Fi.
/// The shutter waits for a sufficiently steady frame; success means a local write or desktop ACK.
///
/// ARKit delivers frames on `frameQueue`, not the main thread, so a busy main thread (SwiftUI, SceneKit)
/// never holds up ARKit's frames. Capture state lives on that queue; the UI gets copies on the main thread.
final class CaptureManager: NSObject, ObservableObject, ARSessionDelegate {
    /// Pictures are only taken while the predicted motion blur is at most this many pixels.
    static let maxBlurPixels = 1.5
    /// How long the shutter waits for a steady frame before giving up.
    private static let steadyTimeout: TimeInterval = 2
    /// 4K camera stream when the device has one. Also sets the AR view's render rate: drawing the scene
    /// faster than the camera delivers frames only adds GPU work.
    static let videoFormat = ARWorldTrackingConfiguration.recommendedVideoFormatFor4KResolution

    let session = ARSession()
    /// How many of the latest pictures keep a frustum marker in each view.
    private static let visibleFrustums = 10
    /// Drawn over the camera image (ARKit world coordinates): frustums and the origin. Main thread.
    let arRoot = SCNNode()
    /// Drawn in the black point-map view (ARKit world coordinates): the point cloud, frustums and the
    /// origin. Main thread.
    let mapRoot = SCNNode()
    private let arFrustumRoot = SCNNode()
    private let mapFrustumRoot = SCNNode()
    /// Axes at the chosen (0, 0, 0), hidden until it is set; one per view, as a node has one parent.
    private let arOriginMarker = CaptureManager.originMarker()
    private let mapOriginMarker = CaptureManager.originMarker()
    private let mapper: SceneMapper

    // MARK: UI state (main thread)

    enum Destination: String, CaseIterable, Identifiable {
        case local = "On iPhone"
        case wired = "USB stream"
        case wifi = "Wi-Fi stream"
        var id: Self { self }
    }

    @Published private(set) var destination: Destination = .local
    @Published private(set) var streamStatus = "USB stream off"
    @Published private(set) var streamReady = false
    @Published private(set) var wifiReady = false
    @Published private(set) var wifiStatus = "Set up a Wi-Fi receiver"
    @Published private(set) var wifiHost = UserDefaults.standard.string(forKey: "wifiHost") ?? ""
    @Published private(set) var wifiPort = UserDefaults.standard.string(forKey: "wifiPort") ?? "39003"
    @Published private(set) var wifiPairingCode = ""

    var destinationReady: Bool {
        switch destination {
        case .local: return true
        case .wired: return streamReady
        case .wifi: return wifiReady
        }
    }
    @Published private(set) var transferInProgress = false

    @Published var frameCount = 0
    @Published var trackingStatus = "Starting…"
    @Published var trackingIsNormal = false
    @Published var sessionURL: URL?
    /// Pose and blur readout, refreshed at 10 Hz. Kept out of this object's own @Published properties so
    /// only the readout rows re-render at that rate, not the whole screen.
    let readout = LiveReadout()
    /// Where (0, 0, 0) stands. Pictures can only be taken once it is set in this session.
    enum OriginState {
        /// No origin, and none saved from an earlier session.
        case notSet
        /// An earlier session's origin is saved; ARKit has not relocalized to it yet.
        case searching
        /// Set in this session; its world map is not on disk yet.
        case unsaved
        /// Set (or restored) and saved, so the next launch can find it again.
        case saved
    }
    @Published private(set) var originState = OriginState.notSet
    var originIsSet: Bool { originState == .unsaved || originState == .saved }
    var hasSavedOrigin: Bool { originState == .searching || originState == .saved }
    var originStatus: String {
        switch originState {
        case .notSet: return "Set origin with scope"
        case .searching: return "Finding saved origin – view the area where it was set"
        case .unsaved: return "Origin set – keep scanning to save it"
        case .saved: return "Origin set and saved"
        }
    }
    /// True between tapping the shutter and a steady frame being saved (or the wait timing out).
    @Published var waitingForSteadyFrame = false
    @Published var shutterMessage: String?
    /// Depth and point-cloud progress for the current capture.
    @Published var depthSummary = SceneMapper.Summary()
    /// Focus, exposure and white balance are frozen (see CameraLock); pictures need this.
    @Published private(set) var cameraLocked = false
    @Published private(set) var cameraLocking = false
    /// The locked values; nil while the camera is in auto mode.
    @Published private(set) var cameraSettings: CameraLock.Settings?
    private var cameraLockAttempt: UUID?

    // MARK: Capture state (frameQueue)

    private let frameQueue = DispatchQueue(label: "ARPoseCapture.frames", qos: .userInteractive)
    private let ioQueue = DispatchQueue(label: "ARPoseCapture.io")
    private let ciContext = CIContext()
    private var tracking = false
    /// ARKit-world transform chosen as (0, 0, 0); nil until set or restored.
    private var origin: simd_float4x4?
    /// The session's origin anchor. It is saved in the world map, so a later session that relocalizes
    /// against that map gets it back at the same physical place.
    private var originAnchorID: UUID?
    /// Bumped whenever the saved origin is replaced or forgotten, so stale world-map saves are dropped.
    private var originGeneration = 0
    /// The world map should be (re)saved: the origin is new, or more of the scene has been mapped.
    private var worldMapDirty = false
    private var worldMapSaving = false
    private var lastWorldMapSave: TimeInterval = -.infinity
    /// `originGeneration` of the last delete on ioQueue; only saves from that generation are written.
    private var ioOriginGeneration = 0
    private var originRequested = false
    private var shutterArmed = false
    private var steadyDeadline: TimeInterval?
    private var steadyTimer: DispatchWorkItem?
    /// Recent (timestamp, camera transform) pairs for the motion blur estimate.
    private var recentPoses: [(time: TimeInterval, transform: simd_float4x4)] = []
    private var lastReadout: TimeInterval = 0
    private var capture: OpenCapture?
    private var pictureIndex = 0
    private var captureDestination: Destination = .local
    private var sessionID = UUID().uuidString
    private var activeShot: UUID?
    private var encodingShot: UUID?
    private var wiredReady = false
    private var wirelessReady = false
    private struct WiFiConfiguration {
        let host: String
        let port: UInt16
        let pairingCode: String
    }
    private var wifiConfiguration: WiFiConfiguration?
    private lazy var usbStream = makeStream(mode: .usb)
    private lazy var wifiStream = makeStream(mode: .wifi)

    private func makeStream(mode: CaptureStream.Mode) -> CaptureStream {
        let stream = CaptureStream(queue: frameQueue, mode: mode)
        stream.onStatus = { [weak self] ready, status in
            guard let self else { return }
            let selected = mode == .usb ? self.captureDestination == .wired : self.captureDestination == .wifi
            if mode == .usb { self.wiredReady = ready } else { self.wirelessReady = ready }
            if !ready, selected, self.shutterArmed { self.finishSteadyWait(message: status) }
            DispatchQueue.main.async { [self] in
                if mode == .usb {
                    self.streamReady = ready
                    self.streamStatus = status
                } else {
                    self.wifiReady = ready
                    self.wifiStatus = status
                }
            }
        }
        return stream
    }

    private var selectedStream: CaptureStream? {
        switch captureDestination {
        case .local: return nil
        case .wired: return usbStream
        case .wifi: return wifiStream
        }
    }

    private var captureDestinationReady: Bool {
        switch captureDestination {
        case .local: return true
        case .wired: return wiredReady
        case .wifi: return wirelessReady
        }
    }

    private func startSelectedStream() {
        switch captureDestination {
        case .local: break
        case .wired:
            usbStream.startUSB(sessionID: sessionID, headers: exportHeaders)
        case .wifi:
            guard let config = wifiConfiguration else {
                DispatchQueue.main.async { [self] in wifiStatus = "Set up a Wi-Fi receiver" }
                return
            }
            wifiStream.startWiFi(host: config.host, port: config.port, pairingCode: config.pairingCode,
                                 sessionID: sessionID, headers: exportHeaders)
        }
    }

    private var exportHeaders: [String: String] {
        ["poses.txt": "", "intrinsics.txt": "# label fx fy cx cy width height\n",
         "reference.csv": PoseMath.referenceHeader, "quaternion.txt": PoseMath.quaternionHeader]
    }

    /// The capture folder being written and its open text files.
    private struct OpenCapture {
        let folder: URL
        let poses: FileHandle
        let intrinsics: FileHandle
        let reference: FileHandle
        let quaternion: FileHandle
    }

    override init() {
        mapper = SceneMapper(frameQueue: frameQueue)
        super.init()
        session.delegate = self
        session.delegateQueue = frameQueue
        arRoot.addChildNode(arFrustumRoot)
        arRoot.addChildNode(arOriginMarker)
        mapRoot.addChildNode(mapper.pointsRoot)
        mapRoot.addChildNode(mapFrustumRoot)
        mapRoot.addChildNode(mapOriginMarker)
        mapper.onSummary = { [weak self] summary in self?.depthSummary = summary }
        do {
            wifiPairingCode = try Self.loadPairingCode()
            if let port = UInt16(wifiPort), port > 0, Self.validWiFiHost(wifiHost),
               CaptureStream.isLowerHex(wifiPairingCode, count: 32) {
                wifiConfiguration = WiFiConfiguration(host: wifiHost, port: port, pairingCode: wifiPairingCode)
                wifiStatus = "Wi-Fi receiver not connected"
            }
        } catch {
            wifiStatus = "Could not load Wi-Fi pairing key: \(error.localizedDescription)"
        }
    }

    /// Starts tracking. If an earlier session saved its origin, ARKit relocalizes against that session's
    /// world map and the origin comes back once tracking is normal (see `session(_:didUpdate:)`).
    func startSession() {
        mapper.prepare()
        // A world map can be megabytes; decode it off the main thread.
        ioQueue.async { [self] in
            var loadError: String?
            var map: ARWorldMap?
            do {
                map = try Self.loadWorldMap()
            } catch {
                loadError = "Saved origin could not be read – set a new origin (\(error.localizedDescription))"
            }
            let anchorID = map?.anchors.first { $0.name == Self.originAnchorName }?.identifier
            DispatchQueue.main.async { [self] in
                let config = ARWorldTrackingConfiguration()
                // Gravity-aligned, Y up. No sceneReconstruction / sceneDepth, so no LiDAR is used.
                config.worldAlignment = .gravity
                config.planeDetection = [.horizontal, .vertical]
                if let format = Self.videoFormat {
                    config.videoFormat = format
                }
                config.initialWorldMap = anchorID == nil ? nil : map
                // Explicit although it is ARKit's default: tone mapping must not vary between pictures.
                config.videoHDRAllowed = false
                session.run(config, options: [.resetTracking, .removeExistingAnchors])
                // Running reconfigures the camera into auto mode.
                cameraLockAttempt = nil
                cameraLocking = false
                cameraLocked = false
                cameraSettings = nil
                frameQueue.async { [self] in
                    origin = nil
                    originAnchorID = anchorID
                    worldMapDirty = false
                    DispatchQueue.main.async { [self] in
                        originState = anchorID == nil ? .notSet : .searching
                        arOriginMarker.isHidden = true
                        mapOriginMarker.isHidden = true
                        if let loadError { shutterMessage = loadError }
                    }
                    startSelectedStream()
                }
            }
        }
    }

    /// Deletes the saved origin and restarts tracking without it, e.g. when relocalization never succeeds.
    func forgetSavedOrigin() {
        guard !waitingForSteadyFrame, !transferInProgress else { return }
        frameQueue.async { [self] in
            guard activeShot == nil, encodingShot == nil, !shutterArmed else { return }
            resetCapture(message: nil)
            originGeneration += 1
            let generation = originGeneration
            ioQueue.async { [self] in
                deleteWorldMap(generation: generation)
                DispatchQueue.main.async { [self] in startSession() }
            }
        }
    }

    private static let originAnchorName = "ARPoseCapture.origin"
    /// Outside Documents, which is shared through the Files app with the capture folders.
    private static var worldMapURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("origin.worldmap")
    }
    /// Minimum time between world-map saves; each one archives the whole map.
    private static let worldMapSaveInterval: TimeInterval = 5

    /// nil when nothing is saved (ioQueue).
    private static func loadWorldMap() throws -> ARWorldMap? {
        guard FileManager.default.fileExists(atPath: worldMapURL.path) else { return nil }
        let data = try Data(contentsOf: worldMapURL)
        return try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: data)
    }

    /// Removes the saved map and invalidates saves from older generations (ioQueue).
    private func deleteWorldMap(generation: Int) {
        ioOriginGeneration = generation
        try? FileManager.default.removeItem(at: Self.worldMapURL)
    }

    func pauseSession() {
        session.pause()
        frameQueue.async { [self] in
            resetCapture(message: "Capture paused")
            usbStream.stop(message: "USB stream paused")
            wifiStream.stop(message: "Wi-Fi stream paused")
        }
    }

    func setDestination(_ destination: Destination) {
        guard self.destination != destination, !waitingForSteadyFrame, !transferInProgress else { return }
        self.destination = destination
        if destination == .wired { streamReady = false }
        if destination == .wifi { wifiReady = false }
        frameQueue.async { [self] in
            resetCapture(message: nil)
            captureDestination = destination
            // Selecting storage does not own either connection's lifetime. A return announces
            // the new session over the same authenticated socket; inactive sockets stay idle.
            startSelectedStream()
        }
    }

    /// Explicit settings changes may replace the Wi-Fi socket; destination changes never do.
    func connectWiFi(host: String, port: String, pairingCode: String) {
        guard !waitingForSteadyFrame, !transferInProgress else { return }
        let host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let port = port.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.validWiFiHost(host) else {
            wifiStatus = "Enter a computer IP address or DNS name, without a scheme, port or path"
            return
        }
        guard !port.isEmpty, port.utf8.allSatisfy({ (48...57).contains($0) }),
              let number = UInt16(port), number > 0 else {
            wifiStatus = "Enter a port from 1 to 65535"
            return
        }
        guard CaptureStream.isLowerHex(key, count: 32) else {
            wifiStatus = "Enter the receiver's 32-character hexadecimal pairing key"
            return
        }
        do {
            try Self.savePairingCode(key)
        } catch {
            wifiStatus = "Could not save Wi-Fi pairing key: \(error.localizedDescription)"
            return
        }
        wifiHost = host
        wifiPort = String(number)
        wifiPairingCode = key
        UserDefaults.standard.set(host, forKey: "wifiHost")
        UserDefaults.standard.set(String(number), forKey: "wifiPort")
        wifiReady = false
        wifiStatus = "Connecting to \(host):\(number)…"
        let config = WiFiConfiguration(host: host, port: number, pairingCode: key)
        frameQueue.async { [self] in
            guard activeShot == nil, encodingShot == nil, !shutterArmed else { return }
            wifiConfiguration = config
            wifiStream.stop(message: "Updating Wi-Fi receiver")
            if captureDestination == .wifi { resetCapture(message: nil) }
            wifiStream.startWiFi(host: config.host, port: config.port, pairingCode: config.pairingCode,
                                 sessionID: sessionID, headers: exportHeaders)
        }
    }

    func disconnectWiFi() {
        guard !waitingForSteadyFrame, !transferInProgress else { return }
        wifiReady = false
        frameQueue.async { [self] in
            guard activeShot == nil, encodingShot == nil, !shutterArmed else { return }
            if captureDestination == .wifi { resetCapture(message: nil) }
            wifiStream.stop(message: "Wi-Fi disconnected")
        }
    }

    private static func validWiFiHost(_ host: String) -> Bool {
        if IPv4Address(host) != nil || IPv6Address(host) != nil { return true }
        guard !host.isEmpty, host.utf8.count <= 253 else { return false }
        let name = host.hasSuffix(".") ? String(host.dropLast()) : host
        return name.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-" &&
                label.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) ||
                    (97...122).contains($0) || $0 == 45 }
        }
    }

    private static var pairingKeyQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Bundle.main.bundleIdentifier ?? "ARPoseCapture",
         kSecAttrAccount as String: "WiFiPairingKey"]
    }

    private static func loadPairingCode() throws -> String {
        var query = pairingKeyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data,
              let code = String(data: data, encoding: .utf8) else {
            throw CaptureStream.StreamError(message: "Keychain read failed (\(status))")
        }
        return code
    }

    private static func savePairingCode(_ code: String) throws {
        let query = pairingKeyQuery
        let attributes: [String: Any] = [
            kSecValueData as String: Data(code.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw CaptureStream.StreamError(message: "Keychain write failed (\(status))")
        }
    }

    /// Makes the phone's position at the next frame (0, 0, 0), replacing any saved origin. Poses from before
    /// and after would not share a frame, so this also finishes the current capture folder; the next picture
    /// starts a new one.
    func setOrigin() {
        frameQueue.async { [self] in originRequested = true }
    }

    /// Locking freezes focus, exposure and white balance at what auto mode shows now, so meter on the
    /// subject first. Unlocking returns to auto.
    func setCameraLocked(_ locked: Bool) {
        guard !cameraLocking, !waitingForSteadyFrame, !transferInProgress else { return }
        guard locked else {
            do {
                try CameraLock.unlock()
            } catch {
                shutterMessage = "Could not unlock camera: \(error.localizedDescription)"
                return
            }
            cameraLocked = false
            cameraSettings = nil
            return
        }
        let attempt = UUID()
        cameraLockAttempt = attempt
        cameraLocking = true
        CameraLock.lock { result in
            DispatchQueue.main.async { [self] in
                guard cameraLockAttempt == attempt else { return }
                cameraLockAttempt = nil
                cameraLocking = false
                switch result {
                case .success(let settings):
                    cameraLocked = true
                    cameraSettings = settings
                    shutterMessage = nil
                case .failure(let error):
                    shutterMessage = "Could not lock camera: \(error.localizedDescription)"
                }
            }
        }
        // The camera confirms each setting from a delivered frame; give up if frames have stopped.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [self] in
            guard cameraLockAttempt == attempt else { return }
            cameraLockAttempt = nil
            cameraLocking = false
            shutterMessage = "Camera did not confirm the lock – try again"
        }
    }

    /// Arms the shutter: the next frame steady enough (see maxBlurPixels) within steadyTimeout is saved.
    func takePicture() {
        guard originIsSet, trackingIsNormal, cameraLocked, !waitingForSteadyFrame, !transferInProgress,
              destinationReady else { return }
        transferInProgress = true
        waitingForSteadyFrame = true
        shutterMessage = "Hold still…"
        frameQueue.async { [self] in
            guard activeShot == nil, encodingShot == nil,
                  captureDestinationReady else {
                finishSteadyWait(message: "Capture destination is not ready")
                publishTransferState()
                return
            }
            // ARKit may restart the camera (e.g. after an interruption), which undoes the lock.
            guard CameraLock.isLocked else {
                finishSteadyWait(message: "Camera settings were reset – lock the camera again")
                publishTransferState()
                DispatchQueue.main.async { [self] in
                    cameraLocked = false
                    cameraSettings = nil
                }
                return
            }
            let shot = UUID()
            activeShot = shot
            shutterArmed = true
            steadyDeadline = nil
            let timer = DispatchWorkItem { [weak self] in
                guard let self, self.shutterArmed, self.activeShot == shot else { return }
                self.finishSteadyWait(message: "No steady camera frame – no picture taken")
            }
            steadyTimer = timer
            frameQueue.asyncAfter(deadline: .now() + Self.steadyTimeout + 1, execute: timer)
        }
    }

    // MARK: - ARSessionDelegate (frameQueue)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let blur = motionBlur(frame)
        let frameTracking: Bool
        if case .normal = frame.camera.trackingState { frameTracking = true } else { frameTracking = false }
        // A loaded world map's anchors are only placed correctly once ARKit has relocalized, which is
        // when tracking becomes normal.
        if origin == nil, frameTracking, let id = originAnchorID,
           let anchor = frame.anchors.first(where: { $0.identifier == id }) {
            applyOrigin(anchor.transform, state: .saved)
        }
        if originRequested {
            originRequested = false
            if tracking { setOrigin(frame) }
        }
        if worldMapDirty, !worldMapSaving, origin != nil, frameTracking,
           frame.timestamp - lastWorldMapSave >= Self.worldMapSaveInterval,
           frame.worldMappingStatus == .mapped || frame.worldMappingStatus == .extending {
            saveWorldMap(at: frame.timestamp)
        }
        if shutterArmed {
            let deadline = steadyDeadline ?? frame.timestamp + Self.steadyTimeout
            steadyDeadline = deadline
            if !tracking || origin == nil {
                finishSteadyWait(message: "Tracking lost – no picture taken")
            } else if blur <= Self.maxBlurPixels {
                finishSteadyWait(message: nil)
                savePicture(frame)
            } else if frame.timestamp > deadline {
                finishSteadyWait(message: "Too shaky – no picture taken")
            }
        }

        // 10 Hz is plenty for the on-screen readout.
        guard frame.timestamp - lastReadout >= 0.1 else { return }
        lastReadout = frame.timestamp
        let pose = PoseMath.cameraPose(frame.camera.transform, origin: origin ?? matrix_identity_float4x4)
        let t = pose.columns.3
        let value = LiveReadout.Value(position: SIMD3<Float>(t.x, t.y, t.z),
                                      quaternion: PoseMath.orientation(pose),
                                      blurPixels: blur)
        DispatchQueue.main.async { [readout] in readout.value = value }
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let status: String
        switch camera.trackingState {
        case .normal:
            status = "Tracking OK"
        case .notAvailable:
            status = "Tracking unavailable"
        case .limited(let reason):
            switch reason {
            case .initializing: status = "Initializing – move the phone slowly"
            case .excessiveMotion: status = "Limited – moving too fast"
            case .insufficientFeatures: status = "Limited – not enough texture/light"
            case .relocalizing: status = "Relocalizing…"
            @unknown default: status = "Tracking limited"
            }
        }
        let normal: Bool
        if case .normal = camera.trackingState { normal = true } else { normal = false }
        tracking = normal
        DispatchQueue.main.async { [self] in
            trackingIsNormal = normal
            trackingStatus = status
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        tracking = false
        let status = "AR error: \(error.localizedDescription)"
        DispatchQueue.main.async { [self] in
            trackingIsNormal = false
            trackingStatus = status
        }
    }

    // MARK: - Capture (frameQueue)

    /// The user picked a new origin: anchor it so the world map can carry it, and drop the saved one.
    private func setOrigin(_ frame: ARFrame) {
        if let id = originAnchorID, let old = frame.anchors.first(where: { $0.identifier == id }) {
            session.remove(anchor: old)
        }
        // Translation only: axes stay ARKit's gravity-aligned world axes, which the world map also restores.
        var transform = matrix_identity_float4x4
        transform.columns.3 = frame.camera.transform.columns.3
        let anchor = ARAnchor(name: Self.originAnchorName, transform: transform)
        session.add(anchor: anchor)
        originAnchorID = anchor.identifier
        originGeneration += 1
        let generation = originGeneration
        ioQueue.async { [self] in deleteWorldMap(generation: generation) }
        worldMapDirty = true
        lastWorldMapSave = -.infinity
        applyOrigin(transform, state: .unsaved)
    }

    private func applyOrigin(_ transform: simd_float4x4, state: OriginState) {
        let cancelling = activeShot != nil || encodingShot != nil
        resetCapture(message: cancelling ? "Origin changed – pending capture cancelled; check the previous capture folder" : nil)
        selectedStream?.changeSession(sessionID, headers: exportHeaders)
        origin = transform
        mapper.reset()
        DispatchQueue.main.async { [self] in
            arFrustumRoot.childNodes.forEach { $0.removeFromParentNode() }
            mapFrustumRoot.childNodes.forEach { $0.removeFromParentNode() }
            // Axes of the Z-up frame written to disk, placed in ARKit's Y-up world.
            let markerTransform = transform * PoseMath.yUpToZUp.inverse
            for marker in [arOriginMarker, mapOriginMarker] {
                marker.simdTransform = markerTransform
                marker.isHidden = false
            }
            sessionURL = nil
            frameCount = 0
            originState = state
        }
    }

    /// Snapshots ARKit's world map, including the origin anchor, for the next launch to relocalize against.
    private func saveWorldMap(at time: TimeInterval) {
        worldMapSaving = true
        worldMapDirty = false
        lastWorldMapSave = time
        let generation = originGeneration
        let anchorID = originAnchorID
        session.getCurrentWorldMap { [self] map, _ in
            ioQueue.async { [self] in
                var saved = false
                var writeError: Error?
                // A newer origin or a forget has deleted the map since this snapshot was requested.
                if generation == ioOriginGeneration, let map,
                   map.anchors.contains(where: { $0.identifier == anchorID }) {
                    do {
                        let data = try NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true)
                        try FileManager.default.createDirectory(at: Self.worldMapURL.deletingLastPathComponent(),
                                                                withIntermediateDirectories: true)
                        try data.write(to: Self.worldMapURL, options: .atomic)
                        saved = true
                    } catch {
                        writeError = error
                    }
                }
                frameQueue.async { [self] in
                    worldMapSaving = false
                    guard generation == originGeneration else { return }
                    // Not mapped well enough yet, or the write failed: try again after the interval.
                    if !saved { worldMapDirty = true }
                    DispatchQueue.main.async { [self] in
                        if saved, originState == .unsaved { originState = .saved }
                        if let writeError { shutterMessage = "Could not save origin: \(writeError.localizedDescription)" }
                    }
                }
            }
        }
    }

    private func finishSteadyWait(message: String?) {
        steadyTimer?.cancel()
        steadyTimer = nil
        shutterArmed = false
        steadyDeadline = nil
        if message != nil { activeShot = nil }
        publishTransferState()
        DispatchQueue.main.async { [self] in
            waitingForSteadyFrame = false
            shutterMessage = message
        }
    }

    /// Reserve one shot before copying or encoding; completion belongs to its session and token.
    private func savePicture(_ frame: ARFrame) {
        guard let origin, let shot = activeShot else { return }
        let shotSession = sessionID
        let destination = captureDestination
        if destination == .local, capture == nil { capture = openCapture() }
        let localCapture = destination == .local ? capture : nil
        guard destination != .local || localCapture != nil else {
            completeShot(shot, session: shotSession, result: .failure(
                CaptureStream.StreamError(message: "Could not create capture folder")), frustum: nil)
            return
        }
        // ARKit has a small camera buffer pool; never retain its frame during JPEG encoding or ACK.
        guard let pixelBuffer = Self.copy(frame.capturedImage) else {
            completeShot(shot, session: shotSession, result: .failure(
                CaptureStream.StreamError(message: "Out of memory – no picture taken")), frustum: nil)
            return
        }
        let size = frame.camera.imageResolution
        let k = PoseMath.portraitIntrinsics(frame.camera.intrinsics,
                                           sensorWidth: Int(size.width), sensorHeight: Int(size.height))
        let stem = String(format: "frame_%05d", pictureIndex)
        let label = stem + ".jpg"
        let pose = PoseMath.cameraPose(frame.camera.transform, origin: origin)
        let lines = [
            "poses.txt": PoseMath.poseLine(label: label, pose: pose),
            "reference.csv": PoseMath.referenceLine(label: stem, pose: pose),
            "intrinsics.txt": "\(label) \(k.fx) \(k.fy) \(k.cx) \(k.cy) \(k.width) \(k.height)\n",
            "quaternion.txt": PoseMath.quaternionLine(label: label, pose: pose)
        ]
        let frustum = Self.frustumNode(intrinsics: k)
        frustum.simdTransform = frame.camera.transform * PoseMath.sensorToPortrait
        mapper.addPicture(frame)
        encodingShot = shot
        ioQueue.async { [self, ciContext] in
            let result: Result<Data, Error>
            do {
                let source = CIImage(cvPixelBuffer: pixelBuffer)
                let colorSpace = source.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
                let options = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 1.0]
                guard let jpeg = ciContext.jpegRepresentation(of: source.oriented(.right),
                                                              colorSpace: colorSpace, options: options) else {
                    throw CaptureStream.StreamError(message: "Could not encode JPEG")
                }
                if let localCapture {
                    try Self.writeLocal(jpeg, label: label, lines: lines, capture: localCapture)
                }
                result = .success(jpeg)
            } catch {
                result = .failure(error)
            }
            frameQueue.async { [self] in
                if encodingShot == shot { encodingShot = nil }
                guard activeShot == shot, sessionID == shotSession else { publishTransferState(); return }
                switch result {
                case .failure(let error):
                    completeShot(shot, session: shotSession, result: .failure(error), frustum: nil)
                case .success(let jpeg):
                    if let stream = selectedStream {
                        stream.send(id: shot.uuidString, metadata: ["label": label, "lines": lines], jpeg: jpeg) { [weak self] result in
                            self?.completeShot(shot, session: shotSession, result: result, frustum: frustum)
                        }
                    } else {
                        completeShot(shot, session: shotSession, result: .success(()), frustum: frustum)
                    }
                }
            }
        }
    }

    private func completeShot(_ shot: UUID, session: String, result: Result<Void, Error>, frustum: SCNNode?) {
        guard activeShot == shot, sessionID == session else { return }
        activeShot = nil
        publishTransferState()
        switch result {
        case .success:
            pictureIndex += 1
            // Capturing means the scene around it has been scanned: extend the saved map.
            worldMapDirty = true
            let count = pictureIndex
            let folder = capture?.folder
            let message = captureDestination == .local ? "Saved on iPhone" : "Saved on computer"
            DispatchQueue.main.async { [self] in
                if let frustum {
                    for (root, node) in [(arFrustumRoot, frustum), (mapFrustumRoot, frustum.clone())] {
                        root.addChildNode(node)
                        while root.childNodes.count > Self.visibleFrustums { root.childNodes.first?.removeFromParentNode() }
                    }
                }
                frameCount = count
                sessionURL = folder
                shutterMessage = message
            }
        case .failure(let error):
            // Start a fresh session after an uncertain ACK or write failure: never overwrite a
            // possibly persisted image by reusing its label.
            resetCapture(message: "Capture failed: \(error.localizedDescription)")
            selectedStream?.changeSession(sessionID, headers: exportHeaders)
        }
    }

    private func publishTransferState() {
        let busy = activeShot != nil || encodingShot != nil
        DispatchQueue.main.async { [self] in transferInProgress = busy }
    }

    private func resetCapture(message: String?) {
        activeShot = nil
        finishSteadyWait(message: message)
        closeCapture()
        sessionID = UUID().uuidString
        pictureIndex = 0
        DispatchQueue.main.async { [self] in
            frameCount = 0
            sessionURL = nil
            arFrustumRoot.childNodes.forEach { $0.removeFromParentNode() }
            mapFrustumRoot.childNodes.forEach { $0.removeFromParentNode() }
        }
    }

    private static func writeLocal(_ jpeg: Data, label: String, lines: [String: String], capture: OpenCapture) throws {
        let imageURL = capture.folder.appendingPathComponent("images").appendingPathComponent(label)
        let files = [("poses.txt", capture.poses), ("intrinsics.txt", capture.intrinsics),
                     ("reference.csv", capture.reference), ("quaternion.txt", capture.quaternion)]
        var offsets: [(FileHandle, UInt64)] = []
        do {
            for (_, file) in files { offsets.append((file, try file.offset())) }
            try jpeg.write(to: imageURL, options: .atomic)
            for (name, file) in files { try file.write(contentsOf: Data(lines[name]!.utf8)) }
        } catch {
            for (file, offset) in offsets {
                try? file.truncate(atOffset: offset)
                try? file.seek(toOffset: offset)
            }
            try? FileManager.default.removeItem(at: imageURL)
            throw error
        }
    }

    private func openCapture() -> OpenCapture? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let folder = documents.appendingPathComponent("capture_\(formatter.string(from: Date()))_\(sessionID)")
        var handles: [String: FileHandle] = [:]
        do {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent("images"),
                                                    withIntermediateDirectories: true)
            for (name, header) in exportHeaders {
                let url = folder.appendingPathComponent(name)
                try Data(header.utf8).write(to: url)
                let handle = try FileHandle(forWritingTo: url)
                try handle.seekToEnd()
                handles[name] = handle
            }
            return OpenCapture(folder: folder, poses: handles["poses.txt"]!,
                               intrinsics: handles["intrinsics.txt"]!, reference: handles["reference.csv"]!,
                               quaternion: handles["quaternion.txt"]!)
        } catch {
            for handle in handles.values { try? handle.close() }
            return nil
        }
    }

    private func closeCapture() {
        guard let capture else { return }
        self.capture = nil
        ioQueue.async {
            try? capture.poses.close()
            try? capture.intrinsics.close()
            try? capture.reference.close()
            try? capture.quaternion.close()
        }
    }

    /// Copies a biplanar camera image (ARKit's YCbCr 4:2:0), keeping its colour attachments.
    private static func copy(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        let planes = CVPixelBufferGetPlaneCount(source)
        guard planes > 0 else { return nil }
        var result: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary
        guard CVPixelBufferCreate(nil, CVPixelBufferGetWidth(source), CVPixelBufferGetHeight(source),
                                  CVPixelBufferGetPixelFormatType(source), attributes, &result) == kCVReturnSuccess,
              let copy = result else { return nil }
        CVBufferPropagateAttachments(source, copy)
        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(copy, [])
        defer {
            CVPixelBufferUnlockBaseAddress(copy, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        for plane in 0..<planes {
            guard let from = CVPixelBufferGetBaseAddressOfPlane(source, plane),
                  let to = CVPixelBufferGetBaseAddressOfPlane(copy, plane) else { return nil }
            let fromRow = CVPixelBufferGetBytesPerRowOfPlane(source, plane)
            let toRow = CVPixelBufferGetBytesPerRowOfPlane(copy, plane)
            let rowBytes = min(fromRow, toRow)
            for y in 0..<CVPixelBufferGetHeightOfPlane(source, plane) {
                memcpy(to + y * toRow, from + y * fromRow, rowBytes)
            }
        }
        return copy
    }

    /// Predicted motion blur of `frame`, from the camera motion over the last ~50 ms (averaged over a few
    /// frames to smooth tracking jitter) and the median depth of ARKit's feature points.
    private func motionBlur(_ frame: ARFrame) -> Double {
        recentPoses.append((frame.timestamp, frame.camera.transform))
        recentPoses.removeAll { frame.timestamp - $0.time > 0.3 }
        guard let previous = recentPoses.last(where: { frame.timestamp - $0.time >= 0.05 }) else { return 0 }

        let worldToCamera = frame.camera.transform.inverse
        var depths: [Float] = []
        for point in frame.rawFeaturePoints?.points ?? [] {
            let depth = -(worldToCamera * SIMD4<Float>(point, 1)).z
            if depth > 0.05 { depths.append(depth) }
        }
        depths.sort()
        let sceneDepth = depths.isEmpty ? 1.5 : depths[depths.count / 2]

        return PoseMath.motionBlurPixels(previous: previous.transform, current: frame.camera.transform,
                                         interval: frame.timestamp - previous.time,
                                         exposure: frame.camera.exposureDuration,
                                         focalPixels: frame.camera.intrinsics[0][0], sceneDepth: sceneDepth)
    }

    // MARK: - Frustum markers

    /// Wireframe pyramid with a translucent image plane, in camera space (looking down -Z),
    /// plus the camera's own axes as thick bars: X red, Y green, Z blue.
    private static func frustumNode(intrinsics k: PoseMath.Intrinsics, depth: Float = 0.08) -> SCNNode {
        let halfWidth = Float(k.width) / (2 * k.fx) * depth
        let halfHeight = Float(k.height) / (2 * k.fy) * depth
        let vertices = [
            SCNVector3(0, 0, 0),
            SCNVector3(-halfWidth, halfHeight, -depth),
            SCNVector3(halfWidth, halfHeight, -depth),
            SCNVector3(halfWidth, -halfHeight, -depth),
            SCNVector3(-halfWidth, -halfHeight, -depth),
        ]
        let edges: [UInt16] = [0, 1, 0, 2, 0, 3, 0, 4, 1, 2, 2, 3, 3, 4, 4, 1]
        let plane: [UInt16] = [1, 4, 3, 1, 3, 2]
        let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices)], elements: [
            SCNGeometryElement(indices: edges, primitiveType: .line),
            SCNGeometryElement(indices: plane, primitiveType: .triangles),
        ])
        geometry.materials = [Self.frustumEdgeMaterial, Self.frustumPlaneMaterial]
        let node = SCNNode(geometry: geometry)

        // SCNCylinder runs along its local Y, so X and Z bars are tipped over.
        let half = Self.axisLength / 2
        let axes: [(SCNGeometry, SCNVector3, SCNVector3)] = [
            (Self.axisBars[0], SCNVector3(half, 0, 0), SCNVector3(0, 0, -Float.pi / 2)),
            (Self.axisBars[1], SCNVector3(0, half, 0), SCNVector3(0, 0, 0)),
            (Self.axisBars[2], SCNVector3(0, 0, half), SCNVector3(Float.pi / 2, 0, 0)),
        ]
        for (bar, position, eulerAngles) in axes {
            let barNode = SCNNode(geometry: bar)
            barNode.position = position
            barNode.eulerAngles = eulerAngles
            node.addChildNode(barNode)
        }
        return node
    }

    // Shared by every frustum, so each new picture adds nodes but no new materials or bar meshes.
    private static let axisLength: Float = 0.06
    private static let frustumEdgeMaterial = constantMaterial(.white)
    private static let frustumPlaneMaterial: SCNMaterial = {
        let material = constantMaterial(UIColor.white.withAlphaComponent(0.2))
        material.isDoubleSided = true
        material.writesToDepthBuffer = false
        return material
    }()
    /// X red, Y green, Z blue.
    private static let axisBars: [SCNGeometry] = [UIColor.red, .green, .blue].map { color in
        let bar = SCNCylinder(radius: 0.0025, height: CGFloat(axisLength))
        bar.materials = [constantMaterial(color)]
        return bar
    }

    /// A white ball with 25 cm axes, X red, Y green, Z blue, each labelled at its tip. Built in the Z-up
    /// frame of poses.txt, so placing it with yUpToZUp.inverse shows that frame's axes. Starts hidden.
    private static func originMarker() -> SCNNode {
        let length: Float = 0.25
        let node = SCNNode(geometry: originBall)
        let axes: [(String, UIColor, SIMD3<Float>, SCNVector3)] = [
            ("X", .red, SIMD3(1, 0, 0), SCNVector3(0, 0, -Float.pi / 2)),
            ("Y", .green, SIMD3(0, 1, 0), SCNVector3(0, 0, 0)),
            ("Z", .blue, SIMD3(0, 0, 1), SCNVector3(Float.pi / 2, 0, 0)),
        ]
        for (name, color, direction, eulerAngles) in axes {
            // SCNCylinder runs along its local Y, so X and Z bars are tipped over.
            let bar = SCNCylinder(radius: 0.006, height: CGFloat(length))
            bar.materials = [constantMaterial(color)]
            let barNode = SCNNode(geometry: bar)
            barNode.simdPosition = direction * (length / 2)
            barNode.eulerAngles = eulerAngles
            node.addChildNode(barNode)

            let text = SCNText(string: name, extrusionDepth: 0)
            text.font = UIFont.systemFont(ofSize: 1, weight: .bold)
            text.flatness = 0.05
            text.materials = [constantMaterial(color)]
            let label = SCNNode(geometry: text)
            label.simdScale = SIMD3(repeating: 0.06)
            label.simdPosition = direction * (length + 0.03)
            label.constraints = [SCNBillboardConstraint()]
            node.addChildNode(label)
        }
        node.isHidden = true
        return node
    }

    private static let originBall: SCNGeometry = {
        let ball = SCNSphere(radius: 0.015)
        ball.materials = [constantMaterial(.white)]
        return ball
    }()

    private static func constantMaterial(_ color: UIColor) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = color
        return material
    }
}

/// The 10 Hz pose and blur readout (main thread).
final class LiveReadout: ObservableObject {
    struct Value {
        /// Camera position in the Z-up frame written to disk, in metres, relative to the chosen origin.
        var position = SIMD3<Float>(0, 0, 0)
        /// Unit camera-to-world quaternion (x, y, z, w), without Euler singularities.
        var quaternion = SIMD4<Double>(0, 0, 0, 1)
        /// Predicted motion blur of the latest frame at the saved resolution, in pixels.
        var blurPixels = 0.0
    }

    /// One value, so each refresh is one change notification.
    @Published var value = Value()
}
