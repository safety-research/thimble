"""config: a `claude` thimble starts gets the user's provider and login variables but not the calling session's
identity, and registering a folder picks a free name and is idempotent."""
from __future__ import annotations

import json

import pytest

from app import config


def test_a_claude_thimble_starts_keeps_the_users_auth_and_drops_the_callers_identity():
    env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "s", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CONFIG_DIR": "/c",
           "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CODE_OAUTH_TOKEN": "t", "CLAUDE_CODE_SKIP_VERTEX_AUTH": "1",
           "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR": "5", "ANTHROPIC_API_KEY": "k", "PATH": "/bin"}
    assert set(config.passed_environ(env)) == {"CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN",
                                               "CLAUDE_CODE_SKIP_VERTEX_AUTH", "ANTHROPIC_API_KEY", "PATH"}


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
    with pytest.raises(ValueError):
        config.register_corpus(run / "manifest.json")  # a file, not a directory
    with pytest.raises(ValueError):
        config.register_corpus(tmp_path / "does-not-exist")
