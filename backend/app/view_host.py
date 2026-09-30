"""The half of a view's reader that runs on the workspace's `views` kernel (views.py sends this file's source to the
kernel and calls `call` there).

A viewer's reader.py defines build_index(paths) -> index, records(index, query) -> JSON, and resolve(index, locator) ->
{excerpt, label, refs, key?, target?} or None, and may define problems(index) -> the lines it could not read, as
[{ref, why}] or {count, examples: [{ref, why}]}, hidden(index) -> the claimed files it leaves out on purpose, as
[{path, why}], and derived(index) -> the fields it made rather than read, as [{field, from, how}]; a card type thimble
ships may also define applies(paths) -> {claims, found} or None, whether it fits a corpus (cardtypes.claims_of), which
runs with no index. `call` loads reader.py (again when it changed), builds the index or loads it from a pickle keyed by
the files' and reader's fingerprint, runs one operation and prints SENTINEL followed by the JSON answer. A reader that
raises answers {ok: false, error, traceback}. Only the last fingerprint per view stays in memory.

While build_index runs, `open` counts the bytes it reads of each claimed file (_Reads), so thimble knows which files
the view read to the end without taking the reader's word for it. The counts are kept beside the index (`reads`)."""
from __future__ import annotations

import builtins
import importlib.util
import io
import json
import os
import pickle
import sys
import time
import traceback
import types

SENTINEL = "\x1ethimble-view\x1e"
TRACEBACK_MAX = 3000

_readers: dict[str, tuple[tuple[int, int], object]] = {}  # reader.py's path -> ((mtime_ns, size), module)
_indexes: dict[tuple[str, str], object] = {}  # (slug, fingerprint) -> index
_read_counts: dict[tuple[str, str], dict[str, int]] = {}  # (slug, fingerprint) -> {claimed path: bytes build_index read}
# a page still on a view's version before a change reads its index beside the new version's
INDEXES_PER_VIEW = 2


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
    """A claimed file opened for reading, which records each byte range it reads in its _Reads."""

    _reads: "_Reads"
    _path: str

    def _note(self, start: int, n: int) -> None:
        if n:
            self._reads.add(self._path, start, start + n)

    def readinto(self, b):  # type: ignore[override]
        start = self.tell()
        n = super().readinto(b)
        self._note(start, n or 0)
        return n

    def read(self, size: int = -1):  # type: ignore[override]
        start = self.tell()
        data = super().read(size)
        self._note(start, len(data or b""))
        return data

    def readall(self):  # type: ignore[override]
        start = self.tell()
        data = super().readall()
        self._note(start, len(data or b""))
        return data


class _Reads:
    """The bytes read of each claimed file while it is active: `open` and `io.open` are replaced by one that gives a
    claimed file, opened only for reading, through _Counted. A file read by other means (os.open, a library's own C
    code) counts as unread."""

    def __init__(self, paths: list[str]) -> None:
        self.claimed: dict[str, list[str]] = {}
        for p in paths:
            self.claimed.setdefault(os.path.realpath(p), []).append(p)
        self.spans: dict[str, list[tuple[int, int]]] = {}
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
                and "r" in mode and buffering != 0:
            try:
                real = os.path.realpath(os.fsdecode(file))
            except (TypeError, ValueError):
                real = None
        if real not in self.claimed:
            return self._open(file, mode, buffering, encoding, errors, newline, closefd, opener)
        raw = _Counted(file, "r")
        raw._reads, raw._path = self, real
        buf = io.BufferedReader(raw, buffering if buffering > 1 else io.DEFAULT_BUFFER_SIZE)
        if "b" in mode:
            return buf
        text = io.TextIOWrapper(buf, encoding, errors, newline, line_buffering=buffering == 1)
        text.mode = mode  # type: ignore[misc]
        return text

    def __enter__(self) -> "_Reads":
        builtins.open = io.open = self.open  # type: ignore[assignment]
        return self

    def __exit__(self, *exc: object) -> None:
        builtins.open = io.open = self._open  # type: ignore[assignment]


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
           reads: str | None = None) -> tuple[object, bool]:
    """(the index for this fingerprint, whether it was built now): from memory, else the pickle, else build_index. With
    `reads`, the path the byte counts are kept at, a pickle without them is built again."""
    key = (slug, fp)
    if key in _indexes:
        return _indexes[key], False
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
    mine = [k for k in _indexes if k[0] == slug]
    for k in mine[: max(0, len(mine) - INDEXES_PER_VIEW + 1)]:
        del _indexes[k]
        _read_counts.pop(k, None)
    _indexes[key] = idx
    _read_counts[key] = counts or {}
    return idx, built


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


def answer(req: dict) -> dict:
    """The answer to one request {slug, reader, fp, paths, cache, reads?, op, arg, labels?}; op is index, records,
    resolve, resolve_many (a list of locators, answered with a list), problems ([] for a reader without problems()),
    shown ({reads, hidden, derived}: the bytes build_index read of each claimed file, and hidden() and derived() each as
    {result} or {error}) or applies (the corpus's record files as `arg`). A records call runs with `labels`, the labels
    context, as thimble's _view_ctx, which thimble.marked and thimble.kept read."""
    t0 = time.monotonic()
    th = None
    try:
        _thimble(req)  # before reader.py loads, since it may import thimble at its top
        mod = _reader(req["slug"], req["reader"])
        if req.get("op") == "applies":
            fn = getattr(mod, "applies", None)
            result = fn(list(req.get("arg") or [])) if callable(fn) else None
            return {"ok": True, "result": result, "built": False, "ms": round((time.monotonic() - t0) * 1000)}
        idx, built = _index(req["slug"], mod, req["fp"], req.get("paths") or [], req.get("cache"), req.get("reads"))
        op = req.get("op")
        if op == "index":
            result = None
        elif op == "records":
            th = _thimble(req)
            if th is not None:
                th._view_ctx = req.get("labels")  # type: ignore[attr-defined]
            result = mod.records(idx, req.get("arg"))  # type: ignore[attr-defined]
        elif op == "resolve":
            result = mod.resolve(idx, req.get("arg"))  # type: ignore[attr-defined]
        elif op == "problems":
            fn = getattr(mod, "problems", None)
            result = fn(idx) if callable(fn) else []
        elif op == "shown":
            result = {"reads": _read_counts.get((req["slug"], req["fp"]), {}), "hidden": _optional(mod, "hidden", idx),
                      "derived": _optional(mod, "derived", idx)}
        elif op == "resolve_many":
            result = []
            for loc in req.get("arg") or []:
                try:
                    result.append({"ok": True, "result": mod.resolve(idx, loc)})  # type: ignore[attr-defined]
                except Exception as e:  # noqa: BLE001 — one locator's failure is its own answer
                    result.append({"ok": False, "error": f"{type(e).__name__}: {e}"})
        else:
            raise ValueError(f"unknown operation {op!r}")
        return {"ok": True, "result": result, "built": built, "ms": round((time.monotonic() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001 — a reader's failure is the answer
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-TRACEBACK_MAX:],
                "ms": round((time.monotonic() - t0) * 1000)}
    finally:
        if th is not None:
            th._view_ctx = None  # type: ignore[attr-defined]


def call(req_json: str) -> None:
    """Answer the request and print it on one line after SENTINEL. A result that is not JSON is sent as its str."""
    out = answer(json.loads(req_json))
    try:
        text = json.dumps(out, ensure_ascii=False, default=str)
    except (TypeError, ValueError) as e:
        text = json.dumps({"ok": False, "error": f"the reader's answer is not JSON: {e}"})
    print(SENTINEL + text, flush=True)
