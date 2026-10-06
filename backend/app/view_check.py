"""The check a view build's session runs on its draft (prompts/dev-view.md's `{{check}}`): it posts the locators it is
given to the view's check route and prints the server's answer.

The session's Bash sandbox has no network (on Linux a network namespace of its own), so this one command is excluded
from the sandbox by its exact prefix (`sandbox.excludedCommands`). curl is not excluded instead because it can reach any
URL or write files; this script only posts to a view's check route on 127.0.0.1. The post proves it holds the token in
the server.json of thimble's home `--home` (app/permission_hook.py's server) as the plugin's hooks do, since the server refuses
a write that proves neither the token nor the analyst's cookie (hook_auth.LocalWriteGuard).

A command that runs inside the sandbox, as one after `cd` or in a pipeline does, reaches neither the server nor
server.json. Then the request goes as a file `<id>.json` in the view folder's `.check` folder (`--folder`), which the
server watches while the session runs (views.watch_checks): it renames the file `<id>.taken` and writes the answer to
`<id>.answer.json`.

Usage: `python -S view_check.py --home <thimble home> --folder <view folder> <check URL> [--picture] [<locator>...]`,
`--picture` asking for a picture of the page as it opens. Standard library only. Exit 0 with the answer on stdout, 1
when the route errored or nothing answered, 2 for a URL that is not a view's check route on 127.0.0.1."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

URL_RE = re.compile(r"^http://127\.0\.0\.1:\d{1,5}/api/ws/[^/\s?#]+/views/[^/\s?#]+/check$")
TIMEOUT_S = 900  # the route loads the page headless; a big corpus's index takes minutes to build
DROP = ".check"  # views.CHECK_DROP
PICKUP_S = 15.0  # a request the server has not taken by then has no server watching for it
POLL_S = 0.25


def proof(home: str = "") -> dict[str, str]:
    """The headers that prove the token in `home`'s server.json (permission_hook.server and sign, loaded from the file
    beside this one, as this runs as a script outside the app package); {} when there is no token to prove, and the
    server refuses."""
    try:
        spec = importlib.util.spec_from_file_location("thimble_permission_hook", Path(__file__).with_name("permission_hook.py"))
        if spec is None or spec.loader is None:
            return {}
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        found = mod.server(home)
    except (OSError, SyntaxError):
        return {}
    if found is None:
        return {}
    nonce = secrets.token_hex(16)
    return {"X-Thimble-Nonce": nonce, "X-Thimble-Auth": mod.sign(found[1], "hook", nonce)}


def dropped(folder: str, body: dict) -> int:
    """The request left as a file in `folder`'s DROP folder and the server's answer printed (module note)."""
    drop = Path(folder) / DROP
    rid = secrets.token_hex(12)
    req, taken, answer = drop / f"{rid}.json", drop / f"{rid}.taken", drop / f"{rid}.answer.json"
    try:
        drop.mkdir(exist_ok=True)
        part = drop / f"{rid}.part"
        part.write_text(json.dumps(body), "utf-8")
        os.replace(part, req)
    except OSError as e:
        sys.stderr.write(f"the check could not reach the server, nor leave its request in {drop}: {e}\n")
        return 1
    start = time.monotonic()
    while time.monotonic() - start < TIMEOUT_S:
        if answer.is_file():
            sys.stdout.write(answer.read_text("utf-8") + "\n")
            answer.unlink(missing_ok=True)
            return 0
        if req.is_file() and time.monotonic() - start > PICKUP_S:
            req.unlink(missing_ok=True)
            sys.stderr.write("the check could not reach the server, and no server took its request: the server checks"
                             " the view when the turn ends\n")
            return 1
        time.sleep(POLL_S)
    req.unlink(missing_ok=True)
    taken.unlink(missing_ok=True)
    sys.stderr.write(f"the check got no answer in {TIMEOUT_S} s\n")
    return 1


def main(argv: list[str]) -> int:
    home = folder = ""
    while argv[:1] in (["--home"], ["--folder"]) and len(argv) > 1:
        if argv[0] == "--home":
            home = argv[1]
        else:
            folder = argv[1]
        argv = argv[2:]
    if not argv or not URL_RE.match(argv[0]):
        sys.stderr.write("usage: view_check.py --home <thimble home> --folder <view folder> <a view's check URL on"
                         " 127.0.0.1> [--picture] [<locator>...]\n")
        return 2
    rest = argv[1:]
    picture = "--picture" in rest
    body = {"locators": [a for a in rest if a != "--picture"], "picture": picture}
    headers = proof(home)
    if not headers and folder:
        return dropped(folder, body)
    req = urllib.request.Request(argv[0], data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # the server is local: never a proxy
    try:
        with opener.open(req, timeout=TIMEOUT_S) as resp:
            sys.stdout.write(resp.read().decode("utf-8", "replace") + "\n")
    except urllib.error.HTTPError as e:
        sys.stdout.write(e.read().decode("utf-8", "replace") + "\n")
        return 1
    except urllib.error.URLError as e:
        if folder and isinstance(e.reason, OSError):
            return dropped(folder, body)
        sys.stderr.write(f"the check route did not answer: {e}\n")
        return 1
    except OSError as e:
        sys.stderr.write(f"the check route did not answer: {e}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
