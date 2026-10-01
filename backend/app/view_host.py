"""The half of a view's reader that runs on the workspace's `views` kernel (views.py sends this file's source to the
kernel and calls `call` there).

A viewer's reader.py defines build_index(paths) -> index, records(index, query) -> JSON, and resolve(index, locator) ->
{excerpt, label, refs, key?, target?} or None, and may define problems(index) -> the lines it could not read, as
[{ref, why}] or {count, examples: [{ref, why}]}, hidden(index) -> the claimed files it leaves out on purpose, as
[{path, why}], unplaced(index) -> the records it read but could not place in the page, as problems() gives them, and
derived(index) -> the fields it made rather than read, as [{field, from, how, kind?}]; a card type thimble
ships may also define applies(paths) -> {claims, found} or None, whether it fits a corpus (cardtypes.claims_of), which
runs with no index. `call` loads reader.py (again when it changed), builds the index or loads it from a pickle keyed by
the files' and reader's fingerprint, runs one operation and prints SENTINEL followed by the JSON answer. A reader that
raises answers {ok: false, error, traceback}. The indexes in memory are the most recently used, at most
INDEXES_PER_VIEW per view and at most the request's `memory` bytes in all; the one in use always stays. An index's
bytes are what the kernel's resident memory grew by while it was built or loaded, at least its pickle's size. After a
call that built or loaded an index, or grew the kernel's memory by more than TRIM_GROWTH, the kernel collects its
garbage and hands the freed memory back to the system (_trim).

A request's `progress` is a file the call's progress is written to while it runs ({phase, done, total, note}): phase
`index` while build_index runs, then `call`, with what the reader reports through thimble.progress.

While build_index runs, `open` counts the bytes it takes of each claimed file (_Reads), so thimble knows which files
the view read to the end. The counts are kept beside the index (`reads`)."""
from __future__ import annotations

import builtins
import gc
import importlib.util
import io
import json
import os
import pickle
import sys
import time
import traceback
import types
import weakref
from collections import OrderedDict
from typing import Any

SENTINEL = "\x1ethimble-view\x1e"
TRACEBACK_MAX = 3000

_readers: dict[str, tuple[tuple[int, int], object]] = {}  # reader.py's path -> ((mtime_ns, size), module)
_indexes: "OrderedDict[tuple[str, str], object]" = OrderedDict()  # (slug, fingerprint) -> index, least recent first
_sizes: dict[tuple[str, str], int] = {}  # (slug, fingerprint) -> bytes of its pickle (0 when it has none)
_read_counts: dict[tuple[str, str], dict[str, int]] = {}  # (slug, fingerprint) -> {claimed path: bytes build_index read}
_unpickled: set[tuple[str, str]] = set()  # the indexes in memory that have no pickle, which a restart would build again
# a page still on a view's version before a change reads its index beside the new version's
INDEXES_PER_VIEW = 2
PROGRESS_EVERY_S = 0.2  # the least time between two writes of a call's progress
LEFT_OUT_MAX = 200_000  # refs a records answer lists of those kept() refused; beyond that it gives only their count
TRIM_GROWTH = 64 * 1024 * 1024  # bytes a call may grow the kernel's resident memory by before it is trimmed after
_libc: list = []  # [glibc's malloc_trim, or None where there is none], looked up once


def _rss() -> int | None:
    """The kernel's resident memory in bytes, None where /proc does not tell it."""
    try:
        with open("/proc/self/statm", "rb") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        return None


def _trim() -> None:
    """Collect garbage, then give the memory malloc holds free back to the system where glibc can."""
    gc.collect()
    if not _libc:
        fn = None
        try:
            import ctypes  # noqa: PLC0415
            import ctypes.util  # noqa: PLC0415

            name = ctypes.util.find_library("c")
            fn = getattr(ctypes.CDLL(name), "malloc_trim", None) if name else None
        except (OSError, AttributeError, ImportError):
            fn = None
        _libc.append(fn)
    if _libc[0] is not None:
        try:
            _libc[0](0)
        except Exception:  # noqa: BLE001 — trimming is an economy, never a failure
            pass


def _reader(slug: str, path: str) -> object:
    """reader.py as a module, loaded again when the file's mtime or size changed."""
    st = os.stat(path)
    sig = (st.st_mtime_ns, st.st_size)
    hit = _readers.get(path)
    if hit is not None and hit[0] == sig:
        return hit[1]
    name = "thimble_view_" + slug.replace("-", "_")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    for fn in ("build_index", "records", "resolve"):
        if not callable(getattr(mod, fn, None)):
            raise AttributeError(f"reader.py defines no function {fn}()")
    _readers[path] = (sig, mod)
    return mod


class _Counted(io.FileIO):
    """A claimed file opened for reading, which records each byte range it reads and whether a read found its end.
    When its reader closes it (settle), the part of its last read that the reader had not yet taken from the buffers
    above it is dropped, unless a read found the end, and its ranges go to its _Reads."""

    _reads: "_Reads"
    _path: str

    def _start(self, reads: "_Reads", path: str) -> None:
        self._reads, self._path = reads, path
        self._spans: list[list[int]] = []
        self._eof = self._done = False

    def _note(self, start: int, n: int, asked: int) -> None:
        if n:
            if self._spans and self._spans[-1][1] == start:
                self._spans[-1][1] = start + n
                self._last = (start, start + n)
            else:
                self._spans.append([start, start + n])
                self._last = (start, start + n)
        elif asked:
            self._eof = True

    def readinto(self, b):  # type: ignore[override]
        start = self.tell()
        n = super().readinto(b)
        self._note(start, n or 0, len(memoryview(b)) if n is not None else 0)
        return n

    def read(self, size: int = -1):  # type: ignore[override]
        start = self.tell()
        data = super().read(size)
        self._note(start, len(data or b""), size if data is not None else 0)
        if size is None or size < 0:
            self._eof = True
        return data

    def readall(self):  # type: ignore[override]
        start = self.tell()
        data = super().readall()
        self._note(start, len(data or b""), 0)
        self._eof = True
        return data

    def settle(self, pos: int | None) -> None:
        """Record the ranges read, `pos` being how far the reader had taken the file (None when that is not known)."""
        if self._done:
            return
        self._done = True
        if self._spans and not self._eof:
            a, z = self._last
            cut = a if pos is None or not a <= pos < z else pos
            self._spans[-1][1] = cut
        for a, z in self._spans:
            if z > a:
                self._reads.add(self._path, a, z)

    def close(self) -> None:
        if not self.closed:
            self.settle(self.tell())
        super().close()


class _CountedBuffer(io.BufferedReader):
    def settle(self) -> None:
        try:
            pos = self.tell()
        except (OSError, ValueError):
            pos = None
        self.raw.settle(pos)

    def close(self) -> None:
        if not self.closed:
            self.settle()
        super().close()


class _CountedText(io.TextIOWrapper):
    """Iterates by readline, so tell() stays usable and settle knows how far the reader got."""

    def __next__(self) -> str:
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def settle(self) -> None:
        raw = self.buffer.raw
        try:
            pos = self.tell()
            if pos > os.fstat(raw.fileno()).st_size:  # an opaque position: the decoder holds state
                pos = None
        except (OSError, ValueError):
            pos = None
        raw.settle(pos)

    def close(self) -> None:
        if not self.closed:
            self.settle()
        super().close()


class _Reads:
    """The bytes read of each claimed file while it is active: `open` and `io.open` are replaced by one that gives a
    claimed file, opened only for reading, through _Counted. A file read by other means (os.open, os.fdopen, mmap, a
    library's own C code) counts as unread. The count follows what the reader reads, so a reader can also fake it."""

    def __init__(self, paths: list[str]) -> None:
        self.claimed: dict[str, list[str]] = {}
        for p in paths:
            self.claimed.setdefault(os.path.realpath(p), []).append(p)
        self.spans: dict[str, list[tuple[int, int]]] = {}
        self.handles: list[weakref.ref] = []
        self._open = io.open

    def add(self, path: str, start: int, end: int) -> None:
        spans = self.spans.setdefault(path, [])
        if spans and spans[-1][0] <= start <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))

    def counts(self) -> dict[str, int]:
        """{path: the bytes read of it, each byte once} for every claimed path."""
        out = {p: 0 for ps in self.claimed.values() for p in ps}
        for real, spans in self.spans.items():
            total, end = 0, -1
            for a, z in sorted(spans):
                if z > end:
                    total += z - max(a, end)
                    end = z
            for p in self.claimed.get(real, []):
                out[p] = total
        return out

    def open(self, file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
        real = None
        if opener is None and closefd and isinstance(file, (str, bytes, os.PathLike)) and set(mode) <= set("rbt") \
                and "r" in mode:
            try:
                real = os.path.realpath(os.fsdecode(file))
            except (TypeError, ValueError):
                real = None
        if real not in self.claimed or (buffering == 0 and "b" not in mode):
            return self._open(file, mode, buffering, encoding, errors, newline, closefd, opener)
        raw = _Counted(file, "r")
        raw._start(self, real)
        top: Any = raw
        if buffering != 0:
            top = _CountedBuffer(raw, buffering if buffering > 1 else io.DEFAULT_BUFFER_SIZE)
            if "b" not in mode:
                top = _CountedText(top, encoding, errors, newline, line_buffering=buffering == 1)
                top.mode = mode  # type: ignore[misc]
        self.handles.append(weakref.ref(top))
        return top

    def __enter__(self) -> "_Reads":
        builtins.open = io.open = self.open  # type: ignore[assignment]
        return self

    def __exit__(self, *exc: object) -> None:
        builtins.open = io.open = self._open  # type: ignore[assignment]
        for ref in self.handles:
            f = ref()
            if f is not None and not f.closed:
                f.settle() if not isinstance(f, _Counted) else f.settle(f.tell())


def _load_reads(path: str | None) -> dict[str, int] | None:
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return None
    return {str(k): int(v) for k, v in raw.items()} if isinstance(raw, dict) else None


def _index(slug: str, mod: object, fp: str, paths: list[str], cache: str | None,
           reads: str | None = None, progress: "_Progress | None" = None) -> tuple[object, bool]:
    """(the index for this fingerprint, whether it was built now): from memory, else the pickle, else build_index. With
    `reads`, the path the byte counts are kept at, a pickle without them is built again."""
    key = (slug, fp)
    if key in _indexes:
        _indexes.move_to_end(key)
        return _indexes[key], False
    before = _rss()
    idx = None
    built = False
    counts = _load_reads(reads)
    if cache and os.path.isfile(cache) and (counts is not None or not reads):
        try:
            with open(cache, "rb") as f:
                idx = pickle.load(f)
        except Exception:  # noqa: BLE001 — a broken cache is rebuilt
            idx = None
    if idx is None:
        if progress is not None:
            progress.set(force=True, phase="index")
        with _Reads(list(paths)) as seen:
            idx = mod.build_index(list(paths))  # type: ignore[attr-defined]
        counts = seen.counts()
        built = True
        if cache:
            try:
                os.makedirs(os.path.dirname(cache), exist_ok=True)
                tmp = f"{cache}.{os.getpid()}.tmp"
                with open(tmp, "wb") as f:
                    pickle.dump(idx, f, protocol=pickle.HIGHEST_PROTOCOL)
                os.replace(tmp, cache)
            except Exception:  # noqa: BLE001 — an index that does not pickle stays in memory only
                pass
        if reads:
            try:
                os.makedirs(os.path.dirname(reads), exist_ok=True)
                tmp = f"{reads}.{os.getpid()}.tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(counts, f)
                os.replace(tmp, reads)
            except OSError:
                pass
    _indexes[key] = idx
    _trim()
    after = _rss()
    grew = after - before if after is not None and before is not None else 0
    _sizes[key] = max(grew, _file_size(cache))
    _read_counts[key] = counts or {}
    if not cache or not os.path.isfile(cache):
        _unpickled.add(key)
    return idx, built


def _file_size(path: str | None) -> int:
    try:
        return os.path.getsize(path) if path else 0
    except OSError:
        return 0


def _evict(key: tuple[str, str], memory: int | None) -> list[str]:
    """Drop the least recently used indexes but `key`'s: beyond INDEXES_PER_VIEW of one view, then while the pickles of
    those kept come to more than `memory` bytes. The fingerprints dropped, as `<slug>/<fp>`."""
    dropped = []
    mine = [k for k in _indexes if k[0] == key[0] and k != key]
    gone = mine[: max(0, len(mine) - INDEXES_PER_VIEW + 1)]
    if memory is not None:
        total = sum(_sizes.get(k, 0) for k in _indexes if k not in gone)
        for k in list(_indexes):
            if total <= memory:
                break
            if k != key and k not in gone:
                gone.append(k)
                total -= _sizes.get(k, 0)
    for k in gone:
        _indexes.pop(k, None)
        _sizes.pop(k, None)
        _read_counts.pop(k, None)
        _unpickled.discard(k)
        dropped.append(f"{k[0]}/{k[1]}")
    return dropped


class _Progress:
    """Writes a call's progress to its file, at most every PROGRESS_EVERY_S but for a change of phase."""

    def __init__(self, path: str | None) -> None:
        self.path = path
        self.state: dict = {"phase": "call"}
        self.at = 0.0

    def set(self, force: bool = False, **fields: Any) -> None:
        if not self.path:
            return
        self.state.update(fields)
        now = time.monotonic()
        if not force and now - self.at < PROGRESS_EVERY_S:
            return
        self.at = now
        try:
            tmp = f"{self.path}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.state, f)
            os.replace(tmp, self.path)
        except (OSError, TypeError, ValueError):
            pass


def _optional(mod: object, name: str, idx: object) -> dict:
    """{result} of the reader's optional function `name` on the index, {result: None} when it has none, {error} when
    it raised."""
    fn = getattr(mod, name, None)
    if not callable(fn):
        return {"result": None}
    try:
        return {"result": fn(idx)}
    except Exception as e:  # noqa: BLE001 — its failure is part of the answer
        return {"error": f"{type(e).__name__}: {e}"}


def _thimble(req: dict) -> object | None:
    """The `thimble` module a reader imports: the kernel's own, else one built from kernel_thimble.py (`req["thimble"]`)
    for a kernel started without it."""
    mod = sys.modules.get("thimble")
    if mod is None and req.get("thimble"):
        mod = types.ModuleType("thimble")
        mod.WS = None  # type: ignore[attr-defined]
        with open(req["thimble"], encoding="utf-8") as f:
            exec(f.read(), mod.__dict__)  # noqa: S102 — thimble's own module source
        sys.modules["thimble"] = mod
    return mod


def _left_answer(left_out: set[str]) -> dict:
    if not left_out:
        return {}
    return {"left_out_n": len(left_out), **({"left_out": list(left_out)} if len(left_out) <= LEFT_OUT_MAX else {})}


def answer(req: dict) -> dict:
    """The answer to one request {slug, reader, fp, paths, cache, reads?, memory?, progress?, op, arg, labels?, root?};
    op is index, records, resolve, resolve_many (a list of locators, answered with a list), problems ([] for a reader
    without problems()), shown ({reads, hidden, derived, unplaced}: the bytes build_index read of each claimed file, and
    hidden(), derived() and unplaced() each as {result} or {error}) or applies (the corpus's record files as `arg`). A
    records call runs with `labels`, the labels context, as thimble's _view_ctx, which thimble.marked and thimble.kept
    read, and the claimed paths as its _view_paths; its answer's `left_out_n` counts the refs thimble.kept and
    kept_unit refused for the filter, and `left_out` lists them when there are at most LEFT_OUT_MAX. With `root` the
    call runs in that folder, a copy of the corpus the paths are relative to. The answer's `held` lists the indexes in
    memory afterwards (_held), `dropped` those it let go, and `unpickled` is true while one of them has no pickle."""
    t0 = time.monotonic()
    start_rss = _rss()
    th = None
    progress = _Progress(req.get("progress"))
    dropped: list[str] = []
    left_out: set[str] = set()
    here = os.getcwd() if req.get("root") else None
    try:
        if here is not None:
            os.chdir(req["root"])
        th = _thimble(req)  # before reader.py loads, since it may import thimble at its top
        if th is not None:
            th._progress = progress.set  # type: ignore[attr-defined]
        mod = _reader(req["slug"], req["reader"])
        if req.get("op") == "applies":
            fn = getattr(mod, "applies", None)
            result = fn(list(req.get("arg") or [])) if callable(fn) else None
            return {"ok": True, "result": result, "built": False, "ms": round((time.monotonic() - t0) * 1000)}
        idx, built = _index(req["slug"], mod, req["fp"], req.get("paths") or [], req.get("cache"), req.get("reads"),
                            progress)
        dropped = _evict((req["slug"], req["fp"]), req.get("memory"))
        progress.set(force=built, phase="call")
        op = req.get("op")
        if op == "index":
            result = None
        elif op == "records":
            if th is not None:
                th._view_ctx = req.get("labels")  # type: ignore[attr-defined]
                th._view_paths = list(req.get("paths") or [])  # type: ignore[attr-defined]
                th._left_out = left_out  # type: ignore[attr-defined]
            result = mod.records(idx, req.get("arg"))  # type: ignore[attr-defined]
        elif op == "resolve":
            result = mod.resolve(idx, req.get("arg"))  # type: ignore[attr-defined]
        elif op == "problems":
            fn = getattr(mod, "problems", None)
            result = fn(idx) if callable(fn) else []
        elif op == "shown":
            result = {"reads": _read_counts.get((req["slug"], req["fp"]), {}), "hidden": _optional(mod, "hidden", idx),
                      "derived": _optional(mod, "derived", idx), "unplaced": _optional(mod, "unplaced", idx)}
        elif op == "resolve_many":
            result = []
            for loc in req.get("arg") or []:
                try:
                    result.append({"ok": True, "result": mod.resolve(idx, loc)})  # type: ignore[attr-defined]
                except Exception as e:  # noqa: BLE001 — one locator's failure is its own answer
                    result.append({"ok": False, "error": f"{type(e).__name__}: {e}"})
        else:
            raise ValueError(f"unknown operation {op!r}")
        return {"ok": True, "result": result, "built": built, "ms": round((time.monotonic() - t0) * 1000),
                "held": _held(), **({"dropped": dropped} if dropped else {}), **({"unpickled": True} if _unpickled else {}),
                **_left_answer(left_out)}
    except Exception as e:  # noqa: BLE001 — a reader's failure is the answer
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-TRACEBACK_MAX:],
                "ms": round((time.monotonic() - t0) * 1000)}
    finally:
        if th is not None:
            th._view_ctx = None  # type: ignore[attr-defined]
            th._view_paths = []  # type: ignore[attr-defined]
            th._left_out = None  # type: ignore[attr-defined]
            th._progress = None  # type: ignore[attr-defined]
        if here is not None:
            os.chdir(here)
        now = _rss()
        if dropped or (now is not None and start_rss is not None and now - start_rss > TRIM_GROWTH):
            _trim()


def _held() -> list[list]:
    """The indexes in memory, least recently used first, as [slug, fingerprint, bytes of its pickle]."""
    return [[k[0], k[1], _sizes.get(k, 0)] for k in _indexes]


def call(req_json: str) -> None:
    """Answer the request and print it on one line after SENTINEL. A result that is not JSON is sent as its str."""
    out = answer(json.loads(req_json))
    try:
        text = json.dumps(out, ensure_ascii=False, default=str)
    except (TypeError, ValueError) as e:
        text = json.dumps({"ok": False, "error": f"the reader's answer is not JSON: {e}"})
    print(SENTINEL + text, flush=True)
