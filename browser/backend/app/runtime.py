"""The server runs every agent itself: main, the side threads' forks and thimble's agents (writers, view builders and
reviewers, report checks, code tickets), on whichever way to reach Claude the person chose (claude_access.py):

    api   an API key or Workload Identity Federation: a loop on the Messages API in this process (runtime_api.py),
          with the built-in tools of runtime_tools.py. No `claude` process is started.
    cc    the person's Claude Code sign-in: one headless Claude Code session per agent, through the Agent SDK
          (runtime_cc.py), with thimble's tools as in-process MCP tools and Claude Code's built-in tools limited to
          the same set.

Both are behind one interface (Conv.turn), take the same prompts and the same tools, and write the same records: each
agent writes a transcript in Claude Code's own format, which the mirror (session.py) reads into the chats exactly as
it read 0.8's interactive session. Main's is <workspace>/runtime/<sid>.jsonl, attached as main (session.attach); a
fork's or an agent's is <workspace>/runtime/<sid>/subagents/agent-<id>.jsonl with its meta json, where the mirror
finds a subagent's. So the page cannot tell the two ways apart.

Writes (spec_of). Main and its thread forks write the corpus folder, as Claude Code does in its own folder, unless the
analyst turns Settings' "Claude can edit files in this folder" off for the workspace (ledger.corpus_edits); their
prompt and their Bash, Write and Edit descriptions say which, and name that switch when it is off. thimble's other
agents (writers, view builds and reviews, checks) and the checker's and proposer's forks never write it. No agent
writes thimble's private files (PRIVATE_FILES) or the workspace's protected files (protected), with one carve-out: a
view's builder and its reviewer write that view's folder in the protected extension/, and their own folder, alone
(agent_writes), by the slug of the start the server recorded for them, so no other agent writes a view's files.

What 0.8 did through Claude Code's interactive session and thimble's plugin, the server now does in its place:
- a browser event (events._publish) starts a turn of main (deliver), or waits for main's turn to end; a message the
  analyst types in main's chat reaches main's running turn at its next tool call, as Claude Code gives a message typed
  mid-turn (Conv.take_waiting), and main's chat shows it waiting until then (unread);
- a `thread` event starts a fork of main's conversation that answers the thread, or a new turn of its fork;
- the plugin module's ops (module_bridge.request: spawn, send, stop, abort, note) start, message and stop the agents
  and main here (module_op);
- the notes main heard through the module (`$.session.append`) wait for main's next turn (tell), and so do the notes
  about the cards main or a thread's fork made that no call of theirs took yet, such as the card check's replacement
  (card_size, Conv.take_notes).
No plugin hook or hooks module runs, so nothing depends on hooks Claude Code may skip (an Enterprise sign-in's
security plugin skips person-installed plugins' prompt.context and session.append hooks).

When Claude cannot be reached the way chosen (no choice, no key, a WIF file that cannot be used), a turn writes one
card into the chat (ACCESS_KIND) that says what is missing and opens the setup step; never a raw error.

Main's chats. Each start of thimble-browser is a new session of the folder, a workspace as empty as at its first start
(folder_sessions.py); `--continue` and `--resume` bring an earlier session back whole, with its chat of main. A session
can hold several chats of main (a workspace from before sessions, or the register route's `chat` "new"): Space.switch
makes one main, and main's conversation (convs/main-<sid>.<engine>.json) and its transcript are that chat's again.
runtime/main.json names the chat that is main now; chats_in lists them. When the workspace's folder goes (moved aside
or deleted, ledger), forget drops its runtime, so the next ensure reads the folder in its place.

THIMBLE_RUNTIME=off turns this off (0.8's own tests); it is on otherwise.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from . import nofollow  # standard library only

log = logging.getLogger("thimble.runtime")

ENV = "THIMBLE_RUNTIME"
DIR = "runtime"
MAIN = "main"
FORK_TYPE = "fork"
FIXER = "fixer"  # the role of thimble fix's fork (fixes.py), whose folder is its copy of thimble
MAIN_BUILTINS = ("Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch")
AGENT_BUILTINS = ("Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebFetch", "WebSearch")
WEB = ("WebFetch", "WebSearch")
ACCESS_KIND = "claude-access"  # the chat's error record when Claude cannot be reached (the frontend's setup card)
API_ERROR_KIND = "api-error"
NOTES_HEAD = "(thimble, since your last turn:)"
MAIN_MODEL = "claude-opus-5-5"
PRIVATE_FILES = ("claude-access.json", "anthropic-api-key", "server.json", "session.key", "paired.json")
NEW = "new"  # the register route's `chat` for a new chat of main (open_chat)
CHAT_CHIP = "session"  # the kind of main's line where a chat starts or comes back (session.CHIP_KIND)
NEW_CHAT = "New chat"
RESUMED_CHAT = "Resumed the chat that began with: {first}"
SID_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
EVENT_BODY_RE = re.compile(r'^\s*<thimble-event\s[^>]*?kind="([^"]*)"[^>]*>\n?(.*?)\n?</thimble-event>\s*$', re.S)
EVENT_ID_RE = re.compile(r'^\s*<thimble-event\s[^>]*?\bevent="([^"]*)"')
EVENT_IDS_RE = re.compile(r'<thimble-event\s[^>]*?\bevent="([^"]*)"')  # the ids of the events a prompt carries (rewind)
REWIND_CHIP = "rewind"  # the kind of main's line where a rewind cut its chat (rewind_main), which names the message
REWOUND = ("Rewound to before your message. Claude no longer sees it or anything after it; files and cards it changed "
           "stay as they are.")


def enabled() -> bool:
    return os.environ.get(ENV, "on").strip().lower() not in ("off", "0", "no", "false")


def engine() -> str:
    """'api' (an API key or WIF), 'cc' (Claude Code sign-in), or '' before a choice."""
    from . import claude_access  # noqa: PLC0415

    h = claude_access.how()
    if h == claude_access.CLAUDE_CODE:
        return "cc"
    return "api" if h in (claude_access.API_KEY, claude_access.WIF) else ""


def network() -> str:
    """Where the shell commands of main and its agents reach, as Settings' row for main (ledger.agent_rows) and the prompt
    of the main this server runs (events.network_words) say: "on" with an API key or WIF, any host, unasked; else "ask",
    where on Claude Code sign-in a request to a host the analyst has not allowed asks them first (host_asks)."""
    return "on" if engine() == "api" else "ask"


def uses_api() -> bool:
    """Whether model calls go to the Messages API from this process (model.structured)."""
    return enabled() and engine() != "cc"


def shell_temp(c: str) -> Path:
    """The TMPDIR of the shell commands of main and its thread forks in workspace `c`, which every card kernel of the
    workspace shares (notebook), so a card's code reads what such a command wrote in $TMPDIR: on the Messages API, the
    workspace's temp folder, which runtime_tools.Box gives them (config.temp_dir); on Claude Code sign-in, the temp
    folder Claude Code's sandbox gives them in the workspace's short folder (runtime_cc.shell_tmp), or the workspace's
    temp folder when there is none."""
    from . import config, runtime_cc  # noqa: PLC0415

    if engine() == "cc" and (t := runtime_cc.shell_tmp(c)) is not None:
        return t
    return config.temp_dir(c)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class AccessProblem(Exception):
    """Claude cannot be reached the way chosen: {what, fix}."""

    def __init__(self, problem: dict[str, str]) -> None:
        super().__init__(f"{problem.get('what', '')} {problem.get('fix', '')}".strip())
        self.problem = problem


class Refused(Exception):
    """A reply Claude's safeguards declined, in the words the chat shows."""


# --------------------------------------------------------------------------- transcripts


class Transcript:
    """One agent's transcript in Claude Code's record shapes, appended line by line; the mirror reads it."""

    def __init__(self, path: Path, sid: str, agent_id: str | None = None) -> None:
        self.path, self.sid, self.agent_id = path, sid, agent_id
        self.last: str | None = None

    def emit(self, rec: dict[str, Any]) -> dict[str, Any]:
        full = {"parentUuid": self.last, "isSidechain": self.agent_id is not None, "sessionId": self.sid,
                **({"agentId": self.agent_id} if self.agent_id else {}), "uuid": str(uuid.uuid4()),
                "timestamp": _now(), **rec}
        # in the workspace, which a card's code writes: never through a link put there (nofollow)
        nofollow.append_bytes(self.path, (json.dumps(full, ensure_ascii=False) + "\n").encode("utf-8"), make=True)
        self.last = full["uuid"]
        return full

    def write_meta(self, meta: dict[str, Any]) -> None:
        p = self.path.with_name(self.path.name[: -len(".jsonl")] + ".meta.json")
        nofollow.write_text(p, json.dumps(meta), make=True)


# --------------------------------------------------------------------------- what an agent is


@dataclass
class Spec:
    """What one turn of an agent runs with: the same for both engines."""
    system: str
    builtins: list[str]
    thimble: list[str]
    model: str
    effort: str
    cwd: Path
    workspace: Path
    read_roots: list[Path]
    write_roots: list[Path]
    private: list[Path]
    home: Path
    # main's and its thread forks' commands' TMPDIR, which they share with the kernels (shell_temp), so a card's code
    # reads what Bash wrote in $TMPDIR: on the Messages API runtime_tools.Box gives it them (when not inside `home`),
    # and in a headless Claude Code session its sandbox does, in the workspace's short TMPDIR
    # (runtime_cc.workspace_tmp). None for thimble's other agents, whose commands have a TMPDIR of their own
    temp: Path | None = None
    fast: bool = False
    # whether the corpus is among write_roots (Settings' "Claude can edit files in this folder"): True or False for
    # main and its thread forks, which the switch reaches, None for thimble's other agents, which never write it
    corpus_edits: bool | None = None
    no_write: list[Path] = field(default_factory=list)  # the workspace's protected files, never written (protected)


@dataclass
class TurnEnd:
    status: str  # done, failed, stopped
    text: str = ""
    error: str = ""


@dataclass
class Conv:
    """One agent's conversation: main, a thread's fork or one of thimble's agents."""
    space: "Space"
    id: str
    kind: str  # main | fork | agent
    agent_id: str | None = None
    agent_type: str = ""
    role: str = ""
    values: dict[str, Any] = field(default_factory=dict)
    key: str = ""  # the key of the start it runs for (subagents' request), such as `view:<slug>` (agent_writes)
    transcript: Transcript | None = None
    queue: list[str] = field(default_factory=list)
    # set as a message joins the queue (deliver), so a Claude Code session of main's hands it on while its turn runs
    # (runtime_cc._hand)
    arrived: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    last_text: str = ""
    base: str | None = None  # a fork's source conversation (main), copied at its first turn
    switched: str | None = None  # the model Claude's safeguards answer this conversation on instead (switches)

    @property
    def c(self) -> str:
        return self.space.c

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    def state_path(self, engine_kind: str) -> Path:
        """The engine's state of the conversation: main's is its current chat's (Space.switch)."""
        if self.kind == "main":
            return self.space.dir / "convs" / f"{MAIN}-{self.space.sid}.{engine_kind}.json"
        return self.space.dir / "convs" / f"{self.id}.{engine_kind}.json"

    def emit(self, rec: dict[str, Any]) -> dict[str, Any]:
        assert self.transcript is not None
        got = self.transcript.emit(rec)
        self.space.read()
        return got

    def emit_assistant(self, blocks: list[dict[str, Any]], model: str, usage: dict[str, Any] | None = None, *,
                       asked: str = "", told: list[dict[str, Any]] | None = None) -> None:
        """A reply of `model`, after the records of a switch to it from `asked`, the model the request was for
        (switches)."""
        for rec in self.switches(asked, model, told or []):
            self.emit(rec)
        if not blocks:
            return
        from . import tools  # noqa: PLC0415

        shown = []
        for b in blocks:
            if b.get("type") == "tool_use" and tools.known(str(b.get("name"))):
                b = {**b, "name": tools.thimble_tool(str(b["name"]))}
            if b.get("type") == "text":
                self.last_text = str(b.get("text") or "").strip() or self.last_text
            shown.append(b)
        self.emit({"type": "assistant", "message": {"id": f"msg_{secrets.token_hex(8)}", "type": "message",
                                                     "role": "assistant", "model": model, "content": shown,
                                                     "usage": usage or {}}})

    def switches(self, asked: str, model: str, told: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The records of Claude's safeguards answering this conversation on another model than the one asked for
        (session.FALLBACK_SUBTYPE, as Claude Code writes them), which the mirror tells as a notice in its chat: the
        reply's own (`told`: a Messages API reply's `fallback` blocks), else one for a reply of `model` when it is not
        `asked` and the replies were not on it already, as a reply sticky routing sends straight to the fallback
        model, and a Claude Code reply on its own fallback, come with none. A reply on the model asked for ends the
        switch, so a later one is told again."""
        from . import config, session  # noqa: PLC0415

        got = "" if not model or model.startswith("<") else config.base_model(model)
        if told:
            self.switched = config.base_model(str(told[-1].get("fallbackModel") or "")) or got or None
            return told
        if not got or not asked:
            return []
        if config.same_model(got, asked):
            self.switched = None
            return []
        if self.switched and config.same_model(got, self.switched):
            return []
        self.switched = got
        return [{"type": "system", "subtype": session.FALLBACK_SUBTYPE, "direction": "retry",
                 "originalModel": config.base_model(config.exact_model(asked)), "fallbackModel": got}]

    def live_text(self, piece: str, text: str | None) -> None:
        """Main's words while Claude writes them, to the pages that are open (investigation.push, a `chat-live`
        record): `text` is the message's text so far, as the chat will show it (session.visible), and None says the
        message is complete, so the page drops the words once its log holds the message (emit_assistant). Only main's
        reply streams: a thread's fork answers with reply_in_thread, and an agent's steps show as they end. Never
        raises."""
        if self.kind != "main":
            return
        from . import agents, investigation, session  # noqa: PLC0415

        rec: dict[str, Any] = {"type": "chat-live", "chat": agents.MAIN_ID, "piece": piece}
        if text is None:
            rec["end"] = True
        else:
            rec["text"] = _live_shown(session.visible(text))
        try:
            investigation.push(self.c, investigation.MAIN, rec)
        except Exception:  # noqa: BLE001 — the words still arrive with the message
            log.debug("%s: live text not pushed", self.c, exc_info=True)

    def emit_results(self, results: list[dict[str, Any]]) -> None:
        if results:
            self.emit({"type": "user", "message": {"role": "user", "content": results}})

    def waiting_messages(self) -> list[str]:
        """The messages the analyst typed in main's chat while its turn ran (Space.said), in main's queue, oldest first.
        Every other event, such as a /thimble-fix request, which Claude Code too keeps for the turn's end as it keeps a
        command, waits for the turn to end, and so does any other conversation's queue."""
        if self.kind != "main":
            return []
        return [t for t in self.queue if (m := EVENT_ID_RE.match(t)) and m.group(1) in self.space.said]

    def take_waiting(self) -> list[str]:
        """The analyst's messages that wait for main's running turn, read now, with the results of the turn's tool
        calls, as Claude Code gives a message typed mid-turn to the model at its next tool call (heard)."""
        got = self.waiting_messages()
        for text in got:
            self.heard(text)
        return got

    def heard(self, text: str) -> None:
        """Main read `text`, a message that waited in its queue, in its running turn: it leaves the queue, the
        transcript records it as Claude Code records a message typed mid-turn (a queued_command attachment, which the
        mirror reads as an event of the turn), and the analyst's line goes into main's chat here (Space.said_line)."""
        with contextlib.suppress(ValueError):
            self.queue.remove(text)
        self.emit({"type": "attachment", "attachment": {"type": "queued_command", "prompt": text,
                                                       "origin": {"kind": "task-notification"}}})
        self.space.said_line(text)

    def spec(self) -> Spec:
        return self.space.spec_of(self)

    async def call_thimble(self, name: str, args: dict[str, Any], tool_use_id: str) -> Any:
        """One of thimble's tools, as 0.8's MCP shim and call route ran it: the caller's line first (who made the
        call), then the call as that caller's session (tools._as_caller), so a fork's call runs as main's own and an
        agent's as its role's. Main's result carries the quiet events that came while its turn runs, such as the
        analyst's choice in a label's ask (events.with_held)."""
        from . import events, subagent_files as files, tools  # noqa: PLC0415

        files.add_caller(self.space.ws, tool_use_id, self.agent_id or "", self.agent_type or "")
        refused, session = await tools._as_caller(self.c, name, tool_use_id)
        if refused:
            return tools.err(refused)
        res = await tools.call(self.c, name, args, session=session, tool_use_id=tool_use_id)
        return events.with_held(self.c, res) if self.kind == "main" else res

    def take_notes(self) -> list[str]:
        """What waits for this conversation's next turn: the notes kept for it (Space.tell), then those about the cards
        it made that no call of its own took yet (card_size.take)."""
        from . import card_size  # noqa: PLC0415

        author = self.card_author()
        return [*self.space.take_notes(self.id), *(card_size.take(self.c, author) if author else [])]

    def card_author(self) -> str | None:
        """The `created_by` of the cards this conversation makes (tools.Ctx.cell_author): main's are the terminal's, a
        thread's fork's its thread's chat. None for one of thimble's agents, whose calls alone take its notes."""
        from . import session, tools  # noqa: PLC0415

        if self.kind == "main":
            return tools.TERMINAL
        chat = session.chat_of_agent(self.c, self.agent_id) if self.kind == "fork" else None
        return f"chat:{chat}" if chat else None


# --------------------------------------------------------------------------- one workspace


class Space:
    def __init__(self, c: str) -> None:
        from . import config  # noqa: PLC0415

        self.c = c
        self.ws = config.workspace_dir(c)
        self.corpus = config.corpus_dir(c)
        self.dir = self.ws / DIR  # in the workspace: its files are written and moved as nofollow does
        nofollow.makedirs(self.dir)
        # main's chat names main's files (main_path, Conv.state_path), and a card's code writes main.json: a chat id no
        # route would take (SID_OK) is none, and main starts a new chat
        kept = str(_read_json(self.dir / "main.json").get("session") or "")
        self.sid = kept if SID_OK.match(kept) else str(uuid.uuid4())
        if self.sid != kept:
            nofollow.write_text(self.dir / "main.json", json.dumps({"session": self.sid, "at": _now()}))
        for kind in ("api", "cc"):  # main's state from before chats were kept apart is its chat's
            old, new = self.dir / "convs" / f"{MAIN}.{kind}.json", self.dir / "convs" / f"{MAIN}-{self.sid}.{kind}.json"
            if old.is_file() and not new.exists():
                with contextlib.suppress(OSError):
                    nofollow.rename(old, new)
        self.main = self._main_conv()
        self.convs: dict[str, Conv] = {}
        self.notes: dict[str, list[str]] = {}
        # by event id, the analyst's words of each message that came while main's turn ran (events.post): main's chat
        # shows them waiting (unread), and their line goes in where main reads them (said_line)
        self.said: dict[str, str] = {}
        # by event id, the quiet events that rode along with an event for main (events._publish) while it waits in
        # main's queue: a rewind that takes the event back holds them again for main's next event (take_back)
        self.riders: dict[str, list[dict[str, Any]]] = {}

    def _main_conv(self) -> Conv:
        tr = Transcript(self.main_path, self.sid)
        tr.last = _last_uuid(self.main_path)  # a chat brought back goes on from its last record
        return Conv(self, MAIN, "main", transcript=tr)

    async def switch(self, sid: str | None) -> bool:
        """Make chat `sid` main, or a new chat for None: main's running turn stops and what waited for it goes
        (drop_waiting), runtime/main.json names the chat, the mirror follows its transcript (session.attach, which reads
        a chat brought back from its end), and main's log gets one line that says so. A new chat while main's chat has
        no turn yet is that chat. False when nothing changed. ValueError for an id that is no chat of this workspace."""
        from . import agents  # noqa: PLC0415

        if sid is not None and (not SID_OK.match(sid) or not (self.dir / f"{sid}.jsonl").is_file()):
            raise ValueError(f"no chat {sid} in this workspace")
        if sid == self.sid or (sid is None and not _chat_of(self.main_path)["turns"]):
            self.attach()
            return False
        self.drop_waiting()
        if self.main.running:
            await _cancel(self.main.task)
        self.sid = sid or str(uuid.uuid4())
        nofollow.write_text(self.dir / "main.json", json.dumps({"session": self.sid, "at": _now()}))
        self.main = self._main_conv()
        self.attach()
        if sid is None:
            agents.chip(self.c, CHAT_CHIP, NEW_CHAT)
        else:
            got = _chat_of(self.main_path)
            agents.chip(self.c, CHAT_CHIP, RESUMED_CHAT.format(first=got["first"] or "a chat"))
        return True

    @property
    def main_path(self) -> Path:
        return self.dir / f"{self.sid}.jsonl"

    def sub_path(self, agent_id: str) -> Path:
        return self.dir / self.sid / "subagents" / f"agent-{agent_id}.jsonl"

    def attach(self) -> None:
        """Main is the mirror's session, with the effort it runs at while the composer chose none (spec_of), for the
        composer's chip."""
        from . import cc_settings, session  # noqa: PLC0415

        lv = session.current(self.c)
        if lv is None or lv.sid != self.sid:
            model = str(_main_choice(self.ws).get("model") or MAIN_MODEL)
            session.attach(self.c, self.sid, str(self.corpus), transcript_path=str(self.main_path),
                           effort=cc_settings.session_effort(self.corpus, model))

    def live(self) -> Any:
        from . import session  # noqa: PLC0415

        lv = session.current(self.c)
        if lv is None or lv.sid != self.sid:
            self.attach()
            lv = session.current(self.c)
        return lv

    def read(self) -> None:
        """The mirror reads what the transcripts gained, now."""
        from . import session  # noqa: PLC0415

        lv = self.live()
        if lv is not None:
            session._read_now(lv)

    def scan(self) -> None:
        from . import session  # noqa: PLC0415

        lv = self.live()
        if lv is not None and not lv.reading:
            with contextlib.suppress(Exception):
                session._scan_subs(lv)
            session._read_now(lv)

    # ---- notes for a conversation's next turn

    def tell(self, conv_id: str, text: str) -> None:
        if text:
            self.notes.setdefault(conv_id, []).append(text)

    def take_notes(self, conv_id: str) -> list[str]:
        return self.notes.pop(conv_id, [])

    # ---- the analyst's messages that wait for main

    def said_line(self, text: str) -> None:
        """The analyst's line of `text`, a browser event main reads now (Conv.heard, _main_loop) or never will
        (drop_waiting), into main's chat, when it is a message that waited for main's turn: events.post logs the line of
        any other as it posts it. The quiet events the event carried (riders) leave with it."""
        from . import agents  # noqa: PLC0415

        m = EVENT_ID_RE.match(text)
        words = self.said.pop(m.group(1), None) if m else None
        if m:
            self.riders.pop(m.group(1), None)
        if m and words is not None:
            agents.mirror(self.c, "user", by=agents.BROWSER, text=words, event=m.group(1))

    def drop_waiting(self) -> None:
        """What waits for main goes unread (main's chat changes, the workspace's folder goes, the server stops): the
        analyst's messages among it still get their lines in main's chat, as they sent them."""
        for text in self.main.queue:
            self.said_line(text)
        self.main.queue.clear()

    def take_back(self, logged: dict[str, str]) -> list[tuple[str, str]]:
        """What a rewind takes back of what waits for main (rewind_main): each message the analyst typed in main's chat
        while its turn ran (said), and the event of each message of the analyst's that the rewind hides and main has
        not read (`logged`: the words of each, by event id, such as a /thimble-fix's), leave main's queue unread, and
        the quiet events they carried wait again for main's next event (events.hold_again). (event id, words) of each,
        oldest first, for the composer. Every other event, such as an agent's report or a notice of thimble's, stays
        for main's next turn."""
        from . import events  # noqa: PLC0415

        taken: list[tuple[str, str]] = []
        kept: list[str] = []
        riders: list[dict[str, Any]] = []
        for text in self.main.queue:
            m = EVENT_ID_RE.match(text)
            eid = m.group(1) if m else ""
            words = self.said.pop(eid, None) if eid else None
            if words is None:
                words = logged.get(eid) if eid else None
            if words is None:
                kept.append(text)
                continue
            taken.append((eid, words))
            riders += self.riders.pop(eid, [])
        self.main.queue[:] = kept
        if riders:
            events.hold_again(self.c, riders)
        return taken

    # ---- what each agent runs with

    def private(self) -> list[Path]:
        from . import cli  # noqa: PLC0415

        home = cli.home().expanduser()
        return [home / n for n in PRIVATE_FILES]

    def spec_of(self, conv: Conv) -> Spec:
        from . import cc_settings, config, events, ledger, runtime_tools, subagents, tools, userconf  # noqa: PLC0415

        tmp = self.dir / "tmp" / conv.id
        nofollow.makedirs(tmp)
        temp: Path | None = None
        reads = [self.corpus, self.ws, config.REPO_ROOT / "docs", config.REPO_ROOT / "plugin" / "viewers",
                 config.REPO_ROOT / "frontend" / "src" / "kit"]
        if conv.kind in ("main", "fork"):
            # main and its thread forks write the corpus, as Claude Code does in its folder, unless the analyst turned
            # "Claude can edit files in this folder" off in Settings (ledger.corpus_edits)
            edits: bool | None = ledger.corpus_edits(self.c)
            system = events.session_prompt(str(self.corpus), edits=edits)
            names = [s.name for s in tools.REGISTRY.values()
                     if tools.ANALYST in s.roles and (not s.sessions or None in s.sessions)]
            builtins = list(MAIN_BUILTINS)
            choice = _main_choice(self.ws)
            model = str(choice.get("model") or MAIN_MODEL)
            # the composer's effort, else the one Claude Code in a terminal runs the model at by the analyst's
            # settings, as the level it runs at (ultracode's is xhigh)
            effort = config.effort_level(choice.get("effort") or cc_settings.session_effort(self.corpus, model))
            temp = shell_temp(self.c)  # their commands' TMPDIR, the kernels' too (Spec.temp)
            writes = [*([self.corpus] if edits else []), self.ws / "card-libs", tmp, temp]
            fast = bool(choice.get("fast"))
        else:
            role = subagents.roles(self.c).get(conv.role) or {}
            prompt = str(role.get("prompt") or "")
            skills = role.get("skills") or []
            if any(str(s).endswith("shared") for s in skills):
                prompt = f"{prompt}\n\n{events.render_prompts(['shared'], str(self.corpus))}"
            system = prompt
            denied = set(role.get("disallowedTools") or [])
            own = subagents.own_tools(conv.role)
            names = [s.name for s in tools.REGISTRY.values() if tools.ANALYST in s.roles
                     and (own is None or s.name in own) and tools.thimble_tool(s.name) not in denied]
            builtins = [b for b in AGENT_BUILTINS if b not in denied]
            if role.get("tools"):
                builtins = [b for b in builtins if b in role["tools"]]
            model = str(conv.values.get("model") or role.get("model") or MAIN_MODEL)
            effort = str(conv.values.get("effort") or role.get("effort") or "")
            writes = [*agent_writes(self.c, conv), tmp]
            edits = None  # writers, view builds and reviews, and checks keep the corpus read-only
            fast = False
            with contextlib.suppress(Exception):
                for d in writes:
                    nofollow.makedirs(d)
        cwd = self.corpus
        if conv.kind == "fork" and conv.role == FIXER:
            # thimble fix's fixer (fixes.py): main's conversation and tools, and Edit and Write, in the fix's copy of
            # thimble, which it alone writes, with its temp folder. Claude Code resumes main's session only from
            # main's folder, so there the copy is an added folder
            from . import fixes  # noqa: PLC0415

            work, more, writes = fixes.fixer_roots(int(conv.values.get("fix") or 0))
            writes, temp = [*writes, tmp], None
            reads = [*reads, *more]
            builtins = [*builtins, *(b for b in ("Edit", "Write") if b not in builtins)]
            edits = None
            if engine() == "api":
                cwd = work
        with contextlib.suppress(Exception):
            if userconf.main_web_off(self.c):  # Settings' row for main, which main's prompt follows too
                builtins = [b for b in builtins if b not in WEB]
        # a protected folder that holds one of the agent's own write folders is left out, since the agent writes only
        # in those: a view's builder writes extension/views/<slug> (agent_writes), and nothing else of extension/
        no_write = [p for p in protected(self.ws) if not any(p in w.parents for w in writes)]
        return Spec(system=system, builtins=runtime_tools.available(builtins) if engine() == "api" else builtins,
                    thimble=names, model=model, effort=effort, cwd=cwd, workspace=self.ws,
                    read_roots=reads, write_roots=writes, private=self.private(), home=tmp, temp=temp, fast=fast,
                    corpus_edits=edits, no_write=no_write)


def agent_writes(c: str, conv: Conv) -> list[Path]:
    """The folders one of thimble's agents writes. A view's builder and its reviewer write that view's folder,
    extension/views/<slug>, and their own folder, views-work/<slug> (dev.view_work_dir), alone: the slug is the one of
    the start the server recorded for the agent (Conv.key, `view:<slug>` or `review:<slug>`), never one the agent
    names. Every other agent writes the agents' work folders (subagents.write_dirs) less the folders that hold the
    views' builders' folders, so no agent's command can put a link in place of a folder the sandbox of a builder's
    command binds by its path; an agent of a view's role without such a key writes nothing but its temp folder."""
    from . import config, dev, subagents, tools, view_tools, views  # noqa: PLC0415

    kinds = {view_tools.BUILDER: tools.VIEW_SESSION, view_tools.REVIEWER: tools.REVIEW_SESSION}
    views_root = views.views_dir(c)
    if conv.role in kinds:
        slug = view_tools.slug_of(conv.key)
        if tools.session_kind(conv.key) != kinds[conv.role] or not views.SLUG_RE.fullmatch(slug):
            return []
        return [views_root / slug, dev.view_work_dir(c, slug)]
    builders = (views_root, config.workspace_dir(c) / dev.VIEWS_WORK)
    return [w for w in subagents.write_dirs(c) if w not in builders]


def protected(ws: Path) -> list[Path]:
    """The workspace's files no agent writes: its hidden files and its locks folder, and the files and folders
    kernel_wrap keeps from agents' commands (READ_ONLY_FILES, READ_ONLY_DIRS). They matter where a write root holds
    the workspace, as a corpus folder that holds thimble's home would."""
    from . import kernel_wrap  # noqa: PLC0415

    return [ws / n for n in (*kernel_wrap.HIDDEN_FILES, kernel_wrap.LOCKS_DIR, *kernel_wrap.READ_ONLY_FILES,
                             *kernel_wrap.READ_ONLY_DIRS)]


def _read_json(p: Path) -> dict[str, Any]:
    try:  # in the workspace's runtime folder: never read through a link a card's code left there (nofollow)
        got = json.loads(nofollow.read_text(p))
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _last_uuid(path: Path) -> str | None:
    try:  # in the workspace, which a card's code writes: never through a link or a FIFO left there (nofollow)
        with nofollow.reader(path) as f:
            f.seek(max(0, os.fstat(f.fileno()).st_size - 65536))
            lines = f.read().splitlines()
    except OSError:
        return None
    for ln in reversed(lines):
        with contextlib.suppress(ValueError):
            rec = json.loads(ln)
            if isinstance(rec, dict) and rec.get("uuid"):
                return str(rec["uuid"])
    return None


def _chat_of(path: Path) -> dict[str, Any]:
    """{turns, first, start}: how many turns a main transcript holds (the user records that open one), the first message
    the analyst typed in it, as one line, and when its first turn began (the record's timestamp, '' when none)."""
    turns, first, other, start = 0, "", "", ""
    try:  # as _last_uuid reads it
        f = nofollow.reader(path, "r", encoding="utf-8")
    except OSError:
        return {"turns": 0, "first": "", "start": ""}
    with f:
        for ln in f:
            try:
                rec = json.loads(ln)
            except ValueError:
                continue
            content = (rec.get("message") or {}).get("content") if isinstance(rec, dict) else None
            if rec.get("type") != "user" or not isinstance(content, str):
                continue
            turns += 1
            start = start or str(rec.get("timestamp") or "")
            if first:
                continue
            m = EVENT_BODY_RE.match(content)
            body = " ".join((m.group(2) if m else content).split())
            if m and m.group(1) == "main":
                first = body
            elif not other:
                other = body
    return {"turns": turns, "first": first or other, "start": start}


def main_chats(c: str) -> list[dict[str, Any]]:
    """The workspace's chats of main that hold a turn, the latest first (chats_in)."""
    from . import config  # noqa: PLC0415

    return chats_in(config.workspace_dir(c) / DIR)


def chats_in(d: Path) -> list[dict[str, Any]]:
    """The chats of main that hold a turn in a workspace's runtime folder `d`, the latest first: {id, at (the last
    write, epoch seconds), turns, first (the first message), start (when its first turn began), current (main's now)}.
    Reads only, so it lists a session moved aside as well (folder_sessions)."""
    now = str(_read_json(d / "main.json").get("session") or "")
    out = []
    for p in d.glob("*.jsonl") if d.is_dir() else ():
        sid = p.name[: -len(".jsonl")]
        if not SID_OK.match(sid):
            continue
        got = _chat_of(p)
        if got["turns"]:
            out.append({"id": sid, "at": p.stat().st_mtime, **got, "current": sid == now})
    return sorted(out, key=lambda r: r["at"], reverse=True)


def open_chat(c: str, chat: str) -> bool:
    """Space.switch from a request's thread (the register route): `chat` is "new" or a chat's id. Waits for the switch;
    False when the runtime is off or did not change chats. ValueError for an unknown id."""
    if not enabled() or _loop is None or not _loop.is_running():
        return False

    async def go() -> bool:
        return await ensure(c).switch(None if chat == NEW else chat)

    return asyncio.run_coroutine_threadsafe(go(), _loop).result(timeout=30)


def _live_shown(text: str) -> str:
    """A text that is still being written, without a last line that may be the start of the end token (main's
    `(shown in the dashboard)`, which the chat never shows), so it does not flash before the token is complete."""
    from . import session  # noqa: PLC0415

    head, _, tail = text.rpartition("\n")
    t = tail.strip().strip("*_").lower()
    if t.startswith("(") and session.END_TOKEN.lower().startswith(t.rstrip(".")):
        return head.rstrip()
    return text


def _main_choice(ws: Path) -> dict[str, Any]:
    from . import config  # noqa: PLC0415

    got = _read_json(ws / "settings.json").get(config.MODELS_KEY) or {}
    main = got.get("main") if isinstance(got, dict) else None
    return main if isinstance(main, dict) else {}


_spaces: dict[str, Space] = {}
_loop: asyncio.AbstractEventLoop | None = None


def ensure(c: str) -> Space:
    """The workspace's runtime, with main attached as the mirror's session."""
    global _loop
    with contextlib.suppress(RuntimeError):
        _loop = asyncio.get_running_loop()
    sp = _spaces.get(c)
    if sp is None:
        sp = _spaces[c] = Space(c)
    sp.attach()
    return sp


async def forget(c: str) -> None:
    """The workspace's folder goes (ledger: moved aside for a new session, or deleted): what waited for main goes
    (Space.drop_waiting), its conversations' running turns stop, awaited, so none writes into the folder that takes its
    place, and its runtime is dropped, so the next ensure reads that folder (a new session's empty one, or a session
    brought back)."""
    sp = _spaces.pop(c, None)
    if sp is None:
        return
    sp.drop_waiting()
    for conv in [sp.main, *sp.convs.values()]:
        if conv.running:
            conv.queue.clear()
            await _cancel(conv.task)


def ensure_soon(c: str) -> None:
    """ensure(c) on the server's loop, from any thread; nothing when the runtime is off."""
    if not enabled() or _loop is None or not _loop.is_running():
        return

    def go() -> None:
        try:
            ensure(c)
        except Exception:  # noqa: BLE001 — a workspace that cannot attach now attaches at its first event
            log.exception("%s: main was not attached", c)

    _loop.call_soon_threadsafe(go)


def spaces() -> list[Space]:
    return list(_spaces.values())


# --------------------------------------------------------------------------- turns


async def _engine_turn(conv: Conv, text: str) -> TurnEnd:
    from . import claude_access  # noqa: PLC0415

    problem = claude_access.problem()
    kind = engine()
    if problem or not kind:
        raise AccessProblem(problem or {"what": "thimble does not know how to reach Claude.", "fix": ""})
    notes = conv.take_notes()
    if notes:
        text = "\n".join([NOTES_HEAD, *notes, "", text])
    if kind == "api":
        from . import runtime_api  # noqa: PLC0415

        return await runtime_api.turn(conv, text)
    from . import runtime_cc  # noqa: PLC0415

    return await runtime_cc.turn(conv, text)


def _access_record(conv: Conv, problem: dict[str, str]) -> None:
    """The one card that says Claude cannot be reached and how to fix it, in the conversation's chat."""
    from . import agents, session  # noqa: PLC0415

    fields = {"kind": ACCESS_KIND, "message": problem.get("what") or "Claude cannot be reached.",
              "detail": problem.get("fix") or "", "action": "claude-access"}
    lv = conv.space.live()
    if conv.kind == "main":
        if lv is not None:
            session._rec(lv, "error", **fields)  # the turn wrote something, so it ends with `done`
        else:
            agents.mirror(conv.c, "error", by=agents.TERMINAL, **fields)
        return
    sub = session._sub_by(lv, agent_id=conv.agent_id) if lv is not None else None
    if sub is not None:
        sub.rec.record("error", **fields)


def _api_error_record(conv: Conv, message: str) -> None:
    from . import agents, session  # noqa: PLC0415

    lv = conv.space.live()
    if conv.kind == "main":
        if lv is not None:
            session._rec(lv, "error", kind=API_ERROR_KIND, message=message)
        else:
            agents.mirror(conv.c, "error", by=agents.TERMINAL, kind=API_ERROR_KIND, message=message)
        return
    sub = session._sub_by(lv, agent_id=conv.agent_id) if lv is not None else None
    if sub is not None:
        sub.rec.record("error", kind=API_ERROR_KIND, message=message)


async def _run(conv: Conv, text: str) -> TurnEnd:
    """One turn of `conv` on `text`, its failures written where the analyst sees them."""
    from . import llm  # noqa: PLC0415

    try:
        return await _engine_turn(conv, text)
    except asyncio.CancelledError:
        raise
    except AccessProblem as e:
        _access_record(conv, e.problem)
        return TurnEnd("failed", error=str(e))
    except Exception as e:  # noqa: BLE001 — every failure is a line the analyst reads
        if llm.credentials_failure(e):
            _access_record(conv, {"what": llm.failure(e), "fix": "Check how thimble reaches Claude in Settings."})
            return TurnEnd("failed", error=llm.failure(e))
        log.warning("%s: %s's turn failed: %s", conv.c, conv.id, type(e).__name__, exc_info=True)
        _api_error_record(conv, _failure_text(e))
        return TurnEnd("failed", error=_failure_text(e))


def _failure_text(e: BaseException) -> str:
    from . import llm  # noqa: PLC0415

    if isinstance(e, Refused):
        return str(e)
    try:
        return llm.failure(e)
    except Exception:  # noqa: BLE001
        return f"Claude stopped with an error: {type(e).__name__}"


# ---- main


def deliver(c: str, note: dict[str, Any]) -> None:
    """A browser event for main (events._publish): a thread's starts or continues its fork; any other starts a turn of
    main, or waits for main's running turn: a message the analyst typed in main's chat (`said`, events.post) until the
    turn's next tool call (Conv.take_waiting), any other event until the turn ends. Main's chat shows such a message
    waiting until main reads it (unread)."""
    from . import agents, events  # noqa: PLC0415

    sp = ensure(c)
    meta = note.get("meta") or {}
    text = events.render(note)
    if meta.get("kind") == events.THREAD:
        _thread(sp, meta, text)
        return
    main = sp.main
    main.queue.append(text)
    event = str(meta.get("event") or "")
    if note.get("riders"):  # the quiet events it carries (events._publish), which a rewind holds again (take_back)
        sp.riders[event] = list(note["riders"])
    if note.get("said"):
        sp.said[event] = str(note["said"])
        agents.notify(c, agents.MAIN_ID)
    if _in_loop():
        main.arrived.set()
    elif _loop is not None:
        _loop.call_soon_threadsafe(main.arrived.set)
    if not main.running:
        main.task = _spawn_task(_main_loop(sp), f"main:{c}")


def _spawn_task(coro: Any, name: str) -> asyncio.Task:
    loop = asyncio.get_running_loop() if _in_loop() else _loop
    if loop is None:
        raise RuntimeError("the runtime has no event loop")
    if _in_loop():
        return loop.create_task(coro, name=name)
    return asyncio.run_coroutine_threadsafe(_wrap(coro), loop)  # type: ignore[return-value]


async def _wrap(coro: Any) -> Any:
    return await coro


def _in_loop() -> bool:
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


async def _main_loop(sp: Space) -> None:
    main = sp.main
    while main.queue:
        text = main.queue.pop(0)
        t0 = time.monotonic()
        main.emit({"type": "user", "message": {"role": "user", "content": text}, "origin": {"kind": "task-notification"}})
        sp.said_line(text)
        try:
            # each label as main can read it in this turn is a version, which a citation of it is checked against
            await asyncio.to_thread(_keep_label_versions, sp.c)
            await _run(main, text)
        except asyncio.CancelledError:
            sp.read()
            raise
        main.emit({"type": "system", "subtype": "turn_duration", "durationMs": int((time.monotonic() - t0) * 1000)})


def _keep_label_versions(c: str) -> None:
    from . import label_versions  # noqa: PLC0415

    label_versions.keep_first(c)


async def abort_main(c: str) -> bool:
    """Stop main's running turn. What waited for it stays, and is main's next turn once the Stop is told (after_stop).
    False when no turn ran."""
    sp = ensure(c)
    main = sp.main
    if not main.running:
        return False
    await _cancel(main.task)
    return True


def after_stop(c: str) -> None:
    """The analyst's Stop of main is told (agents.interrupt_route: the stopped turn ended in main's chat, with its
    note), or a rewind is done (rewind_main): what waited for the stopped turn, such as a message the analyst sent
    while it ran (after a rewind, what it did not take back), is main's next turn. Nothing when the runtime is off or
    nothing waits."""
    sp = _spaces.get(c) if enabled() else None
    if sp is not None and sp.main.queue and not sp.main.running:
        sp.main.task = _spawn_task(_main_loop(sp), f"main:{c}")


def unread(c: str) -> list[dict[str, str]]:
    """The analyst's messages that came while main's turn ran and that main has not read yet, oldest first, for main's
    chat (agents._main_state): {event, text}. Empty when the runtime is off."""
    sp = _spaces.get(c) if enabled() else None
    if sp is None:
        return []
    out = []
    for text in sp.main.queue:
        m = EVENT_ID_RE.match(text)
        if m and m.group(1) in sp.said:
            out.append({"event": m.group(1), "text": sp.said[m.group(1)]})
    return out


async def _cancel(task: Any) -> None:
    """Cancel a conversation's task (an asyncio Task, or the future of one started from another thread) and wait for
    it to end."""
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await (task if isinstance(task, asyncio.Future) else asyncio.wrap_future(task))


# ---- rewind
#
# Rewind main to one of the analyst's messages, as Claude Code's /rewind restores a conversation: main's conversation
# goes back to where it stood before that message, so its next turn sees neither the message nor anything after it.
# The engine's state is cut there (_rewind_plan): the Messages API's message list is cut before the message's prompt,
# and the Claude Code session's next turn resumes it at the entry before that prompt as a fork (resume_session_at),
# which Claude Code keeps beside the session it leaves. A message main read mid-turn (Conv.take_waiting) is cut where
# main read it: on the Messages API inside the user message that carries it, whose results of the turn's tool calls
# stay, since those calls ran; on Claude Code before the queued_command entry Claude Code keeps it as. Main's log only
# grows: the rewind's line (REWIND_CHIP) names the message, and the page hides the records from that message to the
# line (rewound), so nothing that refers to a record by its place changes. The transcript the mirror reads is left
# whole. Files and cards are not put back: Claude's edits of the folder and its cards stay as they are (Undo takes a
# card back).
#
# Nothing the analyst typed is lost. The rewind stops main's running turn, and takes back what it hides that main never
# read: the messages the analyst sent while the turn ran, which wait for it (said), and the event of a message the
# chat logged as it was posted, such as a /thimble-fix, which waits for the turn's end. Their words come back in the
# composer after the message's own, oldest first (Space.take_back). Every other event that waits, such as an agent's
# report, is main's next turn, as after a Stop (after_stop). An ask before a request to a host that waits on main's
# chat (host_asks) ends with the stopped turn's session, unanswered, so nothing is allowed or kept.
#
# The workspace's files are read and written as nofollow opens them (main's log, its conversations' states, where
# removal is nofollow.unlink), and the Claude Code session's id and the entry it resumes at are checked
# (runtime_cc.session_id, resume_at) before the id names the session's transcript or either goes to Claude Code.


class RewindRefused(Exception):
    """Why main cannot be rewound to a message, in the words the page shows."""


UNREAD_SESSION = "thimble could not read main's Claude Code session, so it cannot rewind it."
UNCHANGED = "thimble could not change main's saved conversation, so it did not rewind it."
# the entries of a Claude Code transcript that a resumed conversation keeps, one of which it resumes at (_cc_cut)
RESUMABLE = ("user", "assistant", "attachment", "system")


def _analyst_message(rec: Any, event_id: str | None = None) -> bool:
    """Whether a record of main's log is a message the analyst sent from the page (events.post), `event_id`'s when
    given: what a rewind goes back to."""
    from . import agents  # noqa: PLC0415

    return (isinstance(rec, dict) and rec.get("type") == "user" and rec.get("by") == agents.BROWSER
            and bool(rec.get("event")) and (event_id is None or rec.get("event") == event_id))


def rewound(records: list[Any]) -> set[int]:
    """The places of main's records that a rewind hid: each rewind line hides the records from the message it names up
    to itself, the line staying. The page hides the same (frontend chat/model rewoundRecords)."""
    hidden: set[int] = set()
    for i, rec in enumerate(records):
        if not (isinstance(rec, dict) and rec.get("type") == "chip" and rec.get("kind") == REWIND_CHIP):
            continue
        start = next((j for j in range(i) if j not in hidden and _analyst_message(records[j], rec.get("event"))), None)
        if start is not None:
            hidden.update(range(start, i))
    return hidden


def _prompt_events(content: Any) -> set[str]:
    """The ids of the events a prompt carries: its text's `<thimble-event … event="…">` tags. A tool's result carries
    none, so a result that quotes a message is never its prompt."""
    if isinstance(content, str):
        return set(EVENT_IDS_RE.findall(content))
    if isinstance(content, list):
        return {e for b in content if isinstance(b, dict) and b.get("type") == "text"
                for e in EVENT_IDS_RE.findall(str(b.get("text") or ""))}
    return set()


def _api_cut(messages: list[Any], ids: set[str]) -> list[Any] | None:
    """Main's Messages API conversation cut before the first prompt that carries one of the events `ids`, None when
    none does: before the user message whose text carries it, or, for a message main read with the results of its tool
    calls (Conv.take_waiting), inside that user message, whose blocks before the message stay, since those calls ran."""
    for i, m in enumerate(messages):
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str):
            if _prompt_events(content) & ids:
                return messages[:i]
            continue
        for j, b in enumerate(content if isinstance(content, list) else []):
            if isinstance(b, dict) and b.get("type") == "text" and _prompt_events(b.get("text")) & ids:
                return [*messages[:i], *([{**m, "content": content[:j]}] if j else [])]
    return None


def _entry_events(entry: dict[str, Any]) -> set[str]:
    """The events an entry of a Claude Code transcript carries as a prompt: a user entry's text (a turn's prompt, or a
    message the session ran as its next turn), or a queued_command attachment's (a message the session read mid-turn,
    runtime_cc._hand)."""
    if entry.get("type") == "user":
        msg = entry.get("message")
        return _prompt_events(msg.get("content")) if isinstance(msg, dict) else set()
    att = entry.get("attachment")
    if entry.get("type") == "attachment" and isinstance(att, dict) and att.get("type") == "queued_command":
        return _prompt_events(att.get("prompt"))
    return set()


def _cc_cut(entries: list[dict[str, Any]], ids: set[str], kept: str | None) -> tuple[bool, str | None]:
    """Where main's Claude Code session resumes once it is cut before the first prompt among `entries` (its transcript,
    runtime_cc.session_entries) that carries one of the events `ids`: (found, the entry before that prompt that Claude
    Code keeps in a resumed conversation, or None when the prompt is the session's first). `kept`: where an earlier
    rewind left the session, which main's next turn has not taken up yet, so the entries after it are cut already.
    RewindRefused when that entry is not in the transcript."""
    from . import runtime_cc  # noqa: PLC0415

    if kept is not None:
        at = next((i for i, e in enumerate(entries) if e.get("uuid") == kept), None)
        if at is None:
            raise RewindRefused(UNREAD_SESSION)
        entries = entries[: at + 1]
    at = next((i for i, e in enumerate(entries) if _entry_events(e) & ids), None)
    if at is None:
        return False, None
    before = [e for e in entries[:at] if e.get("type") in RESUMABLE and runtime_cc.SESSION_ID_RE.match(e["uuid"])]
    return True, str(before[-1]["uuid"]) if before else None


def _rewind_plan(conv: Conv, ids: set[str]) -> list[tuple[Path, Any, Any]]:
    """How each engine's state of `conv` is cut before the first prompt that carries one of the events `ids`: (state
    file, what it holds next, that engine's save; None removes the file). An engine whose state holds none of them is
    left alone, since none of those messages reached it. RewindRefused when the Claude Code session's transcript
    cannot be read."""
    from . import runtime_api, runtime_cc  # noqa: PLC0415

    plan: list[tuple[Path, Any, Any]] = []
    api = conv.state_path("api")
    cut = _api_cut(runtime_api._load(api), ids)
    if cut is not None:
        plan.append((api, cut, runtime_api._save))
    cc = conv.state_path("cc")
    state = runtime_cc._load(cc)
    sid = runtime_cc.session_id(state)
    if sid:
        entries = runtime_cc.session_entries(sid)
        if not entries:
            raise RewindRefused(UNREAD_SESSION)
        found, at = _cc_cut(entries, ids, runtime_cc.resume_at(state))
        if found:
            plan.append((cc, {"session_id": sid, "resume_at": at} if at else None, runtime_cc._save))
    return plan


async def rewind_main(c: str, event_id: str) -> dict[str, Any]:
    """Rewind main to before the analyst's message `event_id` (module note above): main's running turn stops, its
    conversation is cut before the message, what main never read of what the rewind hides is taken back, and main's
    log gets the rewind's line; what else waited is main's next turn. {text: the message's words, then those of each
    message taken back, which the page puts back in the composer, event}. RewindRefused, with nothing changed, for a
    message the chat no longer shows and for a Claude Code session that cannot be read; when that read fails only
    once main's turn has stopped, or main's state cannot be changed, the turn stays stopped, as after a Stop."""
    from . import agents, session  # noqa: PLC0415

    sp = ensure(c)
    records = agents.read_events(agents.paths(c, agents.MAIN_ID)[1])
    hidden = rewound(records)
    shown = [i for i in range(len(records)) if i not in hidden and _analyst_message(records[i])]
    at = next((i for i in shown if records[i]["event"] == event_id), None)
    if at is None:
        raise RewindRefused("That message is not in main's chat any more.")
    # the message and each of the analyst's after it, by event id: the first of them the engine holds is where its
    # state is cut, and the rewind hides them all
    later = {str(records[i]["event"]): str(records[i].get("text") or "") for i in shown if i >= at}
    plan = _rewind_plan(sp.main, set(later))  # a session that cannot be read refuses it before anything changes
    if sp.main.running:
        await _cancel(sp.main.task)
        session.turn_stopped(c)
        try:
            plan = _rewind_plan(sp.main, set(later))  # again, as the stopped turn left main's states
        except RewindRefused:
            after_stop(c)  # the turn stopped all the same: what waited for it is main's next turn, as after a Stop
            raise
    try:
        for path, held, save in plan:
            if held is None:
                nofollow.unlink(path)  # in the workspace: the entry itself, never through a link a card's code left
            else:
                save(path, held)
    except OSError:  # such as a link a card's code left on the way (nofollow.Linked)
        log.warning("%s: main's conversation was not cut for the rewind", c, exc_info=True)
        after_stop(c)
        raise RewindRefused(UNCHANGED) from None
    taken = [words for eid, words in sp.take_back(later) if eid != event_id]
    agents.chip(c, REWIND_CHIP, REWOUND, event=event_id)
    after_stop(c)
    return {"text": "\n\n".join(w for w in [later[event_id], *taken] if w), "event": event_id}


# ---- threads


def _thread(sp: Space, meta: dict[str, Any], text: str) -> None:
    agent = str(meta.get("agent") or "")
    conv = sp.convs.get(agent) if agent else None
    if conv is None:
        name = str(meta.get("name") or "thread")
        agent_id = _agent_id()
        conv = Conv(sp, agent_id, "fork", agent_id=agent_id, agent_type=FORK_TYPE, base=MAIN,
                    transcript=Transcript(sp.sub_path(agent_id), sp.sid, agent_id))
        sp.convs[agent_id] = conv
        conv.transcript.write_meta({"agentType": FORK_TYPE, "isFork": True, "description": f"thread:{name}",
                                    "name": name})
        text = f"{text}\n\nthread:{name}"
    conv.queue.append(text)
    if not conv.running:
        conv.task = _spawn_task(_agent_loop(conv), f"fork:{sp.c}:{conv.id}")


def _agent_id() -> str:
    return "a" + secrets.token_hex(8)


async def _agent_loop(conv: Conv) -> None:
    """The runs of a fork or one of thimble's agents: each waiting message is a run, each ends where the mirror sees it
    end (the thread's fork finished, the agent's run ended)."""
    sp = conv.space
    while conv.queue:
        text = conv.queue.pop(0)
        first = conv.transcript is not None and not conv.transcript.path.exists()
        rec: dict[str, Any] = {"type": "user", "message": {"role": "user", "content": text}}
        if not first:
            rec["origin"] = {"kind": "coordinator"}
        conv.emit(rec)
        if first:
            sp.scan()
        status, report = "done", ""
        try:
            end = await _run(conv, text)
            status, report = end.status, end.text or conv.last_text or end.error
        except asyncio.CancelledError:
            status, report = "stopped", ""
            conv.queue.clear()
            _ended(conv, status, report)
            raise
        _ended(conv, status, report)


def _ended(conv: Conv, status: str, report: str) -> None:
    from . import session, subagents  # noqa: PLC0415

    sp = conv.space
    sp.read()
    lv = sp.live()
    if conv.kind == "fork":
        sub = session._sub_by(lv, agent_id=conv.agent_id) if lv is not None else None
        if sub is not None:
            session._finish_sub(lv, sub, status, report or None)
        return
    with contextlib.suppress(Exception):
        subagents.run_ended(conv.c, str(conv.agent_id), status, report or None, source="runtime")


# ---- the module's ops


async def module_op(c: str, op: str, args: dict[str, Any]) -> dict[str, Any]:
    """What thimble's plugin module did in main's session (module_bridge.request), done here: an Answer."""
    sp = ensure(c)
    if op == "register":
        return {"ok": True}
    if op == "spawn":
        return _spawn_agent(sp, args)
    if op == "send":
        conv = sp.convs.get(str(args.get("agent") or ""))
        if conv is None:
            return {"error": "the agent ended with the server that ran it", "gone": True}
        conv.values = dict(args.get("values") or conv.values)
        conv.queue.append(str(args.get("text") or ""))
        queued = conv.running
        if not queued:
            conv.task = _spawn_task(_agent_loop(conv), f"agent:{c}:{conv.id}")
        return {"agentId": conv.id, **({"queued": True} if queued else {})}
    if op == "stop":
        conv = sp.convs.get(str(args.get("agent") or ""))
        if conv is None or not conv.running:
            return {"error": "is not running", "gone": True}
        await _cancel(conv.task)
        return {"agentId": conv.id}
    if op == "abort":
        return {"ok": True} if await abort_main(c) else {"error": "no turn of main's ran", "gone": True}
    if op == "note":
        sp.tell(MAIN, str(args.get("text") or ""))
        return {"ok": True}
    return {"error": f"unknown op {op}"}


def _spawn_agent(sp: Space, args: dict[str, Any]) -> dict[str, Any]:
    from . import subagents  # noqa: PLC0415

    role = str(args.get("role") or "")
    if role not in subagents.TYPES:
        return {"error": f"no role {role}"}
    agent_id = _agent_id()
    values = dict(args.get("values") or {})
    # the key of the start this answers, from the server's own record of it (agent_writes)
    asked = subagents.request(sp.c, str(args.get("request") or "")) or {}
    key = str(asked.get("key") or "") if asked.get("role") == role else ""
    conv = Conv(sp, agent_id, "agent", agent_id=agent_id, agent_type=subagents.type_name(role), role=role, values=values,
                key=key, transcript=Transcript(sp.sub_path(agent_id), sp.sid, agent_id))
    sp.convs[agent_id] = conv
    prompt = str(args.get("prompt") or "")
    description = str(args.get("description") or role)

    async def start() -> None:
        await asyncio.sleep(0)  # the start's answer binds the agent to its request first (subagents._spawn)
        conv.transcript.write_meta({"agentType": conv.agent_type, "description": description})  # type: ignore[union-attr]
        conv.queue.append(prompt)
        await _agent_loop(conv)

    conv.task = _spawn_task(start(), f"agent:{sp.c}:{agent_id}")
    model = str(values.get("model") or (subagents.roles(sp.c).get(role) or {}).get("model") or "")
    return {"agentId": agent_id, **({"model": model} if model else {})}


def access_changed() -> None:
    """The way to reach Claude changed: nothing to restart, since each turn reads it anew."""
    from . import llm  # noqa: PLC0415

    llm.forget()


def start_line() -> str:
    """The server's start line about Claude access."""
    from . import claude_access  # noqa: PLC0415

    p = claude_access.problem_line()
    return f"Claude access: {claude_access.describe()}" + (f". {p}" if p else "")


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    from . import config, llm  # noqa: PLC0415

    global _loop
    _loop = asyncio.get_running_loop()
    if enabled():
        log.info("%s", start_line())
        for p in sorted(config.WORKSPACES_DIR.glob(f"*/{DIR}/main.json")):
            with contextlib.suppress(Exception):
                ensure(p.parent.parent.name)
        _loop.run_in_executor(None, llm.warm)  # so the first message does not wait for the SDK's import
    yield
    # this router is included last, so its lifespan ends first, while the mirror and the modules still run
    await stop_all()


router = APIRouter(lifespan=_lifespan)

STOP_WAIT_S = 5.0  # how long the server's stop waits for its agents to end (stop_all)


async def stop_all(wait_s: float = STOP_WAIT_S) -> list[str]:
    """The server stops (Ctrl-C in thimble-browser, a restart): every agent it runs stops, main's turn, the threads'
    forks and thimble's agents, as a Stop click stops one (_cancel): each ends `stopped` in its chat and in the registry
    (_agent_loop, _ended), and what waited for main goes (Space.drop_waiting). It waits up to `wait_s` for them, then
    the mirror keeps where each stands (session.keep_places), so the next server neither shows them running nor takes
    them up again. The ids stopped."""
    from . import session  # noqa: PLC0415

    stopping: list[tuple[str, Any]] = []
    mains = [sp.c for sp in _spaces.values() if sp.main.running]
    for sp in list(_spaces.values()):
        sp.drop_waiting()
        for conv in [sp.main, *sp.convs.values()]:
            if conv.running:
                conv.queue.clear()
                conv.task.cancel()  # type: ignore[union-attr]
                stopping.append((f"{sp.c}/{conv.id}", conv.task))
    if stopping:
        waits = [t if isinstance(t, asyncio.Future) else asyncio.wrap_future(t) for _, t in stopping]
        _, late = await asyncio.wait(waits, timeout=wait_s)
        if late:
            log.warning("%d agent(s) did not stop within %g s", len(late), wait_s)
        log.info("the server stops: stopped %s", ", ".join(i for i, _ in stopping))
    for c in mains:  # main's turn ends with a note, as the Stop button ends it (agents.interrupt_route)
        with contextlib.suppress(Exception):
            session.turn_stopped(c, stopped=True, text=session.QUIT_TEXT)
    session.keep_places()
    return [i for i, _ in stopping]


async def shutdown() -> None:
    await stop_all()
