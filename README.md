# AR Pose Capture

An iPhone camera app for portrait JPEGs and matching camera poses. Open
`ARPoseCapture.xcodeproj` in Xcode, select your iPhone, and run the app.

To sign the app for your device, create `Local.xcconfig` in the repository root
(it is git-ignored) with your Apple team and a bundle ID of your own:

```
DEVELOPMENT_TEAM = ABCDE12345
PRODUCT_BUNDLE_IDENTIFIER = com.yourname.ARPoseCapture
```

## Capture modes

- **On iPhone** is the default. Photos and pose files stay in the app's Documents
  folder. Use the share button to export the current capture folder.
- **USB stream** sends each shutter capture directly to a connected computer.
  It does not save a second copy of the photo on the iPhone. The shutter is
  enabled only when tracking, origin, camera lock, and the desktop receiver are ready.
- **Wi-Fi stream** sends the same photos and pose files to a paired computer over a
  local network or Tailscale, without USB. Configure the computer in **Wi-Fi settings**.

All modes retain the existing manual shutter and steady-frame check. Tap the
scope button to choose the origin. Changing the origin or destination starts a
new capture session; earlier capture folders remain intact.

The origin persists across app launches. Once ARKit has mapped enough of the
surroundings, the app saves its world map with an anchor at the origin
(`Application Support/origin.worldmap`, outside the shared Documents folder), and
saves it again after new pictures. The status reads **Origin set and saved** once
this has happened. On the next launch, aim the phone at the area where the origin
was set, ideally with similar lighting. When ARKit relocalizes, the origin returns
to the same physical spot with the same axes, and capture is available again.
Relocalization fails if the scene has changed substantially. In that case, tap
**Forget saved origin** (also in Capture details) to restart tracking with no
origin. Choosing a new origin with the scope replaces the saved one.

Every picture uses fixed capture parameters. Aim at the subject so auto mode
meters it, then tap the padlock: focus (lens position), exposure (shutter time and
ISO), and white balance are frozen at the current values. Video HDR and low-light
boost are off. The shutter stays disabled until the camera is locked. Locked
focus keeps the focal length, and therefore the exported intrinsics, constant
between pictures. Capture details lists the locked values. Tap the padlock again
to return to auto. If ARKit restarts the camera (for example after the app was
in the background), the lock is lost; the shutter reports it, and you lock again.
ARKit streams from a single physical lens and offers no video stabilization
setting, so there is no lens switching or stabilization to turn off.

Once a USB or Wi-Fi receiver is connected, selecting another save destination
leaves that connection open and idle. Only the selected destination receives new
photos. Returning to a stream announces the new capture session over the same
connection, without reconnecting or repeating Wi-Fi pairing. Neither desktop
receiver needs to be restarted just because the destination changes.
Local mode identifies the connections still open while saving on the phone.
Explicit **Reconnect Wi-Fi** / **Disconnect Wi-Fi**, ending the app session, or
losing the cable/network can still disconnect a stream.

**Camera / Points** changes only the view, independently of the save destination.
The point cloud and recent camera frustums are spatial aids for placing pictures,
not reconstruction output. Point-cloud data is not transferred, and a depth-model
failure does not prevent saving or transferring photos and poses.

The top diagnostics panel has been replaced by the info button. Capture details
contain the live position, quaternion orientation, blur estimate, and depth status.

## USB receiver

On the computer (macOS setup):

```sh
brew install libimobiledevice libusbmuxd
python3 receive_capture.py --output captures
```

Connect the iPhone with a data-capable USB cable, unlock it, accept **Trust This
Computer** if prompted, and select **USB stream** in the app. Keep the app in the
foreground. The receiver waits up to 30 seconds for the phone's stream to appear,
so either side can be started first. Wait for `Ready:` on the computer and
`USB receiver ready` on the phone before taking pictures.
If several iPhones are connected, select one explicitly:

```sh
idevice_id -l
python3 receive_capture.py --udid YOUR_DEVICE_UDID --output captures
```

The receiver launches `iproxy` in USB-only mode. Both forwarding and the app's
listener use loopback, with no Wi-Fi discovery or network fallback. Default port:
39001, outside the dynamic/ephemeral port range. The app binds specifically to IPv4
`127.0.0.1`. `--port` changes the computer's forwarding port if it is occupied;
`--device-port` must match the app's listener port.

The phone waits for listener cancellation to finish before starting a replacement,
and both ends permit reuse of recently closed connections. Restarting the receiver
or switching modes does not require waiting for TCP's TIME_WAIT interval. A genuinely
occupied computer port is still rejected: stop the other receiver/iproxy, or use
`--port 39002`.
If the phone reports `USB listener failed`, it is not accepting connections;
repeated `iproxy` connection attempts alone do not mean streaming is working.

Each session goes into `captures/capture_<UUID>/`. A photo counts as saved only
after the computer has persisted its JPEG and all associated metadata and sent an
acknowledgement. Only one capture is in flight at a time.

On disconnection or an acknowledgement timeout, inspect the output before
recapturing: a computer may have saved a shot whose acknowledgement was lost.
There is no silent on-phone fallback or automatic retransmission. Restart the
receiver after reconnecting. Subsequent captures use a fresh session after a
transfer failure to avoid overwriting an uncertain shot.

## Wi-Fi receiver

On the computer:

```sh
python3 receive_capture.py --wifi --output captures
```

No `iproxy` or USB tools are needed. The receiver listens on IPv4 interfaces at
TCP port **39003** and prints a pairing key. Allow incoming TCP on that port in
the computer's firewall.

On the iPhone:

1. Select **Wi-Fi stream**, then open **Wi-Fi settings** if it is not already open.
2. Enter the computer's LAN IP address (for example `192.168.1.10`) or its Tailscale
   IP/MagicDNS hostname. Do not include `http://`, a port, or a path in this field.
3. Use port `39003` unless you explicitly changed the receiver's `--port`.
4. Paste the 32-character pairing key printed by the receiver and tap **Connect Wi-Fi**.
5. Allow local-network access when iOS asks. Wait for **Wi-Fi receiver ready**, close
   settings, set the origin, and capture as usual.

The app remembers the computer address/port and stores the pairing key in the
iPhone Keychain. The desktop key is kept in `captures/.wifi-pairing-key` with
permissions `0600`. Keep it private. Using another output directory creates a
different key; update the phone's settings accordingly. To explicitly rotate it,
use `--pairing-code` with a new 32-character hexadecimal secret.

USB and Wi-Fi receivers can run simultaneously in separate terminals: they use
different ports, and changing the selected destination does not close either
connection. One phone is served at a time by each Wi-Fi receiver. After a real
network disconnection, the server stays running for the next connection; use
**Connect Wi-Fi** on the phone to reconnect. No photos are replayed automatically,
and there is no silent fallback to another destination.

### Tailscale and network security

Both devices must be on the tailnet, with its access rules permitting the phone
to reach the computer's TCP port `39003`. Enter the computer's Tailscale IPv4
address or MagicDNS hostname on the phone. To limit listening to a specific
network address, run:

```sh
python3 receive_capture.py --wifi --bind COMPUTER_IP --output captures
```

Pairing uses fresh, mutually verified HMAC-SHA256 challenges before any capture
session is opened. It authenticates the peers but **does not encrypt photo data**.
Use trusted Wi-Fi; use Tailscale for encrypted transport. Do not expose this
receiver through a public port forward. IPv6 listening is available with
`--bind ::`; the phone accepts IPv6 addresses as well.

## Files and Metashape

Every local or streamed capture contains:

| File | Contents |
| --- | --- |
| `images/frame_XXXXX.jpg` | Full-quality portrait JPEGs with the camera's EXIF lens metadata |
| `poses.txt` | Image filename and 16 row-major camera-to-world matrix entries |
| `intrinsics.txt` | Image filename, fx, fy, cx, cy, width, height in pixels |
| `reference.csv` | Camera label, x/y/z in metres, yaw/pitch/roll and omega/phi/kappa in degrees |
| `quaternion.txt` | Image filename and unit quaternion qx/qy/qz/qw |

Each JPEG embeds the EXIF that ARKit reports for that frame, typically focal length
(mm and 35 mm equivalent), f-number, lens model and specification, exposure time,
and ISO, plus Make `Apple` and the iPhone model identifier. The metadata is part of the JPEG bytes, so
local saving, USB, and Wi-Fi all deliver it identically; the receiver stores the
file unchanged. Metashape reads it when the photos are added.

All poses and intrinsics describe the saved portrait image, not the landscape
sensor buffer. World coordinates are Z-up, with positions relative to the chosen
origin. Camera axes are X right, Y up, Z backward (looking down -Z).

In Metashape, add the JPEGs from `images/`, then import `reference.csv` through the
Reference pane using local coordinates. Map the label and position columns, then
choose **either** yaw/pitch/roll **or** omega/phi/kappa according to Metashape's
rotation convention. Labels omit the `.jpg` extension to match camera labels.
No Metashape installation is needed on the receiver computer just to collect files.

Matrices and quaternions have no Euler gimbal lock. The live readout uses a
quaternion; Euler angles remain in the CSV for Metashape compatibility. Euler
values are not unique at their singularities and may jump while the camera
orientation remains correct. Near-singular angle extraction preserves small
tilts instead of rounding them to exactly 90 degrees. Quaternions q and -q
represent the same rotation; exported quaternions use qw >= 0.

## Workcell Studio

`studio/` is a local browser editor for the reconstructed welding cell in
`assets/welding_cell`. Its catalog displays the captured workcell as a compressed,
view-independent SPZ and keeps the aligned semantic GLB as a fallback. The
captured table is shown by default; the generated parametric table starts hidden
to avoid drawing a second table over the scan. Studio provides a metric, Z-up
Three.js work surface for local scan/splat references, measurements, collision review, a revisioned local
scene-control API, constrained Python scene scripts, and fixed-target
Blender/OpenUSD/MuJoCo builds. Studio uses a balanced multi-axis viewer light rig; generated simulator assets contain no scene lights.

See [`studio/README.md`](studio/README.md) for setup, API and Python examples,
supported reference formats, coordinate conventions, and the loopback service
boundary. The environment assets do not include the robot, URDF, articulation,
controllers, or hardware access.

## Verification

```sh
python3 -m unittest discover -s Tests -v
xcodebuild -project ARPoseCapture.xcodeproj -scheme ARPoseCapture \
  -destination 'generic/platform=iOS' build
```

For transport development, `python3 receive_capture.py --direct` connects to an
explicit loopback listener without USB forwarding. It is not a separate user
capture mode and does not enable LAN streaming.

## License

Apache License 2.0; see [LICENSE](LICENSE).

`ARPoseCapture/DepthAnythingV2SmallF16P6.mlpackage` is Apple's Core ML conversion
of Depth Anything V2 Small (Lihe Yang et al., "Depth Anything V2"), redistributed
unmodified under the Apache License 2.0.
