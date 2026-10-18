"""Checks' comments on Claude's answers: the third run target of a report check (checks.py, ANSWERS) beside the
documents and the cards. After a data answer (is_data_turn), each check that is on and covers answers reads the
answer's passages and comments on the ones its instructions apply to; the terminal tints each commented passage in its
check's color and the panel's Checks view lists the comments. A check on an answer never starts a turn of Claude's.

    workspaces/<c>/answers.json           the answers the checks read: {answers: [{turn, sid, at, rows: [{uuid,
                                          text}]}]}, the last ANSWERS_KEPT, each row's text raw as Claude wrote it
    workspaces/<c>/answer-comments.json   {comments: [{id, turn, row, ref, start, end, quote, check, run, author, text,
                                          details, evidence, fp, ts, status, resolution}]}

Passages (passages): each row's text is split into paragraphs (blank lines), list items (lines that start `- `, `* ` or
`<n>. `) and sentences (after `.`, `?` or `!` followed by a space and an uppercase letter or a digit, never inside a
`[…](…)` link, a `[[…]]` citation or backticks). A fenced code block and a table's lines hold no passage. Each sentence
is `answer:<turn>#s<n>` (n from 1 across the turn; `<turn>` the uuid of the turn's first text row) with its `row`, its
`start` and `end` (character offsets in that row's raw text, a list item's marker and a heading's #s left out) and a
fingerprint of its turn and words.

A comment keeps its passage's raw text as `quote` and its offsets, so the terminal finds the passage again (and, when the
offsets no longer match, the quote). `status` is `open`, `dismissed` (the analyst's dismiss, `resolution` done) or
dismissed with `resolution` superseded (a later run of its check covered its passage). Each change emits
`answer-comments` on the workspace's stream; the terminal UI watches the file.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import config, investigation
from .ledger import read_json, update_json

log = logging.getLogger("thimble.answer_comments")

ANSWERS = "@answers"  # the run target of a check over Claude's answers, among a check's runs (checks.ANSWERS)
ANSWERS_FILE = "answers.json"
FILE = "answer-comments.json"
EVENT = "answer-comments"  # the stream record a change emits
ANSWERS_KEPT = 20  # the answers kept for the checks to read, newest last
SETTLED = "dismissed"
RESOLUTION_DONE = "done"
RESOLUTION_SUPERSEDED = "superseded"
TEXT_CHARS = 20_000  # of a row's text, kept
DETAILS_CHARS = 2_000
UUID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
REF_RE = re.compile(r"^answer:([A-Za-z0-9_-]{1,80})#s([0-9]{1,5})$")
# the heading of the answer in a check's task file (checks.task_text), then the answer's sentences, each with its ref
TASK_HEADING = ("Claude's answer in the chat, which the analyst read in their terminal. Comment only on its sentences, "
                "each by its ref `answer:<turn>#s<n>`, listed below with the sentence's text.")

# thimble's tools, as main's session and a worker see them
THIMBLE_TOOL_PREFIXES = ("mcp__plugin_thimble_thimble__", "mcp__thimble__")
READ_TOOLS = ("Read", "NotebookRead")
SEARCH_TOOLS = ("Grep", "Glob")
# a link to a thimble ref (`card:<id>`, `report:<doc>#<id>` …) or a corpus path in a markdown link or a [[…]] citation
_REF_KINDS = ("card:", "cell:", "concept:", "label:", "report:", "view:", "thread:", "chat:", "doc:", "type:", "answer:")
_MD_LINK_RE = re.compile(r"\[[^\]\n]*\]\(([^()\s]+)\)")
_BRACKETS_RE = re.compile(r"\[\[([^\[\]\n]+)\]\]")
# the spans no sentence ends inside: a markdown link, a [[…]] citation, a code span
_PROTECTED_RE = re.compile(r"\[\[[^\[\]\n]*\]\]|\[[^\[\]\n]*\]\([^()\n]*\)|`[^`\n]*`")
_END_RE = re.compile(r"[.!?][\"'”’)\]*_]*(?=\s+[A-Z0-9])")
_LIST_RE = re.compile(r"^[ \t]*(?:[-*]|[0-9]{1,3}\.)[ \t]+")
_HEADING_RE = re.compile(r"^[ \t]*#{1,6}[ \t]+")
_FENCE_RE = re.compile(r"^[ \t]*(```|~~~)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


def _ws_file(c: str, name: str) -> Path:
    return config.workspace_dir(c) / name


def fingerprint(turn: str, text: str) -> str:
    return hashlib.sha1("\x1f".join(["a", turn, _collapse(text).lower()]).encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------- passages


def _blocks(text: str) -> list[tuple[int, int]]:
    """(start, end) of each paragraph or list item of a row's text, a list item's marker and a heading's #s left out;
    a fenced code block and a table's lines hold none."""
    out: list[tuple[int, int]] = []
    pos = 0
    fenced = False
    cur: list[int] | None = None  # [start, end] of the block being read

    def close() -> None:
        nonlocal cur
        if cur is not None and cur[1] > cur[0]:
            out.append((cur[0], cur[1]))
        cur = None

    for line in text.splitlines(keepends=True):
        start, body = pos, line.rstrip("\r\n")
        pos += len(line)
        if _FENCE_RE.match(body):
            close()
            fenced = not fenced
            continue
        if fenced:
            continue
        stripped = body.strip()
        if not stripped or stripped.startswith("|"):
            close()
            continue
        lead = len(body) - len(body.lstrip())
        if (m := _LIST_RE.match(body)) or (m := _HEADING_RE.match(body)):
            close()
            cur = [start + m.end(), start + len(body.rstrip())]
            if _HEADING_RE.match(body):
                close()
            continue
        if cur is None:
            cur = [start + lead, start + len(body.rstrip())]
        else:
            cur[1] = start + len(body.rstrip())
    close()
    return out


def split(text: str) -> list[tuple[int, int]]:
    """(start, end) of each sentence of a row's raw text, in order (module note)."""
    out: list[tuple[int, int]] = []
    for a, b in _blocks(text):
        block = text[a:b]
        guarded = [(m.start(), m.end()) for m in _PROTECTED_RE.finditer(block)]
        s = 0
        for m in _END_RE.finditer(block):
            e = m.end()
            if any(x < m.start() < y for x, y in guarded):
                continue
            if block[s:e].strip():
                out.append((a + s, a + e))
            rest = block[e:]
            s = e + (len(rest) - len(rest.lstrip()))
        if block[s:].strip():
            out.append((a + s, a + len(block.rstrip())))
    return [(x, y) for x, y in out if y > x]


def passages(turn: dict[str, Any]) -> list[dict[str, Any]]:
    """The passages of one answer (`turn`: {turn, rows: [{uuid, text}]}): each sentence {ref, kind, turn, row, start,
    end, text, fp}, refs numbered from 1 across the turn."""
    tid = str(turn.get("turn") or "")
    out: list[dict[str, Any]] = []
    n = 0
    for row in turn.get("rows") or []:
        if not isinstance(row, dict):
            continue
        text, uuid = str(row.get("text") or ""), str(row.get("uuid") or "")
        for a, b in split(text):
            n += 1
            out.append({"ref": f"answer:{tid}#s{n}", "kind": "sentence", "turn": tid, "row": uuid, "start": a, "end": b,
                        "text": text[a:b], "fp": fingerprint(tid, text[a:b])})
    return out


# --------------------------------------------------------------------------- the data turn


def _corpus_ref(ref: str) -> bool:
    r = ref.strip()
    if not r or r.startswith(("http://", "https://", "mailto:", "#")):
        return False
    if r.startswith(_REF_KINDS):
        return True
    path = r.split("#", 1)[0]
    return bool(path) and not path.startswith("/") and "." in path.rsplit("/", 1)[-1]


def cites(text: str) -> bool:
    """Whether an answer's text holds a citation: a [[…]] citation, or a markdown link to a thimble ref or a corpus
    path."""
    for m in _BRACKETS_RE.finditer(text):
        ref = m.group(1).split("|", 1)[1] if "|" in m.group(1) else m.group(1)
        if _corpus_ref(ref):
            return True
    return any(_corpus_ref(m.group(1)) for m in _MD_LINK_RE.finditer(text))


def _named_files(command: str) -> list[str]:
    return [t.strip("'\"") for t in re.split(r"[\s;|&<>()]+", command) if t.strip("'\"")]


def is_data_turn(c: str, turn: dict[str, Any]) -> bool:
    """Whether a turn of main's answered from the data: it called one of thimble's tools, read or searched a data file of
    the corpus (coverage.is_data), or its answer cites (cites)."""
    from . import coverage  # noqa: PLC0415

    try:
        root = config.corpus_dir(c)
    except ValueError:
        return False
    tree = coverage.code_tree(root)
    base = os.path.normpath(str(root))

    def data(path: Any) -> bool:
        p = str(path or "").strip()
        if not p:
            return False
        full = os.path.normpath(p if os.path.isabs(p) else os.path.join(base, p))
        if not (full == base or full.startswith(base + "/")):
            return False
        rel = full[len(base) + 1:] if full != base else ""
        return coverage.is_data(rel, tree) or (not tree and os.path.isdir(full))

    for call in turn.get("tools") or []:
        if not isinstance(call, dict):
            continue
        name = str(call.get("name") or "")
        inp = call.get("input") if isinstance(call.get("input"), dict) else {}
        if name.startswith(THIMBLE_TOOL_PREFIXES):
            return True
        if name in READ_TOOLS and data(inp.get("file_path") or inp.get("notebook_path")):
            return True
        if name in SEARCH_TOOLS and (data(inp.get("path")) or (not tree and not inp.get("path"))):
            return True
        if name == "Bash" and any(data(t) for t in _named_files(str(inp.get("command") or ""))
                                  if "." in t.rsplit("/", 1)[-1]):
            return True
    return any(cites(str(r.get("text") or "")) for r in turn.get("rows") or [] if isinstance(r, dict))


# --------------------------------------------------------------------------- the answers


def _answers(data: Any) -> list[dict[str, Any]]:
    items = data.get("answers") if isinstance(data, dict) else None
    return [a for a in items or [] if isinstance(a, dict) and a.get("turn")]


def store_answer(c: str, turn: dict[str, Any]) -> dict[str, Any] | None:
    """Keep an answer for the checks to read (the last ANSWERS_KEPT): {turn, sid, at, rows}; None for an answer with
    no text row or a turn id that is not one."""
    rows = [{"uuid": str(r.get("uuid") or ""), "text": str(r.get("text") or "")[:TEXT_CHARS]}
            for r in turn.get("rows") or [] if isinstance(r, dict) and str(r.get("text") or "").strip()
            and UUID_RE.match(str(r.get("uuid") or ""))]
    tid = str(turn.get("turn") or (rows[0]["uuid"] if rows else ""))
    if not rows or not UUID_RE.match(tid):
        return None
    try:
        at = float(turn.get("at") or time.time())
    except (TypeError, ValueError):
        at = time.time()
    rec = {"turn": tid, "sid": str(turn.get("sid") or ""), "at": at, "rows": rows}

    def change(data: Any) -> dict[str, Any]:
        kept = [a for a in _answers(data) if a["turn"] != tid]
        return {"answers": [*kept, rec][-ANSWERS_KEPT:]}

    update_json(_ws_file(c, ANSWERS_FILE), change, {"answers": []})
    return rec


def answers(c: str) -> list[dict[str, Any]]:
    """The answers kept, oldest first."""
    return _answers(read_json(_ws_file(c, ANSWERS_FILE), {}))


def all_passages(c: str, turns: list[str] | None = None) -> list[dict[str, Any]]:
    """The passages of the answers kept (of the turns named, when given), oldest answer first."""
    want = set(turns) if turns is not None else None
    return [p for a in answers(c) if want is None or a["turn"] in want for p in passages(a)]


def passage_of(c: str, ref: str, ps: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    r = str(ref or "").strip().strip("[]").strip()
    m = REF_RE.match(r)
    if not m:
        return None
    ps = ps if ps is not None else all_passages(c, [m.group(1)])
    return next((p for p in ps if p["ref"] == r), None)


# --------------------------------------------------------------------------- the comments


def _read(c: str) -> list[dict[str, Any]]:
    data = read_json(_ws_file(c, FILE), {})
    items = data.get("comments") if isinstance(data, dict) else None
    return [x for x in items or [] if isinstance(x, dict) and x.get("id")]


def _change(c: str, fn: Any) -> Any:
    out: dict[str, Any] = {}

    def change(data: Any) -> Any:
        items = data.get("comments") if isinstance(data, dict) else None
        items = [x for x in items or [] if isinstance(x, dict) and x.get("id")]
        out["value"] = fn(items)
        return {"comments": items}

    update_json(_ws_file(c, FILE), change, {"comments": []})
    return out.get("value")


def _emit(c: str, **extra: Any) -> None:
    try:
        investigation.emit(c, investigation.MAIN, {"type": EVENT, **extra})
    except Exception:  # noqa: BLE001 — the pages and the terminal read the file again
        log.debug("%s: answer comments record not emitted", c, exc_info=True)


def _new_id(used: set[str]) -> str:
    while True:
        i = "a" + secrets.token_hex(4)
        if i not in used:
            return i


def add(c: str, *, passage: dict[str, Any], text: str, author: str, details: str = "", check: str | None = None,
        run: str | None = None, evidence: str = "") -> tuple[dict[str, Any], bool]:
    """Store a comment on one passage of an answer, with the passage's raw text as `quote` and its offsets, or find
    the same open one. (the comment, whether it is new)."""
    text = _collapse(text)
    details = str(details or "").strip()[:DETAILS_CHARS]

    def fn(items: list[dict[str, Any]]) -> tuple[dict[str, Any], bool]:
        same = next((x for x in items if x.get("ref") == passage["ref"] and x.get("check") == check
                     and x.get("run") == run and (x.get("status") or "open") == "open"
                     and _collapse(x.get("text")) == text and str(x.get("details") or "") == details), None)
        if same is not None:
            return same, False
        cm = {"id": _new_id({str(x["id"]) for x in items}), "turn": passage["turn"], "row": passage["row"],
              "ref": passage["ref"], "start": passage["start"], "end": passage["end"], "quote": passage["text"],
              "check": check, "run": run, "author": author, "text": text, "details": details, "evidence": evidence,
              "fp": passage["fp"], "ts": _now(), "status": "open", "resolution": None}
        items.append(cm)
        return cm, True

    cm, new = _change(c, fn)
    if new:
        _emit(c, comment=cm["id"])
    return cm, new


def set_status(c: str, cid: str, status: str) -> dict[str, Any]:
    """Dismiss a comment (`dismissed`, resolution done) or open it again (`open`). The comment; 404 for no comment of
    that id."""

    def fn(items: list[dict[str, Any]]) -> dict[str, Any] | None:
        for x in items:
            if str(x["id"]) != cid:
                continue
            if status == "open":
                x["status"] = "open"
                for k in ("resolution", "resolved_ts", "superseded_by"):
                    x.pop(k, None)
                x["resolution"] = None
            else:
                x.update(status=SETTLED, resolution=RESOLUTION_DONE, resolved_ts=_now())
            return dict(x)
        return None

    got = _change(c, fn)
    if got is None:
        raise HTTPException(404, f"no comment {cid!r} on an answer")
    _emit(c, comment=cid)
    return got


def supersede(c: str, check: str, run: str, refs: set[str]) -> int:
    """A run of `check` over answers ended done: its check's earlier open comments on the passages it covered are
    superseded. How many."""

    def fn(items: list[dict[str, Any]]) -> int:
        n = 0
        for x in items:
            if (x.get("check") == check and x.get("run") != run and (x.get("status") or "open") == "open"
                    and x.get("ref") in refs):
                x.update(status=SETTLED, resolution=RESOLUTION_SUPERSEDED, superseded_by=run)
                n += 1
        return n

    n = _change(c, fn) or 0
    if n:
        _emit(c)
    return n


def count(c: str, check: str, run: str) -> int:
    return sum(1 for x in _read(c) if x.get("check") == check and x.get("run") == run)


def open_comments(c: str) -> list[dict[str, Any]]:
    return [x for x in _read(c) if (x.get("status") or "open") == "open"]


def state(c: str, sid: str | None = None, status: str = "open") -> dict[str, Any]:
    """`thimble state answer-comments`: {comments: [{id, check, check_name, color, about, turn, row, ref, start, end,
    quote, text, details, status, at}], running: [{check, check_name, turn}]}, of the session `sid`'s answers when
    given; `color` is the check's color, a label palette place 1-8 (checks.COLOURS), as the browser draws it."""
    from . import checks  # noqa: PLC0415 — checks imports this module

    turns = None
    if sid:
        turns = {a["turn"] for a in answers(c) if a.get("sid") == sid}
    every = {str(x["id"]): x for x in checks.list_checks(c)}
    # a check the analyst turned off leaves nothing in the chat: its comments and its running state stay in the store
    # and come back when it is turned on again (the owner, 10-18)
    off = {cid for cid, x in every.items() if not x.get("shown")}
    out = []
    for x in _read(c):
        if (status == "open" and (x.get("status") or "open") != "open") or (turns is not None and x.get("turn") not in turns):
            continue
        if str(x.get("check") or "") in off:
            continue
        check = every.get(str(x.get("check") or "")) or {}
        out.append({"id": str(x["id"]), "check": str(x.get("check") or ""), "check_name": str(check.get("name") or ""),
                    "color": int(check.get("colour") or checks.COLOURS[0]), "about": str(check.get("about") or ""),
                    "turn": str(x.get("turn") or ""), "row": str(x.get("row") or ""), "ref": str(x.get("ref") or ""),
                    "start": int(x.get("start") or 0), "end": int(x.get("end") or 0), "quote": str(x.get("quote") or ""),
                    "text": str(x.get("text") or ""), "details": str(x.get("details") or ""),
                    "status": "open" if (x.get("status") or "open") == "open" else SETTLED, "at": str(x.get("ts") or "")})
    running = []
    for check in every.values():
        if str(check["id"]) in off:
            continue
        rec = (check.get("runs") or {}).get(ANSWERS)
        if not isinstance(rec, dict) or rec.get("status") != "running":
            continue
        for tid in dict.fromkeys(str(r).split("#", 1)[0].removeprefix("answer:") for r in rec.get("covered") or []):
            if turns is None or tid in turns:
                running.append({"check": str(check["id"]), "check_name": str(check.get("name") or ""), "turn": tid})
    return {"comments": out, "running": running}
