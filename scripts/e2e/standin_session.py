"""A stand-in for the analyst's Claude Code session, for the end-to-end test (scripts/e2e_release.sh).

    <tree>/backend/.venv/bin/python scripts/e2e/standin_session.py <tree> <corpus folder>

It holds the subscription the plugin's MCP shim holds in a real session (GET /api/channel, signed with the token in
$THIMBLE_HOME/server.json), which attaches a session to the workspace's main, so the UI is not greyed out under "No
Claude Code session connected". Events the server sends are read and dropped: no model runs. It subscribes again
after a dropped connection and runs until it is killed.
"""
import json
import os
import secrets
import sys
import time
import urllib.parse
import uuid
from pathlib import Path

tree, corpus = Path(sys.argv[1]).resolve(), str(Path(sys.argv[2]).resolve())
sys.path.insert(0, str(tree / "backend"))

import httpx  # noqa: E402

from app import hook_auth  # noqa: E402

SESSION = os.environ.get("THIMBLE_E2E_SESSION") or str(uuid.uuid4())


def server() -> tuple[str, str] | None:
    home = Path(os.environ.get("THIMBLE_HOME") or Path.home() / ".thimble")
    try:
        st = json.loads((home / "server.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    api, tok = st.get("api") or st.get("url"), st.get("token")
    return (str(api), str(tok)) if api and tok else None


def main() -> None:
    query = urllib.parse.urlencode({"cwd": corpus, "session": SESSION, "pid": os.getpid(), "delivery": "channel",
                                    "config_dir": ""})
    print(f"standin: session {SESSION}", flush=True)
    while True:
        found = server()
        if found:
            try:
                headers = hook_auth.headers(found[1], secrets.token_hex(16))
                with httpx.Client(timeout=httpx.Timeout(None, connect=3.0)) as client:
                    with client.stream("GET", f"{found[0]}/api/channel?{query}", headers=headers) as resp:
                        print(f"standin: subscribed, HTTP {resp.status_code}", flush=True)
                        for _ in resp.iter_lines():
                            pass
            except httpx.HTTPError as e:
                print(f"standin: {type(e).__name__}: {e}", flush=True)
        time.sleep(1.0)


if __name__ == "__main__":
    main()
