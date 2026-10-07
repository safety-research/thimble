"""Side threads as forks of the analyst's Claude Code session.

A thread starts in the browser from a ⌘-click or ⌘-drag (agents.new_thread); its meta keeps the anchor (ref, visible
text, surface, selector, and a PNG under `anchors/`). Each message typed in it is a browser event of kind `thread`
(`event`) naming the thread and its card group `thread:<id>`; the first one carries the anchor and what its refs
hold.
Main answers by forking with description and prompt `thread:<name>`, the thread's fork name (fork_name: its first
question as a slug, which Claude Code's agent tray shows; in terminal mode thimble-term gives the call the question as its
description, so the fork is known by its prompt, fork_ref; the event's line in main's terminal names the thread by its
first question, line_name);
the mirror (session.py) matches the fork's transcript, copies its tool calls and its text into the thread's chat, with
the messages the analyst typed to it in Claude Code's agent view and those main sent it for a question typed in the
terminal, and calls fork_finished when it stops. The fork replies with `reply_in_thread` or its text.

A fork lives only as long as its session: after that, the next event forks anew and carries the earlier turns. A
message typed while the first event waits for its fork is queued (`queued`) and sent once the fork is known (flush)."""
from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import re
import secrets
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import agents, cite, config

log = logging.getLogger("thimble.threads")

ANCHOR_TEXT_CHARS = agents.ANCHOR_TEXT_CHARS  # of what the element showed, cut when the thread is made
CONTENT_CHARS = 4_000  # of what the anchor's refs hold, all refs together
IMAGE_DIR = "anchors"
IMAGE_MAX_BYTES = 8 * 1024 * 1024
FORK_DESCRIPTION_RE = re.compile(r"^\s*thread:([A-Za-z0-9_-]{1,64})\s*$")
THREAD_REF_RE = re.compile(r"^thread:([A-Za-z0-9_-]{1,64})$")
CHIP_KIND = "thread"
CHIP_CHARS = 120
FORK_NAME_KEY = "fork_name"  # on a thread's meta: the name its forks run under (fork_name)
FORK_NAME_CHARS = 24  # of a fork's name, which Claude Code's agent tray shows whole up to about 27 characters
FORK_NAME_FALLBACK = "thread"
RESERVED_NAMES = ("main", "team-lead", "user", "system")  # names Claude Code's Agent tool refuses for an agent
WARM_S = 20.0  # the longest wait for the anchor's view refs to resolve before a thread's first event (warm)
WARM_MAX = 8  # the anchor's refs resolved that way
EARLIER_CHARS = 3_000  # of the thread's earlier turns, the newest kept, on the event that forks it anew
QUEUED_KEY = "queued"  # the meta's messages waiting for the thread's fork (module note)
# why a run ended without a reply the analyst can read: the error record's kind, and its message
SESSION_ENDED, UNANSWERED, FORK_LOST = "session-ended", "unanswered", "fork-lost"
STOP_TEXT = {
    SESSION_ENDED: "The Claude Code session ended before this thread finished",
    UNANSWERED: "Main's turn ended without answering in this thread",
    FORK_LOST: "The thread's fork could not be reached",
}
STOP_KINDS = (SESSION_ENDED, UNANSWERED, FORK_LOST, "failed", "stopped")
_DATA_URL_RE = re.compile(r"^data:image/png;base64,(.+)$", re.S)
_CHAT_REF_RE = re.compile(r"^chat:([A-Za-z0-9_-]{1,64})#(\d+)$")
# (workspace, thread) -> the session a forkless event of the thread went to, until its fork is known (module note)
_awaiting: dict[tuple[str, str], str | None] = {}
_moved: dict[tuple[str, str], str] = {}  # (workspace, thread) -> the session its fork moved from (fork_moved)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def thread_of(description: Any) -> str | None:
    """The thread id an Agent call's description names (`thread:<id>`), else None."""
    m = FORK_DESCRIPTION_RE.match(str(description or ""))
    return m.group(1) if m else None


def fork_ref(tool_input: Any) -> str | None:
    """The `thread:<name>` an Agent call for a thread's fork carries: its description, else its prompt, else None. Main
    writes `thread:<name>` as both (prompts/main.md); in terminal mode thimble-term gives the call the thread's
    question as its description before it runs, so that Claude Code's agent tray and exit dialog name the thread by its
    question (subagent_files.fork_ref)."""
    if not isinstance(tool_input, dict):
        return None
    for key in ("description", "prompt"):
        value = str(tool_input.get(key) or "")
        if FORK_DESCRIPTION_RE.match(value):
            return value.strip()
    return None


def slug(title: str) -> str:
    """A title as a fork name: its words in lower case joined by '-', cut at FORK_NAME_CHARS. Claude Code's Agent takes
    a name only in ASCII, so accents are dropped and words in other scripts left out."""
    plain = unicodedata.normalize("NFKD", str(title or "")).encode("ascii", "ignore").decode()
    words = re.findall(r"[a-z0-9]+", plain.lower())
    out = ""
    for w in words:
        nxt = f"{out}-{w}" if out else w
        if len(nxt) > FORK_NAME_CHARS:
            break
        out = nxt
    out = out or FORK_NAME_FALLBACK
    return f"{out}-{FORK_NAME_FALLBACK}" if out in RESERVED_NAMES or re.fullmatch(r"a[0-9a-f]{16}", out) else out


def fork_name(c: str, meta: dict, question: str = "") -> str:
    """The name the thread's next fork runs under, which Claude Code's agent tray and exit dialog show: the name it has
    (FORK_NAME_KEY), else its first question as a slug (`question` when its log holds none yet), else its title as one,
    with -2, -3 … when another thread's forks run under that name, kept on the meta."""
    taken = {str(m.get(FORK_NAME_KEY)) for m in agents.list_chats(c)
             if m.get("kind") == agents.KIND_THREAD and m.get("id") != meta.get("id") and m.get(FORK_NAME_KEY)}
    kept = str(meta.get(FORK_NAME_KEY) or "")
    if kept and kept not in taken:
        return kept
    first = first_question(c, str(meta.get("id") or "")) or " ".join(str(question or "").split())
    base = slug(first) if first and slug(first) != FORK_NAME_FALLBACK else slug(str(meta.get("title") or ""))
    name, n = base, 2
    while name in taken:
        name, n = f"{base}-{n}", n + 1
    if meta.get(FORK_NAME_KEY) != name:
        agents.update_agent(c, str(meta["id"]), **{FORK_NAME_KEY: name})
    return name


def by_fork_name(c: str, name: str) -> str | None:
    """The thread whose forks run under `name`, else None."""
    low = str(name or "").strip().lower()
    if not low:
        return None
    for m in agents.list_chats(c):
        if m.get("kind") == agents.KIND_THREAD and str(m.get(FORK_NAME_KEY) or "").lower() == low:
            return str(m["id"])
    return None


def first_question(c: str, thread_id: str) -> str:
    """The thread's first question on one line, '' while its log holds none (or for no thread)."""
    if not thread_id or agents.meta_or_none(c, thread_id) is None:
        return ""
    for r in agents.read_events(agents.paths(c, thread_id)[1]):
        if r.get("type") == "user" and str(r.get("text") or "").strip():
            return " ".join(str(r["text"]).split())
    return ""


def is_thread(c: str, chat_id: str | None) -> bool:
    meta = agents.meta_or_none(c, chat_id) if chat_id else None
    return bool(meta and meta.get("kind") == agents.KIND_THREAD)


def group_ref(thread_id: str) -> str:
    """The `group` a thread's event names for its cards, `thread:<id>`, resolved by the card tools to the thread's
    canvas
    group (group_of), made with its first card."""
    return f"thread:{thread_id}"


def group_of(c: str, ref: str, *, make: bool = True) -> str | None:
    """The canvas group (a notebook id) of the thread a `thread:<id>` ref names (agents.group_for), made now when it has
    none and `make`; None when the ref names no thread, or the thread has no group and `make` is false."""
    m = THREAD_REF_RE.match(str(ref or "").strip())
    meta = agents.meta_or_none(c, m.group(1)) if m else None
    if meta is None or meta.get("kind") != agents.KIND_THREAD:
        return None
    if not make:
        from . import notebook  # noqa: PLC0415

        gid = str(meta.get("group") or "")
        return gid if gid and notebook.read_notebook(config.workspace_dir(c), gid) is not None else None
    return agents.group_for(c, meta)


# --------------------------------------------------------------------------- the anchor


def save_image(c: str, thread_id: str, data_url: str | None) -> str | None:
    """Write the PNG the browser captured at the click (a `data:image/png;base64,` URL) as anchors/<thread>.png under
    the workspace; its absolute path, or None when there is none or it is not a PNG."""
    m = _DATA_URL_RE.match(str(data_url or "").strip())
    if not m:
        return None
    try:
        data = base64.b64decode(m.group(1), validate=False)
    except (binascii.Error, ValueError):
        return None
    if not data.startswith(b"\x89PNG") or len(data) > IMAGE_MAX_BYTES:
        return None
    d = config.workspace_dir(c) / IMAGE_DIR
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{thread_id}.png"
    path.write_bytes(data)
    return str(path)


def _anchors(meta: dict) -> list[str]:
    return [a.strip() for a in str(meta.get("anchor") or "").split(",") if a.strip()]


def _read(c: str, ref: str) -> str:
    """What read_ref returns for one ref, without its call line; a line saying why when it does not resolve."""
    from . import refs, tools  # noqa: PLC0415

    try:
        if m := _CHAT_REF_RE.match(ref):
            return _chat_record(c, m.group(1), int(m.group(2)))
        if ref.startswith(("card:", "cell:")):
            res = tools._read_cell(tools.Ctx(c, tools.ANALYST), "card:" + ref.split(":", 1)[1])
            return res.text
        hit = refs.resolve(config.corpus_dir(c), ref)
        return f"{ref} ({hit.get('kind', 'record')})\n{str(hit.get('excerpt') or '').strip()}"
    except Exception as e:  # noqa: BLE001 — a ref that does not resolve still opens the thread
        detail = getattr(e, "detail", None) or f"{type(e).__name__}: {e}"
        return f"{ref} does not resolve: {detail}"


def _chat_record(c: str, chat_id: str, index: int) -> str:
    """One record of a chat's log as the thread's anchor content: a message's text, or a call with its result."""
    records = agents.read_events(agents.paths(c, chat_id)[1])
    rec = records[index] if 0 <= index < len(records) else None
    ref = f"chat:{chat_id}#{index}"
    if rec is None:
        return f"{ref} does not resolve: the chat has no record {index}"
    if rec.get("type") == "user":
        return f"{ref} (a message to the session)\n{str(rec.get('text') or '').strip()}"
    if rec.get("type") == "text":
        return f"{ref} (a reply)\n{str(rec.get('delta') or '').strip()}"
    if rec.get("type") == "tool_use":
        result = next((r for r in records[index + 1:] if r.get("type") == "tool_result" and r.get("id") == rec.get("id")), {})
        return f"{ref} (a call of {rec.get('name')})\n{rec.get('input')}\n{str(result.get('summary') or '').strip()}".strip()
    return f"{ref} ({rec.get('type')})\n{str(rec.get('text') or rec.get('message') or '').strip()}".strip()


async def warm(c: str, meta: dict) -> None:
    """Resolve the anchor's view refs once in a worker thread, so the thread's first event, built on the server's loop,
    finds them in the views memo (views.resolve_sync cannot run a reader on that loop). Waits WARM_S at most."""
    from . import refs  # noqa: PLC0415

    wanted = [a for a in _anchors(meta) if a.startswith("view:") or _file_ref(a) and "#" in a]
    if not wanted:
        return
    corpus = config.corpus_dir(c)

    async def one(ref: str) -> None:
        try:
            await asyncio.to_thread(refs.resolve, corpus, ref)
        except Exception:  # noqa: BLE001 — _read says why a ref does not resolve
            return

    try:
        await asyncio.wait_for(asyncio.gather(*(one(r) for r in wanted[:WARM_MAX])), WARM_S)
    except asyncio.TimeoutError:
        log.info("%s: the anchor %s did not resolve within %.0f s", c, meta.get("anchor"), WARM_S)


def content(c: str, meta: dict) -> str:
    """What the anchor's refs hold, each cut to an equal share of CONTENT_CHARS."""
    anchors = [a for a in _anchors(meta) if not a.startswith("ui:")]
    if not anchors:
        return ""
    share = max(400, CONTENT_CHARS // len(anchors))
    parts: list[str] = []
    for ref in anchors:
        text = _read(c, ref).strip()
        parts.append(text if len(text) <= share else text[:share].rstrip() + "\n…")
    out = "\n\n".join(parts)
    return out if len(out) <= CONTENT_CHARS else out[:CONTENT_CHARS].rstrip() + "\n…"


def _line(key: str, value: Any) -> str | None:
    s = str(value or "").strip()
    if not s:
        return None
    return f"{key}:\n{s}" if "\n" in s else f"{key}: {s}"


# --------------------------------------------------------------------------- the event


def _session_id(c: str) -> str | None:
    from . import session  # noqa: PLC0415

    lv = session.current(c)
    return lv.sid if lv is not None else None


def event(c: str, payload: dict[str, Any], event_id: str) -> tuple[str, dict[str, Any], str] | None:
    """events.post's builder for kind `thread`: (body, attributes, thread id), or None when the message waits for the
    thread's fork (module note). The question is logged in the thread's chat and the thread is marked running until its
    fork stops."""
    thread_id = str(payload.get("thread") or "").strip()
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "empty message")
    meta = agents.read_meta(c, thread_id)
    if meta.get("kind") != agents.KIND_THREAD:
        raise HTTPException(400, f"{thread_id} is not a thread")
    _, log_path = agents.paths(c, thread_id)
    by = agents.TERMINAL if payload.get("by") == agents.TERMINAL else agents.BROWSER  # message_thread's, from the terminal
    agents.append(log_path, {"type": "user", "ts": _now(), "text": text, "by": by, "event": event_id})
    waits = awaiting_fork(c, thread_id)
    agents.set_running(c, thread_id, True)
    if waits:
        entry = {"text": text, "event": event_id, "ts": _now()}
        # appended to the list as the meta holds it now, under its lock (agents.change_meta)
        meta = agents.change_meta(c, thread_id, lambda m: m.update({QUEUED_KEY: [*(m.get(QUEUED_KEY) or []), entry]}))
        agents._notify(c, thread_id)
        log.info("%s: thread %s: a message waits for its fork (%d queued)", c, thread_id, len(meta[QUEUED_KEY]))
        return None
    return build(c, thread_id, [text])


def build(c: str, thread_id: str, questions: list[str]) -> tuple[str, dict[str, Any], str]:
    """The event that asks the thread's questions: to its fork when it has one in the session that is main, else to
    main to fork anew, with the anchor, what its refs hold and the thread's earlier turns."""
    meta = agents.read_meta(c, thread_id)
    group = group_ref(thread_id)
    fork = _live_fork(c, meta)
    lines = [_line("question", "\n\n".join(q.strip() for q in questions if q.strip()))]
    if not fork.get("agent_id"):
        lines += [
            _line("ref", meta.get("anchor")),
            _line("surface", meta.get("anchor_surface")),
            _line("element", meta.get("anchor_element")),
            _line("selector", meta.get("anchor_selector")),
            _line("text", meta.get("anchor_text")),
            _line("image", meta.get("anchor_image")),
            _line("content", content(c, meta)),
            _line("earlier", earlier(c, thread_id, len(questions))),
        ]
        _awaiting[(c, thread_id)] = _session_id(c)
    fields: dict[str, Any] = {"thread": thread_id, "group": group,
                              "name": (fork.get("agent_id") and meta.get(FORK_NAME_KEY))
                              or fork_name(c, meta, questions[0] if questions else "")}
    if fork.get("agent_id"):
        fields["agent"] = fork["agent_id"]
    log.info("%s: thread %s asks %s (%d question%s)", c, thread_id, f"its fork {fork['agent_id']}" if fork.get("agent_id")
             else "main to fork", len(questions), "" if len(questions) == 1 else "s")
    return cite.canon_text("\n".join(ln for ln in lines if ln)), fields, thread_id


LINE_NAME_CHARS = 40  # of the first question that names a thread in main's terminal (line_name)


def line_name(c: str, thread_id: str, questions: list[str]) -> str:
    """What names the thread in its event's line in main's terminal (events.terminal_line): its first question in
    quotation marks, cut at LINE_NAME_CHARS; '' when the questions asked are its first, which the line shows whole
    (`› new thread: …`). Never the fork's name, which is a slug."""
    records = agents.read_events(agents.paths(c, thread_id)[1])
    first = next((" ".join(str(r.get("text") or "").split()) for r in records
                  if r.get("type") == "user" and str(r.get("text") or "").strip()), "")
    asked = " ".join(" ".join(questions).split())
    if not first or asked.startswith(first):
        return ""
    if len(first) > LINE_NAME_CHARS:
        cut = first[: LINE_NAME_CHARS - 1]
        word = cut.rsplit(" ", 1)[0]
        first = (word if len(word) > LINE_NAME_CHARS // 2 else cut).rstrip(" ,;:.") + "…"
    return f'"{first}"'


def earlier(c: str, thread_id: str, asking: int = 1) -> str:
    """The thread's turns before the `asking` questions at the end of its log, as `analyst:` and `reply:` lines, cut to
    the newest EARLIER_CHARS; empty when there were none (a first question)."""
    records = agents.read_events(agents.paths(c, thread_id)[1])
    users = [i for i, r in enumerate(records) if r.get("type") == "user"]
    if len(users) <= asking:
        return ""
    cut = users[-asking] if asking else len(records)
    lines: list[str] = []
    for r in records[:cut]:
        if r.get("type") == "user" and str(r.get("text") or "").strip():
            lines.append("analyst: " + " ".join(str(r["text"]).split()))
        elif r.get("type") == "text" and r.get("reply") and str(r.get("delta") or "").strip():
            lines.append("reply: " + " ".join(str(r["delta"]).split()))
    out = "\n".join(lines)
    return out if len(out) <= EARLIER_CHARS else "…" + out[-EARLIER_CHARS:].lstrip()


def awaiting_fork(c: str, thread_id: str) -> bool:
    """Whether an event of the thread went to main to fork, in the session that is main now, and its fork is not known
    yet: a message typed meanwhile waits (module note)."""
    key = (c, thread_id)
    return key in _awaiting and _awaiting[key] == _session_id(c) and agents.running(c, thread_id)


def flush(c: str, thread_id: str) -> bool:
    """Send the messages queued while the thread waited for its fork, to the fork when it is known, else to main to
    fork anew; False when none wait or no session listens (they stay queued, and ask_again sends them)."""
    from . import events  # noqa: PLC0415

    meta = agents.meta_or_none(c, thread_id)
    if not (meta or {}).get(QUEUED_KEY) or not events.reachable(c):
        return False
    taken: list[Any] = []

    def take(m: dict) -> None:  # the list as the meta holds it now, emptied under its lock (agents.change_meta)
        taken.extend(m.get(QUEUED_KEY) or [])
        m[QUEUED_KEY] = []

    agents.change_meta(c, thread_id, take)
    agents._notify(c, thread_id)
    queued = [q for q in taken if isinstance(q, dict) and str(q.get("text") or "").strip()]
    if not queued:
        return False
    questions = [str(q["text"]) for q in queued]
    body, fields, _ = build(c, thread_id, questions)
    events.send(c, events.THREAD, body, fields, thread=thread_id,
                 line=events.terminal_line(events.THREAD, " ".join(questions), {"name": line_name(c, thread_id, questions)}))
    agents.set_running(c, thread_id, True)
    return True


def unanswered(c: str, thread_id: str) -> list[str]:
    """The analyst's questions after the thread's last reply or finished run; the last question when every one was
    answered."""
    records = agents.read_events(agents.paths(c, thread_id)[1])
    last = max((i for i, r in enumerate(records) if r.get("type") == "done" or (r.get("type") == "text" and r.get("reply"))),
               default=-1)
    after = [str(r.get("text") or "") for r in records[last + 1:] if r.get("type") == "user" and str(r.get("text") or "").strip()]
    if after:
        return after
    asked = [str(r.get("text") or "") for r in records if r.get("type") == "user" and str(r.get("text") or "").strip()]
    return asked[-1:]


def ask_again(c: str, thread_id: str, *, hand: bool = False) -> dict[str, Any]:
    """Send the thread's unanswered questions to the session again, with no new line in the thread (the `again`
    record marks it for the export); with `hand`, the event is returned as `text` for a tool's result instead
    (events.hand). 400 for a chat that is no thread or has no question, 409 when the thread is working or no session
    listens."""
    from . import events  # noqa: PLC0415

    meta = agents.read_meta(c, thread_id)
    if meta.get("kind") != agents.KIND_THREAD:
        raise HTTPException(400, f"{thread_id} is not a thread")
    if agents.running(c, thread_id):
        raise HTTPException(409, "the thread is working; its reply comes in the thread")
    questions = unanswered(c, thread_id)
    if not questions:
        raise HTTPException(400, "the thread has no question to ask again")
    if not events.reachable(c):
        raise HTTPException(409, events.NOT_LISTENING.format(cwd=config.corpus_dir(c)))
    agents.update_agent(c, thread_id, **{QUEUED_KEY: []})
    body, fields, _ = build(c, thread_id, questions)
    if hand:
        event_id = secrets.token_hex(4)
        out = {"text": events.hand(c, event_id, body, fields, thread=thread_id)}
    else:
        posted = events.send(c, events.THREAD, body, fields, thread=thread_id,
                              line=events.terminal_line(events.THREAD, " ".join(questions), {"name": line_name(c, thread_id, questions)}))
        event_id, out = posted["id"], {}
    _, log_path = agents.paths(c, thread_id)
    agents.append(log_path, {"type": "again", "ts": _now(), "event": event_id, "questions": len(questions)})
    agents.set_running(c, thread_id, True)
    return {"asked": thread_id, "event": event_id, "questions": len(questions), **out}


# --------------------------------------------------------------------------- the fork, as the mirror sees it


def _live_fork(c: str, meta: dict) -> dict:
    """The thread's fork when it runs in the session that is main now and was not lost, else {} (the next event forks
    anew)."""
    from . import session  # noqa: PLC0415

    fork = meta.get("fork") or {}
    lv = session.current(c)
    live = fork.get("agent_id") and not fork.get("ended") and lv is not None and fork.get("session") == lv.sid
    return fork if live else {}


def fork_started(c: str, thread_id: str, *, agent_id: str | None = None, tool_use_id: str | None = None,
                 session: str | None = None) -> None:
    """The mirror found the thread's fork: its agent id, the Agent call that started it and its session are recorded,
    and
    messages that waited for it are flushed."""
    meta = agents.meta_or_none(c, thread_id)
    if meta is None:
        return
    fork = dict(meta.get("fork") or {})
    changed = False
    if (session and fork.get("session") not in (None, session)) or fork.get("ended"):
        fork, changed = {}, True
    for k, v in (("agent_id", agent_id), ("tool_use_id", tool_use_id), ("session", session)):
        if v and fork.get(k) != v:
            fork[k] = v
            changed = True
    if changed:
        agents.update_agent(c, thread_id, fork=fork)
        log.info("%s: thread %s forked (agent %s, session %s)", c, thread_id, fork.get("agent_id") or "?", fork.get("session"))
    agents.set_running(c, thread_id, True)
    if fork.get("agent_id"):
        _awaiting.pop((c, thread_id), None)
        flush(c, thread_id)


def replied_since_question(c: str, thread_id: str) -> bool:
    """Whether a reply follows the analyst's last question in the thread's chat."""
    _, log_path = agents.paths(c, thread_id)
    records = agents.read_events(log_path)
    last_user = max((i for i, r in enumerate(records) if r.get("type") == "user"), default=-1)
    return any(r.get("type") == "text" and r.get("reply") for r in records[last_user + 1:])


def _stop(c: str, thread_id: str, kind: str, detail: str | None = None) -> None:
    """Say in the thread why its run ended without a reply the analyst can read (STOP_TEXT)."""
    _, log_path = agents.paths(c, thread_id)
    rec = {"type": "error", "ts": _now(), "message": STOP_TEXT.get(kind, kind), "kind": kind}
    if detail:
        rec["detail"] = detail
    agents.append(log_path, rec)
    log.info("%s: thread %s stopped (%s)", c, thread_id, kind)


def fork_finished(c: str, thread_id: str, status: str = "done", *, kind: str | None = None,
                  tool_use_id: str | None = None, agent_id: str | None = None, refused: bool = False) -> None:
    """The fork stopped: the thread stops running, the run ends in its chat with `done` or why it did not finish, and a
    run with no reply leaves a chip in main pointing at the anchor. Waiting messages go to the fork now.

    The end of an Agent call that never ran (`refused`: a hook denied it, such as fork_check's second fork of a thread)
    or that is not the thread's fork (its `tool_use_id` and `agent_id` are not those the meta's fork records) changes
    nothing: the thread's own fork answers it. A failure after the thread replied to its last question leaves the
    answer as it is."""
    from . import subagents  # noqa: PLC0415 — subagents imports session, which imports this module

    meta = agents.meta_or_none(c, thread_id)
    fork = (meta or {}).get("fork") or {}
    if refused:
        log.info("%s: thread %s: an Agent call that did not run (%s) leaves the thread as it is", c, thread_id,
                 tool_use_id or "?")
        return
    if (tool_use_id and fork.get("tool_use_id") and fork["tool_use_id"] != tool_use_id
            and not (agent_id and fork.get("agent_id") == agent_id)):
        log.info("%s: thread %s: the end of call %s, which is not its fork's (%s), leaves the thread as it is", c,
                 thread_id, tool_use_id, fork["tool_use_id"])
        return
    agents.set_running(c, thread_id, False)
    _awaiting.pop((c, thread_id), None)
    subagents.fork_ended(c, thread_id)
    if meta is None:
        return
    _, log_path = agents.paths(c, thread_id)
    if status in ("done", "completed"):
        if not replied_since_question(c, thread_id):
            question = next((str(r.get("text") or "") for r in reversed(agents.read_events(log_path)) if r.get("type") == "user"), "")
            anchors = _anchors(meta)
            agents.chip(c, CHIP_KIND, " ".join(question.split())[:CHIP_CHARS] or str(meta.get("title") or thread_id),
                        ref=anchors[0] if anchors else None, chat=thread_id)
        agents.append(log_path, {"type": "done", "ts": _now(), "result": None})
        log.info("%s: thread %s: its fork finished", c, thread_id)
    elif kind and replied_since_question(c, thread_id):
        # the fork had answered and was still at work when it was cut: the answer stands, and nothing asks again
        agents.append(log_path, {"type": "done", "ts": _now(), "result": None})
        log.info("%s: thread %s: its fork was cut after its reply (%s)", c, thread_id, kind)
    elif kind:
        _stop(c, thread_id, kind)
    elif replied_since_question(c, thread_id):
        # the fork answered and then failed: the answer stands, and the run ends as done
        agents.append(log_path, {"type": "done", "ts": _now(), "result": None})
        log.info("%s: thread %s: its fork ended %s after its reply", c, thread_id, status)
    else:
        agents.append(log_path, {"type": "error", "ts": _now(), "message": status, "kind": status})
        log.info("%s: thread %s: its fork ended %s", c, thread_id, status)
    if kind != SESSION_ENDED:
        flush(c, thread_id)
    agents.notify(c, thread_id)


def released(c: str, thread_id: str) -> None:
    """Main's turn took the thread's event and ended without forking it or messaging its fork: the messages that waited
    go out as a new event, or else the thread stops running, saying so when nothing answered it."""
    _awaiting.pop((c, thread_id), None)
    if flush(c, thread_id):
        return
    agents.set_running(c, thread_id, False)
    if agents.meta_or_none(c, thread_id) is not None and not replied_since_question(c, thread_id):
        _stop(c, thread_id, UNANSWERED)
        agents.notify(c, thread_id)


def fork_lost(c: str, thread_id: str) -> None:
    """Main's message to the thread's fork failed (a fork of a session that ended in the same process): the fork is
    forgotten, so the next event forks anew."""
    meta = agents.meta_or_none(c, thread_id)
    if meta is None:
        return
    fork = dict(meta.get("fork") or {})
    if fork and not fork.get("ended"):
        fork["ended"] = _now()
        agents.update_agent(c, thread_id, fork=fork)
    log.info("%s: thread %s: its fork %s could not be reached", c, thread_id, fork.get("agent_id"))


def fork_moved(c: str, thread_id: str, old: str, new: str) -> None:
    """Main's session `old` continues in session `new`, which runs the thread's fork on (session._continue): the fork,
    and an event of the thread that waits for one, are the new session's, so session_ended(old) leaves the thread
    running and its next event goes to the fork (_live_fork)."""
    meta = agents.meta_or_none(c, thread_id)
    fork = dict((meta or {}).get("fork") or {})
    if fork.get("session") == old and not fork.get("ended"):
        fork["session"] = new
        agents.update_agent(c, thread_id, fork=fork)
    if (c, thread_id) in _awaiting and _awaiting[(c, thread_id)] == old:
        _awaiting[(c, thread_id)] = new
    _moved[(c, thread_id)] = old


def awaiting_in(c: str, sid: str) -> set[str]:
    """The threads whose event went to main to fork in session `sid` and wait for their fork (awaiting_fork)."""
    return {tid for (cc, tid), s in _awaiting.items() if cc == c and s == sid}


def session_ended(c: str, sid: str) -> None:
    """The session `sid` is no longer main: every thread's fork in it is gone, so its next event forks anew; a thread
    still marked running (an event that waited for its fork, or a queued message) stops and says why. A thread whose
    fork went on in another session (fork_moved) is left alone."""
    for meta in agents.list_chats(c):
        if meta.get("kind") != agents.KIND_THREAD:
            continue
        tid = str(meta["id"])
        if _moved.pop((c, tid), None) == sid:
            continue
        fork = dict(meta.get("fork") or {})
        if fork.get("session") == sid and not fork.get("ended"):
            fork["ended"] = _now()
            agents.update_agent(c, tid, fork=fork)
        if (c, tid) in _awaiting and _awaiting[(c, tid)] in (sid, None):
            _awaiting.pop((c, tid), None)
        if fork.get("session") == sid:
            # its fork is gone, so a new Agent call may fork it again at once, also when --continue resumes the session
            # under the same id (fork_check)
            from . import subagents  # noqa: PLC0415 — subagents imports session, which imports this module

            subagents.fork_ended(c, tid)
        if agents.running(c, tid):
            agents.set_running(c, tid, False)
            if meta.get(QUEUED_KEY):
                agents.update_agent(c, tid, **{QUEUED_KEY: []})  # logged already; ask_again sends every unanswered one
            if not replied_since_question(c, tid):
                _stop(c, tid, SESSION_ENDED)
            agents.notify(c, tid)


def reply(c: str, thread_id: str, text: str, *, by: str) -> None:
    """The thread's visible reply: a `text` record marked `reply`, so the fold shows it as the model's message and
    fork_finished knows the run answered."""
    _, log_path = agents.paths(c, thread_id)
    agents.append(log_path, {"type": "text", "delta": cite.from_links(text), "reply": True, "by": by})
    agents.notify(c, thread_id)


SEEN_KEY = "seen"  # on a thread's meta: how many of its log's records the analyst had when they last opened it


def _answers_after(records: list[dict[str, Any]], start: int) -> bool:
    return any(r.get("type") == "done" or (r.get("type") == "text" and r.get("reply")) for r in records[start:])


def unread(c: str, meta: dict[str, Any]) -> bool:
    """Whether the thread has an answer (a reply or a finished run) the analyst has not opened since it came: one in
    its log after the records SEEN_KEY counts. A thread never opened counts from its start. Kept on the meta, so it
    holds across a restart and in both modes."""
    try:
        records = agents.read_events(agents.paths(c, str(meta["id"]))[1])
    except Exception:  # noqa: BLE001 — a thread that cannot be read shows nothing new
        return False
    seen = meta.get(SEEN_KEY)
    return _answers_after(records, seen if isinstance(seen, int) and not isinstance(seen, bool) else 0)


def mark_seen(c: str, thread_id: str) -> int:
    """The analyst opened the thread: every record its log holds now is seen (SEEN_KEY). Returns that count; 404 for a
    chat that does not exist, 400 for one that is no thread."""
    meta = agents.read_meta(c, thread_id)
    if meta.get("kind") != agents.KIND_THREAD:
        raise HTTPException(400, f"{thread_id} is not a thread")
    n = len(agents.read_events(agents.paths(c, thread_id)[1]))
    agents.update_agent(c, thread_id, **{SEEN_KEY: n})
    return n


# --------------------------------------------------------------------------- tools


async def tool_reply_in_thread(ctx: Any, args: dict[str, Any]) -> Any:
    """The `reply_in_thread` tool: the text the analyst reads in the thread."""
    from . import tools  # noqa: PLC0415

    thread_id = str(args.get("thread") or "").strip().removeprefix("thread:")
    text = str(args.get("text") or "").strip()
    if not thread_id:
        return tools.err("reply_in_thread: `thread` is empty; it is the `thread` attribute of the thread's event")
    if not text:
        return tools.err("reply_in_thread: `text` is empty")
    if not is_thread(ctx.c, thread_id):
        thread_id = by_fork_name(ctx.c, thread_id) or thread_id
    if not is_thread(ctx.c, thread_id):
        threads = [m["id"] for m in agents.list_chats(ctx.c) if m.get("kind") == agents.KIND_THREAD]
        return tools.err(f"reply_in_thread: no thread {thread_id!r}; the threads are {', '.join(threads) or '(none)'}")
    reply(ctx.c, thread_id, text, by=ctx.cell_author)
    return tools.ok(f"replied in thread {thread_id}")


# the roles of the agent chats the thread tree lists besides the threads (the frontend's chat/threads.ts threadKind)
LISTED_ROLES = ("orient", "writer", "check", "dev", agents.STEP_ROLE)
_TICKET_PREFIX_RE = re.compile(r"^ticket #\d+:\s*", re.I)


def view_names(chats: list[dict]) -> dict[str, str]:
    """The thread tree's names of a view's builds and reviews, by chat id, as the browser's tree gives them
    (frontend chat/threads.ts): the first build `<view>`, its first review `<view>-review`, each later one the next
    number (`<view>-2`, `<view>-review-2`), so no two share a name (live check L25)."""
    out: dict[str, str] = {}
    seen: dict[str, int] = {}
    for m in sorted((m for m in chats if m.get("role") == "dev" and m.get("view")),
                    key=lambda m: str(m.get("created_at") or "")):
        base = f"{m['view']}-review" if m.get("review") else str(m["view"])
        seen[base] = seen.get(base, 0) + 1
        out[str(m["id"])] = base if seen[base] == 1 else f"{base}-{seen[base]}"
    return out


def _names(meta: dict, views: dict[str, str] | None = None) -> set[str]:
    """What names a chat in the thread tree, lower case: its title, the analyst's name for it, a ticket's slug as
    the tree shows it (group-board-by-round), a view build's or review's tree name (view_names), and a thread's fork
    name."""
    title = str(meta.get("title") or "")
    words = re.findall(r"[^\W_]+", _TICKET_PREFIX_RE.sub("", title))
    view = (views or {}).get(str(meta.get("id"))) or (str(meta.get("view") or "") if meta.get("role") == "dev" else "")
    return {n.lower() for n in (title, str(meta.get("name") or ""), "-".join(words[:4]), view,
                                str(meta.get(FORK_NAME_KEY) or "")) if n.strip()}


def find_threads(c: str, name: str) -> list[dict]:
    """The chats of the thread tree that `name` names: the one with that id (`thread:<id>` too), else each whose name
    matches,
    case aside, whole or as the last path part. Never main."""
    listed = [m for m in agents.list_chats(c)
              if m.get("kind") == agents.KIND_THREAD or (m.get("kind") == agents.KIND_AGENT and m.get("role") in LISTED_ROLES)]
    q = re.sub(r"^(?:thread|chat):", "", " ".join(name.split()))
    by_id = [m for m in listed if m["id"] == q]
    if by_id or not q:
        return by_id
    low = q.lower()
    names = view_names(listed)
    return [m for m in listed if any(low == n or low.endswith(f"/{n}") for n in _names(m, names))]


def _one_thread(c: str, tool: str, name: str) -> tuple[dict | None, str]:
    """(the chat `name` names, '') or (None, why not, listing the threads to choose from)."""
    found = find_threads(c, name)
    if len(found) == 1:
        return found[0], ""
    if found:
        return None, f"{tool}: {name!r} names {len(found)} threads; pass one id: " + ", ".join(
            f"{m['id']} ({m.get('name') or m.get('title')})" for m in found)
    listed = [m for m in agents.list_chats(c) if m.get("kind") == agents.KIND_THREAD
              or (m.get("kind") == agents.KIND_AGENT and m.get("role") in LISTED_ROLES and m.get("role") != agents.STEP_ROLE)]
    return None, f"{tool}: no thread {name!r}; the threads are " + (", ".join(
        f"{m['id']} ({m.get('name') or m.get('title')})" for m in listed) or "(none)")


async def tool_rename_thread(ctx: Any, args: dict[str, Any]) -> Any:
    """The `rename_thread` tool: the thread's name in the browser's thread list (agents.rename_chat)."""
    from . import tools  # noqa: PLC0415

    name = " ".join(str(args.get("name") or "").split())
    if not name:
        return tools.err("rename_thread: `name` is empty")
    meta, why = _one_thread(ctx.c, "rename_thread", str(args.get("thread") or ""))
    if meta is None:
        return tools.err(why)
    agents.rename_chat(ctx.c, meta["id"], name)
    return tools.ok(f"renamed thread {meta['id']} to {name!r}")


async def tool_delete_thread(ctx: Any, args: dict[str, Any]) -> Any:
    """The `delete_thread` tool: the thread and its chat leave the workspace, its session stopped (agents.delete_chat)."""
    from . import tools  # noqa: PLC0415

    meta, why = _one_thread(ctx.c, "delete_thread", str(args.get("thread") or ""))
    if meta is None:
        return tools.err(why)
    ids = await agents.delete_chat(ctx.c, meta["id"])
    steps = f" and its {len(ids) - 1} steps" if len(ids) > 1 else ""
    return tools.ok(f"deleted thread {meta['id']} ({meta.get('name') or meta.get('title')}){steps}")


ORIENT_NAMES = ("orient", "orientation")  # what /thimble:ask takes for the latest orientation, the tree's `orient`


def _ask_target(c: str, name: str) -> tuple[dict | None, str]:
    """The chat /thimble:ask names (_one_thread), where the latest orientation is also `orient` or `orientation`, and
    the builds of one view count as one chat, its latest, since each sends a change to that view."""
    from . import orientation  # noqa: PLC0415

    if " ".join(name.split()).lower() in ORIENT_NAMES:
        chat = ((orientation.read_run(c) or {}).get("chats") or {}).get(orientation.ROLE)
        meta = agents.meta_or_none(c, str(chat)) if chat else None
        if meta is not None:
            return meta, ""
    found = find_threads(c, name)
    if len(found) > 1 and len({m.get("view") if m.get("role") == "dev" else None for m in found} - {None}) == 1 \
            and all(m.get("role") == "dev" and m.get("view") for m in found):
        return max(found, key=lambda m: str(m.get("created_at") or "")), ""
    return _one_thread(c, "message_thread", name)


async def tool_message_thread(ctx: Any, args: dict[str, Any]) -> Any:
    """The `message_thread` tool (the /thimble:ask command): a message typed in the terminal goes where the thread's
    composer in the browser would send it (the frontend's threads.composerTarget). A side thread logs it and hands main
    its `thread` event in the result, so main answers in the same turn (events.hand), and with no message asks its
    unanswered questions again (ask_again); the latest orientation takes it as main's follow-up, the exact SendMessage
    message_orientation gives (orient_session.tool_message_orientation);
    a view's build thread takes it as a change to the view (views.message). Any other chat's messages go to main."""
    from . import events, orient_session, orientation, tools, views  # noqa: PLC0415

    text = str(args.get("message") or "").strip()
    meta, why = _ask_target(ctx.c, str(args.get("thread") or ""))
    if meta is None:
        return tools.err(why)
    tid, name = str(meta["id"]), str(meta.get("name") or meta.get("title") or meta["id"])
    try:
        if meta.get("kind") == agents.KIND_THREAD:
            if not text:
                again = ask_again(ctx.c, tid, hand=True)
                return tools.ok(tools.hint("message_thread-again", thread=name, event=again["text"]))
            if not events.reachable(ctx.c):
                return tools.err(f"message_thread: {events.NOT_LISTENING.format(cwd=config.corpus_dir(ctx.c))}")
            event_id = secrets.token_hex(4)
            built = event(ctx.c, {"thread": tid, "text": text, "by": agents.TERMINAL}, event_id)
            if built is None:
                return tools.ok(tools.hint("message_thread-queued", thread=name))
            body, fields, _ = built
            return tools.ok(tools.hint("message_thread-event", thread=name,
                                       event=events.hand(ctx.c, event_id, body, fields, thread=tid)))
        if not text:
            return tools.err(tools.hint("message_thread-empty", thread=name))
        latest = (((orientation.read_run(ctx.c) or {}).get("chats") or {}).get(orientation.ROLE))
        if meta.get("role") == orientation.ROLE and tid == latest:  # main's follow-up: its exact SendMessage
            return await orient_session.tool_message_orientation(ctx, {"message": text})
        if meta.get("role") == "dev" and meta.get("view"):
            # a change typed in the terminal: main's exact Agent call starts its builder, as file_dev_ticket's does, so
            # auto mode judges the start (a browser message is the analyst's click, views.message_route)
            views._bind_loop()
            slug = str(meta["view"])
            views.message(ctx.c, slug, text, by=agents.TERMINAL, route=views.TYPED)
            return await tools._typed_build(ctx, slug)
    except HTTPException as e:
        return tools.err(f"message_thread: {e.detail}")
    except (orient_session.NoOrientation, RuntimeError) as e:
        return tools.err(f"message_thread: {e}")
    return tools.err(tools.hint("message_thread-main", thread=name))


def _file_ref(ref: str) -> bool:
    """Whether `ref` names a place in a corpus file."""
    from . import refs  # noqa: PLC0415

    try:
        return "path" in refs.parse_ref(ref)
    except ValueError:
        return False


async def tool_screenshot(ctx: Any, args: dict[str, Any]) -> Any:
    """`screenshot` of `thread:<id>`, or of a ref a thread was opened on: the PNG the browser captured at the click."""
    from . import tools  # noqa: PLC0415

    ref = str(args.get("ref") or "").strip()
    m = THREAD_REF_RE.match(ref)
    meta = agents.meta_or_none(ctx.c, m.group(1)) if m else None
    if meta is None and not m:
        meta = next((x for x in reversed(agents.list_chats(ctx.c)) if x.get("kind") == agents.KIND_THREAD
                     and ref in _anchors(x) and x.get("anchor_image")), None)
    path = Path(str((meta or {}).get("anchor_image") or ""))
    if meta is None or not path.is_file():
        if not m and _file_ref(ref):
            # a file ref no view opens, and no thread was opened on it: the tool's answer names the way to read it
            return tools.err("screenshot: " + tools.hint("screenshot-none", what=f"No view opens {ref}"))
        return tools.err(f"screenshot: no picture of {ref}; a thread's element is `thread:<id>`, and only a thread opened "
                         "from the browser has one")
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return tools._image(data, "image/png", f"screenshot of {ref} ({meta.get('anchor') or 'no ref'}), taken at the click")
