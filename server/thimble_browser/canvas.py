"""The canvas: groups of cards, each group one file `notebooks/<id>.json` in the workspace.

A card has a question (its `title`), content and a takeaway. Its content is either code (kinds plot, table, code,
diagram, timeline), which runs in the sandbox (cards/sandbox.py) and keeps the outputs the canvas draws, or data
(kinds note, example, custom). The card shapes are those of thimble 0.8, so the 0.8 canvas draws them unchanged.

Citations. Claude writes a citation as a Markdown link, `[31](card:<id>#outcome/merged)` or `[↗](runs/x.jsonl#L4)`,
in the chat and in a takeaway alike, as the terminal plugin does. A takeaway is stored in the canvas's own form,
`[[31|card:<id>#outcome/merged]]` and `[[runs/x.jsonl#L4]]`, which the canvas draws as links (to_canvas_links).
"""
from __future__ import annotations

import copy
import logging
import re
import secrets
import threading
from pathlib import Path
from typing import Any, Callable

from . import home
from .cards import frames
from .hub import hub

MAIN = "main"
CODE_KINDS = ("plot", "table", "code", "diagram", "timeline")
DATA_KINDS = ("note", "example", "custom")
KINDS = CODE_KINDS + DATA_KINDS
_lock = threading.RLock()
log = logging.getLogger("thimble_browser.canvas")
# the fields an edit that the card's history keeps changes (the `fields` of its `edited` entry)
VERSION_FIELDS = ("title", "kind", "code", "payload", "takeaway")

# Feature modules hear each change to a card (on_change): fn(ws, op, before, after, by=..., prior=...), `op` created,
# edited, ran or deleted, `before`/`after` copies of the card (None for none), `prior` the id of the card before it in
# its group (where an undo puts a deleted card back). A hook's failure is logged and never stops the change.
HOOKS: list[Callable[..., None]] = []


def on_change(fn: Callable[..., None]) -> None:
    if fn not in HOOKS:
        HOOKS.append(fn)


def _changed(ws: str, op: str, before: dict[str, Any] | None, after: dict[str, Any] | None, by: str,
             prior: str | None = None) -> None:
    for fn in list(HOOKS):
        try:
            fn(ws, op, copy.deepcopy(before), copy.deepcopy(after), by=by, prior=prior)
        except Exception:  # noqa: BLE001
            log.exception("a hook on the change to a card failed")


def _prior(nb: dict[str, Any], cid: str) -> str | None:
    ids = [c["id"] for c in nb["cells"]]
    i = ids.index(cid) if cid in ids else -1
    return ids[i - 1] if i > 0 else None

MD_LINK = re.compile(r"(?<!!)\[([^\[\]\n]*)\]\(([^()\n]+?)\)")


def to_canvas_links(text: str) -> str:
    """Markdown-link citations as the canvas writes them: `[31](ref)` -> `[[31|ref]]`, `[↗](ref)` -> `[[ref]]`. A web
    link (http, https, mailto) stays a Markdown link."""
    def sub(m: re.Match) -> str:
        words, ref = m.group(1), m.group(2)
        if re.match(r"^([a-z][a-z0-9+.-]*://|mailto:|#|/)", ref.strip(), re.I):
            return m.group(0)
        ref = ref.strip().replace("%20", " ")
        if words.strip() in ("", "↗"):
            return f"[[{ref}]]"
        return f"[[{words}|{ref}]]"
    return MD_LINK.sub(sub, text or "")


def _dir(ws: str) -> Path:
    d = home.workspace_dir(ws) / "notebooks"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _path(ws: str, nb: str) -> Path:
    if not home.NAME_RE.match(nb):
        raise KeyError(nb)
    return _dir(ws) / f"{nb}.json"


def load(ws: str, nb: str) -> dict[str, Any]:
    got = home.read_json(_path(ws, nb))
    if not isinstance(got, dict):
        raise KeyError(nb)
    return got


def save(ws: str, nb: dict[str, Any]) -> None:
    home.write_json(_path(ws, nb["id"]), nb)


def notebooks(ws: str) -> list[dict[str, Any]]:
    out = []
    for p in sorted(_dir(ws).glob("*.json"), key=lambda p: p.stat().st_mtime):
        got = home.read_json(p)
        if isinstance(got, dict) and "cells" in got:
            out.append(got)
    out.sort(key=lambda n: n.get("ts") or "")
    return out


def group_for(ws: str, title: str | None, chat: str | None = None) -> dict[str, Any]:
    """The group named `title` (by title or id), made when there is none; `main` when no title is given."""
    with _lock:
        nbs = notebooks(ws)
        if not title:
            for nb in nbs:
                if nb["id"] == MAIN:
                    return nb
            nb = {"id": MAIN, "title": "Canvas", "parent": None, "kind": "sequence", "anchor": None, "chat": chat,
                  "role": "main", "ts": home.now(), "cells": []}
            save(ws, nb)
            return nb
        for nb in nbs:
            if nb["id"] == title or nb.get("title") == title:
                return nb
        nb = {"id": secrets.token_hex(4), "title": title, "parent": None, "kind": "sequence", "anchor": None,
              "chat": chat, "role": "main", "ts": home.now(), "cells": []}
        save(ws, nb)
        return nb


def canvas(ws: str) -> dict[str, Any]:
    groups, cells = [], []
    for nb in notebooks(ws):
        g = {k: v for k, v in nb.items() if k != "cells"}
        g["n_cells"] = len(nb["cells"])
        groups.append(g)
        cells.extend(nb["cells"])
    return {"groups": groups, "cells": cells, "hidden": []}


def find(ws: str, card: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """(the group, the card) for a card id or `card:<id>`; KeyError for none."""
    cid = card.removeprefix("card:").removeprefix("cell:").split("#", 1)[0].split("@", 1)[0]
    for nb in notebooks(ws):
        for c in nb["cells"]:
            if c["id"] == cid or c.get("slug") == cid:
                return nb, c
    raise KeyError(card)


def _slug(title: str, taken: set[str]) -> str:
    words = [w for w in re.sub(r"[^a-z0-9\s-]", " ", (title or "").lower()).split()
             if w not in {"the", "a", "an", "of", "in", "on", "what", "how", "which", "do", "does", "did", "is",
                          "are", "was", "were", "to", "for", "and", "or", "by", "with", "many", "much"}
             and not w.isdigit()]
    base = "-".join(words[:4])[:40].strip("-") or "card"
    s, n = base, 2
    while s in taken:
        s, n = f"{base}-{n}", n + 1
    return s


def emit(ws: str, cell: dict[str, Any], kind: str = "ran") -> None:
    hub.publish(ws, {"type": "cell", "notebook": cell.get("notebook", ""), "cell": cell["id"], "kind": kind})


def new_card(ws: str, args: dict[str, Any], *, by: str = "main", chat: str | None = None) -> dict[str, Any]:
    kind = str(args.get("kind") or "code")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}, not {kind!r}")
    question = str(args.get("question") or "").strip()
    if not question:
        raise ValueError("a card needs its question")
    now = home.now()
    taken = {c.get("slug") for nb in notebooks(ws) for c in nb["cells"]}
    cell: dict[str, Any] = {"id": secrets.token_hex(4), "kind": kind, "title": question,
                            "slug": _slug(question, taken),
                            "takeaway": to_canvas_links(str(args.get("takeaway") or "")),
                            "takeaway_author": by if args.get("takeaway") else None, "labels": [], "locked": False,
                            "created_by": by, "created_at_event": None, "edited": [], "created_ts": now, "ts": now,
                            "width": None, "height": None, "pos": None, "starred": False}
    if kind in CODE_KINDS:
        if not str(args.get("code") or "").strip():
            raise ValueError(f"a {kind} card needs `code`: Python that ends in what the card shows")
        cell.update(code=str(args["code"]), exec_count=None, status="idle", outputs=[])
    elif kind == "note":
        text = to_canvas_links(str(args.get("text") or ""))
        cell.update(payload={"text": text}, text=text)
    elif kind == "example":
        refs = args.get("refs") or []
        if not isinstance(refs, list) or not refs:
            raise ValueError("an example card needs `refs`: the records it shows")
        cell["payload"] = {"refs": refs}
    elif kind == "custom":
        cell["payload"] = {"html": str(args.get("html") or "")}
    # a card cites itself as card:<id> before it has an id (the add_card tool says so): its own id goes in
    for k in ("takeaway", "text"):
        if isinstance(cell.get(k), str):
            cell[k] = cell[k].replace("card:card:<id>", f"card:{cell['id']}").replace("card:<id>", f"card:{cell['id']}")
    if isinstance(cell.get("payload"), dict) and isinstance(cell["payload"].get("text"), str):
        cell["payload"]["text"] = cell["text"]
    with _lock:
        nb = group_for(ws, args.get("group"), chat)
        cell["notebook"] = nb["id"]
        nb["cells"].append(cell)
        save(ws, nb)
        prior = _prior(nb, cell["id"])
    emit(ws, cell, "added")
    _changed(ws, "created", None, cell, by, prior)
    return cell


def update_card(ws: str, card: str, args: dict[str, Any], *, by: str = "main") -> dict[str, Any]:
    with _lock:
        nb, cell = find(ws, card)
        if cell.get("locked") and by != "analyst":
            raise PermissionError("the person locked this card")
        before = copy.deepcopy(cell)
        if args.get("question"):
            cell["title"] = str(args["question"])
        if "takeaway" in args and args["takeaway"] is not None:
            cell["takeaway"] = to_canvas_links(str(args["takeaway"]))
            cell["takeaway_author"] = by
        if "code" in args and args["code"] is not None and cell["kind"] in CODE_KINDS:
            cell["code"] = str(args["code"])
            cell["status"] = "idle"
        if args.get("kind") in KINDS and args["kind"] != cell["kind"]:
            if (args["kind"] in CODE_KINDS) != (cell["kind"] in CODE_KINDS):
                raise ValueError("a card with code cannot become a card with data, or the other way: add a new card")
            cell["kind"] = args["kind"]
        if "text" in args and cell["kind"] == "note":
            text = to_canvas_links(str(args["text"] or ""))
            cell["payload"], cell["text"] = {"text": text}, text
        if "refs" in args and cell["kind"] == "example":
            cell["payload"] = {"refs": args["refs"]}
        if "html" in args and cell["kind"] == "custom":
            cell["payload"] = {"html": str(args["html"] or "")}
        for k in ("locked", "starred", "width", "height", "pos"):
            if k in args and by == "analyst":
                cell[k] = args[k]
        cell["ts"] = home.now()
        fields = [k for k in VERSION_FIELDS if before.get(k) != cell.get(k)]
        if fields:  # an edit of what the card says, which its history keeps (a move or a star is no edit)
            cell.setdefault("edited", []).append({"by": by, "ts": cell["ts"], "id": secrets.token_hex(4),
                                                  "fields": fields})
        if args.get("group") and by != "analyst":
            target = group_for(ws, args["group"])
            if target["id"] != nb["id"]:
                nb["cells"] = [c for c in nb["cells"] if c["id"] != cell["id"]]
                save(ws, nb)
                cell["notebook"] = target["id"]
                target = load(ws, target["id"])
                target["cells"].append(cell)
                nb = target
        else:
            nb["cells"] = [cell if c["id"] == cell["id"] else c for c in nb["cells"]]
        save(ws, nb)
    emit(ws, cell, "edited")
    _changed(ws, "edited", before, cell, by)
    return cell


def delete_card(ws: str, card: str, *, by: str = "main") -> None:
    with _lock:
        nb, cell = find(ws, card)
        if cell.get("locked") and by != "analyst":
            raise PermissionError("the person locked this card")
        prior = _prior(nb, cell["id"])
        nb["cells"] = [c for c in nb["cells"] if c["id"] != cell["id"]]
        save(ws, nb)
    emit(ws, cell, "deleted")
    _changed(ws, "deleted", cell, None, by, prior)


def set_run(ws: str, cid: str, **fields: Any) -> dict[str, Any]:
    with _lock:
        nb, cell = find(ws, cid)
        before = copy.deepcopy(cell)
        cell.update(fields)
        nb["cells"] = [cell if c["id"] == cell["id"] else c for c in nb["cells"]]
        save(ws, nb)
    emit(ws, cell, "ran")
    if "outputs" in fields:
        _changed(ws, "ran", before, cell, "run")
    return cell


async def run_card(ws: str, cid: str, corpus: Path, *, unsandboxed: bool = False, timeout: float = 60.0) -> dict:
    """Run a card's code in the sandbox and keep its outputs."""
    from .cards import sandbox

    _, cell = find(ws, cid)
    if cell["kind"] not in CODE_KINDS:
        return cell
    set_run(ws, cid, status="running")
    import time

    t0 = time.monotonic()
    res = await sandbox.run_code(cell["code"], corpus, timeout=timeout, unsandboxed=unsandboxed)
    outputs = [{**o, "_out": i} for i, o in enumerate(res.get("outputs") or [])]
    status = "ok" if res.get("status") == "ok" else "error"
    _, cell = find(ws, cid)
    return set_run(ws, cid, status=status, outputs=outputs, exec_count=(cell.get("exec_count") or 0) + 1,
                   duration_s=round(time.monotonic() - t0, 2))


def outputs_text(cell: dict[str, Any], limit: int = 6000) -> str:
    """What Claude reads of a card after it runs: each output's text, so it can cite what the card shows."""
    parts = []
    for i, o in enumerate(cell.get("outputs") or []):
        if "application/vnd.thimble.error+json" in o:
            e = o["application/vnd.thimble.error+json"]
            tb = "\n".join(re.sub(r"\x1b\[[0-9;]*m", "", t) for t in (e.get("traceback") or [])[-6:])
            parts.append(f"[out{i}] error {e.get('ename')}: {e.get('evalue')}\n{tb}".strip())
        elif frames.FRAME_MIME in o:
            parts.append(f"[out{i}] table (cite a value as card:{cell['id']}#<column>/<row>):\n{o.get('text/plain', '')}")
        elif "application/vnd.vegalite.v6.json" in o:
            parts.append(f"[out{i}] chart\n{o.get('text/plain', '')}")
        elif "image/svg+xml" in o or "image/png" in o:
            parts.append(f"[out{i}] figure {o.get('text/plain', '')}")
        else:
            parts.append(f"[out{i}] {o.get('text/plain', '')}")
    text = "\n\n".join(parts) or "(no output)"
    return text if len(text) <= limit else text[:limit] + f"\n[cut at {limit} characters]"


def resolve_card_ref(ws: str, ref: str) -> dict[str, Any]:
    """What a card ref points at: the card, or one value of its table (`card:<id>#<column>/<row>`)."""
    nb, cell = find(ws, ref)
    _, _, loc = ref.partition("#")
    out: dict[str, Any] = {"ref": ref, "kind": "cell", "excerpt": f"{cell['title']}\n{cell.get('takeaway') or ''}",
                           "meta": {"card": cell["id"], "notebook": nb["id"], "kind": cell["kind"]}}
    if loc and "/" in loc:
        col, row = loc.split("/", 1)
        frame = frames.frame_in(cell.get("outputs"))
        if frame:
            got = frames.locate({frames.FRAME_MIME: frame}, col, row)
            if got is not None:
                out.update(kind="value", excerpt=f"{col} for {row}: {got}")
    return out
