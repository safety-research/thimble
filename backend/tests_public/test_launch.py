"""The launch (`thimble`, cli.launch_args): before main starts it registers the folder, marks it active for the plugin's
hooks, starts thimble's server and finds the workspace's extensions again, and writes launch.json; it unsets the
variables that would override the agents' models and efforts, says why thimble's agents may not start, and adds no
permission rule and no sandbox to main's session."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cc_plugin, cli, config, userconf

REGISTER = cli.register_here  # the real one, which conftest replaces for the other tests
REFRESH = cli.refresh_extensions
SERVER_FOR_LAUNCH = cli.server_for_launch

# the launcher's lines (launch_args): the plugin folder, the effort, the settings, the turn tools, main's name, the
# session id, the switches, the unset names, the notes, the mode line
EFFORT, SETTINGS, SESSION, UNSET, NOTES = 1, 2, 5, 7, 8


@pytest.fixture()
def corpus(tmp_path, monkeypatch) -> Path:
    """A folder to start thimble in, with the data folder, the workspaces and thimble's home of the test's own; the
    folder registered as `logs`."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("THIMBLE_PORT", "21101")
    monkeypatch.setenv("THIMBLE_UI_PORT", "21102")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    for name in (*cli.UNSET_VARS, cli.NO_MODULE_ENV, cli.SAFE_MODE_ENV, "THIMBLE_CALLER_CWD", "THIMBLE_DEV_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(cc_plugin, "MANAGED_DIRS", {})
    folder = tmp_path / "work" / "logs"
    folder.mkdir(parents=True)
    config.register_corpus(folder, exact=True)
    return folder


def _launch(c: str = "logs") -> dict:
    return json.loads((config.WORKSPACES_DIR / c / cli.LAUNCH_FILE).read_text())


def test_launch_args_on_a_new_folder_registers_it_refreshes_its_extensions_first_and_writes_launch_json(
        tmp_path, corpus, monkeypatch):
    """On a folder never registered, launch-args registers it, marks it active for the plugin's hooks, finds its
    extensions again before anything reads the roles (U4), prints no --agents line, writes launch.json with main's
    session id, the switches and the variables it unsets, and gives main no permission rule and no sandbox."""
    monkeypatch.setattr(cli, "register_here", REGISTER)
    seen: list[str] = []
    monkeypatch.setattr(cli, "refresh_extensions", lambda c: seen.append(c))
    fresh = tmp_path / "work" / "notes"
    fresh.mkdir()
    assert config.workspace_for_cwd(str(fresh)) is None
    monkeypatch.setenv("CLAUDE_CODE_SUBAGENT_MODEL", "haiku")
    lines = cli.launch_args(fresh).split("\n")
    assert config.workspace_for_cwd(str(fresh)) == "notes" and seen == ["notes"]
    assert all((cli.home() / cli.ACTIVE_DIR / key).is_file() for key in cli.active_keys(fresh))
    assert "--agents" not in "\n".join(lines[:10])
    rec = _launch("notes")
    assert rec["session"] == lines[SESSION] and cli.SESSION_ID_RE.fullmatch(rec["session"])
    assert rec["switches"] == cli.SWITCHES and rec["unset"] == ["CLAUDE_CODE_SUBAGENT_MODEL"] and rec["at"]
    assert "fenced" not in rec
    settings = json.loads(lines[SETTINGS])
    assert "sandbox" not in settings and "permissions" not in settings, "thimble adds no rule and no sandbox"
    resumed = cli.launch_args(fresh, own_session="0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b").split("\n")
    assert resumed[SESSION] == "" and _launch("notes")["session"] == "0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", \
        "the analyst's own --resume or --session-id names it"
    cli.launch_args(fresh, own_session="")
    assert _launch("notes")["session"] is None
    assert REGISTER(Path.home()) is None, "the home folder is never a workspace"


def test_the_launch_starts_the_server_before_main_and_before_it_finds_the_extensions(corpus, monkeypatch):
    """A server that is not up when `claude` starts lets the hooks module register thimble's agent types only later,
    and Claude Code then prints "N agent type(s) available" instead of listing them from main's first turn. So the
    launch starts the server and waits for it first, then finds the extensions through it, and prints what the start
    said; a folder thimble does not open starts none."""
    order: list[str] = []
    monkeypatch.setattr(cli, "server_for_launch", lambda c: order.append(f"server {c}") or ["thimble: restarted"])
    monkeypatch.setattr(cli, "refresh_extensions", lambda c: order.append(f"extensions {c}"))
    lines = cli.launch_args(corpus).split("\n")
    assert order == ["server logs", "extensions logs"] and "thimble: restarted" in lines[NOTES].split("\t")
    order.clear()
    monkeypatch.setattr(cli, "register_here", lambda cwd: None)
    cli.launch_args(corpus)
    assert order == []


def test_server_for_launch_starts_and_waits_for_the_server_and_never_stops_the_launch(corpus, monkeypatch):
    """server_for_launch runs `up`'s start (ensure_running) with its wait and passes on its notices; another install's
    server on the port, a server that does not answer in time and a start that fails each give a line or nothing, and
    the launch goes on."""
    monkeypatch.setattr(cli, "foreign_home", lambda url=None: None)
    monkeypatch.setattr(cli, "stuck_server", lambda url=None: None)
    waits: list[float] = []

    def running(wait: float) -> bool:
        waits.append(wait)
        cli.NOTICES.append("thimble: the server restarted")
        return True

    monkeypatch.setattr(cli, "ensure_running", running)
    assert SERVER_FOR_LAUNCH("logs") == ["thimble: the server restarted"] and waits == [cli.WAIT_S]
    monkeypatch.setattr(cli, "ensure_running", lambda wait: False)
    assert SERVER_FOR_LAUNCH("logs") == [cli.LAUNCH_NO_SERVER_LINE.format(wait=cli.WAIT_S, log=cli.log_path())]

    def slow(wait: float) -> bool:
        raise TimeoutError("still starting")

    monkeypatch.setattr(cli, "ensure_running", slow)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    assert SERVER_FOR_LAUNCH("logs") == [], "it answered after all"

    def broken(wait: float) -> bool:
        raise OSError("no port")

    monkeypatch.setattr(cli, "ensure_running", broken)
    assert SERVER_FOR_LAUNCH("logs") == []
    monkeypatch.setattr(cli, "foreign_home", lambda url=None: "/other/home")
    assert SERVER_FOR_LAUNCH("logs") == [cli.FOREIGN_LINE.format(port=cli.port())]


def test_launch_json_names_the_launchers_pid_where_kernels_and_file_tools_cannot_change_it(corpus):
    """The launcher passes its own pid (--launcher-pid $$), which launch.json records until the launcher writes main's
    `claude` process there as it starts it. launch.json stays a file the hooks trust: written where kernels see it
    read-only, in a folder the hooks module refuses every edit tool (userconf.module_rules' records)."""
    from app import kernel_wrap  # noqa: PLC0415

    args = cli.build_parser().parse_args(["launch-args", "--launcher-pid", "4242", "--cwd", str(corpus)])
    assert args.launcher_pid == 4242
    cli.launch_args(corpus, launcher_pid=args.launcher_pid)
    path = config.workspace_dir("logs") / cli.LAUNCH_FILE
    rec = json.loads(path.read_text())
    assert rec["pid"] == 4242 and cli.SESSION_ID_RE.fullmatch(rec["session"])
    cli.launch_args(corpus)
    assert "pid" not in json.loads(path.read_text()), "a launcher that names no pid: the bridge waits for /thimble"
    cli.launch_args(corpus, launcher_pid=1)
    assert "pid" not in json.loads(path.read_text()), "never init"
    assert path.parent.name == kernel_wrap.TRUSTED_DIR in kernel_wrap.READ_ONLY_DIRS
    records = userconf.module_rules("logs")["records"]
    assert str(path.parent) in records or str(path.parent.resolve()) in records


def test_refresh_extensions_asks_a_running_server_else_finds_them_here(corpus, monkeypatch):
    """A running server of this install refreshes the workspace's extensions (GET /ws/{c}/extensions); without one
    launch-args finds them itself. Neither failing stops the launch."""
    calls: list = []
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "foreign_home", lambda url=None: None)
    monkeypatch.setattr(cli, "_request", lambda method, url, body=None, timeout=5.0, **kw: calls.append((method, url))
                        or (200, {}))
    REFRESH("logs")
    assert calls == [("GET", f"{cli.api_url()}/api/ws/logs/extensions")]
    from app import extensions

    found: list[str] = []

    async def refresh(c, wait=0.0):
        found.append(c)
        return {}

    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(extensions, "refresh", refresh)
    REFRESH("logs")
    assert found == ["logs"]

    async def broken(c, wait=0.0):
        raise RuntimeError("no")

    monkeypatch.setattr(extensions, "refresh", broken)
    REFRESH("logs")  # never raises


def test_the_launch_unsets_the_effort_and_subagent_model_variables_and_gives_main_its_effort(corpus, monkeypatch):
    """CLAUDE_CODE_EFFORT_LEVEL is unset and its value passed as main's --effort, unless thimble's models.main names
    main's effort; the two subagent-model variables are unset; a note names each."""
    monkeypatch.setenv("CLAUDE_CODE_EFFORT_LEVEL", "high")
    monkeypatch.setenv("CLAUDE_CODE_SUBAGENT_MODEL", "haiku")
    monkeypatch.setenv("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "1")
    lines = cli.launch_args(corpus).split("\n")
    assert lines[EFFORT] == "high" and lines[UNSET].split() == list(cli.UNSET_VARS)
    notes = lines[NOTES].split("\t")
    assert cli.UNSET_EFFORT_LINE.format(effort="high") in notes
    assert all(cli.UNSET_LINE.format(name=n) in notes for n in cli.UNSET_VARS[1:])
    (config.WORKSPACES_DIR / "logs").mkdir(parents=True, exist_ok=True)
    (config.WORKSPACES_DIR / "logs" / "settings.json").write_text(json.dumps({"models": {"main": {"effort": "low"}}}))
    lines = cli.launch_args(corpus).split("\n")
    assert lines[EFFORT] == "low" and "CLAUDE_CODE_EFFORT_LEVEL" in lines[UNSET].split()
    monkeypatch.delenv("CLAUDE_CODE_EFFORT_LEVEL")
    monkeypatch.delenv("CLAUDE_CODE_SUBAGENT_MODEL")
    monkeypatch.delenv("CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
    assert cli.launch_args(corpus).split("\n")[UNSET] == ""


def test_main_s_settings_blank_the_variables_a_settings_file_s_env_would_set_and_main_keeps_its_effort(corpus, tmp_path):
    """An `env` block in the analyst's Claude Code settings sets CLAUDE_CODE_EFFORT_LEVEL, which would override every
    agent's effort (live check L30), past the launcher's unset line. Main's --settings, which rank above the analyst's
    files, give each of the three variables '', which Claude Code reads as unset. Main runs at the level the settings
    file named, passed as --effort, unless models.main names one; a note names each variable a settings file set."""
    def env_of(lines: list[str]) -> dict:
        return json.loads(lines[SETTINGS])["env"]

    blank = {name: "" for name in cli.UNSET_VARS}
    lines = cli.launch_args(corpus).split("\n")
    assert env_of(lines) == blank
    assert not any("is blank in this session" in n for n in lines[NOTES].split("\t"))
    (tmp_path / "cc").mkdir(exist_ok=True)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"env": {"CLAUDE_CODE_EFFORT_LEVEL": "medium",
                                                                         "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"}}))
    lines = cli.launch_args(corpus).split("\n")
    assert env_of(lines) == blank and lines[EFFORT] == "medium" and lines[UNSET] == ""
    notes = lines[NOTES].split("\t")
    assert cli.BLANKED_EFFORT_LINE.format(effort="medium") in notes
    assert cli.BLANKED_LINE.format(name="CLAUDE_CODE_SUBAGENT_MODEL") in notes
    assert not any("CLAUDE_CODE_SUBAGENT_MODEL_FORCE" in n for n in notes)
    lines = cli.launch_args(corpus, settings=json.dumps({"env": {"CLAUDE_CODE_EFFORT_LEVEL": "max", "MINE": "1"}}))
    assert env_of(lines.split("\n")) == {**blank, "MINE": "1"}, "their own --settings too"
    (config.WORKSPACES_DIR / "logs").mkdir(parents=True, exist_ok=True)
    (config.WORKSPACES_DIR / "logs" / "settings.json").write_text(json.dumps({"models": {"main": {"effort": "low"}}}))
    assert cli.launch_args(corpus).split("\n")[EFFORT] == "low", "the composer's choice for main wins"


def test_the_launch_says_plainly_when_hooks_modules_are_off_and_still_launches(corpus, tmp_path, monkeypatch):
    """Managed settings that set disableAllHooks or allowManagedHooksOnly, the analyst's own disableAllHooks or
    THIMBLE_NO_MODULE: the note line says thimble's agents can't start and why, and the launch goes on; THIMBLE_NO_MODULE
    is recorded among the switches. Safe mode gets its warning."""
    def note(**kw) -> list[str]:
        return cli.launch_args(corpus, **kw).split("\n")[NOTES].split("\t")

    assert not any("hooks modules are off" in n for n in note())
    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setattr(cc_plugin, "MANAGED_DIRS", {cc_plugin.sys.platform: managed})
    for key in ("disableAllHooks", "allowManagedHooksOnly"):
        (managed / "managed-settings.json").write_text(json.dumps({key: True}))
        assert cli.MODULES_OFF_LINE.format(reason=f"your organization's managed settings set {key}") in note()
    (managed / "managed-settings.json").write_text(json.dumps({"allowManagedHooksOnly": True,
                                                               "enabledPlugins": {"thimble@thimble-local": True}}))
    assert not any("hooks modules are off" in n for n in note()), "thimble is a managed plugin there"
    (managed / "managed-settings.json").unlink()
    monkeypatch.setenv(cli.NO_MODULE_ENV, "1")
    assert cli.MODULES_OFF_LINE.format(reason=f"{cli.NO_MODULE_ENV} is set") in note()
    assert _launch()["switches"][cli.NO_MODULE_ENV] == "1"
    monkeypatch.delenv(cli.NO_MODULE_ENV)
    (tmp_path / "cc").mkdir(exist_ok=True)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    assert cli.MODULES_OFF_LINE.format(reason="your Claude Code settings set disableAllHooks") in note()
    (tmp_path / "cc" / "settings.json").write_text("{}")
    # live check L29: what only the launch can see, its own --settings, is kept in launch.json for the browser and the
    # doctor, which run outside that session
    assert cli.launch_args(corpus, settings='{"disableAllHooks": true}')
    assert _launch()["modules_off"] == "your --settings set disableAllHooks"
    line = cli.module_line(corpus)
    assert line.startswith("off in the last launch here") and "your --settings set disableAllHooks" in line
    cli.launch_args(corpus)
    assert "modules_off" not in _launch()
    assert cli.SAFE_MODE_LINE in note(safe_mode=True)
    monkeypatch.setenv(cli.SAFE_MODE_ENV, "1")
    assert cli.SAFE_MODE_LINE in note()


def test_the_launch_says_nothing_about_the_permission_mode(corpus, tmp_path):
    """Before Claude Code starts, the launch cannot know main's mode (Claude Code starts in auto mode by its own default
    since 2.1.283), so it prints no note about it: the Manual-mode notice shows once main reports Manual mode
    (modes.manual_notice, test_manual_notice)."""
    user = tmp_path / "cc" / "settings.json"
    user.parent.mkdir(exist_ok=True)
    for own in ({}, {"permissions": {"defaultMode": "default"}}, {"permissions": {"disableAutoMode": "disable"}}):
        user.write_text(json.dumps(own))
        notes = cli.launch_args(corpus).split("\n")[NOTES]
        assert "Manual" not in notes and "shift+tab" not in notes and "auto mode" not in notes, own


def test_the_launch_and_the_doctor_name_the_security_plugin_s_allow_managed_mods_only(corpus, monkeypatch):
    """Where the organization's managed settings set the security plugin's allowManagedModsOnly, Claude Code loads no
    hooks module of a plugin a person installs, so thimble's agents can't start: the launch's note line, the doctor's
    check and its fix name the setting, as for allowManagedHooksOnly."""
    why = "your organization's managed settings set allowManagedModsOnly"
    monkeypatch.setattr(cc_plugin, "managed", lambda environ=None: {
        "pluginConfigs": {"cc-plugin-sec-default@builtin": {"options": {"allowManagedModsOnly": True}}}})
    assert cli.modules_off(corpus) == why
    assert cli.MODULES_OFF_LINE.format(reason=why) in cli.launch_args(corpus).split("\n")[NOTES].split("\t")
    assert cli.module_line(corpus).startswith(f"off: Claude Code's hooks modules are off ({why})")
    assert cli._hooks_fix(why) == ("Ask your administrator: your organization's Claude Code settings set "
                                   "allowManagedModsOnly")
