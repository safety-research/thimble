"""check.py SPEC.json (or - for stdin): the kernel's own citation check of the corpus orientation's claims, without saving
anything. cli.mjs runs it for `thimble verb claims check`, so the subagent that writes the claims sees each evidence ref or
quote that does not hold before main saves them. It builds the object as `thimble save` would (objects.build) and prints, as JSON, how many citations hold
and the problems. It writes nothing."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine"))
from kernel import objects as O  # noqa: E402
from kernel.store import Store  # noqa: E402


def main(path: str) -> int:
    spec = json.loads(sys.stdin.read() if path == "-" else Path(path).read_text())
    st = Store()
    _, lin = O.build(st, spec)
    cites = lin.get("cites") or []
    bad = [c for c in cites if c.get("problem")]
    print(json.dumps({"root": str(st.root), "cites": len(cites), "hold": len(cites) - len(bad),
                      "problems": [f"{c['in']}: {c['problem']}" for c in bad][:80],
                      "other": [p for p in lin.get("problems") or [] if not any(c["problem"] in p for c in bad)][:20],
                      "rows": {f: x.get("count") for f, x in (lin.get("rows") or {}).items()}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
