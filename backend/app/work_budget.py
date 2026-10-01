"""The PostToolUse hook of a fenced session's Bash (agent_session.scratch_hooks): it tells the agent when the session's
work folder grows past a size budget, so that the session deletes the extracts it no longer needs while it works rather
than leaving them all to the end of its run (work_files).

The folder is measured at most every CHECK_S, and its size and the last budget step warned of are kept in STATE_FILE in
the folder, so a warning comes once each time the folder grows past another whole budget, and again after it shrank
and grew back.

Usage: `python -S work_budget.py --work <work folder> --budget <bytes> --text <line>`, where `{size}`, `{budget}` and
`{folder}` in the line are replaced. Standard library only; anything unexpected prints nothing."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

CHECK_S = 30.0
STATE_FILE = ".thimble-budget.json"
WALK_MAX = 500_000  # the entries of the folder counted at most, so that a measure stays short


def size_of(work: Path) -> int:
    """The bytes of the files under `work`, links counted as links and never followed."""
    total = n = 0
    for root, dirs, files in os.walk(work):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
        n += len(files) + len(dirs)
        if n > WALK_MAX:
            break
    return total


def _size(n: int) -> str:
    return f"{n / 1e9:.1f} GB" if n >= 1e9 else f"{n / 1e6:.0f} MB"


def main(argv: list[str]) -> int:
    def arg(name: str) -> str:
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else ""

    work, text = arg("--work"), arg("--text")
    try:
        json.load(sys.stdin)
        budget = int(arg("--budget"))
    except (OSError, ValueError):
        return 0
    folder = Path(work)
    if not work or not text or budget <= 0 or not folder.is_dir():
        return 0
    state_file = folder / STATE_FILE
    try:
        state = json.loads(state_file.read_text("utf-8"))
        checked, warned = float(state["checked"]), int(state["warned"])
    except (OSError, ValueError, TypeError, KeyError):
        checked, warned = 0.0, 0
    now = time.time()
    if now - checked < CHECK_S:
        return 0
    size = size_of(folder)
    step = size // budget
    say = step > warned
    try:
        tmp = state_file.with_name(f"{STATE_FILE}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"checked": now, "size": size, "warned": step if say else min(warned, step)}), "utf-8")
        os.replace(tmp, state_file)
    except OSError:
        return 0
    if say:
        line = text.replace("{size}", _size(size)).replace("{budget}", _size(budget)).replace("{folder}", str(folder))
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": line}}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
