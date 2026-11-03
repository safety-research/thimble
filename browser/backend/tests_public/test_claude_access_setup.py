"""`thimble-browser --setup`, as scripts/install.sh runs it (--sign-in, or --keep) and as a person runs it: the line
that says the way chosen and what its check found, in the install's words; the API key from ANTHROPIC_API_KEY when it
is set, else one pasted in Settings, and never a key read from a file or typed here; the WIF config by its path alone;
and the Claude Code sign-in, whose `claude` gets the environment as it is and whose login the line names. No model is
called: the Messages API check is faked, and `claude` is a stand-in script."""
from __future__ import annotations

import json
import os
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
    """No ANTHROPIC_API_KEY where the test runs, unless the test sets one."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def wif_file(folder: Path) -> Path:
    token = folder / "token"
    token.write_text("eyJ.test.token")
    p = folder / "wif.toml"
    p.write_text(f'federation_rule_id = "{RULE}"\norganization_id = "{ORG}"\ntoken_file = "{token}"\n')
    p.chmod(0o600)
    return p


# --------------------------------------------------------------------------- the API key


def test_the_api_key_from_the_environment_is_used_and_never_printed(capsys, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    answers(monkeypatch, {"ok": True})
    rc, out = run_setup(capsys, "--how", "api-key")
    assert rc == 0
    assert out == "Sign-in: an API key, from ANTHROPIC_API_KEY. Checked: Claude answers.\n"
    assert claude_access.how() == claude_access.API_KEY and claude_access.api_key() == FAKE_KEY
    assert not claude_access.key_path().exists(), "the key of the environment is not saved"
    assert FAKE_KEY not in json.dumps(claude_access.status()) and claude_access.status()["env_key"] is True


def test_without_anthropic_api_key_the_workbench_asks_for_a_key_when_it_starts(capsys):
    """--sign-in api-key with no ANTHROPIC_API_KEY: the choice is saved, nothing is read from the terminal or a file,
    and the line says that the workbench asks in its Settings; the page's first start shows that step."""
    rc, out = run_setup(capsys, "--how", "api-key")
    assert rc == 0
    assert out == ("Sign-in: an API key. ANTHROPIC_API_KEY is not set here, so the workbench asks for a key in its "
                   "Settings when it starts.\n")
    assert claude_access.how() == claude_access.API_KEY
    assert claude_access.problem()["what"] == "No API key: ANTHROPIC_API_KEY is not set, and no key is saved."


def test_a_key_pasted_in_settings_is_used_when_anthropic_api_key_is_not_set(capsys, monkeypatch):
    claude_access.save(claude_access.API_KEY, key=FAKE_KEY)
    answers(monkeypatch, {"ok": True})
    rc, out = run_setup(capsys, "--how", "api-key")
    assert rc == 0 and out == "Sign-in: an API key, the one saved in Settings. Checked: Claude answers.\n"
    assert FAKE_KEY not in out
    # ANTHROPIC_API_KEY, once set, wins over the pasted one
    monkeypatch.setenv("ANTHROPIC_API_KEY", "-".join(("sk", "ant", "other", "made", "up")))
    assert claude_access.api_key() != FAKE_KEY and claude_access.describe() == "an API key, from ANTHROPIC_API_KEY"


def test_no_key_file_and_no_search_for_wif_files(capsys):
    """--key-file and --find-wif are gone: setup reads no key from a file or a terminal, and looks for no file."""
    for gone in (["--key-file", "x"], ["--find-wif"]):
        with pytest.raises(SystemExit):
            claude_access.setup(gone)
    capsys.readouterr()
    assert not hasattr(claude_access, "read_key_file") and not hasattr(claude_access, "find_wif")


def test_a_failed_check_says_why_and_the_command_after_the_fix(capsys, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    answers(monkeypatch, {"ok": False, "problem": {"what": "Claude refused the credentials (401) at a made-up time.",
                                                     "fix": ""}})
    rc, out = run_setup(capsys, "--how", "api-key")
    assert rc == 2
    assert out.splitlines() == [
        "Sign-in: an API key, from ANTHROPIC_API_KEY. The check failed: Claude refused the credentials (401) at a "
        "made-up time.",
        "  After you fix that: thimble-browser --setup --how api-key"]
    assert FAKE_KEY not in out


# --------------------------------------------------------------------------- Workload Identity Federation


def test_wif_is_the_config_file_s_path(tmp_path, capsys, monkeypatch):
    p = wif_file(tmp_path)
    answers(monkeypatch, {"ok": True})
    rc, out = run_setup(capsys, "--wif-file", str(p))  # the file alone chooses WIF
    assert rc == 0 and out == f"Sign-in: Workload Identity Federation, with {p}. Checked: Claude answers.\n"
    assert claude_access.read()["wif_file"] == str(p)
    assert RULE not in out and ORG not in out and "eyJ" not in out


def test_a_wif_check_that_fails_names_the_file_and_the_command_after_the_fix(tmp_path, capsys, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    p = wif_file(home)
    answers(monkeypatch, {"ok": False, "problem": {"what": "The identity token was not exchanged (401).", "fix": ""}})
    rc, out = run_setup(capsys, "--how", "wif", "--wif-file", str(p))
    assert rc == 2
    assert out.splitlines() == [
        "Sign-in: Workload Identity Federation, with ~/wif.toml. The check failed: The identity token was not "
        "exchanged (401).",
        "  After you fix that: thimble-browser --setup --how wif --wif-file ~/wif.toml"]


def test_a_wif_file_that_cannot_be_used_is_not_saved(tmp_path, capsys):
    gone = tmp_path / "nope.toml"
    rc, out = run_setup(capsys, "--how", "wif", "--wif-file", str(gone))
    assert rc == 1
    assert out.splitlines() == [
        f"Sign-in: Workload Identity Federation, with {gone}. It was not saved: there is no file {gone}.",
        f"  After you fix that: thimble-browser --setup --how wif --wif-file {shlex.quote(str(gone))}"]
    assert claude_access.how() == ""


# --------------------------------------------------------------------------- the install's run: --keep, no terminal


def test_with_no_choice_and_no_terminal_the_workbench_asks_when_it_starts(capsys):
    rc, out = run_setup(capsys, "--keep")
    assert rc == 0 and out == "Sign-in: not chosen yet. The workbench asks when it starts.\n"
    assert claude_access.how() == ""


def test_keep_leaves_a_way_chosen_before_and_checks_it(tmp_path, capsys, monkeypatch):
    claude_access.save(claude_access.WIF, wif_file=str(wif_file(tmp_path)))
    answers(monkeypatch, {"ok": True})
    rc, out = run_setup(capsys, "--keep")
    assert rc == 0 and out.startswith("Sign-in: Workload Identity Federation, with ") and "Checked" in out
    assert claude_access.how() == claude_access.WIF


# --------------------------------------------------------------------------- the Claude Code sign-in check


def fake_cli(tmp_path: Path, monkeypatch, answer: dict, rc: int = 0, status: dict | None = None) -> Path:
    """A stand-in `claude`: `auth status` prints `status` (default: signed in), `-p` prints `answer` as JSON and exits
    `rc`; each call's words are kept in calls.txt, and the names of the ANTHROPIC_* variables it got in env.txt."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    calls = tmp_path / "calls.txt"
    (tmp_path / "answer.json").write_text(json.dumps(answer))
    (tmp_path / "status.json").write_text(json.dumps(status or {"loggedIn": True}))
    (tmp_path / "env.txt").write_text("")
    bin_ = tmp_path / "fake-claude"
    bin_.write_text("#!/bin/sh\n"
                    f'echo "$@" >> {shlex.quote(str(calls))}\n'
                    f'env | sed -n "s/^\\(ANTHROPIC_[A-Z_]*\\)=.*/\\1/p" >> {shlex.quote(str(tmp_path / "env.txt"))}\n'
                    f'case "$1" in auth) cat {shlex.quote(str(tmp_path / "status.json"))};; '
                    f'-p) cat {shlex.quote(str(tmp_path / "answer.json"))}; exit {rc};; esac\n')
    bin_.chmod(0o755)
    monkeypatch.setattr(config, "CLI_PATH", str(bin_))
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    return calls


def test_claude_code_check_runs_one_headless_turn_and_names_the_login(tmp_path, capsys, monkeypatch):
    calls = fake_cli(tmp_path, monkeypatch, {"is_error": False, "result": "ok"},
                     status={"loggedIn": True, "authMethod": "claude.ai"})
    rc, out = run_setup(capsys, "--how", "claude-code")
    assert rc == 0
    assert out == "Sign-in: your Claude Code sign-in (logged in with a Claude account). Checked: Claude answers.\n"
    turn = [line for line in calls.read_text().splitlines() if line.startswith("-p")]
    assert len(turn) == 1 and "--safe-mode" in turn[0] and "--max-turns 1" in turn[0]
    assert claude_access.read()["consent"]["text"] == claude_access.CONSENT, "choosing it is the consent"


@pytest.mark.parametrize("status, words", [
    ({"loggedIn": True, "authMethod": "api_key", "apiKeySource": "apiKeyHelper"}, "an API key from its apiKeyHelper"),
    ({"loggedIn": True, "authMethod": "api_key", "apiKeySource": "ANTHROPIC_API_KEY"},
     "an API key from ANTHROPIC_API_KEY"),
    ({"loggedIn": True, "authMethod": "oauth_token", "apiProvider": "firstParty"}, "an OAuth token"),
    ({"loggedIn": True, "authMethod": "third_party", "apiProvider": "bedrock"}, "Amazon Bedrock"),
])
def test_the_line_names_the_login_claude_code_uses(tmp_path, capsys, monkeypatch, status, words):
    """N97: whoever installs thimble sees whether a key stands in for the Claude plan, with no check of their own."""
    fake_cli(tmp_path, monkeypatch, {"is_error": False, "result": "ok"}, status=status)
    rc, out = run_setup(capsys, "--how", "claude-code")
    assert rc == 0 and out == f"Sign-in: your Claude Code sign-in (logged in with {words}). Checked: Claude answers.\n"


def test_claude_code_gets_the_environment_as_it_is(tmp_path, capsys, monkeypatch):
    """The workbench runs Claude Code with the environment as it is, so that it signs in as it does in the person's
    terminal: a key or a federation's IDs there reach it, and the line says which login that gives."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    monkeypatch.setenv("ANTHROPIC_FEDERATION_RULE_ID", RULE)
    fake_cli(tmp_path, monkeypatch, {"is_error": False, "result": "ok"},
             status={"loggedIn": True, "authMethod": "api_key", "apiKeySource": "ANTHROPIC_API_KEY"})
    rc = claude_access.main(["setup", "--how", "claude-code"])
    out = capsys.readouterr().out
    assert rc == 0
    assert out == ("Sign-in: your Claude Code sign-in (logged in with an API key from ANTHROPIC_API_KEY). "
                   "Checked: Claude answers.\n")
    assert FAKE_KEY not in out and RULE not in out
    got = set((tmp_path / "env.txt").read_text().split())
    assert {"ANTHROPIC_API_KEY", "ANTHROPIC_FEDERATION_RULE_ID"} <= got
    assert os.environ["ANTHROPIC_API_KEY"] == FAKE_KEY, "nothing takes it out of the workbench's environment"


def test_claude_code_check_says_what_failed(tmp_path, capsys, monkeypatch):
    fake_cli(tmp_path, monkeypatch, {"is_error": True, "result": "Not logged in · Please run /login"}, rc=1)
    rc, out = run_setup(capsys, "--how", "claude-code")
    assert rc == 2
    assert out.splitlines() == [
        "Sign-in: your Claude Code sign-in. The check failed: Claude Code did not answer: Not logged in · Please run "
        "/login. Run claude in a terminal and check that it answers.",
        "  After you fix that: thimble-browser --setup --how claude-code"]


def test_a_claude_code_that_is_not_signed_in_is_said(tmp_path, capsys, monkeypatch):
    fake_cli(tmp_path, monkeypatch, {"is_error": False, "result": "ok"}, status={"loggedIn": False})
    rc, out = run_setup(capsys, "--how", "claude-code")
    assert rc == 2
    assert out.splitlines()[0] == ("Sign-in: your Claude Code sign-in. The check failed: Claude Code is not signed in. "
                                   "Run claude in a terminal and sign in.")


def test_a_refused_key_says_where_to_check_it(monkeypatch):
    """A 401 names the way and where the key comes from: ANTHROPIC_API_KEY where the workbench runs, which Settings
    cannot change, or the key pasted in Settings."""
    import anthropic
    import httpx

    from app import llm

    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    refused = anthropic.AuthenticationError("bad key", response=httpx.Response(401, request=req), body=None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    claude_access.save(claude_access.API_KEY)
    said = llm.failure(refused)
    assert "for an API key, from ANTHROPIC_API_KEY. Check ANTHROPIC_API_KEY where the workbench runs." in said
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    claude_access.save(claude_access.API_KEY, key=FAKE_KEY)
    assert llm.failure(refused).endswith("for an API key, the one saved in Settings. Check them in Settings, Claude "
                                         "access.")
    assert FAKE_KEY not in said
