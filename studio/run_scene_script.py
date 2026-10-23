#!/usr/bin/env python3
"""Run a Workcell Studio scene script through the loopback scene-control API."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_SERVER = "http://127.0.0.1:4174"
MAX_SCRIPT_BYTES = 64 * 1024


def request_json(url: str, *, method: str = "GET", payload: object | None = None) -> dict:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=body,
        method=method,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": url.split("/api/", 1)[0],
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"scene API returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(
            "Workcell Studio is unavailable. Start it with `bun run serve` or `bun run dev:server`."
        ) from error


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("script", help="Python file, or - to read from standard input")
    parser.add_argument("--server", default=DEFAULT_SERVER, help="Scene API base URL")
    arguments = parser.parse_args()

    if arguments.script == "-":
        script = sys.stdin.read()
    else:
        script = Path(arguments.script).read_text(encoding="utf-8")
    if len(script.encode("utf-8")) > MAX_SCRIPT_BYTES:
        raise SystemExit("scene script exceeds the 64 KiB limit")

    server = arguments.server.rstrip("/")
    snapshot = request_json(f"{server}/api/scene")
    result = request_json(
        f"{server}/api/scene/python",
        method="POST",
        payload={"expectedRevision": snapshot["revision"], "script": script},
    )
    output = result.get("output", "")
    if output:
        print(output, end="" if output.endswith("\n") else "\n")
    print(
        json.dumps(
            {
                "revision": result["revision"],
                "updatedAt": result["document"]["updatedAt"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
