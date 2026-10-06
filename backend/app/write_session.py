"""A writer: `thimble:writer`, a subagent of the analyst's Claude Code session for one document (subagents.py).

Its registration (definition) is prompts/writer.md with shared.md loaded as the skill `thimble:shared`, the `writer`
role's model and effort from Settings, and of thimble's tools OWN_TOOLS. Its run's prompt names its task and a context
file, writers/<doc>/context.md, that holds the whole context (context.render, CONTEXT_CHARS) followed by the task, which
it reads first. One writer runs per document. Write in the browser is a click (write_route), the orientation's report
pass a follow-on start of the same click or typed start (follow_on), both through thimble's plugin module; main's
`start_writing` gives the exact Agent call main makes (tool_start_writing). Main hears a `written` browser event when a
writer ends. A writer answering the orientation's report pass carries `orient` and `orient_run` on its chat. A writer
stopped when Claude Code quit is started again with Write again (subagents.again)."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import config, context, report_types, subagents, tools, work_files

log = logging.getLogger("thimble.write_session")
router = APIRouter()

AGENT = "writer"  # prompts/writer.md, the writer's registered prompt
ROLE = "writer"  # the agent chat's role, and its role among subagents.TYPES
WRITTEN_KIND = "written"  # the event kind that tells main a writer ended (prompts/main.md)
CONTEXT_CHARS = 600_000  # of the context file, about 150k tokens
CONTEXT_FILE = "context.md"  # in its work folder: what it reads first
WORK_DIR = "writers"  # workspaces/<c>/writers/<doc>, a writer's own folder, where it may write
SKILLS = ("thimble:shared",)  # shared.md, loaded before its first turn (U3)
OWN_TOOLS = ("read_ref", "list_cards", "add_card", "edit_card", "delete_card", "screenshot", "write_document",
             "edit_document")  # a writer's thimble tools


def session_key(doc: str) -> str:
    """The key of the writer of `doc`, the session its calls run as (tools.session_kind reads its kind)."""
    return f"{tools.WRITER_SESSION}:{doc}"

def work_dir(c: str, doc: str) -> Path:
    return config.workspace_dir(c) / WORK_DIR / doc

def task_text(t: dict[str, Any], request: str, after: str) -> str:
    lines = [tools.hint("writer-task", doc=t["slug"], title=t.get("name") or t["slug"])]
    if request.strip():
        lines.append(tools.hint("writer-request", request=request.strip()))
    if after.strip():
        lines.append(tools.hint("writer-after", after=after.strip()))
    return "\n".join(x for x in lines if x)

def first_message(c: str, t: dict[str, Any], request: str = "", after: str = "") -> str:
    """The context file's text: the context engine's every part, then the task (module note)."""
    return context.render(c, task_text(t, request, after), budget=CONTEXT_CHARS, focus=(f"report:{t['slug']}",))


def definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:writer` for workspace `c` (subagents.roles adds its model, effort and
    `background`): writer.md's body, its frontmatter's description, shared.md as the skill `thimble:shared`, and the
    thimble tools that are not a writer's taken away."""
    from . import agent_session, cli, prompts, userconf  # noqa: PLC0415

    with prompts.custom(userconf.prompt_files(c, "writer")):
        _, agent = cli.agent_definition(AGENT)
    out = {k: agent[k] for k in ("description", "prompt") if k in agent}
    out["skills"] = list(dict.fromkeys([*SKILLS, *(agent.get("skills") or [])]))
    out["disallowedTools"] = agent_session.not_own(OWN_TOOLS)
    return out


def write_context(c: str, t: dict[str, Any], request: str, after: str) -> Path:
    """The writer's context file, writers/<doc>/context.md (first_message), which its prompt names."""
    path = work_dir(c, str(t["slug"])) / CONTEXT_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(first_message(c, t, request, after) + "\n", "utf-8")
    return path


def task(t: dict[str, Any], request: str, after: str, path: Path) -> str:
    """A writer's run prompt: its task, the analyst's request and passage, and its context file
    (`## writer-context-file`)."""
    return "\n\n".join(x for x in (task_text(t, request, after), tools.hint("writer-context-file", path=str(path))) if x)


def running(c: str, doc: str) -> bool:
    from . import harness  # noqa: PLC0415

    return subagents.running(c, session_key(doc)) or harness.running(c, session_key(doc))


async def start(c: str, doc: str, request: str = "", after: str = "", *, route: str = subagents.CLICK,
                values: "dict[str, Any] | None" = None, call: str | None = None, orient: str | None = None,
                orient_run: int = 0) -> subagents.Answer:
    """Start the writer of `doc` for workspace `c` with the analyst's request and passage and the run's values (each
    defaulting to Settings' writer row): a click or a follow-on start through the module, or a typed one's pending
    request and exact Agent call (subagents.start_job). The context file is written off the event loop first.
    ValueError for an unknown document type; a refusal (Answer) when a writer of `doc` runs. An extension whose program
    runs the writer runs it instead (start_program)."""
    t = report_types.read_type(c, doc) if report_types.SLUG_RE.match(doc or "") else None
    if t is None:
        raise ValueError(f"no document {doc!r}")
    key = session_key(doc)
    if running(c, doc):
        return subagents.refusal(subagents.HOOK, tools.hint("start_writing-running", doc=doc))
    # the orientation's report pass: the writer carries its chat and run, and its card shows the writer (module note)
    pending = report_types.write_pending(c, doc) or {}
    fields = {"orient": orient or pending.get("orient") or None, "orient_run": orient_run or pending.get("orient_run") or 0}
    from . import roles  # noqa: PLC0415

    agent = roles.agent_for(c, "writer")
    if agent.code and agent.replacing is not None:
        prompt = await asyncio.to_thread(first_message, c, t, request, after)
        start_program(c, doc, t, request, after, prompt, agent.replacing, fields)
        return subagents.Answer({"program": agent.replacing.extension})
    if route == subagents.TYPED or route == subagents.CLICK:
        before = subagents.refusal_before(c)
        if before is not None:
            return before
    path = await asyncio.to_thread(write_context, c, t, request, after)
    if running(c, doc):  # a second call that started while this one rendered
        return subagents.refusal(subagents.HOOK, tools.hint("start_writing-running", doc=doc))
    report_types.begin_write(c, doc, request, after)
    ans = await subagents.start_job(c, ROLE, key, task(t, request, after, path), subagents.values_for(c, ROLE, values),
                                    route, description=f"writer: {doc}",
                                    chat={"title": f"Write {doc}", "doc": doc, "brief": task_text(t, request, after),
                                          **fields},
                                    work=work_dir(c, doc), call=call, check=False)
    return ans


def follow_on(c: str, doc: str, request: str = "", **fields: Any) -> None:
    """The writer of `doc` as a follow-on start of a run whose own start was the analyst's click or a typed start main
    made (the orientation's report pass, Q5), through the module, in a task; in plan mode it waits (out_of_plan)."""
    async def go() -> None:
        try:
            await subagents.out_of_plan(c)
            ans = await start(c, doc, request, route=subagents.FOLLOW_ON, **fields)
        except Exception:  # noqa: BLE001
            log.exception("%s: the writer of %s did not start", c, doc)
            return
        if ans.refused:
            log.info("%s: the writer of %s did not start: %s (%s)", c, doc, ans.reason, ans.kind)

    try:
        asyncio.get_running_loop().create_task(go(), name=f"writer-follow-on:{c}:{doc}")
    except RuntimeError:
        log.warning("%s: no loop to start the writer of %s in", c, doc)


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
        subagents.tell_main(c, WRITTEN_KIND, {"text": summary or "", "status": status, "doc": doc})

    run = harness.start(job, part, on_end=ended)
    report_types.begin_write(c, doc, request, after)
    return run


def subagent_started(c: str, run: subagents.Run, req: dict[str, Any]) -> None:
    """A writer's run started: a follow-up typed to it in Claude Code's agent tray (run k > 0) writes its document
    again, which the Report tab shows."""
    if run.k > 0:
        report_types.begin_write(c, run.key.split(":", 1)[-1])


def subagent_ended(c: str, run: subagents.Run, status: str, summary: str) -> None:
    """A writer's run ended: main hears its last message (report_types.writer_finished has ended the write, on its
    chat's end), and its work folder lets go of what it no longer needs (work_files.after_run)."""
    doc = run.key.split(":", 1)[-1]
    work_files.after_run(c, work_dir(c, doc), status)
    subagents.tell_main(c, WRITTEN_KIND, {"text": summary or "", "status": status, "doc": doc})


def subagent_refused(c: str, req: dict[str, Any]) -> None:
    """A writer's start that did not happen: its document's card shows the refusal with its kind, and its pending
    write ends (report_types.write_refused)."""
    if req.get("kind") != "start":
        return
    doc = str(req.get("key") or "").split(":", 1)[-1]
    report_types.write_refused(c, doc, str(req.get("reason") or ""), str(req.get("refused_kind") or subagents.ERROR),
                               request=req.get("id"), expired=req.get("expired"))


async def tool_start_writing(ctx: Any, args: dict[str, Any]) -> Any:
    """The `start_writing` tool: the pending start of the writer of `doc` with the analyst's request and passage and
    the run's model and effort, and the exact Agent call main makes (`## start_writing-subagent`). A `doc` no type
    holds is made first when the call names its `type` and `name`."""
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
    values = {k: str(args[k]) for k in ("model", "effort") if args.get(k)}
    try:
        ans = await start(ctx.c, doc, request, after, route=subagents.TYPED, values=values, call=ctx.tool_use_id)
    except (RuntimeError, ValueError) as e:
        return tools.err(f"start_writing: {e}")
    if ans.refused:
        return tools.err(ans.reason or f"start_writing: {ans.kind}")
    started = (tools.hint("start_writing-program", doc=doc) if ans.get("program")
               else tools.hint("start_writing-subagent", input=json.dumps(ans["input"], ensure_ascii=False)))
    if made is not None:
        started = tools.hint("start_writing-made", doc=doc, title=str(made["name"])) + "\n" + started
    return tools.ok(started)


class WriteBody(BaseModel):
    """Write in the browser (POST /ws/{c}/write): the document, the analyst's request and passage, and the run's model
    and effort."""

    doc: str
    text: str = ""
    after: str = ""
    model: str | None = None
    effort: str | None = None


@router.post("/ws/{c}/write")
async def write_route(c: str, body: WriteBody, request: Request) -> dict[str, Any]:
    """Write in the browser: a click, so the analyst's cookie (403 without it), and the writer starts through the module
    (start). The answer: {agentId} or the refusal's {kind, reason}; 404 for an unknown document."""
    subagents.analyst_only(request)
    config.workspace_dir(c)
    doc = str(body.doc or "").strip().lower().removeprefix("report:").split("#", 1)[0]
    values = {k: v for k, v in (("model", body.model), ("effort", body.effort)) if v}
    try:
        ans = await start(c, doc, body.text, body.after, route=subagents.CLICK, values=values)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {**dict(ans), **({"kind": ans.kind, "reason": ans.reason} if ans.refused else {})}
