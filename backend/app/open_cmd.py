"""`thimble open`: the press that opens thimble's browser workbench on an object, signed in, on the same session (0.9.0
build spec 3.15, contract C12).

    thimble open [--session SID] [--cwd DIR] [--ref REF] [--hook] [--link] [--json]
        prints {"ok": true, "port", "url", "opened", "remote", "tunnel", "et", "link_file", "claim_file", "proxy"} or
        {"ok": false, "error": {code, message, fix}}; never a sign-in code; exit 0

SCAFFOLD STUB (browser lane): every press answers NOT_BUILT.
"""
from __future__ import annotations

import json
import sys

NOT_BUILT = {"ok": False, "error": {"code": "NOT_BUILT", "message": "thimble open is not built yet",
                                    "fix": "wait for the browser lane"}}


def main(argv: list[str]) -> int:
    """`open [...]` (module note): C12's JSON on stdout, exit 0."""
    sys.stdout.write(json.dumps(NOT_BUILT) + "\n")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    sys.exit(main(args[1:] if args[:1] == ["open"] else args))
