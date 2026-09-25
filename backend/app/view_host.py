"""The half of a view's reader that runs on the workspace's `views` kernel (views.py sends this file's source to the
kernel and calls `call` there).

A viewer's reader.py defines build_index(paths) -> index, records(index, query) -> JSON, and resolve(index, locator)
->
{excerpt, label, refs, key?, target?} or None. `call` loads reader.py (again when it changed), builds the index or
loads
it from a pickle keyed by the files' and reader's fingerprint, runs one operation and prints SENTINEL followed by the
JSON answer. A reader that raises answers {ok: false, error, traceback}. Only the last fingerprint per view stays in
memory."""
from __future__ import annotations

import importlib.util
import json
import os
import pickle
import sys
import time
import traceback

SENTINEL = "\x1ethimble-view\x1e"
TRACEBACK_MAX = 3000

_readers: dict[str, tuple[tuple[int, int], object]] = {}  # reader.py's path -> ((mtime_ns, size), module)
_indexes: dict[tuple[str, str], object] = {}  # (slug, fingerprint) -> index


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
    for k in [k for k in _indexes if k[0] == slug]:
        del _indexes[k]
    _indexes[key] = idx
    return idx, built


def answer(req: dict) -> dict:
    """The answer to one request {slug, reader, fp, paths, cache, op, arg}; op is index, records or resolve."""
    t0 = time.monotonic()
    try:
        mod = _reader(req["slug"], req["reader"])
        idx, built = _index(req["slug"], mod, req["fp"], req.get("paths") or [], req.get("cache"))
        op = req.get("op")
        if op == "index":
            result = None
        elif op == "records":
            result = mod.records(idx, req.get("arg"))  # type: ignore[attr-defined]
        elif op == "resolve":
            result = mod.resolve(idx, req.get("arg"))  # type: ignore[attr-defined]
        else:
            raise ValueError(f"unknown operation {op!r}")
        return {"ok": True, "result": result, "built": built, "ms": round((time.monotonic() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001 — a reader's failure is the answer
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-TRACEBACK_MAX:],
                "ms": round((time.monotonic() - t0) * 1000)}


def call(req_json: str) -> None:
    """Answer the request and print it on one line after SENTINEL. A result that is not JSON is sent as its str."""
    out = answer(json.loads(req_json))
    try:
        text = json.dumps(out, ensure_ascii=False, default=str)
    except (TypeError, ValueError) as e:
        text = json.dumps({"ok": False, "error": f"the reader's answer is not JSON: {e}"})
    print(SENTINEL + text, flush=True)
