"""A stand-in `claude` for the Agent SDK's stream-json protocol: it answers the SDK's initialize request, replies to
each user message with FAKE_CLAUDE_REPLY as its result, and writes its argv, folder and THIMBLE_SESSION to
FAKE_CLAUDE_LOG (one JSON line per start), and each line it reads on stdin to FAKE_CLAUDE_STDIN when that is set. With
-p and --output-format json it reads the prompt on stdin and prints one result object."""
import json
import os
import sys

argv = sys.argv[1:]
with open(os.environ["FAKE_CLAUDE_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "session": os.environ.get("THIMBLE_SESSION")}) + "\n")
reply = os.environ.get("FAKE_CLAUDE_REPLY", "The corpus holds three runs.")


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def result(text):
    return {"type": "result", "subtype": "success", "is_error": False, "result": text, "session_id": "fake",
            "duration_ms": 1, "duration_api_ms": 1, "num_turns": 1, "total_cost_usd": 0, "usage": {}}


if "-p" in argv and "--output-format" in argv and argv[argv.index("--output-format") + 1] == "json":
    prompt = sys.stdin.read()
    out(result(f"{reply} ({len(prompt)} characters asked)"))
    sys.exit(0)

for line in sys.stdin:
    if os.environ.get("FAKE_CLAUDE_STDIN"):
        with open(os.environ["FAKE_CLAUDE_STDIN"], "a", encoding="utf-8") as f:
            f.write(line if line.endswith("\n") else line + "\n")
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if msg.get("type") == "control_request":
        out({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"],
                                                      "response": {"commands": []}}})
    elif msg.get("type") == "user":
        out({"type": "assistant", "message": {"role": "assistant", "model": "fake", "content": [
            {"type": "text", "text": reply}]}, "parent_tool_use_id": None, "session_id": "fake"})
        out(result(reply))
sys.exit(0)
