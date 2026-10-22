"""The folder's map of claims: `thimble claims save --from FILE` checks every citation of a map a subagent wrote
(prompts/claims-folder.md) and keeps it, where the Claims pane reads it.

A map is JSON: {title?, data: {scope?, clusters?: [{id, name, lead?}], claims: [{id, name, cluster?, n?, of?,
evidence: [{ref, quote}]}], relations?: [{from, to, type}]}}. A citation holds when its ref names a record of the
folder (refs.py) and the record's text holds the quote, read with case, runs of space, and the kind of quote mark and
dash set aside. The map is kept whole, with how many citations hold, in the folder's record folder
(store.py records_dir: claims/folder.json, under THIMBLE_HOME, not in the folder), and the session's change feed gets a
`folder_claims` line, which brings its claims into the session's Claims (plugin/claims/term.ts folderClaimsFromFeed).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from . import labels as L
from . import refs as R
from .store import Store

FOLD = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "−": "-", " ": " "})
MAX_FILE = 64 * 1024 * 1024


class ClaimsError(ValueError):
    """A map that cannot be read or kept."""


def fold(s: str) -> str:
    """Text as a quote is matched in it: one kind of quote mark and dash, lower case, runs of space as one."""
    return re.sub(r"\s+", " ", str(s).translate(FOLD).replace("\\n", " ").replace('\\"', '"')).strip().lower()


def _strings(v: Any) -> list[str]:
    """Every string a record holds, in order."""
    if isinstance(v, str):
        return [v]
    if isinstance(v, dict):
        return [s for x in v.values() for s in _strings(x)]
    if isinstance(v, list):
        return [s for x in v for s in _strings(x)]
    return []


def record_text(st: Store, ref: str) -> str | None:
    """The text of the record a ref names (its raw text and the strings it holds), or None when it names none."""
    p = R.parse(ref)
    rel = p["path"]
    f = (st.root / rel).resolve()
    if st.root.resolve() not in f.parents or not f.is_file():
        return None
    if p["kind"] == "file":
        if f.stat().st_size > MAX_FILE:
            return None
        return f.read_text(errors="replace")
    rows = L.rows_of(st, [ref])
    if ref in rows:
        row = rows[ref]
        return "\n".join([row.raw, *_strings(row.value)])
    if p["kind"] == "lines":
        # a range of lines: their text together
        want = set(p["nums"])
        with open(f, errors="replace") as fh:
            got = [line for i, line in enumerate(fh, 1) if i in want]
        return "".join(got) if got else None
    return None


def check(st: Store, data: dict[str, Any]) -> tuple[int, int, list[str]]:
    """How many citations hold, of how many, and a line for each that does not."""
    holds = total = 0
    problems: list[str] = []
    for i, c in enumerate(data.get("claims") or []):
        for j, e in enumerate((c or {}).get("evidence") or []):
            if not isinstance(e, dict) or not isinstance(e.get("ref"), str):
                continue
            total += 1
            at = f"/claims/{i}/evidence/{j}"
            try:
                text = record_text(st, e["ref"])
            except (R.RefError, OSError) as err:
                problems.append(f"{at}: {e['ref']} is no record of the folder ({err})")
                continue
            if text is None:
                problems.append(f"{at}: {e['ref']} names no record of the folder")
                continue
            q = fold(e.get("quote") or "")
            if q and q not in fold(text):
                problems.append(f"{at}: the quote {q[:80]!r} is not in {e['ref']}")
                continue
            holds += 1
    return holds, total, problems


def save(st: Store, file: Path) -> dict[str, Any]:
    """The map in `file` checked and kept; the feed told. Returns {path, claims, clusters, holds, total, problems}."""
    try:
        m = json.loads(Path(file).read_text())
    except (OSError, ValueError) as err:
        raise ClaimsError(f"cannot read the map {file}: {err}") from err
    data = m.get("data") if isinstance(m, dict) and isinstance(m.get("data"), dict) else m
    if not isinstance(data, dict) or not isinstance(data.get("claims"), list):
        raise ClaimsError('the map has no "claims" list (see the shape in the guide)')
    holds, total, problems = check(st, data)
    out = st.sub("claims") / "folder.json"
    kept = {"title": m.get("title") if isinstance(m, dict) else None, "data": data, "holds": holds, "total": total}
    out.write_text(json.dumps(kept, ensure_ascii=False, indent=1))
    st.emit({"kind": "folder_claims", "path": str(out), "holds": holds, "total": total})
    return {"path": str(out), "claims": len(data["claims"]), "clusters": len(data.get("clusters") or []), "holds": holds, "total": total, "problems": problems}
