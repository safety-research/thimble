"""The plugin copy main loads and the route browser events take: a copy in Claude Code's plugin cache and the plugin of
a directory marketplace Claude Code has registered (a Global install's thimble-local) are named by their marketplace,
and any other folder is `inline`, loaded with --plugin-dir. Browser events reach main through the plugin's hooks, and
where Claude Code's settings turn hooks off /thimble prints a warning and the command main's Monitor runs; on the hook
route it prints nothing about routes."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cc_plugin, cli

NAME = "thimble-local"


@pytest.fixture()
def cc(tmp_path, monkeypatch) -> Path:
    """Claude Code's config dir, empty."""
    d = tmp_path / "cc"
    (d / "plugins").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(d))
    return d


def _tree(tmp_path: Path, name: str = NAME) -> Path:
    """A tree with a marketplace file and its plugin/; returns plugin/."""
    app = tmp_path / "app"
    (app / ".claude-plugin").mkdir(parents=True)
    (app / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"name": name, "plugins": []}))
    (app / "plugin").mkdir()
    return app / "plugin"


def _register(cc: Path, folder: Path, name: str = NAME, installed: bool = True) -> None:
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps(
        {name: {"source": {"source": "directory", "path": str(folder)}, "installLocation": str(folder)}}))
    plugins = {f"thimble@{name}": [{"scope": "user"}]} if installed else {}
    (cc / "plugins" / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": plugins}))


def test_cache_copy_names_its_marketplace(cc):
    assert cc_plugin.marketplace(cc / "plugins" / "cache" / "mkt" / "thimble" / "0.4.1") == "mkt"


def test_registered_directory_marketplace_names_itself(cc, tmp_path):
    root = _tree(tmp_path)
    _register(cc, root.parent)
    assert cc_plugin.marketplace(root) == NAME


@pytest.mark.parametrize("case", ["unregistered", "elsewhere", "not installed", "other name", "garbled"])
def test_other_folders_are_inline(cc, tmp_path, case):
    root = _tree(tmp_path)
    if case == "elsewhere":
        _register(cc, tmp_path / "another")
    elif case == "not installed":
        _register(cc, root.parent, installed=False)
    elif case == "other name":
        _register(cc, root.parent, name="thimble")
    elif case == "garbled":
        _register(cc, root.parent)
        (cc / "plugins" / "known_marketplaces.json").write_text("{not json")
    assert cc_plugin.marketplace(root) == cc_plugin.INLINE


@pytest.mark.parametrize("where", ["none", "user", "project", "managed", "managed-only"])
def test_the_route_is_the_hooks_unless_settings_turn_them_off(cc, tmp_path, monkeypatch, where):
    """disableAllHooks in the analyst's or the folder's settings, or in the org's managed tier, or a managed tier that
    allows only its own hooks without enabling this plugin, makes main arm a Monitor instead."""
    root, folder = _tree(tmp_path), tmp_path / "corpus"
    (folder / ".claude").mkdir(parents=True)
    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setitem(cc_plugin.MANAGED_DIRS, __import__("sys").platform, managed)
    if where == "user":
        (cc / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    elif where == "project":
        (cc / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
        (folder / ".claude" / "settings.local.json").write_text(json.dumps({"disableAllHooks": False}))
    elif where == "managed":
        (managed / cc_plugin.MANAGED_FILE).write_text(json.dumps({"disableAllHooks": True}))
    elif where == "managed-only":
        (managed / cc_plugin.MANAGED_FILE).write_text(json.dumps({"allowManagedHooksOnly": True}))
    off = where in ("user", "managed", "managed-only")
    assert cc_plugin.route(folder, root) == (cc_plugin.MONITOR if off else cc_plugin.HOOK)


@pytest.mark.parametrize("how", ["inline", "split", "file", "equals", "none"])
def test_the_launcher_s_settings_turn_the_hooks_off_over_the_folder_s(cc, tmp_path, monkeypatch, how):
    """`thimble --settings` with disableAllHooks reaches main as the `--settings` its `claude` runs with, which Claude
    Code ranks over the analyst's and the folder's settings: the route is the Monitor's. Without /proc the command line
    comes split on white space."""
    from app import procs

    root, folder = _tree(tmp_path), tmp_path / "corpus"
    (folder / ".claude").mkdir(parents=True)
    (folder / ".claude" / "settings.local.json").write_text(json.dumps({"disableAllHooks": False}))
    value = json.dumps({"statusLine": {"type": "command", "command": "a b"}, "disableAllHooks": True})
    (tmp_path / "s.json").write_text(value)
    argv = {"inline": ["claude", "--settings", value, "--", "/thimble"],
            "split": ["claude", "--settings", *value.split(), "--", "/thimble"],
            "file": ["claude", "--settings", "s.json"],
            "equals": ["claude", f"--settings={value}"],
            "none": ["claude", "--resume"]}[how]
    monkeypatch.setattr(cc_plugin, "claude_pid", lambda environ=None: 4242)
    monkeypatch.setattr(procs, "argv", lambda pid: argv if pid == 4242 else [])
    monkeypatch.setattr(procs, "cwd", lambda pid: tmp_path)
    assert cc_plugin.route(folder, root) == (cc_plugin.HOOK if how == "none" else cc_plugin.MONITOR)


def test_slash_thimble_prints_nothing_about_routes_on_the_hook_route_and_the_monitor_s_command_off_it(
        cc, tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "plugin_root", lambda: tmp_path / "plugin")
    assert cli.monitor_lines(tmp_path, "sid") == []
    (cc / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    note, mark = cli.monitor_lines(tmp_path, "sid")
    assert note == cli.MONITOR_NOTE
    assert mark.startswith(cli.MONITOR_MARK) and mark.endswith("--stream --cwd " + str(tmp_path) + " --session sid")
