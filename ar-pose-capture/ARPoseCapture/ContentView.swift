import ARKit
import SceneKit
import SwiftUI

struct ARViewContainer: UIViewRepresentable {
    let session: ARSession
    let content: SCNNode

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView()
        view.session = session
        view.automaticallyUpdatesLighting = false
        // Match the camera: frames drawn between camera frames show the same image and cost GPU time
        // that ARKit, Vision and Core Image need.
        view.preferredFramesPerSecond = CaptureManager.videoFormat?.framesPerSecond ?? 60
        view.debugOptions = [.showFeaturePoints]
        view.scene.rootNode.addChildNode(content)
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}

/// Only the diagnostics sheet observes the 10 Hz readout, not the camera controls.
struct LiveReadoutView: View {
    @ObservedObject var readout: LiveReadout
    let originIsSet: Bool

    var body: some View {
        let value = readout.value
        if originIsSet {
            Text(String(format: "X %+.3f   Y %+.3f   Z %+.3f m",
                        value.position.x, value.position.y, value.position.z))
                .font(.body.monospacedDigit())
        } else {
            Text("Tap the scope button to set (0, 0, 0)")
        }
        VStack(alignment: .leading, spacing: 4) {
            Text("Orientation · quaternion")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(String(format: "x %+.4f   y %+.4f\nz %+.4f   w %+.4f",
                        value.quaternion.x, value.quaternion.y, value.quaternion.z, value.quaternion.w))
                .font(.body.monospacedDigit())
        }
        Text(String(format: "Blur ≈ %.1f px", value.blurPixels))
            .font(.subheadline.monospacedDigit())
            .foregroundStyle(value.blurPixels <= CaptureManager.maxBlurPixels ? .green : .orange)
    }
}

struct ContentView: View {
    /// What fills the screen behind the controls.
    enum Backdrop: String, CaseIterable, Identifiable {
        /// The camera image with the last frustums and the origin.
        case camera = "Camera"
        /// Black, with the point cloud from the saved pictures, frustums and the origin, seen from the phone.
        case points = "Points"

        var id: Self { self }
    }

    @StateObject private var capture = CaptureManager()
    @State private var backdrop = Backdrop.camera
    @State private var showingDiagnostics = false
    @State private var showingWiFiSettings = false

    private var canTakePicture: Bool {
        capture.trackingIsNormal && capture.originIsSet && capture.cameraLocked && !capture.waitingForSteadyFrame
            && !capture.transferInProgress && capture.destinationReady
    }

    var body: some View {
        ZStack {
            // Only one is alive at a time, so the hidden one costs no rendering. Both follow the same
            // ARSession, which keeps running across the switch.
            switch backdrop {
            case .camera:
                ARViewContainer(session: capture.session, content: capture.arRoot)
                    .ignoresSafeArea()
            case .points:
                PointMapView(session: capture.session, content: capture.mapRoot)
                    .ignoresSafeArea()
            }

            VStack(spacing: 12) {
                HStack {
                    Spacer()
                    Button {
                        showingDiagnostics = true
                    } label: {
                        Image(systemName: "info.circle")
                            .font(.title2)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Capture details")
                }

                Spacer()

                VStack(spacing: 4) {
                    Text(capture.trackingStatus)
                    Text("\(capture.frameCount) pictures · \(capture.originStatus)")
                        .monospacedDigit()
                    if !capture.cameraLocked {
                        Text(capture.cameraLocking ? "Locking camera…" : "Aim at the subject, then lock the camera")
                    }
                    if capture.destination == .wifi {
                        Text(capture.wifiStatus)
                    } else if capture.destination == .wired {
                        Text(capture.streamStatus)
                    } else if capture.streamReady || capture.wifiReady {
                        Text(capture.streamReady && capture.wifiReady
                             ? "USB + Wi-Fi connected · saving on iPhone"
                             : capture.wifiReady ? "Wi-Fi connected · saving on iPhone"
                             : "USB connected · saving on iPhone")
                    }
                    if let message = capture.shutterMessage {
                        Text(message)
                            .foregroundStyle(.yellow)
                    }
                }
                .font(.subheadline.weight(.medium))
                .multilineTextAlignment(.center)
                .shadow(color: .black, radius: 3, y: 1)
                .accessibilityElement(children: .combine)

                if capture.originState == .searching {
                    Button("Forget saved origin") { capture.forgetSavedOrigin() }
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                        .shadow(color: .black, radius: 3, y: 1)
                        .disabled(capture.waitingForSteadyFrame || capture.transferInProgress)
                }

                Picker("Save to", selection: Binding(
                    get: { capture.destination },
                    set: {
                        capture.setDestination($0)
                        if $0 == .wifi && (capture.wifiHost.isEmpty || capture.wifiPairingCode.isEmpty) {
                            showingWiFiSettings = true
                        }
                    }
                )) {
                    ForEach(CaptureManager.Destination.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 360)
                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                .disabled(capture.waitingForSteadyFrame || capture.transferInProgress)

                if capture.destination == .wifi {
                    Button {
                        showingWiFiSettings = true
                    } label: {
                        Label(capture.wifiReady ? "Wi-Fi settings" : "Connect Wi-Fi", systemImage: "wifi")
                            .font(.subheadline.weight(.semibold))
                            .frame(minHeight: 44)
                    }
                    .shadow(color: .black, radius: 3, y: 1)
                }

                Picker("View", selection: $backdrop) {
                    ForEach(Backdrop.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 220)
                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))

                HStack(spacing: 32) {
                    Button {
                        capture.setCameraLocked(!capture.cameraLocked)
                    } label: {
                        Image(systemName: capture.cameraLocked ? "lock.fill" : "lock.open")
                            .font(.system(size: 36))
                            .foregroundStyle(capture.cameraLocked ? .white : .yellow)
                            .frame(width: 44, height: 48)
                    }
                    .accessibilityLabel(capture.cameraLocked ? "Unlock focus, exposure and white balance"
                                                             : "Lock focus, exposure and white balance")
                    .opacity(capture.cameraLocking || capture.transferInProgress || capture.waitingForSteadyFrame ? 0.35 : 1)
                    .disabled(capture.cameraLocking || capture.transferInProgress || capture.waitingForSteadyFrame)

                    Button {
                        capture.setOrigin()
                    } label: {
                        Image(systemName: "scope")
                            .font(.system(size: 48))
                            .foregroundStyle(capture.originIsSet ? .white : .yellow)
                    }
                    .accessibilityLabel("Set capture origin")
                    .opacity(capture.trackingIsNormal && !capture.transferInProgress && !capture.waitingForSteadyFrame ? 1 : 0.35)
                    .disabled(!capture.trackingIsNormal || capture.transferInProgress || capture.waitingForSteadyFrame)

                    Button {
                        capture.takePicture()
                    } label: {
                        Image(systemName: "circle.inset.filled")
                            .font(.system(size: 76))
                            .foregroundStyle(.white)
                    }
                    .accessibilityLabel("Take picture")
                    .opacity(canTakePicture ? 1 : 0.35)
                    .disabled(!canTakePicture)

                    if let url = capture.sessionURL {
                        ShareLink(item: url) {
                            Image(systemName: "square.and.arrow.up.circle.fill")
                                .font(.system(size: 48))
                                .foregroundStyle(.white)
                        }
                        .accessibilityLabel("Share capture folder")
                    } else {
                        Color.clear.frame(width: 48, height: 48)
                    }
                }
                .padding(.bottom, 24)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 20)
        }
        .sheet(isPresented: $showingDiagnostics) {
            NavigationStack {
                Form {
                    Section("Capture") {
                        Text(capture.trackingStatus)
                        LabeledContent("Pictures", value: "\(capture.frameCount)")
                        LabeledContent("Destination", value: capture.destination.rawValue)
                        if let url = capture.sessionURL {
                            Text(url.lastPathComponent)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                    Section {
                        Text(capture.originStatus)
                        if capture.hasSavedOrigin {
                            Button("Forget saved origin", role: .destructive) { capture.forgetSavedOrigin() }
                                .disabled(capture.waitingForSteadyFrame || capture.transferInProgress)
                        }
                    } header: {
                        Text("Origin")
                    } footer: {
                        Text("The origin is saved with ARKit's map of the surroundings. On the next launch, view the area where it was set to restore it. Forgetting it restarts tracking without an origin.")
                    }
                    Section {
                        if let settings = capture.cameraSettings {
                            LabeledContent("Camera", value: settings.camera)
                            LabeledContent("Focus (lens position)", value: String(format: "%.3f", settings.lensPosition))
                            LabeledContent("Shutter", value: String(format: "1/%.0f s", 1 / settings.exposureDuration))
                            LabeledContent("ISO", value: String(format: "%.0f", settings.iso))
                            LabeledContent("White balance", value: String(format: "%.0f K, tint %+.0f",
                                                                          settings.temperature, settings.tint))
                            LabeledContent("Video HDR", value: settings.videoHDR ? "On" : "Off")
                        } else {
                            Text(capture.cameraLocking ? "Locking…" : "Auto – lock with the padlock before capturing")
                        }
                    } header: {
                        Text("Camera")
                    } footer: {
                        Text("Locked values are what auto mode had settled on when you locked. ARKit streams from one physical lens and has no video stabilization setting.")
                    }
                    if capture.destination == .wired || capture.streamReady {
                        Section("USB stream") {
                            Text(capture.streamStatus)
                            Text("On the connected computer, run python3 receive_capture.py. Unlock this iPhone and trust the computer when prompted.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section("Wi-Fi stream") {
                        Text(capture.wifiStatus)
                        NavigationLink("Connection settings") {
                            WiFiConnectionView(capture: capture)
                        }
                    }
                    Section {
                        LiveReadoutView(readout: capture.readout, originIsSet: capture.originIsSet)
                    } header: {
                        Text("Pose")
                    } footer: {
                        Text("Matrices and quaternions have no gimbal lock. Metashape Euler angles are still exported for compatibility; their values can jump near ±90° without changing the camera pose.")
                    }
                    Section("Point cloud") {
                        DepthStatusView(summary: capture.depthSummary)
                    }
                }
                .navigationTitle("Capture details")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showingDiagnostics = false }
                    }
                }
            }
        }
        .sheet(isPresented: $showingWiFiSettings) {
            NavigationStack {
                WiFiConnectionView(capture: capture, showsDoneButton: true)
            }
        }
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            capture.startSession()
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            capture.pauseSession()
        }
    }
}

struct WiFiConnectionView: View {
    @ObservedObject var capture: CaptureManager
    var showsDoneButton = false
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var port = "39003"
    @State private var pairingCode = ""

    private var captureIsBusy: Bool {
        capture.waitingForSteadyFrame || capture.transferInProgress
    }

    var body: some View {
        Form {
            Section {
                TextField("Computer address", text: $host, prompt: Text("IP address or Tailscale hostname"))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                TextField("Port", text: $port)
                    .keyboardType(.numberPad)
                SecureField("Pairing code", text: $pairingCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Computer")
            } footer: {
                Text("Run python3 receive_capture.py --wifi on the computer. Enter its Wi-Fi IP address or Tailscale hostname and the pairing code printed by the receiver.")
            }
            .disabled(captureIsBusy)

            Section {
                Text(capture.wifiStatus)
                Button(capture.wifiReady ? "Reconnect Wi-Fi" : "Connect Wi-Fi") {
                    capture.connectWiFi(host: host, port: port, pairingCode: pairingCode)
                }
                .disabled(captureIsBusy || host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || port.isEmpty || pairingCode.isEmpty)
                if capture.wifiReady {
                    Button("Disconnect Wi-Fi", role: .destructive) {
                        capture.disconnectWiFi()
                    }
                    .disabled(captureIsBusy)
                }
            } footer: {
                Text("Switching save destinations keeps established connections open. Only Wi-Fi stream sends photos over this connection.")
            }

            Section {
                Text("Pairing authenticates the receiver; the app does not encrypt photo data. Use trusted Wi-Fi. For encrypted transport, connect through Tailscale.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Wi-Fi stream")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsDoneButton {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            host = capture.wifiHost
            port = capture.wifiPort
            pairingCode = capture.wifiPairingCode
        }
    }
}

/// How the point cloud is doing: model state, pictures waiting for depth, point counts, and why the latest
/// picture without depth failed.
struct DepthStatusView: View {
    let summary: SceneMapper.Summary

    var body: some View {
        switch summary.model {
        case .notLoaded: EmptyView()
        case .loading:
            Label("Loading depth model…", systemImage: "hourglass")
                .font(.caption)
                .foregroundStyle(.yellow)
        case .ready: EmptyView()
        case .failed:
            Label("Depth model failed to load", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
        }
        if summary.pending > 0 {
            Text("Depth pending for \(summary.pending) picture\(summary.pending == 1 ? "" : "s")")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.yellow)
        }
        let done = summary.picturesWithDepth + summary.picturesWithoutDepth
        if done > 0 || summary.featurePoints > 0 {
            Text("Depth for \(summary.picturesWithDepth) of \(done) · \(summary.points) depth pts · \(summary.featurePoints) tracked pts")
                .font(.caption.monospacedDigit())
        }
        if let failure = summary.lastFailure {
            Text("Last miss: \(failure.description)")
                .font(.caption)
                .foregroundStyle(.orange)
                .multilineTextAlignment(.center)
        }
    }
}
