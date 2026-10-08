"""The keys of a file's records that the File browser's Transcript mode can colour by, over the whole file.

`GET /corpora/{c}/source/keys?path=&bins=` reads a JSON lines file (each line an object) or a CSV or TSV file (its
first line names the columns) and answers the record keys that name a kind or a who: a key, or column, whose values are
short scalars (a string of at most VALUE_CHARS characters, a number or a boolean), at least two of them, and either at
most FEW of them (a type, a role, a wiki) or, for strings, at most a third as many as the records that carry one, so
that each value comes back on several records (a user, a page, an address); never a value per record (an id, a time).
They come in the order of how many records carry a value, at most KEYS_MAX keys. For each it gives the first
VALUES_LISTED values with their counts, most frequent first, how many values and records the rest hold, how many
records have none, and where the values fall: the file's lines cut into `bins`, and per bin the rank of its most
frequent value (-1 for a bin whose records have none), which the overview track draws. `bytes` is each bin's share of
the file's bytes, which the track draws as density when nothing is coloured.

A file bigger than SCAN_BYTES is read up to there: the answer says `partial`, and its bins cover the lines read. An
answer is cached per file on its size and modification time. A file of another kind, or whose lines are not JSON
objects, has no keys.
"""
from __future__ import annotations

import csv
import io
import json
import threading
from array import array
from collections import Counter, OrderedDict
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter()

VALUE_CHARS = 80
FEW = 30  # values a key may have whatever they are
MANY = 20_000  # values tracked per key; past it the key names each record, not a kind
VALUES_LISTED = 60
KEYS_MAX = 12
BINS_DEFAULT = 1000
BINS_MAX = 2000
SCAN_BYTES = 256 * 1024 * 1024
SNIFF_LINES = 20  # lines read to tell JSON objects from other text
CACHE_MAX = 16
_NONE = 0xFFFF  # a line's value index when it has none (a key with MANY values is dropped before this matters)

_cache: OrderedDict[tuple[str, int, int, int], dict[str, Any]] = OrderedDict()
_lock = threading.Lock()


def _scalar(v: Any) -> str | None:
    """A value as the key's value when it is a short scalar; None for none, a long text or a nested value."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return json.dumps(v)
    if isinstance(v, str) and len(v) <= VALUE_CHARS and "\n" not in v:
        return v
    return None


class _Key:
    """One key's values as the file is read: their counts, and each line's value index, until it has too many."""

    __slots__ = ("name", "order", "values", "index", "lines", "dropped", "nested")

    def __init__(self, name: str, order: int, lines_so_far: int) -> None:
        self.name = name
        self.order = order
        self.values: Counter[str] = Counter()
        self.index: dict[str, int] = {}
        self.lines = array("H", [_NONE]) * lines_so_far
        self.dropped = False
        self.nested = False

    def add(self, v: Any) -> None:
        if self.dropped:
            return
        s = _scalar(v)
        if s is None:
            if v is not None and v != "":
                self.nested = True
                self.dropped = True
                self.lines = array("H")
                return
            self.lines.append(_NONE)
            return
        i = self.index.get(s)
        if i is None:
            if len(self.index) >= MANY:
                self.dropped = True
                self.lines = array("H")
                return
            i = self.index[s] = len(self.index)
        self.values[s] += 1
        self.lines.append(i)

    def none(self) -> None:
        if not self.dropped:
            self.lines.append(_NONE)


def _rows(path: Path, budget: int):
    """(line number, row dict or None, bytes) per line of the file, up to `budget` bytes, then a final (0, None, -1)
    when it stopped early. JSON lines give their objects; a CSV or TSV file its rows under the first line's names (that
    line itself gives None)."""
    name = path.name.lower()
    sep = "\t" if name.endswith(".tsv") else "," if name.endswith(".csv") else None
    read = 0
    with path.open("rb") as f:
        header: list[str] | None = None
        for n, raw in enumerate(f, start=1):
            read += len(raw)
            if read > budget:
                yield 0, None, -1
                return
            text = raw.decode("utf-8", "replace").rstrip("\r\n")
            if sep is None:
                try:
                    obj = json.loads(text) if text.strip() else None
                except ValueError:
                    obj = None
                yield n, obj if isinstance(obj, dict) else None, len(raw)
                continue
            try:
                cells = next(csv.reader(io.StringIO(text), delimiter=sep))
            except (csv.Error, StopIteration):
                cells = []
            if header is None:
                header = [c.strip() for c in cells]
                yield n, None, len(raw)
                continue
            yield n, {k: (cells[i] if i < len(cells) else None) for i, k in enumerate(header) if k}, len(raw)


def _readable(path: Path) -> bool:
    """A CSV or TSV file, or one whose first non-blank lines are mostly JSON objects."""
    name = path.name.lower()
    if name.endswith((".csv", ".tsv")):
        return True
    seen = objs = 0
    with path.open("rb") as f:
        for raw in f:
            text = raw.decode("utf-8", "replace").strip()
            if not text:
                continue
            seen += 1
            try:
                objs += isinstance(json.loads(text), dict)
            except ValueError:
                pass
            if seen >= SNIFF_LINES:
                break
    return seen > 0 and objs / seen >= 0.8


def scan(path: Path, bins: int = BINS_DEFAULT) -> dict[str, Any]:
    """The answer for one file (the module note). Pure but for reading the file."""
    bins = max(1, min(int(bins), BINS_MAX))
    if not _readable(path):
        return {"total": 0, "bins": bins, "partial": False, "bytes": [], "keys": []}
    keys: dict[str, _Key] = {}
    sizes = array("I")
    total = 0
    partial = False
    for n, row, size in _rows(path, SCAN_BYTES):
        if size < 0:
            partial = True
            break
        total = n
        sizes.append(min(size, 0xFFFFFFFF))
        seen = set()
        if row is not None:
            for k, v in row.items():
                key = keys.get(k)
                if key is None:
                    key = keys[k] = _Key(k, len(keys), n - 1)
                key.add(v)
                seen.add(k)
        for k, key in keys.items():
            if k not in seen:
                key.none()
    def kind(k: _Key) -> bool:
        n, carried = len(k.values), sum(k.values.values())
        if k.dropped or n < 2:
            return False
        strings = all(not v.lstrip("-").replace(".", "", 1).isdigit() for v in list(k.values)[:50])
        return n <= FEW or (strings and n * 3 <= carried)

    kept = [k for k in keys.values() if kind(k)]
    kept.sort(key=lambda k: (-sum(k.values.values()), k.order))
    kept = kept[:KEYS_MAX]
    lines = max(1, total)
    out_bytes = [0] * bins
    for i, s in enumerate(sizes):
        out_bytes[min(bins - 1, i * bins // lines)] += s
    out_keys = []
    for k in kept:
        ranked = [v for v, _ in k.values.most_common()]
        rank = {k.index[v]: r for r, v in enumerate(ranked)}
        per = [Counter() for _ in range(bins)]
        for i, vi in enumerate(k.lines):
            if vi != _NONE:
                per[min(bins - 1, i * bins // lines)][rank[vi]] += 1
        at = [c.most_common(1)[0][0] if c else -1 for c in per]
        rest = ranked[VALUES_LISTED:]
        out_keys.append({
            "key": k.name,
            "values": [{"value": v, "n": k.values[v]} for v in ranked[:VALUES_LISTED]],
            "more": {"values": len(rest), "n": sum(k.values[v] for v in rest)},
            "none": total - sum(k.values.values()) - (1 if path.name.lower().endswith((".csv", ".tsv")) else 0),
            "at": at,
        })
    return {"total": total, "bins": bins, "partial": partial, "bytes": out_bytes, "keys": out_keys}


def keys_of(path: Path, bins: int = BINS_DEFAULT) -> dict[str, Any]:
    """scan(), cached per file on its size and modification time."""
    st = path.stat()
    ck = (str(path), st.st_size, st.st_mtime_ns, int(bins))
    with _lock:
        hit = _cache.get(ck)
        if hit is not None:
            _cache.move_to_end(ck)
            return hit
    got = scan(path, bins)
    with _lock:
        _cache[ck] = got
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
    return got


@router.get("/corpora/{c}/source/keys")
def get_source_keys(c: str, path: str, bins: int = BINS_DEFAULT) -> dict[str, Any]:
    """{path, total, bins, partial, bytes, keys: [{key, values: [{value, n}], more: {values, n}, none, at}]}: the keys
    of the file's records that name a kind or a who, over the whole file (the module note)."""
    from . import corpus  # noqa: PLC0415 — corpus imports nothing from here

    root = corpus._corpus(c)
    p = corpus._file(root, path)
    if corpus.sniff_binary(p):
        return {"path": path, "total": 0, "bins": bins, "partial": False, "bytes": [], "keys": []}
    return {"path": path, **keys_of(p, bins)}
