"""The MCP shim's lifetime (plugin/bin/thimble-mcp, module note): it serves its session until Claude Code closes its
stdin, and ends once its plugin folder is gone, as an uninstall or a deleted checkout leaves it, with no folder made on
the way. The shim runs from a copy of the plugin, as from Claude Code's plugin cache, on this tree's backend."""
from __future__ import annotations

import json
import os
import shutil
import subprocess

from app import config

INITIALIZE = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": {"name": "test", "version": "0"}}}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


def _folders(root, but: str) -> set[str]:
    """The folders under `root`, relative to it, but the folder `but` and those in it."""
    found = {os.path.relpath(os.path.join(at, d), root) for at, dirs, _ in os.walk(root) for d in dirs}
    return {f for f in found if f != but and not f.startswith(but + os.sep)}


def test_a_shim_ends_once_its_plugin_folder_is_gone_and_makes_no_folder(tmp_path):
    """A session left open after an uninstall keeps no shim: with its stdin still open, the shim of a plugin copy ends
    within a few seconds of the copy's deletion, and it made no folder, thimble's home and workspaces among them."""
    plugin = tmp_path / "plugins" / "cache" / "thimble"
    shutil.copytree(config.REPO_ROOT / "plugin", plugin)
    folder = tmp_path / "data"
    folder.mkdir()
    env = {**os.environ, "HOME": str(tmp_path / "home"), "CLAUDE_CONFIG_DIR": str(tmp_path / "claude-config"),
           "THIMBLE_APP_DIR": str(config.REPO_ROOT), "THIMBLE_CWD": str(folder)}
    for name in ("THIMBLE_SESSION", "THIMBLE_SESSION_TOKEN"):  # the analyst's session, which looks for its workspace
        env.pop(name, None)
    shim = subprocess.Popen([str(plugin / "bin" / "thimble-mcp")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=folder, env=env)
    try:
        shim.stdin.write((json.dumps(INITIALIZE) + "\n").encode())
        shim.stdin.flush()
        assert b'"result"' in shim.stdout.readline(), shim.communicate(timeout=30)[1].decode(errors="replace")
        shim.stdin.write((json.dumps(INITIALIZED) + "\n").encode())
        shim.stdin.flush()
        copy = os.path.relpath(plugin, tmp_path)
        before = _folders(tmp_path, but=copy)
        shutil.rmtree(plugin)
        assert shim.wait(timeout=15) == 0
        assert _folders(tmp_path, but=copy) == before
    finally:
        if shim.poll() is None:
            shim.kill()
            shim.wait()
