"""A critique: the orientation's check of its own analysis, by a Claude Code session of its own running as the critic.

The critic reviews the orientation's whole transcript and cards for coverage and competing accounts, and checks the
drafted deck's claims against the calls that should support them. The machinery shared with other agent sessions is
agent_session.py; this module holds what is the critique's own.

Start. Only the orientation's session lists `critique`. The server starts `claude -p` in the critic's work folder
running as the critic agent (prompts/critic.md via `--agents`, shared.md appended), with the `critic` role's model
settings. It has every tool of a default Claude Code session and, of thimble's, OWN_TOOLS, so it adds no card, and it
runs in a work folder of its own with the corpus read-only (agent_session, the fence). One critique runs at a time, in
the orientation's permission mode.

The transcript. Raw transcripts run to megabytes of JSON and Read cuts lines at 2,000 characters, so the critique
renders the session's and its agents' transcripts into one digest, each tool call under its ref in the orientation's
call store (`call:<chat>/<n>`) with its input and the first lines of its result. The digest is written to
`<workspace>/critique/<chat>/transcript.md`, which the critic gets with `--add-dir`; the raw transcripts stay out of its
reach. `chat:<orientation chat>` resolves to the same digest, a page at a time.

The first message names what to review, the drafts, the digest, the orientation's context, the coverage checks'
findings, and ends with the analyst's conversation with main.

The chat is a step of the orientation's chat titled `critique`. The critic's last message is returned whole as the
tool's result. A critique that fails, is stopped, or runs past CRITIQUE_LIMIT_S of active time returns `##
critique-ended` with whatever it wrote; a call the caller abandons stops the critique with it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import textwrap
from pathlib import Path
from typing import Any

from . import agent_session, agents, cc_settings, config, orient_checks, orientation, session, tools

log = logging.getLogger("thimble.critique_session")

AGENT = "critic"  # prompts/critic.md, the agent the session runs as
TITLE = "critique"  # its step's title, so the browser names it `<caller>/critique`
DEFAULT_EFFORT = "high"  # when critic.md names none
# The most active time a critique may take, by effort. The orientation waits inside one tool call, so a hanging critic
# is stopped past the limit and the orientation hears `## critique-ended`.
CRITIQUE_LIMIT_S = {"low": 1200.0, "medium": 1200.0, "high": 1800.0, "xhigh": 2700.0, "max": 3600.0}
DIGEST_DIR = "critique"  # the one folder outside the corpus the critic may read
WORK_DIR = "work"  # critique/<chat>/work, the critic's own folder, where it may write
OWN_TOOLS = ("read_ref", "list_cards")  # the critic's thimble tools
DIGEST_FILE = "transcript.md"
RESULT_LINES = 8  # lines of a tool result the digest shows; a card reads whole with read_ref, a file with Read
# lines of a Read's result: the critic reads the file itself, and the call's input says which part the agent saw
READ_LINES = 2
LINE_CHARS = 200  # chars of one of those lines
VALUE_CHARS = 400  # chars of one string of a call's input, such as a card's code
CALL_CHARS = 1_500  # chars of a call's line, under the 2,000 at which Read cuts a line
DIGEST_CHARS = 2_000_000  # a guard against a runaway session
DIGEST_PAGE_LINES = 600  # of the digest a `chat:` ref reads at once (resolve_chat)
CONTEXT_CHARS = 400_000  # of the analyst's conversation with main in the first message
INDENT = "    "


def session_key(caller: str) -> str:
    """The THIMBLE_SESSION of the session critiquing the analysis of the session `caller` (tools.session_kind reads its
    kind)."""
    return f"{tools.CRITIQUE_SESSION}:{caller}"


def agent_definition() -> tuple[str, dict[str, Any]]:
    """(name, definition) of the critic agent for `--agents`, from prompts/critic.md."""
    from . import cli  # noqa: PLC0415 — cli is large, and the definition's shape is the launcher's

    return cli.agent_definition(AGENT)


def orientation_run(c: str, key: str | None) -> agent_session.Run | None:
    """The orientation's running session when `key`, the THIMBLE_SESSION of the call, is its; None for any other."""
    if tools.session_kind(key) != tools.ORIENT_SESSION:
        return None
    return agent_session.current(c, key)


# --------------------------------------------------------------------------- the transcript's digest


def _started(path: Path) -> str:
    """When an agent's transcript starts, its first record's timestamp, so the agents list in the order they ran."""
    try:
        with path.open("rb") as f:
            for line in f:
                try:
                    stamp = session._load(line).get("timestamp")
                except session.Unreadable:
                    continue
                if isinstance(stamp, str):
                    return stamp
    except OSError:
        pass
    return "~"  # after every timestamp


def transcripts(run: agent_session.Run) -> list[tuple[str, Path]]:
    """(title, path) of the session's transcript, then of each of its subagents' and workflow agents', in the order they
    started; [] while the session's own is not found."""
    main = run.main.path if run.main is not None and run.main.path is not None else None
    return transcripts_of(run.c, run.chat, run.sid, main)


def transcripts_of(c: str, chat: str, sid: str, main: Path | None = None) -> list[tuple[str, Path]]:
    """transcripts for the session `sid` of the orientation chat `chat`, running or not: a title is the chat's for the
    session, and for an agent its workflow phase, its description and its type, as the meta json names them."""
    if main is None and sid:
        found = session.find_transcript(sid)
        main = Path(found) if found else None
    if main is None or not main.is_file():
        return []
    title = str((agents.meta_or_none(c, chat) or {}).get("title") or orientation.TITLE)
    out = [(title, main)]
    folder = main.parent / sid / "subagents"
    steps: list[tuple[str, str, Path]] = []
    for path in sorted(folder.rglob("agent-*.jsonl")) if folder.is_dir() else []:
        if not session.AGENT_FILE_RE.match(path.name):
            continue
        meta = session._read_meta_json(path)
        label = str(meta.get("description") or meta.get("agentType") or path.stem)
        phase, kind = str(meta.get("workflowPhase") or ""), str(meta.get("agentType") or "")
        name = f"{phase}: {label}" if phase else label
        steps.append((_started(path), f"{name} ({kind})" if kind and kind != label else name, path))
    return out + [(t, p) for _, t, p in sorted(steps, key=lambda s: s[0])]


def _cut(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _short_values(v: Any) -> Any:
    if isinstance(v, str):
        return _cut(v, VALUE_CHARS)
    if isinstance(v, dict):
        return {k: _short_values(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_short_values(x) for x in v]
    return v


def _call_line(n: "int | str", name: str, inp: Any, root: str = "") -> str:
    """`<ref> <tool> <input as JSON>` (`<n>.` without a ref), strings cut to VALUE_CHARS, corpus paths relative to
    `root`, the line cut to CALL_CHARS."""
    body = json.dumps(_short_values(inp), ensure_ascii=False, default=str) if inp not in (None, {}, []) else ""
    lead = n if isinstance(n, str) else f"{n}."
    return _cut(f"{lead} {session._short(name)} {_relative(body, root)}".rstrip(), CALL_CHARS)


def _relative(text: str, root: str) -> str:
    return text.replace(root.rstrip("/") + "/", "") if root.startswith("/") and root.rstrip("/") else text


def _result_lines(text: str, is_error: bool, limit: int = RESULT_LINES, root: str = "") -> list[str]:
    """A result's first `limit` lines, indented under its call, paths relative to the corpus folder `root`, less a
    thimble tool's echo of the call, which the call's line shows; an error's first line marked ✗."""
    rows = _relative(text, root).strip("\n").splitlines()
    if rows and rows[0].startswith("$ "):
        rows = rows[1:]
    shown = [INDENT + _cut(r, LINE_CHARS) for r in rows[:limit]]
    if len(rows) > limit:
        shown.append(INDENT + tools.hint("critique-transcript-cut", n=f"{len(rows) - limit:,}"))
    if is_error:
        shown = [INDENT + "✗ " + shown[0][len(INDENT):]] + shown[1:] if shown else [INDENT + "✗"]
    return shown


def render(title: str, path: Path, root: str = "", refs: "tuple[str, str] | None" = None) -> str:
    """One transcript as the digest shows it: `# <title>`, then its brief, its text and each tool call under its ref
    with its result beneath, corpus paths relative to `root`. `refs` (workspace, orientation chat) names the call store
    numbering the refs; without it calls are numbered from 1. Reminders, ToolSearch and unreadable lines are left out.
    """
    from . import calls  # noqa: PLC0415

    entries: list[tuple[str, Any]] = []  # ("text", str) or ("call", tool_use_id)
    lines_: dict[str, str] = {}
    reads: set[str] = set()  # the Read calls, whose results show READ_LINES
    results: dict[str, list[str]] = {}
    n = 0
    try:
        raw = path.read_bytes()
    except OSError:
        raw = b""
    for line in raw.splitlines():
        try:
            rec = session._load(line)
        except session.Unreadable:
            continue
        kind = rec.get("type")
        if kind == "user" and not rec.get("isMeta"):
            blocks = [b for b in session._content_list(rec) if isinstance(b, dict) and b.get("type") == "tool_result"]
            for b in blocks:
                tid = str(b.get("tool_use_id") or "")
                if tid in lines_:  # not a result whose call the digest leaves out (ToolSearch)
                    results[tid] = _result_lines(session.response_text(b.get("content")), bool(b.get("is_error")),
                                                 READ_LINES if tid in reads else RESULT_LINES, root)
            text = session._user_text(rec) if not blocks else None
            if text and text.strip() and not text.lstrip().startswith("<"):
                entries.append(("text", "\n".join(f"> {ln}".rstrip() for ln in text.strip().splitlines())))
        elif kind == "assistant":
            try:
                blocks = session._blocks(rec)
            except session.Unreadable:
                continue
            for b in blocks:
                if b["type"] == "text" and str(b.get("text") or "").strip():
                    entries.append(("text", str(b["text"]).strip()))
                elif b["type"] == "tool_use" and b.get("name") not in session.PLUMBING_TOOLS:
                    name, inp = str(b.get("name") or ""), b.get("input")
                    message = inp.get("message") if isinstance(inp, dict) else None
                    if name == session.HANDBACK_TOOL and isinstance(message, str) and message.strip():
                        entries.append(("text", message.strip()))  # a subagent's report to its caller, whole
                        continue
                    n += 1
                    tid = str(b.get("id") or f"#{n}")
                    lead: "int | str" = n
                    if refs is not None and b.get("id"):
                        lead = calls.ref(refs[1], calls.number(refs[0], refs[1], tid, name, inp))
                    lines_[tid] = _call_line(lead, name, inp, root)
                    if name == "Read":
                        reads.add(tid)
                    entries.append(("call", tid))
    out = [f"# {title}"]
    for kind, value in entries:
        out.append("")
        if kind == "text":  # a heading an agent wrote is escaped, so `# ` begins an agent's part alone
            out.append("\n".join("\\" + ln if ln.startswith("#") else ln for ln in value.splitlines()))
        else:
            out.append(lines_[value])
            out.extend(results.get(value, []))
    return "\n".join(out)


def digest(run: agent_session.Run) -> str:
    """The session's transcript and its agents', rendered (render) with the refs of the orientation's call store, one
    after the other; '' while the session's own is not found."""
    chat = run.calls or run.chat
    return digest_of(run.c, chat, transcripts(run), str(run.cwd))


def digest_of(c: str, chat: str, parts: "list[tuple[str, Path]]", root: str) -> str:
    text = "\n\n".join(render(title, path, root, (c, chat)) for title, path in parts)
    if len(text) > DIGEST_CHARS:
        left = text[DIGEST_CHARS:].count("\n") + 1
        text = text[:DIGEST_CHARS] + "\n" + tools.hint("critique-transcript-cut", n=f"{left:,}")
    return text


_digests: dict[tuple[str, str], tuple[tuple, str]] = {}  # (workspace, chat) -> (the transcripts' sizes, the digest)


def chat_digest(c: str, chat: str) -> str:
    """The digest of the orientation chat `chat` (its session's transcripts, running or not), '' when the chat is no
    orientation's or its transcript is gone; kept while the transcripts do not grow."""
    meta = agents.meta_or_none(c, chat) or {}
    if meta.get("role") != orientation.ROLE or not meta.get("session"):
        return ""
    parts = transcripts_of(c, chat, str(meta["session"]))
    if not parts:
        return ""
    sizes = tuple(session._size(p) for _, p in parts)
    hit = _digests.get((c, chat))
    if hit is not None and hit[0] == sizes:
        return hit[1]
    try:
        root = str(config.corpus_dir(c))
    except Exception:  # noqa: BLE001 — a corpus that is gone leaves absolute paths
        root = ""
    text = digest_of(c, chat, parts, root)
    _digests[(c, chat)] = (sizes, text)
    return text


def resolve_chat(c: str, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """`chat:<orientation chat>` and `chat:<chat>#L<a>-L<b>` as refs.resolve answers: a DIGEST_PAGE_LINES page of the
    digest, with a `## digest-more` line naming the next page's ref. RefError 404 when the chat is no orientation's or
    its transcript is gone."""
    from .refs import RefError  # noqa: PLC0415 — refs imports this module lazily

    chat = str(p["chat_id"])
    text = chat_digest(c, chat)
    if not text:
        raise RefError(f"chat:{chat} is no orientation whose transcript Claude Code still keeps", 404)
    lines = text.split("\n")
    a = max(1, int(p.get("line") or 1))
    b = min(int(p.get("end_line") or (a + DIGEST_PAGE_LINES - 1)), a + DIGEST_PAGE_LINES - 1, len(lines))
    if a > len(lines):
        raise RefError(f"chat:{chat} has {len(lines)} lines", 404)
    body = "\n".join(lines[a - 1 : b])
    if b < len(lines):
        body += "\n" + tools.hint("digest-more", ref=f"chat:{chat}#L{b + 1}-L{min(b + DIGEST_PAGE_LINES, len(lines))}",
                                  total=f"{len(lines):,}")
    return {"ref": ref, "kind": "chat", "excerpt": body,
            "meta": {"chat": chat, "line": a, "end_line": b, "lines": len(lines)}}


def work_dir(c: str, chat: str) -> Path:
    """The critic's own folder for the orientation chat `chat`, where it may write."""
    return config.workspace_dir(c) / DIGEST_DIR / chat / WORK_DIR


def write_digest(c: str, run: agent_session.Run) -> Path | None:
    """The digest of the session `run`, written to its folder in workspace `c`; None when the transcript is not found or
    the file cannot be written."""
    text = digest(run)
    if not text:
        log.info("%s: the transcript of session %s (%s) was not found", c, run.key, run.sid)
        return None
    path = config.workspace_dir(c) / DIGEST_DIR / run.chat / DIGEST_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    except OSError as e:
        log.warning("%s: the transcript digest of session %s was not written (%s)", c, run.key, e)
        return None
    return path


# --------------------------------------------------------------------------- the session


def drafts(c: str) -> list[str]:
    """The parts of the first message that name the orientation's drafts: `## critique-deck` when its deck is on, and
    `## critique-proposals` with each view it proposed, since no tool lists proposals."""
    from . import views  # noqa: PLC0415

    out: list[str] = []
    run = orientation.read_run(c) or {}
    if orientation.deck_of(run):
        out.append(tools.hint("critique-deck", deck=orientation.GROUP_PATHS["deck"]))
    mine = [p for p in views.list_proposals(c) if (p.get("orientation") or p.get("held")) and p.get("status") != "dropped"]
    if mine:
        rows = "\n".join(f"- {p.get('name')}: {p.get('why')} Claims {', '.join(p.get('claims') or [])}.\n"
                         + textwrap.indent(views.spec_lines(p), "  ") for p in mine)
        out.append(tools.hint("critique-proposals", proposals=rows))
    return out


async def checks_text(c: str) -> str | None:
    """What the coverage checks found for workspace `c`, as the first message lists it; None when they did not run or
    failed. The checks run in a child process, which a cancelled critique kills."""
    try:
        return orient_checks.text(await orient_checks.check_apart(c))
    except ValueError as e:  # a corpus that is gone
        log.info("%s: the coverage checks did not run (%s)", c, e)
    except (TimeoutError, RuntimeError) as e:
        log.warning("%s: the coverage checks failed (%s)", c, e)
    return None


def first_message(c: str, transcript: Path | None, context: str, checks: str | None = None) -> str:
    """The session's first message, with `checks`, what checks_text found."""
    parts = [tools.hint("critique-task"), *drafts(c),
             tools.hint("critique-transcript", path=str(transcript)) if transcript else tools.hint("critique-no-transcript")]
    if context.strip():
        parts.append(tools.hint("critique-context", context=context.strip()))
    if checks is not None:
        parts.append(tools.hint("critique-checks", checks=checks))
    from . import context as engine  # noqa: PLC0415 — the context engine reads the orientation's digest from this module

    parts.append(engine.render(c, budget=CONTEXT_CHARS, parts=("conversation",)))
    return "\n\n".join(p.strip() for p in parts if p.strip())


async def start(c: str, caller: agent_session.Run, context: str = "") -> tuple[agent_session.Run, asyncio.Future]:
    """Start the session critiquing the analysis of the session `caller` (the orientation's) for workspace `c`, as a
    step of its chat, and follow it; returns the run and a future of (status, report) set when it ends. RuntimeError
    with the text for the model when a critique of it runs or claude cannot be started."""
    key = session_key(caller.key)
    if agent_session.running(c, key):
        raise RuntimeError(tools.hint("critique-running"))
    # Rendering megabytes of transcript runs in a thread and the checks in a child process, off the event loop, which
    # serves every other session meanwhile.
    transcript = await asyncio.to_thread(write_digest, c, caller)
    checks = await checks_text(c)
    prompt = await asyncio.to_thread(first_message, c, transcript, context, checks)
    if agent_session.running(c, key):  # a second call that started while this one rendered
        raise RuntimeError(tools.hint("critique-running"))
    agent_name, agent, conf, effort = _critic(c)
    done: asyncio.Future = asyncio.get_running_loop().create_future()

    def ended(run: agent_session.Run, status: str, summary: str) -> None:
        if not done.done():
            done.set_result((status, agent_session.with_earlier(run, summary)))

    # The digest's folder is the one place outside the corpus folder the critic may read.
    readable = ["--add-dir", str(transcript.parent)] if transcript else []
    fields = {"transcript": str(transcript)} if transcript else {}
    run = await agent_session.start(
        c, key, role=agent_session.STEP_ROLE, title=TITLE,
        agent_args=["--agents", json.dumps({agent_name: agent}, ensure_ascii=False), "--agent", agent_name, *readable],
        effort=effort, settings=agent_session.settings_json(effort, fastMode=bool(conf["fast"])), prompt=prompt,
        agent_type=agent_name, on_end=ended, parent=caller.chat, model=str(agent.get("model") or ""),
        calls=caller.calls or caller.chat,  # numbered in the orientation's sequence
        # the orientation's permission mode, followed at each request
        permission_mode=cc_settings.orient_permission_flag(caller.mode) if caller.mode else "",
        mode_owner=caller.key if caller.mode else None, patient=caller.patient,
        work=work_dir(c, caller.chat), unasked=True, disallowed=agent_session.not_own(OWN_TOOLS),
        brief=prompt.split("\n\n", 1)[0], background=caller.bg, **fields)  # the critique-task line that opens the first message
    return run, done


def _relaunch(c: str, meta: dict[str, Any]) -> dict[str, Any]:
    """The start arguments of a critic's background session that this server did not start, from its chat's meta
    (agent_session.on_relaunch): a later turn of it is followed, and its Resume starts it again, with no critique
    waiting on it."""
    agent_name, agent, conf, effort = _critic(c)
    transcript = str(meta.get("transcript") or "")
    readable = ["--add-dir", str(Path(transcript).parent)] if transcript else []
    parent = str(meta.get("parent") or agents.MAIN_ID)
    return dict(role=agent_session.STEP_ROLE, title=TITLE,
                agent_args=["--agents", json.dumps({agent_name: agent}, ensure_ascii=False), "--agent", agent_name, *readable],
                effort=effort, settings=agent_session.settings_json(effort, fastMode=bool(conf["fast"])),
                agent_type=agent_name, parent=parent, model=str(agent.get("model") or ""), work=work_dir(c, parent),
                unasked=True, disallowed=agent_session.not_own(OWN_TOOLS), background=True)


agent_session.on_relaunch(tools.CRITIQUE_SESSION, _relaunch)


def _critic(c: str) -> tuple[str, dict[str, Any], dict[str, Any], str]:
    """(name, definition, role settings, effort) of the critic for workspace `c`: critic.md's agent with the `critic`
    role's model, effort and fast mode (config.models_for)."""
    agent_name, agent = agent_definition()
    conf = config.models_for(c)["critic"]
    agent = agent_session.role_agent(agent, conf)
    return agent_name, agent, conf, str(agent.get("effort") or DEFAULT_EFFORT)


def critique_limit(effort: str) -> float:
    """CRITIQUE_LIMIT_S for a critique at `effort`; the longest for a level the table does not name."""
    return CRITIQUE_LIMIT_S.get(effort, max(CRITIQUE_LIMIT_S.values()))


async def tool_critique(ctx: Any, args: dict[str, Any]) -> Any:
    """The `critique` tool: start the critique of the calling orientation's analysis and wait for the critic's report,
    which it returns whole. A critique past CRITIQUE_LIMIT_S of active time is stopped and returns `## critique-ended`.

    When this call is cancelled (the shim's request dropped, the orientation stopped, or the server stopping), the
    checks' child and the critic's session end with it.
    """
    caller = orientation_run(ctx.c, ctx.session)
    if caller is None:
        return tools.err(tools.hint("critique-not-orientation"))
    try:
        run, done = await start(ctx.c, caller, str(args.get("context") or ""))
    except RuntimeError as e:
        return tools.err(str(e))
    limit = critique_limit(_critic(ctx.c)[3])
    waiting = asyncio.ensure_future(agent_session.wait_active(run, done, limit))
    gone = asyncio.ensure_future(_caller_ended(caller))
    try:
        await asyncio.wait({waiting, gone}, return_when=asyncio.FIRST_COMPLETED)
        if not waiting.done():
            log.info("%s: the orientation's session %s ended during its critique, which is stopped", ctx.c, caller.sid)
            await asyncio.shield(agent_session.stop_run(run))
            return tools.err(tools.hint("critique-ended", status="stopped", text="nothing"))
        if not waiting.result():
            await agent_session.stop_run(run)
            _, summary = done.result() if done.done() else ("stopped", "")
            return tools.err(tools.hint("critique-ended", status=f"after running past its {limit / 60:.0f}-minute limit",
                                        text=str(summary or "").strip() or "nothing"))
        status, summary = done.result()
    except asyncio.CancelledError:
        # shielded, so a second cancellation (the server's last sweep of its tasks) cannot cut the stop short
        await asyncio.shield(agent_session.stop_run(run))
        raise
    finally:
        waiting.cancel()
        gone.cancel()
    if status != "done":
        return tools.err(tools.hint("critique-ended", status=status, text=summary.strip() or "nothing"))
    return tools.ok(summary.strip())


async def _caller_ended(caller: agent_session.Run) -> None:
    """Return once the orientation's session `caller` no longer runs (agent_session._end took it out, or its follower
    has finished)."""
    while agent_session.current(caller.c, caller.key) is caller:
        if caller.task is None:
            await asyncio.sleep(agent_session.POLL_S)
            continue
        if caller.task.done():
            return
        await asyncio.wait({caller.task}, timeout=agent_session.POLL_S)
