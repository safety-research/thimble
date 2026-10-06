"""A critique: the orientation's check of its own analysis, by `thimble:critic`, a subagent the orientation starts
itself (depth 2) after its `critique` call returns.

The critic reviews the orientation's whole transcript and cards for coverage and competing accounts, and checks the
drafted deck's claims against the calls that should support them. Its registration (definition) is prompts/critic.md
with shared.md loaded as the skill `thimble:shared`, the `critic` role's model and effort from Settings, and of thimble's
tools OWN_TOOLS, so it adds no card. It writes only in its own work folder, critique-work/<chat>; when its run ends, its
subagents' `tmp_*` folders and the large files no card uses are deleted there (work_files.after_run).

The transcript. Raw transcripts run to megabytes of JSON and Read cuts lines at 2,000 characters, so the critique
renders the orientation's agent transcript and its descendants' into one digest, each tool call under its ref in the
orientation's call store (`call:<chat>/<n>`) with its input and the first lines of its result. The digest is written to
`<workspace>/critique/<chat>/transcript.md`, which main's fence lets every agent read. `chat:<orientation chat>`
resolves to the same digest, a page at a time.

The brief. `critique` writes the critic's first message to `critique/<chat>/brief.md`: what to review, the drafts, the
digest, the orientation's context, the coverage checks' findings led by the coverage line, and the analyst's
conversation with main. It records a pending start of the critic for the orientation's run and returns the exact Agent
call (`## critique-subagent`); the orientation makes it, ends its turn, and revises when the critic's report arrives as a
message (F1). Meanwhile its chat is `paused: critique`. The critic's chat is a step of the orientation's chat titled
`critique`.

An extension's program can run the critique instead (program_critique): it gets the same digest, through one Caller
for both, and its report is the tool's result; the orientation's end stops it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import agents, config, orient_checks, orientation, session, subagents, tools, work_files

log = logging.getLogger("thimble.critique_session")

AGENT = "critic"  # prompts/critic.md, the critic's registered prompt
ROLE = "critic"  # its role among subagents.TYPES
TITLE = "critique"  # its step's title, so the browser names it `<caller>/critique`
DIGEST_DIR = "critique"  # the one folder outside the corpus and the work folders the critic reads
WORK_DIR = "critique-work"  # critique-work/<chat>, the critic's own folder, where it may write
BRIEF_FILE = "brief.md"  # in critique/<chat>: the critic's first message
SKILLS = ("thimble:shared",)
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
    """The key of the critic of the agent of `caller` (tools.session_kind reads its kind): `critique:orient`."""
    return f"{tools.CRITIQUE_SESSION}:{caller}"


def definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:critic` for workspace `c` (subagents.roles adds its model, effort and
    `background`): critic.md's body, its frontmatter's description, shared.md as the skill `thimble:shared`, and the
    thimble tools that are not the critic's taken away."""
    from . import cli, prompts, userconf  # noqa: PLC0415

    with prompts.custom(userconf.prompt_files(c, "critic")):
        _, agent = cli.agent_definition(AGENT)
    out = {k: agent[k] for k in ("description", "prompt") if k in agent}
    out["skills"] = list(dict.fromkeys([*SKILLS, *(agent.get("skills") or [])]))
    out["disallowedTools"] = tools.not_own(OWN_TOOLS)
    return out


@dataclass
class Caller:
    """The orientation whose analysis a critique reviews, as thimble's critic and an extension's program both see it:
    its key, chat, agent id, main's session, and the corpus folder its paths are relative to. `calls` is the chat whose
    call store numbers the digest's refs."""

    c: str
    key: str
    chat: str
    agent_id: str | None
    sid: str
    cwd: str

    @property
    def calls(self) -> str:
        return self.chat

    def transcripts(self) -> list[tuple[str, Path]]:
        if self.agent_id:
            return agent_transcripts(self.c, self.chat, self.agent_id)
        return transcripts_of(self.c, self.chat, self.sid)

    def stopped(self) -> bool:
        return not subagents.running(self.c, self.key)


def orientation_caller(c: str, key: str | None) -> Caller | None:
    """The Caller of the orientation's running agent when `key`, the session a call runs as, is its; None for any
    other."""
    if tools.session_kind(key) != tools.ORIENT_SESSION:
        return None
    run = subagents.current(c, key)
    if run is None:
        return None
    try:
        root = str(config.corpus_dir(c))
    except Exception:  # noqa: BLE001
        root = ""
    return Caller(c, run.key, run.chat, run.agent_id, run.sid, root)


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


def transcripts_of(c: str, chat: str, sid: str, main: Path | None = None) -> list[tuple[str, Path]]:
    """The transcripts of an orientation an earlier version ran as a session of its own, `sid`, for its chat `chat`:
    the session's, then each of its agents', in the order they started; a title is the chat's for the session, and for
    an agent its workflow phase, its description and its type, as the meta json names them."""
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


def agent_files(c: str, agent_id: str, sessions: "list[str]") -> list[Path]:
    """The transcript files of main's subagent `agent_id`, in the folder of each session it ran under (after /clear or
    /resume Claude Code continues it in the new session's folder, U1), oldest first."""
    out: list[Path] = []
    for sid in dict.fromkeys(s for s in sessions if s):
        found = session.find_transcript(sid)
        if not found:
            continue
        path = Path(found).parent / sid / "subagents" / f"agent-{agent_id}.jsonl"
        if path.is_file():
            out.append(path)
    return out


def agent_transcripts(c: str, chat: str, agent_id: str) -> list[tuple[str, Path]]:
    """(title, path) of the orientation agent `agent_id`'s transcript (each part of it, after /clear), then of each of
    its descendants' (found by `parentAgentId` in their meta json, at any depth), in the order they started; [] while
    the orientation's own is not found."""
    a = subagents.agent(c, agent_id) or {}
    meta = agents.meta_or_none(c, chat) or {}
    sessions = [str(s) for s in (a.get("sessions") or meta.get("sessions") or [meta.get("session")]) if s]
    own = agent_files(c, agent_id, sessions)
    if not own:
        return []
    title = str(meta.get("title") or orientation.TITLE)
    out = [(title, p) for p in own]
    folders = list(dict.fromkeys(p.parent for p in own))
    metas: dict[str, tuple[dict, Path]] = {}
    for folder in folders:
        for path in sorted(folder.glob("agent-*.jsonl")):
            m = session.AGENT_FILE_RE.match(path.name)
            if m and m.group(1) != agent_id:
                metas.setdefault(m.group(1), (session._read_meta_json(path), path))
    mine = {agent_id}
    grew = True
    while grew:
        grew = False
        for aid, (m, _) in metas.items():
            if aid not in mine and str(m.get("parentAgentId") or "") in mine:
                mine.add(aid)
                grew = True
    steps: list[tuple[str, str, Path]] = []
    for aid, (m, path) in metas.items():
        if aid not in mine:
            continue
        label = str(m.get("description") or m.get("agentType") or path.stem)
        phase, kind = str(m.get("workflowPhase") or ""), str(m.get("agentType") or "")
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


def digest(caller: Caller) -> str:
    """The orientation's transcript and its agents', rendered (render) with the refs of its call store, one after the
    other; '' while its own is not found."""
    return digest_of(caller.c, caller.calls, caller.transcripts(), caller.cwd)


def digest_of(c: str, chat: str, parts: "list[tuple[str, Path]]", root: str) -> str:
    text = "\n\n".join(render(title, path, root, (c, chat)) for title, path in parts)
    if len(text) > DIGEST_CHARS:
        left = text[DIGEST_CHARS:].count("\n") + 1
        text = text[:DIGEST_CHARS] + "\n" + tools.hint("critique-transcript-cut", n=f"{left:,}")
    return text

_digests: dict[tuple[str, str], tuple[tuple, str]] = {}  # (workspace, chat) -> (the transcripts' sizes, the digest)


def chat_digest(c: str, chat: str) -> str:
    """The digest of the orientation chat `chat` (its agent's transcripts, or an earlier version's session's, running or
    not), '' when the chat is no orientation's or its transcript is gone; kept while the transcripts do not grow."""
    meta = agents.meta_or_none(c, chat) or {}
    if meta.get("role") != orientation.ROLE or not (meta.get("agent_id") or meta.get("session")):
        return ""
    if meta.get("route") == "subagent" and meta.get("agent_id"):
        parts = agent_transcripts(c, chat, str(meta["agent_id"]))
    else:
        parts = transcripts_of(c, chat, str(meta.get("session") or ""))
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
    """The critic's own folder for the orientation chat `chat`, where it may write (subagents.write_dirs)."""
    return config.workspace_dir(c) / WORK_DIR / chat


def digest_dir(c: str, chat: str) -> Path:
    return config.workspace_dir(c) / DIGEST_DIR / chat


def write_digest(c: str, caller: Caller) -> Path | None:
    """The digest of the orientation `caller`, written to its folder in workspace `c`; None when its transcript is not
    found or the file cannot be written."""
    text = digest(caller)
    if not text:
        log.info("%s: the transcript of the orientation %s was not found", c, caller.chat)
        return None
    path = digest_dir(c, caller.chat) / DIGEST_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    except OSError as e:
        log.warning("%s: the transcript digest of %s was not written (%s)", c, caller.chat, e)
        return None
    return path


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

async def checks_text(c: str, chat: str | None = None) -> str | None:
    """What the coverage checks found for workspace `c`, as the first message lists it, with the coverage line of the
    orientation chat `chat` in place of the unread line; None when they did not run or failed. The checks run in a
    child process, which a cancelled critique kills."""
    try:
        return orient_checks.text(await orient_checks.check_apart(c, coverage_of=chat))
    except ValueError as e:  # a corpus that is gone
        log.info("%s: the coverage checks did not run (%s)", c, e)
    except (TimeoutError, RuntimeError) as e:
        log.warning("%s: the coverage checks failed (%s)", c, e)
    return None

def first_message(c: str, transcript: Path | None, context: str, checks: str | None = None) -> str:
    """The critic's first message (its brief), with `checks`, what checks_text found."""
    parts = [tools.hint("critique-task"), *drafts(c),
             tools.hint("critique-transcript", path=str(transcript)) if transcript else tools.hint("critique-no-transcript")]
    if context.strip():
        parts.append(tools.hint("critique-context", context=context.strip()))
    if checks is not None:
        parts.append(tools.hint("critique-checks", checks=checks))
    from . import context as engine  # noqa: PLC0415 — the context engine reads the orientation's digest from this module

    parts.append(engine.render(c, budget=CONTEXT_CHARS, parts=("conversation",)))
    return "\n\n".join(p.strip() for p in parts if p.strip())


async def brief(c: str, caller: Caller, context: str = "") -> tuple[Path | None, str]:
    """(the digest's path, the brief): the digest written, the checks run in a child process and the brief rendered,
    each off the event loop."""
    transcript = await asyncio.to_thread(write_digest, c, caller)
    checks = await checks_text(c, caller.chat)
    text = await asyncio.to_thread(first_message, c, transcript, context, checks)
    return transcript, text


async def tool_critique(ctx: Any, args: dict[str, Any]) -> Any:
    """The `critique` tool, the orientation's: the digest and the brief written (critique/<chat>/brief.md), a pending
    start of the critic for the orientation's run, and the exact Agent call the orientation makes, then ends its turn
    and revises when the report arrives (`## critique-subagent`). Its chat is `paused: critique` meanwhile. An
    extension's program runs the critique instead (program_critique)."""
    caller = orientation_caller(ctx.c, ctx.session)
    if caller is None:
        return tools.err(tools.hint("critique-not-orientation"))
    from . import roles  # noqa: PLC0415

    agent = roles.agent_for(ctx.c, "critic")
    if agent.code and agent.replacing is not None:
        return await program_critique(ctx.c, caller, agent.replacing, str(args.get("context") or ""))
    key = session_key(caller.key)
    if subagents.running(ctx.c, key):
        return tools.err(tools.hint("critique-running"))
    _, text = await brief(ctx.c, caller, str(args.get("context") or ""))
    path = digest_dir(ctx.c, caller.chat) / BRIEF_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    except OSError as e:
        return tools.err(f"critique: the brief was not written ({e})")
    task = "\n\n".join(x for x in (tools.hint("critique-task"), tools.hint("critic-brief-file", path=str(path))) if x)
    ans = await subagents.start_job(ctx.c, ROLE, key, task, subagents.values_for(ctx.c, ROLE), subagents.TYPED,
                                    description=TITLE, chat={"title": TITLE, "parent": caller.chat,
                                                             "brief": tools.hint("critique-task")},
                                    work=work_dir(ctx.c, caller.chat), call=ctx.tool_use_id,
                                    caller_role="orientation")
    if caller.agent_id:
        subagents.set_paused(ctx.c, caller.agent_id, "critique")
    return tools.ok(tools.hint("critique-subagent", input=json.dumps(ans["input"], ensure_ascii=False)))


NEVER_STARTED = "the orientation ended its run without starting the critic"  # a critic start it never made (expire)


def expire_pending(c: str, orient: subagents.Run) -> list[str]:
    """The orientation's run ended: a critic start its `critique` call made and its own Agent call never claimed is
    refused (kind no-call), so it waits no more and --agent-check denies a late call of it. The R3 check of main's turns
    skips an agent's own starts, so nothing else ends it. The request ids refused."""
    key = session_key(orient.key)
    out = []
    for rid, r in list((subagents.read(c).get("requests") or {}).items()):
        if (isinstance(r, dict) and r.get("kind") == "start" and r.get("key") == key and r.get("caller_role")
                and r.get("state") == "pending"):
            subagents.refuse(c, rid, NEVER_STARTED, subagents.NO_CALL)
            out.append(rid)
    return out


def subagent_started(c: str, run: subagents.Run, req: dict[str, Any]) -> None:
    """The critic started: its orientation waits for its report (`paused: critique`, subagents.started_route)."""


def subagent_ended(c: str, run: subagents.Run, status: str, summary: str) -> None:
    """The critic's run ended: its work folder lets go of what it no longer needs; its report reaches the orientation
    as Claude Code's hand-back, which continues the orientation's run (subagents.child_ended)."""
    a = subagents.agent(c, run.agent_id) or {}
    parent = str(a.get("parent") or "")
    meta = agents.meta_or_none(c, run.chat) or {}
    work_files.after_run(c, work_dir(c, str(meta.get("parent") or run.chat)), status)
    if parent:
        subagents.child_ended(c, parent)


def subagent_refused(c: str, req: dict[str, Any]) -> None:
    """A critic's start that did not happen: the orientation's thread says so, and it goes on without the critique
    (its prompt says to revise without it and say so)."""
    for agent_id, a in subagents.agents_of(c, "orientation").items():
        if a.get("status") in ("running", "waiting") and a.get("chat"):
            subagents.set_paused(c, agent_id, None)
            try:
                agents.chip(c, "critique_refused", str(req.get("reason") or ""), chat=str(a["chat"]),
                            kind_refused=req.get("refused_kind"))
            except Exception:  # noqa: BLE001
                log.debug("%s: the refused critique did not reach %s", c, a["chat"], exc_info=True)


async def program_critique(c: str, caller: Caller, part: Any, context: str = "") -> Any:
    """The critique run by an extension's program (harness.py): its input is the digest thimble's critic reads, and
    what it returns is the report, which the orientation's call gets whole. It runs until it ends, the orientation's
    run ends (orient_session.subagent_ended stops it), or it is stopped."""
    from . import harness  # noqa: PLC0415

    key = session_key(caller.key)
    if harness.running(c, key) or subagents.running(c, key):
        return tools.err(tools.hint("critique-running"))
    transcript, prompt = await brief(c, caller, context)
    done: asyncio.Future = asyncio.get_running_loop().create_future()

    def ended(_run: Any, status: str, summary: str) -> None:
        work_files.after_run(c, work_dir(c, caller.chat), status)
        if not done.done():
            done.set_result((status, summary))

    job = harness.Job(c, "critic", key, TITLE, {"digest": prompt, "transcript": str(transcript or ""),
                                               "context": context},
                      OWN_TOOLS, work_dir(c, caller.chat), chat_role=agents.STEP_ROLE, parent=caller.chat,
                      fields={"brief": prompt.split("\n\n", 1)[0]})
    try:
        harness.start(job, part, on_end=ended)
    except RuntimeError as e:
        return tools.err(str(e))
    try:
        status, summary = await asyncio.shield(done)
    except asyncio.CancelledError:
        await asyncio.shield(harness.stop(c, key))
        raise
    if status != "done":
        return tools.err(tools.hint("critique-ended", status=status, text=str(summary).strip() or "nothing"))
    return tools.ok(str(summary).strip())
