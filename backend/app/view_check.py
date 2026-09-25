"""The check a view build's session runs on its draft (prompts/dev-view.md's `{{check}}`): it posts the locators it is
given to the view's check route and prints the server's answer.

The session's Bash sandbox has no network (on Linux a network namespace of its own), so this one command is excluded
from the sandbox by its exact prefix (`sandbox.excludedCommands`). curl is not excluded instead because it can reach
any
URL or write files; this script only posts to a view's check route on 127.0.0.1 and writes nothing.

Usage: `python -S view_check.py <check URL> [<locator>...]`. Standard library only. Exit 0 with the answer on stdout,
1
when the route errored or did not answer, 2 for a URL that is not a view's check route on 127.0.0.1."""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request

URL_RE = re.compile(r"^http://127\.0\.0\.1:\d{1,5}/api/ws/[^/\s?#]+/views/[^/\s?#]+/check$")
TIMEOUT_S = 900  # the route loads the page headless; a big corpus's index takes minutes to build


def main(argv: list[str]) -> int:
    if not argv or not URL_RE.match(argv[0]):
        sys.stderr.write("usage: view_check.py <a view's check URL on 127.0.0.1> [<locator>...]\n")
        return 2
    body = json.dumps({"locators": argv[1:]}).encode("utf-8")
    req = urllib.request.Request(argv[0], data=body, method="POST", headers={"Content-Type": "application/json"})
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
