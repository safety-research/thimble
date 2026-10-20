"""Runs one call of a view's reader in the sandbox and prints its answer as JSON (views.run_reader).

Input on stdin: {"view": its folder, "paths": the claimed files, "op": "records" | "resolve" | "check", "arg": ...,
"kernel": the path of the `thimble` module card code imports}. The reader's own folder and the folder of files are
read-only here, and the working folder is the folder of files.

Output: {"ok": true, "result": ...} or {"ok": false, "error": "Type: message", "traceback": "..."}.
"""
from __future__ import annotations

import builtins
import importlib.util
import json
import math
import os
import sys
import traceback
import types
from typing import Any


def install_thimble(path: str) -> None:
    m = types.ModuleType("thimble")
    m.__file__, m.WS = path, "/tmp"
    with open(path, encoding="utf-8") as f:
        exec(compile(f.read(), path, "exec"), m.__dict__)
    sys.modules["thimble"] = m


def load_reader(folder: str) -> Any:
    spec = importlib.util.spec_from_file_location("thimble_view_reader", os.path.join(folder, "reader.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def clean(v: Any) -> Any:
    """JSON as the page takes it: NaN and Infinity become null."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {str(k): clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    return v


def main() -> int:
    req = json.loads(sys.stdin.read() or "{}")
    real_out = sys.stdout
    sys.stdout = sys.stderr  # a print in the reader never mixes with the answer
    try:
        install_thimble(req["kernel"])
        mod = load_reader(req["view"])
        paths = list(req.get("paths") or [])
        read: set[str] = set()
        if req["op"] == "check":
            real_open = builtins.open

            def counting_open(file: Any, *a: Any, **k: Any) -> Any:
                rel = os.path.relpath(os.path.abspath(str(file)), os.getcwd()) if isinstance(file, (str, os.PathLike)) else ""
                if rel in paths:
                    read.add(rel)
                return real_open(file, *a, **k)

            builtins.open = counting_open
        index = mod.build_index(paths)
        if req["op"] == "check":
            builtins.open = real_open
        op, arg = req["op"], req.get("arg")
        if op == "records":
            result = mod.records(index, arg if arg is not None else {})
        elif op == "resolve":
            result = mod.resolve(index, arg)
        else:
            data = clean(mod.records(index, {}))
            text = json.dumps(data, ensure_ascii=False)
            problems = []
            hidden = {h.get("path") for h in (mod.hidden(index) if hasattr(mod, "hidden") else []) or []}
            missed = [p for p in paths if p not in read and p not in hidden]
            if missed:
                problems.append(f"build_index did not read {len(missed)} claimed files with open(), such as "
                                f"{missed[:3]}; read them, or list them in hidden(index) with why")
            if paths:
                got = mod.resolve(index, {"path": paths[0], "fragment": "L1"})
                if got is not None and not isinstance(got, dict):
                    problems.append("resolve() must return a dict or None")
            result = {"read": len(read), "size": len(text), "sample": text[:300], "problems": problems}
        real_out.write(json.dumps({"ok": True, "result": clean(result)}, ensure_ascii=False, default=str))
    except BaseException as e:  # noqa: BLE001 — the answer says what failed
        real_out.write(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}",
                                   "traceback": traceback.format_exc()[-4000:]}))
    real_out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
