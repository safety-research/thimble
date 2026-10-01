#!/bin/sh
''''exec "${THIMBLE_PYTHON:-python3}" "$0" "$@" # '''
"""The `claude` an agent program's Agent SDK runs (thimble.options sets it as cli_path). It asks thimble's server to
start the session on the analyst's own claude, outside the program's sandbox, with the role's permission mode,
sandbox, settings and tools, and passes the session's stdin, stdout and stderr through a WebSocket.

The first two lines make this file both a shell script and a Python program: `sh` runs the `exec` line, which re-runs
the file under THIMBLE_PYTHON, thimble's own Python; Python reads that line as a string literal.

It proves the program's token (THIMBLE_AGENT_TOKEN, `<id>.<secret>`) as thimble's hooks prove theirs: AGENT_HEADER
names the id, and the request carries a nonce and HMAC-SHA256(token, "hook:" + nonce). Frames: a text frame
{"argv", "cwd"} first, then the session's stdin as binary frames and {"eof": true} when it closes; the server sends
binary frames whose first byte is `o` (stdout) or `e` (stderr), and {"exit": code} last."""
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

PATH = "/api/agent/claude"
CHUNK = 65536


def main(argv: list[str]) -> int:
    api = os.environ.get("THIMBLE_API", "").rstrip("/")
    token = os.environ.get("THIMBLE_AGENT_TOKEN", "")
    if not api or "." not in token:
        print("thimble's claude: THIMBLE_API and THIMBLE_AGENT_TOKEN are not set", file=sys.stderr)
        return 2
    nonce = secrets.token_hex(16)
    proof = hmac.new(token.encode(), f"hook:{nonce}".encode(), hashlib.sha256).hexdigest()
    headers = {"x-thimble-agent": token.split(".", 1)[0], "x-thimble-nonce": nonce, "x-thimble-auth": proof}
    url = "ws" + api[len("http"):] + PATH if api.startswith("http") else api + PATH
    try:
        ws = connect(url, additional_headers=headers, max_size=None, open_timeout=30)
    except Exception as e:  # noqa: BLE001 — any failure to connect ends the session with its reason
        print(f"thimble's claude: could not reach thimble at {api}: {e}", file=sys.stderr)
        return 1
    ws.send(json.dumps({"argv": argv, "cwd": os.getcwd()}))

    def feed() -> None:
        try:
            while True:
                data = os.read(0, CHUNK)
                if not data:
                    break
                ws.send(data)
            ws.send(json.dumps({"eof": True}))
        except (OSError, ConnectionClosed):
            pass

    threading.Thread(target=feed, daemon=True).start()
    code = 1
    try:
        for frame in ws:
            if isinstance(frame, bytes):
                out = sys.stdout.buffer if frame[:1] == b"o" else sys.stderr.buffer
                out.write(frame[1:])
                out.flush()
            else:
                msg = json.loads(frame)
                if "exit" in msg:
                    code = int(msg["exit"])
                    break
    except ConnectionClosed:
        pass
    finally:
        try:
            ws.close()
        except Exception:  # noqa: BLE001
            pass
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
