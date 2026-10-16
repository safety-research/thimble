"""Activation (app/activate.py, contracts C1, C2): `thimble activate` refuses a folder too broad to be a corpus, and
otherwise registers the folder, marks it active for the plugin's hooks, writes the hooks module's roles file, records
the session in launch.json (as main, or as a peer beside a live main) and writes the session marker and its guide
marker; a second call changes only `mod`, eight calls at once do the work once, and write_launch is launch.json's one
writer. --rekey-from carries a session's files to the id /clear or /resume gives it."""
from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from app import activate, cli, config, guide, subagent_files

APP = Path(__file__).resolve().parent.parent / "app"
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


def test_a_bad_via_or_session_is_an_error_not_a_crash(corpus):
    assert activate.activate(corpus, "s", "sideways")["error"]["code"] == "IO"
    assert activate.activate(corpus, "///", "data")["error"]["code"] == "IO"


# --------------------------------------------------------------------------- what activation writes


def test_activation_registers_the_folder_and_writes_the_session_s_files(corpus):
    got = _ok(activate.activate(corpus, "s-1", "data", mod=True))
    c = config.workspace_for_cwd(str(corpus))
    assert c and got["ws"] == c and got["role"] == "main" and got["first_in_folder"] is True
    assert got["path"] == str(config.workspace_dir(c)) and got["took_over"] is None
    assert got["settings"] == {k: True for k in ("autoActivate", "viewProposals", "labels", "checks",
                                                 "citationMarks", "coverage", "cardCheck")}
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


def test_a_second_call_keeps_the_session_and_takes_mod_but_never_drops_it(corpus):
    first = _ok(activate.activate(corpus, "s-2", "tool"))
    marker = guide.marker("s-2")
    assert json.loads(activate.marker_path("s-2").read_text())["mod"] is False
    again = _ok(activate.activate(corpus, "s-2", "data", mod=True))
    rec = json.loads(activate.marker_path("s-2").read_text())
    assert rec["mod"] is True and rec["via"] == "tool", "the earlier activation's via is kept"
    assert again["first_in_folder"] is False and again["ws"] == first["ws"]
    _ok(activate.activate(corpus, "s-2", "command"))
    assert json.loads(activate.marker_path("s-2").read_text())["mod"] is True, "never set back to false"
    assert guide.marker("s-2") == marker


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


def test_eight_activations_in_eight_processes_do_the_work_once(corpus, tmp_path):
    env = {**os.environ, "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR)}
    procs = [subprocess.Popen([sys.executable, "-m", "app.activate", "activate", "--cwd", str(corpus), "--session",
                               "s-p8", "--via", "data", "--mod", "--json"], cwd=str(APP.parent), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(8)]
    outs = [json.loads(p.communicate(timeout=60)[0]) for p in procs]
    assert all(o["ok"] for o in outs) and sum(o["first_in_folder"] for o in outs) == 1
    assert len({o["ws"] for o in outs}) == 1


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


def test_a_dead_main_is_replaced_without_a_takeover(corpus):
    _ok(activate.activate(corpus, "s-old", "data"))  # no claude process: its pid is none
    got = _ok(activate.activate(corpus, "s-new", "data"))
    assert got["role"] == "main" and got["took_over"] is None
    assert activate.read_launch(config.workspace_for_cwd(str(corpus)))["session"] == "s-new"


def test_write_launch_keeps_every_field_under_eight_writers(corpus):
    _ok(activate.activate(corpus, "s-w", "data"))
    c = config.workspace_for_cwd(str(corpus))
    path = config.workspace_dir(c) / "trusted" / "launch.json"
    rec = json.loads(path.read_text())
    path.write_text(json.dumps({**rec, "switches": {"X": "1"}, "unset": ["Y"], "modules_off": "why"}))
    threads = [threading.Thread(target=activate.write_launch, args=(c, f"p{i}"),
                                kwargs={"role": "peer", "transport": "local", "via": "data"}) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    rec = json.loads(path.read_text())
    assert sorted(rec["peers"]) == [f"p{i}" for i in range(8)]
    assert rec["switches"] == {"X": "1"} and rec["unset"] == ["Y"] and rec["modules_off"] == "why"
    assert rec["session"] == "s-w" and rec["transport"] == "local"
    rec = activate.write_launch(c, "s-w", role="main", transport="server", via="press", pid=4242)
    assert rec["transport"] == "server" and rec["pid"] == 4242 and len(rec["peers"]) == 8
    assert activate.transport(c) == "server" and activate.transport(c, "p3") == "local"
    with pytest.raises(ValueError):
        activate.write_launch(c, "s-w", role="boss", transport="local", via="data")


WRITES = re.compile(r"atomic_write_text\(|\.write_text\(|write_json\(|json\.dump\(|write_private\(|atomic_write_bytes\(")
NAMES = re.compile(r"LAUNCH_FILE|LAUNCH_LOCK|launch_path\(|launch\.json")
# launch.json writers outside activate.py that another lane removes, each with why (SPEC-v2 3.7, 5.2)
WRITERS_LEFT = {("cli.py", "launch_record"): "the runtime lane routes the launcher's record through write_launch"}


def test_write_launch_is_launch_json_s_one_writer():
    """A grep over backend/app: every function that names launch.json and writes a file is activate.py's (its writer
    and its lock), or one another lane removes (WRITERS_LEFT)."""
    found = set()
    for p in sorted(APP.glob("*.py")):
        src = p.read_text("utf-8")
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                seg = ast.get_source_segment(src, node) or ""
                body = seg.split('"""', 2)[-1] if seg.count('"""') >= 2 else seg
                if NAMES.search(body) and WRITES.search(body):
                    found.add((p.name, node.name))
    assert found - set(WRITERS_LEFT) <= {("activate.py", "write_launch"), ("activate.py", "_launch_locked")}, found


# --------------------------------------------------------------------------- /clear and /resume


def test_rekey_keeps_the_marker_for_resume_and_makes_a_new_one_for_clear(corpus):
    _ok(activate.activate(corpus, "s-a", "data", mod=True))
    old = guide.marker("s-a")
    guide.mark(str(corpus), "s-a")
    _ok(activate.activate(corpus, "s-resumed", "data", rekey_from="s-a", reason="resume"))
    assert guide.marker("s-resumed") == old and not guide.owed(str(corpus), "s-resumed")
    assert json.loads(activate.marker_path("s-resumed").read_text())["mod"] is True, "mod is kept"
    _ok(activate.activate(corpus, "s-cleared", "data", rekey_from="s-a", reason="clear"))
    assert guide.marker("s-cleared") != old and guide.owed(str(corpus), "s-cleared")
    assert json.loads(activate.marker_path("s-cleared").read_text())["mod"] is True
    assert guide.marker("s-a") == old, "the old session's files stay"


def test_the_command_line_answers_json_and_exits_0(corpus, capsys):
    assert activate.main(["activate", "--cwd", str(corpus), "--session", "s-cli", "--via", "command", "--mod",
                          "--json"]) == 0
    got = json.loads(capsys.readouterr().out)
    assert got["ok"] and got["session"] == "s-cli"
    assert activate.main(["activate", "--cwd", "/", "--session", "s-cli2", "--via", "command", "--json"]) == 0
    got = json.loads(capsys.readouterr().out)
    assert not got["ok"] and got["error"]["code"] == "REFUSED_ROOT"


def test_listed_json_records_the_names_and_when(corpus):
    rec = activate.write_listed("s-l", ["b", "a"])
    assert rec["names"] == ["a", "b"] and rec["count"] == 2 and rec["at"] > 0 and len(rec["digest"]) == 40
    assert activate.read_listed("s-l") == rec
    assert (activate.session_dir("s-l") / activate.LISTED_FILE).stat().st_mode & 0o777 == 0o600
