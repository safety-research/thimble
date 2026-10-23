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
writes thimble's private files (PRIVATE_FILES) or the workspace's protected files (protected).

What 0.8 did through Claude Code's interactive session and thimble's plugin, the server now does in its place:
- a browser event (events._publish) starts a turn of main (deliver), or waits for main's turn to end;
- a `thread` event starts a fork of main's conversation that answers the thread, or a new turn of its fork;
- the plugin module's ops (module_bridge.request: spawn, send, stop, abort, note) start, message and stop the agents
  and main here (module_op);
- the notes main heard through the module (`$.session.append`) wait for main's next turn (tell).
No plugin hook or hooks module runs, so nothing depends on hooks Claude Code may skip (an Enterprise sign-in's
security plugin skips person-installed plugins' prompt.context and session.append hooks).

When Claude cannot be reached the way chosen (no choice, no key, a WIF file that cannot be used), a turn writes one
card into the chat (ACCESS_KIND) that says what is missing and opens the setup step; never a raw error.

Main's chats. Each start of thimble-browser opens a new chat of main, as each `claude` starts a new session: the
workspace's cards, canvas, reports and labels stay, and main's log in the page keeps the earlier chats above a `New
chat` line. `--continue` and `--resume` bring an earlier chat back (Space.switch, from the register route's `chat`):
main's conversation (convs/main-<sid>.<engine>.json) and its transcript are that chat's again. runtime/main.json names
the chat that is main now; main_chats lists them for the launcher's picker.

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

log = logging.getLogger("thimble.runtime")

ENV = "THIMBLE_RUNTIME"
DIR = "runtime"
MAIN = "main"
FORK_TYPE = "fork"
MAIN_BUILTINS = ("Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch")
AGENT_BUILTINS = ("Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebFetch", "WebSearch")
WEB = ("WebFetch", "WebSearch")
ACCESS_KIND = "claude-access"  # the chat's error record when Claude cannot be reached (the frontend's setup card)
API_ERROR_KIND = "api-error"
NOTES_HEAD = "(thimble, since your last turn:)"
MAIN_MODEL = "claude-opus-5-5"
MAIN_EFFORT = "high"
PRIVATE_FILES = ("claude-access.json", "anthropic-api-key", "server.json", "session.key", "paired.json")
NEW = "new"  # the register route's `chat` for a new chat of main (open_chat)
CHAT_CHIP = "session"  # the kind of main's line where a chat starts or comes back (session.CHIP_KIND)
NEW_CHAT = "New chat"
RESUMED_CHAT = "Resumed the chat that began with: {first}"
SID_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
EVENT_BODY_RE = re.compile(r'^\s*<thimble-event\s[^>]*?kind="([^"]*)"[^>]*>\n?(.*?)\n?</thimble-event>\s*$', re.S)


def enabled() -> bool:
    return os.environ.get(ENV, "on").strip().lower() not in ("off", "0", "no", "false")


def engine() -> str:
    """'api' (an API key or WIF), 'cc' (Claude Code sign-in), or '' before a choice."""
    from . import claude_access  # noqa: PLC0415

    h = claude_access.how()
    if h == claude_access.CLAUDE_CODE:
        return "cc"
    return "api" if h in (claude_access.API_KEY, claude_access.WIF) else ""


def uses_api() -> bool:
    """Whether model calls go to the Messages API from this process (model.structured)."""
    return enabled() and engine() != "cc"


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
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(full, ensure_ascii=False) + "\n")
        self.last = full["uuid"]
        return full

    def write_meta(self, meta: dict[str, Any]) -> None:
        p = self.path.with_name(self.path.name[: -len(".jsonl")] + ".meta.json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(meta), encoding="utf-8")


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
    transcript: Transcript | None = None
    queue: list[str] = field(default_factory=list)
    task: asyncio.Task | None = None
    last_text: str = ""
    base: str | None = None  # a fork's source conversation (main), copied at its first turn

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

    def emit_assistant(self, blocks: list[dict[str, Any]], model: str, usage: dict[str, Any] | None = None) -> None:
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

    def spec(self) -> Spec:
        return self.space.spec_of(self)

    async def call_thimble(self, name: str, args: dict[str, Any], tool_use_id: str) -> Any:
        """One of thimble's tools, as 0.8's MCP shim and call route ran it: the caller's line first (who made the
        call), then the call as that caller's session (tools._as_caller), so a fork's call runs as main's own and an
        agent's as its role's."""
        from . import subagent_files as files, tools  # noqa: PLC0415

        files.add_caller(self.space.ws, tool_use_id, self.agent_id or "", self.agent_type or "")
        refused, session = await tools._as_caller(self.c, name, tool_use_id)
        if refused:
            return tools.err(refused)
        return await tools.call(self.c, name, args, session=session, tool_use_id=tool_use_id)

    def take_notes(self) -> list[str]:
        return self.space.take_notes(self.id)


# --------------------------------------------------------------------------- one workspace


class Space:
    def __init__(self, c: str) -> None:
        from . import config  # noqa: PLC0415

        self.c = c
        self.ws = config.workspace_dir(c)
        self.corpus = config.corpus_dir(c)
        self.dir = self.ws / DIR
        self.dir.mkdir(parents=True, exist_ok=True)
        rec = _read_json(self.dir / "main.json")
        self.sid = str(rec.get("session") or "") or str(uuid.uuid4())
        if not rec.get("session"):
            (self.dir / "main.json").write_text(json.dumps({"session": self.sid, "at": _now()}), encoding="utf-8")
        for kind in ("api", "cc"):  # main's state from before chats were kept apart is its chat's
            old, new = self.dir / "convs" / f"{MAIN}.{kind}.json", self.dir / "convs" / f"{MAIN}-{self.sid}.{kind}.json"
            if old.is_file() and not new.exists():
                with contextlib.suppress(OSError):
                    old.rename(new)
        self.main = self._main_conv()
        self.convs: dict[str, Conv] = {}
        self.notes: dict[str, list[str]] = {}

    def _main_conv(self) -> Conv:
        tr = Transcript(self.main_path, self.sid)
        tr.last = _last_uuid(self.main_path)  # a chat brought back goes on from its last record
        return Conv(self, MAIN, "main", transcript=tr)

    async def switch(self, sid: str | None) -> bool:
        """Make chat `sid` main, or a new chat for None: main's running turn stops, runtime/main.json names the chat,
        the mirror follows its transcript (session.attach, which reads a chat brought back from its end), and main's
        log gets one line that says so. A new chat while main's chat has no turn yet is that chat. False when
        nothing changed. ValueError for an id that is no chat of this workspace."""
        from . import agents  # noqa: PLC0415

        if sid is not None and (not SID_OK.match(sid) or not (self.dir / f"{sid}.jsonl").is_file()):
            raise ValueError(f"no chat {sid} in this workspace")
        if sid == self.sid or (sid is None and not _chat_of(self.main_path)["turns"]):
            self.attach()
            return False
        if self.main.running:
            self.main.queue.clear()
            await _cancel(self.main.task)
        self.sid = sid or str(uuid.uuid4())
        (self.dir / "main.json").write_text(json.dumps({"session": self.sid, "at": _now()}), encoding="utf-8")
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
        from . import session  # noqa: PLC0415

        lv = session.current(self.c)
        if lv is None or lv.sid != self.sid:
            session.attach(self.c, self.sid, str(self.corpus), transcript_path=str(self.main_path))

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

    # ---- what each agent runs with

    def private(self) -> list[Path]:
        from . import cli  # noqa: PLC0415

        home = cli.home().expanduser()
        return [home / n for n in PRIVATE_FILES]

    def spec_of(self, conv: Conv) -> Spec:
        from . import config, events, ledger, runtime_tools, subagents, tools, userconf  # noqa: PLC0415

        tmp = self.dir / "tmp" / conv.id
        tmp.mkdir(parents=True, exist_ok=True)
        reads = [self.corpus, self.ws, config.REPO_ROOT / "docs", config.REPO_ROOT / "plugin" / "viewers",
                 config.REPO_ROOT / "frontend" / "src" / "kit"]
        if conv.kind in ("main", "fork"):
            # main and its thread forks write the corpus, as Claude Code does in its folder, unless the analyst turned
            # "Claude can edit files in this folder" off in Settings (ledger.corpus_edits)
            edits: bool | None = ledger.corpus_edits(self.c)
            system = events.session_prompt(str(self.corpus), terminal=False, edits=edits)
            names = [s.name for s in tools.REGISTRY.values()
                     if tools.ANALYST in s.roles and (not s.sessions or None in s.sessions)]
            builtins = list(MAIN_BUILTINS)
            choice = _main_choice(self.ws)
            model = str(choice.get("model") or MAIN_MODEL)
            effort = str(choice.get("effort") or MAIN_EFFORT)
            writes = [*([self.corpus] if edits else []), self.ws / "card-libs", tmp]
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
            writes = [*subagents.write_dirs(self.c), tmp]
            edits = None  # writers, view builds and reviews, and checks keep the corpus read-only
            fast = False
            with contextlib.suppress(Exception):
                for d in writes:
                    d.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(Exception):
            if (userconf.load_or_defaults(self.c)[0].get("agents") or {}).get("main", {}).get("web") == "off":
                builtins = [b for b in builtins if b not in WEB]
        return Spec(system=system, builtins=runtime_tools.available(builtins) if engine() == "api" else builtins,
                    thimble=names, model=model, effort=effort, cwd=self.corpus, workspace=self.ws,
                    read_roots=reads, write_roots=writes, private=self.private(), home=tmp, fast=fast,
                    corpus_edits=edits, no_write=protected(self.ws))


def protected(ws: Path) -> list[Path]:
    """The workspace's files no agent writes, as the kernels' sandbox keeps them (kernel_wrap.srt_rules): its hidden
    files and lock, and its read-only files and folders. They matter where a write root holds the workspace, as a
    corpus folder that holds thimble's home would."""
    from . import kernel_wrap  # noqa: PLC0415

    return [ws / n for n in (*kernel_wrap.HIDDEN_FILES, *kernel_wrap.LOCK_FILES, *kernel_wrap.READ_ONLY_FILES,
                             *kernel_wrap.READ_ONLY_DIRS)]


def _read_json(p: Path) -> dict[str, Any]:
    try:
        got = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _last_uuid(path: Path) -> str | None:
    try:
        with path.open("rb") as f:
            f.seek(max(0, path.stat().st_size - 65536))
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
    """{turns, first}: how many turns a main transcript holds (the user records that open one) and the first message
    the analyst typed in it, as one line."""
    turns, first, other = 0, "", ""
    try:
        f = path.open(encoding="utf-8")
    except OSError:
        return {"turns": 0, "first": ""}
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
            if first:
                continue
            m = EVENT_BODY_RE.match(content)
            body = " ".join((m.group(2) if m else content).split())
            if m and m.group(1) == "main":
                first = body
            elif not other:
                other = body
    return {"turns": turns, "first": first or other}


def main_chats(c: str) -> list[dict[str, Any]]:
    """The workspace's chats of main that hold a turn, the latest first: {id, at (the last write, epoch seconds),
    turns, first (the first message), current (main's now)}. For the launcher's --continue and --resume."""
    from . import config  # noqa: PLC0415

    d = config.workspace_dir(c) / DIR
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
    main, or waits for main's running turn to end."""
    from . import events  # noqa: PLC0415

    sp = ensure(c)
    meta = note.get("meta") or {}
    text = events.render(note)
    if meta.get("kind") == events.THREAD:
        _thread(sp, meta, text)
        return
    main = sp.main
    main.queue.append(text)
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
        try:
            await _run(main, text)
        except asyncio.CancelledError:
            sp.read()
            raise
        main.emit({"type": "system", "subtype": "turn_duration", "durationMs": int((time.monotonic() - t0) * 1000)})


async def abort_main(c: str) -> bool:
    """Stop main's running turn; whatever waited for it is dropped. False when no turn ran."""
    sp = ensure(c)
    main = sp.main
    if not main.running:
        return False
    main.queue.clear()
    await _cancel(main.task)
    return True


async def _cancel(task: Any) -> None:
    """Cancel a conversation's task (an asyncio Task, or the future of one started from another thread) and wait for
    it to end."""
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await (task if isinstance(task, asyncio.Future) else asyncio.wrap_future(task))


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
    conv = Conv(sp, agent_id, "agent", agent_id=agent_id, agent_type=subagents.type_name(role), role=role, values=values,
                transcript=Transcript(sp.sub_path(agent_id), sp.sid, agent_id))
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
        llm.scrub_env()
        log.info("%s", start_line())
        for p in sorted(config.WORKSPACES_DIR.glob(f"*/{DIR}/main.json")):
            with contextlib.suppress(Exception):
                ensure(p.parent.parent.name)
        _loop.run_in_executor(None, llm.warm)  # so the first message does not wait for the SDK's import
    yield
    for sp in list(_spaces.values()):
        for conv in [sp.main, *sp.convs.values()]:
            if conv.running:
                conv.task.cancel()  # type: ignore[union-attr]


router = APIRouter(lifespan=_lifespan)


async def shutdown() -> None:
    for sp in list(_spaces.values()):
        for conv in [sp.main, *sp.convs.values()]:
            if conv.running:
                conv.task.cancel()  # type: ignore[union-attr]
