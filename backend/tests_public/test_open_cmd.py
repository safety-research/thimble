"""`thimble open` (app/open_cmd.py, contract C12): the press opens the page on one object for one session, signed in,
with status only on stdout and stderr (never a code, TTY or not), a 60 s code in a redirect file the opener gets (a
300 s link for a remote terminal or --link), one opener per session and ref within 5 s, --session bound to the caller's
CLAUDE_CODE_SESSION_ID, and a shell open with no live main starting nothing. The server's own steps (start, register,
name the session, make it main) are the cli's, stood in for here; test_opener.py covers the opener and the files."""
from __future__ import annotations

import io
import json
import os
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

    def request(self, method, url, body=None, timeout=5.0, **kw):
        assert url.endswith("/api/ui/pair"), url
        self.mints.append(dict(body))
        return 200, {"code": f"{CODE}{len(self.mints)}", "expires_s": body["ttl"]}

    def codes(self) -> list[str]:
        return [f"{CODE}{i + 1}" for i in range(len(self.mints))]


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
        "name_session": lambda url, name, session, cwd, **kw: s.named.append((name, session)),
        "made_main": lambda name, session, cwd: s.made.append((name, session)),
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


def test_on_a_terminal_it_prints_one_line_and_no_code(server, popen, desktop, capsys, monkeypatch):
    out, err = run(capsys, ["--cwd", str(desktop)], tty=True, monkeypatch=monkeypatch)
    assert out == f"opened in the browser · 127.0.0.1:{PORT}\n" and err == ""
    assert all(c not in out for c in server.codes())


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


def test_eternal_terminal_and_the_ssh_host_fill_the_rows(server, popen, desktop, capsys, monkeypatch):
    monkeypatch.setenv("ET_VERSION", "6.2.9")
    monkeypatch.setenv("THIMBLE_SSH_HOST", "devbox")
    st = status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    assert st["et"] == f"et -t {PORT}:{PORT} devbox" and st["tunnel"].endswith(" devbox")


def test_no_browser_takes_the_remote_path_without_rows(server, popen, desktop, capsys, monkeypatch):
    monkeypatch.setenv("THIMBLE_NO_BROWSER", "1")
    st = status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    assert st["remote"] and st["tunnel"] is None and st["et"] is None and st["link_file"] and popen.calls == []


def test_link_makes_a_five_minute_link_and_runs_no_opener(server, popen, desktop, capsys, monkeypatch):
    st = status(run(capsys, ["--cwd", str(desktop), "--link", "--json"], monkeypatch=monkeypatch)[0])
    assert st["ok"] and not st["opened"] and st["link_file"] and popen.calls == []
    assert [m["ttl"] for m in server.mints] == [300]


def test_no_opener_answers_no_opener_with_a_link_to_copy(server, popen, desktop, capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    st = status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    assert not st["ok"] and st["error"]["code"] == "NO_OPENER" and st["link_file"] and popen.calls == []
    assert st["claim_file"] and st["port"] == PORT


def test_a_second_press_of_the_session_at_the_ref_within_five_seconds_runs_no_second_opener(
        server, popen, desktop, capsys, monkeypatch):
    """The mod's press and the UserPromptExpansion hook both run for one /thimble open: one tab."""
    first = status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    second = status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    assert first == second and len(popen.calls) == 1 and len(server.mints) == 1
    status(run(capsys, ["--cwd", str(desktop), "--ref", "card:x", "--json"], monkeypatch=monkeypatch)[0])
    assert len(popen.calls) == 2, "another ref is another press"
    record = opener.press_record(SID, "home")
    body = json.loads(record.read_text())
    body["at"] -= open_cmd.DEBOUNCE_S + 1
    record.write_text(json.dumps(body))
    status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    assert len(popen.calls) == 3, "after 5 s a press opens again"
    assert all(c not in record.read_text() for c in server.codes()), "the record holds no code"


def test_session_must_be_the_callers_own(server, popen, desktop, capsys, monkeypatch):
    st = status(run(capsys, ["--cwd", str(desktop), "--session", OTHER, "--json"], monkeypatch=monkeypatch)[0])
    assert st == {"ok": False, "error": {"code": "REFUSED_SESSION", **_words("REFUSED_SESSION")}}
    assert server.started == 0 and popen.calls == [] and server.mints == []
    st = status(run(capsys, ["--cwd", str(desktop), "--session", SID, "--json"], monkeypatch=monkeypatch)[0])
    assert st["ok"] and server.named == [("mini", SID)]


def _words(code: str) -> dict:
    msg, fix = open_cmd.ERRORS[code]
    return {"message": msg, "fix": fix}


def test_a_shell_open_with_no_live_main_starts_nothing_and_with_one_targets_it(
        server, popen, desktop, capsys, monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    st = status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    assert st["error"]["code"] == "NO_SESSION" and st["error"]["message"] == (
        "No Claude Code session is active in this folder. Start claude (or thimble) here.")
    assert server.started == 0 and popen.calls == []
    monkeypatch.setattr(open_cmd, "live_main", lambda cwd: OTHER)
    st = status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    assert st["ok"] and server.named == [("mini", OTHER)]
    monkeypatch.setattr(open_cmd, "live_main", lambda cwd: None)
    st = status(run(capsys, ["--cwd", str(desktop), "--session", SID, "--ref", "x", "--json"], monkeypatch=monkeypatch)[0])
    assert st["ok"], "the mod names its session (its process has no CLAUDE_CODE_SESSION_ID)"


def test_live_main_reads_launch_json_and_the_claude_process(monkeypatch, tmp_path):
    from app import config

    monkeypatch.setattr(config, "workspace_for_cwd", lambda cwd: "mini")
    monkeypatch.setattr(cli, "read_launch", lambda c: {"session": OTHER, "pid": 4242})
    monkeypatch.setattr(cli, "live_launch", lambda rec, c=None: True)
    assert open_cmd.live_main(tmp_path) == OTHER
    monkeypatch.setattr(cli, "live_launch", lambda rec, c=None: False)
    assert open_cmd.live_main(tmp_path) is None, "a main whose claude is gone"


@pytest.mark.parametrize("ref", ["x" * 513, "card:a\nb", "a\x1b]8;;http://x\x07"])
def test_a_long_ref_or_one_with_control_characters_is_refused_before_anything_starts(
        server, popen, desktop, capsys, monkeypatch, ref):
    st = status(run(capsys, ["--cwd", str(desktop), "--ref", ref, "--json"], monkeypatch=monkeypatch)[0])
    assert st["error"]["code"] == "REFUSED_REF" and server.started == 0 and popen.calls == []


def test_the_home_folder_is_refused(server, popen, desktop, capsys, monkeypatch):
    st = status(run(capsys, ["--cwd", str(Path.home()), "--json"], monkeypatch=monkeypatch)[0])
    assert st["error"]["code"] == "REFUSED_HOME" and server.started == 0


def test_hook_reads_the_session_and_folder_from_stdin_prints_nothing_and_skips_other_arguments(
        server, popen, desktop, capsys, monkeypatch):
    hook = {"session_id": SID, "cwd": str(desktop), "command_args": "open"}
    out, err = run(capsys, ["--hook"], stdin=json.dumps(hook), monkeypatch=monkeypatch)
    assert out == "" and err == "" and len(popen.calls) == 1 and server.named == [("mini", SID)]
    out, err = run(capsys, ["--hook"], stdin=json.dumps({**hook, "command_args": "fresh"}), monkeypatch=monkeypatch)
    assert out == "" and len(popen.calls) == 1 and len(server.mints) == 1, "/thimble fresh is no press"
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", OTHER)
    out, _ = run(capsys, ["--hook"], stdin=json.dumps(hook), monkeypatch=monkeypatch)
    assert out == "" and len(popen.calls) == 1, "a hook input naming another session than the caller's is refused"


def test_the_proxy_flag(server, popen, desktop, capsys, monkeypatch):
    from app import config

    monkeypatch.setenv("HTTPS_PROXY", "http://proxy:3128")
    monkeypatch.setattr(config, "GIVEN_NO_PROXY", {})
    st = status(run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)[0])
    assert st["proxy"] is True
    monkeypatch.setattr(config, "GIVEN_NO_PROXY", {"NO_PROXY": "example.com,127.0.0.1"})
    assert open_cmd.proxy_set(os.environ) is False
    assert open_cmd.proxy_set({"ALL_PROXY": "socks5://x", "no_proxy": "localhost"}) is False
    assert open_cmd.proxy_set({"ALL_PROXY": "socks5://x"}) is True


def test_a_failure_inside_is_a_status_line_with_no_traceback_and_no_code(server, popen, desktop, capsys, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError(f"broke at http://127.0.0.1:{PORT}/#p={CODE}9")

    monkeypatch.setattr(opener, "open_url", boom)
    out, err = run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)
    st = status(out)
    assert st["error"]["code"] == "START" and "Traceback" not in out + err and CODE not in out + err
    log = (opener.home() / "server.log").read_text()
    assert "RuntimeError" in log and f"{CODE}9" not in log and "#p=<code>" in log, "logged, with the code scrubbed"


def test_printed_output_of_the_steps_never_reaches_stdout(server, popen, desktop, capsys, monkeypatch):
    """cli steps that print (refuse_foreign's line) print into the log, not into the status."""
    def foreign(url=None):
        print("thimble: port 29280 (set by THIMBLE_PORT) is in use by another program.")
        return True

    monkeypatch.setattr(cli, "refuse_foreign", foreign)
    out, err = run(capsys, ["--cwd", str(desktop), "--json"], monkeypatch=monkeypatch)
    assert status(out)["error"]["code"] == "PORT" and err == ""
