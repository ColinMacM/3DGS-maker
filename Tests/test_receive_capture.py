import hashlib
import hmac
import os
import queue
import json
from pathlib import Path
import socket
import subprocess
import struct
import sys
import tempfile
import threading
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import receive_capture as receiver


def capture_message(hello, index):
    stem = f"frame_{index:05d}"
    label = stem + ".jpg"
    return {
        "type": "capture", "session": hello["session"], "id": str(uuid.uuid4()),
        "label": label, "jpeg_bytes": 4,
        "lines": {
            "poses.txt": label + " 1 0 0 1 0 1 0 2 0 0 1 3 0 0 0 1\n",
            "intrinsics.txt": label + " 10 10 8 8 16 16\n",
            "reference.csv": stem + ",1,2,3,0,0,0,0,0,0\n",
            "quaternion.txt": label + " 0 0 0 1\n",
        },
    }


class ReceiverPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name)
        self.hello = {
            "type": "hello", "protocol": 1, "session": str(uuid.uuid4()),
            "headers": {name: "" for name in receiver.FILES},
        }
        self.session = receiver.Session(self.output, self.hello)

    def capture(self, index):
        return capture_message(self.hello, index)

    def exports(self):
        return {name: (self.session.folder / name).read_bytes() for name in receiver.FILES}

    def test_duplicate_cannot_overwrite_photo_or_append_metadata(self):
        shot = self.capture(0)
        image = self.session.persist(shot, b"\xff\xd8first\xff\xd9")
        before = self.exports()
        with self.assertRaises(receiver.CaptureError):
            self.session.persist(shot, b"\xff\xd8replacement\xff\xd9")
        self.assertEqual(image.read_bytes(), b"\xff\xd8first\xff\xd9")
        self.assertEqual(self.exports(), before)
        self.assertFalse((self.session.folder / ".pending.json").exists())

    def test_reopening_rolls_back_interrupted_photo_but_keeps_committed_shot(self):
        committed = self.session.persist(self.capture(0), b"\xff\xd8committed\xff\xd9")
        before = self.exports()
        interrupted = self.capture(1)
        offsets = {name: len(data) for name, data in before.items()}
        journal = self.session.folder / ".pending.json"
        journal.write_text(json.dumps({"label": interrupted["label"], "offsets": offsets}))
        orphan = self.session.images / interrupted["label"]
        orphan.write_bytes(b"\xff\xd8uncommitted\xff\xd9")
        # Interruption after only some of the four exports have been appended.
        for name in ("poses.txt", "reference.csv"):
            with (self.session.folder / name).open("ab") as file:
                file.write(interrupted["lines"][name].encode())
        receiver.Session(self.output, self.hello)
        self.assertEqual(self.exports(), before)
        self.assertEqual(committed.read_bytes(), b"\xff\xd8committed\xff\xd9")
        self.assertFalse(orphan.exists())
        self.assertFalse(journal.exists())

    def test_mismatched_pose_label_rejects_entire_shot(self):
        shot = self.capture(0)
        shot["lines"]["reference.csv"] = "frame_00001,1,2,3,0,0,0,0,0,0\n"
        before = self.exports()
        with self.assertRaises(receiver.CaptureError):
            self.session.persist(shot, b"\xff\xd8\xff\xd9")
        self.assertEqual(self.exports(), before)
        self.assertEqual(list(self.session.images.iterdir()), [])

    def test_truncated_wire_photo_gets_no_ack_or_partial_files(self):
        phone, desktop = socket.socketpair()
        phone.settimeout(2)
        errors = []

        def receive():
            try:
                with desktop:
                    receiver.run_receiver(desktop, self.output)
            except receiver.CaptureError as error:
                errors.append(error)

        thread = threading.Thread(target=receive, daemon=True)
        thread.start()
        self.addCleanup(phone.close)
        receiver.send_json(phone, self.hello)
        self.assertEqual(receiver.receive_json(phone)["type"], "ready")
        shot = self.capture(0)
        shot["jpeg_bytes"] = 100
        receiver.send_json(phone, shot)
        phone.sendall(b"\xff\xd8partial")
        phone.shutdown(socket.SHUT_WR)
        response = receiver.receive_json(phone)
        self.assertEqual(response["type"], "error")
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(list(self.session.images.iterdir()), [])
        self.assertTrue(all(data == b"" for data in self.exports().values()))


class ReceiverStartupTests(unittest.TestCase):
    def test_closed_forwarder_port_is_reusable_but_live_listener_is_rejected(self):
        with socket.create_server(("127.0.0.1", 0)) as listener:
            host, port = listener.getsockname()
            with socket.create_connection((host, port)) as client:
                peer, _ = listener.accept()
                peer.close()  # Active close leaves the forwarding port in TIME_WAIT.
                self.assertEqual(client.recv(1), b"")
        receiver.check_forwarding_port(host, port)
        with socket.create_server((host, port)):
            with self.assertRaises(receiver.CaptureError):
                receiver.check_forwarding_port(host, port)

    def test_startup_waits_past_closed_proxy_connection_without_consuming_hello(self):
        errors = []
        hello = {"type": "hello", "protocol": 1, "session": str(uuid.uuid4())}
        with socket.create_server(("127.0.0.1", 0)) as listener:
            listener.settimeout(3)
            host, port = listener.getsockname()

            def forwarder():
                try:
                    first, _ = listener.accept()
                    first.close()  # Local accept succeeded, but phone was not listening yet.
                    second, _ = listener.accept()
                    with second:
                        receiver.send_json(second, hello)
                        second.shutdown(socket.SHUT_WR)
                except BaseException as error:
                    errors.append(error)

            thread = threading.Thread(target=forwarder, daemon=True)
            thread.start()
            # A real child supplies the process-lifetime guard; traffic uses real TCP sockets.
            with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"],
                                  stdin=subprocess.PIPE) as proxy:
                try:
                    with receiver.connect(host, port, proxy, startup_timeout=3) as stream:
                        self.assertEqual(receiver.receive_json(stream), hello)
                finally:
                    proxy.stdin.close()
                    thread.join(timeout=4)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])


class ReceiverWiFiTests(unittest.TestCase):
    key = "0123456789abcdef0123456789abcdef"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name)
        self.hello = {
            "type": "hello", "protocol": 1,
            "session": "00000000-0000-0000-0000-000000000001",
            "headers": {name: "" for name in receiver.FILES},
        }

    def start_connection(self):
        phone, desktop = socket.socketpair()
        phone.settimeout(3)
        errors = []

        def receive():
            try:
                with desktop:
                    receiver.run_wifi_receiver(desktop, self.output, self.key)
            except (OSError, receiver.CaptureError, ValueError) as error:
                errors.append(error)

        thread = threading.Thread(target=receive, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 3)
        self.addCleanup(phone.close)
        return phone, thread, errors

    def proof(self, role, nonce):
        return hmac.new(self.key.encode(), (role + ":" + nonce).encode(), hashlib.sha256).hexdigest()

    def challenge(self, phone):
        challenge = receiver.receive_json(phone)
        self.assertEqual(challenge["type"], "challenge")
        self.assertEqual(challenge["protocol"], 1)
        self.assertRegex(challenge["nonce"], r"^[0-9a-f]{32}$")
        self.assertEqual(challenge["proof"], self.proof("receiver", challenge["nonce"]))
        return challenge

    def authentication(self, challenge):
        return {
            "type": "authenticate", "protocol": 1, "nonce": challenge["nonce"],
            "proof": self.proof("phone", challenge["nonce"]),
        }

    def authenticate(self, phone):
        receiver.send_json(phone, self.authentication(self.challenge(phone)))
        self.assertEqual(receiver.receive_json(phone), {"type": "authenticated", "protocol": 1})

    def assert_pairing_rejected(self, phone, thread, errors):
        self.assertEqual(receiver.receive_json(phone)["type"], "error")
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_pairing_key_is_stable_private_and_explicit_override_is_normalized(self):
        key = receiver.load_pairing_key(self.output)
        self.assertRegex(key, r"^[0-9a-f]{32}$")
        path = self.output / ".wifi-pairing-key"
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(receiver.load_pairing_key(self.output), key)
        self.assertEqual(receiver.load_pairing_key(self.output, self.key.upper()), self.key)
        self.assertEqual(receiver.load_pairing_key(self.output), self.key)

    def test_pairing_key_rejects_symlinks_insecure_permissions_and_hard_links(self):
        target = self.output / "secret"
        target.write_text(self.key + "\n")
        target.chmod(0o600)
        path = self.output / ".wifi-pairing-key"
        path.symlink_to(target)
        with self.assertRaises((OSError, receiver.CaptureError)):
            receiver.load_pairing_key(self.output)
        path.unlink()
        os.link(target, path)
        with self.assertRaises(receiver.CaptureError):
            receiver.load_pairing_key(self.output)
        path.unlink()
        target.rename(path)
        path.chmod(0o644)
        with self.assertRaises(receiver.CaptureError):
            receiver.load_pairing_key(self.output)
        self.assertEqual(path.read_text(), self.key + "\n")

    def test_authentication_rejects_wrong_proof_nonce_role_protocol_and_type(self):
        for invalid in ("proof", "nonce", "reflection", "protocol", "type", "uppercase"):
            with self.subTest(invalid=invalid):
                phone, thread, errors = self.start_connection()
                challenge = self.challenge(phone)
                message = self.authentication(challenge)
                if invalid == "proof":
                    message["proof"] = ("1" if message["proof"][0] == "0" else "0") + message["proof"][1:]
                elif invalid == "nonce":
                    message["nonce"] = "0" * 32 if challenge["nonce"] != "0" * 32 else "1" * 32
                elif invalid == "reflection":
                    message["proof"] = challenge["proof"]
                elif invalid == "protocol":
                    message["protocol"] = True
                elif invalid == "type":
                    message["type"] = "hello"
                else:
                    message["proof"] = "A" * 64
                receiver.send_json(phone, message)
                self.assert_pairing_rejected(phone, thread, errors)
                phone.close()

    def test_unauthenticated_hello_and_truncated_or_malformed_frames_never_create_session(self):
        frames = (
            json.dumps(self.hello).encode(),
            b"not json",
            b"[]",
            b'{"type":"authenticate"',
            b"[" * 2000 + b"]" * 2000,
            None,
        )
        for payload in frames:
            with self.subTest(payload=payload):
                phone, thread, errors = self.start_connection()
                self.challenge(phone)
                if payload is None:
                    phone.sendall(struct.pack("!I", receiver.MAX_JSON + 1))
                else:
                    phone.sendall(struct.pack("!I", len(payload)) + payload)
                phone.shutdown(socket.SHUT_WR)
                self.assert_pairing_rejected(phone, thread, errors)
                phone.close()

    def test_partial_authentication_frame_disconnect_never_creates_session(self):
        phone, thread, errors = self.start_connection()
        self.challenge(phone)
        phone.sendall(struct.pack("!I", 100) + b'{"type":')
        phone.shutdown(socket.SHUT_WR)
        self.assert_pairing_rejected(phone, thread, errors)

    def test_rejected_hello_cannot_recover_or_change_existing_capture_metadata(self):
        session = receiver.Session(self.output, self.hello)
        session.persist(capture_message(self.hello, 0), b"\xff\xd8\xff\xd9")
        offsets = {name: (session.folder / name).stat().st_size for name in receiver.FILES}
        (session.folder / ".pending.json").write_text(json.dumps({
            "label": "frame_00001.jpg", "offsets": offsets,
        }))
        (session.images / "frame_00001.jpg.part").write_bytes(b"interrupted")
        before = {path.relative_to(self.output): path.read_bytes()
                  for path in self.output.rglob("*") if path.is_file()}
        phone, thread, errors = self.start_connection()
        self.challenge(phone)
        receiver.send_json(phone, self.hello)
        self.assertEqual(receiver.receive_json(phone)["type"], "error")
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        after = {path.relative_to(self.output): path.read_bytes()
                 for path in self.output.rglob("*") if path.is_file()}
        self.assertEqual(after, before)

    def test_one_authentication_allows_pipelined_hello_and_continuous_session_switches(self):
        phone, thread, errors = self.start_connection()
        challenge = self.challenge(phone)
        # Both frames arrive before the desktop has acknowledged authentication.
        receiver.send_json(phone, self.authentication(challenge))
        receiver.send_json(phone, self.hello)
        self.assertEqual(receiver.receive_json(phone), {"type": "authenticated", "protocol": 1})
        self.assertEqual(receiver.receive_json(phone), {"type": "ready", "session": self.hello["session"]})
        first = dict(self.hello)
        second = {**self.hello, "session": "00000000-0000-0000-0000-000000000002"}
        for hello, index in ((first, 0), (second, 0), (first, 1)):
            if hello is not first or index:
                receiver.send_json(phone, hello)
                self.assertEqual(receiver.receive_json(phone), {"type": "ready", "session": hello["session"]})
            shot = capture_message(hello, index)
            receiver.send_json(phone, shot)
            phone.sendall(b"\xff\xd8\xff\xd9")
            self.assertEqual(receiver.receive_json(phone),
                             {"type": "ack", "session": hello["session"], "id": shot["id"]})
            folder = self.output / ("capture_" + hello["session"])
            self.assertEqual((folder / "images" / shot["label"]).read_bytes(), b"\xff\xd8\xff\xd9")
            self.assertFalse((folder / ".pending.json").exists())
            for name in receiver.FILES:
                self.assertTrue((folder / name).read_text().endswith(shot["lines"][name]))
        phone.shutdown(socket.SHUT_WR)
        self.assertEqual(receiver.receive_json(phone)["type"], "error")
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)

    def test_wifi_server_survives_rejected_and_disconnected_clients_without_replaying(self):
        with socket.create_server(("127.0.0.1", 0)) as reservation:
            port = reservation.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, "-u", str(Path(receiver.__file__)), "--wifi", "--bind", "127.0.0.1",
             "--port", str(port), "--output", str(self.output), "--pairing-code", self.key],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            env={**os.environ, "PATH": ""},
        )

        def stop():
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            reader.join(timeout=3)
            process.stdout.close()

        self.addCleanup(stop)
        lines = queue.Queue()

        def read_output():
            for line in process.stdout:
                lines.put(line)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        self.assertIn(f"127.0.0.1:{port}", lines.get(timeout=5))
        self.assertIn(self.key, lines.get(timeout=3))
        with socket.create_connection(("127.0.0.1", port), timeout=3) as rejected:
            self.challenge(rejected)
            receiver.send_json(rejected, self.hello)
            self.assertEqual(receiver.receive_json(rejected)["type"], "error")
        self.assertFalse(any(self.output.glob("capture_*")))
        with socket.create_connection(("127.0.0.1", port), timeout=3) as phone:
            self.authenticate(phone)
            receiver.send_json(phone, self.hello)
            self.assertEqual(receiver.receive_json(phone)["type"], "ready")
            shot = capture_message(self.hello, 0)
            receiver.send_json(phone, shot)
            phone.sendall(b"\xff\xd8\xff\xd9")
            self.assertEqual(receiver.receive_json(phone)["type"], "ack")
        folder = self.output / ("capture_" + self.hello["session"])
        before = {name: (folder / name).read_bytes() for name in receiver.FILES}
        with socket.create_connection(("127.0.0.1", port), timeout=3) as phone:
            self.authenticate(phone)
            receiver.send_json(phone, self.hello)
            self.assertEqual(receiver.receive_json(phone)["type"], "ready")
        self.assertEqual({name: (folder / name).read_bytes() for name in receiver.FILES}, before)
        self.assertEqual([path.name for path in (folder / "images").iterdir()], ["frame_00000.jpg"])



if __name__ == "__main__":
    unittest.main()
