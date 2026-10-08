"""The `claude -p` contract check of the release test (scripts/e2e_release.sh, with THIMBLE_LIVE_CLAUDE=1): the formats of
Claude Code's that thimble's hooks, mirror and module read, checked against a real `claude -p`, so a Claude Code update
that changes one fails the release instead of breaking thimble silently. A format check, not a thimble route: the agents
are test-only types passed with --agents.

    <tree>/backend/.venv/bin/python scripts/e2e/contract_print.py <tree> <out folder> --port N
        [--results results.jsonl] [--claude claude]

Two runs, each with --setting-sources user, `ultracode: false`, thimble's plugin from <tree>/plugin (its waker and its
hooks module; any other thimble copy Claude Code enables is turned off for the run), THIMBLE_LAUNCHED=1 so that only
the module's own `isInteractive` check keeps it idle, and a stand-in thimble server on port N (THIMBLE_HOME in the out
folder) that would accept the module's hello and hold its long poll, so a module that is not idle in -p would show:
  - format: main (a `[1m]` model) starts a background contract-parent, which calls a probe MCP tool, starts a background
    contract-child and hands its report back; the child ends with plain text, so Claude Code makes it hand back;
  - cap: under CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=1 main starts two agents at once, so Claude Code refuses one.
The assertions (each one line of results.jsonl, {step, title, status, detail}; see ASSERTIONS):
  - the SubagentStart, SubagentStop and PreToolUse hook fields thimble reads;
  - the two SubagentStops of an agent that ends with plain text, the `[handback-send-enforce]` record between them, and
    the SubagentHandback call that carries its report;
  - `parentAgentId` in the nested agent's meta.json;
  - the hand-back row in main's transcript and the task notification's fields (session.py TASK_FIELD_RE);
  - the MCP `_meta` tool-use id (bin/thimble-mcp TOOL_USE_META) equal to the PreToolUse hook's tool_use_id;
  - from the last result line: modelUsage[<model>].contextWindow 1,000,000 for the `[1m]` id, subagent_stats.max_depth 2,
    and refused.concurrency_limit with Claude Code's limit text, which thimble's matchers recognise;
  - the hooks module registers nothing in -p (no thimble type in the agent list, nothing sent to the stand-in server),
    the waker holds no long poll, and each run ends within END_S of its last turn's result line.
The format run is made once more (run-format-2) when its child handed back by itself, since the plain-text ending was
then not exercised. Everything goes to <out folder>: run-<name>/{argv.json, stream.jsonl, stderr.txt, hooks.jsonl,
mcp.jsonl, transcripts/}, stub-requests.jsonl and summary.json; the stand-in server's home is removed at the end. Exit 0 when every assertion passed, 1 otherwise.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
END_S = 2.0  # a run must end this soon after its last turn's result line (V3: a module's open long poll held -p 21.5 s)
RUN_TIMEOUT_S = 600.0
ATTEMPTS = 2  # format runs, when the child hands back by itself instead of ending with plain text
HOLD_S = 25.0  # the stand-in server holds a long poll as long as thimble's does
LONG_CONTEXT = 1_000_000
ENFORCE = "[handback-send-enforce]"  # Claude Code's nudge to an agent that ended with plain text (spike U18)
HANDBACK = "SubagentHandback"
PARENT, CHILD, QUICK = "contract-parent", "contract-child", "contract-quick"
PARENT_DONE, CHILD_DONE, QUICK_DONE = "PARENT-DONE", "CHILD-OK", "QUICK-OK"
# the session variables of the Claude Code session this may run in, which must not reach the runs (e2e_release.sh's)
SESSION_VARS = re.compile(r"^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|"
                          r"CLAUDE_CODE_SESSION_.*|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_CODE_BRIDGE_.*|"
                          r"CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_SUBAGENT_MODEL.*|CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS)$")

ASSERTIONS = {
    "hook-fields": "SubagentStart, SubagentStop and PreToolUse carry the fields thimble's hooks read",
    "two-stops": "An agent that ends with plain text stops twice, with the hand-back nudge and SubagentHandback between",
    "nested-meta": "A nested agent's meta.json names its parent (parentAgentId)",
    "notification": "Main gets the hand-back row and a task notification with the fields the mirror reads",
    "mcp-meta": "An MCP call's _meta carries the tool-use id the PreToolUse hook gives",
    "context-window": "The result line's modelUsage gives a [1m] model a 1,000,000-token window",
    "subagent-stats": "The result line's subagent_stats counts the nested depth and a refusal at the concurrency cap",
    "limit-text": "Claude Code's concurrency-limit text matches thimble's matchers",
    "module-idle": "thimble's hooks module registers and fetches nothing in -p, and the waker holds no long poll",
    "ends-quickly": f"Each -p run ends within {END_S:.0f} s of its last turn's result line",
}


# --------------------------------------------------------------------------------------------- what thimble reads

def formats(tree: Path) -> dict[str, Any]:
    """The matchers thimble's code applies to these formats, read from the tree so the check follows the code: the task
    notification's fields and the hand-back's lead (app/session.py), a module call's id prefix (subagent_files), the
    limit words (subagents.LIMIT_RE_WORDS), the module's limit regex (plugin/hooks/thimble.ts LIMIT) and the shim's
    `_meta` key (plugin/bin/thimble-mcp TOOL_USE_META)."""
    sys.path.insert(0, str(tree / "backend"))
    from app import session, subagent_files, subagents  # noqa: PLC0415

    ts = (tree / "plugin" / "hooks" / "thimble.ts").read_text("utf-8")
    m = re.search(r"^const LIMIT = /(.+?)/([a-z]*)", ts, re.M)
    shim = (tree / "plugin" / "bin" / "thimble-mcp").read_text("utf-8")
    key = re.search(r'^TOOL_USE_META = "([^"]+)"', shim, re.M)
    return {
        "task_fields": session.TASK_FIELD_RE,
        "handback_lead": session.HANDBACK_LEAD,
        "plugin_call": subagent_files.PLUGIN_CALL,
        "limit_words": tuple(subagents.LIMIT_RE_WORDS),
        "module_limit": re.compile(m.group(1), re.I if "i" in m.group(2) else 0) if m else None,
        "meta_key": key.group(1) if key else "claudecode/toolUseId",
    }


# --------------------------------------------------------------------------------------------- reading a run

def jsonl(path: Path) -> list[dict]:
    rows = []
    try:
        lines = path.read_text("utf-8", errors="replace").splitlines()
    except OSError:
        return rows
    for ln in lines:
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        if isinstance(r, dict):
            rows.append(r)
    return rows


def hook_inputs(rows: Iterable[dict]) -> list[dict]:
    """The hook inputs contract_hook.py logged, in order."""
    return [r["in"] for r in rows if isinstance(r.get("in"), dict) and r["in"].get("hook_event_name")]


def stream(rows: Iterable[dict]) -> list[tuple[float, dict]]:
    """(seconds since the run started, message) for each stream-json line the run printed."""
    out = []
    for r in rows:
        try:
            msg = json.loads(r.get("line") or "")
        except ValueError:
            continue
        if isinstance(msg, dict):
            out.append((float(r.get("t") or 0.0), msg))
    return out


def last_result(messages: list[tuple[float, dict]]) -> tuple[float | None, dict]:
    """The time and message of the run's last result line (-p prints one at the end of each of main's turns, then one
    with no turn as it ends; its usage and subagent_stats count the whole run)."""
    found = [(t, m) for t, m in messages if m.get("type") == "result"]
    return found[-1] if found else (None, {})


def answer_at(messages: list[tuple[float, dict]]) -> float | None:
    """When the run's last turn ended: the time of its last result line that ran a turn (num_turns ≥ 1). The closing
    result line with no turn comes only once whatever holds the run open lets go (V3's long poll held it 21.5 s), so
    the end is timed from this one."""
    found = [t for t, m in messages if m.get("type") == "result" and (m.get("num_turns") or 0) >= 1]
    return found[-1] if found else last_result(messages)[0]


def text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(text_of(b.get("text") if isinstance(b, dict) and "text" in b else
                                 b.get("content") if isinstance(b, dict) else b) for b in content)
    return ""


# --------------------------------------------------------------------------------------------- the assertions
# Each takes what a run left and returns (ok, detail).

HOOK_FIELDS = {  # event -> {field: type}; the fields thimble's hooks (bin/.thimble-watch, subagent_files) read
    "SubagentStart": {"agent_id": str, "agent_type": str, "prompt_id": str, "session_id": str, "transcript_path": str},
    "SubagentStop": {"agent_id": str, "agent_type": str, "prompt_id": str, "permission_mode": str,
                     "stop_hook_active": bool, "agent_transcript_path": str},
    "PreToolUse": {"tool_use_id": str, "tool_name": str, "tool_input": dict, "prompt_id": str, "permission_mode": str},
}
SUBAGENT_FIELDS = {"agent_id": str, "agent_type": str}  # on a PreToolUse a subagent makes, never on main's


def check_hook_fields(events: list[dict]) -> tuple[bool, str]:
    missing = []
    for event, fields in HOOK_FIELDS.items():
        rows = [e for e in events if e.get("hook_event_name") == event]
        if not rows:
            missing.append(f"no {event}")
            continue
        for name, kind in fields.items():
            if not all(isinstance(e.get(name), kind) for e in rows):
                missing.append(f"{event}.{name}")
    pre = [e for e in events if e.get("hook_event_name") == "PreToolUse"]
    by_agent = [e for e in pre if e.get("agent_id")]
    if not by_agent:
        missing.append("no PreToolUse of a subagent")
    for name, kind in SUBAGENT_FIELDS.items():
        if not all(isinstance(e.get(name), kind) for e in by_agent):
            missing.append(f"PreToolUse.{name} of a subagent")
    if any(e.get("agent_id") for e in pre if e.get("tool_name") == "Agent" and (e.get("tool_input") or {}).get(
            "subagent_type") == PARENT):
        missing.append("main's PreToolUse carries an agent_id")
    stops = [e for e in events if e.get("hook_event_name") == "SubagentStop"]
    if not any(isinstance(e.get("last_assistant_message"), str) for e in stops):
        missing.append("SubagentStop.last_assistant_message on no stop")
    counts = {ev: sum(e.get("hook_event_name") == ev for e in events) for ev in HOOK_FIELDS}
    return not missing, ("missing or mistyped: " + ", ".join(missing)) if missing else (
        "fields present: " + "; ".join(f"{ev} x{n}" for ev, n in counts.items()))


def check_two_stops(events: list[dict], agent_rows: dict[str, list[dict]], agent: str) -> tuple[bool, str]:
    """`agent` (the child, which ends with plain text): SubagentStop with stop_hook_active false and its text as
    last_assistant_message, the enforce record and a SubagentHandback call in its transcript, then a second
    SubagentStop with stop_hook_active true and no last_assistant_message (spike U18)."""
    if not agent:
        return False, f"no {CHILD} agent started"
    seq = [e for e in events if e.get("agent_id") == agent and e.get("hook_event_name") in ("SubagentStop", "PreToolUse")
           and (e.get("hook_event_name") == "SubagentStop" or e.get("tool_name") == HANDBACK)]
    shape = [("stop*" if e.get("stop_hook_active") else "stop") if e["hook_event_name"] == "SubagentStop" else "handback"
             for e in seq]
    stops = [e for e in seq if e["hook_event_name"] == "SubagentStop"]
    rows = agent_rows.get(agent) or []
    enforce = any(r.get("type") == "user" and ENFORCE in text_of((r.get("message") or {}).get("content")) for r in rows)
    calls = [b for r in rows if r.get("type") == "assistant" for b in ((r.get("message") or {}).get("content") or [])
             if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == HANDBACK]
    report = str((calls[-1].get("input") or {}).get("message") or "") if calls else ""
    if not stops:
        return False, f"{agent}: no SubagentStop"
    first, second = stops[0], stops[1] if len(stops) > 1 else {}
    ok = (shape[:3] == ["stop", "handback", "stop*"] and isinstance(first.get("last_assistant_message"), str)
          and not second.get("last_assistant_message") and enforce and CHILD_DONE in report)
    return ok, (f"{agent}: {' → '.join(shape)}; enforce record {'yes' if enforce else 'no'}; SubagentHandback message "
                f"{report[:60]!r}; first stop's last_assistant_message {str(first.get('last_assistant_message'))[:40]!r}")


def plain_ending(events: list[dict]) -> bool:
    """Whether the child ended a turn with plain text: a SubagentStop of it with stop_hook_active false before any
    SubagentHandback call of its own (the shape check_two_stops reads)."""
    for e in events:
        if e.get("agent_type") != CHILD:
            continue
        if e.get("hook_event_name") == "PreToolUse" and e.get("tool_name") == HANDBACK:
            return False
        if e.get("hook_event_name") == "SubagentStop":
            return not e.get("stop_hook_active")
    return False


def check_nested_meta(metas: dict[str, dict], parent: str, child: str) -> tuple[bool, str]:
    meta = metas.get(child) or {}
    ok = bool(parent) and bool(child) and meta.get("parentAgentId") == parent
    return ok, (f"meta.json of {child or '(no child)'}: parentAgentId {meta.get('parentAgentId')!r}, parent {parent!r}, "
                f"agentType {meta.get('agentType')!r}, spawnDepth {meta.get('spawnDepth')!r}")


def deliveries(main_rows: list[dict]) -> list[tuple[dict, str, dict]]:
    """What reached main from its agents, as the mirror reads it (session.py): (origin, text, record) of each user row
    with an origin, and of each queued_command attachment, the shape a hand-back or notification takes when it comes
    while main's turn goes on."""
    out = []
    for r in main_rows:
        if r.get("type") == "user" and isinstance(r.get("origin"), dict):
            out.append((r["origin"], text_of((r.get("message") or {}).get("content")), r))
        att = r.get("attachment") if r.get("type") == "attachment" else None
        if isinstance(att, dict) and att.get("type") == "queued_command":
            origin = dict(att.get("origin") or {}) if isinstance(att.get("origin"), dict) else {}
            if att.get("commandMode") == "task-notification":
                origin.setdefault("kind", "task-notification")
            out.append((origin, str(att.get("prompt") or ""), r))
    return out


def check_notification(main_rows: list[dict], parent: str, parent_call: str, fmt: dict) -> tuple[bool, str]:
    """The parent's hand-back, with origin kind `peer` and the hand-back lead, and its task notifications with task-id,
    status, summary and result as TASK_FIELD_RE reads them, each as a user row or, mid-turn, a queued_command
    attachment; the first run's names the start call's tool-use-id (a later run's has none, spike U10)."""
    got = deliveries(main_rows)
    handbacks = [(o, t, r) for o, t, r in got if o.get("kind") == "peer" and o.get("from") == parent]
    lead = bool(handbacks) and all(fmt["handback_lead"] in t for _, t, _ in handbacks)
    notes = [dict(fmt["task_fields"].findall(t)) for o, t, _ in got if o.get("kind") == "task-notification"]
    notes = [n for n in notes if n.get("task-id", "").strip() == parent]
    wrong = [f"#{i + 1} {k}" for i, n in enumerate(notes) for k in ("status", "summary", "result") if not n.get(k, "").strip()]
    wrong += [f"#{i + 1} status {n.get('status')!r}" for i, n in enumerate(notes) if n.get("status", "").strip() != "completed"]
    if notes and notes[0].get("tool-use-id", "").strip() != parent_call:
        wrong.append(f"#1 tool-use-id {notes[0].get('tool-use-id')!r}, not the start's {parent_call!r}")
    shapes = sorted({r.get("type", "") + ("/" + str((r.get("attachment") or {}).get("type")) if r.get("type") == "attachment" else "")
                     for o, _, r in got if o.get("from") == parent or o.get("kind") == "task-notification"})
    ok = bool(parent) and bool(handbacks) and lead and bool(notes) and not wrong
    return ok, (f"hand-backs from {parent or '(no parent)'}: {len(handbacks)} (lead {'in each' if lead else 'missing'}); "
                f"its task notifications: {len(notes)}, fields {[sorted(n) for n in notes]}; as {shapes}"
                + (f"; wrong or missing: {wrong}" if wrong else ""))


def check_mcp_meta(mcp_rows: list[dict], events: list[dict], fmt: dict) -> tuple[bool, str]:
    calls = [e for e in events if e.get("hook_event_name") == "PreToolUse" and str(e.get("tool_name") or "").startswith(
        "mcp__contract__")]
    ids = [((r.get("params") or {}).get("_meta") or {}).get(fmt["meta_key"]) for r in mcp_rows]
    hook_ids = [e.get("tool_use_id") for e in calls]
    ok = bool(ids) and all(isinstance(i, str) and i for i in ids) and set(ids) <= set(hook_ids)
    return ok, f"_meta[{fmt['meta_key']!r}] {ids}; PreToolUse tool_use_id {hook_ids}"


def check_context_window(result: dict, model: str) -> tuple[bool, str]:
    usage = (result.get("modelUsage") or {}).get(model) or {}
    window = usage.get("contextWindow")
    return window == LONG_CONTEXT, f"modelUsage[{model!r}].contextWindow = {window!r} (of {sorted(result.get('modelUsage') or {})})"


def check_subagent_stats(format_result: dict, cap_result: dict) -> tuple[bool, str]:
    fs, cs = format_result.get("subagent_stats") or {}, cap_result.get("subagent_stats") or {}
    depth = fs.get("max_depth")
    refused = (cs.get("refused") or {}).get("concurrency_limit")
    ok = depth == 2 and isinstance(refused, int) and refused >= 1
    return ok, f"format run: max_depth {depth!r}, spawned {fs.get('spawned')!r}; cap run: refused.concurrency_limit {refused!r}"


def limit_texts(messages: list[tuple[float, dict]]) -> list[str]:
    """The texts of the Agent calls Claude Code refused at its concurrency cap (an error tool result)."""
    out = []
    for _, m in messages:
        if m.get("type") != "user":
            continue
        for b in (m.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                t = text_of(b.get("content"))
                if "concurrent" in t.lower():
                    out.append(t)
    return out


def check_limit_text(texts: list[str], fmt: dict) -> tuple[bool, str]:
    if not texts:
        return False, "no Agent call was refused at the cap"
    t = texts[0]
    words = all(w in t.lower() for w in fmt["limit_words"])
    module = bool(fmt["module_limit"] and fmt["module_limit"].search(t))
    return words and module, (f"{t[:160]!r}; subagents.LIMIT_RE_WORDS {'match' if words else 'do not match'}, "
                              f"thimble.ts LIMIT {'matches' if module else 'does not match'}")


def check_module_idle(inits: list[dict], requests: list[dict]) -> tuple[bool, str]:
    types = sorted({a for m in inits for a in (m.get("agents") or []) if isinstance(a, str) and a.startswith("thimble:")})
    module = [r["path"] for r in requests if str(r.get("path") or "").startswith("/api/module/")]
    pulls = [r["path"] for r in requests if str(r.get("path") or "").startswith("/api/events/pull")]
    plugin = sorted({str(p.get("name") or p) if isinstance(p, dict) else str(p) for m in inits for p in (m.get("plugins") or [])})
    ok = not types and not module and not pulls and any("thimble" in p for p in plugin)
    return ok, (f"plugins {plugin}; thimble types in the agent list {types or 'none'}; module requests to the stand-in "
                f"server {module or 'none'}; waker long polls {pulls or 'none'}")


def check_ends(runs: dict[str, dict]) -> tuple[bool, str]:
    parts, ok = [], True
    for name, r in runs.items():
        t_res, t_end = r.get("t_result"), r.get("t_exit")
        gap = None if t_res is None or t_end is None else t_end - t_res
        ok = ok and gap is not None and gap <= END_S and r.get("returncode") == 0
        parts.append(f"{name}: exit {r.get('returncode')}, {('%.2f s' % gap) if gap is not None else 'no result line'} "
                     f"after its last turn's result line, {r.get('t_exit', 0):.1f} s in all")
    return ok, "; ".join(parts)


# --------------------------------------------------------------------------------------------- the stand-in server

def proof(token: str, nonce: str, side: str) -> str:
    return hmac.new(token.encode(), f"{side}:{nonce}".encode(), hashlib.sha256).hexdigest()


class Stub:
    """A stand-in thimble server for the module and the waker: it proves the token as thimble's does (hook_auth), would
    accept the module's hello and hand it one role, holds its long poll and the waker's for HOLD_S, and logs every
    request. Neither should reach it in -p."""

    def __init__(self, home: Path, port: int, log: Path) -> None:
        self.token, self.log, self.requests = secrets.token_hex(32), log, []
        home.mkdir(parents=True, exist_ok=True)
        home.chmod(0o700)
        (home / "server.json").write_text(json.dumps({"port": port, "api": f"http://127.0.0.1:{port}",
                                                      "url": f"http://127.0.0.1:{port}", "token": self.token}))
        (home / "server.json").chmod(0o600)
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def answer(self, status: int, body: Any = None) -> None:
                nonce = self.headers.get("x-thimble-nonce") or ""
                data = b"" if body is None else json.dumps(body).encode()
                try:
                    self.send_response(status)
                    if nonce and hmac.compare_digest(self.headers.get("x-thimble-auth") or "",
                                                     proof(stub.token, nonce, "hook")):
                        self.send_header("x-thimble-proof", proof(stub.token, nonce, "server"))
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the run ended while a long poll was held

            def route(self) -> None:
                path = self.path.split("?", 1)[0]
                stub.note(self.command, self.path)
                if path == "/api/health":
                    return self.answer(200, {"ok": True})
                if path == "/api/module/hello":
                    return self.answer(200, {"ok": True})
                if path == "/api/module/roles":
                    return self.answer(200, {"roles": {"contract-probe": {
                        "description": "A type the stand-in server hands thimble's module; it must never register.",
                        "prompt": "Reply OK.", "model": "claude-haiku-4-5-20251001"}}})
                if path == "/api/module/state":
                    return self.answer(200, {})
                if path in ("/api/module/next", "/api/events/pull"):
                    time.sleep(HOLD_S)
                    return self.answer(204)
                return self.answer(404, {"detail": "not here"})

            do_GET = do_POST = route

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def note(self, method: str, path: str) -> None:
        row = {"t": time.time(), "method": method, "path": path}
        self.requests.append(row)
        with self.log.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


# --------------------------------------------------------------------------------------------- the runs

def other_thimbles(claude: str, tree: Path, env: dict[str, str]) -> list[str]:
    """The thimble plugins Claude Code enables other than this tree's (`claude plugin list --json`): the runs turn them
    off, so only <tree>/plugin runs. Read only."""
    try:
        r = subprocess.run([claude, "plugin", "list", "--json"], capture_output=True, text=True, timeout=60,
                           stdin=subprocess.DEVNULL, env=env, check=False)
        listed = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    out = []
    for p in listed if isinstance(listed, list) else []:
        pid, path = str((p or {}).get("id") or ""), str((p or {}).get("installPath") or "")
        if pid.startswith("thimble@") and p.get("enabled") and not path.startswith(str(tree)):
            out.append(pid)
    return out


def run_env(base: dict[str, str], home: Path, port: int, extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {k: v for k, v in base.items() if not k.startswith("THIMBLE_") and not SESSION_VARS.match(k)}
    env.update({"THIMBLE_HOME": str(home), "THIMBLE_PORT": str(port), "THIMBLE_UI_PORT": str(port + 1),
                "THIMBLE_LAUNCHED": "1", "DISABLE_AUTOUPDATER": "1", **(extra or {})})
    return env


def settings(hook_cmd: str, disable: list[str]) -> str:
    hooks = {event: [{"matcher": "*", "hooks": [{"type": "command", "command": hook_cmd, "timeout": 10}]}]
             for event in ("PreToolUse", "SubagentStart", "SubagentStop")}
    return json.dumps({"ultracode": False, "enabledPlugins": {p: False for p in disable}, "hooks": hooks})


def agents_json(agent_model: str) -> str:
    plain = "Test agent of a format check. Follow the task's steps exactly, in order, and do nothing else."
    return json.dumps({
        PARENT: {"description": f"The contract check's parent agent. Use only when asked for {PARENT}.",
                 "prompt": plain, "model": agent_model, "effort": "low", "background": True},
        CHILD: {"description": f"The contract check's child agent. Use only when asked for {CHILD}.",
                "prompt": (f"Test agent of a format check, which looks at what Claude Code does when an agent ends "
                           f"with plain text. Your whole reply is the plain text {CHILD_DONE}: write it as text and end "
                           f"your turn, with no tool call, not even SubagentHandback. Only if you are then asked to "
                           f"deliver your report, call SubagentHandback with {CHILD_DONE}."),
                "model": agent_model, "effort": "low", "tools": [], "background": True},
        QUICK: {"description": f"The contract check's quick agent. Use only when asked for {QUICK}.",
                "prompt": plain, "model": agent_model, "effort": "low", "tools": [], "background": True},
    })


PARENT_TASK = (f"1. Call the MCP tool mcp__contract__probe with text \"parent\". 2. Call the Agent tool once with "
               f"subagent_type \"{CHILD}\", description \"contract child\" and prompt \"Write the plain text {CHILD_DONE} "
               f"as your reply and end your turn. Do not call any tool for it.\". 3. The child's report "
               f"arrives as a message: end your turn now, with no tool call, and the report will start your next turn. 4. Then "
               f"hand back the report \"{PARENT_DONE} <the child's report>\".")
FORMAT_PROMPT = (f"This is an automated format check. Call the Agent tool once, with subagent_type \"{PARENT}\", "
                 f"description \"contract parent\" and exactly this prompt: {json.dumps(PARENT_TASK)}. Then wait for its "
                 f"report and reply with that report only.")
CAP_PROMPT = (f"This is an automated format check. In one message, make two Agent calls at once, both with subagent_type "
              f"\"{QUICK}\": the first with description \"quick one\", the second with description \"quick two\", each "
              f"with the prompt \"Reply with the plain text {QUICK_DONE}.\". Do not retry a call that fails. Then reply "
              f"DONE.")


def run_args(folder: Path, model: str, prompt: str, tree: Path, disable: list[str], agent_model: str) -> list[str]:
    """The arguments of one run, its probe MCP server's and its hook's logs in `folder`."""
    folder.mkdir(parents=True, exist_ok=True)
    mcp = {"mcpServers": {"contract": {"type": "stdio", "command": sys.executable,
                                       "args": ["-I", str(HERE / "contract_mcp.py"), str(folder / "mcp.jsonl")]}}}
    (folder / "mcp.json").write_text(json.dumps(mcp))
    hook = f"{sys.executable} -I {HERE / 'contract_hook.py'} {folder / 'hooks.jsonl'}"
    return ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--permission-mode", "auto",
            "--setting-sources", "user", "--settings", settings(hook, disable), "--plugin-dir", str(tree / "plugin"),
            "--mcp-config", str(folder / "mcp.json"), "--allowedTools", "mcp__contract__probe",
            "--agents", agents_json(agent_model), prompt]


def run(claude: str, args: list[str], env: dict[str, str], cwd: Path, folder: Path) -> dict[str, Any]:
    """One `claude -p` run with stream-json output, each line logged with its time; the time of its last turn's result
    line and of its exit."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "argv.json").write_text(json.dumps([claude, *args], indent=1))
    t0 = time.monotonic()
    with (folder / "stream.jsonl").open("w", encoding="utf-8") as out, (folder / "stderr.txt").open("w") as err:
        p = subprocess.Popen([claude, *args], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=err, text=True,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        timer = threading.Timer(RUN_TIMEOUT_S, p.kill)
        timer.start()
        try:
            for line in p.stdout:  # type: ignore[union-attr]
                out.write(json.dumps({"t": round(time.monotonic() - t0, 3), "line": line.rstrip("\n")}) + "\n")
                out.flush()
            p.wait()
        finally:
            timer.cancel()
    t_exit = time.monotonic() - t0
    messages = stream(jsonl(folder / "stream.jsonl"))
    result = last_result(messages)[1]
    return {"returncode": p.returncode, "t_exit": round(t_exit, 3), "t_result": answer_at(messages), "result": result,
            "messages": messages}


def copy_transcripts(events: list[dict], folder: Path) -> tuple[list[dict], dict[str, list[dict]], dict[str, dict]]:
    """Main's transcript, each agent's and each agent's meta.json, read from the paths the hooks gave, and copied into
    `folder` as evidence."""
    folder.mkdir(parents=True, exist_ok=True)
    main_path = next((Path(e["transcript_path"]) for e in events if e.get("transcript_path")), None)
    main_rows = jsonl(main_path) if main_path else []
    if main_path and main_path.is_file():
        shutil.copy2(main_path, folder / "main.jsonl")
    rows, metas = {}, {}
    sub = main_path.with_suffix("") / "subagents" if main_path else None
    if sub and sub.is_dir():
        for p in sub.glob("agent-*.jsonl"):
            aid = p.stem.removeprefix("agent-")
            rows[aid] = jsonl(p)
            shutil.copy2(p, folder / p.name)
            meta = p.with_suffix(".meta.json")
            if meta.is_file():
                shutil.copy2(meta, folder / meta.name)
                try:
                    metas[aid] = json.loads(meta.read_text("utf-8"))
                except ValueError:
                    metas[aid] = {}
    return main_rows, rows, metas


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tree")
    ap.add_argument("out")
    ap.add_argument("--port", type=int, required=True, help="the stand-in server's port")
    ap.add_argument("--results", help="results.jsonl of e2e_release.sh, to append each assertion to")
    ap.add_argument("--claude", default=os.environ.get("THIMBLE_E2E_CLAUDE") or "claude")
    a = ap.parse_args(argv)
    tree, out = Path(a.tree).resolve(), Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    claude = shutil.which(a.claude) or a.claude
    fmt = formats(tree)
    from app import config  # noqa: PLC0415 — formats() put the tree's backend on sys.path

    main_model = config.long_context(config.exact_model("sonnet"))
    agent_model = config.exact_model("sonnet")
    home, cwd = out / "thimble-home", out / "cwd"
    cwd.mkdir(exist_ok=True)
    stub = Stub(home, a.port, out / "stub-requests.jsonl")
    base = run_env(dict(os.environ), home, a.port)
    disable = other_thimbles(claude, tree, base)
    runs: dict[str, dict] = {}
    try:
        for name, prompt, model, extra in (("format", FORMAT_PROMPT, main_model, {}),
                                           ("cap", CAP_PROMPT, agent_model, {"CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "1"})):
            for attempt in range(1, (ATTEMPTS if name == "format" else 1) + 1):
                folder = out / (f"run-{name}" if attempt == 1 else f"run-{name}-{attempt}")
                r = run(claude, run_args(folder, model, prompt, tree, disable, agent_model),
                        run_env(dict(os.environ), home, a.port, extra), cwd, folder)
                r["events"] = hook_inputs(jsonl(folder / "hooks.jsonl"))
                r["main"], r["agents"], r["metas"] = copy_transcripts(r["events"], folder / "transcripts")
                r["folder"], r["attempt"] = folder, attempt
                # a child that handed back by itself did not exercise the plain-text ending: the run is made again
                if name != "format" or plain_ending(r["events"]):
                    break
            runs[name] = r
    finally:
        stub.close()
        shutil.rmtree(home, ignore_errors=True)  # the stand-in server's home: its server.json and token

    fr, cr = runs["format"], runs["cap"]
    starts = [e for e in fr["events"] if e.get("hook_event_name") == "SubagentStart"]
    parent = next((e["agent_id"] for e in starts if e.get("agent_type") == PARENT), "")
    child = next((e["agent_id"] for e in starts if e.get("agent_type") == CHILD), "")
    parent_call = next((e.get("tool_use_id") for e in fr["events"] if e.get("hook_event_name") == "PreToolUse"
                        and e.get("tool_name") == "Agent" and (e.get("tool_input") or {}).get("subagent_type") == PARENT
                        and not e.get("agent_id")), "")
    inits = [m for r in runs.values() for _, m in r["messages"] if m.get("type") == "system" and m.get("subtype") == "init"]
    checks = {
        "hook-fields": check_hook_fields(fr["events"]),
        "two-stops": check_two_stops(fr["events"], fr["agents"], child),
        "nested-meta": check_nested_meta(fr["metas"], parent, child),
        "notification": check_notification(fr["main"], parent, str(parent_call or ""), fmt),
        "mcp-meta": check_mcp_meta(jsonl(fr["folder"] / "mcp.jsonl"), fr["events"], fmt),
        "context-window": check_context_window(fr["result"], main_model),
        "subagent-stats": check_subagent_stats(fr["result"], cr["result"]),
        "limit-text": check_limit_text(limit_texts(cr["messages"]), fmt),
        "module-idle": check_module_idle(inits, stub.requests),
        "ends-quickly": check_ends({k: {kk: v for kk, v in r.items() if kk in ("returncode", "t_exit", "t_result")}
                                    for k, r in runs.items()}),
    }
    rows = []
    for name, (ok, detail) in checks.items():
        row = {"step": f"contract-print-{name}", "title": f"claude -p contract: {ASSERTIONS[name]}",
               "status": "pass" if ok else "fail", "detail": detail, "shots": []}
        rows.append(row)
        print(f"contract-print {name}: {row['status']} ({detail})", flush=True)
    summary = {"claude": subprocess.run([claude, "--version"], capture_output=True, text=True, check=False).stdout.strip(),
               "main_model": main_model, "agent_model": agent_model, "disabled_plugins": disable,
               "parent": parent, "child": child,
               "runs": {k: {kk: str(v) for kk, v in r.items() if kk in ("returncode", "t_exit", "t_result", "folder", "attempt")}
                        for k, r in runs.items()},
               "assertions": rows}
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    if a.results:
        with open(a.results, "a", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
    return 0 if all(r["status"] == "pass" for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
