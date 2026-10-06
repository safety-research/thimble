"""Run an orientation on a corpus through an interactive main, to pre-cache a workspace (the demo's).

    <tree>/backend/.venv/bin/python scripts/dev/precache_orientation.py <tree> <corpus folder> <log folder>
        [--mode auto|default|bypassPermissions] [--no-report] [--critique] [--model M] [--effort E]
        [--socket NAME] [--attach]

Run it in the environment the server runs in, with a home and ports of its own (THIMBLE_HOME, THIMBLE_PORT,
THIMBLE_UI_PORT; it refuses to run without THIMBLE_HOME), and the server up. thimble's agents are subagents that its
plugin module starts in an interactive main, and the module does nothing in `claude -p` (spike V3), so this drives one:
  - it registers the folder and starts the launcher (<tree>/plugin/bin/thimble, with `--permission-mode <mode>`) in the
    corpus folder, in a tmux server of its own (`tmux -L <socket>`), with CLAUDE_CODE_DISABLE_AGENT_VIEW=1 and
    DISABLE_AUTOUPDATER=1; it answers the folder-trust question if Claude Code asks it;
  - it waits for the module's hello (subagents.json's `module`), then presses Start as the browser does, with the
    page's key (the ui_key cookie of server.json): POST /api/ws/<c>/start with the deck, views and report on and the
    critique off (--no-report turns the report off, --critique the critique on; --model and --effort name the run's,
    else Settings decide);
  - every STATUS_S it writes <log folder>/status.json, what the workspace holds and whether it is done (the orientation
    ended, no view build or writer runs, and a report asked for is written), and the terminal's screen to
    <log folder>/screen.txt;
  - once done, it quits main with /exit, choosing "Exit and stop tasks" if Claude Code asks, and stops its tmux server.
--attach skips the Start (a run already going). Every step goes to <log folder>/events.jsonl.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

STATUS_S = 30.0
HELLO_WAIT_S = 180.0  # the launcher, Claude Code's start and the module's hello
QUIT_WAIT_S = 60.0
SESSION = "precache"
TRUST_WORDS = ("Do you trust", "Yes, proceed", "trust this folder")
EXIT_CHOICE = "Exit and stop tasks"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def options(argv: "list[str] | None" = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("tree")
    ap.add_argument("corpus")
    ap.add_argument("logs")
    ap.add_argument("--mode", default="auto", choices=("auto", "default", "bypassPermissions"))
    ap.add_argument("--no-report", action="store_true")
    ap.add_argument("--critique", action="store_true")
    ap.add_argument("--model")
    ap.add_argument("--effort")
    ap.add_argument("--socket", default="precache", help="the tmux server's name (tmux -L)")
    ap.add_argument("--attach", action="store_true")
    return ap.parse_args(argv)


class Terminal:
    """main's terminal: a tmux session on a server of its own, so nothing else on the machine is touched."""

    def __init__(self, socket: str) -> None:
        self.socket = socket

    def tmux(self, *args: str, check: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run(["tmux", "-L", self.socket, *args], capture_output=True, text=True, check=check)

    def start(self, cwd: str, command: str) -> None:
        self.tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "-c", cwd, command, check=True)

    def screen(self) -> str:
        return self.tmux("capture-pane", "-p", "-t", SESSION).stdout

    def keys(self, *keys: str) -> None:
        self.tmux("send-keys", "-t", SESSION, *keys)

    def text(self, text: str) -> None:
        self.tmux("send-keys", "-t", SESSION, "-l", text)

    def alive(self) -> bool:
        return self.tmux("has-session", "-t", SESSION).returncode == 0

    def stop(self) -> None:
        self.tmux("kill-server")


def menu_moves(screen: str, choice: str) -> int | None:
    """How many lines down (negative: up) the menu's cursor (❯) must move to reach `choice`; None when the screen shows
    no menu with it."""
    lines = screen.splitlines()
    at = next((i for i, ln in enumerate(lines) if choice in ln), None)
    cursor = next((i for i, ln in enumerate(lines) if ln.lstrip().startswith("❯")), None)
    if at is None or cursor is None:
        return None
    return at - cursor


def launch_command(tree: Path, mode: str, environ: "dict[str, str]") -> str:
    """The shell command tmux runs: the launcher with main's permission mode, in an environment with the agent view
    off, no auto-update, and the caller's thimble home and ports (and Claude Code's config folder, when set)."""
    env = {"CLAUDE_CODE_DISABLE_AGENT_VIEW": "1", "DISABLE_AUTOUPDATER": "1",
           **{k: environ[k] for k in ("THIMBLE_HOME", "THIMBLE_PORT", "THIMBLE_UI_PORT", "CLAUDE_CONFIG_DIR")
              if environ.get(k)}}
    launcher = [str(tree / "plugin" / "bin" / "thimble"), "--permission-mode", mode]
    return " ".join(["env", *(f"{k}={shlex.quote(v)}" for k, v in env.items()), *map(shlex.quote, launcher)])


def start_body(opts: argparse.Namespace) -> dict[str, Any]:
    """Start as the browser's gate sends it: the deck, views and report on, the critique off, no focus; the run's model
    and effort only when named."""
    return {"text": "", "deck": True, "views": True, "report": not opts.no_report, "critique": opts.critique,
            **({"model": opts.model} if opts.model else {}), **({"effort": opts.effort} if opts.effort else {})}


def read(p: Path):
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def hello(ws: Path) -> "dict | None":
    """The module's accepted hello in subagents.json (`module`: {session, version, at}), None while it has none."""
    module = (read(ws / "subagents.json") or {}).get("module")
    if isinstance(module, dict) and module.get("session") and module.get("version") and not module.get("idle"):
        return module
    return None


def status(ws: Path, c: str, report: bool) -> dict:
    run = read(ws / "orient" / "run.json") or {}
    chats = [m for m in (read(p) for p in (ws / "chats").glob("*.meta.json")) if isinstance(m, dict)]
    running = sorted(f"{m.get('role') or m.get('kind')}:{m.get('title') or m.get('id')}" for m in chats
                     if m.get("status") == "running" and m.get("id") != "main")
    props = read(ws / "views" / "proposals.json")
    rows = props if isinstance(props, list) else (props or {}).get("proposals") or []
    proposals = {str(r.get("slug") or r.get("name")): str(r.get("status") or r.get("state")) for r in rows
                 if isinstance(r, dict)}
    views = sorted(p.parent.name for p in (ws / "extension" / "views").glob("*/view.json")
                   if (read(p) or {}).get("built"))
    docs = sorted({p.stem for p in (ws / "investigations").glob("*/*.json")} - {"investigation"})
    ended = run.get("status") in ("done", "failed", "stopped", "refused")
    done = ended and not running and (not report or "report" not in (run.get("passes") or []) or "report" in docs)
    return {"at": now(), "workspace": c, "orientation": run.get("status"), "refused": run.get("refused"),
            "passes": run.get("passes"), "model": run.get("model"), "effort": run.get("effort"),
            "started": run.get("started"), "ended": run.get("ended"), "running": running, "proposals": proposals,
            "views": views, "documents": docs, "done": done}


def press_start(url: str, cookie: str, body: dict[str, Any]) -> tuple[int, Any]:
    """POST the Start with the page's cookie, as the browser sends it (the click routes take only the analyst's)."""
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Cookie": cookie})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:500]
    except OSError as e:
        return 0, str(e)


def quit_main(term: Terminal, note: Callable[..., None]) -> None:
    """/exit, and "Exit and stop tasks" when Claude Code asks what to do with the tasks still running; never "Move to
    background" (CLAUDE_CODE_DISABLE_AGENT_VIEW=1 removes it, and the cursor only moves up or down)."""
    if not term.alive():
        return
    term.keys("Escape")
    term.text("/exit")
    term.keys("Enter")
    deadline = time.monotonic() + QUIT_WAIT_S
    while time.monotonic() < deadline and term.alive():
        moves = menu_moves(term.screen(), EXIT_CHOICE)
        if moves is not None:
            term.keys(*(["Down"] * moves if moves > 0 else ["Up"] * -moves), "Enter")
            note("exit-and-stop-tasks", moves=moves)
        time.sleep(1.0)
    note("quit", ended=not term.alive())


def main() -> int:
    opts = options()
    if not os.environ.get("THIMBLE_HOME"):
        print("precache_orientation: set THIMBLE_HOME (and THIMBLE_PORT, THIMBLE_UI_PORT) to the server's own",
              file=sys.stderr)
        return 2
    tree, corpus, logs = Path(opts.tree).resolve(), str(Path(opts.corpus).resolve()), Path(opts.logs).resolve()
    sys.path.insert(0, str(tree / "backend"))
    logs.mkdir(parents=True, exist_ok=True)
    from app import cli, config, hook_auth  # noqa: PLC0415

    def note(kind: str, **fields: Any) -> None:
        with (logs / "events.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": now(), "kind": kind, **fields}, ensure_ascii=False) + "\n")

    status_code, body = cli._request("POST", f"{cli.api_url()}/api/corpora/register", {"path": corpus}, timeout=30)
    if status_code not in (200, 201) or not isinstance(body, dict) or not body.get("name"):
        print(f"precache_orientation: register {corpus} → {status_code} {str(body)[:300]}", file=sys.stderr)
        return 1
    c = str(body["name"])
    ws = config.workspace_dir(c)
    note("registered", workspace=c, url=cli.ui_url(c, key=False))

    term = Terminal(opts.socket)
    command = launch_command(tree, opts.mode, dict(os.environ))
    launched = time.time()
    term.start(corpus, command)
    note("launched", command=command, socket=opts.socket)
    try:
        said = None
        deadline = time.monotonic() + HELLO_WAIT_S
        while time.monotonic() < deadline and term.alive():
            if any(w in term.screen() for w in TRUST_WORDS):
                term.keys("Enter")
                note("trusted")
            said = hello(ws)
            if said:
                break
            time.sleep(1.0)
        (logs / "screen.txt").write_text(term.screen(), "utf-8")
        if said is None:
            module = (read(ws / "subagents.json") or {}).get("module")
            print(f"precache_orientation: no hello from thimble's module within {HELLO_WAIT_S:.0f} s ({module})",
                  file=sys.stderr)
            return 1
        note("hello", module=said, after_s=round(time.time() - launched, 1))
        if not opts.attach:
            start = start_body(opts)
            cookie = f"{hook_auth.ui_cookie()}={cli.read_state().get('ui_key') or ''}"
            s, res = press_start(f"{cli.api_url()}/api/ws/{c}/start", cookie, start)
            note("start", status=s, result=res, payload=start)
            if s != 200 or not isinstance(res, dict) or res.get("kind") or not res.get("agentId"):
                print(f"precache_orientation: Start → {s} {str(res)[:300]}", file=sys.stderr)
                return 1
        st: dict = {}
        while True:
            st = status(ws, c, not opts.no_report)
            (logs / "status.json").write_text(json.dumps(st, indent=1), "utf-8")
            (logs / "screen.txt").write_text(term.screen(), "utf-8")
            if st["done"] or not term.alive():
                note("done" if st["done"] else "main-ended", status=st)
                break
            time.sleep(STATUS_S)
        quit_main(term, note)
        return 0 if st.get("done") else 1
    finally:
        term.stop()


if __name__ == "__main__":
    sys.exit(main())
