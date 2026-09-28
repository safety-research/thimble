"""The workspace export: one zip holding every usage record of a workspace.

GET /api/ws/{c}/export answers `<c>-thimble-export-<UTC stamp>.zip`, built in a worker thread; `python -m app.export
<workspace> [<out.zip>]` writes the same zip from a shell. export_readme.md beside this module describes each file and
ships in the zip as README.md with this export's numbers appended. manifest.json names every file with its size and
SHA-256 and lists the corpus's files by path, size and hash.

Left out: the corpus itself, the long tool results beside a transcript (listed in the manifest), views' caches, label
indexes, kernel state and notebooks' full-size output side files. A file still being written is copied up to its last
complete line as it stood when the copy began.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse

from . import canvas_history, config

log = logging.getLogger("thimble.export")
router = APIRouter()

SCHEMA = "thimble-workspace-export"
VERSION = 1
README_SOURCE = Path(__file__).with_name("export_readme.md")
CHUNK = 1 << 20
SID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
AGENT_FILE_RE = re.compile(r"^agent-([A-Za-z0-9]+)\.(jsonl|meta\.json)$")
# under a session's own directory: what the zip carries (transcripts, their metas, workflow journals and scripts)
SESSION_SUFFIXES = (".jsonl", ".json", ".js")
SKIPPED_DIRS = ("cache", "__pycache__")  # a view's cache: rebuilt from the corpus
SECRET_KEY_RE = re.compile(r"key|token|secret|password|credential", re.I)
_hash_cache: dict[tuple[str, int, int], str] = {}  # (abs path, size, mtime_ns) -> sha256 of a corpus file


# ----------------------------------------------------------------------------- small helpers


def _read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    """The whole-line JSON objects of a JSONL file; a torn or foreign line is skipped."""
    try:
        f = path.open(encoding="utf-8")
    except OSError:
        return
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                yield rec


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _parse_ts(v: Any) -> datetime | None:
    if not isinstance(v, str) or len(v) < 10:
        return None
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(d: datetime | None) -> str | None:
    return d.astimezone(timezone.utc).isoformat(timespec="milliseconds") if d else None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _corpus_hash(path: Path, size: int, mtime_ns: int) -> str:
    key = (str(path), size, mtime_ns)
    hit = _hash_cache.get(key)
    if hit is None:
        hit = _hash_cache[key] = sha256_file(path)
    return hit


def _stable_prefix(path: Path) -> bytes:
    """The file as it stood when the copy began, up to its last complete line."""
    size = path.stat().st_size
    with path.open("rb") as f:
        data = f.read(size)
    cut = data.rfind(b"\n")
    return data[: cut + 1] if cut >= 0 else b""


# ----------------------------------------------------------------------------- the zip writer


class Writer:
    """Writes entries into the zip and keeps what the manifest says of them: path, bytes, SHA-256, rows."""

    def __init__(self, zf: zipfile.ZipFile) -> None:
        self.zf = zf
        self.files: list[dict[str, Any]] = []
        self.omitted: list[dict[str, Any]] = []
        self.lo: datetime | None = None
        self.hi: datetime | None = None

    def note_ts(self, v: Any) -> None:
        d = _parse_ts(v)
        if d is None:
            return
        if self.lo is None or d < self.lo:
            self.lo = d
        if self.hi is None or d > self.hi:
            self.hi = d

    def _add(self, arc: str, data: bytes, rows: int | None = None) -> None:
        self.zf.writestr(arc, data)
        entry: dict[str, Any] = {"path": arc, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if rows is not None:
            entry["rows"] = rows
        self.files.append(entry)

    def jsonl(self, arc: str, rows: Iterable[dict[str, Any]], ts_keys: tuple[str, ...] = ("ts",)) -> int:
        lines: list[str] = []
        for r in rows:
            for k in ts_keys:
                self.note_ts(r.get(k))
            lines.append(json.dumps(r, ensure_ascii=False, separators=(",", ":"), default=str))
        self._add(arc, ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8"), rows=len(lines))
        return len(lines)

    def json(self, arc: str, obj: Any) -> None:
        self._add(arc, json.dumps(obj, ensure_ascii=False, indent=1, default=str).encode("utf-8"))

    def text(self, arc: str, text: str) -> None:
        self._add(arc, text.encode("utf-8"))

    def copy_jsonl(self, arc: str, src: Path, ts_keys: tuple[str, ...] = ("ts", "timestamp")) -> dict[str, Any]:
        """A JSONL file copied byte for byte up to its last whole line; {rows, first_ts, last_ts} of it."""
        data = _stable_prefix(src)
        rows, first, last = 0, None, None
        for line in data.splitlines():
            if not line.strip():
                continue
            rows += 1
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            for k in ts_keys:
                d = _parse_ts(rec.get(k))
                if d is not None:
                    self.note_ts(rec.get(k))
                    first = d if first is None or d < first else first
                    last = d if last is None or d > last else last
                    break
        self._add(arc, data, rows=rows)
        return {"rows": rows, "first_ts": _iso(first), "last_ts": _iso(last)}

    def copy(self, arc: str, src: Path) -> None:
        self._add(arc, src.read_bytes())

    def omit(self, rel: str, src: Path, why: str) -> None:
        try:
            self.omitted.append({"path": rel, "bytes": src.stat().st_size, "sha256": sha256_file(src), "why": why})
        except OSError:
            pass


# ----------------------------------------------------------------------------- the streams


def _telemetry(w: Writer, ws: Path) -> dict[str, int]:
    return {
        "telemetry/ui.jsonl": w.jsonl("telemetry/ui.jsonl", _read_jsonl(ws / "telemetry.jsonl")),
        "telemetry/files-opened.jsonl": w.jsonl("telemetry/files-opened.jsonl", _read_jsonl(ws / "viewed.jsonl")),
        "telemetry/events.jsonl": w.jsonl("telemetry/events.jsonl", _read_jsonl(ws / "investigations" / "main" / "events.jsonl")),
    }


def _chats(w: Writer, ws: Path) -> list[dict[str, Any]]:
    """Every chat's records as the browser showed them, and one index row per chat (its meta and where its log is)."""
    index: list[dict[str, Any]] = []
    d = ws / "chats"
    for folder, trashed in ((d, False), (d / "trash", True)):
        for meta_path in sorted(folder.glob("*.meta.json")):
            meta = _read_json(meta_path)
            if not isinstance(meta, dict):
                continue
            cid = str(meta.get("id") or meta_path.name[: -len(".meta.json")])
            log_path = folder / f"{cid}.jsonl"
            arc = f"chats/{'trash/' if trashed else ''}{cid}.jsonl"
            stats = w.copy_jsonl(arc, log_path, ("ts",)) if log_path.is_file() else {"rows": 0, "first_ts": None, "last_ts": None}
            w.note_ts(meta.get("created_at"))
            index.append({**meta, "log": arc if log_path.is_file() else None, "records": stats["rows"],
                          "first_ts": stats["first_ts"], "last_ts": stats["last_ts"], "trashed": trashed})
    w.jsonl("chats/index.jsonl", index, ("created_at",))
    return index


def _projects_roots(ws: Path) -> list[Path]:
    """Where Claude Code writes transcripts: the config dir of the workspace's attached session and the one this server
    serves, both read from the attaching process (config.process_claude_config), and this server's own. sessions.json's
    `config_dir` is not read, since a cell can write that file."""
    from . import session  # noqa: PLC0415 — session imports most of the app

    live = session.current(ws.name)
    dirs = [live.config_dir] if live is not None and live.config_known else []
    dirs += [config.claude_config_dir(), config.config_dir_of(config.own_claude_config())]
    return list(dict.fromkeys(d / "projects" for d in dirs))


def _own_file(p: Path, root: Path) -> bool:
    """A regular file that is no symlink and resolves inside `root` (as feedback._own_file)."""
    try:
        return p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(root.resolve())
    except (OSError, ValueError):
        return False


def _find_transcript(sid: str, roots: list[Path], hint: Any = None) -> Path | None:
    """Session `sid`'s transcript: the path sessions.json recorded when it is an own file (_own_file) of one of Claude
    Code's transcript roots, else the newest `<root>/*/<sid>.jsonl` that is one. Any other path is ignored, since a cell
    can write sessions.json and plant a symlink, and the zip is meant to be shared."""
    if isinstance(hint, str) and hint:
        p = Path(hint)
        if p.name == f"{sid}.jsonl" and any(_own_file(p, root) for root in roots):
            return p
    for root in roots:
        try:
            hits = sorted((h for h in root.glob(f"*/{sid}.jsonl") if _own_file(h, root)),
                          key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            hits = []
        if hits:
            return hits[0]
    return None


def session_records(ws: Path, chats: list[dict[str, Any]], tickets: Iterable[dict[str, Any]] = ()) -> dict[str, dict[str, Any]]:
    """Every Claude Code session the workspace names, by id: {role, chat, transcript_path?, and what sessions.json
    says}."""
    out: dict[str, dict[str, Any]] = {}

    def put(sid: Any, **info: Any) -> None:
        sid = str(sid or "")
        if not SID_RE.match(sid):
            return
        cur = out.setdefault(sid, {"session": sid})
        for k, v in info.items():
            if v is not None and cur.get(k) is None:
                cur[k] = v

    stored = _read_json(ws / "sessions.json")
    for sid, rec in (stored.items() if isinstance(stored, dict) else []):
        rec = rec if isinstance(rec, dict) else {}
        put(sid, role="main", chat="main", transcript_path=rec.get("transcript_path"), cwd=rec.get("cwd"),
            since=rec.get("since"), ended=rec.get("ended"), reason=rec.get("reason"))
    for meta in chats:
        role, kind = meta.get("role"), meta.get("kind")
        if kind == "main":
            put((meta.get("attached") or {}).get("session") if isinstance(meta.get("attached"), dict) else None, role="main", chat="main")
            put(meta.get("sdk_session_id"), role="main", chat="main")
        # A `step` with a session and no agent id is a session started as a step of another (such as a critique); a step
        # with an agent id is a subagent, found under its parent's folder.
        elif meta.get("session") and not meta.get("agent_id") and role in ("orient", "writer", "dev", "step"):
            put(meta.get("session"), role=role, chat=meta.get("id"))
        elif kind == "thread":
            put(meta.get("sdk_session_id"), role="thread", chat=meta.get("id"))
    ticket_chats = {str(m.get("ticket")): str(m.get("id")) for m in chats if m.get("role") == "dev" and m.get("ticket")}
    for t in tickets:
        put(t.get("session_id"), role="dev", chat=ticket_chats.get(str(t.get("id"))), ticket=t.get("id"))
    return out


def _agent_chat_index(chats: list[dict[str, Any]]) -> dict[str, str]:
    """A subagent's or a fork's agent id -> the chat that shows it."""
    by: dict[str, str] = {}
    for meta in chats:
        if meta.get("agent_id"):
            by[str(meta["agent_id"])] = str(meta.get("id"))
        fork = meta.get("fork")
        if isinstance(fork, dict) and fork.get("agent_id"):
            by[str(fork["agent_id"])] = str(meta.get("id"))
    return by


def _sessions(w: Writer, ws: Path, chats: list[dict[str, Any]], tickets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each session's transcript and every transcript under its own directory, with one index row per file."""
    from . import threads  # noqa: PLC0415

    roots = _projects_roots(ws)
    agents = _agent_chat_index(chats)
    index: list[dict[str, Any]] = []
    for sid, info in sorted(session_records(ws, chats, tickets).items(), key=lambda kv: (kv[1].get("since") or "", kv[0])):
        path = _find_transcript(sid, roots, info.get("transcript_path"))
        row = {k: v for k, v in info.items() if k != "transcript_path"}
        if path is None:
            index.append({**row, "file": "session", "path": None, "found": False})
            continue
        stats = w.copy_jsonl(f"sessions/{sid}.jsonl", path)
        index.append({**row, "file": "session", "path": f"sessions/{sid}.jsonl", "found": True, **stats})
        side = path.with_suffix("")  # <projects>/<slug>/<sid>/
        if side.is_symlink() or not side.is_dir():
            continue
        for p in sorted(side.rglob("*")):
            if not _own_file(p, side):
                continue
            rel = p.relative_to(side).as_posix()
            arc = f"sessions/{sid}/{rel}"
            if not rel.endswith(SESSION_SUFFIXES) or rel.startswith("tool-results/"):
                w.omit(arc, p, "a tool result Claude Code wrote out of line: the text a model read, mostly corpus text")
                continue
            m = AGENT_FILE_RE.match(p.name)
            if rel.endswith(".jsonl"):
                stats = w.copy_jsonl(arc, p)
                kind = "journal" if p.name == "journal.jsonl" else ("workflow-agent" if "/workflows/" in f"/{rel}" else "subagent")
                entry: dict[str, Any] = {"session": sid, "parent_role": info.get("role"), "file": kind, "path": arc, "found": True, **stats}
                if m:
                    entry["agent_id"] = m.group(1)
                    meta_path = p.with_name(f"agent-{m.group(1)}.meta.json")
                    meta = _read_json(meta_path) if _own_file(meta_path, side) else None
                    fork = threads.FORK_DESCRIPTION_RE.match(str(meta.get("description") or "")) if isinstance(meta, dict) else None
                    # A thread's fork is described `thread:<fork name>` or `thread:<id>` (threads.FORK_DESCRIPTION_RE),
                    # which names its thread even when the thread's meta no longer lists it.
                    named = fork.group(1) if fork else None
                    by_name = {str(c.get(threads.FORK_NAME_KEY)): str(c["id"]) for c in chats if c.get(threads.FORK_NAME_KEY)}
                    entry["chat"] = agents.get(m.group(1)) or (by_name.get(named, named) if named else None)
                    if isinstance(meta, dict):
                        entry["meta"] = meta
                if "/workflows/" in f"/{rel}":
                    entry["workflow_run"] = p.parent.name
                index.append(entry)
            else:
                w.copy(arc, p)
    w.jsonl("sessions/index.jsonl", index, ())
    return index


def _card_row(cell: dict[str, Any], group: dict[str, Any], trashed: bool) -> dict[str, Any]:
    row = {"card": cell.get("id"), "group": group.get("id"), "group_title": group.get("title"), "trashed": trashed}
    row.update(canvas_history.state_of(cell))
    for k in ("ts", "edited", "previous_code", "duration_s", "reads", "verification", "text"):
        if cell.get(k) not in (None, [], ""):
            row[k] = cell[k]
    return row


def _groups(ws: Path) -> list[tuple[dict[str, Any], bool]]:
    out: list[tuple[dict[str, Any], bool]] = []
    for folder, trashed in ((ws / "notebooks", False), (ws / "notebooks" / "trash", True)):
        for p in sorted(folder.glob("*.json")):
            nb = _read_json(p)
            if isinstance(nb, dict):
                nb.setdefault("id", p.stem)
                out.append((nb, trashed))
    return out


def canvas_history_rows(ws: Path, groups: list[tuple[dict[str, Any], bool]]) -> list[dict[str, Any]]:
    """The canvas history: the log's lines, plus lines reconstructed from the other records for what happened before the
    log began (`source: reconstructed`). Oldest first."""
    logged: list[dict[str, Any]] = []
    first_logged: dict[str, datetime] = {}
    for r in _read_jsonl(ws / canvas_history.LOG_NAME):
        r = {**r, "source": "log"}
        logged.append(r)
        d = _parse_ts(r.get("ts"))
        cid = str(r.get("card") or "")
        if d is not None and cid and (cid not in first_logged or d < first_logged[cid]):
            first_logged[cid] = d
    created_logged = {str(r.get("card")) for r in logged if r.get("op") == "created"}
    rebuilt: list[dict[str, Any]] = []
    known: dict[str, tuple[dict[str, Any], dict[str, Any], bool]] = {}
    for nb, trashed in groups:
        for cell in nb.get("cells") or []:
            if isinstance(cell, dict) and cell.get("id"):
                known[str(cell["id"])] = (cell, nb, trashed)

    def before_log(cid: str, ts: Any) -> bool:
        d = _parse_ts(ts)
        start = first_logged.get(cid)
        return start is None or (d is not None and d < start)

    for cid, (cell, nb, trashed) in known.items():
        if trashed:
            continue
        made = cell.get("created_ts") or cell.get("ts")
        if cid not in created_logged and before_log(cid, made):
            rebuilt.append({"ts": made, "op": "created", "card": cid, "group": nb.get("id"), "by": cell.get("created_by"),
                            "changed": [], "state": canvas_history.state_of(cell), "state_as_of": "export",
                            "source": "reconstructed"})
        for e in cell.get("edited") or []:
            if isinstance(e, dict) and before_log(cid, e.get("ts")):
                rebuilt.append({"ts": e.get("ts"), "op": "edited", "card": cid, "group": nb.get("id"), "by": e.get("by"),
                                "changed": None, "state": None, "source": "reconstructed"})
    deleted_logged = {str(r.get("card")) for r in logged if r.get("op") == "deleted"}
    for ev in _read_jsonl(ws / "investigations" / "main" / "events.jsonl"):
        if ev.get("type") != "cell" or ev.get("kind") != "deleted":
            continue
        cid = str(ev.get("cell") or "")
        if not cid or cid in deleted_logged or not before_log(cid, ev.get("ts")):
            continue
        hit = known.get(cid)
        state = canvas_history.state_of(hit[0]) if hit and hit[2] else None
        rebuilt.append({"ts": ev.get("ts"), "op": "deleted", "card": cid, "group": ev.get("notebook"), "by": None,
                        "changed": [], "state": state, "source": "reconstructed"})
    rows = logged + rebuilt
    far = datetime.max.replace(tzinfo=timezone.utc)
    rows.sort(key=lambda r: _parse_ts(r.get("ts")) or far)
    return rows


def _canvas(w: Writer, ws: Path) -> dict[str, int]:
    groups = _groups(ws)
    group_rows = [{**{k: v for k, v in nb.items() if k != "cells"}, "cards": len(nb.get("cells") or []), "trashed": trashed}
                  for nb, trashed in groups]
    cards = [_card_row(cell, nb, trashed) for nb, trashed in groups for cell in nb.get("cells") or [] if isinstance(cell, dict)]
    return {
        "canvas/groups.jsonl": w.jsonl("canvas/groups.jsonl", group_rows),
        "canvas/cards.jsonl": w.jsonl("canvas/cards.jsonl", cards, ("created_ts", "ts")),
        "canvas/history.jsonl": w.jsonl("canvas/history.jsonl", canvas_history_rows(ws, groups)),
    }


def _labels(w: Writer, ws: Path) -> dict[str, int]:
    defs = []
    for p in sorted((ws / "concepts").glob("*.json")):
        d = _read_json(p)
        if isinstance(d, dict):
            d.setdefault("id", p.stem)
            defs.append(d)

    def results() -> Iterator[dict[str, Any]]:
        for p in sorted((ws / "labels").glob("*.jsonl")):
            for r in _read_jsonl(p):
                yield {"label": p.stem, **{("value" if k == "label" else k): v for k, v in r.items()}}

    counts = {"labels/definitions.jsonl": w.jsonl("labels/definitions.jsonl", defs),
              "labels/results.jsonl": w.jsonl("labels/results.jsonl", results())}
    filters = _read_json(ws / "filters.json")
    if filters is not None:
        w.json("labels/filters.json", filters)
    return counts


def _views(w: Writer, ws: Path) -> int:
    base = ws / "views"
    n = 0
    if not base.is_dir():
        return 0
    for p in sorted(base.rglob("*")):
        rel = p.relative_to(base)
        if not p.is_file() or p.is_symlink() or any(part in SKIPPED_DIRS for part in rel.parts):
            continue
        w.copy(f"views/{rel.as_posix()}", p)
        n += 1
    return n


def _documents(w: Writer, ws: Path) -> dict[str, int]:
    """Every stored state of every document (current, unwritten frame, archived generations, revision records), and
    every comment once, as the newest state holding it has it."""
    inv = ws / "investigations" / "main"
    rows: list[dict[str, Any]] = []
    if inv.is_dir():
        for p in sorted(inv.glob("*.json")):
            d = _read_json(p)
            if p.name == "investigation.json":
                rows.append({"doc": None, "state": "investigation", "file": p.name, "document": d})
            elif p.name.endswith(".frame.json"):
                rows.append({"doc": p.name[: -len(".frame.json")], "state": "frame", "file": p.name, "document": d})
            else:
                rows.append({"doc": p.stem, "state": "current", "file": p.name, "document": d})
        for sub in sorted(x for x in inv.iterdir() if x.is_dir() and x.name != "versions"):
            for p in sorted(sub.glob("*.json")):
                rows.append({"doc": sub.name, "state": "archive", "file": f"{sub.name}/{p.name}", "stamp": p.stem,
                             "document": _read_json(p)})
        for sub in sorted((inv / "versions").glob("*")):
            for p in sorted(sub.glob("*.json"), key=lambda q: (len(q.stem), q.stem)):
                rows.append({"doc": sub.name, "state": "version", "file": f"versions/{sub.name}/{p.name}", "n": p.stem,
                             "document": _read_json(p)})
    comments: dict[tuple[str, str], tuple[int, dict[str, Any]]] = {}
    for r in rows:
        doc = r.get("document")
        if not isinstance(doc, dict) or not r.get("doc"):
            continue
        states = [doc] + ([doc["previous"]] if isinstance(doc.get("previous"), dict) else [])
        for st in states:
            gen = st.get("generation") if isinstance(st.get("generation"), int) else -1
            rank = gen + (1_000_000 if r["state"] == "current" else 0)
            for cm in st.get("comments") or []:
                if isinstance(cm, dict) and cm.get("id"):
                    key = (str(r["doc"]), str(cm["id"]))
                    if key not in comments or rank >= comments[key][0]:
                        comments[key] = (rank, {"doc": r["doc"], **cm})
    for r in rows:
        doc = r.get("document")
        if isinstance(doc, dict):
            w.note_ts(doc.get("generated_at") or doc.get("ts"))
    return {"documents/documents.jsonl": w.jsonl("documents/documents.jsonl", rows, ()),
            "documents/comments.jsonl": w.jsonl("documents/comments.jsonl", [v for _, v in sorted(comments.values(), key=lambda kv: str(kv[1].get("ts") or ""))])}


def _orientation(w: Writer, ws: Path) -> None:
    for name in ("run.json", "summary.md"):
        p = ws / "orient" / name
        if p.is_file():
            w.copy(f"orientation/{name}", p)


def _dev_rows(c: str, name: str) -> list[dict[str, Any]]:
    """The dev tickets filed from this workspace (dev/ holds every workspace's)."""
    from . import dev  # noqa: PLC0415

    return [r for r in _read_jsonl(dev.DEV_DIR / name) if r.get("workspace") == c]


def _corpus_files(c: str) -> dict[str, Any]:
    from . import corpus  # noqa: PLC0415

    root = config.corpus_dir(c)
    files: list[dict[str, Any]] = []
    for s in corpus.list_sources(root):
        p = root / s["path"]
        try:
            st = p.stat()
            files.append({"path": s["path"], "bytes": st.st_size, "sha256": _corpus_hash(p, st.st_size, st.st_mtime_ns)})
        except OSError:
            files.append({"path": s["path"], "bytes": s.get("size_bytes"), "sha256": None})
    return {"root": str(root), "files": files, "total_files": len(files), "total_bytes": sum(f["bytes"] or 0 for f in files)}


def _settings(ws: Path) -> dict[str, Any]:
    s = _read_json(ws / "settings.json")
    return {k: v for k, v in s.items() if not SECRET_KEY_RE.search(k)} if isinstance(s, dict) else {}


def _readme(manifest: dict[str, Any]) -> str:
    try:
        text = README_SOURCE.read_text("utf-8").rstrip() + "\n"
    except OSError:
        text = "# thimble workspace export\n"
    rng = manifest["time_range"]
    lines = ["", "## This export", "",
             f"Workspace `{manifest['workspace']['name']}`, exported {manifest['exported_at']}, records from "
             f"{rng['first'] or 'none'} to {rng['last'] or 'none'}. The corpus has {manifest['corpus']['total_files']} files "
             f"({manifest['corpus']['total_bytes']:,} bytes), listed in manifest.json and not included.", "",
             "| file | rows | bytes |", "|---|---|---|"]
    lines += [f"| `{f['path']}` | {f.get('rows', '')} | {f['bytes']:,} |" for f in manifest["files"]]
    if manifest["omitted"]:
        lines += ["", f"{len(manifest['omitted'])} files are listed in manifest.json `omitted` and not included."]
    return text + "\n".join(lines) + "\n"


# ----------------------------------------------------------------------------- the whole export


def build(c: str, out: Path) -> dict[str, Any]:
    """Write the export of workspace `c` to `out` (a zip); the manifest. ValueError for an unknown workspace."""
    ws = config.workspace_path(c)
    exported = datetime.now(timezone.utc)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        w = Writer(zf)
        _telemetry(w, ws)
        chats = _chats(w, ws)
        tickets = _dev_rows(c, "tickets.jsonl")
        _sessions(w, ws, chats, tickets)
        _canvas(w, ws)
        _labels(w, ws)
        _views(w, ws)
        _documents(w, ws)
        _orientation(w, ws)
        w.jsonl("tickets.jsonl", tickets)
        try:
            corpus_info = _corpus_files(c)
        except Exception as e:  # noqa: BLE001 — a corpus folder that moved still leaves the usage logs worth exporting
            log.exception("export %s: the corpus listing failed", c)
            corpus_info = {"root": None, "files": [], "total_files": 0, "total_bytes": 0, "error": str(e)}
        manifest: dict[str, Any] = {
            "schema": SCHEMA, "version": VERSION, "exported_at": _iso(exported),
            "workspace": {"name": c, "manifest": config.corpus_manifest(c), "settings": _settings(ws)},
            "time_range": {"first": _iso(w.lo), "last": _iso(w.hi)},
            "corpus": corpus_info,
            "files": list(w.files),
            "omitted": w.omitted,
        }
        readme = _readme(manifest)
        w.text("README.md", readme)
        manifest["files"] = list(w.files)
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
    return manifest


def filename(c: str, when: datetime | None = None) -> str:
    return f"{c}-thimble-export-{(when or datetime.now(timezone.utc)).strftime('%Y%m%dT%H%M%SZ')}.zip"


@router.get("/ws/{c}/export")
async def export_route(c: str, background: BackgroundTasks) -> FileResponse:
    """The workspace's export as a zip download."""
    try:
        config.workspace_path(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    fd, tmp = tempfile.mkstemp(prefix=f"thimble-export-{c}-", suffix=".zip")
    os.close(fd)
    path = Path(tmp)
    try:
        await asyncio.to_thread(build, c, path)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    background.add_task(path.unlink, missing_ok=True)
    return FileResponse(path, media_type="application/zip", filename=filename(c), background=background)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help"):
        print("usage: python -m app.export <workspace> [<out.zip>]")
        return 0 if args else 2
    c = args[0]
    out = Path(args[1]) if len(args) > 1 else Path.cwd() / filename(c)
    m = build(c, out)
    print(f"{out}: {len(m['files'])} files, records {m['time_range']['first']} to {m['time_range']['last']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
