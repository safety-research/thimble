"""The file browser (/thimble-files): the folder's files as a tree, and one file opened in the modes its kind offers,
written as views (views/SPEC.md) under .thimble-cc-mod/files/ for the panel to draw as it draws any view.

    python3 files.py tree --root DIR --out DIR         every file: folder, type, size, records, its first lines
    python3 files.py open PATH [--at N | --from N] --root DIR --out DIR
                                                       one file's records: Transcript, Table and Raw tabs, WINDOW
                                                       lines (a JSON list's items) at a time, the window holding
                                                       line N

Each writes view.json and rows.json (in parts when large, as viewpipe.write_rows does) in --out, and prints one JSON
line: {"ok", "name", "slug", "tabs", "rows"} or {"ok": false, "error"}. A file is read again only when it, or the
folder's labels.json, changed since its view was written.

The kinds follow thimble's File browser (backend/app/transcripts.py sniff): a file reads as a transcript when its
records name who speaks and what they said and the speakers take turns; Transcript is its first tab when the speakers
are role words (user, assistant), else Table is first and Transcript offered. Raw shows the lines with their numbers.
Rows keep their text cut (CELL, TEXT, RAW characters) and a view holds one window of WINDOW lines, since the panel holds
and lays out every row at once (a view of tens of thousands of long rows outlasts the hooks worker's patience); the
header pages through the windows, and each row's ref opens the whole record.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import viewhost  # noqa: E402
import viewpipe  # noqa: E402

SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"}
FILES_MAX = 20_000  # files the tree lists
COUNT_BYTES = 1_000_000_000  # bytes the tree reads in all to count records; later files show none
HEAD_BYTES = 256 * 1024
HEADS_FULL = 2_000  # files of the tree whose kind is read from HEAD_BYTES, and whose first lines it keeps; later ones from SHORT_HEAD
HEAD_LINES = 6  # a file's first lines the tree keeps, for its detail
HEAD_CHARS = 160  # characters of each of them
SHORT_HEAD = 16 * 1024
WINDOW = 4_000  # lines (a JSON list's items) a file's view holds
CELL = 80  # characters of a table cell
TEXT = 240  # characters of a turn's words
RAW = 140  # characters of a raw line
COLUMNS_MAX = 12
JSON_MAX = 64 * 1024 * 1024  # a whole JSON file parsed for its records

JSONLISH = {".jsonl", ".ndjson", ".jsonlines"}
DELIMITED = {".csv": ",", ".tsv": "\t"}
TEXTISH = {"", ".txt", ".text", ".log", ".chat", ".transcript", ".vtt", ".srt", ".rst", ".org", ".irc", ".out", ".err"}
MARKDOWN = {".md", ".markdown"}
CODE = {".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".sh", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cc",
        ".hpp", ".cs", ".php", ".pl", ".r", ".sql", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".html", ".css", ".xml",
        ".swift", ".kt", ".scala", ".lua", ".ipynb"}
DATABASE = {".db", ".sqlite", ".sqlite3"}
IMAGE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
OPENS = {"transcript", "records", "table", "json", "text", "markdown", "code"}  # the kinds a file view shows

SPEAKER_KEYS = ("role", "speaker", "sender", "author", "from", "user", "username", "participant", "character", "who",
                "nick", "persona")
WEAK_SPEAKERS = ("label", "editor", "agent", "name")  # who speaks only beside a time, as thimble's sniff reads them
TEXT_KEYS = ("content", "text", "message", "body", "value", "parts", "utterance", "msg", "change_summary")
TIME_KEYS = ("timestamp", "ts", "time", "created_at", "create_time", "date", "datetime", "sent_at", "created")
WRAPS = ("message", "data", "msg", "payload")
NAME_KEYS = ("name", "display_name", "username", "role", "id")
TOOL_NAME_KEYS = ("tool_name", "tool", "function", "name")
TOOL_IN_KEYS = ("tool_call", "tool_input", "input", "arguments", "args")
TOOL_OUT_KEYS = ("tool_result", "tool_output", "output", "result")
STREAM_TYPES = {"assistant", "user", "system", "result", "summary"}
ROLE_WORDS = {"user", "assistant", "human", "ai", "system", "bot", "claude", "model", "agent", "tool", "developer",
              "function", "gpt", "chatgpt", "gemini", "llm", "interviewer", "interviewee", "customer", "support"}
TITLE_KEYS = ("title", "name", "subject", "page_id", "id", "key", "record_id", "event_id", "rev_id", "uuid")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$")
HEADING = re.compile(r"^(#{1,6})\s+(.*\S)")
CHAT_LINE = re.compile(r"^\s*(?:\[[^\]\n]{3,40}\]\s*)?(?:\*\*)?(?P<who>[^\W\d_][\w .'@-]{0,30}?)(?:\*\*)?\s*:\s+(?P<said>\S.*)$")


# ------------------------------------------------------------------------------------------------ small readers


def cut(s: str, n: int) -> str:
    s = s.replace("\r", "")
    return s if len(s) <= n else s[: n - 1] + "…"


def flat(v) -> str:
    """A value as one string: a string as it is, anything else as compact JSON."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"), default=str)


def get(obj, dotted: str):
    for part in dotted.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def name_of(v) -> str:
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    if isinstance(v, dict):
        for k in NAME_KEYS:
            if isinstance(v.get(k), str) and v[k].strip():
                return v[k].strip()
    return ""


def first(obj: dict, keys) -> str | None:
    return next((k for k in keys if k in obj), None)


def head_text(path: str, size: int = HEAD_BYTES) -> tuple[str, bool]:
    """The file's first `size` bytes as text (cut at the last whole line) and whether they hold a NUL (binary)."""
    with open(path, "rb") as f:
        head = f.read(size)
    if b"\0" in head[:8192]:
        return "", True
    text = head.decode("utf-8", "replace")
    if len(head) == size and "\n" in text:
        text = text[: text.rfind("\n")]
    return text, False


# ------------------------------------------------------------------------------------------------ transcripts


def message_keys(obj, timed: bool = False) -> dict | None:
    """Where a record keeps who speaks, what they said and when (dotted keys), looking in it and in a nested message."""
    if not isinstance(obj, dict):
        return None
    for prefix, inner in [("", obj)] + [(w + ".", obj[w]) for w in WRAPS if isinstance(obj.get(w), dict)]:
        tk = first(inner, TIME_KEYS) or (first(obj, TIME_KEYS) if prefix else None)
        sk = next((k for k in SPEAKER_KEYS if name_of(inner.get(k))), None)
        if sk is None and (tk or timed):
            sk = next((k for k in WEAK_SPEAKERS if name_of(inner.get(k))), None)
        xk = next((k for k in TEXT_KEYS if k != sk and isinstance(inner.get(k), (str, list, dict)) and inner.get(k)), None)
        if sk and xk:
            out = {"speaker": prefix + sk, "text": prefix + xk}
            if tk:
                out["time"] = (prefix + tk) if tk in inner else tk
            return out
    return None


def is_stream(obj) -> bool:
    """A Claude Code session record: a type of message and the message under `message`."""
    return isinstance(obj, dict) and obj.get("type") in STREAM_TYPES and isinstance(obj.get("message"), dict)


def takes_turns(speakers: list[str]) -> bool:
    if len(speakers) < 2:
        return False
    counts: dict[str, int] = {}
    for s in speakers:
        counts[s.lower()] = counts.get(s.lower(), 0) + 1
    if sum(c for s, c in counts.items() if s in ROLE_WORDS) * 2 >= len(speakers):
        return True
    return len(speakers) >= 3 and max(counts.values()) >= 2 and len(counts) <= max(2, len(speakers) * 0.8)


def sniff_records(objs: list) -> dict | None:
    """Whether JSON records read as a transcript: {"keys", "strong"} or {"stream": True, "strong": True}, else None."""
    dicts = [o for o in objs if isinstance(o, dict)]
    if len(dicts) < 2:
        return None
    if sum(1 for o in dicts if is_stream(o)) * 5 >= len(dicts) * 3:
        return {"stream": True, "strong": True}
    keyed = [(o, k) for o in dicts if (k := message_keys(o))]
    n = len(dicts)
    if not (len(keyed) * 2 >= n or (len(keyed) >= 2 and len(keyed) * 5 >= n)):
        return None
    counts: dict[str, int] = {}
    for _, k in keyed:
        j = json.dumps(k, sort_keys=True)
        counts[j] = counts.get(j, 0) + 1
    keys = json.loads(max(counts, key=counts.__getitem__))
    speakers = [s for o, _ in keyed if (s := name_of(get(o, keys["speaker"])))]
    if not takes_turns(speakers):
        return None
    roles = sum(1 for s in speakers if s.lower() in ROLE_WORDS) * 2 >= len(speakers)
    return {"keys": keys, "strong": roles and len(keyed) * 2 >= n}


def blocks_text(v) -> tuple[str, list[str], str]:
    """A message's content as (words, folded tool lines, kind): a string, or a list of blocks (text, thinking,
    tool_use, tool_result) as Claude's API and Claude Code write them."""
    if isinstance(v, str):
        return v, [], "message"
    if isinstance(v, dict):
        v = [v]
    if not isinstance(v, list):
        return flat(v), [], "message"
    words, tools, kinds = [], [], set()
    for b in v:
        if isinstance(b, str):
            words.append(b)
            continue
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text" or (t is None and isinstance(b.get("text"), str)):
            words.append(str(b.get("text") or ""))
            kinds.add("message")
        elif t == "thinking":
            kinds.add("thinking")
            words.append(str(b.get("thinking") or ""))
        elif t == "tool_use":
            kinds.add("tool call")
            tools.append(fold_call(str(b.get("name") or "tool"), b.get("input")))
        elif t == "tool_result":
            kinds.add("tool result")
            got, _, _ = blocks_text(b.get("content"))
            tools.append("◂ " + (("error: " if b.get("is_error") else "") + one_line(got) or "(empty)"))
        else:
            words.append(flat(b.get("text") or b.get("content") or ""))
    kind = "message" if "message" in kinds or not kinds else sorted(kinds)[0]
    return "\n".join(w for w in words if w.strip()), tools, kind


def one_line(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def fold_call(name: str, args) -> str:
    """A tool call on one line: its name and its first argument's words."""
    if isinstance(args, dict):
        main = next((args[k] for k in ("command", "cmd", "text", "query", "file_path", "path", "url", "pattern", "code")
                     if isinstance(args.get(k), str)), None)
        shown = main if main is not None else flat(args)
    else:
        shown = flat(args)
    # a tool call folded to one line: the tool's name and what it was given (no glyph: the name says it is a call)
    return f"{name} {one_line(shown)}".rstrip()


def turn_of(obj, sniffed: dict) -> dict | None:
    """One record as a turn: speaker, words (with its tool calls folded to a line each), time, kind."""
    if not isinstance(obj, dict):
        return None
    if sniffed.get("stream"):
        if not is_stream(obj):
            return None
        m = obj["message"]
        speaker = name_of(m.get("role")) or str(obj.get("type"))
        words, tools, kind = blocks_text(m.get("content"))
        return {"speaker": speaker, "text": "\n".join([words] + tools).strip(), "time": obj.get("timestamp"), "kind": kind}
    keys = sniffed["keys"]
    speaker = name_of(get(obj, keys["speaker"]))
    words, tools, kind = blocks_text(get(obj, keys["text"]))
    # a record of one tool call, its input and output beside the message keys (an eval's transcript)
    tool = next((obj[k] for k in TOOL_NAME_KEYS[:3] if isinstance(obj.get(k), str)), None)
    if tool and not words.strip():
        tin = next((obj[k] for k in TOOL_IN_KEYS if k in obj), None)
        tout = next((obj[k] for k in TOOL_OUT_KEYS if k in obj), None)
        if isinstance(tin, str):
            try:
                tin = json.loads(tin)
            except ValueError:
                pass
        tools = [fold_call(tool, tin)] + ([f"◂ {one_line(flat(tout))}"] if tout not in (None, "") else [])
        kind = "tool call"
    if not speaker and not words and not tools:
        return None
    return {"speaker": speaker or "–", "text": "\n".join([words] + tools).strip(), "time": get(obj, keys["time"]) if keys.get("time") else None,
            "kind": kind}


# ------------------------------------------------------------------------------------------------ kinds


def kind_of(path: str, rel: str, head: int = HEAD_BYTES) -> tuple[str, dict]:
    """A file's kind from its name and head, and what the head showed (its transcript keys, a CSV's delimiter)."""
    ext = os.path.splitext(rel)[1].lower()
    if ext in DATABASE:
        return "database", {}
    if ext == ".pdf":
        return "pdf", {}
    if ext in IMAGE:
        return "image", {}
    try:
        text, binary = head_text(path, head)
    except OSError:
        return "other", {}
    if binary:
        return "binary", {}
    if ext in JSONLISH or (ext in TEXTISH and text.lstrip()[:1] == "{" and "\n" in text.strip()):
        objs = []
        for ln in text.split("\n")[:60]:  # as many as thimble's sniff reads
            if ln.strip():
                try:
                    objs.append(json.loads(ln))
                except ValueError:
                    pass
        if objs and (ext in JSONLISH or len(objs) >= 2):
            s = sniff_records(objs)
            return ("transcript" if s else "records"), {"transcript": s} if s else {}
    if ext == ".json":
        return "json", {}
    if ext in DELIMITED:
        info = {"delimiter": DELIMITED[ext]}
        s = sniff_csv(text, DELIMITED[ext])
        if s:
            info["transcript"] = s
        return ("transcript" if s and s["strong"] else "table"), info
    if ext in MARKDOWN:
        return "markdown", {}
    if ext in CODE:
        return "code", {}
    s = sniff_chat(text.split("\n"))
    if s:
        return "transcript", {"transcript": s}
    return "text", {}


def sniff_csv(text: str, sep: str) -> dict | None:
    try:
        rows = list(csv.reader(io.StringIO(text), delimiter=sep))[:200]
    except csv.Error:
        return None
    if len(rows) < 3:
        return None
    header = [c.strip() for c in rows[0]]
    low = [re.sub(r"[^a-z0-9]", "", c.lower()) for c in header]
    sk = next((header[low.index(k)] for k in SPEAKER_KEYS + ("speakername", "authorname") if k in low), None)
    xk = next((header[low.index(k)] for k in TEXT_KEYS + ("messagetext", "comment", "line", "dialogue") if k in low), None)
    if not sk or not xk or sk == xk:
        return None
    tk = next((header[low.index(k)] for k in TIME_KEYS if k in low), None)
    i = header.index(sk)
    speakers = [r[i].strip() for r in rows[1:] if len(r) > i and r[i].strip()]
    if not takes_turns(speakers):
        return None
    keys = {"speaker": sk, "text": xk, **({"time": tk} if tk else {})}
    return {"keys": keys, "strong": sum(1 for s in speakers if s.lower() in ROLE_WORDS) * 2 >= len(speakers)}


def sniff_chat(lines: list[str]) -> dict | None:
    """A text chat log whose lines start turns (`User: …`, `[10:32] alice: …`, `**Assistant:** …`)."""
    turns = [m.group("who").strip().lower() for ln in lines[:400] if (m := CHAT_LINE.match(ln))]
    if len(turns) < 3 or not takes_turns(turns):
        return None
    counts = {t: turns.count(t) for t in set(turns)}
    if len(counts) > max(2, len(turns) * 0.6):
        return None
    return {"chat": True, "strong": sum(1 for t in turns if t in ROLE_WORDS) * 2 >= len(turns)}


def count_records(path: str, kind: str, size: int, budget: list[int]) -> int | None:
    """Lines of a text file (records of JSON lines, rows of a CSV file less its header), while the budget lasts."""
    if kind not in OPENS or kind == "json" or size > budget[0]:
        return None
    budget[0] -= size
    n, last = 0, b"\n"
    try:
        with open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                n += chunk.count(b"\n")
                last = chunk[-1:]
    except OSError:
        return None
    n += 0 if last == b"\n" or size == 0 else 1
    return max(0, n - 1) if kind == "table" else n


# ------------------------------------------------------------------------------------------------ the tree


def natural(name: str) -> list:
    """A name's sort key with its numbers as numbers: a2 before a10."""
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r"(\d+)", name)]


def walk(root: str) -> tuple[list[str], int]:
    """Every file of the folder by its path, the mod's own and hidden folders left out; how many more there were."""
    out: list[str] = []
    more = 0
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted((x for x in dirs if not x.startswith(".") and x not in SKIP_DIRS), key=natural)
        for f in sorted(files, key=natural):
            if f.startswith("."):
                continue
            if len(out) >= FILES_MAX:
                more += 1
                continue
            out.append(os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/"))
    return out, more


def kb(size: int) -> float:
    k = size / 1024
    return round(k, 1) if k < 10 else round(k)


def type_of(rel: str) -> str:
    """A file's type as its name says it: its extension without the dot, or "none"."""
    ext = os.path.splitext(rel)[1].lower().lstrip(".")
    return ext or "none"


def head_lines(path: str) -> list[str]:
    """A text file's first HEAD_LINES lines, each cut to HEAD_CHARS characters, read without reading the whole file."""
    out: list[str] = []
    try:
        with open(path, "rb") as f:
            for _ in range(HEAD_LINES):
                raw = f.readline(HEAD_CHARS * 4 + 1)
                if not raw:
                    break
                ln = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                out.append(cut(ln.expandtabs(2), HEAD_CHARS) or " ")
                # a line longer than the read: skip to its end
                if not raw.endswith(b"\n"):
                    while (rest := f.readline(1 << 16)) and not rest.endswith(b"\n"):
                        pass
    except OSError:
        return []
    return out


def tree(root: str, out: str) -> dict:
    paths, more = walk(root)
    base = os.path.basename(os.path.abspath(root)) or "folder"
    budget = [COUNT_BYTES]
    rows = []
    for i, rel in enumerate(paths):
        full = os.path.join(root, rel)
        try:
            size = os.path.getsize(full)
        except OSError:
            continue
        kind, _ = kind_of(full, rel, HEAD_BYTES if i < HEADS_FULL else SHORT_HEAD)
        folder = os.path.dirname(rel)
        row = {"path": rel, "name": os.path.basename(rel), "folder": f"{base}/{folder}/" if folder else f"{base}/",
               "type": type_of(rel), "kind": kind, "size": kb(size), "records": count_records(full, kind, size, budget),
               "ref": f"{rel}#L1" if kind in OPENS else rel}
        # its first lines, which its detail shows before it is opened
        if i < HEADS_FULL and kind in OPENS:
            row["head"] = head_lines(full)
        rows.append(row)
    spec = {
        "version": 1, "name": "Files", "slug": "files",
        "description": "Every file of the folder, by folder, with its type, records and size; a click shows its first lines, a second opens it.",
        "scope": ["**/*"],
        "collections": [{
            "name": "files", "one": "one file of the folder", "key": "path", "title": "name", "ref": "ref",
            "opens": "path",
            "fields": [
                {"name": "path", "type": "text"},
                {"name": "name", "type": "text"},
                {"name": "folder", "type": "category"},
                {"name": "type", "type": "category", "label": "type"},
                {"name": "kind", "type": "category", "label": "opens as"},
                {"name": "records", "type": "number", "label": "records", "derived": "computed",
                 "from": "the file's lines", "how": "lines counted, a CSV file's header left out"},
                {"name": "size", "type": "number", "unit": "KB"},
                {"name": "head", "type": "list", "label": "first lines"},
                {"name": "ref", "type": "ref"},
            ],
            # the detail: the file's first lines, and what opening it shows
            "detail": {"fields": [], "lines": "head"},
        }],
        "stats": [{"label": "files", "collection": "files", "agg": "count"},
                  {"label": "records", "collection": "files", "agg": "sum", "field": "records"}],
        "tabs": [{
            "name": "Files", "collection": "files",
            "zoom": "nothing: the tree has no overview",
            "filter": {"fields": ["type", "folder"], "search": ["path"]},
            # in the walk's order: folders that fold, names with their numbers as numbers, each file's dot in its type's
            # hue
            "body": [{"kind": "table", "group": "folder", "color": "type",
                      "columns": [{"field": "name"}, {"field": "type"}, {"field": "records"}, {"field": "size"}]}],
        }],
        "labels": False,
    }
    data = {"collections": {"files": rows}, "problems": [], "files": len(rows),
            "hidden": [{"path": f"{more} more files", "why": f"the tree lists the first {FILES_MAX:,}"}] if more else []}
    write(out, spec, data)
    return {"ok": True, "name": "Files", "slug": "files", "tabs": ["Files"], "rows": len(rows)}


# ------------------------------------------------------------------------------------------------ one file


def slug_of(rel: str) -> str:
    return "file-" + hashlib.sha1(rel.encode()).hexdigest()[:12]


def time_value(v):
    """A time a field can declare as time (ISO 8601, epoch seconds or milliseconds), else None."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and 1e8 < v < 1e14:
        return v
    if isinstance(v, str) and ISO.match(v.strip()):
        return v.strip()
    return None


def column_fields(records: list[dict], skip: set[str], text_key: str | None) -> list[dict]:
    """The table's columns: the keys most records have (in the order first seen), each typed by its values."""
    seen: dict[str, int] = {}
    sample = records[:3000]
    for r in sample:
        for k in r:
            seen[k] = seen.get(k, 0) + 1
    keys = [k for k, n in seen.items() if n * 20 >= len(sample) and k not in skip][:COLUMNS_MAX]
    out = []
    for i, k in enumerate(keys):
        vs = [r.get(k) for r in sample if r.get(k) not in (None, "")]
        if vs and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vs):
            t = "number"
        elif vs and all(isinstance(v, str) and ISO.match(v.strip()) for v in vs):
            t = "time"
        elif vs and all(isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) or x is None for x in v) and len(v) <= 12 for v in vs):
            t = "list"
        else:
            distinct = len({flat(v) for v in vs})
            short = all(len(flat(v)) <= 40 for v in vs)
            t = "category" if vs and short and 2 <= distinct <= 30 and distinct * 3 <= len(vs) else "text"
        out.append({"name": f"c{i}", "type": t, "label": k, "key": k, "long": k == text_key})
    return out


def cell(f: dict, v):
    if v is None or v == "":
        return None
    t = f["type"]
    if t == "number":
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    if t == "time":
        return time_value(v)
    if t == "list":
        return [x if isinstance(x, (str, int, float, bool)) or x is None else flat(x) for x in v] if isinstance(v, list) else [cut(flat(v), CELL)]
    return cut(flat(v), TEXT if f.get("long") else CELL)


def title_field(cols: list[dict], records: list[dict]) -> str | None:
    """The column a person reads as a record's name: a title or name key, else an id, unique enough to tell rows apart."""
    by = {f["key"].lower(): f for f in cols if f["type"] in ("text", "category")}
    for k in TITLE_KEYS:
        if k in by:
            return by[k]["name"]
    return None


def read_lines(path: str, start: int, count: int | None) -> tuple[list[tuple[int, str]], int]:
    """The file's lines from line `start` (`count` of them, or all), each with its number, and how many it has."""
    out, n = [], 0
    with open(path, "rb") as f:
        for raw in f:
            n += 1
            if n >= start and (count is None or n < start + count):
                out.append((n, raw.decode("utf-8", "replace").rstrip("\r\n")))
    return out, n


def window_start(n: int) -> int:
    """The first line of the window that holds line (or item) n."""
    return (max(1, n) - 1) // WINDOW * WINDOW + 1


def open_file(root: str, rel: str, out: str, start: int = 1) -> dict:
    full = os.path.join(root, rel)
    if not os.path.isfile(full) or os.path.relpath(os.path.realpath(full), os.path.realpath(root)).startswith(".."):
        return {"ok": False, "error": f"no file {rel} in this folder"}
    st = os.stat(full)
    labels_file = os.path.join(viewpipe.home(root), "labels.json")
    stamp = f"{st.st_size}:{st.st_mtime_ns}:{os.path.getmtime(labels_file) if os.path.exists(labels_file) else 0}:{start}"
    slug = slug_of(rel)
    try:
        with open(os.path.join(out, "view.json"), encoding="utf-8") as f:
            old = json.load(f)
        if old.get("stamp") == stamp and os.path.exists(os.path.join(out, "rows.json")):
            return {"ok": True, "name": old["name"], "slug": slug, "tabs": [t["name"] for t in old["tabs"]], "cached": True}
    except (OSError, ValueError, KeyError):
        pass
    kind, info = kind_of(full, rel)
    if kind not in OPENS:
        return {"ok": False, "error": f"{rel} is a {kind} file, which the file browser does not open"}
    ext = os.path.splitext(rel)[1].lower()
    lines, total = read_lines(full, start, WINDOW)
    units, unit = total, "lines"
    records: list[dict] = []  # each {"n": line, "obj": dict, "ref"}
    turns: list[dict] = []  # each {"n", "ref", speaker, text, time, kind}
    sniffed = info.get("transcript")
    if kind in ("records", "transcript") and (ext in JSONLISH or not (sniffed or {}).get("chat")):
        for n, ln in lines:
            if not ln.strip():
                continue
            try:
                obj = json.loads(ln)
            except ValueError:
                continue
            if isinstance(obj, dict):
                records.append({"n": n, "obj": obj, "ref": f"{rel}#L{n}"})
                if sniffed and (t := turn_of(obj, sniffed)):
                    turns.append({"n": n, "ref": f"{rel}#L{n}", **t})
    elif kind in ("table", "transcript") and ext in DELIMITED:
        # the whole file, as a quoted cell may run over lines; the rows that start in the window kept
        text = "\n".join(ln for _, ln in read_lines(full, 1, None)[0])
        rd = csv.reader(io.StringIO(text), delimiter=info.get("delimiter", ","))
        try:
            header = next(rd)
            first = rd.line_num + 1
            for row in rd:
                if start <= first < start + WINDOW:
                    obj = dict(zip(header, row))
                    records.append({"n": first, "obj": obj, "ref": f"{rel}#L{first}"})
                    if sniffed:
                        k = sniffed["keys"]
                        turns.append({"n": first, "ref": f"{rel}#L{first}", "speaker": obj.get(k["speaker"]) or "–",
                                      "text": obj.get(k["text"]) or "", "time": obj.get(k.get("time", "")), "kind": "message"})
                first = rd.line_num + 1
        except (csv.Error, StopIteration):
            pass
    elif kind == "json" and st.st_size <= JSON_MAX:
        try:
            with open(full, encoding="utf-8", errors="replace") as f:
                doc = json.load(f)
        except ValueError:
            doc = None
        items, at = (doc, "") if isinstance(doc, list) else next(
            ((v, "/" + k) for k, v in (doc or {}).items() if isinstance(v, list) and v and isinstance(v[0], dict)), (None, "")) if isinstance(doc, dict) else (None, "")
        if items:
            units, unit = len(items), "items"
            sniffed = sniff_records([x for x in items[:200] if isinstance(x, dict)])
            for i, obj in enumerate(items[start - 1:start - 1 + WINDOW], start - 1):
                if not isinstance(obj, dict):
                    continue
                ref = f"{rel}#{at}/{i}"
                records.append({"n": i + 1, "obj": obj, "ref": ref})
                if sniffed and (t := turn_of(obj, sniffed)):
                    turns.append({"n": i + 1, "ref": ref, **t})
    elif sniffed and sniffed.get("chat"):
        cur = None
        for n, ln in lines:
            m = CHAT_LINE.match(ln)
            if m:
                cur = {"n": n, "ref": f"{rel}#L{n}", "speaker": m.group("who").strip(), "text": m.group("said"), "time": None, "kind": "message"}
                turns.append(cur)
            elif cur is not None and ln.strip():
                cur["text"] += "\n" + ln
                cur["ref"] = f"{rel}#L{cur['n']}-L{n}"

    collections, tabs, cols_spec, stats = {}, [], [], []
    base = os.path.basename(rel)
    # a file longer than a window: the header says which lines the view holds and pages to the others
    window = {"from": start, "to": min(units, start + WINDOW - 1), "total": units, "unit": unit} if units > WINDOW or start > 1 else None
    if kind == "json" and unit == "lines":
        # a JSON document's lines and its items do not window alike: its Raw shows the window's lines
        window = {"from": start, "to": min(total, start + WINDOW - 1), "total": total, "unit": "lines"} if total > WINDOW or start > 1 else None

    # Transcript and Table. Where each turn is a record (JSON lines, CSV rows, a JSON list) both tabs draw the one
    # collection, the Transcript the records with a speaker; else (a chat log, a JSON document of conversations) the
    # turns are a collection of their own.
    record_ns = {r["n"] for r in records}
    merged = bool(turns) and bool(records) and all(t["n"] in record_ns for t in turns)
    timed = bool(turns) and sum(1 for t in turns if time_value(t.get("time")) is not None) * 2 >= len(turns)
    keys = (sniffed or {}).get("keys") or {}
    # the record's own keys the turn's fields stand for, which the table then shows under their names
    top = {k: v for k, v in keys.items() if k in ("speaker", "text", "time") and "." not in v and "|" not in v} if merged else {}
    if not timed:
        top.pop("time", None)
    turn_of_n = {}
    for t in turns:
        r = {"speaker": cut(str(t["speaker"]), 60), "said": cut(t["text"], TEXT) or "(empty)", "kind": t["kind"]}
        if timed and (tv := time_value(t.get("time"))) is not None:
            r["time"] = tv
        turn_of_n[t["n"]] = r
    turn_decl = [{"name": "speaker", "type": "category", "label": top.get("speaker", "speaker")},
                 {"name": "said", "type": "text", "label": top.get("text", "said")},
                 {"name": "kind", "type": "category"},
                 *([{"name": "time", "type": "time", "label": top.get("time", "time")}] if timed else [])]
    kinds = {r["kind"] for r in turn_of_n.values()}
    speakers = {r["speaker"] for r in turn_of_n.values()}
    if turns:
        tcol = "records" if merged else "turns"
        tab = {"name": "Transcript", "collection": tcol,
               **({"where": {"field": "speaker", "not": None}} if merged else {}),
               "zoom": "a click on a bar keeps that speaker's turns",
               "filter": {"fields": ["speaker"] + (["kind"] if len(kinds) > 1 else []), "search": ["said", "speaker"]},
               "body": [{"kind": "transcript", "speaker": "speaker", "text": "said", **({"time": "time"} if timed else {}),
                         "sort": {"field": "n"}}]}
        if 1 < len(speakers) <= 40:
            tab["overview"] = {"kind": "bars", "field": "speaker"}
        tabs.append(tab)
        if not merged:
            collections["turns"] = [{"n": t["n"], "ref": t["ref"], **turn_of_n[t["n"]]} for t in turns]
            cols_spec.append({
                "name": "turns", "one": "one turn: who spoke and what they said", "key": "n", "title": "speaker", "ref": "ref",
                "fields": [{"name": "n", "type": "number", "label": "line"}, *turn_decl, {"name": "ref", "type": "ref"}],
                "detail": {"meta": ["kind", *(["time"] if timed else [])], "text": "said"},
            })
        stats.append({"label": "turns", "collection": tcol, "agg": "count", **({"where": {"field": "speaker", "not": None}} if merged else {})})
        stats.append({"label": "speakers", "collection": tcol, "agg": "distinct", "field": "speaker"})

    # Table: a row per record, its keys as columns
    if records:
        objs = [r["obj"] for r in records]
        fields = column_fields(objs, set(top.values()), None)
        title = title_field(fields, objs)
        rows = []
        for r in records:
            row = {"n": r["n"], "ref": r["ref"]}
            for f in fields:
                v = cell(f, r["obj"].get(f["key"]))
                if v is not None:
                    row[f["name"]] = v
            if merged and r["n"] in turn_of_n:
                row.update(turn_of_n[r["n"]])
            rows.append(row)
        collections["records"] = rows
        decl = [{k: v for k, v in f.items() if k in ("name", "type", "label")} for f in fields]
        long = "said" if merged else next(
            (f["name"] for f in fields if f["type"] == "text" and f["name"] != title and any(len(str(x.get(f["name"], ""))) > 60 for x in rows[:200])), None)
        cats = [f for f in fields if f["type"] == "category"]
        meta = ["speaker", *(["time"] if timed else [])] if merged else []
        cols_spec.append({
            "name": "records", "one": "one record of the file", "key": "n", "title": title or "n", "ref": "ref",
            "fields": [{"name": "n", "type": "number", "label": "line" if ext != ".json" else "#"}, *decl,
                       *(turn_decl if merged else []), {"name": "ref", "type": "ref"}],
            "detail": {**({"meta": meta} if meta else {}),
                       "fields": [f["name"] for f in fields if f["name"] not in (title, long)] + (["kind"] if merged and len(kinds) > 1 else []),
                       **({"text": long} if long else {})},
        })
        shown = [f["name"] for f in fields if f["name"] not in (long, title)]
        if merged:
            shown = [x for x in ("speaker", "time") if x in meta] + shown
        tab = {"name": "Table", "collection": "records",
               "zoom": "nothing: the table has no overview",
               "filter": {"fields": [f["name"] for f in cats[:3]],
                          "search": [f["name"] for f in fields if f["type"] in ("text", "category", "list")] + (["said", "speaker"] if merged else []) or ["n"]},
               "body": [{"kind": "table", "sort": {"field": "n"},
                         "columns": [{"field": "n"}] + ([{"field": title}] if title else []) + [{"field": x} for x in shown[:8]]}]}
        # no overview: a table shows the records, and its filter narrows them (views/SPEC.md, "The file browser")
        # Table first unless the file reads surely as a transcript
        if sniffed and sniffed.get("strong"):
            tabs.append(tab)
        else:
            tabs.insert(0, tab)
        stats.insert(0, {"label": "records", "collection": "records", "agg": "count"})

    # Raw: the lines with their numbers; markdown under its headings
    md = ext in MARKDOWN
    section, rows = "", []
    for n, ln in lines:
        if md:
            h = HEADING.match(ln)
            if h:
                section = cut(h.group(2), 60)
            if not ln.strip():
                continue
        row = {"n": n, "ref": f"{rel}#L{n}", "line": cut(ln.expandtabs(2), RAW) or " "}
        if md:
            row["section"] = section or base
        rows.append(row)
    collections["lines"] = rows
    cols_spec.append({
        "name": "lines", "one": "one line of the file", "key": "n", "title": "line", "ref": "ref",
        "fields": [{"name": "n", "type": "number", "label": "line"}, {"name": "line", "type": "text", "label": "text"},
                   *([{"name": "section", "type": "text"}] if md else []), {"name": "ref", "type": "ref"}],
        "detail": {"text": "line"},
    })
    tabs.append({"name": "Raw", "collection": "lines", "zoom": "nothing: the raw lines have no overview",
                 "filter": {"fields": [], "search": ["line"]},
                 "body": [{"kind": "table", "sort": {"field": "n"}, **({"group": "section"} if md else {}),
                           "columns": [{"field": "n"}, {"field": "line"}]}]})
    stats.append({"label": "lines", "collection": "lines", "agg": "count"})

    spec = {"version": 1, "name": base, "slug": slug,
            "description": f"{rel}: {kind}", "scope": [rel],
            "collections": cols_spec, "stats": stats[:3], "tabs": tabs, "labels": True,
            "up": "files", "source": rel, "stamp": stamp, **({"window": window} if window else {})}
    data = {"collections": collections, "problems": [], "files": 1,
            "hidden": []}
    data["labels"] = viewhost.label_marks(viewpipe.label_defs(root, out), root, collections, spec)
    write(out, spec, data)
    return {"ok": True, "name": base, "slug": slug, "tabs": [t["name"] for t in tabs], "rows": sum(len(v) for v in collections.values())}


def write(out: str, spec: dict, data: dict) -> None:
    os.makedirs(out, exist_ok=True)
    viewpipe.write_rows(out, data)
    viewpipe.write_json(os.path.join(out, "view.json"), spec)


def main(argv: list[str]) -> int:
    args, opts = [], {}
    it = iter(argv)
    for a in it:
        if a.startswith("--"):
            opts[a[2:]] = next(it, "")
        else:
            args.append(a)
    root = os.path.abspath(opts.get("root") or os.environ.get("THIMBLE_CC_MOD_ROOT") or ".")
    try:
        if args[:1] == ["tree"]:
            got = tree(root, opts.get("out") or os.path.join(viewpipe.home(root), "files", "files"))
        elif args[:1] == ["open"] and len(args) == 2:
            rel = os.path.normpath(args[1]).replace(os.sep, "/")
            start = window_start(int(opts.get("at") or opts.get("from") or 1))
            got = open_file(root, rel, opts.get("out") or os.path.join(viewpipe.home(root), "files", slug_of(rel)), start)
        else:
            print(__doc__, file=sys.stderr)
            return 2
    except Exception as err:  # noqa: BLE001 — the panel shows why
        got = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    print(json.dumps(got, ensure_ascii=False))
    return 0 if got.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
