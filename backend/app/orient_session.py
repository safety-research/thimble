"""The orientation: a broad analysis of the corpus for the analyst, run as `thimble:orientation`, a named subagent of the
analyst's Claude Code session with a fresh context (subagents.py). The machinery it shares with thimble's other agents
is subagents.py; this module holds what is the orientation's own.

Start. Main starts the orientation: it calls `start_orientation` (or `/thimble:orient` does), whose result is the exact
Agent call main makes (tool_start_orientation); a thread's fork's call gives that call to main in a `start_agent` event
(tools._ask_main). POST /ws/{c}/start is a click (start_route): the module spawns the orientation with no turn of main.
The browser no longer sends it, since its chat opens without a Start; scripts/dev/precache_orientation.py does. Both
take the request (the focus) and the run's model and effort, which default to Settings (choices_of); no switch decides
what the orientation does. Once an orientation has ended, the tool starts another only when someone asked for it since
(asked_for). Without thimble's plugin module, or in plan mode, no orientation starts (subagents.refusal_before).

The prompt. The registration (subagent_definition) holds prompts/orient.md's body rendered for the workspace, its
instructions (prompts/orient-instructions.md, or the workspace's `orient_instructions` setting) and the active
extensions' blocks; the module registers it again when they change. A run's own prompt (run_prompt, hint
orient-subagent-prompt) carries the request id on its first line and the request. The orientation explores as far as
the request and its effort call for, leaves its findings as cards in its deck, and may start its own subagents, such
as the critic its `critique` tool starts (critique_session.py). The run's model and effort are Settings' or its
arguments' (subagents.values_for).

Calls. Each call the orientation and its own subagents make is numbered in its chat's sequence and citable as
`call:<chat>/<n>` (calls.py); the plugin's --agents hook tells the model each ref.

End of a run. The orientation's run ends at its hand-back (subagents.run_ended), and subagent_ended does what it means:
the first run's record closes and reveals the deck, its coverage line is measured (below), main hears an `orient` event
with one line counting what was made, and the work folder lets go of what no card uses (work_files). When the first run
ended done, thimble's view proposer is told (_tell_proposer, proposer.trigger). thimble writes a report only when the
analyst asks for one (start_writing). A run the analyst stopped stops the builds of the views it proposed, which only an
orientation from before 0.8.0 did. A run that failed gets its notice where every agent's end does (subagents.run_ended);
a failed run of an extension's program that runs the orientation gets one here (_notice).

Coverage. When the first run finishes (done; not stopped or failed), its coverage line (orient_checks.coverage) is
measured in the checks' child process before the end goes on; meanwhile a follow-up waits (at most COVERAGE_TIMEOUT_S),
so that it carries the line (`## orient-coverage-lead`). The line is a note at the end of its thread, a second line of
main's `orient` event and of summary.md, and the record's `coverage`. It stays due (coverage_lead) until a run starts
with it (_told_if_carried): main's message_orientation gives it in each exact SendMessage until one reaches the agent, so
a SendMessage that --agent-check denied, and the call main makes again after it, do not lose it (live check T5).

Follow-ups. The thread's composer sends a follow-up through the module (message_route, subagents.send); main's
`message_orientation` returns the exact SendMessage. A follow-up continues the same agent, by its id, as its next run;
its cards land in place as one undo batch. One stopped with Esc in its agent view, which Claude Code resumes no more, is
continued by a message all the same (continue_stopped): a new `thimble:orientation` run in its thread, as its next run,
with what the stopped run left and on its model and effort. An orientation of an earlier Claude Code session, or of an
earlier version of thimble (a chat with no agent id), cannot be continued (409, 410). An orientation `thimble demo`
installed from a pre-cache cannot either (precached.py). An orientation an extension's program runs takes a follow-up by
running again with it (_program_follow_up); Settings' Run now for an extension whose program runs the orientation runs it
again (run_program_now).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import agents, cc_settings, config, ledger, orient_checks, orientation, precached, prompts, subagents, tools, \
    userconf, work_files

log = logging.getLogger("thimble.orient_session")
router = APIRouter()

PROMPT = "orient"  # prompts/orient.md, the orientation's registered prompt
KEY = tools.ORIENT_SESSION  # its key: the session its calls run as (subagents.caller)
ROLE = "orientation"  # its role among subagents.TYPES


# The thimble tools the orientation gets; every other registry tool is taken away. Since 0.8.0 it proposes no views
# (thimble's view proposer does, proposer.py), so propose_view is not among them.
ORIENT_TOOLS = ("read_ref", "list_cards", "add_card", "edit_card", "delete_card", "apply_label", "screenshot", "critique")

WORK_DIR = "work"  # orient/work: the one folder outside the corpus the session writes into

INSTRUCTIONS = "orient-instructions"  # prompts/orient-instructions.md, thimble's default instructions

SETTING = "orient_instructions"  # settings.json: the analyst's own instructions, which replace the defaults (instructions_of)

# The blocks of the prompt thimble gives a default for, which an extension may replace (extensions.orient_blocks), by
# name: each one's default prompt file.
BLOCKS = {"instructions": INSTRUCTIONS}

# What stands in each slot the analyst's text fills while orient.md renders, so that text goes in whole after it
# (system_prompt).
_MARKS = {"request": "\x00request\x00", "instructions": "\x00instructions\x00"}

BROWSER = "browser"  # `by` of a message typed in the orientation's thread

MAIN = "main"  # `by` of a message main's message_orientation sent

TERMINAL = "terminal"  # `by` of a message the analyst typed to the orientation in Claude Code's agent tray

EXTENSION = "extension"  # `by` of an extension's orientation instructions, sent when it starts running here

COVERAGE_KIND = "coverage"  # the chip kind of the coverage line at the end of the orientation's thread (_keep_coverage)

COVERAGE_TIMEOUT_S = 120.0  # the coverage line is given up after this long, so main hears the end without it (measure)
ERROR_KIND = "orient_error"  # the chip kind of the line that ends a failed run in the orientation's thread (_say_failed)
# that line: the run stopped, and why, in the error's own words (failure_line), such as Claude Code's API error line
FAILED_LINES = ("The orientation stopped because of an error: {error}",
                "The orientation's follow-up stopped because of an error: {error}")
# a notice of a failed run of an extension's program that runs the orientation (_notice): the agent it names, its key's
# prefix (the chat follows), how much of the error it keeps, and the fix it gives after the failed line
NOTICE_AGENT, NOTICE_KEY, NOTICE_CHARS = "Orientation", "orientation", 200
NOTICE_FIX = "A message in its thread runs it again."

ASKED_WAIT_S = 2.0  # how long start_orientation waits for main's chat to show the analyst's latest message (asked_for)
# what a thread's fork's start_orientation filed, and the agent main starts for it, as its start_agent event and the
# fork's line name them (tools._ask_main)
FORK_WHAT, FORK_AGENT = "the request for an orientation", "the orientation"
SCRATCH_GLOB = "tmp_*"  # the scratch folders of the orientation's own subagents (the --subagent-start hook)


class NoOrientation(RuntimeError):
    """No orientation has run in the workspace, or one is starting and has no agent yet."""


class EarlierSession(RuntimeError):
    """The orientation ran in an earlier Claude Code session, whose agents this one cannot reach."""


class EarlierVersion(RuntimeError):
    """The orientation ran in an earlier version of thimble (its chat has no agent id), so it cannot be continued."""


class StoppedInTerminal(EarlierVersion):
    """The orientation was stopped with Esc in its agent view, after which Claude Code resumes it no more
    (subagents.mark_cancelled). A message to it starts a continuation (continue_stopped): a new run in its thread with
    the stopped run's context. `chat` and `agent_id` name the stopped run."""

    def __init__(self, text: str, chat: str = "", agent_id: str = "") -> None:
        super().__init__(text)
        self.chat, self.agent_id = chat, agent_id


_closing: dict[str, asyncio.Event] = {}  # the workspaces whose first run ended and is being measured (_measured)


def running(c: str) -> bool:
    """Whether the orientation's agent or program runs, a start of it waits for its answer, or its first run's end
    waits for its coverage line."""
    from . import harness  # noqa: PLC0415

    return c in _closing or subagents.running(c, KEY) or harness.running(c, KEY) or orientation.running(c)


async def stop(c: str) -> bool:
    """Stop the orientation: its agent through the module (subagents.stop), or its program."""
    from . import harness  # noqa: PLC0415

    run = subagents.current(c, KEY)
    if run is not None:
        return not (await subagents.stop(c, run.agent_id)).refused
    return await harness.stop(c, KEY)


def work_dir(c: str) -> Path:
    """The orientation's work folder, where it may write."""
    return orientation.orient_dir(c) / WORK_DIR


def effort_of(choices: dict[str, Any]) -> str:
    """The effort a run's choices or record name: its own, Ultracode as its level (xhigh), as is the `ultracode` flag an
    earlier version kept."""
    effort = str(choices.get("effort") or "")
    if choices.get("ultracode") or effort == cc_settings.ULTRACODE:
        return cc_settings.ULTRACODE_EFFORT
    return effort


def instructions_of(c: str, own: "str | None" = None) -> str:
    """The instructions part of workspace `c`'s prompt: `own` when given, else the workspace's SETTING; either one, when
    it holds text, replaces thimble's defaults (INSTRUCTIONS) rather than adding to them. Without it, an active
    extension's replacement of the block stands in for the defaults. Each active extension's orient.md follows, under its
    name."""
    from . import extensions  # noqa: PLC0415

    if own is None:
        stored = ledger.stored_settings(c).get(SETTING)
        own = stored if isinstance(stored, str) else ""
    blocks = extensions.orient_blocks(c)
    text = own.strip() or blocks["replaced"].get("instructions") or prompts.render(INSTRUCTIONS, {}).strip()
    for title, added in blocks["added"]:
        text += f"\n\n#### {title}\n\n{added}"
    return text

def system_prompt(c: str, brief: str, instructions: "str | None" = None) -> str:
    """orient.md's body rendered for workspace `c`: the prefix with shared.md (with the workspace's view citation forms)
    and the request, the instructions, and the suffix."""
    from . import cardtypes, views  # noqa: PLC0415 — views imports refs, which the rest of this module does not need

    values = {"workdir": str(config.corpus_dir(c)), "workfolder": str(work_dir(c)), "forms": views.forms_text(c),
              "card_types": cardtypes.prompt_text(c), **_MARKS}
    text = prompts.agent_prompt(PROMPT, values)
    # The request and the instructions go in after the prompt renders, so a `{{` in either is never read as a slot.
    fills = {"request": brief.strip() or tools.hint("orient-no-request"), "instructions": instructions_of(c, instructions)}
    for slot, mark in _MARKS.items():
        text = text.replace(mark, fills[slot], 1)
    return re.sub(r"\n{3,}", "\n\n", text)  # an empty {{forms}} leaves a blank line of its own

def disallowed() -> list[str]:
    """The registration's disallowedTools: the thimble tools that are not the orientation's (main's own among them)."""
    return tools.not_own(list(ORIENT_TOOLS))


def subagent_definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:orientation` for workspace `c` (subagents.roles adds its model, effort and
    `background`): orient.md's body rendered, shared.md embedded, the workspace's instructions and the extensions'
    blocks, with the request left to each run's prompt (`## orient-subagent-prompt`), its frontmatter's description, and
    the thimble tools that are not the orientation's taken away. orient.md has no `{{request}}` slot; an analyst's own
    copy that still has one loses the no-request line there, since each run's prompt says it."""
    front = prompts.agent_file(PROMPT)[0]
    with prompts.custom(userconf.prompt_files(c, "orientation")):
        body = system_prompt(c, "")
    body = body.replace(tools.hint("orient-no-request"), "", 1)
    return {"description": str(front.get("description") or ""), "prompt": body, "disallowedTools": disallowed()}


def run_prompt(c: str, rid: str, brief: str) -> str:
    """A run's own prompt (`## orient-subagent-prompt`): the request id `rid` on its first line, then the analyst's
    request."""
    return tools.hint("orient-subagent-prompt", request_id=rid, request=brief.strip() or tools.hint("orient-no-request"))


def description(brief: str) -> str:
    """The Agent call's description, which Claude Code's agent tray shows beside the type: `orientation: <focus>`."""
    focus = " ".join(brief.split())[:60] or "the whole corpus"
    return f"orientation: {focus}"


_starting: set[str] = set()  # the workspaces whose orientation's start waits for the module's answer (start)


def starting(c: str) -> bool:
    return c in _starting


async def start(c: str, brief: str, *, values: "dict[str, Any] | None" = None, route: str = subagents.CLICK,
                call: str | None = None) -> subagents.Answer:
    """Start the orientation for workspace `c` with the request `brief` and the run's values (the model and effort
    default to Settings): a click through the module (start_route), or for a typed start (`call`, main's
    start_orientation call) the pending request and the exact Agent call (subagents.start_job). The record says
    `starting`, then `running` once the agent starts (subagent_started), or `refused` with the reason and its kind. An
    extension whose program runs the orientation runs it instead (start_program). The workspace's extensions are found
    first when it never found them (extensions.settle)."""
    from . import extensions, roles  # noqa: PLC0415

    if running(c) or starting(c):
        return subagents.refusal(subagents.HOOK, tools.hint("start_orientation-running"))
    _starting.add(c)
    try:
        await extensions.settle(c)
        vals = subagents.values_for(c, ROLE, values)
        agent = roles.agent_for(c, "orientation")
        if agent.code and agent.replacing is not None:
            orientation.request(c, brief, **vals)
            await start_program(c, agent.replacing, brief, vals, call=call)
            await extensions.mark_oriented(c, [agent.replacing.extension])
            return subagents.Answer({"program": agent.replacing.extension})
        rid = subagents.request_id()
        started_by = "typed" if route == subagents.TYPED else "click"
        before = subagents.refusal_before(c, click=route == subagents.CLICK)
        if before is not None and route == subagents.TYPED:
            return before  # main reads why; the analyst typed it in the terminal and reads main's answer there
        orientation.start_requested(c, {"text": brief, **vals, "request": rid, "started_by": started_by})
        if before is not None:
            orientation.refuse(c, before.reason, before.kind or subagents.ERROR)
            return before
        task = run_prompt(c, rid, brief)
        ans = await subagents.start_job(c, ROLE, KEY, task, vals, route, description=description(brief), request_id=rid,
                                        chat={"title": orientation.TITLE, "brief": brief.strip()}, work=work_dir(c),
                                        call=call, check=False)
        if ans.started or ans.typed:
            await extensions.mark_oriented(c)
        return ans
    finally:
        _starting.discard(c)


async def start_program(c: str, part: Any, brief: str, choices: dict[str, Any], call: str | None = None,
                        follow_up: bool = False) -> Any:
    """Start the orientation as an extension's program (harness.py) with the request `brief` and the run's `choices`
    (its model and effort); `follow_up` for a message to a finished one, which runs the program again with it. Its
    input keeps `outputs`, now always the deck, for programs written before 0.8.0. Its cards and labels come through its
    tools; what it returns is the line main hears."""
    from . import harness  # noqa: PLC0415

    listed = await tools.call(c, "list_cards", {"group": "all"}, session=KEY)
    # critique reads the transcript of thimble's own orientation session, which a program has none of
    own = tuple(n for n in ORIENT_TOOLS if n != "critique")
    job = harness.Job(c, "orientation", KEY, orientation.TITLE,
                      {"request": brief.strip(), "outputs": [orientation.DECK], "follow_up": follow_up,
                       "choices": {"effort": effort_of(choices)},
                       "cards": listed.text, "corpus": str(config.corpus_dir(c)), "tools": list(own)},
                      own, work_dir(c), chat_role=orientation.ROLE,
                      fields={"brief": brief.strip(), **({"tool_use_id": call} if call else {})})

    def started(run: Any) -> None:
        orientation.started(c, run.chat, route="program")
        orientation.record(c, model=choices.get("model"), effort=choices.get("effort"), program=part.extension)

    def ended(run: Any, status: str, summary: str) -> None:
        try:
            orientation.finished(c, run.chat, status, summary)
        except Exception:  # noqa: BLE001
            log.exception("%s: the orientation's record was not closed", c)
        _tell_main(c, status, 0, {}, error=summary if status == "failed" else "")
        _notice(c, run.chat, status, summary, follow_up)
        if status == "done" and not follow_up:
            _tell_proposer(c)

    return harness.start(job, part, on_start=started, on_end=ended)


async def measure(c: str, chat: str) -> str:
    """The coverage line of the orientation chat `chat` (orient_checks.coverage), measured in the checks' child process;
    '' when it could not be measured within COVERAGE_TIMEOUT_S."""
    try:
        found = await orient_checks.check_apart(c, COVERAGE_TIMEOUT_S, coverage_of=chat, only=True)
    except (ValueError, TimeoutError, RuntimeError) as e:
        log.warning("%s: the orientation's coverage was not measured (%s)", c, e)
        return ""
    return found[0].text if found else ""

def _keep_coverage(c: str, chat: str, line: str, summary: bool) -> None:
    """The first run's coverage line joins its record, for the next run's prompt (coverage_lead), the end of its thread,
    as a note, and summary.md when the run wrote one (`summary`)."""
    orientation.record(c, coverage=line, coverage_told=False)
    try:
        _, log_path = agents.paths(c, chat)
        agents.append(log_path, {"type": "chip", "ts": _now(), "kind": COVERAGE_KIND, "text": line})
        agents._notify(c, chat)
    except (HTTPException, OSError) as e:
        log.warning("%s: the coverage line did not reach the orientation's thread (%s)", c, e)
    if summary:
        try:
            with orientation.summary_file(c).open("a", encoding="utf-8") as f:
                f.write(f"\n{line}\n")
        except OSError as e:
            log.warning("%s: the coverage line did not reach summary.md (%s)", c, e)

def coverage_lead(rec: dict[str, Any]) -> str:
    """The end of the next run's prompt: the first run's coverage line, until a run started with it; '' after."""
    line = rec.get("coverage")
    if not isinstance(line, str) or not line.strip() or rec.get("coverage_told"):
        return ""
    return tools.hint("orient-coverage-lead", coverage=line.strip())


def _told_if_carried(c: str, carried: str) -> None:
    """A run started with the text `carried` (its message, or a continuation's prompt): when that holds the first run's
    coverage line while it is due, the line is told (coverage_lead gives it no more)."""
    rec = orientation.read_run(c) or {}
    line = rec.get("coverage")
    if isinstance(line, str) and line.strip() and not rec.get("coverage_told") and line.strip() in carried:
        orientation.record(c, coverage_told=True)


def undo_batch(c: str) -> tuple[str, str] | None:
    """(id, label) of the undo batch a call of the orientation belongs to: its follow-up's, `<chat>/<run>`, while one
    runs; None during the first run, whose cards are each a step."""
    run = subagents.current(c, KEY)
    if run is None or run.k <= 0:
        return None
    return f"{run.chat}/{run.k}", orientation.FOLLOWUP_LABEL


def latest(c: str) -> tuple[dict[str, Any], str, str]:
    """(the record, its chat, its agent id) of the workspace's latest orientation that can take a follow-up.
    NoOrientation when none ran (or one is starting), EarlierVersion for a chat with no agent id (0.5.0, or a
    pre-release 0.6.0 that ran it headless), EarlierSession when its agent belongs to another Claude Code session than
    main's."""
    from . import session  # noqa: PLC0415

    rec = orientation.read_run(c)
    chat = str(((rec or {}).get("chats") or {}).get(orientation.ROLE) or "")
    meta = agents.meta_or_none(c, chat) if chat else None
    if not rec or meta is None:
        raise NoOrientation("no orientation has run in this workspace")
    agent_id = str(meta.get("agent_id") or rec.get("agent_id") or "")
    if not agent_id or meta.get("route") != "subagent":
        raise EarlierVersion(tools.hint("orient-continue-earlier-version"))
    a = subagents.agent(c, agent_id) or {}
    if a.get("cancelled") or meta.get("continue") == subagents.CANCELLED:
        raise StoppedInTerminal(tools.hint("orient-continue-stopped-by-user"), chat, agent_id)
    sessions = [str(s) for s in a.get("sessions") or meta.get("sessions") or [meta.get("session")] if s]
    lv = session.current(c)
    if lv is not None and sessions and lv.sid not in sessions:
        raise EarlierSession(earlier_text(sessions[-1]))
    return rec, chat, agent_id


def stopped_unnamed(c: str, agent_id: str) -> bool:
    """Whether the orientation's latest run ended stopped with no sign of who stopped it: no stop of thimble's own (the
    browser's Stop, plan mode, main's quit) and no task notification. Esc on the first run of an agent the plugin
    started is such a stop, as Claude Code sends main no task notification for that run (live check U2 on 060-s4), and
    Claude Code resumes that agent no more. So main's message_orientation continues it as it does one stopped with Esc,
    in place of a SendMessage that Claude Code refuses."""
    a = subagents.agent(c, agent_id) or {}
    return a.get("status") == "stopped" and not a.get("stopped_by") and bool(a.get("plugin_started"))


def earlier_text(sid: str) -> str:
    """The text for an orientation of an earlier Claude Code session, naming the full session id to resume."""
    return tools.hint("orient-continue-earlier-session", session=sid)


def _refuse_message(c: str, text: str) -> None:
    """Plan mode: no follow-up starts (start-plan-mode), as no start does (U20)."""
    from . import session  # noqa: PLC0415

    if session.main_mode(c) == "plan":
        raise RuntimeError(tools.hint("start-plan-mode"))


def with_lead(c: str, text: str) -> tuple[str, bool]:
    """A follow-up's text with the first run's coverage line after it when one is due (coverage_lead), and whether it
    carries it."""
    told = coverage_lead(orientation.read_run(c) or {})
    return ("\n\n".join(p for p in (text.strip(), told) if p), bool(told))


async def _after_measure(c: str) -> None:
    """Wait while the first run's coverage line is measured (at most COVERAGE_TIMEOUT_S)."""
    ev = _closing.get(c)
    if ev is not None:
        try:
            await asyncio.wait_for(ev.wait(), COVERAGE_TIMEOUT_S)
        except asyncio.TimeoutError:
            pass


def _show_message(c: str, chat: str, text: str, by: str, run: int | None = None) -> None:
    """The analyst's message in the orientation's thread, from the browser or main, as it is sent, with the run it
    starts or joins (subagents.message_run), so the browser shows it as that follow-up's."""
    try:
        agents.Recorder(c, chat).record("user", text=text, by=by, **({"run": run} if run is not None else {}))
    except Exception:  # noqa: BLE001 — a chat deleted under the message
        log.debug("%s: the message was not shown in %s", c, chat, exc_info=True)


NOT_PASSED_ON = "not_passed_on"  # the chip kind of a follow-up that did not reach the orientation, its text the reason


def not_passed_on(c: str, chat: str, reason: str, text: str = "") -> None:
    """A follow-up that did not reach the orientation: a chip in its thread (NOT_PASSED_ON) with the reason and the
    message, which the browser shows as not passed on, with Send again."""
    try:
        agents.chip(c, NOT_PASSED_ON, reason, chat=chat, **({"message": text} if text else {}))
    except Exception:  # noqa: BLE001
        log.debug("%s: the not-passed-on line did not reach %s", c, chat, exc_info=True)


async def send(c: str, text: str, by: str = BROWSER, extension: str = "") -> dict[str, Any]:
    """A follow-up from the thread's composer (`by` BROWSER), or an extension's orientation instructions the analyst
    chose to run (`by` EXTENSION, with the line that names `extension` before them): through the module to the
    orientation's agent (subagents.send), with the coverage lead when due; held while the coverage line is measured,
    then sent ({status: held}). ValueError for an empty message, NoOrientation, EarlierSession, EarlierVersion,
    precached.Precached, RuntimeError (plan mode, or a module that could not pass it on, with its reason)."""
    text = str(text or "").strip()
    if not text:
        raise ValueError("the message is empty")
    if by == EXTENSION:
        text = "\n\n".join(x for x in (tools.hint("orient-from-extension", extension=extension), text) if x)
    if precached.is_precached_run(orientation.read_run(c)):
        raise precached.Precached(tools.hint("message_orientation-precached") or "this orientation ran in advance")
    program = await _program_follow_up(c, text, None)
    if program is not None:
        return program
    try:
        _, chat, agent_id = latest(c)
    except StoppedInTerminal as stopped:
        _refuse_message(c, text)
        ans = await continue_stopped(c, stopped.chat, stopped.agent_id, text, by)
        if ans.refused:
            raise RuntimeError(ans.reason or ans.kind or "the continuation did not start")
        return {"status": "continued", "chat": stopped.chat, **({"agentId": ans.agent_id} if ans.agent_id else {})}
    _refuse_message(c, text)
    k = subagents.message_run(c, agent_id)  # before the send, which may start the run
    if c in _closing:
        _show_message(c, chat, text, by, k)
        asyncio.get_running_loop().create_task(_send_held(c, chat, agent_id, text), name=f"orient-held:{c}")
        return {"status": "held", "chat": chat}
    body, told = with_lead(c, text)
    ans = await subagents.send(c, agent_id, body)
    if ans.refused and subagents.cancelled(c, agent_id):  # Claude Code said it resumes it no more (Esc): continue it
        ans = await continue_stopped(c, chat, agent_id, text, by)
        if ans.refused:
            raise RuntimeError(ans.reason or ans.kind or "the continuation did not start")
        return {"status": "continued", "chat": chat, **({"agentId": ans.agent_id} if ans.agent_id else {})}
    if ans.refused:
        raise RuntimeError(ans.reason or ans.kind or "the module did not pass it on")
    _show_message(c, chat, text, by, k)
    if told:
        orientation.record(c, coverage_told=True)
    return {"status": "sent", "chat": chat}


CONTINUATION_CARDS = 40  # of the stopped run's cards its continuation's prompt lists, by id and question
SUMMARY_CHARS = 2000  # of the stopped run's last text in the continuation's prompt


def _stopped_transcripts(c: str, agent_id: str) -> "list[Path]":
    """The transcript files of the stopped run's agent: those the mirror follows, else those under main's session
    folders in Claude Code's projects (one per session it ran under, U1)."""
    from . import demo, session  # noqa: PLC0415

    paths = [p for p in session.agent_paths(c, [agent_id]) if p.is_file()]
    if paths:
        return paths
    a = subagents.agent(c, agent_id) or {}
    out: list[Path] = []
    for sid in dict.fromkeys(str(s) for s in a.get("sessions") or [] if s):
        out += [f / f"agent-{agent_id}.jsonl" for f in demo._main_folders(demo.claude_config_dir(), sid)
                if (f / f"agent-{agent_id}.jsonl").is_file()]
    return out


def _last_text(paths: "list[Path]") -> str:
    """The last text an agent wrote, read from the end of its transcript files; '' when there is none."""
    for path in reversed(paths):
        try:
            lines = path.read_text("utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            msg = rec.get("message") if isinstance(rec, dict) and rec.get("type") == "assistant" else None
            content = msg.get("content") if isinstance(msg, dict) else None
            texts = [str(b.get("text") or "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
            text = "\n".join(t for t in texts if t.strip()).strip()
            if text:
                return text
    return ""


def _stopped_cards(c: str, rec: dict[str, Any]) -> str:
    """The cards of the orientation's deck, one line each with its ref and question, at most CONTINUATION_CARDS."""
    from . import notebook  # noqa: PLC0415

    deck = orientation.deck_of(rec)
    nb = notebook.read_notebook(config.workspace_dir(c), deck) if deck else None
    cells = [x for x in (nb or {}).get("cells") or [] if isinstance(x, dict) and x.get("id")]
    lines = [f"card:{x['id']} {' '.join(str(x.get('title') or '').split())}".rstrip() for x in cells[:CONTINUATION_CARDS]]
    if len(cells) > CONTINUATION_CARDS:
        lines.append(f"and {len(cells) - CONTINUATION_CARDS} more (list_cards)")
    return "\n".join(lines)


def continuation_prompt(c: str, rid: str, agent_id: str, message: str) -> str:
    """The prompt of a continuation (`## orient-continuation-prompt`): the request id on its first line, what the
    stopped run left (its last text, its deck's cards, the paths of its transcript), and the analyst's message."""
    rec = orientation.read_run(c) or {}
    paths = _stopped_transcripts(c, agent_id)
    summary = " ".join((_last_text(paths) or str(orientation.summary(c) or "")).split())
    if len(summary) > SUMMARY_CHARS:
        summary = summary[: SUMMARY_CHARS - 1].rstrip() + "…"
    none = tools.hint("orient-continuation-none") or "none"
    return tools.hint("orient-continuation-prompt", request_id=rid, summary=summary or none,
                      cards=_stopped_cards(c, rec) or none,
                      transcripts="\n".join(str(p) for p in paths) or none, message=message.strip())


async def continue_stopped(c: str, chat: str, agent_id: str, text: str, by: str = BROWSER, *,
                           route: str = subagents.CLICK, call: str | None = None) -> subagents.Answer:
    """A message to an orientation stopped with Esc, which Claude Code resumes no more (U2): a continuation, a new
    `thimble:orientation` run in the same thread (its chat, as run k+1 of its record), with the stopped run's context
    (continuation_prompt) and on the stopped run's model and effort, as a click through the module or, for main's
    message_orientation (`route` typed), the pending request and the exact Agent call. Its message shows in the thread
    as the run's when the agent starts (subagent_started)."""
    if running(c) or starting(c):
        return subagents.refusal(subagents.HOOK, tools.hint("start_orientation-running"))
    rec = orientation.read_run(c) or {}
    a = subagents.agent(c, agent_id) or {}
    vals = dict(a.get("values") or {}) or subagents.values_for(c, ROLE, {k: rec[k] for k in ("model", "effort")
                                                                        if rec.get(k)})
    body, told = with_lead(c, text)
    rid = subagents.request_id()
    meta = agents.meta_or_none(c, chat) or {}
    _starting.add(c)
    try:
        task = await asyncio.to_thread(continuation_prompt, c, rid, agent_id, body)
        ans = await subagents.start_job(
            c, ROLE, KEY, task, vals, route, description=description(str(meta.get("brief") or rec.get("query") or "")),
            request_id=rid, chat={"title": orientation.TITLE}, work=work_dir(c), call=call,
            fields={"continues": {"chat": chat, "agent": agent_id, "run": int(a.get("run") or 0) + 1,
                                  "message": text.strip(), "by": by}})
    finally:
        _starting.discard(c)
    if told and ans.started:  # a typed one's prompt tells it when its run starts (_told_if_carried)
        orientation.record(c, coverage_told=True)
    log.info("%s: the orientation %s stopped with Esc is continued (%s): %s", c, agent_id, route,
             ans.agent_id or ans.get("request") or ans.reason)
    return ans


async def _send_held(c: str, chat: str, agent_id: str, text: str) -> None:
    await _after_measure(c)
    body, told = with_lead(c, text)
    try:
        ans = await subagents.send(c, agent_id, body)
    except Exception as e:  # noqa: BLE001
        ans = subagents.refusal(subagents.ERROR, str(e))
    if ans.refused:
        not_passed_on(c, chat, ans.reason, text)
    elif told:
        orientation.record(c, coverage_told=True)


async def _program_follow_up(c: str, text: str, call: str | None) -> dict[str, Any] | None:
    """A message to an orientation an extension's program ran: the program runs again with it, {status: resumed,
    chat, run: 0}; None when the latest orientation was thimble's own. RuntimeError while it runs."""
    from . import harness, roles  # noqa: PLC0415

    rec = orientation.read_run(c) or {}
    agent = roles.agent_for(c, "orientation")
    if not rec.get("program") or not agent.code or agent.replacing is None:
        return None
    if harness.running(c, KEY) or orientation.running(c):
        raise RuntimeError("the orientation is running")
    choices = {"model": rec.get("model"), "effort": rec.get("effort")}
    run = await start_program(c, agent.replacing, text, choices, call=call, follow_up=True)
    return {"status": "sent", "chat": run.chat, "run": 0}

async def run_program_now(c: str, name: str) -> dict[str, Any]:
    """Settings' Run now for extension `name`, whose program runs the orientation here: the program runs again as a
    follow-up of the latest orientation, thimble's own or a program's, with that orientation's request, model and
    effort and the cards as they stand, so it adds to them rather than starting over. {status: resumed, chat, run: 0};
    NoOrientation when no orientation ran here, RuntimeError while one runs or when another agent runs the
    orientation."""
    from . import roles  # noqa: PLC0415

    agent = roles.agent_for(c, "orientation")
    if not agent.code or agent.replacing is None or agent.extension != name:
        raise RuntimeError(f"{name}'s program does not run the orientation here")
    if running(c) or orientation.running(c):
        raise RuntimeError("the orientation is running. Choose Run now again once it ends")
    rec = orientation.read_run(c) or {}
    chat = str((rec.get("chats") or {}).get(orientation.ROLE) or "")
    meta = agents.meta_or_none(c, chat) if chat else None
    if meta is None:
        raise NoOrientation("no orientation has run in this workspace")
    choices = {"model": rec.get("model"), "effort": rec.get("effort")}
    run = await start_program(c, agent.replacing, str(meta.get("brief") or ""), choices, follow_up=True)
    return {"status": "resumed", "chat": run.chat, "run": 0}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def _at(ts: Any) -> datetime | None:
    try:
        at = datetime.fromisoformat(str(ts or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)

def changed_cards(c: str, chat: str, k: int) -> dict[str, Any]:
    """What run `k` of the orientation `chat` changed, read from its undo batch (undo.batch_steps): {added, revised,
    deleted, cards}, the counts of cards it added, changed and deleted, and the ids of every card it touched."""
    from . import undo  # noqa: PLC0415

    added, revised, deleted = set(), set(), set()
    for step in undo.batch_steps(c, f"{chat}/{k}"):
        if step.get("kind") != "card":
            continue
        cid = str(step.get("target") or "")
        op = step.get("op")
        if op == "created":
            added.add(cid)
        elif op == "deleted":
            deleted.add(cid)
        else:
            revised.add(cid)
    revised -= added | deleted
    return {"added": len(added), "revised": len(revised), "deleted": len(deleted),
            "cards": sorted(added | revised | deleted)}

def subagent_started(c: str, run: subagents.Run, req: dict[str, Any]) -> None:
    """The orientation's agent started a run (subagents.ensure_chat for the first, run_again for a follow-up): the
    first takes up the record (`running`, its chat, agent id, route and session; its deck made), a follow-up runs it
    again as run k with the message it carries."""
    if run.k == 0:
        orientation.started(c, run.chat, session=run.sid, agent_id=run.agent_id, route="subagent")
        return
    cont = req.get("continues") if isinstance(req.get("continues"), dict) else {}
    if cont and int(cont.get("run") or 0) == run.k:  # a continuation's first run: its message is the analyst's (U2)
        text, by = str(cont.get("message") or ""), str(cont.get("by") or BROWSER)
        _show_message(c, run.chat, text, by, run.k)
        orientation.run_started(c, run.chat, run.k, [{"text": text, "by": by}] if text else [])
        orientation.record(c, agent_id=run.agent_id)
        _told_if_carried(c, str((req.get("input") or {}).get("prompt") or ""))
    else:
        messages = _run_messages(c, run)
        orientation.run_started(c, run.chat, run.k, messages)
        _told_if_carried(c, "\n".join(str(m.get("text") or "") for m in messages))
    try:  # main's chat shows the follow-up as the orientation's card for this run (the browser's AgentCard `run`)
        _, main_log = agents.paths(c, agents.MAIN_ID)
        agents.append(main_log, {"type": "agent", "ts": _now(), "chat": run.chat, "role": orientation.ROLE,
                                 "title": "Orientation", "run": run.k, "by": agents.TERMINAL})
        agents._notify(c, agents.MAIN_ID)
    except (HTTPException, OSError) as e:
        log.warning("%s: main's chat did not get the orientation's run %s (%s)", c, run.k, e)


def _run_messages(c: str, run: subagents.Run) -> "list[dict[str, Any]]":
    """The message that started a follow-up run, as its record keeps it: the message request a SendMessage claimed for
    the agent (from main's message_orientation, `by` MAIN, or the browser through the module, `by` BROWSER); none for a
    message the analyst typed in the agent tray, which no request carries (the mirror shows it in the thread)."""
    a = subagents.agent(c, run.agent_id) or {}
    if a.get("by") == "human":
        return []
    for r in reversed(list((subagents.read(c).get("requests") or {}).values())):
        if isinstance(r, dict) and r.get("kind") == "message" and r.get("agent") == run.agent_id \
                and r.get("state") in ("claimed", "done"):
            text = str((r.get("input") or {}).get("message") or "")
            return [{"text": text, "by": MAIN if r.get("route") == subagents.TYPED else BROWSER}] if text else []
    return []


def subagent_refused(c: str, req: dict[str, Any]) -> None:
    """A start or follow-up of the orientation that did not happen: a start's record ends `refused` with the reason and
    its kind (the browser's card, with Start it); a follow-up's thread says it was not passed on."""
    cont = req.get("continues") if isinstance(req.get("continues"), dict) else {}
    if req.get("kind") == "start" and cont.get("chat"):  # a continuation that did not start: its message was not
        not_passed_on(c, str(cont["chat"]), str(req.get("reason") or ""), str(cont.get("message") or ""))
        return
    if req.get("kind") == "start":
        rec = orientation.read_run(c) or {}
        if rec.get("request") in (None, req.get("id")) or rec.get("status") == "starting":
            orientation.refuse(c, str(req.get("reason") or ""), str(req.get("refused_kind") or subagents.ERROR),
                               request=req.get("id"))
        return
    if req.get("kind") == "message":
        a = subagents.agent(c, str(req.get("agent") or "")) or {}
        if a.get("cancelled"):
            return  # stopped with Esc: no Send again that cannot work; the composer's place says why (latest)
        if a.get("chat"):
            not_passed_on(c, str(a["chat"]), str(req.get("reason") or ""),
                          str((req.get("input") or {}).get("message") or ""))


def subagent_ended(c: str, run: subagents.Run, status: str, summary: str) -> None:
    """A run of the orientation ended (subagents.run_ended): its record closes (the first run's reveals its deck), and
    what follows goes on (_go_on): main hears it, thimble's view proposer is told of a first run that ended done, and the
    work folder lets go of what it no longer needs. A critic start it never made ends (critique_session.expire_pending).
    A run the analyst stopped stops the builds of the views it proposed (dev.stop_orientation_views, for an orientation
    from before 0.8.0) first. The first run's end goes on, when it finished, once its coverage line is measured
    (_measured). A critique an extension's program runs for it stops with it (critique_session.program_critique)."""
    _stop_program_critique(c, run)
    try:
        from . import critique_session  # noqa: PLC0415 — critique_session imports this module's callers

        critique_session.expire_pending(c, run)
    except Exception:  # noqa: BLE001 — the run ends either way
        log.exception("%s: the orientation's pending critic start was not ended", c)
    stopped = _analyst_stopped(c, run, status)
    if stopped:
        from . import dev  # noqa: PLC0415 — dev imports the modules that import this one

        try:
            if stopped := dev.stop_orientation_views(c):
                log.info("%s: the orientation was stopped, and so were the builds of %s", c, ", ".join(stopped))
        except Exception:  # noqa: BLE001 — the run ends either way
            log.exception("%s: the builds of the orientation's views were not stopped", c)
    try:
        if run.k == 0:
            orientation.finished(c, run.chat, status, summary)
            made: dict[str, Any] = {}
        else:
            made = changed_cards(c, run.chat, run.k)
            orientation.run_finished(c, run.chat, run.k, status, {k: v for k, v in made.items() if k != "cards"})
    except Exception:  # noqa: BLE001
        log.exception("%s: the orientation's record was not closed", c)
        made = {}
    if status == "failed":
        _say_failed(c, run.chat, run.k, summary, plan=summary == subagents.plan_failed_line(run.role))
    if run.k == 0 and status == "done" and not run.interrupted:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            _closing[c] = asyncio.Event()
            loop.create_task(_measured(c, run, status, summary, stopped, made), name=f"orient-coverage:{c}")
            return
    _go_on(c, run, status, summary, stopped, made)


def _say_failed(c: str, chat: str, k: int, summary: str, plan: bool = False) -> None:
    """A failed run's last line in the orientation's thread, as a note: it stopped, and why (FAILED_LINES), such as the
    API error that ended it, which subagents.run_ended gives as its report; for a run main's plan mode held at its end
    (`plan`), that line itself (subagents.plan_failed_line), which says what to do."""
    line = summary if plan else FAILED_LINES[k > 0].format(error=failure_line(summary) or "no error text came with it")
    try:
        _, log_path = agents.paths(c, chat)
        agents.append(log_path, {"type": "chip", "ts": _now(), "kind": ERROR_KIND, "text": line})
        agents._notify(c, chat)
    except (HTTPException, OSError) as e:
        log.warning("%s: the failed run's line did not reach the orientation's thread (%s)", c, e)


def _stop_program_critique(c: str, run: subagents.Run) -> None:
    """Stop the critique an extension's program runs for the orientation's run that ended, when one runs."""
    from . import critique_session, harness  # noqa: PLC0415 — critique_session imports this module's callers

    key = critique_session.session_key(run.key)
    if not harness.running(c, key):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(harness.stop(c, key), name=f"critique-stop:{c}")


async def _measured(c: str, run: subagents.Run, status: str, summary: str, stopped: "bool | list[str]",
                    made: dict[str, Any]) -> None:
    """The first run's end once its coverage line is measured: the line is kept (_keep_coverage), then main hears the
    end with it and what follows goes on (_go_on). The server's stop cuts the measure short: main hears the end
    without the line."""
    line = ""
    try:
        line = await measure(c, run.chat)
    except asyncio.CancelledError:
        _closed(c)
        try:
            _tell_main(c, status, 0, made)
        except Exception:  # noqa: BLE001 — the server is stopping either way
            log.exception("%s: main did not hear the orientation's end", c)
        raise
    except Exception:  # noqa: BLE001 — the run's end goes on without its line
        log.exception("%s: the orientation's coverage was not measured", c)
    try:
        if line:
            _keep_coverage(c, run.chat, line, summary=bool(str(summary or "").strip()))
    finally:
        _closed(c)
    try:
        _go_on(c, run, status, summary, stopped, made, line)
    except Exception:  # noqa: BLE001
        log.exception("%s: the end of the orientation's first run was not recorded", c)


def _closed(c: str) -> None:
    ev = _closing.pop(c, None)
    if ev is not None:
        ev.set()


def _go_on(c: str, run: subagents.Run, status: str, summary: str, stopped: "bool | list[str]", made: dict[str, Any],
           coverage: str = "") -> None:
    """What follows a run's end once its record is closed: main hears it, with the first run's coverage line, thimble's
    view proposer is told when the first run ended done (_tell_proposer), and the work folder is cleared."""
    _tell_main(c, status, run.k, made, error=summary if status == "failed" else "", coverage=coverage)
    if run.k == 0 and status == "done" and not run.interrupted:
        _tell_proposer(c)
    work_files.after_run(c, work_dir(c), "stopped" if status != "failed" and stopped else status)


def _tell_proposer(c: str) -> None:
    """Tell thimble's view proposer that the orientation's first run ended done, so it may check for a view proposal
    (proposer.trigger, which waits for main's hand-back turn). Imported here: proposer imports context, which imports
    session. A failure costs only that check."""
    try:
        from . import proposer  # noqa: PLC0415

        proposer.trigger(c, "orientation")
    except Exception:  # noqa: BLE001 — the run's end goes on without it
        log.exception("%s: the view proposer did not hear of the orientation's end", c)


def _notice(c: str, chat: str, status: str, error: str, follow_up: bool = False) -> None:
    """The end of a run of an extension's program that runs the orientation (start_program), told where the analyst is
    looking: a failed run posts a notice (notices.post) that names the orientation, says why in one line and how to run
    it again, with its thread `chat`; a run that ended done clears it. thimble's own orientation, a subagent, gets its
    notice where every agent's end does (subagents.run_ended). Imported here; a notice that cannot be told is logged,
    and the run's end goes on."""
    try:
        from . import notices  # noqa: PLC0415

        key = f"{NOTICE_KEY}:{chat}"
        if status == "failed":
            line = FAILED_LINES[bool(follow_up)].format(
                error=failure_line(error, NOTICE_CHARS) or "no error text came with it")
            line += "" if line.endswith((".", "…", "!", "?")) else "."
            notices.post(c, kind="agent", agent=NOTICE_AGENT, chat=chat, key=key, text=f"{line} {NOTICE_FIX}")
        elif status == "done":
            notices.clear(c, key)
    except Exception:  # noqa: BLE001 — the run's end goes on without it
        log.exception("%s: the notice of the orientation's end (%s) was not told", c, status)


def _analyst_stopped(c: str, run: subagents.Run, status: str) -> bool:
    """Whether the analyst stopped the run (Stop, Esc), not main's quit or a failure."""
    return status == "stopped" and not run.interrupted


VIEW_LINES = {"built": "orient-views-built", "failed": "orient-views-failed", "building": "orient-views-building",
              "stopped": "orient-views-stopped", "suggested": "orient-views-suggested"}

def view_counts(c: str, since: datetime | None) -> dict[str, int]:
    """The views an orientation from before 0.8.0 proposed since `since`, which only the end line of a record whose
    passes name `views` counts (made_text), by where their builds stand (built, failed, building; queued or
    held count as building; stopped, those the analyst's Stop dropped), and the viewers for file types it suggested.
    Proposals main made at the analyst's request are not counted; one that failed through its repairs counts as
    failed."""
    from . import dev, views  # noqa: PLC0415

    counts = dict.fromkeys(VIEW_LINES, 0)
    for p in views.list_proposals(c):
        if p.get("asked") or (since is not None and ((t := _at(p.get("ts"))) is None or t < since)):
            continue
        if p.get("status") == "dropped":
            counts["stopped"] += p.get("error") == dev.ORIENTATION_STOPPED
            continue
        counts[p["status"] if p.get("status") in ("built", "failed", "suggested") else "building"] += 1
    return counts

def views_text(counts: dict[str, int], none: str = "orient-made-views") -> str:
    """An end line's words for view_counts (`orient-views-*` of prompts/tools.md), or the line `none` names when the
    orientation proposed no view."""
    if not any(counts.values()):
        return tools.hint(none, views=tools._count("view", 0))
    return ", ".join(tools.hint(VIEW_LINES[k], views=tools._count("view", n)) for k, n in counts.items() if n)

def made_text(c: str, run: dict[str, Any]) -> str:
    """What the orientation of `run` made, for the `orient-made-*` lines of prompts/tools.md: the labels it defined (trials
    among them) and the cards it made in its deck, and for a record from before 0.8.0 whose passes name `views`, the views
    it proposed by build state; an earlier orientation's cards in the same deck are not counted. A record may name the
    deck's pass `analyze` or keep the deck as its `final` group."""
    from . import concepts, notebook  # noqa: PLC0415 — the workspace's stores, only read at the end

    since = _at(run.get("started"))

    def new(items: "list[dict[str, Any]]", key: str) -> int:
        return sum(1 for x in items if since is None or ((t := _at(x.get(key))) is not None and t >= since))

    passes = run.get("passes") or []
    parts: list[str] = []
    if "views" in passes:
        parts.append(views_text(view_counts(c, since)))
    ws = config.workspace_dir(c)
    labels = new(concepts.list_concepts(ws), "ts")
    if labels:
        parts.append(tools._count("label", labels))
    groups = run.get("groups") or {}
    deck = str(groups.get("final") or groups.get("orientation") or "") if ("final" in passes or "analyze" in passes) else ""
    nb = notebook.read_notebook(ws, deck) if deck else None
    cards = new([x for x in (nb or {}).get("cells") or [] if isinstance(x, dict)], "created_ts")
    if deck:
        parts.append(tools._count("card", cards))
    return ", ".join(parts) or tools.hint("orient-made-nothing")


CHANGED_LINES = {"added": "orient-changed-added", "revised": "orient-changed-revised",
                 "deleted": "orient-changed-deleted"}  # a follow-up's card counts in its `orient` event (status_text)


def status_text(c: str, status: str, k: int = 0, made: "dict[str, Any] | None" = None, error: str = "",
                coverage: str = "") -> str:
    """The `orient` event's text: the first run ended (finished, stopped or failed) and what it made, or follow-up `k`
    ended and what it changed; a failed run's line ends with `error`, the failure's own text on one line
    (failure_line), so main can say why. The first run's `coverage` line follows on a line of its own."""
    why = failure_line(error)
    run = orientation.read_run(c) or {}
    if k > 0:
        m = made or {}
        what = [tools.hint(CHANGED_LINES[key], cards=tools._count("card", int(m[key])))
                for key in CHANGED_LINES if m.get(key)]
        follow = {"stopped": "orient-follow-up-stopped", "failed": "orient-follow-up-failed"}.get(status, "orient-followed-up")
        return tools.hint(follow, changed=", ".join(what) or tools.hint("orient-changed-nothing"), error=why)
    first = {"stopped": "orient-stopped", "failed": "orient-failed"}.get(status, "orient-finished")
    text = tools.hint(first, made=made_text(c, run), error=why)
    return f"{text}\n{coverage.strip()}" if coverage.strip() else text


FAILURE_CHARS = 400  # of a failure's text in the one line that says why (failure_line)


def failure_line(summary: str | None, chars: int = FAILURE_CHARS) -> str:
    """A failure's text on one line, cut at `chars` (FAILURE_CHARS)."""
    line = " ".join(str(summary or "").split())
    return line if len(line) <= chars else line[: chars - 1].rstrip() + "…"


def _tell_main(c: str, status: str, k: int = 0, made: "dict[str, Any] | None" = None, error: str = "",
               coverage: str = "") -> None:
    """The `orient` browser event: a run of the orientation ended, with status_text as its text (prompts/main.md). It
    waits for main's next event, since it asks main for nothing."""
    subagents.tell_main(c, orientation.ORIENT_KIND, {"text": status_text(c, status, k, made, error, coverage),
                                                     "status": status, **({"run": k} if k else {})})


def _wrote_since(c: str, since: str, chat: str = agents.MAIN_ID) -> bool:
    """Whether main's chat (or the thread `chat`) holds a message of the analyst's, typed in the terminal or sent from
    the browser's chat, at or after the ISO time `since`."""
    try:
        floor = datetime.fromisoformat(since.replace("Z", "+00:00"))
        _, log_path = agents.paths(c, chat)
        recs = agents.read_events(log_path)
    except (ValueError, HTTPException, OSError):
        return True  # a record or a chat that cannot be read refuses no orientation
    for rec in reversed(recs):
        if rec.get("type") != "user" or rec.get("by") not in (agents.TERMINAL, agents.BROWSER):
            continue
        try:
            ts = datetime.fromisoformat(str(rec.get("ts") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        return ts >= floor  # the latest message decides
    return False

async def asked_for(c: str, chat: str = agents.MAIN_ID) -> bool:
    """Whether anyone asked for a new orientation: a start waits for its agent, none has run here yet, or the
    analyst wrote to main (or to the thread `chat` whose fork calls start_orientation, U5) since the latest one ended.
    Main's chat records a typed message within its follower's tail, so a message not there yet is waited for up to
    ASKED_WAIT_S."""
    run = orientation.read_run(c)
    if not run or run.get("status") in orientation.RUNNING or not run.get("ended"):
        return True
    end = asyncio.get_running_loop().time() + ASKED_WAIT_S
    while True:
        if await asyncio.to_thread(_wrote_since, c, str(run["ended"]), chat):
            return True
        if asyncio.get_running_loop().time() >= end:
            return False
        await asyncio.sleep(0.25)


def choices_of(args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """(the request, the run's model and effort) of start_orientation's arguments or the body of POST /ws/{c}/start:
    `focus` (or `brief`, `text`), and `model` and `effort`, left to Settings when not given (subagents.values_for). The
    switches a start had before 0.8.0 (the deck, the views, the report, the critique) are ignored."""
    brief = str(args.get("focus") or args.get("brief") or args.get("text") or "")
    values = {k: str(args[k]) for k in ("model", "effort") if args.get(k)}
    return brief, values


async def tool_start_orientation(ctx: Any, args: dict[str, Any]) -> Any:
    """The `start_orientation` tool: the pending start of the orientation with the request and the run's model and
    effort (choices_of), and the exact Agent call main makes (`## start_orientation-subagent`). Refused while one runs,
    when nobody asked for a new one since the latest ended (asked_for), without the module, and in plan mode. A thread's
    fork's call starts the orientation the same way, by main's Agent call on a `start_agent` event (tools._ask_main),
    since the fork may not make it."""
    from . import session  # noqa: PLC0415

    brief, values = choices_of(args)
    if running(ctx.c) or starting(ctx.c):
        return tools.err(tools.hint("start_orientation-running"))
    fork = await tools._fork_of(ctx) if ctx.session is None else None
    # a subagent of main's may start it (U5). A thread's fork answers to the analyst's messages in its thread; any other
    # answers to the analyst's messages to main, since the prompt its own chat holds is main's words, not the analyst's
    from . import threads  # noqa: PLC0415

    asker = str((fork or {}).get("id") or "") or None
    if asker is None:
        caller = await subagents.typed_caller(ctx.c, ctx.tool_use_id)
        asker = session.chat_of_agent(ctx.c, caller) if caller else None
    if not await asked_for(ctx.c, asker if asker and threads.is_thread(ctx.c, asker) else agents.MAIN_ID):
        return tools.err(tools.hint("start_orientation-unasked"))
    try:
        # a fork's start keeps no call of the fork's: main's Agent call claims it (tools._ask_main)
        ans = await start(ctx.c, brief, values=values, route=subagents.TYPED,
                          call=None if fork is not None else ctx.tool_use_id)
    except (RuntimeError, ValueError) as e:
        return tools.err(f"start_orientation: {e}")
    if ans.get("program"):
        return tools.ok(tools.hint("start_orientation-program", extension=ans["program"]))
    if ans.refused:
        return tools.err(ans.reason or f"start_orientation: {ans.kind}")
    if fork is not None:
        return await tools._ask_main(ctx, ans, what=FORK_WHAT, thread=fork, agent=FORK_AGENT)
    return tools.ok(tools.hint("start_orientation-subagent", input=json.dumps(ans["input"], ensure_ascii=False)))


async def tool_message_orientation(ctx: Any, args: dict[str, Any]) -> Any:
    """The `message_orientation` tool, main's: the pending message request and the exact SendMessage main makes
    (`## orient-subagent-message`), with the coverage lead when due, waiting while the coverage line is measured."""
    text = str(args.get("message") or "").strip()
    if not text:
        return tools.err(tools.hint("message_orientation-empty"))
    if precached.is_precached_run(orientation.read_run(ctx.c)):
        return tools.err(tools.hint("message_orientation-precached"))
    try:
        program = await _program_follow_up(ctx.c, text, ctx.tool_use_id)
        if program is not None:
            return tools.ok(tools.hint("message_orientation-started"))
        _, chat, agent_id = latest(ctx.c)
        _refuse_message(ctx.c, text)
        if stopped_unnamed(ctx.c, agent_id):  # Esc, as far as thimble can tell: main's SendMessage would be refused
            raise StoppedInTerminal(tools.hint("orient-continue-stopped-by-user"), chat, agent_id)
    except NoOrientation:
        return tools.err(tools.hint("message_orientation-none"))
    except StoppedInTerminal as stopped:  # Claude Code resumes it no more: a continuation in its thread (U2)
        try:
            _refuse_message(ctx.c, text)
        except RuntimeError as e:
            return tools.err(str(e))
        ans = await continue_stopped(ctx.c, stopped.chat, stopped.agent_id, text, MAIN, route=subagents.TYPED,
                                     call=ctx.tool_use_id)
        if ans.refused:
            return tools.err(ans.reason or f"message_orientation: {ans.kind}")
        return tools.ok(tools.hint("message_orientation-continues",
                                   input=json.dumps(ans["input"], ensure_ascii=False)))
    except (EarlierSession, EarlierVersion, RuntimeError) as e:
        return tools.err(str(e))
    await _after_measure(ctx.c)
    body, _ = with_lead(ctx.c, text)  # told once the run starts with it (_told_if_carried), not when main is given it
    ans = subagents.message_request(ctx.c, agent_id, body, call=ctx.tool_use_id)
    return tools.ok(tools.hint("orient-subagent-message", agent=agent_id, text=body,
                               input=json.dumps(ans["input"], ensure_ascii=False)))


class StartBody(BaseModel):
    """The body of POST /ws/{c}/start, which the browser's Start sent before 0.8.0 and a pre-cache sends
    (scripts/dev/precache_orientation.py): the focus and the run's model and effort. Any other field, such as a switch
    an older page or a pre-cache sends (`deck`, `views`, `report`, `critique`), is ignored."""

    text: str = ""
    model: str | None = None
    effort: str | None = None


@router.post("/ws/{c}/start")
async def start_route(c: str, body: StartBody, request: Request) -> dict[str, Any]:
    """A start by click, which a pre-cache sends (the browser's Start sent it before 0.8.0): the analyst's cookie (403
    without it), and the orientation starts through the module (start). The answer: {agentId} or the refusal's {kind,
    reason}, which the record also holds."""
    subagents.analyst_only(request)
    config.workspace_dir(c)
    brief, values = choices_of(body.model_dump())
    ans = await start(c, brief, values=values, route=subagents.CLICK)
    return {**dict(ans), **({"kind": ans.kind, "reason": ans.reason} if ans.refused else {})}


RUN_FIELDS = ("status", "query", "model", "effort", "route", "started_by", "agent_id", "request", "refused", "requested",
              "started", "ended", "chats")  # what run_route shows of orient/run.json


@router.get("/ws/{c}/orientation")
async def run_route(c: str) -> dict[str, Any]:
    """The latest orientation's record as the browser's orientation card reads it: its status, the request, the run's
    exact model and effort, who started it, the pending request, and for a start that did not happen {reason, kind, at,
    expired?}; {} before any was asked for."""
    config.workspace_dir(c)
    rec = orientation.read_run(c) or {}
    return {k: rec[k] for k in RUN_FIELDS if k in rec}


class MessageBody(BaseModel):
    text: str


@router.post("/ws/{c}/orientation/message")
async def message_route(c: str, body: MessageBody, request: Request) -> dict[str, Any]:
    """The orientation thread's composer: a click, so the analyst's cookie (403 without it), and the follow-up goes
    through the module (send): {status: sent | held, chat}. 400 for an empty message, 404 when no orientation has run,
    409 with the earlier-session text (and for a pre-cache, plan mode, or a module that did not pass it on), 410 with
    the earlier-version text. A message to an orientation stopped with Esc starts its continuation (continue_stopped):
    {status: continued, chat}."""
    from . import events  # noqa: PLC0415

    subagents.analyst_only(request)
    config.workspace_dir(c)
    try:
        out = await send(c, body.text, BROWSER)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except NoOrientation as e:
        raise HTTPException(404, str(e)) from e
    except precached.Precached as e:
        raise HTTPException(409, str(e)) from e
    except EarlierVersion as e:
        raise HTTPException(410, str(e)) from e
    except (EarlierSession, RuntimeError) as e:
        raise HTTPException(409, str(e)) from e
    events.show(c, events.terminal_line(events.MAIN, f"orientation: {body.text}", {}))
    return out
