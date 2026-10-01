"""The check a view build's session runs on its draft (prompts/dev-view.md's `{{check}}`): it posts the locators it is
given to the view's check route and prints the server's answer.

The session's Bash sandbox has no network (on Linux a network namespace of its own), so this one command is excluded
from the sandbox by its exact prefix (`sandbox.excludedCommands`). curl is not excluded instead because it can reach
any
URL or write files; this script only posts to a view's check route on 127.0.0.1 and writes nothing. The post proves it
holds the token in the server.json of thimble's home `--home` (app/call_ref.py's server) as the plugin's hooks do, since
the server refuses a write that proves neither the token nor the analyst's cookie (hook_auth.LocalWriteGuard).

Usage: `python -S view_check.py --home <thimble home> <check URL> [--picture] [<locator>...]`, `--picture` asking for a
picture of the page as it opens. Standard library only. Exit 0 with the answer on stdout, 1 when the route errored or
did not answer, 2 for a URL that is not a view's check route on 127.0.0.1."""
from __future__ import annotations

import importlib.util
import json
import re
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path

URL_RE = re.compile(r"^http://127\.0\.0\.1:\d{1,5}/api/ws/[^/\s?#]+/views/[^/\s?#]+/check$")
TIMEOUT_S = 900  # the route loads the page headless; a big corpus's index takes minutes to build


def proof(home: str = "") -> dict[str, str]:
    """The headers that prove the token in `home`'s server.json (call_ref.server and sign, loaded from the file beside
    this one, as this runs as a script outside the app package); {} when there is no token to prove, and the server
    refuses."""
    try:
        spec = importlib.util.spec_from_file_location("thimble_call_ref", Path(__file__).with_name("call_ref.py"))
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


def main(argv: list[str]) -> int:
    home = ""
    if argv[:1] == ["--home"] and len(argv) > 1:
        home, argv = argv[1], argv[2:]
    if not argv or not URL_RE.match(argv[0]):
        sys.stderr.write("usage: view_check.py --home <thimble home> <a view's check URL on 127.0.0.1>"
                         " [--picture] [<locator>...]\n")
        return 2
    rest = argv[1:]
    picture = "--picture" in rest
    body = json.dumps({"locators": [a for a in rest if a != "--picture"], "picture": picture}).encode("utf-8")
    req = urllib.request.Request(argv[0], data=body, method="POST",
                                 headers={"Content-Type": "application/json", **proof(home)})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # the server is local: never a proxy
    try:
        with opener.open(req, timeout=TIMEOUT_S) as resp:
            sys.stdout.write(resp.read().decode("utf-8", "replace") + "\n")
    except urllib.error.HTTPError as e:
        sys.stdout.write(e.read().decode("utf-8", "replace") + "\n")
        return 1
    except OSError as e:
        sys.stderr.write(f"the check route did not answer: {e}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
