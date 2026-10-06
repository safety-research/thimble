"""Main started by `thimble` runs inside thimble's fence (cli.main_fence), so every subagent it starts, thimble's agents
among them, runs inside it too; the launch registers the folder, finds its extensions again and writes launch.json
before main starts (cli.launch_args), and says what it unset and why thimble's agents may not start."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cc_plugin, cli, config, userconf

REGISTER = cli.register_here  # the real one, which conftest replaces for the other tests
REFRESH = cli.refresh_extensions
SERVER_FOR_LAUNCH = cli.server_for_launch


@pytest.fixture()
def corpus(tmp_path, monkeypatch) -> Path:
    """A folder to start thimble in, with the data folder, the workspaces and thimble's home of the test's own; the
    folder registered as `logs`, its sandbox able to run."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("THIMBLE_PORT", "21101")
    monkeypatch.setenv("THIMBLE_UI_PORT", "21102")
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    for name in (*cli.UNSET_VARS, cli.NO_MODULE_ENV, cli.SAFE_MODE_ENV, "THIMBLE_CALLER_CWD", "THIMBLE_DEV_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(cc_plugin, "MANAGED_DIRS", {})
    folder = tmp_path / "work" / "logs"
    folder.mkdir(parents=True)
    config.register_corpus(folder, exact=True)
    return folder


def _conf(data) -> None:
    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps(data))


def _rules(fence) -> dict[str, list[str]]:
    return fence["permissions"]


def test_the_fence_keeps_the_corpus_read_only_and_lets_main_write_only_the_agents_work_folders(corpus):
    """Claude Code's sandbox on with no command outside it and no Bash allowed unasked; writes only in the six work
    folders, never a ticket's worktree; the corpus and the workspace's config and settings not writable; the token files
    and the links folder unreadable; thimble's records not editable; no additionalDirectories; the fence's mark."""
    fence = cli.main_fence(corpus)
    box, perms = fence["sandbox"], _rules(fence)
    ws = config.WORKSPACES_DIR.resolve() / "logs"
    assert box["enabled"] and not box["allowUnsandboxedCommands"] and not box["autoAllowBashIfSandboxed"]
    assert box["failIfUnavailable"] is True, "sandbox.enforce, on by default"
    fs = box["filesystem"]
    assert fs["allowWrite"] == [str(ws / d) for d in ("orient/work", "writers", "critique-work", "check-work",
                                                       "views-work", "extension/views")]
    assert fs["allowWrite"] == [str(p) for p in cli.write_dirs("logs")]
    assert fs["denyWrite"] == [str(corpus.resolve()), str(ws / "config.json"), str(ws / "settings.json")]
    assert fs["denyRead"] == [*userconf.private_paths(), str(cli.home() / "links")]
    assert "network" not in box, "the orientation's network is on by default"
    assert box["excludedCommands"] == [], "with the hooks on, no command runs outside the sandbox"
    assert "additionalDirectories" not in perms
    for p in ("checks/**", "chats/**", "extensions/**", "extension/extension.json", "orient/run.json", "subagents.json",
              "callers.jsonl", "launch.json", "views/**"):
        assert f"Edit(/{ws / p})" in perms["deny"], p
    assert f"Edit(/{userconf.main_modes_file()})" in perms["deny"]
    assert all(r in perms["deny"] for r in userconf.private_rules())
    assert f"Read(/{cli.home() / 'links'}/**)" in perms["deny"]
    assert f"Read(/{ws / 'critique'}/**)" in perms["allow"], "the critic reads its digest and brief"
    assert fence["env"] == {cc_plugin.FENCE_MARK: "1"}
    assert not any("views-work" in r for r in perms["deny"]), "view builders work there"
    rules = [*fs["allowWrite"], *fs["denyWrite"], *fs["denyRead"],
             *(r[len("Edit(/"):-1] for r in perms["deny"] if r.startswith("Edit("))]
    for path in rules:
        assert "*" not in path.removesuffix("/**"), f"{path}: Linux drops any other glob (U19)"


def test_the_fence_s_rules_follow_the_orientation_s_data_web_and_network_and_add_no_install_rule(corpus):
    """An edit of the corpus asks, is denied, or is left to the mode by `data`; an edit of thimble's config asks; the web
    tools ask, are denied or allowed by `web`; `network` off denies every domain. No rule names an install, whatever an
    earlier config's `installs` says."""
    ws = config.WORKSPACES_DIR.resolve() / "logs"
    corpus_rule = f"Edit(/{corpus.resolve()}/**)"
    for data, web, network in (("ask", "ask", "on"), ("off", "off", "off"), ("allow", "allow", "on")):
        for installs in ("ask", "deny", "allow"):
            _conf({"installs": installs, "agents": {"orientation": {"data": data, "web": web, "network": network}}})
            fence = cli.main_fence(corpus)
            perms = _rules(fence)
            where = {k: [r for r in v if r == corpus_rule] for k, v in perms.items()}
            assert where == {**{k: [] for k in perms}, **({"ask": [corpus_rule]} if data == "ask" else
                                                         {"deny": [corpus_rule]} if data == "off" else {})}
            web_in = {"ask": "ask", "off": "deny", "allow": "allow"}[web]
            assert {"WebFetch", "WebSearch"} <= set(perms[web_in])
            assert (fence["sandbox"].get("network") == {"deniedDomains": ["*"]}) == (network == "off")
            assert {f"Edit(/{userconf.global_file()})", f"Edit(/{ws / 'config.json'})",
                    f"Edit(/{ws / 'settings.json'})"} <= set(perms["ask"])
            every = [r for rules in perms.values() for r in rules]
            assert not any(r.startswith("Bash(") for r in every), (installs, every)
    causes = {r.rule: r.cause for r in userconf.main_rules("logs")}
    assert causes[f"Edit(/{userconf.global_file()})"] == "config" and causes["WebFetch"] == "web"
    assert "installs" not in causes.values()


def test_a_development_install_denies_edits_of_the_code_tickets_records(corpus, tmp_path, monkeypatch):
    """In a development install main may not edit the checkout's dev/tickets.jsonl and dev/applies.jsonl, which hold
    the change a ticket's checks passed; the folders are no write folder either."""
    monkeypatch.setenv("THIMBLE_DEV_DIR", str(tmp_path / "dev"))
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)
    (tmp_path / ".git").mkdir()
    perms = _rules(cli.main_fence(corpus))
    assert {f"Edit(/{tmp_path / 'dev' / 'tickets.jsonl'})", f"Edit(/{tmp_path / 'dev' / 'applies.jsonl'})"} <= \
        set(perms["deny"])
    (tmp_path / ".git").rmdir()
    assert not any("tickets.jsonl" in r for r in _rules(cli.main_fence(corpus))["deny"]), "an installed copy has none"


def test_no_fence_without_the_sandbox_and_the_launch_says_so(corpus, monkeypatch):
    """With thimble's config turning the sandbox off, or where it cannot run, main starts without the fence, and the
    launch's note line says so; a folder `up` refuses has no fence either."""
    _conf({"sandbox": {"use": "never", "enforce": False}})
    assert cli.main_fence(corpus) == {} and cli.fence_off("logs") == "never"
    assert cli.NO_FENCE_LINES["never"] in cli.launch_args(corpus).split("\n")[9].split("\t")
    _conf({})
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    assert cli.main_fence(corpus) == {}
    lines = cli.launch_args(corpus).split("\n")
    assert cli.NO_FENCE_LINES["missing"] in lines[9].split("\t")
    assert cc_plugin.FENCE_MARK not in json.dumps(json.loads(lines[3]).get("env") or {})
    assert cli.fence_off(None) == "refused"
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setattr(cli, "register_here", lambda cwd: None)
    assert cli.NO_FENCE_LINES["refused"] in cli.launch_args(corpus).split("\n")[9].split("\t")


def test_launch_json_says_unfenced_when_the_analysts_settings_cannot_be_read(corpus, capsys):
    """An analyst's --settings that cannot be read is passed on as it is, without thimble's fence, and launch.json
    records main as not fenced, as main's command line will show it."""
    lines = cli.launch_args(corpus, settings="missing.json").split("\n")
    assert lines[3] == "missing.json" and "could not be read" in capsys.readouterr().err
    assert json.loads((config.WORKSPACES_DIR / "logs" / cli.LAUNCH_FILE).read_text())["fenced"] is False
    cli.launch_args(corpus)
    assert json.loads((config.WORKSPACES_DIR / "logs" / cli.LAUNCH_FILE).read_text())["fenced"] is True


def test_a_config_with_an_error_still_fences_main_with_the_defaults(corpus):
    """A broken config never opens the fence: main is fenced with the defaults' rules."""
    _conf({"agents": {"orientation": {"data": "sometimes"}}})
    assert userconf.problem("logs")
    perms = _rules(cli.main_fence(corpus))
    assert f"Edit(/{corpus.resolve()}/**)" in perms["ask"]


def test_with_fence_joins_the_analysts_own_settings_but_keeps_the_sandbox_closed(corpus):
    """The analyst's own --settings: permission lists joined, their sandbox keys kept, filesystem and excluded commands
    joined, their env kept beside the fence's mark; the keys that would open the fence stay thimble's."""
    own = {"permissions": {"allow": ["Bash(git status)"], "ask": ["Bash(git push:*)"]},
           "sandbox": {"autoAllowBashIfSandboxed": True, "enabled": False, "allowUnsandboxedCommands": True,
                       "filesystem": {"allowWrite": ["/srv/out"]}, "excludedCommands": ["docker *"]},
           "env": {"MINE": "1"}}
    fence = cli.main_fence(corpus)
    fence["sandbox"]["excludedCommands"] = ["/p/bin/.thimble-watch --stream --cwd /c --session s"]  # hooks off
    out = cli.with_fence(own, fence)
    assert out["permissions"]["allow"][0] == "Bash(git status)"
    assert out["permissions"]["ask"][0] == "Bash(git push:*)" and len(out["permissions"]["ask"]) > 1
    assert out["sandbox"]["autoAllowBashIfSandboxed"] is True, "the analyst's own sandbox keys win"
    assert out["sandbox"]["enabled"] is True and out["sandbox"]["allowUnsandboxedCommands"] is False
    assert "/srv/out" in out["sandbox"]["filesystem"]["allowWrite"]
    assert out["sandbox"]["excludedCommands"] == ["docker *", *fence["sandbox"]["excludedCommands"]]
    assert out["env"]["MINE"] == "1" and out["env"][cc_plugin.FENCE_MARK] == "1"
    assert cli.with_fence(own, {}) is own
    settings = json.loads(cli.launch_settings(corpus, json.dumps(own), cli.main_fence(corpus)))
    assert cc_plugin.fenced_argv(["claude", "--settings", json.dumps(settings)], corpus), "main_fenced reads it so"


def test_launch_args_on_a_new_folder_registers_it_refreshes_its_extensions_first_and_writes_launch_json(
        tmp_path, corpus, monkeypatch):
    """On a folder never registered, launch-args registers it, finds its extensions again before anything reads the
    roles (U4), prints no --agents line, writes launch.json with main's session id, whether main is fenced, the
    switches and the variables it unsets, and gives main the fence."""
    monkeypatch.setattr(cli, "register_here", REGISTER)
    seen: list[str] = []
    monkeypatch.setattr(cli, "refresh_extensions", lambda c: seen.append(c))
    fresh = tmp_path / "work" / "notes"
    fresh.mkdir()
    assert config.workspace_for_cwd(str(fresh)) is None
    monkeypatch.setenv("CLAUDE_CODE_SUBAGENT_MODEL", "haiku")
    lines = cli.launch_args(fresh).split("\n")
    assert config.workspace_for_cwd(str(fresh)) == "notes" and seen == ["notes"]
    assert "--agents" not in "\n".join(lines[:10])
    rec = json.loads((config.WORKSPACES_DIR / "notes" / cli.LAUNCH_FILE).read_text())
    assert rec["session"] == lines[6] and cli.SESSION_ID_RE.fullmatch(rec["session"])
    assert rec["fenced"] is True and rec["switches"] == cli.SWITCHES and rec["unset"] == ["CLAUDE_CODE_SUBAGENT_MODEL"]
    assert rec["at"]
    settings = json.loads(lines[3])
    assert settings["sandbox"]["enabled"] and settings["env"][cc_plugin.FENCE_MARK] == "1"
    assert "Read(/" + str(Path(cli.resolve_env()["workspaces_dir"]).resolve() / "*" / "bg" / "*.md") + ")" not in lines[1]
    resumed = cli.launch_args(fresh, own_session="0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b").split("\n")
    assert resumed[6] == "" and json.loads((config.WORKSPACES_DIR / "notes" / cli.LAUNCH_FILE).read_text())["session"] \
        == "0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "the analyst's own --resume or --session-id names it"
    cli.launch_args(fresh, own_session="")
    assert json.loads((config.WORKSPACES_DIR / "notes" / cli.LAUNCH_FILE).read_text())["session"] is None
    home = Path.home()
    assert REGISTER(home) is None, "the home folder is never a workspace"


def test_the_launch_starts_the_server_before_main_and_before_it_finds_the_extensions(corpus, monkeypatch):
    """A server that is not up when `claude` starts lets the hooks module register thimble's agent types only later,
    and Claude Code then prints "N agent type(s) available" instead of listing them from main's first turn. So the
    launch starts the server and waits for it first, then finds the extensions through it, and prints what the start
    said; a folder thimble does not open starts none."""
    order: list[str] = []
    monkeypatch.setattr(cli, "server_for_launch", lambda c: order.append(f"server {c}") or ["thimble: restarted"])
    monkeypatch.setattr(cli, "refresh_extensions", lambda c: order.append(f"extensions {c}"))
    lines = cli.launch_args(corpus).split("\n")
    assert order == ["server logs", "extensions logs"] and "thimble: restarted" in lines[9].split("\t")
    order.clear()
    monkeypatch.setattr(cli, "register_here", lambda cwd: None)
    cli.launch_args(corpus)
    assert order == []


def test_server_for_launch_starts_and_waits_for_the_server_and_never_stops_the_launch(corpus, monkeypatch):
    """server_for_launch runs `up`'s start (ensure_running) with its wait and passes on its notices; another install's
    server on the port, a server that does not answer in time and a start that fails each give a line or nothing, and
    the launch goes on."""
    monkeypatch.setattr(cli, "foreign_home", lambda url=None: None)
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
    assert SERVER_FOR_LAUNCH("logs") == [cli.FOREIGN_LINE.format(port=cli.port(), other="/other/home")]


def test_launch_json_names_the_launchers_pid_where_kernels_and_mains_edits_cannot_change_it(corpus):
    """The launcher passes its own pid (--launcher-pid $$), which `exec claude` keeps, and launch.json records it, so the
    module's bridge can read main's fence from that process's command line before /thimble attaches main. launch.json
    stays a file the hooks trust: written where kernels see it read-only and main's Edit is denied, in no folder main's
    Bash may write."""
    from app import kernel_wrap  # noqa: PLC0415

    args = cli.build_parser().parse_args(["launch-args", "--launcher-pid", "4242", "--cwd", str(corpus)])
    assert args.launcher_pid == 4242
    cli.launch_args(corpus, launcher_pid=args.launcher_pid)
    path = config.workspace_dir("logs") / cli.LAUNCH_FILE
    rec = json.loads(path.read_text())
    assert rec["pid"] == 4242 and rec["fenced"] is True and cli.SESSION_ID_RE.fullmatch(rec["session"])
    cli.launch_args(corpus)
    assert "pid" not in json.loads(path.read_text()), "a launcher that names no pid: the bridge waits for /thimble"
    cli.launch_args(corpus, launcher_pid=1)
    assert "pid" not in json.loads(path.read_text()), "never init"
    assert path.name in kernel_wrap.TRUSTED_FILES
    fence = cli.main_fence(corpus)
    assert f"Edit(/{path.resolve()})" in fence["permissions"]["deny"]
    assert not any(path.resolve().is_relative_to(Path(d)) for d in fence["sandbox"]["filesystem"]["allowWrite"])


def test_refresh_extensions_asks_a_running_server_else_finds_them_here(corpus, monkeypatch):
    """A running server of this install refreshes the workspace's extensions (GET /ws/{c}/extensions); without one
    launch-args finds them itself. Neither failing stops the launch."""
    calls: list = []
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "foreign_home", lambda url=None: None)
    monkeypatch.setattr(cli, "_request", lambda method, url, body=None, timeout=5.0: calls.append((method, url)) or (200, {}))
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
    assert lines[2] == "high" and lines[8].split() == list(cli.UNSET_VARS)
    notes = lines[9].split("\t")
    assert cli.UNSET_EFFORT_LINE.format(effort="high") in notes
    assert all(cli.UNSET_LINE.format(name=n) in notes for n in cli.UNSET_VARS[1:])
    (config.WORKSPACES_DIR / "logs").mkdir(parents=True, exist_ok=True)
    (config.WORKSPACES_DIR / "logs" / "settings.json").write_text(json.dumps({"models": {"main": {"effort": "low"}}}))
    lines = cli.launch_args(corpus).split("\n")
    assert lines[2] == "low" and "CLAUDE_CODE_EFFORT_LEVEL" in lines[8].split()
    monkeypatch.delenv("CLAUDE_CODE_EFFORT_LEVEL")
    monkeypatch.delenv("CLAUDE_CODE_SUBAGENT_MODEL")
    monkeypatch.delenv("CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
    assert cli.launch_args(corpus).split("\n")[8] == ""


def test_main_s_settings_blank_the_variables_a_settings_file_s_env_would_set_and_main_keeps_its_effort(corpus, tmp_path,
                                                                                                     monkeypatch):
    """An `env` block in the analyst's Claude Code settings sets CLAUDE_CODE_EFFORT_LEVEL, which would override every
    agent's effort (live check L30), past the launcher's unset line. Main's --settings, which rank above the analyst's
    files, give each of the three variables '', which Claude Code reads as unset (a stand-in API received the --effort
    level under such a block once main's settings blanked it, and the settings file's level without), fenced or not.
    Main runs at the level the settings file named, passed as --effort, unless models.main names one; a note names each
    variable a settings file set."""
    def env_of(lines: list[str]) -> dict:
        return json.loads(lines[3])["env"]

    blank = {name: "" for name in cli.UNSET_VARS}
    lines = cli.launch_args(corpus).split("\n")
    assert env_of(lines) == {**blank, cc_plugin.FENCE_MARK: "1"}
    assert not any("is blank in this session" in n for n in lines[9].split("\t"))
    (tmp_path / "cc").mkdir(exist_ok=True)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"env": {"CLAUDE_CODE_EFFORT_LEVEL": "medium",
                                                                         "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"}}))
    lines = cli.launch_args(corpus).split("\n")
    assert env_of(lines) == {**blank, cc_plugin.FENCE_MARK: "1"} and lines[2] == "medium" and lines[8] == ""
    notes = lines[9].split("\t")
    assert cli.BLANKED_EFFORT_LINE.format(effort="medium") in notes
    assert cli.BLANKED_LINE.format(name="CLAUDE_CODE_SUBAGENT_MODEL") in notes
    assert not any("CLAUDE_CODE_SUBAGENT_MODEL_FORCE" in n for n in notes)
    lines = cli.launch_args(corpus, settings=json.dumps({"env": {"CLAUDE_CODE_EFFORT_LEVEL": "max", "MINE": "1"}}))
    assert env_of(lines.split("\n")) == {**blank, "MINE": "1", cc_plugin.FENCE_MARK: "1"}, "their own --settings too"
    (config.WORKSPACES_DIR / "logs").mkdir(parents=True, exist_ok=True)
    (config.WORKSPACES_DIR / "logs" / "settings.json").write_text(json.dumps({"models": {"main": {"effort": "low"}}}))
    assert cli.launch_args(corpus).split("\n")[2] == "low", "the composer's choice for main wins"
    _conf({"sandbox": {"use": "never", "enforce": False}})
    assert env_of(cli.launch_args(corpus).split("\n")) == blank, "without the fence as well"


def test_with_hooks_off_the_fence_lets_out_only_the_skill_s_own_command_for_main_s_session(corpus, tmp_path):
    """With the plugin's hooks off, /thimble's own command must reach the server from outside the sandbox. The fence
    lets out exactly that command as Claude Code runs it for main's session, for the plain /thimble and /thimble status
    alone, never `server up *`, which would let main's Bash run `--action fresh` or `fix` outside the sandbox. Claude
    Code 2.1.291 matched these entries against the skill's command as it ran it, without its `2>&1`, let the plain and the
    status one out, and kept fresh and fix in the sandbox. Without a session id for main, none is let out."""
    from test_plugin_agents import split

    sid = "0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
    root = cli.plugin_root()
    assert cli.main_fence(corpus, session=sid)["sandbox"]["excludedCommands"] == [], "hooks on"
    (tmp_path / "cc").mkdir(exist_ok=True)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    excluded = cli.main_fence(corpus, session=sid)["sandbox"]["excludedCommands"]
    assert excluded == [*cli.watch_rules(root, corpus, sid), *cli.sandbox_rules(root, corpus, sid)]
    assert len(excluded) == 3 and not any(rule.endswith("server up *") or rule.endswith(" *") for rule in excluded)
    # the Monitor route's watcher: exactly the command /thimble gives main's Monitor for main's session (monitor_lines)
    monkey = pytest.MonkeyPatch()
    monkey.setattr(cc_plugin, "route", lambda cwd, root, environ=None: cc_plugin.MONITOR)
    monkey.setattr(cli, "plugin_root", lambda: root)
    try:
        watched = next(ln for ln in cli.monitor_lines(corpus, sid) if ln.startswith(cli.MONITOR_MARK))
    finally:
        monkey.undo()
    assert watched.removeprefix(cli.MONITOR_MARK).strip() == excluded[0]
    _, body = split((root / "skills" / "thimble" / "SKILL.md").read_text("utf-8"))
    command = next(ln[2:].split("`")[0] for ln in body.splitlines() if "server up" in ln and ln.startswith("!`"))
    for action in cli.SANDBOX_ACTIONS:
        ran = (command.replace("${CLAUDE_PLUGIN_ROOT}", str(root)).replace("${CLAUDE_PROJECT_DIR}", str(corpus))
               .replace("${CLAUDE_SESSION_ID}", sid).replace("$action", action).replace("$archive", ""))
        assert ran.endswith(" 2>&1") and ran.removesuffix(" 2>&1") in excluded, ran
    assert cli.main_fence(corpus)["sandbox"]["excludedCommands"] == [], "no session id"
    lines = cli.launch_args(corpus).split("\n")
    assert cli.sandbox_rules(root, corpus, lines[6])[0] in json.loads(lines[3])["sandbox"]["excludedCommands"]
    link = tmp_path / "work" / "link"
    link.symlink_to(corpus)
    both = cli.sandbox_rules(root, link, sid)
    assert len(both) == 4 and any(f'--cwd "{link}"' in r for r in both) and any(f'--cwd "{corpus}"' in r for r in both)
    watch = cli.watch_rules(root, link, sid)
    assert len(watch) == 2 and any(f"--cwd {link} " in r for r in watch) and any(f"--cwd {corpus} " in r for r in watch)
    assert cli.watch_rules(root, corpus, None) == [] and cli.watch_rules(root, corpus, "x") == []
    assert cli.sandbox_rules(root, tmp_path / 'say "hi"', sid) == [] and cli.sandbox_rules(root, corpus, "x") == []


def test_the_launch_says_plainly_when_hooks_modules_are_off_and_still_launches(corpus, tmp_path, monkeypatch):
    """Managed settings that set disableAllHooks or allowManagedHooksOnly, the analyst's own disableAllHooks or
    THIMBLE_NO_MODULE: the note line says thimble's agents can't start and why, and the launch goes on; THIMBLE_NO_MODULE
    is recorded among the switches. Safe mode gets its warning."""
    def note(**kw) -> list[str]:
        return cli.launch_args(corpus, **kw).split("\n")[9].split("\t")

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
    rec = json.loads((config.WORKSPACES_DIR / "logs" / cli.LAUNCH_FILE).read_text())
    assert rec["switches"][cli.NO_MODULE_ENV] == "1"
    monkeypatch.delenv(cli.NO_MODULE_ENV)
    (tmp_path / "cc").mkdir(exist_ok=True)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    assert cli.MODULES_OFF_LINE.format(reason="your Claude Code settings set disableAllHooks") in note()
    (tmp_path / "cc" / "settings.json").write_text("{}")
    assert cli.SAFE_MODE_LINE in note(safe_mode=True)
    monkeypatch.setenv(cli.SAFE_MODE_ENV, "1")
    assert cli.SAFE_MODE_LINE in note()


def test_slash_thimble_warns_in_a_session_the_launcher_did_not_start(corpus, monkeypatch, capsys):
    """/thimble in a plain `claude` (no THIMBLE_LAUNCHED and no fence on its command line) prints the warning; in a
    launched, fenced main it does not."""
    monkeypatch.setattr(cli, "launched", lambda: False)
    monkeypatch.setattr(cli, "fenced_here", lambda cwd: False)
    assert cli.UNFENCED_LINE.startswith("thimble: WARNING - this session was not started with `thimble`")
    assert "thimble's agents cannot start in it" in cli.UNFENCED_LINE
    src = Path(cli.__file__).read_text("utf-8")
    assert "if args.session and not launched() and not fenced_here(cwd):\n            print(UNFENCED_LINE)" in src
    fence = {"sandbox": {"enabled": True}, "env": {cc_plugin.FENCE_MARK: "1"}}
    monkeypatch.undo()
    monkeypatch.setattr(cc_plugin, "claude_pid", lambda environ=None: 77)
    from app import procs

    monkeypatch.setattr(procs, "argv", lambda pid: ["claude", "--settings", json.dumps(fence)])
    monkeypatch.setattr(procs, "cwd", lambda pid: None)
    assert cli.fenced_here(Path("/tmp"))
    monkeypatch.setattr(procs, "argv", lambda pid: ["claude"])
    assert not cli.fenced_here(Path("/tmp"))
