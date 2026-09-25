"""On macOS Claude Code keeps its login in the Keychain, not in .credentials.json (config.keychain_login). A login
found there counts as one for `thimble doctor`'s auth line (cli.auth_line) and for the check at server start that
prints NO_AUTH_LINE (cli.auth_missing), found without reading the secret: `security find-generic-password` for the
default config dir, without -w or -g, and `claude auth status` for another config dir or when there is no item, run
without the environment's credentials. Only exit statuses are read. `security` and `claude` are stubs that record their
arguments and environment and answer by exit status; sys.platform reads "darwin".

The Keychain item is named for its config dir, so a CLI in a workspace's own config dir finds no login there, and the
server's own model calls (the card check's reading, the labels classifier) run in the served config dir instead
(agents.call_env); doctor says which (cli.model_calls_line)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app import agents, card_check, claude_config, cli, config, model

KEYCHAIN_LOGIN = config.keychain_login  # the module's own, which conftest's _no_keychain replaces in every test


class Stubs:
    def __init__(self, bin_: Path, log: Path):
        self.bin, self.log = bin_, log

    def answer(self, name: str, rc: int) -> None:
        """`name` exits `rc` after recording its arguments and the environment it saw, and prints a made-up secret."""
        (self.bin / name).write_text(
            "#!/bin/sh\n"
            f'printf "%s\\n" "$(basename "$0") $* | config=${{CLAUDE_CONFIG_DIR:-}} key=${{ANTHROPIC_API_KEY:-}}" >> {self.log}\n'
            'echo \'password: "stub-secret"\'\n'
            f"exit {rc}\n")
        (self.bin / name).chmod(0o755)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []


@pytest.fixture()
def mac(monkeypatch, tmp_path) -> Stubs:
    """macOS with the default config dir under a scratch home holding no login file, no credential in the environment,
    and the stubs first on PATH (`claude` as config.CLI_PATH)."""
    monkeypatch.setattr(config, "keychain_login", KEYCHAIN_LOGIN)
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"):
        monkeypatch.delenv(k, raising=False)
    (tmp_path / "home" / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setattr(config, "_served_config", None)
    monkeypatch.setattr(config, "_helper_cache", None)
    monkeypatch.setattr(sys, "platform", "darwin")
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    monkeypatch.setenv("PATH", f"{bin_}:/usr/bin:/bin")
    monkeypatch.setattr(config, "CLI_PATH", str(bin_ / "claude"))
    stubs = Stubs(bin_, tmp_path / "calls.log")
    stubs.answer("claude", 1)
    return stubs


def test_a_keychain_login_counts_as_a_login_for_doctor_and_at_server_start(mac):
    mac.answer("security", 0)
    assert config.auth_path() == ("cli", "CLI login (in the macOS Keychain)")
    assert cli.auth_line() == "CLI login (in the macOS Keychain)"
    assert not cli.auth_missing()
    calls = mac.calls()
    assert calls[0].startswith("security find-generic-password -s Claude Code-credentials |")
    assert not [c for c in calls if " -w" in c or " -g" in c or c.startswith("claude")]
    assert "stub-secret" not in config.auth_path()[1]


def test_without_the_item_claude_auth_status_decides(mac):
    mac.answer("security", 44)
    mac.answer("claude", 0)
    assert config.auth_path() == ("cli", "CLI login (`claude auth status` reports one)")
    assert [c.split(" |")[0] for c in mac.calls()[:2]] == ["security find-generic-password -s Claude Code-credentials",
                                                          "claude auth status"]
    mac.answer("claude", 1)
    kind, text = config.auth_path()
    assert kind == "none" and "no CLI login in" in text and "or the macOS Keychain" in text
    assert cli.auth_missing()


def test_another_config_dir_asks_claude_with_that_dir_and_without_the_environments_key(mac, monkeypatch, tmp_path):
    mac.answer("security", 0)
    mac.answer("claude", 0)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-invented")  # gitleaks:allow  an invented key
    assert config.keychain_login() == "`claude auth status` reports one"
    assert mac.calls() == [f"claude auth status | config={tmp_path / 'cfg'} key="]
    assert "a CLI login" in cli.auth_line(), "the warning names the login the environment's key overrides"


def test_a_login_file_comes_first_and_nothing_runs(mac, tmp_path):
    mac.answer("security", 0)
    (tmp_path / "home" / ".claude" / config.CREDENTIALS_FILE).write_text(json.dumps({"claudeAiOauth": {}}))
    assert config.auth_path()[0] == "cli" and mac.calls() == []


def test_nothing_runs_off_macos_or_under_skip_key_and_a_missing_command_is_no_login(mac, monkeypatch):
    mac.answer("security", 0)
    mac.answer("claude", 0)
    monkeypatch.setenv("THIMBLE_SKIP_KEY", "1")
    assert config.keychain_login() == ""
    monkeypatch.delenv("THIMBLE_SKIP_KEY")
    monkeypatch.setattr(sys, "platform", "linux")
    assert config.keychain_login() == "" and config.auth_path()[0] == "none"
    assert "macOS" not in config.auth_path()[1]
    assert mac.calls() == []
    monkeypatch.setattr(sys, "platform", "darwin")
    (mac.bin / "security").unlink()
    monkeypatch.setattr(config, "CLI_PATH", None)
    assert config.keychain_login() == "" and config.auth_path()[0] == "none"


def test_a_keychain_login_runs_the_servers_own_model_calls_in_the_served_config_dir(mac, monkeypatch, tmp_path):
    """A CLI run in workspaces/<c>/.claude-config finds no Keychain item and no login file to link, so the server's
    model calls run in the served config dir."""
    monkeypatch.setattr(config, "HAS_API_KEY", False)
    mac.answer("security", 0)
    assert not claude_config.login_linkable()
    assert agents.call_env("demo") == {}, "the default config dir: CLAUDE_CONFIG_DIR stays unset, as the Keychain item wants"
    assert not (config.WORKSPACES_DIR / "demo" / ".claude-config").exists()
    kind, _ = config.auth_path()
    assert cli.model_calls_line(kind) == (f"the CLI, in {tmp_path / 'home' / '.claude'} (its login is in the macOS "
                                          "Keychain, which a workspace's own config dir cannot reach)")
    monkeypatch.setattr(config, "_served_config", (None, str(tmp_path / "served")))
    assert agents.call_env("demo") == {"CLAUDE_CONFIG_DIR": str(tmp_path / "served")}


def test_a_login_file_or_a_credential_keeps_the_calls_in_the_workspace_s_own_dir(mac, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "HAS_API_KEY", False)
    (tmp_path / "home" / ".claude" / config.CREDENTIALS_FILE).write_text(json.dumps({"claudeAiOauth": {}}))
    own = tmp_path / "ws" / ".claude-config"
    monkeypatch.setattr(agents, "_ws", lambda c: tmp_path / "ws")
    assert claude_config.login_linkable()
    assert agents.call_env("demo") == {"CLAUDE_CONFIG_DIR": str(own)}
    assert (own / config.CREDENTIALS_FILE).is_symlink(), "the login file is linked in"
    assert cli.model_calls_line("cli") == "the CLI, in each workspace's own config dir with the login file linked in"
    (tmp_path / "home" / ".claude" / config.CREDENTIALS_FILE).unlink()
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "invented")
    assert claude_config.login_linkable()
    assert cli.model_calls_line("oauth_token") == "the CLI, on CLAUDE_CODE_OAUTH_TOKEN"
    assert cli.model_calls_line("env") == "the Messages API, on the credential above"
    assert cli.model_calls_line("none").startswith("fail: ")


async def test_the_card_check_s_reading_runs_where_the_keychain_login_is(mac, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "HAS_API_KEY", False)
    mac.answer("security", 0)
    monkeypatch.setattr(config, "corpus_dir", lambda c: tmp_path)
    seen = {}

    async def fake_structured(prompt, **kw):
        seen.update(kw)
        return model.CallResult(status="ok", output={})

    monkeypatch.setattr(model, "structured", fake_structured)
    await card_check._call("demo", "system", "user", object(), [], effort="high")
    assert seen["config_env"] == {}
