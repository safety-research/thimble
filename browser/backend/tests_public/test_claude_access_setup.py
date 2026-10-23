"""`thimble-browser --setup` without a terminal, as Claude runs it when it installs thimble for a person
(claude_access.setup): an API key read from a file the person wrote and never printed, the WIF config files found in the
usual places, and the Claude Code sign-in check, which runs one headless turn. No model is called: the Messages API
check is faked, and `claude` is a stand-in script."""
from __future__ import annotations

import json
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


def fake_cli(tmp_path: Path, monkeypatch, answer: dict, rc: int = 0) -> Path:
    """A stand-in `claude`: `auth status` says signed in, `-p` prints `answer` as JSON and exits `rc`, and each call's
    words are kept in calls.txt."""
    calls = tmp_path / "calls.txt"
    (tmp_path / "answer.json").write_text(json.dumps(answer))
    bin_ = tmp_path / "fake-claude"
    bin_.write_text("#!/bin/sh\n"
                    f'echo "$@" >> {shlex.quote(str(calls))}\n'
                    'case "$1" in auth) echo \'{"loggedIn": true}\';; '
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
