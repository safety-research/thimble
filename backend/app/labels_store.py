"""The labels store: one SQLite file beside each label's jsonl, so label reads need no parse.

`labels/<id>.jsonl` is the append-only record. `labels/<id>.sqlite` is derived from it: the current state per ref (the
latest classifier row and the latest analyst verdict, with `effective`, the value the row reads as, and `spans`, the
texts a span label marks) and a `meta` table naming the (size, mtime_ns) of the jsonl it reflects. Writers append to the
jsonl first, then upsert rows and the new key in one transaction, so the store is never ahead of the record. A reader
that finds the store missing, behind or stale (including an older schema) brings it up to date.

Covers. A label over whole files gives most records its quiet value, so such a run writes rows only for records that
took another value, plus a `cover` line per labeled range (records `from`..`to` without a row of their own took
`value`), preceded by a `clear` line that drops earlier classifier rows and covers on that range (analyst verdicts
stay). The store keeps covers in their own table and adds their records where a read needs them (implicit rows).

A torn last line is handled at both ends: `meta.parsed` is the offset after the last whole line ingested, and every
writer calls mend_tail before its first append.

Size. A label over millions of records makes a store of hundreds of megabytes, mostly the rows and their indexes, so
the store keeps no index another one covers, and a rebuild of more than COMPACT_BYTES is copied compacted
(`VACUUM INTO`), its indexes written in order rather than grown row by row. Nothing here imports concepts, so a scan-pool worker can rebuild a store
with this module alone.
"""
from __future__ import annotations

import bisect
import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable, Iterator

log = logging.getLogger("thimble.labels_store")

SCHEMA = 6
COMPACT_BYTES = 64 * 1024 * 1024  # a rebuilt store larger than this is copied compacted before it goes into place
SYNC_INLINE_BYTES = 16 * 1024 * 1024  # a jsonl, or its unread tail, up to this size is ingested by the reader that finds it behind
BATCH = 5_000                         # rows per transaction when ingesting a file
YIELD_EVERY = 200                     # rows parsed between two yields of the interpreter
BUSY_TIMEOUT_S = 10.0                 # a connection waits this long for a lock
CACHE_KB = 65_536                     # the writer's page cache
_REF_KINDS_WITHOUT_PATH = ("card:", "cell:", "chat:", "concept:", "report:")
OLD_CARD, CARD = "cell:", "card:"  # a card unit's ref prefix: `cell:` is read as `card:` (cite.CARD_PREFIXES)


def canon_ref(ref: Any) -> str:
    """A label row's ref as the store keys it: a card unit written `cell:<id>` is `card:<id>`, so both forms are one
    unit (cite.canon, without importing it here)."""
    s = str(ref)
    return CARD + s[len(OLD_CARD):] if s.startswith(OLD_CARD) else s

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS current (
    ref TEXT PRIMARY KEY,
    path TEXT, line INTEGER,
    label TEXT, confidence REAL, rationale TEXT, source TEXT, ts TEXT,
    analyst TEXT, analyst_ts TEXT, analyst_note TEXT,
    effective TEXT,
    spans TEXT
);
CREATE TABLE IF NOT EXISTS covers (path TEXT, first INTEGER, last INTEGER, value TEXT, source TEXT, ts TEXT);
"""
_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS current_path_line ON current(path, line);
CREATE INDEX IF NOT EXISTS current_label ON current(label);
CREATE INDEX IF NOT EXISTS current_effective ON current(effective);
CREATE INDEX IF NOT EXISTS current_analyst ON current(analyst) WHERE analyst IS NOT NULL;
CREATE INDEX IF NOT EXISTS covers_path ON covers(path, first);
"""

_UPSERT_MODEL = """
INSERT INTO current (ref, path, line, label, confidence, rationale, source, ts, effective, spans) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(ref) DO UPDATE SET path = excluded.path, line = excluded.line, label = excluded.label,
    confidence = excluded.confidence, rationale = excluded.rationale, source = excluded.source, ts = excluded.ts,
    effective = COALESCE(current.analyst, excluded.label), spans = excluded.spans
"""
_UPSERT_ANALYST = """
INSERT INTO current (ref, path, line, analyst, analyst_ts, analyst_note, effective) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(ref) DO UPDATE SET analyst = excluded.analyst, analyst_ts = excluded.analyst_ts, analyst_note = excluded.analyst_note,
    effective = COALESCE(excluded.analyst, current.label)
"""
# a row the analyst judged on a record a cover holds has no classifier label of its own: it reads the cover's value
_COVER_OF = "(SELECT c.value FROM covers c WHERE c.path = current.path AND current.line BETWEEN c.first AND c.last LIMIT 1)"
_LABEL = f"COALESCE(label, {_COVER_OF})"
_MERGED_COLS = f"ref, {_LABEL}, confidence, rationale, source, ts, analyst, analyst_ts, spans, path, line"
_LABELED = "effective IS NOT NULL"
# per cover: its records that have a row of their own (_ROWS_IN) and those with a classifier label (_LABELED_IN)
_ROWS_IN = "(SELECT COUNT(*) FROM current r WHERE r.path = c.path AND r.line BETWEEN c.first AND c.last)"
_LABELED_IN = ("(SELECT COUNT(*) FROM current r WHERE r.path = c.path AND r.line BETWEEN c.first AND c.last "
               "AND r.label IS NOT NULL)")
COVER, CLEAR = "cover", "clear"  # the keys of a cover line and a clear line
LAST_LINE = 2**62  # a clear line's `to` when it names no end


# --------------------------------------------------------------------------- paths and refs


def store_path(jsonl: Path) -> Path:
    return jsonl.with_suffix(".sqlite")


def side_files(jsonl: Path) -> list[Path]:
    """The store's files for a labels file: the database, SQLite's WAL and shm, a rebuild in progress and its
    compacted copy."""
    db = store_path(jsonl)
    return [db, db.with_name(db.name + "-wal"), db.with_name(db.name + "-shm"), db.with_name(db.name + ".building"),
            db.with_name(db.name + ".building.compact")]


def remove(jsonl: Path) -> None:
    """Delete the store (not the jsonl)."""
    for p in side_files(jsonl):
        p.unlink(missing_ok=True)


def mend_tail(jsonl: Path) -> bool:
    """Give a labels file whose last byte is not a newline one, so the next row lands on its own line. Returns
    whether a newline was added; a missing or empty file is left alone."""
    try:
        with open(jsonl, "r+b") as f:
            if f.seek(0, os.SEEK_END) == 0:
                return False
            f.seek(-1, os.SEEK_END)
            if f.read(1) == b"\n":
                return False
            f.write(b"\n")
            return True
    except OSError:
        return False


def file_key(p: Path) -> tuple[int, int] | None:
    try:
        st = p.stat()
    except OSError:
        return None
    return (st.st_size, st.st_mtime_ns)


def ref_parts(ref: Any) -> tuple[str | None, int | None]:
    """(corpus path, line) of a label ref: `<path>` for a file unit, `<path>` and n of `<path>#L<n>` for a record, and
    `<path>` with no line for a record of another reader (records.py: a database row, a PDF page, a JSON value, a CSV
    row); (None, None) for a cell, span or other ref without a path. The common shapes are cut without the ref
    grammar."""
    ref = str(ref)
    head, sep, tail = ref.partition("#")
    if head and " " not in head and not head.startswith(_REF_KINDS_WITHOUT_PATH):
        if sep and tail.startswith("L"):
            n = 0
            for ch in tail[1:]:
                if not ch.isdigit():
                    break
                n = n * 10 + ord(ch) - 48
            return head, (n or None)
        if not sep and ":" not in head:
            return head, None
    if head.startswith(_REF_KINDS_WITHOUT_PATH):
        return None, None
    try:
        from . import refs  # lazy: a scan-pool worker rebuilding a store boots without it

        parsed = refs.parse_ref(ref)
    except Exception:  # noqa: BLE001
        return None, None
    line = parsed.get("line")
    return parsed.get("path"), (int(line) if isinstance(line, int) else None)


def row_line(ref: str, row: dict) -> tuple[str | None, int | None]:
    """ref_parts, with the line a row names (`line`) for a record whose ref carries none: the line a CSV row or a JSON
    document's record starts on, so the reader's page of lines finds its marks."""
    path, line = ref_parts(ref)
    given = row.get("line")
    if line is None and path is not None and isinstance(given, int) and not isinstance(given, bool) and given >= 1:
        line = given
    return path, line


# covers


def cover_row(path: str, first: int, last: int, value: str, source: str, ts: str) -> dict:
    """A cover line: records `first`..`last` of `path` that have no row of their own took `value` (from `source`)."""
    return {COVER: path, "from": int(first), "to": int(last), "value": value, "source": source, "ts": ts}


def clear_row(path: str, first: int, last: int | None = None) -> dict:
    """A clear line: the classifier's rows and the covers on records `first`..`last` of `path` (to its end when `last`
    is None) are dropped, before a run writes that range again."""
    return {CLEAR: path, "from": int(first), "to": None if last is None else int(last)}


def is_marker(r: Any) -> bool:
    """Whether a labels file line is a cover or a clear line rather than a row."""
    return isinstance(r, dict) and not r.get("ref") and isinstance(r.get(COVER) or r.get(CLEAR), str)


def _span(r: dict) -> tuple[int, int] | None:
    """(first, last) of a marker, `to` None reading as the file's end; None for one that names no valid range."""
    try:
        a = int(r.get("from") or 1)
        b = LAST_LINE if r.get("to") is None else int(r["to"])
    except (TypeError, ValueError):
        return None
    return (a, b) if 1 <= a <= b else None


def trim(covers: list[tuple[int, int, Any]], a: int, b: int) -> list[tuple[int, int, Any]]:
    """`covers` (first, last, payload) with records a..b taken out: a cover inside the range goes, one across its edge
    keeps the part outside."""
    out: list[tuple[int, int, Any]] = []
    for first, last, payload in covers:
        if last < a or first > b:
            out.append((first, last, payload))
            continue
        if first < a:
            out.append((first, a - 1, payload))
        if last > b:
            out.append((b + 1, last, payload))
    return out


def implicit_row(path: str, line: int, value: str, source: str | None, ts: str | None) -> dict:
    """The row a record a cover holds reads as, as the label routes answer a row."""
    return {"ref": f"{path}#L{line}", "label": value, "confidence": 1.0, "rationale": None, "source": source, "ts": ts,
            "analyst": None}


# --------------------------------------------------------------------------- the store


def _migrate(conn: sqlite3.Connection, have: str) -> None:
    """A store of an older schema opened for write: add and fill `effective`, add `spans` and the covers table, drop
    the index on `path` alone (the one on path and line serves its queries), and stamp the schema; connect creates the
    indexes after this."""
    if have in ("0", "1", "2", "3", "4", "5"):
        conn.execute("DROP INDEX IF EXISTS current_path")
    if have in ("0", "1", "2", "3", "4"):
        cols = {r[1] for r in conn.execute("PRAGMA table_info(current)")}
        if "effective" not in cols:
            conn.execute("ALTER TABLE current ADD COLUMN effective TEXT")
            conn.execute("UPDATE current SET effective = COALESCE(analyst, label)")
        elif have in ("0", "1", "2"):
            conn.execute("UPDATE current SET effective = COALESCE(analyst, label)")
        if "spans" not in cols:
            conn.execute("ALTER TABLE current ADD COLUMN spans TEXT")
    if have in ("0", "1", "2", "3", "4", "5"):
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", (str(SCHEMA),))


def spans_field(v: Any) -> list[str] | None:
    """A row's `spans` as the store keeps them: the distinct non-empty strings of a list, else None."""
    if not isinstance(v, list):
        return None
    out: list[str] = []
    for s in v:
        if isinstance(s, str) and s.strip() and s not in out:
            out.append(s)
    return out or None


def _spans_json(v: Any) -> str | None:
    spans = spans_field(v)
    return json.dumps(spans, ensure_ascii=False) if spans else None


def _spans_read(v: Any) -> list[str] | None:
    if not v:
        return None
    try:
        return spans_field(json.loads(v))
    except (TypeError, ValueError):
        return None


def _merged(r: tuple) -> dict:
    """A `current` row as the label routes' row: the latest classifier row with the analyst's verdict attached (a
    verdict on a record a cover holds with the cover's value as its label), and the texts it marks when it has any."""
    ref, label, confidence, rationale, source, ts, analyst, analyst_ts, spans, path, line = r
    out = {"ref": ref, "label": label, "confidence": confidence, "rationale": rationale, "source": source,
           "ts": ts if ts is not None else analyst_ts, "analyst": analyst}
    marked = _spans_read(spans)
    if marked:
        out["spans"] = marked
    if line is not None and path is not None and ref_parts(ref)[1] is None:
        out["line"] = int(line)  # the line a record of another reader starts on (row_line)
    return out


class Store:
    """The store of one labels file. Cheap to make; every method opens its own connection."""

    def __init__(self, jsonl: Path) -> None:
        self.jsonl = Path(jsonl)
        self.db = store_path(self.jsonl)

    # ----------------------------------------------------------------------- connections and state

    def connect(self, path: Path | None = None, *, write: bool = False) -> sqlite3.Connection:
        """A connection in WAL mode with a busy timeout. `write` sizes the page cache for a run's inserts and
        creates the schema when the file is new."""
        p = path or self.db
        if not write and not p.exists():
            raise sqlite3.OperationalError(f"no store at {p}")
        conn = sqlite3.connect(str(p), timeout=BUSY_TIMEOUT_S, isolation_level=None, check_same_thread=False)
        try:
            if write:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
                conn.execute(f"PRAGMA cache_size=-{CACHE_KB}")
                conn.execute("PRAGMA temp_store=MEMORY")
                conn.executescript(_SCHEMA_SQL)
                have = conn.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
                if have is None:
                    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?), ('size', '0'), ('mtime_ns', '0')", (str(SCHEMA),))
                elif str(have[0]) != str(SCHEMA):
                    _migrate(conn, str(have[0]))
                conn.executescript(_INDEX_SQL)
            else:
                conn.execute("PRAGMA query_only=1")
        except sqlite3.Error:
            conn.close()
            raise
        return conn

    def meta(self, conn: sqlite3.Connection | None = None) -> dict:
        """{schema, size, mtime_ns, parsed} as stored. `parsed` is the offset after the last whole line the store
        took, equal to `size` unless the file ended in a torn line."""
        own = conn is None
        conn = conn or self.connect()
        try:
            rows = conn.execute("SELECT key, value FROM meta").fetchall()
        finally:
            if own:
                conn.close()
        out = {"schema": 0, "size": 0, "mtime_ns": 0}
        parsed: int | None = None
        for k, v in rows:
            if k in out or k == "parsed":
                try:
                    n = int(v)
                except (TypeError, ValueError):
                    continue
                if k == "parsed":
                    parsed = n
                else:
                    out[k] = n
        out["parsed"] = min(out["size"], parsed) if parsed is not None else out["size"]
        return out

    def state(self) -> tuple[str, dict]:
        """How the store stands to its jsonl: `none` (no labels file), `missing` (no store), `fresh`, `behind` (the
        file grew past the store), `stale` (another file, an older schema, an unreadable store). With the meta."""
        key = file_key(self.jsonl)
        if key is None:
            return "none", {}
        if not self.db.exists():
            return "missing", {}
        try:
            m = self.meta()
        except sqlite3.Error:
            return "stale", {}
        if m["schema"] != SCHEMA or self._old_refs():
            return "stale", m
        if (m["size"], m["mtime_ns"]) == key:
            return "fresh", m
        if key[0] > m["size"]:
            return "behind", m
        return "stale", m

    def _old_refs(self) -> bool:
        """Whether the store keys a card unit by a `cell:` ref (canon_ref), so it is rebuilt once from the file."""
        try:
            conn = self.connect()
        except sqlite3.Error:
            return False
        try:
            return conn.execute("SELECT 1 FROM current WHERE ref >= ? AND ref < ? LIMIT 1", (OLD_CARD, "cell;")).fetchone() is not None
        except sqlite3.Error:
            return False
        finally:
            conn.close()

    def fresh(self) -> bool:
        return self.state()[0] == "fresh"

    # ----------------------------------------------------------------------- writes

    def add(self, rows: Iterable[dict], key: tuple[int, int] | None, conn: sqlite3.Connection | None = None,
            parsed: int | None = None) -> int:
        """Upsert label rows (later rows per ref win), apply the cover and clear lines among them in order, and record
        `key`, the jsonl's (size, mtime_ns) after they were appended, in one transaction. Returns the rows taken (a
        marker is no row)."""
        own = conn is None
        conn = conn or self.connect(write=True)
        model: list[tuple] = []
        analyst: list[tuple] = []
        taken = 0

        def flush() -> None:
            if model:
                conn.executemany(_UPSERT_MODEL, model)
                model.clear()
            if analyst:
                conn.executemany(_UPSERT_ANALYST, analyst)
                analyst.clear()

        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                for r in rows:
                    if is_marker(r):
                        flush()  # a marker applies after the rows before it and before those after it
                        self._mark(conn, r)
                        continue
                    if not isinstance(r, dict) or not r.get("ref"):
                        continue
                    ref = canon_ref(r["ref"])
                    path, line = row_line(ref, r)
                    label = None if r.get("label") is None else str(r["label"])
                    if r.get("source") == "analyst":
                        analyst.append((ref, path, line, label, r.get("ts"), r.get("rationale"), label))
                    else:
                        conf = r.get("confidence")
                        model.append((ref, path, line, label,
                                      float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) else None,
                                      r.get("rationale"), r.get("source"), r.get("ts"), label, _spans_json(r.get("spans"))))
                    taken += 1
                flush()
                if key is not None:
                    self._set_key(conn, key, parsed)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        finally:
            if own:
                conn.close()
        return taken

    def _mark(self, conn: sqlite3.Connection, r: dict) -> None:
        """Apply one cover or clear line: a clear drops the classifier's part of the rows on its records (verdicts stay)
        and the covers there; a cover replaces the covers on its records with itself."""
        span = _span(r)
        if span is None:
            return
        a, b = span
        path = str(r.get(COVER) or r.get(CLEAR))
        if r.get(CLEAR):
            conn.execute("DELETE FROM current WHERE path = ? AND line BETWEEN ? AND ? AND analyst IS NULL", (path, a, b))
            conn.execute("UPDATE current SET label = NULL, confidence = NULL, rationale = NULL, source = NULL, ts = NULL, "
                         "spans = NULL, effective = analyst WHERE path = ? AND line BETWEEN ? AND ?", (path, a, b))
        got = conn.execute("SELECT rowid, first, last, value, source, ts FROM covers WHERE path = ? AND last >= ? AND first <= ?",
                           (path, a, b)).fetchall()
        if got:
            conn.executemany("DELETE FROM covers WHERE rowid = ?", [(g[0],) for g in got])
            kept = trim([(g[1], g[2], g[3:]) for g in got], a, b)
            conn.executemany("INSERT INTO covers (path, first, last, value, source, ts) VALUES (?, ?, ?, ?, ?, ?)",
                             [(path, first, last, *payload) for first, last, payload in kept])
        if r.get(COVER) and r.get("value") is not None:
            conn.execute("INSERT INTO covers (path, first, last, value, source, ts) VALUES (?, ?, ?, ?, ?, ?)",
                         (path, a, b, str(r["value"]), r.get("source"), r.get("ts")))

    def _set_key(self, conn: sqlite3.Connection, key: tuple[int, int], parsed: int | None = None) -> None:
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?), ('size', ?), ('mtime_ns', ?), ('parsed', ?)",
                     (str(SCHEMA), str(int(key[0])), str(int(key[1])), str(int(key[0] if parsed is None else min(parsed, key[0])))))

    def ingest(self, start: int, key: tuple[int, int] | None = None, conn: sqlite3.Connection | None = None) -> int:
        """Read the jsonl from byte `start` to its end into the store, BATCH rows a transaction; the last transaction
        records `key` and, when the file ends in a torn line, `parsed` at the last newline. Returns the rows taken."""
        key = key or file_key(self.jsonl)
        if key is None:
            return 0
        own = conn is None
        conn = conn or self.connect(write=True)
        n = 0
        try:
            batch: list[dict] = []
            mark = [start]
            for r in _read_rows(self.jsonl, start, key[0], mark, markers=True):
                batch.append(r)
                if len(batch) >= BATCH:
                    n += self.add(batch, None, conn)
                    batch = []
            n += self.add(batch, key, conn, parsed=mark[0])
        finally:
            if own:
                conn.close()
        return n

    def rebuild(self) -> int:
        """The store built afresh from the whole jsonl into `<db>.building`, then moved into place. A jsonl removed or
        replaced by a smaller one while the build ran leaves no store behind. Returns the rows taken."""
        tmp = self.db.with_name(self.db.name + ".building")
        for p in (tmp, tmp.with_name(tmp.name + "-wal"), tmp.with_name(tmp.name + "-shm")):
            p.unlink(missing_ok=True)
        key = file_key(self.jsonl)
        conn = self.connect(tmp, write=True)
        n = 0
        try:
            if key is not None:
                n = self.ingest(0, key, conn)
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()
        for p in (tmp.with_name(tmp.name + "-wal"), tmp.with_name(tmp.name + "-shm")):
            p.unlink(missing_ok=True)
        self._compact(tmp)
        now = file_key(self.jsonl)
        if now is None or (key is not None and now[0] < key[0]):
            tmp.unlink(missing_ok=True)
            log.info("labels store %s: the labels file went away while the store was built; the build is discarded", self.db.name)
            return n
        for p in (self.db.with_name(self.db.name + "-wal"), self.db.with_name(self.db.name + "-shm")):
            p.unlink(missing_ok=True)
        os.replace(tmp, self.db)
        return n

    @staticmethod
    def _compact(db: Path) -> None:
        """Replace a rebuilt store larger than COMPACT_BYTES with a compacted copy of it; left as it is when the copy
        cannot be made."""
        try:
            if db.stat().st_size <= COMPACT_BYTES:
                return
        except OSError:
            return
        out = db.with_name(db.name + ".compact")
        out.unlink(missing_ok=True)
        try:
            conn = sqlite3.connect(str(db), timeout=BUSY_TIMEOUT_S, isolation_level=None)
            try:
                conn.execute("VACUUM INTO ?", (str(out),))
            finally:
                conn.close()
            os.replace(out, db)
        except (sqlite3.Error, OSError) as e:
            out.unlink(missing_ok=True)
            log.info("labels store %s: not compacted (%s)", db.name, e)

    # ----------------------------------------------------------------------- reads

    def _q(self, sql: str, args: tuple = ()) -> list[tuple]:
        conn = self.connect()
        try:
            return conn.execute(sql, args).fetchall()
        finally:
            conn.close()

    def rows_for_refs(self, wanted: list[str]) -> list[dict]:
        """The merged rows of these refs, in the order asked; a ref with no row of its own reads as the cover that
        holds its line, when one does."""
        conn = self.connect()
        out: list[dict] = []
        try:
            for i in range(0, len(wanted), 500):
                part = [canon_ref(r) for r in wanted[i:i + 500]]
                got = {r[0]: _merged(r) for r in conn.execute(
                    f"SELECT {_MERGED_COLS} FROM current WHERE ref IN ({','.join('?' * len(part))})", part)}
                for ref in part:
                    if ref in got:
                        out.append(got[ref])
                        continue
                    path, line = ref_parts(ref)
                    if path is None or line is None:
                        continue
                    cover = conn.execute("SELECT value, source, ts FROM covers WHERE path = ? AND ? BETWEEN first AND last "
                                         "ORDER BY rowid DESC LIMIT 1", (path, line)).fetchone()
                    if cover is not None:
                        out.append(implicit_row(path, line, str(cover[0]), cover[1], cover[2]))
            return out
        finally:
            conn.close()

    def rows_for_path(self, path: str | None, lines: tuple[int, int] | None = None) -> list[dict]:
        """The merged rows on one corpus path, in first-labelled order, then the implicit rows of its covers in line
        order; `None` returns every row. `lines` (a, b) keeps the rows on lines a..b (row_line) plus whole-file rows."""
        conn = self.connect()
        try:
            if path is None:
                rows = conn.execute(f"SELECT {_MERGED_COLS} FROM current ORDER BY rowid").fetchall()
                paths = [str(p) for (p,) in conn.execute("SELECT DISTINCT path FROM covers ORDER BY path")]
            elif lines is None:
                rows = conn.execute(f"SELECT {_MERGED_COLS} FROM current WHERE path = ? ORDER BY rowid", (path,)).fetchall()
                paths = [path]
            else:
                rows = conn.execute(f"SELECT {_MERGED_COLS} FROM current WHERE path = ? AND (line BETWEEN ? AND ? OR ref = path) "
                                    "ORDER BY rowid", (path, int(lines[0]), int(lines[1]))).fetchall()
                paths = [path]
            out = [_merged(r) for r in rows]
            lo, hi = (int(lines[0]), int(lines[1])) if lines is not None else (1, LAST_LINE)
            for p in paths:
                out.extend(self._implicit(conn, p, lo, hi))
            return out
        finally:
            conn.close()

    def _implicit(self, conn: sqlite3.Connection, path: str, lo: int = 1, hi: int = LAST_LINE,
                  value: str | None = None) -> Iterator[dict]:
        """The implicit rows on records lo..hi of `path`: each record a cover holds that has no row of its own (of the
        covers of `value` alone when given), in line order."""
        covers = conn.execute("SELECT first, last, value, source, ts FROM covers WHERE path = ? AND last >= ? AND first <= ?"
                              + ("" if value is None else " AND value = ?") + " ORDER BY first",
                              (path, lo, hi) + (() if value is None else (value,))).fetchall()
        if not covers:
            return
        a, b = max(lo, min(c[0] for c in covers)), min(hi, max(c[1] for c in covers))
        have = {int(n) for (n,) in conn.execute("SELECT line FROM current WHERE path = ? AND line BETWEEN ? AND ?", (path, a, b))}
        for first, last, v, source, ts in covers:
            for n in range(max(first, lo), min(last, hi) + 1):
                if n not in have:
                    yield implicit_row(path, n, str(v), source, ts)

    def rows(self, value: str | None, limit: int, offset: int = 0, after: int | None = None) -> tuple[list[dict], int, int | None]:
        """(one page of merged rows, the total, the next cursor or None): every labeled ref, or those whose effective
        value is `value`; own rows first by rowid, then the covers' implicit rows. `after` is the previous page's cursor
        (a rowid, or -(k + 1) after k implicit rows); `offset` is a plain skip used when no cursor is given."""
        where = _LABELED + ("" if value is None else " AND effective = ?")
        args: list = [] if value is None else [value]
        limit = max(1, int(limit))
        conn = self.connect()
        try:
            own = int(conn.execute(f"SELECT COUNT(*) FROM current WHERE {where}", tuple(args)).fetchone()[0])
            implicit = self._implicit_total(conn, value)
            got: list = []
            skip = 0  # implicit rows to pass before this page's
            if after is None or after >= 0:
                if after is not None:
                    sql = f"SELECT rowid, {_MERGED_COLS} FROM current WHERE {where} AND rowid > ? ORDER BY rowid LIMIT ?"
                    args += [int(after), limit + 1]
                else:
                    sql = f"SELECT rowid, {_MERGED_COLS} FROM current WHERE {where} ORDER BY rowid LIMIT ? OFFSET ?"
                    args += [limit + 1, max(0, int(offset))]
                    skip = max(0, int(offset) - own)
                got = conn.execute(sql, tuple(args)).fetchall()
                if len(got) > limit:
                    return [_merged(r[1:]) for r in got[:limit]], own + implicit, int(got[limit - 1][0])
            else:
                skip = -int(after) - 1
            page = [_merged(r[1:]) for r in got]
            if implicit and len(page) < limit:
                page += self._implicit_page(conn, value, skip, limit - len(page) + 1)
                if len(page) > limit:
                    return page[:limit], own + implicit, -(skip + limit - len(got)) - 1
            elif implicit > skip:  # the rows of their own ended with this page; the implicit rows follow
                return page, own + implicit, -skip - 1
            return page[:limit], own + implicit, None
        finally:
            conn.close()

    def _implicit_total(self, conn: sqlite3.Connection, value: str | None) -> int:
        """How many records the covers (of `value` alone when given) hold that have no row of their own."""
        where = "" if value is None else " WHERE c.value = ?"
        got = conn.execute(f"SELECT SUM(c.last - c.first + 1 - {_ROWS_IN}) FROM covers c{where}",
                           () if value is None else (value,)).fetchone()
        return int(got[0] or 0)

    def _implicit_page(self, conn: sqlite3.Connection, value: str | None, skip: int, limit: int) -> list[dict]:
        """`limit` implicit rows after the first `skip`, the covers in the order they were written."""
        out: list[dict] = []
        where = "" if value is None else " WHERE c.value = ?"
        covers = conn.execute(f"SELECT c.path, c.first, c.last, c.last - c.first + 1 - {_ROWS_IN} FROM covers c{where} ORDER BY c.rowid",
                              () if value is None else (value,)).fetchall()
        for path, first, last, n in covers:
            if skip >= n:
                skip -= int(n)
                continue
            for row in self._implicit(conn, str(path), int(first), int(last), value):
                if skip:
                    skip -= 1
                    continue
                out.append(row)
                if len(out) >= limit:
                    return out
        return out

    def stats(self) -> dict:
        """{n_labeled, n_reviewed, n_marked, counts}: refs with a classifier label, those the analyst also judged, every
        ref the analyst judged, and the count per label, covers' records included."""
        counts = {str(label): int(n) for label, n in self._q("SELECT label, COUNT(*) FROM current WHERE label IS NOT NULL GROUP BY label")}
        for value, n in self._q(f"SELECT c.value, SUM(c.last - c.first + 1 - {_LABELED_IN}) FROM covers c GROUP BY c.value"):
            if n:
                counts[str(value)] = counts.get(str(value), 0) + int(n)
        return {"n_labeled": sum(counts.values()), "n_reviewed": self.n_reviewed(), "n_marked": self.n_marked(), "counts": counts}

    def n_reviewed(self) -> int:
        return int(self._q(f"SELECT COUNT(*) FROM current WHERE analyst IS NOT NULL AND {_LABEL} IS NOT NULL")[0][0])

    def n_marked(self) -> int:
        return int(self._q("SELECT COUNT(*) FROM current WHERE analyst IS NOT NULL")[0][0])

    def n_refs(self) -> int:
        """The labeled units: the rows, and the records the covers hold without one."""
        conn = self.connect()
        try:
            return int(conn.execute("SELECT COUNT(*) FROM current").fetchone()[0]) + self._implicit_total(conn, None)
        finally:
            conn.close()

    def calibration_pairs(self) -> list[tuple[str, str]]:
        """(classifier label, analyst label) for every ref the analyst judged that has a classifier label, its cover's
        value for a record a cover holds."""
        return [(str(a), str(b)) for a, b in self._q(f"SELECT {_LABEL} AS l, analyst FROM current WHERE analyst IS NOT NULL AND l IS NOT NULL")]

    def refs(self) -> set[str]:
        """The refs of the rows (the records the covers hold without a row are not listed)."""
        return {r[0] for r in self._q("SELECT ref FROM current")}

    def paths(self) -> dict[str, int]:
        """{corpus path: refs with a classifier label on it}: the files a label's rows and covers cover (a cell or span
        ref has no path)."""
        out = {str(path): int(n) for path, n in self._q("SELECT path, COUNT(*) FROM current WHERE path IS NOT NULL AND label IS NOT NULL GROUP BY path")}
        for path, n in self._q(f"SELECT c.path, SUM(c.last - c.first + 1 - {_LABELED_IN}) FROM covers c GROUP BY c.path"):
            if n:
                out[str(path)] = out.get(str(path), 0) + int(n)
        return out

    def presence(self) -> dict[str, dict[str, int]]:
        """{corpus path: {effective value: refs}}: which values a label left on each file, covers' records included, for
        the files tree's dots and stripes."""
        out: dict[str, dict[str, int]] = {}
        for path, value, n in self._q("SELECT path, effective, COUNT(*) FROM current WHERE path IS NOT NULL AND effective IS NOT NULL "
                                      "GROUP BY path, effective"):
            out.setdefault(str(path), {})[str(value)] = int(n)
        for path, value, n in self._q(f"SELECT c.path, c.value, SUM(c.last - c.first + 1 - {_ROWS_IN}) FROM covers c GROUP BY c.path, c.value"):
            if n:
                got = out.setdefault(str(path), {})
                got[str(value)] = got.get(str(value), 0) + int(n)
        return out

    def line_bins(self, path: str, total: int, bins: int) -> dict[str, list[int]]:
        """{effective value: [bin, ...]}: the bins of `total` lines cut into `bins` holding at least one record of that
        value on `path` (the reader's overview ruler), covers included. Whole-file rows are left out."""
        total, bins = max(1, int(total)), max(1, int(bins))
        found: dict[str, set[int]] = {}
        conn = self.connect()
        try:
            for value, b in conn.execute("SELECT effective, MIN(?, ((line - 1) * ?) / ?) AS b FROM current "
                                         "WHERE path = ? AND line IS NOT NULL AND effective IS NOT NULL GROUP BY effective, b",
                                         (bins - 1, bins, total, path)):
                found.setdefault(str(value), set()).add(int(b))
            covers = conn.execute("SELECT first, last, value FROM covers WHERE path = ? ORDER BY first", (path,)).fetchall()
            if covers:
                have = sorted(int(n) for (n,) in conn.execute("SELECT line FROM current WHERE path = ? AND line IS NOT NULL", (path,)))
                for first, last, value in covers:
                    got = found.setdefault(str(value), set())
                    for b in range(min(bins - 1, (first - 1) * bins // total), min(bins - 1, (last - 1) * bins // total) + 1):
                        # the lines the query above puts in bin b: from ceil(b·total/bins) + 1 to ceil((b+1)·total/bins),
                        # and every line after that in the last bin
                        lo = max(first, -(-b * total // bins) + 1)
                        hi = last if b == bins - 1 else min(last, -(-(b + 1) * total // bins))
                        if hi >= lo and hi - lo + 1 > bisect.bisect_right(have, hi) - bisect.bisect_left(have, lo):
                            got.add(b)
        finally:
            conn.close()
        return {v: sorted(bs) for v, bs in found.items() if bs}

    def verdicts(self, limit: int | None = None) -> list[dict]:
        """The analyst's verdicts, latest first: {ref, analyst, analyst_note, label} per ref they judged."""
        sql = (f"SELECT ref, analyst, analyst_note, {_LABEL} FROM current WHERE analyst IS NOT NULL "
               "ORDER BY analyst_ts DESC, rowid DESC")
        rows = self._q(sql + " LIMIT ?", (int(limit),)) if limit is not None else self._q(sql)
        return [{"ref": ref, "analyst": analyst, "analyst_note": note, "label": label} for ref, analyst, note, label in rows]


# --------------------------------------------------------------------------- the jsonl, read once


def _read_rows(jsonl: Path, start: int, end: int, mark: list[int] | None = None, markers: bool = False) -> Iterator[dict]:
    """The rows of the labels file's bytes [start, end), parsed one at a time, yielding the interpreter every
    YIELD_EVERY rows, and with `markers` its cover and clear lines in place. `mark[0]` receives the offset after the
    last full line."""
    try:
        f = open(jsonl, "rb")
    except OSError:
        return
    with f:
        f.seek(start)
        left = end - start
        pos = start
        i = 0
        while left > 0:
            line = f.readline()
            if not line:
                break
            left -= len(line)
            if line.endswith(b"\n"):
                pos += len(line)
                if mark is not None:
                    mark[0] = pos
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict) and r.get("ref"):
                r["ref"] = canon_ref(r["ref"])
                yield r
            elif markers and is_marker(r):
                yield r
            i += 1
            if i % YIELD_EVERY == 0:
                time.sleep(0)


def scan_jsonl(jsonl: Path, path: str | None, lines: tuple[int, int] | None = None) -> list[dict]:
    """One streaming pass over a labels file while its store is being rebuilt: the merged rows on `path` (or every row;
    with `lines`, lines a..b and whole-file rows), then its covers' implicit rows, as the store would answer them."""
    model: dict[str, dict] = {}
    analyst: dict[str, dict] = {}
    covers: dict[str, list[tuple[int, int, Any]]] = {}
    for i, r in enumerate(_read_rows(jsonl, 0, (file_key(jsonl) or (0, 0))[0], markers=True)):
        if i % 2_000 == 1_999:
            time.sleep(0)
        if is_marker(r):
            where, span = str(r.get(COVER) or r.get(CLEAR)), _span(r)
            if span is None or (path is not None and where != path):
                continue
            a, b = span
            if r.get(CLEAR):
                for ref in [ref for ref in model if ref_parts(ref)[0] == where and a <= (ref_parts(ref)[1] or 0) <= b]:
                    del model[ref]
            covers[where] = trim(covers.get(where, []), a, b)
            if r.get(COVER) and r.get("value") is not None:
                covers[where].append((a, b, (str(r["value"]), r.get("source"), r.get("ts"))))
            continue
        ref = str(r["ref"])
        if path is not None:
            ref_path, line = row_line(ref, r)
            if ref_path != path or (lines is not None and (not lines[0] <= line <= lines[1] if line is not None else ref != path)):
                continue
        (analyst if r.get("source") == "analyst" else model)[ref] = r

    def held(ref: str) -> tuple[str, Any, Any] | None:
        where, line = ref_parts(ref)
        return next((payload for first, last, payload in covers.get(where or "", []) if line and first <= line <= last), None)

    rows: list[dict] = []
    for ref, r in model.items():
        a = analyst.get(ref)
        row = {"ref": ref, "label": r.get("label"), "confidence": r.get("confidence"), "rationale": r.get("rationale"),
               "source": r.get("source"), "ts": r.get("ts"), "analyst": a.get("label") if a else None}
        marked = spans_field(r.get("spans"))
        if marked:
            row["spans"] = marked
        at = row_line(ref, r)[1]
        if at is not None and ref_parts(ref)[1] is None:
            row["line"] = at
        rows.append(row)
    for ref, a in analyst.items():
        if ref not in model:
            cover = held(ref)
            rows.append({"ref": ref, "label": cover[0] if cover else None, "confidence": None, "rationale": None,
                         "source": None, "ts": a.get("ts"), "analyst": a.get("label")})
    lo, hi = lines if lines is not None else (1, LAST_LINE)
    have: dict[str, set[int]] = {}
    for ref in [*model, *analyst]:
        where, line = ref_parts(ref)
        if where is not None and line is not None:
            have.setdefault(where, set()).add(line)
    for where in sorted(covers) if path is None else [path]:
        for first, last, (value, source, ts) in sorted(covers.get(where, []), key=lambda c: c[0]):
            for n in range(max(first, lo), min(last, hi) + 1):
                if n not in have.get(where, ()):
                    rows.append(implicit_row(where, n, value, source, ts))
    return rows


def rebuild_file(jsonl: str) -> int:
    """Store(jsonl).rebuild() by path, for the scan pool."""
    return Store(Path(jsonl)).rebuild()
