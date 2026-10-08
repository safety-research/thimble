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


# --------------------------------------------------------------------------- the model and effort of each role


def _conf(data) -> None:
    from app import userconf  # noqa: PLC0415

    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps(data))


def test_every_role_resolves_to_a_full_model_id_and_an_explicit_effort(tmp_path, monkeypatch):
    """No role resolves to an empty model or effort: the agents, thimble:orient-helper's row (`subagents`), the classifiers,
    the viewer suggestion and the refusal row each name a full id and a level Claude Code takes, also when an agent
    file names none. A stored `ultracode` runs at xhigh, the orientation's default is xhigh, and `fast` is kept only for
    the classifiers."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    for k in [k for k in __import__("os").environ if k.startswith("THIMBLE_") and k.endswith(("_MODEL", "_EFFORT"))]:
        monkeypatch.delenv(k)
    monkeypatch.setattr(config, "agent_front", lambda name: {})
    models = config.models_for(None)
    assert set(models) == set(config.MODEL_ROLES) >= {"suggest", "refusal", "subagents"}
    for role, conf in models.items():
        assert conf["model"].startswith("claude-") and conf["effort"] in config.ROLE_EFFORTS, (role, conf)
    assert models["orient"]["effort"] == config.ORIENT_DEFAULT_EFFORT == "xhigh"
    assert models["subagents"]["model"] == config.base_model(models["orient"]["model"])
    assert models["subagents"]["effort"] == "xhigh" and models["subagents"]["follows"] == "orient"
    assert (models["suggest"]["model"], models["suggest"]["effort"]) == ("claude-opus-5-5", "low")
    assert (models["refusal"]["model"], models["refusal"]["effort"], models["refusal"]["off"]) == \
        (config.FALLBACK_MODEL, "high", False)
    _conf({"agents": {"orientation": {"effort": "ultracode", "subagentModel": "sonnet", "subagentEffort": "medium"},
                      "writer": {"fast": True, "effort": "max"}, "dev": {"fast": True},
                      "labels": {"fast": True, "model": "claude-opus-5-5"}, "suggest": {"effort": "high"},
                      "refusal": {"model": "claude-sonnet-5", "effort": "low"}}})
    models = config.models_for(None)
    assert models["orient"]["effort"] == "xhigh", "a stored ultracode runs at xhigh"
    assert (models["subagents"]["model"], models["subagents"]["effort"]) == ("claude-sonnet-5", "medium")
    assert "follows" not in models["subagents"]
    assert models["writer"]["effort"] == "max" and not models["writer"]["fast"]
    assert models["dev"]["fast"], "code tickets keep the dev row's fast mode"
    assert models["labels"]["fast"], "a classifier keeps its fast mode"
    assert models["suggest"]["effort"] == "high"
    assert config.call_settings(None, "labels")["refusal"] == {"model": "claude-sonnet-5", "effort": "low"}
    _conf({"agents": {"refusal": {"off": True}}})
    assert config.models_for(None)["refusal"]["off"] and config.call_settings(None, "verify")["refusal"] is None


def test_the_viewer_suggestion_runs_on_its_own_row(monkeypatch):
    """views._suggest_call, which ran the dev row's model at a hard-coded low effort, runs on Settings' `suggest` row
    and passes the refusal row."""
    import asyncio

    from app import model, views

    seen: dict = {}

    async def fake(prompt, **kw):
        seen.update(kw)
        return "result"

    monkeypatch.setattr(model, "structured", fake)
    monkeypatch.setattr(config, "corpus_dir", lambda c: "/tmp")
    monkeypatch.setattr(config, "call_settings", lambda c, role: {"model": f"m-{role}", "effort": f"e-{role}",
                                                                   "speed": "standard", "refusal": {"model": "r"}})
    assert asyncio.run(views._suggest_call("c", "sys", "user", tool=None)) == "result"
    assert (seen["model"], seen["effort"], seen["refusal"]) == ("m-suggest", "e-suggest", {"model": "r"})
