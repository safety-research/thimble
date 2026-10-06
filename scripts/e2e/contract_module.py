"""The interactive contract check of the release test (scripts/e2e_release.sh, with THIMBLE_LIVE_CLAUDE=1): thimble's hooks
module in a real interactive main, since the module does nothing in `claude -p` (spike V3), checked against what Claude
Code does with what the module asks, so a Claude Code update that changes it fails the release.

    <tree>/backend/.venv/bin/python scripts/e2e/contract_module.py <tree> <corpus folder> <out folder>
        [--results results.jsonl] [--socket NAME] [--main-model M] [--keep-corpus]

Run it in the environment the run's server would run in (THIMBLE_HOME, THIMBLE_PORT, THIMBLE_UI_PORT; it refuses to
run without THIMBLE_HOME), with no server on THIMBLE_PORT: it runs thimble's server (app.main:app on uvicorn) in its own
process, with the environment and server.json `thimble server up` gives one, so it can make requests of the module
through the bridge itself (module_bridge.request, subagents.start_job, send and stop) as the browser's clicks do. It
starts the launcher (<tree>/plugin/bin/thimble --permission-mode auto) in the corpus folder, in a tmux server of its own
(`tmux -L <socket>`), with CLAUDE_CODE_DISABLE_AGENT_VIEW=1, DISABLE_AUTOUPDATER=1, every other thimble copy Claude
Code enables turned off for the session, and a hook that logs the inputs of PreToolUse, SubagentStart and SubagentStop.
Claude Code must already trust the corpus folder: the check never answers its trust question yes (it answers "No, exit"
and fails), since that would change the analyst's trusted folders; THIMBLE_E2E_TRUSTED_DIR names a folder Claude Code
trusts, under which e2e_release.sh copies the corpus for this check.

The assertions (each one line of results.jsonl, {step, title, status, detail}; see ASSERTIONS), in order:
  hello            the module's hello is accepted for main's session as launch.json names it;
  initial-listing  each of thimble's types (subagents.TYPES, `thimble:<name>`) is in main's first agent listing
                   (agent_listing_delta with isInitial true), and the terminal printed no "agent types available" line;
  spawn            a spawn through the bridge of thimble:check (thimble:writer while the check role is not in
                   subagents.TYPES), as a click makes it (subagents.start_job), with a full model id and an explicit
                   effort answers an agent id, and the agent transcript's message.model and effort equal them;
  plugin-id        that start's PreToolUse input has a `toolu_plugin_` id, which --agent-check claimed the request with;
  deny             a spawn through the bridge with no pending request comes back as {deny} from --agent-check;
  handback         in auto mode the run's hand-back reaches main as a user row from the agent, and main answers it;
  resume           a SendMessage through the bridge to the finished agent, with another effort, answers "Resuming
                   agent", and the resumed run's records carry the registration in force at the send (V1);
  descendants      a thimble:helper spawned through the bridge on the run values (thimble's roles keep to their own
                   work and decline a test's errand) starts a general-purpose child, which runs on its run values, and
                   a thimble:helper child, which runs on the helper's registration (V7);
  clear            after /clear the module's hello arrives under the new session id, and a click's spawn through it
                   answers an agent id;
  stop             TaskStop through the bridge (subagents.stop) stops that agent as soon as it runs: the agent ends
                   stopped, makes no request after it, and main gets no call, notification or hand-back for it;
  classifier       one structured call (Settings' labels row) runs `claude` with that row's --model and --effort while
                   CLAUDE_CODE_EFFORT_LEVEL is set in the environment, which the call's own environment blanks;
  quit             /exit and "Exit and stop tasks" end main.
It quits with /exit and "Exit and stop tasks", never ←, and stops its tmux session (never the tmux server). Everything
goes to <out folder>: events.jsonl (each step), screens/, hooks.jsonl, server.log is the caller's, transcripts/ (main's
and the agents', copied), workspace/ (subagents.json, launch.json), classifier/ and summary.json. Exit 0 when every
assertion passed, 1 otherwise.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from contract_print import SESSION_VARS, deliveries, jsonl, other_thimbles  # noqa: E402

HEALTH_WAIT_S = 60.0
HELLO_WAIT_S = 240.0  # the launcher, Claude Code's start, /thimble and the module's hello
RUN_WAIT_S = 300.0  # an agent's run, or a run with its two children
REPLY_WAIT_S = 120.0
CLEAR_WAIT_S = 60.0
QUIET_S = 15.0  # after the stop, main must get nothing for the stopped agent this long
QUIT_WAIT_S = 90.0
SESSION = "main"
TRUST_WORDS = ("Yes, I trust this folder", "Do you trust", "Quick safety check")
NO_TRUST = "No, exit"
EXIT_CHOICE = "Exit and stop tasks"
TYPES_LINE = re.compile(r"agent types? available", re.I)
RESUMING = "Resuming agent"
HANDBACK = "SubagentHandback"
GP, HELPER_TYPE = "general-purpose", "thimble:helper"
GP_DONE, HELPER_DONE, SPAWN_DONE, RESUMED_DONE = "GP-OK", "HELPER-OK", "SPAWN-OK", "RESUMED-OK"

ASSERTIONS = {
    "hello": "The module's hello is accepted for main's session",
    "initial-listing": "thimble's types are in main's first agent listing, with no terminal line for them",
    "spawn": "A spawn through the bridge with a full model id and an explicit effort runs on exactly them",
    "plugin-id": "The spawn's PreToolUse input has a toolu_plugin_ id",
    "deny": "A spawn with no pending request comes back as {deny} from --agent-check",
    "handback": "In auto mode the run's hand-back reaches main, and main answers it",
    "resume": "SendMessage through the bridge answers Resuming agent, on the registration in force at the send",
    "descendants": "A general-purpose child runs on its parent's run values, a thimble:helper child on the helper's",
    "clear": "After /clear the hello arrives under the new session id and a spawn through it answers",
    "stop": "TaskStop through the bridge stops an agent with nothing reaching main",
    "classifier": "A structured call's claude argv carries --model and --effort while CLAUDE_CODE_EFFORT_LEVEL is set",
    "quit": "/exit and Exit and stop tasks end main",
}

ROLE_TASK = ("This is an automated contract check of thimble's release test, run by the analyst; there is no document, "
             f"view or check to work on in this run. Hand back \"{SPAWN_DONE}\" and do nothing else.")
SPAWN_TASK = ("This is an automated contract check of thimble's release test, not a real task: do exactly these steps "
              "and nothing else, and write nothing anywhere. 1. Call the Agent tool with subagent_type "
              f"\"{GP}\", description \"contract gp\" and prompt \"Reply with the plain text {GP_DONE}.\". 2. Call the "
              f"Agent tool with subagent_type \"{HELPER_TYPE}\", description \"contract helper\" and prompt \"Reply with "
              f"the plain text {HELPER_DONE}.\". 3. End your turn with no tool call: each child's report arrives later "
              f"as a message and starts your next turn. 4. Once both have reported, hand back \"{SPAWN_DONE}\".")
RESUME_TEXT = f"Contract check follow-up from the analyst's release test: hand back \"{RESUMED_DONE}\" and do nothing else."


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def when(rec: dict) -> float:
    """A transcript record's time, as seconds since the epoch (0 without one)."""
    try:
        return datetime.fromisoformat(str(rec.get("timestamp")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


# --------------------------------------------------------------------------------------------- reading transcripts
# Pure functions, tested in backend/tests_public/test_contract_checks.py.

def first_listing(rows: list[dict]) -> dict | None:
    """Main's first agent listing: the first agent_listing_delta attachment with isInitial true."""
    for r in rows:
        att = r.get("attachment") if r.get("type") == "attachment" else None
        if isinstance(att, dict) and att.get("type") == "agent_listing_delta" and att.get("isInitial") is True:
            return att
    return None


def check_listing(listing: dict | None, expected: list[str], roles: list[str], screen: str) -> tuple[bool, str]:
    added = set((listing or {}).get("addedTypes") or [])
    missing = [t for t in expected if t not in added]
    pending = [f"thimble:{r}" for r in roles if f"thimble:{r}" not in expected]
    lines = sorted(set(m.group(0) for m in TYPES_LINE.finditer(screen)))
    ok = listing is not None and not missing and not lines
    present = sorted(t for t in added if t.startswith("thimble:"))
    return ok, (f"{'no isInitial listing' if listing is None else 'isInitial listing'}: thimble types {present}; "
                f"expected (subagents.TYPES) {expected}" + (f"; missing {missing}" if missing else "")
                + (f"; roles not in subagents.TYPES on this head: {pending}" if pending else "")
                + f"; terminal line {lines or 'none'}")


def assistant_runs(rows: list[dict], after: float = 0.0) -> list[tuple[float, str, Any]]:
    """(time, message.model, effort) of each assistant record at or after `after`."""
    out = []
    for r in rows:
        if r.get("type") == "assistant" and when(r) >= after:
            out.append((when(r), str((r.get("message") or {}).get("model") or ""), r.get("effort")))
    return out


def on_values(rows: list[dict], model: str, effort: Any, after: float = 0.0) -> tuple[bool, str]:
    """Whether every assistant record (at or after `after`) ran on `model` and `effort` (None: a model with none)."""
    seen = assistant_runs(rows, after)
    pairs = sorted({(m, e) for _, m, e in seen}, key=str)
    want_effort = effort or None
    ok = bool(seen) and all(m == model and (e or None) == want_effort for _, m, e in seen)
    return ok, f"{len(seen)} requests on {pairs}, wanted ({model!r}, {want_effort!r})"


def handed_back(rows: list[dict]) -> str | None:
    """The message of the agent's last SubagentHandback call, when that call is its last tool call and has its result."""
    calls, results = [], set()
    for r in rows:
        content = (r.get("message") or {}).get("content")
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use":
                calls.append(b)
            elif b.get("type") == "tool_result":
                results.add(b.get("tool_use_id"))
    if calls and calls[-1].get("name") == HANDBACK and calls[-1].get("id") in results:
        return str((calls[-1].get("input") or {}).get("message") or "")
    return None


def last_handback_at(rows: list[dict]) -> float:
    """The time of the agent's last SubagentHandback call, 0 without one."""
    at = 0.0
    for r in rows:
        content = (r.get("message") or {}).get("content")
        if r.get("type") == "assistant" and isinstance(content, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == HANDBACK for b in content):
            at = max(at, when(r))
    return at


def main_rows_from(rows: list[dict], agent: str, after: float = 0.0) -> dict[str, list[dict]]:
    """What main's transcript holds for `agent` at or after `after`: its hand-backs (origin kind peer) and its task
    notifications (task-id), each as a user row or a queued_command attachment (contract_print.deliveries), and main's
    own calls naming it (TaskStop, SendMessage)."""
    out: dict[str, list[dict]] = {"handbacks": [], "notifications": [], "calls": []}
    for origin, text, r in deliveries([r for r in rows if when(r) >= after]):
        if origin.get("kind") == "peer" and origin.get("from") == agent:
            out["handbacks"].append(r)
        elif origin.get("kind") == "task-notification" and re.search(rf"<task-id>\s*{re.escape(agent)}\s*</task-id>", text):
            out["notifications"].append(r)
    for r in rows:
        if r.get("type") == "assistant" and when(r) >= after:
            for b in (r.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in ("TaskStop", "SendMessage") \
                        and agent in json.dumps(b.get("input") or {}):
                    out["calls"].append(r)
    return out


def origin_of(rec: dict) -> dict:
    """The origin of a user row, or of a queued_command attachment (a delivery that came mid-turn)."""
    if isinstance(rec.get("origin"), dict):
        return rec["origin"]
    att = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
    return att.get("origin") if isinstance(att.get("origin"), dict) else {}


def answered_after(rows: list[dict], at: float) -> bool:
    """Whether main wrote an assistant record after `at` (its answer to a row it got then)."""
    return any(r.get("type") == "assistant" and when(r) > at for r in rows)


def flag_value(argv: list[str], flag: str) -> str | None:
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(flag + "="):
            return a.split("=", 1)[1]
    return None


def check_classifier(calls: list[dict], want: dict, status: str) -> tuple[bool, str]:
    if not calls:
        return False, f"no `claude` was run (the call ended {status})"
    argv, env = calls[0].get("argv") or [], calls[0].get("effort_env")
    model, effort = flag_value(argv, "--model"), flag_value(argv, "--effort")
    ok = model == want["model"] and effort == want["effort"] and not env and status == "ok"
    return ok, (f"argv --model {model!r} --effort {effort!r} (Settings' labels row {want['model']!r}, {want['effort']!r}); "
                f"CLAUDE_CODE_EFFORT_LEVEL in the call's environment {env!r} (the test set it to high); call {status}")


# --------------------------------------------------------------------------------------------- the terminal

class Terminal:
    """main's terminal: a session on a tmux server of its own, so nothing else on the machine is touched. Never ←, never
    "Move to background"; stopping kills this session only, never the server."""

    def __init__(self, socket: str, env: dict[str, str]) -> None:
        self.socket, self.env = socket, env

    def tmux(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["tmux", "-L", self.socket, *args], capture_output=True, text=True, env=self.env,
                              check=False)

    def start(self, cwd: str, command: str) -> None:
        r = self.tmux("new-session", "-d", "-s", SESSION, "-x", "220", "-y", "50", "-c", cwd, command)
        if r.returncode != 0:
            raise RuntimeError(f"tmux new-session failed: {r.stderr.strip()}")
        self.tmux("set-option", "-t", SESSION, "history-limit", "20000")

    def screen(self, history: bool = False) -> str:
        return self.tmux("capture-pane", "-p", "-t", SESSION, *(["-S", "-20000"] if history else [])).stdout

    def keys(self, *keys: str) -> None:
        if "Left" in keys:
            raise ValueError("← is never pressed")
        self.tmux("send-keys", "-t", SESSION, *keys)

    def text(self, text: str) -> None:
        self.tmux("send-keys", "-t", SESSION, "-l", text)

    def alive(self) -> bool:
        return self.tmux("has-session", "-t", SESSION).returncode == 0

    def stop(self) -> None:
        if self.alive():
            self.tmux("kill-session", "-t", SESSION)


def menu_moves(screen: str, choice: str) -> int | None:
    """How many lines down (negative: up) the menu's cursor (❯) must move to reach `choice`; None when the screen shows
    no menu with it."""
    lines = screen.splitlines()
    at = next((i for i, ln in enumerate(lines) if choice in ln), None)
    cursors = [i for i, ln in enumerate(lines) if ln.lstrip().startswith("❯")]
    if at is None or not cursors:
        return None
    return at - min(cursors, key=lambda i: abs(i - at))  # the menu's cursor, not the prompt's ❯ above it


# --------------------------------------------------------------------------------------------- the check

class Check:
    def __init__(self, opts: argparse.Namespace, tree: Path, corpus: Path, out: Path, environ: dict[str, str]) -> None:
        self.opts, self.tree, self.corpus, self.out, self.environ = opts, tree, corpus, out, environ
        self.results: dict[str, tuple[bool, str]] = {}
        self.c = ""
        self.term: Terminal | None = None
        self.shots = 0
        self.server: Any = None
        self.info: dict[str, Any] = {}

    # ---- records
    def note(self, kind: str, **fields: Any) -> None:
        with (self.out / "events.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": now_iso(), "kind": kind, **fields}, ensure_ascii=False, default=str) + "\n")
        print(f"contract-module: {kind} {json.dumps(fields, default=str)[:300]}", flush=True)

    def result(self, name: str, ok: bool, detail: str) -> None:
        self.results[name] = (bool(ok), detail)
        self.note("assert", name=name, ok=bool(ok), detail=detail)

    def shot(self, name: str) -> str:
        self.shots += 1
        path = self.out / "screens" / f"{self.shots:02d}-{name}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.term.screen() if self.term else "", "utf-8")
        return str(path)

    # ---- the server's state, read in this process
    def on_loop(self, coro: Any, timeout: float = 60.0) -> Any:
        from app import module_bridge  # noqa: PLC0415

        loop = module_bridge._loop
        if loop is None:
            raise RuntimeError("the bridge has no event loop yet (no module said hello)")
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout)

    def main_path(self) -> Path | None:
        from app import session  # noqa: PLC0415

        lv = session.current(self.c)
        p = getattr(lv, "transcript_path", None) if lv is not None else None
        return Path(p) if p else None

    def project_dir(self) -> Path | None:
        p = self.main_path() or self.info.get("first_main")
        return Path(p).parent if p else None

    def main_paths(self) -> list[Path]:
        """main's transcripts in this run: the first session's, and the one /clear made."""
        found = [self.info.get("first_main"), self.info.get("second_main"), self.main_path()]
        return list(dict.fromkeys(Path(p) for p in found if p))

    def main_rows(self, path: Path | None = None) -> list[dict]:
        p = path or self.main_path()
        return jsonl(p) if p else []

    def agent_rows(self, agent: str) -> list[dict]:
        proj = self.project_dir()
        rows: list[dict] = []
        if proj is None:
            return rows
        for p in sorted(proj.glob(f"*/subagents/agent-{agent}.jsonl")):
            rows.extend(jsonl(p))
        return sorted(rows, key=when)

    def children(self, agent: str) -> dict[str, str]:
        """{child agent id: agentType} of the agents whose meta.json names `agent` as parent."""
        proj, out = self.project_dir(), {}
        for p in proj.glob("*/subagents/agent-*.meta.json") if proj else []:
            try:
                meta = json.loads(p.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            if meta.get("parentAgentId") == agent:
                out[p.name.removeprefix("agent-").removesuffix(".meta.json")] = str(meta.get("agentType") or "")
        return out

    def wait(self, what: str, test: Callable[[], Any], timeout: float, every: float = 1.0) -> Any:
        end = time.monotonic() + timeout
        while True:
            got = test()
            if got:
                return got
            if time.monotonic() >= end or (self.term is not None and not self.term.alive()):
                self.note("timeout", what=what, after_s=timeout)
                return got
            time.sleep(every)

    # ---- the steps
    def run(self) -> None:
        try:
            self.steps()
        except Exception as e:  # noqa: BLE001 — every assertion not reached fails with this
            self.note("error", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc())
            for name in ASSERTIONS:
                if name not in self.results and name not in ("classifier", "quit"):
                    self.results[name] = (False, f"not reached: {type(e).__name__}: {e}")
        finally:
            try:
                if "classifier" not in self.results:
                    self.classifier()
            except Exception as e:  # noqa: BLE001
                self.result("classifier", False, f"{type(e).__name__}: {e}")
            self.quit()
            self.evidence()
            if self.server is not None:
                self.server.should_exit = True

    def steps(self) -> None:
        from app import cli, config, module_bridge, subagents  # noqa: PLC0415

        self.wait("health", lambda: self.healthy(cli.api_url()), HEALTH_WAIT_S, 0.5)
        disable = other_thimbles(shutil.which("claude") or "claude", self.tree, self.claude_env())
        own = {"enabledPlugins": {p: False for p in disable}, "hooks": self.hooks()}
        launcher = [str(self.tree / "plugin" / "bin" / "thimble"), "--permission-mode", "auto", "--settings", json.dumps(own)]
        if self.opts.main_model:
            launcher += ["--model", self.opts.main_model]
        switches = {"CLAUDE_CODE_DISABLE_AGENT_VIEW": "1", "DISABLE_AUTOUPDATER": "1",
                    **{k: self.environ[k] for k in ("THIMBLE_HOME", "THIMBLE_PORT", "THIMBLE_UI_PORT") if self.environ.get(k)}}
        command = " ".join(["env", *(f"{k}={shlex.quote(v)}" for k, v in switches.items()), *map(shlex.quote, launcher)])
        self.term = Terminal(self.opts.socket, self.claude_env())
        launched = time.monotonic()
        self.term.start(str(self.corpus), command)
        self.note("launched", command=command, socket=self.opts.socket, disabled=disable)

        # hello
        def hello() -> Any:
            screen = self.term.screen()
            if any(w in screen for w in TRUST_WORDS):
                return "trust"
            c = config.workspace_for_cwd(str(self.corpus))
            if not c:
                return None
            self.c = c
            rec = subagents.read(c).get("module")
            seen = self.info.setdefault("module_records", [])
            if isinstance(rec, dict) and rec and (not seen or seen[-1] != rec):
                seen.append(rec)  # the module's record before and at its accepted hello
            sid = str(module_bridge._launch(c).get("session") or "")
            return sid if sid and module_bridge.live(c) and module_bridge._bridge(c).session == sid else None
        said = self.wait("hello", hello, HELLO_WAIT_S, 0.25)
        self.shot("hello")
        if said == "trust":
            moves = menu_moves(self.term.screen(), NO_TRUST)
            if moves is not None:
                self.term.keys(*(["Down"] * moves if moves > 0 else ["Up"] * -moves), "Enter")
            raise RuntimeError(f"Claude Code asks whether to trust {self.corpus}; the check answered No. Run it in a "
                               "folder Claude Code trusts (THIMBLE_E2E_TRUSTED_DIR)")
        rec = (subagents.read(self.c).get("module") or {}) if self.c else {}
        self.result("hello", bool(said), f"hello from {said or '(none)'} accepted {time.monotonic() - launched:.1f} s "
                    f"after launch; subagents.json module {rec}" if said else
                    f"no accepted hello within {HELLO_WAIT_S:.0f} s; subagents.json module {rec}; why_not "
                    f"{module_bridge.why_not(self.c) if self.c else 'no workspace'}")
        if not said:
            raise RuntimeError("no hello")
        old_sid = str(said)
        self.wait("main's transcript", lambda: self.main_path() is not None, REPLY_WAIT_S, 0.5)
        self.info["first_main"] = str(self.main_path() or "")

        # main's first agent listing (its first request, the /thimble turn)
        self.wait("main's first turn", lambda: first_listing(self.main_rows()) is not None, REPLY_WAIT_S)
        self.wait("main idle", lambda: self.idle(), REPLY_WAIT_S)
        expected = [subagents.type_name(t) for t in subagents.TYPES]
        ok, detail = check_listing(first_listing(self.main_rows()), expected, list(subagents.ROLES),
                                   self.term.screen(history=True))
        first = next((r for r in self.main_rows() if r.get("attachment", {}).get("type") == "agent_listing_delta"), {})
        self.result("initial-listing", ok, f"{detail}; main's first request at {first.get('timestamp')}, the module's "
                    f"records until its hello was accepted: {self.info.get('module_records')}")
        self.shot("listing")

        # a spawn of a role through the bridge, as a click starts one, on run values that differ from its registration
        role = "check" if "check" in subagents.TYPES else "writer"
        roles = subagents.roles(self.c)
        helper = roles.get(subagents.HELPER) or {}
        values = {"model": config.exact_model("sonnet"), "effort": "low"}
        if values == {"model": roles.get(role, {}).get("model"), "effort": roles.get(role, {}).get("effort")}:
            values["effort"] = "medium"
        self.info.update(role=role, values=values,
                         registered={k: {"model": v.get("model"), "effort": v.get("effort")} for k, v in roles.items()})
        t0 = time.time()
        ans = self.on_loop(subagents.start_job(self.c, role, f"{subagents.TYPES[role].kind}:contract-1", ROLE_TASK, values,
                                               subagents.CLICK, description="contract check spawn"))
        agent = str(ans.get("agentId") or "")
        self.info["spawn_s"] = f"{time.time() - t0:.2f} s"
        self.note("spawn", role=role, values=values, answer=dict(ans))
        if not agent:
            self.result("spawn", False, f"thimble:{role} with {values}: {dict(ans)}")
            raise RuntimeError("the spawn did not start an agent")
        rid = str(ans.get("request") or "")
        claimed = str((subagents.request(self.c, rid) or {}).get("claimed_by") or "")
        hooked = [e for e in self.hook_inputs() if e.get("hook_event_name") == "PreToolUse"
                  and e.get("tool_name") in ("Agent", "Task") and not e.get("agent_id")
                  and (e.get("tool_input") or {}).get("subagent_type") == f"thimble:{role}"]
        ids = [str(e.get("tool_use_id") or "") for e in hooked]
        self.result("plugin-id", bool(ids) and ids[-1].startswith("toolu_plugin_") and claimed == ids[-1],
                    f"PreToolUse tool_use_id {ids}; --agent-check claimed request {rid} with {claimed!r}")

        # a spawn of a role with no pending request
        deny = self.on_loop(module_bridge.request(self.c, "spawn", role=role, description="contract deny", values={},
                                                  prompt="Contract check: a start no request names.", what="contract"))
        self.result("deny", bool(deny.get("deny")), f"the bridge answered {deny}")

        # the run's end, its hand-back in main and main's answer
        self.wait("the spawned run's hand-back", lambda: handed_back(self.agent_rows(agent)) is not None
                  and self.answered(agent), RUN_WAIT_S, 2.0)
        self.shot("spawned-run-ended")
        ok, detail = on_values(self.agent_rows(agent), values["model"], values["effort"])
        self.result("spawn", ok, f"agent {agent} of thimble:{role}, answered in {self.info['spawn_s']}; {detail}; it "
                    f"handed back {str(handed_back(self.agent_rows(agent)))[:80]!r}")
        got = main_rows_from(self.main_rows(), agent)
        hb = got["handbacks"][0] if got["handbacks"] else {}
        answered = answered_after(self.main_rows(), when(hb)) if hb else False
        self.result("handback", bool(hb) and origin_of(hb).get("handback") is True and answered,
                    f"hand-backs from {agent} in main: {len(got['handbacks'])}, the first a {hb.get('type')} record with "
                    f"origin { {k: v for k, v in origin_of(hb).items() if k != 'body'} }; main answered after it: {answered}")
        self.wait("main idle", self.idle, REPLY_WAIT_S)

        # a follow-up through the bridge to the finished agent, on another effort
        values2 = {"model": values["model"], "effort": "medium" if values["effort"] != "medium" else "high"}
        sent_at = time.time()
        ans = self.on_loop(subagents.send(self.c, agent, RESUME_TEXT, values=values2))
        self.note("send", values=values2, answer=dict(ans))
        said = str(ans.get("text") or "")
        self.wait("the resumed run's hand-back", lambda: last_handback_at(self.agent_rows(agent)) > sent_at, RUN_WAIT_S, 2.0)
        rok, rdet = on_values(self.agent_rows(agent), values2["model"], values2["effort"], after=sent_at)
        self.result("resume", RESUMING in said and not ans.get("queued") and rok,
                    f"the bridge answered {said[:80]!r}; the resumed run: {rdet}")
        self.shot("resumed")
        self.wait("main idle", self.idle, REPLY_WAIT_S)

        # descendants: a thimble:helper started through the bridge on run values starts a general-purpose child and a
        # thimble:helper child (thimble's roles keep to their own work, so a role is not asked to)
        ans = self.on_loop(module_bridge.request(self.c, "spawn", role=subagents.HELPER, prompt=SPAWN_TASK,
                                                 description="contract helper", values=values, what="contract"))
        parent = str(ans.get("agentId") or "")
        self.note("spawn-helper", values=values, answer=dict(ans))
        helper_now = {**{k: helper.get(k) for k in ("model", "effort")}, **values}  # its registration after the spawn

        def family_done() -> bool:
            kids = self.children(parent)
            return (len(kids) >= 2 and all(handed_back(self.agent_rows(k)) is not None for k in kids)
                    and last_handback_at(self.agent_rows(parent)) > max(last_handback_at(self.agent_rows(k)) for k in kids))
        if parent:
            self.wait("the helper's children", family_done, RUN_WAIT_S, 2.0)
        kids = self.children(parent) if parent else {}
        gp = next((k for k, t in kids.items() if t == GP), "")
        hp = next((k for k, t in kids.items() if t == HELPER_TYPE), "")
        pok, pdet = on_values(self.agent_rows(parent), values["model"], values["effort"]) if parent else (False, str(dict(ans)))
        gok, gdet = on_values(self.agent_rows(gp), values["model"], values["effort"]) if gp else (False, "no child")
        hok, hdet = (on_values(self.agent_rows(hp), str(helper_now.get("model") or ""), helper_now.get("effort"))
                     if hp else (False, "no child"))
        main_runs = sorted({(m, e) for _, m, e in assistant_runs(self.main_rows())}, key=str)
        self.result("descendants", pok and gok and hok,
                    f"parent thimble:helper {parent or '-'}: {pdet}; children {kids}; {GP} {gp or '-'} (wants the "
                    f"parent's run values): {gdet}; {HELPER_TYPE} {hp or '-'} (wants the helper's registration, which the "
                    f"bridge set to the run values; Settings' is {helper.get('model')!r}, {helper.get('effort')!r}): {hdet}; "
                    f"main runs on {main_runs}")
        self.shot("descendants")
        self.wait("main idle", self.idle, REPLY_WAIT_S)

        # /clear: the hello under the new session id, then a click's spawn through it
        self.term.keys("Escape")
        self.term.text("/clear")
        self.term.keys("Enter")
        cleared_at = time.time()

        def moved() -> str | None:
            sid = module_bridge._bridge(self.c).session
            return sid if sid and sid != old_sid and module_bridge.live(self.c) and module_bridge.main_session(self.c) == sid \
                else None
        new_sid = self.wait("the hello after /clear", moved, CLEAR_WAIT_S, 0.25)
        hello_s = time.time() - cleared_at
        if new_sid:
            self.wait("main's new transcript", lambda: (self.main_path() or Path()).stem == new_sid, REPLY_WAIT_S, 0.5)
            self.info["second_main"] = str(self.main_path() or "")
        rec = subagents.read(self.c).get("module") or {}
        self.shot("cleared")
        ans2 = self.on_loop(subagents.start_job(self.c, role, f"{subagents.TYPES[role].kind}:contract-2", ROLE_TASK, values,
                                                subagents.CLICK, description="contract check stop")) if new_sid else {}
        agent2 = str(ans2.get("agentId") or "")
        self.result("clear", bool(new_sid) and bool(agent2),
                    f"main's session {old_sid} → {new_sid or '(no new hello)'}, the hello accepted {hello_s:.1f} s "
                    f"after /clear was typed; subagents.json module {rec}; the spawn after it answered {dict(ans2) if ans2 else '(not tried)'}")
        if not agent2:
            raise RuntimeError("no spawn after /clear")

        # TaskStop through the bridge while that agent runs
        self.wait("the agent's first record", lambda: bool(self.agent_rows(agent2)), REPLY_WAIT_S, 0.2)
        stop_at = time.time()
        ran_before = handed_back(self.agent_rows(agent2)) is not None
        ans3 = self.on_loop(subagents.stop(self.c, agent2))
        self.note("stop", answer=dict(ans3), handed_back_before=ran_before)
        self.wait("the stopped agent's end", lambda: (subagents.agent(self.c, agent2) or {}).get("status")
                  in ("stopped", "done", "failed"), QUIET_S)
        time.sleep(QUIET_S)
        heard = main_rows_from(self.main_rows(), agent2, after=stop_at)
        status = (subagents.agent(self.c, agent2) or {}).get("status")
        after = [r for r in self.agent_rows(agent2) if when(r) > stop_at + 1 and r.get("type") == "assistant"]
        self.result("stop", bool(ans3.get("agentId")) and not ans3.get("done") and status == "stopped" and not after
                    and not any(heard.values()),
                    f"the bridge answered {dict(ans3)}; the agent had {'already' if ran_before else 'not'} handed back; "
                    f"its status {status!r}; its requests after the stop: {len(after)}; in main {QUIET_S:.0f} s after: "
                    f"{ {k: len(v) for k, v in heard.items()} } (hand-backs, notifications, main's calls naming it)")
        self.shot("stopped")

    # ---- helpers of the steps
    def healthy(self, url: str) -> bool:
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=2) as r:
                return r.status == 200
        except OSError:
            return False

    def idle(self) -> bool:
        """main between turns: its last transcript record is its own text, or the screen shows the prompt with no
        spinner. A rough reading, used only to space the steps."""
        rows = [r for r in self.main_rows() if r.get("type") in ("user", "assistant")]
        if not rows:
            return False
        last = rows[-1]
        content = (last.get("message") or {}).get("content")
        text_end = last.get("type") == "assistant" and isinstance(content, list) and content and \
            isinstance(content[-1], dict) and content[-1].get("type") == "text"
        return bool(text_end) and time.time() - when(last) > 3

    def answered(self, agent: str) -> bool:
        got = main_rows_from(self.main_rows(), agent)
        return bool(got["handbacks"]) and answered_after(self.main_rows(), when(got["handbacks"][0]))

    def hooks(self) -> dict:
        cmd = f"{sys.executable} -I {HERE / 'contract_hook.py'} {self.out / 'hooks.jsonl'}"
        return {event: [{"matcher": "*", "hooks": [{"type": "command", "command": cmd, "timeout": 10}]}]
                for event in ("PreToolUse", "SubagentStart", "SubagentStop")}

    def hook_inputs(self) -> list[dict]:
        return [r["in"] for r in jsonl(self.out / "hooks.jsonl") if isinstance(r.get("in"), dict)]

    def claude_env(self) -> dict[str, str]:
        env = {k: v for k, v in self.environ.items() if not SESSION_VARS.match(k)}
        env.update({"CLAUDE_CODE_DISABLE_AGENT_VIEW": "1", "DISABLE_AUTOUPDATER": "1"})
        return env

    def classifier(self) -> None:
        folder = self.out / "classifier"
        folder.mkdir(parents=True, exist_ok=True)
        env = {k: v for k, v in self.environ.items() if not SESSION_VARS.match(k)}
        env["CLAUDE_CODE_EFFORT_LEVEL"] = "high"
        r = subprocess.run([sys.executable, "-I", str(Path(__file__).resolve()), "--classifier-smoke", str(self.tree),
                            str(folder)], env=env, capture_output=True, text=True, timeout=600, check=False)
        (folder / "smoke.log").write_text(r.stdout + r.stderr, "utf-8")
        try:
            got = json.loads((folder / "smoke.json").read_text("utf-8"))
        except (OSError, ValueError):
            self.result("classifier", False, f"the smoke wrote no result (exit {r.returncode}; {folder / 'smoke.log'})")
            return
        self.result("classifier", *check_classifier(jsonl(folder / "argv.jsonl"), got["want"], got["status"]))

    def quit(self) -> None:
        term = self.term
        if term is None or not term.alive():
            if term is not None:
                self.result("quit", True, "main had ended already")
            return
        term.keys("Escape")
        term.text("/exit")
        term.keys("Enter")
        chose = None
        end = time.monotonic() + QUIT_WAIT_S
        while time.monotonic() < end and term.alive():
            screen = term.screen()
            moves = menu_moves(screen, EXIT_CHOICE)
            if moves is not None and chose is None:
                (self.out / "screens").mkdir(parents=True, exist_ok=True)
                (self.out / "screens" / "99-exit-dialog.txt").write_text(screen, "utf-8")
                term.keys(*(["Down"] * moves if moves > 0 else ["Up"] * -moves), "Enter")
                chose = moves
            time.sleep(1.0)
        ended = not term.alive()
        self.result("quit", ended, f"/exit{', then ' + EXIT_CHOICE if chose is not None else ''}; main "
                    f"{'ended' if ended else 'still ran, and its tmux session was stopped'}")
        term.stop()

    def evidence(self) -> None:
        dest = self.out / "transcripts"
        dest.mkdir(parents=True, exist_ok=True)
        for main in self.main_paths():
            if main.is_file():
                shutil.copy2(main, dest / f"main-{main.stem}.jsonl")
            sub = main.with_suffix("") / "subagents"
            if sub.is_dir():
                shutil.copytree(sub, dest / f"{main.stem}-subagents", dirs_exist_ok=True)
        if self.c:
            from app import config  # noqa: PLC0415

            ws = config.workspace_dir(self.c)
            (self.out / "workspace").mkdir(exist_ok=True)
            for name in ("subagents.json", "launch.json", "callers.jsonl"):
                if (ws / name).is_file():
                    shutil.copy2(ws / name, self.out / "workspace" / name)


# --------------------------------------------------------------------------------------------- the classifier smoke

def classifier_smoke(tree: Path, folder: Path) -> int:
    """One structured call on Settings' labels row with CLAUDE_CODE_EFFORT_LEVEL set (the caller set it), its `claude`
    a wrapper that logs its argv and that variable as the call gives it, then runs the real `claude`."""
    real = shutil.which("claude") or "claude"
    wrapper = folder / "claude"
    log = folder / "argv.jsonl"
    wrapper.write_text("#!/bin/sh\n"
                       f"{shlex.quote(sys.executable)} -I -c 'import json, os, sys; print(json.dumps({{\"argv\": sys.argv[1:], "
                       f"\"effort_env\": os.environ.get(\"CLAUDE_CODE_EFFORT_LEVEL\")}}))' \"$@\" >> {shlex.quote(str(log))}\n"
                       f"exec {shlex.quote(real)} \"$@\"\n")
    wrapper.chmod(0o755)
    os.environ["THIMBLE_CLAUDE_BIN"] = str(wrapper)
    sys.path.insert(0, str(tree / "backend"))
    from app import config, model  # noqa: PLC0415

    want = config.call_settings(None, "labels")
    tool = model.ToolSpec("answer", "Your answer.", {"type": "object", "properties": {"ok": {"type": "boolean"}},
                                                     "required": ["ok"]})
    res = asyncio.run(model.structured("Call the answer tool with ok true.", tool=tool, cwd=str(folder), **want))
    (folder / "smoke.json").write_text(json.dumps({"want": {"model": want["model"], "effort": want["effort"]},
                                                    "status": res.status, "detail": res.detail,
                                                    "model_used": res.model_used}, indent=1))
    return 0


# --------------------------------------------------------------------------------------------- main

def serve(check: Check) -> None:
    """thimble's server in this process, as `thimble server up` starts it (cli.start's environment and server.json, this
    process's pid), with the check in a thread beside it; the server stops when the check ends, or by itself once main
    has quit (session._stop_server)."""
    from app import cli, config  # noqa: PLC0415

    p, ui = cli.port(), cli.ui_port()
    env = cli.resolve_env()
    os.environ.update(cli._server_environ(env, p, ui))
    state = {"port": p, "pid": os.getpid(), "url": cli.api_url(p), "api": cli.api_url(p), "ui_port": ui, "vite_pid": None,
             "dev": False, "repo": str(config.REPO_ROOT), "started": now_iso(), "stopped": None,
             "env": {k: env[k] for k in cli.STATE_ENV_KEYS}, "token": cli.new_token()}
    cli.write_state(state)
    import uvicorn  # noqa: PLC0415

    from app.main import app  # noqa: PLC0415

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=p, loop="asyncio", log_level="info",
                                           timeout_graceful_shutdown=3))
    check.server = server
    driver = threading.Thread(target=check.run, name="contract-module", daemon=True)
    driver.start()
    # uvicorn raises the SIGTERM it caught again once it has shut down (the server stops itself after main quits,
    # cli.stop_self); this process goes on to write the check's results
    signal.signal(signal.SIGTERM, lambda *_: check.note("server-stopped", by="SIGTERM"))
    server.run()
    driver.join(timeout=QUIT_WAIT_S + 60)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--classifier-smoke"]:
        return classifier_smoke(Path(argv[1]).resolve(), Path(argv[2]).resolve())
    ap = argparse.ArgumentParser()
    ap.add_argument("tree")
    ap.add_argument("corpus")
    ap.add_argument("out")
    ap.add_argument("--results", help="results.jsonl of e2e_release.sh, to append each assertion to")
    ap.add_argument("--socket", default="thimble-contract", help="the tmux server's name (tmux -L)")
    ap.add_argument("--main-model", help="main's --model (default: the analyst's own settings)")
    opts = ap.parse_args(argv)
    if not os.environ.get("THIMBLE_HOME"):
        print("contract_module: set THIMBLE_HOME (and THIMBLE_PORT, THIMBLE_UI_PORT) to the run's own", file=sys.stderr)
        return 2
    tree, corpus, out = Path(opts.tree).resolve(), Path(opts.corpus).resolve(), Path(opts.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    environ = dict(os.environ)
    sys.path.insert(0, str(tree / "backend"))
    from app import cli  # noqa: PLC0415

    if cli.healthy(cli.api_url()):
        print(f"contract_module: a server answers on port {cli.port()}; stop it first", file=sys.stderr)
        return 2
    check = Check(opts, tree, corpus, out, environ)
    serve(check)
    rows = []
    for name, title in ASSERTIONS.items():
        ok, detail = check.results.get(name, (False, "not reached"))
        rows.append({"step": f"contract-module-{name}", "title": f"Interactive module contract: {title}",
                     "status": "pass" if ok else "fail", "detail": detail, "shots": []})
    (out / "summary.json").write_text(json.dumps({"info": check.info, "workspace": check.c, "assertions": rows},
                                                 indent=1, default=str))
    if opts.results:
        with open(opts.results, "a", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
    for row in rows:
        print(f"contract-module {row['step'].removeprefix('contract-module-')}: {row['status']} ({row['detail'][:400]})",
              flush=True)
    return 0 if all(r["status"] == "pass" for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
