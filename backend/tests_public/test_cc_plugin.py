"""The plugin copy main loads and the route browser events take: a copy in Claude Code's plugin cache and the plugin of
a directory marketplace Claude Code has registered (a Global install's thimble-local) are named by their marketplace,
and any other folder is `inline`, loaded with --plugin-dir. Browser events reach main through the plugin's hooks, and
where Claude Code's settings turn hooks off /thimble prints a warning and the command main's Monitor runs; on the hook
route it prints nothing about routes."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cc_plugin

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


@pytest.mark.parametrize("where", ["none", "project"])
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


MODS_ONLY = {"pluginConfigs": {"cc-plugin-sec-default@builtin": {"options": {"allowManagedModsOnly": True}}}}


@pytest.mark.parametrize("tier, off", [(None, False), (MODS_ONLY, True)])
def test_the_security_plugin_s_allow_managed_mods_only_keeps_thimble_s_module_out(monkeypatch, tier, off):
    """Claude Code's built-in security plugin, seated where an organization manages Claude Code (unless managed
    prependPlugins leaves it out), refuses the hooks module of every plugin a person installs when its managed option
    allowManagedModsOnly is set to anything but false; a plugin in one of the organization's own seats loads."""
    monkeypatch.setattr(cc_plugin, "managed", lambda environ=None: tier)
    assert cc_plugin.managed_mods_only() is off
