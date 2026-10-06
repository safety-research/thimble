"""Run an orientation on a corpus with no model in main, to pre-cache a workspace (the demo's).

    <tree>/backend/.venv/bin/python scripts/dev/precache_orientation.py <tree> <corpus folder> <log folder>
        [--mode auto|manual|bypass] [--no-report] [--critique] [--attach]

Run it in the environment the server runs in (THIMBLE_HOME, THIMBLE_PORT, THIMBLE_WORKSPACES_DIR), with the server up.
It registers the folder, then stands in for the analyst's Claude Code session as
scripts/e2e/standin_session.py does: it holds the shim's subscription (GET /api/events), names itself main, takes
main's events as the plugin's watcher does (GET /api/events/pull, then POST /api/events/ack) and reports main's
permission mode (`--mode`, auto by default, as a session whose Claude Code settings say `defaultMode: auto` reports
it). It presses Start as the browser's
Start gate sends it with its defaults (deck, views and report on, the critique off, Ultracode, no instructions;
--no-report turns the report off, --critique the critique on) and answers the events main.md asks main to act on: `start` with start_orientation and `write`
with start_writing, each with the event's attributes. Every event goes to <log folder>/events.jsonl, and
<log folder>/status.json says every STATUS_S what the workspace holds and whether it is done: the orientation ended,
no view build or writer runs, and a report asked for is written. --attach skips the Start (a run already going).

It runs until killed, since main's end stops the workspace's view builds; stop it once status.json says done.
"""
import argparse
import html
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path

STATUS_S = 30.0

ap = argparse.ArgumentParser()
ap.add_argument("tree")
ap.add_argument("corpus")
ap.add_argument("logs")
ap.add_argument("--mode", default="auto", choices=("auto", "manual", "bypass"))
ap.add_argument("--no-report", action="store_true")
ap.add_argument("--critique", action="store_true")
ap.add_argument("--attach", action="store_true")
opts = ap.parse_args()
tree, corpus, logs = Path(opts.tree).resolve(), str(Path(opts.corpus).resolve()), Path(opts.logs).resolve()
sys.path.insert(0, str(tree / "backend"))
logs.mkdir(parents=True, exist_ok=True)

import httpx  # noqa: E402

from app import cli, config, hook_auth  # noqa: E402

SESSION = str(uuid.uuid4())
CLAUDE_MODE = {"auto": "auto", "manual": "default", "bypass": "bypassPermissions"}[opts.mode]
lock = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def note(kind: str, **fields) -> None:
    with lock, (logs / "events.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"at": now(), "kind": kind, **fields}, ensure_ascii=False) + "\n")


def api(method: str, path: str, body: dict | None = None, timeout: float = 30.0):
    return cli._request(method, f"{cli.api_url()}{path}", body, timeout=timeout)


def call(tool: str, args: dict) -> None:
    status, res = api("POST", f"/api/tools/{tool}", {"args": args, "cwd": corpus,
                                                      "tool_use_id": f"toolu_standin_{secrets.token_hex(8)}"}, 600.0)
    note("call", tool=tool, args=args, status=status, result=res)


def act(meta: dict, content: str) -> None:
    kind = meta.get("kind")
    if kind == "start":  # the Start sends no instructions, so the event's text is describe()'s line, not a brief
        args = {"brief": "", **{k: meta[k] == "true" for k in ("final_notebook", "propose_views", "generate_report",
                                                                "critique") if k in meta}}
        call("start_orientation", args)
    elif kind == "write":
        args = {"doc": meta.get("doc") or "report", "request": "", **({"after": meta["after"]} if meta.get("after") else {})}
        call("start_writing", args)


EVENT_RE = re.compile(r"<thimble-event ([^>]*)>\n(.*)\n</thimble-event>\s*$", re.S)  # events.render
ATTR_RE = re.compile(r'([A-Za-z0-9_]+)="([^"]*)"')


def listen(ready: threading.Event) -> None:
    """The shim's subscription: on its `ready`, name this session main in the workspace it names and report the mode."""
    query = urllib.parse.urlencode({"cwd": corpus, "session": SESSION, "pid": os.getpid(),
                                    "delivery": "hook", "config_dir": ""})
    while True:
        try:
            tok = hook_auth.token()
            headers = hook_auth.headers(tok, secrets.token_hex(16)) if tok else {}
            with httpx.Client(timeout=httpx.Timeout(None, connect=3.0)) as client:
                with client.stream("GET", f"{cli.api_url()}/api/events?{query}", headers=headers) as resp:
                    note("subscribed", status=resp.status_code)
                    for line in resp.iter_lines():
                        if line.startswith("data:") and "workspace" in line:
                            ws = json.loads(line[5:].strip())["workspace"]
                            s, res = api("POST", f"/api/ws/{urllib.parse.quote(ws)}/session",
                                         {"session": SESSION, "cwd": corpus})
                            note("named", status=s, result=res)
                            api("POST", "/api/events/mode", {"cwd": corpus, "session": SESSION,
                                                             "permission_mode": CLAUDE_MODE})
                            ready.set()
        except httpx.HTTPError as e:
            note("dropped", error=f"{type(e).__name__}: {e}")
        time.sleep(1.0)


def watch() -> None:
    """The plugin's watcher: take main's next event, acknowledge it, and act on it in a thread of its own."""
    query = urllib.parse.urlencode({"cwd": corpus, "session": SESSION, "pid": os.getpid(), "wait": 30})
    while True:
        status, body = api("GET", f"/api/events/pull?{query}", timeout=60.0)
        if status == 200 and isinstance(body, dict) and body.get("id"):
            api("POST", "/api/events/ack", {"cwd": corpus, "session": SESSION, "id": body["id"]})
            m = EVENT_RE.match(str(body.get("text") or ""))
            meta = {k: html.unescape(v) for k, v in ATTR_RE.findall(m.group(1))} if m else {}
            content = m.group(2) if m else str(body.get("text") or "")
            note("event", meta=meta, content=content[:2000])
            threading.Thread(target=act, args=(meta, content), daemon=True).start()
        elif status != 204:
            note("pull", status=status, result=str(body)[:300])
            time.sleep(1.0)


def read(p: Path):
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def status(c: str, report: bool) -> dict:
    ws = config.workspace_dir(c)
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
    ended = run.get("status") in ("done", "failed", "stopped")
    done = ended and not running and (not report or "report" not in (run.get("passes") or []) or "report" in docs)
    return {"at": now(), "workspace": c, "orientation": run.get("status"), "passes": run.get("passes"),
            "started": run.get("started"), "ended": run.get("ended"), "running": running, "proposals": proposals,
            "views": views, "documents": docs, "done": done}


def main() -> int:
    status_code, body = api("POST", "/api/corpora/register", {"path": corpus})
    if status_code not in (200, 201) or not isinstance(body, dict) or not body.get("name"):
        print(f"precache_orientation: register {corpus} → {status_code} {str(body)[:300]}", file=sys.stderr)
        return 1
    c = str(body["name"])
    note("registered", workspace=c, session=SESSION, url=cli.ui_url(c))
    ready = threading.Event()
    threading.Thread(target=listen, args=(ready,), daemon=True).start()
    if not ready.wait(60):
        print("precache_orientation: the subscription did not open", file=sys.stderr)
        return 1
    threading.Thread(target=watch, daemon=True).start()
    if not opts.attach:
        start = {"final_notebook": True, "propose_views": True, "generate_report": not opts.no_report,
                 "critique": opts.critique, "ultracode": True, "effort": "xhigh"}
        s, res = api("POST", f"/api/ws/{c}/events", {"kind": "start", "payload": start})
        note("start", status=s, result=res, payload=start)
    while True:
        (logs / "status.json").write_text(json.dumps(status(c, not opts.no_report), indent=1), "utf-8")
        time.sleep(STATUS_S)


if __name__ == "__main__":
    sys.exit(main())
