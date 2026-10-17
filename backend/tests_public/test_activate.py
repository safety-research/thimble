"""Activation (app/activate.py, contracts C1, C2): `thimble activate` refuses a folder too broad to be a corpus, and
otherwise registers the folder, marks it active for the plugin's hooks, writes the hooks module's roles file, records
the session in launch.json (as main, or as a peer beside a live main) and writes the session marker and its guide
marker; a second call changes only `mod`, eight calls at once do the work once, and write_launch is launch.json's one
writer. --rekey-from carries a session's files to the id /clear or /resume gives it."""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from pathlib import Path

import pytest

from app import activate, cli, config, subagent_files

REGISTER_HERE = cli.register_here  # the real one, which conftest's _launch_writes_nothing_shared replaces in every test


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp):
    """A data folder outside the home folder, a home folder of the test's own, and a data folder for the registry."""
    monkeypatch.setenv("HOME", str(tmp_path / "home" / "me"))
    (tmp_path / "home" / "me").mkdir(parents=True)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(workspaces_tmp))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    monkeypatch.delenv("CLAUDE_PID", raising=False)
    monkeypatch.setattr(activate, "refresh_later", activate.refresh)  # the roles file at once, not in a detached process
    monkeypatch.setattr(cli, "register_here", REGISTER_HERE)  # into the test's own data folder
    d = tmp_path / "runs"
    d.mkdir()
    (d / "events.jsonl").write_text('{"a": 1}\n')
    return d


def _ok(got: dict) -> dict:
    assert got.get("ok"), got
    return got


# --------------------------------------------------------------------------- refusals


def test_activation_refuses_a_folder_too_broad_to_be_a_corpus(tmp_path, monkeypatch, corpus):
    home = Path(os.environ["HOME"])
    (tmp_path / "linked").symlink_to(home)
    thimble_home = Path(os.environ["THIMBLE_HOME"])
    thimble_home.mkdir(parents=True, exist_ok=True)
    (tmp_path / "cc").mkdir(exist_ok=True)
    mounted = tmp_path / "disk"
    mounted.mkdir()
    monkeypatch.setattr(activate, "mount_points", lambda path="/proc/mounts": {str(mounted)})
    for folder, code in ((home, "REFUSED_HOME"), (Path("/"), "REFUSED_ROOT"), (tmp_path / "linked", "REFUSED_HOME"),
                         (tmp_path / "home", "REFUSED_BROAD"), (tmp_path, "REFUSED_BROAD"),
                         (thimble_home, "REFUSED_HOME"), (tmp_path / "cc", "REFUSED_HOME"), (mounted, "REFUSED_ROOT")):
        got = activate.activate(folder, "s-refused", "command")
        assert not got["ok"] and got["error"]["code"] == code, (folder, got)
        assert got["error"]["message"] == activate.REFUSED_MESSAGE and got["error"]["fix"]
    assert not activate.marker_path("s-refused").exists()
    assert config.workspace_for_cwd(str(home)) is None, "nothing registered"
    assert activate.refusal(corpus) is None


# --------------------------------------------------------------------------- what activation writes


def test_activation_registers_the_folder_and_writes_the_session_s_files(corpus):
    got = _ok(activate.activate(corpus, "s-1", "data", mod=True))
    c = config.workspace_for_cwd(str(corpus))
    assert c and got["ws"] == c and got["role"] == "main" and got["first_in_folder"] is True
    assert got["path"] == str(config.workspace_dir(c)) and got["took_over"] is None
    assert got["settings"] == {k: True for k in ("viewProposals", "labels", "checks", "citationMarks", "coverage",
                                                 "cardCheck")}
    home = Path(os.environ["THIMBLE_HOME"])
    assert all((home / cli.ACTIVE_DIR / key).is_file() for key in cli.active_keys(corpus)), "the folder marker"
    ws = config.workspace_dir(c)
    assert subagent_files.roles_path(ws).is_file(), "the hooks module's roles file"
    launch = json.loads((ws / "trusted" / "launch.json").read_text())
    assert launch["session"] == "s-1" and launch["transport"] == "local" and launch["via"] == "data"
    assert launch["peers"] == [] and launch["moved"] == []
    marker = json.loads(activate.marker_path("s-1").read_text())
    assert {k: marker[k] for k in ("cwd", "ws", "path", "via", "role", "mod")} == {
        "cwd": str(corpus), "ws": c, "path": str(ws), "via": "data", "role": "main", "mod": True}
    assert activate.marker_path("s-1").stat().st_mode & 0o777 == 0o600
    gm = activate.session_dir("s-1") / activate.GUIDE_MARKER
    assert re.fullmatch(r"[0-9a-f]{8}\n", gm.read_text()) and gm.stat().st_mode & 0o777 == 0o600
    assert (home / "up").stat().st_mode & 0o777 == 0o700


def test_eight_activations_at_once_do_the_work_once(corpus, monkeypatch):
    calls: list[str] = []
    real = activate._register
    monkeypatch.setattr(activate, "_register", lambda cwd: calls.append(cwd) or real(cwd))
    results: list[dict] = []
    threads = [threading.Thread(target=lambda: results.append(activate.activate(corpus, "s-8", "data", mod=True)))
               for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == 8 and all(r["ok"] for r in results)
    assert len(calls) == 1, "one registration"
    assert len({r["ws"] for r in results}) == 1 and sum(r["first_in_folder"] for r in results) == 1


# --------------------------------------------------------------------------- launch.json: main, peers, take over


@pytest.fixture()
def live_claude(tmp_path):
    """A process named `claude` with Claude Code's record of it naming a session, as cli.live_launch reads one: the
    pid and a function that names the session."""
    exe = tmp_path / "bin" / "claude"
    exe.parent.mkdir()
    exe.symlink_to("/bin/sleep")
    p = subprocess.Popen([str(exe), "60"])
    sessions = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)

    def names(sid: str) -> int:
        (sessions / f"{p.pid}.json").write_text(json.dumps({"sessionId": sid, "pid": p.pid}))
        return p.pid

    yield names
    p.kill()
    p.wait()


def test_a_second_session_beside_a_live_main_is_a_peer_and_a_press_takes_main(corpus, live_claude, monkeypatch):
    from app import cc_plugin

    pid = live_claude("s-main")
    monkeypatch.setattr(cc_plugin, "claude_pid", lambda environ=None: pid)  # main's `claude` is that process
    _ok(activate.activate(corpus, "s-main", "data"))
    monkeypatch.setattr(cc_plugin, "claude_pid", lambda environ=None: None)
    c = config.workspace_for_cwd(str(corpus))
    assert activate.main_alive(c)
    peer = _ok(activate.activate(corpus, "s-peer", "data"))
    assert peer["role"] == "peer" and peer["took_over"] is None
    rec = activate.read_launch(c)
    assert rec["session"] == "s-main" and rec["peers"] == ["s-peer"]
    assert activate.transport(c, "s-peer") == "local" and activate.transport(c, "s-main") == "local"
    tool = _ok(activate.activate(corpus, "s-tool", "tool"))
    assert tool["role"] == "peer", "a model's load_thimble beside a live main makes a peer"
    press = _ok(activate.activate(corpus, "s-press", "press"))
    assert press["role"] == "main" and press["took_over"] == "s-main"
    rec = activate.read_launch(c)
    assert rec["session"] == "s-press" and "s-main" in rec["moved"] and "s-press" not in rec["peers"]
    from app import notices

    assert any(n.get("key") == activate.TAKEOVER_KEY for n in notices.open_notices(c))


def test_the_conversation_main_s_process_moved_to_takes_main_with_no_takeover(corpus, live_claude, monkeypatch):
    """Bug hunt 7, H10: after /clear, /thimble restore brought back a workspace whose launch.json names the conversation
    before the /clear, and taking main posted "thimble's browser follows the other session in this folder now" and
    put that conversation under `moved`, though no other session ran. The conversation main's own `claude` process
    moved to is the same session: it takes main with no notice, keeps main's transport and leaves `moved` empty, both
    when the workspace recorded the move (subagents.json) and when only the process shows it."""
    from app import cc_plugin, notices

    pid = live_claude("s-before")
    monkeypatch.setattr(cc_plugin, "claude_pid", lambda environ=None: pid)
    _ok(activate.activate(corpus, "s-before", "command"))
    c = config.workspace_for_cwd(str(corpus))
    activate.write_launch(c, "s-before", role="main", transport="server", via="press")
    # /clear: the same `claude` runs the new conversation, and the hook recorded the move in the workspace
    live_claude("s-after")
    with subagent_files.update(config.workspace_path(c)) as state:
        subagent_files.rekey(state, "s-before", "s-after")
    assert activate.take_main(c, "s-after", "press") is None
    rec = activate.read_launch(c)
    assert (rec["session"], rec["moved"], rec["transport"]) == ("s-after", [], "server")
    # a restored workspace that names the conversation before a /clear it never saw: the process shows the move
    activate.write_launch(c, "s-before", role="main", transport="server", via="press")
    live_claude("s-later")
    assert _ok(activate.activate(corpus, "s-later", "data"))["role"] == "main"
    assert activate.read_launch(c)["transport"] == "server", "the same terminal keeps main's transport"
    activate.write_launch(c, "s-before", role="main", transport="server", via="press")
    assert activate.take_main(c, "s-later", "press") is None
    assert activate.read_launch(c)["moved"] == []
    assert not any(n.get("key") == activate.TAKEOVER_KEY for n in notices.open_notices(c))
    # another `claude` that runs the session before is another session: a takeover, as before
    monkeypatch.setattr(cc_plugin, "claude_pid", lambda environ=None: None)
    assert _ok(activate.activate(corpus, "s-other", "press"))["took_over"] == "s-later"
    assert any(n.get("key") == activate.TAKEOVER_KEY for n in notices.open_notices(c))
