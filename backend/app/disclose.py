"""Load on demand: the later parts of main's guidance reach main when it first uses their feature, not in its guide.

main.md and shared.md mark the parts of main's guidance that matter only once a feature is in use, such as the
examples of a label, the bullet of each event kind or the Threads section, as later parts (`{{later:<name>}}…{{/later}}`,
prompts.py). The guide leaves them out (guide.render), but those the workspace already uses (inline: the orientation's
follow-ups once an orientation ran, the view citations once the workspace has a view). Every other prompt that
includes the files (the orientation's, the writer's, the critic's) keeps them. A part reaches main word for word, as
the guide would have held it, under the heading of the guide it sits under, after the lead line LATER_LEAD that names
the session's guide marker:
- with the result of main's first call of a tool that uses its feature (TOOL_SECTIONS), or of a ref that names it
  (REF_SECTIONS), as one more text block after the result's own text (after_call): a call that fails gives nothing,
  and so does a call of one of thimble's agents (its own prompt holds every part), a call without a tool_use_id (a
  program's) or one thimble's module made, and a thread's fork's start of an agent, whose Agent call main makes;
- with main's first event of a kind that uses it (EVENT_SECTIONS, with_event): after the event's text, or for a quiet
  event, which rides along on one line under `meanwhile:`, after those lines (events.meanwhile); a quiet event that
  goes before it reaches main (events.drop_held) gives its parts back (untold).
Each part reaches each conversation once. A conversation is main's (its Claude Code session, launch.json's session
followed through the moves --rekey records, so /clear starts a new one), or a subagent's, by its agent id from the
caller hook's line of the call (callers.jsonl). A thread's fork starts from main's context, so it is not given a part
main had. Each time the whole guide goes out again (session start, /clear, /compact, a switch that changes it), it
replaces the guidance before it, so main's marks are forgotten and its inline parts marked (guide.render).

The marks: `trusted/disclosed.json` in the workspace folder, {conversation: {part: when}}, the newest
CONVERSATIONS_KEPT kept. Standard library only at import time.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

log = logging.getLogger("thimble.disclose")

DIR = "trusted"  # subagent_files.DIR: the workspace's folder of the files the hooks trust
FILE = "disclosed.json"
CONVERSATIONS_KEPT = 64
LOCK_WAIT_S = 2.0
MAIN = "main"
AGENT = "agent"
PLUGIN_CALL = "toolu_plugin_"  # subagent_files.PLUGIN_CALL: a call thimble's module made, whose result no model reads
FORK_TYPE = "fork"  # subagent_files.FORK_TYPE

# The later parts (main.md and shared.md), by name: where each sits in the guide.
SECTIONS = {
    "labels": "Labels: what apply_label does with a predicate of each kind (its schema's words), what a label's result "
              "is, the label card and its colors, and the three examples; the label row of Citations",
    "documents": "the passage row of Citations",
    "orientation": "The orientation: following up a finished orientation, and its three rows; the call rows of "
                   "Citations",
    "views": "Citations: how to cite a viewer and a view, the forms of the workspace's views, and the view example",
    "agents": "thimble's agents: a message for one and a stop of one; Permission requests",
    "checks": "Checks: how a running check shows its comments and runs again",
    "threads": "Chat and cards: when a thread needs a reply; Threads",
    "events": "Events from thimble: how an event arrives, and the line of an event with no text",
    "event-quiet": "Events from thimble: the events that ride along under `meanwhile:`",
    **{f"event-{k}": f"Events from thimble: the `{k}` bullet" for k in (
        "main", "thread", "start_agent", "orient", "card", "written", "checked", "labeled", "view", "card_types",
        "label_done", "rerun")},
}
# The parts the first call of each tool gives, in the guide's order.
TOOL_SECTIONS: dict[str, tuple[str, ...]] = {
    "apply_label": ("labels",), "show_label": ("labels",), "delete_label": ("labels",),
    "start_orientation": ("orientation", "agents"), "message_orientation": ("orientation", "agents"),
    "start_writing": ("agents",), "propose_view": ("agents",), "file_dev_ticket": ("agents",),
    "list_agents": ("agents",),
    "run_check": ("checks", "agents"), "stop_check": ("checks",),
    "open_view": ("views",),
    "write_document": ("documents",), "edit_document": ("documents",),
    "message_thread": ("events", "event-thread", "threads"), "reply_in_thread": ("threads",),
    "rename_thread": ("threads",), "delete_thread": ("threads",),
}
# read_ref, add_comment and resolve_comment, by the start of the ref they name
REF_SECTIONS: dict[str, tuple[str, ...]] = {"view:": ("views",), "report:": ("documents",), "call:": ("orientation",)}
REF_TOOLS = {"read_ref": "ref", "add_comment": "ref", "resolve_comment": "comment"}
# main's first event of each kind
EVENT_SECTIONS: dict[str, tuple[str, ...]] = {
    "main": ("events", "event-main"),
    "thread": ("events", "event-thread", "threads"),
    "start_agent": ("events", "event-start_agent", "agents"),
    "orient": ("events", "event-orient", "event-quiet", "orientation", "agents"),
    "card": ("events", "event-card"),
    "written": ("events", "event-written", "event-quiet", "agents"),
    "checked": ("events", "event-checked", "checks", "agents"),
    "labeled": ("events", "event-labeled", "event-quiet", "labels"),
    "view": ("events", "event-view", "event-quiet", "views"),
    "card_types": ("events", "event-card_types", "event-quiet"),
    "label_done": ("events", "event-label_done", "labels"),
    "rerun": ("events", "event-rerun", "labels"),
}
# the start tools whose call by a thread's fork main carries out (tools._ask_main): the fork only files the request, and
# main gets those parts with the `start_agent` event
FORK_STARTS = ("start_orientation", "start_writing", "run_check", "propose_view", "file_dev_ticket")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


# --------------------------------------------------------------------------- the marks


def path(ws: Path) -> Path:
    return Path(ws) / DIR / FILE


def read(ws: Path) -> dict[str, dict[str, str]]:
    """The marks of the workspace folder `ws`: {conversation: {part: when}}; {} when there are none."""
    try:
        data = json.loads(path(ws).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}


@contextlib.contextmanager
def _changing(ws: Path) -> Iterator[dict[str, dict[str, str]]]:
    """The marks to change in place, under a lock of their own; written back when the block changed them. A lock that
    stays taken past LOCK_WAIT_S is passed over, so a call never hangs on it."""
    p = path(ws)
    p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(f"{p}.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        end = time.monotonic() + LOCK_WAIT_S
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= end:
                    break
                time.sleep(0.01)
        data = read(ws)
        before = json.dumps(data, sort_keys=True)
        yield data
        if json.dumps(data, sort_keys=True) != before:
            if len(data) > CONVERSATIONS_KEPT:
                newest = sorted(data, key=lambda k: max(data[k].values(), default=""), reverse=True)
                data = {k: data[k] for k in newest[:CONVERSATIONS_KEPT]}
            tmp = p.with_name(f".{p.name}.{os.getpid()}.tmp")
            fd_tmp = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd_tmp, "w", encoding="utf-8") as f:
                f.write(json.dumps(data, ensure_ascii=False))
            os.replace(tmp, p)
    finally:
        os.close(fd)


def take(ws: Path, conversation: str, names: "list[str] | tuple[str, ...]",
         inherits: "tuple[str, ...]" = ()) -> list[str]:
    """The parts of `names` that neither `conversation` nor a conversation it began from (`inherits`) has had, in order;
    they count as had by `conversation` from now on."""
    if not names:
        return []
    with _changing(ws) as data:
        had = set(data.get(conversation) or {})
        for other in inherits:
            had |= set(data.get(other) or {})
        new = [s for s in dict.fromkeys(names) if s not in had]
        if new:
            mine = data.setdefault(conversation, {})
            for s in new:
                mine[s] = _now()
    return new


def untake(ws: Path, conversation: str, names: "list[str]") -> None:
    """`conversation` has not had `names` after all (a part that could not be rendered)."""
    with _changing(ws) as data:
        mine = data.get(conversation) or {}
        for s in names:
            mine.pop(s, None)


def reset(ws: Path, conversation: str, had: "list[str] | tuple[str, ...]" = ()) -> None:
    """`conversation` has had only `had` from now on: the whole guide went out again (module note)."""
    with _changing(ws) as data:
        data.pop(conversation, None)
        if had:
            data[conversation] = {s: _now() for s in had}


def main_key(ws: Path, sid: str | None = None) -> str:
    """Main's conversation in the workspace folder `ws`: session `sid`, else main's Claude Code session
    (subagent_files.main_session)."""
    if sid is None:
        from . import subagent_files  # noqa: PLC0415 — standard library only at import time, as this module

        sid = subagent_files.main_session(Path(ws))
    return f"{MAIN}:{sid}"


def conversation(ws: Path, tool_use_id: str) -> tuple[str, tuple[str, ...]]:
    """(the conversation that made the call `tool_use_id`, the conversations whose context it began with): main's for a
    call the caller hook names no agent for, else the agent's, which began with main's when it is a thread's fork."""
    from . import subagent_files  # noqa: PLC0415

    line = subagent_files.find_caller(Path(ws), tool_use_id) if tool_use_id else None
    agent = str((line or {}).get("agent_id") or "")
    main = main_key(ws)
    if not agent:
        return main, ()
    fork = str((line or {}).get("agent_type") or "") == FORK_TYPE
    return f"{AGENT}:{agent}", (main,) if fork else ()


# --------------------------------------------------------------------------- the parts' text


def inline(c: str | None) -> tuple[str, ...]:
    """The later parts the guide keeps for workspace `c` (module note): the orientation's once an orientation ran in
    it, the views' once it has a view."""
    if not c:
        return ()
    out = []
    try:
        from . import orientation  # noqa: PLC0415

        if orientation.read_run(c):
            out.append("orientation")
    except Exception:  # noqa: BLE001 — a run that cannot be read leaves the part for its first use
        log.debug("%s: the orientation's run could not be read", c, exc_info=True)
    try:
        from . import views  # noqa: PLC0415

        if views.forms_text(c):
            out.append("views")
    except Exception:  # noqa: BLE001
        log.debug("%s: the views' forms could not be read", c, exc_info=True)
    return tuple(out)


def text_of(c: str, names: "list[str] | tuple[str, ...]", marker: str) -> str:
    """The parts `names` of workspace `c`'s guide as main gets them: LATER_LEAD with `marker`, then each part in the
    guide's order, word for word, under the heading it sits under (a part that opens with a heading of its own goes
    without); '' when none of them is in the guide (a feature switched off)."""
    from . import config, guide  # noqa: PLC0415

    wanted = set(names)
    parts = [p for p in guide.later_parts(str(config.corpus_dir(c))) if p[0] in wanted]
    out: list[str] = []
    shown = ""
    for _, heading, text in parts:
        if not text.strip():
            continue
        if text.lstrip().startswith("## "):
            shown = text.lstrip().splitlines()[0].strip()
        elif heading and heading != shown:
            out.append(heading)
            shown = heading
        out.append(text)
    if not out:
        return ""
    return guide.LATER_LEAD.format(marker=marker) + "\n\n" + "\n\n".join(out)


def _main_marker(ws: Path) -> str | None:
    """The guide marker of main's session, None when launch.json names no session."""
    from . import guide, subagent_files  # noqa: PLC0415

    sid = subagent_files.main_session(Path(ws))
    return guide.marker(sid) if sid else None


def _given(c: str, ws: Path, conv: str, names: "list[str] | tuple[str, ...]",
           inherits: "tuple[str, ...]" = ()) -> str:
    """The text of the parts of `names` that `conv` has not had, marked had; '' for none."""
    return _given_parts(c, ws, conv, names, inherits)[1]


def _given_parts(c: str, ws: Path, conv: str, names: "list[str] | tuple[str, ...]",
                 inherits: "tuple[str, ...]" = ()) -> tuple[list[str], str]:
    """(the parts of `names` that `conv` has not had, marked had, their text); ([], '') for none."""
    marker = _main_marker(ws)
    if marker is None:
        return [], ""
    new = take(ws, conv, names, inherits)
    if not new:
        return [], ""
    try:
        text = text_of(c, new, marker)
    except Exception:  # noqa: BLE001 — a part that cannot be rendered goes with the next use
        untake(ws, conv, new)
        raise
    return new, text


# --------------------------------------------------------------------------- what a call or an event gives


def call_sections(name: str, args: dict[str, Any]) -> list[str]:
    """The later parts a call of tool `name` with `args` gives on its first use, in order."""
    from . import tools  # noqa: PLC0415

    name = tools.canonical(name)
    out = list(TOOL_SECTIONS.get(name, ()))
    if name in REF_TOOLS:
        ref = str(args.get(REF_TOOLS[name]) or "").strip().removeprefix("[[").lstrip()
        for start, names in REF_SECTIONS.items():
            if ref.startswith(start):
                out += names
    return out


def after_call(c: str, name: str, args: dict[str, Any] | None, res: Any, session: str | None,
               tool_use_id: str | None) -> Any:
    """`res`, the ToolResult of a call, with the later parts of its first use that the caller's conversation has not
    had, as one more text block after its own text (module note). Never fails the call: a failure here leaves `res` as
    it is."""
    if session is not None or not tool_use_id or tool_use_id.startswith(PLUGIN_CALL) or getattr(res, "is_error", False):
        return res
    try:
        names = call_sections(name, dict(args or {}))
        if not names:
            return res
        from . import config, tools  # noqa: PLC0415

        ws = config.workspace_dir(c)
        conv, inherits = conversation(ws, tool_use_id)
        if inherits and tools.canonical(name) in FORK_STARTS:
            return res
        text = _given(c, ws, conv, names, inherits)
        if not text:
            return res
        return tools.ToolResult([*res.content, {"type": "text", "text": text}], res.is_error)
    except Exception:  # noqa: BLE001 — a part left out never fails the call
        log.exception("%s: the later parts of %s's first use were left out", c, name)
        return res


def with_event(c: str, kind: str, note: dict[str, Any], quiet: bool) -> dict[str, Any]:
    """`note`, main's event of `kind`, with the later parts of its kind's first event that main has not had: after its
    text, or for a `quiet` event, which rides along on one line, as its `told` (and their names, `told_parts`), which
    events.meanwhile puts after the lines (module note)."""
    names = EVENT_SECTIONS.get(kind)
    if not names:
        return note
    try:
        from . import config  # noqa: PLC0415

        ws = config.workspace_dir(c)
        parts, text = _given_parts(c, ws, main_key(ws), names)
    except Exception:  # noqa: BLE001 — a part left out never fails the event
        log.exception("%s: the later parts of the first %s event were left out", c, kind)
        return note
    if not text:
        return note
    if quiet:
        return {**note, "told": text, "told_parts": parts}
    body = str(note.get("content") or "")
    return {**note, "content": f"{body}\n\n{text}" if body else text}


def untold(ws: Path, notes: "list[dict[str, Any]]") -> None:
    """Quiet events that went before they reached main (events.drop_held): main has not had the later parts they carried
    (`told_parts`), which go with the next event that uses them. Never raises."""
    parts = [str(p) for n in notes if isinstance(n, dict) for p in n.get("told_parts") or []]
    if not parts:
        return
    try:
        untake(ws, main_key(ws), parts)
    except Exception:  # noqa: BLE001 — a part main has not had is at worst left out
        log.exception("the later parts of main's guidance that dropped events carried were not given back")


def told(notes: "list[dict[str, Any]]") -> str:
    """The later parts quiet events carry (with_event), each after a blank line; '' for none."""
    return "".join(f"\n\n{n['told']}" for n in notes if isinstance(n, dict) and n.get("told"))
