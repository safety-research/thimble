"""`thimble-browser --setup` without a terminal, as Claude runs it when it installs thimble for a person
(claude_access.setup): an API key read from a file the person wrote and never printed, the WIF config files found in the
usual places, and the Claude Code sign-in check, which runs one headless turn and says the login it ran on. No model is
called: the Messages API check is faked, and `claude` is a stand-in script."""
from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

import pytest

from app import claude_access, config

FAKE_KEY = "-".join(("sk", "ant", "fake", "key", "for", "tests"))  # built, so no scanner takes it for a key


def run_setup(capsys, *argv: str) -> tuple[int, str]:
    rc = claude_access.setup(list(argv))
    got = capsys.readouterr()
    return rc, got.out + got.err


def key_file(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "key.txt"
    p.write_text(text)
    p.chmod(0o600)
    return p


# --------------------------------------------------------------------------- --key-file


def test_key_file_is_saved_and_never_printed(tmp_path, capsys):
    p = key_file(tmp_path, FAKE_KEY + "\n")  # pbpaste and an editor may add a newline
    rc, out = run_setup(capsys, "--key-file", str(p), "--no-check")
    assert rc == 0
    assert FAKE_KEY not in out
    assert "saved: an Anthropic API key" in out
    assert claude_access.how() == claude_access.API_KEY
    assert claude_access.api_key() == FAKE_KEY
    assert claude_access.key_path().stat().st_mode & 0o077 == 0
    assert p.exists(), "the person's file is theirs to delete"


def test_key_file_check_runs_and_a_failure_does_not_print_the_key(tmp_path, capsys, monkeypatch):
    p = key_file(tmp_path, FAKE_KEY)

    async def failed():
        return {"ok": False, "problem": {"what": "The API key was refused.",
                                         "fix": "Or set it again with thimble-browser --setup."}}

    monkeypatch.setattr(claude_access, "check", failed)
    rc, out = run_setup(capsys, "--key-file", str(p))
    assert rc == 2
    assert "the check failed: The API key was refused." in out
    assert FAKE_KEY not in out


@pytest.mark.parametrize("content, says", [
    ("", "is empty"),
    ("\n  \n", "is empty"),
    ("hello there", "does not hold an Anthropic API key"),
    (FAKE_KEY + "\nsecond line", "does not hold an Anthropic API key"),
    ("x" * (claude_access.KEY_FILE_MAX + 1), "too large"),
])
def test_a_bad_key_file_is_a_clear_error_that_never_quotes_it(tmp_path, capsys, content, says):
    p = key_file(tmp_path, content)
    rc, out = run_setup(capsys, "--key-file", str(p), "--no-check")
    assert rc == 1
    assert out.startswith("thimble: not saved:") and says in out and str(p) in out
    assert "hello" not in out and "second line" not in out and FAKE_KEY not in out
    assert claude_access.how() == "" and not claude_access.has_key()


def test_a_missing_key_file_or_a_folder_is_a_clear_error(tmp_path, capsys):
    rc, out = run_setup(capsys, "--key-file", str(tmp_path / "nope.txt"), "--no-check")
    assert rc == 1 and f"there is no file {tmp_path / 'nope.txt'}" in out
    rc, out = run_setup(capsys, "--key-file", str(tmp_path), "--no-check")
    assert rc == 1 and "is a folder" in out
    assert claude_access.how() == ""


def test_key_file_goes_with_the_api_key_choice_only(tmp_path, capsys):
    p = key_file(tmp_path, FAKE_KEY)
    rc, out = run_setup(capsys, "--how", "wif", "--key-file", str(p), "--no-check")
    assert rc == 1 and "--key-file goes with --how api-key" in out
    assert not claude_access.has_key()
    rc, _ = run_setup(capsys, "--how", "api-key", "--key-file", str(p), "--no-check")
    assert rc == 0 and claude_access.api_key() == FAKE_KEY


# --------------------------------------------------------------------------- --find-wif

RULE, ORG = "fdrl_test_rule_value", "00000000-test-org-value"


def test_find_wif_lists_paths_and_reasons_never_ids(tmp_path, capsys, monkeypatch):
    places = tmp_path / "anthropic"
    places.mkdir()
    token = tmp_path / "token"
    token.write_text("eyJ.test.token")
    good = places / "wif.toml"
    good.write_text(f'federation_rule_id = "{RULE}"\norganization_id = "{ORG}"\ntoken_file = "{token}"\n')
    good.chmod(0o600)
    partial = places / "other.env"
    partial.write_text(f"ANTHROPIC_FEDERATION_RULE_ID={RULE}\n")
    partial.chmod(0o600)
    (places / "notes.txt").write_text("nothing to do with it\n")
    monkeypatch.setattr(claude_access, "WIF_PLACES", (str(places), str(tmp_path / "absent")))
    rc, out = run_setup(capsys, "--find-wif")
    assert rc == 0
    assert f"{good}: usable, with the token file {token}" in out
    assert f"{partial}: not usable:" in out and "organization_id" in out
    assert "notes.txt" not in out
    assert RULE not in out and ORG not in out and "eyJ" not in out
    assert claude_access.how() == ""


def test_find_wif_says_where_it_looked_when_there_is_none(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(claude_access, "WIF_PLACES", (str(tmp_path / "absent"),))
    rc, out = run_setup(capsys, "--find-wif")
    assert rc == 1 and "no Workload Identity Federation config file in" in out and "absent" in out


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


def test_claude_code_check_runs_one_headless_turn(tmp_path, capsys, monkeypatch):
    calls = fake_cli(tmp_path, monkeypatch, {"is_error": False, "result": "ok"})
    rc, out = run_setup(capsys, "--how", "claude-code", "--yes")
    assert rc == 0 and "checked: Claude answers." in out
    turn = [line for line in calls.read_text().splitlines() if line.startswith("-p")]
    assert len(turn) == 1 and "--safe-mode" in turn[0] and "--max-turns 1" in turn[0]


def test_claude_code_check_says_what_failed(tmp_path, capsys, monkeypatch):
    fake_cli(tmp_path, monkeypatch, {"is_error": True, "result": "Not logged in · Please run /login"}, rc=1)
    rc, out = run_setup(capsys, "--how", "claude-code", "--yes")
    assert rc == 2
    assert "the check failed: Claude Code did not answer: Not logged in · Please run /login" in out
    assert "Run `claude` in a terminal" in out


def test_claude_code_check_says_the_login_its_sessions_use(tmp_path, capsys, monkeypatch):
    """N97: the check says the login `claude auth status` reports for the sessions thimble starts, so that whoever
    installs thimble sees whether a key stands in for the sign-in, with no check of their own: a key from apiKeyHelper
    that answers, and a key from Claude Code's settings that is stale."""
    fake_cli(tmp_path / "helper", monkeypatch, {"is_error": False, "result": "ok"},
             status={"loggedIn": True, "authMethod": "api_key", "apiKeySource": "apiKeyHelper"})
    rc, out = run_setup(capsys, "--how", "claude-code", "--yes")
    assert rc == 0
    assert "thimble: checked: Claude answers, through Claude Code logged in with api_key from apiKeyHelper.\n" in out
    fake_cli(tmp_path / "stale", monkeypatch, {"is_error": True, "result": "Invalid API key · Fix external API key"},
             rc=1, status={"loggedIn": True, "authMethod": "api_key", "apiKeySource": "ANTHROPIC_API_KEY"})
    rc, out = run_setup(capsys, "--how", "claude-code", "--yes")
    assert rc == 2
    assert ("thimble: the check failed: Claude Code, logged in with api_key from ANTHROPIC_API_KEY, did not answer: "
            "Invalid API key · Fix external API key") in out


def test_setup_names_the_shell_s_anthropic_variables_and_uses_none(tmp_path, capsys, monkeypatch):
    """N97: `thimble-browser --setup` (claude_access.main) takes the shell's ANTHROPIC_* variables out first, so a stale
    key there reaches neither the check's `claude` nor the workbench, and its check line names them, never a value."""
    for name in [k for k in os.environ if k.startswith("ANTHROPIC_")]:
        monkeypatch.delenv(name)
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://made-up.example")
    fake_cli(tmp_path, monkeypatch, {"is_error": False, "result": "ok"},
             status={"loggedIn": True, "authMethod": "claude.ai"})
    rc = claude_access.main(["setup", "--how", "claude-code", "--yes"])
    out = capsys.readouterr().out
    assert rc == 0
    assert out.splitlines()[-1] == ("thimble: checked: Claude answers, through Claude Code logged in with claude.ai. "
                                    "ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, set in this shell, are not used.")
    assert FAKE_KEY not in out and "made-up.example" not in out
    assert (tmp_path / "env.txt").read_text() == ""
