"""The marks' check after the checker fork answered, as the plugin's hooks run it (marks/checker.ts): JSON on stdin,
JSON on stdout. No model call, and no code run: kernel/evidence.py reads the files and the calls' real outputs.

    stdin   {"cwd": the working folder, "root": the folder the session started in, which the paths shown start from,
             "marks": [{"n", "words", "sentence"}], "answer": the checker's last message,
             "calls": [{"command", "output", "by": "checker" | "main"}]}
    stdout  {"parsed": bool, "results": [{"n", "status", "shown", "reason", "was"?, "failedBy"?, "evidence"?, "note"?}]}
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kernel.evidence import check_all  # noqa: E402


def main() -> int:
    req = json.load(sys.stdin)
    out = check_all(req.get("marks") or [], str(req.get("answer") or ""), req.get("calls") or [], str(req.get("cwd") or "."), req.get("root") or None)
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
