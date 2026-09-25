"""The SubagentStart hook of a fenced session (agent_session.scratch_hooks): it gives each subagent its own scratch
folder in the session's work folder, `tmp_<agent id>/`, and tells the subagent where it is.

Claude Code's sandbox points every Bash command of a session and its agents at one $TMPDIR, so parallel subagents
overwrite one another's scripts. A SubagentStart hook's `additionalContext` reaches the subagent before its first
prompt. The `tmp_*` folders are deleted when an orientation run ends (orient_session._clear_temp).

Usage: `python -S scratch_hook.py --work <work folder> --text <line>`, where `{folder}` in the line is replaced by
the
folder. Standard library only; anything unexpected prints nothing."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PREFIX = "tmp_"  # orient_session.TEMP_GLOB


def main(argv: list[str]) -> int:
    def arg(name: str) -> str:
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else ""

    work, text = arg("--work"), arg("--text")
    try:
        hook = json.load(sys.stdin)
    except (OSError, ValueError):
        return 0
    agent = re.sub(r"[^A-Za-z0-9_-]", "", str(hook.get("agent_id") or "") if isinstance(hook, dict) else "")[:64]
    if not work or not text or not agent:
        return 0
    folder = Path(work) / f"{PREFIX}{agent}"
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError:
        return 0
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SubagentStart",
                                             "additionalContext": text.replace("{folder}", str(folder))}}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
