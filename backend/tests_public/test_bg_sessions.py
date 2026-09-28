"""thimble's agents as Claude Code background sessions in terminal-first mode (bg_session.py): a writer starts as a
`claude --bg` session named thimble:writer, its run ends when the session is idle with its turn ended while the session
goes on, a turn the session starts on its own is followed as the chat's next run, and a message for it waits in its
outbox for the tray entry (the proxy) to send, which the relay hook swaps in, once. The proxy's wait returns the
session's news, the stop hook keeps it going while its session runs, and a second proxy is told to stop. A restart
follows a running session again; a session whose process went away leaves its chat stopped. The statusline and
/thimble:agents list every running agent, and the hooks print a start and a finish line once.

A stand-in CLI (FAKE_BG) keeps its sessions in a JSON file: `claude --bg` starts one and writes its transcript,
`--bg --resume` wakes a stopped one under its id, `agents --json` lists them and `stop` ends one's process."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

from app import agent_session, agents, bg_session, channel, config, ledger, session, tools, write_session

CORPUS = "mini"

FAKE_BG = r'''
import json, os, sys, uuid
from pathlib import Path
out = Path(os.environ["FAKE_DIR"])
state_path = out / "sessions.json"
state = json.loads(state_path.read_text()) if state_path.exists() else {}
argv = sys.argv[1:]
with open(out / "argvs.jsonl", "a") as f:
    f.write(json.dumps(argv) + "\n")
proj = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-corpus"
proj.mkdir(parents=True, exist_ok=True)
def put(sid, *recs):
    with open(proj / f"{sid}.jsonl", "a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
def turn(sid, prompt, reply, end=True):
    error = reply.startswith("API Error")
    put(sid, {"type": "user", "message": {"role": "user", "content": prompt}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}, **({"isApiErrorMessage": True} if error else {})},
        *([{"type": "system", "subtype": "turn_duration"}] if end else []))
if argv[:1] == ["agents"]:
    print(json.dumps([{"id": s["sid"][:8], "sessionId": s["sid"], "kind": "background", "name": s["name"],
                       "status": s["status"], "pid": s["pid"], "cwd": s["cwd"], "state": s.get("state", "working")}
                      for s in state.values()]))
    sys.exit(0)
if argv[:1] == ["stop"]:
    state[argv[1]]["pid"], state[argv[1]]["state"] = None, "stopped"
    state_path.write_text(json.dumps(state))
    print("stopped " + argv[1])
    sys.exit(0)
if "--bg" in argv:
    prompt = argv[argv.index("--") + 1]
    if "--resume" in argv:
        sid = argv[argv.index("--resume") + 1]
        s = state[sid[:8]]
        s["pid"], s["status"], s["state"] = 4242, "idle", "working"
        turn(sid, prompt, "carried on")
    else:
        if (Path.cwd() / ".thimble-first-message.md").exists() and "first message is in" in prompt:
            prompt = (Path.cwd() / ".thimble-first-message.md").read_text()
        sid = str(uuid.uuid4())
        name = argv[argv.index("-n") + 1]
        busy = os.environ.get("FAKE_BUSY") == "1"  # the session keeps working until the test says otherwise
        s = state[sid[:8]] = {"sid": sid, "name": name, "status": "busy" if busy else "idle", "pid": 4242, "cwd": os.getcwd()}
        turn(sid, prompt, os.environ.get("FAKE_REPLY", "Wrote the report."), end=not busy)
    state_path.write_text(json.dumps(state))
    print(f"backgrounded · {sid[:8]} · {s['name']}")
    sys.exit(0)
sys.exit(2)
'''


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    session._live.clear()
    channel._subs.clear()
    agent_session._runs.clear()
    agent_session._launches.clear()
    bg_session._entries.clear()
    bg_session._loaded.clear()
    bg_session._announced.clear()
    bg_session._announced_loaded.clear()
    bg_session._forking.clear()
    monkeypatch.setattr(bg_session, "_closing", False)
    monkeypatch.setattr(bg_session, "POLL_S", 0.05)
    monkeypatch.setattr(bg_session, "START_GRACE_S", 0.0)
    monkeypatch.setattr(bg_session, "WAIT_S", 0.3)
    monkeypatch.setattr(agent_session, "POLL_S", 0.05)
    yield
    if bg_session._task is not None:
        bg_session._task.cancel()
        bg_session._task = None
    channel._subs.clear()
    agent_session._runs.clear()
    bg_session._entries.clear()


@pytest.fixture()
def fake(tmp_path, monkeypatch) -> Path:
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n{FAKE_BG}")
    script.chmod(0o755)
    out = tmp_path / "fake"
    out.mkdir()
    cfg = tmp_path / "claude-config"
    cfg.mkdir()
    # main runs in the corpus folder, which the analyst trusted when Claude Code first asked
    (cfg / ".claude.json").write_text(json.dumps({"projects": {str(config.corpus_dir(CORPUS)): {"hasTrustDialogAccepted": True}}}))
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(script))
    monkeypatch.setenv("FAKE_DIR", str(out))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    ledger.put_settings(CORPUS, {"terminal_first": True, ledger.TERMINAL_FIRST_CONSENT: True})
    return out


def _bg_calls(fake: Path) -> list[list[str]]:
    return [a for a in map(json.loads, (fake / "argvs.jsonl").read_text().splitlines()) if "--bg" in a]


def _state(fake: Path) -> dict:
    return json.loads((fake / "sessions.json").read_text())


def _transcript(sid: str) -> Path:
    return Path(session.find_transcript(sid) or "")


async def _until(cond, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        await asyncio.sleep(0.05)


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _proxy_transcript(tmp_path: Path, agent_id: str, *recs: dict, key: str = "writer:report") -> Path:
    """A tray entry's transcript: its first prompt names its instructions file, as main's Agent call gives it."""
    path = tmp_path / f"agent-{agent_id}.jsonl"
    first = {"type": "user", "message": {"role": "user", "content": str(bg_session.proxy_file(CORPUS, key))}}
    path.write_text("".join(json.dumps(r) + "\n" for r in (first, *recs)))
    return path


def test_uninstall_puts_back_the_statusline_and_the_trust_before_it_removes_anything(tmp_path, monkeypatch):
    """`thimble uninstall` runs `python -m app.claude_changes undo` with the tree's Python, before any removal: every
    corpus folder's statusline is the analyst's own again and every work folder's trust is taken back."""
    import subprocess

    from app import cc_settings, claude_changes

    home = tmp_path / "home"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / ".claude.json").write_text(json.dumps({"projects": {}}))
    corpus = tmp_path / "corpus-copy"
    local = corpus / ".claude" / "settings.local.json"
    local.parent.mkdir(parents=True)
    local.write_text(json.dumps({"statusLine": {"type": "command", "command": "my-line"}}))
    cc_settings.set_statusline(corpus, "thimble-agents --statusline --chain my-line")
    claude_changes.consent()
    work = (config.WORKSPACES_DIR / CORPUS / "writers" / "report").resolve()
    work.mkdir(parents=True)
    assert bg_session.trust_workspaces(work, {config.CONFIG_DIR_ENV: str(cfg)})
    user = tmp_path / "user"
    user.mkdir()
    env = {"HOME": str(user), "THIMBLE_HOME": str(home), "PATH": "/usr/bin:/bin"}
    r = subprocess.run(["bash", str(config.REPO_ROOT / "plugin" / "bin" / "thimble"), "uninstall", "--yes", "--keep-home"],
                       capture_output=True, text=True, env=env, timeout=60)
    assert "put back what terminal-first changed in Claude Code's files" in r.stdout, r.stdout + r.stderr
    assert json.loads(local.read_text())["statusLine"] == {"type": "command", "command": "my-line"}
    assert str(work) not in json.loads((cfg / ".claude.json").read_text())["projects"]
    assert claude_changes.statuslines() == {} and json.loads((home / claude_changes.TRUST_FILE).read_text()) == {}
    assert r.stdout.index("put back what terminal-first") < r.stdout.index("is kept (--keep-home)")
