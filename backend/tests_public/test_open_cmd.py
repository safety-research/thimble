"""`thimble open` (app/open_cmd.py, contract C12): the press opens the page on one object for one session, signed in,
with status only on stdout and stderr (never a code, TTY or not), a 60 s code in a redirect file the opener gets (a
300 s link for a remote terminal or --link), one opener per session and ref within 5 s, --session bound to the caller's
CLAUDE_CODE_SESSION_ID, and a shell open with no live main starting nothing. The server's own steps (start, register,
name the session, make it main) are the cli's, stood in for here; test_opener.py covers the opener and the files."""
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

    def request(self, method, url, body=None, timeout=5.0, **kw):
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
