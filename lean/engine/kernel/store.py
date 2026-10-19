"""Where the kernel keeps its records.

In the folder under analysis (the root), the `thimble/` folder holds what the person may keep, share or diff:

    thimble/objects/<nn>-<slug>.json        one object each: program + data + lineage (objects.py)
    thimble/objects/.versions/<id>/v<k>.json  its earlier versions
    thimble/queries/q<n>.json               each query with its code, inputs, output and row lineage (query.py); a
                                            large row lineage is kept packed (pack_record)
    thimble/labels/<name>.json              each label with every version of its values (labels.py)
    thimble/kept/<name>.pkl.gz              results a query kept with keep(), which a later query reads with use()
    thimble/kept/<name>.rows.json           beside a kept table with no `_ref`, the rows behind each of its rows, when
                                            the query that kept it knew them (query._keep_rows)
    thimble/results/q<n>.pkl.gz             each query's output table, which a later query reads with use("q<n>")
    thimble/ledger.jsonl                    one line per `lean` call that read rows (what was read and how)

The pickles are compressed (gzip): a table whose rows each keep thousands of refs takes a twentieth of the space, and
pandas reads them as it reads any .pkl.gz. Earlier kernels wrote <name>.pkl, which is still read.

Under $THIMBLE_HOME/lean/events/<session>.jsonl the session's change feed: one line per change a surface draws (a
saved object), so the terminal and the browser learn of a save from the kernel, not from what a command printed.

Outside it, under $THIMBLE_HOME/lean (default ~/.thimble/lean): seen/<session>.jsonl, where the hooks module keeps the
files that Claude's own Read, Grep and Bash calls touched in each session (so a coding session in another folder never
gets a thimble/ folder), and cache/<folder>/, row counts and loaded frames, safe to delete. The cache stays bounded
(prune_cache): at most CACHE_MAX bytes of frames in all, none unread for CACHE_DAYS days. Nothing here writes into a
source file.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import time
import zlib
from pathlib import Path
from typing import Any

DIR = "thimble"


def thimble_home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or os.path.expanduser("~/.thimble"))


def find_root(start: str | Path | None = None) -> Path:
    """The folder under analysis: LEAN_ROOT, else the nearest folder at or above `start` (the working folder) that
    holds a thimble/ record folder, else `start` itself."""
    env = os.environ.get("LEAN_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(start or os.getcwd()).resolve()
    d = here
    while True:
        t = d / DIR
        if (t / "queries").is_dir() or (t / "objects").is_dir() or (t / "ledger.jsonl").is_file():
            return d
        if d.parent == d:
            return here
        d = d.parent


def session_id() -> str:
    return os.environ.get("LEAN_SESSION") or os.environ.get("CLAUDE_CODE_SESSION_ID") or "cli"


class Store:
    def __init__(self, root: str | Path | None = None, session: str | None = None):
        self.root = Path(root).resolve() if root else find_root()
        self.session = session or session_id()
        self.dir = self.root / DIR
        self.cache = thimble_home() / "lean" / "cache" / safe(str(self.root))[-100:]

    def sub(self, name: str) -> Path:
        d = self.dir / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    def cache_dir(self) -> Path:
        """This folder's cache, with a note of the folder it serves (`root`), so prune_cache can tell when the folder is
        gone and its cache can never be read again."""
        note = self.cache / "root"
        if not note.exists():
            try:
                self.cache.mkdir(parents=True, exist_ok=True)
                note.write_text(str(self.root) + "\n")
            except OSError:
                pass
        return self.cache

    # ---------------------------------------------------------------- ledger

    def log(self, row: dict[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        row = {"t": round(time.time(), 3), "session": self.session, **row}
        with open(self.dir / "ledger.jsonl", "a") as f:
            f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")

    def emit(self, row: dict[str, Any]) -> None:
        """One event of the session's change feed: $THIMBLE_HOME/lean/events/<session>.jsonl, one JSON line each,
        appended in one write. A surface follows the file by its size; an event names its folder, so the reader needs
        no other context."""
        try:
            d = thimble_home() / "lean" / "events"
            d.mkdir(parents=True, exist_ok=True)
            row = {"t": round(time.time(), 3), "session": self.session, "root": str(self.root), **row}
            line = json.dumps(row, ensure_ascii=False, default=str) + "\n"
            fd = os.open(d / f"{safe(self.session)}.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
            try:
                os.write(fd, line.encode())
            finally:
                os.close(fd)
        except OSError:
            pass

    def ledger(self, session: str | None = "") -> list[dict[str, Any]]:
        """Rows of the ledger: of this session (the default), of `session`, or of every session (None)."""
        want = self.session if session == "" else session
        out = []
        try:
            with open(self.dir / "ledger.jsonl") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if want is None or r.get("session") == want:
                        out.append(r)
        except OSError:
            pass
        return out

    # ---------------------------------------------------------------- what the hooks saw

    def seen(self, session: str | None = "") -> list[dict[str, Any]]:
        """The Read, Grep and Bash calls the hooks module kept for this session (or `session`, or every session when
        None) whose working folder is under the root, with absolute paths."""
        d = thimble_home() / "lean" / "seen"
        want = self.session if session == "" else session
        files = sorted(d.glob("*.jsonl")) if want is None else [d / f"{safe(want)}.jsonl"]
        out = []
        root = str(self.root)
        for f in files:
            try:
                lines = f.read_text().splitlines()
            except OSError:
                continue
            for line in lines:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                cwd = str(r.get("cwd") or "")
                if cwd == root or cwd.startswith(root + os.sep) or root.startswith(cwd.rstrip("/") + os.sep):
                    out.append(r)
        return out

    def rel(self, path: str) -> str | None:
        """A path relative to the root, or None when it is outside the root."""
        try:
            p = Path(path)
            if not p.is_absolute():
                p = self.root / p
            r = os.path.relpath(os.path.normpath(p), self.root)
        except ValueError:
            return None
        return None if r.startswith("..") else r

    # ---------------------------------------------------------------- json files

    @staticmethod
    def read_json(p: Path) -> Any:
        try:
            return json.loads(p.read_text())
        except (OSError, ValueError):
            return None

    @staticmethod
    def write_json(p: Path, obj: Any) -> None:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False, default=str) + "\n")
        os.replace(tmp, p)


def safe(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in s)[:120] or "none"


# ------------------------------------------------------------------ row lineage, kept compactly
#
# Row lineage is lists of row-set strings: a query's `rows`, `read` and `cells`; an object's rows per file, and the rows
# of each binding and citation. A row set joins numbered rows of one file (`a.jsonl#L4-9,12`), but a ref that names a
# block of a transcript record (`a.jsonl#L44.b0`) stays one string each, so a query over a swarm's transcripts can keep
# millions of them, and a summary keeps the same list once per value. Over PACK_MIN characters a record keeps them
# packed: each distinct list once, each file path once, then compressed (zlib, as base64 text, so the record stays one
# JSON file). Unpacking gives back the same lists, in the same order, so every ref resolves as before.

PACK_KEYS = ("rows", "read", "cells")
PACK_MIN = 64_000  # characters of row lineage over which a record keeps it packed
PACK_FORMAT = "lean-rows/1"


def _rowset_chars(v: Any) -> int:
    if isinstance(v, str):
        return len(v) + 3
    if isinstance(v, list):
        return sum(_rowset_chars(x) for x in v) + 2
    if isinstance(v, dict):
        return sum(len(str(k)) + _rowset_chars(x) for k, x in v.items()) + 2
    return 4


class _Packer:
    """Lists of row-set strings, each distinct list once by its number, each file path once."""

    def __init__(self) -> None:
        self.files: dict[str, int] = {}
        self.lists: list[list[Any]] = []
        self.by_id: dict[int, int] = {}
        self.by_value: dict[tuple[str, ...], int] = {}

    def put(self, xs: Any) -> int | None:
        if xs is None:
            return None
        i = self.by_id.get(id(xs))
        if i is not None:
            return i
        if not isinstance(xs, list):
            raise TypeError("row lineage is a list of row sets")
        key = tuple(xs)
        i = self.by_value.get(key)
        if i is None:
            enc: list[Any] = []
            cur = -1
            for x in xs:
                path, mark, frag = x.partition("#")
                f = self.files.get(path)
                if f is None:
                    f = self.files[path] = len(self.files)
                if f != cur:
                    enc.append(f)
                    cur = f
                enc.append(frag if mark else None)
            i = self.by_value[key] = len(self.lists)
            self.lists.append(enc)
        self.by_id[id(xs)] = i
        return i

    def packed(self, body: dict[str, Any], keys: list[str]) -> dict[str, Any]:
        body = {**body, "files": list(self.files), "lists": self.lists}
        raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8", "surrogatepass")
        refs = sum(1 for enc in self.lists for e in enc if type(e) is not int)
        return {"format": PACK_FORMAT, "keys": keys, "lists": len(self.lists), "refs": refs,
                "zlib": base64.b64encode(zlib.compress(raw, 6)).decode("ascii")}


def _unpacked(p: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    """(the packed body, a function from a list's number to the list). A list several parts share is one list."""
    body = json.loads(zlib.decompress(base64.b64decode(p["zlib"])).decode("utf-8", "surrogatepass"))
    files = body["files"]
    lists: list[list[str]] = []
    for enc in body["lists"]:
        out: list[str] = []
        cur, pre = "", "#"
        for e in enc:
            if type(e) is int:
                cur = files[e]
                pre = cur + "#"
            elif e is None:
                out.append(cur)
            else:
                out.append(pre + e)
        lists.append(out)
    return body, (lambda i: None if i is None else lists[i])


def pack_record(q: dict[str, Any]) -> dict[str, Any]:
    """A query record as it is written: its row lineage packed when it is longer than PACK_MIN characters, else the
    record as it is."""
    parts = {k: q[k] for k in PACK_KEYS if q.get(k) is not None}
    if not parts or _rowset_chars(parts) <= PACK_MIN:
        return q
    pk = _Packer()
    try:
        body: dict[str, Any] = {}
        if "rows" in parts:
            body["rows"] = [pk.put(x) for x in parts["rows"]]
        if "read" in parts:
            body["read"] = pk.put(parts["read"])
        if "cells" in parts:
            body["cells"] = [{c: pk.put(x) for c, x in cell.items()} if isinstance(cell, dict) else None for cell in parts["cells"]]
        packed = pk.packed(body, list(parts))
    except (AttributeError, TypeError, ValueError):  # a list that holds something other than row sets stays as it is
        return q
    out = {k: v for k, v in q.items() if k not in PACK_KEYS}
    out["packed"] = packed
    return out


def unpack_record(q: dict[str, Any]) -> dict[str, Any]:
    """A query record as read: its packed row lineage (if any) given back as `rows`, `read` and `cells`. A list that
    several parts share (a summary's rows) is one list object, as when the query made it."""
    p = q.get("packed")
    if not isinstance(p, dict) or p.get("format") != PACK_FORMAT:
        return q
    body, at = _unpacked(p)
    q = {k: v for k, v in q.items() if k != "packed"}
    if "rows" in body:
        q["rows"] = [at(i) for i in body["rows"]]
    if "read" in body:
        q["read"] = at(body["read"])
    if "cells" in body:
        q["cells"] = [{c: at(i) for c, i in cell.items()} if isinstance(cell, dict) else cell for cell in body["cells"]]
    return q


def _rows_in(rowset: str) -> int | None:
    """How many rows a row set names, as the observer counts them (observer/evidence.js rowsIn); None for a whole file."""
    hash_ = rowset.find("#")
    if hash_ < 0:
        return None
    frag = rowset[hash_ + 1:]
    if re.fullmatch(r"L\d+\.b\d+", frag):
        return 1
    if re.fullmatch(r"L\d+(?:-\d+)?\.b\d+(?:-\d+)?(?:,\d+(?:-\d+)?\.b\d+(?:-\d+)?)*", frag):
        # a block set: each part's lines times its blocks
        n = 0
        for part in frag[1:].split(","):
            lines, _, blocks = part.partition(".b")
            a, _, b = lines.partition("-")
            c, _, d = blocks.partition("-")
            n += (abs(int(b or a) - int(a)) + 1) * (abs(int(d or c) - int(c)) + 1)
        return n
    m = re.fullmatch(r"L(\d+)-L(\d+)", frag)
    if m:
        return max(0, int(m[2]) - int(m[1]) + 1)
    m = re.search(r"(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$", frag)
    if not m:
        return 1
    n = 0
    for part in m[1].split(","):
        a, _, b = part.partition("-")
        n += 1 if not b else max(0, int(b) - int(a) + 1)
    return n


def _rows_n(rowsets: list[str]) -> int | None:
    n = 0
    for rs in rowsets:
        k = _rows_in(rs)
        if k is None:
            return None
        n += k
    return n


def pack_object(obj: dict[str, Any]) -> dict[str, Any]:
    """An object as it is written: when its lineage's rows (per file, and of each binding and citation) are longer
    than PACK_MIN characters, they are packed into `lineage.packed`. What stays in place is what the other readers of
    the file use: each file's `count`, and each citation's `rows_n` and `rows_files` (the observer's slim form). The
    data, with each row's `_rows`, stays as it is: a card's program reads it."""
    lin = obj.get("lineage")
    if not isinstance(lin, dict):
        return obj
    rows = lin.get("rows") if isinstance(lin.get("rows"), dict) else {}
    binds = lin.get("bindings") if isinstance(lin.get("bindings"), list) else []
    cites = lin.get("cites") if isinstance(lin.get("cites"), list) else []
    size = (sum(_rowset_chars(x.get("rowsets")) for x in rows.values() if isinstance(x, dict) and x.get("rowsets"))
            + sum(_rowset_chars(b.get("rows")) for b in binds if isinstance(b, dict) and b.get("rows") is not None)
            + sum(_rowset_chars(c.get("rows")) for c in cites if isinstance(c, dict) and c.get("rows") is not None))
    if size <= PACK_MIN:
        return obj
    pk = _Packer()

    def where(d: dict[str, Any], key: str) -> int:
        return list(d).index(key)

    try:
        body = {
            "rows": {f: pk.put(x["rowsets"]) for f, x in rows.items() if isinstance(x, dict) and "rowsets" in x},
            "bindings": [[pk.put(b["rows"]), where(b, "rows")] if isinstance(b, dict) and "rows" in b else None for b in binds],
            "cites": [[pk.put(c["rows"]), where(c, "rows")] if isinstance(c, dict) and "rows" in c else None for c in cites],
        }
        packed = pk.packed(body, ["rows", "bindings", "cites"])
    except (AttributeError, TypeError, ValueError):
        return obj
    slim_cite = lambda c: {**{k: v for k, v in c.items() if k != "rows"}, "rows_n": _rows_n(c["rows"]),  # noqa: E731
                           "rows_files": list(dict.fromkeys(str(x).split("#")[0] for x in c["rows"]))}
    new = dict(lin)
    new["rows"] = {f: ({k: v for k, v in x.items() if k != "rowsets"} if isinstance(x, dict) else x) for f, x in rows.items()}
    if "bindings" in lin:
        new["bindings"] = [{k: v for k, v in b.items() if k != "rows"} if isinstance(b, dict) else b for b in binds]
    if "cites" in lin:
        new["cites"] = [slim_cite(c) if isinstance(c, dict) and "rows" in c else c for c in cites]
    new["packed"] = packed
    return {**obj, "lineage": new}


def unpack_object(obj: dict[str, Any] | None) -> dict[str, Any] | None:
    """An object as read: its packed lineage rows (if any) back in place, in the same order of keys."""
    if not isinstance(obj, dict) or not isinstance(obj.get("lineage"), dict):
        return obj
    lin = obj["lineage"]
    p = lin.get("packed")
    if not isinstance(p, dict) or p.get("format") != PACK_FORMAT:
        return obj
    body, at = _unpacked(p)

    def put_back(d: dict[str, Any], i: int | None, pos: int, drop: tuple[str, ...] = ()) -> dict[str, Any]:
        items = [(k, v) for k, v in d.items() if k not in drop]
        items.insert(pos, ("rows", at(i)))
        return dict(items)

    new = {k: v for k, v in lin.items() if k != "packed"}
    rows = dict(new.get("rows") or {})
    for f, i in body.get("rows", {}).items():
        if isinstance(rows.get(f), dict):
            rows[f] = {**rows[f], "rowsets": at(i)}
    if "rows" in new:
        new["rows"] = rows
    if "bindings" in new:
        new["bindings"] = [put_back(b, *e) if e and isinstance(b, dict) else b for b, e in zip(new["bindings"], body.get("bindings") or [])]
    if "cites" in new:
        new["cites"] = [put_back(c, *e, drop=("rows_n", "rows_files")) if e and isinstance(c, dict) else c
                        for c, e in zip(new["cites"], body.get("cites") or [])]
    return {**obj, "lineage": new}


# ------------------------------------------------------------------ pickles: results and kept values


def pickle_path(d: Path, name: str) -> Path | None:
    """The pickle a result or kept value is in: <name>.pkl.gz, else an earlier kernel's <name>.pkl; None when neither."""
    for p in (d / f"{name}.pkl.gz", d / f"{name}.pkl"):
        if p.exists():
            return p
    return None


def write_pickle(d: Path, name: str, obj: Any) -> Path:
    """A result or a kept value, pickled and compressed at gzip's fastest level (a table of a million refs: 89 MB as a
    plain pickle, 3 MB here, in about the same time), written whole and then renamed. An earlier kernel's plain
    pickle of the same name goes."""
    import pandas as pd

    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{name}.pkl.gz"
    tmp = d / f".{name}.{os.getpid()}.tmp"
    try:
        pd.to_pickle(obj, tmp, compression={"method": "gzip", "compresslevel": 1, "mtime": 0})
        os.replace(tmp, p)
    finally:
        if tmp.exists():
            tmp.unlink()
    old = d / f"{name}.pkl"
    if old.exists():
        old.unlink()
    return p


def read_pickle(p: Path) -> Any:
    import pandas as pd

    with open(p, "rb") as f:
        gz = f.read(2) == b"\x1f\x8b"
    return pd.read_pickle(p, compression="gzip" if gz else None)


# ------------------------------------------------------------------ the cache: bounded


CACHE_MAX = int(float(os.environ.get("LEAN_CACHE_MAX_GB") or 8) * 1e9)  # bytes of cached frames in all
CACHE_SHARE = 0.25  # and at most this share of the space the cache could have (the disk's free space and its own)
CACHE_DAYS = 14  # a frame no load read for this long goes
PRUNE_EVERY = 86400  # seconds: the cache is looked over at most this often, and after a query that added to it


def prune_cache(force: bool = False, now: float | None = None) -> dict[str, int]:
    """Keep $THIMBLE_HOME/lean/cache bounded. Removes what this kernel cannot use: an earlier kernel's frames
    (frames/<key>.pkl), parts of a write that never finished, and the cache of a folder that is gone; then every frame
    no load read in CACHE_DAYS days; then the least recently read frames until all of them take at most CACHE_MAX bytes
    and at most CACHE_SHARE of the disk space the cache could have. A load marks a frame read by touching its index. A
    corpus of 5 GB keeps about 6 GB of frames, so its loads all read from the cache under the default. Returns what it
    removed: {files, bytes}."""
    base = thimble_home() / "lean" / "cache"
    stamp = base / ".pruned"
    now = time.time() if now is None else now
    if not force:
        try:
            if now - stamp.stat().st_mtime < PRUNE_EVERY:
                return {"files": 0, "bytes": 0}
        except OSError:
            pass
    if not base.is_dir():
        return {"files": 0, "bytes": 0}
    gone = {"files": 0, "bytes": 0}

    def drop(p: Path) -> None:
        try:
            n = p.stat().st_size
            p.unlink()
            gone["files"] += 1
            gone["bytes"] += n
        except OSError:
            pass

    def drop_dir(d: Path) -> None:
        for dp, _, fs in os.walk(d):
            for f in fs:
                try:
                    gone["bytes"] += os.lstat(os.path.join(dp, f)).st_size
                    gone["files"] += 1
                except OSError:
                    pass
        shutil.rmtree(d, ignore_errors=True)

    frames: list[tuple[float, int, Path, Path]] = []  # (last read, bytes, index, columns)
    for folder in sorted(p for p in base.iterdir() if p.is_dir()):
        legacy = folder / "frames"
        if legacy.is_dir():
            drop_dir(legacy)
        try:
            root = (folder / "root").read_text().strip()
        except OSError:
            root = ""
        if root and not Path(root).is_dir():
            drop_dir(folder)
            continue
        d = folder / "frames2"
        if not d.is_dir():
            # a folder with no frames (row counts only) that nothing wrote to in CACHE_DAYS days
            try:
                if all(now - p.stat().st_mtime > CACHE_DAYS * 86400 for p in folder.iterdir()):
                    drop_dir(folder)
            except OSError:
                pass
            continue
        names: dict[str, os.stat_result] = {}
        for e in os.scandir(d):
            try:
                names[e.name] = e.stat()
            except OSError:
                continue
        for name, s in names.items():
            p = d / name
            if name.endswith(".tmp"):
                if now - s.st_mtime > 3600:
                    drop(p)
            elif name.endswith(".json"):
                cols = name[:-5] + ".cols"
                if cols not in names:
                    drop(p)
                else:
                    frames.append((s.st_mtime, s.st_size + names[cols].st_size, p, d / cols))
            elif name.endswith(".cols") and name[:-5] + ".json" not in names and now - s.st_mtime > 3600:
                drop(p)
    frames.sort(key=lambda x: x[0])
    total = sum(x[1] for x in frames)
    cap = CACHE_MAX
    try:
        cap = min(cap, int((shutil.disk_usage(base).free + total) * CACHE_SHARE))
    except OSError:
        pass
    for used, size, idx, cols in frames:
        if now - used <= CACHE_DAYS * 86400 and total <= cap:
            break
        drop(idx)
        drop(cols)
        total -= size
    try:
        base.mkdir(parents=True, exist_ok=True)
        stamp.touch()
    except OSError:
        pass
    return gone
