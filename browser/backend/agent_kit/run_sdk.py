"""Runs an Agent SDK program for thimble: `python run_sdk.py <program.py>` imports the program, calls its
`run(input)` with the input thimble sends (awaited when it is a coroutine function) and sends what it returns as the
output. A program without `run` exits 2; one whose `run` raises exits 1 with the traceback on stderr."""
from __future__ import annotations

import asyncio
import importlib.util
import inspect
import sys
import traceback
from pathlib import Path

import thimble


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: run_sdk.py <program.py>", file=sys.stderr)
        return 2
    thimble._setup()
    path = Path(argv[0]).resolve()
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        print(f"run_sdk.py: {path} is not a Python program", file=sys.stderr)
        return 2
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    run = getattr(module, "run", None)
    if not callable(run):
        print(f"run_sdk.py: {path.name} has no run(input)", file=sys.stderr)
        return 2
    try:
        result = run(thimble.get_input())
        if inspect.isawaitable(result):
            result = asyncio.run(thimble._wait(result))
    except Exception:  # noqa: BLE001 — the traceback is the program's error, which thimble shows
        traceback.print_exc()
        return 1
    thimble.output(result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
