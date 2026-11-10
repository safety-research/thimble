"""`thimble-browser --setup`, as scripts/install.sh runs it (--sign-in) and as a person runs it: the line that says
the way chosen and what its check found; the API key from ANTHROPIC_API_KEY when it is set, else one pasted in the
workbench; the WIF config by its path alone; and the Claude Code sign-in, whose login the line names. Each credential
goes only to the host its own way names. No model is called: the Messages API check is faked, a made-up API answers
on 127.0.0.1, and `claude` is a stand-in script."""
from __future__ import annotations

import json
import shlex
from pathlib import Path

import pytest

from app import claude_access, config

FAKE_KEY = "-".join(("sk", "ant", "fake", "key", "for", "tests"))  # built, so no scanner takes it for a key
RULE, ORG = "fdrl_test_rule_value", "00000000-test-org-value"


def run_setup(capsys, *argv: str) -> tuple[int, str]:
    rc = claude_access.setup(list(argv))
    got = capsys.readouterr()
    return rc, got.out + got.err


def answers(monkeypatch, check: dict) -> None:
    """The check, faked: what it found."""

    async def fake():
        return {"how": claude_access.how(), "describe": claude_access.describe(), **check}

    monkeypatch.setattr(claude_access, "check", fake)


@pytest.fixture(autouse=True)
def no_key(monkeypatch):
    """No ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL where the test runs, unless the test sets one."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)


def wif_file(folder: Path) -> Path:
    token = folder / "token"
    token.write_text("eyJ.test.token")
    p = folder / "wif.toml"
    p.write_text(f'federation_rule_id = "{RULE}"\norganization_id = "{ORG}"\ntoken_file = "{token}"\n')
    p.chmod(0o600)
    return p


# --------------------------------------------------------------------------- the API key


def test_the_api_key_comes_from_anthropic_api_key_else_from_settings_and_is_never_printed(capsys, monkeypatch):
    claude_access.save(claude_access.API_KEY, key=FAKE_KEY)  # a key pasted in Settings
    answers(monkeypatch, {"ok": True})
    rc, out = run_setup(capsys, "--how", "api-key")
    assert rc == 0 and "the one saved in the workbench" in out and "Checked: Claude answers" in out
    assert claude_access.api_key() == FAKE_KEY and FAKE_KEY not in out
    # ANTHROPIC_API_KEY, once set, wins over the pasted one
    env_key = "-".join(("sk", "ant", "env", "made", "up"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", env_key)
    rc, out = run_setup(capsys, "--how", "api-key")
    assert rc == 0 and "from ANTHROPIC_API_KEY" in out and env_key not in out
    assert claude_access.api_key() == env_key
    assert FAKE_KEY not in json.dumps(claude_access.status()) and env_key not in json.dumps(claude_access.status())


# --------------------------------------------------------------------------- Workload Identity Federation


def test_wif_is_the_config_file_s_path_and_a_failed_check_names_it_and_the_command_after_the_fix(tmp_path, capsys,
                                                                                                 monkeypatch):
    p = wif_file(tmp_path)
    answers(monkeypatch, {"ok": True})
    rc, out = run_setup(capsys, "--wif-file", str(p))  # the file alone chooses WIF
    assert rc == 0 and f"Workload Identity Federation, with {p}" in out and "Checked: Claude answers" in out
    assert claude_access.read()["wif_file"] == str(p)
    assert RULE not in out and ORG not in out and "eyJ" not in out
    answers(monkeypatch, {"ok": False, "problem": {"what": "The identity token was not exchanged (401).", "fix": ""}})
    rc, out = run_setup(capsys, "--how", "wif", "--wif-file", str(p))
    assert rc == 2 and "The identity token was not exchanged (401)." in out
    assert f"After you fix that: thimble-browser --setup --how wif --wif-file {p}" in out


class StandInApi:
    """Anthropic's API on 127.0.0.1, made up: it exchanges any identity token and answers any message, and keeps the
    path of each request."""

    def __init__(self) -> None:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        paths = self.paths = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                paths.append(self.path.split("?")[0])
                body = ({"access_token": "made-up-access", "token_type": "bearer", "expires_in": 3600}
                        if self.path.startswith("/v1/oauth/token") else
                        {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
                         "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn",
                         "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}})
                data = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def test_a_key_or_an_identity_token_goes_only_to_the_host_its_own_way_names(tmp_path, monkeypatch):
    """ANTHROPIC_BASE_URL goes with ANTHROPIC_API_KEY, which the same shell sets, as Claude Code sends them; a key
    pasted in Settings goes to Anthropic's API whatever the shell sets. The identity token of WIF never goes to the
    shell's ANTHROPIC_BASE_URL either: the token exchange and the calls go to Anthropic's API, or to the base_url the
    config file names, which must be an https address unless it is this machine."""
    import asyncio

    from app import llm, wif

    shell, named = StandInApi(), StandInApi()
    try:
        monkeypatch.setenv("ANTHROPIC_BASE_URL", shell.url)
        claude_access.save(claude_access.API_KEY, key=FAKE_KEY)
        assert llm.client().base_url.host == "api.anthropic.com"
        monkeypatch.setenv("ANTHROPIC_API_KEY", "-".join(("sk", "ant", "env", "made", "up")))
        assert llm.client().base_url.host == "127.0.0.1", "the shell's key goes where the shell says"
        monkeypatch.delenv("ANTHROPIC_API_KEY")

        p = wif_file(tmp_path)
        claude_access.save(claude_access.WIF, wif_file=str(p))
        assert llm.client().base_url.host == "api.anthropic.com"
        p.write_text(p.read_text() + f'base_url = "{named.url}"\n')
        asyncio.run(llm.client().messages.create(model="claude-haiku-5-5", max_tokens=1,
                                                 messages=[{"role": "user", "content": "ok"}]))
        assert named.paths == ["/v1/oauth/token", "/v1/messages"] and shell.paths == []
        p.write_text(p.read_text().replace(named.url, "http://gw.example.invalid"))
        with pytest.raises(wif.WifError, match="base_url is an https address"):
            wif.load(str(p))
    finally:
        shell.server.shutdown()
        named.server.shutdown()


# --------------------------------------------------------------------------- the Claude Code sign-in check


def fake_cli(tmp_path: Path, monkeypatch, answer: dict, status: dict) -> Path:
    """A stand-in `claude`: `auth status` prints `status`, `-p` prints `answer` as JSON; each call's words are kept in
    calls.txt."""
    calls = tmp_path / "calls.txt"
    (tmp_path / "answer.json").write_text(json.dumps(answer))
    (tmp_path / "status.json").write_text(json.dumps(status))
    bin_ = tmp_path / "fake-claude"
    bin_.write_text("#!/bin/sh\n"
                    f'echo "$@" >> {shlex.quote(str(calls))}\n'
                    f'case "$1" in auth) cat {shlex.quote(str(tmp_path / "status.json"))};; '
                    f'-p) cat {shlex.quote(str(tmp_path / "answer.json"))};; esac\n')
    bin_.chmod(0o755)
    monkeypatch.setattr(config, "CLI_PATH", str(bin_))
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    return calls


def test_claude_code_check_runs_one_headless_turn_and_names_the_login(tmp_path, capsys, monkeypatch):
    calls = fake_cli(tmp_path, monkeypatch, {"is_error": False, "result": "ok"},
                     status={"loggedIn": True, "authMethod": "claude.ai"})
    rc, out = run_setup(capsys, "--how", "claude-code")
    assert rc == 0 and "logged in with a Claude account" in out and "Checked: Claude answers" in out
    turn = [line for line in calls.read_text().splitlines() if line.startswith("-p")]
    assert len(turn) == 1 and "--safe-mode" in turn[0] and "--max-turns 1" in turn[0]
    assert claude_access.read()["consent"]["text"] == claude_access.CONSENT, "choosing it is the consent"


def test_the_start_line_says_how_the_workbench_is_authenticated_or_what_is_missing(tmp_path, monkeypatch):
    assert claude_access.start_line().startswith("thimble does not know yet how to reach Claude.")
    claude_access.save(claude_access.API_KEY, key=FAKE_KEY)
    assert claude_access.start_line() == "authenticated via API key"
    claude_access.save(claude_access.WIF, wif_file=str(wif_file(tmp_path)))
    assert claude_access.start_line() == "authenticated via WIF"
    monkeypatch.setattr(config, "CLI_PATH", "claude")
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    assert claude_access.start_line() == "authenticated via Claude Code sign-in"
