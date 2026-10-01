"""Programs that run one of thimble's roles: the Agent SDK program (`sdk`) or the command (`command`) an extension's
agents/<role>/agent.json names (roles.py). docs/agents.md documents what a program gets and how it answers.

Start. run() opens the role's agent chat and starts the program from its agent folder: an SDK program through
agent_kit/run_sdk.py on thimble's Python, a command as written, with thimble's Python first on PATH and
agent_kit/ (the `thimble` module) on PYTHONPATH. The input goes on stdin as {"input": ...} and in the file
THIMBLE_INPUT. The program writes only in its work folder (THIMBLE_WORK).

The box. Where Anthropic's sandbox runtime runs (kernel_wrap.srt_works), the program runs in it. It can never read
server.json or Claude Code's credentials file (userconf.private_paths, CREDENTIALS). With the role's sandbox on it
writes only its work folder and its temp folder, and the corpus too when the role's `data` is "allow"; with the
sandbox off it writes anywhere. With the role's network off it reaches no host, and talks to thimble only on its
stdin and stdout. Where the runtime can't run, a role whose sandbox is on does not start while `sandbox.enforce` is
on; otherwise the program runs unboxed, and its thread says so.

The token. Each run gets a token of its own (hook_auth.grant), THIMBLE_AGENT_TOKEN, valid until it ends, on the
tool routes of the role's own tools and on the session route; a tool call made with it runs as the role's session.

Sessions. thimble.options() sets the SDK's cli_path to agent_kit/claude_shim.py, which asks the server, over a
WebSocket on SESSION_PATH, to start the session. The server starts it on the analyst's own claude, outside the box,
in the role's work folder with the corpus added, and passes its stdin, stdout and stderr through. claude_argv keeps
only the flags a session may choose (KEEP, KEEP_VALUE): the role's permission mode, sandbox, data rule, private read
denies and permission hooks are thimble's, and the program's allowed tools, plugins, setting sources and MCP servers
that run outside it are dropped. Its permission requests show on the run's chat (agent_session.host). A run holds at
most MAX_SESSIONS sessions at once.

Requests. On stdout a program writes JSON lines (agent_kit/thimble.py): `log` lines go into its thread, `output` is
what the role returns, and `tool`, `ask` and `session` requests are answered on stdin. Any other line on stdout, and
everything on stderr, goes to the server's log; the end of stderr is the error of a run that fails.

End. A run is done when the program exits 0, and failed otherwise. Stop ends the program's process group and its
sessions.
"""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import os
import secrets
import signal
import sys
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import agents, config, hook_auth, kernel_wrap, modes, roles, srt, userconf

log = logging.getLogger("thimble.harness")
router = APIRouter()

KIT = Path(__file__).resolve().parent.parent / "agent_kit"
SHIM = KIT / "claude_shim.py"
RUN_SDK = KIT / "run_sdk.py"
SESSION_PATH = "/agent/claude"
TOOL_PREFIX = "/api/tools/"
CREDENTIALS = ".credentials.json"  # in Claude Code's config folder
MAX_SESSIONS = 16
STDERR_KEEP = 40  # lines of a program's stderr kept for its error
LINE_LIMIT = 16 * 1024 * 1024
INPUT_FILE = ".thimble-input.json"  # in the work folder
TMP_DIR = ".tmp"  # in the work folder: the program's TMPDIR
CACHE_DIR = ".cache"
ENV_KEEP = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "TERM", "HOME", "SHELL")
ROWS = {"orientation": "orient", "critic": "critic", "writer": "writer", "dev": "dev"}  # modes.AGENTS
STOP_WAIT_S = 5.0
NO_BOX = ("The role's sandbox could not run here, so its program runs without one and can read what you can, "
          "thimble's token among it.")
NO_BOX_ENFORCED = ("thimble runs an agent's program only in its sandbox (sandbox.enforce), and the sandbox can't run on "
                   "this machine, so the {role} agent did not start. `thimble doctor` says what is missing.")
NO_DEFAULT = ("thimble lends no implementation of the {role} role to a program. Run the role's work in your program, "
              "or add to thimble's prompt for it with the prompt way.")
# a session's flags a program may choose, without and with a value; any other flag is dropped (claude_argv)
KEEP = ("-p", "--print", "--verbose", "--include-partial-messages", "--include-hook-events", "--continue",
        "--fork-session", "--replay-user-messages", "--session-mirror", "--debug-to-stderr")
KEEP_VALUE = ("--output-format", "--input-format", "--system-prompt", "--append-system-prompt", "--tools",
              "--disallowedTools", "--disallowed-tools", "--max-turns", "--max-budget-usd", "--model", "--fallback-model",
              "--betas", "--effort", "--max-thinking-tokens", "--thinking", "--task-budget", "--resume", "--session-id",
              "--resume-session-at", "--resume-drops-turn", "--agents", "--json-schema")
OWN_VALUE = ("--settings", "--add-dir", "--mcp-config", "--system-prompt-file", "--allowedTools", "--allowed-tools",
             "--permission-mode", "--permission-prompt-tool", "--plugin-dir", "--setting-sources", "--debug")


class HarnessError(RuntimeError):
    """A program could not start, or ended any way but done; the message says why, for the analyst."""


@dataclass
class Job:
    """What a role's caller asks a program to do."""

    c: str
    role: str  # one of roles.SESSION_ROLES
    key: str  # the THIMBLE_SESSION its tool calls and sessions run as: `orient`, `critique:<caller>`, `writer:<doc>`
    title: str
    input: dict[str, Any]
    tools: tuple[str, ...]  # its thimble tools
    work: Path
    chat_role: str = ""  # the agent chat's role, the role's own when ''
    patient: bool = False  # its sessions' permission requests wait for the analyst
    parent: str = agents.MAIN_ID
    fields: dict[str, Any] = field(default_factory=dict)  # land on the chat's meta


@dataclass
class Run:
    job: Job
    part: roles.Part
    conf: userconf.Session
    token_id: str
    token: str
    chat: str = ""
    rec: agents.Recorder | None = None
    proc: asyncio.subprocess.Process | None = None
    output: Any = None
    has_output: bool = False
    boxed: bool = False
    stderr: deque = field(default_factory=lambda: deque(maxlen=STDERR_KEEP))
    sessions: set = field(default_factory=set)
    slots: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(MAX_SESSIONS))
    writing: asyncio.Lock = field(default_factory=asyncio.Lock)
    tasks: set = field(default_factory=set)
    calls: int = 0

    @property
    def c(self) -> str:
        return self.job.c

    def allows(self, method: str, path: str) -> bool:
        """The routes this run's token is good for (hook_auth.grant): a POST of one of its role's tools."""
        return method == "POST" and path.startswith(TOOL_PREFIX) and path[len(TOOL_PREFIX):] in self.job.tools


_runs: dict[str, Run] = {}  # by token id
_by_key: dict[tuple[str, str], Run] = {}


def current(c: str, key: str) -> Run | None:
    return _by_key.get((c, key))


def running(c: str, key: str) -> bool:
    return (c, key) in _by_key


def by_token(token_id: str) -> Run | None:
    return _runs.get(token_id)


def api_url() -> str:
    from . import cli  # noqa: PLC0415 — cli is large

    return cli.api_url()


def private_paths() -> list[str]:
    """What a program may never read: server.json and Claude Code's credentials file."""
    return [*userconf.private_paths(), str(config.claude_config_dir() / CREDENTIALS)]


# --------------------------------------------------------------------------- the program


def program_argv(part: roles.Part) -> list[str]:
    if part.way == "sdk":
        target = part.path(part.spec["sdk"])
        return [sys.executable, str(RUN_SDK), str(target)]
    return [str(a) for a in part.spec["command"]]


def box_rules(run: Run) -> dict[str, Any]:
    """srt's rules for the program's box (module note, the box)."""
    deny = [p for p in private_paths() if Path(p).exists()]
    if run.conf.conf.get("sandbox") == "off":
        return {"filesystem": {"denyRead": deny, "allowRead": [], "allowWrite": ["/"], "denyWrite": deny}}
    work = run.job.work
    writes = [str(work), str(work / TMP_DIR)]
    corpus = run.conf.corpus()
    if run.conf.data == "allow" and corpus is not None:
        writes.append(str(corpus))
    out: dict[str, Any] = {"filesystem": {"denyRead": deny, "allowRead": [], "allowWrite": writes, "denyWrite": deny}}
    if not run.conf.network:
        out["network"] = {"allowedDomains": [], "deniedDomains": []}
    return out


def boxed(run: Run, argv: list[str]) -> list[str] | None:
    """`argv` run in the program's box; None where the sandbox runtime can't run."""
    node, package = srt.node(), srt.package(config.REPO_ROOT)
    if not kernel_wrap.srt_works(node, package):
        return None
    assert node is not None and package is not None
    return kernel_wrap.srt_argv(argv, node=node, srt_dir=package, rules=box_rules(run))


def program_env(run: Run) -> dict[str, str]:
    job, part = run.job, run.part
    env = {k: os.environ[k] for k in ENV_KEEP if k in os.environ}
    env.update({n: os.environ[n] for n in run.conf.conf.get("env") or [] if n in os.environ})
    lib = part.root / "lib"
    corpus = run.conf.corpus()
    env.update({
        "PATH": os.pathsep.join([str(Path(sys.executable).parent), *[p for p in env.get("PATH", "").split(os.pathsep) if p]]),
        "PYTHONPATH": os.pathsep.join([str(KIT), *([str(lib)] if lib.is_dir() else []), str(part.folder)]),
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
        "THIMBLE_API": api_url(), "THIMBLE_AGENT_TOKEN": run.token, "THIMBLE_SESSION": job.key,
        "THIMBLE_ROLE": job.role, "THIMBLE_WORKSPACE": job.c, "THIMBLE_WORK": str(job.work),
        "THIMBLE_CORPUS": str(corpus or ""), "THIMBLE_INPUT": str(job.work / INPUT_FILE),
        "THIMBLE_AGENT_DIR": str(part.folder), "THIMBLE_CLAUDE": str(SHIM), "THIMBLE_PYTHON": sys.executable,
        "CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK": "1", "TMPDIR": str(job.work / TMP_DIR),
        "XDG_CACHE_HOME": str(job.work / CACHE_DIR),
    })
    return env


def _line_text(raw: bytes) -> str:
    return raw.decode("utf-8", "replace").rstrip("\r\n")


async def _say(run: Run, obj: dict[str, Any]) -> None:
    proc = run.proc
    if proc is None or proc.stdin is None or proc.stdin.is_closing():
        return
    async with run.writing:
        with contextlib.suppress(ConnectionError, OSError):
            proc.stdin.write((json.dumps(obj, ensure_ascii=False, default=str) + "\n").encode("utf-8"))
            await proc.stdin.drain()


async def _read_stdout(run: Run) -> None:
    assert run.proc is not None and run.proc.stdout is not None
    while True:
        try:
            raw = await run.proc.stdout.readline()
        except ValueError:  # a line over the limit
            log.warning("%s: %s's program wrote a line over %d bytes; it is dropped", run.c, run.job.role, LINE_LIMIT)
            continue
        if not raw:
            return
        text = _line_text(raw)
        try:
            msg = json.loads(text)
        except ValueError:
            msg = None
        if not isinstance(msg, dict):
            if text.strip():
                log.info("%s: %s program: %s", run.c, run.job.role, text[:2000])
            continue
        if "log" in msg:
            line = str(msg["log"]).rstrip("\n")
            if run.rec is not None and line:
                run.rec.text(line + "\n")
        elif "output" in msg:
            run.output, run.has_output = msg["output"], True
        elif isinstance(msg.get("id"), (int, str)):
            kind = next((k for k in ("tool", "ask", "session", "default") if k in msg), "")
            task = asyncio.get_running_loop().create_task(_answer(run, msg["id"], kind, msg.get(kind)))
            run.tasks.add(task)
            task.add_done_callback(run.tasks.discard)


async def _read_stderr(run: Run) -> None:
    assert run.proc is not None and run.proc.stderr is not None
    while True:
        raw = await run.proc.stderr.readline()
        if not raw:
            return
        text = _line_text(raw)
        run.stderr.append(text)
        log.info("%s: %s program (stderr): %s", run.c, run.job.role, text[:2000])


async def _answer(run: Run, rid: Any, kind: str, payload: Any) -> None:
    try:
        if not isinstance(payload, dict):
            raise HarnessError(f"a {kind or 'request'} needs an object")
        if kind == "tool":
            result = await tool_call(run, payload)
        elif kind == "ask":
            result = await ask(run, payload)
        elif kind == "session":
            result = await session_call(run, payload)
        elif kind == "default":
            raise HarnessError(NO_DEFAULT.format(role=run.job.role))
        else:
            raise HarnessError("a request names tool, ask, session or default")
    except Exception as e:  # noqa: BLE001 — every failure is the program's to read
        if not isinstance(e, HarnessError):
            log.exception("%s: a %s request of the %s program failed", run.c, kind, run.job.role)
        await _say(run, {"id": rid, "error": str(e) or type(e).__name__})
        return
    await _say(run, {"id": rid, "result": result})


async def tool_call(run: Run, payload: dict[str, Any]) -> dict[str, Any]:
    from . import tools  # noqa: PLC0415 — tools is large

    name = str(payload.get("name") or "")
    if name not in run.job.tools:
        raise HarnessError(f"{name or 'a tool with no name'} is not one of the {run.job.role}'s tools: "
                           f"{', '.join(run.job.tools)}")
    args = payload.get("args") if isinstance(payload.get("args"), dict) else {}
    run.calls += 1
    cid = f"h{run.calls}"
    if run.rec is not None:
        run.rec.tool_use(cid, name, args)
    res = await tools.call(run.c, name, args, session=run.job.key)
    if run.rec is not None:
        run.rec.tool_result(cid, res.text, is_error=res.is_error)
    return res.as_dict()


ANSWER_TOOL = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


async def ask(run: Run, payload: dict[str, Any]) -> Any:
    from . import model  # noqa: PLC0415 — model binds the SDK at first use

    prompt = str(payload.get("prompt") or "")
    if not prompt.strip():
        raise HarnessError("ask needs a prompt")
    schema = payload.get("schema")
    plain = not isinstance(schema, dict)
    spec = model.ToolSpec("answer", "Give your answer with this tool.", ANSWER_TOOL if plain else schema)
    role = config.models_for(run.c).get(ROWS[run.job.role]) or {}
    chosen = str(payload.get("model") or role.get("model") or config.FALLBACK_MODEL)
    res = await model.structured(prompt, tool=spec, model=chosen, effort=role.get("effort") or None,
                                 cwd=str(run.job.work))
    if res.status != "ok" or res.output is None:
        raise HarnessError(f"the model call ended {res.status}: {res.detail or res.text[:300]}")
    return res.output.get("text", "") if plain else res.output


async def session_call(run: Run, payload: dict[str, Any]) -> str:
    prompt = str(payload.get("prompt") or "")
    if not prompt.strip():
        raise HarnessError("session needs a prompt")
    argv = ["-p", "--output-format", "json"]
    if isinstance(payload.get("system"), str):
        argv += ["--system-prompt", payload["system"]]
    if isinstance(payload.get("tools"), list):
        argv += ["--tools", ",".join(str(t) for t in payload["tools"])]
    if isinstance(payload.get("agents"), dict):
        argv += ["--agents", json.dumps(payload["agents"])]
    async with run.slots:
        final, folder, env = claude_argv(run, argv)
        proc = await asyncio.create_subprocess_exec(*final, cwd=str(folder), env=env, stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    start_new_session=True, limit=LINE_LIMIT)
        run.sessions.add(proc)
        try:
            out, err = await proc.communicate(prompt.encode("utf-8"))
        finally:
            run.sessions.discard(proc)
    try:
        got = json.loads(out.decode("utf-8", "replace").strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise HarnessError(f"the session ended with code {proc.returncode}: "
                           f"{err.decode('utf-8', 'replace').strip()[-600:]}") from None
    if got.get("is_error"):
        raise HarnessError(f"the session failed: {str(got.get('result') or got.get('subtype'))[:600]}")
    return str(got.get("result") or "")


# --------------------------------------------------------------------------- sessions


def _split(argv: list[str]) -> list[tuple[str, str | None]]:
    """The program's flags as (flag, value): `--flag=value` split, a value-taking flag with the word after it, a
    lone word as ('', word)."""
    out: list[tuple[str, str | None]] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        flag, eq, value = a.partition("=") if a.startswith("--") else (a, "", "")
        if eq:
            out.append((flag, value))
        elif flag in KEEP_VALUE or flag in OWN_VALUE:
            out.append((flag, argv[i + 1] if i + 1 < len(argv) else ""))
            i += 1
        elif a.startswith("-"):
            out.append((a, None))
        else:
            out.append(("", a))
        i += 1
    return out


def _under(path: str, roots: list[Path]) -> bool:
    try:
        real = Path(os.path.realpath(path))
    except (OSError, ValueError):
        return False
    return any(real == r or r in real.parents for r in roots)


def claude_argv(run: Run, argv: list[str]) -> tuple[list[str], Path, dict[str, str]]:
    """(the session's argv, the folder it runs in, its environment) for a session a program asked for with `argv`
    (module note, sessions)."""
    from . import agent_session  # noqa: PLC0415 — agent_session imports this module's callers

    job, conf = run.job, run.conf
    corpus = conf.corpus() or config.corpus_dir(job.c)
    work = job.work
    roots = [Path(os.path.realpath(work)), Path(os.path.realpath(corpus)), Path(os.path.realpath(run.part.root))]
    kept: list[str] = []
    denied: list[str] = []
    appended: list[str] = []
    asked: dict[str, list[str]] = {}
    for flag, value in _split(argv):
        if flag in KEEP and value is None:
            kept.append(flag)
        elif flag in ("--disallowedTools", "--disallowed-tools") and value is not None:
            denied += [t.strip() for t in value.replace(",", " ").split() if t.strip()]
        elif flag == "--append-system-prompt" and value is not None:
            appended.append(value)
        elif flag in KEEP_VALUE and value is not None:
            kept += [flag, value]
        elif flag == "--system-prompt-file" and value and _under(value, roots):
            kept += [flag, value]
        elif flag == "--settings" and value:
            try:
                given = json.loads(value) if value.strip().startswith("{") else {}
            except ValueError:
                given = {}
            perms = given.get("permissions") if isinstance(given, dict) else None
            for k in ("deny", "ask"):
                if isinstance(perms, dict) and isinstance(perms.get(k), list):
                    asked.setdefault(k, []).extend(str(r) for r in perms[k])
        elif flag == "--mcp-config" and value:
            try:
                servers = (json.loads(value).get("mcpServers") or {}) if value.strip().startswith("{") else {}
            except (ValueError, AttributeError):
                servers = {}
            own = {n: s for n, s in servers.items() if isinstance(s, dict) and s.get("type") == "sdk"}
            if own:
                kept += ["--mcp-config", json.dumps({"mcpServers": own})]
        elif flag == "--add-dir" and value and _under(value, roots):
            kept += ["--add-dir", value]
        elif flag == "" and value is not None:
            kept.append(value)
    mode = modes.mode_for(job.c, ROWS[job.role])
    permission_mode = modes.flag(mode)
    settings: dict[str, Any] = {"permissions": dict(asked)}
    fenced = agent_session.fence(corpus, work, sandbox=conf.sandboxed, network=conf.network,
                                 auto_allow=not conf.install_asks(), required=conf.enforced, data=conf.data)
    perms = {**settings["permissions"]}
    for k, rules in fenced["permissions"].items():
        perms[k] = list(dict.fromkeys([*(perms.get(k) or []), *rules])) if isinstance(rules, list) else rules
    settings = {**fenced, "permissions": perms}
    settings = agent_session.with_config(settings, conf.settings())
    if conf.web == "ask":
        settings = agent_session.with_web_asks(settings, permission_mode)
    elif conf.web == "off":
        denied += list(agent_session.WEB_TOOLS)
    hooks = agent_session.permission_hooks(job.c, permission_mode == "auto", session=job.key,
                                           home=str(userconf.global_file().parent), wait=conf.may_ask())
    hooks.update(agent_session.scratch_hooks(work))
    settings["hooks"] = hooks
    shared = agent_session.shared_prompt(corpus)
    append = "\n\n".join([*appended, shared])
    deny = list(dict.fromkeys([*denied, *agent_session.not_own(job.tools), *agent_session.LATER_TOOLS]))
    final = [agent_session.CLAUDE_BIN, *kept, "--plugin-dir", str(agent_session.PLUGIN_DIR), "--add-dir", str(corpus),
             "--settings", json.dumps(settings), "--append-system-prompt", append, "--permission-mode", permission_mode,
             "--allowedTools", ",".join(agent_session.own_rules()), "--disallowedTools", ",".join(deny)]
    work.mkdir(parents=True, exist_ok=True)
    env = agent_session.environ(job.key, {**agent_session.fence_env(work),
                                          **agent_session.skill_prompts_env(corpus, work)})
    return final, work, env


def _proven(headers: Any) -> Run | None:
    """The live run whose token the WebSocket's headers prove (hook_auth's proof), else None."""
    aid = headers.get(hook_auth.AGENT_HEADER, "")
    nonce = headers.get(hook_auth.NONCE_HEADER, "")
    run = _runs.get(aid)
    if run is None or not nonce or len(nonce) > hook_auth.NONCE_MAX:
        return None
    want = hook_auth.sign(run.token, "hook", nonce)
    return run if hmac.compare_digest(headers.get(hook_auth.AUTH_HEADER, ""), want) else None


@router.websocket(SESSION_PATH)
async def session_route(ws: WebSocket) -> None:
    """A session an agent program's SDK asked for through claude_shim.py (module note, sessions)."""
    run = _proven(ws.headers)
    if run is None:
        await ws.close(code=4401)
        return
    await ws.accept()
    try:
        first = json.loads(await ws.receive_text())
    except (WebSocketDisconnect, ValueError):
        return
    argv = [str(a) for a in first.get("argv") or []] if isinstance(first, dict) else []
    if argv in (["-v"], ["--version"]):
        proc = await asyncio.create_subprocess_exec(config.CLAUDE_BIN, "-v", stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE)
        out, _ = await proc.communicate()
        await ws.send_bytes(b"o" + out)
        await ws.send_text(json.dumps({"exit": proc.returncode or 0}))
        await ws.close()
        return
    async with run.slots:
        try:
            final, folder, env = claude_argv(run, argv)
            proc = await asyncio.create_subprocess_exec(*final, cwd=str(folder), env=env,
                                                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.PIPE, start_new_session=True)
        except (OSError, userconf.ConfigError) as e:
            await ws.send_bytes(b"e" + f"thimble could not start the session: {e}\n".encode())
            await ws.send_text(json.dumps({"exit": 1}))
            await ws.close()
            return
        run.sessions.add(proc)

        async def pump(stream: Any, tag: bytes) -> None:
            while chunk := await stream.read(65536):
                await ws.send_bytes(tag + chunk)

        async def feed() -> None:
            assert proc.stdin is not None
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    raise WebSocketDisconnect()
                if msg.get("bytes") is not None:
                    proc.stdin.write(msg["bytes"])
                    await proc.stdin.drain()
                elif msg.get("text") and json.loads(msg["text"]).get("eof"):
                    proc.stdin.close()
                    return

        outs = [asyncio.ensure_future(pump(proc.stdout, b"o")), asyncio.ensure_future(pump(proc.stderr, b"e"))]
        feeding = asyncio.ensure_future(feed())
        try:
            waiting = asyncio.ensure_future(proc.wait())
            await asyncio.wait({waiting, feeding}, return_when=asyncio.FIRST_COMPLETED)
            if feeding.done() and feeding.exception() is not None:
                raise WebSocketDisconnect()
            await waiting
            await asyncio.gather(*outs, return_exceptions=True)
            await ws.send_text(json.dumps({"exit": proc.returncode if proc.returncode is not None else 1}))
            await ws.close()
        except (WebSocketDisconnect, RuntimeError, ConnectionError):
            pass
        finally:
            feeding.cancel()
            for t in outs:
                t.cancel()
            _end_group(proc)
            run.sessions.discard(proc)


def _end_group(proc: asyncio.subprocess.Process, sig: int = signal.SIGTERM) -> None:
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, sig)


# --------------------------------------------------------------------------- runs


def start(job: Job, part: roles.Part, *, on_start: Callable[[Run], None] | None = None,
          on_end: Callable[[Run, str, str], None] | None = None) -> Run:
    """Start `part`'s program for `job` in an agent chat (module note, start); `on_start` hears the run once its chat
    exists, `on_end` its status (done, failed or stopped) and its summary. RuntimeError when one runs for the key, or
    the role may not start (its config, or the sandbox it needs)."""
    if running(job.c, job.key):
        raise RuntimeError(f"the {job.role} program of {job.key} is running")
    try:
        conf = userconf.session(job.c, job.role, sandbox=True)
    except userconf.ConfigError as e:
        raise RuntimeError(str(e)) from e
    token_id = secrets.token_hex(8)
    run = Run(job, part, conf, token_id, f"{token_id}.{secrets.token_urlsafe(32)}")
    argv = program_argv(part)
    wrapped = boxed(run, argv)
    if wrapped is None and conf.conf.get("sandbox") != "off" and conf.enforced:
        raise RuntimeError(NO_BOX_ENFORCED.format(role=job.role))
    run.boxed = wrapped is not None
    _runs[token_id] = run
    _by_key[(job.c, job.key)] = run

    async def go(rec: agents.Recorder) -> str:
        run.rec, run.chat = rec, rec.chat_id
        status, summary = "failed", ""
        try:
            if on_start is not None:
                on_start(run)
            summary = await _run(run, wrapped or argv)
            status = "done"
            return summary
        except asyncio.CancelledError:
            status, summary = "stopped", agents.STOPPED_LINE
            raise
        except Exception as e:
            summary = str(e)
            raise
        finally:
            _runs.pop(token_id, None)
            if _by_key.get((job.c, job.key)) is run:
                _by_key.pop((job.c, job.key), None)
            if on_end is not None:
                try:
                    on_end(run, status, summary)
                except Exception:  # noqa: BLE001 — the run has ended either way
                    log.exception("%s: the end of the %s program could not be told", job.c, job.role)

    try:
        meta = agents.start_agent(job.c, job.chat_role or job.role, job.title, go, parent=job.parent,
                                  by=agents.TERMINAL, agent_type=f"{part.extension}:{job.role}",
                                  extension=part.extension, way=part.way, **job.fields)
        run.chat = str(meta["id"])
    except Exception:
        _runs.pop(token_id, None)
        _by_key.pop((job.c, job.key), None)
        raise
    return run


async def _run(run: Run, argv: list[str]) -> str:
    from . import agent_session  # noqa: PLC0415

    job = run.job
    for sub in (job.work, job.work / TMP_DIR, job.work / CACHE_DIR):
        sub.mkdir(parents=True, exist_ok=True)
    (job.work / INPUT_FILE).write_text(json.dumps(job.input, ensure_ascii=False, indent=1), "utf-8")
    if not run.boxed and run.rec is not None:
        run.rec.text(NO_BOX + "\n")
    hook_auth.grant(run.token_id, run.token, run.allows)
    hosted = agent_session.host(job.c, job.key, run.chat, agent=ROWS[job.role],
                                wait_s=agent_session.PERMISSION_WAIT_S, conf=run.conf)
    hosted.patient = job.patient
    try:
        try:
            run.proc = await asyncio.create_subprocess_exec(
                *argv, cwd=str(run.part.folder), env=program_env(run), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
                limit=LINE_LIMIT)
        except OSError as e:
            raise HarnessError(f"the {job.role} program of {run.part.extension} could not start: {e}") from e
        log.info("%s: %s program of %s started (pid %s, %s)", job.c, job.role, run.part.extension, run.proc.pid,
                 "in its sandbox" if run.boxed else "without a sandbox")
        await _say(run, {"input": job.input})
        readers = [asyncio.ensure_future(_read_stdout(run)), asyncio.ensure_future(_read_stderr(run))]
        code = await run.proc.wait()
        await asyncio.gather(*readers, return_exceptions=True)
        if run.tasks:
            await asyncio.gather(*list(run.tasks), return_exceptions=True)
    finally:
        hook_auth.revoke(run.token_id)
        agent_session.unhost(job.c, job.key)
        await _stop_all(run)
    if code != 0:
        tail = "\n".join(run.stderr).strip()[-1200:]
        raise HarnessError(f"the {job.role} program of {run.part.extension} ended with code {code}"
                           + (f": {tail}" if tail else ""))
    out = run.output
    return out if isinstance(out, str) else "" if out is None else json.dumps(out, ensure_ascii=False)


async def _stop_all(run: Run) -> None:
    procs = [p for p in (run.proc, *run.sessions) if p is not None and p.returncode is None]
    for p in procs:
        _end_group(p)
    for p in procs:
        try:
            await asyncio.wait_for(p.wait(), STOP_WAIT_S)
        except asyncio.TimeoutError:
            _end_group(p, signal.SIGKILL)
    for t in list(run.tasks):
        t.cancel()


async def stop(c: str, key: str) -> bool:
    run = current(c, key)
    if run is None or not run.chat:
        return False
    return await agents.stop_agent(c, run.chat)


async def shutdown() -> None:
    for run in list(_runs.values()):
        await _stop_all(run)
        hook_auth.revoke(run.token_id)

