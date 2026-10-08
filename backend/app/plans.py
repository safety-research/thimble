"""Plan cards' steps after the card is made: update_plan, which changes one step, and the live rows of a step's runs.

A plan card (notebook.PLAN_KIND) holds numbered steps, each with a status the agent keeps current. update_plan changes
one step through notebook.edit_cell, under the groups' lock, and stamps `started` and `ended` when its status changes,
so the card shows how long a step took, or has run so far, unless the agent gives a time. A plan is not rewritten for a
new phase: once a step has started, edit_card refuses new steps (tools.py, `## plan-started`), and the next phase is a
new plan card whose `follows` names this one.

A step's `runs` names the Agent calls that do it, by their description, as Claude Code's agent tray names them.
plan_runs matches each name to main's subagent chat of that title (session.py mirrors each Agent call of main's as an
agent chat titled by its description) and gives its state, its latest event and how long it has run, which the card
shows under the step while it runs (GET /ws/{c}/cards/{id}/plan-runs).
"""
from __future__ import annotations

import builtins
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException

from . import config, notebook

router = APIRouter()

SUBAGENT_ROLE = "subagent"  # session.SUBAGENT_ROLE: the role of the agent chat of each of main's Agent calls
LATEST_CHARS = 120  # of a run's latest event on its row
# the argument of a tool call its row names, first found first (a Bash command, a file, a search, a prompt)
CALL_ARGS = ("description", "command", "file_path", "path", "pattern", "query", "url", "prompt", "card", "ref")


class PlanError(ValueError):
    """A change update_plan refuses: `hint` names the `## <hint>` section of prompts/tools.md, else the message is the
    line itself."""

    def __init__(self, message: str, hint: str = "", **values: Any):
        super().__init__(message)
        self.hint = hint
        self.values = values


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def step_number(raw: Any) -> int | None:
    """The 1-based number of a step as a call names it: 2, "2", "step-2" or card:<id>#step-2; None for anything else."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    text = str(raw or "").strip()
    if "#" in text:
        text = text.rsplit("#", 1)[1]
    text = text.removeprefix("step-").removeprefix("step ").strip()
    return int(text) if text.isdigit() else None


def stamp(step: dict, status: str, now: str) -> None:
    """Set a step's status and its times: running starts its clock (a step that waited for the analyst keeps the clock
    it had), done stops it, needs you holds it, and not started clears both."""
    old = step.get("status")
    step["status"] = status
    if status == notebook.PLAN_RUNNING:
        if not (old == notebook.PLAN_NEEDS_YOU and step.get("started")):
            step["started"] = now
        step["ended"] = None
    elif status == notebook.PLAN_DONE:
        step["ended"] = now
    elif status == notebook.PLAN_NEEDS_YOU:
        step["ended"] = None
    else:
        step["started"] = step["ended"] = None


def update_step(c: str, cid: str, n: int, *, status: str | None = None, note: str | None = None,
                runs: "builtins.list[str] | None" = None, time: str | None = None, by: str | None = None) -> dict:
    """Change step `n` (from 1) of plan `cid` and return the card: its status (with its times stamped, stamp), its note,
    its runs or the time it shows. PlanError for a card that is not a plan, an unknown step or a status that is not one
    of notebook.PLAN_STATUSES. The analyst's lock is the caller's to check (tools.card_locked)."""
    ws = config.workspace_dir(c)
    with notebook.editing(ws):
        hit = notebook.find_cell(ws, cid)
        if hit is None:
            raise PlanError(f"card:{cid} does not exist", "edit_card-gone", cid=cid)
        cell = hit[1]
        if cell.get("kind") != notebook.PLAN_KIND:
            raise PlanError(f"update_plan: card:{cid} is a {cell.get('kind') or notebook.DEFAULT_KIND} card, not a plan")
        steps = notebook.plan_steps(cell)
        if not 1 <= n <= len(steps):
            raise PlanError(f"update_plan: card:{cid} has no step {n}", "plan-step-unknown", cid=cid, step=n,
                            count=len(steps))
        word = None
        if status is not None:
            word = notebook.plan_status_of(status)
            if word is None:
                raise PlanError(f"update_plan: `status` must be one of {', '.join(notebook.PLAN_STATUSES)}")
        step = steps[n - 1]
        if word is not None and word != step["status"]:
            stamp(step, word, _now())
        if note is not None:
            step["note"] = str(note).strip()
        if runs is not None:
            step["runs"] = notebook.plan_step_of({"runs": runs}, step["id"])["runs"]
        if time is not None:
            step["time"] = " ".join(str(time).split())
        payload = {**(cell.get("payload") or {}), "steps": steps}
        return notebook.edit_cell(c, cid, payload=payload, by=by)


async def tool_update_plan(ctx: Any, args: dict[str, Any]) -> Any:
    """update_plan: one step of a plan card, by its number, changed (update_step); the result is the plan's steps."""
    from . import tools  # noqa: PLC0415 — tools imports this module lazily, through the registry

    raw_card = args.get("card") if args.get("card") not in (None, "") else args.get("cell")
    cid = tools._cell_id_of(raw_card) or str(ctx.anchor or "").strip()
    if not cid:
        return tools.err(tools.hint("edit_card-no-card") or "update_plan: name the plan with `card`")
    raw_step = args.get("step")
    if raw_step in (None, "") and "#step-" in str(raw_card or ""):
        raw_step = raw_card
    n = step_number(raw_step)
    if n is None:
        return tools.err("update_plan: `step` is the step's number, from 1")
    hit = notebook.find_cell(ctx.ws, cid)
    if hit is not None and (refused := tools.card_locked(ctx, cid, hit[1], tool="update_plan")):
        return refused
    fields = {k: args.get(k) for k in ("status", "note", "runs", "time") if args.get(k) is not None}
    if not fields:
        return tools.err("update_plan: pass `status`, `note`, `runs` or `time`")
    runs = fields.get("runs")
    if runs is not None and not isinstance(runs, builtins.list):
        runs = [runs]
    try:
        cell = update_step(ctx.c, cid, n, status=fields.get("status"), note=fields.get("note"), runs=runs,
                           time=fields.get("time"), by=ctx.cell_author)
    except PlanError as e:
        return tools.err((tools.hint(e.hint, **e.values) if e.hint else "") or str(e))
    return tools.ok(f"card:{cid}\n\n" + "\n".join(notebook.plan_lines(cell)))


# --------------------------------------------------------------------------- the live rows of a step's runs


def _name(text: Any) -> str:
    return " ".join(str(text or "").split()).casefold()


def _seconds(start: Any, end: Any = None) -> float | None:
    try:
        a = datetime.fromisoformat(str(start))
        b = datetime.fromisoformat(str(end)) if end else datetime.now(timezone.utc)
    except ValueError:
        return None
    if a.tzinfo is None:
        a = a.replace(tzinfo=timezone.utc)
    if b.tzinfo is None:
        b = b.replace(tzinfo=timezone.utc)
    return (b - a).total_seconds()


def _cut(text: str, n: int = LATEST_CHARS) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def call_line(name: str, inp: Any) -> str:
    """A tool call as a run's row shows it: its short name and the argument that says what it does."""
    short = name.rsplit("__", 1)[-1] if name.startswith("mcp__") else name
    if isinstance(inp, str):
        try:
            inp = json.loads(inp)
        except ValueError:
            inp = {}
    arg = next((str(inp[k]) for k in CALL_ARGS if isinstance(inp, dict) and str(inp.get(k) or "").strip()), "")
    return _cut(f"{short} {arg}".strip())


def latest_event(records: "builtins.list[dict]") -> str:
    """A chat's latest event: its last tool call, or the first line of its last text, whichever came last."""
    for r in reversed(records):
        if r.get("type") == "tool_use" and r.get("name"):
            return call_line(str(r["name"]), r.get("input"))
        if r.get("type") == "text":
            text = str(r.get("text") or r.get("delta") or "").strip()
            if text:
                return _cut(text.splitlines()[0])
        if r.get("type") == "done":
            return _cut(str(r.get("result") or "done").strip().splitlines()[0] if r.get("result") else "done")
        if r.get("type") == "error":
            return _cut(str(r.get("message") or "failed"))
    return ""


TAIL_BYTES = 65_536  # of a chat's log, read for its latest event


def tail_records(path: Any, size: int = TAIL_BYTES) -> "builtins.list[dict]":
    """The records at the end of a chat's log (agents.py: one JSON object a line), from its last `size` bytes, so a long
    run's log is not read whole every few seconds."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            end = f.tell()
            f.seek(max(0, end - size))
            data = f.read()
    except OSError:
        return []
    lines = data.split(b"\n")
    if end > size:
        lines = lines[1:]  # the first line may start mid-record
    out: builtins.list[dict] = []
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict):
            out.append(r)
    return out


def _chats_by_title(c: str) -> dict[str, dict]:
    """Main's subagent chats by their title (casefolded), the newest of a title kept."""
    from . import agents  # noqa: PLC0415

    out: dict[str, dict] = {}
    for meta in agents.list_chats(c):
        if meta.get("kind") != agents.KIND_AGENT or meta.get("role") != SUBAGENT_ROLE:
            continue
        key = _name(meta.get("title"))
        if key and (key not in out or str(meta.get("created_at") or "") >= str(out[key].get("created_at") or "")):
            out[key] = meta
    return out


def plan_runs(c: str, cid: str) -> "builtins.list[dict[str, Any]]":
    """The live row of each run a step of plan `cid` names: {step (from 1), name, chat, state, latest, elapsed}, where
    `chat` is the subagent chat of that title (None while none has started) and `elapsed` its time in the card's
    words. 404 for a card that is not a plan."""
    from . import agents  # noqa: PLC0415

    cell = notebook.get_cell(c, cid)
    if cell is None or cell.get("kind") != notebook.PLAN_KIND:
        raise HTTPException(404, f"no plan card {cid}")
    steps = notebook.plan_steps(cell)
    chats = _chats_by_title(c) if any(s["runs"] for s in steps) else {}
    rows: builtins.list[dict[str, Any]] = []
    for n, step in enumerate(steps, 1):
        for name in step["runs"]:
            meta = chats.get(_name(name))
            row: dict[str, Any] = {"step": n, "name": name, "chat": None, "state": "not started", "latest": "", "elapsed": ""}
            if meta is not None:
                _, log_path = agents.paths(c, str(meta["id"]))
                secs = _seconds(meta.get("created_at"), meta.get("ts_end"))
                row.update(chat=str(meta["id"]), state=str(meta.get("status") or "running"),
                           latest=latest_event(tail_records(log_path)),
                           elapsed=notebook.duration_words(secs) if secs is not None else "")
            rows.append(row)
    return rows


@router.get("/ws/{c}/cards/{cell_id}/plan-runs")
def plan_runs_route(c: str, cell_id: str) -> dict:
    """The live rows of a plan's runs (plan_runs), which the card reads while a step runs."""
    try:
        config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"runs": plan_runs(c, cell_id)}
