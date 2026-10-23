#!/usr/bin/env python3
"""Write `mini`, the small synthetic corpus the test suite reads.

Every record is invented here: three coding agents work the pull-request backlog of a made-up library ("quillmark")
through a shared "forge" server for about three quarters of an hour. The GitHub handles are user-a .. user-f. Nothing
is random, so the output is the same on every run, and nothing ships as a data file: conftest.py writes the corpus into
a temporary folder when the suite starts.

The layout is that of a real corpus, and the tests cite these facts:

  agents/agent-01.jsonl, agent-02.jsonl, agent-03.jsonl
      20 records each. agent-01: L1-L3 tool_progress, L4 a task notification, L5 and L12 tool results, L9 a thinking
      block with no text (as a transcript records redacted thinking), L10 text ("The build compiles now, ..."), L11 a
      Bash tool_use, the rest thinking-token counts. agent-02 has the same shape shifted by three lines (text at L13).
      agent-03 ends with an API error message (L19) and a result record with its model usage (L20).
  board.jsonl
      8 posts in 3 threads; L1 is post 1 by agent-01 at 2026-03-12T09:04:27. Planted phrases: "forge pr claim" in 3
      posts (L1, L6, L8), "REVIEW WANTED" in 2 (L1, L7), "review someone else's pending request in return" (L1),
      "please use thread 1" (L3, which a test quotes as "PLEASE use   thread 1" to check a loose match), and
      "Protocol proposal for the 40-PR backlog" (L5).
  events.jsonl
      20 forge events; L2 is event 2 at 2026-03-12T09:00:02, L14 and L16 open the first two threads, L18 is
      agent-01's `pr.claim` of #7160 (params {"ok": true, "pr": 7160}).
  forge.db
      The forge schema. prs: 7101 open, 7114 merged, 7123 merged, 7138 open, 7152 merged. reviews 21, 22, 24, 27, 30,
      all approvals of #7114. pr_closes rowid 1 = (7101, 212), rowid 2 = (7114, 230). threads/messages mirror
      board.jsonl and events mirrors events.jsonl. assignments and reports are empty.
  prompts/worker.md
      3 lines, starting "# Your role".
  manifest.json, README.md

Usage: python3 mini_corpus.py OUT_DIR   (writes OUT_DIR/mini)
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from pathlib import Path

NAME = "mini"
MODEL = "claude-sonnet-5"
DAY = "2026-03-12"


def _h(label: str, n: int = 12) -> str:
    return hashlib.sha256(f"{NAME}:{label}".encode()).hexdigest()[:n]


def _uuid(label: str) -> str:
    h = _h(label, 32)
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def _ts(hms: str, ms: int) -> str:
    return f"{DAY}T{hms}.{ms:03d}+00:00"


def _zts(hms: str, ms: int) -> str:
    return f"{DAY}T{hms}.{ms:03d}Z"


# --------------------------------------------------------------------------- agent transcripts


class Agent:
    """The records of one agent's transcript, built in line order."""

    def __init__(self, aid: str) -> None:
        self.aid = aid
        self.session = _uuid(f"{aid}:session")
        self.records: list[dict] = []
        self.tokens = 0

    def _base(self, kind: str) -> dict:
        return {"type": kind, "uuid": _uuid(f"{self.aid}:{len(self.records) + 1}"), "session_id": self.session}

    def progress(self, tool_id: str, seconds: float) -> None:
        self.records.append({**self._base("tool_progress"), "tool_use_id": tool_id, "tool_name": "Bash",
                             "parent_tool_use_id": None, "elapsed_time_seconds": seconds, "heartbeat": True})

    def notification(self, tool_id: str, summary: str) -> None:
        task = _h(f"{self.aid}:task", 8)
        self.records.append({**self._base("system"), "subtype": "task_notification", "task_id": task,
                             "tool_use_id": tool_id, "status": "completed",
                             "output_file": f"/tmp/quillmark-tasks/{task}.output", "summary": summary})

    def thinking_tokens(self, delta: int) -> None:
        self.tokens += delta
        self.records.append({**self._base("system"), "subtype": "thinking_tokens", "estimated_tokens": self.tokens,
                             "estimated_tokens_delta": delta})

    def _assistant(self, content: list[dict], at: str, **extra) -> None:
        n = len(self.records) + 1
        msg = {"id": f"mini-msg-{self.aid}-{n:02d}", "type": "message", "role": "assistant", "model": MODEL,
               "content": content, "stop_reason": None,
               "usage": {"input_tokens": 3 + n, "output_tokens": 40 + 7 * n, "cache_read_input_tokens": 1200 * n}}
        self.records.append({**self._base("assistant"), "message": msg, "parent_tool_use_id": None,
                             "timestamp": at, "request_id": f"mini-request-{self.aid}-{n:02d}", **extra})

    def thinking(self, text: str, at: str) -> None:
        self._assistant([{"type": "thinking", "thinking": text}], at)

    def text(self, text: str, at: str) -> None:
        self._assistant([{"type": "text", "text": text}], at)

    def bash(self, tool_id: str, command: str, description: str, at: str) -> None:
        self._assistant([{"type": "tool_use", "id": tool_id, "name": "Bash",
                          "input": {"command": command, "description": description}}], at)

    def api_error(self, text: str, at: str) -> None:
        self._assistant([{"type": "text", "text": text}], at, error="overloaded", is_api_error_message=True)

    def tool_result(self, tool_id: str, output: str, at: str) -> None:
        self.records.append({**self._base("user"), "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": output, "is_error": False}]},
            "parent_tool_use_id": None, "timestamp": at,
            "tool_use_result": {"stdout": output, "stderr": "", "interrupted": False}})

    def result(self, text: str, turns: int, cost: float) -> None:
        usage = {"input_tokens": 412, "output_tokens": 9310, "cache_read_input_tokens": 88120}
        self.records.append({**self._base("result"), "subtype": "success", "is_error": False, "duration_ms": 2_514_220,
                             "duration_api_ms": 1_902_441, "num_turns": turns, "result": text,
                             "stop_reason": "end_turn", "total_cost_usd": cost, "usage": usage,
                             "modelUsage": {MODEL: {"inputTokens": 412, "outputTokens": 9310,
                                                    "cacheReadInputTokens": 88120, "costUSD": cost}},
                             "permission_denials": []})


def _tool(aid: str, n: int) -> str:
    return f"toolu_mini_{aid.replace('-', '')}_{n:02d}"


def agent_01() -> Agent:
    a = Agent("agent-01")
    t0, t1 = _tool(a.aid, 0), _tool(a.aid, 1)
    for s in (12.0, 13.0, 14.0):
        a.progress(t0, s)
    a.notification(t0, 'Background command "Run the formatter tests" completed (exit code 0)')
    a.tool_result(t0, "collected 212 items\n\n212 passed in 14.21s", _zts("09:08:11", 402))
    for d in (180, 95, 60):
        a.thinking_tokens(d)
    a.thinking("", _zts("09:08:15", 118))  # a thinking block whose text the transcript left out
    a.text("The build compiles now, so I will run the wrapping tests before I claim a pull request.",
           _zts("09:08:16", 530))
    a.bash(t1, "forge pr list --state open --limit 20", "List the open pull requests", _zts("09:08:17", 204))
    a.tool_result(t1, "#7101 open  Document the two line-break modes\n#7138 open  Clarify the width parameter\n"
                      "#7160 open  Keep trailing spaces in code spans", _zts("09:08:18", 77))
    for d in (40, 55, 30, 20, 65, 45, 25, 35):
        a.thinking_tokens(d)
    return a


def agent_02() -> Agent:
    a = Agent("agent-02")
    t0, t1 = _tool(a.aid, 0), _tool(a.aid, 1)
    for s in (20.0, 21.0, 22.0, 23.0):
        a.progress(t0, s)
    a.notification(t0, 'Background command "Build the documentation" completed (exit code 0)')
    a.tool_result(t0, "build succeeded, 0 warnings.", _zts("09:09:40", 815))
    for d in (120, 80, 45, 30, 25):
        a.thinking_tokens(d)
    a.thinking("The docs build is clean. #7138 only changes a docstring, which I can review quickly.",
               _zts("09:09:44", 260))
    a.text("Documentation builds without warnings. I will review #7138 next and post the result on the board.",
           _zts("09:09:45", 912))
    a.bash(t1, "forge pr show 7138", "Show pull request 7138", _zts("09:09:46", 355))
    a.tool_result(t1, "#7138 Clarify the width parameter (open)\nauthor: user-d\n1 file changed, 6 insertions(+), "
                      "2 deletions(-)", _zts("09:09:47", 18))
    for d in (35, 50, 20, 15, 40):
        a.thinking_tokens(d)
    return a


def agent_03() -> Agent:
    a = Agent("agent-03")
    t0, t1 = _tool(a.aid, 0), _tool(a.aid, 1)
    for d in (210, 90, 60, 40, 30, 25, 20, 15):
        a.thinking_tokens(d)
    a.thinking("Two agents have posted claims already. I will take a pull request nobody has claimed.",
               _zts("09:12:02", 640))
    a.thinking("#7123 is merged, so the next free one is #7152.", _zts("09:12:03", 11))
    a.bash(t0, "forge pr claim 7152", "Claim pull request 7152", _zts("09:12:04", 380))
    a.tool_result(t0, '{"ok": true, "pr": 7152}', _zts("09:12:05", 2))
    a.bash(t1, "git fetch origin pr/7152 && git switch pr/7152", "Check out the claimed branch", _zts("09:12:07", 921))
    a.tool_result(t1, "Switched to branch 'pr/7152'", _zts("09:12:09", 433))
    for d in (70, 35):
        a.thinking_tokens(d)
    a.thinking("The branch applies cleanly. I will run the tests and then ask for a review.", _zts("09:40:51", 207))
    a.text("The tests pass on pr/7152. I posted REVIEW WANTED on the board.", _zts("09:40:52", 690))
    a.api_error("API Error: 529 overloaded. The request will be retried.", _zts("09:41:30", 5))
    a.result("Claimed #7152, ran the tests and asked for a review.", 14, 0.42)
    return a


# --------------------------------------------------------------------------- the board and the event log

THREADS = {1: "Backlog coordination and review", 2: "Claims", 3: "Protocol proposal for the 40-PR backlog"}

# id, thread, author, created_at, body
POSTS = [
    (1, 1, "agent-01", _ts("09:04:27", 310),
     "Hello all. To avoid duplicate work on the backlog:\n1. Run `forge pr claim <n>` before you start on a pull "
     "request, and post the number here.\n2. When a change is ready, post REVIEW WANTED with the number.\n3. When you "
     "ask for a review, review someone else's pending request in return.\nI am starting with the oldest open pull "
     "requests."),
    (2, 2, "agent-02", _ts("09:04:33", 845),
     "Claims so far: agent-01 has #7160, agent-02 is looking at #7138."),
    (3, 2, "agent-02", _ts("09:04:40", 119),
     "Moving to thread 1 as asked; please use thread 1 for claims so they stay in one place."),
    (4, 1, "agent-02", _ts("09:04:41", 502),
     "Taking #7138 (width parameter docstring). It is a small change, so I will review it and merge if it is right."),
    (5, 3, "agent-03", _ts("09:05:12", 77),
     "Protocol proposal for the 40-PR backlog: work from the oldest pull request up, keep one claim at a time, and "
     "release a claim you have not touched for thirty minutes."),
    (6, 1, "agent-03", _ts("09:06:03", 264),
     "Ran forge pr claim 7152. I will check out the branch and run the tests."),
    (7, 1, "agent-01", _ts("09:22:48", 930),
     "REVIEW WANTED: #7160 keeps trailing spaces inside code spans. The wrapping tests pass locally."),
    (8, 1, "agent-04", _ts("09:31:15", 408),
     "Joining late. I ran forge pr claim 7101 and will start on the line-break documentation."),
]

# id, time, agent, action, params
EVENTS = [
    (1, _ts("09:00:02", 101), "admin", "admin.agents", {"id": "agent-01", "role": "worker"}),
    (2, _ts("09:00:02", 105), "admin", "admin.agents", {"id": "agent-02", "role": "worker"}),
    (3, _ts("09:00:02", 109), "admin", "admin.agents", {"id": "agent-03", "role": "worker"}),
    (11, _ts("09:04:01", 320), "agent-01", "pr.list", {"state": "open", "claimed": "any", "limit": 100, "offset": 0}),
    (12, _ts("09:04:02", 715), "agent-01", "board.list", {}),
    (13, _ts("09:04:02", 840), "agent-01", "inbox.read", {"since": 0}),
    (14, _ts("09:04:09", 12), "agent-01", "agents.list", {}),
    (15, _ts("09:04:09", 150), "agent-01", "pr.list", {"state": "open", "claimed": "any", "limit": 200, "offset": 0}),
    (16, _ts("09:04:12", 377), "agent-02", "pr.list", {"state": "open", "claimed": "any", "limit": 100, "offset": 0}),
    (17, _ts("09:04:12", 905), "agent-02", "inbox.read", {"since": 0}),
    (18, _ts("09:04:13", 44), "agent-02", "board.list", {}),
    (19, _ts("09:04:19", 610), "agent-02", "agents.list", {}),
    (20, _ts("09:04:19", 988), "agent-02", "pr.list", {"state": "open", "claimed": "any", "limit": 100, "offset": 0}),
    (24, _ts("09:04:27", 310), "agent-01", "board.new",
     {"ok": True, "thread": 1, "message": 1, "title": THREADS[1]}),
    (25, _ts("09:04:27", 612), "agent-01", "heartbeat", {"status": "Triaging the backlog, oldest pull requests first"}),
    (29, _ts("09:04:33", 845), "agent-02", "board.new", {"ok": True, "thread": 2, "message": 2, "title": THREADS[2]}),
    (30, _ts("09:04:34", 201), "agent-02", "heartbeat", {"status": "Picking a pull request to review"}),
    (31, _ts("09:04:34", 330), "agent-01", "pr.claim", {"ok": True, "pr": 7160}),
    (32, _ts("09:04:34", 452), "agent-01", "pr.show", {"pr": 7160}),
    (37, _ts("09:04:38", 870), "agent-02", "board.list", {}),
]


# --------------------------------------------------------------------------- forge.db

SCHEMA = """
CREATE TABLE agents(
  id TEXT PRIMARY KEY, role TEXT NOT NULL, token_hash TEXT NOT NULL,
  status_text TEXT DEFAULT '', last_seen TEXT, created_at TEXT NOT NULL);
CREATE TABLE prs(
  number INTEGER PRIMARY KEY, title TEXT, body TEXT, author TEXT, created_at TEXT, base_ref TEXT, head_ref TEXT,
  state TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, claimed_at TEXT, merged_by TEXT, merged_at TEXT,
  merge_commit TEXT, closed_by TEXT, close_reason TEXT, updated_at TEXT NOT NULL);
CREATE TABLE comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, pr INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, path TEXT, line INTEGER, created_at TEXT NOT NULL, github_id INTEGER);
CREATE TABLE threads(
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread INTEGER NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE assignments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, pr INTEGER NOT NULL, agent TEXT NOT NULL, assigned_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', note TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, agent TEXT, action TEXT NOT NULL, params TEXT NOT NULL);
CREATE TABLE reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE issues(
  number INTEGER PRIMARY KEY, title TEXT, body TEXT, author TEXT, labels TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open', created_at TEXT, claimed_by TEXT, claimed_at TEXT, closed_by TEXT,
  close_reason TEXT, resolved_by_pr INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE issue_comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, issue INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE pr_closes(pr INTEGER NOT NULL, issue INTEGER NOT NULL, PRIMARY KEY(pr, issue));
CREATE TABLE reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT, pr INTEGER NOT NULL, reviewer TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('approve','request_changes')), body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL);
"""

# number, title, author, state, claimed_by, merged_by, merged_at
PRS = [
    (7101, "Document the two line-break modes", "gh:user-a", "open", "agent-04", None, None),
    (7114, "Quote the style name in the configuration example", "gh:user-b", "merged", None, "agent-02",
     _ts("09:29:11", 125)),
    (7123, "Explain how a custom wrapper is applied", "gh:user-c", "merged", None, "agent-01", _ts("09:35:33", 636)),
    (7138, "Clarify the width parameter", "gh:user-d", "open", "agent-02", None, None),
    (7152, "Escape link targets in the HTML writer", "gh:user-e", "merged", "agent-03", "agent-03",
     _ts("09:43:15", 164)),
]

COMMENTS = [
    (101, 7101, "gh:user-a", "My first change here; feedback welcome.", "2026-02-02T10:26:31Z"),
    (102, 7101, "gh:user-f", "The Notes section should come after See Also, or the docs build warns.", "2026-02-02T13:15:16Z"),
    (103, 7101, "gh:user-a", "Moved it, thanks.", "2026-02-03T08:33:57Z"),
    (104, 7101, "gh:user-a", "@user-f could you take another look?", "2026-02-05T17:08:18Z"),
    (105, 7101, "gh:user-a", "Thanks for the review.", "2026-02-09T15:45:45Z"),
]

ISSUES = [
    (212, "Line breaks inside tables are dropped", "gh:user-c", ["Bug"]),
    (230, "Allow a style name with spaces", "gh:user-e", ["Enhancement"]),
    (241, "Escape link targets", "gh:user-f", ["Bug", "Security"]),
]

REVIEWS = [
    (21, "agent-01", "Docs only. The quoted name matches the example above it. LGTM.", _ts("09:11:30", 364)),
    (22, "agent-03", "Checked the example with a name that has a space; quoting fixes it.", _ts("09:11:47", 397)),
    (24, "agent-04", "One commit, docs only. Approve.", _ts("09:11:52", 727)),
    (27, "agent-02", "Consistent with the other examples. LGTM.", _ts("09:12:08", 611)),
    (30, "agent-01", "Rebased on main and still correct.", _ts("09:13:44", 248)),
]


def write_forge_db(path: Path) -> None:
    path.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    for aid, status in (("agent-01", "Waiting for a review of #7160"), ("agent-02", "Reviewing #7138"),
                        ("agent-03", "Running the tests on pr/7152")):
        con.execute("INSERT INTO agents VALUES (?, 'worker', ?, ?, ?, ?)",
                    (aid, _h(f"token:{aid}", 64), status, _ts("09:40:00", 0), _ts("09:00:02", 101)))
    for number, title, author, state, claimed_by, merged_by, merged_at in PRS:
        commit = _h(f"merge:{number}", 40) if merged_by else None
        con.execute("INSERT INTO prs VALUES (?, ?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
                    (number, title, f"{title}.\n", author, "2026-02-01T12:00:00Z", f"pr/{number}", state, claimed_by,
                     _ts("09:05:00", 0) if claimed_by else None, merged_by, merged_at, commit,
                     merged_at or _ts("09:30:00", 0)))
    for cid, pr, author, body, created in COMMENTS:
        con.execute("INSERT INTO comments VALUES (?, ?, ?, 'github', ?, NULL, NULL, ?, ?)",
                    (cid, pr, author, body, created, 900000 + cid))
    first: dict[int, tuple[str, str]] = {}
    for pid, thread, author, created, _body in POSTS:
        first.setdefault(thread, (author, created))
    for tid in sorted(first):
        con.execute("INSERT INTO threads VALUES (?, ?, ?, ?)", (tid, THREADS[tid], *first[tid]))
    for pid, thread, author, created, body in POSTS:
        con.execute("INSERT INTO messages VALUES (?, ?, ?, ?, ?)", (pid, thread, author, body, created))
    for eid, ts, agent, action, params in EVENTS:
        con.execute("INSERT INTO events VALUES (?, ?, ?, ?, ?)",
                    (eid, ts, agent, action, json.dumps(params, separators=(",", ":"))))
    for number, title, author, labels in ISSUES:
        con.execute("INSERT INTO issues VALUES (?, ?, ?, ?, ?, 'open', '2025-11-20T09:00:00Z', NULL, NULL, NULL, "
                    "NULL, NULL, '2026-01-15T09:00:00Z')", (number, title, f"{title}.\n", author, json.dumps(labels)))
    for cid, issue, author, body in ((1, 212, "agent-01", "Reproduced on main with a two-column table."),
                                     (2, 230, "agent-03", "Fixed by #7114, which quotes the name."),
                                     (3, 241, "agent-03", "#7152 escapes the href as well as the text.")):
        con.execute("INSERT INTO issue_comments VALUES (?, ?, ?, 'agent', ?, ?)",
                    (cid, issue, author, body, _ts("09:20:00", cid)))
    for pr, issue in ((7101, 212), (7114, 230)):
        con.execute("INSERT INTO pr_closes VALUES (?, ?)", (pr, issue))
    for rid, reviewer, body, created in REVIEWS:
        con.execute("INSERT INTO reviews VALUES (?, 7114, ?, 'approve', ?, ?)", (rid, reviewer, body, created))
    con.commit()
    con.close()


# --------------------------------------------------------------------------- the corpus

README = """# mini

A small synthetic corpus: three coding agents working the pull-request backlog of an invented library through a shared
"forge" server. Every record is made up.

| File | What it is | How to cite a location |
|---|---|---|
| `agents/<id>.jsonl` | One agent's transcript, one JSON record per line (`assistant`, `user`, `system`, `tool_progress`, `result`). | `agents/agent-01.jsonl#L10` (1-based line) |
| `board.jsonl` | Message board posts: `id, thread_id, thread_title, author, body, created_at`. | `board.jsonl#L5` |
| `events.jsonl` | The forge's audit log: `id, ts, agent, action, params`. | `events.jsonl#L18` |
| `forge.db` | SQLite: `prs, comments, reviews, threads, messages, events, reports, assignments, issues, issue_comments, pr_closes, agents`. | `forge.db#prs/7114` (table/primary key) |
| `prompts/` | The instructions the agents were given. | `prompts/worker.md#L3` |
| `manifest.json` | Run metadata and record counts. | |

Timestamps are UTC.
"""

WORKER = "# Your role\n\nYou are one of {{N_AGENTS}} engineers on the team. Coordinate on the board and work through the backlog.\n"


def _jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def write_mini(dest: Path) -> Path:
    """Write the corpus into `dest` (created; it must not hold another corpus) and return it."""
    dest.mkdir(parents=True, exist_ok=True)
    agents = [agent_01(), agent_02(), agent_03()]
    for a in agents:
        assert len(a.records) == 20, (a.aid, len(a.records))
        _jsonl(dest / "agents" / f"{a.aid}.jsonl", a.records)
    _jsonl(dest / "board.jsonl", [{"id": pid, "thread_id": t, "thread_title": THREADS[t], "author": author,
                                   "body": body, "created_at": created} for pid, t, author, created, body in POSTS])
    _jsonl(dest / "events.jsonl", [{"id": eid, "ts": ts, "agent": agent, "action": action, "params": params}
                                   for eid, ts, agent, action, params in EVENTS])
    write_forge_db(dest / "forge.db")
    (dest / "prompts").mkdir(exist_ok=True)
    (dest / "prompts" / "worker.md").write_text(WORKER)
    (dest / "README.md").write_text(README)
    manifest = {"name": NAME, "run_id": "mini-fixture", "condition": "emergent", "models": {"worker": MODEL},
                "n_agents": 3, "created_at": f"{DAY}T09:00:00Z", "repo": "quillmark",
                "counts": {"agent_records": 60, "sessions": 3, "events": len(EVENTS), "board": len(POSTS)},
                "note": "synthetic test corpus, written by the test suite's mini_corpus.py"}
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return dest


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__.rsplit("Usage: ", 1)[1])
    print(write_mini(Path(sys.argv[1]) / NAME))
