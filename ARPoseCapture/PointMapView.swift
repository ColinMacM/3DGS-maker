import ARKit
import SceneKit
import SwiftUI

/// A black 3D view of the point cloud and frustums whose virtual camera follows the phone's ARKit pose with
/// the real camera's field of view, so points appear where the real surfaces are: AR without the camera
/// image. Gaps in the cloud are what the pictures have not covered.
struct PointMapView: UIViewRepresentable {
    let session: ARSession
    /// Scene content in ARKit world coordinates.
    let content: SCNNode

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIView(context: Context) -> SCNView {
        let scene = SCNScene()
        scene.background.contents = UIColor.black
        scene.rootNode.addChildNode(content)
        scene.rootNode.addChildNode(context.coordinator.cameraNode)
        let view = SCNView()
        view.scene = scene
        view.backgroundColor = .black
        view.pointOfView = context.coordinator.cameraNode
        view.delegate = context.coordinator
        view.rendersContinuously = true
        view.preferredFramesPerSecond = CaptureManager.videoFormat?.framesPerSecond ?? 60
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {}

    final class Coordinator: NSObject, SCNSceneRendererDelegate {
        let cameraNode = SCNNode()
        private let session: ARSession

        init(session: ARSession) {
            self.session = session
            let camera = SCNCamera()
            camera.zNear = 0.02
            camera.zFar = 50
            camera.projectionDirection = .vertical
            cameraNode.camera = camera
            super.init()
        }

        /// Render thread: moves the virtual camera to the phone's latest pose before each frame.
        func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
            guard let frame = session.currentFrame else { return }
            // SceneKit cameras look down -Z with Y up, like the portrait camera of the saved pictures.
            cameraNode.simdTransform = frame.camera.transform * PoseMath.sensorToPortrait
            // The portrait image's height is the sensor's width. The AR view fills the screen height with
            // it (cropping the sides), so the same vertical field of view lines the two views up.
            let fx = frame.camera.intrinsics[0][0]
            let sensorWidth = Float(frame.camera.imageResolution.width)
            cameraNode.camera?.fieldOfView = CGFloat(2 * atan(sensorWidth / 2 / fx) * 180 / .pi)
        }
    }
}
