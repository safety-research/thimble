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


def test_calls_to_thimbles_own_server_stay_off_the_shells_proxy():
    """thimble's server is on 127.0.0.1. With a proxy exported and NO_PROXY naming other hosts, keep_local_off_proxy
    adds 127.0.0.1 and localhost, so urllib and httpx send thimble's local calls direct; run again, it changes
    nothing."""
    import urllib.request
    env = {"HTTP_PROXY": "http://proxy.invalid:3128", "NO_PROXY": "corp.example"}
    config.keep_local_off_proxy(env)
    assert env["NO_PROXY"] == "corp.example,127.0.0.1,localhost"
    assert env["no_proxy"] == "127.0.0.1,localhost"
    assert urllib.request.proxy_bypass_environment("127.0.0.1", {"no": env["NO_PROXY"]})
    again = dict(env)
    config.keep_local_off_proxy(again)
    assert again == env


def test_a_claude_thimble_starts_keeps_the_users_proxy_certificate_and_gateway_settings():
    """Exported in the shell that starts thimble's server, the proxy, CA-certificate, client-certificate and gateway
    variables reach every `claude` the server runs (labels, card checks), as they reach main; a file descriptor's
    variable and the calling session's identity still stay out."""
    network = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE",
               "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CLAUDE_CODE_HTTP_PROXY", "CLAUDE_CODE_HTTPS_PROXY",
               "CLAUDE_CODE_PROXY_URL", "CLAUDE_CODE_PROXY_AUTHENTICATE", "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
               "CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS", "CLAUDE_CODE_PROXY_RESOLVES_HOSTS", "CLAUDE_CODE_CERT_STORE",
               "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
               "CLAUDE_CODE_GATEWAY_TOKEN", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
               "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_USE_GATEWAY"]
    left_out = ["CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID",
                "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_PROXY_URL_EXTRA"]
    env = {name: "x" for name in [*network, *left_out]}
    assert set(config.passed_environ(env)) == set(network)
    assert set(network) <= set(config.launch_environ(env)), "what every `claude` thimble runs gets"


def test_a_claude_thimble_starts_gets_the_sign_in_environment_of_the_analysts_session():
    """Every CLAUDE* variable Claude Code reads to sign in reaches a `claude` thimble starts, so it signs in as the
    analyst's session does and keeps its tokens where that session keeps them: the federation token cache, the
    credential store, OAuth, an environment token's account, the cloud providers' credential settings, a host's
    credentials and the managed settings that choose the login. A host's token refresh (it reaches main alone) and the
    calling cloud session's own tokens stay out."""
    sign_in = ["CLAUDE_CODE_FEDERATION_CACHE_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN",
               "CLAUDE_CODE_DISABLE_AUTH_REFRESH_LOCK", "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_OAUTH_CLIENT_ID",
               "CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID", "CLAUDE_CODE_OAUTH_401_WAIT_MS", "CLAUDE_CODE_AUTH_FAIL_EXIT_MS",
               "CLAUDE_LOCAL_OAUTH_API_BASE", "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
               "CLAUDE_TRUSTED_DEVICE_TOKEN", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_ACCOUNT_TAGGED_ID",
               "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_SUBSCRIPTION_TYPE",
               "CLAUDE_CODE_RATE_LIMIT_TIER", "CLAUDE_CODE_HFI_BEARER_TOKEN", "CLAUDE_CODE_SKIP_AWS_CRED_CACHE",
               "CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
               "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_HOST_GATEWAY_LINEAGE",
               "CLAUDE_CODE_MANAGED_SETTINGS_PATH", "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
               "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_SERVICE_ACCOUNT_ID",
               "ANTHROPIC_WORKSPACE_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_PROFILE"]
    left_out = ["CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
                "CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS", "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
                "CLAUDE_SESSION_INGRESS_TOKEN_FILE", "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
                "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_FEDERATION_CACHE_DIR_EXTRA"]
    env = {name: f"/made/up/{i}" for i, name in enumerate([*sign_in, *left_out])}
    assert set(config.passed_environ(env)) == set(sign_in)
    launched = config.launch_environ(env)
    assert {k: launched.get(k) for k in sign_in} == {k: env[k] for k in sign_in}, "what every `claude` thimble runs gets"


def test_not_logged_in_names_the_login_and_where_the_other_ways_are(monkeypatch):
    """thimble has no login of its own: the alert names `claude auth login` and points to INSTALL.md's Authentication
    section for the other ways, and nothing longer."""
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    monkeypatch.setattr(config, "CLI_PATH", "/bin/claude")
    said = config.auth_problem({"loggedIn": False})
    assert said == ("Claude Code is not logged in (`claude auth status`): log in with `claude auth login` (INSTALL.md, "
                    "Authentication, has more ways), then try again")
    assert config.auth_problem({"loggedIn": True}) == ""


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
    assert (models["suggest"]["model"], models["suggest"]["effort"]) == ("claude-opus-5-5", "medium")
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
