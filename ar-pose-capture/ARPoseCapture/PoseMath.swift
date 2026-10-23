import Foundation
import simd

/// Camera pose conventions shared by the live readout and the files written for each capture.
///
/// Saved images are rotated to portrait, so every pose and intrinsic written to disk describes the
/// portrait camera: X right, Y up, Z backward (looking down -Z) in the saved image. This is also
/// Metashape's aerial camera axis convention, so the angle conversions below need no extra flip.
enum PoseMath {
    /// +90° about X: ARKit world (Y up) -> Metashape world (Z up), i.e. (x, y, z) -> (x, -z, y).
    static let yUpToZUp = simd_float4x4(columns: (
        SIMD4<Float>(1, 0, 0, 0),
        SIMD4<Float>(0, 0, 1, 0),
        SIMD4<Float>(0, -1, 0, 0),
        SIMD4<Float>(0, 0, 0, 1)
    ))

    /// +90° about camera Z: ARKit's landscape sensor camera -> the camera of the saved image, which is
    /// the sensor image rotated 90° clockwise. Portrait right = sensor up, portrait up = sensor left.
    static let sensorToPortrait = simd_float4x4(columns: (
        SIMD4<Float>(0, 1, 0, 0),
        SIMD4<Float>(-1, 0, 0, 0),
        SIMD4<Float>(0, 0, 1, 0),
        SIMD4<Float>(0, 0, 0, 1)
    ))

    /// Pinhole intrinsics in pixels (principal point measured from the image's top-left corner).
    struct Intrinsics {
        var fx: Float
        var fy: Float
        var cx: Float
        var cy: Float
        var width: Int
        var height: Int
    }

    /// Intrinsics of the sensor image rotated 90° clockwise: pixel (u, v) -> (sensorHeight - v, u).
    static func portraitIntrinsics(_ k: simd_float3x3, sensorWidth: Int, sensorHeight: Int) -> Intrinsics {
        // simd is column-major: k[column][row]
        Intrinsics(fx: k[1][1], fy: k[0][0], cx: Float(sensorHeight) - k[2][1], cy: k[2][0],
                   width: sensorHeight, height: sensorWidth)
    }

    /// Z-up camera-to-world transform of the saved portrait image, relative to `origin`
    /// (the ARKit-world transform of the chosen origin; Y up).
    static func cameraPose(_ arkitCameraTransform: simd_float4x4, origin: simd_float4x4) -> simd_float4x4 {
        yUpToZUp * origin.inverse * arkitCameraTransform * sensorToPortrait
    }

    /// Unit quaternion (x, y, z, w) of the Z-up portrait camera-to-world rotation.
    /// Unlike Euler angles, this represents every camera orientation without gimbal lock.
    /// q and -q represent the same orientation; use the hemisphere with w >= 0.
    static func orientation(_ pose: simd_float4x4) -> SIMD4<Double> {
        let q = simd_normalize(simd_quatd(rotation(pose))).vector
        return q.w < 0 ? -q : q
    }

    static let quaternionHeader = "# label qx qy qz qw (unit quaternion, Z-up camera-to-world)\n"

    static func quaternionLine(label: String, pose: simd_float4x4) -> String {
        let q = orientation(pose)
        return String(format: "%@ %.12g %.12g %.12g %.12g\n", label, q.x, q.y, q.z, q.w)
    }

    /// Predicted motion blur, in pixels, of a frame exposed for `exposure` seconds while the camera moves
    /// from `previous` to `current` (camera-to-world transforms) over `interval` seconds. Rotation sweeps the
    /// image by about focal × angle (an upper bound for roll about the view axis), and sideways motion by
    /// focal × distance / depth.
    static func motionBlurPixels(previous: simd_float4x4, current: simd_float4x4, interval: Double,
                                 exposure: Double, focalPixels: Float, sceneDepth: Float) -> Double {
        guard interval > 0 else { return 0 }
        let r0 = rotation(previous)
        let r1 = rotation(current)
        let relative = r0.transpose * r1
        let cosAngle = (relative[0][0] + relative[1][1] + relative[2][2] - 1) / 2
        let angle = acos(max(-1, min(1, cosAngle)))
        let moved = SIMD3<Double>(SIMD3<Float>(current.columns.3.x, current.columns.3.y, current.columns.3.z)
                                  - SIMD3<Float>(previous.columns.3.x, previous.columns.3.y, previous.columns.3.z))
        let forward = -r1.columns.2
        let sideways = moved - simd_dot(moved, forward) * forward
        let sweep = angle + simd_length(sideways) / Double(max(sceneDepth, 0.1))
        return exposure / interval * Double(focalPixels) * sweep
    }

    /// Metashape (yaw, pitch, roll) in degrees, with camera-to-world rotation
    /// R = Rz(-yaw) · Rx(pitch) · Ry(roll). (0, 0, 0) looks straight down with the image top towards +Y;
    /// yaw turns clockwise seen from above, and a camera looking at the horizon with its image upright
    /// has pitch +90. Singular at pitch ±90 (image Y axis vertical), where roll is reported as 0.
    static func metashapeYPR(_ pose: simd_float4x4) -> SIMD3<Double> {
        let r = rotation(pose)
        // r[column][row]
        // Float matrices can round sin(pitch) to ±1 before the singularity; atan2 keeps the tilt.
        let pitch = atan2(r[1][2], hypot(r[1][0], r[1][1]))
        let yaw: Double
        let roll: Double
        if cos(pitch) < 1e-6 {
            roll = 0
            yaw = -atan2(r[0][1], r[0][0])
        } else {
            yaw = atan2(r[1][0], r[1][1])
            roll = atan2(-r[0][2], r[2][2])
        }
        return SIMD3(yaw, pitch, roll) * (180 / .pi)
    }

    /// Metashape (omega, phi, kappa) in degrees — rotations about the X, Y and Z axes, with
    /// camera-to-world rotation R = Rx(omega) · Ry(phi) · Rz(kappa). (0, 0, 0) is the same downward-looking
    /// pose as for yaw/pitch/roll. Singular at phi ±90 (camera looking along ±X), where kappa is reported as 0.
    static func metashapeOPK(_ pose: simd_float4x4) -> SIMD3<Double> {
        let r = rotation(pose)
        // r[column][row]
        // Preserve small offsets from ±90° even when the sine has rounded to ±1.
        let phi = atan2(r[2][0], hypot(r[0][0], r[1][0]))
        let omega: Double
        let kappa: Double
        if cos(phi) < 1e-6 {
            kappa = 0
            omega = atan2(r[0][1] * sin(phi), r[1][1])
        } else {
            omega = atan2(-r[2][1], r[2][2])
            kappa = atan2(-r[1][0], r[0][0])
        }
        return SIMD3(omega, phi, kappa) * (180 / .pi)
    }

    /// "<label> m00 m01 m02 m03 m10 … m33" — the 4x4 camera-to-world matrix, row-major.
    static func poseLine(label: String, pose: simd_float4x4) -> String {
        var values: [String] = []
        values.reserveCapacity(16)
        for row in 0..<4 {
            for column in 0..<4 {
                // simd is column-major: m[column][row]
                values.append(String(format: "%.9g", pose[column][row]))
            }
        }
        return label + " " + values.joined(separator: " ") + "\n"
    }

    /// Header and rows of reference.csv, Metashape's Reference pane CSV import (local coordinates).
    static let referenceHeader = "# label,x,y,z,yaw,pitch,roll,omega,phi,kappa (metres, degrees)\n"

    static func referenceLine(label: String, pose: simd_float4x4) -> String {
        let t = pose.columns.3
        let ypr = metashapeYPR(pose)
        let opk = metashapeOPK(pose)
        return String(format: "%@,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f\n", label,
                      t.x, t.y, t.z, ypr.x, ypr.y, ypr.z, opk.x, opk.y, opk.z)
    }

    private static func rotation(_ m: simd_float4x4) -> simd_double3x3 {
        simd_double3x3(
            SIMD3<Double>(Double(m[0][0]), Double(m[0][1]), Double(m[0][2])),
            SIMD3<Double>(Double(m[1][0]), Double(m[1][1]), Double(m[1][2])),
            SIMD3<Double>(Double(m[2][0]), Double(m[2][1]), Double(m[2][2]))
        )
    }
}
