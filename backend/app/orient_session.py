"""The orientation: a broad analysis of the corpus for the analyst, run as `thimble:orientation`, a named subagent of the
analyst's Claude Code session with a fresh context (subagents.py). The machinery it shares with thimble's other agents
is subagents.py; this module holds what is the orientation's own.

Start. Start in the browser is a click (start_route): the module spawns the orientation with no turn of main. Typed in
the terminal, main calls `start_orientation`, whose result is the exact Agent call main makes (tool_start_orientation).
Both take the request (the focus), the four switches (the deck, the views, the critique and the report) and the run's
model and effort, each defaulting to Settings. Once an orientation has ended, the tool starts another only when someone
asked for it since (asked_for). Without thimble's plugin module, in plan mode, or in a session the launcher did not
start, no orientation starts (subagents.refusal_before).

The prompt. The registration (subagent_definition) holds prompts/orient.md's body rendered for the workspace with every
part, its instructions (prompts/orient-instructions.md, or the workspace's `orient_instructions` setting) and the active
extensions' blocks; the module registers it again when they change. A run's own prompt (run_prompt, hint
orient-subagent-prompt) carries the request id on its first line, the request, and which outputs are on, so the parts
that are off stay unused: their tools refuse a call (orientation.part_on). The run's model and effort are Settings' or
its arguments' (subagents.values_for).

Calls. Each call the orientation and its own subagents make is numbered in its chat's sequence and citable as
`call:<chat>/<n>` (calls.py); the plugin's --agents hook tells the model each ref.

End of a run. The orientation's run ends at its hand-back (subagents.run_ended), and subagent_ended does what it means:
the first run's record closes and reveals the deck, its coverage line is measured (below), main hears an `orient` event
with one line counting what was made, the work folder lets go of what no card uses (work_files), and the report pass
starts the report's writer through the module, as part of the orientation's own start (write_session.follow_on). A run
the analyst stopped stops the builds of the views it proposed.

Coverage. When the first run finishes (done; not stopped or failed), its coverage line (orient_checks.coverage) is
measured in the checks' child process before the end goes on; meanwhile a follow-up waits (at most COVERAGE_TIMEOUT_S),
so that it carries the line (`## orient-coverage-lead`). The line is a note at the end of its thread, a second line of
main's `orient` event and of summary.md, and the record's `coverage`.

Follow-ups. The thread's composer sends a follow-up through the module (message_route, subagents.send); main's
`message_orientation` returns the exact SendMessage. A follow-up continues the same agent, by its id, as its next run;
its cards land in place as one undo batch, and when it changes a card the report cites, the report pass runs again as a
revision. An orientation of an earlier Claude Code session, or of an earlier version of thimble (a chat with no agent
id), cannot be continued (409, 410). An orientation `thimble demo` installed from a pre-cache cannot either
(precached.py). An orientation an extension's program runs takes a follow-up by running again with it
(_program_follow_up); Settings' Run now for an extension whose program runs the orientation runs it again
(run_program_now).
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


PASSES = ("final", "views", "report")  # orientation.passes: the outputs start_orientation's switches turn on

# The `#### ` parts of orient.md's `### Outputs` a switch includes or leaves out, by the output it turns on.
PARTS = {"final": "The deck", "views": "Views", "report": "The report"}

# The parts that are lines of orient.md, by what turns them on, and the text that finds each line.
LINES = {"critique": "`critique`"}

# The lines of orient.md about the outputs as a whole, kept only while at least one output is on.
OUTPUT_LINES = ("Draft the outputs described below", "Then revise the outputs described above")

# The lines of orient.md's order of work that propose views, early and while it analyzes, kept only while the views are
# on.
VIEWS_LINES = ("propose the views whose form the survey", "propose a view when the categories or leads")

# The thimble tools the orientation gets; every other registry tool is taken away.
ORIENT_TOOLS = ("read_ref", "list_cards", "add_card", "edit_card", "delete_card", "apply_label", "propose_view",
                "screenshot", "critique")

# The thimble tools that belong to a part, by the part: each refuses a call while its part is off (orientation.part_on).
PART_TOOLS = {"final": ("add_card", "edit_card", "delete_card", "apply_label"), "views": ("propose_view",),
              "critique": ("critique",)}

WORK_DIR = "work"  # orient/work: the one folder outside the corpus the session writes into

INSTRUCTIONS = "orient-instructions"  # prompts/orient-instructions.md, thimble's default instructions

SETTING = "orient_instructions"  # settings.json: the analyst's own instructions, which replace the defaults (instructions_of)

# The blocks of the prompt thimble gives a default for, which an extension may replace (extensions.orient_blocks), by
# name: each one's default prompt file.
BLOCKS = {"instructions": INSTRUCTIONS}

# What stands in each slot the analyst's text fills until the parts are left out (system_prompt).
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

ASKED_WAIT_S = 2.0  # how long start_orientation waits for main's chat to show the analyst's latest message (asked_for)
SCRATCH_GLOB = "tmp_*"  # the scratch folders of the orientation's own subagents (the --subagent-start hook)


class NoOrientation(RuntimeError):
    """No orientation has run in the workspace, or one is starting and has no agent yet."""


class EarlierSession(RuntimeError):
    """The orientation ran in an earlier Claude Code session, whose agents this one cannot reach."""


class EarlierVersion(RuntimeError):
    """The orientation ran in an earlier version of thimble (its chat has no agent id), so it cannot be continued."""


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


def parts_of(choices: dict[str, Any], passes: "list[str] | tuple[str, ...]") -> list[str]:
    """The parts of the prompt a run uses (the keys of PARTS and LINES): the outputs its switches turned on, and the
    critique when on."""
    on = [p for p in PASSES if p in passes]
    if choices.get("critique", orientation.DEFAULT_CRITIQUE):
        on.append("critique")
    return [p for p in (*PARTS, *LINES) if p in on]


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

def system_prompt(c: str, brief: str, parts: "list[str] | tuple[str, ...]", instructions: "str | None" = None) -> str:
    """orient.md's body rendered for workspace `c`: the prefix with shared.md (with the workspace's view citation forms)
    and the request, the instructions, and the suffix with each part not in `parts` left out (and OUTPUT_LINES when no
    output is on, VIEWS_LINES when the views are off)."""
    from . import cardtypes, views  # noqa: PLC0415 — views imports refs, which the rest of this module does not need

    values = {"workdir": str(config.corpus_dir(c)), "workfolder": str(work_dir(c)), "forms": views.forms_text(c),
              "card_types": cardtypes.prompt_text(c), **_MARKS}
    lines = [s for p, s in LINES.items() if p not in parts] + ([] if any(p in parts for p in PARTS) else list(OUTPUT_LINES))
    lines += [] if "views" in parts else list(VIEWS_LINES)
    replaced = bool(userconf.prompt_files(c, "orientation"))  # a prompt that replaces thimble's may lack its parts
    text = prompts.without(prompts.agent_prompt(PROMPT, values), [h for p, h in PARTS.items() if p not in parts], lines,
                           strict=not replaced)
    # The request and the instructions go in after the parts are left out, so a heading in either cannot cut the
    # analyst's own text or a part of the suffix.
    fills = {"request": brief.strip() or tools.hint("orient-no-request"), "instructions": instructions_of(c, instructions)}
    for slot, mark in _MARKS.items():
        text = text.replace(mark, fills[slot], 1)
    return re.sub(r"\n{3,}", "\n\n", text)  # an empty {{forms}} leaves a blank line of its own

def disallowed() -> list[str]:
    """The registration's disallowedTools: the thimble tools that are not the orientation's (main's own among them).
    A part's tools stay, since one registration serves every run; a call of one whose part is off is refused
    (orientation.part_on)."""
    return tools.not_own(list(ORIENT_TOOLS))


def subagent_definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:orientation` for workspace `c` (subagents.roles adds its model, effort and
    `background`): orient.md's body rendered with every part, shared.md embedded, the workspace's instructions and the
    extensions' blocks, with the request left to each run's prompt (`## orient-subagent-prompt`), its frontmatter's
    description, and the thimble tools that are not the orientation's taken away. orient.md has no `{{request}}` slot;
    an analyst's own copy that still has one loses the no-request line there, since each run's prompt says it."""
    front = prompts.agent_file(PROMPT)[0]
    with prompts.custom(userconf.prompt_files(c, "orientation")):
        body = system_prompt(c, "", [*PARTS, *LINES])
    body = body.replace(tools.hint("orient-no-request"), "", 1)
    return {"description": str(front.get("description") or ""), "prompt": body, "disallowedTools": disallowed()}


# a run prompt's {outputs} and {off}, each the outputs named so, or `none` and `nothing`; its {critique} is on or off
OUTPUT_WORDS = {"final": "the deck", "views": "view proposals", "report": "the report"}


def run_prompt(c: str, rid: str, brief: str, passes: "list[str]", critique: bool) -> str:
    """A run's own prompt (`## orient-subagent-prompt`): the request id `rid` on its first line, the analyst's request,
    the outputs this run makes and those it leaves out, and whether it runs the critique."""
    on = [OUTPUT_WORDS[p] for p in PASSES if p in passes]
    off = [OUTPUT_WORDS[p] for p in PASSES if p not in passes]
    return tools.hint("orient-subagent-prompt", request_id=rid, request=brief.strip() or tools.hint("orient-no-request"),
                      outputs=", ".join(on) or "none", off=", ".join(off) or "nothing",
                      critique="on" if critique else "off")


def description(brief: str) -> str:
    """The Agent call's description, which Claude Code's agent tray shows beside the type: `orientation: <focus>`."""
    focus = " ".join(brief.split())[:60] or "the whole corpus"
    return f"orientation: {focus}"


_starting: set[str] = set()  # the workspaces whose orientation's start waits for the module's answer (start)


def starting(c: str) -> bool:
    return c in _starting


async def start(c: str, brief: str, passes: "list[str] | tuple[str, ...]" = ("final", "views"), *,
                critique: bool = orientation.DEFAULT_CRITIQUE, values: "dict[str, Any] | None" = None,
                route: str = subagents.CLICK, call: str | None = None) -> subagents.Answer:
    """Start the orientation for workspace `c` with the outputs `passes`, the critique and the run's values (each
    defaulting to Settings): a click through the module, or for a typed start (`call`, main's start_orientation call)
    the pending request and the exact Agent call (subagents.start_job). The record says `starting`, then `running` once
    the agent starts (subagent_started), or `refused` with the reason and its kind. An extension whose program runs the
    orientation runs it instead (start_program). The workspace's extensions are found first when it never found them
    (extensions.settle)."""
    from . import extensions, roles  # noqa: PLC0415

    if running(c) or starting(c):
        return subagents.refusal(subagents.HOOK, tools.hint("start_orientation-running"))
    _starting.add(c)
    try:
        await extensions.settle(c)
        passes = [p for p in PASSES if p in passes]
        vals = subagents.values_for(c, ROLE, values)
        agent = roles.agent_for(c, "orientation")
        if agent.code and agent.replacing is not None:
            orientation.request(c, brief, passes, critique=critique, **vals)
            await start_program(c, agent.replacing, brief, passes, {"critique": critique, **vals}, call=call)
            await extensions.mark_oriented(c, [agent.replacing.extension])
            return subagents.Answer({"program": agent.replacing.extension})
        rid = subagents.request_id()
        started_by = "typed" if route == subagents.TYPED else "click"
        before = subagents.refusal_before(c)
        if before is not None and route == subagents.TYPED:
            return before  # main reads why; the analyst typed it in the terminal and reads main's answer there
        orientation.start_requested(c, {"text": brief, "passes": passes, "critique": critique, **vals,
                                        "request": rid, "started_by": started_by})
        if before is not None:
            orientation.refuse(c, before.reason, before.kind or subagents.ERROR)
            return before
        task = run_prompt(c, rid, brief, passes, critique)
        ans = await subagents.start_job(c, ROLE, KEY, task, vals, route, description=description(brief), request_id=rid,
                                        chat={"title": orientation.TITLE, "brief": brief.strip()}, work=work_dir(c),
                                        call=call, check=False)
        if ans.started or ans.typed:
            await extensions.mark_oriented(c)
        return ans
    finally:
        _starting.discard(c)


async def start_program(c: str, part: Any, brief: str, passes: "list[str]", choices: dict[str, Any],
                        call: str | None = None, follow_up: bool = False) -> Any:
    """Start the orientation as an extension's program (harness.py) with the request `brief`, the outputs `passes` and
    Start's `choices`; `follow_up` for a message to a finished one, which runs the program again with it. Its cards,
    labels and proposals come through its tools; what it returns is the line main hears."""
    from . import harness  # noqa: PLC0415

    listed = await tools.call(c, "list_cards", {"group": "all"}, session=KEY)
    parts = parts_of(choices, passes)
    # critique reads the transcript of thimble's own orientation session, which a program has none of
    own = tuple(n for n in ORIENT_TOOLS if n != "critique" and n not in {
        t for p, names in PART_TOOLS.items() if p not in parts for t in names})
    job = harness.Job(c, "orientation", KEY, orientation.TITLE,
                      {"request": brief.strip(), "outputs": list(passes), "follow_up": follow_up,
                       "choices": {"effort": effort_of(choices),
                                   "critique": bool(choices.get("critique", orientation.DEFAULT_CRITIQUE))},
                       "cards": listed.text, "corpus": str(config.corpus_dir(c)), "tools": list(own)},
                      own, work_dir(c), chat_role=orientation.ROLE,
                      fields={"brief": brief.strip(), **({"tool_use_id": call} if call else {})})

    def started(run: Any) -> None:
        orientation.started(c, run.chat, passes=passes, route="program")
        orientation.record(c, model=choices.get("model"), effort=choices.get("effort"),
                           critique=bool(choices.get("critique", orientation.DEFAULT_CRITIQUE)), program=part.extension)

    def ended(run: Any, status: str, summary: str) -> None:
        try:
            orientation.finished(c, run.chat, status, summary, report=False)
        except Exception:  # noqa: BLE001
            log.exception("%s: the orientation's record was not closed", c)
        _tell_main(c, status, 0, {}, error=summary if status == "failed" else "")
        if status == "done":
            _report(c)

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
    sessions = [str(s) for s in a.get("sessions") or meta.get("sessions") or [meta.get("session")] if s]
    lv = session.current(c)
    if lv is not None and sessions and lv.sid not in sessions:
        raise EarlierSession(earlier_text(sessions[-1]))
    return rec, chat, agent_id


def earlier_text(sid: str) -> str:
    """The text for an orientation of an earlier Claude Code session, naming the full session id to resume."""
    return tools.hint("orient-continue-earlier-session", resume=f"thimble -r {sid}")


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


def _show_message(c: str, chat: str, text: str, by: str) -> None:
    """The analyst's message in the orientation's thread, from the browser or main, as it is sent."""
    try:
        agents.Recorder(c, chat).record("user", text=text, by=by)
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
    _, chat, agent_id = latest(c)
    _refuse_message(c, text)
    if c in _closing:
        _show_message(c, chat, text, by)
        asyncio.get_running_loop().create_task(_send_held(c, chat, agent_id, text), name=f"orient-held:{c}")
        return {"status": "held", "chat": chat}
    body, told = with_lead(c, text)
    ans = await subagents.send(c, agent_id, body)
    if ans.refused:
        raise RuntimeError(ans.reason or ans.kind or "the module did not pass it on")
    _show_message(c, chat, text, by)
    if told:
        orientation.record(c, coverage_told=True)
    return {"status": "sent", "chat": chat}


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
    passes = [p for p in PASSES if p in (rec.get("passes") or [])]
    choices = {"model": rec.get("model"), "effort": rec.get("effort"),
               "critique": rec.get("critique", orientation.DEFAULT_CRITIQUE)}
    run = await start_program(c, agent.replacing, text, passes, choices, call=call, follow_up=True)
    return {"status": "sent", "chat": run.chat, "run": 0}

async def run_program_now(c: str, name: str) -> dict[str, Any]:
    """Settings' Run now for extension `name`, whose program runs the orientation here: the program runs again as a
    follow-up of the latest orientation, thimble's own or a program's, with that orientation's request, outputs and
    choices and the cards as they stand, so it adds to them rather than starting over. {status: resumed, chat, run: 0};
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
    passes = [p for p in PASSES if p in (rec.get("passes") or [])]
    choices = {"model": rec.get("model"), "effort": rec.get("effort"),
               "critique": rec.get("critique", orientation.DEFAULT_CRITIQUE)}
    run = await start_program(c, agent.replacing, str(meta.get("brief") or ""), passes, choices, follow_up=True)
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
    deleted, views, view_states, cards}, the counts of cards it added, changed and deleted, of the views it proposed and
    of those by where their builds stand (view_counts), and the ids of every card it touched."""
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
    started = None
    for u in (orientation.read_run(c) or {}).get("followups") or []:
        if isinstance(u, dict) and u.get("run") == k:
            started = _at(u.get("started"))
    states = view_counts(c, started) if started is not None else dict.fromkeys(VIEW_LINES, 0)
    return {"added": len(added), "revised": len(revised), "deleted": len(deleted), "views": sum(states.values()),
            "view_states": states, "cards": sorted(added | revised | deleted)}

def report_cards(c: str) -> set[str]:
    """The ids of the cards the report cites or shows, read from its stored document; empty when none is written."""
    from . import investigation, report_types  # noqa: PLC0415

    try:
        doc = report_types.read_doc(c, investigation.MAIN, orientation.REPORT_DOC)
    except Exception:  # noqa: BLE001 — a report that cannot be read cites nothing we can revise
        return set()
    if not isinstance(doc, dict):
        return set()
    text = json.dumps(doc, ensure_ascii=False)
    out = set(re.findall(r"(?:card|cell):([A-Za-z0-9_-]+)", text))

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for key in ("cell", "card", "cell_id"):
                if isinstance(x.get(key), str):
                    out.add(x[key])
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(doc)
    return out


def subagent_started(c: str, run: subagents.Run, req: dict[str, Any]) -> None:
    """The orientation's agent started a run (subagents.ensure_chat for the first, run_again for a follow-up): the
    first takes up the record (`running`, its chat, agent id, route and session; the deck made when on), a follow-up
    runs it again as run k with the message it carries."""
    rec = orientation.read_run(c) or {}
    if run.k == 0:
        orientation.started(c, run.chat, session=run.sid, passes=list(rec.get("passes") or ["final", "views"]),
                            agent_id=run.agent_id, route="subagent")
        return
    text = ""
    for r in reversed(list((subagents.read(c).get("requests") or {}).values())):
        if isinstance(r, dict) and r.get("kind") == "message" and r.get("agent") == run.agent_id:
            text = str((r.get("input") or {}).get("message") or "")
            break
    by = MAIN if run.route == subagents.TYPED else BROWSER
    orientation.run_started(c, run.chat, run.k, [{"text": text, "by": by}] if text else [])


def subagent_refused(c: str, req: dict[str, Any]) -> None:
    """A start or follow-up of the orientation that did not happen: a start's record ends `refused` with the reason and
    its kind (the browser's card, with Start it); a follow-up's thread says it was not passed on."""
    if req.get("kind") == "start":
        rec = orientation.read_run(c) or {}
        if rec.get("request") in (None, req.get("id")) or rec.get("status") == "starting":
            orientation.refuse(c, str(req.get("reason") or ""), str(req.get("refused_kind") or subagents.ERROR),
                               request=req.get("id"))
        return
    if req.get("kind") == "message":
        a = subagents.agent(c, str(req.get("agent") or "")) or {}
        if a.get("chat"):
            not_passed_on(c, str(a["chat"]), str(req.get("reason") or ""),
                          str((req.get("input") or {}).get("message") or ""))


def subagent_ended(c: str, run: subagents.Run, status: str, summary: str) -> None:
    """A run of the orientation ended (subagents.run_ended): its record closes (the first run's reveals its outputs),
    and what follows goes on (_go_on): main hears it, the work folder lets go of what it no longer needs, and the
    report pass is asked for. A critic start it never made ends (critique_session.expire_pending). A run the analyst
    stopped stops the builds of the views it proposed (dev.stop_orientation_views) first. The first run's end goes on, when it finished, once its coverage line is
    measured (_measured). A critique an extension's program runs for it stops with it (critique_session.program_critique).
    """
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
            orientation.finished(c, run.chat, status, summary, report=False)
            made: dict[str, Any] = {}
        else:
            made = changed_cards(c, run.chat, run.k)
            orientation.run_finished(c, run.chat, run.k, status, {k: v for k, v in made.items() if k != "cards"})
            if made.get("cards"):
                rec = orientation.read_run(c) or {}
                orientation.record(c, revised_cards=sorted({*(rec.get("revised_cards") or []), *made["cards"]}))
    except Exception:  # noqa: BLE001
        log.exception("%s: the orientation's record was not closed", c)
        made = {}
    if status == "failed":
        _say_failed(c, run.chat, run.k, summary)
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


def _say_failed(c: str, chat: str, k: int, summary: str) -> None:
    """A failed run's last line in the orientation's thread, as a note: it stopped, and why (FAILED_LINES), such as the
    API error that ended it, which subagents.run_ended gives as its report."""
    line = FAILED_LINES[k > 0].format(error=failure_line(summary) or "no error text came with it")
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
    """What follows a run's end once its record is closed: main hears it, with the first run's coverage line, the work
    folder is cleared, and the report pass is asked for. A stop asks for no report."""
    _tell_main(c, status, run.k, made, error=summary if status == "failed" else "", coverage=coverage)
    work_files.after_run(c, work_dir(c), "stopped" if status != "failed" and stopped else status)
    if status == "done" and not run.interrupted:
        _report(c)


def _analyst_stopped(c: str, run: subagents.Run, status: str) -> bool:
    """Whether the analyst stopped the run (Stop, Esc), not main's quit or a failure."""
    return status == "stopped" and not run.interrupted


def _report(c: str) -> None:
    """The report pass once no run goes: the first report when the switch was on and it was never asked for, else a
    revision when a follow-up changed a card the report cites. The report's writer starts through the module as part of
    the orientation's own start (orientation.request_report). A writer still writing the report gets the revision when
    it ends (_writer_finished)."""
    from . import write_session  # noqa: PLC0415

    rec = orientation.read_run(c) or {}
    if "report" not in (rec.get("passes") or []) or running(c):
        return
    if not rec.get("report_asked"):
        if orientation.request_report(c):
            orientation.record(c, revised_cards=[])
        return
    changed = set(rec.get("revised_cards") or []) & report_cards(c)
    if not changed:
        return
    if write_session.running(c, orientation.REPORT_DOC):
        return  # _writer_finished asks when the writer ends
    request = tools.hint("orient-report-revision", cards=", ".join(f"card:{x}" for x in sorted(changed)))
    if orientation.request_report(c, request):
        orientation.record(c, revised_cards=[])


def _writer_finished(c: str, meta: dict[str, Any]) -> None:
    """An agent chat ended: when it was the report's writer and a follow-up revised cards the report cites meanwhile,
    the revision is asked for now."""
    from . import report_types  # noqa: PLC0415

    if str(meta.get("agent_type") or "").rsplit(":", 1)[-1] != report_types.WRITER_AGENT:
        return
    if meta.get("doc") not in (None, orientation.REPORT_DOC):
        return
    try:
        if (orientation.read_run(c) or {}).get("revised_cards"):
            _report(c)
    except Exception:  # noqa: BLE001 — the writer has ended either way
        log.exception("%s: the report's revision was not asked for", c)

agents.on_agent_finished(_writer_finished)

VIEW_LINES = {"built": "orient-views-built", "failed": "orient-views-failed", "building": "orient-views-building",
              "stopped": "orient-views-stopped", "suggested": "orient-views-suggested"}

def view_counts(c: str, since: datetime | None) -> dict[str, int]:
    """The views the orientation proposed since `since`, by where their builds stand (built, failed, building; queued or
    held count as building; stopped, those the analyst's Stop dropped), and the viewers for file types it suggested.
    Proposals main made at the analyst's request, and those dropped as they failed, are not counted."""
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
    """What the orientation of `run` made, for the `orient-made-*` lines of prompts/tools.md: the views it proposed by
    build state, the labels it defined (not trials), and the cards it made in its deck; an earlier orientation's cards
    in the same deck are not counted. A record may name the deck's pass `analyze` or keep the deck as its `final` group.
    """
    from . import concepts, notebook  # noqa: PLC0415 — the workspace's stores, only read at the end

    since = _at(run.get("started"))

    def new(items: "list[dict[str, Any]]", key: str) -> int:
        return sum(1 for x in items if since is None or ((t := _at(x.get(key))) is not None and t >= since))

    passes = run.get("passes") or []
    parts: list[str] = []
    if "views" in passes:
        parts.append(views_text(view_counts(c, since)))
    ws = config.workspace_dir(c)
    labels = new(concepts.list_concepts(ws, trials=False), "ts")
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
        if m.get("views"):
            states = m.get("view_states") if isinstance(m.get("view_states"), dict) else {}
            what.append(views_text({k: int(states.get(k) or 0) for k in VIEW_LINES}) if any(states.values())
                        else tools.hint("orient-changed-views", views=tools._count("view", int(m["views"]))))
        follow = {"stopped": "orient-follow-up-stopped", "failed": "orient-follow-up-failed"}.get(status, "orient-followed-up")
        return tools.hint(follow, changed=", ".join(what) or tools.hint("orient-changed-nothing"), error=why)
    first = {"stopped": "orient-stopped", "failed": "orient-failed"}.get(status, "orient-finished")
    text = tools.hint(first, made=made_text(c, run), error=why)
    return f"{text}\n{coverage.strip()}" if coverage.strip() else text


FAILURE_CHARS = 400  # of a failure's text in the one line that says why (failure_line)


def failure_line(summary: str | None) -> str:
    """A failure's text on one line, cut at FAILURE_CHARS."""
    line = " ".join(str(summary or "").split())
    return line if len(line) <= FAILURE_CHARS else line[: FAILURE_CHARS - 1].rstrip() + "…"


def _tell_main(c: str, status: str, k: int = 0, made: "dict[str, Any] | None" = None, error: str = "",
               coverage: str = "") -> None:
    """The `orient` browser event: a run of the orientation ended, with status_text as its text (prompts/main.md). It
    waits for main's next event, since it asks main for nothing."""
    subagents.tell_main(c, orientation.ORIENT_KIND, {"text": status_text(c, status, k, made, error, coverage),
                                                     "status": status, **({"run": k} if k else {})})


def _wrote_since(c: str, since: str) -> bool:
    """Whether main's chat holds a message of the analyst's, typed in the terminal or sent from the browser's chat, at
    or after the ISO time `since`."""
    try:
        floor = datetime.fromisoformat(since.replace("Z", "+00:00"))
        _, log_path = agents.paths(c, agents.MAIN_ID)
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

async def asked_for(c: str) -> bool:
    """Whether anyone asked for a new orientation: a Start waits for start_orientation, none has run here yet, or the
    analyst wrote to main since the latest one ended. Main's chat records a typed message within its follower's tail,
    so a message not there yet is waited for up to ASKED_WAIT_S."""
    run = orientation.read_run(c)
    if not run or run.get("status") in orientation.RUNNING or not run.get("ended"):
        return True
    end = asyncio.get_running_loop().time() + ASKED_WAIT_S
    while True:
        if await asyncio.to_thread(_wrote_since, c, str(run["ended"])):
            return True
        if asyncio.get_running_loop().time() >= end:
            return False
        await asyncio.sleep(0.25)


def _switch(args: dict[str, Any], keys: "tuple[str, ...]", default: bool) -> bool:
    for key in keys:
        if args.get(key) is not None:
            return orientation.flag(args[key], default)
    return default


def choices_of(args: dict[str, Any]) -> tuple[str, list[str], bool, dict[str, Any]]:
    """(the request, the outputs, the critique, the run's model and effort) of start_orientation's arguments or Start's
    body: `focus` (or `brief`, `text`); the deck (`deck`, `final_notebook`, `analyze_data`) and the views on unless
    turned off; the report (`report`, `generate_report`) and the critique off unless turned on; `model` and `effort`
    left to Settings when not given (subagents.values_for)."""
    brief = str(args.get("focus") or args.get("brief") or args.get("text") or "")
    deck = _switch(args, ("deck", "final_notebook", "analyze_data"), True)
    views = _switch(args, ("views", "propose_views"), True)
    report = _switch(args, ("report", "generate_report"), False)
    critique = _switch(args, ("critique",), orientation.DEFAULT_CRITIQUE)
    passes = [p for p, on in (("final", deck), ("views", views), ("report", report)) if on]
    values = {k: str(args[k]) for k in ("model", "effort") if args.get(k)}
    return brief, passes, critique, values


async def tool_start_orientation(ctx: Any, args: dict[str, Any]) -> Any:
    """The `start_orientation` tool: the pending start of the orientation with the request, the four switches and the
    run's model and effort (choices_of), and the exact Agent call main makes (`## start_orientation-subagent`).
    Refused while one runs, when nobody asked for a new one since the latest ended (asked_for), without the module, in
    plan mode, and in a session the launcher did not start."""
    brief, passes, critique, values = choices_of(args)
    if running(ctx.c) or starting(ctx.c):
        return tools.err(tools.hint("start_orientation-running"))
    if not await asked_for(ctx.c):
        return tools.err(tools.hint("start_orientation-unasked"))
    try:
        ans = await start(ctx.c, brief, passes, critique=critique, values=values, route=subagents.TYPED,
                          call=ctx.tool_use_id)
    except (RuntimeError, ValueError) as e:
        return tools.err(f"start_orientation: {e}")
    if ans.get("program"):
        return tools.ok(tools.hint("start_orientation-program", extension=ans["program"]))
    if ans.refused:
        return tools.err(ans.reason or f"start_orientation: {ans.kind}")
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
    except NoOrientation:
        return tools.err(tools.hint("message_orientation-none"))
    except (EarlierSession, EarlierVersion, RuntimeError) as e:
        return tools.err(str(e))
    await _after_measure(ctx.c)
    body, told = with_lead(ctx.c, text)
    ans = subagents.message_request(ctx.c, agent_id, body, call=ctx.tool_use_id)
    if told:
        orientation.record(ctx.c, coverage_told=True)
    return tools.ok(tools.hint("orient-subagent-message", agent=agent_id, text=body,
                               input=json.dumps(ans["input"], ensure_ascii=False)))


class StartBody(BaseModel):
    """Start's body (POST /ws/{c}/start): the focus, the four switches, and the run's model and effort; `ultracode`,
    `fast` and `mode` from an older page are ignored."""

    text: str = ""
    deck: bool | None = None
    views: bool | None = None
    critique: bool | None = None
    report: bool | None = None
    model: str | None = None
    effort: str | None = None
    final_notebook: bool | None = None
    propose_views: bool | None = None
    generate_report: bool | None = None


@router.post("/ws/{c}/start")
async def start_route(c: str, body: StartBody, request: Request) -> dict[str, Any]:
    """Start in the browser: a click, so the analyst's cookie (403 without it), and the orientation starts through the
    module (start). The answer: {agentId} or the refusal's {kind, reason}, which the record also holds."""
    subagents.analyst_only(request)
    config.workspace_dir(c)
    brief, passes, critique, values = choices_of(body.model_dump())
    ans = await start(c, brief, passes, critique=critique, values=values, route=subagents.CLICK)
    return {**dict(ans), **({"kind": ans.kind, "reason": ans.reason} if ans.refused else {})}


RUN_FIELDS = ("status", "query", "passes", "critique", "model", "effort", "route", "started_by", "agent_id", "request",
              "refused", "requested", "started", "ended", "chats")  # what run_route shows of orient/run.json


@router.get("/ws/{c}/orientation")
async def run_route(c: str) -> dict[str, Any]:
    """The latest orientation's record as the browser's Start gate and its card read it: its status, the request and
    switches, the run's exact model and effort, who started it, the pending request, and for a start that did not
    happen {reason, kind, at, expired?}; {} before any was asked for."""
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
    the earlier-version text."""
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
