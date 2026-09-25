"""The problem report's parts and where it goes (app/feedback.py): the background sessions' transcripts and the
workspace's state, the chats a failure names first, the browser's errors, the install log and the kind of install, a
part that cannot be read, the bundle without the logs; the folder it is written to when Downloads or THIMBLE_HOME
cannot take it; Show in folder for its own bundles only; `thimble feedback`, and the report written with the venv gone
and the supervisor broken, by the launcher and for the /thimble skill. The workspace is test_feedback's `env`, built by
hand over the synthetic corpus `mini`."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import cli, config, feedback
from test_feedback import (C, CONTACT, CONTACT_URL, INSTRUCTIONS, S_CHECK, S_CRITIC, S_DEV, S_ORIENT, S_OTHER, S_VIEW,  # noqa: F401
                           ISSUES, S_WRITER, SECRET, _age, _lines, _zip, app, corpus, env)


def _meta(ws: Path, cid: str, **meta) -> None:
    _lines(ws / "chats" / f"{cid}.jsonl", [{"type": "text", "delta": f"chat {cid}"}])
    (ws / "chats" / f"{cid}.meta.json").write_text(json.dumps({"id": cid, "kind": "agent", **meta}))


def _state(env) -> dict[str, Path]:
    """The orientation, a writer, a report check's run and the critique as agent chats with their sessions; their
    transcripts under the Claude Code config (one with a subagent and a tool result, one a symlink out); a view build
    and a dev ticket with theirs; the permission log, the orientation's record, card checks, a report check and a
    view's files; and decoys that must stay out."""
    ws, projects = env["ws"], env["claude"] / "projects" / "-work-orient"
    _meta(ws, "orient1", role="orient", session=S_ORIENT, status="failed", result="Claude Code exited 1")
    _meta(ws, "writer1", role="writer", session=S_WRITER, status="done", title="write report")
    _meta(ws, "check1", role="check", session=S_CHECK, status="done")
    _meta(ws, "critic1", role="step", session=S_CRITIC, status="done", title="critique")
    _meta(ws, "sub1", role="step", session=S_OTHER, agent_id="a1", title="a subagent, not a session")
    _age(ws / "chats" / "orient1.meta.json", 30)
    _lines(projects / f"{S_ORIENT}.jsonl", [{"type": "assistant", "text": "the orientation's own transcript"}])
    _lines(projects / S_ORIENT / "subagents" / "agent-a1.jsonl", [{"type": "assistant", "text": "a reader's transcript"}])
    (projects / S_ORIENT / "subagents" / "agent-a1.meta.json").write_text('{"agentType": "reader"}')
    (projects / S_ORIENT / "tool-results").mkdir()
    (projects / S_ORIENT / "tool-results" / "t1.txt").write_text(SECRET)
    _lines(projects / f"{S_WRITER}.jsonl", [{"type": "assistant", "text": "the writer's transcript"}])
    _lines(projects / f"{S_OTHER}.jsonl", [{"text": SECRET}])  # a session the workspace does not name as its own
    outside = env["tmp"] / "critic-outside.jsonl"
    outside.write_text(json.dumps({"text": SECRET}) + "\n")
    (projects / f"{S_CRITIC}.jsonl").symlink_to(outside)
    own = ws / ".claude-config" / "projects" / "-views"
    _lines(own / f"{S_VIEW}.jsonl", [{"type": "assistant", "text": "the view build's transcript"}])
    (ws / "views" / "graph" / "cache").mkdir(parents=True)
    (ws / "views" / "proposals.json").write_text(json.dumps([{"slug": "graph", "name": "Graph", "status": "failed",
                                                              "error": "reader.py: KeyError 'page'", "session_id": S_VIEW,
                                                              "chat": "view1"}]))
    (ws / "views" / "graph" / "reader.py").write_text("def read():\n    return rows['page']\n")
    (ws / "views" / "graph" / "view.json").write_text('{"name": "Graph"}')
    (ws / "views" / "graph" / "cache" / "rows.json").write_text(json.dumps({"row": SECRET}))
    _lines(env["dev"] / "tickets.jsonl", [
        {"id": "t1", "workspace": C, "title": "fix the chart", "status": "failed", "session_id": S_DEV, "error": "gates failed"},
        {"id": "t2", "workspace": "other", "title": SECRET, "session_id": S_OTHER}])
    _lines(env["claude"] / "projects" / "-worktree" / f"{S_DEV}.jsonl", [{"type": "assistant", "text": "the dev ticket's transcript"}])
    _lines(ws / "permissions.jsonl", [{"event": "asked", "id": "p1", "tool": "Bash", "what": "Create x"},
                                      {"event": "answered", "id": "p1", "answer": "deny"}])
    (ws / "orient").mkdir()
    (ws / "orient" / "run.json").write_text(json.dumps({"status": "failed", "error": "Claude Code exited 1"}))
    (ws / "notebooks").mkdir()
    (ws / "notebooks" / "g1.json").write_text(json.dumps({"cells": [
        {"id": "c1", "title": "Edits per day", "code": "x", "check": {"status": "fixed", "critique": {"fails": ["labels cut"]}},
         "fixes": [{"id": "f1", "fields": ["code"]}]},
        {"id": "c2", "title": "unchecked", "code": SECRET}]}))
    (ws / "checks").mkdir()
    (ws / "checks" / "unverified.json").write_text(json.dumps({"id": "unverified", "name": "Unverified", "runs": {
        "report": {"run": 2, "status": "failed", "chat": "check1", "summary": "exit 1",
                   "comments": [{"text": SECRET}], "covered": ["p1"], "seen": ["x"]}}}))
    return {"projects": projects}


def _broken_tree(tmp: Path) -> Path:
    """A thimble tree with feedback.py and plugin.json as they are, a supervisor that cannot be imported, and no venv."""
    tree = tmp / "tree"
    app_dir = tree / "backend" / "app"
    app_dir.mkdir(parents=True)
    shutil.copy(Path(feedback.__file__), app_dir / "feedback.py")
    (app_dir / "cli.py").write_text("raise RuntimeError('cli.py is broken on purpose')\n")
    (app_dir / "config.py").write_text("this is not python\n")
    (tree / "backend" / "pyproject.toml").write_text("[project]\nname = 'thimble-backend'\n")
    bin_dir = tree / "plugin" / "bin"
    bin_dir.mkdir(parents=True)
    for name in ("thimble", "thimble-app-dir", "thimble-python"):
        shutil.copy(config.REPO_ROOT / "plugin" / "bin" / name, bin_dir / name)
    (tree / "plugin" / ".claude-plugin").mkdir()
    shutil.copy(config.REPO_ROOT / "plugin" / ".claude-plugin" / "plugin.json", tree / "plugin" / ".claude-plugin")
    return tree


def _shell_env(env, data: Path) -> dict[str, str]:
    keep = {k: v for k, v in os.environ.items() if not k.startswith(("THIMBLE_", "CLAUDE", "PYTHON", "VIRTUAL_ENV"))}
    path = os.pathsep.join(p for p in keep.get("PATH", "").split(os.pathsep) if ".venv" not in p)
    return {**keep, "PATH": path, "HOME": str(env["user"]), "THIMBLE_HOME": str(env["home"]),
            "THIMBLE_DATA_DIR": str(data), "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR),
            "THIMBLE_PORT": "1", "THIMBLE_DEV_DIR": str(env["dev"])}


# ----------------------------------------------------------------------------- what goes in


def test_the_bundle_holds_the_background_sessions_transcripts_and_the_workspace_s_state(env):
    _state(env)
    out = feedback.build("the orientation failed", workspace=(C, env["ws"]))
    files = _zip(out["path"])
    for name in ("workspace/permissions.jsonl", "workspace/orientation.json", "workspace/card-checks.jsonl",
                 "workspace/report-checks.jsonl", "workspace/views.jsonl", "workspace/views/graph/reader.py",
                 "workspace/views/graph/view.json", "workspace/dev-tickets.jsonl", "workspace/sessions.jsonl",
                 f"workspace/transcripts/{S_ORIENT}.jsonl", f"workspace/transcripts/{S_ORIENT}/subagents/agent-a1.jsonl",
                 f"workspace/transcripts/{S_ORIENT}/subagents/agent-a1.meta.json", f"workspace/transcripts/{S_WRITER}.jsonl",
                 f"workspace/transcripts/{S_VIEW}.jsonl", f"workspace/transcripts/{S_DEV}.jsonl"):
        assert name in files, name
    for name, data in files.items():
        assert SECRET.encode() not in data, name
    assert not [n for n in files if "tool-results" in n or "/cache/" in n or S_OTHER in n or S_CRITIC in n]
    rows = {r["session"]: r for r in map(json.loads, files["workspace/sessions.jsonl"].decode().splitlines())}
    assert set(rows) == {S_ORIENT, S_WRITER, S_CHECK, S_CRITIC, S_VIEW, S_DEV}
    assert rows[S_ORIENT]["role"] == "orient" and rows[S_ORIENT]["status"] == "failed" and rows[S_ORIENT]["chat"] == "orient1"
    assert rows[S_CHECK]["transcript"] == "not found" and rows[S_CRITIC]["transcript"] == "not found", "a symlink is skipped"
    assert rows[S_VIEW]["role"] == "view" and rows[S_DEV]["role"] == "dev" and rows[S_DEV]["title"] == "fix the chart"
    assert rows[S_ORIENT]["files"][0] == f"workspace/transcripts/{S_ORIENT}.jsonl"
    assert set(rows[S_ORIENT]["files"][1:]) == {f"workspace/transcripts/{S_ORIENT}/subagents/agent-a1.jsonl",
                                                f"workspace/transcripts/{S_ORIENT}/subagents/agent-a1.meta.json"}
    [card] = map(json.loads, files["workspace/card-checks.jsonl"].decode().splitlines())
    assert card["card"] == "c1" and card["check"]["status"] == "fixed" and "code" not in card
    [chk] = map(json.loads, files["workspace/report-checks.jsonl"].decode().splitlines())
    assert chk["runs"]["report"] == {"run": 2, "status": "failed", "chat": "check1", "summary": "exit 1", "comments": 1}
    [ticket] = map(json.loads, files["workspace/dev-tickets.jsonl"].decode().splitlines())
    assert ticket["id"] == "t1"
    assert "KeyError 'page'" in files["workspace/views.jsonl"].decode()
    assert '"answer": "deny"' in files["workspace/permissions.jsonl"].decode()
    contents = files["contents.txt"].decode()
    assert "the Claude Code transcripts of 4 of the workspace's 6 background sessions" in contents
    assert "the permission requests of the workspace's sessions and their answers" in contents


def test_the_chats_and_sessions_a_failure_names_go_first(env):
    _state(env)
    out = feedback.build("the writer failed", workspace=(C, env["ws"]), focus=["writer1"])
    files = _zip(out["path"])
    first = json.loads(files["workspace/sessions.jsonl"].decode().splitlines()[0])
    assert first["session"] == S_WRITER
    chats = [n for n in files if n.startswith("workspace/chats/") and n.endswith(".jsonl")]
    assert chats[0] == "workspace/chats/writer1.jsonl"


def _crowded(env, n: int = 20) -> Path:
    """`n` writer chats newer than an old view build and a dev ticket, each chat and each transcript near its cap, so
    that the newest alone would fill the chats' and the transcripts' room."""
    ws, projects = env["ws"], env["claude"] / "projects" / "-work"
    big = [{"type": "text", "delta": "w" * 1000}] * 1100
    for i in range(n):
        sid = f"{i:08d}-0000-4000-8000-000000000000"
        _lines(ws / "chats" / f"w{i}.jsonl", big)
        (ws / "chats" / f"w{i}.meta.json").write_text(json.dumps({"id": f"w{i}", "kind": "agent", "role": "writer",
                                                                   "session": sid, "title": f"Write draft {i}"}))
        _lines(projects / f"{sid}.jsonl", big)
        _age(ws / "chats" / f"w{i}.jsonl", 60 * (i + 1))
        _age(ws / "chats" / f"w{i}.meta.json", 60 * (i + 1))
    _meta(ws, "view1", role="dev", view="session-timeline", title="view: Session timeline", status="done")
    (ws / "views").mkdir(exist_ok=True)
    (ws / "views" / "proposals.json").write_text(json.dumps([{"slug": "session-timeline", "name": "Session timeline",
                                                              "status": "built", "chat": "view1", "session_id": S_VIEW}]))
    _lines(projects / f"{S_VIEW}.jsonl", [{"type": "assistant", "text": "the view change's transcript"}])
    _meta(ws, "tick1", role="dev", ticket="t1", title="dev: fix the legend", status="done")
    _meta(ws, "thread1", kind="thread", role="thread", title="why-run-3-stopped")
    for cid in ("view1", "tick1", "thread1", "main"):
        for suffix in (".jsonl", ".meta.json"):
            if (ws / "chats" / f"{cid}{suffix}").exists():
                _age(ws / "chats" / f"{cid}{suffix}", 86_400)
    return ws


def test_the_view_builds_and_dev_tickets_chats_and_transcripts_go_in_however_many_newer_chats_there_are(env):
    """A report about a view change names no chat: the view build's chat and its session's transcript still go in,
    with the dev ticket's chat and main, ahead of 20 newer writers that would fill the room on their own."""
    ws = _crowded(env)
    _lines(ws / "chats" / "main.jsonl", [{"type": "user", "text": "dim the gridlines"}])
    (ws / "chats" / "main.meta.json").write_text(json.dumps({"id": "main", "kind": "main", "title": "main"}))
    _age(ws / "chats" / "main.jsonl", 86_400)
    out = feedback.build("the view change I asked for was marked done but nothing changed", workspace=(C, ws))
    files = _zip(out["path"])
    for cid in ("view1", "tick1", "main"):
        assert f"workspace/chats/{cid}.jsonl" in files, cid
    assert f"workspace/transcripts/{S_VIEW}.jsonl" in files
    assert "workspace/chats/thread1.jsonl" not in files, "an old chat the report does not name stays behind the newest"
    assert "workspace/chats/w19.jsonl" not in files, "the room ran out before the oldest writer"
    rows = [json.loads(ln) for ln in files["workspace/sessions.jsonl"].decode().splitlines()]
    assert rows[0]["session"] == S_VIEW and rows[0]["role"] == "view"
    assert not [n for n, d in files.items() if not d], "no part is empty"


def test_a_chat_the_description_names_by_title_or_slug_goes_in_ahead_of_the_newest(env):
    ws = _crowded(env)
    files = _zip(feedback.build("In the why run 3 stopped thread the answer cut off", workspace=(C, ws))["path"])
    chats = [n for n in files if n.startswith("workspace/chats/") and n.endswith(".jsonl")]
    assert chats[0] == "workspace/chats/thread1.jsonl"
    assert feedback._words("view: Session timeline") == " view session timeline "
    first = feedback.first_chats(C, ws, feedback._chat_metas(ws), "The Session-Timeline view is blank", ["w3"])
    assert first[:2] == ["w3", "view1"] and first[-1] == "main"
    assert "thread1" not in feedback.first_chats(C, ws, feedback._chat_metas(ws), "why", [])


def test_a_report_check_run_that_stores_its_comments_as_a_count_is_read(env):
    _state(env)
    (env["ws"] / "checks" / "unverified.json").write_text(json.dumps({"id": "unverified", "name": "Unverified", "runs": {
        "report": {"run": "r2", "status": "done", "comments": 3, "covered": ["p1"], "seen": []},
        "matrix": {"run": "r3", "status": "done", "comments": [{"text": "x"}]}}}))
    files = _zip(feedback.build("x", workspace=(C, env["ws"]))["path"])
    [chk] = map(json.loads, files["workspace/report-checks.jsonl"].decode().splitlines())
    assert chk["runs"]["report"]["comments"] == 3 and chk["runs"]["matrix"]["comments"] == 1
    assert "could not be read" not in files["contents.txt"].decode()


def test_a_transcript_whose_last_line_is_longer_than_the_room_keeps_that_line_cut(env, tmp_path):
    p = tmp_path / "agent-a1.jsonl"
    p.write_text(json.dumps({"type": "user", "text": "short"}) + "\n" + json.dumps({"text": "word " * 10_000 + "end"}) + "\n")
    text, cut = feedback.tail(p, 1000)
    assert cut and text.endswith('word end"}\n') and 0 < len(text.encode()) <= 1000
    whole, cut = feedback.tail(p, 100_000)
    assert not cut and whole.startswith('{"type": "user"')


def test_the_views_part_counts_views_and_files_apart(env):
    for slug in ("a", "b"):
        (env["ws"] / "views" / slug).mkdir(parents=True)
        for name in ("reader.py", "view.json", "view.html"):
            (env["ws"] / "views" / slug / name).write_text("x")
    contents = _zip(feedback.build("x", workspace=(C, env["ws"]))["path"])["contents.txt"].decode()
    assert "the 6 files of the corpus's 2 views" in contents


def test_the_browser_s_errors_and_failed_requests_go_in_with_the_logs(env):
    browser = [{"ts": "2026-09-25T02:00:00Z", "kind": "request", "method": "GET", "url": "/api/ws/mini/views", "status": 500,
                "text": "500 Internal Server Error: boom"},
               {"ts": "2026-09-25T02:00:01Z", "kind": "console", "text": "x" * 10_000}, "not an entry"]
    client = TestClient(app)
    out = client.post(f"/api/ws/{C}/feedback", json={"description": "x", "browser": browser}).json()
    files = _zip(out["path"])
    rows = [json.loads(ln) for ln in files["browser-log.jsonl"].decode().splitlines()]
    assert [r["kind"] for r in rows] == ["request", "console"] and rows[0]["status"] == 500
    assert len(rows[1]["text"]) < 5000, "a long entry is cut"
    out = client.post(f"/api/ws/{C}/feedback", json={"description": "x", "browser": browser, "logs": False}).json()
    assert "browser-log.jsonl" not in _zip(out["path"])


def test_the_install_log_and_the_kind_of_install_go_in(env, monkeypatch):
    (env["home"] / "install.log").write_text("== 1/11 prerequisites\nuv 0.9\n== 5/11 frontend\nnpm ERR! network\n")
    checkout = env["tmp"] / "checkout"
    (checkout / ".git").mkdir(parents=True)
    monkeypatch.setattr(feedback, "REPO_ROOT", checkout)
    files = _zip(feedback.build("x")["path"])
    assert files["install-log.txt"].decode().endswith("npm ERR! network\n")
    versions = files["versions.txt"].decode()
    assert "install: checkout" in versions and "server: not answering at http://127.0.0.1:" in versions
    tree = env["tmp"] / "release"
    tree.mkdir()
    (tree / "RELEASE.json").write_text(json.dumps({"version": "0.4.0", "commit": "abc1234", "date": "2026-09-20"}))
    monkeypatch.setattr(feedback, "REPO_ROOT", tree)
    versions = _zip(feedback.build("x")["path"])["versions.txt"].decode()
    assert "install: release" in versions and "thimble: release 0.4.0 @ abc1234, 2026-09-20" in versions


def test_a_part_that_cannot_be_read_is_a_line_in_contents_and_the_report_still_goes(env, monkeypatch):
    def boom(ws):
        raise PermissionError("denied")

    monkeypatch.setattr(feedback, "_card_checks", boom)
    files = _zip(feedback.build("x", workspace=(C, env["ws"]))["path"])
    assert "workspace/card-checks.jsonl could not be read (PermissionError: denied)" in files["contents.txt"].decode()
    assert "workspace/chats/new.jsonl" in files


def test_without_the_logs_only_the_description_versions_and_doctor_without_its_log_tail_go_in(env):
    out = TestClient(app).post(f"/api/ws/{C}/feedback", json={"description": "x", "logs": False}).json()
    files = _zip(out["path"])
    assert set(files) == {"contents.txt", "description.txt", "versions.txt", "doctor.txt"}
    doctor = files["doctor.txt"].decode()
    assert "last doctor line" not in doctor and "log tail: left out with the logs" in doctor
    assert "were left out" in files["contents.txt"].decode()


# ----------------------------------------------------------------------------- where it goes


def test_with_no_downloads_folder_the_bundle_goes_to_thimble_home_and_names_never_collide(env):
    (env["user"] / "Downloads").rmdir()
    a = feedback.build("x")
    b = feedback.build("y")
    assert Path(a["path"]).parent == env["home"]
    assert a["path"] != b["path"]
    c = feedback.build("z", now=datetime(2026, 9, 25, 2, 15, 0))
    d = feedback.build("z", now=datetime(2026, 9, 25, 2, 15, 0))
    assert Path(c["path"]).name == "thimble-feedback-20260925-021500.zip"
    assert Path(d["path"]).name == "thimble-feedback-20260925-021500-2.zip"


def test_when_neither_downloads_nor_home_can_be_written_the_bundle_goes_to_the_temp_folder(env, monkeypatch):
    (env["user"] / "Downloads").rmdir()
    blocked = env["tmp"] / "blocked"
    blocked.write_text("a file where the home folder should be")
    monkeypatch.setenv("THIMBLE_HOME", str(blocked))
    temp = env["tmp"] / "temp"
    temp.mkdir()
    monkeypatch.setattr(feedback.tempfile, "gettempdir", lambda: str(temp))
    out = feedback.build("x")
    assert Path(out["path"]).parent == temp


def test_reveal_shows_only_a_bundle_this_module_wrote(env, monkeypatch):
    out = feedback.build("x")
    with pytest.raises(LookupError):
        feedback.reveal(out["path"])
    ran: list[list[str]] = []
    monkeypatch.setattr(feedback, "reveal_command", lambda p: ["true", str(p)])
    monkeypatch.setattr(feedback.subprocess, "Popen", lambda cmd, **kw: ran.append(cmd))
    feedback.reveal(out["path"])
    assert ran == [["true", out["path"]]]
    elsewhere = env["tmp"] / Path(out["path"]).name
    elsewhere.write_bytes(b"x")
    for bad in (str(elsewhere), "/etc/passwd", str(env["user"] / "Downloads" / "notes.zip")):
        with pytest.raises(ValueError):
            feedback.reveal(bad)
    client = TestClient(app)
    assert client.post("/api/feedback/reveal", json={"path": "/etc/passwd"}).status_code == 400
    assert client.post("/api/feedback/reveal", json={"path": out["path"]}).json() == {"ok": True}


# ----------------------------------------------------------------------------- the commands


def test_thimble_feedback_writes_the_bundle_for_the_folder_s_workspace_and_prints_how_to_send_it(env, monkeypatch, capsys):
    data = env["tmp"] / "data"
    (data / C).mkdir(parents=True)
    (data / C / "manifest.json").write_text('{"name": "mini"}')
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    monkeypatch.setenv("THIMBLE_CALLER_CWD", str(data / C))
    assert cli.main(["feedback", "the", "chart", "is", "blank"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].startswith(f"thimble: wrote {env['user'] / 'Downloads'}/thimble-feedback-") and lines[0].endswith(")")
    assert lines[1].startswith("It holds: contents.txt, description.txt, versions.txt, doctor.txt, server-log.txt, "
                               "workspace/events.jsonl") and lines[1].endswith("2 chats.")
    assert lines[2] == INSTRUCTIONS
    assert lines[3].startswith(f"Open a GitHub issue: {ISSUES}?title=the%20chart")
    assert lines[4] == f"{CONTACT} on GitHub: {CONTACT_URL}"
    path = lines[0].split("wrote ", 1)[1].rsplit(" (", 1)[0]
    files = _zip(path)
    assert files["description.txt"] == b"the chart is blank\n"
    assert "workspace/chats/new.jsonl" in files
    assert cli.main(["feedback", "--no-logs"]) == 0
    assert "server-log.txt" not in capsys.readouterr().out
    assert cli.build_parser().parse_args(["feedback"]).fn is cli.cmd_feedback


@pytest.mark.skipif(not shutil.which("python3"), reason="needs python3 on PATH")
def test_feedback_py_runs_on_the_standard_library_alone_with_the_supervisor_broken(env, corpus):
    """Run as plugin/bin/thimble runs it when the venv is gone: python3 from PATH, no site packages, a cli.py that raises
    and a config.py that does not parse. The zip is written with the workspace found from the files, doctor.txt says
    why it could not run, and import-error.txt holds the traceback."""
    tree = _broken_tree(env["tmp"])
    r = subprocess.run(["python3", "-s", "-E", "-m", "app.feedback", "the", "server", "is", "down", "--cwd", str(corpus / C)],
                       cwd=tree / "backend", env=_shell_env(env, corpus), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    first = r.stdout.splitlines()[0]
    assert first.startswith(f"thimble: wrote {env['user'] / 'Downloads'}/thimble-feedback-"), r.stdout
    files = _zip(first.split("wrote ", 1)[1].rsplit(" (", 1)[0])
    assert files["description.txt"] == b"the server is down\n"
    assert "cli.py is broken on purpose" in files["import-error.txt"].decode()
    assert "could not run: cli.py failed to import" in files["doctor.txt"].decode()
    assert "workspace/chats/new.jsonl" in files and "server-log.txt" in files
    versions = files["versions.txt"].decode()
    assert "server: not answering at http://127.0.0.1:1" in versions and "workspace: mini" in versions


@pytest.mark.skipif(not shutil.which("python3"), reason="needs python3 on PATH")
def test_the_launcher_writes_the_report_without_a_venv_and_for_the_thimble_skill(env, corpus):
    """`thimble feedback` in a tree with no venv falls back to python3; a venv whose python fails is tried first and
    then python3; `/thimble feedback` (the skill's `server up --action feedback`) prints only thimble: lines, starts no
    server and exits 0."""
    tree = _broken_tree(env["tmp"])
    run_env = {**_shell_env(env, corpus), "THIMBLE_APP_DIR": str(tree)}
    launcher = str(tree / "plugin" / "bin" / "thimble")
    r = subprocess.run([launcher, "feedback", "the chart is blank"], cwd=corpus / C, env=run_env, capture_output=True,
                       text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.startswith("thimble: wrote ") and "Open a GitHub issue: https://github.com/" in r.stdout
    venv = tree / "backend" / ".venv" / "bin"
    venv.mkdir(parents=True)
    (venv / "python").write_text("#!/bin/sh\nexit 3\n")
    (venv / "python").chmod(0o755)
    r = subprocess.run([launcher, "server", "up", "--cwd", str(corpus / C), "--session", "s1", "--action", "feedback",
                        "--archive", ""], cwd=env["tmp"], env=run_env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    lines = r.stdout.splitlines()
    assert lines and all(ln.startswith("thimble: ") for ln in lines), lines
    assert "could not write the report (exit 3); trying python3" in lines[0]
    assert lines[1].startswith(f"thimble: wrote {env['user'] / 'Downloads'}/thimble-feedback-")
    assert lines[-3:] == [f"thimble: {INSTRUCTIONS}",
                          f"thimble: Open a GitHub issue: {ISSUES}",
                          f"thimble: {CONTACT} on GitHub: {CONTACT_URL}"], "the skill's reply gets the plain page"
    assert not (env["home"] / "server.json").exists(), "no server was started"
