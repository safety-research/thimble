"""thimble's config (app/userconf.py): layering and errors, the move out of an earlier build's settings.json, where the
Settings pane writes, and what a session gets from it."""
from __future__ import annotations

import json
import os

import pytest

from app import config, ledger, userconf

CORPUS = "mini"


def _write(path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def test_the_workspace_s_file_overrides_the_home_s_key_by_key_and_errors_name_the_key(workspaces_tmp, tmp_path):
    """Defaults, then thimble's home, then the workspace's file, merged key by key; a mistyped key or value is an error
    that names the file, the key and what it takes, and no session starts with one."""
    _write(userconf.global_file(), {"sandbox": {"enforce": False},
                                    "agents": {"dev": {"model": "claude-opus-4-8", "web": "ask"}}})
    _write(userconf.workspace_file(CORPUS), {"agents": {"dev": {"web": "allow"}}})
    conf = userconf.load(CORPUS)
    assert conf["sandbox"] == {"use": "when-available", "enforce": False}
    assert conf["agents"]["dev"]["model"] == "claude-opus-4-8"
    assert conf["agents"]["dev"]["web"] == "allow" and conf["agents"]["dev"]["network"] == "on"
    assert config.models_for(CORPUS)["dev"]["model"] == "claude-opus-4-8"
    _write(userconf.global_file(), {"sandbox": {"use": "sometimes"},
                                    "agents": {"labels": {"web": "off"}, "dev": {"effort": "huge"}}})
    with pytest.raises(userconf.ConfigError) as e:
        userconf.load(CORPUS)
    text = str(e.value)
    assert str(userconf.global_file()) in text and 'sandbox.use is "sometimes"; it takes "when-available" or "never"' in text
    assert "agents.labels.web is not a setting" in text and "agents.dev.effort" in text
    with pytest.raises(userconf.ConfigError):
        userconf.session(CORPUS, "orientation")
    assert config.models_for(CORPUS)["dev"]["model"] == "claude-opus-5-5", "the pages still show, on the defaults"
    _write(userconf.global_file(), {"sandbox": {"use": "never", "enforce": True}})
    assert "no agent could run" in userconf.problem()
    _write(userconf.global_file(), {})
    _write(userconf.workspace_file(CORPUS), {"browser": "off"})
    assert "for the whole machine" in userconf.problem(CORPUS)
    (tmp_path / "mine.md").write_text("x")
    _write(userconf.global_file(), {"agents": {"writer": {"prompt": "mine.md"}, "critic": {"prompt": "gone.md"}}})
    assert "agents.critic.prompt names gone.md" in userconf.problem()


def test_the_settings_pane_writes_where_the_value_it_shows_came_from(workspaces_tmp, analyst):
    """A change goes to the workspace's file when that file sets the key, else to thimble's home; back to the default
    removes it; a value the config does not take is refused and nothing is written."""
    _write(userconf.workspace_file(CORPUS), {"agents": {"writer": {"effort": "low"}}})
    ledger.put_settings_route(CORPUS, analyst, {"models": {"writer": {"effort": "high", "fast": True},
                                                           "critic": {"effort": "max"},
                                                           "subagents": {"model": "claude-sonnet-5", "effort": "medium"}},
                                                "permission_modes": {"orient": "auto", "dev": "auto"}})
    assert json.loads(userconf.workspace_file(CORPUS).read_text()) == {"agents": {"writer": {"effort": "high"}}}, \
        "an agent has no fast mode of its own"
    assert json.loads(userconf.global_file().read_text()) == {"agents": {
        "critic": {"effort": "max"}, "orientation": {"subagentModel": "claude-sonnet-5", "subagentEffort": "medium"},
        "dev": {"permissionMode": "auto"}}}, "the orientation's row of earlier builds is taken and dropped"
    got = ledger.get_settings(CORPUS)
    assert got["models"]["subagents"]["model"] == "claude-sonnet-5" and got["models"]["subagents"]["effort"] == "medium"
    assert got["permission_modes"] == {"dev": "auto"}
    ledger.put_settings_route(CORPUS, analyst, {"models": {"subagents": {"model": "", "effort": ""}},
                                                "permission_modes": {"dev": None}})
    assert json.loads(userconf.global_file().read_text()) == {"agents": {"critic": {"effort": "max"}}}
    before = userconf.global_file().read_text()
    with pytest.raises(Exception) as e:
        ledger.put_settings_route(CORPUS, analyst, {"models": {"critic": {"effort": "ultracode"}}})
    assert getattr(e.value, "status_code", None) == 400 and userconf.global_file().read_text() == before


def test_the_hooks_module_s_rules_keep_file_tools_from_the_token_files_the_records_and_what_the_config_turns_off(
        workspaces_tmp, tmp_path, monkeypatch):
    """module_rules, which GET /api/module/roles serves the hooks module: the token files and the links folder for
    every file tool; the workspace's records (the notices among them), main's kept mode and the Bypass choice for the
    edit tools; the corpus only when the orientation's `data` is "off", and the web tools only when its `web` is. Each
    path as spelled and as its realpath, and each refusal's reason from prompts/tools.md."""
    from app import tools

    home, ws = userconf.global_file().parent, config.WORKSPACES_DIR / CORPUS
    rules = userconf.module_rules(CORPUS)
    assert set(rules) == {"private", "records", "corpus", "web_off", "reasons"}
    for path in (*userconf.private_paths(), str(home / userconf.LINKS_DIR)):
        assert path in rules["private"], path
    assert str(home / "paired.json") in rules["private"]
    for path in (ws / "trusted", ws / "chats", ws / "notices.json", ws / "notices-dismissed.json",
                 userconf.main_modes_file(), userconf.bypass_file()):
        assert str(path) in rules["records"], path
    assert not any(r.endswith("/**") for r in rules["records"])
    assert (rules["corpus"], rules["web_off"]) == (None, False), "data and web at their defaults"
    assert rules["reasons"] == {"private": tools.hint("module-deny-private"), "records": tools.hint("module-deny-records"),
                                "data": tools.hint("module-deny-data"), "web": tools.hint("module-deny-web")}
    assert all(rules["reasons"].values())
    _write(userconf.global_file(), {"agents": {"orientation": {"data": "off", "web": "off"}}})
    rules = userconf.module_rules(CORPUS)
    assert rules["corpus"] == os.path.realpath(config.corpus_dir(CORPUS)) and rules["web_off"] is True
    _write(userconf.global_file(), {"agents": {"orientation": {"data": "allow", "web": "allow"}}})
    assert (userconf.module_rules(CORPUS)["corpus"], userconf.module_rules(CORPUS)["web_off"]) == (None, False)
    # a home reached through a link: the realpath is listed too
    real = tmp_path / "real-home"
    real.mkdir()
    (tmp_path / "linked-home").symlink_to(real)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "linked-home"))
    private = userconf.module_rules(CORPUS)["private"]
    assert str(tmp_path / "linked-home" / "server.json") in private and str(real / "server.json") in private


def test_thimble_s_agents_share_main_s_fence_and_keep_only_web_off(workspaces_tmp, monkeypatch):
    """An agent that runs as main's subagent takes main's fence's network, data and web, the orientation's keys; its own
    `web: off` keeps it off the web tools, and its own sandbox, network or data is read and ignored. The dev agent, whose
    code tickets keep a fence of their own, keeps its keys."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    _write(userconf.global_file(), {"agents": {
        "orientation": {"network": "off", "data": "off", "web": "allow"},
        "critic": {"web": "off", "network": "on", "data": "allow", "sandbox": "off"},
        "writer": {"web": "ask"},
        "dev": {"network": "on", "data": "allow", "web": "ask", "sandbox": "off", "permissionMode": "auto"}}})
    assert userconf.problem() == ""
    critic, writer = userconf.session(CORPUS, "critic"), userconf.session(CORPUS, "writer")
    assert (critic.network, critic.data, critic.web, critic.sandboxed) == (False, "off", "off", True)
    assert (writer.network, writer.data, writer.web) == (False, "off", "allow"), "a writer's `ask` is main's web"
    dev = userconf.session(CORPUS, "dev")
    assert (dev.network, dev.data, dev.web, dev.sandboxed) == (True, "allow", "ask", False)
    assert userconf.mode_rows(CORPUS) == {"dev": "auto"}


def test_a_wrapped_kernel_can_neither_read_nor_write_the_workspace_s_config(tmp_path):
    """...and reads the card types and extensions the server found, in the registry folder, and the workspace's views,
    which main's prompt is made from, without writing them."""
    from app import kernel_wrap

    argv = kernel_wrap.kernel_wrap_argv(["python"], corpus_dir=tmp_path / "c", workspace_dir=tmp_path / "w",
                                        connection_dir=tmp_path / "k", venv=None, python="/usr/bin/python3")
    binds = {argv[i + 2]: argv[i + 1] for i, a in enumerate(argv) if a == "--ro-bind"}
    assert binds[str(tmp_path / "w" / "config.json")] == binds[str(tmp_path / "w" / "settings.json")] == "/dev/null"
    for name in (kernel_wrap.REGISTRY_DIR, "views"):
        d = str(tmp_path / "w" / name)
        assert binds[d] == d and argv.index(d) > argv.index(str(tmp_path / "w")), f"{name} over the workspace"
