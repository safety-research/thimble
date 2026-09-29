"""The half of a view's reader that runs on the workspace's `views` kernel (views.py sends this file's source to the
kernel and calls `call` there).

A viewer's reader.py defines build_index(paths) -> index, records(index, query) -> JSON, and resolve(index, locator)
->
{excerpt, label, refs, key?, target?} or None, and may define problems(index) -> the lines it could not read, as
[{ref, why}] or {count, examples: [{ref, why}]}; a viewer thimble ships may also define applies(paths) -> {claims,
found} or None, whether it fits a corpus (views.propose_builtins), which runs with no index. `call` loads reader.py
(again when it changed), builds the index or loads it from a pickle keyed by the files' and reader's fingerprint, runs
one operation and prints SENTINEL followed by the JSON answer. A reader that raises answers {ok: false, error,
traceback}. Only the last fingerprint per view stays in memory."""
from __future__ import annotations

import importlib.util
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


def _index(slug: str, mod: object, fp: str, paths: list[str], cache: str | None) -> tuple[object, bool]:
    """(the index for this fingerprint, whether it was built now): from memory, else the pickle, else build_index."""
    key = (slug, fp)
    if key in _indexes:
        return _indexes[key], False
    idx = None
    built = False
    if cache and os.path.isfile(cache):
        try:
            with open(cache, "rb") as f:
                idx = pickle.load(f)
        except Exception:  # noqa: BLE001 — a broken cache is rebuilt
            idx = None
    if idx is None:
        idx = mod.build_index(list(paths))  # type: ignore[attr-defined]
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
    mine = [k for k in _indexes if k[0] == slug]
    for k in mine[: max(0, len(mine) - INDEXES_PER_VIEW + 1)]:
        del _indexes[k]
    _indexes[key] = idx
    return idx, built


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
    """The answer to one request {slug, reader, fp, paths, cache, op, arg, labels?}; op is index, records, resolve,
    resolve_many (a list of locators, answered with a list), problems ([] for a reader without problems()) or applies
    (the corpus's record files as `arg`). A records call runs with `labels`, the labels context,
    as thimble's _view_ctx, which thimble.marked and thimble.kept read."""
    t0 = time.monotonic()
    th = None
    try:
        _thimble(req)  # before reader.py loads, since it may import thimble at its top
        mod = _reader(req["slug"], req["reader"])
        if req.get("op") == "applies":
            fn = getattr(mod, "applies", None)
            result = fn(list(req.get("arg") or [])) if callable(fn) else None
            return {"ok": True, "result": result, "built": False, "ms": round((time.monotonic() - t0) * 1000)}
        idx, built = _index(req["slug"], mod, req["fp"], req.get("paths") or [], req.get("cache"))
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
