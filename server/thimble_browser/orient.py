"""The orientation: a broad analysis of the folder that leaves its findings as a deck of cards, the group `Orientation`,
with a critic that reviews its analysis before it finishes.

The orientation is one of thimble's agents (agent.AGENTS["orient"], prompts/browser/orient.md), started in a chat of its
own (kind `agent`, role `orient`) by main's `start_orientation` or by `POST /ws/{c}/orientation`. Main's chat gets an
`agent` row that opens its thread. Every card it adds goes to the deck (AgentDef.group), whose group has the role
`exploration`, which the canvas opens on. Each of its calls carries its ref, `call:<chat>/<n>` (calls.py).

The critic. Once the deck is drafted, the orientation calls `critique` with its account. The tool starts the critic
(agent.AGENTS["critic"], prompts/browser/critic.md) in a chat of its own, a step of the orientation's thread (role
`step`, agent type `thimble:critic`), with a brief: the account, the drafted cards, the files no call named, the
orientation's transcript with each call under its ref, and the analyst's chat. The tool waits for the critic's turn to
end, and its report is the tool's result. Meanwhile the orientation's chat is `paused: critique`. Stopping the critique
ends only the critique; stopping the orientation ends both.

Follow-ups. A message to the orientation (its thread's composer, `POST /ws/{c}/orientation/message`, or main's
`message_orientation`) continues the same conversation as run k = 1, 2, ...: its user row says so (`run`, `event`), main's
chat gets an `agent` row for that run, and the chat's meta keeps each run's state in `followups`. A message sent while
the orientation runs waits until the run ends.

The record, `orient/run.json`, is what `GET /ws/{c}/orientation` serves (frontend lib/types OrientRun): {status, query,
model, effort, route, started_by, agent_id, started, ended, chats: {orient}, run, pending}. Main's meta keeps the status
as `orientation`, and every change is an `orient` record on the stream.
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import re
import secrets
from pathlib import Path
from typing import Any

from fastapi import Body, HTTPException

from . import agent, canvas, chats, home, prompts, settings, tools
from .agent import AGENTS, READ, AgentDef, load_messages
from .calls import calls_of
from .hub import hub

log = logging.getLogger("thimble_browser.orient")

ROLE = "orient"
TITLE = "Orientation"
DECK = "Orientation"
DECK_ROLE = "exploration"  # the role of the deck's group, which the canvas opens on (frontend canvas/layout.ts)
CRITIC = "critic"
CRITIC_TITLE = "critique"
CRITIC_TYPE = "thimble:critic"
NO_REQUEST = "Orient me in this folder."
ORIENT_TOOLS = READ + ("run_python", "read_ref", "list_cards", "add_card", "edit_card", "delete_card", "critique")
CRITIC_TOOLS = READ + ("run_python", "read_ref", "list_cards")
MAIN_TOOLS = ("start_orientation", "message_orientation")
# the critic's brief
RESULT_LINES = 8  # lines of a call's result the transcript shows; the critic reads a call whole with read_ref
LINE_CHARS = 200
VALUE_CHARS = 400  # of one string of a call's input, such as a card's code
TRANSCRIPT_CHARS = 200_000
CHAT_CHARS = 40_000  # of the analyst's chat
UNNAMED_SHOWN = 80  # of the files no call named
RUNNING = ("starting", "running")


# ---- the record

def _dir(ws: str) -> Path:
    d = home.workspace_dir(ws) / "orient"
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_run(ws: str) -> dict[str, Any]:
    got = home.read_json(_dir(ws) / "run.json", {})
    return got if isinstance(got, dict) else {}


def _write_run(ws: str, run: dict[str, Any]) -> dict[str, Any]:
    home.write_json(_dir(ws) / "run.json", run)
    return run


def _update_run(ws: str, **fields: Any) -> dict[str, Any]:
    return _write_run(ws, {**read_run(ws), **fields})


def _announce(ws: str, status: str, **fields: Any) -> None:
    """The status in main's meta (`orientation`), which the page reads the record again on, and on the stream."""
    try:
        m = chats.meta(ws, "main")
        m["orientation"] = status
        chats.save_meta(ws, m)
    except KeyError:
        pass
    hub.publish(ws, {"type": "orient", "status": status, **fields})
    hub.publish(ws, {"type": "chat", "chat": "main"})


def latest_chat(ws: str) -> str | None:
    chat = (read_run(ws).get("chats") or {}).get(ROLE)
    if not chat:
        return None
    try:
        chats.meta(ws, chat)
    except KeyError:
        return None
    return str(chat)


def running(ws: str, sessions: agent.Sessions) -> bool:
    chat = latest_chat(ws)
    return bool(chat and chat in sessions.running(ws))


def ensure_deck(ws: str) -> dict[str, Any]:
    """The deck's group, made when there is none, with the role the canvas opens on."""
    nb = canvas.group_for(ws, DECK)
    if nb.get("role") != DECK_ROLE:
        nb = canvas.load(ws, nb["id"])
        nb["role"] = DECK_ROLE
        canvas.save(ws, nb)
    return nb


def _deck_cards(ws: str) -> list[dict[str, Any]]:
    for nb in canvas.notebooks(ws):
        if nb.get("title") == DECK:
            return list(nb["cells"])
    return []


# ---- starting it

def first_message(ws: str, query: str) -> str:
    parts = [f"The analyst's request: {query.strip()}" if query.strip() else
             "The analyst gave no request: orient them in the whole folder."]
    cards = _deck_cards(ws)
    if cards:
        parts += ["", "An earlier orientation left these cards in the deck. Add to them rather than repeat them:"]
        parts += [f"- card:{c['id']} ({c['kind']}) {c['title']} | {(c.get('takeaway') or '')[:200]}" for c in cards]
    return "\n".join(parts)


async def start(ws: str, sessions: agent.Sessions, query: str, *, by: str = "click",
                tool_use_id: str | None = None) -> dict[str, Any]:
    """Start an orientation on the analyst's request `query`: {chat} for one started, {kind: busy, chat} while one
    runs."""
    if running(ws, sessions):
        return {"kind": "busy", "chat": latest_chat(ws), "reason": "an orientation is running already"}
    ensure_deck(ws)
    s = settings.read()
    values = {"model": s["model"], "effort": sessions_effort(ws)}
    cid = "o" + secrets.token_hex(4)
    m = chats.new_meta(cid, kind="agent", title=TITLE, parent="main")
    m.update(role=ROLE, status="running", route="subagent", agent_id=cid, brief=query.strip() or NO_REQUEST,
             values=values, run=0, followups=[], query=query.strip() or None)
    chats.save_meta(ws, m)
    _write_run(ws, {"status": "running", "query": query.strip() or None, **values, "route": "subagent",
                    "started_by": by, "agent_id": cid, "started": home.now(), "ended": None,
                    "chats": {ROLE: cid}, "run": 0, "pending": []})
    chats.append(ws, "main", {"type": "agent", "chat": cid, "role": ROLE, "title": TITLE,
                              **({"tool_use_id": tool_use_id} if tool_use_id else {})})
    await sessions.get(ws, cid).send(first_message(ws, query), shown=query.strip() or NO_REQUEST)
    _announce(ws, "running", chat=cid)
    return {"chat": cid, "agentId": cid}


def sessions_effort(ws: str) -> str:
    e = (home.read_json(home.workspace_dir(ws) / "session.json", {}) or {}).get("effort")
    return {"ultracode": "xhigh"}.get(e, e) if e in settings.EFFORTS + ("ultracode",) else settings.read()["effort"]


async def message(ws: str, sessions: agent.Sessions, text: str, *, by: str = "browser") -> dict[str, Any]:
    """Send the latest orientation a message: it continues as its next run, now or when the run going on ends."""
    text = text.strip()
    if not text:
        raise ValueError("an empty message")
    chat = latest_chat(ws)
    if chat is None:
        raise LookupError("there is no orientation yet: ask for one in main")
    run = read_run(ws)
    if chat in sessions.running(ws):
        _update_run(ws, pending=[*(run.get("pending") or []), {"text": text, "by": by}])
        return {"status": "sent", "chat": chat, "queued": True}
    await _follow_up(ws, sessions, chat, text, by)
    return {"status": "sent", "chat": chat}


async def _follow_up(ws: str, sessions: agent.Sessions, chat: str, text: str, by: str) -> None:
    run = read_run(ws)
    k = int(run.get("run") or 0) + 1
    m = chats.meta(ws, chat)
    m.update(status="running", run=k, ts_end=None)
    m.pop("stopped_by", None)
    m["followups"] = [*(m.get("followups") or []), {"run": k, "status": "running", "started": home.now(),
                                                     "ended": None}]
    chats.save_meta(ws, m)
    _update_run(ws, status="running", run=k, ended=None)
    chats.append(ws, "main", {"type": "agent", "chat": chat, "role": ROLE, "title": TITLE, "run": k})
    await sessions.get(ws, chat).send(text, record={"run": k, "event": "orient-follow-up", "by": by})
    _announce(ws, "running", chat=chat, run=k)


def _finished(session: agent.Session, result: str | None) -> None:
    """The end of one of the orientation's runs: its state in its meta, the record, main's meta and the stream; a
    message that waited starts the next run."""
    ws, chat = session.ws, session.chat
    status = {None: "done", "stopped": "stopped"}.get(result, "failed")
    m = chats.meta(ws, chat)
    k = int(m.get("run") or 0)
    m.update(status=status, ts_end=home.now())
    m.pop("paused", None)
    if status == "stopped":
        m["stopped_by"] = "analyst"
    for u in m.get("followups") or []:
        if u.get("run") == k and u.get("status") == "running":
            u.update(status=status, ended=home.now())
    chats.save_meta(ws, m)
    run = read_run(ws)
    pending = list(run.get("pending") or [])
    run.update(status=status, ended=home.now(), pending=[])
    _write_run(ws, run)
    _announce(ws, status, chat=chat, run=k)
    if pending and status != "stopped" and session.manager is not None:
        text = "\n\n".join(str(p.get("text") or "") for p in pending)
        asyncio.get_running_loop().create_task(_follow_up(ws, session.manager, chat, text,
                                                          str(pending[-1].get("by") or "browser")))


# ---- the critic

def _short(v: Any) -> Any:
    if isinstance(v, str):
        return v if len(v) <= VALUE_CHARS else v[:VALUE_CHARS] + f"... [{len(v)} characters]"
    if isinstance(v, dict):
        return {k: _short(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_short(x) for x in v]
    return v


def _lines(text: str, n: int = RESULT_LINES) -> list[str]:
    lines = (text or "").split("\n")
    out = [ln if len(ln) <= LINE_CHARS else ln[:LINE_CHARS] + " [...]" for ln in lines[:n]]
    if len(lines) > n:
        out.append(f"[{len(lines) - n} more lines: read_ref the call]")
    return out


def transcript(ws: str, chat: str) -> str:
    """The orientation's work in order: its messages and each call under its ref, with its input and the start of its
    result."""
    results: dict[str, tuple[str, bool]] = {}
    numbers = {c["id"]: c for c in calls_of(ws, chat)}
    for c in numbers.values():
        results[c["id"]] = (c["result"] or "", c["is_error"])
    out: list[str] = []
    for msg in load_messages(ws, chat):
        if msg.get("role") == "user" and isinstance(msg.get("content"), str):
            out.append(f"[message to the orientation]\n{msg['content']}")
            continue
        if msg.get("role") != "assistant":
            continue
        for b in msg.get("content") or []:
            if b.get("type") == "text" and b.get("text", "").strip():
                out.append(f"[orientation]\n{b['text'].strip()}")
            elif b.get("type") == "tool_use":
                c = numbers.get(b.get("id")) or {}
                head = f"call:{chat}/{c.get('n', '?')} {b.get('name')} {json.dumps(_short(b.get('input')), ensure_ascii=False)}"
                res, err = results.get(b.get("id"), ("(no result)", False))
                out.append("\n".join([head, *[("  error: " if err and i == 0 else "  ") + ln
                                              for i, ln in enumerate(_lines(res))]]))
    text = "\n\n".join(out)
    return text if len(text) <= TRANSCRIPT_CHARS else text[-TRANSCRIPT_CHARS:]


def _folder_files(folder: Path) -> list[str]:
    t = tools.Tools("-", "-", folder)
    return [str(p.relative_to(folder)) for p in t._files(folder)]


GLOBBY = re.compile(r"""["']([^"'\n]*[*?][^"'\n]*)["']""")
LISTS = ("glob", "listdir", "iterdir", "rglob", "walk", "scandir")


def unnamed_files(ws: str, chat: str, folder: Path) -> tuple[list[str], int]:
    """The folder's files that no Read call, no code of a call or a deck card, and no glob or listed folder in that code
    named: candidates for files the orientation never opened. (the files, how many the folder holds)"""
    files = _folder_files(folder)
    texts: list[str] = []
    for c in calls_of(ws, chat):
        inp = c.get("input") or {}
        if c["name"] == "Read":
            texts.append(str(inp.get("file_path") or ""))
        elif c["name"] in ("run_python", "add_card", "edit_card"):
            texts.append(str(inp.get("code") or ""))
            texts += [str(r.get("ref") if isinstance(r, dict) else r) for r in inp.get("refs") or []]
        elif c["name"] == "Grep":
            texts.append(c.get("result") or "")
    texts += [str(card.get("code") or "") for card in _deck_cards(ws)]
    blob = "\n".join(texts)
    pats = set(GLOBBY.findall(blob))
    lists = any(w in blob for w in LISTS)
    out = []
    for f in files:
        if f in blob or any(fnmatch.fnmatch(f, p) or fnmatch.fnmatch(f, p.lstrip("./")) for p in pats):
            continue
        parent = str(Path(f).parent)
        if lists and parent != "." and (f'"{parent}' in blob or f"'{parent}" in blob):
            continue
        out.append(f)
    return out, len(files)


def critic_brief(ws: str, chat: str, account: str, folder: Path) -> str:
    parts = ["# Your brief", "", "Review the orientation's analysis and its drafted cards, then write your report.", "",
             "## What the orientation wrote about its analysis", "", account.strip() or "(nothing)", "",
             "## The drafted cards, the group Orientation, in reading order", ""]
    cards = _deck_cards(ws)
    for i, c in enumerate(cards, 1):
        parts.append(f"{i}. card:{c['id']} ({c['kind']}) {c['title']}\n   takeaway: {c.get('takeaway') or '(none)'}")
    if not cards:
        parts.append("(no cards yet)")
    unnamed, total = unnamed_files(ws, chat, folder)
    parts += ["", "## What code found", ""]
    if unnamed:
        shown = unnamed[:UNNAMED_SHOWN]
        parts.append(f"No Read call and no code of the orientation named {len(unnamed)} of the folder's {total} files, "
                     "so it may never have opened them (code finds candidates: a search or a listing may have read "
                     "them):")
        parts += [f"- {f}" for f in shown]
        if len(unnamed) > len(shown):
            parts.append(f"- and {len(unnamed) - len(shown)} more")
    else:
        parts.append(f"Every one of the folder's {total} files is named by a Read call or by code of the orientation.")
    parts += ["", "## The orientation's transcript", "", transcript(ws, chat) or "(empty)", "",
              "## The analyst's chat", "", _chat_text(ws, "main") or "(the analyst has not written in the chat)"]
    return "\n".join(parts)


def _chat_text(ws: str, chat: str) -> str:
    out: list[str] = []
    for r in chats.records(ws, chat):
        if r.get("type") == "user":
            out.append(f"[analyst] {r.get('text')}")
        elif r.get("type") == "text":
            if out and out[-1].startswith("[claude] "):
                out[-1] += r.get("delta") or ""
            else:
                out.append("[claude] " + (r.get("delta") or ""))
    text = "\n".join(out)
    return text if len(text) <= CHAT_CHARS else text[-CHAT_CHARS:]


def _last_text(ws: str, chat: str) -> str:
    for msg in reversed(load_messages(ws, chat)):
        if msg.get("role") == "assistant":
            text = "".join(b.get("text", "") for b in msg.get("content") or [] if b.get("type") == "text").strip()
            if text:
                return text
    return ""


def _set_paused(ws: str, chat: str, paused: str | None) -> None:
    m = chats.meta(ws, chat)
    if paused:
        m["paused"] = paused
    else:
        m.pop("paused", None)
    chats.save_meta(ws, m)
    hub.publish(ws, {"type": "chat", "chat": chat})


async def t_critique(t: tools.Tools, args: dict[str, Any]) -> tools.Result:
    s = t.session
    if s is None or s.role != ROLE or s.manager is None:
        return tools.Result("only the orientation asks for a critique", True)
    ws, chat = t.ws, t.chat
    brief = critic_brief(ws, chat, str(args.get("context") or ""), t.folder)
    cid = "c" + secrets.token_hex(4)
    m = chats.new_meta(cid, kind="agent", title=CRITIC_TITLE, parent=chat)
    m.update(role="step", agent=CRITIC, agent_type=CRITIC_TYPE, status="running")
    chats.save_meta(ws, m)
    chats.append(ws, chat, {"type": "agent", "chat": cid, "role": "step", "title": CRITIC_TITLE})
    _set_paused(ws, chat, "critique")
    critic = s.manager.get(ws, cid)
    try:
        await critic.send(brief, shown="Review the orientation's analysis and its drafted cards.")
        if critic.task is not None:
            await asyncio.wait({critic.task})
    except asyncio.CancelledError:
        await critic.interrupt()
        raise
    finally:
        _set_paused(ws, chat, None)
    status = chats.meta(ws, cid).get("status")
    report = _last_text(ws, cid)
    if status != "done" or not report:
        why = {"stopped": "the analyst stopped it"}.get(str(status), "it failed")
        return tools.Result(f"The critic could not finish ({why}). Revise without its review, and say so in your last "
                            "message.", True)
    return tools.Result(f"The critic's report:\n\n{report}")


def _critic_finished(session: agent.Session, result: str | None) -> None:
    status = {None: "done", "stopped": "stopped"}.get(result, "failed")
    m = chats.meta(session.ws, session.chat)
    m.update(status=status, ts_end=home.now())
    if status == "stopped":
        m["stopped_by"] = "analyst"
    chats.save_meta(session.ws, m)
    hub.publish(session.ws, {"type": "chat", "chat": session.chat})


# ---- main's tools

async def t_start_orientation(t: tools.Tools, args: dict[str, Any]) -> tools.Result:
    s = t.session
    if s is None or s.manager is None:
        return tools.Result("this agent cannot start an orientation", True)
    got = await start(t.ws, s.manager, str(args.get("brief") or ""), by="typed")
    if got.get("kind") == "busy":
        return tools.Result("An orientation is running already, so none started. Pass the request on with "
                            "message_orientation, or wait until it ends.", True)
    return tools.Result("The orientation started. It works on its own, beside you, and leaves its cards in the group "
                        "Orientation; thimble shows its thread. Answer what you can yourself meanwhile, and say no "
                        "more about it than that it started.")


async def t_message_orientation(t: tools.Tools, args: dict[str, Any]) -> tools.Result:
    s = t.session
    if s is None or s.manager is None:
        return tools.Result("this agent cannot message the orientation", True)
    try:
        got = await message(t.ws, s.manager, str(args.get("message") or ""), by="main")
    except (ValueError, LookupError) as e:
        return tools.Result(str(e), True)
    return tools.Result("Passed on to the orientation" + (", which reads it when its current run ends." if
                                                         got.get("queued") else ". It answers in its thread."))


# ---- registration

def _orient_prompt(folder: Path) -> str:
    return prompts.render("browser/orient.md", {"workdir": str(folder)})


def _critic_prompt(folder: Path) -> str:
    return prompts.render("browser/critic.md", {"workdir": str(folder)})


AGENTS[ROLE] = AgentDef(_orient_prompt, ORIENT_TOOLS, finished=_finished, group=DECK, call_refs=True)
AGENTS[CRITIC] = AgentDef(_critic_prompt, CRITIC_TOOLS, finished=_critic_finished, effort="xhigh", call_refs=True)
tools.register("critique", t_critique)
tools.register("start_orientation", t_start_orientation)
tools.register("message_orientation", t_message_orientation)


SERVER_STOPPED = "server"  # stopped_by of a run the server's stop ended


def recover(ws: str) -> None:
    """The orientation's chats and its critics' a server that stopped left running end `stopped`; a message continues
    the orientation."""
    for m in chats.listing(ws, set()):
        if m.get("status") == "running" and (m.get("role") == ROLE or m.get("agent") == CRITIC):
            m = chats.meta(ws, m["id"])
            m.update(status="stopped", stopped_by=SERVER_STOPPED, ts_end=home.now())
            m.pop("paused", None)
            for u in m.get("followups") or []:
                if u.get("status") == "running":
                    u.update(status="stopped", ended=home.now())
            chats.save_meta(ws, m)
    run = read_run(ws)
    if run.get("status") in RUNNING:
        _write_run(ws, {**run, "status": "stopped", "ended": home.now(), "pending": []})
        try:
            m = chats.meta(ws, "main")
            m["orientation"] = "stopped"
            chats.save_meta(ws, m)
        except KeyError:
            pass


def register(ctx: Any) -> None:
    for w in home.list_workspaces():
        try:
            recover(w["name"])
        except Exception:  # noqa: BLE001
            log.exception("could not end the orientation left running in %s", w["name"])
    main = AGENTS["main"]
    main.tools = main.tools + tuple(n for n in MAIN_TOOLS if n not in main.tools)
    app, sessions = ctx.app, ctx.sessions

    @app.get("/api/ws/{c}/orientation")
    def orientation(c: str) -> dict[str, Any]:
        ctx.ws_of(c)
        return read_run(c)

    @app.post("/api/ws/{c}/orientation")
    async def orientation_start(c: str, body: dict = Body(default={})) -> dict[str, Any]:
        ctx.ws_of(c)
        got = await start(c, sessions, str(body.get("brief") or body.get("text") or ""), by="click")
        if got.get("kind") == "busy":
            raise HTTPException(409, got["reason"])
        return got

    @app.post("/api/ws/{c}/orientation/message")
    async def orientation_message(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        try:
            return await message(c, sessions, str(body.get("text") or ""))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        except LookupError as e:
            raise HTTPException(409, str(e)) from None
