"""User-action telemetry and its export.

POST /ws/{c}/telemetry takes one record or an array of at most BATCH_MAX: {kind, target?, target_kind?, detail?,
duration_ms?, ts?, seq?, session?}, `kind` one of KINDS; one bad row rejects the batch (400). Rows land fsync'd in
workspaces/<c>/telemetry.jsonl with the server's ts, the log's own `seq`, `boot` and the browser's `client_seq`, so
lost rows show as gaps (`gaps()`). The server records locks and lock refusals itself (note).

GET /ws/{c}/telemetry/export?form=standard|anonymized&format=jsonl|csv merges telemetry.jsonl, the view log and the
workspace events that are user actions, in time order, as {ts, actor, kind, target, target_kind, detail, duration_ms,
session, source}. The anonymized form keeps relative ms timestamps, vocabulary tokens (else `other`), targets hashed
with a per-export salt, session indices, and only {length, has_numbers} of a detail's text."""
from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import logging
import math
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Header, HTTPException, Response

from . import config, ledger

log = logging.getLogger("thimble.telemetry")
router = APIRouter()

LOG_NAME = "telemetry.jsonl"
EVENTS_PATH = ("investigations", "main", "events.jsonl")
ACTOR = "analyst"
DETAIL_MAX = 2048
TARGET_MAX = 512
BATCH_MAX = 500
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
VOCAB_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
SCHEMA = ("ts", "actor", "kind", "target", "target_kind", "detail", "duration_ms", "session", "source")
FORMS = ("standard", "anonymized")
FORMATS = ("jsonl", "csv")
ACTOR_ROLES = ("analyst", "claude", "system", "model")
OTHER = "other"

# The UI actions the browser posts. A kind outside this list is a 400, so the export's `kind` stays a closed
# vocabulary the anonymized form can keep.
KINDS = frozenset({
    # the page and the workspace
    "page-load", "page-unload", "visibility", "corpus-switch",
    # the surfaces: the chat and the three center tabs
    "panel-open", "panel-close", "tab-activate",
    # the chat: the Start card, agent rows, chips, the ⌘ pointer, threads
    "start-toggle", "start-run", "agent-row-expand", "chip-teleport", "pointer-open", "pointer-send",
    "chat-open", "chat-interrupt", "chat-settings", "thread-open", "thread-switch", "thread-fold", "thread-rename", "thread-delete",
    "thread-ask-again", "chat-retry",
    "ask-send",
    # files
    "file-close", "file-save", "search", "reader-find", "view-open", "view-build", "view-dismiss", "concept-layer",
    # the canvas: cards and groups
    "card-run", "card-code-toggle", "card-fold",
    "cell-add", "cell-run", "cell-edit", "cell-delete", "takeaway-edit", "prompt-cell", "kernel-restart",
    "notebook-create", "notebook-rename", "notebook-delete", "notebook-switch",
    # labels and filters
    "label-edit", "label-delete", "label-calibrate", "label-refine", "label-apply", "label-cancel",
    "filter-set", "filter-clear",
    # documents: the frame, the report, story, slides, custom types
    "report-open", "report-close", "report-edit", "report-tag", "report-fix", "report-revise", "report-generate",
    "report-drag-cell", "report-frame-edit", "rewrite-span",
    "report-type-create", "report-type-edit", "report-type-delete",
    # comments on report units
    "comment-add", "comment-reply", "comment-dismiss", "comment-reopen", "comment-incorporate",
    # tickets
    "dev-dismiss",
    # the generic UI stream: a click on an interactive element the kinds above did not name, and a text selection
    "ui-click", "ui-select",
    # misc
    "undo", "error",
    # locks: the analyst locking or unlocking a card or a report block, and a model's change that a lock refused; the
    # server
    # records these itself (note)
    "lock", "unlock", "lock-refused",
})

TARGET_KINDS = frozenset({
    "file", "dir", "cell", "group", "notebook", "chat", "thread", "concept", "report", "sentence", "section",
    "comment", "panel", "orient", "ticket", "view", "search", "workspace", "ui", OTHER,
})
# a card's ref reads as the kind `cell` by either prefix (cite.CARD_PREFIXES)
_PREFIX_KIND = {
    "cell": "cell", "card": "cell", "group": "group", "chat": "chat", "concept": "concept", "thread": "thread", "report": "report",
    "doc": "report", "type": "report", "sentence": "sentence", "section": "section", "comment": "comment",
    "panel": "panel", "notebook": "notebook", "file": "file", "dir": "dir", "orient": "orient", "ticket": "ticket",
    "view": "view", "workspace": "workspace", "ui": "ui",
}

# events.jsonl records that are user actions or their direct outcomes: status -> (kind, actor)
_ORIENT_EVENTS = {"started": ("orient-start", "analyst"), "stopped": ("orient-stop", "analyst"),
                  "done": ("orient-done", "system"), "failed": ("orient-failed", "system")}
_REPORT_EVENTS = {"generating": ("report-request", None), "generated": ("report-generated", "system"),
                  "failed": ("report-failed", "system")}
_TICKET_STATUSES = ("queued",)
_VIEW_STATUSES = ("building",)


# ----------------------------------------------------------------------------- helpers


def _ws(c: str) -> Path:
    try:
        return config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


def log_path(c: str) -> Path:
    return config.workspace_dir(c) / LOG_NAME


def parse_ts(ts: Any) -> datetime | None:
    if not isinstance(ts, str) or not ts:
        return None
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _read_jsonl(path: Path) -> list[dict]:
    out: list[dict] = []
    if not path.is_file():
        return out
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                out.append(rec)
    return out


def target_kind_of(target: Any) -> str | None:
    """The closed-vocabulary kind of a target from its prefix; a ref without a known prefix names a file."""
    s = str(target or "").strip()
    if not s:
        return None
    head, sep, _rest = s.partition(":")
    if sep and head in _PREFIX_KIND:
        return _PREFIX_KIND[head]
    if "#" in s or "/" in s or "." in s:
        return "file"
    return OTHER


def _row(ts: Any, actor: str, kind: str, target: Any, target_kind: str | None, detail: dict | None,
         duration_ms: Any, session: Any, source: str) -> dict:
    return {"ts": ts, "actor": actor, "kind": kind, "target": target if target not in ("", None) else None,
            "target_kind": target_kind, "detail": detail or None,
            "duration_ms": duration_ms if isinstance(duration_ms, (int, float)) and not isinstance(duration_ms, bool) else None,
            "session": session or None, "source": source}


# ----------------------------------------------------------------------------- the store


def _validate(rec: Any, header_session: str | None) -> dict:
    """One posted record as the stored row (minus the server stamps); HTTPException 400 with the reason."""
    if not isinstance(rec, dict):
        raise HTTPException(400, "each telemetry record must be a JSON object")
    kind = str(rec.get("kind") or "").strip()
    if kind not in KINDS:
        raise HTTPException(400, f"unknown telemetry kind {kind!r}")
    target = rec.get("target")
    if target is not None:
        if not isinstance(target, str):
            raise HTTPException(400, "target must be a string")
        target = target.strip() or None
        if target and len(target) > TARGET_MAX:
            raise HTTPException(400, f"target longer than {TARGET_MAX} chars")
    tk = rec.get("target_kind")
    if tk is not None:
        if tk not in TARGET_KINDS:
            raise HTTPException(400, f"target_kind must be one of {', '.join(sorted(TARGET_KINDS))}")
    else:
        tk = target_kind_of(target)
    detail = rec.get("detail")
    if detail is not None:
        if not isinstance(detail, dict):
            raise HTTPException(400, "detail must be a JSON object")
        try:
            size = len(json.dumps(detail, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError):
            raise HTTPException(400, "detail is not JSON-serialisable")
        if size > DETAIL_MAX:
            raise HTTPException(400, f"detail is {size} bytes; at most {DETAIL_MAX}")
        if not detail:
            detail = None
    dur = rec.get("duration_ms")
    if dur is not None:
        if isinstance(dur, bool) or not isinstance(dur, (int, float)) or not math.isfinite(dur) or dur < 0:
            raise HTTPException(400, "duration_ms must be a non-negative number")
        dur = int(round(dur))
    session = rec.get("session") or header_session
    if session is not None:
        session = str(session).strip()
        if not SESSION_RE.match(session):
            raise HTTPException(400, "session must match [A-Za-z0-9_-]{1,64}")
    client_ts = rec.get("ts")
    if client_ts is not None and parse_ts(client_ts) is None:
        raise HTTPException(400, f"ts must be an ISO timestamp, got {client_ts!r}")
    cseq = rec.get("seq")
    if cseq is not None and (isinstance(cseq, bool) or not isinstance(cseq, int) or cseq < 0):
        raise HTTPException(400, "seq must be a non-negative integer")
    row: dict[str, Any] = {"actor": ACTOR, "session": session, "kind": kind, "target": target, "target_kind": tk,
                           "detail": detail, "duration_ms": dur}
    if cseq is not None:
        row["client_seq"] = cseq
    if client_ts is not None:
        row["client_ts"] = client_ts
    return row


def record(c: str, rows: list[dict]) -> int:
    """Append validated rows with the server's ts, the log's `seq` and the process's `boot`; a torn tail is
    terminated first and the batch is fsync'd. The count. 404 for an unknown corpus."""
    p = _ws(c) / LOG_NAME
    if not rows:
        return 0
    now = ledger.now_iso()
    with ledger.seq_lock(p):
        ledger.heal_tail(p)
        first = ledger.next_seq(p, len(rows))
        return ledger.append_jsonl_many(p, ({"ts": now, "seq": first + i, "boot": ledger.BOOT_ID, **r} for i, r in enumerate(rows)),
                                        sync=True)


def note(c: str, kind: str, target: str, *, actor: str = ACTOR, detail: dict | None = None) -> None:
    """One row the server records itself, for an action the browser does not report on its own (a lock, a model's
    change a lock refused), under `actor` (a role word, so the anonymized form keeps it). A failure is logged and
    swallowed, since telemetry never stops the action it records."""
    if kind not in KINDS:
        raise ValueError(f"unknown telemetry kind {kind!r}")
    row = {"actor": actor, "session": None, "kind": kind, "target": target, "target_kind": target_kind_of(target),
           "detail": detail or None, "duration_ms": None}
    try:
        record(c, [row])
    except Exception:  # noqa: BLE001
        log.exception("telemetry: %s on %s not recorded", kind, target)


def gaps(ws: Path) -> dict[str, Any]:
    """What telemetry.jsonl's sequence numbers show: `boots` (one entry per server process, first-seen order),
    `server_gaps` ([after, before] pairs where a stored seq does not follow the previous), `client_gaps` (per browser
    session, where client_seq skips) and `unparseable` (lines that are not JSON)."""
    boots: dict[str, dict[str, Any]] = {}
    server_gaps: list[list[int]] = []
    client_gaps: dict[str, list[list[int]]] = {}
    last_client: dict[str, int] = {}
    prev_seq: int | None = None
    bad = 0
    p = ws / LOG_NAME
    try:
        lines = p.read_text("utf-8").splitlines()
    except OSError:
        lines = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            bad += 1
            continue
        if not isinstance(r, dict):
            bad += 1
            continue
        seq, boot, ts = r.get("seq"), r.get("boot"), r.get("ts")
        if isinstance(seq, int) and not isinstance(seq, bool):
            if prev_seq is not None and seq > prev_seq + 1:
                server_gaps.append([prev_seq, seq])
            prev_seq = seq if prev_seq is None else max(prev_seq, seq)
        b = str(boot) if boot else "-"
        entry = boots.setdefault(b, {"boot": b, "rows": 0, "first_seq": seq, "last_seq": seq, "first_ts": ts, "last_ts": ts})
        entry["rows"] += 1
        if isinstance(seq, int):
            entry["first_seq"] = seq if entry["first_seq"] is None else min(entry["first_seq"], seq)
            entry["last_seq"] = seq if entry["last_seq"] is None else max(entry["last_seq"], seq)
        entry["last_ts"] = ts
        sess, cseq = r.get("session"), r.get("client_seq")
        if sess and isinstance(cseq, int) and not isinstance(cseq, bool):
            sess = str(sess)
            last = last_client.get(sess)
            if last is not None and cseq > last + 1:
                client_gaps.setdefault(sess, []).append([last, cseq])
            last_client[sess] = cseq if last is None else max(last, cseq)
    return {"boots": list(boots.values()), "server_gaps": server_gaps, "client_gaps": client_gaps, "unparseable": bad}


@router.post("/ws/{c}/telemetry", status_code=201)
async def post_telemetry(c: str, body: Any = Body(...), x_thimble_session: str | None = Header(default=None)) -> dict:
    """The browser's user actions: one record or an array of at most BATCH_MAX; all valid or 400."""
    records = body if isinstance(body, list) else [body]
    if not records:
        raise HTTPException(400, "empty telemetry batch")
    if len(records) > BATCH_MAX:
        raise HTTPException(400, f"telemetry batch of {len(records)} records; at most {BATCH_MAX}")
    rows = [_validate(r, x_thimble_session) for r in records]
    n = await asyncio.to_thread(record, c, rows)
    for r in rows:
        if r.get("kind") == "error":
            log_browser_error(c, r)
    return {"recorded": n}


BROWSER_ERRORS_PER_MIN = 20  # server.log lines for the browser's uncaught errors, per workspace and minute
_browser_errors: dict[str, list[float]] = {}
browser_log = logging.getLogger("thimble.browser")


def log_browser_error(c: str, row: dict) -> bool:
    """The browser's uncaught error in server.log too, where the doctor and a problem report find it; at most
    BROWSER_ERRORS_PER_MIN lines a minute per workspace."""
    now = time.monotonic()
    recent = [t for t in _browser_errors.get(c, []) if now - t < 60.0]
    if len(recent) >= BROWSER_ERRORS_PER_MIN:
        _browser_errors[c] = recent
        return False
    _browser_errors[c] = [*recent, now]
    detail = row.get("detail") if isinstance(row.get("detail"), dict) else {}
    text = str(detail.get("text") or row.get("target") or "?")[:500]
    browser_log.error("%s: browser error (session %s, at %s): %s", c, row.get("session") or "-", row.get("target") or "-",
                      text)
    return True


# ----------------------------------------------------------------------------- the export's sources


def _view_rows(c: str) -> list[dict]:
    from . import viewlog  # noqa: PLC0415

    out: list[dict] = []
    for r in viewlog.rows(c):
        kind = r.get("kind") if r.get("kind") in viewlog.KINDS else "file"
        detail = {k: r[k] for k in ("by", "tool") if r.get(k)}
        out.append(_row(r.get("ts"), str(r.get("actor") or OTHER), "view", r.get("path") or "", kind, detail, None, None, "view"))
    return out


def _telemetry_rows(ws: Path) -> list[dict]:
    out: list[dict] = []
    for r in _read_jsonl(ws / LOG_NAME):
        if not r.get("ts") or not r.get("kind"):
            continue
        detail = r.get("detail") if isinstance(r.get("detail"), dict) else None
        if r.get("client_ts"):
            detail = {**(detail or {}), "client_ts": r["client_ts"]}
        tk = r.get("target_kind") if r.get("target_kind") in TARGET_KINDS else target_kind_of(r.get("target"))
        out.append(_row(r["ts"], str(r.get("actor") or ACTOR), str(r["kind"]), r.get("target"), tk, detail,
                        r.get("duration_ms"), r.get("session"), "telemetry"))
    return out


def _event_rows(ws: Path) -> list[dict]:
    """The workspace events that are user actions or their direct outcomes; the rest of the stream is machinery."""
    out: list[dict] = []
    for ev in _read_jsonl(ws.joinpath(*EVENTS_PATH)):
        ts, t = ev.get("ts"), ev.get("type")
        if not ts:
            continue
        rest = {k: v for k, v in ev.items() if k not in ("ts", "seq", "type") and v not in (None, "", [])}
        if t == "orient":
            hit = _ORIENT_EVENTS.get(str(ev.get("status")))
            if hit is None:
                continue
            kind, actor = hit
            run = ev.get("run")
            out.append(_row(ts, actor, kind, f"orient:{run}" if run is not None else None, "orient", rest, None, None, "event"))
        elif t == "report":
            hit = _REPORT_EVENTS.get(str(ev.get("status")))
            if hit is None:
                continue
            kind, actor = hit
            actor = actor or (str(ev.get("by")) if ev.get("by") in ACTOR_ROLES else ACTOR)
            by = str(ev.get("by") or "")
            if kind == "report-generated" and (by == "terminal" or by.startswith("chat:")):
                actor = "model"  # a document a model wrote and saved itself (the write_document tool), not the server's writer
            slug = ev.get("slug")
            out.append(_row(ts, actor, kind, f"report:{slug}" if slug else None, "report", rest, None, None, "event"))
        elif t == "ticket":
            if str(ev.get("status")) not in _TICKET_STATUSES:
                continue
            tid = ev.get("id")
            out.append(_row(ts, ACTOR, "dev-ticket", f"ticket:{tid}" if tid else None, "ticket", rest, None, None, "event"))
        elif t == "filter":
            kind = "filter-set" if ev.get("concept") else "filter-clear"
            out.append(_row(ts, ACTOR, kind, f"concept:{ev['concept']}" if ev.get("concept") else None, "concept",
                            rest, None, None, "event"))
        elif t == "view":
            if str(ev.get("status")) not in _VIEW_STATUSES:
                continue
            slug = ev.get("slug")
            out.append(_row(ts, ACTOR, "view-build", f"view:{slug}" if slug else None, "view", rest, None, None, "event"))
    return out


def build_export(c: str) -> list[dict]:
    """Every row of every source, oldest first (same-instant rows keep source order: view, telemetry, event). A
    source that fails is logged and left out."""
    ws = _ws(c)
    rows: list[dict] = []
    for name, fn in (("view", lambda: _view_rows(c)), ("telemetry", lambda: _telemetry_rows(ws)), ("event", lambda: _event_rows(ws))):
        try:
            rows.extend(fn())
        except Exception:  # noqa: BLE001
            log.exception("telemetry export: %s failed", name)
    keyed: list[tuple[datetime, dict]] = []
    for r in rows:
        d = parse_ts(r.get("ts"))
        if d is not None:
            r["ts"] = _iso(d)
            keyed.append((d, r))
    keyed.sort(key=lambda kd: kd[0])
    return [r for _, r in keyed]


# ----------------------------------------------------------------------------- the anonymized form


def _free_text(row: dict) -> str | None:
    d = row.get("detail") if isinstance(row.get("detail"), dict) else {}
    t = d.get("text") if row.get("source") == "telemetry" else None
    return t if isinstance(t, str) and t else None


def _vocab(s: Any) -> str:
    s = str(s or "")
    return s if VOCAB_RE.match(s) else OTHER


def anonymize(rows: list[dict]) -> list[dict]:
    """The module docstring's anonymized form, over build_export's time-ordered rows."""
    salt = secrets.token_bytes(16)
    sessions: dict[str, int] = {}
    t0: datetime | None = None
    out: list[dict] = []
    for r in rows:
        d = parse_ts(r.get("ts"))
        if d is None:
            continue
        if t0 is None:
            t0 = d
        target = r.get("target")
        token = "h:" + hashlib.sha256(salt + str(target).encode("utf-8")).hexdigest()[:16] if target else None
        session = r.get("session")
        sidx: int | None = None
        if session:
            sidx = sessions.setdefault(str(session), len(sessions))
        text = _free_text(r)
        detail = {"length": len(text), "has_numbers": bool(re.search(r"\d", text))} if text is not None else None
        actor = str(r.get("actor") or "")
        out.append({"ts": int(round((d - t0).total_seconds() * 1000)), "actor": actor if actor in ACTOR_ROLES else OTHER,
                    "kind": _vocab(r.get("kind")), "target": token,
                    "target_kind": _vocab(r.get("target_kind")) if r.get("target_kind") else None,
                    "detail": detail, "duration_ms": r.get("duration_ms"), "session": sidx, "source": _vocab(r.get("source"))})
    return out


# ----------------------------------------------------------------------------- rendering


def to_jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps({k: r.get(k) for k in SCHEMA}, ensure_ascii=False) + "\n" for r in rows)


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(SCHEMA)
    for r in rows:
        w.writerow(["" if r.get(k) is None else (json.dumps(r[k], ensure_ascii=False) if k == "detail" else r[k]) for k in SCHEMA])
    return buf.getvalue()


@router.get("/ws/{c}/telemetry/export")
async def export_telemetry(c: str, form: str = "standard", format: str = "jsonl") -> Response:
    """The merged stream as a download, built in a worker thread."""
    form, format = (form or "").strip().lower(), (format or "").strip().lower()
    if form not in FORMS:
        raise HTTPException(400, f"form must be one of {', '.join(FORMS)}")
    if format not in FORMATS:
        raise HTTPException(400, f"format must be one of {', '.join(FORMATS)}")
    rows = await asyncio.to_thread(build_export, c)
    if form == "anonymized":
        rows = anonymize(rows)
    body = to_csv(rows) if format == "csv" else to_jsonl(rows)
    name = f"telemetry-anonymized.{format}" if form == "anonymized" else f"{c}-telemetry.{format}"
    media = "text/csv; charset=utf-8" if format == "csv" else "application/x-ndjson; charset=utf-8"
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})
