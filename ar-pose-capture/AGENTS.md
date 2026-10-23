# Agent guide: AR Pose Capture

This folder is a self-contained product: the iOS app and its desktop receiver.
It is **not** part of Asset Studio. Do not read, edit, build or test anything in
`../studio/` or `../assets/` for work here, and do not apply Studio conventions
(MCP `scene_*` tools, `+Z up` world, Bun commands) to this code.

| Path | Contents |
| --- | --- |
| `ARPoseCapture.xcodeproj` | Xcode project; sources come from the `ARPoseCapture/` file-system synchronized group, so new `.swift` files there are picked up without editing the project |
| `ARPoseCapture/` | SwiftUI + ARKit app (`CaptureManager` capture/session state, `CameraLock` focus/exposure/white-balance lock, `CaptureStream` USB/Wi-Fi transport, `PoseMath`, `SceneMapper`/`DepthMap` depth) and the bundled Depth Anything V2 Core ML model |
| `Info.plist`, `Signing.xcconfig` | Build settings; `Signing.xcconfig` holds public placeholders and includes the git-ignored `Local.xcconfig` with the developer's real team ID and bundle ID. Never commit `Local.xcconfig` or put a team ID in tracked files |
| `receive_capture.py` | Python 3 standard-library receiver (USB via `iproxy`, `--wifi`, `--direct` loopback smoke mode) |
| `Tests/` | `unittest` tests for the receiver |
| `captures/` | Git-ignored receiver output, including the private `.wifi-pairing-key` |

Run every command from this folder. See `README.md` for the wire protocol,
output files and pose conventions (camera axes X right, Y up, looking down −Z;
exported world coordinates Z-up relative to the chosen origin).

## Verification

```sh
python3 -m unittest discover -s Tests -v
xcodebuild -project ARPoseCapture.xcodeproj -scheme ARPoseCapture \
  -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO
```

The app and receiver share a wire protocol: change both sides together and keep
`Tests/` passing.
