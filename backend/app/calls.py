"""The orientation's tool calls, stored whole so they can be cited.

A number that came from shell output is cited by the call that printed it: `call:<chat>/<n>` for the whole call,
`call:<chat>/<n>#L<a>[-L<b>]` for lines of its output. The chat log keeps only a short summary of a result and Claude
Code deletes transcripts after 30 days by default, so the output is stored here.

Store: `workspaces/<c>/calls/<chat>.jsonl`, append-only: `{n, id, chat, name, input, ts, agent?}` when a call is first
seen, `{n, result, is_error}` when its result is, and `{n, chat}` when the chat whose log holds the call becomes known.
Numbering: one sequence per orientation chat, keyed by tool_use_id and never reused. The follower (Numbering) and the
call-ref hook (hook_route, or in terminal mode the hook itself through calls_file.number) both number calls; whichever
sees a call first numbers it, under the store's lock (calls_file). Each read goes on from where this process last read
the file, so a number another process gave is seen. A chat without a store is backfilled from its transcripts on first
read.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import calls_file, config, ledger

log = logging.getLogger("thimble.calls")
router = APIRouter()

CALLS_DIR = "calls"  # workspaces/<c>/calls/<chat>.jsonl
RESULT_CHARS = 2_000_000  # of one call's output kept
LINE_CHARS = 300  # of a call's one-line summary (chip_line)
EXCERPT_LINES = 40  # of a whole call's output in its excerpt
READ_CHARS = 40_000  # of a call's output read_ref shows at once; a line range reads the rest
TOOL_RESULTS = "tool-results"  # Claude Code saves a long output as <projects>/<slug>/<session>/tool-results/<file>
SESSION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
REF_RE = re.compile(r"^call:([A-Za-z0-9_-]+)/(\d+)(?:#L(\d+)(?:-L(\d+))?)?$")
# the prefixes of thimble's own tools, whose calls the hook skips
THIMBLE_PREFIXES = ("mcp__plugin_thimble_thimble__", "mcp__thimble__")
CHAT_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# --------------------------------------------------------------------------- the store


@dataclass
class _Index:
    """What one chat's store holds, replayed from its file up to `offset` (the end of its last whole line): tool_use_id
    -> n, each call by n, and the next number. Another process appends to the same file (the hooks number calls in
    terminal mode, calls_file.number), so each use reads on from `offset` (_load)."""

    by_id: dict[str, int] = field(default_factory=dict)
    rows: dict[int, dict[str, Any]] = field(default_factory=dict)
    next: int = 1
    offset: int = 0
    ino: int | None = None


_lock = threading.RLock()
_indexes: dict[str, _Index] = {}  # by the store's path
_backfilled: set[str] = set()  # the store paths whose missing store backfill has tried this process


def path(c: str, chat: str) -> Path:
    if not CHAT_RE.match(chat or ""):
        raise HTTPException(404, f"invalid chat id: {chat!r}")
    return config.workspace_dir(c) / CALLS_DIR / f"{chat}.jsonl"


def _load(c: str, chat: str) -> _Index:
    """The chat's index, brought up to date with what the file gained since it was last read (by this process or
    another). A file that shrank or was replaced is read again from its start."""
    p = path(c, chat)
    key = str(p)  # by file, so a workspace made again under the same name starts from its own store
    idx = _indexes.get(key)
    try:
        st = p.stat()
    except OSError:
        st = None
    if idx is not None and (st is None or st.st_ino != idx.ino or st.st_size < idx.offset):
        idx = None  # the store was removed, replaced or cut: its numbers are read again
    if idx is None:
        idx = _indexes[key] = _Index()
    if st is None or st.st_size == idx.offset:
        return idx
    try:
        with p.open("rb") as f:
            f.seek(idx.offset)
            chunk = f.read()
    except OSError:
        return idx
    end = chunk.rfind(b"\n") + 1  # a torn last line waits until it is whole
    idx.offset += end
    idx.ino = st.st_ino
    for raw in chunk[:end].splitlines():
        try:
            rec = json.loads(raw)
        except ValueError:
            continue  # a torn line, mended since
        _replay(idx, rec)
    return idx


def _replay(idx: _Index, rec: Any) -> None:
    n = rec.get("n") if isinstance(rec, dict) else None
    if not isinstance(n, int) or isinstance(n, bool):
        return
    if "id" in rec:
        if str(rec["id"]) in idx.by_id:
            return  # numbered twice by an earlier build without the lock: the first number stands
        idx.by_id[str(rec["id"])] = n
        idx.rows[n] = {k: v for k, v in rec.items()}
        idx.next = max(idx.next, n + 1)
    elif "result" in rec and n in idx.rows:
        idx.rows[n]["result"] = rec.get("result")
        idx.rows[n]["is_error"] = bool(rec.get("is_error"))
    elif "chat" in rec and n in idx.rows:
        idx.rows[n]["chat"] = rec.get("chat")


def _append(c: str, chat: str, rec: dict[str, Any]) -> None:
    """Append one line under the store's lock (the caller holds it, or it is taken here)."""
    p = path(c, chat)
    p.parent.mkdir(parents=True, exist_ok=True)
    with ledger.locked(p):
        ledger.heal_tail(p)
        with p.open("a", encoding="utf-8") as f:
            f.write(calls_file.line(rec))


def forget(c: str | None = None) -> None:
    """Drop the indexes held in memory (every workspace's when None), for tests and a reset."""
    with _lock:
        if c is None:
            _indexes.clear()
            _backfilled.clear()
            return
        root = str(config.workspace_dir(c) / CALLS_DIR)
        for key in [k for k in _indexes if k.startswith(root)]:
            _indexes.pop(key, None)
        for key in [k for k in _backfilled if k.startswith(root)]:
            _backfilled.discard(key)


def exists(c: str, chat: str) -> bool:
    try:
        return path(c, chat).is_file()
    except HTTPException:
        return False


def number(c: str, chat: str, tool_use_id: str, name: str, inp: Any = None, *, agent: str | None = None,
           at: str | None = None) -> int:
    """The number of the call `tool_use_id` in chat `chat`'s sequence, assigned the first time any process sees the call
    (calls_file.number, under the store's lock). `at` is the chat whose log holds the call's record, when the caller
    knows it."""
    tid = str(tool_use_id or "")
    if not tid:
        raise ValueError("a call needs its tool_use_id")
    p = path(c, chat)
    with _lock, ledger.locked(p):
        idx = _load(c, chat)
        if tid not in idx.by_id:
            calls_file.number(config.workspace_dir(c), chat, tid, name, inp, agent, at=at, held=True)
            idx = _load(c, chat)
        n = idx.by_id[tid]
        row = idx.rows[n]
        if row.get("input") is None and inp is not None:
            row["input"] = inp  # the hook saw it first without an input; kept in memory, the file has the first line
        if at and not row.get("chat"):
            row["chat"] = at
            _append(c, chat, {"n": n, "chat": at})
            _load(c, chat)  # reads the line just written
        return n


def result(c: str, chat: str, tool_use_id: str, text: str, is_error: bool = False) -> int | None:
    """Store the call's whole output (up to RESULT_CHARS) once; None for a call not numbered yet."""
    with _lock, ledger.locked(path(c, chat)):
        idx = _load(c, chat)
        n = idx.by_id.get(str(tool_use_id or ""))
        if n is None:
            return None
        row = idx.rows[n]
        if "result" in row:
            return n
        body = text if len(text) <= RESULT_CHARS else text[:RESULT_CHARS]
        row["result"], row["is_error"] = body, bool(is_error)
        _append(c, chat, {"n": n, "result": body, "is_error": bool(is_error)})
        _load(c, chat)  # reads the line just written, so it is not replayed twice
        return n


def get(c: str, chat: str, n: int) -> dict[str, Any] | None:
    """The call numbered `n`, {n, id, chat, name, input, ts, agent?, result?, is_error?}, or None."""
    with _lock:
        _ensure(c, chat)
        row = _load(c, chat).rows.get(int(n))
        return dict(row) if row is not None else None


def number_of(c: str, chat: str, tool_use_id: str) -> int | None:
    with _lock:
        return _load(c, chat).by_id.get(str(tool_use_id or ""))


def ref(chat: str, n: int, start: int | None = None, end: int | None = None) -> str:
    out = f"call:{chat}/{n}"
    if start is not None:
        out += f"#L{start}" + (f"-L{end}" if end is not None and end != start else "")
    return out


def is_thimble(name: str) -> bool:
    return str(name or "").startswith(THIMBLE_PREFIXES)


# --------------------------------------------------------------------------- what a call shows


def _short(name: str) -> str:
    return str(name or "").rsplit("__", 1)[-1]


def chip_line(name: str, inp: Any, root: "str | tuple[str, ...]" = "") -> str:
    """A call in one line as its chip reads, such as `grep refund tickets/` or the command a Bash call ran; paths in the
    folders `root` names (the corpus folder, and the workspace folder, which holds the orientation's work folder)
    written relative to the folder, as the browser's chip line writes them (frontend chat/model.ts underCorpus)."""
    d = inp if isinstance(inp, dict) else {}
    short = _short(name)
    if short == "Bash" and isinstance(d.get("command"), str):
        line = d["command"]
    elif short == "Read" and isinstance(d.get("file_path"), str):
        line = f"Read {d['file_path']}" + (f" from line {d['offset']}" if d.get("offset") else "")
    elif short == "Grep" and isinstance(d.get("pattern"), str):
        line = f"grep {d['pattern']} {d.get('path') or d.get('glob') or ''}".rstrip()
    elif short == "Glob" and isinstance(d.get("pattern"), str):
        line = f"glob {d['pattern']}" + (f" in {d['path']}" if d.get("path") else "")
    elif short == "Skill" and d.get("skill"):
        line = f"skill {d['skill']}" + (f" {d['args']}" if d.get("args") else "")
    elif isinstance(d.get("description"), str) and d["description"].strip():
        line = f"{short} {d['description']}"
    else:
        body = json.dumps(d, ensure_ascii=False, default=str) if d else ""
        line = f"{short} {body}".rstrip()
    for r in sorted((root,) if isinstance(root, str) else root, key=len, reverse=True):
        if r.startswith("/") and r.rstrip("/"):
            line = line.replace(r.rstrip("/") + "/", "")
    line = " ".join(line.split())
    return line if len(line) <= LINE_CHARS else line[: LINE_CHARS - 1].rstrip() + "…"


def lines_of(text: Any) -> list[str]:
    """An output's lines as refs number them from 1: split at each newline only, as the browser splits them."""
    t = str(text or "")
    if not t:
        return []
    out = t.split("\n")
    if len(out) > 1 and out[-1] == "":
        out.pop()
    return out


def persisted_path(rec: dict[str, Any] | None) -> Path | None:
    """The file Claude Code saved the record's long tool output to (`toolUseResult.persistedOutputPath`) when it is a
    regular file in the tool-results folder of the record's own session, beside that session's transcript; else None.
    The text of a result never names the file: a tool's output can say anything."""
    rec = rec or {}
    tur = rec.get("toolUseResult")
    saved = tur.get("persistedOutputPath") if isinstance(tur, dict) else None
    sid = rec.get("sessionId")
    if not isinstance(saved, str) or not isinstance(sid, str) or not SESSION_ID_RE.match(sid):
        return None
    f = Path(saved)
    folder = f.parent
    if not f.is_absolute() or folder.name != TOOL_RESULTS or folder.parent.name != sid:
        return None
    try:
        if not (folder.parent.parent / f"{sid}.jsonl").is_file() or f.is_symlink() or not f.is_file():
            return None
        return f if f.resolve().parent == folder.resolve() else None
    except OSError:
        return None


def result_text(block: dict[str, Any], rec: dict[str, Any] | None = None) -> str:
    """The whole output of a transcript's tool_result `block` (the user record `rec` carries it): the file Claude Code
    saved a long output to (persisted_path), read up to RESULT_CHARS, when it saved one; else the result's text."""
    from . import session  # noqa: PLC0415 — session imports agents, which imports tools

    saved = persisted_path(rec)
    if saved is not None:
        try:
            with open(saved, "r", encoding="utf-8", errors="replace") as f:
                return f.read(RESULT_CHARS)
        except OSError:
            pass
    return session.response_text(block.get("content"))


def listing(c: str, chat: str) -> list[dict[str, Any]]:
    """[{n, id, name, line, is_error, done, agent?}] of the chat's calls in number order, for the thread's chips."""
    with _lock:
        _ensure(c, chat)
        rows = [dict(r) for _, r in sorted(_load(c, chat).rows.items())]
    root = _root(c)
    out = []
    for r in rows:
        item = {"n": r["n"], "id": r.get("id"), "chat": r.get("chat") or (chat if not r.get("agent") else None),
                "name": r.get("name"), "line": chip_line(str(r.get("name") or ""), r.get("input"), root),
                "done": "result" in r, "is_error": bool(r.get("is_error"))}
        if r.get("agent"):
            item["agent"] = r["agent"]
        out.append(item)
    return out


def _root(c: str) -> tuple[str, ...]:
    """The folders a chip line writes paths relative to: the corpus folder, and the workspace folder, where the
    orientation's files go (`orient/work/count.py`)."""
    out = []
    for folder in (config.corpus_dir, config.workspace_dir):
        try:
            out.append(str(folder(c)))
        except Exception:  # noqa: BLE001 — a workspace whose corpus is gone still shows its calls
            continue
    return tuple(out)


def whole(c: str, chat: str, n: int) -> dict[str, Any]:
    """The call for the browser: its ref, the chat whose log holds its record, tool, input, one-line summary and its
    whole output, `result`, null while it runs; 404 when there is no such call."""
    row = get(c, chat, n)
    if row is None:
        raise HTTPException(404, f"no call {ref(chat, n)}")
    out = {"ref": ref(chat, n), "n": row["n"], "id": row.get("id"), "chat": row.get("chat") or (chat if not row.get("agent") else None),
           "name": row.get("name"), "input": row.get("input"),
           "line": chip_line(str(row.get("name") or ""), row.get("input"), _root(c)), "ts": row.get("ts"),
           "done": "result" in row, "is_error": bool(row.get("is_error")),
           "result": row.get("result") if "result" in row else None}
    if row.get("agent"):
        out["agent"] = row["agent"]
    return out


# --------------------------------------------------------------------------- refs


def parse_ref(text: str) -> dict[str, Any] | None:
    """{chat_id, n, line?, end_line?} of a call ref, or None when `text` is not one."""
    m = REF_RE.match(str(text or "").strip())
    if not m:
        return None
    out: dict[str, Any] = {"kind": "call", "chat_id": m[1], "n": int(m[2])}
    if m[3]:
        out["line"] = int(m[3])
        if m[4]:
            out["end_line"] = int(m[4])
    return out


def resolve(c: str, p: dict[str, Any], text: str) -> dict[str, Any]:
    """A call ref as refs.resolve answers: the whole call (its line and the first EXCERPT_LINES of its output) or the
    cited lines of its output, exactly, as the excerpt, so a number checked against it is checked against those lines
    alone (verify._ref_check). RefError 404 for a call that does not exist, 400 for a range that ends before it
    starts; a line past the output's end is `span_missing`, as a card's line span is."""
    from .refs import RefError  # noqa: PLC0415 — refs imports this module lazily

    row = get(c, str(p["chat_id"]), int(p["n"]))
    if row is None:
        raise RefError(f"no call {ref(str(p['chat_id']), int(p['n']))}", 404)
    lines = lines_of(row.get("result"))
    line = chip_line(str(row.get("name") or ""), row.get("input"), _root(c))
    meta: dict[str, Any] = {"chat": p["chat_id"], "n": row["n"], "name": row.get("name"), "line": line,
                            "is_error": bool(row.get("is_error")), "done": "result" in row, "lines": len(lines)}
    out: dict[str, Any] = {"ref": text, "kind": "call", "meta": meta}
    a, b = p.get("line"), p.get("end_line")
    if a is None:
        body = "\n".join(lines[:EXCERPT_LINES]) + (f"\n… {len(lines) - EXCERPT_LINES} more lines" if len(lines) > EXCERPT_LINES else "")
        out["excerpt"] = f"$ {line}\n{body}".rstrip()
        return out
    if b is not None and b < a:
        raise RefError(f"range end L{b} is before start L{a}", 400)
    if not 1 <= a <= len(lines):
        meta["span_missing"] = True
        out["excerpt"] = f"$ {line}"
        return out
    last = min(b, len(lines)) if b is not None else a
    text_ = "\n".join(lines[a - 1 : last])
    meta["span"] = {"line": a, "end_line": last, "text": text_}
    out["excerpt"] = text_
    return out


def tool_read_ref(c: str, text: str) -> tuple[str, bool]:
    """(text, is_error) of read_ref for a call ref: the call's line, then its output numbered, the cited lines of a
    line ref, up to READ_CHARS, with the ref of the next lines when it stops early."""
    p = parse_ref(text)
    if p is None:
        return f"read_ref: {text} is not a call ref (call:<chat>/<n>, or call:<chat>/<n>#L<a>-L<b> for lines)", True
    row = get(c, str(p["chat_id"]), int(p["n"]))
    if row is None:
        return f"read_ref: there is no call {ref(str(p['chat_id']), int(p['n']))}", True
    lines = lines_of(row.get("result"))
    start = int(p.get("line") or 1)
    stop = min(int(p.get("end_line") or p.get("line") or len(lines)), len(lines))
    if p.get("line") and not p.get("end_line"):
        stop = start
    head = f"{ref(str(p['chat_id']), int(p['n']))} {_short(str(row.get('name') or ''))}" + (" (failed)" if row.get("is_error") else "")
    out = [head, "input: " + json.dumps(row.get("input"), ensure_ascii=False, default=str)]
    if "result" not in row:
        out.append("output: (not returned yet)")
        return "\n".join(out), False
    out.append(f"output, {len(lines):,} lines:")
    used = 0
    for i in range(start, stop + 1):
        s = f"{i}\t{lines[i - 1]}"
        if used + len(s) > READ_CHARS:
            out.append(f"[stopped at line {i - 1}; read_ref {ref(str(p['chat_id']), int(p['n']), i, stop)} reads on]")
            break
        out.append(s)
        used += len(s) + 1
    return "\n".join(out), False


# --------------------------------------------------------------------------- the follower's side


class Numbering:
    """What a follower's session.Sub calls for each tool call and result it writes into a chat (session.translate_sub):
    the call numbered in the orientation chat `chat`'s sequence and its output stored whole. `agent` names the
    subagent or workflow agent whose transcript it is, None for the session's own."""

    def __init__(self, c: str, chat: str, agent: str | None = None, at: str | None = None) -> None:
        self.c, self.chat, self.agent, self.at = c, chat, agent, at or (None if agent else chat)

    def use(self, tool_use_id: str, name: str, inp: Any) -> int | None:
        try:
            return number(self.c, self.chat, tool_use_id, name, inp, agent=self.agent, at=self.at)
        except Exception:  # noqa: BLE001 — the store never stops the mirror
            log.exception("%s: call %s was not numbered", self.c, tool_use_id)
            return None

    def result(self, tool_use_id: str, block: dict[str, Any], rec: dict[str, Any] | None = None) -> None:
        try:
            result(self.c, self.chat, tool_use_id, result_text(block, rec), bool(block.get("is_error")))
        except Exception:  # noqa: BLE001
            log.exception("%s: the output of call %s was not stored", self.c, tool_use_id)


# --------------------------------------------------------------------------- earlier orientations


def _ensure(c: str, chat: str) -> None:
    """Backfill a missing store once per process."""
    try:
        key = str(path(c, chat))
    except HTTPException:
        return
    if key in _backfilled or exists(c, chat):
        return
    _backfilled.add(key)
    try:
        backfill(c, chat)
    except Exception:  # noqa: BLE001 — an old orientation without refs still opens
        log.exception("%s: the calls of chat %s were not backfilled", c, chat)


def backfill(c: str, chat: str) -> int:
    """Build a missing store of an orientation chat from its session's transcripts, its own then each agent's in start
    order; the number of calls stored, 0 when the chat is no orientation's or its transcript is gone."""
    from . import agents, orientation, session  # noqa: PLC0415

    meta = agents.meta_or_none(c, chat) or {}
    sid = str(meta.get("session") or "")
    if meta.get("role") != orientation.ROLE or not sid:
        return 0
    found = session.find_transcript(sid)
    if not found:
        return 0
    main = Path(found)
    paths: list[tuple[str | None, Path]] = [(None, main)]
    folder = main.parent / sid / "subagents"
    if folder.is_dir():
        for p in sorted(folder.rglob("agent-*.jsonl")):
            m = session.AGENT_FILE_RE.match(p.name)
            if m:
                paths.append((m.group(1), p))
    stored = 0
    with _lock:
        for agent, p in paths:
            try:
                raw = p.read_bytes()
            except OSError:
                continue
            for line in raw.splitlines():
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                content = (rec.get("message") or {}).get("content") if isinstance(rec.get("message"), dict) else None
                if not isinstance(content, list):
                    continue
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if rec.get("type") == "assistant" and b.get("type") == "tool_use" and b.get("id") \
                            and b.get("name") not in session.PLUMBING_TOOLS:
                        number(c, chat, str(b["id"]), str(b.get("name") or ""), b.get("input"), agent=agent)
                        stored += 1
                    elif rec.get("type") == "user" and b.get("type") == "tool_result" and b.get("tool_use_id"):
                        result(c, chat, str(b["tool_use_id"]), result_text(b, rec), bool(b.get("is_error")))
    return stored


# --------------------------------------------------------------------------- routes


class HookCall(BaseModel):
    session: str | None = None
    tool_use_id: str | None = None
    tool_name: str | None = None
    tool_input: Any = None
    agent_id: str | None = None


@router.post("/ws/{c}/calls/ref")
async def hook_route(c: str, body: HookCall) -> dict[str, Any]:
    """The plugin's --agents hook: number the call the orientation (its key `session`), or its descendant `agent_id`,
    just made in the orientation's sequence and answer `{context}`, the `## call-ref` line that tells the model its
    ref; `{}` for a call of thimble's own tools, of Claude Code's plumbing, or of an agent that is no orientation's."""
    from . import session, subagents, tools  # noqa: PLC0415

    name = str(body.tool_name or "")
    if not body.tool_use_id or not name or is_thimble(name) or name in session.PLUMBING_TOOLS:
        return {}
    run = subagents.current(c, body.session)
    chat = run.calls if run is not None else None
    if not chat:
        return {}
    n = number(c, chat, body.tool_use_id, name, body.tool_input, agent=body.agent_id or None)
    return {"ref": ref(chat, n), "context": tools.hint("call-ref", ref=ref(chat, n))}


@router.get("/ws/{c}/calls/{chat}")
async def list_route(c: str, chat: str) -> list[dict[str, Any]]:
    config.workspace_dir(c)
    return listing(c, chat)


@router.get("/ws/{c}/calls/{chat}/{n}")
async def get_route(c: str, chat: str, n: int) -> dict[str, Any]:
    config.workspace_dir(c)
    return whole(c, chat, n)
