"""The context engine: what the workspace holds, rendered for an agent that needs it. The writer, a report check, a
critique and the card check build what they send with render(), so each gets the full history rather than a brief.

render(c, task, *, budget, focus, parts, chat). prompts/context.md holds one `## ` section per part (heading,
description, slot); render sends each part asked for, in the file's order, and the task last. Parts: conversation
(main's transcript with tool calls), threads, orientation (the latest orientation's digest), session (one chat thimble
started), canvas, views and documents.

The budget is in characters. Never cut: the task, the canvas, the views, the documents, and every entry that touches a
ref in `focus`. The rest is cut in order until it fits (STEPS, then DROP_ORDER): results shortened, then calls, then the
oldest entries. A cut result ends with a `## context-cut` line naming the ref read_ref reads it whole by. What is left
past every cut is sent over the budget.
"""
from __future__ import annotations

import contextlib
import json
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

from . import agents, cite, config, events, investigation, prompts, report_types, session, threads, tools

PROMPT = "context"  # prompts/context.md
PARTS = ("conversation", "threads", "orientation", "canvas", "views", "documents")  # every part render gives by default
# each part's `## ` heading in prompts/context.md, in the order render sends them; `session` is asked for by name
HEADINGS = {"conversation": "The conversation", "threads": "The threads", "orientation": "The orientation",
            "session": "The session", "canvas": "The canvas", "views": "The views", "documents": "The documents"}
TASK_HEADING = "Your task"
ALWAYS = ("conversation", "orientation", "canvas")  # the parts that say they are empty rather than being left out
OUTPUT_CHARS = 6_000  # of one tool result
INPUT_CHARS = 8_000  # of one argument of a call
TIERS = ((OUTPUT_CHARS, INPUT_CHARS), (2_000, 3_000), (600, 1_000), (0, 300))  # (result, argument) caps, tried in order
ORIENT_LINE_CHARS = 300  # of one line of the orientation's digest, in its second cut
CARD_CALLS = ("add_card", "edit_card", "add_cell", "edit_cell")  # the calls whose result names the card they made
COMMENT_CHARS = 300  # of an open comment's text in the documents part
INDENT = "    "
# the cut steps, (part, level) in order, then the parts whose oldest entries go, in order
STEPS = (("orientation", 1), ("orientation", 2), ("threads", 1), ("threads", 2), ("conversation", 1),
         ("conversation", 2), ("conversation", 3), ("session", 1), ("session", 2), ("session", 3))
DROP_ORDER = ("orientation", "threads", "session", "conversation")
_memo = threading.local()  # the hint lines of prompts/tools.md, read once per render (_hints)


def _hint(name: str, **values: Any) -> str:
    """tools.hint, from the lines read once for the render under way: a long conversation cuts thousands of results,
    and tools.hint reads prompts/tools.md fresh each time."""
    secs = getattr(_memo, "secs", None)
    if secs is None:
        return tools.hint(name, **values)
    body = secs.get(name, "")
    try:
        return body.format(**values) if body else ""
    except (KeyError, IndexError, ValueError):
        return body


@contextlib.contextmanager
def _hints() -> Iterator[None]:
    outer = getattr(_memo, "secs", None)
    _memo.secs = outer if outer is not None else tools.descriptions()
    try:
        yield
    finally:
        _memo.secs = outer


# --------------------------------------------------------------------------- the conversation


@dataclass
class _Entry:
    """One entry of the conversation: a message (`body`) or a call (`name`, `args` and, once read, `result`)."""

    head: str
    body: str = ""
    name: str = ""
    args: dict[str, Any] | None = None
    result: str | None = None
    error: bool = False


def _records(path: Path) -> list[dict]:
    try:
        data = path.read_bytes()
    except OSError:
        return []
    out = []
    for line in data.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def transcript_path(c: str) -> Path | None:
    """Main's transcript: the attached session's, else the one recorded last for the workspace."""
    lv = session.current(c)
    if lv is not None and lv.transcript_path:
        return Path(lv.transcript_path)
    recorded = sorted(session.sessions(c).values(), key=lambda r: str(r.get("since") or ""), reverse=True)
    for r in recorded:
        path = r.get("transcript_path") or (session.find_transcript(str(r.get("session") or "")) if r.get("session") else None)
        if path:
            return Path(path)
    return None


def _event(raw: str, forks: bool = True) -> _Entry | None:
    """A browser event as main received it: the analyst's message for `main`, else the event with its attributes. A
    thread's event keeps its question and refs, since the rest of its anchor (the selector, the element's text, what
    the ref resolves to) is for the fork to read; without `forks` it is left out, since the threads part tells it."""
    m = session.EVENT_RE.match(raw or "")
    attrs = dict(session.ATTR_RE.findall(m.group(1))) if m else {}
    body = (m.group(2) if m else str(raw or "")).strip()
    kind = attrs.pop("kind", "")
    attrs.pop("event", None)
    attrs.pop("source", None)  # 0.5.0's tag (session.OLD_TAG)
    if kind in ("main", ""):
        return _Entry("[analyst]", body) if body else None
    if kind == events.THREAD:
        if not forks:
            return None
        keep = [ln for ln in body.splitlines() if ln.startswith(("question:", "ref:"))]
        body = "\n".join(keep) or body
        attrs = {k: v for k, v in attrs.items() if k == "thread"}
    tags = " ".join(f'{k}="{v}"' for k, v in attrs.items())
    return _Entry(f"[event {kind}{' ' + tags if tags else ''}]", body)


def _fork_entries(path: Path, thread: str, start: int) -> tuple[list[_Entry], int]:
    """A thread's fork's calls from its transcript, from record `start` on (a follow-up resumes the same file), and
    the number of records read. Its text is left out: the analyst reads a fork's reply_in_thread, never its text."""
    recs = _records(path)
    out: list[_Entry] = []
    calls: dict[str, _Entry] = {}
    for rec in recs[start:]:
        if rec.get("type") == "assistant":
            try:
                blocks = session._blocks(rec)
            except session.Unreadable:
                continue
            for b in blocks:
                if b["type"] != "tool_use" or b.get("name") in session.PLUMBING_TOOLS:
                    continue
                e = _Entry(f"[thread {thread} calls {session._short(str(b.get('name') or ''))}]",
                           name=session._short(str(b.get("name") or "")), args=b.get("input") if isinstance(b.get("input"), dict) else {})
                calls[str(b.get("id") or "")] = e
                out.append(e)
        elif rec.get("type") == "user":
            _results(rec, calls, set())
    return out, len(recs)


def _results(rec: dict, calls: dict[str, _Entry], hidden: set[str]) -> None:
    for b in session._content_list(rec):
        if isinstance(b, dict) and b.get("type") == "tool_result" and isinstance(b.get("tool_use_id"), str):
            call = calls.get(b["tool_use_id"])
            if call is None or b["tool_use_id"] in hidden:
                continue
            text = session.response_text(b.get("content"))
            if call.name in session.AGENT_TOOLS and session.ASYNC_RESULT_RE.match(text):
                continue  # a background agent's launch notice; its task notification carries its result
            call.result, call.error = text, bool(b.get("is_error"))


def _entries(path: Path, forks: bool = True) -> list[_Entry]:
    """Main's conversation from its transcript, in order; without `forks`, no thread's event or calls."""
    entries: list[_Entry] = []
    calls: dict[str, _Entry] = {}
    hidden: set[str] = set()  # tool_use ids whose calls and results are not the conversation
    fork_calls: dict[str, str] = {}  # tool_use id of an Agent or SendMessage call to a thread's fork -> the thread
    fork_agents: dict[str, str] = {}  # a fork's agent id -> its thread
    fork_read: dict[str, int] = {}  # a fork's agent id -> records of its transcript rendered
    subagents = path.parent / path.stem / "subagents"

    def notification(text: str) -> None:
        # the browser's events come as a task notification, from thimble's watcher or its Monitor
        # (session.browser_events); they are the analyst's messages and are rendered as such
        found = session.browser_events(text)
        if found:
            entries.extend(e for e in (_event(x, forks) for x in found) if e is not None)
            return
        fields = dict(session.TASK_FIELD_RE.findall(text or ""))
        agent_id = str(fields.get("task-id") or "").strip()
        thread = fork_calls.get(str(fields.get("tool-use-id") or "").strip()) or fork_agents.get(agent_id)
        if thread and agent_id:
            fork_agents[agent_id] = thread
            if forks:
                got, read = _fork_entries(subagents / f"agent-{agent_id}.jsonl", thread, fork_read.get(agent_id, 0))
                fork_read[agent_id] = read
                entries.extend(got)
            return
        result, status = str(fields.get("result") or "").strip(), str(fields.get("status") or "").strip()
        if result:
            entries.append(_Entry(f"[notification {status}]" if status else "[notification]", result))

    def prompt(text: str, origin: str | None) -> None:
        if origin == session.OLD_ORIGIN:  # an event in a transcript thimble 0.5.0 wrote
            e = _event(text, forks)
            if e is not None:
                entries.append(e)
        elif origin == "task-notification":
            notification(text)
        elif origin in (None, "human"):
            command = session._command_line(text)
            if command is not None:
                entries.append(_Entry("[analyst]", command))
            elif text.strip() and not text.lstrip().startswith("<") and not session.INTERRUPT_RE.match(text.strip()):
                entries.append(_Entry("[analyst]", text.strip()))

    for rec in _records(path):
        if rec.get("isSidechain"):
            continue
        kind = rec.get("type")
        origin = (rec.get("origin") or {}).get("kind") if isinstance(rec.get("origin"), dict) else None
        if kind == "user":
            _results(rec, calls, hidden)
            text = session._user_text(rec)
            if text is None or rec.get("isCompactSummary") or (rec.get("isMeta") and origin != session.OLD_ORIGIN):
                continue
            prompt(text, origin)
        elif kind == "attachment":
            att = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
            if att.get("type") == "queued_command":
                a_origin = (att.get("origin") or {}).get("kind") if isinstance(att.get("origin"), dict) else None
                prompt(str(att.get("prompt") or ""), a_origin)
        elif kind == "assistant":
            try:
                blocks = session._blocks(rec)
            except session.Unreadable:
                continue
            for b in blocks:
                text = session.visible(str(b.get("text") or "")) if b["type"] == "text" else ""
                if text.strip():  # main's end token is no reply the analyst read (session.py, the end token)
                    entries.append(_Entry("[session]", text.strip()))
                elif b["type"] == "tool_use" and isinstance(b.get("id"), str):
                    name = session._short(str(b.get("name") or ""))
                    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                    thread = threads.thread_of(inp.get("description")) if name in session.AGENT_TOOLS else \
                        fork_agents.get(str(inp.get("to") or "")) if name == session.SEND_TOOL else None
                    if thread:
                        fork_calls[b["id"]] = thread
                    if thread or b.get("name") in session.PLUMBING_TOOLS:
                        hidden.add(b["id"])
                        continue
                    e = _Entry(f"[session calls {name}]", name=name, args=inp)
                    calls[b["id"]] = e
                    entries.append(e)
    return entries


def _ref_of(e: _Entry) -> str | None:
    """What read_ref reads whole for a call: the card a card's call made or changed, the ref read_ref read."""
    if e.name in CARD_CALLS:
        cid = agents.cell_id(e.result or "")
        if cid:
            return f"card:{cid}"
        card = str((e.args or {}).get("card") or (e.args or {}).get("cell") or "").strip()
        return cite.canon(card if card.startswith(("card:", "cell:")) else f"card:{card}") if card else None
    if e.name == "read_ref":
        ref = str((e.args or {}).get("ref") or "").strip()
        return ref or None
    return None


def _cut(text: str, cap: int, ref: str | None) -> str:
    """`text` whole when it fits `cap`, else its start, cut at a line where one is near, and the hint that says how
    much is shown and names the ref that reads it whole."""
    if len(text) <= cap:
        return text
    head = text[:cap]
    nl = head.rfind("\n")
    if nl > cap // 2:
        head = head[:nl]
    hint = (_hint("context-cut", shown=len(head), total=len(text), ref=ref) if ref
            else _hint("context-cut-plain", shown=len(head), total=len(text)))
    return f"{head.rstrip()}\n{hint}" if head.strip() else hint


def _indent(text: str) -> str:
    return "\n".join(INDENT + ln if ln else ln for ln in text.splitlines())


def _args_text(args: dict[str, Any], cap: int, ref: str | None) -> str:
    lines = []
    for k, v in args.items():
        value = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        value = _cut(value, cap, ref)
        lines.append(f"{k}:\n{_indent(value)}" if "\n" in value else f"{k}: {value}")
    return "\n".join(lines)


def _entry_text(e: _Entry, out_cap: int, in_cap: int) -> str:
    """One entry as the agent reads it, a call with its arguments and its result under it. `cell:<id>` refs are read as
    `card:<id>` (cite.canon_text)."""
    if not e.name:
        return cite.canon_text(f"{e.head}\n{e.body}" if e.body else e.head)
    ref = _ref_of(e)
    args = _args_text(e.args or {}, in_cap, ref)
    blocks = [f"{e.head}\n{args}" if args else e.head]
    if e.result is not None:
        blocks.append(f"{'[error]' if e.error else '[result]'}\n{_cut(e.result.strip(), out_cap, ref)}")
    return cite.canon_text("\n\n".join(blocks))


# --------------------------------------------------------------------------- the cuttable parts


@dataclass
class _Item:
    """One entry of a part, as its text at each cut level (level 0 whole); an entry that touches a focus ref is shown
    whole at every level and never left out."""

    levels: list[str]
    focus: bool = False

    def at(self, level: int) -> str:
        return self.levels[0] if self.focus else self.levels[min(level, len(self.levels) - 1)]


@dataclass
class _Part:
    """A part the budget may cut: its entries, oldest first, the level its entries are shown at, how many of its oldest
    entries are left out, and the line that says so (`oldest`, given the count)."""

    key: str
    items: list[_Item]
    sep: str = "\n\n"
    oldest: Callable[[int], str] = lambda n: _hint("context-cut-oldest", n=n)
    level: int = 0
    dropped: set[int] = field(default_factory=set)
    cut_line: str = ""  # a line added whenever the part is cut in any way (the orientation's, naming its ref)

    def cut(self) -> bool:
        return bool(self.level or self.dropped)

    def text(self) -> str:
        shown = [t for i, it in enumerate(self.items) if i not in self.dropped and (t := it.at(self.level))]
        lead = self.cut_line if self.cut() and self.cut_line else self.oldest(len(self.dropped)) if self.dropped else ""
        return self.sep.join([lead, *shown] if lead else shown)


def _touches(text: str, focus: tuple[str, ...]) -> bool:
    return any(re.search(re.escape(f) + r"(?![A-Za-z0-9_-])", text) for f in focus)


def _items(texts: Iterable[list[str]], focus: tuple[str, ...]) -> list[_Item]:
    return [_Item(levels, focus=bool(focus) and _touches(levels[0], focus)) for levels in texts]


def conversation_part(c: str, focus: tuple[str, ...] = (), forks: bool = True) -> _Part | None:
    """Main's conversation as a part, each entry at every tier of TIERS; None when it has no entry."""
    path = transcript_path(c)
    entries = _entries(path, forks) if path is not None else []
    if not entries:
        return None
    return _Part("conversation", _items(([_entry_text(e, o, i) for o, i in TIERS] for e in entries), focus))


def conversation(c: str, limit: int = 600_000) -> str:
    """Main's whole conversation alone, its thread forks' calls among it, cut to `limit`."""
    with _hints():
        part = conversation_part(c)
        if part is None:
            return _hint("context-no-conversation")
        _fit([part], limit, 0)
        return part.text()


def _thread_levels(c: str, meta: dict[str, Any]) -> list[str]:
    """One thread as the threads part shows it at each level: whole, without its calls' results, then its questions
    and replies alone."""
    anchor = str(meta.get("anchor") or "").strip()
    seen = " ".join(str(meta.get("anchor_text") or "").split())
    head = f"### thread:{meta['id']}" + (f" · on {cite.canon_text(anchor)}" if anchor else "")
    lead = [head] + ([f"pointed at: {seen}"] if seen else [])
    whole, bare, talk = list(lead), list(lead), list(lead)
    calls: dict[str, str] = {}
    text: list[str] = []

    def flush() -> None:
        if text:
            line = "[text]\n" + "".join(text).strip()
            whole.append(line)
            bare.append(line)
            text.clear()

    for e in agents.read_events(agents.paths(c, str(meta["id"]))[1]):
        kind = e.get("type")
        if kind == "text":
            if e.get("reply"):
                flush()
                line = f"[reply]\n{str(e.get('delta') or '').strip()}"
                whole.append(line)
                bare.append(line)
                talk.append(line)
            else:
                text.append(str(e.get("delta") or ""))
            continue
        flush()
        if kind == "user" and str(e.get("text") or "").strip():
            line = f"[analyst]\n{str(e['text']).strip()}"
            whole.append(line)
            bare.append(line)
            talk.append(line)
        elif kind == "tool_use":
            name = session._short(str(e.get("name") or ""))
            if name == session.REPLY_TOOL:
                continue  # its text is the reply above
            inp = e.get("input") if isinstance(e.get("input"), dict) else {}
            ref = _ref_of(_Entry("", name=name, args=inp))
            calls[str(e.get("id") or "")] = name
            args = _args_text(inp, INPUT_CHARS, ref)
            whole.append(f"[thread calls {name}]\n{args}" if args else f"[thread calls {name}]")
            args = _args_text(inp, TIERS[-1][1], ref)
            bare.append(f"[thread calls {name}]\n{args}" if args else f"[thread calls {name}]")
        elif kind == "tool_result" and str(e.get("id") or "") in calls:
            summary = str(e.get("summary") or "").strip()
            if summary:
                whole.append(f"{'[error]' if e.get('is_error') else '[result]'}\n{summary}")
    flush()
    return [cite.canon_text("\n\n".join(x)) for x in (whole, bare, talk)]


def threads_part(c: str, focus: tuple[str, ...] = ()) -> _Part | None:
    """Every thread of the workspace, oldest first, one entry each; None when there is none."""
    metas = sorted((m for m in agents.list_chats(c) if m.get("kind") == agents.KIND_THREAD),
                   key=lambda m: str(m.get("created_at") or ""))
    if not metas:
        return None
    return _Part("threads", _items((_thread_levels(c, m) for m in metas), focus))


def _orientation_chat(c: str) -> str:
    from . import orientation as orient  # noqa: PLC0415

    return str(((orient.read_run(c) or {}).get("chats") or {}).get(orient.ROLE) or "")


def orientation_part(c: str, focus: tuple[str, ...] = ()) -> _Part | None:
    """The latest orientation's digest as a part, an entry for each line that is not indented with the lines indented
    under it (a call and its result), at three levels: whole, without the indented lines, with each line shortened to
    ORIENT_LINE_CHARS; None when no orientation ran or its transcript is gone."""
    from . import critique_session  # noqa: PLC0415

    chat = _orientation_chat(c)
    text = critique_session.chat_digest(c, chat) if chat else ""
    if not text:
        return None
    groups: list[list[str]] = []
    for ln in text.split("\n"):
        if ln.startswith(critique_session.INDENT) and groups:
            groups[-1].append(ln)
        else:
            groups.append([ln])

    def short(ln: str) -> str:
        return ln if len(ln) <= ORIENT_LINE_CHARS else ln[: ORIENT_LINE_CHARS - 1] + "…"

    levels = ([ "\n".join(g), g[0], short(g[0])] for g in groups)
    cut = _hint("context-orientation-cut", ref=f"chat:{chat}")
    return _Part("orientation", _items(levels, focus), sep="\n", oldest=lambda n: cut, cut_line=cut)


def orientation(c: str, limit: int = 600_000) -> str:
    """The latest orientation's thread alone, cut to `limit`."""
    with _hints():
        part = orientation_part(c)
        if part is None:
            return _hint("context-no-orientation")
        _fit([part], limit, 0)
        return part.text()


def session_part(c: str, chat: str | None, focus: tuple[str, ...] = ()) -> _Part | None:
    """The chat of a session thimble started, as a part, each entry at every tier of TIERS; None when it holds
    nothing."""
    if not chat or agents.meta_or_none(c, chat) is None:
        return None
    entries: list[_Entry] = []
    by_id: dict[str, _Entry] = {}
    for e in agents.read_events(agents.paths(c, chat)[1]):
        kind = e.get("type")
        if kind == "user" and str(e.get("text") or "").strip():
            entries.append(_Entry("[message]", str(e["text"]).strip()))
        elif kind == "text" and str(e.get("delta") or "").strip():
            if entries and entries[-1].head == "[session]":
                entries[-1].body += str(e.get("delta") or "")
            else:
                entries.append(_Entry("[session]", str(e.get("delta") or "")))
        elif kind == "tool_use":
            name = session._short(str(e.get("name") or ""))
            call = _Entry(f"[session calls {name}]", name=name, args=e.get("input") if isinstance(e.get("input"), dict) else {})
            by_id[str(e.get("id") or "")] = call
            entries.append(call)
        elif kind == "tool_result" and str(e.get("id") or "") in by_id:
            call = by_id[str(e["id"])]
            call.result, call.error = str(e.get("summary") or ""), bool(e.get("is_error"))
    for e in entries:
        e.body = e.body.strip()
    if not entries:
        return None
    return _Part("session", _items(([_entry_text(e, o, i) for o, i in TIERS] for e in entries), focus))


# --------------------------------------------------------------------------- the parts never cut


def canvas(c: str) -> str:
    """Every card by group, in the tree's order: its ref, kind and question, and its takeaway."""
    from . import notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    rows = notebook.tree_order(notebook.list_notebooks(ws, figures=False))
    blocks = []
    for row in rows:
        nb = notebook.read_notebook(ws, row["id"]) or {}
        cells = [x for x in nb.get("cells") or [] if isinstance(x, dict) and x.get("id")]
        if not cells:
            continue
        lines = [f"### {tools._group_name(rows, row)} ({len(cells)} card{'' if len(cells) == 1 else 's'})"]
        for cell in cells:
            kind = cell.get("kind", notebook.DEFAULT_KIND)
            title = " ".join(str(cell.get("title") or "").split())
            if not title and kind == "note":
                text = str((cell.get("payload") or {}).get("text") or "")
                title = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
            locked = " · locked" if cell.get("locked") is True else ""  # the analyst's lock: no model may change the card
            lines.append(f"- card:{cell['id']} · {kind}{locked} · {title or '(untitled)'}")
            takeaway = " ".join(cite.canon_text(str(cell.get("takeaway") or "")).split())
            if takeaway:
                lines.append(f"  takeaway: {takeaway}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) or _hint("context-no-cards")


def views(c: str) -> str:
    """The corpus's own views, each with the files it claims and what it is for, then the proposals not built yet (one
    the orientation dropped is not among them)."""
    from . import views as views_mod  # noqa: PLC0415

    lines: list[str] = []
    try:
        listed = [v for v in views_mod.list_views(c) if v.get("origin") != "builtin" and v.get("ok")]
        proposed = [p for p in views_mod.list_proposals(c) if p.get("status") not in ("built", "dropped")]
    except (OSError, ValueError):
        return ""
    for v in listed:
        lines.append(f"- view:{v['slug']} · {v['name']} · claims {', '.join(v.get('claims') or [])}")
        if v.get("description"):
            lines.append(f"  {v['description']}")
    for p in proposed:
        lines.append(f"- proposed, {p.get('status')}: {p.get('name') or p.get('slug')} · claims {', '.join(p.get('claims') or [])}")
        if p.get("why"):
            lines.append(f"  {' '.join(str(p['why']).split())}")
    return "\n".join(lines)


def _comment_lines(c: str, doc: dict[str, Any]) -> list[str]:
    """A written document's open comments, each on the passage it is anchored to, by its author, a check by its name."""
    from . import checks  # noqa: PLC0415 — checks imports this module

    names = checks.names(c)
    out = []
    for cm in report_types.anchored_open_comments(doc):
        who = names.get(str(cm.get("check") or ""), str(cm.get("check") or "")) if cm.get("check") else str(cm.get("author") or report_types.ANALYST)
        text = " ".join(cite.canon_text(str(cm.get("text") or "")).split())
        if len(text) > COMMENT_CHARS:
            text = text[: COMMENT_CHARS - 1] + "…"
        out.append(f"comment on #{cm.get('sentence_id')} · {who} · {text}")
    return out


def documents(c: str) -> str:
    """Each document type, one line: its ref, name, and whether it is written; under it the blocks the analyst locked,
    the reverted ones, and its open comments. Under a document not written yet, everything the analyst wrote in its frame."""
    lines = []
    for t in report_types.list_types(c):
        slug, name = str(t["slug"]), str(t.get("name") or t["slug"])
        doc = report_types.read_doc(c, investigation.MAIN, slug)
        frame = None if doc is not None else report_types.read_frame(c, investigation.MAIN, slug)
        if doc is not None:
            title = " ".join(str(doc.get("title") or "").split())
            lines.append(f"- report:{slug} · {name} · generation {doc.get('generation') or 1} · "
                         f"{report_types.doc_words(doc)} words" + (f" · {title}" if title else ""))
            lines += [f"{INDENT}{line}" for line in report_types.locked_block_lines(doc)]
            reverted = [str(r.get("ref")) for r in report_types.current_reverts(doc)]
            if reverted:  # a change to a locked block that thimble reverted since this generation was written
                lines.append(f"{INDENT}{report_types.reverted_line(reverted)}")
            lines += [f"{INDENT}{line}" for line in _comment_lines(c, doc)]
        elif frame and (report_types.units(frame) or str(frame.get("title") or "").strip()):
            lines.append(f"- report:{slug} · {name} · not written yet")
            text = [_hint("read_ref-frame", slug=slug), *report_types.document_lines(frame)]
            lines += [f"{INDENT}{cite.canon_text(line)}" for line in text if line]
        else:
            lines.append(f"- report:{slug} · {name} · not written yet")
    return "\n".join(lines)


# --------------------------------------------------------------------------- render


def _fit(parts: list[_Part], budget: int, fixed: int) -> None:
    """Cut `parts` in place until they and `fixed` characters fit `budget`."""
    by_key = {p.key: p for p in parts}

    def size() -> int:
        return fixed + sum(len(p.text()) + 2 for p in parts)

    if size() <= budget:
        return
    for key, level in STEPS:
        p = by_key.get(key)
        if p is None:
            continue
        p.level = level
        if size() <= budget:
            return
    for key in DROP_ORDER:
        p = by_key.get(key)
        if p is None:
            continue
        # entries go oldest first, and their lengths are counted as they go, since a part runs to thousands of them;
        # the line that says how many went is counted at its longest
        rest = size() - len(p.text())
        lengths = [len(it.at(p.level)) for it in p.items]
        body = sum(n + len(p.sep) for i, n in enumerate(lengths) if n and i not in p.dropped)
        lead = len(p.cut_line or p.oldest(len(p.items))) + len(p.sep)
        for i, it in enumerate(p.items):
            if rest + lead + body <= budget:
                break
            if i in p.dropped or it.focus:
                continue
            p.dropped.add(i)
            body -= lengths[i] + len(p.sep) if lengths[i] else 0
        if size() <= budget:
            return


def _section(heading: str, value: str) -> str:
    """A part's `## ` section of prompts/context.md with its slot filled, under its heading."""
    body = prompts.section(PROMPT, heading)
    slot = next(iter(re.findall(r"\{\{([a-z_]+)\}\}", body)), "")
    return f"## {heading}\n\n" + prompts._fill(body, {slot: value} if slot else {}, prompts._norm(PROMPT)).strip()


def render(c: str, task: str = "", *, budget: int, focus: Iterable[str] = (), parts: Iterable[str] = PARTS,
           chat: str | None = None) -> str:
    """The parts `parts` asks for (PARTS, and `session` for the chat `chat`), each under its heading, then `task` under
    `## Your task` when it is given, cut to `budget` characters around the refs in `focus`."""
    with _hints():
        want = [k for k in HEADINGS if k in set(parts)]
        focus_refs = tuple(dict.fromkeys(cite.canon(str(f).strip()) for f in focus if str(f).strip()))
        cuttable: dict[str, _Part | None] = {}
        fixed: dict[str, str] = {}
        for key in want:
            if key == "conversation":
                cuttable[key] = conversation_part(c, focus_refs, forks="threads" not in want)
            elif key == "threads":
                cuttable[key] = threads_part(c, focus_refs)
            elif key == "orientation":
                cuttable[key] = orientation_part(c, focus_refs)
            elif key == "session":
                cuttable[key] = session_part(c, chat, focus_refs)
            elif key == "canvas":
                fixed[key] = canvas(c)
            elif key == "views":
                fixed[key] = views(c)
            elif key == "documents":
                fixed[key] = documents(c)
        empty = {"conversation": "context-no-conversation", "orientation": "context-no-orientation"}
        frames = {k: _section(HEADINGS[k], "") for k in want}  # each section's own text, counted against the budget
        live = [p for p in cuttable.values() if p is not None]
        size = sum(len(frames[k]) + 2 for k in want) + sum(len(v) for v in fixed.values())
        size += sum(len(_hint(empty[k])) for k, p in cuttable.items() if p is None and k in empty)
        if task.strip():
            size += len(_section(TASK_HEADING, task.strip())) + 2
        _fit(live, budget, size)
        out = []
        for key in want:
            part = cuttable.get(key)
            value = fixed.get(key, "") if key in fixed else part.text() if part is not None else \
                _hint(empty[key]) if key in empty else ""
            if value.strip() or key in ALWAYS:
                out.append(_section(HEADINGS[key], value.strip()))
        if task.strip():
            out.append(_section(TASK_HEADING, task.strip()))
        return "\n\n".join(out)
