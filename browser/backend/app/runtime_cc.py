"""One turn of an agent as a headless Claude Code session (runtime.py's `cc` engine), only when the person chose their
Claude Code sign-in and confirmed claude_access.CONSENT.

The session runs through the Agent SDK on the person's own `claude` (config.CLI_PATH), as 0.8's sdk.build ran its
calls: `--safe-mode`, so the person's CLAUDE.md, plugins, hooks and MCP servers stay out while their sign-in applies;
thimble's prompt as the whole system prompt; the role's model and effort. thimble's tools are an in-process MCP server
named so that the tools read as 0.8's plugin named them (tools.thimble_tool); Claude Code's built-in tools are the
same set the Messages API runtime gives (Spec.builtins), Bash in Claude Code's sandbox (no Bash where it cannot run),
Edit and Write allowed only in the agent's write folders (the corpus among them for main and its thread forks while
Settings' "Claude can edit files in this folder" is on, runtime.Spec.corpus_edits).

Permissions. The session runs in Claude Code's default mode with a permission callback (options' `ask`), so a command's
request to a host the analyst's Claude Code settings do not allow asks the analyst in the chat, as Claude Code asks in
the terminal (host_asks.py), and the hosts the analyst always allowed for the workspace are allowed in the session's
settings. Every other call that would ask is refused as Claude Code's `dontAsk` refuses it (REFUSED), so nothing else
waits on a prompt nobody sees. Claude Code's ask about a host names the host alone, under an id of its own, so the ask
shows the session's Bash call that runs (a session runs one at a time), which the hooks below hear start and end.

A PreToolUse hook callback (in this process, not a plugin hook) hears each call of thimble's tools with Claude Code's
id for it, which the tool's handler takes up, so a call runs as its caller's (Conv.call_thimble) as in 0.8, and each
Bash call with its input, until a PostToolUse or PostToolUseFailure hook callback hears that it ended. The
session's id is kept in <workspace>/runtime/convs/<id>.cc.json and resumed at the next turn; a fork resumes main's
session as a fork of it (fork_session). After a rewind of main (runtime.rewind_main) the state also names the entry of
the session that main's next turn, and a fork until then, resumes it up to (resume_at), as a fork of it.

A message the analyst sends while main's turn runs goes to main's session at once (_hand), as a message typed in Claude
Code's prompt mid-turn: Claude Code gives it to the model at the turn's next tool call, or runs it as the session's next
turn when this one ends first. Main's session echoes each message it reads (`replay-user-messages`), which is when
main's chat logs it (Conv.heard); the turn goes on until each message handed on is read.

The sandbox. Claude Code puts its sandbox's proxy sockets in TMPDIR (claude-http-<16 hex>.sock), and a Unix socket's
path holds at most 104 (macOS) or 108 (Linux) bytes, so with a long TMPDIR (the workspace's runtime/tmp/<conv>, 76
characters and more) the sandbox did not start, and Claude Code then ran Bash outside it. So each turn's session gets a
short TMPDIR (a 0700 folder under /tmp), and its sandbox is required (cc_settings.offline_sandbox's `required`): a
sandbox that still cannot start refuses each Bash call, and the person gets a notice (SANDBOX_NOTICE). The sandbox gives
a command Claude Code's own temp folder as its TMPDIR, claude-<uid> in CLAUDE_CODE_TMPDIR, which the session gets as its
TMPDIR too. Main's and its thread forks' sessions have the workspace's own short folder (workspace_tmp), kept from turn
to turn, so their commands' TMPDIR (shell_tmp) is the same folder at each turn, which the card kernels share (notebook);
it goes when the workspace is deleted or moved aside for another session (drop_workspace_tmp), and a server's start
removes those of workspaces deleted otherwise (sweep_workspace_tmps). Any other agent's session has one of its own (short_tmp), removed when the turn ends.
The agent's own files stay in the workspace (Spec.home), as before.

Claude Code's sandbox makes an empty .claude/.cc-writes/ folder in the session's working folder (the corpus) when it
starts, and no setting moves it, so the last session of a corpus to end removes that folder, and .claude/ when the
sandbox made it, when they are still empty (_tidy).

Background commands. A command Bash runs in the background (`run_in_background`) lives as long as its session's
`claude`, which kills it as it exits. So main's session stays open after a turn while such a command runs
(background_tasks_changed), and main's next turn goes on in it, as the next prompt in a terminal would (Held); it closes
when a turn ends with none running, when main's settings for a turn change, and when main's session truly ends: a Stop
or a failure, a new chat, a rewind, the workspace's folder going, another way to reach Claude, the server's stop
(close). Claude Code runs a turn of its own when such a command ends; main's next turn reads that turn first, and ends
only at the result after Claude Code echoed its own prompt.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
import uuid
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from . import nofollow

log = logging.getLogger("thimble.runtime_cc")
# the callback is for the asks the allowed tools leave (module note, permissions), so the Agent SDK's advisory that an
# allowed tool never reaches it would only print in the analyst's terminal
warnings.filterwarnings("ignore", message="can_use_tool will not be invoked")

SERVER = "plugin_thimble_thimble"  # tools.thimble_tool: mcp__plugin_thimble_thimble__<tool>
TMP_ROOT = "/tmp"  # short_tmp's and workspace_tmp's parent where it exists, else the system's temp folder
TMP_PREFIX = "thimble-cc-"
TMP_MAX = 60  # short_tmp's path at most: Claude Code's sandbox starts with a TMPDIR of up to 74 characters
TMP_TAG = 8  # workspace_tmp's name: TMP_PREFIX and this many hex digits of a hash of the workspace's folder
TMP_OWNER = ".thimble-workspace"  # in workspace_tmp: the workspace's folder, which it goes with
# a Claude Code session id, or the uuid of an entry of its transcript, as a state file keeps it
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
TRANSCRIPT_TYPES = ("user", "assistant", "progress", "system", "attachment")  # the records of a session's conversation
CC_WRITES = (".claude", ".cc-writes")  # what Claude Code's sandbox makes in the session's working folder
SANDBOX_FAILED = "Sandbox is required but failed to initialize"  # Claude Code's Bash result when it refuses the call
SANDBOX_KEY = "cc-sandbox"  # the notice's key (notices.py)
SANDBOX_NOTICE = ("{agent}'s shell commands did not run: Claude Code's Bash sandbox could not start ({why}), and thimble "
                  "runs them only inside it. On Linux the sandbox needs bubblewrap and socat; once they are installed, "
                  "send the message again. Settings, Claude access, can switch to an API key instead.")
# what a call that would ask for anything but a host gets (module note, permissions): word for word the refusal of
# Claude Code's `dontAsk`, which the session ran in before, so the model reads what it read then
REFUSED = ("Permission to use {tool} has been denied because Claude Code is running in don't ask mode. IMPORTANT: You "
           "*may* attempt to accomplish this action using other tools that might naturally be used to accomplish this "
           "goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious "
           "ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work "
           "around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. If "
           "you believe this capability is essential to complete the user's request, STOP and explain to the user what "
           "you were trying to do and why you need this permission. Let the user decide how to proceed.")
STOP_TASKS_S = 2.0  # how long a kept session's background commands get to stop as it closes (Held.close)
_open: dict[str, int] = {}  # the sessions running in each working folder (_enter, _tidy)
_had_claude: dict[str, bool] = {}  # whether .claude/ was in that folder when its first session started


@dataclass
class Held:
    """Main's session, open past its turn while a command it ran in the background runs (module note)."""
    spec: Any  # the turn's Spec: a turn with another opens a new session
    client: Any
    stack: contextlib.AsyncExitStack
    tasks: list[Any] = field(default_factory=list)  # its background tasks that run (background_tasks_changed)
    ended: Any = None  # what goes once it closes: its TMPDIR, and the sandbox's folder in the corpus (turn)

    async def close(self) -> None:
        try:
            # `claude` waits for its background commands before it exits, and the SDK ends it only after a grace period
            # (5 s), so the session stops them first
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(STOP_TASKS_S):
                    for t in self.tasks:
                        with contextlib.suppress(Exception):
                            await self.client.stop_task(str(t.get("task_id") or ""))
            await self.stack.aclose()  # the SDK's close: `claude` exits, and its background commands with it
        finally:
            if self.ended is not None:
                self.ended()


async def close(conv: Any) -> None:
    """`conv`'s session that stayed open after its turn (Held) closes; nothing when none did. Never raises."""
    held = getattr(conv, "cc", None)
    if held is None:
        return
    conv.cc = None
    try:
        await held.close()
    except Exception:  # noqa: BLE001
        log.warning("%s: %s's Claude Code session did not close cleanly", conv.c, conv.id, exc_info=True)


def _load(path: Any) -> dict[str, Any]:
    try:  # in the workspace's runtime folder: never read through a link a card's code left there (nofollow)
        got = json.loads(nofollow.read_text(path))
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def session_id(state: dict[str, Any]) -> str | None:
    """The Claude Code session a conversation's state names (`session_id`), which Claude Code resumes, or None: the
    state lies in the workspace, which a card's code writes, so an id that is not one Claude Code makes (letters,
    digits, dashes; never a leading dash, which would read as an option) is none."""
    sid = str(state.get("session_id") or "")
    return sid if SESSION_ID_RE.match(sid) else None


def resume_at(state: dict[str, Any]) -> str | None:
    """The entry of its session a conversation's state says the next turn resumes it up to (`resume_at`, which a rewind
    left, runtime.rewind_main), or None: checked as session_id checks the session's id, since it goes to Claude Code's
    --resume-session-at."""
    at = str(state.get("resume_at") or "")
    return at if SESSION_ID_RE.match(at) else None


def session_entries(sid: str) -> list[dict[str, Any]]:
    """The entries of Claude Code session `sid`'s conversation, in the order its transcript holds them: each record with
    a uuid of TRANSCRIPT_TYPES (a prompt, a reply, a tool's result, a message the session read mid-turn, which Claude
    Code keeps as a queued_command attachment, a system or progress record), a subagent's own (isSidechain) left out.
    Empty when no transcript of the session is found (session.find_transcript) or it cannot be read. `sid` is an id
    session_id took."""
    from . import session  # noqa: PLC0415

    path = session.find_transcript(sid)
    if path is None:
        return []
    out: list[dict[str, Any]] = []
    try:  # in Claude Code's config folder, read as nofollow reads a file there: a FIFO holds no read
        with nofollow.reader(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(rec, dict) and rec.get("type") in TRANSCRIPT_TYPES and isinstance(rec.get("uuid"), str)
                        and not rec.get("isSidechain")):
                    out.append(rec)
    except OSError:
        return []
    return out


def _save(path: Any, data: dict[str, Any]) -> None:
    """The session's state, in the workspace's runtime folder, replaced whole and never through a link a card's code
    left there (nofollow.replace)."""
    nofollow.replace(path, json.dumps(data).encode("utf-8"), make=True)


def _key(name: str, args: Any) -> str:
    return name.rsplit("__", 1)[-1] + "\0" + json.dumps(args, sort_keys=True, default=str)


def short_tmp() -> Path | None:
    """A new private (0700) folder with a short path (at most TMP_MAX characters) for one session's TMPDIR (module
    note): /tmp/thimble-<8 random characters>, else under the system's temp folder; None when neither can hold one."""
    for root in _tmp_roots():
        if len(root) + len(TMP_PREFIX) + 9 > TMP_MAX or not os.path.isdir(root):
            continue
        with contextlib.suppress(OSError):
            return Path(tempfile.mkdtemp(prefix=TMP_PREFIX, dir=root))
    return None


def _tmp_roots() -> list[str]:
    """Where short_tmp and workspace_tmp make their folders: TMP_ROOT, else the system's temp folder."""
    return list(dict.fromkeys((TMP_ROOT, tempfile.gettempdir())))


def _tmp_name(folder: str) -> str:
    """workspace_tmp's name for the workspace whose folder is `folder` (its real path)."""
    return f"{TMP_PREFIX}{hashlib.sha256(folder.encode()).hexdigest()[:TMP_TAG]}"


def workspace_tmp(c: str) -> Path | None:
    """Workspace `c`'s own short private folder (module note, the sandbox): /tmp/thimble-cc-<a hash of the workspace's
    folder>, else under the system's temp folder, the same at each turn and for each server, so a card kernel that
    outlives a server still finds it; None when neither can hold one that is this user's own folder. It names the
    workspace's folder in TMP_OWNER, by which a server's start finds it once that folder is gone (sweep_workspace_tmps);
    it goes with the workspace (drop_workspace_tmp)."""
    from . import config  # noqa: PLC0415

    folder = str(config.workspace_dir(c).resolve())
    for root in _tmp_roots():
        p = Path(root) / _tmp_name(folder)
        if len(str(p)) > TMP_MAX or not os.path.isdir(root):
            continue
        with contextlib.suppress(OSError):
            got = _own(p)
            if _owner(got) != folder:
                with contextlib.suppress(OSError), _mine(got) as fd:
                    nofollow.replace_at(fd, TMP_OWNER, folder.encode("utf-8"))
            return got
    return None


@contextlib.contextmanager
def _mine(p: Path, root: Path | None = None) -> Iterator[int]:
    """A descriptor of the folder `p`, opened from `root` (its parent's) one part at a time without following a link
    (nofollow), checked by that descriptor to be a folder of this user's own; OSError for anything else. Main's Bash
    on Claude Code sign-in writes the short folders, so what the server reads, writes and removes there goes through
    such a descriptor, never through a link or a FIFO that Bash put there."""
    with nofollow.folder(p, root=p.parent if root is None else root) as fd:
        if os.fstat(fd).st_uid != os.getuid():
            raise OSError(f"{p} is not a folder of this user's own")
        yield fd


def _owner(p: Path) -> str | None:
    """The workspace folder a short folder `p` names (TMP_OWNER), when `p` is a folder of this user's own and no link,
    and the file a regular file, no link (both as _mine opens them); else None, as for one that names none (a session's
    own, short_tmp, or one an earlier version made)."""
    try:
        with _mine(p) as fd, os.fdopen(nofollow.open_at(fd, TMP_OWNER, os.O_RDONLY), "rb") as f:
            return f.read().decode("utf-8").strip() or None
    except (OSError, ValueError):
        return None


def _remove(p: Path) -> bool:
    """`p` removed, when it is a folder of this user's own and no link (_mine), without following a link in it: whether
    it was."""
    try:
        with _mine(p):
            pass
        nofollow.rmtree(p, root=p.parent)
        return True
    except OSError:
        return False


def drop_workspace_tmp(folder: Path) -> None:
    """The workspace whose folder is `folder` is deleted, or moved aside for another session (ledger.archive_workspace):
    its short folder (workspace_tmp) goes with it, unless it names another workspace (two folders whose hashes meet).
    The workspace's sessions and kernels have stopped already."""
    real = str(folder.resolve())
    for root in _tmp_roots():
        p = Path(root) / _tmp_name(real)
        if _owner(p) in (None, real):
            _remove(p)


def sweep_workspace_tmps() -> list[Path]:
    """At a server's start, the short folders of workspaces that are gone (deleted by hand, or while no server ran),
    removed: each that names its workspace's folder (TMP_OWNER) when that folder is not there. Another server's, whose
    workspaces are there, and the sessions' own (short_tmp), which name none, stay. Those removed."""
    gone: list[Path] = []
    for root in _tmp_roots():
        try:
            found = sorted(Path(root).glob(f"{TMP_PREFIX}*"))
        except OSError:
            continue
        for p in found:
            owner = _owner(p)
            if owner and not os.path.isdir(owner) and _remove(p):
                gone.append(p)
    return gone


def shell_tmp(c: str) -> Path | None:
    """The TMPDIR Claude Code's sandbox gives the commands of main's and its thread forks' sessions: Claude Code's own
    temp folder, claude-<uid> in workspace_tmp, made as Claude Code makes it, so a card kernel that starts before main's
    first turn shares it too (runtime.shell_temp). None when there is no workspace_tmp."""
    base = workspace_tmp(c)
    if base is None:
        return None
    with contextlib.suppress(OSError):
        return _own(base / f"claude-{os.getuid()}", base.parent)
    return None


def _own(p: Path, root: Path | None = None) -> Path:
    """`p`, made when missing in its folder as nofollow opens that from `root` (its parent's), then a folder this user
    owns and no link (_mine), then mode 0700 through its descriptor, as Claude Code checks its temp folder; OSError for
    anything else, such as a folder another user made in its place."""
    with nofollow.folder(p.parent, root=p.parent if root is None else root) as fd, \
            contextlib.suppress(FileExistsError):
        os.mkdir(p.name, 0o700, dir_fd=fd)
    with _mine(p, root) as fd:
        os.fchmod(fd, 0o700)
    return p


def _enter(cwd: Path) -> None:
    key = str(cwd)
    if not _open.get(key):
        _had_claude[key] = (cwd / CC_WRITES[0]).exists()
    _open[key] = _open.get(key, 0) + 1


def _tidy(cwd: Path) -> None:
    """One session in `cwd` ended: when it was the last, the empty .claude/.cc-writes/ Claude Code's sandbox made there
    goes, and .claude/ with it when it was not there before and is now empty (module note)."""
    key = str(cwd)
    _open[key] = max(0, _open.get(key, 0) - 1)
    if _open[key]:
        return
    del _open[key]
    had = _had_claude.pop(key, True)
    with contextlib.suppress(OSError):
        (cwd / CC_WRITES[0] / CC_WRITES[1]).rmdir()
        if not had:
            (cwd / CC_WRITES[0]).rmdir()


def settings(spec: Any, bash: bool, tmp: Path | None = None, hosts: list[str] | None = None) -> dict[str, Any]:
    """The session's inline settings: its effort as 0.8's calls pinned it (sdk.cli_settings), the sandbox for Bash
    (required: a sandbox that cannot start refuses the call, module note), the PATH Bash has on the Messages API
    (runtime_tools.shell_path) and the variables that keep its programs from writing caches beside what they read
    (kernel_wrap.NO_SIDE_WRITES), edits only in the write folders, and no reads of thimble's private files. `tmp` is
    the session's TMPDIR, which its commands may write too; `hosts` the web rules of the hosts the analyst always
    allowed for the workspace (host_asks.kept), which the sandbox's network then reaches unasked."""
    from . import cc_settings, kernel_wrap, runtime_tools, sdk  # noqa: PLC0415

    out = json.loads(sdk.cli_settings(spec.model, spec.effort or None))
    out["env"] = {**out.get("env", {}), "PATH": runtime_tools.shell_path(), **kernel_wrap.NO_SIDE_WRITES}
    no_write = list(getattr(spec, "no_write", []) or [])
    corpus = spec.cwd in spec.write_roots  # main and its thread forks while Settings lets Claude edit the folder
    out["permissions"] = {
        "allow": [f"Edit(/{w}/**)" for w in spec.write_roots],
        "deny": [*([] if corpus else [f"Edit(/{spec.cwd}/**)"]),
                 *[r for p in spec.private for r in (f"Read(/{p})", f"Edit(/{p})")],
                 *[r for p in no_write for r in (f"Edit(/{p})", f"Edit(/{p}/**)")]],
        "additionalDirectories": [str(w) for w in spec.write_roots],
    }
    if bash:
        writes = [str(w) for w in spec.write_roots] + ([str(tmp)] if tmp else [])
        out["sandbox"] = {**cc_settings.offline_sandbox(auto_allow=True, network=True, required=True),
                          "filesystem": {"allowWrite": writes,
                                         "denyWrite": [*map(str, spec.private), *map(str, no_write)]}}
        out["permissions"]["allow"] += list(hosts or [])
    return out


def _chat(conv: Any) -> str | None:
    """The chat a conversation's asks wait on: main's, or the chat the mirror writes a fork or an agent into."""
    from . import agents, session  # noqa: PLC0415

    return agents.MAIN_ID if conv.kind == "main" else session.chat_of_agent(conv.c, conv.agent_id)


def options(conv: Any, spec: Any, pending: dict[str, list[str]], tmp: Path | None = None) -> Any:
    from claude_agent_sdk import (ClaudeAgentOptions, HookMatcher, PermissionResultAllow,  # noqa: PLC0415
                                  PermissionResultDeny, SdkMcpTool, create_sdk_mcp_server)

    from . import cc_settings, config, host_asks, runtime, sdk, tools  # noqa: PLC0415

    bash = "Bash" in spec.builtins and cc_settings.sandbox_ok()
    builtins = [b for b in spec.builtins if b != "Bash" or bash]
    secs = tools.tool_sections(spec.thimble, getattr(spec, "labels", True))

    def handler(name: str) -> Any:
        async def run(args: dict[str, Any]) -> dict[str, Any]:
            ids = pending.get(_key(name, args)) or []
            tid = ids.pop(0) if ids else f"toolu_rt{secrets.token_hex(10)}"
            res = await conv.call_thimble(name, args if isinstance(args, dict) else {}, tid)
            return {"content": [b for b in res.content if isinstance(b, dict)], "is_error": bool(res.is_error)}
        return run

    server = create_sdk_mcp_server(SERVER, tools=[SdkMcpTool(name=n, description=secs[n][0], input_schema=secs[n][1],
                                                             handler=handler(n)) for n in spec.thimble if n in secs])

    shell: dict[str, dict[str, Any]] = {}  # the session's Bash calls that run, by Claude Code's id: {tool, input}

    async def pre(inp: Any, tool_use_id: str | None, _ctx: Any) -> dict[str, Any]:
        name = str((inp or {}).get("tool_name") or "")
        if tool_use_id and name.startswith(f"mcp__{SERVER}__"):
            pending.setdefault(_key(name, (inp or {}).get("tool_input")), []).append(tool_use_id)
        elif tool_use_id and name == "Bash":
            shell[tool_use_id] = {"tool": name, "input": (inp or {}).get("tool_input") or {}}
        return {}

    async def ended(_inp: Any, tool_use_id: str | None, _ctx: Any) -> dict[str, Any]:
        shell.pop(tool_use_id or "", None)
        return {}

    async def ask(name: str, inp: dict[str, Any], _ctx: Any) -> Any:
        if name != host_asks.TOOL:
            return PermissionResultDeny(message=REFUSED.format(tool=name))
        # the request is the running Bash call's (module note, permissions): the one started last, should two run
        call = next(reversed(shell.values()), None)
        if await host_asks.ask(conv.c, _chat(conv), str((inp or {}).get("host") or ""), call):
            return PermissionResultAllow()
        return PermissionResultDeny()

    allowed = [b for b in builtins if b not in ("Edit", "Write")]
    allowed += [f"Edit(/{w}/**)" for w in spec.write_roots]
    allowed += [tools.thimble_tool(n) for n in spec.thimble]
    state = _load(conv.state_path("cc"))
    # a rewind (runtime.rewind_main) left `resume_at`: the session resumes up to that entry, as a fork of it
    resume = session_id(state)
    at = resume_at(state) if resume else None
    fork = bool(at)
    if resume is None and conv.base:
        base = conv.space.main if conv.base == runtime.MAIN else conv.space.convs.get(conv.base)
        held = _load(base.state_path("cc")) if base is not None else {}
        if sid := session_id(held):
            resume, fork, at = sid, True, resume_at(held)
    sent = spec.effort if spec.effort and config.has_effort(spec.model) else None
    return ClaudeAgentOptions(
        cwd=str(spec.cwd),
        tools=builtins,
        allowed_tools=allowed,
        permission_mode="default",
        can_use_tool=ask,
        mcp_servers={SERVER: server},
        system_prompt=spec.system,
        model=spec.model,
        effort=sent,
        settings=json.dumps(settings(spec, bash, tmp, host_asks.kept(conv.c))),
        cli_path=config.CLI_PATH,
        max_buffer_size=sdk.MAX_BUFFER_SIZE,
        setting_sources=["user"],
        strict_mcp_config=True,
        add_dirs=[str(w) for w in spec.write_roots],
        # Claude Code keeps its own temp folder in the short TMPDIR too, whatever CLAUDE_CODE_TMPDIR the server has
        env=sdk.call_env({"TMPDIR": str(tmp or spec.home), **({"CLAUDE_CODE_TMPDIR": str(tmp)} if tmp else {})}),
        # main's session echoes each message it reads, so a message handed to it mid-turn is known read (_hand)
        extra_args={"safe-mode": None, **({"replay-user-messages": None} if conv.kind == "main" else {})},
        hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[pre])],
               "PostToolUse": [HookMatcher(matcher="Bash", hooks=[ended])],
               "PostToolUseFailure": [HookMatcher(matcher="Bash", hooks=[ended])]},
        resume=resume,
        fork_session=fork,
        resume_session_at=at,
    )


def _block(b: Any) -> dict[str, Any] | None:
    from claude_agent_sdk import ServerToolUseBlock, TextBlock, ToolUseBlock  # noqa: PLC0415

    if isinstance(b, TextBlock):
        return {"type": "text", "text": b.text}
    if isinstance(b, ToolUseBlock):
        return {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input or {}}
    if isinstance(b, ServerToolUseBlock):
        from . import runtime_tools  # noqa: PLC0415

        return {"type": "tool_use", "id": b.id, "name": runtime_tools.SERVER_NAMES.get(b.name, b.name),
                "input": b.input or {}}
    return None


def _result(b: Any) -> dict[str, Any] | None:
    from claude_agent_sdk import ServerToolResultBlock, ToolResultBlock  # noqa: PLC0415

    if isinstance(b, ToolResultBlock):
        return {"type": "tool_result", "tool_use_id": b.tool_use_id, "content": b.content if b.content is not None else "",
                **({"is_error": True} if b.is_error else {})}
    if isinstance(b, ServerToolResultBlock):
        return {"type": "tool_result", "tool_use_id": b.tool_use_id, "content": json.dumps(b.content)[:2000]}
    return None


async def turn(conv: Any, text: str) -> Any:
    """One turn of `conv` on `text` in a session with a short TMPDIR (module note): the workspace's own for main and its
    thread forks (Spec.temp), which stays; any other agent's own, removed when the turn ends."""
    spec = conv.spec()
    held = getattr(conv, "cc", None)
    if held is not None and held.spec == spec:
        return await _session(conv, spec, text, None)  # the session open since its last turn (module note)
    await close(conv)
    pending: dict[str, list[str]] = {}
    kept = workspace_tmp(conv.c) if spec.temp is not None else None
    tmp = kept or short_tmp()
    if tmp is None:
        log.warning("%s: no short TMPDIR for %s's session; its sandbox may not start", conv.c, conv.id)
    _enter(spec.cwd)

    def ended() -> None:
        if tmp is not None and tmp != kept:
            nofollow.rmtree(tmp, root=tmp.parent, ignore_errors=True)  # the session's Bash wrote it: no link followed
        _tidy(spec.cwd)

    try:
        return await _session(conv, spec, text, options(conv, spec, pending, tmp))
    finally:
        held = getattr(conv, "cc", None)
        if held is None:
            ended()
        else:
            held.ended = ended  # once it closes


def _box_failure(results: list[dict[str, Any]]) -> str:
    """Why Claude Code refused a Bash call because its required sandbox could not start (SANDBOX_FAILED), '' when no
    result in `results` says so."""
    for r in results:
        content = r.get("content")
        said = content if isinstance(content, str) else " ".join(
            str(b.get("text") or "") for b in content if isinstance(b, dict)) if isinstance(content, list) else ""
        if r.get("is_error") and SANDBOX_FAILED in said:
            why = said.split(SANDBOX_FAILED, 1)[1].lstrip(" :").split(". Restart", 1)[0].strip().rstrip(".")
            return why or "no reason given"
    return ""


def _tell_box(conv: Any, why: str) -> None:
    """The notice that `conv`'s shell commands were refused since the sandbox could not start (SANDBOX_NOTICE), or, with
    no `why`, its end. Never raises."""
    from . import notices  # noqa: PLC0415

    try:
        if not why:
            notices.clear(conv.c, SANDBOX_KEY)
            return
        name = "Main" if conv.kind == "main" else "The thread" if conv.kind == "fork" else notices.who(conv.role)[0]
        notices.post(conv.c, kind="sandbox", key=SANDBOX_KEY, agent=name,
                     text=SANDBOX_NOTICE.format(agent=name, why=why[:200]), action=notices.SETTINGS)
    except Exception:  # noqa: BLE001 — a notice not told is no reason to fail the turn
        log.exception("%s: the sandbox notice was not told", conv.c)


async def _hand(conv: Any, client: Any, handed: dict[str, str], closing: asyncio.Event) -> None:
    """The analyst's messages that wait for main's running turn (Conv.waiting_messages), each handed to main's session
    as it comes (Conv.arrived), under a uuid it echoes once it reads the message (`handed`, _session), until the turn
    ends (`closing`). A message that cannot be handed on stays in main's queue, for main's next turn."""
    while not closing.is_set():
        conv.arrived.clear()
        for text in conv.waiting_messages():
            if closing.is_set() or text in handed.values():
                continue
            uid = str(uuid.uuid4())
            handed[uid] = text
            try:
                await client.query(_message(text, uid))
            except Exception:  # noqa: BLE001 — it waits for main's next turn
                handed.pop(uid, None)
                log.warning("%s: a message for main was not handed to its session", conv.c, exc_info=True)
                return
        await conv.arrived.wait()


async def _message(text: str, uid: str) -> Any:
    """`text` as one user message of the session's input, under `uid`, which the session echoes it with."""
    yield {"type": "user", "message": {"role": "user", "content": text}, "parent_tool_use_id": None, "uuid": uid}


async def _session(conv: Any, spec: Any, text: str, opts: Any) -> Any:
    """One turn in a new session on `opts`, or, with none, in `conv`'s session open since its last turn (Held)."""
    from claude_agent_sdk import AssistantMessage, ClaudeSDKClient, ResultMessage, SystemMessage, UserMessage  # noqa: PLC0415

    from . import runtime  # noqa: PLC0415

    path = conv.state_path("cc")
    reply, failed, box, ran = "", "", "", False
    bash_ids: set[str] = set()
    handed: dict[str, str] = {}  # by uuid, main's messages handed to the session (_hand) that it has not read yet
    closing = asyncio.Event()
    # in a session kept open, this turn's prompt, by its uuid, until the session echoes it: a result before that ends a
    # turn Claude Code ran of its own (module note)
    prompt: str | None = None

    def results(rs: list[dict[str, Any]]) -> None:
        nonlocal box, ran
        conv.emit_results(rs)
        mine = [r for r in rs if r.get("tool_use_id") in bash_ids]
        box = box or _box_failure(mine)
        ran = ran or any(not _box_failure([r]) for r in mine)

    held, conv.cc = getattr(conv, "cc", None), None
    if held is None:
        stack = contextlib.AsyncExitStack()
        held = Held(spec, await stack.enter_async_context(ClaudeSDKClient(opts)), stack)
    keep = False
    try:
        client = held.client
        if held.tasks:
            prompt = str(uuid.uuid4())
            await client.query(_message(text, prompt))
        else:
            await client.query(text)
        hand = asyncio.create_task(_hand(conv, client, handed, closing)) if conv.kind == "main" else None
        try:
            # the session's reply; then, while a message handed to it is not read yet, its next turn, which reads it
            while True:
                ended = own = False
                async for msg in client.receive_response():
                    if isinstance(msg, SystemMessage) and msg.subtype == "init":
                        sid = (msg.data or {}).get("session_id")
                        if sid:
                            _save(path, {"session_id": sid})
                    elif isinstance(msg, SystemMessage) and msg.subtype == "background_tasks_changed":
                        held.tasks = list((msg.data or {}).get("tasks") or [])
                    elif isinstance(msg, AssistantMessage):
                        if getattr(msg, "parent_tool_use_id", None):
                            continue
                        blocks = [b for b in (_block(x) for x in msg.content) if b is not None]
                        bash_ids.update(str(b["id"]) for b in blocks
                                        if b.get("type") == "tool_use" and b.get("name") == "Bash")
                        conv.emit_assistant(blocks, str(msg.model or spec.model), msg.usage or {}, asked=spec.model)
                        results([r for r in (_result(x) for x in msg.content) if r is not None])
                        said = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
                        reply = said or reply
                        if msg.error and prompt is None:
                            failed = str(msg.error)
                    elif isinstance(msg, UserMessage):
                        if prompt is not None and getattr(msg, "uuid", None) == prompt:
                            prompt = None
                            continue
                        if getattr(msg, "uuid", None) in handed:  # the session read a message handed to it
                            conv.heard(handed.pop(str(msg.uuid)))
                            continue
                        if getattr(msg, "parent_tool_use_id", None) or isinstance(msg.content, str):
                            continue
                        results([r for r in (_result(x) for x in msg.content) if r is not None])
                    elif isinstance(msg, ResultMessage):
                        if msg.session_id:
                            _save(path, {"session_id": msg.session_id})
                        if prompt is not None:  # a turn of Claude Code's own: this one's comes after it
                            own = True
                            continue
                        ended = True
                        if msg.is_error and not failed:
                            failed = str(msg.result or msg.subtype or "the Claude Code session failed")
                if own:
                    continue
                if not ended or failed:
                    break
                if not handed and hand is not None:  # nothing more is handed on: what comes waits for main's next turn
                    closing.set()
                    conv.arrived.set()
                    with contextlib.suppress(Exception):
                        await hand
                    hand = None
                if not handed:
                    break
        finally:
            if hand is not None:
                hand.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await hand
        keep = ended and not failed and bool(held.tasks) and conv.kind == "main"
    finally:
        if keep:
            conv.cc = held
        else:
            await held.close()
    if box or ran:
        _tell_box(conv, box)
    if failed:
        if "auth" in failed.lower() or "login" in failed.lower() or "401" in failed:
            raise runtime.AccessProblem({"what": f"Claude Code could not sign in: {failed[:300]}",
                                         "fix": "Run `claude` in a terminal and sign in, or choose another way in "
                                                "Settings, Claude access."})
        raise RuntimeError(failed[:300])
    return runtime.TurnEnd("done", text=reply)
