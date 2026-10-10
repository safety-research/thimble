"""The view jobs' thimble tools: a view's builder (`thimble:view-builder`, dev.py) and its reviewer
(`thimble:view-reviewer`, view_review.py) are subagents of the analyst's Claude Code session, and the gate loops the
server ran around a `claude -p` session are tools they call (plan, lane E):

  view_check     the draft check (views.check_answer), as often as the agent wants: the gate with the locators it names,
                 and a picture of the page as it opens when it asks for one
  finish_view    the builder's end: the gates of record (views.gate); a pass registers the view (views.mark_built) and
                 tells main (the `view` event), a failure answers what failed and the attempt, up to dev.MAX_ATTEMPTS
  view_pictures  the reviewer's pictures (view_review.shoot): the overview first, then up to view_review.EXTRA_SHOTS
                 more states a round, into views-work/<slug>/review/<round>/, whose paths it opens with Read
  finish_review  the reviewer's end of a round: the gate over its revision, which stays (a round counted, up to
                 view_review.ROUNDS) or is undone (the view as it last passed)

Each takes its view from its caller's key (`view:<slug>`, `review:<slug>`), and runs only for the agent registered for
that key's current run, never for main (its Spec names no session of main's), another agent or a descendant of the
agent; an extension's program that builds the view (dev.program_build) may call view_check. A finish tool blocks while
its gate runs and is cancelled when its caller drops the call (tools.Spec.drop_stops: Claude Code closes it when the
agent is stopped), and it registers a pass only for a caller still running. A finish call after the last attempt or
round runs nothing and registers nothing. An agent still running FINISH_GRACE_S after its pass or its last attempt is
stopped through the module (subagents.stop), and its run ends as the finish tool said (dev.build_ended,
view_review.subagent_ended read the outcome the tool kept on the proposal)."""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from . import config, subagents, tools

log = logging.getLogger("thimble.view_tools")

BUILDER = "view-builder"  # subagents.TYPES
REVIEWER = "view-reviewer"
BUILDER_TOOLS = ("read_ref", "view_check", "finish_view")  # a builder's thimble tools
REVIEWER_TOOLS = ("read_ref", "view_check", "view_pictures", "finish_review")  # a reviewer's
FINISH_GRACE_S = 120.0  # after a pass or the last attempt, how long the agent may still run before it is stopped
# the fixed descriptions main's agent list shows (V5: main keeps the first description it sees)
BUILDER_DESCRIPTION = ("thimble's builder of one view of the analyst's corpus. thimble starts it, or gives the exact "
                       "Agent call that starts it.")
REVIEWER_DESCRIPTION = ("thimble's reviewer of one view it built: it looks at pictures of the view and fixes what it "
                        "finds. thimble starts it.")
UNCHANGED_REPORT = "the view's files are as they were before the change, so the change is not made yet"
NOT_YOURS = "{tool} is the tool of the agent thimble started for this view, and this call is not that agent's"


def build_key(slug: str) -> str:
    """The key of a build of the view `slug`, the session its calls run as (tools.session_kind reads `view`)."""
    return f"{tools.VIEW_SESSION}:{slug}"


def review_key(slug: str) -> str:
    """The key of a review of the view `slug` (tools.session_kind reads `review`)."""
    return f"{tools.REVIEW_SESSION}:{slug}"


def slug_of(key: str | None) -> str:
    return str(key or "").split(":", 1)[1] if ":" in str(key or "") else ""


# --------------------------------------------------------------------------- the definitions


def builder_definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:view-builder` for workspace `c` (subagents.roles adds its model, effort and
    `background`): prompts/dev.md with prompts/dev-view.md, the fixed part of every build, as its task (the dev agent's
    prompt as the config or the active extensions change it), a fixed description, and the thimble tools that are not
    a builder's taken away. The view a run builds is in its prompt (dev.build_task)."""
    from . import dev, prompts, userconf, views  # noqa: PLC0415 — dev imports the view modules, which import this one

    with prompts.custom(userconf.prompt_files(c, "dev")):
        prompt = prompts.render_dev("dev-view", {"corpus": str(config.corpus_dir(c)), "examples": str(views.EXAMPLES_DIR),
                                                 "docs": str(views.DOCS_DIR),
                                                 "attempts": str(dev.MAX_ATTEMPTS)})
    return {"description": BUILDER_DESCRIPTION, "prompt": prompt, "disallowedTools": tools.not_own(BUILDER_TOOLS)}


def reviewer_definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:view-reviewer` for workspace `c`: the `review` section of prompts/view-review.md,
    the view-review task's part (tasks.py), as the active extensions change it, a fixed description, and the thimble
    tools that are not a reviewer's taken away. The view a run reviews is in its prompt (view_review.task)."""
    from . import prompts, tasks, view_review  # noqa: PLC0415

    with prompts.custom(tasks.files(c, view_review.PROMPT)):
        prompt = view_review.reviewer_prompt(c)
    return {"description": REVIEWER_DESCRIPTION, "prompt": prompt, "disallowedTools": tools.not_own(REVIEWER_TOOLS)}


# --------------------------------------------------------------------------- the caller


class Refused(Exception):
    """A view tool's call that may not run: its message is the tool's error result."""


async def _caller(ctx: Any, tool: str, role: str) -> tuple[str, str]:
    """(slug, agent id) of the view and the agent a call of `tool` runs for: the agent of `role` registered for the key
    its call runs as, itself and not a descendant of it, whose run goes now. Refused otherwise."""
    key = str(ctx.session or "")
    kind = tools.session_kind(key)
    want = tools.VIEW_SESSION if role == BUILDER else tools.REVIEW_SESSION
    slug = slug_of(key)
    if kind != want or not slug:
        raise Refused(NOT_YOURS.format(tool=tool))
    who = await subagents.caller(ctx.c, ctx.tool_use_id) if ctx.tool_use_id else None
    run = subagents.current(ctx.c, key)
    if who is None or run is None or who.agent_id != who.root or who.role != role or who.agent_id != run.agent_id:
        raise Refused(NOT_YOURS.format(tool=tool))
    return slug, who.agent_id


def _program_call(ctx: Any) -> str:
    """The slug a program's call of view_check checks: a call that runs as a build's key with no tool-use id of Claude
    Code's comes from the harness, which runs as that key only while the program's run goes (harness.tool_call)."""
    from . import harness  # noqa: PLC0415

    key = str(ctx.session or "")
    if tools.session_kind(key) == tools.VIEW_SESSION and not ctx.tool_use_id and harness.running(ctx.c, key):
        return slug_of(key)
    return ""


def still_running(c: str, key: str, agent_id: str) -> bool:
    """Whether `agent_id` is still the running agent of `key`: a gate whose caller was stopped meanwhile registers no
    pass (V6)."""
    run = subagents.current(c, key)
    return run is not None and run.agent_id == agent_id


# --------------------------------------------------------------------------- the grace stop


_grace: dict[tuple[str, str], asyncio.TimerHandle] = {}  # (workspace, agent id) -> its stop after FINISH_GRACE_S


def stop_after_grace(c: str, key: str, agent_id: str) -> None:
    """Stop `agent_id` through the module if it still runs as `key` FINISH_GRACE_S from now: an agent that goes on after
    its pass or its last attempt, which a finish tool told to end."""
    old = _grace.pop((c, agent_id), None)
    if old is not None:
        old.cancel()
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    def fire() -> None:
        _grace.pop((c, agent_id), None)
        if still_running(c, key, agent_id):
            loop.create_task(_grace_stop(c, key, agent_id), name=f"finish-grace:{c}:{agent_id}")

    _grace[(c, agent_id)] = loop.call_later(FINISH_GRACE_S, fire)


async def _grace_stop(c: str, key: str, agent_id: str) -> None:
    log.info("%s: the agent %s of %s went on %.0f s after its finish, so it is stopped", c, agent_id, key, FINISH_GRACE_S)
    try:
        await subagents.stop(c, agent_id)
    except Exception:  # noqa: BLE001 — it ends with main at the latest
        log.exception("%s: the agent %s of %s was not stopped", c, agent_id, key)


def cancel_grace(c: str, agent_id: str) -> None:
    h = _grace.pop((c, agent_id), None)
    if h is not None:
        h.cancel()


# --------------------------------------------------------------------------- view_check


def _check_text(answer: dict[str, Any]) -> str:
    lines = [str(x) for x in answer.get("lines") or []]
    head = "The checks pass." if answer.get("ok") else "The checks fail."
    out = "\n".join([head, *lines])
    if answer.get("png"):
        out += f"\n\nThe picture of the page as it opens, which Read opens: {answer['png']}"
    if answer.get("drawing"):
        out += f"\n\nThe view as it opens, drawn as text as the panel shows it:\n\n{answer['drawing']}"
    return out


async def tool_view_check(ctx: Any, args: dict[str, Any]) -> Any:
    """`view_check`: the checks of the view the caller builds or reviews, with the `locators` it names beside the
    sampled lines, and with `picture` a picture of the page as it opens, or in terminal mode the view drawn as text
    (views.check_answer)."""
    from . import views  # noqa: PLC0415

    slug = _program_call(ctx)
    if not slug:
        try:
            slug, _ = await _caller(ctx, "view_check",
                                    BUILDER if tools.session_kind(ctx.session) == tools.VIEW_SESSION else REVIEWER)
        except Refused as e:
            return tools.err(str(e))
    raw = args.get("locators") or []
    raw = [raw] if isinstance(raw, str) else raw
    locators = [str(x).strip() for x in raw if str(x).strip()]
    answer = await views.check_answer(ctx.c, slug, locators, bool(args.get("picture")))
    return tools.ok(_check_text(answer))


# --------------------------------------------------------------------------- finish_view


def _finished(prop: dict[str, Any], agent_id: str) -> dict[str, Any] | None:
    f = prop.get("finish")
    return f if isinstance(f, dict) and f.get("agent") == agent_id else None


async def tool_finish_view(ctx: Any, args: dict[str, Any]) -> Any:
    """`finish_view`: the builder's end. The gates of record run on the view's folder (views.gate, with the locators the
    builder last checked); a pass registers the view and tells main, a failure answers what failed and the attempt, and
    the last failure, or a call after it, tells the builder to stop, each of these as an error result. The attempts are
    counted on the proposal."""
    from . import dev, views  # noqa: PLC0415

    try:
        slug, agent_id = await _caller(ctx, "finish_view", BUILDER)
    except Refused as e:
        return tools.err(str(e))
    c, key = ctx.c, build_key(slug)
    prop = views.read_proposal(c, slug)
    if prop is None:
        return tools.err(f"finish_view: the view {slug} has no proposal any more")
    done = _finished(prop, agent_id)
    if done is not None and done.get("result") == "pass":
        return tools.ok(tools.hint("finish-view-pass"))
    attempt = int(prop.get("attempt") or 0)
    if attempt >= dev.MAX_ATTEMPTS:  # a failure's answer is an error result, so the build's thread marks it so
        return tools.err(tools.hint("finish-view-stop"))
    attempt += 1
    views.update_proposal(c, slug, attempt=attempt)
    report = await views.gate(c, slug, views._kept_locators(c, slug))
    ok = bool(report.get("ok"))
    lines = "\n".join(views.gate_lines(report))
    if ok and prop.get("revision") and views.unchanged_since_built(c, slug):
        ok, lines = False, UNCHANGED_REPORT
    if not still_running(c, key, agent_id):
        log.info("%s: the gate of %s ended after its builder %s stopped, so it registers nothing", c, slug, agent_id)
        return tools.err(f"finish_view: the build of {slug} was stopped, so nothing was registered")
    dev.gate_step(c, slug, report, chat=prop.get("chat"))
    if ok:
        dev.register_pass(c, slug, agent_id)
        stop_after_grace(c, key, agent_id)
        return tools.ok(tools.hint("finish-view-pass"))
    if attempt >= dev.MAX_ATTEMPTS:
        views.update_proposal(c, slug, finish={"agent": agent_id, "result": "stop", "report": lines[:dev.ERROR_CHARS]})
        stop_after_grace(c, key, agent_id)
        return tools.err(tools.hint("finish-view-stop"))
    views.update_proposal(c, slug, last_report=lines[:dev.ERROR_CHARS])
    # an error result: the build's thread shows the failed gate on its finish_view row, not a ✓ (live check L25)
    return tools.err(tools.hint("finish-view-fail", report=lines, n=str(attempt), of=str(dev.MAX_ATTEMPTS)))


# --------------------------------------------------------------------------- view_pictures


async def tool_view_pictures(ctx: Any, args: dict[str, Any]) -> Any:
    """`view_pictures`: pictures of the view the caller reviews, the overview first in each round, then the states it
    asks for, up to view_review.EXTRA_SHOTS more a round, with the records the pages fetched, what the checks found and
    what an extension's program that replaces the view-review task found in them (view_review.pictures)."""
    from . import view_review  # noqa: PLC0415

    try:
        slug, agent_id = await _caller(ctx, "view_pictures", REVIEWER)
    except Refused as e:
        return tools.err(str(e))
    try:
        paths, records, reading = await view_review.pictures(ctx.c, slug, agent_id, args.get("states") or [])
    except view_review.NoPictures as e:
        return tools.err(str(e))
    return tools.ok("\n\n".join(x for x in (tools.hint("view-pictures", paths=paths, records=records), reading) if x))


# --------------------------------------------------------------------------- finish_review


async def tool_finish_review(ctx: Any, args: dict[str, Any]) -> Any:
    """`finish_review`: the end of a round of the reviewer. A revision runs the gate: a pass keeps it and counts the
    round, a failure puts the view back as it was before the round (view_review.finish)."""
    from . import view_review  # noqa: PLC0415

    try:
        slug, agent_id = await _caller(ctx, "finish_review", REVIEWER)
    except Refused as e:
        return tools.err(str(e))

    def phrases(name: str) -> list[str]:
        raw = args.get(name) or []
        raw = [raw] if isinstance(raw, str) else raw
        return [" ".join(str(x).split()) for x in raw if str(x).strip()]

    hint = await view_review.finish(ctx.c, slug, agent_id, phrases("revised"), phrases("left"))
    if hint is None:
        return tools.err(f"finish_review: the review of {slug} was stopped, so nothing was registered")
    return tools.ok(tools.hint(hint))


# --------------------------------------------------------------------------- helpers the jobs share


def fenced_proposal(prop: dict[str, Any]) -> str:
    """The proposal's fields (what the analyst sees, the files, its spec) fenced as data, since an agent wrote them."""
    from . import dev, views  # noqa: PLC0415

    text = "\n".join(x for x in (f"- What the analyst sees in it and why that helps: {prop.get('why') or ''}",
                                 f"- The files it reads: {', '.join(prop.get('claims') or [])}",
                                 views.spec_lines(prop)) if x)
    return dev.fenced("the proposal", text)


async def shutdown() -> None:
    for h in list(_grace.values()):
        with contextlib.suppress(Exception):
            h.cancel()
    _grace.clear()
