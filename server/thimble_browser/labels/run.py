"""Running a label over its scope: one run at a time per label, in the background, its record (`RUNS`) read by the
page while it goes (GET /concepts, GET /concepts/{id}: `run`) and its rows written as they come, so the marks, the
counts and the card fill in during the run.

- prompt: the records go to the model in batches (classify.batches), CONCURRENCY calls at once, each with the same
  system prompt so the calls after the first read it from the cache, and structured JSON answers.
- regex: Python's re searches each unit's text; a unit that matches takes the first value, any other the second.
- code: the label's `label(unit)` runs in the sandbox (code_runner.py through cards/sandbox.run_script), CODE_CHUNK units
  per run of it.

Stopping a run (cancel(), or the chat's Stop while apply_label waits on it) keeps the rows written so far.
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
from pathlib import Path
from typing import Any

import anthropic

from .. import home, llm
from ..cards import sandbox
from . import classify, store, units as units_mod

log = logging.getLogger("thimble_browser.labels")

CONCURRENCY = 10  # model calls a prompt label makes at once
CODE_CHUNK = 5_000  # units per sandbox run of a code label
CODE_TIMEOUT_S = 120.0
REGEX_CHUNK = 2_000
PROGRESS_S = 0.5  # the page hears of a run's progress at most this often
MESSAGES_KEPT = 3

RUNS: dict[tuple[str, str], dict[str, Any]] = {}  # (workspace, label id) -> the run record, the last one kept
TASKS: dict[tuple[str, str], asyncio.Task] = {}
SETTINGS: dict[str, Any] = {"unsandboxed": False}


def running(ws: str, cid: str) -> bool:
    t = TASKS.get((ws, cid))
    return t is not None and not t.done()


def record(ws: str, cid: str) -> dict[str, Any] | None:
    return RUNS.get((ws, cid))


class _Progress:
    """Tells the page a run moved on, at most every PROGRESS_S."""

    def __init__(self, ws: str, cid: str) -> None:
        self.ws, self.cid, self.last = ws, cid, 0.0
        self.pending: asyncio.TimerHandle | None = None

    def __call__(self) -> None:
        now = time.monotonic()
        if now - self.last >= PROGRESS_S:
            self.last = now
            store.notify(self.ws, self.cid, "progress")
        elif self.pending is None:
            def fire() -> None:
                self.pending = None
                self.last = time.monotonic()
                store.notify(self.ws, self.cid, "progress")
            self.pending = asyncio.get_running_loop().call_later(PROGRESS_S, fire)

    def close(self) -> None:
        if self.pending is not None:
            self.pending.cancel()


def scope_units(ws: str, folder: Path, concept: dict[str, Any], paths: list[str], limit: int | None) -> list[Any]:
    """The units a run labels: the scope's, those another label gave a value when the label is `within` it, and with a
    `limit` that many spread over the files."""
    got = units_mod.units_of(ws, folder, concept["unit"], paths)
    within = concept.get("within")
    if within:
        rows = store.merged(ws, within["label"])
        got = [u for u in got if (r := rows.get(u.ref)) is not None and store.effective(r) == within["value"]]
    if limit:
        got = units_mod.sample(got, limit)
    return got


async def start(ws: str, folder: Path, concept: dict[str, Any], *, paths: list[str], limit: int | None = None,
                created_by: str = "user") -> dict[str, Any]:
    """Start a run of the label over `paths` (its glob for files); its record. LabelError when one runs already, or the
    scope has no units."""
    key = (ws, concept["id"])
    if running(ws, concept["id"]):
        raise store.LabelError(f"the label {concept['name']} is running already")
    found = await asyncio.to_thread(scope_units, ws, folder, concept, paths, limit)
    if not found:
        where = {"cell": "the canvas has no cards", "span": "the report has no sentences"}.get(
            concept["unit"], f"{', '.join(paths) or 'its glob'} matches no file with records")
        raise store.LabelError(f"nothing to label: {where}")
    if concept["kind"] == "regex":
        try:
            re.compile(concept["spec"])
        except re.error as e:
            raise store.LabelError(f"the pattern is not a regular expression: {e}") from None
    rec = {"run_id": secrets.token_hex(4), "status": "running", "started": home.now(), "created_by": created_by,
           "paths": list(paths), "limit": limit, "total": len(found), "matched_total": len(found), "done": 0,
           "labeled": 0, "failed": 0, "matches": 0, "message": None, "examples": 0, "version": concept["version"],
           "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "calls": 0}}
    await asyncio.to_thread(store.clear_model_rows, ws, concept["id"])
    RUNS[key] = rec
    TASKS[key] = asyncio.create_task(_run(ws, folder, concept, found, rec))
    store.notify(ws, concept["id"], "applying")
    return rec


async def wait(ws: str, cid: str, timeout: float | None = None) -> dict[str, Any] | None:
    """The run's record once it ends, or as it stands after `timeout` seconds."""
    t = TASKS.get((ws, cid))
    if t is not None and not t.done():
        try:
            await asyncio.wait_for(asyncio.shield(t), timeout)
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            if t.done():  # the run itself was stopped
                pass
            else:
                raise
    return RUNS.get((ws, cid))


async def cancel(ws: str, cid: str) -> bool:
    t = TASKS.get((ws, cid))
    if t is None or t.done():
        return False
    t.cancel()
    try:
        await t
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    return True


def _note(rec: dict[str, Any], why: str) -> None:
    msgs = rec.setdefault("_messages", [])
    if why and why not in msgs and len(msgs) < MESSAGES_KEPT:
        msgs.append(why)


async def _run(ws: str, folder: Path, concept: dict[str, Any], found: list[Any], rec: dict[str, Any]) -> None:
    progress = _Progress(ws, concept["id"])
    stopped = False
    try:
        if concept["kind"] == "prompt":
            await _prompt(ws, concept, found, rec, progress)
        elif concept["kind"] == "regex":
            await _regex(ws, concept, found, rec, progress)
        else:
            await _code(ws, folder, concept, found, rec, progress)
        rec["status"] = "done"
    except asyncio.CancelledError:
        stopped = True
        rec["status"] = "done"
        rec["stopped"] = True
        _note(rec, f"stopped after {rec['done']:,} of {rec['total']:,}")
    except Exception as e:  # noqa: BLE001 — a run's failure is its record's message
        log.warning("label run failed: %s", type(e).__name__)
        rec["status"] = "error"
        _note(rec, str(e) or type(e).__name__)
    finally:
        progress.close()
        rec["message"] = "; ".join(rec.pop("_messages", [])) or None
        rec["ended"] = home.now()
        _finish(ws, concept["id"], rec)
    if stopped:
        raise asyncio.CancelledError


def _finish(ws: str, cid: str, rec: dict[str, Any]) -> None:
    """Keep the run on the label, with its counts for card code (label_stats), and tell the page."""
    concept = store.read(ws, cid)
    if concept is None:  # deleted while it ran
        return
    st = store.stats(ws, cid)
    p = store.rows_path(ws, cid)
    try:
        key = [p.stat().st_size, p.stat().st_mtime_ns]
    except OSError:
        key = [0, 0]
    concept["label_stats"] = {"key": key, **st}
    app = {k: rec.get(k) for k in ("total", "matched_total", "labeled", "failed", "status", "message", "created_by",
                                   "matches", "limit", "stopped")}
    app.update(ts=rec["started"], paths=rec.get("paths") or [], version=concept["version"])
    concept["applications"] = [*concept["applications"], app][-store.APPLICATIONS_KEPT:]
    if rec.get("limit") is None and rec["status"] == "done" and not rec.get("stopped"):
        concept["trial"] = False
    elif rec.get("limit") is not None and len(concept["applications"]) == 1:
        concept["trial"] = True
    store.note_change(concept, "ran", f"ran over {rec.get('total') or 0:,} units")
    store.write(ws, concept)
    store.notify(ws, cid, "ran")


def _row(u: Any, value: str, confidence: float | None, source: str, **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {"ref": u.ref, "label": value, "confidence": confidence, "source": source, "ts": home.now()}
    if u.line is not None:
        row["line"] = u.line
    row.update({k: v for k, v in extra.items() if v})
    return row


def _count(rec: dict[str, Any], concept: dict[str, Any], rows: list[dict[str, Any]], n_done: int, n_failed: int) -> None:
    rec["done"] += n_done
    rec["labeled"] += len(rows)
    rec["failed"] += n_failed
    rec["matches"] += sum(1 for r in rows if r["label"] == concept["labels"][0])


# ---- prompt

async def _call(concept: dict[str, Any], system: str, user: str, rec: dict[str, Any]) -> str | None:
    """One classifier call: the reply's text, or None when Claude declined it."""
    args = llm.request_args(effort=classify.EFFORT, model=concept.get("model") or classify.MODEL)
    args["output_config"] = {**args["output_config"],
                             "format": {"type": "json_schema", "schema": classify.schema(concept)}}
    msg = await llm.client().beta.messages.create(
        max_tokens=classify.MAX_TOKENS, system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}], **args)
    u = rec["usage"]
    u["calls"] += 1
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens"):
        u[k] += int(getattr(msg.usage, k, 0) or 0)
    if msg.stop_reason == "refusal":
        return None
    return "".join(b.text for b in msg.content if b.type == "text")


async def _prompt(ws: str, concept: dict[str, Any], found: list[Any], rec: dict[str, Any], progress: _Progress) -> None:
    system = classify.system_prompt(concept)
    sem = asyncio.Semaphore(CONCURRENCY)
    values = concept["labels"]
    cut = sum(1 for u in found if u.extra.get("cut"))
    if cut:
        _note(rec, f"read {cut:,} {'unit' if cut == 1 else 'units'} only in part, as {'it is' if cut == 1 else 'they are'}"
                   f" longer than {units_mod.WHOLE_CHARS:,} characters")

    async def one(batch: list[Any]) -> None:
        async with sem:
            try:
                reply = await _call(concept, system, classify.records_text([u.text for u in batch]), rec)
            except (anthropic.APIError, llm.NoCredentials) as e:
                why = llm.failure(e)
                _note(rec, why)
                _count(rec, concept, [], len(batch), len(batch))
                progress()
                return
            if reply is None:
                _note(rec, "Claude declined to judge some records")
                _count(rec, concept, [], len(batch), len(batch))
                progress()
                return
            got, failed = classify.answers(reply, len(batch), values)
            for why in list(dict.fromkeys(failed.values()))[:1]:
                _note(rec, why)
            rows = [_row(batch[k], a["value"], a["confidence"], "prompt", rationale=a.get("reason"))
                    for k, a in sorted(got.items())]
            await asyncio.to_thread(store.append_rows, ws, concept["id"], rows)
            _count(rec, concept, rows, len(batch), len(failed))
            progress()

    await asyncio.gather(*(one(b) for b in classify.batches(found)))
    if rec["labeled"] == 0 and rec["failed"]:
        raise RuntimeError(rec.get("_messages", ["no record got a value"])[0])


# ---- regex

def _regex_rows(concept: dict[str, Any], rx: re.Pattern, chunk: list[Any]) -> list[dict[str, Any]]:
    values = concept["labels"]
    other = values[1] if len(values) > 1 else None
    rows = []
    for u in chunk:
        m = rx.search(u.text[:units_mod.WHOLE_CHARS])
        if m:
            span = m.group(0)
            rows.append(_row(u, values[0], 1.0, "regex", spans=[span[:500]] if span.strip() else None))
        elif other is not None:
            rows.append(_row(u, other, 1.0, "regex"))
    return rows


async def _regex(ws: str, concept: dict[str, Any], found: list[Any], rec: dict[str, Any], progress: _Progress) -> None:
    rx = re.compile(concept["spec"])
    for i in range(0, len(found), REGEX_CHUNK):
        chunk = found[i:i + REGEX_CHUNK]
        rows = await asyncio.to_thread(_regex_rows, concept, rx, chunk)
        await asyncio.to_thread(store.append_rows, ws, concept["id"], rows)
        _count(rec, concept, rows, len(chunk), 0)
        progress()


# ---- code

RUNNER = Path(__file__).resolve().with_name("code_runner.py")


def _value(v: Any, values: list[str]) -> str:
    if isinstance(v, bool):
        return values[0] if v else (values[1] if len(values) > 1 else "no")
    s = " ".join(str(v).split())
    return next((x for x in values if x.lower() == s.lower()), s)


async def _code(ws: str, folder: Path, concept: dict[str, Any], found: list[Any], rec: dict[str, Any],
                progress: _Progress) -> None:
    values = concept["labels"]
    for i in range(0, len(found), CODE_CHUNK):
        chunk = found[i:i + CODE_CHUNK]
        req = {"code": concept["spec"], "units": [u.value for u in chunk], "timeout": CODE_TIMEOUT_S}
        res = await sandbox.run_script(RUNNER, req, folder, timeout=CODE_TIMEOUT_S, unsandboxed=SETTINGS["unsandboxed"])
        if res.get("status") == "error" and "rows" not in res:  # the sandbox could not run it
            raise RuntimeError(str(res.get("error") or "the label's code could not run"))
        rows, failed = [], 0
        for entry in res.get("rows") or []:
            k = int(entry[0])
            if entry[1] is None:
                failed += 1
                _note(rec, f"{chunk[k].ref}: {entry[4] if len(entry) > 4 else 'no value'}")
                continue
            rows.append(_row(chunk[k], _value(entry[1], values), entry[2], "code", spans=entry[3]))
        await asyncio.to_thread(store.append_rows, ws, concept["id"], rows)
        _count(rec, concept, rows, len(chunk), failed)
        progress()
        if res.get("error"):
            raise RuntimeError(f"the label's code failed: {res['error']}")
