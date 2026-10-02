"""The channel entry of a plugin copy and the delivery note /thimble prints: a copy in Claude Code's plugin cache and the
plugin of a directory marketplace Claude Code has registered (a Global install's thimble-local) are named by their
marketplace, any other folder is `inline` with --plugin-dir, and a background session of Claude Code's gets no advice to
restart with channels."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cc_channel, cli, procs

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
    assert cc_channel.marketplace(cc / "plugins" / "cache" / "mkt" / "thimble" / "0.4.1") == "mkt"


def test_registered_directory_marketplace_names_itself(cc, tmp_path):
    root = _tree(tmp_path)
    _register(cc, root.parent)
    assert cc_channel.marketplace(root) == NAME
    assert cc_channel.channel(root) == f"plugin:thimble@{NAME}"


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
    assert cc_channel.marketplace(root) == cc_channel.INLINE


def test_channel_command_for_a_registered_marketplace(cc, tmp_path):
    root = _tree(tmp_path)
    assert "--plugin-dir" in cli.channel_command(root)
    _register(cc, root.parent)
    command = cli.channel_command(root)
    assert command == f"claude --dangerously-load-development-channels plugin:thimble@{NAME}"


def test_flags_recognise_the_marketplace_entry(cc, tmp_path, monkeypatch):
    root = _tree(tmp_path)
    _register(cc, root.parent)
    monkeypatch.setattr(procs, "argv", lambda pid: ["claude", cc_channel.DEV_FLAG, f"plugin:thimble@{NAME}"])
    assert cc_channel.flags(4242, root, {"CLAUDE_CONFIG_DIR": str(cc)}) == {cc_channel.DEV_FLAG}
    monkeypatch.setattr(procs, "argv", lambda pid: ["claude", cc_channel.DEV_FLAG, "plugin:thimble@inline"])
    assert cc_channel.flags(4242, root, {"CLAUDE_CONFIG_DIR": str(cc)}) == set()


def _state(cc: Path, pid: int, kind: str) -> None:
    (cc / "sessions").mkdir(exist_ok=True)
    (cc / "sessions" / f"{pid}.json").write_text(json.dumps({"pid": pid, "kind": kind}))


@pytest.mark.parametrize("mode", [cc_channel.HOOK, cc_channel.MONITOR])
@pytest.mark.parametrize("detected", ["env", "state file"])
def test_background_session_note_gives_no_restart(cc, tmp_path, mode, detected):
    if detected == "env":
        bg = cc_channel.background(None, {"CLAUDE_CONFIG_DIR": str(cc), cc_channel.BG_KIND_ENV: cc_channel.BG_KIND})
    else:
        _state(cc, 4242, "bg")
        bg = cc_channel.background(4242, {"CLAUDE_CONFIG_DIR": str(cc)})
    assert bg
    route = cc_channel.Delivery(mode, cc_channel.SESSION)
    lines = cli.delivery_lines(route, tmp_path, "sid", bg)
    text = "\n".join(lines)
    assert cc_channel.DEV_FLAG not in text and "quit" not in text and "restart" not in text
    assert lines[0].startswith("thimble: ")
    assert lines[-1].startswith(cli.MONITOR_MARK) == (mode == cc_channel.MONITOR)


@pytest.mark.parametrize("mode", [cc_channel.HOOK, cc_channel.MONITOR])
def test_interactive_session_note_keeps_the_restart_command(cc, tmp_path, mode):
    _state(cc, 4242, "interactive")
    bg = cc_channel.background(4242, {"CLAUDE_CONFIG_DIR": str(cc)})
    assert not bg
    lines = cli.delivery_lines(cc_channel.Delivery(mode, cc_channel.SESSION), tmp_path, "sid", bg)
    assert cli.channel_command() in lines[0]
    org = cc_channel.Delivery(mode, cc_channel.ORG)
    assert cli.delivery_lines(org, tmp_path, "sid", True) == cli.delivery_lines(org, tmp_path, "sid", False)
