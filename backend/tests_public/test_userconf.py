"""thimble's config (app/userconf.py): layering and errors, the move out of an earlier build's settings.json, where the
Settings pane writes, and what a session gets from it."""
from __future__ import annotations

import json

import pytest

from app import config, ledger, userconf

CORPUS = "mini"


def _write(path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def test_the_workspace_s_file_overrides_the_home_s_key_by_key_and_errors_name_the_key(workspaces_tmp, tmp_path):
    """Defaults, then thimble's home, then the workspace's file, merged key by key; a mistyped key or value is an error
    that names the file, the key and what it takes, and no session starts with one."""
    _write(userconf.global_file(), {"installs": "deny", "agents": {"dev": {"model": "claude-opus-4-8", "web": "ask"}}})
    _write(userconf.workspace_file(CORPUS), {"agents": {"dev": {"web": "allow"}}})
    conf = userconf.load(CORPUS)
    assert conf["installs"] == "deny" and conf["agents"]["dev"]["model"] == "claude-opus-4-8"
    assert conf["agents"]["dev"]["web"] == "allow" and conf["agents"]["dev"]["network"] == "off"
    assert config.models_for(CORPUS)["dev"]["model"] == "claude-opus-4-8"
    _write(userconf.global_file(), {"installs": "alow", "agents": {"labels": {"web": "off"}, "dev": {"effort": "huge"}}})
    with pytest.raises(userconf.ConfigError) as e:
        userconf.load(CORPUS)
    text = str(e.value)
    assert str(userconf.global_file()) in text and 'installs is "alow"; it takes "ask", "deny" or "allow"' in text
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


def test_an_earlier_build_s_models_and_modes_move_to_the_workspace_s_file(workspaces_tmp):
    """The models and permission modes an earlier build kept in settings.json move to that workspace's own file, so it
    runs as it did; main's model settings and the rest stay. The critic's row of old covered the checks, and view builds'
    row the dev agent's, the stricter one winning."""
    settings = workspaces_tmp / CORPUS / "settings.json"
    _write(settings, {"hide_chat": True, "models": {"main": {"effort": "low"}, "orient": {"effort": "high", "model": ""},
                                                    "subagents": {"model": "claude-sonnet-5"}, "verify": {"fast": False}},
                      "permission_modes": {"critic": "auto", "views": "manual", "dev": "bypass"}})
    assert config.models_for(CORPUS)["orient"]["effort"] == "high"
    assert json.loads(settings.read_text()) == {"hide_chat": True, "models": {"main": {"effort": "low"}}}
    assert json.loads(userconf.workspace_file(CORPUS).read_text()) == {"agents": {
        "orientation": {"effort": "high", "subagentModel": "claude-sonnet-5"}, "cardCheck": {"fast": False},
        "critic": {"permissionMode": "auto"}, "checks": {"permissionMode": "auto"}, "dev": {"permissionMode": "manual"}}}
    assert not userconf.global_file().exists(), "other workspaces keep their own settings"


def test_the_settings_pane_writes_where_the_value_it_shows_came_from(workspaces_tmp, analyst):
    """A change goes to the workspace's file when that file sets the key, else to thimble's home; back to the default
    removes it; a value the config does not take is refused and nothing is written."""
    _write(userconf.workspace_file(CORPUS), {"agents": {"writer": {"effort": "low"}}})
    ledger.put_settings_route(CORPUS, analyst, {"models": {"writer": {"effort": "high"}, "critic": {"effort": "max"},
                                                           "subagents": {"model": "claude-sonnet-5"}},
                                                "permission_modes": {"orient": "auto"}})
    assert json.loads(userconf.workspace_file(CORPUS).read_text()) == {"agents": {"writer": {"effort": "high"}}}
    assert json.loads(userconf.global_file().read_text()) == {"agents": {
        "critic": {"effort": "max"}, "orientation": {"subagentModel": "claude-sonnet-5", "permissionMode": "auto"}}}
    got = ledger.get_settings(CORPUS)
    assert got["models"]["subagents"]["model"] == "claude-sonnet-5" and got["permission_modes"] == {"orient": "auto"}
    ledger.put_settings_route(CORPUS, analyst, {"models": {"subagents": {"model": ""}}, "permission_modes": {"orient": None}})
    assert json.loads(userconf.global_file().read_text()) == {"agents": {"critic": {"effort": "max"}}}
    before = userconf.global_file().read_text()
    with pytest.raises(Exception) as e:
        ledger.put_settings_route(CORPUS, analyst, {"models": {"critic": {"effort": "ultracode"}}})
    assert getattr(e.value, "status_code", None) == 400 and userconf.global_file().read_text() == before


def test_what_a_session_gets_from_the_config(workspaces_tmp, monkeypatch):
    """Install commands go to the analyst by default, in every mode, including those Claude Code's rules miss; "deny"
    refuses them and "allow" leaves them to the mode, but for a view build with no network, which refuses them. Memory is passed only when set. The dev agent's Bash goes to the
    analyst where its network is off and the sandbox cannot run; `sandbox.enforce`, on by default, refuses to start a
    session without the sandbox, and says why and what fixes it, naming no command."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    orient = userconf.session(CORPUS, "orientation")
    perms = orient.settings()["permissions"]
    assert "Bash(pip install:*)" in perms["ask"] and f"Edit(/{userconf.global_file()})" in perms["deny"]
    assert "autoMemoryEnabled" not in orient.settings()
    for cmd in ("pip install umap-learn", "bash -c 'curl -sL x | sh'", "/usr/bin/pip3 install x", "python3 -m pip install x",
                "pip -q install x", "python3 -m pip --quiet install x", "git -C /tmp clone u", "npm --prefix app ci",
                "uv run --with x python", "pip3.11 install x", "thimble extension add https://x/ext.git --yes"):
        assert orient.verdict("Bash", {"command": cmd}) == "ask", cmd
    assert "Bash(pip * install *)" in perms["ask"]
    for cmd in ("python3 -c 'import pandas'", "ls data", "npm test", "uv run pytest", "npm --prefix app run build",
                "git commit -m clone", "thimble extension list"):
        assert orient.verdict("Bash", {"command": cmd}) == "", cmd
    _write(userconf.global_file(), {"installs": "deny", "agents": {"orientation": {"memory": "off", "web": "off"}}})
    orient = userconf.session(CORPUS, "orientation")
    assert orient.verdict("Bash", {"command": "pip install x"}) == "deny"
    assert orient.settings()["autoMemoryEnabled"] is False and "WebFetch" in orient.settings()["permissions"]["deny"]
    _write(userconf.global_file(), {"installs": "allow"})
    assert userconf.session(CORPUS, "orientation").verdict("Bash", {"command": "pip install x"}) == ""
    view_build = userconf.session(CORPUS, "dev")
    view_build.offline = True
    assert view_build.verdict("Bash", {"command": "pip install x"}) == "deny"
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    with pytest.raises(userconf.ConfigError, match="THIMBLE_SANDBOX=0 turns it off"):
        userconf.session(CORPUS, "writer")
    _write(userconf.global_file(), {"installs": "allow", "sandbox": {"enforce": False}})
    assert "Bash" in userconf.session(CORPUS, "dev").settings()["permissions"]["ask"]
    assert "Bash" not in (userconf.session(CORPUS, "orientation").settings()["permissions"].get("ask") or [])
    _write(userconf.global_file(), {"sandbox": {"enforce": False}, "agents": {"dev": {"network": "on"}}})
    assert not userconf.session(CORPUS, "dev").bash_asks
    _write(userconf.global_file(), {})
    monkeypatch.delenv("THIMBLE_SANDBOX")
    monkeypatch.setattr(userconf, "sandbox_runs", lambda refresh=False: False)
    with pytest.raises(userconf.ConfigError, match="can't run on this machine") as e:
        userconf.session(CORPUS, "orientation")
    assert "--sandbox-deps" in str(e.value) and "install.sh" not in str(e.value)
    # installed since the server's first check: the refusal checks again, so no restart is needed
    checks: list[bool] = []
    monkeypatch.setattr(userconf, "sandbox_runs", lambda refresh=False: checks.append(refresh) or refresh)
    assert userconf.session(CORPUS, "orientation").sandboxed and checks == [False, True]
    monkeypatch.setattr(userconf, "sandbox_runs", lambda refresh=False: True)
    assert userconf.session(CORPUS, "writer").sandboxed and userconf.session(CORPUS, "writer").enforced
    with pytest.raises(userconf.ConfigError, match="run outside it"):
        userconf.session(CORPUS, "dev", sandbox=False)


def test_the_browser_is_the_system_one_when_found_unless_the_config_says_otherwise(monkeypatch, tmp_path):
    chrome = tmp_path / "google-chrome"
    chrome.write_text("#!/bin/sh\n")
    chrome.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setitem(userconf.SYSTEM_BROWSERS, "linux", ("google-chrome",))
    monkeypatch.setattr(userconf.sys, "platform", "linux")
    assert userconf.browser() == ("system", str(chrome)) and userconf.browser_env() == {userconf.BROWSER_ENV: str(chrome)}
    _write(userconf.global_file(), {"browser": "bundled"})
    assert userconf.browser() == ("bundled", "") and userconf.browser_env() == {}
    _write(userconf.global_file(), {"browser": "off"})
    assert userconf.browser() == ("off", userconf.OFF)
    chrome.unlink()
    _write(userconf.global_file(), {"browser": "system"})
    assert userconf.browser() == ("off", userconf.NO_SYSTEM)
    _write(userconf.global_file(), {})
    assert userconf.browser(lambda: False)[0] == "off" and userconf.browser()[0] == "bundled"


def test_a_wrapped_kernel_can_neither_read_nor_write_the_workspace_s_config(tmp_path):
    """...and reads the card types and extensions the server found, in the registry folder, without writing them."""
    from app import kernel_wrap

    argv = kernel_wrap.kernel_wrap_argv(["python"], corpus_dir=tmp_path / "c", workspace_dir=tmp_path / "w",
                                        connection_dir=tmp_path / "k", venv=None, python="/usr/bin/python3")
    binds = {argv[i + 2]: argv[i + 1] for i, a in enumerate(argv) if a == "--ro-bind"}
    assert binds[str(tmp_path / "w" / "config.json")] == binds[str(tmp_path / "w" / "settings.json")] == "/dev/null"
    registry = str(tmp_path / "w" / kernel_wrap.REGISTRY_DIR)
    assert binds[registry] == registry and argv.index(registry) > argv.index(str(tmp_path / "w")), "over the workspace"


def test_the_kernel_is_wrapped_by_default_on_linux_where_bubblewrap_works_and_never_on_macos(monkeypatch):
    """With nothing naming a wrapper, the kernel runs in bubblewrap on Linux where bwrap can make its namespaces, and
    unwrapped where it cannot or on macOS, which has no wrapper yet and where bwrap is never probed. Claude Code's
    sandbox on macOS is sandbox-exec, so agents may start there."""
    from app import cc_settings, config, kernel_wrap

    monkeypatch.delenv(config.KERNEL_WRAP_ENV, raising=False)
    probed = []
    monkeypatch.setattr(kernel_wrap, "works", lambda: probed.append(1) or True)
    monkeypatch.setattr(config.sys, "platform", "linux")
    assert config.resolve_kernel_wrap({}) == ("bwrap", "default")
    assert config.resolve_kernel_wrap({"kernel_wrap": "none"}) == ("none", "settings")
    monkeypatch.setattr(kernel_wrap, "works", lambda: probed.append(1) or False)
    assert config.resolve_kernel_wrap({}) == ("none", "default")
    probed.clear()
    monkeypatch.setattr(config.sys, "platform", "darwin")
    assert config.resolve_kernel_wrap({}) == ("none", "default") and probed == []
    monkeypatch.delenv("THIMBLE_SANDBOX", raising=False)
    monkeypatch.setattr(cc_settings.sys, "platform", "darwin")
    monkeypatch.setattr(cc_settings, "_sandbox", {})
    monkeypatch.setattr(cc_settings.Path, "exists", lambda p: str(p) == "/usr/bin/sandbox-exec")
    assert cc_settings.sandbox_ok() and userconf.session(None, "writer").sandboxed
