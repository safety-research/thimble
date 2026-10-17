"""The view proposer: after the analyst's turn of main, after a side thread answers them and when an orientation ends,
one model call over a fork of main's own conversation decides whether thimble shows the analyst a view proposal card,
and writes it (views.offer).

When it runs (trigger): at the end of a turn of main that answered the analyst (session.turn_analyst: a line they typed,
their message from the browser), at the cut of that turn's turn_duration record (turn_ended); when a side thread's fork
answered (session._finish_sub), not at the end of main's turn that handed the thread's question, from the browser or
from /thimble:ask in the terminal, to that fork; and once when the first run of an orientation ends done
(orient_session). Each trigger merges into the workspace's pending job (JOB_FILE's `job`: the reasons, main's session
and its cut), so a later pass of the mirror on the local transport, or a restarted server, runs it. One loop per workspace
(_loop) waits DEBOUNCE_MAIN_S after a main turn, else DEBOUNCE_OTHER_S (longer than auto mode's hand-back wait, so an
orientation's end merges with main's `↳` turn), and runs the job once main is idle; a main turn still open leaves it
pending until that turn ends. A running fork is never cancelled; a trigger that comes meanwhile is the next job.

The gate (due): view proposals are on (the View proposals feature switch, features.auto `proposer`, which reads
views.propose_enabled: PROPOSE_ENV, then Settings' View proposals switch),
main is attached and idle with a finished turn, not in plan mode (which starts nothing of thimble's), no view proposal card
waits (views.open_offer), and views can be built here (views.build_problem_for). There is no other limit.

The call (_fork): one tool-less completion over main's own transcript, which thimble's plugin module makes with
`$.model.fork` in main's session (model_call.fork). It reads main's conversation as main last sent it, on main's model
and effort, so the API serves main's context from its prompt cache. Its message (assemble) is prompts/view-propose.md,
the threads (cut to the room main's context leaves, _threads_budget), the orientation, the views the analyst has
(built, building, failed, accepted and rejected proposals, deleted views) and what just happened, then the answer's
schema (prompts/complete.md `fork`); its answer is its reply, one JSON object (parse), asked for once more when it does
not fit the schema. It is no subagent: it has no tools, never interrupts main, leaves no row in main's terminal and
asks nothing.

Each run appends a line to the run log (LOG_FILE). Every failure tells the analyst in the foreground with an easy fix
(notices.post, NOTICE_KEY): a request Claude's safeguards blocked (Try again, Turn off view proposals), Claude Code not
signed in (in the terminal: /login, as main's own card says it; Try again), access refused for the account or its
organization (403: in the terminal, /login, or the organization's settings; Try again), no Claude Code session that
runs thimble here (the fix; Try again), and any other failure (Try again). A run that works clears the notice; a run
with nothing to fork yet (after a /clear) tells nothing.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import agents, capture, config, ledger, model_call, notices, prompts, views
from .call_result import CallResult, ToolSpec, json_object

log = logging.getLogger("thimble.proposer")

PROMPT = "view-propose"  # prompts/view-propose.md
PROPOSE_ENV = views.PROPOSE_ENV  # "off" turns view proposals off whatever Settings say (the test suite)
DEBOUNCE_MAIN_S = 2.0
DEBOUNCE_OTHER_S = 45.0  # above subagents' 30 s hand-back wait in auto mode
FORK_TIMEOUT_S = 300.0
CONTEXT_CHARS = 120_000  # of the threads part, at most
MIN_CONTEXT_CHARS = 8_000  # of the threads part, at least, however full main's context is
RESERVE_TOKENS = 20_000  # of main's context window, kept free for the fork's answer and Claude Code's own text
# the answer's schema, which the fork's message shows (complete.md `fork`) and its reply must fit; parse reads it then
_TEXT = {"type": "string", "minLength": 1}
SCHEMA = {
    "type": "object",
    "properties": {
        "show": {"type": "boolean"},
        "why": {"type": "string"},
        "proposal": {"anyOf": [{"type": "null"}, {
            "type": "object",
            "properties": {"name": _TEXT, "description": _TEXT, "task": _TEXT,
                           "claims": {"anyOf": [_TEXT, {"type": "array", "items": _TEXT, "minItems": 1}]}},
            "required": ["name", "description", "task", "claims"]}]},
    },
    "required": ["show", "why", "proposal"],
    "if": {"properties": {"show": {"const": True}}},
    "then": {"properties": {"proposal": {"type": "object"}}},
}
ANSWER = ToolSpec(name="view_proposal", input_schema=SCHEMA,
                  description="Your decision, as the section \"Your answer\" above describes it.")
LOG_FILE = "proposer.jsonl"  # in the views state folder: one line per run
# in the views state folder: {job: the pending job {after, sid, cut, since} or null}, read through
# views.proposer_state and changed under the file's lock (ledger.update_json) by whichever process triggers
JOB_FILE = views.PROPOSER_FILE
NOTICE_KEY = "proposals"  # the key of the proposer's notices (notices.post)
AGENT = "View proposals"  # the proposer's name on its notices
BUILTIN = "Files shows every file in its built-in views: Raw, Table, Text, Transcript and Timeline, as fit its type."
TERMINAL_BUILTIN = ("thimble's panel shows every file in its built-in views: Raw, Table, Text, Transcript and Timeline, "
                    "as fit its type.")
MAIN, ORIENTATION, THREAD = "main", "orientation", "thread:"
REPLY_CHARS = 1_500  # of a thread's question quoted in the Now section
# the words of an error that says the model's safeguards refused the request, of one that says Claude Code has no
# working sign-in (spike G: "Not logged in · Please run /login", error authentication_failed), of one that says the
# account may not make the request (403), and the HTTP status a line names, which decides before its other words do
REFUSED_RE, AUTH_RE, FORBIDDEN_RE, STATUS_RE = notices.REFUSED_RE, notices.AUTH_RE, notices.FORBIDDEN_RE, notices.STATUS_RE

NOTICE_REFUSED = "Couldn't check for a view proposal: Claude's safeguards blocked the request."
# a failed sign-in or a credit balance too low: its fix runs in the terminal, in the words that name the login Claude Code
# uses (notices.sign_in_words), with Try again here
NOTICE_SIGN_IN = "Couldn't check for a view proposal: {why}."
NOTICE_FORBIDDEN = ("Couldn't check for a view proposal: access was refused for this account or organization (403). In "
                    "your terminal: run /login to check the account, or check your organization's settings.")
NOTICE_FAILED = "Couldn't check for a view proposal: {reason}."
TRY_AGAIN = {"label": "Try again", "do": "proposals-retry"}
TURN_OFF = {"label": "Turn off view proposals", "do": "proposals-off"}
REASONS = {"timeout": f"Claude didn't answer within {int(FORK_TIMEOUT_S // 60)} minutes",
           "unparsed": "Claude's answer couldn't be read", "error": "Claude Code stopped with an error"}

_tasks: dict[str, asyncio.Task] = {}  # workspace -> its loop (_loop) or a run_now run
_running: set[str] = set()  # workspaces whose fork runs now


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def enabled(c: str) -> bool:
    """Whether view proposals are on in workspace `c`: views.propose_enabled (PROPOSE_ENV is not off and Settings'
    switch, `views.propose`, is on), which the View proposals feature switch (features.auto `proposer`) reads."""
    from . import features  # noqa: PLC0415

    return views.propose_enabled(c) and bool(features.auto(c, "proposer"))


# --------------------------------------------------------------------------- the pending job


def _job_path(c: str) -> Path:
    return views.state_dir(c) / JOB_FILE


def _job_of(state: Any) -> dict[str, Any] | None:
    job = state.get("job") if isinstance(state, dict) else None
    return job if isinstance(job, dict) and job.get("after") else None


def pending(c: str) -> dict[str, Any] | None:
    """The workspace's pending job {after: [...], sid, cut, since}, or None (views.proposer_state)."""
    return _job_of(views.proposer_state(c))


def _merge(c: str, after: str, *, sid: str | None = None, cut: str | None = None) -> dict[str, Any]:
    """Add a reason to the pending job: the reasons are unioned, and a cut replaces the job's when its session is the
    same or the job has none. The job."""
    def change(state: Any) -> dict[str, Any]:
        job = _job_of(state) or {"after": [], "sid": None, "cut": None}
        job["after"] = list(dict.fromkeys([*job["after"], after]))
        if cut and (not job.get("sid") or job.get("sid") == sid or not job.get("cut")):
            job["sid"], job["cut"] = sid, cut
        job["since"] = _now()
        return {**(state if isinstance(state, dict) else {}), "job": job}

    p = _job_path(c)
    p.parent.mkdir(parents=True, exist_ok=True)
    return ledger.update_json(p, change, None)["job"]


def _pop(c: str) -> dict[str, Any] | None:
    """Take the pending job, leaving none."""
    out: dict[str, Any] = {}

    def change(state: Any) -> dict[str, Any] | None:
        job = _job_of(state)
        if job is None:
            return None
        out.update(job)
        return {**state, "job": None}

    p = _job_path(c)
    if p.is_file():
        ledger.update_json(p, change, None)
    return out or None


# --------------------------------------------------------------------------- triggers


def trigger(c: str, after: str, *, cut: str | None = None, sid: str | None = None) -> None:
    """Something happened after which a view proposal may help: `after` is "main" (with main's session `sid` and the
    `cut` its turn ended at), "thread:<id>" or "orientation". Nothing happens while view proposals are off. The job is
    kept, and its loop starts when an event loop runs here (else a later turn end starts it)."""
    if not enabled(c):
        return
    _merge(c, after, sid=sid, cut=cut)
    _start(c)


def turn_ended(c: str, *, sid: str, analyst: bool, cut: str | None) -> None:
    """A turn of main ended (session._end_turn) at the turn_duration record `cut`. A turn that answered the analyst
    (`analyst`) triggers the proposer; any other turn (a task notification, a Monitor's re-arm, a start_agent event)
    starts a job that waited for main to be idle."""
    if analyst and cut:
        trigger(c, MAIN, cut=cut, sid=sid)
    elif pending(c) is not None:
        _start(c)


def _loop_running() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _start(c: str) -> None:
    loop = _loop_running()
    if loop is None:
        return
    task = _tasks.get(c)
    if task is None or task.done():
        _tasks[c] = loop.create_task(_loop(c), name=f"view-proposer-{c}")


async def _loop(c: str) -> None:
    """Run the workspace's pending job once it stopped changing for its debounce and main is idle (module note)."""
    try:
        while (job := pending(c)) is not None:
            await asyncio.sleep(DEBOUNCE_MAIN_S if MAIN in job["after"] else DEBOUNCE_OTHER_S)
            if pending(c) != job:
                continue  # a trigger came while it waited: wait again
            from . import session  # noqa: PLC0415 — session imports this module lazily

            lv = session.current(c)
            if lv is not None and lv.turn_open:
                return  # main's turn end starts the loop again (turn_ended)
            if (job := _pop(c)) is not None:
                await run_once(c, job)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — a proposer that fails must not take the server's loop with it
        log.exception("%s: the view proposer failed", c)


def run_now(c: str) -> dict[str, Any]:
    """The analyst's Try again on a proposer notice (POST /views/propose-now): a run now, with no wait, from main's last
    cut. {started: true}; {queued: true} when a run goes on or main is answering, so the job runs after it; or
    {started: false, reason} when it cannot run (view proposals off, a card waits, no session, views cannot be built).
    Call it on the server's loop."""
    from . import session  # noqa: PLC0415

    if not enabled(c):
        return {"started": False, "reason": "View proposals are off."}
    lv = session.current(c)
    if lv is None:
        return {"started": False, "reason": "No Claude Code session is attached to thimble."}
    job = _merge(c, MAIN, sid=lv.sid, cut=lv.last_cut)
    if c in _running or lv.turn_open:
        _start(c)
        return {"queued": True}
    why = due(c, lv, job)[1]
    if why:
        _pop(c)  # as a run the gate holds leaves no job (run_once)
        return {"started": False, "reason": why}
    loop = _loop_running()
    if loop is None:
        return {"queued": True}
    task = _tasks.get(c)
    if task is not None and not task.done():
        task.cancel()  # its debounce only: a running fork is in _running, answered above
    _tasks[c] = loop.create_task(_run_popped(c), name=f"view-proposer-now-{c}")
    return {"started": True}


async def _run_popped(c: str) -> None:
    try:
        if (job := _pop(c)) is not None:
            await run_once(c, job)
    except Exception:  # noqa: BLE001
        log.exception("%s: the view proposer failed", c)


# --------------------------------------------------------------------------- the gate


def due(c: str, lv: Any, job: dict[str, Any]) -> tuple[str | None, str]:
    """(the cut of main's turn the job comes after, '') when the job may run now, else (None, why not): view proposals
    off, no main, main answering, no finished turn, plan mode, a card waiting, or views that cannot be built here."""
    from . import session  # noqa: PLC0415

    if not enabled(c):
        return None, "View proposals are off."
    if lv is None or not getattr(lv, "transcript_path", None):
        return None, "No Claude Code session is attached to thimble."
    if lv.turn_open:
        return None, "Claude is answering."
    cut = job.get("cut") if job.get("sid") == lv.sid and job.get("cut") else lv.last_cut
    if not cut:
        return None, "Main has no finished turn to start from."
    if session.main_mode(c) == "plan":
        return None, "Claude Code is in plan mode, in which thimble starts nothing."
    if views.open_offer(c) is not None:
        return None, "A view proposal waits for the analyst."
    if problem := views.build_problem_for(c):
        return None, problem
    return str(cut), ""


# --------------------------------------------------------------------------- the prompt


def _hm(ts: Any) -> str:
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%H:%M")
    except (TypeError, ValueError):
        return "an earlier time"


def _one(text: Any) -> str:
    return " ".join(str(text or "").split())


def nest_headings(md: str, by: int = 2) -> str:
    """Markdown with each heading `by` levels deeper (at most six), code fences left alone."""
    out, fence = [], False
    for line in md.splitlines():
        if line.lstrip().startswith("```"):
            fence = not fence
        m = None if fence else re.match(r"^(#{1,6})(\s.*)$", line)
        out.append(("#" * min(6, len(m.group(1)) + by) + m.group(2)) if m else line)
    return "\n".join(out)


def _threads_section(c: str, budget: int = CONTEXT_CHARS) -> str:
    from . import context  # noqa: PLC0415 — context imports session, which imports this module lazily

    text = context.render(c, parts=("threads",), budget=budget).strip()
    return text or "## The threads\n\nThe analyst has asked nothing in a side thread."


def _orientation_cards(c: str, chat: str) -> list[str]:
    from . import notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    out = []
    for row in notebook.list_notebooks(ws, figures=False):
        for cell in (notebook.read_notebook(ws, row["id"]) or {}).get("cells") or []:
            if isinstance(cell, dict) and cell.get("created_by") == f"chat:{chat}":
                title, takeaway = _one(cell.get("title")), _one(cell.get("takeaway"))
                out.append(f"- {title or '(untitled)'}{': ' + takeaway if takeaway else ''}")
    return out


def _orientation_section(c: str) -> str:
    from . import orientation  # noqa: PLC0415

    run = orientation.read_run(c)
    out = ["## The orientation", ""]
    if not run or run.get("status") in (None, "requested", "starting"):
        return "\n".join([*out, "No orientation has started."])
    chat = str((run.get("chats") or {}).get(orientation.ROLE) or "")
    cards = _orientation_cards(c, chat) if chat else []
    if run.get("status") == "running":
        out.append(f"An orientation started at {_hm(run.get('started'))} and runs beside the session; the analyst sees "
                   "its cards appear.")
        out += (["", "Its cards so far:", "", *cards] if cards else ["It has made no card yet."])
    else:
        ended = {"done": "", "stopped": " and was stopped before it finished", "failed": " and failed"}
        out.append(f"An orientation ran beside the session from {_hm(run.get('started'))} to "
                   f"{_hm(run.get('ended'))}{ended.get(str(run.get('status')), '')}, and the analyst sees its cards.")
        summary = (orientation.summary(c) or "").strip() if run.get("status") == "done" else ""
        if summary:
            out += ["Its summary:", "", nest_headings(summary)]
        if cards:
            out += ["", "Its cards:", "", *cards]
    return "\n".join(out).rstrip()


def _suffix(claims: Any) -> str:
    for g in claims or []:
        if (s := views.type_suffix(str(g))):
            return s
    return "such a"


def _views_section(c: str) -> str:
    """The views the analyst has: each proposal row by how it stands, then each built view without a row, then each
    deleted one."""
    # where a view the proposal builds is drawn first: the terminal's panel on the local transport, else the browser
    out = ["## Views the analyst has", "", TERMINAL_BUILTIN if views.default_target(c) == views.TERM_PAGE else BUILTIN]
    rows = views.list_proposals(c)
    built = {v["slug"]: v for v in views.list_views(c)}
    state = {"built": "built", "queued": "building", "building": "building", "failed": "the build failed"}
    for p in rows:
        name, desc = _one(p.get("name")), _one(p.get("description"))
        status, offered = str(p.get("status") or ""), p.get("offered")
        if isinstance(offered, dict):
            if offered.get("after") == "file" or p.get("proposed_by") == "files":
                who = (f"thimble proposed it when the analyst opened a {_suffix(p.get('claims'))} file, at "
                       f"{_hm(offered.get('at'))}")
            else:
                who = f"You proposed it at {_hm(offered.get('at'))}"
            if p.get("answer") == "rejected" or (status == "dropped" and p.get("answer") != "accepted"):
                out.append(f"- {name}: {desc} {who}, and the analyst rejected it.")
            elif status in state:
                out.append(f"- {name}: {desc} {who}, and the analyst accepted it; {state[status]}.")
            elif status == "suggested":
                out.append(f"- {name}: {desc} {who}; it waits for the analyst's answer.")
        elif status in state:  # main's proposals, and an older orientation's (a dropped or legacy row is left out)
            out.append(f"- {name}: {desc} {state[status].capitalize()}.")
    have = {p["slug"] for p in rows}
    out += [f"- {_one(v.get('name'))}: {_one(v.get('description'))} Built." for s, v in built.items() if s not in have]
    out += [f"- {_one(d.get('name'))}: the analyst deleted this view." for d in views.deleted_proposals(c)]
    return "\n".join(out)


def _last_question(c: str, chat: str) -> str:
    try:
        recs = agents.read_events(agents.paths(c, chat)[1])
    except Exception:  # noqa: BLE001 — a thread deleted meanwhile
        return ""
    text = next((str(r.get("text") or "") for r in reversed(recs) if r.get("type") == "user" and r.get("text")), "")
    text = _one(text)
    return text if len(text) <= REPLY_CHARS else text[:REPLY_CHARS].rstrip() + " …"


def _now_section(c: str, after: list[str]) -> str:
    said = [f"It is {datetime.now(timezone.utc).strftime('%H:%M')} UTC."]
    if ORIENTATION in after:
        said.append("The orientation has just finished.")
    for a in after:
        if a.startswith(THREAD):
            q = _last_question(c, a[len(THREAD):])
            said.append(f"A side thread has just answered the analyst: \"{q}\"" if q else
                        "A side thread has just answered the analyst.")
    if MAIN in after:
        said.append("The session has just answered the analyst's last message, above.")
    return "## Now\n\n" + " ".join(said)


def _threads_budget(lv: Any, rest: int) -> int:
    """The characters the threads part may take: what main's context window leaves after main's context, RESERVE_TOKENS
    and the rest of the message (`rest` characters), at four characters a token; between MIN_CONTEXT_CHARS and
    CONTEXT_CHARS. A context past the plain window is on the 1M-token one."""
    used = int(getattr(lv, "context_tokens", 0) or 0)
    window = config.LONG_CONTEXT_TOKENS if used > config.CONTEXT_TOKENS - RESERVE_TOKENS else config.CONTEXT_TOKENS
    room = (window - used - RESERVE_TOKENS) * 4 - rest
    return max(MIN_CONTEXT_CHARS, min(CONTEXT_CHARS, room))


def assemble(c: str, job: dict[str, Any], lv: Any = None) -> str:
    """The fork's message (module note): the proposer prompt, the threads (cut to the room main's context leaves,
    _threads_budget), the orientation, the views the analyst has and what just happened (job's `after`)."""
    # the page a proposal it makes builds: view.term.js on the local transport, view.html after the press
    flags = views.target_flags(c, views.default_target(c))
    head = prompts.load(PROMPT, flags).strip()
    tail = [_orientation_section(c), _views_section(c), _now_section(c, list(job.get("after") or []))]
    budget = _threads_budget(lv, len(head) + sum(len(t) for t in tail) + 2_000)
    parts = [head, _threads_section(c, budget), *tail]
    return "\n\n".join(p for p in parts if p) + "\n"


# --------------------------------------------------------------------------- the answer


def parse(text: str) -> tuple[dict[str, Any] | None, str | None]:
    """The answer's object {show, why, proposal} and None, or None and what is wrong. `show` is a boolean; with `show`
    true the proposal's name, description and task are non-empty strings and its claims a non-empty list of strings (a
    string is one claim); with `show` false the proposal may be null. A missing `why` reads as ''."""
    obj, err = json_object(text)
    if obj is None:
        return None, err
    if not isinstance(obj.get("show"), bool):
        return None, "`show` is not a boolean"
    obj["why"] = _one(obj.get("why")) if isinstance(obj.get("why"), str) else ""
    p = obj.get("proposal")
    if not obj["show"] and not isinstance(p, dict):
        obj["proposal"] = None
        return obj, None
    if not isinstance(p, dict):
        return None, "`proposal` is not an object"
    for k in ("name", "description", "task"):
        if not isinstance(p.get(k), str) or not p[k].strip():
            return None, f"`proposal.{k}` is missing"
    claims = [p["claims"]] if isinstance(p.get("claims"), str) else p.get("claims")
    if not isinstance(claims, list) or not claims or not all(isinstance(x, str) and x.strip() for x in claims):
        return None, "`proposal.claims` is not a non-empty list of strings"
    p["claims"] = [x.strip() for x in claims]
    return obj, None


def classify(res: CallResult, obj: dict[str, Any] | None) -> str:
    """ok (a valid answer, from whichever model), refused (Claude's safeguards blocked the request), auth (Claude Code
    has no working sign-in: 401), billing (its credit balance is too low), forbidden (the account or its organization
    may not make the request: 403), timeout, no_session (no Claude Code session runs thimble here), stopped (the server
    stopped it), unparsed (an answer that is not the object) or error."""
    if obj is not None:
        return "ok"
    if res.status in ("ok", "no_tool_call"):
        return "unparsed"
    if res.status in ("timeout", "no_session", "stopped", "refused"):
        return res.status
    said = res.detail or ""
    if REFUSED_RE.search(said):
        return "refused"
    named = STATUS_RE.search(said)
    status = int(named.group(1)) if named else None
    if status == 403:
        return "forbidden"
    if status == 401:
        return "auth"
    if notices.BILLING_RE.search(said):
        return "billing"
    if AUTH_RE.search(said):
        return "auth"
    if FORBIDDEN_RE.search(said):
        return "forbidden"
    return "error"


def error_line(detail: str) -> str:
    """What went wrong in a few words, for the notice."""
    line = _one(detail).rstrip(".")
    if not line:
        return REASONS["error"]
    return line if len(line) <= 160 else line[:159].rstrip() + "…"


# --------------------------------------------------------------------------- the fork


async def _fork(c: str, lv: Any, prompt: str) -> CallResult:
    """The fork (module note): one completion over main's transcript (model_call.fork), with the answer's schema, at
    most FORK_TIMEOUT_S. Tests replace it."""
    model_id, effort = str(getattr(lv, "model", "") or ""), str(getattr(lv, "effort", "") or "")
    cap = capture.begin("view-propose", model=model_id or None, effort=effort or None, path="fork of main")
    cap.text("Prompt", prompt)
    res = await model_call.fork(c, prompt, tool=ANSWER, model=model_id, what="view proposal",
                                timeout_s=FORK_TIMEOUT_S)
    cap.text("Answer", json.dumps(res.output, ensure_ascii=False, indent=1) if res.output is not None else res.detail)
    cap.finish(res.status, res.detail[:600])
    return res


# --------------------------------------------------------------------------- one run


def _log_line(c: str, line: dict[str, Any]) -> None:
    try:
        p = views.state_dir(c) / LOG_FILE
        p.parent.mkdir(parents=True, exist_ok=True)
        with ledger.locked(p), p.open("a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
    except (OSError, ValueError):
        log.warning("%s: the view proposer's run log was not written", c, exc_info=True)


def _after_of(after: list[str]) -> str:
    """What an offer comes after, by priority: the orientation, a thread, main."""
    if ORIENTATION in after:
        return ORIENTATION
    return next((a for a in after if a.startswith(THREAD)), MAIN)


def _stale(c: str, sid: str) -> bool:
    """Whether a result that came back is out of date: main is another session now, the analyst opened a new turn, or a
    newer turn of theirs ended meanwhile (its job waits)."""
    from . import session  # noqa: PLC0415

    cur = session.current(c)
    if cur is None or cur.sid != sid or (cur.turn_open and cur.turn_analyst):
        return True
    job = pending(c)
    return bool(job and MAIN in job["after"])


def _tell(c: str, status: str, *, reason: str = "") -> None:
    """The notice of the run's outcome (module note): the failure and its fix, or, for a run that worked, none. The
    proposer has no chat, so its notices show in the foreground alone."""
    def tell(text: str, action: Any = None) -> None:
        notices.post(c, kind="proposals", text=text, agent=AGENT, action=action, key=NOTICE_KEY)

    if status == "refused":
        tell(NOTICE_REFUSED, [TRY_AGAIN, TURN_OFF])
    elif status in ("auth", "billing"):
        tell(NOTICE_SIGN_IN.format(why=notices.sign_in_words(status)), TRY_AGAIN)
    elif status == "forbidden":
        tell(NOTICE_FORBIDDEN, TRY_AGAIN)
    elif status in ("timeout", "unparsed", "error", "no_session"):
        tell(NOTICE_FAILED.format(reason=reason or REASONS.get(status) or REASONS["error"]), TRY_AGAIN)
    else:
        notices.clear(c, NOTICE_KEY)


async def run_once(c: str, job: dict[str, Any]) -> dict[str, Any]:
    """One run of the proposer for `job` (module note): the gate, the fork, its answer, the card, the run log line and
    the notice. The run log line, or {status: skipped, why} when the gate held it."""
    from . import session  # noqa: PLC0415

    lv = session.current(c)
    cut, why = await asyncio.to_thread(due, c, lv, job)
    if cut is None:
        log.debug("%s: no view proposal run: %s", c, why)
        return {"status": "skipped", "why": why}
    after = list(job.get("after") or [])
    prompt = await asyncio.to_thread(assemble, c, job, lv)
    asked = str(getattr(lv, "model", "") or "") or None
    line: dict[str, Any] = {"at": _now(), "after": after, "sid": lv.sid, "cut": cut, "model": asked,
                            "effort": getattr(lv, "effort", None)}
    _running.add(c)
    try:
        res = await _fork(c, lv, prompt)
    finally:
        _running.discard(c)
    obj, err = parse(json.dumps(res.output)) if res.status == "ok" and res.output is not None else (None, "")
    status = classify(res, obj)
    usage = res.usage or {}
    sent = sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    # the tokens the fork read as the API counted them, of which the prompt cache served `cached`; else an estimate
    line.update(status=status, seconds=res.duration_s,
                input_tokens=sent or int(getattr(lv, "context_tokens", 0) or 0) + len(prompt) // 4,
                cached=int(usage.get("cache_read_input_tokens") or 0) if usage else None)
    if obj is not None:
        line.update(show=obj["show"], why=obj["why"])
        if obj["show"] and obj.get("proposal") and await asyncio.to_thread(_stale, c, lv.sid):
            line["status"] = "stale"
        elif obj["show"] and obj.get("proposal"):
            p = obj["proposal"]
            row, refused = await asyncio.to_thread(
                lambda: views.offer(c, name=p["name"], description=p["description"], task=p["task"],
                                    claims=p["claims"], after=_after_of(after), why=obj["why"]))
            line.update(offered=(row or {}).get("slug"), refused_offer=refused or None)
    else:
        line["error"] = err if status == "unparsed" and err else error_line(res.detail)
    await asyncio.to_thread(_log_line, c, line)
    if status == "stopped":
        return line  # the server stopped it, or main had nothing to fork yet: nothing to tell
    # on the loop: the notice's row and event reach the browser from here (agents.notify, investigation.emit)
    _tell(c, status, reason=line.get("error", "") if status in ("error", "no_session") else "")
    if status != "ok":
        log.warning("%s: view proposer run %s: %s", c, status, line.get("error") or "")
    return line


async def shutdown() -> None:
    """The server stops: every loop and run ends (a fork that runs in the module runs to its end, and its answer goes
    nowhere)."""
    tasks = [t for t in _tasks.values() if not t.done()]
    for t in tasks:
        t.cancel()
    for t in tasks:
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await t
    _tasks.clear()
