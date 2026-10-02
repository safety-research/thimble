"""thimble-cc-mod's resolver, run by the mod: reads {"cwd", "items": [{"id", "ref", "display", "quote"?}], "around"} on stdin and
prints one result per item (refs.resolve) as JSON. One process checks every citation of a reply."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refs import dumps, read_stdin_json, resolve_many  # noqa: E402

if __name__ == "__main__":
    req = read_stdin_json(sys.stdin)
    cwd = str(req.get("cwd") or os.getcwd())
    print(dumps(resolve_many(cwd, list(req.get("items") or []), int(req.get("around") or 6))))
