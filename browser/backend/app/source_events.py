"""A file's records on a time axis, for the File browser's Timeline mode (frontend files/views/timeline.tsx).

A record is one as records.iter_records splits the file, the record labels mark and cite: a line of JSON lines, an
element of a JSON document's array (an ATIF trajectory's steps), a CSV or TSV row. Its time is its value of the file's
time key: of the keys transcripts._time_key names in the first records (`timestamp`, `created_at`, `sentAt`), the one
most of them carry with a value that reads as a time (secs): an ISO time, read in UTC when it gives no zone, or seconds
or milliseconds since 1970.

`time_hint` names the key from the file's first records, and the first page of the file (corpus._page) gives it as
`time`, so the reader offers the mode. A JSON document is indexed for it only up to HINT_JSON_BYTES, since its records
are known only once the whole document is; a larger one is read for it from its head (_head_key).

`GET /corpora/{c}/source/events?path=` answers every record that has a time, up to EVENTS_MAX in time order: its ref,
the line it starts on, its time, the start of its words (gist) and its values of the keys that name a kind or a who, by
source_keys' rules over the same records and the same fields (its _Tally; a transcript's turn fields), which the mode
offers for Rows, Color by and Filter by. Records with no time are counted, not placed. The answer is cached per file on
its size and modification time.

`GET /corpora/{c}/source/timeline` is the mode's page as its frame loads it (views.frame_document over
files_timeline.html): the view kit's search, Filter by, Rows, Color by, time range and timeline over a table of the
records, which the reader feeds with these answers (ViewerFrame's `host`)."""
from __future__ import annotations

import csv
import datetime as _dt
import io
import itertools
import json
import re
import threading
from collections import Counter, OrderedDict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from . import source_keys, transcripts

router = APIRouter()

PAGE_HTML = Path(__file__).resolve().parent / "files_timeline.html"
HINT_RECORDS = 50  # records read for the time key
HINT_LINE_BYTES = 1024 * 1024  # bytes of the head of JSON lines or a CSV file read for them
HINT_JSON_BYTES = 2 * 1024 * 1024  # a larger JSON document is read for it from its head alone (_head_key)
HINT_HEAD_BYTES = 256 * 1024  # bytes of a larger JSON document's head read for its time key
HINT_HEAD_PAIRS = 3  # times under one key that head must hold
HINT_SHARE = 0.6  # of the records read that must carry a time under the key
EVENTS_MAX = 20_000  # records an answer places at most; past it the answer is `partial`
GIST_CHARS = 160  # characters of a record's words an event carries
CACHE_MAX = 8

_hints: OrderedDict[str, tuple[tuple[int, int], dict[str, Any] | None]] = OrderedDict()
_events: OrderedDict[tuple[str, int, int], dict[str, Any]] = OrderedDict()
_lock = threading.Lock()
_EPOCH = re.compile(r"\d{9,13}(?:\.\d+)?")
_PAIR = re.compile(rb'"([A-Za-z_][\w.-]{0,40})"\s*:\s*("[^"\\\n]{8,40}"|\d{9,13}(?:\.\d+)?)')
_ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def secs(v: Any) -> float | None:
    """A time value as seconds since 1970: an ISO time (in UTC when it gives no zone), or seconds or milliseconds since
    1970 as a number or its digits; None for any other value."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, str):
        s = v.strip()
        if _EPOCH.fullmatch(s):
            v = float(s)
        elif _ISO_DAY.match(s):
            try:
                d = _dt.datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith(("Z", "z")) else s)
            except ValueError:
                return None
            return (d if d.tzinfo else d.replace(tzinfo=_dt.timezone.utc)).timestamp()
        else:
            return None
    if isinstance(v, (int, float)) and v >= 1e8:
        return v / 1000 if v > 1e11 else float(v)
    return None


def time_key(rows: list[Any]) -> str | None:
    """The key of the records' time (module note): the one transcripts._time_key names in most of them, when at least
    HINT_SHARE of the records, and two at least, hold a time under it. Pure."""
    objs = [r for r in rows if isinstance(r, dict)]
    named = Counter(k for r in objs if (k := transcripts._time_key(r)))
    for key, _n in named.most_common(3):
        timed = sum(1 for r in objs if secs(r.get(key)) is not None)
        if timed >= 2 and timed >= HINT_SHARE * len(objs):
            return key
    return None


def _stat(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_size, st.st_mtime_ns


def _first_rows(path: Path, rel: str) -> list[Any]:
    """The objects of the file's first records: JSON lines' and a CSV file's rows read from its head, a JSON document's
    records when it is small enough to index (HINT_JSON_BYTES)."""
    from . import records  # noqa: PLC0415 — records imports corpus, which reads this module lazily

    reader = records.reader_of(path, rel)
    if reader == "json":
        if records.json_index(path) is None:
            return []
        return [r["record"] for r in itertools.islice(records.iter_records(path, rel), HINT_RECORDS)]
    if reader not in ("lines", "csv"):
        return []
    # the head's whole lines, so a file of one long line is never read whole
    with path.open("rb") as f:
        head = f.read(HINT_LINE_BYTES)
    lines = head.split(b"\n")
    if len(head) == HINT_LINE_BYTES:
        lines = lines[:-1]
    texts = [x.decode("utf-8", "replace").rstrip("\r") for x in lines]
    if reader == "csv":
        try:
            rows = list(itertools.islice(csv.reader(io.StringIO("\n".join(texts)), delimiter="\t" if rel.lower().endswith(".tsv") else ","), HINT_RECORDS + 1))
        except csv.Error:
            return []
        header = [c.strip() for c in rows[0]] if rows else []
        return [{k: (r[i] if i < len(r) else None) for i, k in enumerate(header) if k} for r in rows[1:]]
    out = []
    for t in texts:
        if len(out) >= HINT_RECORDS:
            break
        try:
            obj = json.loads(t) if t.strip() else None
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _big_json(path: Path, rel: str) -> bool:
    """A JSON document past HINT_JSON_BYTES, whose records are known only once the whole document is indexed."""
    from . import records  # noqa: PLC0415

    return path.stat().st_size > HINT_JSON_BYTES and records.reader_of(path, rel) == "json"


def _head_key(path: Path) -> str | None:
    """A large JSON document's time key from its head (HINT_HEAD_BYTES): the key transcripts._time_key names that holds
    a time most often there, at least HINT_HEAD_PAIRS times, without indexing the document."""
    with path.open("rb") as f:
        head = f.read(HINT_HEAD_BYTES)
    named: Counter[str] = Counter()
    for m in _PAIR.finditer(head):
        k, raw = m[1].decode("utf-8", "replace"), m[2].decode("utf-8", "replace")
        v: Any = raw[1:-1] if raw.startswith('"') else raw
        if transcripts._time_key({k: v}) == k and secs(v) is not None:
            named[k] += 1
    got = named.most_common(1)
    return got[0][0] if got and got[0][1] >= HINT_HEAD_PAIRS else None


def time_hint(path: Path, rel: str) -> dict[str, Any] | None:
    """{key}: the file's time key read from its first records (module note), or None; kept per path and (size,
    mtime_ns)."""
    key = _stat(path)
    if key is None:
        return None
    k = str(path)
    with _lock:
        hit = _hints.get(k)
        if hit is not None and hit[0] == key:
            _hints.move_to_end(k)
            return hit[1]
    try:
        found = _head_key(path) if _big_json(path, rel) else time_key(_first_rows(path, rel))
    except (OSError, ValueError):
        found = None
    got = {"key": found} if found else None
    with _lock:
        _hints[k] = (key, got)
        while len(_hints) > 256:
            _hints.popitem(last=False)
    return got


def gist(obj: Any, time: str, shown: frozenset[str] = frozenset()) -> str:
    """A record's words on one line, at most GIST_CHARS: its message's text (transcripts.message_keys), else its first
    value under one of transcripts.TEXT_KEYS that holds text, else its longest string when that is a sentence, else its
    other values as `key: value`, those of the keys the mode shows beside it (`shown`) left out while any other is left,
    and nested ones last, as JSON. Its `time` is never part of it. Pure."""
    if not isinstance(obj, dict):
        return ""
    text = None
    keys = transcripts.message_keys(obj)
    if keys and keys.get("text"):
        text = transcripts._text_of(transcripts._get(obj, keys["text"]))
    if not text:
        for k in transcripts.TEXT_KEYS:
            if k != time and isinstance(obj.get(k), (str, list, dict)) and (t := transcripts._text_of(obj[k])):
                text = t
                break
    if not text:
        rest = [(k, v) for k, v in obj.items() if k != time and v not in (None, "", [], {})]
        longest = max((v for _k, v in rest if isinstance(v, str)), key=len, default="")
        own = [(k, v) for k, v in rest if k not in shown] or rest
        flat = [kv for kv in own if not isinstance(kv[1], (dict, list))] + [kv for kv in own if isinstance(kv[1], (dict, list))]
        text = longest if len(longest) > 24 else " · ".join(
            f"{k}: {json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v}" for k, v in flat)
    return " ".join(str(text)[: GIST_CHARS * 4].split())[:GIST_CHARS]


def scan(path: Path, rel: str) -> dict[str, Any]:
    """The answer for one file (module note). Pure but for reading the file."""
    from . import records  # noqa: PLC0415

    hint = time_hint(path, rel)
    key = hint["key"] if hint else None
    if key is None:
        return {"time": None, "total": 0, "untimed": 0, "partial": False, "keys": [], "events": []}
    # a record's fields as source_keys reads them, so Color by offers what the Transcript and Table modes offer: a
    # whole-file JSON transcript's turn fields, JSON lines of messages their own keys and their turns' fields
    shape = (transcripts.sniff(path, rel) or {}).get("format")
    if shape == "json":
        fields = transcripts.turn_fields
    elif shape in ("stream", "messages"):
        fields = lambda o: {**o, **transcripts.record_fields(o)}  # noqa: E731
    else:
        fields = lambda o: o  # noqa: E731
    tally = source_keys._Tally()
    placed: list[tuple[float, int, str, dict[str, Any], dict[str, Any]]] = []
    total = untimed = 0
    partial = False
    for rec in records.iter_records(path, rel):
        obj = rec.get("record")
        if not isinstance(obj, dict):
            continue
        t = secs(obj.get(key))
        if t is None:
            untimed += 1
            continue
        if len(placed) >= EVENTS_MAX:
            partial = True
            break
        total += 1
        row = fields(obj)
        tally.add(row, rec["line"] or 0)
        placed.append((t, rec["line"] or 0, rec["ref"], obj, row))
    keys = [k for k in tally.answer(1, max(1, total), [], partial)["keys"] if k["key"] != key]
    names = [k["key"] for k in keys]
    shown = frozenset(names)
    placed.sort(key=lambda e: (e[0], e[1]))
    events = [{"ref": ref, "line": line, "t": t, "text": gist(obj, key, shown), "v": [source_keys._scalar(row.get(k)) for k in names]}
              for t, line, ref, obj, row in placed]
    for k in keys:
        k.pop("at", None)
    return {"time": key, "total": total, "untimed": untimed, "partial": partial, "keys": keys, "events": events}


def events_of(path: Path, rel: str) -> dict[str, Any]:
    """scan(), cached per file on its size and modification time."""
    st = _stat(path) or (0, 0)
    ck = (str(path), *st)
    with _lock:
        hit = _events.get(ck)
        if hit is not None:
            _events.move_to_end(ck)
            return hit
    got = scan(path, rel)
    with _lock:
        _events[ck] = got
        while len(_events) > CACHE_MAX:
            _events.popitem(last=False)
    return got


def dress(page: dict[str, Any], path: Path, rel: str) -> dict[str, Any]:
    """The first page of a file with its time key (`time`, time_hint), when its records carry one."""
    if page.get("start") == 1 and (hint := time_hint(path, rel)) is not None:
        page["time"] = hint
    return page


@router.get("/corpora/{c}/source/events")
def get_source_events(c: str, path: str) -> dict[str, Any]:
    """{path, time, total, untimed, partial, keys: [{key, values, more, none}], events: [{ref, line, t, text, v}]}: the
    file's records on a time axis (module note), each event's `v` its values of `keys` in their order."""
    from . import corpus  # noqa: PLC0415 — corpus imports this module lazily

    root = corpus._corpus(c)
    p = corpus._file(root, path)
    if corpus.source_kind(path) == "forge" or corpus.sniff_binary(p):
        raise HTTPException(415, f"{path!r} has no records with a time")
    return {"path": path, **events_of(p, path)}


@router.get("/corpora/{c}/source/timeline")
def get_timeline_page(c: str) -> HTMLResponse:
    """The Timeline mode's page as its frame loads it (views.frame_document over files_timeline.html), which loads no
    URL: its records come from the reader."""
    from . import corpus, views  # noqa: PLC0415

    corpus._corpus(c)
    page = {"dir": str(PAGE_HTML.parent), "page": PAGE_HTML.name, "slug": "", "name": "Timeline"}
    return HTMLResponse(views.frame_document(page), headers={"Cache-Control": "no-cache"})
