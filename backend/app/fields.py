"""What a question about some files needs before it labels their records: each file's fields with a few of their values,
and how the records relate. A view's question carries it for the files the view claims (threads.content), and read_ref
on a view gives it (views.tool_read_ref).

describe(corpus_dir, paths) groups the files whose records have the same fields, such as one page's saves per file, and
reads each group's records up to SCAN_BYTES. A field's line gives its values with their counts when it has at most
ENUM_MAX, else how many it has and the commonest; the span of a time or a number; the length of a long text. Relations:
  saves  records with a sequence and a text field (concepts._save_key) that mostly keep at least half the lines of the
         save before them on their document, which labels read as what each save changed (concepts.change_lines)
  names  a text field whose values are almost all values of another field that is different on every record
Each file's description is cached on its size and modification time."""
from __future__ import annotations

import csv
import json
import re
import threading
from collections import Counter
from pathlib import Path
from typing import Any

from . import config

SCAN_BYTES = 256 * 1024 * 1024  # of a group's files read for its fields; the rest is left unread, and the text says so
ENUM_MAX = 6  # a field with at most this many values lists them all
EXAMPLES = 2  # values shown of a field with more
VALUE_CHARS = 60
LONG_CHARS = 200  # a string longer than this is a text, described by its length and not counted as a value
DISTINCT_MAX = 100_000  # values counted per field
UNIQUE_MIN = 5  # records a field must be on to count as naming each record
NAMES_SHARE = 0.9  # of a field's values that must be another's, and of that field's records that must differ, for a name
SAVES_SHARE = 0.5  # of the pairs of consecutive saves that must keep half the lines for records to save whole documents
PAIRS_MAX = 2_000  # pairs of consecutive saves compared
PATHS_SHOWN = 3
FIELDS_SHOWN = 30
TEXT_MAX = 3_000  # characters of the whole description
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")

_cache: dict[tuple, str] = {}
_lock = threading.Lock()


def describe(corpus_dir: Path, paths: list[str]) -> str:
    """The description of the files at `paths` (relative to the corpus), as the module note says; "" for none. Blocking."""
    groups: dict[tuple, list[tuple[str, Path]]] = {}
    for rel in sorted(dict.fromkeys(paths)):
        try:
            p = config.safe_corpus_path(corpus_dir, rel)
        except ValueError:
            continue
        if p.is_file():
            groups.setdefault((p.suffix, _keys(p)), []).append((rel, p))
    parts = []
    for (_suffix, keys), files in groups.items():
        sig = tuple((str(p), p.stat().st_size, p.stat().st_mtime_ns) for _rel, p in files)
        with _lock:
            text = _cache.get(sig)
        if text is None:
            text = _group(files) if keys else _plain(files)
            with _lock:
                _cache[sig] = text
        parts.append(text)
    out = "\n".join(parts)
    return out if len(out) <= TEXT_MAX else out[: TEXT_MAX - 1].rstrip() + "…"


def _keys(p: Path) -> tuple[str, ...]:
    """The fields of the file's first record, or () for a file that holds none."""
    for rec in _records(p, 1):
        return tuple(sorted(rec))
    return ()


def _records(p: Path, most: int | None = None, budget: list[int] | None = None):
    """The dicts of a JSON Lines file or a CSV's rows, `most` of them at most, reading while `budget[0]` bytes are left."""
    n = 0
    if p.suffix == ".csv":
        with open(p, encoding="utf-8", errors="replace", newline="") as f:
            for row in csv.DictReader(f):
                if budget is not None:
                    budget[0] -= sum(len(str(v)) for v in row.values())
                yield {str(k).strip(): v for k, v in row.items() if k is not None}
                n += 1
                if (most and n >= most) or (budget is not None and budget[0] <= 0):
                    return
        return
    if p.suffix != ".jsonl":
        return
    with open(p, "rb") as f:
        for raw in f:
            if budget is not None:
                budget[0] -= len(raw)
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if isinstance(rec, dict):
                yield rec
                n += 1
                if (most and n >= most) or (budget is not None and budget[0] <= 0):
                    return


def _plain(files: list[tuple[str, Path]]) -> str:
    return f"{_names(files)}: files that hold no records"


def _names(files: list[tuple[str, Path]]) -> str:
    names = [rel for rel, _p in files]
    return ", ".join(names[:PATHS_SHOWN]) + (f" and {len(names) - PATHS_SHOWN} more" if len(names) > PATHS_SHOWN else "")


class _Field:
    __slots__ = ("n", "empty", "kinds", "values", "full", "longest", "lo", "hi")

    def __init__(self) -> None:
        self.n = self.empty = self.longest = 0
        self.kinds: Counter = Counter()
        self.values: Counter = Counter()
        self.full = False
        self.lo = self.hi = None

    def add(self, v: Any) -> None:
        self.n += 1
        if v is None or v == "":
            self.empty += 1
            return
        kind = ("bool" if isinstance(v, bool) else "number" if isinstance(v, (int, float)) else "list" if isinstance(v, list)
                else "object" if isinstance(v, dict) else "time" if isinstance(v, str) and TIME_RE.match(v) else "text")
        self.kinds[kind] += 1
        if kind in ("number", "time"):
            try:
                self.lo = v if self.lo is None or v < self.lo else self.lo
                self.hi = v if self.hi is None or v > self.hi else self.hi
            except TypeError:  # numbers and times in one field: the span is of the first kind seen
                pass
        if kind in ("list", "object"):
            v = json.dumps(v, ensure_ascii=False)[:LONG_CHARS]
        elif kind == "text":
            self.longest = max(self.longest, len(v))
            if len(v) > LONG_CHARS:
                return
        if v in self.values or len(self.values) < DISTINCT_MAX:
            self.values[v] += 1
        else:
            self.full = True

    def unique(self, share: float = 1.0) -> bool:
        """Whether the field has a different value on each record that has one (on `share` of them)."""
        filled = self.n - self.empty
        return not self.full and filled >= UNIQUE_MIN and len(self.values) >= share * filled

    def line(self, name: str, total: int) -> str:
        kind = self.kinds.most_common(1)[0][0] if self.kinds else "empty"
        filled = self.n - self.empty
        if kind == "empty":
            words = "always empty"
        elif kind in ("number", "time") and len(self.values) > 2:
            words = f"{'numbers' if kind == 'number' else 'times'} from {self.lo} to {self.hi}"
        elif kind == "text" and self.longest > LONG_CHARS:
            words = f"texts of up to {self.longest:,} characters"
        elif self.unique():
            words = f"different on each record, such as {_quote(next(iter(self.values)))}"
        elif len(self.values) <= ENUM_MAX and not self.full:
            words = ", ".join(f"{_quote(v)} ({c:,})" for v, c in self.values.most_common())
        else:
            many = f"{len(self.values):,}{'+' if self.full else ''} values"
            words = f"{many}, the commonest {', '.join(f'{_quote(v)} ({c:,})' for v, c in self.values.most_common(EXAMPLES))}"
        missing = total - filled
        if kind != "empty" and missing * 20 > total:
            words += f"; missing or empty on {missing:,}"
        return f"  `{name}`: {words}"


def _quote(v: Any) -> str:
    s = v if isinstance(v, str) else json.dumps(v)
    return json.dumps(s[:VALUE_CHARS] + ("…" if len(s) > VALUE_CHARS else ""), ensure_ascii=False) if isinstance(v, str) else s


def _group(files: list[tuple[str, Path]]) -> str:
    """One group's lines: its files and records, a line per field, then how its records relate."""
    from . import concepts  # noqa: PLC0415 — concepts imports much of the app

    fields: dict[str, _Field] = {}
    budget = [SCAN_BYTES]
    total = pairs = whole = disorder = 0
    last: dict[tuple, tuple[Any, str]] = {}
    save: tuple[str, str, str] | None = None  # (document field, sequence field, text field) of the saves
    docs: set = set()
    for rel, p in files:
        if budget[0] <= 0:
            break
        for rec in _records(p, None, budget):
            total += 1
            for k, v in rec.items():
                fields.setdefault(k, _Field()).add(v)
            key = concepts._save_key(rec)
            if key is None:
                continue
            doc_field = next((k for k in concepts.SAVE_PLACE_KEYS if k in rec), "")
            seq_field = next(k for k in concepts.SAVE_SEQ_KEYS if k in rec)
            save = save or (doc_field, seq_field, key[1])
            doc = (rel, key[0])
            docs.add(doc)
            before = last.get(doc)
            seq = rec.get(seq_field)
            if before is not None:
                try:
                    disorder += seq < before[0]
                except TypeError:
                    pass
                if pairs < PAIRS_MAX:
                    pairs += 1
                    whole += concepts.change_lines(before[1], rec[key[1]]) is not None
            last[doc] = (seq, rec[key[1]])
    head = f"{_names(files)}: {total:,} records{' in the part read' if budget[0] <= 0 else ''}, with fields"
    lines = [head] + [f.line(k, total) for k, f in list(fields.items())[:FIELDS_SHOWN]]
    if len(fields) > FIELDS_SHOWN:
        lines.append(f"  and {len(fields) - FIELDS_SHOWN} more fields")
    if save and pairs and whole >= SAVES_SHARE * pairs:
        doc_field, seq_field, text_field = save
        where = (f"`{doc_field}` names the document ({len(docs):,} of them)" if doc_field
                 else "each file is one document")
        order = "in file order" if not disorder else f"out of file order {disorder:,} times"
        lines.append(f"Each record saves a whole document again: {where}, `{seq_field}` numbers its saves {order}, and "
                     f"`{text_field}` holds the document. A label by a model or a regex reads a save as the lines it added "
                     "(+) and removed (-) since the save before; code gets the record whole.")
    unique = {k for k, f in fields.items() if f.unique(NAMES_SHARE) and set(f.kinds) <= {"text", "number"}}
    for k, f in fields.items():
        if f.full or set(f.kinds) != {"text"} or len(f.values) < 3:
            continue
        for u in unique - {k}:
            if sum(v in fields[u].values for v in f.values) >= NAMES_SHARE * len(f.values):
                lines.append(f"`{k}` names another record by its `{u}`.")
                break
    return "\n".join(lines)
