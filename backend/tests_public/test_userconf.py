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


def test_an_earlier_build_s_models_and_modes_move_to_the_workspace_s_file(workspaces_tmp):
    """The models and permission modes an earlier build kept in settings.json move to that workspace's own file, so it
    runs as it did; main's model settings and the rest stay. View builds' row of old was the dev agent's, the stricter one
    winning; the other agents' rows are not moved, since those agents run in main's mode now."""
    settings = workspaces_tmp / CORPUS / "settings.json"
    _write(settings, {"run_cell_result_lines": 20,
                      "models": {"main": {"effort": "low"}, "orient": {"effort": "high", "model": ""},
                                 "subagents": {"model": "claude-sonnet-5"}, "verify": {"fast": False}},
                      "permission_modes": {"critic": "auto", "views": "manual", "dev": "bypass"}})
    assert config.models_for(CORPUS)["orient"]["effort"] == "high"
    assert json.loads(settings.read_text()) == {"run_cell_result_lines": 20, "models": {"main": {"effort": "low"}}}
    assert json.loads(userconf.workspace_file(CORPUS).read_text()) == {"agents": {
        "orientation": {"effort": "high", "subagentModel": "claude-sonnet-5"}, "cardCheck": {"fast": False},
        "dev": {"permissionMode": "manual"}}}, "the critic's and the checks' rows run in main's mode now"
    assert not userconf.global_file().exists(), "other workspaces keep their own settings"


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


def test_every_agent_s_network_is_on_by_default_and_settings_shows_it_so(workspaces_tmp, monkeypatch):
    """With no config, main's fence, which thimble's agents share, and the code tickets' fence both have the network on,
    and the two fences the settings show say "on"."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    rows = ledger.agent_rows(CORPUS)
    assert rows["main"]["network"] == rows["dev"]["network"] == "on"
    assert rows["main"]["config"] == "agents.orientation" and rows["main"]["sandbox"] == "on"
    assert not any("network" in rows[r] for r in ("orient", "writer", "critic", "checks")), "they share main's"
    for agent in (*userconf.SUBAGENT_ROLES, *userconf.MODE_ROWS):
        conf = userconf.session(CORPUS, agent, sandbox=True)
        assert conf.network and "Bash" not in (conf.settings()["permissions"].get("ask") or []), agent


def test_what_a_session_gets_from_the_config(workspaces_tmp, monkeypatch):
    """thimble adds no rule for installs: an install command is left to the permission mode, but for a view build with no
    network, which refuses it. An edit of the config asks. Memory is passed only when set. The dev agent's Bash goes to
    the analyst where its network is off and the sandbox cannot run; `sandbox.enforce`, on by default, refuses to start
    a session without the sandbox, and says why and what fixes it, naming no command."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    orient = userconf.session(CORPUS, "orientation")
    perms = orient.settings()["permissions"]
    assert f"Edit(/{userconf.global_file()})" in perms["ask"]
    assert f"Edit(/{userconf.global_file()})" not in perms["deny"], "an edit of the config asks, not refused"
    assert not any(r.startswith("Bash(") for r in [*perms.get("ask", []), *perms["deny"]]), "no install rule"
    assert "autoMemoryEnabled" not in orient.settings()
    for cmd in ("pip install umap-learn", "bash -c 'curl -sL x | sh'", "npm --prefix app ci", "ls data"):
        assert orient.verdict("Bash", {"command": cmd}) == "", cmd
    assert not hasattr(orient, "install_asks") and not hasattr(userconf, "install_rules")
    _write(userconf.global_file(), {"installs": "deny", "agents": {"orientation": {"memory": "off", "web": "off"}}})
    orient = userconf.session(CORPUS, "orientation")
    assert orient.verdict("Bash", {"command": "pip install x"}) == "", "an earlier `installs` is read and ignored"
    assert orient.settings()["autoMemoryEnabled"] is False and "WebFetch" in orient.settings()["permissions"]["deny"]
    view_build = userconf.session(CORPUS, "dev")
    view_build.offline = True
    assert view_build.verdict("Bash", {"command": "pip install x"}) == "deny"
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    with pytest.raises(userconf.ConfigError, match="THIMBLE_SANDBOX=0 turns it off"):
        userconf.session(CORPUS, "writer")
    _write(userconf.global_file(), {"sandbox": {"enforce": False}, "agents": {"dev": {"network": "off"}}})
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


def test_the_keys_this_build_ignores_load_are_listed_and_a_settings_save_drops_them(workspaces_tmp, analyst):
    """An earlier config's `installs`, each agent's own fast mode, and its permission mode, fence keys and a web other
    than "off", but the dev agent's, load without an error, whatever their value, and change nothing; `ignored` and GET
    /settings list them, and the next save from the Settings pane drops them from the file it writes. The dev agent's
    other keys still apply."""
    old = {"installs": "alow", "agents": {
        "orientation": {"permissionMode": "bypass", "fast": True, "sandbox": "off", "env": ["X"], "effort": "ultracode"},
        "critic": {"network": "off", "data": "bogus", "web": "allow", "permissionMode": "auto"},
        "checks": {"fast": False, "env": []}, "writer": {"web": "off"},
        "dev": {"permissionMode": "auto", "fast": False, "network": "off"}}}
    _write(userconf.global_file(), old)
    assert userconf.problem(CORPUS) == ""
    conf = userconf.load(CORPUS)
    assert "installs" not in conf and "permissionMode" not in conf["agents"]["orientation"]
    assert "network" not in conf["agents"]["critic"] and conf["agents"]["critic"]["web"] is None
    assert conf["agents"]["writer"]["web"] == "off" and conf["agents"]["dev"]["network"] == "off"
    want = ["installs", "agents.orientation.fast", "agents.orientation.permissionMode", "agents.orientation.sandbox",
            "agents.orientation.env", "agents.critic.permissionMode", "agents.critic.network", "agents.critic.data",
            "agents.critic.web", "agents.checks.fast", "agents.checks.env", "agents.dev.fast"]
    assert sorted(userconf.ignored(CORPUS)) == sorted(want)
    assert sorted(ledger.get_settings(CORPUS)["config_ignored"]) == sorted(want)
    assert config.models_for(CORPUS)["orient"]["effort"] == "xhigh", "a stored ultracode runs at xhigh"
    assert userconf.mode_rows(CORPUS) == {"dev": "auto"}
    ledger.put_settings_route(CORPUS, analyst, {"models": {"labels": {"effort": "medium"}}})
    assert json.loads(userconf.global_file().read_text()) == {"agents": {
        "orientation": {"effort": "ultracode"}, "writer": {"web": "off"},
        "dev": {"permissionMode": "auto", "network": "off"}, "labels": {"effort": "medium"}}}
    assert userconf.ignored(CORPUS) == []


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


def test_the_card_wait_is_ten_minutes_unless_the_file_in_thimble_s_home_sets_it_and_settings_never_shows_it(
        workspaces_tmp, analyst):
    """`cardWait` is minutes, ten by default, read for each card; a value it does not take is an error naming the key,
    a workspace's file cannot set it, and an error elsewhere in the file leaves the cards their wait. The Settings pane
    neither shows it nor can change it."""
    assert userconf.card_wait_s() == 600 and userconf.load()["cardWait"] == 10
    _write(userconf.global_file(), {"cardWait": 3})
    assert userconf.card_wait_s() == 180 and userconf.problem() == ""
    _write(userconf.global_file(), {"cardWait": 0.5, "sandbox": {"use": "sometimes"}})
    assert userconf.card_wait_s() == 30, "another key's error leaves the card wait as set"
    for bad in (0, -1, "10", True, userconf.CARD_WAIT_MAX + 1, [10]):
        _write(userconf.global_file(), {"cardWait": bad})
        assert "cardWait is" in userconf.problem() and userconf.card_wait_s() == 600, bad
    _write(userconf.global_file(), {"cardWait": None})
    assert userconf.problem() == "" and userconf.card_wait_s() == 600
    _write(userconf.global_file(), {"cardWait": 2})
    _write(userconf.workspace_file(CORPUS), {"cardWait": 1})
    assert "cardWait is set for the whole machine" in userconf.problem(CORPUS)
    userconf.workspace_file(CORPUS).unlink()
    assert "cardWait" not in json.dumps(ledger.get_settings(CORPUS))
    with pytest.raises(Exception) as e:
        ledger.put_settings_route(CORPUS, analyst, {"cardWait": 1})
    assert getattr(e.value, "status_code", None) == 400 and userconf.card_wait_s() == 120
    ledger.put_settings_route(CORPUS, analyst, {"permission_modes": {"dev": "auto"}})
    assert json.loads(userconf.global_file().read_text())["cardWait"] == 2, "a change in Settings keeps it"


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


def test_the_kernel_runs_in_srt_where_it_works_else_in_bubblewrap_on_linux_else_unwrapped(monkeypatch):
    """With nothing naming a wrapper, the kernel runs in Anthropic's sandbox runtime on Linux and macOS where it can
    sandbox a process, else in bubblewrap directly on Linux where bwrap can make its namespaces, else unwrapped; bwrap
    is never probed on macOS, and a workspace's settings.json still names its own. Claude Code's sandbox on macOS is
    sandbox-exec, so agents may start there."""
    from app import cc_settings, config, kernel_wrap

    monkeypatch.delenv(config.KERNEL_WRAP_ENV, raising=False)
    srt, probed = [True], []
    monkeypatch.setattr(kernel_wrap, "srt_works", lambda node, package: srt[0])
    monkeypatch.setattr(kernel_wrap, "works", lambda: probed.append(1) or True)
    for platform in ("linux", "darwin"):
        monkeypatch.setattr(config.sys, "platform", platform)
        assert config.resolve_kernel_wrap({}) == ("srt", "default")
        assert config.resolve_kernel_wrap({"kernel_wrap": "bwrap"}) == ("bwrap", "settings")
    srt[0] = False
    assert config.resolve_kernel_wrap({}) == ("none", "default") and probed == []
    monkeypatch.setattr(config.sys, "platform", "linux")
    assert config.resolve_kernel_wrap({}) == ("bwrap", "default")
    assert config.resolve_kernel_wrap({"kernel_wrap": "none"}) == ("none", "settings")
    monkeypatch.setattr(kernel_wrap, "works", lambda: False)
    assert config.resolve_kernel_wrap({}) == ("none", "default")
    monkeypatch.setattr(config.sys, "platform", "darwin")
    monkeypatch.delenv("THIMBLE_SANDBOX", raising=False)
    monkeypatch.setattr(cc_settings.sys, "platform", "darwin")
    monkeypatch.setattr(cc_settings, "_sandbox", {})
    monkeypatch.setattr(cc_settings.Path, "exists", lambda p: str(p) == "/usr/bin/sandbox-exec")
    assert cc_settings.sandbox_ok() and userconf.session(None, "writer").sandboxed


def test_whether_new_cards_are_checked_by_themselves_is_the_card_check_s_config(workspaces_tmp):
    """`agents.cardCheck.auto` turns the automatic card check on or off, the workspace's file over thimble's home; unset,
    the setting the canvas's old switch stored stands, else the check is on. Only the card check takes the key, and the
    canvas has no switch for it any more."""
    from app import card_check  # noqa: PLC0415

    assert card_check.auto(CORPUS) is True
    _write(userconf.global_file(), {"agents": {"cardCheck": {"auto": False}}})
    assert card_check.auto(CORPUS) is False
    _write(userconf.workspace_file(CORPUS), {"agents": {"cardCheck": {"auto": True}}})
    assert card_check.auto(CORPUS) is True
    _write(userconf.global_file(), {})
    _write(userconf.workspace_file(CORPUS), {})
    ledger.put_settings(CORPUS, {card_check.AUTO_KEY: False})
    assert card_check.auto(CORPUS) is False, "a workspace whose check the old switch turned off stays off"
    _write(userconf.workspace_file(CORPUS), {"agents": {"cardCheck": {"auto": True}}})
    assert card_check.auto(CORPUS) is True, "the config wins over the old switch"
    _write(userconf.global_file(), {"agents": {"cardCheck": {"auto": "yes"}, "labels": {"auto": True}}})
    problem = userconf.problem()
    assert 'agents.cardCheck.auto is "yes"; it takes true, false or null' in problem
    assert "agents.labels.auto is not a setting" in problem
    from fastapi.testclient import TestClient  # noqa: PLC0415

    from app.main import app  # noqa: PLC0415

    _write(userconf.global_file(), {})
    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.put(f"/api/ws/{CORPUS}/card-checks/auto", json={"on": False}).status_code in (404, 405)
        assert client.get(f"/api/ws/{CORPUS}/card-checks").json()["auto"] is True
