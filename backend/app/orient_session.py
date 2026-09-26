"""The orientation's own Claude Code session, beside main, started with the `start_orientation` tool. The machinery it
shares with a writer's session is agent_session.py; this module holds what is the orientation's own. It is a separate
session rather than an agent-team teammate because a teammate has no Workflow tool, its permission prompts are not
relayed to the channel, the plugin agent's definition is not applied, and it runs at main's effort.

Start. `start_orientation` takes a brief and three independent output switches: `final_notebook` (the deck, group
`Orientation`), `propose_views` and `generate_report`. The orientation's thread is what it always leaves.

The prompt. prompts/orient.md defines the agent the session runs as (`--agents` for that session alone and `--agent
thimble-orient`, so main never sees it). Its body is a template system_prompt renders in three parts: a prefix (the
opening, shared.md and `## The orientation` with the analyst's request in `{{request}}`), the instructions in
`{{instructions}}`, and a suffix holding everything the switches turn on or off (PARTS, LINES). The request and
instructions are filled after parts are left out, so a heading in either cannot cut a part. The instructions default to
prompts/orient-instructions.md and are replaced whole by the workspace's `orient_instructions` setting when set.

Tools. orient.md names no tools, so the session has every tool the analyst's Claude Code has; --disallowedTools removes
the thimble tools that are not the orientation's (ORIENT_TOOLS) and those of each part switched off (PART_TOOLS).

The fence. The session writes only into `workspaces/<c>/orient/work/`; where Claude Code's Bash sandbox runs, Bash runs
there with no network and no write into the corpus. When a run ends (unless it failed) its `tmp_*` files are deleted.

Permissions. Start's switcher offers Manual, Auto or Bypass for the orientation alone; a tool-started orientation takes
the stored `orient_permissions`, else the mode the analyst's own mode stands for. Manual and Bypass pass `--permission-
mode default` (requests wait on the card, or are granted at once); Auto passes `auto`, and a refused call waits on the
card. Effort, Ultracode and the critique come from Start's choices, kept on the run's record for follow-ups; the model
settings come from the `orient` and `subagents` roles (config.models_for).

Calls. Each call the session, its agents, its critique and its follow-ups make is numbered in its chat's sequence and
citable as `call:<chat>/<n>` (calls.py).

End of the first run. orientation.finished closes the record, reveals the deck and releases held view proposals; the
report is asked for once no follow-up waits. Main hears an `orient` event with one line counting what was made.

Restarts. A run a server stop cut short is resumed by the next server with `--resume` in the same chat. A failed first
run is resumed as run 0 when start_orientation asks for the same orientation again, rather than redoing its work.

Terminal-first mode (orientation module note): start_orientation writes the subagent's prompt and asks main to start
it (subagent_start), and a message to it goes through main, which alone can message its subagent (Subagent).

Follow-ups. Messages from main's `message_orientation` tool or the thread's composer go through message(): a finished
orientation's session is resumed with the message in `## orient-follow-up`; a message sent while a run goes waits in the
record's `queue`. A follow-up's cards land in place as one undo batch; when it changes a card the report cites, the
report pass runs again as a revision. When Claude Code has deleted the session's transcript, message() raises Gone.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import agent_session, agents, bg_session, cc_settings, config, ledger, orientation, prompts, tools

log = logging.getLogger("thimble.orient_session")
router = APIRouter()

PROMPT = "orient"  # prompts/orient.md, the agent the session runs as (its frontmatter names it orientation.AGENT)
KEY = tools.ORIENT_SESSION  # its THIMBLE_SESSION, and the key agent_session holds it by
PASSES = ("final", "views", "report")  # orientation.passes: the outputs start_orientation's three switches turn on
# The `#### ` parts of orient.md's `### Outputs` a switch includes or leaves out, by the output it turns on.
PARTS = {"final": "The deck", "views": "Views", "report": "The report"}
# The parts that are lines of orient.md, by what turns them on, and the text that finds each line.
LINES = {"critique": "`critique`"}
# The lines of orient.md about the outputs as a whole, kept only while at least one output is on.
OUTPUT_LINES = ("Draft the outputs described below", "Then revise the outputs described above")
# The thimble tools the orientation gets; every other registry tool is taken away.
ORIENT_TOOLS = ("read_ref", "list_cards", "add_card", "edit_card", "delete_card", "apply_label", "propose_view",
                "screenshot", "critique")
# The thimble tools that belong to a part, by the part: each leaves the session with its part (disallowed).
PART_TOOLS = {"final": ("add_card", "edit_card", "delete_card", "apply_label"), "views": ("propose_view",),
              "critique": ("critique",)}
WORK_DIR = "work"  # orient/work: the one folder outside the corpus the session writes into
TEMP_GLOB = "tmp_*"  # what in the work folder is deleted when a run ends (_clear_temp)
INSTRUCTIONS = "orient-instructions"  # prompts/orient-instructions.md, thimble's default instructions
SETTING = "orient_instructions"  # settings.json: the analyst's own instructions, which replace the defaults (instructions_of)
PERMISSIONS_SETTING = ledger.ORIENT_PERMISSIONS_KEY  # settings.json: the stored mode for the orientation
# What stands in each slot the analyst's text fills until the parts are left out (system_prompt).
_MARKS = {"request": "\x00request\x00", "instructions": "\x00instructions\x00"}
BROWSER = "browser"  # `by` of a message typed in the orientation's thread
MAIN = "main"  # `by` of a message main's message_orientation sent


class NoOrientation(RuntimeError):
    """No orientation has run in the workspace, or one is starting and has no session yet."""


class Gone(RuntimeError):
    """Claude Code no longer keeps the orientation's transcript, so its session cannot be resumed."""


class Subagent(RuntimeError):
    """The orientation runs as a subagent of main (terminal-first mode), which only main can message; the agent id,
    with its chat."""

    def __init__(self, agent_id: str, chat: str) -> None:
        super().__init__(agent_id)
        self.chat = chat


def current(c: str) -> agent_session.Run | None:
    return agent_session.current(c, KEY)


def running(c: str) -> bool:
    return agent_session.running(c, KEY)


async def stop(c: str) -> bool:
    return await agent_session.stop(c, KEY)


def work_dir(c: str) -> Path:
    """The session's work folder, where it may write."""
    return orientation.orient_dir(c) / WORK_DIR


def effort_of(choices: dict[str, Any]) -> str:
    """The session's effort: Ultracode's level when it is on, else Start's."""
    if choices.get("ultracode"):
        return cc_settings.ULTRACODE_EFFORT
    return str(choices.get("effort") or orientation.DEFAULT_EFFORT)


def parts_of(choices: dict[str, Any], passes: "list[str] | tuple[str, ...]") -> list[str]:
    """The parts of the prompt the session gets (the keys of PARTS and LINES): the outputs start_orientation's switches
    turned on, and the critique when Start left it on."""
    on = [p for p in PASSES if p in passes]
    if choices.get("critique", True):
        on.append("critique")
    return [p for p in (*PARTS, *LINES) if p in on]


def instructions_of(c: str, own: "str | None" = None) -> str:
    """The instructions part of workspace `c`'s prompt: `own` when given, else the workspace's SETTING; either one, when
    it holds text, replaces thimble's defaults (INSTRUCTIONS) rather than adding to them."""
    if own is None:
        stored = ledger.stored_settings(c).get(SETTING)
        own = stored if isinstance(stored, str) else ""
    return own.strip() or prompts.render(INSTRUCTIONS, {}).strip()


def system_prompt(c: str, brief: str, parts: "list[str] | tuple[str, ...]", instructions: "str | None" = None) -> str:
    """orient.md's body rendered for workspace `c`: the prefix with shared.md (with the workspace's view citation forms)
    and the request, the instructions, and the suffix with each part not in `parts` left out (and OUTPUT_LINES when no
    output is on)."""
    from . import views  # noqa: PLC0415 — views imports refs, which the rest of this module does not need

    values = {"workdir": str(config.corpus_dir(c)), "workfolder": str(work_dir(c)), "forms": views.forms_text(c), **_MARKS}
    lines = [s for p, s in LINES.items() if p not in parts] + ([] if any(p in parts for p in PARTS) else list(OUTPUT_LINES))
    text = prompts.without(prompts.agent_prompt(PROMPT, values), [h for p, h in PARTS.items() if p not in parts], lines)
    # The request and the instructions go in after the parts are left out, so a heading in either cannot cut the
    # analyst's own text or a part of the suffix.
    fills = {"request": brief.strip() or tools.hint("orient-no-request"), "instructions": instructions_of(c, instructions)}
    for slot, mark in _MARKS.items():
        text = text.replace(mark, fills[slot], 1)
    return re.sub(r"\n{3,}", "\n\n", text)  # an empty {{forms}} leaves a blank line of its own


def agent_definition(c: str, brief: str, parts: "list[str] | tuple[str, ...]") -> tuple[str, dict[str, Any]]:
    """(name, definition) of the orientation's agent for `--agents`: orient.md's frontmatter as the writer's is read
    (cli.agent_definition), with the rendered prompt as its prompt. It names no tools, so the session has every tool;
    the ones it does not get are the session's --disallowedTools (disallowed)."""
    from . import cli  # noqa: PLC0415 — cli is large, and the definition's shape is the launcher's

    name, agent = cli.agent_definition(PROMPT)
    return name, {**agent, "prompt": system_prompt(c, brief, parts)}


def disallowed(parts: "list[str] | tuple[str, ...]") -> list[str]:
    """The session's --disallowedTools: the thimble tools that are not the orientation's, and those of each part that is
    off."""
    off = {t for part, names in PART_TOOLS.items() if part not in parts for t in names}
    return agent_session.not_own([n for n in ORIENT_TOOLS if n not in off])


def mode_of(c: str, choice: str | None) -> str:
    """The mode the session runs in: Start's choice, else the workspace's stored one, else the analyst's own mode's."""
    chosen = orientation.permissions(choice) or orientation.permissions(ledger.stored_settings(c).get(PERMISSIONS_SETTING))
    return cc_settings.orient_mode(config.corpus_dir(c), chosen)


def _mode_changed(run: agent_session.Run) -> None:
    """The analyst switched the session's mode on its card (agent_session.set_mode): the record keeps it for a
    follow-up."""
    orientation.record(run.c, permissions=run.mode)


def subagent_start(c: str, brief: str, passes: "list[str]") -> str:
    """start_orientation in terminal-first mode (orientation module note): the prompt, without the critique's part
    since main's shim does not list `critique`, is written to its file, the run is recorded as requested for the
    subagent, and the answer asks main to start it with the Agent tool."""
    parts = parts_of({**orientation.choices(c), "critique": False}, passes)
    work_dir(c).mkdir(parents=True, exist_ok=True)
    path = orientation.subagent_prompt_file(c)
    ledger.atomic_write_text(path, system_prompt(c, brief, parts) + "\n\n" + tools.hint("orient-subagent-notes") + "\n")
    fields = {"route": orientation.SUBAGENT_ROUTE, "critique": False}
    run = orientation.read_run(c)
    if run and run.get("status") == "requested":
        orientation.record(c, passes=list(passes), **fields)
    else:
        orientation.request(c, brief, passes, **fields)
    return tools.hint("start_orientation-subagent", agent=f"{orientation.PLUGIN}:{orientation.SUBAGENT}", prompt=str(path))


def _launch(c: str, brief: str, passes: "list[str]", choices: dict[str, Any]) -> dict[str, Any]:
    """The arguments of agent_session.start that a start and a resume share, so a follow-up runs with its first run's
    flags."""
    models = config.models_for(c)
    own, subagents = models["orient"], models["subagents"]
    effort = effort_of(choices)
    ultracode = bool(choices.get("ultracode"))
    parts = parts_of(choices, passes)
    mode = mode_of(c, choices.get("permissions"))
    name, agent = agent_definition(c, brief, parts)
    env = {config.SUBAGENT_MODEL_ENV: subagents["model"]} if subagents["model"] else None
    return dict(role=orientation.ROLE, title=orientation.TITLE,
                agent_args=["--agents", json.dumps({name: agent}, ensure_ascii=False), "--agent", name], effort=effort,
                settings=agent_session.settings_json(effort, env, ultracode=ultracode, fastMode=bool(own["fast"])),
                agent_type=name, append_shared=False, model=own["model"], work=work_dir(c), calls=True,
                permission_mode=cc_settings.orient_permission_flag(mode), mode=mode, patient=True, on_mode=_mode_changed,
                disallowed=disallowed(parts), background=bg_session.wanted(c, "orient"))


async def start(c: str, brief: str, passes: "list[str] | tuple[str, ...]" = ("final", "views"),
                call: str | None = None, chosen: "dict[str, Any] | None" = None) -> agent_session.Run:
    """Start the orientation session for workspace `c` with the parts `passes` names (PASSES) and follow it, `call`
    being main's start_orientation call (agent_session.start); `chosen` holds the critique and permission choices the
    call made, over Start's. RuntimeError when one runs or claude cannot be started."""
    if running(c):
        raise RuntimeError("an orientation is running")
    choices = orientation.choices(c)
    own = config.models_for(c)["orient"]
    if (orientation.read_run(c) or {}).get("status") != "requested":
        # no Start gate chose: the settings popover's effort for the orientation
        on = own["effort"] == cc_settings.ULTRACODE
        choices = {**choices, "ultracode": on, "effort": choices.get("effort") if on else own["effort"]}
    choices = {**choices, **(chosen or {})}
    passes = [p for p in PASSES if p in passes]
    failed = _failed_first_run(c, brief, passes)
    if failed is not None:
        return await _restart(c, *failed, call=call)
    args = _launch(c, brief, passes, choices)

    def started(run: agent_session.Run) -> None:
        orientation.started(c, run.chat, session=run.sid, pid=run.pid, passes=passes)
        orientation.record(c, effort=choices.get("effort"), ultracode=bool(choices.get("ultracode")),
                           critique=bool(choices.get("critique", True)), permissions=run.mode)

    return await agent_session.start(
        c, KEY, prompt=tools.hint("orient-start"), on_start=started, on_end=_ended, on_pid=_moved,
        ultracode=bool(choices.get("ultracode")), critique=bool(choices.get("critique", True)), brief=brief.strip(),
        call=call, **args)


def _failed_first_run(c: str, brief: str, passes: "list[str]") -> tuple[dict[str, Any], str, str] | None:
    """(the record, its chat, its session id) when the first run failed and a start with `brief` and `passes` asks for
    the same orientation (empty or same brief, same outputs), so it resumes; else None."""
    from . import session  # noqa: PLC0415

    try:
        rec, chat, sid = _chat_of(c)
    except NoOrientation:
        return None
    meta = agents.meta_or_none(c, chat) or {}
    if rec.get("status") != "failed" or int(rec.get("run") or 0) != 0:
        return None
    if brief.strip() not in ("", str(meta.get("brief") or "").strip()):
        return None
    if sorted(passes) != sorted(p for p in PASSES if p in (rec.get("passes") or [])):
        return None
    return (rec, chat, sid) if session.find_transcript(sid) else None


async def _restart(c: str, rec: dict[str, Any], chat: str, sid: str, call: str | None = None) -> agent_session.Run:
    """Resume the orientation whose first run failed, as run 0 again in its chat, with its first run's choices and `##
    session-resumed` on stdin."""
    meta = agents.meta_or_none(c, chat) or {}
    choices = {"effort": rec.get("effort") or meta.get("effort") or orientation.DEFAULT_EFFORT,
               "ultracode": rec.get("ultracode"), "critique": rec.get("critique", True),
               "permissions": rec.get("permissions")}
    passes = [p for p in PASSES if p in (rec.get("passes") or [])]
    args = _launch(c, str(meta.get("brief") or ""), passes, choices)
    log.info("%s: the orientation's first run failed (%s); resuming its session %s", c,
             agent_session.failure_line(rec.get("error"))[:200], sid)

    def started(run: agent_session.Run) -> None:
        orientation.restarted(c, chat, pid=run.pid)

    return await agent_session.start(c, KEY, prompt=tools.hint(agent_session.RESUMED_PROMPT, stopped=""),
                                     on_start=started, on_end=_ended, on_pid=_moved, resume=sid, chat=chat, run_k=0,
                                     call=call, **args)


def _moved(run: agent_session.Run) -> None:
    """A retry changed the session's process: the record names the new pid, or none while the retry waits, so
    orientation.running does not take the run for ended."""
    orientation.record(run.c, pid=run.pid)


# --------------------------------------------------------------------------- follow-ups


def undo_batch(c: str) -> tuple[str, str] | None:
    """(id, label) of the undo batch a call of the orientation's session or subagent belongs to: its follow-up's,
    `<chat>/<run>`, while one runs; None during the first run, whose cards appear whole when it ends and are each a
    step."""
    run = current(c)
    if run is not None:
        return (f"{run.chat}/{run.k}", orientation.FOLLOWUP_LABEL) if run.k > 0 else None
    sub = orientation.subagent_run(c) or {}  # terminal-first mode: the follow-up the mirror recorded (session._revive)
    k, chat = int(sub.get("run") or 0), (sub.get("chats") or {}).get(orientation.ROLE)
    if k <= 0 or not chat or sub.get("status") != "running":
        return None
    return f"{chat}/{k}", orientation.FOLLOWUP_LABEL


def _lead(messages: "list[dict[str, Any]]") -> str:
    """The follow-up's stdin prompt, `## orient-follow-up` with each message after the line that says who sent it."""
    parts = []
    for m in messages:
        who = tools.hint("orient-from-main" if m.get("by") == MAIN else "orient-from-analyst")
        parts.append(f"{who}\n\n{str(m.get('text') or '').strip()}")
    return tools.hint("orient-follow-up", messages="\n\n".join(parts))


def _chat_of(c: str) -> tuple[dict[str, Any], str, str]:
    """(the record, its chat, its session id) of the workspace's latest orientation; NoOrientation when there is none,
    or while one is asked for and has no session yet."""
    rec = orientation.read_run(c)
    chat = str(((rec or {}).get("chats") or {}).get(orientation.ROLE) or "")
    sid = str((rec or {}).get("session") or "")
    if not rec or not chat or not sid or agents.meta_or_none(c, chat) is None:
        raise NoOrientation("no orientation has run in this workspace")
    return rec, chat, sid


async def message(c: str, text: str, by: str = MAIN, call: str | None = None) -> dict[str, Any]:
    """The one server function a follow-up goes through: `text` from `by` (MAIN or BROWSER) resumes the finished
    orientation, {status: resumed, chat, run}, or waits for the run going, {status: queued, chat, queued}. `call` is
    main's message_orientation call. ValueError for an empty message, NoOrientation, Gone."""
    text = str(text or "").strip()
    if not text:
        raise ValueError("the message is empty")
    sub = orientation.subagent_run(c)
    if sub is not None:
        raise Subagent(str(sub.get("agent_id") or ""), str((sub.get("chats") or {}).get(orientation.ROLE) or ""))
    rec, chat, sid = _chat_of(c)
    entry = {"text": text, "by": by if by in (MAIN, BROWSER) else MAIN, "ts": _now()}
    if running(c) or orientation.running(c):
        queue = [*(rec.get("queue") or []), entry]
        orientation.record(c, queue=queue)
        _show_queue(c, chat, queue)
        return {"status": "queued", "chat": chat, "queued": len(queue)}
    run = await resume(c, [entry], call=call)
    return {"status": "resumed", "chat": chat, "run": run.k}


def _show_queue(c: str, chat: str, queue: "list[dict[str, Any]]") -> None:
    try:
        agents.update_agent(c, chat, queued=list(queue))
    except HTTPException:
        pass


async def resume(c: str, messages: "list[dict[str, Any]]", call: str | None = None,
                 announce: bool = True) -> agent_session.Run:
    """Resume the orientation's session with `messages` as run k+1; Gone when Claude Code no longer keeps its
    transcript, NoOrientation when there is none, RuntimeError when it cannot start. A background session that started
    a turn on its own takes no messages: the run follows it (_woken)."""
    from . import session  # noqa: PLC0415

    rec, chat, sid = _chat_of(c)
    if running(c):
        raise RuntimeError("an orientation is running")
    if not session.find_transcript(sid):
        raise Gone(f"Claude Code no longer keeps the transcript of session {sid}")
    k = int(rec.get("run") or 0) + 1
    meta = agents.meta_or_none(c, chat) or {}
    choices = {"effort": rec.get("effort"), "ultracode": rec.get("ultracode"), "critique": rec.get("critique", True),
               "permissions": rec.get("permissions")}
    if choices["effort"] is None:  # a record without stored choices: the ones its chat names
        choices["effort"] = meta.get("effort") or orientation.DEFAULT_EFFORT
    passes = [p for p in PASSES if p in (rec.get("passes") or [])]
    args = _launch(c, str(meta.get("brief") or ""), passes, choices)
    lead = _lead(messages) if messages else ""

    def started(run: agent_session.Run) -> None:
        orientation.run_started(c, chat, k, messages, pid=run.pid)

    return await agent_session.start(c, KEY, prompt=lead, on_start=started, on_end=_ended, on_pid=_moved, resume=sid,
                                     chat=chat, run_k=k, leads=[{"text": m.get("text"), "by": m.get("by")} for m in messages],
                                     call=call, announce=announce, **args)


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


def _ended(run: agent_session.Run, status: str, summary: str) -> None:
    """A run of the session ended: its record closes (the first run's reveals its outputs), main hears it, then waiting
    messages start the next run, or the report pass is asked for."""
    c = run.c
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
    _tell_main(c, status, run.k, made, error=summary if status == "failed" else "")
    if status != "failed":  # a failed run is resumed with its work folder as it left it
        _clear_temp(c)
    rec = orientation.read_run(c) or {}
    queue = [m for m in rec.get("queue") or [] if isinstance(m, dict)]
    if queue:
        orientation.record(c, queue=[])
        _show_queue(c, run.chat, [])
    if status == "stopped" or run.interrupted:
        return  # the analyst's Stop clears what waited, and asks for no report; so does the server's own stop
    if queue:
        asyncio.get_running_loop().create_task(_resume_queued(c, queue), name=f"orient-follow-up:{c}")
        return
    if status == "done":
        _report(c)


def _clear_temp(c: str) -> None:
    """Delete the `tmp_*` files and folders in the session's work folder once a run ends, so large intermediates are not
    kept in an archive. The rest stays, since a card's code may read a cleaned copy the session made there."""
    for path in work_dir(c).glob(TEMP_GLOB):
        try:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
        except OSError as e:
            log.info("%s: the orientation's temporary %s was not deleted (%s)", c, path.name, e)


async def _resume_queued(c: str, queue: "list[dict[str, Any]]") -> None:
    try:
        await resume(c, queue)
    except (Gone, NoOrientation, RuntimeError) as e:
        log.warning("%s: the waiting follow-up of the orientation did not start (%s)", c, e)
        _report(c)


def _report(c: str) -> None:
    """The report pass once no run goes and nothing waits: the first report when the switch was on and it was never
    asked for, else a revision when a follow-up changed a card the report cites. A writer still writing the report gets
    the revision when it ends (_writer_finished)."""
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


VIEW_LINES = {"built": "orient-views-built", "failed": "orient-views-failed", "building": "orient-views-building"}


def view_counts(c: str, since: datetime | None) -> dict[str, int]:
    """The views the orientation proposed since `since`, by where their builds stand (built, failed, building; queued or
    held count as building). Proposals main made at the analyst's request, and dropped ones, are not counted."""
    from . import views  # noqa: PLC0415

    counts = dict.fromkeys(VIEW_LINES, 0)
    for p in views.list_proposals(c):
        if p.get("asked") or p.get("status") == "dropped" or (since is not None and ((t := _at(p.get("ts"))) is None or t < since)):
            continue
        counts[p["status"] if p.get("status") in ("built", "failed") else "building"] += 1
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


def status_text(c: str, status: str, k: int = 0, made: "dict[str, Any] | None" = None, error: str = "") -> str:
    """The `orient` event's text: the first run ended (finished, stopped or failed) and what it made, or follow-up `k`
    ended and what it changed; a failed run's line ends with `error`, the failure's own text on one line
    (agent_session.failure_line), so main can say why."""
    why = agent_session.failure_line(error)
    run = orientation.read_run(c) or {}
    if k > 0:
        m = made or {}
        what = [tools.hint(line, cards=tools._count("card", int(m[key])))
                for key, line in (("added", "orient-changed-added"), ("revised", "orient-changed-revised"),
                                  ("deleted", "orient-changed-deleted")) if m.get(key)]
        if m.get("views"):
            states = m.get("view_states") if isinstance(m.get("view_states"), dict) else {}
            what.append(views_text({k: int(states.get(k) or 0) for k in VIEW_LINES}) if any(states.values())
                        else tools.hint("orient-changed-views", views=tools._count("view", int(m["views"]))))
        line = {"stopped": "orient-follow-up-stopped", "failed": "orient-follow-up-failed"}.get(status, "orient-followed-up")
        return tools.hint(line, changed=", ".join(what) or tools.hint("orient-changed-nothing"), error=why)
    line = {"stopped": "orient-stopped", "failed": "orient-failed"}.get(status, "orient-finished")
    return tools.hint(line, made=made_text(c, run), error=why)


def _tell_main(c: str, status: str, k: int = 0, made: "dict[str, Any] | None" = None, error: str = "") -> None:
    """The `orient` channel event: a run of the orientation ended, with status_text as its text (prompts/main.md); it
    waits for main when no session listens (agent_session.tell_main)."""
    agent_session.tell_main(c, orientation.ORIENT_KIND, {"text": status_text(c, status, k, made, error),
                                                         "status": status, **({"run": k} if k else {})})


def _left(c: str, meta: dict[str, Any], status: str, summary: str) -> None:
    """A run a previous server left running was closed: its record closes and main hears it, as when its session ends.
    """
    run = agent_session.Run(c, KEY, str(meta["id"]), str(meta.get("session") or ""), config.corpus_dir(c),
                            orientation.ROLE, k=int(meta.get("run") or 0))
    _ended(run, status, summary)


agent_session.on_left(orientation.ROLE, _left)


async def _resume_left(c: str, meta: dict[str, Any], prompt: str) -> agent_session.Run:
    """Resume the run a previous server left running: its session with `--resume` in its chat as the same run, `prompt`
    on stdin, and the flags and choices its record keeps. NotResumed when the record names another orientation or no
    longer runs."""
    rec = orientation.read_run(c) or {}
    chat = str(meta["id"])
    k = int(meta.get("run") or 0)
    if (rec.get("chats") or {}).get(orientation.ROLE) != chat or rec.get("status") != "running":
        raise agent_session.NotResumed("another orientation has started since")
    choices = {"effort": rec.get("effort") or meta.get("effort") or orientation.DEFAULT_EFFORT,
               "ultracode": rec.get("ultracode"), "critique": rec.get("critique", True),
               "permissions": rec.get("permissions")}
    passes = [p for p in PASSES if p in (rec.get("passes") or [])]
    args = _launch(c, str(meta.get("brief") or ""), passes, choices)
    return await agent_session.start(c, KEY, prompt=prompt, on_start=_moved, on_end=_ended, on_pid=_moved,
                                     resume=str(meta.get("session") or ""), chat=chat, run_k=k, restarted=True, **args)


agent_session.on_resume(orientation.ROLE, _resume_left)


async def _woken(c: str, e: bg_session.Entry) -> agent_session.Run | None:
    """The orientation's background session started a turn with no run of this server's (bg_session.on_wake): the run a
    restart cut off is followed again as it was, and any other turn is a follow-up, run k+1."""
    meta = agents.meta_or_none(c, e.chat)
    if meta is None:
        return None
    if meta.get("status") == "running":
        return await _resume_left(c, meta, "")
    return await resume(c, [], announce=False)


bg_session.on_wake(tools.ORIENT_SESSION, _woken)


# --------------------------------------------------------------------------- tools and routes


async def tool_start_orientation(ctx: Any, args: dict[str, Any]) -> Any:
    """The `start_orientation` tool: start the orientation's session with the brief and the outputs its three switches
    turn on (`final_notebook` and `propose_views` by default, `generate_report` only when asked); a switch left out
    takes a waiting Start's choice. `analyze_data` is accepted for the deck's switch."""
    brief = str(args.get("brief") or "")
    # A switch the call leaves out takes the Start's choice while a Start waits for this call, so a call that omits
    # one keeps what the analyst clicked; with no Start waiting it takes the default.
    run = orientation.read_run(ctx.c)
    asked = (run.get("passes") or []) if run and run.get("status") == "requested" else None

    def switch(key: str, part: str, default: bool) -> bool:
        if args.get(key) is not None:
            return orientation.flag(args[key], default)
        return part in asked if asked is not None else default

    final = switch("final_notebook" if args.get("final_notebook") is not None else "analyze_data", "final", True)
    views = switch("propose_views", "views", True)
    report = switch("generate_report", "report", False)
    # Start's other choices, from the call (/thimble:orient's flags); left out, Start's or the defaults hold
    chosen: dict[str, Any] = {}
    if args.get("critique") is not None:
        chosen["critique"] = orientation.flag(args["critique"], True)
    if orientation.permissions(args.get("permissions")):
        chosen["permissions"] = orientation.permissions(args.get("permissions"))
    if running(ctx.c) or orientation.active(ctx.c):
        return tools.err(tools.hint("start_orientation-running"))
    passes = [p for p, on in (("final", final), ("views", views), ("report", report)) if on]
    if orientation.terminal_first(ctx.c) and not bg_session.wanted(ctx.c, tools.ORIENT_SESSION):
        return tools.ok(subagent_start(ctx.c, brief, passes))
    try:
        await start(ctx.c, brief, passes, call=ctx.tool_use_id, chosen=chosen)
    except RuntimeError as e:
        return tools.err(f"start_orientation: {e}")
    return tools.ok(tools.hint("start_orientation-started"))


async def tool_message_orientation(ctx: Any, args: dict[str, Any]) -> Any:
    """The `message_orientation` tool, main's: message() with the analyst's request, from main."""
    try:
        res = await message(ctx.c, str(args.get("message") or ""), MAIN, call=ctx.tool_use_id)
    except ValueError:
        return tools.err(tools.hint("message_orientation-empty"))
    except NoOrientation:
        return tools.err(tools.hint("message_orientation-none"))
    except Gone:
        return tools.err(tools.hint("message_orientation-gone"))
    except Subagent as e:
        return tools.ok(tools.hint("message_orientation-subagent", agent_id=str(e)))
    except RuntimeError as e:
        return tools.err(f"message_orientation: {e}")
    if res["status"] == "queued":
        return tools.ok(tools.hint("message_orientation-queued"))
    return tools.ok(tools.hint("message_orientation-started"))


class MessageBody(BaseModel):
    text: str


@router.post("/ws/{c}/orientation/message")
async def message_route(c: str, body: MessageBody) -> dict[str, Any]:
    """The orientation thread's composer: message() from the analyst. 400 for an empty message, 404 when no orientation
    has run, 410 when its session is gone, 409 when it cannot start."""
    config.workspace_dir(c)
    try:
        return await message(c, body.text, BROWSER)
    except Subagent as e:
        # terminal-first mode: only main can message its subagent, so main is asked to pass the message on
        from . import channel, session  # noqa: PLC0415

        posted = channel.post(c, channel.MAIN, {"text": tools.hint("orient-relay", text=body.text.strip())}, mirror=False)
        if e.chat:
            session.relay(c, e.chat, body.text.strip(), BROWSER)
        return {"status": "relayed", "event": posted["id"]}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except NoOrientation as e:
        raise HTTPException(404, str(e)) from e
    except Gone as e:
        raise HTTPException(410, f"{e}; start a new orientation to explore further") from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
