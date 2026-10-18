"""`thimble open` (app/open_cmd.py, contract C12): the press opens the page on one object for one session, signed in,
with status only on stdout and stderr (never a code, TTY or not), a 60 s code in a redirect file the opener gets (a
300 s link for a remote terminal or --link), one opener per session and ref within 5 s, --session bound to the caller's
CLAUDE_CODE_SESSION_ID, and a shell open with no live main starting nothing; a signed-in tab of the page that is live
takes the press, and no other opens. The server's own steps (start, register, name the session, make it main) are the
cli's, stood in for here; test_opener.py covers the opener and the files."""
from __future__ import annotations

import io
import json
import stat
from pathlib import Path

import pytest

from app import cli, open_cmd, opener

SID = "5e55a000-0000-4000-8000-0000000000b1"
OTHER = "5e55a000-0000-4000-8000-0000000000b2"
CODE = "SecretCode_"
PORT = 29280


class Server:
    """The cli steps the press runs, stood in for: what each was asked."""

    def __init__(self):
        self.started = 0
        self.mints: list[dict] = []
        self.named: list[tuple] = []
        self.made: list[tuple] = []
        self.steps: list[str] = []  # name_session and made_main, in the order the press ran them
        self.tab = False  # a signed-in tab of the page is live and takes a press handed to it
        self.presses: list[dict] = []

    def request(self, method, url, body=None, timeout=5.0, **kw):
        if url.endswith("/api/ui/press"):
            self.presses.append(dict(body))
            return 200, {"reused": self.tab}
        assert url.endswith("/api/ui/pair"), url
        self.mints.append(dict(body))
        return 200, {"code": f"{CODE}{len(self.mints)}", "expires_s": body["ttl"]}

    def codes(self) -> list[str]:
        return [f"{CODE}{i + 1}" for i in range(len(self.mints))]


@pytest.fixture(autouse=True)
def _dirs_kept(monkeypatch):
    """config's data and workspaces folders put back after each test: the stand-in resolve_env names no workspaces
    folder, so core's activation (cli.server_dirs) fails part way in these tests and would leave config.DATA_DIR on the
    test's folder for the tests that run after (test_pairing found no corpus)."""
    from app import config  # noqa: PLC0415

    monkeypatch.setattr(config, "DATA_DIR", config.DATA_DIR)
    monkeypatch.setattr(config, "WORKSPACES_DIR", config.WORKSPACES_DIR)


@pytest.fixture()
def server(monkeypatch, tmp_path):
    s = Server()
    data = tmp_path / "data"
    data.mkdir()

    def ensure_running(wait_s):
        s.started += 1
        return True

    for name, value in {
        "in_sandbox": lambda: False, "resolve_env": lambda: {"data_dir": str(data), "dev": False},
        "api_url": lambda p=None: f"http://127.0.0.1:{PORT}", "refuse_foreign": lambda url=None: False,
        "ensure_running": ensure_running, "serves": lambda url=None: True,
        "open_workspace": lambda cwd, d, url, here=False: ("mini", False),
        "name_session": lambda url, name, session, cwd, **kw: (s.named.append((name, session)),
                                                               s.steps.append("name_session")),
        "made_main": lambda name, session, cwd: (s.made.append((name, session)), s.steps.append("made_main")),
        "has_ui_build": lambda: True, "read_state": lambda: {"url": f"http://127.0.0.1:{PORT}"},
        "own_sandbox_here": lambda cwd: False, "setup_warnings": lambda cwd: [], "_request": s.request,
    }.items():
        monkeypatch.setattr(cli, name, value)
    monkeypatch.setattr(open_cmd, "live_main", lambda cwd: None)
    return s


class Popen:
    def __init__(self):
        self.calls: list[list[str]] = []

    def __call__(self, argv, **kw):
        self.calls.append(list(argv))
        return object()


@pytest.fixture()
def popen(monkeypatch):
    p = Popen()
    monkeypatch.setattr(opener.subprocess, "Popen", p)
    return p


@pytest.fixture()
def desktop(monkeypatch, tmp_path):
    """A local desktop session: xdg-open on PATH, a DISPLAY, no SSH, no proxy, the caller's session id."""
    d = tmp_path / "bin"
    d.mkdir()
    (d / "xdg-open").write_text("#!/bin/sh\n")
    (d / "xdg-open").chmod(0o755)
    for name in ("SSH_CONNECTION", "SSH_TTY", "ET_VERSION", "TMUX", "VSCODE_IPC_HOOK_CLI", "BROWSER", "WAYLAND_DISPLAY",
                 "THIMBLE_NO_BROWSER", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy",
                 "all_proxy", "THIMBLE_SSH_HOST"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("PATH", f"{d}:/usr/bin:/bin")
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SID)
    monkeypatch.setattr(opener, "_default_browser", lambda env: "")
    monkeypatch.setattr(opener, "_ancestors", lambda pid, limit=64: [])
    folder = tmp_path / "corpus"
    folder.mkdir()
    return folder


def run(capsys, argv: list[str], tty: bool = False, stdin: str = "", monkeypatch=None) -> tuple[str, str]:
    if monkeypatch is not None:
        monkeypatch.setattr(open_cmd.sys.stdout, "isatty", lambda: tty, raising=False)
    assert open_cmd.main(argv, stdin=io.StringIO(stdin)) == 0
    got = capsys.readouterr()
    return got.out, got.err


def status(out: str) -> dict:
    return json.loads(out)


def test_a_press_opens_the_page_with_a_sixty_second_code_in_a_redirect_file_and_prints_status_only(
        server, popen, desktop, capsys, monkeypatch):
    out, err = run(capsys, ["--cwd", str(desktop), "--ref", "card:abc", "--json"], monkeypatch=monkeypatch)
    st = status(out)
    assert set(st) == {"ok", "port", "url", "opened", "remote", "tunnel", "et", "link_file", "claim_file", "proxy"}
    assert st["ok"] and st["opened"] and not st["remote"] and st["port"] == PORT
    assert st["url"] == f"http://127.0.0.1:{PORT}/?ws=mini&ref=card:abc"
    assert (st["tunnel"], st["et"], st["link_file"], st["proxy"]) == (None, None, None, False)
    [code] = server.codes()
    assert code not in out and code not in err and "#p=" not in out + err
    [mint] = server.mints
    assert mint["ttl"] == 60 and mint["ws"] == "mini"
    assert st["claim_file"] == str(opener.claim_path(mint["open"])), "the claim mark names the code's open"
    [argv] = popen.calls
    assert argv[0] == "xdg-open" and code not in " ".join(argv)
    page = Path(argv[1])
    assert page == opener.open_dir() / f"{mint['open']}.html" and f"#p={code}" in page.read_text()
    assert stat.S_IMODE(page.stat().st_mode) == 0o600
    assert server.started == 1 and server.named == [("mini", SID)] and server.made == [("mini", SID)]
    assert server.steps == ["made_main", "name_session"], \
        "the transport moves to the server before the server attaches the session (session.attach, H4)"


def test_a_remote_terminal_gets_a_300_second_link_in_its_link_file_and_the_tunnel_row(
        server, popen, desktop, capsys, monkeypatch):
    monkeypatch.setenv("SSH_CONNECTION", "10.1.2.3 5000 10.1.2.4 22")
    out, err = run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)
    st = status(out)
    assert st["ok"] and st["remote"] and not st["opened"] and popen.calls == [], "no opener over SSH"
    assert st["tunnel"] == f"ssh -N -L {PORT}:127.0.0.1:{PORT} <your ssh host>" and st["et"] is None
    [mint] = server.mints
    assert mint["ttl"] == 300
    link = Path(st["link_file"])
    assert link == opener.home() / "links" / f"{SID}.json" and stat.S_IMODE(link.stat().st_mode) == 0o600
    [code] = server.codes()
    assert json.loads(link.read_text())["url"] == f"http://127.0.0.1:{PORT}/?ws=mini#p={code}"
    assert code not in out + err
    out, _ = run(capsys, ["--cwd", str(desktop), "--ref", "checks"], tty=True, monkeypatch=monkeypatch)
    assert "ssh -N -L" in out and str(link) in out and CODE not in out


def test_session_must_be_the_callers_own(server, popen, desktop, capsys, monkeypatch):
    st = status(run(capsys, ["--cwd", str(desktop), "--session", OTHER, "--json"], monkeypatch=monkeypatch)[0])
    assert st == {"ok": False, "error": {"code": "REFUSED_SESSION", **_words("REFUSED_SESSION")}}
    assert server.started == 0 and popen.calls == [] and server.mints == []
    st = status(run(capsys, ["--cwd", str(desktop), "--session", SID, "--json"], monkeypatch=monkeypatch)[0])
    assert st["ok"] and server.named == [("mini", SID)]


def _words(code: str) -> dict:
    msg, fix = open_cmd.ERRORS[code]
    return {"message": msg, "fix": fix}


@pytest.mark.parametrize("ref", ["x" * 513, "a\x1b]8;;http://x\x07"])
def test_a_long_ref_or_one_with_control_characters_is_refused_before_anything_starts(
        server, popen, desktop, capsys, monkeypatch, ref):
    st = status(run(capsys, ["--cwd", str(desktop), "--ref", ref, "--json"], monkeypatch=monkeypatch)[0])
    assert st["error"]["code"] == "REFUSED_REF" and server.started == 0 and popen.calls == []


def test_a_live_tab_of_the_page_takes_the_press_and_no_other_tab_opens(server, popen, desktop, capsys, monkeypatch):
    """Bug hunt round 9, J8: every press opened one more tab, though a signed-in tab of the same page was open and live
    (after a quit, `claude -c`, `/thimble browser`, `thimble -c` and two ↗, five tabs). The press hands its ref to that
    tab: no opener runs and no code is made, and the status says so; with no live tab, the press opens one."""
    server.tab = True
    out, err = run(capsys, ["--cwd", str(desktop), "--ref", "card:abc", "--json"], monkeypatch=monkeypatch)
    st = status(out)
    assert st["ok"] and st["opened"] and st["reused"] and not st["remote"]
    assert popen.calls == [] and server.mints == [], "no other tab, no code"
    [press] = server.presses
    assert (press["ws"], press["ref"]) == ("mini", "card:abc")
    assert st["claim_file"] == str(opener.claim_path(press["open"]))
    assert open_cmd.status_line(st) == f"shown in the thimble tab already open in your browser · 127.0.0.1:{PORT}"
    # no live tab: the press opens one
    server.tab = False
    st = status(run(capsys, ["--cwd", str(desktop), "--ref", "card:def", "--json"], monkeypatch=monkeypatch)[0])
    assert st["ok"] and st["opened"] and not st.get("reused") and len(popen.calls) == 1 and len(server.mints) == 1


async def test_the_server_hands_a_press_to_a_signed_in_tab_and_waits_for_it_to_take_it():
    """investigation.press: a press goes to the signed-in tabs' streams alone, as an event in no log, and counts once a
    tab says it took it; with no tab, or none that answers, it does not."""
    import asyncio

    from app import investigation

    assert await investigation.press("mini", "card:abc", "open0000aa") is False, "no tab open"
    q: asyncio.Queue = asyncio.Queue()
    investigation._tabs.setdefault("mini", set()).add(q)
    try:
        waiting = asyncio.create_task(investigation.press("mini", "card:abc", "open0000ab"))
        told = await asyncio.wait_for(q.get(), 1)
        assert (told.event, told.data) == ("press", {"ref": "card:abc", "open": "open0000ab"})
        assert investigation.took("open0000ab") is True
        assert await waiting is True
        assert investigation.took("open0000ab") is False, "taken once"
        assert await investigation.press("mini", "home", "open0000ac", wait_s=0.05) is False, "a tab that does not answer"
    finally:
        investigation._tabs["mini"].discard(q)


async def test_k12_a_press_waits_for_a_stopped_tab_to_come_back_and_hands_it_the_press():
    """Bug hunt round 10, K12: after `claude -c` and `/thimble browser`, or `thimble -c`, a new tab opened beside the one
    that stopped with the session, which then tried to close itself and could not (a browser lets a script close only a
    tab a script opened). A stopped tab comes back by itself once the server answers (frontend StoppedPage): a press
    while no tab is live waits for it and hands it the press as its stream opens, so no other tab opens. A tab that was
    closed, not stopped, is not waited for, nor one that does not come back."""
    import asyncio

    from app import config, investigation

    class Req:
        headers: dict = {}

    c = "mini"
    config.workspace_dir(c)
    tabs = investigation._tabs.setdefault(c, set())
    try:
        # a signed-in tab's stream opens, and its session ends: the tab stops, it is not closed
        await investigation._stream(c, investigation.MAIN, Req(), tab=True)
        [q0] = tabs
        investigation.page_ended(c)
        tabs.discard(q0)
        investigation._stream_ended(c)
        assert investigation.stopped_tab(c)
        # the press after `claude -c`: no tab is live, so it waits for the stopped one
        waiting = asyncio.create_task(investigation.press(c, "card:abc", "open0000ba", stopped_wait_s=5))
        await asyncio.sleep(0.05)
        assert not waiting.done(), "a press waits for the stopped tab"
        # the stopped tab comes back: its stream opens, and the press is handed to it
        await investigation._stream(c, investigation.MAIN, Req(), tab=True)
        [q] = tabs
        told = q.get_nowait()
        assert (told.event, told.data) == ("press", {"ref": "card:abc", "open": "open0000ba"})
        assert investigation.took("open0000ba") is True and await waiting is True
        # the analyst closes it: its stream ends while the server and the session run, so no press waits for it
        tabs.discard(q)
        investigation._stream_ended(c)
        assert not investigation.stopped_tab(c)
        assert await investigation.press(c, "home", "open0000bb", stopped_wait_s=5) is False
        # a stopped tab that does not come back in time: the press opens a tab, and the next one waits for none
        investigation.note_tab(c)
        assert await investigation.press(c, "home", "open0000bc", stopped_wait_s=0.05) is False
        assert not investigation.stopped_tab(c)
        from app import demo
        assert demo.full_kept(Path(investigation.TABS_FILE)), "this machine's tabs are no part of a full export"
    finally:
        tabs.clear()
        investigation._subscribers.pop((c, investigation.MAIN), None)
        investigation._ended.discard(c)
