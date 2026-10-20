"""Lenses: readers that mark passages of what Claude wrote, so the analyst sees what to look at twice. A mark is
active: a click opens what the lens says about the passage, and a question about it opens a thread anchored to it.

There are three built-in lenses, and the analyst's own checks (the page calls every lens a check):

- **Explainers** (`explain`, teal) mark the terms the analyst may not know, with what each means here. The instructions
  are the terminal plugin's explain lens, word for word (prompts/shared.json, part `explain`).
- **Important details** (`details`, orange) mark a detail the analyst should know before relying on the text.
- **Unverifiable** (`unverifiable`, off at first) marks a claim that nothing in the files can support.
- **A check** the analyst asks for (`add_check`, or POST /lenses) marks the passages its instructions name, such as
  "claims no cited source shows".

Each lens has a scope: the surfaces it reads, the chat's answers (`chat`), the cards' takeaways (`cards`) and the
report (`report`). One small API sets it (PUT /api/ws/{c}/lenses/{id}), so any control on the page can sit on top. A
lens that is off, or a surface out of its scope, shows no marks there, and the next reading skips it.

When a lens reads. After each turn of the chat agent, one model call reads what the turn wrote on each surface that
some lens covers: the answer, the cards it made or changed, and the report when the turn saved it. That is the one
quiet look after a turn; nothing else runs unless the analyst asks (a new check reads at once, POST /lenses/read reads
again). The call has no tools.

Marks are kept in `marks.json` in the workspace: {id, lens, surface, where, term, title, body, here, ts}. `where` is
the chat and its answer's turn, the card's id, or `report`. A mark follows its words: one whose term is no longer in
the card's takeaway or the report is not served. A chat's marks are also a `marks` record in its log, after the
answer they mark, so the page draws them on that answer.

    GET    /api/ws/{c}/lenses              the lenses, each {id, name, color, builtin, on, scope, question, leaves,
                                           instructions, found: {chat, cards, report}}
    PUT    /api/ws/{c}/lenses/{id}         {on?, scope?: {chat?, cards?, report?}, instructions?}: the lens as it is now
    GET    /api/ws/{c}/lenses/{id}/found   what the lens found, where it stands now, newest first
    POST   /api/ws/{c}/lenses              {name, instructions, scope?}: the analyst's own check; it reads at once
    DELETE /api/ws/{c}/lenses/{id}         remove an own check and its marks
    POST   /api/ws/{c}/lenses/read         {lens?, surfaces?}: read now, as the analyst asks
    GET    /api/ws/{c}/marks               {marks, lenses}: the marks shown now (?surface= for one surface)
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import threading
from pathlib import Path
from typing import Any

from fastapi import Body, HTTPException

from .. import agent, canvas, chats, home, llm, prompts, report, tools
from ..hub import hub
from ..tools import Result
from . import Feature, is_on

log = logging.getLogger("thimble_browser.lenses")

SURFACES = ("chat", "cards", "report")
# the built-in lenses: their names, colors and today's default scope
BUILTIN: dict[str, dict[str, Any]] = {
    "explain": {"name": "Explainers", "color": "teal", "key": "glosses", "prompt": "lens-explain.md", "on": True,
                "question": "Which terms might the reader not know?",
                "leaves": "the term highlighted; a click explains it",
                "scope": {"chat": True, "cards": False, "report": False}},
    "details": {"name": "Important details", "color": "orange", "key": "details", "prompt": "lens-details.md",
                "on": True, "question": "Which details are easy to miss and matter before relying on this?",
                "leaves": "the detail highlighted, and what to do about it beside it",
                "scope": {"chat": False, "cards": False, "report": True}},
    "unverifiable": {"name": "Unverifiable", "color": "gold", "key": "unverifiable", "prompt": "lens-check.md",
                     "on": False, "question": "Which claims can't be checked against the files?",
                     "instructions": "Mark a claim only when nothing in the files can support it, and the claim matters "
                                     "to the conclusions.",
                     "leaves": "the claim highlighted, and a comment beside it",
                     "scope": {"chat": False, "cards": False, "report": True}},
}
# the colors a check of the analyst's own takes, in turn (the page's viz families, tokens.css)
OWN_COLORS = ("pink", "blue", "green", "violet", "gold")
OWN_LEAVES = "the passage highlighted, and a comment beside it"
KEEP_SEEN = 100  # terms already explained that the explain lens is told of
TEXT_MAX = 4000
_lock = threading.RLock()


# ---- the lenses

def _conf_path(ws: str) -> Path:
    return home.workspace_dir(ws) / "lenses.json"


def _conf(ws: str) -> dict[str, Any]:
    got = home.read_json(_conf_path(ws), {}) or {}
    return got if isinstance(got, dict) else {}


def _scope(raw: Any, default: dict[str, bool]) -> dict[str, bool]:
    raw = raw if isinstance(raw, dict) else {}
    return {s: bool(raw.get(s, default.get(s, False))) for s in SURFACES}


def lenses(ws: str) -> list[dict[str, Any]]:
    """Every lens as it is now: the built-ins with the analyst's changes, then their own checks."""
    conf = _conf(ws)
    out = []
    for lid, b in BUILTIN.items():
        own = (conf.get("builtin") or {}).get(lid) or {}
        out.append({"id": lid, "name": b["name"], "color": b["color"], "builtin": True, "on": own.get("on", b["on"]),
                    "scope": _scope(own.get("scope"), b["scope"]), "question": b["question"], "leaves": b["leaves"],
                    "instructions": b.get("instructions")})
    for c in conf.get("checks") or []:
        out.append({"id": c["id"], "name": c["name"], "color": c.get("color") or OWN_COLORS[0], "builtin": False,
                    "on": c.get("on", True), "scope": _scope(c.get("scope"), {"report": True}),
                    "question": c.get("instructions") or "", "leaves": OWN_LEAVES,
                    "instructions": c.get("instructions") or ""})
    return out


def with_found(ws: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The lenses with how many marks each found on each surface, shown or not: what the Checks sidebar counts."""
    found = {x["id"]: {s: 0 for s in SURFACES} for x in rows}
    for m in present(ws):
        if m["lens"] in found:
            found[m["lens"]][m["surface"]] += 1
    return [{**x, "found": found[x["id"]]} for x in rows]


def lens(ws: str, lid: str) -> dict[str, Any]:
    for x in lenses(ws):
        if x["id"] == lid:
            return x
    raise KeyError(lid)


def reads(ws: str, lid: str, surface: str) -> bool:
    """Whether lens `lid` marks `surface` now: the lenses feature and the lens are on, and the surface is in scope."""
    try:
        x = lens(ws, lid)
    except KeyError:
        return False
    return is_on("lenses") and x["on"] and x["scope"].get(surface, False)


def set_lens(ws: str, lid: str, *, on: bool | None = None, scope: dict[str, Any] | None = None,
             instructions: str | None = None) -> dict[str, Any]:
    with _lock:
        x = lens(ws, lid)
        conf = _conf(ws)
        new_scope = _scope({**x["scope"], **(scope or {})}, x["scope"]) if scope is not None else x["scope"]
        if x["builtin"]:
            row = conf.setdefault("builtin", {}).setdefault(lid, {})
        else:
            row = next(c for c in conf.get("checks") or [] if c["id"] == lid)
        if on is not None:
            row["on"] = bool(on)
        if scope is not None:
            row["scope"] = new_scope
        if instructions is not None:
            if x["builtin"]:
                raise ValueError("a built-in check keeps its own question")
            if not instructions.strip():
                raise ValueError("a check needs its question")
            row["instructions"] = instructions.strip()[:TEXT_MAX]
        home.write_json(_conf_path(ws), conf)
    hub.publish(ws, {"type": "lenses"})
    return lens(ws, lid)


def add_lens(ws: str, name: str, instructions: str, scope: dict[str, Any] | None = None) -> dict[str, Any]:
    name, instructions = " ".join(name.split())[:80], instructions.strip()[:TEXT_MAX]
    if not name or not instructions:
        raise ValueError("a check needs its name and its instructions")
    with _lock:
        conf = _conf(ws)
        lid = "k" + secrets.token_hex(3)
        taken = [c.get("color") for c in conf.get("checks") or []]
        color = min(OWN_COLORS, key=lambda c: (taken.count(c), OWN_COLORS.index(c)))
        conf.setdefault("checks", []).append({"id": lid, "name": name, "instructions": instructions, "on": True,
                                              "color": color, "scope": _scope(scope, {"report": True}),
                                              "ts": home.now()})
        home.write_json(_conf_path(ws), conf)
    hub.publish(ws, {"type": "lenses"})
    return lens(ws, lid)


def remove_lens(ws: str, lid: str) -> None:
    with _lock:
        conf = _conf(ws)
        if lid in BUILTIN or not any(c["id"] == lid for c in conf.get("checks") or []):
            raise KeyError(lid)
        conf["checks"] = [c for c in conf["checks"] if c["id"] != lid]
        home.write_json(_conf_path(ws), conf)
        _save_marks(ws, [m for m in _marks(ws) if m["lens"] != lid])
    hub.publish(ws, {"type": "lenses"})


# ---- the marks

def _marks_path(ws: str) -> Path:
    return home.workspace_dir(ws) / "marks.json"


def _marks(ws: str) -> list[dict[str, Any]]:
    got = home.read_json(_marks_path(ws), {}) or {}
    return [m for m in got.get("marks") or [] if isinstance(m, dict)] if isinstance(got, dict) else []


def _save_marks(ws: str, marks: list[dict[str, Any]]) -> None:
    home.write_json(_marks_path(ws), {"marks": marks})


def _card_text(cell: dict[str, Any]) -> str:
    return f"{cell.get('title') or ''}\n{cell.get('takeaway') or ''}"


def present(ws: str, surface: str | None = None) -> list[dict[str, Any]]:
    """The marks whose words are still where they were found (a card's takeaway, the report), dismissed ones left out,
    whether their lens shows them or not."""
    out = []
    md = None
    for m in _marks(ws):
        if m.get("status") == "dismissed" or (surface and m["surface"] != surface):
            continue
        if m["surface"] == "cards":
            try:
                if m["term"] not in _card_text(canvas.find(ws, m["where"])[1]):
                    continue
            except KeyError:
                continue
        elif m["surface"] == "report":
            md = report.markdown(ws) if md is None else md
            if not md or m["term"] not in md:
                continue
        out.append(m)
    return out


def shown(ws: str, surface: str | None = None) -> list[dict[str, Any]]:
    """The marks the page shows now: of a lens that reads that surface, on words that are still there."""
    return [m for m in present(ws, surface) if reads(ws, m["lens"], m["surface"])]


def resolve_ref(ws: str, ref: str) -> dict[str, Any]:
    """A `mark:<id>` ref: the mark, as a thread about it reads it."""
    mid = ref.removeprefix("mark:")
    for m in _marks(ws):
        if m["id"] == mid:
            name = lens(ws, m["lens"])["name"] if m["lens"] in {x["id"] for x in lenses(ws)} else m["lens"]
            where = {"chat": "an answer in the chat", "cards": f"card:{m['where']}", "report": "the report"}
            text = f"{name} on \"{m['term']}\" in {where.get(m['surface'], m['surface'])}: {m.get('title') or ''}\n" \
                   f"{m.get('body') or ''}\n{m.get('here') or ''}".strip()
            return {"ref": ref, "kind": "mark", "excerpt": text, "meta": m}
    raise KeyError(ref)


# ---- reading: one call over what changed, for every lens that reads it

def _lens_text(ws: str, x: dict[str, Any]) -> str:
    if x["builtin"] and BUILTIN[x["id"]]["prompt"] != "lens-check.md":
        text = prompts.render(BUILTIN[x["id"]]["prompt"])
        if x["id"] == "explain":
            seen = [m["term"] for m in _marks(ws) if m["lens"] == "explain"][-KEEP_SEEN:]
            text += "\n\n" + prompts.shared("explain-digest").replace("{{GLOSSED}}", "\n".join(seen) or "(none)")
        return text
    return prompts.render("lens-check.md", {"name": x["name"], "instructions": x["instructions"] or "",
                                            "key": x["id"]})


def _key(x: dict[str, Any]) -> str:
    return BUILTIN[x["id"]]["key"] if x["builtin"] else x["id"]


def found(ws: str, lid: str) -> list[dict[str, Any]]:
    """What a lens found, newest first, each mark with where it stands now: the chat and its answer, the card's question,
    or the report; whether it is shown there."""
    titles: dict[str, str] = {}
    for nb in canvas.notebooks(ws):
        for c in nb["cells"]:
            titles[c["id"]] = c.get("title") or ""
    out = []
    for m in present(ws):
        if m["lens"] != lid:
            continue
        where = {"chat": m["where"] or "main", "cards": titles.get(m["where"], ""), "report": "report"}[m["surface"]]
        out.append({**m, "place": where, "shown": reads(ws, lid, m["surface"])})
    return sorted(out, key=lambda m: str(m.get("ts") or ""), reverse=True)


def _schema(active: list[dict[str, Any]]) -> dict[str, Any]:
    item = {"type": "object", "additionalProperties": False, "required": ["where", "term", "body"],
            "properties": {"where": {"type": "string"}, "term": {"type": "string"}, "title": {"type": "string"},
                           "body": {"type": "string"}, "here": {"type": "string"}}}
    keys = [_key(x) for x in active]
    return {"type": "object", "additionalProperties": False, "required": keys,
            "properties": {k: {"type": "array", "items": item} for k in keys}}


def _texts(ws: str, chat: str | None, answer: str | None, cards: list[str], with_report: bool) -> dict[str, str]:
    """The texts to read, by their place: `answer`, `card:<id>`, `report`."""
    out: dict[str, str] = {}
    if answer:
        out["answer"] = answer
    for cid in dict.fromkeys(cards):
        try:
            cell = canvas.find(ws, cid)[1]
        except KeyError:
            continue
        out[f"card:{cid}"] = _card_text(cell)
    if with_report:
        md = report.markdown(ws)
        if md and md.strip():
            out["report"] = md
    return out


def _surface_of(place: str) -> str:
    return "chat" if place == "answer" else "cards" if place.startswith("card:") else "report"


async def read(ws: str, *, chat: str | None = None, answer: str | None = None, cards: list[str] | None = None,
               with_report: bool = False, only: str | None = None, question: str = "") -> int:
    """One reading of the given texts by every lens that reads their surfaces (`only`: that lens alone); the number
    of marks made."""
    texts = _texts(ws, chat, answer, cards or [], with_report)
    active = [x for x in lenses(ws) if (only is None or x["id"] == only)
              and any(reads(ws, x["id"], _surface_of(p)) for p in texts)]
    if not texts or not active:
        return 0
    places = "\n\n".join(f"<text place=\"{p}\">\n{t[:20000]}\n</text>" for p, t in texts.items())
    covers = "\n".join(f"- {x['name']} (\"{_key(x)}\"): reads "
                       + ", ".join(p for p in texts if reads(ws, x["id"], _surface_of(p))) for x in active)
    system = prompts.render("lenses.md", {"lenses": "\n\n".join(_lens_text(ws, x) for x in active)})
    user = (f"The analyst asked:\n{question}\n\n" if question else "") + \
        f"The texts to read:\n\n{places}\n\nWhich lens reads which text:\n{covers}"
    try:
        got = json.loads(await llm.complete(system, user, schema=_schema(active), effort="low") or "{}")
    except Exception as e:  # noqa: BLE001 — a failed reading leaves the texts as they are, and says so once
        log.warning("the lenses' reading failed: %s", llm.failure(e))
        if chat:
            chats.append(ws, chat, {"type": "notice", "kind": "lenses",
                                    "text": f"The marks of this answer could not be made: {llm.failure(e)}"})
        return 0
    made: list[dict[str, Any]] = []
    for x in active:
        for it in (got.get(_key(x)) or [])[:5]:
            place, term = str(it.get("where") or "answer"), str(it.get("term") or "").strip().strip("`")
            if place not in texts or not term or term not in texts[place] or not it.get("body"):
                continue
            surface = _surface_of(place)
            if not reads(ws, x["id"], surface):
                continue
            made.append({"id": "m" + secrets.token_hex(4), "lens": x["id"], "surface": surface,
                         "where": chat if surface == "chat" else place.removeprefix("card:") if surface == "cards"
                         else "report", "term": term, "title": str(it.get("title") or "")[:120],
                         "body": str(it["body"])[:TEXT_MAX], "here": str(it.get("here") or "")[:TEXT_MAX],
                         "ts": home.now()})
    if not made:
        return 0
    with _lock:
        _save_marks(ws, _marks(ws) + made)
    on_chat = [m for m in made if m["surface"] == "chat"]
    if on_chat and chat:
        chats.append(ws, chat, {"type": "marks", "marks": on_chat})
    hub.publish(ws, {"type": "marks"})
    if any(m["surface"] == "report" for m in made):
        hub.publish(ws, {"type": "report", "slug": report.DOC, "status": "marked"})
    return len(made)


def _question(ws: str, chat: str) -> str:
    for r in reversed(chats.records(ws, chat)):
        if r.get("type") == "user":
            return str(r.get("text") or "")
    return ""


def _after_turn(session: Any, answer: str, result: str | None) -> None:
    """After the chat agent's turn: one reading of what the turn wrote, by the lenses that read it."""
    if result is not None or not is_on("lenses"):
        return
    st = report.state(session.ws)
    with_report = bool(st.get("generated_at")) and str(st.get("generated_at")) >= str(session.started_at or "") \
        and st.get("by") != "analyst"
    asyncio.get_running_loop().create_task(read(session.ws, chat=session.chat, answer=answer,
                                                cards=list(session.cards), with_report=with_report,
                                                question=_question(session.ws, session.chat)))


# ---- the chat's tool

async def add_check(t: Any, args: dict[str, Any]) -> Result:
    surfaces = [s for s in args.get("surfaces") or ["report"] if s in SURFACES]
    try:
        x = add_lens(t.ws, str(args.get("name") or ""), str(args.get("instructions") or ""),
                     {s: True for s in surfaces})
    except ValueError as e:
        return Result(str(e), True)
    asyncio.get_running_loop().create_task(read_all(t.ws, x["id"]))
    return Result(f"Added the check {x['name']} on {', '.join(surfaces)}. It is reading them now; its marks appear "
                  "on the passages it finds, and after each later turn on what the turn wrote.")


async def read_all(ws: str, lid: str | None = None, surfaces: list[str] | None = None) -> int:
    """Read every text of the surfaces now: the latest answer of main, every card, the report."""
    surfaces = surfaces or list(SURFACES)
    answer = None
    if "chat" in surfaces:
        parts: list[str] = []
        for r in reversed(chats.records(ws, "main")):
            if r.get("type") == "user":
                break
            if r.get("type") == "text":
                parts.insert(0, r.get("delta") or "")
        answer = "".join(parts).strip() or None
    cards = [c["id"] for nb in canvas.notebooks(ws) for c in nb["cells"]] if "cards" in surfaces else []
    return await read(ws, chat="main" if answer else None, answer=answer, cards=cards[-40:],
                      with_report="report" in surfaces, only=lid)


# ---- the routes

def register(ctx: Any) -> None:
    app = ctx.app
    agent.AFTER_TURN.append(_after_turn)
    tools.REF_RESOLVERS["mark:"] = resolve_ref
    report.DECORATE.append(lambda ws, doc: doc.__setitem__("marks", shown(ws, "report")))

    @app.get("/api/ws/{c}/lenses")
    def get_lenses(c: str) -> list[dict[str, Any]]:
        ws = ctx.ws_of(c)
        return with_found(ws, lenses(ws))

    @app.get("/api/ws/{c}/lenses/{lid}/found")
    def get_found(c: str, lid: str) -> list[dict[str, Any]]:
        ws = ctx.ws_of(c)
        try:
            lens(ws, lid)
        except KeyError:
            raise HTTPException(404, f"no lens {lid!r}") from None
        return found(ws, lid)

    @app.put("/api/ws/{c}/lenses/{lid}")
    def put_lens(c: str, lid: str, body: dict = Body(...)) -> dict[str, Any]:
        scope = body.get("scope")
        if scope is not None and (not isinstance(scope, dict) or any(k not in SURFACES for k in scope)):
            raise HTTPException(400, f"scope: {{surface: true or false}}, the surfaces {', '.join(SURFACES)}")
        ws = ctx.ws_of(c)
        try:
            set_lens(ws, lid, on=body.get("on"), scope=scope,
                     instructions=str(body["instructions"]) if "instructions" in body else None)
        except KeyError:
            raise HTTPException(404, f"no lens {lid!r}") from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return next(x for x in with_found(ws, lenses(ws)) if x["id"] == lid)

    @app.post("/api/ws/{c}/lenses", status_code=201)
    async def post_lens(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        try:
            x = add_lens(ws, str(body.get("name") or ""), str(body.get("instructions") or ""), body.get("scope"))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        asyncio.get_running_loop().create_task(read_all(ws, x["id"]))
        return x

    @app.delete("/api/ws/{c}/lenses/{lid}")
    def delete_lens(c: str, lid: str) -> dict[str, str]:
        try:
            remove_lens(ctx.ws_of(c), lid)
        except KeyError:
            raise HTTPException(404, f"no check {lid!r} of the analyst's own") from None
        return {"deleted": lid}

    @app.post("/api/ws/{c}/lenses/read")
    async def read_now(c: str, body: dict = Body(default={})) -> dict[str, int]:
        ws = ctx.ws_of(c)
        surfaces = [s for s in body.get("surfaces") or SURFACES if s in SURFACES]
        return {"marks": await read_all(ws, body.get("lens"), surfaces)}

    @app.get("/api/ws/{c}/marks")
    def get_marks(c: str, surface: str | None = None) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        return {"marks": shown(ws, surface), "lenses": with_found(ws, lenses(ws))}

    @app.post("/api/ws/{c}/marks/{mid}/dismiss")
    def dismiss(c: str, mid: str) -> dict[str, bool]:
        ws = ctx.ws_of(c)
        with _lock:
            marks = _marks(ws)
            if not any(m["id"] == mid for m in marks):
                raise HTTPException(404, f"no mark {mid!r}")
            _save_marks(ws, [{**m, "status": "dismissed"} if m["id"] == mid else m for m in marks])
        hub.publish(ws, {"type": "marks"})
        return {"ok": True}


FEATURE = Feature(
    name="lenses",
    title="Explainers and checks",
    does="Marks passages to look at twice: teal for a term you may not know, orange for an important detail, and "
         "the checks you ask for. A click opens what it says.",
    register=register,
    tools={"add_check": add_check},
    main_tools=("add_check",),
    page=("marks",),
)
