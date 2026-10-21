"""The canvas: groups of cards, each group one file `notebooks/<id>.json` in the workspace.

A card has a question (its `title`), content and a takeaway. Its content is either code (kinds plot, table, code,
diagram, timeline, program), which runs in the sandbox (cards/sandbox.py) and keeps the outputs the canvas draws, or
data (kinds note, example, custom). The card shapes are those of thimble 0.8, so the 0.8 canvas draws them unchanged.

A `program` card is drawn as the terminal plugin draws its cards: its code ends in the card's data, and its `program`,
written against the plugin's toolkit (plugin/draw/kit.js), draws that data. The server runs the program in the sandbox
(sandbox.run_program) and keeps the drawing with the data as the run's last output (KIT_MIME), which the page draws
and runs again when the analyst turns a knob or presses a part. A part's id cites it: `card:<id>#<part id>`.

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
from .cards import cite, frames
from .hub import hub

MAIN = "main"
CODE_KINDS = ("plot", "table", "code", "diagram", "timeline", "program")
DATA_KINDS = ("note", "example", "custom")
KINDS = CODE_KINDS + DATA_KINDS
_lock = threading.RLock()
log = logging.getLogger("thimble_browser.canvas")
# the fields an edit that the card's history keeps changes (the `fields` of its `edited` entry)
VERSION_FIELDS = ("title", "kind", "code", "program", "payload", "takeaway")
# the output of a program card's run: {drawing, data, w}, the toolkit's drawing of the data at w columns
KIT_MIME = "application/vnd.thimble.kit+json"
# the columns a program draws in on the server: a card at the canvas's width (frontend canvas/layout CARD_W)
DRAW_W = 88

# Feature modules hear each change to a card (on_change): fn(ws, op, before, after, by=..., prior=...), `op` created,
# edited, ran or deleted, `before`/`after` copies of the card (None for none), `prior` the id of the card before it in
# its group (where an undo puts a deleted card back). A hook's failure is logged and never stops the change.
HOOKS: list[Callable[..., None]] = []


def on_change(fn: Callable[..., None]) -> None:
    if fn not in HOOKS:
        HOOKS.append(fn)


# Where a citation looks for a card's earlier outputs (resolve_card_ref): fn(ws, card) -> [(edit entry, outputs)],
# newest first, the outputs the card showed before each of its edits. The history feature adds one.
EARLIER: list[Callable[[str, dict[str, Any]], list[tuple[dict[str, Any], list[Any]]]]] = []


def on_earlier(fn: Callable[[str, dict[str, Any]], list[tuple[dict[str, Any], list[Any]]]]) -> None:
    if fn not in EARLIER:
        EARLIER.append(fn)


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

def to_canvas_links(text: str) -> str:
    """Markdown-link citations as the canvas writes them: `[31](ref)` -> `[[31|ref]]`, `[↗](ref)` -> `[[ref]]`. A web
    link (http, https, mailto) stays a Markdown link. A ref may hold balanced brackets (cite.link_spans)."""
    def sub(words: str, ref: str, whole: str) -> str:
        if re.match(r"^([a-z][a-z0-9+.-]*://|mailto:|#|/)", ref.strip(), re.I):
            return whole
        ref = ref.strip().replace("%20", " ")
        if words.strip() in ("", "↗"):
            return f"[[{ref}]]"
        return f"[[{words}|{ref}]]"
    return cite.map_links(text or "", sub)


def own_id(text: str, cid: str) -> str:
    """`text` with the card's own citations, written `card:<id>` before the card had its id, naming it."""
    return text.replace("card:card:<id>", f"card:{cid}").replace("card:<id>", f"card:{cid}")


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
    """Tell the page a card changed. The slug goes with the id because a citation may name the card by either."""
    hub.publish(ws, {"type": "cell", "notebook": cell.get("notebook", ""), "cell": cell["id"], "kind": kind,
                     "slug": cell.get("slug") or ""})


def new_card(ws: str, args: dict[str, Any], *, by: str = "main", chat: str | None = None) -> dict[str, Any]:
    kind = str(args.get("kind") or ("program" if args.get("program") else "code"))
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
                            "takeaway_author": by if args.get("takeaway") else None, "labels": [],
                            "created_by": by, "created_at_event": None, "edited": [], "created_ts": now, "ts": now,
                            "width": None, "height": None, "pos": None, "starred": False}
    if kind in CODE_KINDS:
        if not str(args.get("code") or "").strip() and by != "user":  # the analyst's new card starts empty
            raise ValueError(f"a {kind} card needs `code`: Python that ends in what the card shows")
        cell.update(code=str(args.get("code") or ""), exec_count=None, status="idle", outputs=[])
        if kind == "program":
            if not str(args.get("program") or "").strip():
                raise ValueError("a program card needs `program`: the body of (k, data) => node that draws its data")
            cell["program"] = str(args["program"])
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
            cell[k] = own_id(cell[k], cell["id"])
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
        before = copy.deepcopy(cell)
        if args.get("question"):
            cell["title"] = str(args["question"])
        if "takeaway" in args and args["takeaway"] is not None:
            # a card cites itself as card:<id> (the card tools say so): its own id goes in, as when it was added
            cell["takeaway"] = own_id(to_canvas_links(str(args["takeaway"])), cell["id"])
            cell["takeaway_author"] = by
        if "code" in args and args["code"] is not None and cell["kind"] in CODE_KINDS:
            cell["code"] = str(args["code"])
            cell["status"] = "idle"
        if args.get("program") is not None and (cell["kind"] == "program" or args.get("kind") == "program"):
            cell["program"] = str(args["program"])
            cell["status"] = "idle"
        if args.get("kind") in KINDS and args["kind"] != cell["kind"]:
            if (args["kind"] in CODE_KINDS) != (cell["kind"] in CODE_KINDS):
                raise ValueError("a card with code cannot become a card with data, or the other way: add a new card")
            if args["kind"] == "program" and not str(cell.get("program") or "").strip():
                raise ValueError("a program card needs `program`: the body of (k, data) => node that draws its data")
            cell["kind"] = args["kind"]
        if "text" in args and cell["kind"] == "note":
            text = own_id(to_canvas_links(str(args["text"] or "")), cell["id"])
            cell["payload"], cell["text"] = {"text": text}, text
        if "refs" in args and cell["kind"] == "example":
            cell["payload"] = {"refs": args["refs"]}
        if "html" in args and cell["kind"] == "custom":
            cell["payload"] = {"html": str(args["html"] or "")}
        for k in ("starred", "width", "height", "pos"):
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


def kernel_workspace(ws: str) -> Path:
    """The folder card code reads as thimble's workspace (cards/kernel_thimble.py WS): the workspace's labels folder,
    which holds its labels' definitions and rows (labels/store.py), read-only in the sandbox."""
    return home.workspace_dir(ws) / "labels"


async def run_code(ws: str, code: str, corpus: Path, *, timeout: float = 60.0, unsandboxed: bool = False,
                   data: bool = False) -> dict:
    """Run code in the sandbox as a card's code runs: it reads the folder, and thimble.labels() reads the workspace's
    labels. With `data`, the answer also holds the value the code ends in (a program card's data)."""
    from .cards import sandbox

    wsdir = kernel_workspace(ws)
    req: dict[str, Any] = {"code": code, "corpus": str(corpus.resolve()), "timeout": timeout, "data": data}
    if not wsdir.is_dir():
        return await sandbox.run_script(sandbox.RUNNER, req, corpus, timeout=timeout, unsandboxed=unsandboxed)
    req["workspace"] = str(wsdir)
    return await sandbox.run_script(sandbox.RUNNER, req, corpus, extra_ro=[wsdir], timeout=timeout,
                                    unsandboxed=unsandboxed)


async def run_card(ws: str, cid: str, corpus: Path, *, unsandboxed: bool = False, timeout: float = 60.0) -> dict:
    """Run a card's code in the sandbox and keep its outputs."""
    _, cell = find(ws, cid)
    if cell["kind"] not in CODE_KINDS:
        return cell
    set_run(ws, cid, status="running")
    import time

    t0 = time.monotonic()
    program = cell["kind"] == "program"
    res = await run_code(ws, cell["code"], corpus, timeout=timeout, unsandboxed=unsandboxed, data=program)
    outs = list(res.get("outputs") or [])
    status = "ok" if res.get("status") == "ok" else "error"
    if program and status == "ok":
        from .cards import sandbox

        drawing = await sandbox.run_program(str(cell.get("program") or ""), res.get("data"), w=DRAW_W,
                                            title=cell["title"], card_id=cell["id"], unsandboxed=unsandboxed)
        outs.append({KIT_MIME: {"drawing": drawing, "data": res.get("data"), "w": DRAW_W},
                     "text/plain": drawing_text(drawing)})
        if drawing.get("error"):
            status = "error"
    outputs = [{**o, "_out": i} for i, o in enumerate(outs)]
    _, cell = find(ws, cid)
    return set_run(ws, cid, status=status, outputs=outputs, exec_count=(cell.get("exec_count") or 0) + 1,
                   duration_s=round(time.monotonic() - t0, 2))


def drawing_text(drawing: dict[str, Any]) -> str:
    """What Claude reads of a program's drawing, as the terminal's save reports it: the parts it can cite, each with its
    label and the record it opens, then the warnings and the error with what to fix."""
    lines = []
    err = drawing.get("error")
    if err:
        where = f" (line {err['line']})" if err.get("line") else ""
        lines.append(f"the program did not draw: {err.get('name')}: {err.get('message')}{where}. Fix: {err.get('fix')}")
    regions = [r for r in drawing.get("regions") or [] if isinstance(r, dict) and r.get("id")]
    if regions:
        lines.append(f"{len(regions)} parts (cite one as card:<id>#<part id>):")
        for r in regions[:60]:
            meta = r.get("meta") if isinstance(r.get("meta"), dict) else {}
            label = meta.get("label") or ""
            ref = meta.get("ref") or ""
            lines.append(f"  {r['id']}" + (f"  {label}" if label else "") + (f"  → {ref}" if ref else ""))
        if len(regions) > 60:
            lines.append(f"  … {len(regions) - 60} more")
    elif not err:
        lines.append("no parts: nothing on the card can be selected or cited")
    for w in (drawing.get("warnings") or [])[:10]:
        lines.append(f"warning: {w}")
    return "\n".join(lines)


def region_in(outputs: Any, rid: str) -> dict[str, Any] | None:
    """The part `rid` of a program card's drawing in `outputs`, {id, meta}, or None; `rid` as written or as the kit
    renames it (cite.part_id)."""
    return cite.region(outputs, rid)


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
        elif KIT_MIME in o:
            parts.append(f"[out{i}] drawing\n{o.get('text/plain', '')}")
        elif cite.chart_spec(o) is not None:
            rows = cite.chart_text(o, cell["id"])
            own = str(o.get("text/plain") or "")
            parts.append(f"[out{i}] chart " + (rows or ("" if own.startswith("<VegaLite") else own)))
        elif "image/svg+xml" in o or "image/png" in o:
            parts.append(f"[out{i}] figure {o.get('text/plain', '')}")
        else:
            parts.append(f"[out{i}] {o.get('text/plain', '')}")
    text = "\n\n".join(parts) or "(no output)"
    return text if len(text) <= limit else text[:limit] + f"\n[cut at {limit} characters]"


def resolve_card_ref(ws: str, ref: str, value: str | None = None) -> dict[str, Any]:
    """What a card ref points at: the card, or one value of its table or chart (`card:<id>#<column>/<row>`).

    A value is read from the card as it stands. When the card no longer shows it (an edit changed its code, so a row or
    a column went), or `value`, the citation's own words, states another value than the card shows now, the value is
    read from the newest earlier version of the card that shows it (EARLIER), so a citation keeps pointing at what it
    cited. `meta.version` then names that version's edit. `meta.table_html` is the rows around the value."""
    nb, cell = find(ws, ref)
    _, _, loc = ref.partition("#")
    out: dict[str, Any] = {"ref": ref, "kind": "cell", "excerpt": f"{cell['title']}\n{cell.get('takeaway') or ''}",
                           "meta": {"card": cell["id"], "notebook": nb["id"], "kind": cell["kind"]}}
    if loc and cell["kind"] == "program" and ("/" not in loc or region_in(cell.get("outputs"), loc) is not None):
        return _region_ref(ws, cell, loc, out, value)
    if not loc or "/" not in loc:
        return out
    col, row = loc.split("/", 1)
    now = cite.find(cell.get("outputs"), col, row)
    got, entry = now, None
    if now is None or (value and not cite.same_value(now[0], value)):
        for fn in EARLIER:
            try:
                earlier = fn(ws, cell)
            except Exception:  # noqa: BLE001 — a version that cannot be read leaves the card as it stands
                log.exception("reading a card's earlier outputs failed")
                continue
            hits = [(e, f) for e, outs in earlier if (f := cite.find(outs, col, row)) is not None]
            pick = next(((e, f) for e, f in hits if value and cite.same_value(f[0], value)), None)
            if pick is None and now is None and hits:
                pick = hits[0]
            if pick is not None:
                entry, got = pick
                break
    if got is None:
        return out
    shown, html = got
    out.update(kind="value", excerpt=f"{col} for {row}: {shown}")
    out["meta"].update(value=shown, table_html=html, span={"col": col, "row": row})
    if entry is not None:
        out["meta"]["version"] = {"entry": entry.get("id"), "ts": entry.get("ts"), "by": entry.get("by")}
    return out


_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _states(words: str, label: str) -> bool:
    """Whether a part's label states a number the citation's words state (commas aside)."""
    nums = lambda t: {n.replace(",", "") for n in _NUMBER.findall(t)}  # noqa: E731
    return bool(nums(words) & nums(label))


def _label_of(region: dict[str, Any] | None) -> str:
    meta = region.get("meta") if region and isinstance(region.get("meta"), dict) else {}
    return str(meta.get("label") or (region or {}).get("id") or "")


def _region_ref(ws: str, cell: dict[str, Any], rid: str, out: dict[str, Any], value: str | None = None) -> dict[str, Any]:
    """A part of a program card (`card:<id>#<part id>`): its label and the record it opens, from the card as it stands.
    When the card no longer draws the part, or `value`, the citation's own words, states a number its label does not
    (an edit redrew the part with another value), the part is read from the newest earlier version that drew it as
    cited, so a citation keeps pointing at what it cited."""
    got, entry = region_in(cell.get("outputs"), rid), None
    stated = bool(value) and any(ch.isdigit() for ch in str(value))
    if got is None or (stated and not _states(str(value), _label_of(got))):
        for fn in EARLIER:
            try:
                earlier = fn(ws, cell)
            except Exception:  # noqa: BLE001 — a version that cannot be read leaves the card as it stands
                log.exception("reading a card's earlier outputs failed")
                continue
            hits = [(e, r) for e, outs in earlier if (r := region_in(outs, rid)) is not None]
            pick = next(((e, r) for e, r in hits if stated and _states(str(value), _label_of(r))), None)
            if pick is None and got is None and hits:
                pick = hits[0]
            if pick is not None:
                entry, got = pick
                break
    if got is None:
        return out
    meta = got.get("meta") if isinstance(got.get("meta"), dict) else {}
    label = str(meta.get("label") or rid)
    out.update(kind="value", excerpt=f"{label}" + (f" (opens {meta['ref']})" if meta.get("ref") else ""))
    drawn = str(got.get("id") or rid)
    out["meta"].update(value=label, region=drawn, part=meta, span={"region": drawn})
    if entry is not None:
        out["meta"]["version"] = {"entry": entry.get("id"), "ts": entry.get("ts"), "by": entry.get("by")}
    return out
