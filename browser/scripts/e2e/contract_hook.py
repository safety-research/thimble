"""A command hook for the contract checks (scripts/e2e/contract_print.py): appends the hook's input, as Claude Code gave
it on stdin, to a JSON Lines file with the time it came, and prints nothing, so it decides nothing.

    python3 -I scripts/e2e/contract_hook.py <log.jsonl>
"""
import json
import sys
import time

raw = sys.stdin.read()
try:
    data = json.loads(raw)
except ValueError:
    data = {"raw": raw}
with open(sys.argv[1], "a", encoding="utf-8") as f:
    f.write(json.dumps({"t": time.time(), "in": data}) + "\n")
