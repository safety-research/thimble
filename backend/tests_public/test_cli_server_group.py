"""The `server` group of app.cli: `thimble server up | status | repair | stop | restart`. `server up` is `up` with
the same flags and output, exit 0 whatever happens; `ensure` is its alias; `server status` is the status
line and starts nothing; `server repair` is fix."""
from __future__ import annotations

from pathlib import Path

import pytest

from app import cli

pytestmark = pytest.mark.usefixtures("named_sessions")


def _up_fakes(monkeypatch, home: Path) -> list:
    """A healthy server without a process: ensure_running and healthy say yes, _request records the posts."""
    monkeypatch.setattr(cli, "ensure_running", lambda wait: True)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    cli.write_state({"port": 8300, "url": "http://127.0.0.1:5300", "env": {}})
    posted: list = []
    def fake_request(m, u, b=None, timeout=5.0):
        if m == "GET":  # the resume line's read of the holdings; not a registration
            return 404, None
        posted.append((u, b))
        return 201, {"name": Path(b["path"]).name}

    monkeypatch.setattr(cli, "_request", fake_request)
    return posted


def test_the_tree_parses_and_up_takes_the_flags():
    ap = cli.build_parser()
    args = ap.parse_args(["server", "up", "--cwd", "/c", "--session", "s", "--action", ""])
    assert args.cmd == "server" and args.fn is cli.cmd_server_up
    assert (args.cwd, args.session, args.action) == ("/c", "s", "")
    assert ap.parse_args(["server", "ensure"]).fn is cli.cmd_server_up, "`ensure` is up's alias inside the group"
    assert ap.parse_args(["server", "status", "--cwd", "/c"]).fn is cli.cmd_server_status
    assert ap.parse_args(["server", "repair"]).fn is cli.cmd_server_repair
    assert ap.parse_args(["server", "stop"]).fn is cli.cmd_stop
    assert ap.parse_args(["server", "restart", "--keep-vite"]).fn is cli.cmd_restart
    for words in (["ensure"], ["up"], ["stop"], ["restart"], ["doctor"], ["fix"], ["revert"], ["update"]):
        assert ap.parse_args(words).cmd == words[0]
    with pytest.raises(SystemExit):
        ap.parse_args(["server"])
    with pytest.raises(SystemExit):
        ap.parse_args(["server", "nope"])
    with pytest.raises(SystemExit):
        ap.parse_args(["server", "up", "--quiet"])


def test_server_up_prints_what_up_prints_and_opens_the_sessions_folder(home, data, monkeypatch, capsys, tmp_path):
    posted = _up_fakes(monkeypatch, home)
    rc = cli.main(["server", "up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"])
    via_group = capsys.readouterr().out
    rc2 = cli.main(["ensure", "--cwd", str(data / "mini" / "agents"), "--session", "s9"])
    via_ensure = capsys.readouterr().out
    assert rc == rc2 == 0 and via_group == via_ensure, "one starter, two spellings"
    assert via_group.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=mini"]
    assert posted == [], "a folder inside the data dir is known: nothing to register"
    folder = tmp_path / "calls"
    folder.mkdir()
    assert cli.main(["server", "up", "--cwd", str(folder), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls"]
    assert posted == [("http://127.0.0.1:8300/api/corpora/register", {"path": str(folder), "exact": True})]
    assert cli.main(["server", "up", "--cwd", str(tmp_path / "bare")]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/"]
    assert len(posted) == 1, "a bare up registers nothing"


def test_server_up_never_raises_and_exits_zero(home, monkeypatch, capsys):
    def boom(wait):
        raise RuntimeError("no")

    monkeypatch.setattr(cli, "ensure_running", boom)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    assert cli.main(["server", "up"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("thimble: ") and "Traceback" not in out


def test_server_status_is_the_status_line_and_starts_nothing(home, data, monkeypatch, capsys):
    started = []
    monkeypatch.setattr(cli, "ensure_running", lambda wait: started.append(1) or True)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    rc = cli.main(["server", "status", "--cwd", str(data / "mini")])
    out = capsys.readouterr().out.strip()
    assert rc == 0 and started == []
    assert out == "thimble: server down at http://127.0.0.1:8300; orientation: not started; queue: n/a"
    cli.main(["ensure", "--cwd", str(data / "mini"), "--action", "status"])
    assert capsys.readouterr().out.strip() == out, "the same line as `ensure --action status`"


def test_server_repair_stop_and_restart_reach_the_existing_commands(home, monkeypatch, capsys):
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "doctor_text", lambda: "thimble doctor\n  server: up")
    assert cli.main(["server", "repair"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("thimble doctor") and out.rstrip().endswith(cli.FIX_INSTRUCTION)
    monkeypatch.setattr(cli, "stop", lambda vite=True, kernels=True: ["thimble: stopped pid 1"])
    assert cli.main(["server", "stop"]) == 0 and capsys.readouterr().out == "thimble: stopped pid 1\n"
    seen = {}

    def fake_restart(keep_vite=False):
        seen["keep"] = keep_vite
        return ["thimble: restarted"]

    monkeypatch.setattr(cli, "restart", fake_restart)
    monkeypatch.setattr(cli, "running_work", lambda url: [])
    assert cli.main(["server", "restart", "--keep-vite"]) == 0 and seen == {"keep": True}
    assert capsys.readouterr().out == "thimble: restarted\n"


def test_revert_prints_plain_words_and_starts_a_stopped_server_only_after_a_revert(home, monkeypatch, capsys):
    """`thimble revert` says what it took back, or that there was nothing to revert, in a sentence rather than the
    route's JSON. With the server down it starts the server only when a change was taken back."""
    from app import dev

    started: list[int] = []
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "restart", lambda keep_vite=False: started.append(1) or ["server up at http://127.0.0.1:1"])
    monkeypatch.setattr(dev, "revert_last_apply", lambda: {"ok": False, "error": "nothing to revert"})
    assert cli.main(["revert"]) == 1
    assert capsys.readouterr().out == "thimble: nothing to revert\n" and started == []
    monkeypatch.setattr(dev, "revert_last_apply", lambda: {"ok": True, "title": "dim the gridlines",
                                                           "commit": "abcdef1234", "touched": ["README.md"]})
    assert cli.main(["revert"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.REVERTED_LINE.format(title="dim the gridlines", commit="abcdef1"),
                                                    "server up at http://127.0.0.1:1"]
    assert started == [1]
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (409, {"detail": "a ticket is running"}))
    assert cli.main(["revert"]) == 1 and capsys.readouterr().out == "thimble: could not revert: a ticket is running\n"
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (200, {"ok": True, "title": "x", "commit": "1234567",
                                                                 "restart": "restarting"}))
    assert cli.main(["revert"]) == 0
    assert capsys.readouterr().out.splitlines()[1] == "thimble: the server restarts with it" and started == [1]


def test_restart_names_what_runs_and_asks_before_it_stops_anything(home, monkeypatch, capsys):
    """`thimble server restart` names what runs, says what comes back by itself, and asks; no answer, or no terminal
    to answer in, restarts nothing, and `--yes` skips the question for scripts."""
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    work = ["board-sim: the orientation", "trials: the writer \"Write report\""]
    monkeypatch.setattr(cli, "running_work", lambda url: list(work))
    restarts: list[bool] = []
    monkeypatch.setattr(cli, "restart", lambda keep_vite=False: restarts.append(keep_vite) or ["thimble: restarted"])
    answers: list = []
    monkeypatch.setattr(cli, "confirm", lambda question: answers.pop(0))
    said = [cli.RUNNING_HEAD, *(f"  {w}" for w in work), cli.RUNNING_BACK_LINE]

    answers.append(False)
    assert cli.main(["server", "restart"]) == 1 and restarts == []
    assert capsys.readouterr().out.splitlines() == [*said, cli.RESTART_DECLINED_LINE]
    answers.append(None)
    assert cli.main(["restart"]) == 1 and restarts == []
    assert capsys.readouterr().out.splitlines() == [*said, cli.RESTART_UNASKED_LINE]
    answers.append(True)
    assert cli.main(["server", "restart"]) == 0 and restarts == [False]
    assert capsys.readouterr().out.splitlines() == [*said, "thimble: restarted"]

    monkeypatch.setattr(cli, "running_work", lambda url: pytest.fail("--yes asks nothing"))
    assert cli.main(["server", "restart", "--yes", "--keep-vite"]) == 0 and restarts == [False, True]
    assert cli.main(["restart", "-y"]) == 0 and len(restarts) == 3
    assert capsys.readouterr().out.splitlines() == ["thimble: restarted", "thimble: restarted"]


def test_running_work_names_each_run_and_whether_it_resumes(home, monkeypatch):
    """The lines come from the server's list of what it runs and its dev runner's status; a server without that list
    still names the orientations its run.json says run."""
    running = [{"workspace": "board-sim", "kind": "orient", "title": "Orientation", "run": 0, "resumes": True},
               {"workspace": "trials", "kind": "orient", "title": "Orientation", "run": 2, "resumes": True},
               {"workspace": "trials", "kind": "writer", "title": "Write report", "run": 0, "resumes": True},
               {"workspace": "trials", "kind": "check", "title": "Numbers match", "run": 0, "resumes": False},
               {"workspace": "agent-runs", "kind": "view", "title": "Edit timeline", "resumes": True}]
    answers = {"/api/sessions/running": (200, running),
               "/api/dev/status": (200, {"running": True, "current": {"title": "Darker accent", "workspace": "trials"}})}
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: answers[u.split("8300", 1)[1]])
    assert cli.running_work("http://127.0.0.1:8300") == [
        "board-sim: the orientation", "trials: the orientation (follow-up 2)", 'trials: the writer "Write report"',
        f'trials: the report check "Numbers match"{cli.RUNNING_ENDS}', 'agent-runs: the view build "Edit timeline"',
        'trials: the dev ticket "Darker accent"']
    answers.update({"/api/sessions/running": (404, {"detail": "Not Found"}), "/api/dev/status": (200, {"running": False})})
    monkeypatch.setattr(cli, "_workspace_names", lambda d: ["board-sim", "trials"])
    monkeypatch.setattr(cli, "orient_status", lambda c: "running" if c == "trials" else "done")
    assert cli.running_work("http://127.0.0.1:8300") == ["trials: the orientation"]


def test_the_source_change_restart_asks_nothing(home, monkeypatch):
    """The restart `up` spawns after a source change has found the server idle, and runs with no terminal."""
    argvs: list = []
    monkeypatch.setattr(cli, "spawn", lambda argv, **kw: argvs.append(argv) or 4242)
    assert cli.spawn_restart() == 4242
    assert argvs[0][-3:] == ["restart", "--keep-vite", "--yes"]


def test_the_help_names_the_tree_and_the_alias():
    ap = cli.build_parser()
    assert ap.prog == "thimble"
    text = ap.format_help()
    assert "usage: thimble" in text and "server" in text and "ensure" in text
    sub = next(a for a in ap._subparsers._group_actions if getattr(a, "choices", None) and "server" in a.choices)
    srv_help = sub.choices["server"].format_help()
    assert "usage: thimble server" in srv_help and "up (ensure)" in srv_help
    for word in ("status", "repair", "stop", "restart"):
        assert word in srv_help
