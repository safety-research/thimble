"""Which files read as a transcript, and the turns of a whole-file JSON transcript.

sniff(path, rel) reads only the head of one file (HEAD_BYTES) and answers whether it looks even close to a transcript,
in any format: a Claude Code stream, JSON lines of messages or of whole conversations, a JSON file holding message lists
(a chat export, an eval log, a plain list of messages), a CSV or TSV file with a speaker column and a text column, or a
text or markdown chat log whose lines start turns (`User: …`, `**Assistant:** …`, `[10:32] alice: …`, `<bob> …`,
`## Human`, `2026-09-01 10:00 [user] …`, Claude Code's /export with `> ` and `⏺ `, aider's chat history). The answer is kept per path while its size and mtime_ns stay the same, so the File browser asks on every
open and no corpus is walked. A false positive costs one more mode beside Raw, so the rules are lenient: a key names
who speaks in any case style and nesting (`speakerName`, `agent_speaker_id`, `data.speakerId`), but JSON lines read as
messages only when several of them take turns (_takes_turns), and a markdown file's front matter is never a chat log.

The answer, or None:
    {"format": "stream" | "messages" | "conversations" | "json" | "csv" | "text", "score": 0..1,
     "keys"?: {"speaker", "text", "time"}   where a message keeps them (dotted paths into a record, or CSV columns;
                                             "a|b" for who speaks under either key), and for whole conversations,
                                             "list": the key of their list of messages,
     "wrap"?: str                            a stream whose records each nest a stream record under this key,
     "pair"?: [str, str]                     for conversations that are a prompt and its response, their two keys,
     "lines"?: true                          JSON lines in a file the server pages as text (not named .jsonl),
     "style"?: str, "speakers"?: [str]       a text chat log's style of turn line, and who may start a turn in it,
     "delimiter"?: str}
A score of STRONG makes Transcript the file's first mode; WEAK only offers it.

JSON lines are shown from the records the File browser pages; parse_turns() parses a whole-file JSON transcript into
turns, each with the line of the file it stands on, for the Transcript mode to page through: GET
/corpora/{c}/source/turns. A whole-file JSON of any size is offered Transcript; its turns are parsed off the event loop.

turn_of(line, style) reads one line of a text chat log: who speaks, when, and where the words start.
"""
from __future__ import annotations

import csv
import datetime as _dt
import functools
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
FRONT_MATTER_MAX = 400  # lines a front matter may take before its closing fence
KEY_MAX = 64  # characters of a key whose words the sniff reads (_key_words)
JSONL_HEAD_LINES = 60
STRONG = 0.95
WEAK = 0.5
TURN_TEXT_MAX = 20_000  # characters of one turn's text a page carries
TURNS_PAGE_MAX = 500
SNIFF_CACHE_MAX = 4096
TURNS_CACHE_MAX = 4
PARSING_MAX = 64

SPEAKER_KEYS = ("role", "speaker", "sender", "author", "from", "user", "username", "participant", "character", "who",
                "nick", "persona")
# A key names who speaks when one of its words (speakerName, agent_speaker_id, Author-Name) is a speaker word and its
# last word is a speaker word or one of SPEAKER_TAILS. A key whose speaker words are all weak names who speaks only in
# a record that also carries a time, since without one a record with a `name` and a `body` is as likely a page as a post.
SPEAKER_WORDS = frozenset(SPEAKER_KEYS) | {"nickname", "poster", "writer"}
WEAK_SPEAKER_WORDS = frozenset({"name", "editor", "label", "agent"})
SPEAKER_TAILS = SPEAKER_WORDS | WEAK_SPEAKER_WORDS | {"handle", "login", "display", "id", "uuid", "type", "kind"}
# words that make a key name someone other than who speaks, or something about them
NOT_SPEAKER_WORDS = frozenset({"to", "recipient", "recipients", "receiver", "target", "reply", "replied", "mention",
                               "mentions", "mentioned", "parent", "count", "num", "number", "is", "has", "last", "next",
                               "date", "time", "timestamp"})
TEXT_KEYS = ("content", "text", "message", "body", "value", "parts", "utterance", "msg", "change_summary")
TEXT_TAILS = frozenset({"text", "content", "body", "message", "msg", "utterance"})  # of a compound text key (messageText)
TIME_KEYS = ("timestamp", "ts", "time", "created_at", "create_time", "date", "datetime", "sent_at", "created")
TIME_TAILS = frozenset({"time", "timestamp", "ts", "date", "datetime"})  # of a compound time key (createdTime)
TIME_AT = frozenset({"created", "sent", "posted", "published", "written", "updated"})  # of `<word>_at` (sentAt)
# keys whose value names who speaks only when it is a role word, such as LangChain's {"type": "human", "data": {...}}
ROLE_TYPE_KEYS = ("type", "role", "kind")
WRAP_KEYS = ("message", "data", "msg", "payload")  # where a record nests its message (payload: Codex CLI's logs)
# where a record that holds no message of its own may nest one, or nest a Claude Code stream record (the Agent SDK's
# messages kept under `content` beside a database row's own columns)
MORE_WRAPS = ("content", "record", "event", "entry", "item")
MIN_TURNS = 3  # turn-like records a head needs when its speakers are not role words
TITLE_KEYS = ("title", "name", "subject", "channel", "topic", "thread_title", "id", "uuid")
LIST_KEYS = ("messages", "chat_messages", "conversation", "conversations", "turns", "dialogue", "dialog", "chat",
             "history", "utterances", "transcript", "thread", "replies")
PAIR_KEYS = (("prompt", "response"), ("prompt", "completion"), ("question", "answer"), ("instruction", "output"),
             ("input", "output"))
STREAM_TYPES = {"assistant", "user", "system", "tool_progress", "result"}
# where a person object keeps its name: these keys, then a key of NAME_NORMS in any case style (`displayName`), then
# its role or id
NAME_FIELDS = ("name", "display_name", "username", "real_name")
NAME_NORMS = frozenset({"name", "displayname", "username", "realname", "fullname", "nickname", "nick", "handle", "login"})
NAME_LAST = ("role", "id")

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
_STAMP = rf"(?:{_DATE}[ T,]+)?{_CLOCK}(?:Z|[+-]\d{{2}}:?\d{{2}}|\s?UTC)?"  # a clock, after a date or not, with a zone or not
# A turn's first line in a text chat log, by style: (name, regex). Each has the group `speaker` (or `speaker2`), may
# have `time` (or `time2`), and the words of the turn start at the end of the match.
STYLES: list[tuple[str, re.Pattern[str]]] = [
    ("whatsapp", re.compile(rf"^\[?(?P<time>{_DATE},?\s+{_CLOCK})\]?\s*(?:[-–]\s+)?(?P<speaker>{_NAME}):\s")),
    ("bracket", re.compile(rf"^\[(?P<time>[^\]\n]{{3,40}})\]\s*(?:<[@+%]?(?P<speaker2>[^>\n]{{1,40}})>\s?|(?P<speaker>{_NAME}):\s?)")),
    ("irc", re.compile(rf"^(?:(?P<time>{_CLOCK})\s+)?<[@+%]?(?P<speaker>[^>\s]{{1,40}})>\s")),
    ("vtt", re.compile(r"^<v\s+(?P<speaker>[^>\n]{1,40})>")),
    ("bold", re.compile(rf"^\s*(?:[-*>]\s+)?\*\*(?P<speaker>{_NAME})\s*(?:\((?P<time>[^)\n]{{1,40}})\))?\s*:?\s*\*\*"
                        rf"\s*(?:\((?P<time2>{_STAMP}|{_DATE})\))?\s*:?\s*")),
    ("heading", re.compile(rf"^#{{1,4}}\s+(?P<speaker>{_NAME})\s*(?:\((?P<time>[^)\n]{{1,40}})\))?\s*:?\s*$")),
    ("clock-name", re.compile(rf"^\(?(?P<time>{_CLOCK})\)?\s+[-–]?\s*(?P<speaker>{_NAME}):\s")),
    ("name-clock", re.compile(rf"^(?P<speaker>{_NAME})\s*[(\[](?P<time>{_STAMP})[)\]]\s*:?\s*")),
    ("slack", re.compile(rf"^(?P<speaker>{_NAME})\s{{2,}}(?P<time>{_CLOCK})\s*$")),
    ("tagged", re.compile(rf"^(?:(?P<time>{_DATE}[ T]{_CLOCK}\S*)\s+)?\[(?P<speaker>{_NAME})\]:?\s")),
    ("cc", re.compile(r"^(?P<mark>[>⏺●])\s(?=\S)")),
    ("aider", re.compile(r"^(?P<mark>####)\s")),
    ("colon", re.compile(rf"^\s*(?:>\s*)?(?P<speaker>{_NAME})\s*:(?:\s+|$)")),
]
# who a mark that starts a turn stands for: Claude Code's /export (`> ` the user's prompt, `⏺ ` or `● ` Claude's reply)
# and aider's chat history (`#### ` the user's message)
MARKS = {">": "User", "⏺": "Claude", "●": "Claude", "####": "User"}
AIDER_HEAD = "# aider chat started at"
AIDER_OUTPUT = "Aider"  # who speaks a run of aider's own `> ` lines
AIDER_REPLY = "Assistant"
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
    """Who a speaker value names: a short one-line string, a number (an id), or a person object's name."""
    if isinstance(v, str):
        s = v.strip()
        return s if 0 < len(s) <= 80 and "\n" not in s else None
    if isinstance(v, int) and not isinstance(v, bool):
        return str(v)
    if isinstance(v, dict):
        for k in NAME_FIELDS:
            got = _name_of(v.get(k))
            if got:
                return got
        for k, x in v.items():
            if isinstance(k, str) and _norm(k) in NAME_NORMS:
                got = _name_of(x)
                if got:
                    return got
        for k in NAME_LAST:
            got = _name_of(v.get(k))
            if got:
                return got
    return None


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_CAPS = re.compile(r"([A-Z]+)([A-Z][a-z])")
_WORD = re.compile(r"[a-z0-9]+")


def _key_words(key: str) -> tuple[str, ...]:
    """A key's words, in any case style: `agent_speaker_id`, `speakerName`, `Speaker-Type`, `userID`; none for a key
    longer than KEY_MAX, which names no speaker, text or time."""
    return _split_key(key) if len(key) <= KEY_MAX else ()


@functools.lru_cache(maxsize=4096)
def _split_key(key: str) -> tuple[str, ...]:
    return tuple(_WORD.findall(_CAPS.sub(r"\1 \2", _CAMEL.sub(r"\1 \2", key)).lower()))


def _speaker_rank(key: str) -> tuple[int, int, int, int] | None:
    """How surely a key's name says it holds who speaks, lower first: (weak, tail, compound, order), the tail 0 for a
    name, 1 for an id, 2 for a type, or a role beside another word (`speaker_type`); None for a key that names no
    speaker."""
    return _rank_key(key) if len(key) <= KEY_MAX else None


@functools.lru_cache(maxsize=4096)
def _rank_key(key: str) -> tuple[int, int, int, int] | None:
    words = _key_words(key)
    if not words or len(words) > 4 or words[-1] not in SPEAKER_TAILS or "".join(words) == "useragent":
        return None
    if any(w in NOT_SPEAKER_WORDS for w in words):
        return None
    strong = any(w in SPEAKER_WORDS for w in words)
    if not strong and not any(w in WEAK_SPEAKER_WORDS for w in words):
        return None
    tail = words[-1]
    rank = 1 if tail in ("id", "uuid") else 2 if tail in ("type", "kind") or (tail == "role" and len(words) > 1) else 0
    single = len(words) == 1
    order = SPEAKER_KEYS.index(words[0]) if single and words[0] in SPEAKER_KEYS else len(SPEAKER_KEYS)
    if single and words[0] == "name":  # after the other weak keys: it names a page or a thread as often as who speaks
        order += 1
    return (0 if strong else 1, rank, 0 if single else 1, order)


def _speaker_key(obj: dict[str, Any], skip: str | None, timed: bool) -> str | None:
    """The key of `obj` that most surely holds who speaks (_speaker_rank) and holds a name; a weak one only when the
    record carries a time (`timed`)."""
    best: tuple[tuple[int, int, int, int], str] | None = None
    for k, v in obj.items():
        if not isinstance(k, str) or k == skip:
            continue
        rank = _speaker_rank(k)
        if rank is None or (rank[0] and not timed) or not _name_of(v):
            continue
        if best is None or rank < best[0]:
            best = (rank, k)
    return best[1] if best else None


def _time_key(obj: dict[str, Any]) -> str | None:
    """The key of a record's time: one of TIME_KEYS, else a key whose last word says it is one (`createdTime`,
    `sentAt`)."""
    got = _first(obj, TIME_KEYS)
    if got:
        return got
    for k, v in obj.items():
        if not isinstance(k, str) or v in (None, "") or isinstance(v, (dict, list, bool)):
            continue
        words = _key_words(k)
        if words and (words[-1] in TIME_TAILS or (len(words) == 2 and words[1] == "at" and words[0] in TIME_AT)):
            return k
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


def message_keys(obj: Any, timed: bool = False, depth: int = 0) -> dict[str, str] | None:
    """The keys of a record that hold a message (dotted for a nested one, as `message.author`): {speaker, text, time?},
    or None when it holds none. `timed` when a record around it carries the time."""
    if not isinstance(obj, dict) or depth > 3:
        return None
    outer_time = _time_key(obj)
    for wrap in WRAP_KEYS:
        inner = obj.get(wrap)
        if isinstance(inner, dict):
            got = message_keys(inner, timed or bool(outer_time), depth + 1)
            if got:
                out = {k: f"{wrap}.{v}" for k, v in got.items()}
            elif (text := _text_key(inner)) and (role := _role_key(obj)):
                out = {"speaker": role, "text": f"{wrap}.{text}"}
            else:
                continue
            if "time" not in out and outer_time:
                out["time"] = outer_time
            return out
    got = _own_message_keys(obj, timed)
    if got is not None or depth:
        return got
    for wrap in MORE_WRAPS:
        inner = obj.get(wrap)
        if isinstance(inner, dict) and (got := message_keys(inner, bool(outer_time), depth + 1)):
            out = {k: f"{wrap}.{v}" for k, v in got.items()}
            if "time" not in out and outer_time:
                out["time"] = outer_time
            return out
    return None


def _own_message_keys(obj: dict[str, Any], timed: bool) -> dict[str, str] | None:
    """message_keys among a record's own keys, nested ones aside."""
    text = _text_key(obj)
    if text is None:
        return None
    time = _time_key(obj)
    speaker = _speaker_key(obj, text, timed or bool(time)) or _role_key(obj)
    if speaker is None:
        return None
    out = {"speaker": speaker, "text": text}
    if time:
        out["time"] = time
    return out


def _text_key(obj: dict[str, Any]) -> str | None:
    """The key of a record's words: one of TEXT_KEYS, else a key of a string whose last word says it holds words
    (`messageText`, `body_text`)."""
    got = next((k for k in TEXT_KEYS if k in obj and _text_of(obj[k]) is not None), None)
    if got:
        return got
    for k, v in obj.items():
        if isinstance(k, str) and isinstance(v, str):
            words = _key_words(k)
            if 2 <= len(words) <= 3 and words[-1] in TEXT_TAILS:
                return k
    return None


def _role_key(obj: dict[str, Any]) -> str | None:
    """The key of ROLE_TYPE_KEYS whose value is a role word, such as `"type": "human"`."""
    return next((k for k in ROLE_TYPE_KEYS if isinstance(obj.get(k), str) and obj[k].strip().lower() in ROLE_WORDS), None)


def _get(obj: Any, dotted: str) -> Any:
    """A record's value at a dotted key; for `a|b`, the first of the keys that holds a value."""
    if "|" in dotted:
        for alt in dotted.split("|"):
            v = _get(obj, alt)
            if v not in (None, "", [], {}):
                return v
        return None
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


def stream_wrap(obj: Any) -> str | None:
    """Where a record holds a Claude Code stream record: "" for one that is one, the key of one it nests (MORE_WRAPS,
    WRAP_KEYS), else None."""
    if is_stream(obj):
        return ""
    if isinstance(obj, dict):
        for k in (*MORE_WRAPS, *WRAP_KEYS):
            if is_stream(obj.get(k)):
                return k
    return None


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
    jsonish = suffix == ".json" or (suffix in TEXTISH and suffix not in (".md", ".markdown"))
    if suffix in JSONLISH or (jsonish and stripped[:1] == "{"):
        got = _sniff_jsonl(stripped, parsed=suffix == ".jsonl")
        if got is not None or suffix in JSONLISH:
            return got
    if suffix == ".json" or (jsonish and stripped[:1] in ("[", "{")):
        got = _sniff_json(stripped, complete)
        if got is not None or suffix == ".json":
            return got
    if suffix in DELIMITED:
        return _sniff_csv(text, DELIMITED[suffix])
    if suffix in TEXTISH:
        return sniff_text(text, markdown=suffix in (".md", ".markdown"))
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
    wraps = [w for w in map(stream_wrap, objs) if w is not None]
    if len(wraps) * 5 >= n * 3:
        # a stream in a file paged as text shows as posts, under the keys its messages keep; one nested in each record
        # says under which key (`wrap`)
        keyed = [k for k in map(message_keys, objs) if k]
        wrap = _commonest(wraps)
        return {"format": "stream", "score": 1.0, **({"wrap": wrap} if wrap else {}), **lines,
                **({"keys": _commonest(keyed)} if lines and keyed else {})}
    convs = sum(1 for r in objs if conversation_of(r))
    if convs * 2 >= n:
        found = [k for k in map(_conversation_keys, objs) if k]
        return {"format": "conversations", "score": STRONG, **lines, **(_commonest(found) if found else {})}
    keyed_objs = [(r, k) for r in objs if (k := message_keys(r))]
    if not (len(keyed_objs) * 2 >= n or (len(keyed_objs) >= 2 and len(keyed_objs) * 5 >= n)):
        return None
    best = _commonest([k for _, k in keyed_objs])
    speakers = [s for r, _ in keyed_objs if (s := _name_of(_get(r, best["speaker"])))]
    if not _takes_turns(speakers):
        return None
    others = _other_speakers(objs, best)
    if others:
        best = {**best, "speaker": "|".join([best["speaker"], *others])}
    with_speaker = sum(1 for r in objs if _name_of(_get(r, best["speaker"])))
    roles = sum(1 for s in speakers if s.lower() in ROLE_WORDS) * 2 >= len(speakers)
    sure_key = roles or _sure_speaker_key(best["speaker"].split("|")[0].rsplit(".", 1)[-1])
    strong = (len(keyed_objs) * 2 >= n and with_speaker * 10 >= n * 7 and sure_key
              and _in_time_order([_get(r, best["time"]) for r in objs] if "time" in best else []))
    return {"format": "messages", "score": STRONG if strong else WEAK, "keys": best, **lines}


def _sure_speaker_key(leaf: str) -> bool:
    """Whether a key names who speaks by name or role (`author`, `speakerName`, `role`), not by an id or a type
    (`user_id`, `speaker_type`)."""
    words, rank = _key_words(leaf), _speaker_rank(leaf)
    return (rank is not None and rank[:2] == (0, 0)) or (len(words) == 1 and words[0] in ROLE_TYPE_KEYS)


def _speaker_leaf(data: Any, sample: int = 200) -> str | None:
    """The commonest key (its last part) under which the first `sample` messages a parsed JSON document holds keep who
    speaks, or None."""
    leaves: dict[str, int] = {}
    stack: list[tuple[Any, int]] = [(data, 0)]
    while stack and sum(leaves.values()) < sample:
        x, depth = stack.pop()
        if isinstance(x, dict):
            keys = message_keys(x)
            if keys:
                leaf = keys["speaker"].rsplit(".", 1)[-1]
                leaves[leaf] = leaves.get(leaf, 0) + 1
                continue
            items: Any = x.values()
        elif isinstance(x, list):
            items = reversed(x)
        else:
            continue
        if depth < 6:
            stack.extend((v, depth + 1) for v in items if isinstance(v, (dict, list)))
    return max(leaves, key=leaves.__getitem__) if leaves else None


def _takes_turns(speakers: list[str]) -> bool:
    """Whether the speakers of a head's turn-like records take turns: role words (a user and an assistant) in at least
    two, else MIN_TURNS or more in which some speaker speaks again and most do not speak only once, so a file of
    documents each by its own author is no transcript."""
    if len(speakers) < 2:
        return False
    counts: dict[str, int] = {}
    for s in speakers:
        counts[s.lower()] = counts.get(s.lower(), 0) + 1
    if sum(c for s, c in counts.items() if s in ROLE_WORDS) * 2 >= len(speakers):
        return True
    return len(speakers) >= MIN_TURNS and max(counts.values()) >= 2 and len(counts) <= max(2, len(speakers) * 0.8)


def _other_speakers(objs: list[dict[str, Any]], keys: dict[str, str]) -> list[str]:
    """The keys that hold who speaks in the records where `keys["speaker"]` holds no one (a village's agents' actions
    beside its people's talk), most used first, at most three, beside it in the same nested record."""
    prefix, _, _ = keys["speaker"].rpartition(".")
    counts: dict[str, int] = {}
    for r in objs:
        if _name_of(_get(r, keys["speaker"])):
            continue
        inner = _get(r, prefix) if prefix else r
        if isinstance(inner, dict) and (k := _speaker_key(inner, keys.get("text", "").rsplit(".", 1)[-1], "time" in keys)):
            counts[k] = counts.get(k, 0) + 1
    ranked = sorted(counts, key=lambda k: -counts[k])[:3]
    return [f"{prefix}.{k}" if prefix else k for k in ranked]


_ISO = re.compile(r"\d{4}-\d{2}-\d{2}")


def _in_time_order(values: list[Any]) -> bool:
    """Whether a head's records follow their times, forward or back (a transcript reads in order; rows of a table in
    any order read better as the table): true when at most a fifth of the steps between times go the other way, and
    when too few times compare (ISO stamps or numbers) to tell."""
    keys: list[Any] = []
    for v in values:
        if isinstance(v, str) and _ISO.match(v.strip()):
            keys.append(v.strip()[:10] + " " + v.strip()[11:])
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            keys.append(float(v))
    keys = [k for k in keys if type(k) is type(keys[0])] if keys else []
    if len(keys) < 3:
        return True
    steps = list(zip(keys, keys[1:]))
    up = sum(1 for a, b in steps if b >= a)
    down = sum(1 for a, b in steps if b <= a)
    return max(up, down) * 5 >= len(steps) * 4


def _commonest(items: list[Any]) -> Any:
    counts: dict[str, int] = {}
    for it in items:
        k = json.dumps(it, sort_keys=True)
        counts[k] = counts.get(k, 0) + 1
    return json.loads(max(counts, key=counts.__getitem__))


def _conversation_keys(obj: Any) -> dict[str, Any] | None:
    """Where a record holding a whole conversation keeps it, for the Transcript mode to read its turns:
    {"keys": {"list", "speaker", "text", "time"?}} for a list of messages, {"pair": [prompt key, response key]} for a
    prompt and its response; None for any other (a ChatGPT export's `mapping`)."""
    if not isinstance(obj, dict):
        return None
    for k in LIST_KEYS:
        v = obj.get(k)
        if isinstance(v, list) and v and _mostly(v, lambda x: message_keys(x) is not None):
            return {"keys": {"list": k, **_commonest([m for m in map(message_keys, v) if m])}}
    for a, b in PAIR_KEYS:
        if isinstance(obj.get(a), str) and isinstance(obj.get(b), str):
            return {"pair": [a, b]}
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
            if n < 2:
                return {"format": "json", "score": WEAK} if n else None
            # messages under a key that names no speaker outright (`user_id`, `label`, `agentName`) are a transcript
            # only when their speakers take turns, and a sure one only under a key that names them
            speakers = [t["speaker"] for _, turns in convs for t in turns if t.get("speaker")][:400]
            if sum(1 for sp in speakers if _role(sp) != "other") * 2 >= len(speakers):
                return {"format": "json", "score": STRONG}
            leaf = _speaker_leaf(data)
            if leaf in SPEAKER_KEYS:
                return {"format": "json", "score": STRONG}
            if not _takes_turns(speakers):
                return None
            return {"format": "json", "score": STRONG if leaf and _sure_speaker_key(leaf) else WEAK}
    roles = len(re.findall(r'"(?:role|sender|speaker|author|from)"\s*:\s*(?:\{[^{}]{0,200}?"role"\s*:\s*)?"(?:user|assistant|system|human|ai|tool|model|bot|gpt|claude)"', text, re.I))
    speakers = len(re.findall(r'"(?:role|sender|speaker|author|from|user|username|[A-Za-z_]*(?:[Ss]peaker|[Aa]uthor|[Ss]ender)[A-Za-z_]*)"\s*:\s*[\{"]', text))
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
    """A CSV or TSV file whose first line names a speaker column and a text column; a speaker column named in another
    way (Speaker Name, agent_speaker_id) counts when its speakers take turns (_takes_turns)."""
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

    s, t, w = col(CSV_SPEAKER), col(CSV_TEXT), col(CSV_TIME)
    lenient = s is None
    if s is None:
        # a speaker column named in any case style (Speaker Name, agent_speaker_id), a weak one beside a time column
        ranked = sorted((r, i) for i, h in enumerate(header) if (r := _speaker_rank(h)) is not None and (not r[0] or w is not None))
        s = ranked[0][1] if ranked else None
    if t is None:
        t = next((i for i, h in enumerate(header) if 2 <= len(ws := _key_words(h)) <= 3 and ws[-1] in TEXT_TAILS), None)
    if s is None or t is None or s == t:
        return None
    keys = {"speaker": header[s], "text": header[t]}
    if w is not None:
        keys["time"] = header[w]
    values = [r[s].strip() for r in rows[1:] if len(r) > max(s, t)]
    if lenient and not _takes_turns([v for v in values if v]):
        return None
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
    groups = m.groupdict()
    speaker = MARKS.get(groups.get("mark") or "") or groups.get("speaker") or groups.get("speaker2")
    speaker = (speaker or "").strip()
    if not _speaker_ok(speaker):
        return None
    out: dict[str, Any] = {"speaker": speaker, "at": _utf16_len(line[:m.end()])}
    time = groups.get("time") or groups.get("time2")
    if time:
        out["time"] = time.strip()
    return out


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _speaker_ok(speaker: str) -> bool:
    low = speaker.lower().strip()
    return bool(low) and low not in NOT_SPEAKERS and len(low.split()) <= 4 and not low.startswith(("http", "www."))


# the first line of a front matter: a YAML `key:`, a TOML `key =` or a TOML `[table]`
_FRONT_KEY = re.compile(r"""^(?:["']?[^\W\d][\w .-]*["']?\s*(?::(?=\s|$)|=)|\[[^\]\n]+\]\s*$)""")


def front_matter_lines(lines: list[str]) -> int:
    """How many of a file's first lines its front matter takes (YAML between `---` lines, TOML between `+++` lines),
    both fences counted; 0 for a file with none, or whose first line inside is no key, as a paragraph between two rules."""
    if not lines or lines[0].lstrip("\ufeff").strip() not in ("---", "+++"):
        return 0
    fence = lines[0].lstrip("\ufeff").strip()
    first = next((ln for ln in lines[1:FRONT_MATTER_MAX] if ln.strip() and not ln.lstrip().startswith("#")), "")
    if not _FRONT_KEY.match(first):
        return 0
    for i in range(1, min(len(lines), FRONT_MATTER_MAX)):
        if lines[i].strip() == fence or (fence == "---" and lines[i].strip() == "..."):
            return i + 1
    return 0


def sniff_text(text: str, markdown: bool = False) -> dict[str, Any] | None:
    """A text or markdown chat log: the style whose turn lines recur most in the head, with at least two speakers who
    take turns, one of them more than once. In markdown, which reads well rendered, the sniff is sure only when turn
    lines are at least a fifth of the head's lines, so a document quoting an example exchange keeps Rendered first. A
    front matter's lines are no turns, nor are `Word:` lines indented deeper than others (a YAML file's nested keys)."""
    raw = text.split("\n")
    lines = [ln for ln in raw[front_matter_lines(raw):] if ln.strip()][:TEXT_HEAD_LINES]
    if len(lines) < 2:
        return None
    best: tuple[float, str, int, dict[str, int]] | None = None
    for name, rx in STYLES:
        counts: dict[str, int] = {}
        turns = 0
        hits = [(ln, t) for ln in lines if (t := turn_of(ln, name)) is not None]
        if name == "colon" and hits:
            # a chat log's turns start at its shallowest indent, a YAML file's repeated keys under parents shallower
            # than them: only the shallowest indent that two `Word:` lines share counts
            by_indent: dict[int, list[tuple[str, dict[str, Any]]]] = {}
            for ln, t in hits:
                by_indent.setdefault(len(ln) - len(ln.lstrip()), []).append((ln, t))
            hits = next((by_indent[n] for n in sorted(by_indent) if len(by_indent[n]) >= 2), [])
        for _, t in hits:
            turns += 1
            low = t["speaker"].lower()
            counts[low] = counts.get(low, 0) + 1
        if turns < 2 or len(counts) < 1:
            continue
        if name == "cc" and len(counts) < 2:
            continue  # a prompt and a reply, so quoted lines alone are no export
        if name == "aider" and not any(ln.startswith(AIDER_HEAD) for ln in lines):
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
    strong = name in ("cc", "aider") or (
        (roles >= 2 or (name in DISTINCT_STYLES and turns >= 4)) and (not markdown or turns * 5 >= len(lines)))
    out: dict[str, Any] = {"format": "text", "score": STRONG if strong else WEAK, "style": name}
    if name not in DISTINCT_STYLES and name != "aider":
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
    time. Raises HTTPException 415 when the file holds no turns."""
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
    """A page of the turns of a JSON transcript (turns_page): 415 for one with no turns."""
    from . import corpus  # noqa: PLC0415 — corpus imports nothing from here

    p = corpus._file(corpus._corpus(c), path)
    return turns_page(p, path, start, count, line)


def _aider_turns(records: list[dict[str, Any]]) -> None:
    """aider's chat history as turns: a run of `#### ` lines is the user's message, a run of `> ` lines aider's own
    output, and the first other line after either starts the model's reply."""
    prev = ""
    for rec in records:
        text = rec.get("record", {}).get("text") if isinstance(rec.get("record"), dict) else None
        if not isinstance(text, str) or not text.strip():
            continue
        kind, turn = "reply", None
        if text.startswith(AIDER_HEAD):
            kind = "head"
        elif text.startswith("#### "):
            kind = "user"
            if prev != "user":
                turn = {"speaker": MARKS["####"], "at": 5}
        elif text.startswith(">"):
            kind = "aider"
            if prev != "aider":
                turn = {"speaker": AIDER_OUTPUT, "at": 2 if text.startswith("> ") else 1}
        elif prev in ("user", "aider"):
            turn = {"speaker": AIDER_REPLY, "at": 0}
        if turn is not None:
            rec.setdefault("meta", {})["turn"] = turn
        prev = kind


def dress(page: dict[str, Any], path: Path, rel: str) -> dict[str, Any]:
    """A page of a file's records with what the Transcript mode needs: the sniff (`transcript`) when the file reads as
    one, and for a text chat log each record that starts a turn its `meta.turn` (turn_of), only for the speakers the
    sniff names when it names them, or a role such as `System` that first speaks past the head."""
    hint = sniff(path, rel)
    if hint is None:
        return page
    page["transcript"] = hint
    if hint["format"] == "text" and hint.get("style") == "aider":
        _aider_turns(page.get("records") or [])
    elif hint["format"] == "text":
        speakers = set(hint["speakers"]) if "speakers" in hint else None
        for rec in page.get("records") or []:
            text = rec.get("record", {}).get("text") if isinstance(rec.get("record"), dict) else None
            t = turn_of(text, hint["style"]) if isinstance(text, str) else None
            if t is not None and (speakers is None or t["speaker"].lower() in speakers or t["speaker"].lower() in ROLE_WORDS):
                rec.setdefault("meta", {})["turn"] = t
    return page
