"""A folder's sessions at a start of thimble-browser, and two of them open at once (folder_sessions.py, cli.pick_session,
cli.open_session, config.add_session): a plain start in a folder that has a session asks in the terminal which to open,
a new one first; a folder never opened starts a new session at once, as does a start that cannot ask. A second shell's
session runs beside the one the first shell holds, in a workspace of its own over the same folder, so nothing of the
first moves, and each keeps its own chat, cards, labels, settings and temp folder; only the folder's files are shared,
and a write over a file that changed since it was read is refused, as Claude Code refuses it."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import cli

BACKEND = Path(__file__).resolve().parents[1]


def _card(c: str, words: str) -> None:
    from app import config, notebook  # noqa: PLC0415

    nb = notebook.create_notebook(config.workspace_dir(c), "G")
    notebook.insert_cell(c, nb["id"], notebook.new_cell("note", "test", words, nb["id"], payload={"text": words}))


def _answers(monkeypatch, *typed: str) -> list[str]:
    """The terminal, answering the picker with `typed` in turn; what it was asked."""
    asked: list[str] = []
    left = list(typed)

    def answer(prompt: str = "") -> str:
        asked.append(prompt)
        if not left:
            raise EOFError
        return left.pop(0)

    monkeypatch.setattr("builtins.input", answer)
    monkeypatch.setattr(cli, "interactive", lambda: True)
    return asked


def _other_shell(name: str) -> subprocess.Popen:
    """A thimble-browser in another shell that holds workspace `name` (cli.hold_session) until it is killed."""
    other = subprocess.Popen([sys.executable, "-c", f"from app import cli; cli.hold_session({name!r}); "
                              "print('holding', flush=True); import time; time.sleep(100)"],
                             cwd=BACKEND, env=dict(os.environ), stdout=subprocess.PIPE, text=True)
    assert other.stdout is not None and other.stdout.readline().strip() == "holding"
    return other


def test_a_folder_never_opened_starts_a_new_session_and_one_with_a_session_asks_first(home, data, monkeypatch, capsys):
    """A plain start (`auto`) in a folder with no session starts a new one without asking. Once the folder has a
    session, the start lists a new session first and then the folder's sessions, the latest first; Enter or 1 takes a
    new session, and a number one of the sessions. A start that cannot ask (stdin or stdout not a terminal) and an
    explicit `--session new` start a new session without asking, as before."""
    cwd = data / "mini"
    asked = _answers(monkeypatch)
    with cli.server_dirs():
        assert cli.pick_session(cwd, data, "auto") == cli.NEW_SESSION
    assert asked == [] and capsys.readouterr().out == ""
    with cli.server_dirs():
        _card("mini", "two incidents")
    for typed, want in (("", cli.NEW_SESSION), ("1", cli.NEW_SESSION),
                        ("2", {"archive": None, "chat": "new", "slot": "mini", "held": False})):
        asked = _answers(monkeypatch, "7", typed)
        with cli.server_dirs():
            assert cli.pick_session(cwd, data, "auto") == want, typed
        out = capsys.readouterr().out.splitlines()
        assert asked == [cli.PICK_NEW_ASK] * 2
        assert out[:2] == [cli.PICK_HEAD.format(cwd=cwd), f"  1. {cli.PICK_NEW}"], out
        assert out[2].startswith("  2. ") and "1 card" in out[2] and "(no message)" in out[2], out
        assert out[3] == "  a number from 1 to 2, or Enter for a new session", out
    asked = _answers(monkeypatch)
    with cli.server_dirs():
        assert cli.pick_session(cwd, data, "new") == cli.NEW_SESSION
        monkeypatch.setattr(cli, "interactive", lambda: False)
        assert cli.pick_session(cwd, data, "auto") == cli.NEW_SESSION
    assert asked == []
    asked = _answers(monkeypatch)  # Ctrl-D at the picker: nothing opens
    with cli.server_dirs():
        assert cli.pick_session(cwd, data, "auto") is None


@pytest.mark.timeout(120)
def test_a_second_shell_runs_a_session_beside_the_one_another_shell_holds(home, data, monkeypatch, capsys):
    """While a thimble-browser in another shell holds the folder's session, a start lists that session marked
    `open in another shell`, even when it holds nothing yet. Picking it opens it as it is: nothing moves and no request
    is sent. A new session does not move it aside: it opens in a second workspace of the folder (`POST
    /api/ws/mini/sessions`), whose chat the register route opens, and this shell holds it. Once the other shell has
    ended, the folder's own workspace is free again, and a new session takes it, moving its session aside. The server's
    routes are faked; the sessions route writes the workspace's sidecar as config.add_session does."""
    from app import config  # noqa: PLC0415

    cwd = data / "mini"
    sent: list[tuple[str, dict]] = []

    def answer(method, url, body=None, timeout=5.0):
        route = url.split("/api/", 1)[1]
        sent.append((route, body or {}))
        if route == "ws/mini/sessions":
            return 200, {"name": config.add_session("mini")["name"]}
        if route.endswith("/archive"):
            return 200, {"archived": "aside"}
        return 200, {"name": "mini"}

    monkeypatch.setattr(cli, "_request", answer)
    monkeypatch.setattr(cli, "HELD_SESSIONS", {})
    other = _other_shell("mini")
    try:
        assert cli.held_elsewhere("mini") and not cli.held_elsewhere("mini.2")
        _answers(monkeypatch, "2")
        with cli.server_dirs():
            chosen = cli.pick_session(cwd, data, "auto")
        out = capsys.readouterr().out.splitlines()
        assert chosen == {"archive": None, "chat": "new", "slot": "mini", "held": True}
        assert f"[{cli.HELD_MARK}] (no message)" in out[2], out
        with cli.server_dirs():
            assert cli.open_session("http://127.0.0.1:1", "mini", cwd, chosen) == "mini"
        assert sent == [] and capsys.readouterr().out.splitlines() == [cli.BROWSER_LINE.format(what=cli.HELD_LINE)]
        with cli.server_dirs():
            _card("mini", "the first shell's card")
            assert cli.open_session("http://127.0.0.1:1", "mini", cwd, dict(cli.NEW_SESSION)) == "mini.2"
            cli.hold_session("mini.2")
            assert config.sessions_of("mini") == ["mini", "mini.2"]
            assert (config.WORKSPACES_DIR / "mini" / "notebooks").is_dir(), "the other shell's session stays"
        assert [r for r, _ in sent] == ["ws/mini/sessions", "corpora/register"]
        assert sent[-1][1] == {"path": str(cwd.resolve()), "exact": True, "chat": "new", "session": "mini.2"}
        assert not cli.held_elsewhere("mini.2"), "this process's own hold"
    finally:
        other.kill()
        other.wait(timeout=10)
    assert not cli.held_elsewhere("mini")
    sent.clear()
    with cli.server_dirs():
        assert cli.open_session("http://127.0.0.1:1", "mini", cwd, dict(cli.NEW_SESSION)) == "mini"
    assert [r for r, _ in sent] == ["ws/mini/archive", "corpora/register"] and "session" not in sent[-1][1]
    for fd in cli.HELD_SESSIONS.values():
        os.close(fd)


async def test_two_sessions_of_one_folder_share_its_files_and_nothing_else(data_tmp, workspaces_tmp):
    """A folder's second session open at once (config.add_session) is a workspace of its own over the same folder:
    its corpus is the folder, the folder still opens as its own workspace, the switcher numbers both, and its labels
    switch, prompt and temp folder are its own. An earlier session of either workspace comes back in the other, and
    listing names the workspace each session is in."""
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
    assert {r["name"]: r.get("session") for r in corpus.list_corpora()} == {"mini": 1, "mini.2": 2}
    assert [r["label"] for r in start_page.rows()] == ["mini · session 1", "mini · session 2"]

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
