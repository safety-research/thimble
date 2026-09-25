"""`thimble list` and `thimble purge` (app/runs.py): the workspaces by id from the disk, with the open sessions from the
server when it is up; what answers on the port (runs.server); what purge prints, its refusals, the server's
DELETE when it is up and the disk when not, and the guards that keep it inside the workspaces folder and the registry;
the server's side (the sessions route, DELETE /api/ws/<c>?idle=true)."""
from __future__ import annotations

import asyncio
import io
import json
import os
import time
from pathlib import Path

import pytest

from app import channel, cli, config, ledger, runs


class Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


@pytest.fixture()
def dirs(home, tmp_path, monkeypatch):
    """A registry and a workspaces folder the supervisor resolves (THIMBLE_DATA_DIR, THIMBLE_WORKSPACES_DIR), no server,
    and the folders the registry names under tmp_path/corpora."""
    data, ws = tmp_path / "data", tmp_path / "ws"
    data.mkdir()
    ws.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(ws))
    server_down(monkeypatch)
    return data.resolve(), ws.resolve()


def server_down(monkeypatch) -> None:
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)  # the default port may be a live server's
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no request")))


def server_up(monkeypatch, sessions: dict[str, list[str]] | None, delete_status: int = 200,
              folders: tuple[Path, Path] | None = None) -> list[tuple[str, str]]:
    """A healthy server of this install answering the sessions read (with `folders`, the registry and workspaces folder
    it works on, by default the ones purge lists; None sessions: 404, a server older than the route) and the workspace
    DELETE; the requests made."""
    calls: list[tuple[str, str]] = []
    data, ws = runs.dirs() if folders is None else folders

    def request(method, url, body=None, timeout=5.0):
        calls.append((method, url.split("/api", 1)[1]))
        if method == "GET" and url.endswith(runs.SESSIONS_PATH):
            if sessions is None:
                return 404, {"detail": "Not Found"}
            return 200, {"workspaces": sessions, "data_dir": str(data), "workspaces_dir": str(ws)}
        if method == "DELETE":
            return delete_status, {"ok": True} if delete_status == 200 else {"detail": "no"}
        raise AssertionError(f"unexpected {method} {url}")

    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "_request", request)
    return calls


def register(data: Path, name: str, folder: Path, *, make: bool = True) -> Path:
    if make:
        folder.mkdir(parents=True, exist_ok=True)
    side = data / f"{name}.corpus.json"
    side.write_text(json.dumps({"name": name, "root": str(folder), "path": str(folder), "registered_at": "x",
                                "manifest": {"name": name}}))
    return side


def workspace(ws: Path, name: str, age_s: float = 0.0) -> Path:
    p = ws / name
    (p / "chats").mkdir(parents=True, exist_ok=True)
    (p / "sessions.json").write_text("{}")
    t = time.time() - age_s
    for f in (p / "chats", p / "sessions.json", p):
        os.utime(f, (t, t))
    return p


def archive(ws: Path, name: str, age_s: float = 0.0) -> Path:
    p = ws / runs.ARCHIVE_DIR / name
    p.mkdir(parents=True)
    t = time.time() - age_s
    os.utime(p, (t, t))
    return p


@pytest.fixture()
def corpus(dirs, tmp_path):
    """wiki (a workspace used a minute ago, two archives of one second and an older one), old (its folder gone, used
    two days ago), fresh (registered, no workspace yet), stray (a workspace no registration names) and demo (a corpus
    directory in the registry, with a workspace)."""
    data, ws = dirs
    corpora = tmp_path / "corpora"
    register(data, "wiki", corpora / "wiki")
    workspace(ws, "wiki", age_s=90)
    archive(ws, "wiki-2026-09-25-123000", age_s=3 * 3600)
    archive(ws, "wiki-2026-09-25-123000-2", age_s=3 * 3600)
    archive(ws, "wiki-2026-09-20-080000", age_s=5 * 86400)
    register(data, "old", corpora / "old", make=False)
    workspace(ws, "old", age_s=2 * 86400)
    register(data, "fresh", corpora / "fresh")
    workspace(ws, "stray", age_s=20 * 86400)
    (data / "demo").mkdir()
    (data / "demo" / "manifest.json").write_text('{"name": "demo"}')
    workspace(ws, "demo", age_s=4 * 3600)
    return corpora


def test_the_archive_names_are_ledgers(workspaces_tmp):
    assert runs.ARCHIVE_DIR == ledger.ARCHIVE_DIR
    name = ledger.archive_path("my-logs-2").name
    m = runs.ARCHIVE_RE.match(name)
    assert m and m.group("ws") == "my-logs-2", name
    assert runs.ARCHIVE_RE.match("logs-2026-01-02-030405-3").group("n") == "3"
    assert runs.ARCHIVE_RE.match("logs-2") is None, "a folder's -2 name is not an archive's"


def test_list_shows_every_id_from_the_disk_with_the_server_down(corpus, dirs, capsys):
    assert cli.main(["list"]) == 0
    lines = capsys.readouterr().out.splitlines()
    ids = [ln.split()[0] for ln in lines[1:-1]]
    assert lines[0].split() == ["ID", "FOLDER", "LAST", "USED", "SESSIONS"]
    assert ids == ["wiki", "wiki-2026-09-25-123000-2", "wiki-2026-09-25-123000", "wiki-2026-09-20-080000", "demo",
                   "old", "stray", "fresh"], "by last use, each workspace followed by its archives, newest first"
    row = {ln.split()[0]: ln for ln in lines[1:-1]}
    assert "1 min ago" in row["wiki"] and row["wiki"].rstrip().endswith("-")
    assert row["wiki-2026-09-25-123000"].rstrip().endswith("archived") and "3 h ago" in row["wiki-2026-09-25-123000"]
    assert "(folder gone)" in row["old"] and "2 d ago" in row["old"]
    assert "no workspace" in row["fresh"]
    assert "(not registered)" in row["stray"]
    assert row["demo"].split()[1] == str(dirs[0] / "demo"), "a corpus directory in the registry is its own folder"
    assert lines[-1] == "(the server is not running, so open sessions are not counted)"


def test_list_counts_the_open_sessions_when_the_server_is_up(corpus, monkeypatch, capsys):
    server_up(monkeypatch, {"wiki": ["s1", "s2"], "demo": [""]})
    assert cli.main(["list"]) == 0
    lines = capsys.readouterr().out.splitlines()
    row = {ln.split()[0]: ln for ln in lines[1:]}
    assert row["wiki"].endswith("2 open") and row["demo"].endswith("1 open") and row["old"].rstrip().endswith("-")
    assert not lines[-1].startswith("("), "no note: the sessions are counted"
    monkeypatch.setattr(cli, "foreign_home", lambda url=None: "/other/home")
    probe = runs.server(*runs.dirs())
    assert probe.state == runs.OTHER and probe.sessions is None, "another install's server says nothing of this one's"


def test_a_server_that_does_not_say_its_sessions_counts_none_and_purge_deletes_no_workspace(corpus, dirs, monkeypatch,
                                                                                            capsys):
    """A healthy server of this install with no sessions route (the release before, which `thimble update` leaves
    running) is not a server that is down: list shows `?` and says so, and purge deletes no workspace, neither through
    the server nor around it from the disk; an archived run alone still goes."""
    data, ws = dirs
    calls = server_up(monkeypatch, None)
    assert cli.main(["list"]) == 0
    lines = capsys.readouterr().out.splitlines()
    row = {ln.split()[0]: ln for ln in lines[1:-1]}
    assert row["wiki"].endswith("?") and row["wiki-2026-09-20-080000"].endswith("archived")
    assert lines[-1].startswith("Open sessions unknown: the running server is older") and "thimble server restart" in lines[-1]
    assert cli.main(["purge", "wiki", "wiki-2026-09-20-080000", "-y"]) == 1
    out = capsys.readouterr().out
    assert "wiki might still have a session running. Run `thimble server stop` before purging. Nothing deleted." in out
    assert (ws / "wiki").is_dir() and (data / "wiki.corpus.json").is_file()
    assert (ws / runs.ARCHIVE_DIR / "wiki-2026-09-20-080000").is_dir() and not [c for c in calls if c[0] == "DELETE"]
    assert cli.main(["purge", "wiki-2026-09-20-080000", "-y"]) == 0
    assert not (ws / runs.ARCHIVE_DIR / "wiki-2026-09-20-080000").exists()
    # something that holds the port without answering as a healthy server is no server that is down either
    server_down(monkeypatch)
    monkeypatch.setattr(cli, "listening", lambda p: True)
    assert runs.server(data, ws).state == runs.UNKNOWN
    assert cli.main(["purge", "stray", "-y"]) == 1 and (ws / "stray").is_dir()


def test_a_server_on_other_folders_is_not_asked_and_one_sharing_a_folder_refuses(corpus, dirs, tmp_path, monkeypatch,
                                                                                 capsys):
    """The server deletes its own workspaces/<c>, so it is asked only when it works on the folders purge listed. On
    other folders (THIMBLE_DATA_DIR and THIMBLE_WORKSPACES_DIR set to a scratch stack's) it never serves these, and the
    folder the plan names goes from the disk; sharing one folder only, purge refuses."""
    data, ws = dirs
    calls = server_up(monkeypatch, {"wiki": ["s1"]}, folders=(tmp_path / "live" / "data", tmp_path / "live" / "ws"))
    assert cli.main(["list"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert "works on other folders" in lines[-1] and {ln.split()[0]: ln for ln in lines[1:-1]}["wiki"].endswith("-")
    assert cli.main(["purge", "wiki", "-y"]) == 0
    out = capsys.readouterr().out
    assert f"thimble purge: deleted {ws / 'wiki'}" in out and "(open sessions not checked: " in out
    assert not (ws / "wiki").exists() and ("DELETE", "/ws/wiki?idle=true") not in calls
    calls = server_up(monkeypatch, {}, folders=(data, tmp_path / "live" / "ws"))
    assert runs.server(data, ws).state == runs.UNKNOWN
    assert cli.main(["purge", "demo", "-y"]) == 1
    assert "might still have a session running" in capsys.readouterr().out and (ws / "demo").is_dir()
    assert not [c for c in calls if c[0] == "DELETE"]


def test_list_with_nothing(dirs, capsys):
    assert cli.main(["list"]) == 0
    assert capsys.readouterr().out.startswith("thimble: no workspaces yet")


def test_purge_dry_run_prints_the_plan_and_deletes_nothing(corpus, dirs, capsys):
    data, ws = dirs
    assert cli.main(["purge", "wiki", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert out.splitlines() == [f"thimble purge: would delete {ws / 'wiki'}",
                                f"thimble purge: would delete the registration {data / 'wiki.corpus.json'}"]
    assert (ws / "wiki").is_dir() and (data / "wiki.corpus.json").is_file()


def test_purge_deletes_without_asking_and_says_what_went(corpus, dirs, monkeypatch, capsys):
    data, ws = dirs
    monkeypatch.setattr("sys.stdin", io.StringIO(""))  # no terminal and no answer: neither is needed
    assert cli.main(["purge", "wiki"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        f"thimble purge: deleted {ws / 'wiki'}", f"thimble purge: deleted the registration {data / 'wiki.corpus.json'}",
        "(open sessions not checked: the server is not running)"]
    assert not (ws / "wiki").exists() and not (data / "wiki.corpus.json").exists()


def test_purge_from_the_disk_keeps_the_folder_the_archives_and_the_rest(corpus, dirs, capsys):
    data, ws = dirs
    (corpus / "wiki" / "transcript.jsonl").write_text("{}")
    assert cli.main(["purge", "wiki", "-y"]) == 0
    assert f"thimble purge: deleted {ws / 'wiki'}" in capsys.readouterr().out
    assert not (ws / "wiki").exists() and not (data / "wiki.corpus.json").exists()
    assert (corpus / "wiki" / "transcript.jsonl").is_file(), "the folder the workspace read is never touched"
    assert len(list((ws / runs.ARCHIVE_DIR).iterdir())) == 3 and (ws / "old").is_dir()
    assert [r.id for r in runs.rows(data, ws) if r.kind == "workspace"] == ["demo", "old", "stray", "fresh"]


def test_purge_goes_through_the_server_when_it_is_up(corpus, dirs, monkeypatch, capsys):
    data, ws = dirs
    calls = server_up(monkeypatch, {})
    assert cli.main(["purge", "wiki", "-y"]) == 0
    assert ("DELETE", "/ws/wiki?idle=true") in calls
    assert capsys.readouterr().out.splitlines()[0] == f"thimble purge: deleted {ws / 'wiki'}"
    assert (ws / "wiki").is_dir(), "the server's DELETE removes the folder (faked here), not purge"
    assert not (data / "wiki.corpus.json").exists()
    # a server that does not know the corpus (404) runs nothing for it: the folder goes from the disk
    calls = server_up(monkeypatch, {}, delete_status=404)
    register(data, "wiki", corpus / "wiki")
    assert cli.main(["purge", "wiki", "-y"]) == 0
    assert ("DELETE", "/ws/wiki?idle=true") in calls and not (ws / "wiki").exists()
    # a folder that is gone is never asked of the server, which no longer knows the corpus
    calls = server_up(monkeypatch, {})
    assert cli.main(["purge", "old", "-y"]) == 0
    assert ("DELETE", "/ws/old?idle=true") not in calls and not (ws / "old").exists()
    capsys.readouterr()
    # a session that opened while purge asked (409), or any other failure, is never gone around from the disk
    for status, said in ((409, "a session opened on it since purge counted them"), (500, "the server answered 500"),
                         (0, "the server answered nothing")):
        server_up(monkeypatch, {}, delete_status=status)
        assert cli.main(["purge", "demo", "-y"]) == 1
        out = capsys.readouterr().out
        assert f"demo: not deleted, {said}" in out or f"demo: not deleted: {said}" in out, out
        assert (ws / "demo").is_dir() and "thimble purge: deleted" not in out


def test_purge_refuses_a_workspace_a_session_holds_open(corpus, dirs, monkeypatch, capsys):
    data, ws = dirs
    server_up(monkeypatch, {"wiki": ["s1"]})
    assert cli.main(["purge", "wiki", "wiki-2026-09-20-080000", "-y"]) == 1
    out = capsys.readouterr().out
    assert "wiki has 1 session running" in out and "Quit it before purging. Nothing deleted." in out
    assert (ws / "wiki").is_dir() and (ws / runs.ARCHIVE_DIR / "wiki-2026-09-20-080000").is_dir(), "refused whole"


def test_purge_an_archived_run_and_unknown_ids(corpus, dirs, capsys):
    data, ws = dirs
    assert cli.main(["purge", "wiki-2026-09-25-123000", "-y"]) == 0
    assert not (ws / runs.ARCHIVE_DIR / "wiki-2026-09-25-123000").exists()
    assert (ws / runs.ARCHIVE_DIR / "wiki-2026-09-25-123000-2").is_dir() and (ws / "wiki").is_dir()
    assert (data / "wiki.corpus.json").is_file()
    capsys.readouterr()
    for bad in ("nope", ".archive", "..", "wiki-2026-09-25-123000"):
        assert cli.main(["purge", bad, "-y"]) == 1
        assert f"nothing is called {bad}. Run `thimble list`" in capsys.readouterr().out


def test_an_id_a_workspace_and_an_archive_share_is_refused(dirs, tmp_path, capsys):
    data, ws = dirs
    register(data, "logs-2026-01-01-000000", tmp_path / "corpora" / "logs-2026-01-01-000000")
    workspace(ws, "logs-2026-01-01-000000")
    archive(ws, "logs-2026-01-01-000000")
    assert cli.main(["purge", "logs-2026-01-01-000000", "-y"]) == 1
    assert "is both a workspace and an archived run. Delete the one you mean by hand" in capsys.readouterr().out
    assert (ws / "logs-2026-01-01-000000").is_dir() and (ws / runs.ARCHIVE_DIR / "logs-2026-01-01-000000").is_dir()


def test_purge_keeps_a_corpus_directory_and_frees_a_registration_with_no_workspace(corpus, dirs, capsys):
    data, ws = dirs
    assert cli.main(["purge", "demo", "fresh", "-y"]) == 0
    out = capsys.readouterr().out
    assert str(data / "demo") + "\n" not in out and f"deleted {ws / 'demo'}" in out
    assert not (ws / "demo").exists() and (data / "demo" / "manifest.json").is_file()
    assert not (data / "fresh.corpus.json").exists() and (corpus / "fresh").is_dir()
    assert cli.main(["purge", "stray", "-y"]) == 0 and not (ws / "stray").exists()


def test_purge_never_follows_a_link_out_of_the_workspaces_folder(dirs, tmp_path, capsys):
    data, ws = dirs
    outside = tmp_path / "precious"
    (outside / "keep").mkdir(parents=True)
    register(data, "linked", tmp_path / "corpora" / "linked")
    (ws / "linked").symlink_to(outside, target_is_directory=True)
    (ws / runs.ARCHIVE_DIR).mkdir()
    (ws / runs.ARCHIVE_DIR / "linked-2026-01-01-000000").symlink_to(outside, target_is_directory=True)
    found = runs.rows(data, ws)
    assert [(r.id, r.path) for r in found] == [("linked", None)], "a link is no workspace and no archive"
    assert cli.main(["purge", "linked", "-y"]) == 0
    assert (outside / "keep").is_dir() and (ws / "linked").is_symlink()
    assert runs._child(ws, "..") is None and runs._child(ws, ".archive") is None and runs._child(ws, "linked") is None


def test_a_folder_under_another_case_is_the_registered_workspace(dirs, tmp_path):
    """On a disk that folds case (macOS's), a workspace folder `Demo` of the registered `demo` is that workspace's row,
    not a second, unregistered one whose purge would go around demo's open sessions."""
    data, ws = dirs
    register(data, "demo", tmp_path / "corpora" / "demo")
    workspace(ws, "Demo")
    if not (ws / "demo").is_dir():
        pytest.skip("this disk does not fold case")
    found = runs.rows(data, ws, {"demo": 1})
    assert [(r.id, r.sessions) for r in found] == [("demo", 1)]


def test_the_parser_and_the_sessions_route(monkeypatch):
    ap = cli.build_parser()
    assert ap.parse_args(["list"]).fn is cli.cmd_list
    a = ap.parse_args(["purge", "a", "b", "-y", "--dry-run"])
    assert a.fn is cli.cmd_purge and a.ids == ["a", "b"] and a.yes and a.dry_run
    with pytest.raises(SystemExit):
        ap.parse_args(["purge"])
    q1, q2, q3 = asyncio.Queue(), asyncio.Queue(), asyncio.Queue()
    monkeypatch.setattr(channel, "_subs", {"wiki": {q1, q2}, "demo": {q3}, "idle": set()})
    monkeypatch.setattr(channel, "_routes", {q1: ("s1", "channel"), q2: (None, "hook"), q3: ("s3", "channel")})
    answer = asyncio.run(channel.sessions_route())
    got = answer["workspaces"]
    assert sorted(got["wiki"]) == ["", "s1"] and got["demo"] == ["s3"] and "idle" not in got
    assert answer["data_dir"] == str(config.DATA_DIR.resolve())
    assert answer["workspaces_dir"] == str(config.WORKSPACES_DIR.resolve())


def test_the_server_s_delete_refuses_an_open_workspace_and_stops_the_sessions_it_runs(monkeypatch):
    """DELETE /api/ws/<c>?idle=true (purge's): 409 while a shim holds a subscription, checked at the delete; otherwise
    the sessions the server runs for the workspace (an orientation: it never subscribes) are stopped before the folder
    goes, as `/thimble fresh`'s archive stops them."""
    from fastapi.testclient import TestClient

    from app import agent_session, agents
    from app.main import app

    c = "mini"
    agents.mirror(c, "user", by=agents.BROWSER, text="hi")
    q = asyncio.Queue()
    monkeypatch.setattr(channel, "_subs", {c: {q}})
    monkeypatch.setattr(channel, "_routes", {q: ("s1", "channel")})
    stopped: list[str] = []

    async def stop_run(run):
        stopped.append(run.key)
        agent_session._runs.pop((run.c, run.key), None)
        return True

    monkeypatch.setattr(agent_session, "stop_run", stop_run)
    monkeypatch.setitem(agent_session._runs, (c, "orient"), agent_session.Run(c, "orient", "or1", "sid", Path("."),
                                                                             "orient", pid=1))
    with TestClient(app, base_url="http://127.0.0.1") as client:
        r = client.delete(f"/api/ws/{c}?idle=true")
        assert r.status_code == 409 and "1 open session" in r.json()["detail"]
        assert (config.WORKSPACES_DIR / c).is_dir() and stopped == []
        channel._subs[c].clear()
        assert client.delete(f"/api/ws/{c}?idle=true").status_code == 200
    assert stopped == ["orient"] and not (config.WORKSPACES_DIR / c).exists()
