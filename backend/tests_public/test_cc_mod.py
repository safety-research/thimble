"""thimble-cc-mod, the second plugin of thimble's marketplace: the marketplace lists it, `thimble cc-mod on|off|status`
switches it, and only it, in the current folder through `claude plugin` alone (stubbed here: no test runs Claude Code),
and every session thimble starts, main's and the background sessions, turns it off."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import cli, config

MP = "thimble-local"
MOD, OWN = f"thimble-cc-mod@{MP}", f"thimble@{MP}"


@pytest.fixture()
def claude(tmp_path, monkeypatch):
    """An install whose marketplace is thimble-local, a corpus folder as the caller's, and a stand-in for `claude plugin`:
    `listed` is what `plugin list --json` prints there, `markets` what `plugin marketplace list --json` prints; each run
    is recorded in `runs` and changes `listed` as Claude Code would, unless its verb is in `fail`."""
    market = tmp_path / "app" / ".claude-plugin" / "marketplace.json"
    market.parent.mkdir(parents=True)
    market.write_text(json.dumps({"name": MP}))
    monkeypatch.setattr(config, "MARKETPLACE_FILE", market)
    folder = tmp_path / "corpus"
    folder.mkdir()
    monkeypatch.setenv("THIMBLE_CALLER_CWD", str(folder))
    state = SimpleNamespace(listed=[{"id": OWN, "scope": "user", "enabled": True}],
                            markets=[{"name": MP, "source": "directory"}], runs=[], fail=set(), asked=[],
                            folder=folder.resolve())

    def listing(_claude, args, _cwd):
        if args == ["plugin", "list"]:
            return [dict(p) for p in state.listed]
        return list(state.markets) if args == ["plugin", "marketplace", "list"] else []

    def run(_claude, args, cwd):
        state.runs.append(args)
        if args[:3] == ["plugin", "marketplace", "add"]:
            if "marketplace add" in state.fail:
                return 1, "it went wrong"
            state.markets.append({"name": MP, "source": "directory", "path": args[3]})
            return 0, ""
        verb, pid = args[1], args[2]
        assert args[3:] == ["--scope", "project"] and Path(cwd) == state.folder
        if verb in state.fail:
            return 1, "it went wrong"
        if verb == "install":
            state.listed.append({"id": pid, "scope": "project", "projectPath": str(cwd), "enabled": True})
        elif verb == "uninstall":
            state.listed = [p for p in state.listed if not (p["id"] == pid and p["scope"] == "project")]
        else:
            for p in state.listed:
                if p["id"] == pid:
                    p["enabled"] = verb == "enable"
        return 0, ""

    def confirm(question):
        state.asked.append(question)
        return True

    monkeypatch.setattr(cli, "_claude_json", listing)
    monkeypatch.setattr(cli, "_claude_run", run)
    monkeypatch.setattr(cli, "confirm", confirm)
    return state


def _status(capsys) -> str:
    capsys.readouterr()
    assert cli.main(["cc-mod", "status"]) == 0
    return capsys.readouterr().out


def test_on_asks_then_installs_only_the_mod_and_off_uninstalls_only_the_mod(claude, capsys):
    assert cli.main(["cc-mod", "on"]) == 0
    out = capsys.readouterr().out
    assert claude.runs == [["plugin", "install", MOD, "--scope", "project"]]
    assert claude.asked == [cli.MOD_QUESTION]
    assert f"claude plugin install {MOD} --scope project" in out.split(cli.MOD_QUESTION)[0]
    assert str(claude.folder / ".claude" / "settings.json") in out and "`thimble cc-mod off`" in out
    status = _status(capsys)
    assert f"thimble-cc-mod is on in {claude.folder}" in status and f"thimble plugin is on in {claude.folder}" in status
    claude.runs.clear()
    assert cli.main(["cc-mod", "on"]) == 0 and claude.runs == [], "on already"
    assert cli.main(["cc-mod", "off"]) == 0
    assert claude.runs == [["plugin", "uninstall", MOD, "--scope", "project"]]
    status = _status(capsys)
    assert "thimble-cc-mod is off" in status and "thimble plugin is on" in status
    claude.runs.clear()
    assert cli.main(["cc-mod", "off"]) == 0 and claude.runs == [], "nothing left to undo"
    assert not (cli.home() / "cc-mod.json").exists()


def test_on_changes_nothing_without_a_yes_and_yes_skips_the_question(claude, capsys, monkeypatch):
    for answer, line in ((False, cli.MOD_DECLINED_LINE), (None, cli.MOD_UNASKED_LINE)):
        monkeypatch.setattr(cli, "confirm", lambda q, a=answer: a)
        assert cli.main(["cc-mod", "on"]) == 1
        assert line in capsys.readouterr().out and claude.runs == []
    monkeypatch.setattr(cli, "confirm", lambda q: pytest.fail("--yes asks nothing"))
    assert cli.main(["cc-mod", "on", "--yes"]) == 0
    assert [r[1] for r in claude.runs] == ["install"]


def test_a_thimble_plugin_off_here_stays_off_and_an_old_cc_mod_json_is_ignored(claude, capsys):
    """A test build turned thimble off where it turned the mod on and listed the folder in cc-mod.json; off leaves
    thimble off now, and status says how to turn it on."""
    claude.listed = [{"id": OWN, "scope": "project", "projectPath": str(claude.folder), "enabled": False}]
    old = cli.ensure_home() / "cc-mod.json"
    old.write_text(json.dumps([str(claude.folder)]))
    assert cli.main(["cc-mod", "on", "--yes"]) == 0
    assert cli.main(["cc-mod", "off"]) == 0
    assert claude.runs == [["plugin", "install", MOD, "--scope", "project"], ["plugin", "uninstall", MOD, "--scope", "project"]]
    status = _status(capsys)
    assert "thimble plugin is off" in status and f"`claude plugin enable {OWN} --scope project`" in status
    assert json.loads(old.read_text()) == [str(claude.folder)]
    old.write_text("not json")
    assert cli.main(["cc-mod", "on", "--yes"]) == 0


def test_on_without_the_marketplace_registered_registers_it_on_the_same_yes(claude, capsys, monkeypatch):
    """Only `thimble plugin on` (or install.sh --plugin) registers thimble's marketplace; without it, `on` lists the
    marketplace's registration before the install, asks once, and on a yes runs both. With a no it runs nothing."""
    add = ["plugin", "marketplace", "add", str(config.REPO_ROOT)]
    claude.markets = []
    monkeypatch.setattr(cli, "confirm", lambda q: False)
    assert cli.main(["cc-mod", "on"]) == 1 and claude.runs == []
    monkeypatch.setattr(cli, "confirm", lambda q: claude.asked.append(q) or True)
    capsys.readouterr()
    assert cli.main(["cc-mod", "on"]) == 0
    before = capsys.readouterr().out.split("+ claude")[0]
    assert claude.asked == [cli.MOD_QUESTION] and claude.runs == [add, ["plugin", "install", MOD, "--scope", "project"]]
    assert f"claude {' '.join(add)}" in before and f"claude plugin install {MOD} --scope project" in before
    assert f'marketplace "{MP}" yet' in before and "`thimble uninstall` takes it back" in before
    claude.runs.clear()
    assert cli.main(["cc-mod", "off"]) == 0 and claude.runs == [["plugin", "uninstall", MOD, "--scope", "project"]]
    claude.runs.clear()
    assert cli.main(["cc-mod", "on", "--yes"]) == 0, "registered now: only the install runs"
    assert claude.runs == [["plugin", "install", MOD, "--scope", "project"]]


def test_a_failed_registration_installs_nothing(claude, capsys):
    claude.markets, claude.fail = [], {"marketplace add"}
    assert cli.main(["cc-mod", "on", "--yes"]) == 1
    assert claude.runs == [["plugin", "marketplace", "add", str(config.REPO_ROOT)]]
    assert "it went wrong" in capsys.readouterr().out


def test_the_marketplace_from_another_install_is_left_and_nothing_runs(claude, capsys, tmp_path):
    claude.markets = [{"name": MP, "source": "directory", "path": str(tmp_path / "other")}]
    assert cli.main(["cc-mod", "on", "--yes"]) == 1 and claude.runs == []
    out = capsys.readouterr().out
    assert str(tmp_path / "other") in out and f"claude plugin marketplace remove {MP}" in out


def test_a_failed_install_says_why(claude, capsys):
    claude.fail = {"install"}
    assert cli.main(["cc-mod", "on", "--yes"]) == 1
    assert claude.runs == [["plugin", "install", MOD, "--scope", "project"]]
    assert "it went wrong" in capsys.readouterr().out


def test_status_counts_only_this_folder_s_project_install(claude, capsys, tmp_path):
    claude.listed.append({"id": MOD, "scope": "project", "projectPath": str(tmp_path / "elsewhere"), "enabled": True})
    status = _status(capsys)
    assert "thimble-cc-mod is off" in status and "thimble plugin is on" in status


def test_main_s_session_turns_the_mod_off_and_keeps_the_analyst_s_own_plugins(claude):
    assert json.loads(cli.launch_settings(claude.folder))["enabledPlugins"] == {MOD: False}
    given = json.dumps({"fastMode": True, "enabledPlugins": {"other@market": True, MOD: True}})
    out = json.loads(cli.launch_settings(claude.folder, given))
    assert out["enabledPlugins"] == {"other@market": True, MOD: False} and out["fastMode"] is True and out["statusLine"]
    assert json.loads(cli.launch_args(claude.folder).split("\n")[3])["enabledPlugins"] == {MOD: False}


def test_background_sessions_turn_the_mod_off_and_keep_the_analyst_s_own_plugins(claude):
    given = {"fastMode": True, "enabledPlugins": {"other@market": True, MOD: True}}
    assert config.without_mod(given) == {"fastMode": True, "enabledPlugins": {"other@market": True, MOD: False}}


def test_without_a_marketplace_name_the_settings_stay_as_they_are(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "MARKETPLACE_FILE", tmp_path / "missing.json")
    assert config.without_mod({"fastMode": True}) == {"fastMode": True}


def test_the_marketplace_lists_thimble_and_thimble_cc_mod_and_the_launcher_takes_the_command():
    market = json.loads(config.MARKETPLACE_FILE.read_text())
    plugins = {p["name"]: p for p in market["plugins"]}
    assert set(plugins) == {"thimble", "thimble-cc-mod"}
    assert plugins["thimble-cc-mod"]["source"] == "./mods/thimble-cc-mod"
    assert plugins["thimble-cc-mod"]["license"] == "Apache-2.0" and plugins["thimble-cc-mod"]["description"]
    launcher = (config.REPO_ROOT / "plugin" / "bin" / "thimble").read_text()
    assert " cc-mod " in launcher.split('SUPERVISOR_COMMANDS="', 1)[1].split('"', 1)[0]
