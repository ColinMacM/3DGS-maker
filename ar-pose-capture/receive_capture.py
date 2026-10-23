#!/usr/bin/env python3
"""Receive ARPoseCapture shots over USB, Wi-Fi, or loopback --direct smoke mode.

USB: brew install libimobiledevice libusbmuxd
     Unlock the iPhone, trust this computer, open the app and select USB stream.
     python3 receive_capture.py --output captures [--udid DEVICE_UDID]
Wi-Fi: python3 receive_capture.py --wifi --output captures
       Enter this computer's LAN/Tailscale address and the printed pairing key.
       Pairing authenticates peers; TCP payload is plaintext, not TLS.
Direct: python3 receive_capture.py --direct --host 127.0.0.1 --port 39001

Protocol 1: uint32 big-endian JSON byte length, UTF-8 JSON object, then exactly
jpeg_bytes raw bytes for capture messages only. Max JSON 64 KiB; max JPEG 64 MiB.
Phone: hello(protocol,session,headers), capture(session,id,label,lines,jpeg_bytes).
Receiver: ready(session), ack(session,id), error(session,message).
A new hello changes origin/session on the same connection. ACK means all files
and their directory entries were fsynced. No automatic recapture/retry is attempted.
Wi-Fi authenticates once per connection with HMAC-SHA256 challenge proofs before
the normal protocol. Session changes do not reconnect or repeat authentication.
"""

import argparse
import errno
import contextlib
import hashlib
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import secrets
import socket
import struct
import stat
import subprocess
import sys
import time
import uuid

MAX_JSON = 65536
MAX_JPEG = 64 * 1024 * 1024
FILES = ("poses.txt", "intrinsics.txt", "reference.csv", "quaternion.txt")
LABEL = re.compile(r"frame_[0-9]{5,8}\.jpg\Z")
PAIRING_CODE = re.compile(r"[0-9a-f]{32}\Z")
AUTH_TIMEOUT = 10


class CaptureError(Exception):
    pass


def identifier(value):
    if not isinstance(value, str) or len(value) != 36:
        raise CaptureError("Invalid session/capture identifier")
    try:
        if str(uuid.UUID(value)) != value.lower():
            raise ValueError()
    except ValueError as exc:
        raise CaptureError("Invalid session/capture identifier") from exc
    return value.lower()


def recv_exact(sock, count, deadline=None):
    data = bytearray(count)
    view = memoryview(data)
    offset = 0
    while offset < count:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Wi-Fi authentication timed out")
            sock.settimeout(remaining)
        received = sock.recv_into(view[offset:])
        if not received:
            raise CaptureError("Phone disconnected; any unacknowledged shot is uncertain. Check output before recapturing.")
        offset += received
    return data


def receive_json(sock, deadline=None):
    length, = struct.unpack("!I", recv_exact(sock, 4, deadline))
    if not 1 <= length <= MAX_JSON:
        raise CaptureError("Invalid JSON frame length")
    try:
        message = json.loads(recv_exact(sock, length, deadline))
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise CaptureError("Malformed JSON frame") from exc
    if not isinstance(message, dict):
        raise CaptureError("Expected a JSON object")
    return message


def send_json(sock, message):
    data = json.dumps(message, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(data) > MAX_JSON:
        raise CaptureError("Outgoing metadata exceeds protocol limit")
    sock.sendall(struct.pack("!I", len(data)) + data)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_synced(path, data):
    with path.open("xb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def safe_child(parent, name):
    path = parent / name
    if path.is_symlink():
        raise CaptureError(f"Refusing symlink: {path}")
    return path


class Session:
    def __init__(self, output, message):
        if type(message.get("protocol")) is not int or message["protocol"] != 1:
            raise CaptureError("Unsupported protocol version")
        self.id = identifier(message.get("session"))
        headers = message.get("headers")
        if not isinstance(headers, dict) or set(headers) != set(FILES):
            raise CaptureError("Expected all four export headers")
        for header in headers.values():
            if not isinstance(header, str) or len(header.encode("utf-8")) > 4096 or "\x00" in header:
                raise CaptureError("Invalid export header")
        self.folder = safe_child(output, "capture_" + self.id)
        self.folder.mkdir(exist_ok=True)
        self.images = safe_child(self.folder, "images")
        self.images.mkdir(exist_ok=True)
        for name in FILES:
            path = safe_child(self.folder, name)
            data = headers[name].encode("utf-8")
            if not path.exists():
                write_synced(path, data)
            else:
                with path.open("rb") as file:
                    if file.read(len(data)) != data:
                        raise CaptureError(f"Header differs from existing {path}")
        self.recover()
        fsync_directory(self.images)
        fsync_directory(self.folder)
        fsync_directory(output)

    def recover(self):
        journal = safe_child(self.folder, ".pending.json")
        if not journal.exists():
            return
        record = json.loads(journal.read_text(encoding="utf-8"))
        label = record.get("label")
        offsets = record.get("offsets")
        if not isinstance(label, str) or not LABEL.fullmatch(label) or not isinstance(offsets, dict) or set(offsets) != set(FILES):
            raise CaptureError(f"Invalid recovery journal: {journal}")
        for name, offset in offsets.items():
            path = safe_child(self.folder, name)
            if type(offset) is not int or not 0 <= offset <= path.stat().st_size:
                raise CaptureError(f"Invalid recovery offset: {journal}")
        for name, offset in offsets.items():
            with safe_child(self.folder, name).open("r+b") as file:
                file.truncate(offset)
                file.flush()
                os.fsync(file.fileno())
        safe_child(self.images, label).unlink(missing_ok=True)
        safe_child(self.images, label + ".part").unlink(missing_ok=True)
        fsync_directory(self.images)
        journal.unlink()
        fsync_directory(self.folder)

    def persist(self, message, jpeg):
        label = message.get("label")
        if not isinstance(label, str) or not LABEL.fullmatch(label):
            raise CaptureError("Unsafe image label")
        lines = message.get("lines")
        if not isinstance(lines, dict) or set(lines) != set(FILES):
            raise CaptureError("Capture lacks matching pose/intrinsics/reference/quaternion rows")
        for name, count in (("poses.txt", 17), ("intrinsics.txt", 7), ("reference.csv", 10), ("quaternion.txt", 5)):
            line = lines[name]
            if not isinstance(line, str) or len(line.encode("utf-8")) > 4096 or not line.endswith("\n") or line.count("\n") != 1 or "\r" in line or "\x00" in line:
                raise CaptureError(f"Invalid {name} row")
            fields = line.strip().split(",") if name == "reference.csv" else line.split()
            expected = label[:-4] if name == "reference.csv" else label
            if len(fields) != count or fields[0] != expected:
                raise CaptureError(f"Mismatched {name} row")
            try:
                values = [float(value) for value in fields[1:]]
                if not all(math.isfinite(value) for value in values):
                    raise ValueError()
                if name == "quaternion.txt" and abs(sum(value * value for value in values) - 1) > 0.001:
                    raise ValueError()
                if name == "intrinsics.txt" and (min(values[:2]) <= 0 or any(value <= 0 or not value.is_integer() for value in values[4:])):
                    raise ValueError()
            except ValueError as exc:
                raise CaptureError(f"Invalid numeric values in {name}") from exc
        if not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
            raise CaptureError("Invalid JPEG boundaries")
        image = safe_child(self.images, label)
        temporary = safe_child(self.images, label + ".part")
        if image.exists() or temporary.exists():
            raise CaptureError(f"Refusing duplicate image {label}; no file was overwritten")
        offsets = {name: safe_child(self.folder, name).stat().st_size for name in FILES}
        journal = safe_child(self.folder, ".pending.json")
        # Journal is durable before changing any export. A crash before commit rolls back on reopen.
        write_synced(journal, json.dumps({"label": label, "offsets": offsets}).encode("utf-8"))
        fsync_directory(self.folder)
        try:
            write_synced(temporary, jpeg)
            os.replace(temporary, image)
            fsync_directory(self.images)
            for name in FILES:
                with safe_child(self.folder, name).open("ab") as file:
                    file.write(lines[name].encode("utf-8"))
                    file.flush()
                    os.fsync(file.fileno())
            journal.unlink()
            fsync_directory(self.folder)
        except BaseException:
            self.recover()
            raise
        return image


def run_receiver(sock, output):
    session = None
    current_session = ""
    try:
        while True:
            # An idle photographer has no deadline. Framing/JPEG reads have finite deadlines.
            sock.settimeout(None if session is not None else 10)
            first = sock.recv(1, socket.MSG_PEEK)
            if not first:
                raise CaptureError("Phone disconnected; any unacknowledged shot is uncertain. Check output before recapturing.")
            sock.settimeout(30)
            message = receive_json(sock)
            identifier(message.get("session"))
            current_session = message["session"]
            kind = message.get("type")
            if kind == "hello":
                session = Session(output, message)
                send_json(sock, {"type": "ready", "session": message["session"]})
                print(f"Ready: {session.folder}", flush=True)
            elif kind == "capture":
                if session is None or current_session.lower() != session.id:
                    raise CaptureError("Capture arrived before matching session handshake")
                identifier(message.get("id"))
                length = message.get("jpeg_bytes")
                if type(length) is not int or not 4 <= length <= MAX_JPEG:
                    raise CaptureError("Invalid JPEG length")
                jpeg = recv_exact(sock, length)
                image = session.persist(message, jpeg)
                send_json(sock, {"type": "ack", "session": message["session"], "id": message["id"]})
                print(f"Saved: {image}", flush=True)
            else:
                raise CaptureError("Unknown phone message type")
    except (OSError, CaptureError, ValueError) as exc:
        if current_session:
            with contextlib.suppress(OSError, CaptureError):
                send_json(sock, {"type": "error", "session": current_session, "message": str(exc)[:1024]})
        raise


def pairing_code(value):
    if not isinstance(value, str) or not PAIRING_CODE.fullmatch(value.lower()):
        raise CaptureError("Pairing code must be exactly 32 hexadecimal characters")
    return value.lower()


def load_pairing_key(output, override=None):
    """Keep the shared secret private, including when opening an existing key."""
    if override is not None:
        override = pairing_code(override)
    path = output / ".wifi-pairing-key"
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
    created = False
    try:
        descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
    except FileExistsError:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise CaptureError(f"Cannot create private pairing key {path}: {exc}") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise CaptureError(f"Pairing key must be an owned regular file with mode 0600: {path}")
        if info.st_nlink != 1:
            raise CaptureError(f"Refusing a hard-linked pairing key: {path}")
        with os.fdopen(descriptor, "r+b") as file:
            descriptor = None
            if created:
                key = override or secrets.token_hex(16)
            else:
                try:
                    key = pairing_code(file.read(34).decode("ascii").removesuffix("\n"))
                except (UnicodeError, CaptureError) as exc:
                    raise CaptureError(f"Invalid pairing key file: {path}") from exc
                key = override or key
            if created or override is not None:
                file.seek(0)
                file.write((key + "\n").encode("ascii"))
                file.truncate()
                file.flush()
                os.fsync(file.fileno())
        if created:
            fsync_directory(output)
        return key
    finally:
        if descriptor is not None:
            os.close(descriptor)


def pairing_proof(key, role, nonce):
    return hmac.new(key.encode("utf-8"), f"{role}:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def authenticate_wifi(sock, key):
    nonce = secrets.token_hex(16)
    deadline = time.monotonic() + AUTH_TIMEOUT
    sock.settimeout(AUTH_TIMEOUT)
    try:
        send_json(sock, {"type": "challenge", "protocol": 1, "nonce": nonce,
                         "proof": pairing_proof(key, "receiver", nonce)})
        message = receive_json(sock, deadline)
        proof = message.get("proof")
        if (message.get("type") != "authenticate"
                or type(message.get("protocol")) is not int or message["protocol"] != 1
                or message.get("nonce") != nonce
                or not isinstance(proof, str)
                or not re.fullmatch(r"[0-9a-f]{64}", proof)
                or not hmac.compare_digest(proof, pairing_proof(key, "phone", nonce))):
            raise CaptureError("Wi-Fi pairing failed")
        sock.settimeout(max(0.001, deadline - time.monotonic()))
        send_json(sock, {"type": "authenticated", "protocol": 1})
    except (OSError, CaptureError, ValueError) as exc:
        with contextlib.suppress(OSError, CaptureError):
            # A timed-out client must not hold the server open while rejecting it.
            sock.settimeout(1)
            send_json(sock, {"type": "error", "message": "Wi-Fi pairing failed"})
        raise CaptureError("Wi-Fi pairing failed") from exc


def run_wifi_receiver(sock, output, key):
    authenticate_wifi(sock, key)
    run_receiver(sock, output)


def wifi_listener(bind, port):
    try:
        addresses = socket.getaddrinfo(bind, port, socket.AF_UNSPEC, socket.SOCK_STREAM,
                                       0, socket.AI_PASSIVE)
    except OSError as exc:
        raise CaptureError(f"Cannot listen on {bind}:{port}: {exc}") from exc
    last_error = None
    for family, kind, protocol, _, address in addresses:
        listener = socket.socket(family, kind, protocol)
        try:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(address)
            listener.listen(4)
            return listener
        except OSError as exc:
            listener.close()
            last_error = exc
    raise CaptureError(f"Cannot listen on {bind}:{port}: {last_error}")


def serve_wifi(listener, output, key):
    while True:
        sock, address = listener.accept()
        print(f"Wi-Fi client connected: {address}", flush=True)
        with sock:
            try:
                run_wifi_receiver(sock, output, key)
            except (OSError, CaptureError, ValueError) as exc:
                print(f"Wi-Fi client closed: {exc}", file=sys.stderr, flush=True)
        print("Waiting for the next Wi-Fi connection; no captures are replayed.", flush=True)


def usb_device(udid):
    for executable in ("iproxy", "idevice_id", "idevicepair"):
        if shutil.which(executable) is None:
            raise CaptureError(f"Missing {executable}. Install: brew install libimobiledevice libusbmuxd")
    result = subprocess.run(["idevice_id", "-l"], text=True, capture_output=True, check=True)
    devices = result.stdout.split()
    if udid:
        if udid not in devices:
            raise CaptureError("Requested UDID is not connected over USB. Unlock, reconnect and trust this computer.")
    elif len(devices) == 1:
        udid = devices[0]
    elif not devices:
        raise CaptureError("No USB iPhone found. Connect/unlock it and accept Trust This Computer.")
    else:
        raise CaptureError("Multiple USB devices found; choose --udid from: " + ", ".join(devices))
    result = subprocess.run(["idevicepair", "-u", udid, "validate"], text=True, capture_output=True)
    if result.returncode:
        raise CaptureError("USB pairing failed. Unlock and trust this computer; run idevicepair -u " + udid + " pair.\n" + result.stdout + result.stderr)
    return udid


def check_forwarding_port(host, port):
    # A recently closed forwarded connection can leave TIME_WAIT on this port.
    # Match iproxy's reuse policy, but still reject an actively bound listener.
    try:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((host, port))
            probe.listen(1)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            raise CaptureError(
                f"Computer port {port} is in use. Stop the other receiver/iproxy, "
                "or choose another computer port with --port."
            ) from exc
        raise


def connect(host, port, proxy, startup_timeout=30):
    deadline = time.monotonic() + (startup_timeout if proxy is not None else 2)
    while True:
        if proxy is not None and proxy.poll() is not None:
            raise CaptureError("iproxy exited. Check its error above, USB pairing, and the selected app destination.")
        sock = None
        stream_started = False
        try:
            sock = socket.create_connection((host, port), timeout=2)
            sock.settimeout(min(2, max(0.01, deadline - time.monotonic())))
            # iproxy accepts locally even if the iPhone port is not listening.
            # Wait for phone data, not merely a successful localhost TCP connect.
            # Peeking leaves the complete hello for run_receiver to validate.
            stream_started = bool(sock.recv(1, socket.MSG_PEEK))
            if stream_started:
                return sock
        except OSError:
            pass
        finally:
            if sock is not None and not stream_started:
                sock.close()
        remaining = deadline - time.monotonic()
        if proxy is None or remaining <= 0:
            raise CaptureError(
                "No capture stream received from the iPhone. Unlock it, open AR Pose Capture, "
                "select USB stream, and keep the app in the foreground. Check its USB status, "
                "then run the receiver again."
            )
        time.sleep(min(0.5, remaining))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, default=Path("captures"), help="Capture output root (default: captures)")
    parser.add_argument("--udid", help="USB device identifier; required when several devices are attached")
    parser.add_argument("--port", type=int, help="Computer TCP port (Wi-Fi default: 39003; USB/direct default: 39001)")
    parser.add_argument("--device-port", type=int, help="USB iPhone listener port (default: 39001)")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--direct", action="store_true", help="Connect directly to a loopback listener without iproxy; desktop smoke testing only")
    modes.add_argument("--wifi", action="store_true", help="Listen for authenticated iPhone TCP connections; no USB tools required")
    parser.add_argument("--host", help="Loopback IP address in --direct mode (default: 127.0.0.1)")
    parser.add_argument("--bind", help="Listening IP address or hostname in --wifi mode (default: 0.0.0.0; IPv6 example: ::)")
    parser.add_argument("--pairing-code", help="Wi-Fi shared secret: exactly 32 hexadecimal characters; saved in output/.wifi-pairing-key")
    args = parser.parse_args()
    if args.wifi:
        if args.udid is not None or args.device_port is not None or args.host is not None:
            parser.error("--wifi is incompatible with --udid, --device-port and --host; use --bind for the listening address")
        args.port = 39003 if args.port is None else args.port
        args.bind = "0.0.0.0" if args.bind is None else args.bind
        if args.pairing_code is not None:
            try:
                args.pairing_code = pairing_code(args.pairing_code)
            except CaptureError as exc:
                parser.error(str(exc))
    else:
        if args.bind is not None or args.pairing_code is not None:
            parser.error("--bind and --pairing-code require --wifi")
        if args.direct and (args.udid is not None or args.device_port is not None):
            parser.error("--udid and --device-port are incompatible with --direct")
        if not args.direct and args.host is not None:
            parser.error("--host requires --direct; USB forwarding always uses 127.0.0.1")
        args.host = "127.0.0.1" if args.host is None else args.host
        args.port = 39001 if args.port is None else args.port
        try:
            if not ipaddress.ip_address(args.host).is_loopback:
                parser.error("--direct only allows loopback hosts; use --wifi for LAN/Tailscale streaming")
        except ValueError:
            parser.error("--host must be a numeric loopback IP address")
    args.device_port = 39001 if args.device_port is None else args.device_port
    if not all(1 <= port <= 65535 for port in (args.port, args.device_port)):
        parser.error("Ports must be in 1...65535")
    proxy = None
    try:
        args.output.mkdir(parents=True, exist_ok=True)
        output = args.output.resolve()
        if args.wifi:
            key = load_pairing_key(output, args.pairing_code)
            with wifi_listener(args.bind, args.port) as listener:
                address = listener.getsockname()
                print(f"Wi-Fi listening on {address[0]}:{address[1]}", flush=True)
                print(f"Wi-Fi pairing key: {key}", flush=True)
                print(
                    f"On iPhone, select Wi-Fi stream and enter this computer's LAN or Tailscale "
                    f"IPv4/MagicDNS address, port {address[1]}, and the pairing key. "
                    "Allow incoming TCP through the computer firewall. Pairing authenticates peers "
                    "but does not encrypt captures; use a trusted LAN or Tailscale, never a public port forward.",
                    flush=True,
                )
                serve_wifi(listener, output, key)
            return 0
        if not args.direct:
            udid = usb_device(args.udid)
            check_forwarding_port("127.0.0.1", args.port)
            command = ["iproxy", "--local", "--source", "127.0.0.1", "--udid", udid,
                       f"{args.port}:{args.device_port}"]
            print("Starting USB-only forwarding:", " ".join(command), flush=True)
            # iproxy's stdout is per-connection chatter; keep diagnostic stderr visible.
            proxy = subprocess.Popen(command, stdout=subprocess.DEVNULL)
            print("Waiting up to 30 seconds for the iPhone. Open AR Pose Capture and select USB stream.", flush=True)
        with connect(args.host, args.port, proxy) as sock:
            run_receiver(sock, output)
    except KeyboardInterrupt:
        print("\nReceiver stopped; check output for any shot whose ACK was interrupted.", file=sys.stderr)
        return 130
    except (OSError, CaptureError, ValueError, subprocess.SubprocessError) as exc:
        print(f"Capture receiver error: {exc}", file=sys.stderr)
        return 1
    finally:
        if proxy is not None:
            proxy.terminate()
            try:
                proxy.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
