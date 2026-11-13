"""A folder's sessions at a start of thimble-browser, and several of them open at once (folder_sessions.py,
cli.pick_session, cli.open_session, config.add_session): a plain start in a folder that has a session opens the page on
its session picker; a folder never opened starts a new session at once. A session opened beside one that a tab shows or
a shell holds runs in a workspace of its own over the same folder, so nothing of the open one moves, and each keeps its
own chat, cards, labels, settings and temp folder; only the folder's files are shared, and a write over a file that
changed since it was read is refused, as Claude Code refuses it."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import cli

BACKEND = Path(__file__).resolve().parents[1]


def _card(c: str, words: str) -> str:
    from app import config, notebook  # noqa: PLC0415

    nb = notebook.create_notebook(config.workspace_dir(c), "G")
    cell = notebook.new_cell("note", "test", words, nb["id"], payload={"text": words})
    return str(notebook.insert_cell(c, nb["id"], cell)["id"])


def _other_shell(name: str) -> subprocess.Popen:
    """A thimble-browser in another shell that holds workspace `name` (cli.hold_session) until it is killed."""
    other = subprocess.Popen([sys.executable, "-c", f"from app import cli; cli.hold_session({name!r}); "
                              "print('holding', flush=True); import time; time.sleep(100)"],
                             cwd=BACKEND, env=dict(os.environ), stdout=subprocess.PIPE, text=True)
    assert other.stdout is not None and other.stdout.readline().strip() == "holding"
    return other


def test_a_start_in_a_folder_with_sessions_opens_the_page_on_its_picker(home, data, monkeypatch, capsys):
    """A plain start (`auto`) in a folder with no session starts a new one at once. Once the folder has a session, the
    start opens nothing itself: its link opens the page on the folder's session picker (`?pick=`), it says so, and it
    holds no session, since the page opens the one picked. An explicit `--session new` (`-n`) starts a new session
    without the picker, as --continue and --resume do. The server is faked."""
    cwd = data / "mini"
    with cli.server_dirs():
        assert cli.pick_session(cwd, data, "auto") == cli.NEW_SESSION
        _card("mini", "two incidents")
        assert cli.pick_session(cwd, data, "auto") == cli.PICK_IN_PAGE
        assert cli.pick_session(cwd, data, "new") == cli.NEW_SESSION
    sent: list[str] = []

    def answer(method, url, body=None, timeout=5.0):
        sent.append(url.split("/api/", 1)[1])
        return 200, {"code": "k" * 16} if url.endswith("/ui/pair") else {"name": "mini", "open": False}

    monkeypatch.setattr(cli, "_request", answer)
    monkeypatch.setattr(cli, "ensure_running", lambda wait_s: True)
    monkeypatch.setattr(cli, "refuse_foreign", lambda url: False)
    monkeypatch.setattr(cli, "open_workspace", lambda *a, **k: ("mini", False))
    monkeypatch.setattr(cli, "elsewhere_line", lambda *a, **k: None)
    monkeypatch.setattr(cli, "HELD_SESSIONS", {})
    assert cli.main(["browser", "--cwd", str(cwd), "--detach"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("thimble browser: http://") and out[0].endswith("/?pick=mini"), out
    assert out[1] == cli.BROWSER_LINE.format(what=cli.PICK_LINE)
    assert "ws/mini/sessions" not in sent and cli.HELD_SESSIONS == {}
    assert cli.main(["browser", "--cwd", str(cwd), "--detach", "--session", "new"]) == 0
    assert capsys.readouterr().out.splitlines()[0].endswith("/?ws=mini") and "ws/mini/sessions" in sent


@pytest.mark.timeout(120)
async def test_a_session_open_in_a_tab_or_a_shell_is_never_moved_aside(data_tmp, workspaces_tmp, monkeypatch):
    """The page's picker and the CLI open a session through folder_sessions.open_session. A session a tab shows (it
    follows the workspace's events) or a thimble-browser in another shell holds is open: the picker marks it, picking it
    opens it as it is, and a new session goes into a workspace of the folder that is not open, a new one beside it when
    none is, so the open one keeps its cards. One the picker opened is open until its tab follows its events, however
    long the tab takes, and then while a tab follows it. Once nothing holds the folder's own workspace, a new session
    takes it and moves its session aside, which comes back whole. main's chat switch is faked."""
    from app import config, folder_sessions, investigation, runtime  # noqa: PLC0415

    switched: list[tuple[str, str | None]] = []

    class Space:
        def __init__(self, c: str) -> None:
            self.c = c

        async def switch(self, sid: str | None) -> bool:
            switched.append((self.c, sid))
            return True

    monkeypatch.setattr(runtime, "ensure", Space)
    monkeypatch.setattr(folder_sessions, "_opening", set())
    _card("mini", "the first tab's card")
    monkeypatch.setitem(investigation._subscribers, ("mini", investigation.MAIN), {object()})
    rows = folder_sessions.sessions("mini")["sessions"]
    assert [(r["slot"], r["open"], r["cards"]) for r in rows] == [("mini", True, 1)]
    assert await folder_sessions.open_session("mini", slot="mini") == {"name": "mini", "open": True}
    assert await folder_sessions.open_session("mini", new=True, reserve=True) == {"name": "mini.2", "open": False}
    assert switched == [("mini.2", None)] and config.sessions_of("mini") == ["mini", "mini.2"]
    assert folder_sessions.is_open("mini.2"), "the picker's tab is still loading it"
    assert folder_sessions.sessions("mini.2")["label"] == "mini"

    class Request:  # the picker's tab: its event stream opens, then it closes
        headers: dict[str, str] = {}

    await investigation._stream("mini.2", investigation.MAIN, Request())  # type: ignore[arg-type]
    assert folder_sessions.is_open("mini.2") and not folder_sessions._opening
    investigation._subscribers.pop(("mini.2", investigation.MAIN))
    assert not folder_sessions.is_open("mini.2"), "no tab follows it, and the picker holds it no longer"
    other = _other_shell("mini.2")
    try:
        assert folder_sessions.is_open("mini.2")
        assert (await folder_sessions.open_session("mini", new=True))["name"] == "mini.3"
    finally:
        other.kill()
        other.wait(timeout=10)
    assert len(list((workspaces_tmp / "mini" / "notebooks").glob("*.json"))) >= 1, "the open session keeps its card"
    investigation._subscribers.pop(("mini", investigation.MAIN))
    folder_sessions._opening.clear()
    assert await folder_sessions.open_session("mini", new=True) == {"name": "mini", "open": False}
    [aside] = [r for r in folder_sessions.sessions("mini")["sessions"] if r["archive"]]
    assert aside["cards"] == 1 and aside["slot"] == "mini"
    folder_sessions._opening.clear()
    assert (await folder_sessions.open_session("mini", archive=aside["archive"]))["name"] == "mini"
    assert [r["cards"] for r in folder_sessions.sessions("mini")["sessions"] if r["slot"] == "mini" and not r["archive"]] == [1]
    for bad in ({"slot": "other"}, {"archive": "nope"}):
        with pytest.raises(ValueError):
            await folder_sessions.open_session("mini", **bad)


async def test_two_sessions_of_one_folder_share_its_files_and_nothing_else(data_tmp, workspaces_tmp):
    """A folder's second session open at once (config.add_session) is a workspace of its own over the same folder:
    its corpus is the folder, the folder still opens as its own workspace, the switcher numbers the second (the
    folder's own shows no number, as before it had a second), and its labels switch, prompt and temp folder are its
    own. An earlier session of either workspace comes back in the other, and listing names the workspace each session
    is in."""
    from app import config, corpus, events, folder_sessions, ledger, runtime_cc, start_page  # noqa: PLC0415

    folder = config.corpus_dir("mini")
    assert config.sessions_of("mini") == ["mini"] and config.session_number("mini") == 1
    assert config.add_session("mini")["name"] == "mini.2"
    assert config.add_session("mini", "mini.2")["name"] == "mini.2", "one already: as it is"
    for bad in (("mini.2", None), ("mini", "other")):
        with pytest.raises(ValueError):
            config.add_session(*bad)
    assert config.sessions_of("mini") == ["mini", "mini.2"] and config.session_of("mini.2") == "mini"
    assert config.corpus_dir("mini.2") == folder and config.workspace_for_cwd(folder / "sub") == "mini"
    assert {r["name"]: r.get("session") for r in corpus.list_corpora()} == {"mini": None, "mini.2": 2}
    assert [r["label"] for r in start_page.rows()] == ["mini", "mini · session 2"]

    (config.workspace_dir("mini.2") / "settings.json").write_text(json.dumps({ledger.LABELS_KEY: False}))
    assert ledger.labels_on("mini") and not ledger.labels_on("mini.2")
    own, beside = (events.render_prompts(events.SESSION_PROMPTS, str(folder), True, c) for c in ("mini", "mini.2"))
    assert own == events.render_prompts(events.SESSION_PROMPTS, str(folder), True) and beside != own
    tmps = [runtime_cc.workspace_tmp(c) for c in ("mini", "mini.2")]
    try:
        assert None in tmps or tmps[0] != tmps[1]
    finally:
        for c in ("mini", "mini.2"):
            runtime_cc.drop_workspace_tmp(config.workspace_path(c))

    _card("mini", "the folder's first session")
    moved = Path((await ledger.archive_workspace("mini"))["archived"]).name
    _card("mini.2", "the second session")
    _card("mini", "a new session")
    await ledger.restore_workspace("mini.2", {"archive": moved})
    rows = folder_sessions.listing("mini.2")
    assert sorted((r["slot"], bool(r["archive"])) for r in rows) == [("mini", False), ("mini.2", False), ("mini.2", True)]
    assert folder_sessions.listing("mini") == rows
    assert not any(r["held"] for r in rows)
    empty = folder_sessions.listing("mini", held={"mini.3"})
    assert empty == rows, "a workspace the folder does not have is no session"


async def test_a_second_session_s_checks_and_renders_read_its_own_cards(data_tmp, workspaces_tmp):
    """A second session of a folder resolves every ref in its own workspace, as its tools do, since the folder maps to
    the folder's own: its report's links (agents.check_refs), a card's render and card check (render.resolve_all), a
    takeaway's links (verify._ref_check) and main's read of a ref (tools._read_excerpt) find the session's own card,
    which the folder's own workspace does not hold."""
    from app import agents, config, render, tools, verify  # noqa: PLC0415

    config.add_session("mini")
    ref = f"card:{_card('mini.2', 'the second session')}"
    assert await agents.check_refs("mini.2", [ref]) == ([ref], [])
    assert "error" not in render.resolve_all("mini.2", [ref])[ref]
    assert await verify._ref_check(config.corpus_dir("mini.2"), ref, None, c="mini.2") is None
    assert not (await tools._read_excerpt(tools.Ctx("mini.2", tools.ANALYST), ref)).is_error
    assert await agents.check_refs("mini", [ref]) == ([], [ref]), "the folder's own session has no such card"


def test_two_sessions_cc_writes_tidy_waits_for_the_last_one(tmp_path):
    """Claude Code's sandbox makes .claude/.cc-writes/ in the session's working folder, which two sessions of one folder
    share: the folder goes when the last of them ends, not the first (runtime_cc._enter, _tidy)."""
    from app import runtime_cc  # noqa: PLC0415

    folder = tmp_path / "logs"
    folder.mkdir()
    runtime_cc._enter(folder)
    runtime_cc._enter(folder)
    (folder / ".claude" / ".cc-writes").mkdir(parents=True)
    runtime_cc._tidy(folder)
    assert (folder / ".claude" / ".cc-writes").is_dir()
    runtime_cc._tidy(folder)
    assert not (folder / ".claude").exists()


async def test_a_file_changed_since_it_was_read_is_read_again_before_a_write_lands(workspaces_tmp, tmp_path):
    """Main's Write and Edit on the Messages API refuse a file that changed on disk since the conversation last read or
    wrote it, in Claude Code's words (runtime_tools.STALE): another session of the folder, the analyst or a card wrote
    it meanwhile. Read again, the edit lands; a file the conversation has not read is written as before."""
    from app import config, runtime_tools  # noqa: PLC0415

    corpus = tmp_path / "logs"
    corpus.mkdir()
    notes = corpus / "notes.md"
    notes.write_text("one\n")
    ws = config.workspace_dir("mini")
    box = runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus, ws], write_roots=[corpus], reads={})
    assert not (await runtime_tools.call(box, "Read", {"file_path": str(notes)})).is_error
    notes.write_text("one\ntwo\n")  # the other session's write
    st = notes.stat()
    os.utime(notes, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    for name, args in (("Edit", {"file_path": str(notes), "old_string": "one", "new_string": "1"}),
                       ("Write", {"file_path": str(notes), "content": "mine\n"})):
        got = await runtime_tools.call(box, name, args)
        assert got.is_error and got.text == runtime_tools.STALE, name
    assert notes.read_text() == "one\ntwo\n"
    assert not (await runtime_tools.call(box, "Read", {"file_path": str(notes)})).is_error
    assert not (await runtime_tools.call(box, "Edit", {"file_path": str(notes), "old_string": "one",
                                                        "new_string": "1"})).is_error
    assert not (await runtime_tools.call(box, "Write", {"file_path": str(notes), "content": "1\n2\n"})).is_error
    assert not (await runtime_tools.call(box, "Write", {"file_path": str(corpus / "new.md"), "content": "x"})).is_error
    assert notes.read_text() == "1\n2\n"
