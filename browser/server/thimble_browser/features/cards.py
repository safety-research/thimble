"""Cards: what Claude draws when an answer is faster to see than to read, as the terminal plugin draws them.

The card tool (prompts/tools-cards.md, the terminal's card-tool.md). Claude writes its rows as a JSON file in the
workspace's temp folder with its own code, and calls `card` with the file's path, a title and a short JavaScript view.
One call:

  1. checks the file is in the folder or the temp folder, and copies it into the card's folder (`cards/<id>/v<n>/`)
  2. loads the view and the copy into the card runner (cardrunner.py, the terminal's runner.mjs), which draws the card
     as a plain tree of Box, Text and Button nodes and makes its text copy
  3. keeps the card and tells the page, which draws it under the call, or under the answer v was pressed on when the
     designer drew it
  4. tries the call's actions, keys and clicks in order, then puts the card back as it was
  5. answers what the card read (rows, columns, the first row), the text copy at the card's width, and the copy after
     each action, in the terminal's words (plugin/cards/tool.ts)

A call with `id` draws a new version of that card in the card's place, under the call that first drew it or under the
answer v was pressed on, and keeps its title unless the call gives one; the page shows the later call as a line that
points to it. A new version may keep the rows of the card's last call (no `data`) and give `edits` to that call's view
in place of the whole view, as the terminal's card tool takes them. A version that fails leaves the one on screen; its
view and rows are kept for the next call's `edits`, and the view's error goes back to Claude.

The page draws the tree (frontend cards/), and sends the analyst's keys and clicks to the routes below, which pass them
to the runner and answer the new tree. A card's state is kept beside its copy, so it draws the same after a restart.

v. Under the last answer, or typed at an empty message box, v starts the designer: a copy of the chat
(agent.Sessions.spawn) that reads the terminal's designer.md, lists forms for the answer, picks one and draws it with
the card tool. Its cards draw under that answer. The chat's agent reads them with the analyst's next message.
"""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import Body, HTTPException

from .. import agent, cardrunner, chats, home, prompts
from ..hub import hub
from ..tools import Result
from . import Feature

MAX_ROWS_BYTES = 64 * 1024 * 1024
COPY_LINES = 60
WIDTH = 92  # a card's columns until the page says how wide the chat is
MIN_WIDTH = 20
OWN_KEYS = ("v",)  # the letters the page keeps at an empty message box (v), which a card never gets
TELL_CHARS = 3000  # the most of a v card's text copy the chat's agent reads
DESIGNER_TOOLS = ("Read", "Grep", "Glob", "run_python", "card")


# ---- the store: cards/<id>/meta.json, v<n>/view.js and v<n>/rows.json, state.json

def card_dir(ws: str, cid: str) -> Path:
    if not re.fullmatch(r"c[0-9a-f]{8}", cid):
        raise KeyError(cid)
    return cardrunner.cards_dir(ws) / cid


def meta_of(ws: str, cid: str) -> dict[str, Any] | None:
    try:
        got = home.read_json(card_dir(ws, cid) / "meta.json")
    except KeyError:
        return None
    return got if isinstance(got, dict) else None


def save_meta(ws: str, meta: dict[str, Any]) -> None:
    home.write_json(card_dir(ws, meta["id"]) / "meta.json", meta)


def version_dir(ws: str, cid: str, version: int) -> Path:
    return card_dir(ws, cid) / f"v{version}"


def read_state(ws: str, meta: dict[str, Any]) -> Any:
    got = home.read_json(card_dir(ws, meta["id"]) / "state.json", {}) or {}
    return got.get("state") if got.get("version") == meta["version"] else None


def save_state(ws: str, meta: dict[str, Any], state: Any) -> None:
    """The view's state as the runner gives it (JSON text, "null" for none)."""
    try:
        value = json.loads(state) if isinstance(state, str) else state
    except ValueError:
        return
    home.write_json(card_dir(ws, meta["id"]) / "state.json", {"version": meta["version"], "state": value})


def width_of(ws: str) -> int:
    """The columns a card draws at: the chat's width as the page last said it (PUT cards/width)."""
    got = (home.read_json(home.workspace_dir(ws) / "session.json", {}) or {}).get("card_cols")
    return max(MIN_WIDTH, got) if isinstance(got, int) else WIDTH


# ---- the runner, with a card loaded again from its copy when the runner does not hold it

async def load(ws: str, meta: dict[str, Any], width: int, unsandboxed: bool) -> dict[str, Any]:
    d = version_dir(ws, meta["id"], meta["version"])
    try:
        view = (d / "view.js").read_text()
    except OSError:
        return {"ok": False, "error": f"the copy of “{meta['title']}” is gone"}
    return await cardrunner.ask(ws, "load", {"id": meta["id"], "version": meta["version"], "title": meta["title"],
                                             "view": view, "rows": str(d / "rows.json"),
                                             "state": read_state(ws, meta), "width": width}, unsandboxed=unsandboxed)


async def ask_card(ws: str, meta: dict[str, Any], op: str, body: dict[str, Any], unsandboxed: bool) -> dict[str, Any]:
    """A request about a card; a card the runner does not hold (it started again) is loaded from its copy first."""
    r = await cardrunner.ask(ws, op, {"id": meta["id"], **body}, unsandboxed=unsandboxed)
    if not r.get("missing"):
        return r
    loaded = await load(ws, meta, int(body.get("width") or meta.get("width") or width_of(ws)), unsandboxed)
    if not loaded.get("ok"):
        return loaded
    return await cardrunner.ask(ws, op, {"id": meta["id"], **body}, unsandboxed=unsandboxed)


# ---- the tool

def one_line(s: Any, n: int) -> str:
    t = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", re.sub(r"\s+", " ", str(s or ""))).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def data_file(t: Any, raw: Any) -> tuple[Path | None, str]:
    """The data file's real path, or why it cannot be read."""
    p = str(raw or "").strip()
    if not p:
        return None, "`data` is empty: give the path of the JSON file of rows you wrote"
    tmp = home.temp_dir(t.ws).resolve()
    expanded = re.sub(r"^\$\{?TMPDIR\}?(?=/)", str(tmp), p)
    try:
        real = (Path(expanded) if expanded.startswith("/") else t.folder / expanded).resolve(strict=True)
    except OSError:
        return None, f"there is no file at {p}"
    if not real.is_file():
        return None, f"there is no file at {p}"
    if not any(real == r or r in real.parents for r in (t.folder, tmp)):
        return None, f"{p} is outside this folder and the temp folder ($TMPDIR); write the data file in $TMPDIR"
    if real.stat().st_size > MAX_ROWS_BYTES:
        return None, (f"{p} is {real.stat().st_size // 1048576} MB; a card reads at most 64 MB, so write only the rows "
                      "it shows")
    return real, ""


def copy_text(lines: list[str], cut: list[int], width: int) -> list[str]:
    """A text copy for Claude: at most COPY_LINES lines, and a note on the lines cut at the card's width."""
    out = lines[:COPY_LINES]
    if len(lines) > COPY_LINES:
        out.append(f"({len(lines) - COPY_LINES} more lines)")
    if cut:
        many = len(cut) > 1
        out.append(f"(line{'s' if many else ''} {', '.join(map(str, cut[:8]))} {'are' if many else 'is'} wider than "
                   f"the card's {width} columns and cut there)")
    return out


def failed(cid: str, r: dict[str, Any], update: bool) -> str:
    """What a call answers when the version did not draw: what to fix, or, when the runner cannot start, that the
    view is not the cause."""
    error = str(r.get("error") or "no answer")[:800]
    if r.get("down"):
        return (f"The card did not draw: {error}. The view is not the cause, and cards cannot draw in this workspace "
                "until the analyst fixes it; answer in words.")
    fix = "Fix the data file" if r.get("phase") == "rows" else "Fix the view (`edits` change the view of this call)"
    kept = " The version on screen stays." if update else ""
    return f"The card did not draw: {error}.{kept}\n{fix} and call card again with id \"{cid}\"."


def key_notes(asked: list[str]) -> list[str]:
    """What the call says of the keys the view asked for that a card never gets: thimble's own, and all but letters."""
    out = []
    for keys, why in (([k for k in asked if k in OWN_KEYS], "own"),
                      ([k for k in asked if not (k.isalpha() and len(k) == 1)], "letters")):
        if not keys:
            continue
        many = len(keys) > 1
        these = "these keys" if many else "this key"
        if why == "own":
            out.append(f"Note on the view: {' '.join(keys)} {'are' if many else 'is'} thimble's own, so the card does "
                       f"not get {'them' if many else 'it'}; give the card other keys. The analyst has not seen {these} "
                       "on the card.")
        else:
            out.append(f"Note on the view: a card takes letters only, so it does not get {' '.join(keys)}. The analyst "
                       f"has not seen {these} on the card.")
    return out


def notice(ws: str, chat: str, text: str) -> None:
    """A failure the analyst should know of, as a line in the chat."""
    chats.append(ws, chat, {"type": "notice", "kind": "cards", "text": text})


def view_of(args: dict[str, Any], last: Path | None) -> tuple[str, str | None]:
    """(the view of a call, why there is none): the whole `view` it gives, or the view of the card's last call (`last`,
    that call's folder, also when its version did not draw) with the call's `edits` made in order, each `old` text
    standing once in it, or as it is when the call gives only new rows (the terminal's viewOf)."""
    if str(args.get("view") or "").strip():
        return str(args["view"]), None
    edits = args.get("edits") if isinstance(args.get("edits"), list) else []
    if not edits and (last is None or not str(args.get("data") or "").strip()):
        return "", ("give the whole `view`, `edits` to the view of your last call, or new `data` for it" if last else
                    "`view` is empty: give the JavaScript that defines function view(props, surface)")
    if last is None:
        return "", "`edits` change a card you called card for: give its `id`, or the whole `view` for a new card"
    try:
        text = (last / "view.js").read_text()
    except OSError:
        return "", "the view of your last call cannot be read; give the whole `view`"
    # with no edits, new rows for the view of the last call as it is
    for k, e in enumerate(edits, 1):
        old = str((e or {}).get("old") or "")
        n = text.count(old) if old else 0
        if n > 1:
            return "", f"edit {k}: its `old` text stands {n} times in the view, not once; give more of the text around it"
        if not n:
            # where its first line stands, so the next try copies the view's own text
            first = old.split("\n")[0].strip()
            at = text.find(first) if first else -1
            here = f", which has here: {json.dumps(text[at:at + len(old) + 20])}" if at >= 0 else ""
            return "", f"edit {k}: its `old` text is not in the view of your last call{here}"
        text = text.replace(old, str((e or {}).get("new") or ""), 1)
    return text, None


async def card(t: Any, args: dict[str, Any]) -> Result:
    t0 = time.monotonic()
    given = str(args.get("id") or "").strip()
    design = (t.session.meta.get("design") if t.session is not None else None) or None
    before = meta_of(t.ws, given) if given else None
    if given and not before:
        return Result(f"There is no card \"{one_line(given, 40)}\" to replace. Leave out `id` to draw a new card.", True)
    # a version keeps the card's title unless the call gives a new one
    title = one_line(args.get("title"), 120) or (before or {}).get("title") or ""
    if not title:
        return Result("The card did not draw: `title` is empty: give the card's title, what it shows in a few words.", True)
    cid = given or f"c{secrets.token_hex(4)}"
    meta = before or {"id": cid, "version": 0, "title": title, "at": home.now()}
    shown = int(meta["version"])  # the version on screen; 0 while none has drawn
    # a new version may keep the view of the card's last call with a few edits, and its rows: writing the whole view
    # again takes the model half a minute. The last call's folder is the version on screen, or the version after it
    # when that call did not draw (its view did not parse, say), so `edits` fix the view the error was about
    last_no = int(meta.get("last") or meta["version"])
    last = version_dir(t.ws, cid, last_no) if last_no > 0 else None
    view, bad = view_of(args, last)
    if bad:
        return Result(f"The card did not draw: {bad}.", True)
    keep = last is not None and not str(args.get("data") or "").strip()
    path, bad = (last / "rows.json", "") if keep else data_file(t, args.get("data"))
    if path is None:
        return Result(f"The card did not draw: {bad}.", True)
    file = str(meta.get("last_file") or meta.get("file") or "") if keep else str(args.get("data"))
    version = int(meta["version"]) + 1
    d = version_dir(t.ws, cid, version)
    d.mkdir(parents=True, exist_ok=True)
    (d / "view.js").write_text(view)
    if path != d / "rows.json":
        shutil.copyfile(path, d / "rows.json")
    width = int(meta.get("width") or width_of(t.ws))
    r = await cardrunner.ask(t.ws, "load", {"id": cid, "version": version, "title": title, "view": view,
                                            "rows": str(d / "rows.json"), "state": None, "width": width},
                             unsandboxed=t.unsandboxed)
    if not r.get("ok"):
        # the folder stays as the last call's, for the next call's `edits`; the version on screen stays
        save_meta(t.ws, {**meta, "last": version, "last_file": file})
        if r.get("down"):
            notice(t.ws, design["chat"] if design else t.chat, f"Cards cannot draw: {str(r.get('error'))[:300]}")
        return Result(failed(cid, r, shown > 0), True)

    summary = r["summary"]
    asked = list(dict.fromkeys(k for k in str(r.get("keys") or "") if not k.isspace()))
    # a new version takes the card's place: the chat and turn of its first version (the page draws it under the call
    # that drew that version, or under the answer v was pressed on); `design` names the v that drew this version
    place = ({"chat": meta.get("chat"), "turn": meta.get("turn")} if shown else
             {"chat": design["chat"] if design else t.chat, "turn": design["turn"] if design else None})
    nxt = {**meta, **place, "version": version, "last": version, "last_file": file, "title": title,
           "rows": summary["rows"], "columns": summary["columns"],
           "keys": [k for k in asked if k.isalpha() and len(k) == 1 and k not in OWN_KEYS],
           "file": file, "width": width, "at": home.now(), "design": design["id"] if design else None}
    save_meta(t.ws, nxt)
    save_state(t.ws, nxt, r.get("state"))
    if shown:
        shutil.rmtree(version_dir(t.ws, cid, shown), ignore_errors=True)
    if design and not shown:
        # a v card stands under the answer v was pressed on, in the chat that answer is in
        chats.append(t.ws, design["chat"], {"type": "card", "card": cid, "turn": design["turn"]})
    hub.publish(t.ws, {"type": "card", "card": cid, "version": version})
    drawn_ms = round((time.monotonic() - t0) * 1000)

    under_v = bool(nxt["turn"])
    if shown:
        out = [f"Version {version} of “{title}” is drawn in place of version {shown}, "
               f"{'under the answer v was pressed on' if under_v else 'under the call that first drew the card'}."]
    else:
        where = "under the answer v was pressed on" if under_v else "where this call stands, above the words you write after it"
        out = [f"“{title}” is drawn {where}. Its id is \"{cid}\": to change it, call card again with this id."]
    rows, columns = summary["rows"], summary["columns"]
    out.append(f"It read {rows} row{'' if rows == 1 else 's'} from {Path(file).name}"
               + (f", with the columns {', '.join(columns)}" if columns else "") + ".")
    if summary.get("other"):
        out.append("The file is an object: props.rows is its \"rows\" list, and props.data the whole object, with "
                   f"{', '.join(summary['other'])} too.")
    if summary.get("first"):
        out.append(f"The first row: {summary['first']}")
    out += [f"Note: {n}." for n in r.get("notes") or []]
    out += key_notes(asked)
    out += ["", f"What it draws, {width} columns wide:", *copy_text(r["lines"], r["cut"], width)]
    actions = args.get("actions") if isinstance(args.get("actions"), list) else []
    if actions:
        a = await ask_card(t.ws, nxt, "act", {"actions": actions, "width": width}, t.unsandboxed)
        if a.get("ok"):
            for c in a["copies"]:
                if c.get("error"):
                    out += ["", f"After {c['what']}, the view FAILED: {c['error']}"]
                    continue
                note = f" ({c['note']})" if c.get("note") else ""
                out += ["", f"After {c['what']}{note}:", *copy_text(c["lines"], c["cut"], width)]
            out += ["", "The card is back as it was before these actions."]
            save_state(t.ws, nxt, a.get("state"))
        else:
            out += ["", f"The actions did not run: {a.get('error') or 'no answer'}"]
    return Result("\n".join(out), extra={"card": cid, "version": version, "title": title, "drawn_ms": drawn_ms,
                                         "ms": round((time.monotonic() - t0) * 1000)})


# ---- v: the designer

DESIGNS: dict[str, dict[str, Any]] = {}  # the design running in each workspace: {id, chat, turn, session}


def answer_of(ws: str, chat: str) -> tuple[str | None, str]:
    """The chat's last turn, when it ended normally, and its reply (agent.reply_of); else (None, '')."""
    recs = chats.records(ws, chat)
    start = max((i for i, r in enumerate(recs) if r.get("type") == "user"), default=-1)
    if start < 0 or not any(r.get("type") == "done" and not r.get("result") for r in recs[start:]):
        return None, ""
    reply = agent.reply_of((r.get("type") == "tool_use", r.get("delta") or "") for r in recs[start:]
                           if r.get("type") in ("text", "tool_use"))
    return recs[start].get("turn"), reply


def fenced(text: str) -> str:
    """A fenced block of text from the records, so it reads as data and not as words to act on."""
    fence = "`" * (max([2, *(len(m) for m in re.findall(r"`+", text))]) + 1)
    return f"{fence}text\n{text}\n{fence}"


def checked_since(ws: str, chat: str, turn: str) -> str:
    """What the check of the answer's marks changed since the chat's agent wrote it (features/marks.py), for the
    designer, whose copy of the conversation ends at that answer: a card must not repeat a value the check corrected
    or flagged."""
    from . import marks  # noqa: PLC0415 — marks imports this module

    items = [m for m in marks.reply_items(ws, chat, turn) if m.get("status") in ("corrected", "failed")]
    if not items:
        return ""
    def line(m: dict[str, Any]) -> str:
        if m["status"] == "corrected":
            return f"- \"{m.get('was') or m['words']}\" is wrong; it is \"{m['shown']}\""
        said = "is wrong" if m.get("failedBy") == "check" else "is not confirmed"
        return f"- \"{m['words']}\" {said}" + (f": {m['reason']}" if m.get("reason") else "")
    lines = [line(m) for m in items]
    return ("\n\nSince that answer, thimble checked its marks against the data. The check found (its words quote the "
            f"records):\n{fenced(chr(10).join(lines))}\nThe card shows the corrected values, computed from the records.")


def earlier_card(ws: str, chat: str, turn: str) -> str:
    """The card an earlier v drew under this answer: v again on the same answer changes that card."""
    for r in reversed(chats.records(ws, chat)):
        if r.get("type") == "card" and r.get("turn") == turn and (m := meta_of(ws, str(r.get("card")))):
            return (f"\n\nAn earlier press of v drew the card “{m['title']}” under this answer. Draw your card as a new "
                    f"version of it, with `id` \"{m['id']}\", so the answer keeps one card.")
    return ""


async def start_design(ctx: Any, ws: str, chat: str) -> dict[str, Any]:
    """v on the chat's last answer: the designer's copy of the chat starts; an HTTPException says why it cannot."""
    from . import is_on  # noqa: PLC0415

    if not is_on("cards"):
        raise HTTPException(409, "Cards are off in Settings")
    if chat in ctx.sessions.running(ws):
        raise HTTPException(409, "Claude is still answering; v draws a card of the answer once it is done")
    now = DESIGNS.get(ws)
    if now and now["session"].running:
        raise HTTPException(409, "v is already drawing a card")
    turn, reply = answer_of(ws, chat)
    if not turn or not reply.strip():
        raise HTTPException(409, "there is no answer to draw yet")
    prompt = (prompts.fill(prompts.shared("designer"), agent.slots(ws, ctx.folder_of(ws)))
              + checked_since(ws, chat, turn) + earlier_card(ws, chat, turn))
    design = {"id": f"d{secrets.token_hex(4)}", "chat": chat, "turn": turn, "busy": secrets.token_hex(4)}
    hub.publish(ws, {"type": "busy", "id": design["busy"], "word": "drawing a card", "on": True})
    s = await ctx.sessions.spawn(ws, "designer", chat, prompt, title="card of the last answer (v)",
                                 meta={"design": design})
    DESIGNS[ws] = {**design, "session": s}
    return {k: design[k] for k in ("id", "chat", "turn")}


def design_finished(s: Any, result: str | None) -> None:
    """The designer ended: the chat's agent reads the cards it drew, or the analyst reads why it drew none."""
    design, ws = s.meta.get("design") or {}, s.ws
    if not design:
        return
    hub.publish(ws, {"type": "busy", "id": design["busy"], "word": "drawing a card", "on": False})
    if DESIGNS.get(ws, {}).get("id") == design["id"]:
        DESIGNS.pop(ws, None)
    chat = design["chat"]
    if result == "stopped":
        return
    if result == "refused":
        notice(ws, chat, "v drew no card: the model's safeguards refused it. Settings can switch to another model.")
        return
    if result == "failed":
        notice(ws, chat, "v could not draw a card: the model call failed. Press v again to try once more.")
        return
    drawn = [m for m in (meta_of(ws, p.name) for p in sorted(cardrunner.cards_dir(ws).iterdir()))
             if m and m.get("design") == design["id"]]
    if not drawn:
        said = " ".join(s.texts[-1].split())[:160] if s.texts else ""
        notice(ws, chat, "v drew no card." + (f" The copy that drew it ended with: “{said}”" if said else ""))
        return
    asyncio.get_running_loop().create_task(tell_drawn(s, chat, drawn))


async def tell_drawn(s: Any, chat: str, drawn: list[dict[str, Any]]) -> None:
    """The chat's agent reads the v cards with the analyst's next message: each one's title, id and text copy."""
    copies = []
    for m in drawn:
        r = await ask_card(s.ws, m, "copy", {"width": int(m.get("width") or width_of(s.ws))}, s.unsandboxed)
        text = "\n".join(r.get("lines") or []) if r.get("ok") else f"(no copy: {r.get('error')})"
        copies.append(f"“{m['title']}” (id \"{m['id']}\"), as drawn now:\n{fenced(text[:TELL_CHARS])}")
    what = "a card" if len(drawn) == 1 else f"{len(drawn)} cards"
    agent.tell(s.ws, chat, f"The analyst pressed v on your last answer, and a copy of you drew {what} under it. To "
                           "change one, call card with its id. The text of a card shows the records' own words.\n\n"
               + "\n\n".join(copies))


agent.AGENTS["designer"] = agent.AgentDef(
    agent.main_prompt, agent.main_tools, finished=design_finished, allowed=DESIGNER_TOOLS,
    denied="The copy that draws a card reads files, runs Python and draws cards with the card tool, nothing more.")


# ---- the routes

EVENTS = {"key": lambda b: {"key": str(b.get("key") or "")[:1]},
          "press": lambda b: {"button": int(b.get("button") or 0)},
          "pointer": lambda b: {"down": b.get("down"), "up": b.get("up") or b.get("down")},
          "undo": lambda b: {"n": int(b.get("n") or 1)}}


def drawing(meta: dict[str, Any], r: dict[str, Any]) -> dict[str, Any]:
    """A card as the page draws it: its title, keys and version, and its tree or why there is none."""
    head = {"id": meta["id"], "title": meta["title"], "version": meta["version"], "keys": meta.get("keys") or [],
            "chat": meta.get("chat"), "turn": meta.get("turn")}
    if not r.get("ok"):
        return {**head, "error": str(r.get("error") or "no answer")}
    return {**head, "tree": r.get("tree"), "handled": r.get("handled", True)}


def register(ctx: Any) -> None:
    app = ctx.app

    def meta_or_404(c: str, cid: str) -> dict[str, Any]:
        ctx.ws_of(c)
        meta = meta_of(c, cid)
        if not meta:
            raise HTTPException(404, f"no card {cid!r}")
        return meta

    @app.put("/api/ws/{c}/cards/width")
    def card_width(c: str, body: dict = Body(...)) -> dict[str, int]:
        cols = body.get("cols")
        if not isinstance(cols, int) or cols < MIN_WIDTH:
            raise HTTPException(400, f"cols: a whole number of at least {MIN_WIDTH}")
        p = home.workspace_dir(ctx.ws_of(c)) / "session.json"
        home.write_json(p, {**(home.read_json(p, {}) or {}), "card_cols": cols})
        return {"cols": cols}

    @app.get("/api/ws/{c}/cards/{cid}")
    async def card_get(c: str, cid: str, width: int = 0) -> dict[str, Any]:
        meta = meta_or_404(c, cid)
        w = max(MIN_WIDTH, width) if width else int(meta.get("width") or width_of(c))
        return drawing(meta, await ask_card(c, meta, "draw", {"width": w}, ctx.sessions.unsandboxed))

    @app.post("/api/ws/{c}/cards/{cid}/{op}")
    async def card_event(c: str, cid: str, op: str, body: dict = Body(...)) -> dict[str, Any]:
        meta = meta_or_404(c, cid)
        if op not in EVENTS:
            raise HTTPException(404, f"no card event {op!r}")
        r = await ask_card(c, meta, op, EVENTS[op](body), ctx.sessions.unsandboxed)
        if r.get("ok"):
            save_state(c, meta, r.get("state"))
        return drawing(meta, r)

    @app.post("/api/ws/{c}/v")
    async def v(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        return await start_design(ctx, c, str(body.get("chat") or "main"))


FEATURE = Feature(
    name="cards",
    title="Cards",
    does="Claude draws interactive cards under its answers, and v draws one of the last answer.",
    register=register,
    tools={"card": card},
    main_tools=("card",),
    prompt="cards.md",
)
