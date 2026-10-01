"""Which files read as a transcript, and the turns of a whole-file JSON transcript.

sniff(path, rel) reads only the head of one file (HEAD_BYTES) and answers whether it looks even close to a transcript,
in any format: a Claude Code stream, JSON lines of messages or of whole conversations, a JSON file holding message lists
(a chat export, an eval log, a plain list of messages), a CSV or TSV file with a speaker column and a text column, or a
text or markdown chat log whose lines start turns (`User: …`, `**Assistant:** …`, `[10:32] alice: …`, `<bob> …`,
`## Human`). The answer is kept per path while its size and mtime_ns stay the same, so the File browser asks on every
open and no corpus is walked. A false positive costs one more mode beside Raw, so the rules are lenient.

The answer, or None:
    {"format": "stream" | "messages" | "conversations" | "json" | "csv" | "text", "score": 0..1,
     "keys"?: {"speaker", "text", "time"}   where a message keeps them (dotted paths into a record, or CSV columns),
     "lines"?: true                          JSON lines in a file the server pages as text (not named .jsonl),
     "style"?: str, "speakers"?: [str]       a text chat log's style of turn line, and who may start a turn in it,
     "delimiter"?: str}
A score of STRONG makes Transcript the file's first mode; WEAK only offers it.

turns(path, rel, ...) parses a whole JSON transcript (or JSON lines the server pages as text) into turns, each with the
line of the file it stands on, for the Transcript mode to page through: GET /corpora/{c}/source/turns.

turn_of(line, style) reads one line of a text chat log: who speaks, when, and where the words start.
"""
from __future__ import annotations

import csv
import datetime as _dt
import io
import json
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter()

HEAD_BYTES = 256 * 1024  # of a file's head that the sniff reads
TEXT_HEAD_LINES = 400  # non-empty lines of a text file's head the sniff looks at
JSONL_HEAD_LINES = 60
STRONG = 0.95
WEAK = 0.5
JSON_MAX_BYTES = 64 * 1024 * 1024  # the largest file turns() parses whole
TURN_TEXT_MAX = 20_000  # characters of one turn's text a page carries
TURNS_PAGE_MAX = 500
SNIFF_CACHE_MAX = 4096
TURNS_CACHE_MAX = 4
PARSING_MAX = 64

SPEAKER_KEYS = ("role", "speaker", "sender", "author", "from", "user", "username", "participant", "character", "who",
                "nick", "persona")
# keys that name who speaks only in a record that also carries a time, since without one a record with a `name` and a
# `body` is as likely a page as a post
WEAK_SPEAKER_KEYS = ("name", "user_name", "editor", "label", "agent")
TEXT_KEYS = ("content", "text", "message", "body", "value", "parts", "utterance", "msg", "change_summary")
TIME_KEYS = ("timestamp", "ts", "time", "created_at", "create_time", "date", "datetime", "sent_at", "created")
TITLE_KEYS = ("title", "name", "subject", "channel", "topic", "thread_title", "id", "uuid")
LIST_KEYS = ("messages", "chat_messages", "conversation", "conversations", "turns", "dialogue", "dialog", "chat",
             "history", "utterances", "transcript", "thread", "replies")
PAIR_KEYS = (("prompt", "response"), ("prompt", "completion"), ("question", "answer"), ("instruction", "output"),
             ("input", "output"))
STREAM_TYPES = {"assistant", "user", "system", "tool_progress", "result"}
NAME_FIELDS = ("name", "display_name", "username", "real_name", "role", "id")

ROLE_WORDS = {"user", "assistant", "human", "ai", "system", "bot", "claude", "chatgpt", "gpt", "model", "agent", "me",
              "you", "interviewer", "interviewee", "q", "a", "question", "answer", "customer", "support", "operator",
              "tool", "moderator", "host", "guest", "narrator", "student", "teacher", "patient", "doctor", "client",
              "therapist", "gemini", "llm", "copilot", "developer"}
NOT_SPEAKERS = {"info", "debug", "warn", "warning", "error", "fatal", "trace", "critical", "notice", "note", "notes",
                "todo", "fixme", "example", "examples", "usage", "returns", "return", "args", "arguments", "params",
                "parameters", "raises", "see", "tip", "important", "caution", "http", "https", "ftp", "file", "step",
                "summary", "status", "result", "results", "output", "input", "source", "date", "version", "author",
                "license", "title", "description", "tags", "type", "id", "name", "url", "link", "path", "total",
                "default", "required", "optional", "answer key", "figure", "table", "chapter", "section", "page"}

TEXTISH = {"", ".txt", ".text", ".md", ".markdown", ".log", ".chat", ".transcript", ".vtt", ".srt", ".rst", ".org",
           ".irc"}
JSONLISH = {".jsonl", ".ndjson", ".jsonlines"}
DELIMITED = {".csv": ",", ".tsv": "\t"}

_NAME = r"[^\W\d_][\w .'@&+-]{0,38}?"
_CLOCK = r"\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?:\s?[APap]\.?[Mm]\.?)?"
_DATE = r"\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}"
# A turn's first line in a text chat log, by style: (name, regex). Each has the group `speaker` (or `speaker2`), may
# have `time`, and the words of the turn start at the end of the match.
STYLES: list[tuple[str, re.Pattern[str]]] = [
    ("whatsapp", re.compile(rf"^\[?(?P<time>{_DATE},?\s+{_CLOCK})\]?\s*(?:[-–]\s+)?(?P<speaker>{_NAME}):\s")),
    ("bracket", re.compile(rf"^\[(?P<time>[^\]\n]{{3,40}})\]\s*(?:<[@+%]?(?P<speaker2>[^>\n]{{1,40}})>\s?|(?P<speaker>{_NAME}):\s?)")),
    ("irc", re.compile(rf"^(?:(?P<time>{_CLOCK})\s+)?<[@+%]?(?P<speaker>[^>\s]{{1,40}})>\s")),
    ("vtt", re.compile(r"^<v\s+(?P<speaker>[^>\n]{1,40})>")),
    ("bold", re.compile(rf"^\s*(?:[-*>]\s+)?\*\*(?P<speaker>{_NAME})\s*(?:\((?P<time>[^)\n]{{1,40}})\))?\s*:?\s*\*\*\s*:?\s*")),
    ("heading", re.compile(rf"^#{{1,4}}\s+(?P<speaker>{_NAME})\s*(?:\((?P<time>[^)\n]{{1,40}})\))?\s*:?\s*$")),
    ("clock-name", re.compile(rf"^\(?(?P<time>{_CLOCK})\)?\s+[-–]?\s*(?P<speaker>{_NAME}):\s")),
    ("name-clock", re.compile(rf"^(?P<speaker>{_NAME})\s*[(\[](?P<time>{_CLOCK})[)\]]\s*:?\s*")),
    ("slack", re.compile(rf"^(?P<speaker>{_NAME})\s{{2,}}(?P<time>{_CLOCK})\s*$")),
    ("colon", re.compile(rf"^\s*(?:>\s*)?(?P<speaker>{_NAME})\s*:(?:\s+|$)")),
]
_STYLE = dict(STYLES)
# the styles that a line of prose or of a document's headings rarely has, so many turns in them make a strong case
# without role words
DISTINCT_STYLES = {"whatsapp", "bracket", "irc", "vtt", "clock-name", "name-clock", "slack"}

_lock = threading.Lock()
_SNIFFS: "OrderedDict[str, tuple[tuple[int, int], dict[str, Any] | None]]" = OrderedDict()
_TURNS: "OrderedDict[str, tuple[tuple[int, int], dict[str, Any]]]" = OrderedDict()
_PARSING: dict[str, threading.Lock] = {}  # per file, so a file asked for twice at once is parsed once


# --------------------------------------------------------------------------- messages


def _name_of(v: Any) -> str | None:
    """Who a speaker value names: a short string, or a person object's name."""
    if isinstance(v, str):
        s = v.strip()
        return s if 0 < len(s) <= 80 else None
    if isinstance(v, dict):
        for k in NAME_FIELDS:
            got = _name_of(v.get(k))
            if got:
                return got
    return None


def _text_of(v: Any, depth: int = 0) -> str | None:
    """The words a text value holds: a string, the text parts of a list, or an object's own text or parts."""
    if isinstance(v, str):
        return v
    if depth > 3:
        return None
    if isinstance(v, list):
        parts = [t for t in (_text_of(x, depth + 1) for x in v) if t]
        return "\n\n".join(parts) if parts else ("" if not v else None)
    if isinstance(v, dict):
        for k in ("text", "parts", "content", "value", "thinking", "result"):
            if k in v:
                got = _text_of(v[k], depth + 1)
                if got is not None:
                    return got
        if v.get("type") == "tool_use":
            return f"{v.get('name') or 'tool'} {json.dumps(v.get('input'), ensure_ascii=False)[:2000]}"
    return None


def _time_of(v: Any) -> str | None:
    """A time value as text: as written, or an ISO stamp in UTC for seconds or milliseconds since 1970."""
    if isinstance(v, str) and re.fullmatch(r"\d{9,13}(?:\.\d+)?", v.strip()):
        v = float(v)
    if isinstance(v, str) and v.strip():
        return v.strip()[:40]
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 1e8:
        secs = v / 1000 if v > 1e11 else v  # milliseconds when it is too large for seconds
        try:
            return _dt.datetime.fromtimestamp(secs, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    return None


def _first(obj: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    return next((k for k in keys if obj.get(k) not in (None, "", [], {})), None)


def message_keys(obj: Any) -> dict[str, str] | None:
    """The keys of a record that hold a message (dotted for a nested `message` or `data`): {speaker, text, time?}, or
    None when it holds none."""
    if not isinstance(obj, dict):
        return None
    for wrap in ("message", "data", "msg"):
        inner = obj.get(wrap)
        if isinstance(inner, dict):
            got = message_keys(inner)
            if got:
                out = {k: f"{wrap}.{v}" for k, v in got.items()}
                if "time" not in out and (t := _first(obj, TIME_KEYS)):
                    out["time"] = t
                return out
    text = next((k for k in TEXT_KEYS if k in obj and _text_of(obj[k]) is not None), None)
    if text is None:
        return None
    time = _first(obj, TIME_KEYS)
    speaker = next((k for k in SPEAKER_KEYS if k != text and _name_of(obj.get(k))), None)
    if speaker is None and time:
        speaker = next((k for k in WEAK_SPEAKER_KEYS if k != text and _name_of(obj.get(k))), None)
    if speaker is None:
        return None
    out = {"speaker": speaker, "text": text}
    if time:
        out["time"] = time
    return out


def _get(obj: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def message_of(obj: Any) -> dict[str, Any] | None:
    """A record as one turn {speaker, text, time?}, or None."""
    keys = message_keys(obj)
    if keys is None:
        return None
    out = {"speaker": _name_of(_get(obj, keys["speaker"])) or "", "text": _text_of(_get(obj, keys["text"])) or ""}
    if "time" in keys and (t := _time_of(_get(obj, keys["time"]))):
        out["time"] = t
    return out


def _mostly(items: list[Any], test) -> bool:
    dicts = [x for x in items if isinstance(x, dict)]
    return bool(dicts) and sum(1 for x in dicts if test(x)) >= max(1, len(dicts) // 2) and len(dicts) >= len(items) // 2


def conversation_of(obj: Any) -> list[dict[str, Any]] | None:
    """The turns of a record that holds a whole conversation: a list of messages under one of LIST_KEYS, a ChatGPT
    export's `mapping`, or a prompt and its response; None otherwise."""
    if not isinstance(obj, dict):
        return None
    mapping = obj.get("mapping")
    if isinstance(mapping, dict) and mapping:
        return _chatgpt_turns(obj, mapping)
    for k in LIST_KEYS:
        v = obj.get(k)
        if isinstance(v, list) and v and _mostly(v, lambda x: message_keys(x) is not None):
            return [m for m in map(message_of, v) if m is not None]
    for a, b in PAIR_KEYS:
        if isinstance(obj.get(a), str) and isinstance(obj.get(b), str):
            return [{"speaker": a, "text": obj[a]}, {"speaker": b, "text": obj[b]}]
    return None


def _chatgpt_turns(conv: dict[str, Any], mapping: dict[str, Any]) -> list[dict[str, Any]]:
    """A ChatGPT export's conversation in order: from its current node back to the root, reversed; empty system nodes
    left out."""
    node_id = conv.get("current_node")
    if node_id not in mapping:
        node_id = next((k for k, v in reversed(list(mapping.items())) if isinstance(v, dict) and not v.get("children")), None)
    chain: list[dict[str, Any]] = []
    seen: set[str] = set()
    while isinstance(node_id, str) and node_id in mapping and node_id not in seen:
        seen.add(node_id)
        node = mapping[node_id] if isinstance(mapping[node_id], dict) else {}
        chain.append(node)
        node_id = node.get("parent")
    out = []
    for node in reversed(chain):
        msg = node.get("message")
        if not isinstance(msg, dict):
            continue
        turn = message_of(msg) or {}
        text = turn.get("text") or ""
        if not text.strip():
            continue
        speaker = _name_of(msg.get("author")) or turn.get("speaker") or ""
        t = {"speaker": speaker, "text": text, "id": node.get("id") or msg.get("id")}
        if (when := _time_of(msg.get("create_time"))) is not None:
            t["time"] = when
        out.append(t)
    return out


def is_stream(obj: Any) -> bool:
    return isinstance(obj, dict) and obj.get("type") in STREAM_TYPES and (
        isinstance(obj.get("message"), dict) or isinstance(obj.get("session_id"), str) or isinstance(obj.get("uuid"), str))


def _title_of(obj: Any) -> str:
    if isinstance(obj, dict):
        for k in TITLE_KEYS:
            v = obj.get(k)
            if isinstance(v, dict):
                v = _name_of(v)
            if isinstance(v, (str, int)) and not isinstance(v, bool) and str(v).strip():
                return str(v).strip()[:120]
    return ""


def conversations_in(data: Any, depth: int = 0, title: str = "") -> list[tuple[str, list[dict[str, Any]]]]:
    """Every conversation a parsed JSON document holds, in order, each as (title, turns): a list of messages, a record
    holding one (conversation_of), or anything nesting those, down to a few levels."""
    if depth > 5:
        return []
    if isinstance(data, list):
        if data and _mostly(data, lambda x: message_keys(x) is not None):
            return [(title, [m for m in map(message_of, data) if m is not None])]
        out = []
        for item in data:
            out.extend(conversations_in(item, depth + 1, _title_of(item)))
        return out
    if isinstance(data, dict):
        turns = conversation_of(data)
        if turns:
            return [(_title_of(data) or title, turns)]
        out = []
        for k, v in data.items():
            if isinstance(v, (list, dict)):
                out.extend(conversations_in(v, depth + 1, _title_of(data) or title))
        return out
    return []


# --------------------------------------------------------------------------- the sniff


def _stat_key(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_size, st.st_mtime_ns


def sniff(path: Path, rel: str) -> dict[str, Any] | None:
    """Whether the file reads as a transcript, from its head (module note); kept per path and (size, mtime_ns)."""
    key = _stat_key(path)
    if key is None:
        return None
    k = str(path)
    with _lock:
        hit = _SNIFFS.get(k)
        if hit is not None and hit[0] == key:
            _SNIFFS.move_to_end(k)
            return hit[1]
    try:
        with open(path, "rb") as f:
            head = f.read(HEAD_BYTES)
    except OSError:
        return None
    try:
        got = sniff_bytes(head, rel, complete=key[0] <= len(head))
    except Exception:  # noqa: BLE001 — a file the sniff cannot read is no transcript
        got = None
    with _lock:
        _SNIFFS[k] = (key, got)
        _SNIFFS.move_to_end(k)
        while len(_SNIFFS) > SNIFF_CACHE_MAX:
            _SNIFFS.popitem(last=False)
    return got


def sniff_bytes(head: bytes, rel: str, complete: bool = False) -> dict[str, Any] | None:
    """The sniff over a file's first bytes; `complete` when they are the whole file."""
    if b"\0" in head[:8192]:
        return None
    text = head.decode("utf-8", "replace")
    if not complete:
        cut = text.rfind("\n")
        text = text[:cut] if cut > 0 else text
    suffix = Path(rel).suffix.lower()
    stripped = text.lstrip("﻿ \t\r\n")
    if suffix in JSONLISH or (suffix == ".json" and stripped[:1] == "{"):
        got = _sniff_jsonl(stripped, parsed=suffix == ".jsonl")
        if got is not None or suffix in JSONLISH:
            return got
    if suffix == ".json" or (suffix in TEXTISH and stripped[:1] in ("[", "{") and suffix not in (".md", ".markdown")):
        got = _sniff_json(stripped, complete)
        if got is not None or suffix == ".json":
            return got
    if suffix in DELIMITED:
        return _sniff_csv(text, DELIMITED[suffix])
    if suffix in TEXTISH:
        return sniff_text(text)
    return None


def _sniff_jsonl(text: str, parsed: bool) -> dict[str, Any] | None:
    """JSON lines: a Claude Code stream, messages, or whole conversations, by what most of the head's records are. In
    a file not named as JSON lines, the first line must be a record of its own, so a pretty-printed document is not
    read by the few lines that hold a whole object."""
    recs = []
    for k, ln in enumerate(x for x in text.split("\n")[:JSONL_HEAD_LINES] if x.strip()):
        try:
            recs.append(json.loads(ln))
        except ValueError:
            if k == 0 and not parsed:
                return None
            continue
    objs = [r for r in recs if isinstance(r, dict)]
    if len(objs) < 1 or (len(recs) > 1 and len(objs) < 2):
        return None
    lines = {} if parsed else {"lines": True}
    n = len(objs)
    if sum(1 for r in objs if is_stream(r)) * 5 >= n * 3:
        return {"format": "stream", "score": 1.0, **lines}
    convs = sum(1 for r in objs if conversation_of(r))
    if convs * 2 >= n:
        return {"format": "conversations", "score": STRONG, **lines}
    keyed = [k for k in map(message_keys, objs) if k]
    if len(keyed) * 2 >= n:
        keys = max(({json.dumps(k, sort_keys=True) for k in keyed}), key=lambda s: sum(1 for k in keyed if json.dumps(k, sort_keys=True) == s))
        best = json.loads(keys)
        speaker_leaf = best["speaker"].rsplit(".", 1)[-1]
        strong = len(keyed) * 10 >= n * 7 and speaker_leaf in SPEAKER_KEYS
        return {"format": "messages", "score": STRONG if strong else WEAK, "keys": best, **lines}
    return None


def _sniff_json(text: str, complete: bool) -> dict[str, Any] | None:
    """A whole JSON document holding message lists: parsed when the head is the whole file, else judged by the keys and
    roles its head names."""
    if complete:
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if data is not None:
            convs = conversations_in(data)
            n = sum(len(t) for _, t in convs)
            if n >= 1:
                return {"format": "json", "score": STRONG if n >= 2 else WEAK}
            return None
    roles = len(re.findall(r'"(?:role|sender|speaker|author|from)"\s*:\s*(?:\{[^{}]{0,200}?"role"\s*:\s*)?"(?:user|assistant|system|human|ai|tool|model|bot|gpt|claude)"', text, re.I))
    speakers = len(re.findall(r'"(?:role|sender|speaker|author|from|user|username)"\s*:\s*[\{"]', text))
    texts = len(re.findall(r'"(?:content|text|message|body|parts|value|utterance)"\s*:', text))
    marker = re.search(r'"(?:messages|chat_messages|conversation|conversations|mapping|turns|dialogue|transcript)"\s*:\s*[\[{]', text)
    if roles >= 2 and texts >= 2:
        return {"format": "json", "score": STRONG}
    if speakers >= 2 and texts >= 2 and (marker or speakers >= 4):
        return {"format": "json", "score": WEAK}
    return None


def _norm(col: str) -> str:
    return re.sub(r"[^a-z0-9]", "", col.lower())


CSV_SPEAKER = ("role", "speaker", "speakername", "author", "authorname", "sender", "sendername", "from", "user",
               "username", "displayname", "participant", "character", "who", "nick", "persona", "name", "agent")
CSV_TEXT = ("content", "text", "message", "messagetext", "body", "utterance", "msg", "transcript", "response", "value",
            "line", "dialogue", "sentence", "comment", "turn")
CSV_TIME = ("timestamp", "ts", "time", "date", "datetime", "createdat", "sentat", "start", "starttime", "created")


def _sniff_csv(text: str, sep: str) -> dict[str, Any] | None:
    """A CSV or TSV file whose first line names a speaker column and a text column."""
    try:
        rows = list(csv.reader(io.StringIO(text), delimiter=sep))[:200]
    except csv.Error:
        return None
    if len(rows) < 2:
        return None
    header = [c.strip() for c in rows[0]]
    norm = [_norm(c) for c in header]

    def col(names: tuple[str, ...]) -> int | None:
        for name in names:
            if name in norm:
                return norm.index(name)
        return None

    s, t = col(CSV_SPEAKER), col(CSV_TEXT)
    if s is None or t is None or s == t:
        return None
    keys = {"speaker": header[s], "text": header[t]}
    if (w := col(CSV_TIME)) is not None:
        keys["time"] = header[w]
    values = [r[s].strip() for r in rows[1:] if len(r) > max(s, t)]
    recurs = len(values) >= 2 and len(set(values)) < len(values)
    strong = norm[s] in CSV_SPEAKER[:12] and recurs
    return {"format": "csv", "score": STRONG if strong else WEAK, "keys": keys, "delimiter": sep}


def turn_of(line: str, style: str) -> dict[str, Any] | None:
    """The turn a text chat log's line starts, in `style`: {speaker, time?, at}, `at` the UTF-16 offset where its words
    start; None for a line that goes on the turn before it."""
    rx = _STYLE.get(style)
    m = rx.match(line) if rx else None
    if not m:
        return None
    speaker = (m.group("speaker") if "speaker" in rx.groupindex else None) or (m.groupdict().get("speaker2"))
    speaker = (speaker or "").strip()
    if not _speaker_ok(speaker):
        return None
    out: dict[str, Any] = {"speaker": speaker, "at": _utf16_len(line[:m.end()])}
    time = m.groupdict().get("time")
    if time:
        out["time"] = time.strip()
    return out


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _speaker_ok(speaker: str) -> bool:
    low = speaker.lower().strip()
    return bool(low) and low not in NOT_SPEAKERS and len(low.split()) <= 4 and not low.startswith(("http", "www."))


def sniff_text(text: str) -> dict[str, Any] | None:
    """A text or markdown chat log: the style whose turn lines recur most in the head, with at least two speakers who
    take turns, one of them more than once."""
    lines = [ln for ln in text.split("\n") if ln.strip()][:TEXT_HEAD_LINES]
    if len(lines) < 2:
        return None
    best: tuple[float, str, int, dict[str, int]] | None = None
    for name, rx in STYLES:
        counts: dict[str, int] = {}
        turns = 0
        for ln in lines:
            t = turn_of(ln, name)
            if t is None:
                continue
            turns += 1
            low = t["speaker"].lower()
            counts[low] = counts.get(low, 0) + 1
        if turns < 2 or len(counts) < 1:
            continue
        roles = sum(n for s, n in counts.items() if s in ROLE_WORDS or re.fullmatch(r"(speaker|person|participant|agent)[ _-]?\w{1,3}", s))
        repeated = max(counts.values()) >= 2
        few = len(counts) <= max(2, turns * 0.6)
        if not (repeated and few and (len(counts) >= 2 or roles >= 2)):
            continue
        if turns < 3 and roles < 2:
            continue
        rank = turns + 2 * roles
        if best is None or rank > best[0]:
            best = (rank, name, turns, counts)
    if best is None:
        return None
    _, name, turns, counts = best
    roles = sum(n for s, n in counts.items() if s in ROLE_WORDS)
    strong = roles >= 2 or (name in DISTINCT_STYLES and turns >= 4)
    out: dict[str, Any] = {"format": "text", "score": STRONG if strong else WEAK, "style": name}
    if name not in DISTINCT_STYLES:
        # a heading, a bold label or a `Word:` line starts a turn only for a speaker the head shows taking turns
        out["speakers"] = sorted(s for s, n in counts.items() if n >= 2 or s in ROLE_WORDS)
    return out


# --------------------------------------------------------------------------- whole-file turns


# a run of characters every JSON writer leaves as they are (no quote, backslash, slash, <, >, &, apostrophe, brace or
# character past ASCII), so it stands verbatim in the raw file whatever wrote it
_VERBATIM = re.compile(r"[A-Za-z0-9 !#$%()*+,\-.:;=?@\[\]^_`|~]{3,}")
LOCATE_BACK = 1_000_000  # characters before the last turn found that a turn not found after it is looked for in


class _Locator:
    """Sets each turn's `line`: where its words (else its id) stand in the raw text, looked for after the turn before
    and, failing that, a little before it; a turn not found keeps the line of the one before. The searches scan at most
    a few times the text in all, so a file whose words the needles miss costs a few passes, not one per turn."""

    def __init__(self, raw: str) -> None:
        self.raw = raw
        self.pos = 0  # where the next search starts
        self.line_pos = 0  # an offset whose line is known: line_at
        self.line_at = 1
        self.budget = 6 * len(raw) + (1 << 20)

    def place(self, turns: list[dict[str, Any]]) -> None:
        raw = self.raw
        for t in turns:
            found, size = -1, 1
            for needle in (_needles(t) if self.budget > 0 else ()):
                at = raw.find(needle, self.pos)
                self.budget -= (at - self.pos) if at >= 0 else (len(raw) - self.pos)
                if at < 0:
                    lo = max(0, self.pos - LOCATE_BACK)
                    at = raw.find(needle, lo, self.pos)
                    self.budget -= self.pos - lo
                if at >= 0:
                    found, size = at, len(needle)
                    break
                if self.budget <= 0:
                    break
            if found >= 0:
                if found >= self.line_pos:
                    self.line_at += raw.count("\n", self.line_pos, found)
                else:
                    self.line_at -= raw.count("\n", found, self.line_pos)
                self.line_pos = found
                self.pos = found + size
            t["line"] = self.line_at


def _needles(t: dict[str, Any]) -> list[str]:
    """What to look for to find a turn in the raw JSON: the first verbatim run of its words, after a quote when it starts
    them; else its first words as JSON writes them, escaped or not; else its id."""
    text = t.get("text") or ""
    out: list[str] = []
    m = _VERBATIM.search(text, 0, 400)
    if m:
        run = m.group()[:60].rstrip()
        if m.start() == 0:
            out.append('"' + run)
        if len(run.strip()) >= 3:
            out.append(run.strip())
    elif text.strip():
        piece = text.strip()[:40]
        out.append(json.dumps(piece, ensure_ascii=False)[1:-1])
        out.append(json.dumps(piece)[1:-1])
    if t.get("id"):
        out.append(json.dumps(str(t["id"]))[1:-1])
    return list(dict.fromkeys(n for n in out if len(n) >= 2))


def _role(speaker: str) -> str:
    low = speaker.lower()
    if low in ("user", "human", "me", "customer", "client", "student", "patient", "interviewee", "prompt", "question",
               "instruction", "input"):
        return "user"
    if low in ("assistant", "ai", "bot", "model", "claude", "chatgpt", "gpt", "gemini", "llm", "copilot", "agent",
               "response", "completion", "answer", "output"):
        return "assistant"
    if low in ("system", "developer"):
        return "system"
    if low in ("tool", "function", "ipython"):
        return "tool"
    return "other"


def parse_turns(path: Path, rel: str) -> dict[str, Any]:
    """Every turn of a whole-file JSON transcript, or of JSON lines the server pages as text, with the groups
    (conversations) they belong to; kept for the last few files read, and read once however many ask for it at the same
    time. Raises HTTPException 413 past JSON_MAX_BYTES, 415 when the file holds no turns."""
    k = str(path)
    with _lock:
        busy = _PARSING.get(k)
        if busy is None:
            if len(_PARSING) >= PARSING_MAX:
                for name in [n for n, lk in _PARSING.items() if not lk.locked()]:
                    del _PARSING[name]
            busy = _PARSING[k] = threading.Lock()
    with busy:
        return _parse_turns(path, rel)


def _parse_turns(path: Path, rel: str) -> dict[str, Any]:
    key = _stat_key(path)
    if key is None:
        raise HTTPException(404, f"no such file: {rel}")
    k = str(path)
    with _lock:
        hit = _TURNS.get(k)
        if hit is not None and hit[0] == key:
            _TURNS.move_to_end(k)
            return hit[1]
    if key[0] > JSON_MAX_BYTES:
        raise HTTPException(413, f"{rel} is {key[0]:,} bytes, more than the {JSON_MAX_BYTES:,} a transcript is read from")
    raw = path.read_bytes().decode("utf-8", "replace")
    groups: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    whole: Any = None
    try:
        whole = json.loads(raw)
    except ValueError:
        whole = None
    if whole is not None:
        locator = _Locator(raw)
        for title, conv in conversations_in(whole):
            if not conv:
                continue
            groups.append({"title": title, "first": len(turns)})
            for t in conv:
                t["group"] = len(groups) - 1
            locator.place(conv)
            turns.extend(conv)
    else:
        for n, ln in enumerate(raw.split("\n"), 1):
            if not ln.strip():
                continue
            try:
                obj = json.loads(ln)
            except ValueError:
                continue
            conv = conversation_of(obj)
            if conv:
                groups.append({"title": _title_of(obj) or f"line {n}", "first": len(turns), "line": n})
                for t in conv:
                    t.update(line=n, group=len(groups) - 1)
                turns.extend(conv)
                continue
            m = message_of(obj)
            if m is not None:
                m["line"] = n
                turns.append(m)
    if not turns:
        raise HTTPException(415, f"{rel} holds no messages to show as a transcript")
    for t in turns:
        t["role"] = _role(t.get("speaker") or "")
        t.pop("id", None)
    out = {"turns": turns, "groups": groups}
    with _lock:
        _TURNS[k] = (key, out)
        _TURNS.move_to_end(k)
        while len(_TURNS) > TURNS_CACHE_MAX:
            _TURNS.popitem(last=False)
    return out


def turns_page(path: Path, rel: str, start: int = 0, count: int = 100, line: int | None = None) -> dict[str, Any]:
    """A page of parse_turns: `count` turns from index `start`, or, given a `line`, from a few turns before the last
    one standing at or before it. Each turn's text is cut at TURN_TEXT_MAX (`cut` says so). `groups` holds the
    conversations the page's turns belong to, by index, and `n_groups` how many the file holds."""
    parsed = parse_turns(path, rel)
    turns = parsed["turns"]
    if line is not None:
        at = 0
        for i, t in enumerate(turns):
            if t["line"] <= line:
                at = i
            else:
                break
        start = max(0, at - 5)
    count = max(1, min(count, TURNS_PAGE_MAX))
    start = max(0, min(start, len(turns)))
    page = []
    for i, t in enumerate(turns[start:start + count], start):
        text = t.get("text") or ""
        item = {"i": i, "line": t["line"], "speaker": t.get("speaker") or "", "role": t["role"], "text": text[:TURN_TEXT_MAX]}
        if len(text) > TURN_TEXT_MAX:
            item["cut"] = len(text)
        for k in ("time", "group"):
            if k in t:
                item[k] = t[k]
        page.append(item)
    groups = parsed["groups"]
    touched = sorted({t["group"] for t in page if "group" in t})
    return {"path": rel, "total": len(turns), "start": start, "turns": page, "n_groups": len(groups),
            "groups": {str(g): groups[g] for g in touched}}


@router.get("/corpora/{c}/source/turns")
def get_turns(c: str, path: str, start: int = 0, count: int = 100, line: int | None = None) -> dict[str, Any]:
    """A page of the turns of a JSON transcript (turns_page): 413 for a file too large, 415 for one with no turns."""
    from . import corpus  # noqa: PLC0415 — corpus imports nothing from here

    p = corpus._file(corpus._corpus(c), path)
    return turns_page(p, path, start, count, line)


def dress(page: dict[str, Any], path: Path, rel: str) -> dict[str, Any]:
    """A page of a file's records with what the Transcript mode needs: the sniff (`transcript`) when the file reads as
    one, and for a text chat log each record that starts a turn its `meta.turn` (turn_of), only for the speakers the
    sniff names when it names them."""
    hint = sniff(path, rel)
    if hint is None:
        return page
    page["transcript"] = hint
    if hint["format"] == "text":
        speakers = set(hint["speakers"]) if "speakers" in hint else None
        for rec in page.get("records") or []:
            text = rec.get("record", {}).get("text") if isinstance(rec.get("record"), dict) else None
            t = turn_of(text, hint["style"]) if isinstance(text, str) else None
            if t is not None and (speakers is None or t["speaker"].lower() in speakers):
                rec.setdefault("meta", {})["turn"] = t
    return page
