"""A one-tool MCP server for the `claude -p` contract check (scripts/e2e/contract_print.py): it logs the params of each
`tools/call`, `_meta` included, so the check can see the id Claude Code gives a call there (`claudecode/toolUseId`,
which thimble joins its callers.jsonl on), and answers PROBE-OK. Standard library only; newline-delimited JSON-RPC on
stdio, as Claude Code speaks to a stdio server.

    python3 -I scripts/e2e/contract_mcp.py <log.jsonl>
"""
import json
import sys
import time

TOOL = "probe"
ANSWER = "PROBE-OK"


def reply(rid, result=None, error=None) -> None:
    msg = {"jsonrpc": "2.0", "id": rid}
    msg.update({"error": error} if error is not None else {"result": result})
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main() -> None:
    log = sys.argv[1]
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        method, rid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
        if method == "initialize":
            reply(rid, {"protocolVersion": params.get("protocolVersion") or "2025-06-18",
                        "capabilities": {"tools": {}}, "serverInfo": {"name": "contract", "version": "1"}})
        elif method == "tools/list":
            reply(rid, {"tools": [{"name": TOOL, "description": "The contract check's probe: call it when told to.",
                                   "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]})
        elif method == "tools/call":
            with open(log, "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": time.time(), "params": params}) + "\n")
            reply(rid, {"content": [{"type": "text", "text": ANSWER}]})
        elif rid is not None:
            if method == "ping":
                reply(rid, {})
            else:
                reply(rid, error={"code": -32601, "message": f"no method {method}"})


if __name__ == "__main__":
    main()
