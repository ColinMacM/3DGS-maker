import ARKit
import AVFoundation

/// Fixed capture parameters for the camera ARKit is streaming from, so every picture of a capture shares
/// focus (and so focal length), exposure and white balance.
///
/// ARKit owns the capture session and only lends out the device for these settings. It has no video
/// stabilization setting (its frames carry the sensor geometry tracking and the exported intrinsics rely on),
/// and it streams from the single physical camera of its video format, so no lens switching happens.
enum CameraLock {
    struct Settings: Equatable {
        var camera: String
        /// 0 (nearest) ... 1 (farthest); not a physical distance.
        var lensPosition: Float
        var exposureDuration: Double
        var iso: Float
        var temperature: Float
        var tint: Float
        var videoHDR: Bool
    }

    private static var device: AVCaptureDevice? {
        ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera
    }

    /// Freezes focus, exposure and white balance at the values auto mode has settled on, and turns off
    /// video HDR and low-light boost. `completion` runs on an arbitrary queue once the camera applies them.
    static func lock(completion: @escaping (Result<Settings, Error>) -> Void) {
        guard let device else {
            completion(.failure(CaptureStream.StreamError(message: "ARKit does not expose its camera on this device")))
            return
        }
        guard device.isFocusModeSupported(.locked), device.isExposureModeSupported(.custom),
              device.isWhiteBalanceModeSupported(.locked) else {
            completion(.failure(CaptureStream.StreamError(
                message: "This camera cannot lock focus, exposure and white balance")))
            return
        }
        do {
            try device.lockForConfiguration()
        } catch {
            completion(.failure(error))
            return
        }
        defer { device.unlockForConfiguration() }
        device.automaticallyAdjustsVideoHDREnabled = false
        device.isVideoHDREnabled = false
        if device.isLowLightBoostSupported {
            device.automaticallyEnablesLowLightBoostWhenAvailable = false
        }
        // The `current` values lock at what the camera is using at that moment, even mid-adjustment.
        let applied = DispatchGroup()
        applied.enter()
        device.setFocusModeLocked(lensPosition: AVCaptureDevice.currentLensPosition) { _ in applied.leave() }
        applied.enter()
        device.setExposureModeCustom(duration: AVCaptureDevice.currentExposureDuration,
                                     iso: AVCaptureDevice.currentISO) { _ in applied.leave() }
        applied.enter()
        device.setWhiteBalanceModeLocked(with: AVCaptureDevice.currentWhiteBalanceGains) { _ in applied.leave() }
        applied.notify(queue: .global(qos: .userInitiated)) {
            if isLocked {
                completion(.success(settings(of: device)))
            } else {
                completion(.failure(CaptureStream.StreamError(message: "The camera did not keep the locked settings")))
            }
        }
    }

    /// Back to continuous auto focus, exposure and white balance. HDR and low-light boost stay off.
    static func unlock() throws {
        guard let device else { return }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
        if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            device.whiteBalanceMode = .continuousAutoWhiteBalance
        }
    }

    /// False once anything (e.g. ARKit restarting the camera after an interruption) has undone the lock.
    static var isLocked: Bool {
        guard let device else { return false }
        return device.focusMode == .locked && device.exposureMode == .custom && device.whiteBalanceMode == .locked
            && !device.isVideoHDREnabled
    }

    private static func settings(of device: AVCaptureDevice) -> Settings {
        // Conversion raises an Objective-C exception outside 1...maxWhiteBalanceGain.
        let gains = device.deviceWhiteBalanceGains
        let maxGain = device.maxWhiteBalanceGain
        let clamped = AVCaptureDevice.WhiteBalanceGains(redGain: min(max(gains.redGain, 1), maxGain),
                                                        greenGain: min(max(gains.greenGain, 1), maxGain),
                                                        blueGain: min(max(gains.blueGain, 1), maxGain))
        let white = device.temperatureAndTintValues(for: clamped)
        return Settings(camera: device.localizedName, lensPosition: device.lensPosition,
                        exposureDuration: device.exposureDuration.seconds, iso: device.iso,
                        temperature: white.temperature, tint: white.tint, videoHDR: device.isVideoHDREnabled)
    }
}
