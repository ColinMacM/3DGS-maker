import CryptoKit
import Foundation
import Network

/// All methods and Network callbacks run on CaptureManager's frame queue.
/// USB listens only on loopback; Wi-Fi is an outbound TCP connection on any available route.
final class CaptureStream {
    enum Mode { case usb, wifi }
    static let usbPort: UInt16 = 39001
    static let maxJPEGBytes = 64 * 1024 * 1024
    private let queue: DispatchQueue
    private let mode: Mode
    private var label: String { mode == .usb ? "USB" : "Wi-Fi" }
    private var listener: NWListener?
    private var listeningRequested = false
    private var connection: NWConnection?
    private var socketReady = false
    private var sessionID = ""
    private var headers: [String: String] = [:]
    private var ready = false
    private enum Authentication { case challenge, confirmation, complete, failed }
    private var authentication = Authentication.complete
    private var pairingCode = ""
    private var pending: (id: String, completion: (Result<Void, Error>) -> Void)?
    private var timeout: DispatchWorkItem?
    var onStatus: ((Bool, String) -> Void)?

    init(queue: DispatchQueue, mode: Mode) {
        self.queue = queue
        self.mode = mode
    }

    struct StreamError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    func startUSB(sessionID: String, headers: [String: String]) {
        guard mode == .usb else { return }
        self.sessionID = sessionID
        self.headers = headers
        listeningRequested = true
        guard listener == nil else { announceSession(); return }
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback),
                                                         port: NWEndpoint.Port(rawValue: Self.usbPort)!)
            parameters.allowLocalEndpointReuse = true
            let listener = try NWListener(using: parameters)
            self.listener = listener
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                guard let self, let listener, self.listener === listener else { return }
                switch state {
                case .ready:
                    guard self.listeningRequested else { listener.cancel(); return }
                    if self.connection == nil { self.status(false, "Waiting for USB receiver · port \(Self.usbPort)") }
                case .failed(let error):
                    self.stop(message: "USB listener failed on 127.0.0.1:\(Self.usbPort): \(error.localizedDescription)")
                case .cancelled:
                    self.listener = nil
                    if self.listeningRequested {
                        self.startUSB(sessionID: self.sessionID, headers: self.headers)
                    }
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] incoming in
                guard let self, self.connection == nil else { incoming.cancel(); return }
                self.attach(incoming)
            }
            listener.start(queue: queue)
        } catch {
            listeningRequested = false
            status(false, "USB listener failed on 127.0.0.1:\(Self.usbPort): \(error.localizedDescription)")
        }
    }

    /// Selecting a destination reuses an existing connection, including its authentication.
    func startWiFi(host: String, port: UInt16, pairingCode: String,
                   sessionID: String, headers: [String: String]) {
        guard mode == .wifi else { return }
        self.sessionID = sessionID
        self.headers = headers
        if connection != nil { announceSession(); return }
        self.pairingCode = pairingCode
        status(false, "Connecting to \(host):\(port)…")
        // Allow time for the first local-network permission prompt before abandoning the attempt.
        armTimeout(seconds: 30, message: "Wi-Fi connection timed out")
        // Do not require .wifi: Tailscale and other VPN routes must remain eligible.
        let outgoing = NWConnection(host: NWEndpoint.Host(host),
                                    port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        attach(outgoing)
    }

    private func attach(_ connection: NWConnection) {
        self.connection = connection
        socketReady = false
        authentication = mode == .wifi ? .challenge : .complete
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection, self.connection === connection else { return }
            switch state {
            case .ready:
                self.socketReady = true
                if self.mode == .wifi {
                    self.status(false, "Authenticating Wi-Fi receiver…")
                    self.armTimeout(seconds: 10, message: "Wi-Fi pairing timed out", pairingFailure: true)
                } else {
                    self.announceSession()
                }
                self.receiveHeader(on: connection)
            case .failed(let error): self.disconnect("\(self.label) disconnected: \(error.localizedDescription)")
            case .cancelled: self.disconnect("\(self.label) receiver disconnected")
            case .waiting(let error):
                if self.mode == .wifi, !self.socketReady {
                    self.status(false, "Waiting for Wi-Fi route or local-network permission: \(error.localizedDescription)")
                } else {
                    self.disconnect("\(self.label) connection unavailable: \(error.localizedDescription)")
                }
            default: break
            }
        }
        connection.start(queue: queue)
    }

    func changeSession(_ sessionID: String, headers: [String: String]) {
        self.sessionID = sessionID
        self.headers = headers
        // Session changes during pairing must not cancel its bounded authentication deadline.
        if pending != nil { failPending("Capture session changed") }
        announceSession()
    }

    func stop(message: String) {
        listeningRequested = false
        listener?.newConnectionHandler = nil
        listener?.cancel()
        // Retain until .cancelled: cancellation does not release the loopback port synchronously.
        // A start requested meanwhile is resumed by the cancellation callback.
        disconnect(message)
    }

    func send(id: String, metadata: [String: Any], jpeg: Data,
              completion: @escaping (Result<Void, Error>) -> Void) {
        guard ready, pending == nil, let connection else {
            completion(.failure(StreamError(message: "\(label) receiver is not ready")))
            return
        }
        guard jpeg.count <= Self.maxJPEGBytes else {
            completion(.failure(StreamError(message: "JPEG exceeds the capture protocol size limit")))
            return
        }
        pending = (id, completion)
        var message = metadata
        message["type"] = "capture"
        message["session"] = sessionID
        message["id"] = id
        message["jpeg_bytes"] = jpeg.count
        armTimeout(seconds: 30, message: "\(label) acknowledgement timed out; check the computer before recapturing")
        guard sendJSON(message, on: connection) else { return }
        // Separate sends preserve TCP ordering without copying the JPEG into another packet buffer.
        connection.send(content: jpeg, completion: .contentProcessed { [weak self, weak connection] error in
            guard let self, let connection, self.connection === connection else { return }
            if let error { self.disconnect("\(self.label) send failed: \(error.localizedDescription)") }
        })
    }

    private func announceSession() {
        guard authentication == .complete, let connection, case .ready = connection.state else { return }
        status(false, "Waiting for \(label) receiver handshake…")
        armTimeout(seconds: 10, message: "\(label) receiver handshake timed out")
        sendJSON(["type": "hello", "protocol": 1, "session": sessionID, "headers": headers], on: connection)
    }

    private func status(_ ready: Bool, _ message: String) {
        self.ready = ready
        onStatus?(ready, message)
    }

    private func cancelTimeout() {
        timeout?.cancel()
        timeout = nil
    }

    private func failPending(_ message: String) {
        cancelTimeout()
        let completion = pending?.completion
        pending = nil
        completion?(.failure(StreamError(message: message)))
    }

    private func disconnect(_ message: String) {
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
        pairingCode = ""
        status(false, message)
        failPending(message)
    }

    private func armTimeout(seconds: Double, message: String, pairingFailure: Bool = false) {
        cancelTimeout()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if pairingFailure, let connection = self.connection {
                self.pairingFailed(on: connection)
            } else {
                self.disconnect(message)
            }
        }
        timeout = work
        queue.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    @discardableResult
    private func sendJSON(_ message: [String: Any], on connection: NWConnection) -> Bool {
        do {
            let packet = try framedJSON(message)
            connection.send(content: packet, completion: .contentProcessed { [weak self, weak connection] error in
                guard let self, let connection, self.connection === connection else { return }
                if let error { self.disconnect("\(self.label) send failed: \(error.localizedDescription)") }
            })
            return true
        } catch {
            disconnect("\(label) metadata error: \(error.localizedDescription)")
            return false
        }
    }

    private func framedJSON(_ message: [String: Any]) throws -> Data {
        let json = try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys])
        guard json.count <= 65536 else { throw StreamError(message: "Capture metadata exceeds size limit") }
        var length = UInt32(json.count).bigEndian
        var packet = withUnsafeBytes(of: &length) { Data($0) }
        packet.append(json)
        return packet
    }

    private func receiveHeader(on connection: NWConnection) {
        receiveExactly(4, on: connection) { [weak self] data in
            guard let self else { return }
            let length = data.reduce(0) { ($0 << 8) | Int($1) }
            guard (1...65536).contains(length) else {
                if self.authentication != .complete { self.pairingFailed(on: connection) }
                else { self.disconnect("Invalid \(self.label) message length") }
                return
            }
            self.receiveExactly(length, on: connection) { [weak self] data in
                guard let self else { return }
                do {
                    guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let type = message["type"] as? String else {
                        throw StreamError(message: "Invalid \(self.label) response")
                    }
                    if self.authentication != .complete {
                        guard self.handleAuthentication(message, type: type, on: connection) else { return }
                    } else {
                        try self.handleResponse(message, type: type)
                    }
                    self.receiveHeader(on: connection)
                } catch {
                    if self.authentication != .complete {
                        self.pairingFailed(on: connection)
                    } else {
                        self.disconnect(error.localizedDescription)
                    }
                }
            }
        }
    }

    private func handleAuthentication(_ message: [String: Any], type: String, on connection: NWConnection) -> Bool {
        guard message["protocol"] as? Int == 1 else { pairingFailed(on: connection); return false }
        switch authentication {
        case .challenge:
            guard type == "challenge", let nonce = message["nonce"] as? String,
                  Self.isLowerHex(nonce, count: 32), let proof = message["proof"] as? String,
                  Self.isLowerHex(proof, count: 64) else {
                pairingFailed(on: connection)
                return false
            }
            let key = SymmetricKey(data: Data(pairingCode.utf8))
            let proofBytes = stride(from: 0, to: 64, by: 2).map { offset -> UInt8 in
                let start = proof.index(proof.startIndex, offsetBy: offset)
                return UInt8(proof[start..<proof.index(start, offsetBy: 2)], radix: 16)!
            }
            guard HMAC<SHA256>.isValidAuthenticationCode(proofBytes, authenticating: Data("receiver:\(nonce)".utf8), using: key) else {
                pairingFailed(on: connection)
                return false
            }
            let response = HMAC<SHA256>.authenticationCode(for: Data("phone:\(nonce)".utf8), using: key)
                .map { String(format: "%02x", $0) }.joined()
            authentication = .confirmation
            return sendJSON(["type": "authenticate", "protocol": 1, "nonce": nonce, "proof": response], on: connection)
        case .confirmation:
            guard type == "authenticated" else { pairingFailed(on: connection); return false }
            authentication = .complete
            pairingCode = ""
            announceSession()
            return true
        case .complete:
            return true
        case .failed:
            return false
        }
    }

    static func isLowerHex(_ value: String, count: Int) -> Bool {
        value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private func pairingFailed(on connection: NWConnection) {
        guard authentication != .failed else { return }
        authentication = .failed
        cancelTimeout()
        status(false, "Wi-Fi pairing failed")
        // Pairing errors have no session, and must be sent before closing the socket.
        guard let packet = try? framedJSON(["type": "error", "message": "Wi-Fi pairing failed"]) else {
            disconnect("Wi-Fi pairing failed")
            return
        }
        armTimeout(seconds: 1, message: "Wi-Fi pairing failed")
        connection.send(content: packet, completion: .contentProcessed { [weak self, weak connection] _ in
            guard let self, let connection, self.connection === connection else { return }
            self.disconnect("Wi-Fi pairing failed")
        })
    }

    private func handleResponse(_ message: [String: Any], type: String) throws {
        guard let session = message["session"] as? String else {
            throw StreamError(message: message["message"] as? String ?? "Invalid \(label) response")
        }
        // Old ACKs cannot complete a capture in a new origin/destination session.
        guard session == sessionID else { return }
        switch type {
        case "ready":
            guard pending == nil else { throw StreamError(message: "Unexpected ready message") }
            cancelTimeout()
            status(true, "\(label) receiver ready")
        case "ack":
            guard let pending, message["id"] as? String == pending.id else {
                throw StreamError(message: "\(label) acknowledgement does not match capture")
            }
            cancelTimeout()
            self.pending = nil
            pending.completion(.success(()))
        case "error":
            throw StreamError(message: message["message"] as? String ?? "Desktop could not save capture")
        default:
            throw StreamError(message: "Unknown \(label) response")
        }
    }

    private func receiveExactly(_ count: Int, on connection: NWConnection, completion: @escaping (Data) -> Void) {
        connection.receive(minimumIncompleteLength: count, maximumLength: count) { [weak self, weak connection] data, _, complete, error in
            guard let self, let connection, self.connection === connection else { return }
            guard let data, data.count == count else {
                self.disconnect(error.map { "\(self.label) receive failed: \($0.localizedDescription)" } ??
                                (complete ? "\(self.label) receiver disconnected" : "Incomplete \(self.label) response"))
                return
            }
            completion(data)
        }
    }
}
