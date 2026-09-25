"""The server's lifecycle under the supervisor (app.cli): which recorded process is trusted as the server, what `stop`
ends (the server answering on the port when the record is stale, the workspaces' kernels by their records, never
another program), a restart that hands the kernels over and announces itself, the restart after a source change that
waits until the server is idle, and `/thimble restore` with the archives it lists and restores. The stand-in
processes run `sleep` under a server's command line on port 8398, where nothing listens."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app import cli, config, procs
from test_cli import (SERVER_LIKE, _free_port, _healthy_no_process, _healthy_with_state, _restart_seam,  # noqa: F401
                      _started, fake)

pytestmark = pytest.mark.usefixtures("named_sessions")


def _stop_all(*ps: subprocess.Popen) -> None:
    for p in ps:
        if p.poll() is None:
            p.kill()
            p.wait(5)


# ----------------------------------------------------------------------------- which process is the server


def test_a_record_that_names_no_thimble_server_is_cleared_and_the_server_on_the_port_adopted(home, monkeypatch):
    """server.json's pid is trusted only while it is a thimble server on its port: a live pid that is some other
    process is cleared, and a healthy server of this checkout on the port is adopted by the leader its /api/health
    names. A Vite pid that is no Vite any more goes too."""
    other = _started(subprocess.Popen(["sleep", "60"], start_new_session=True), "sleep 60")
    ours = _started(subprocess.Popen(SERVER_LIKE, start_new_session=True, cwd=cli.BACKEND_DIR))
    try:
        cli.write_state({"port": 8398, "pid": other.pid, "vite_pid": other.pid, "repo": str(config.REPO_ROOT)})
        assert cli.owned() is False, "alive is not enough"
        st = cli.reconcile()
        assert st["pid"] is None and st["vite_pid"] is None and cli.read_state()["pid"] is None
        monkeypatch.setattr(cli, "health_leader", lambda url=None: other.pid)
        assert cli.reconcile()["pid"] is None, "a leader that is no thimble server is not adopted"
        monkeypatch.setattr(cli, "health_leader", lambda url=None: ours.pid if url == "http://127.0.0.1:8398" else None)
        assert cli.reconcile()["pid"] == ours.pid and cli.owned() is True
        assert "not a thimble server on port 8398; cleared" in cli.log_path().read_text()
        assert f"adopted the thimble server on port 8398, pid {ours.pid}" in cli.log_path().read_text()
    finally:
        _stop_all(other, ours)


def test_server_check_works_without_proc_through_ps(home, monkeypatch):
    monkeypatch.setattr(procs, "HAVE_PROC", False)
    ours = _started(subprocess.Popen(SERVER_LIKE, start_new_session=True, cwd=cli.BACKEND_DIR))
    other = _started(subprocess.Popen(["sleep", "60"], start_new_session=True), "sleep 60")
    try:
        assert cli.server_check(8398)(ours.pid) is None
        assert cli.server_check(8398)(other.pid).startswith("its command line is 'sleep 60'")
        assert cli.session_pids(ours.pid) == []
        cli.write_state({"port": 8398, "pid": ours.pid, "vite_pid": None})
        assert cli.stop()[1] in (f"server: pid {ours.pid} stopped", f"server: pid {ours.pid} killed")
        ours.wait(5)
        assert other.poll() is None
    finally:
        _stop_all(ours, other)


# ----------------------------------------------------------------------------- stop


def test_stop_with_a_stale_record_stops_the_server_answering_on_the_port(home, monkeypatch):
    """server.json names a pid that is no thimble server while the real server runs on: stop refuses the recorded pid,
    then stops the server that answers on the port when it is this checkout's."""
    other = _started(subprocess.Popen(["sleep", "60"], start_new_session=True), "sleep 60")
    ours = _started(subprocess.Popen(SERVER_LIKE, start_new_session=True, cwd=cli.BACKEND_DIR))
    try:
        monkeypatch.setattr(cli, "health_leader", lambda url=None: ours.pid)
        monkeypatch.setattr(cli, "stop_kernels", lambda ws_dir=None: "kernels: none running")
        cli.write_state({"port": 8398, "pid": other.pid, "vite_pid": None})
        lines = cli.stop()
        assert "not ours" in lines[1] and lines[2] in (f"server: pid {ours.pid} stopped", f"server: pid {ours.pid} killed")
        ours.wait(5)
        assert other.poll() is None, "the recorded pid that is no thimble server is left alone"
        assert cli.read_state()["pid"] is None
    finally:
        _stop_all(other, ours)


def test_stop_ends_the_kernels_before_the_server_and_sweeps_once_more_after(home, monkeypatch):
    order: list[str] = []
    monkeypatch.setattr(cli, "stop_kernels", lambda ws_dir=None: (order.append("kernels"), "kernels: none running")[1])
    monkeypatch.setattr(cli, "_kill", lambda pid, check, label: (order.append(label), f"{label}: not running")[1])
    cli.write_state({"port": 8398, "pid": None, "vite_pid": None})
    assert cli.stop() == ["kernels: none running", "server: not running"], "no Vite recorded, no Vite line"
    assert order == ["kernels", "server", "kernels"]
    order.clear()
    cli.write_state({"port": 8398, "pid": None, "vite_pid": 4242})
    assert cli.stop(kernels=False) == ["server: not running", "vite: not running"] and order == ["server", "vite"]
    sweeps = iter(["kernels: none running", "kernels: 1 stopped"])
    monkeypatch.setattr(cli, "stop_kernels", lambda ws_dir=None: next(sweeps))
    assert cli.stop() == ["kernels: none running", "server: not running", "kernels: 1 stopped"]


def test_stop_ends_the_workspaces_kernels_by_their_records_and_restart_keeps_them(home, tmp_path, monkeypatch):
    ws_dir = tmp_path / "ws"
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(ws_dir))
    kd = ws_dir / "mini" / cli.KERNELS_DIR
    kd.mkdir(parents=True)
    conn_a, conn_b, conn_c = kd / "shared.conn.json", kd / "k-nb1.conn.json", kd / "k-nb2.conn.json"
    for f in (conn_a, conn_b, conn_c):
        f.write_text("{}")
    sleeper = "import time; time.sleep(60)"
    recorded = _started(subprocess.Popen([sys.executable, "-c", sleeper, "ipykernel_launcher", "-f", str(conn_a)],
                                         start_new_session=True), "ipykernel_launcher")
    other = _started(subprocess.Popen([sys.executable, "-c", sleeper], start_new_session=True), sleeper)
    orphan = _started(subprocess.Popen([sys.executable, "-c", sleeper, "ipykernel_launcher", "-f", str(conn_c)],
                                       start_new_session=True), "ipykernel_launcher")
    try:
        (kd / "shared.json").write_text(json.dumps({"name": None, "pid": recorded.pid, "pgid": recorded.pid,
                                                    "connection_file": str(conn_a)}))
        (kd / "k-nb1.json").write_text(json.dumps({"name": "nb1", "pid": other.pid, "pgid": other.pid,
                                                   "connection_file": str(conn_b)}))
        found = {conn: pid for pid, _pgid, conn, _rec in cli.kernel_processes(ws_dir)}
        assert found == {str(conn_a): recorded.pid, str(conn_b): 0, str(conn_c): orphan.pid}
        cli.write_state({"port": _free_port(), "pid": None, "vite_pid": None})
        monkeypatch.setattr(cli, "_kill", lambda pid, must, label: f"{label}: not running")
        assert cli.stop(kernels=False) == ["server: not running"]
        assert recorded.poll() is None and orphan.poll() is None
        lines = cli.stop()
        assert lines[0].startswith("kernels: 2 stopped") and lines[1:] == ["server: not running"]
        recorded.wait(5)
        orphan.wait(5)
        assert other.poll() is None, "a recorded pid whose command line is no kernel is never signalled"
        assert not (kd / "shared.json").exists() and not conn_a.exists()
        assert not (kd / "k-nb1.json").exists() and not conn_b.exists()
        assert cli.stop()[0] == "kernels: none running"
    finally:
        _stop_all(recorded, other, orphan)


# ----------------------------------------------------------------------------- restart


def test_stop_names_what_runs_and_asks_before_it_stops_anything(home, monkeypatch, capsys):
    """`thimble server stop` while the server runs a writer or a view build names them, says what the next start brings
    back, and asks; no answer, or no terminal to answer in, stops nothing, and `--yes` skips the question."""
    work = ['mini: the writer "Write report"', 'mini: the view build "Session timeline"']
    monkeypatch.setattr(cli, "running_work", lambda url: list(work))
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    stops: list[int] = []
    monkeypatch.setattr(cli, "stop", lambda **kw: stops.append(1) or ["server: stopped"])
    answers: list = []
    monkeypatch.setattr(cli, "confirm", lambda question: answers.pop(0))
    said = [cli.RUNNING_HEAD, *(f"  {w}" for w in work), cli.STOP_BACK_LINE]
    answers.append(False)
    assert cli.main(["server", "stop"]) == 1 and stops == []
    assert capsys.readouterr().out.splitlines() == [*said, cli.STOP_DECLINED_LINE]
    answers.append(None)
    assert cli.main(["stop"]) == 1 and stops == []
    assert capsys.readouterr().out.splitlines() == [*said, cli.STOP_UNASKED_LINE]
    answers.append(True)
    assert cli.main(["stop"]) == 0 and stops == [1]
    assert capsys.readouterr().out.splitlines() == [*said, "server: stopped"]
    monkeypatch.setattr(cli, "running_work", lambda url: pytest.fail("--yes asks nothing"))
    assert cli.main(["server", "stop", "--yes"]) == 0 and cli.main(["stop", "-y"]) == 0 and stops == [1, 1, 1]


def test_the_source_change_restart_waits_while_a_view_build_runs(home, monkeypatch):
    """busy_reason names a session or view build the server runs, which its other checks do not see, so the
    source-change restart waits for it."""
    monkeypatch.setattr(cli, "_workspace_names", lambda d: [])
    monkeypatch.setattr(cli, "_request", lambda method, url, body=None, timeout=5.0: (200, {}))
    monkeypatch.setattr(cli, "running_work", lambda url: ['mini: the view build "Session timeline"'])
    assert cli.busy_reason("http://127.0.0.1:1") == 'it runs mini: the view build "Session timeline"'
    monkeypatch.setattr(cli, "running_work", lambda url: [])
    assert cli.busy_reason("http://127.0.0.1:1") is None


def test_a_restart_hands_the_server_s_kernels_over_before_it_stops_it(home, monkeypatch):
    """stop(kernels=False), a restart's stop, leaves the hand-off naming the server's pid before the server gets its
    SIGTERM, so the server leaves its kernels running for the next one; a stop leaves none. A hand-off older than
    HANDOFF_S names no one, and clear_kernel_handoff removes only the one naming its pid."""
    stand_in = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        cli.write_state({"pid": stand_in.pid, "port": 1})
        seen = []
        monkeypatch.setattr(cli, "_kill", lambda pid, check, label: (seen.append((label, cli.kernel_handoff())), "")[1])
        monkeypatch.setattr(cli, "stop_kernels", lambda ws_dir=None: "kernels: none running")
        monkeypatch.setattr(cli, "listening", lambda p: False)
        cli.stop(vite=False, kernels=True)
        assert seen == [("server", None)], "a stop hands nothing over"
        cli.write_state({"pid": stand_in.pid, "port": 1})  # the stop cleared it
        cli.stop(vite=False, kernels=False)
        assert seen[-1] == ("server", stand_in.pid)
    finally:
        _stop_all(stand_in)
    cli.clear_kernel_handoff(stand_in.pid + 1)
    assert cli.kernel_handoff() == stand_in.pid, "another pid's clear leaves it"
    cli.clear_kernel_handoff(stand_in.pid)
    assert cli.kernel_handoff() is None and not (home / cli.KERNEL_HANDOFF).exists()
    (home / cli.KERNEL_HANDOFF).write_text(json.dumps({"pid": 7, "ts": time.time() - cli.HANDOFF_S - 1}))
    assert cli.kernel_handoff() is None, "stale"


def test_restart_stops_starts_and_announces(fake, home, monkeypatch):
    posted = []
    stops: list = []
    monkeypatch.setattr(cli, "stop", lambda **kw: (stops.append(kw), ["server: not running", "vite: not running"])[1])
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: (posted.append((m, u)), (200, {}))[1])
    lines = cli.restart()
    assert stops == [{"vite": True, "kernels": False}]
    assert lines[-1] == "server up at http://127.0.0.1:8300"
    assert posted == [("POST", "http://127.0.0.1:8300/api/dev/announce")]
    assert sum(1 for c in fake.calls if "uvicorn" in c["cmd"]) == 1
    rec = json.loads((home / "restart.json").read_text())
    assert rec["title"] == "manual restart" and rec["ts"]
    (home / "restart.json").write_text(json.dumps({"title": "darker accent", "ts": "t"}) + "\n")
    cli.restart()
    assert json.loads((home / "restart.json").read_text())["title"] == "darker accent", "a dev apply's reason stays"


def test_up_with_an_equal_fingerprint_does_not_restart(home, monkeypatch):
    _healthy_with_state(monkeypatch, cli.source_fingerprint())
    calls = _restart_seam(monkeypatch)
    monkeypatch.setattr(cli, "busy_reason", lambda url: None)
    cli.NOTICES.clear()
    assert cli.ensure_running(2.0) is True
    assert calls == [] and cli.NOTICES == [] and cli.read_state()["pid"] == 4242
    _healthy_with_state(monkeypatch, "")
    assert cli.ensure_running(2.0) is True and calls == [] and cli.NOTICES == []


def test_up_with_a_changed_fingerprint_restarts_only_when_idle(home, data, monkeypatch, capsys):
    _healthy_with_state(monkeypatch, "stale")
    calls = _restart_seam(monkeypatch)
    reasons = ["an orientation is running in mini"]
    monkeypatch.setattr(cli, "busy_reason", lambda url: reasons[0])
    cli.NOTICES.clear()
    assert cli.ensure_running(2.0) is True
    assert calls == [] and cli.NOTICES == [cli.NOT_RESTARTED_LINE.format(reason="an orientation is running in mini")]
    assert cli.read_state()["pid"] == 4242 and "source_restart" not in cli.read_state()
    assert not (home / "restart.json").exists()
    reasons[0] = None
    cli.NOTICES.clear()
    assert cli.ensure_running(2.0) is True
    assert calls == [1] and cli.NOTICES == [cli.RESTARTED_LINE] and cli.read_state()["pid"] == 5151
    assert json.loads((home / "restart.json").read_text())["title"] == cli.SOURCE_CHANGED
    cli.NOTICES.clear()
    assert cli.ensure_running(2.0) is True and calls == [1] and cli.NOTICES == []
    _healthy_with_state(monkeypatch, "stale")
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: (200, {}))
    assert cli.main(["ensure", "--cwd", str(data / "mini")]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:8300/?ws=mini", cli.RESTARTED_LINE]
    assert calls == [1, 1]
    _healthy_with_state(monkeypatch, "stale")
    reasons[0] = "2 jobs running and 0 queued"
    assert cli.main(["up", "--cwd", str(data / "mini")]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:8300/?ws=mini",
                                                    cli.NOT_RESTARTED_LINE.format(reason="2 jobs running and 0 queued")]
    assert "2 jobs running and 0 queued" in cli.log_path().read_text()


def test_a_restart_under_way_is_waited_for_not_repeated(home, monkeypatch):
    _healthy_with_state(monkeypatch, "stale")
    calls = _restart_seam(monkeypatch)
    monkeypatch.setattr(cli, "busy_reason", lambda url: None)
    st = cli.read_state()
    st["source_restart"] = {"requested": time.time(), "old_pid": 4242, "by": 1}
    cli.write_state(st)
    cli.NOTICES.clear()
    assert cli.ensure_running(0.3) is False and calls == []
    st["source_restart"]["requested"] = time.time() - cli.RESTART_MARK_S - 1
    cli.write_state(st)
    assert cli.ensure_running(2.0) is True and calls == [1] and cli.NOTICES == [cli.RESTARTED_LINE]


# ----------------------------------------------------------------------------- resuming a run


def test_up_says_it_resumes_the_last_run_when_the_workspace_holds_something(home, data, monkeypatch, capsys, tmp_path):
    """RESUME_LINE under the URL when `GET /api/tools/holdings` counts a card, a label, a document or a chat someone
    wrote in; nothing for an empty workspace, a folder opened just now (never asked), or a server that does not answer
    (an older server, a transport failure, a fake that raises), so the URL line never waits on it."""
    _healthy_no_process(monkeypatch)
    asked: list[str] = []
    held = {"workspace": "mini", "cards": 12, "labels": 3, "documents": ["report"], "chats": 2,
            "text": "12 cards, 3 labels, document report"}

    def request(method, url, body=None, timeout=5.0, answer=held):
        if method == "POST":
            return 201, {"name": Path(body["path"]).name}
        asked.append(url)
        assert method == "GET" and "/api/tools/holdings?workspace=" in url and timeout <= 3.0
        return 200, answer

    monkeypatch.setattr(cli, "_request", request)
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=mini", cli.RESUME_LINE]
    assert len(asked) == 1 and "`/thimble fresh`" in cli.RESUME_LINE
    empty = {"workspace": "mini", "cards": 0, "labels": 0, "documents": [], "chats": 0,
             "text": "no cards, no labels, no documents"}
    for answer, resumed in ((empty, False), ({**empty, "chats": 1}, True), ({**empty, "documents": ["story"]}, True),
                            ((404, {"detail": "Not Found"}), False), ((200, "nope"), False),
                            ((0, "URLError: refused"), False)):
        stand_in = (lambda m, u, b=None, timeout=5.0, a=answer: a) if isinstance(answer, tuple) else \
            (lambda m, u, b=None, timeout=5.0, a=answer: request(m, u, b, timeout, a))
        monkeypatch.setattr(cli, "_request", stand_in)
        assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s9"]) == 0
        assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=mini",
                                                        *([cli.RESUME_LINE] if resumed else [])], answer

    def boom(*a, **k):
        raise KeyError("no such route")

    monkeypatch.setattr(cli, "_request", boom)
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=mini"]
    assert "holdings of mini: KeyError" in cli.log_path().read_text()
    assert cli.resumes("http://127.0.0.1:8300", None) is False, "a bare up from a shell has no workspace"
    monkeypatch.setattr(cli, "_request", request)
    asked.clear()
    folder = tmp_path / "calls"
    folder.mkdir()
    assert cli.main(["up", "--cwd", str(folder), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls"] and asked == [], \
        "opened just now"


def test_resume_lists_the_archives_or_restores_one_in_place_of_the_workspace(home, data, monkeypatch, capsys,
                                                                             named_sessions):
    """`/thimble restore` lists the folder's archives, newest first, and opens nothing; `/thimble restore <name>` restores
    it (`POST /api/ws/{c}/restore`) after the URL, naming what it restored and where the replaced run went, with the
    command that goes back; an unknown name says how to list them."""
    _healthy_no_process(monkeypatch)
    calls: list[tuple] = []
    answers = {"archives": (200, {"archives": ["mini-2026-09-23-160000", "mini-2026-09-22-090000"]}),
               "restore": (200, {"restored": "/ws/.archive/mini-2026-09-22-090000",
                                 "archived": "/ws/.archive/mini-2026-09-23-170000"})}

    def request(method, url, body=None, timeout=5.0):
        path = url.split("/api", 1)[1]
        calls.append((method, path, body))
        if path.endswith("/archives"):
            return answers["archives"]
        if path.endswith("/restore"):
            return answers["restore"]
        return 404, {"detail": "Not Found"}

    monkeypatch.setattr(cli, "_request", request)
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s9", "--action", "restore"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        cli.ARCHIVES_LINE.format(names="mini-2026-09-23-160000, mini-2026-09-22-090000")]
    assert cli.ARCHIVES_LINE.endswith("brings one back."), "one line, which ends in a full stop"
    assert named_sessions == [], "a listing opens nothing"
    answers["archives"] = (200, {"archives": []})
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s9", "--action", "restore"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.NO_ARCHIVES_LINE]
    calls.clear()
    # `resume` is another name for the action
    argv = ["server", "up", "--cwd", str(data / "mini"), "--session", "s9", "--action", "resume", "--archive",
            "mini-2026-09-22-090000"]
    assert cli.main(argv) == 0
    assert capsys.readouterr().out.splitlines() == [
        "thimble: http://127.0.0.1:5300/?ws=mini",
        "thimble: Restored the run archived as mini-2026-09-22-090000. The run it replaced is archived at "
        "/ws/.archive/mini-2026-09-23-170000; to go back to it, run: /thimble restore mini-2026-09-23-170000"]
    assert calls == [("POST", "/ws/mini/restore", {"archive": "mini-2026-09-22-090000"})]
    assert named_sessions == [("mini", "s9", str(data / "mini"))], "the session attaches to the restored workspace"
    answers["restore"] = (200, {"restored": "/ws/.archive/mini-2026-09-22-090000", "archived": None})
    assert cli.main(argv) == 0
    assert capsys.readouterr().out.splitlines()[1] == "thimble: Restored the run archived as mini-2026-09-22-090000."
    answers["restore"] = (404, {"detail": "no archive"})
    assert cli.main(argv) == 0
    assert capsys.readouterr().out.splitlines()[1] == cli.NO_SUCH_ARCHIVE_LINE.format(name="mini-2026-09-22-090000")
