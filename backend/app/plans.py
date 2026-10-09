"""Plan cards' steps after the card is made: edit_card replaces them (merge_steps), and the live rows of a step's runs.

A plan card (notebook.PLAN_KIND) holds numbered steps, each with a status the agent keeps current. The agent changes a
plan as it changes any card: edit_card with the whole list of steps, at any time, such as to mark a step running or
done, add a note or details, or add a step. merge_steps matches each new step to the step it replaces, so the step keeps
its id (which a comment on it follows) and its clock: by the id it gives, else by the same text (at its place, else
anywhere, as when a step was put before it), else by its place, the old step it reads most like first (likeness). A
matched step keeps `started` and `ended` while its text is unchanged (or it names its id), and keeps every field it
leaves out, such as its runs; a status that changes is stamped (stamp), so the card shows how long a step took, or has
run so far, unless the agent gives a time. The next phase can still be a new plan card whose `follows` names this one.

An edit that changes what the plan is (a step's text, what it makes or its details; a step added or removed) leaves its
marks in the payload (edit_marks, LAST_EDIT), so the card shows the analyst which steps it changed (Changed) and added
(New); the plan as it was is in the card's history (notebook.version_of). The marks stay until the next edit that
changes the plan, through edits of progress alone (marks_after), or until the analyst clears them (POST
/ws/{c}/cards/{id}/plan-edit/clear). Matt 2026-10-09: "we should not keep 'Before' with a strikethrough. maybe cards
have a history button?"

A step's `runs` names the Agent calls that do it, by their description, as Claude Code's agent tray names them.
plan_runs matches each name to main's subagent chat of that title (session.py mirrors each Agent call of main's as an
agent chat titled by its description) and gives its state, its latest event and how long it has run, which the card
shows under the step while it runs (GET /ws/{c}/cards/{id}/plan-runs).
"""
from __future__ import annotations

import builtins
import difflib
import json
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException

from . import config, notebook

router = APIRouter()

SUBAGENT_ROLE = "subagent"  # session.SUBAGENT_ROLE: the role of the agent chat of each of main's Agent calls
LATEST_CHARS = 120  # of a run's latest event on its row
# the argument of a tool call its row names, first found first (a Bash command, a file, a search, a prompt)
CALL_ARGS = ("description", "command", "file_path", "path", "pattern", "query", "url", "prompt", "card", "ref")
# the fields of a step an edit may leave out, which a matched step then keeps (merge_steps)
KEPT_FIELDS = ("makes", "status", "note", "details", "runs", "time")
REMOVED = "removed_steps"  # a plan payload's ids of the steps edits removed (removed_ids)
_WORD = re.compile(r"[^\W_]+")
LAST_EDIT = "last_edit"  # a plan payload's marks of what its last edit changed (edit_marks)
# the fields of a step that say what the plan is, whose change the card marks; status, note, runs and time are progress
MARKED_FIELDS = ("text", "makes", "details")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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


def _text_key(v: Any) -> str:
    return " ".join(str(v or "").split()).casefold()


def likeness(a: Any, b: Any) -> float:
    """How alike two steps' texts read, 0 to 1: the share of their words in the same order (difflib's ratio over the
    words, case and punctuation aside)."""
    wa, wb = _WORD.findall(str(a or "").casefold()), _WORD.findall(str(b or "").casefold())
    if not wa or not wb:
        return 0.0
    return difflib.SequenceMatcher(None, wa, wb, autojunk=False).ratio()


def match_steps(old: "builtins.list[dict]", new: "builtins.list[dict]") -> "builtins.list[int | None]":
    """For each new step, the index of the old step it replaces, or None for a new one: by the `id` it gives, else by
    the same text at its place, else by the same text anywhere, else by an old step left between the old steps of the
    matched new steps before and after it, the most alike pairs first (likeness), then in order. So a step put in
    between two kept steps is new, a step reworded in place is the same, and a step put before a reworded one is new
    rather than taking its place; each old step matched once."""
    out: builtins.list[int | None] = [None] * len(new)
    used: set[int] = set()
    by_id = {str(s.get("id")): i for i, s in enumerate(old) if s.get("id")}

    def take(i: int, j: int | None) -> None:
        if j is not None and j not in used:
            out[i] = j
            used.add(j)

    for i, s in enumerate(new):  # the ids it gives
        if s.get("id") not in (None, ""):
            take(i, by_id.get(str(s["id"])))
    for i, s in enumerate(new):  # the same text at its place
        if out[i] is None and i < len(old) and _text_key(old[i].get("text")) == _text_key(s.get("text")):
            take(i, i)
    for i, s in enumerate(new):  # the same text elsewhere, as when a step was put before it
        if out[i] is None:
            take(i, next((j for j, o in enumerate(old)
                          if j not in used and _text_key(o.get("text")) == _text_key(s.get("text"))), None))

    def window(i: int) -> range:  # the old steps between those of the matched new steps around new step i
        lo = max((j for j in out[:i] if j is not None), default=-1)
        hi = min((j for j in out[i + 1:] if j is not None), default=len(old))
        return range(lo + 1, hi)

    # reworded: an old step left between the matched steps around it, the most alike pairs first, then in order
    alike = sorted(((likeness(o.get("text"), s.get("text")), i, j) for i, s in enumerate(new) if out[i] is None
                    for j, o in enumerate(old) if j not in used), key=lambda t: -t[0])
    for _, i, j in alike:
        if out[i] is None and j not in used and j in window(i):
            take(i, j)
    return out


def merge_steps(old: "builtins.list[dict]", new: "builtins.list[dict]", now: str | None = None,
                removed: "builtins.list[str] | tuple[str, ...]" = ()) -> "builtins.list[dict]":
    """A plan's steps after an edit that replaces them with `new` (each {text, makes, status, note, details, runs,
    time, id?} as add_card's or edit_card's `steps` give it), every step whole (notebook.plan_step_of). A step matched
    to an old one (match_steps) keeps its id, the fields it leaves out, and its status, `started` and `ended` while its
    text is unchanged or it names its id; a status that changes is stamped from there (stamp). A new step gets the id
    it gives when no step had it, else the next free s<n>, never the id of a step before it or one `removed` before
    (removed_ids), so a comment on a removed step stays off the new one; its status, unless not started, is stamped as
    a change from not started."""
    now = now or _now()
    olds = [notebook.plan_step_of(s, str(s.get("id") or "")) for s in old if isinstance(s, dict)]
    pairs = match_steps(olds, new)
    taken = {o["id"] for o in olds if o["id"]} | {str(x) for x in removed}
    out: builtins.list[dict] = []
    n = 0
    for given, j in zip(new, pairs):
        prev = olds[j] if j is not None else None
        own = str(given.get("id") or "")
        if prev is not None and prev["id"]:
            sid = prev["id"]
        elif own and notebook.ID_RE.match(own) and own not in taken:
            sid = own
        else:
            n += 1
            while f"{notebook.STEP_ID_PREFIX}{n}" in taken:
                n += 1
            sid = f"{notebook.STEP_ID_PREFIX}{n}"
        taken.add(sid)
        fields = {k: given[k] for k in ("text", *KEPT_FIELDS) if k in given}
        if prev is not None:
            fields = {**{k: prev[k] for k in KEPT_FIELDS}, **fields}
        step = notebook.plan_step_of({k: v for k, v in fields.items() if k != "status"}, sid)
        if prev is not None and (_text_key(prev["text"]) == _text_key(step["text"]) or own == prev["id"]):
            step.update(status=prev["status"], started=prev["started"], ended=prev["ended"])
        word = notebook.plan_status_of(fields.get("status"))
        if word is not None and word != step["status"]:
            stamp(step, word, now)
        out.append(step)
    return out


def removed_ids(payload: dict | None, steps: "builtins.list[dict]") -> "builtins.list[str]":
    """The ids of a plan's steps that edits removed, the payload's REMOVED with those of its steps before an edit that
    `steps` (the steps after it) no longer has, which no new step takes (merge_steps)."""
    p = payload if isinstance(payload, dict) else {}
    before = [str(x) for x in p.get(REMOVED) or [] if str(x)]
    before += [str(s.get("id")) for s in notebook.plan_steps_of(p.get("steps")) if s.get("id")]
    now = {str(s.get("id")) for s in steps}
    return sorted({x for x in before if x not in now})


def edit_marks(old: "builtins.list[dict]", new: "builtins.list[dict]", now: str | None = None) -> dict | None:
    """What an edit changed in a plan, for the card to mark: {ts, steps: {id: {new: true} | {changed: [field, ...]}}},
    where a changed step names the MARKED_FIELDS the edit changed; a step it removed leaves no mark. The steps match by
    id, as merge_steps leaves them. None when the edit changed none of them and removed no step, as when it changed only
    statuses, notes or runs."""
    by_id = {str(s.get("id")): s for s in old}
    steps: dict[str, dict] = {}
    for s in new:
        was = by_id.get(str(s.get("id")))
        if was is None:
            steps[str(s["id"])] = {"new": True}
        elif changed := [k for k in MARKED_FIELDS if was.get(k) != s.get(k)]:
            steps[str(s["id"])] = {"changed": changed}
    kept = {str(s.get("id")) for s in new}
    if not steps and all(str(s.get("id")) in kept for s in old):
        return None
    return {"ts": now or _now(), "steps": steps}


def marks_after(payload: dict | None, old: "builtins.list[dict]", new: "builtins.list[dict]") -> dict | None:
    """A plan's marks after an edit from steps `old` to `new`: the edit's own (edit_marks) when it changed the plan, None
    when that change marks no step (it only removed steps), else the marks the payload held, so an edit of progress alone
    (a status, a note, runs) leaves the analyst's view of the last change; ids of steps gone since are dropped."""
    if (marks := edit_marks(old, new)) is not None:
        return marks if marks["steps"] else None
    held = (payload or {}).get(LAST_EDIT) if isinstance(payload, dict) else None
    if not isinstance(held, dict):
        return None
    ids = {str(s.get("id")) for s in new}
    steps = {k: v for k, v in (held.get("steps") or {}).items() if k in ids} if isinstance(held.get("steps"), dict) else {}
    return {"ts": held.get("ts"), "steps": steps} if steps else None


def restored_payload(held: dict | None, version: dict | None) -> dict:
    """A plan's payload when the analyst restores an earlier version of it (notebook.restore_version): that version's
    steps as they were, their ids, statuses and clocks with them; the plan's `follows` as it is now; the ids of the steps
    it no longer has kept (removed_ids); and its steps marked against the steps it has now (marks_after), as any edit
    that changes the plan marks them."""
    p = held if isinstance(held, dict) else {}
    old = notebook.plan_steps_of(p.get("steps"))
    steps = notebook.plan_steps_of((version or {}).get("steps") if isinstance(version, dict) else None)
    payload: dict[str, Any] = {"steps": steps, "follows": p.get("follows")}
    if removed := removed_ids(p, steps):
        payload[REMOVED] = removed
    if marks := marks_after(p, old, steps):
        payload[LAST_EDIT] = marks
    return payload


def clear_edit(c: str, cid: str) -> bool:
    """Take off plan `cid`'s marks of its last edit, as the analyst's Clear marks does: whether it had any. 404 for a
    card that is not a plan."""
    cell = notebook.get_cell(c, cid)
    if cell is None or cell.get("kind") != notebook.PLAN_KIND:
        raise HTTPException(404, f"no plan card {cid}")
    return notebook.drop_payload_key(c, cid, LAST_EDIT)


@router.post("/ws/{c}/cards/{cell_id}/plan-edit/clear")
def clear_edit_route(c: str, cell_id: str) -> dict:
    """Clear marks on a plan card (clear_edit)."""
    try:
        config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"cleared": clear_edit(c, cell_id)}


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
