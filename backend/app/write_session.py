"""A writer's own Claude Code session, run beside main for one document.

The writer agent is defined for that session alone with `--agents` from prompts/writer.md and chosen with `--agent`,
so main's list of agents never shows it. It has every tool of a default Claude Code session and, of thimble's,
OWN_TOOLS, and runs in a work folder of its own with the corpus read-only (agent_session, the fence). Its first message
holds the whole context (context.render, CONTEXT_CHARS) followed by the task. One writer runs per document, with the
`writer` role's model settings and THIMBLE_SESSION `writer:<doc>`; the report checks run once it has ended. Main starts
it with `start_writing` and hears a `written` browser event when it ends. A writer cut short by a server stop is resumed
by the next server (_resume_left). A writer answering the orientation's report pass carries `orient` and `orient_run` on
its meta."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import agent_session, agents, bg_session, config, context, report_types, tools, work_files

log = logging.getLogger("thimble.write_session")

AGENT = "writer"  # prompts/writer.md, the agent the session runs as
ROLE = "writer"  # the agent chat's role
WRITTEN_KIND = "written"  # the event kind that tells main a writer ended (prompts/main.md)
DEFAULT_EFFORT = "high"  # when writer.md names none
CONTEXT_CHARS = 600_000  # of the first message, about 150k tokens
WORK_DIR = "writers"  # workspaces/<c>/writers/<doc>, a writer's own folder, where it may write
OWN_TOOLS = ("read_ref", "list_cards", "add_card", "edit_card", "delete_card", "screenshot", "write_document",
             "edit_document")  # a writer's thimble tools


def session_key(doc: str) -> str:
    """The THIMBLE_SESSION of the session writing `doc` (tools.session_kind reads its kind)."""
    return f"{tools.WRITER_SESSION}:{doc}"


def work_dir(c: str, doc: str) -> Path:
    return config.workspace_dir(c) / WORK_DIR / doc


def agent_definition() -> tuple[str, dict[str, Any]]:
    """(name, definition) of the writer agent for `--agents`, from prompts/writer.md."""
    from . import cli  # noqa: PLC0415 — cli is large, and the definition's shape is the launcher's

    return cli.agent_definition(AGENT)


def task_text(t: dict[str, Any], request: str, after: str) -> str:
    lines = [tools.hint("writer-task", doc=t["slug"], title=t.get("name") or t["slug"])]
    if request.strip():
        lines.append(tools.hint("writer-request", request=request.strip()))
    if after.strip():
        lines.append(tools.hint("writer-after", after=after.strip()))
    return "\n".join(x for x in lines if x)


def first_message(c: str, t: dict[str, Any], request: str = "", after: str = "") -> str:
    """The context engine's every part, then the task (module note)."""
    return context.render(c, task_text(t, request, after), budget=CONTEXT_CHARS, focus=(f"report:{t['slug']}",))


# --------------------------------------------------------------------------- start and end


def running(c: str, doc: str) -> bool:
    from . import harness  # noqa: PLC0415

    return agent_session.running(c, session_key(doc)) or harness.running(c, session_key(doc))


async def start(c: str, doc: str, request: str = "", after: str = "") -> agent_session.Run:
    """Start the session writing `doc` for workspace `c` and follow it; ValueError for an unknown document type,
    RuntimeError
    when a writer of `doc` runs or claude cannot be started. The first message is rendered off the event loop."""
    t = report_types.read_type(c, doc) if report_types.SLUG_RE.match(doc or "") else None
    if t is None:
        raise ValueError(f"no document {doc!r}")
    key = session_key(doc)
    if running(c, doc):
        raise RuntimeError(f"a writer of {doc} is running")
    prompt = await asyncio.to_thread(first_message, c, t, request, after)
    if running(c, doc):  # a second call that started while this one rendered
        raise RuntimeError(f"a writer of {doc} is running")
    # the orientation's report pass: the writer carries its chat and run, and its card shows the writer (module note)
    pending = report_types.write_pending(c, doc) or {}
    # `orient: null` on another writer says the analyst asked for it
    orient = {"orient": pending.get("orient") or None, "orient_run": pending.get("orient_run") or 0}
    from . import roles  # noqa: PLC0415

    agent = roles.agent_for(c, "writer")
    if agent.code and agent.replacing is not None:
        return start_program(c, doc, t, request, after, prompt, agent.replacing, orient)
    run = await agent_session.start(c, key, prompt=prompt, **_launch(c, doc), brief=task_text(t, request, after),
                                    **orient)
    report_types.begin_write(c, doc, request, after)
    return run


def start_program(c: str, doc: str, t: dict[str, Any], request: str, after: str, context_text: str, part: Any,
                  orient: dict[str, Any]) -> Any:
    """The writer of `doc` run by an extension's program (harness.py): its input is the document, its type, the
    request and what thimble's writer reads first; it writes through write_document and edit_document, and main hears
    what it returns."""
    from . import harness  # noqa: PLC0415

    job = harness.Job(c, "writer", session_key(doc), f"Write {doc}",
                      {"doc": doc, "type": {k: t.get(k) for k in ("slug", "name", "kind", "description") if k in t},
                       "request": request, "after": after, "context": context_text},
                      OWN_TOOLS, work_dir(c, doc), chat_role=ROLE,
                      fields={"doc": doc, "brief": task_text(t, request, after), **orient})

    def ended(_run: Any, status: str, summary: str) -> None:
        agent_session.tell_main(c, WRITTEN_KIND, {"text": summary or "", "status": status, "doc": doc})

    run = harness.start(job, part, on_end=ended)
    report_types.begin_write(c, doc, request, after)
    return run


def _launch(c: str, doc: str) -> dict[str, Any]:
    """The arguments of agent_session.start that a start and a resume after a restart share: the writer's agent, its
    role's model, effort and fast mode, and its document."""
    from . import prompts, userconf  # noqa: PLC0415

    with prompts.custom(userconf.prompt_files(c, "writer")):
        name, agent = agent_definition()
    models = config.models_for(c)
    agent = agent_session.role_agent(agent, models["writer"])
    effort = str(agent.get("effort") or DEFAULT_EFFORT)
    from . import roles  # noqa: PLC0415

    defined = {**roles.subagents(c, "writer"), name: agent}
    return dict(role=ROLE, title=f"Write {doc}", agent_args=["--agents", json.dumps(defined, ensure_ascii=False),
                                                              "--agent", name],
                effort=effort, settings=agent_session.settings_json(effort, fastMode=bool(models["writer"]["fast"])),
                agent_type=name, on_end=_ended, model=str(agent.get("model") or ""), work=work_dir(c, doc), unasked=True,
                agent="writer", disallowed=agent_session.not_own(OWN_TOOLS), doc=doc, background=True)


async def _resume_left(c: str, meta: dict[str, Any], prompt: str) -> agent_session.Run:
    """Resume a writer that a previous server left running (agent_session, restart): its session with `--resume` in its
    chat, `prompt` on stdin, and its document shown as being written again. NotResumed when its document is gone."""
    doc = str(meta.get("doc") or "")
    if not report_types.SLUG_RE.match(doc) or report_types.read_type(c, doc) is None:
        raise agent_session.NotResumed(f"its document {doc or '(none)'} no longer exists")
    run = await agent_session.start(c, session_key(doc), prompt=prompt, resume=str(meta.get("session") or ""),
                                    chat=str(meta["id"]), run_k=int(meta.get("run") or 0), restarted=True,
                                    **_launch(c, doc))
    report_types.begin_write(c, doc)
    return run


def _ended(run: agent_session.Run, status: str, summary: str) -> None:
    """The session ended: main hears the writer's last message (report_types.writer_finished has ended the write), once
    a session listens (agent_session.tell_main), and its work folder lets go of what it no longer needs
    (work_files.after_run)."""
    work_files.after_run(run.c, work_dir(run.c, run.key.split(":", 1)[-1]), status)
    agent_session.tell_main(run.c, WRITTEN_KIND, {"text": summary or "", "status": status,
                                                  "doc": run.key.split(":", 1)[-1]})


def _left(c: str, meta: dict[str, Any], status: str, summary: str) -> None:
    """A writer that a previous server left running was closed (agent_session, restart): its document shows the write
    as failed, since that server's record of the write went with it, and main hears it."""
    doc = str(meta.get("doc") or "")
    if doc:
        report_types._emit(c, {"type": "report", "slug": doc, "status": "failed", "chat": meta.get("id"),
                               "note": summary or "the writer was stopped before it saved the document"})
    agent_session.tell_main(c, WRITTEN_KIND, {"text": summary or "", "status": status, "doc": doc})


async def _woken(c: str, e: bg_session.Entry) -> agent_session.Run | None:
    """A writer's background session started a turn with no run of this server's (bg_session.on_wake): the run a
    restart cut off is followed again as it was, and any other turn is the chat's next run."""
    meta = agents.meta_or_none(c, e.chat)
    doc = e.key.split(":", 1)[-1]
    if meta is None or report_types.read_type(c, doc) is None:
        return None
    if meta.get("status") == "running":
        return await _resume_left(c, meta, "")
    return await agent_session.start(c, e.key, prompt="", resume=e.sid, chat=e.chat, run_k=int(meta.get("run") or 0) + 1,
                                     announce=False, **_launch(c, doc))


agent_session.on_left(ROLE, _left)
agent_session.on_resume(ROLE, _resume_left)
bg_session.on_wake(tools.WRITER_SESSION, _woken)


async def tool_start_writing(ctx: Any, args: dict[str, Any]) -> Any:
    """The `start_writing` tool: start the session writing `doc` with the analyst's request and passage (else the
    pending
    write event's). A `doc` no type holds is made first when the call names its `type` and `name`."""
    doc = str(args.get("doc") or "").strip().lower().removeprefix("report:").split("#", 1)[0]
    kind = str(args.get("type") or "").strip().lower()
    made = None
    if not report_types.SLUG_RE.match(doc) or report_types.read_type(ctx.c, doc) is None:
        if not kind:
            names = ", ".join(str(t["slug"]) for t in report_types.list_types(ctx.c))
            return tools.err(tools.hint("start_writing-no-doc", doc=doc or "(none)", docs=names,
                                        types=", ".join(report_types.new_kinds(ctx.c))))
        slug = doc if report_types.SLUG_RE.match(doc) and doc not in report_types.RESERVED else None
        try:
            made = report_types.create_document_type(ctx.c, kind, name=str(args.get("name") or "") or None,
                                                     brief=str(args.get("request") or ""), slug=slug,
                                                     created_by=ctx.cell_author)
        except HTTPException as e:
            return tools.err(f"start_writing: {e.detail}")
        doc = str(made["slug"])
    if running(ctx.c, doc):
        return tools.err(tools.hint("start_writing-running", doc=doc))
    pending = report_types.write_pending(ctx.c, doc) or {}
    request = str(args.get("request") or "").strip() or str(pending.get("request") or "")
    after = str(args.get("after") or "").strip() or str(pending.get("after") or "")
    try:
        await start(ctx.c, doc, request, after)
    except (RuntimeError, ValueError) as e:
        return tools.err(f"start_writing: {e}")
    started = tools.hint("start_writing-started", doc=doc)
    if made is not None:
        started = tools.hint("start_writing-made", doc=doc, title=str(made["name"])) + "\n" + started
    return tools.ok(started)
