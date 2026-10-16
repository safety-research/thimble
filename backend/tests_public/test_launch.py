"""The `thimble` command (0.9.0): `claude` with thimble's browser workbench opened at its start. It exports exactly
THIMBLE_OPEN, NO_PROXY, no_proxy and CLAUDE_CODE_TERMINAL_MCP_TOOLS, loads the plugin with --plugin-dir only when Claude
Code has not installed it, gives `/thimble open` as the first prompt only where the hooks module will not load, and
nothing else: no --append-system-prompt, no --settings, no --name, no switches. launch_args finds those values and keeps
them in <home>/launcher.json under the launcher's key, so a launch whose files did not change starts `claude` without
the backend's Python; it registers no folder and starts no server. `thimble mode` and `thimble cc-mod` say there are no
modes."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from app import cc_plugin, cli, config

ROOT = Path(__file__).resolve().parents[2]
INSTALLED_COPY = cli.installed_copy  # before conftest's autouse fixture stands it in
LOAD, TURN_TOOLS, MODULES_OFF, NOTES = 0, 1, 2, 3  # launch_args' lines
# launch-args as the launcher's tree of stubs runs it: prints the lines of `<file>` and keeps them under --key, as
# cli.launch_args does, and counts its runs in `<file>.runs`
STUB_LAUNCH_ARGS = '''import json, os, sys
src = sys.argv[1]
a = sys.argv[2:]
key = a[a.index("--key") + 1] if "--key" in a else ""
lines = (open(src).read().split("\\n") + ["", "", "", ""])[:4]
open(src + ".runs", "a").write("run\\n")
print("\\n".join(lines))
home = os.environ["THIMBLE_HOME"]
path = os.path.join(home, "launcher.json")
try:
    kept = json.load(open(path))
except (OSError, ValueError):
    kept = {}
kept[key] = {"load": lines[0], "turn_tools": lines[1], "modules_off": lines[2],
             "notes": [n for n in lines[3].split("\\t") if n]}
json.dump(kept, open(path, "w"))
'''


@pytest.fixture()
def corpus(tmp_path, monkeypatch) -> Path:
    """A folder to start thimble in, with thimble's home and Claude Code's config dir of the test's own."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    for name in (*cli.UNSET_VARS, cli.NO_MODULE_ENV, cli.SAFE_MODE_ENV, "THIMBLE_CALLER_CWD"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(cc_plugin, "MANAGED_DIRS", {})
    monkeypatch.setattr(cli, "claude_code_version", lambda: None)
    folder = tmp_path / "work" / "logs"
    folder.mkdir(parents=True)
    return folder


def test_launch_args_name_the_plugin_folder_the_turn_tools_and_why_the_module_is_off_and_keep_them(corpus, tmp_path):
    """Four lines; with a key, kept in <home>/launcher.json (0600, the LAUNCHER_KEPT newest keys). No folder is
    registered and no server starts: the session turns thimble on itself (THIMBLE_OPEN)."""
    lines = cli.launch_args(corpus, key="k1").split("\n")
    assert len(lines) == 4
    assert lines[LOAD] == str(cli.plugin_root()), "installed_copy None (conftest): load plugin/"
    assert lines[MODULES_OFF] == "" and lines[NOTES] == ""
    kept_file = tmp_path / "home" / cli.LAUNCHER_FILE
    kept = json.loads(kept_file.read_text())
    assert set(kept) == {"k1"} and kept["k1"]["load"] == lines[LOAD] and kept["k1"]["turn_tools"] == lines[TURN_TOOLS]
    assert kept_file.stat().st_mode & 0o777 == 0o600
    assert config.workspace_for_cwd(str(corpus)) is None, "no folder registered"
    for i in range(cli.LAUNCHER_KEPT + 3):
        cli.launch_args(corpus, key=f"k{i + 2}")
    kept = json.loads(kept_file.read_text())
    assert len(kept) == cli.LAUNCHER_KEPT and "k1" not in kept and f"k{cli.LAUNCHER_KEPT + 4}" in kept


def test_launch_args_say_plainly_when_hooks_modules_are_off(corpus, tmp_path, monkeypatch):
    """Managed settings that set disableAllHooks or allowManagedHooksOnly, the analyst's own disableAllHooks or
    THIMBLE_NO_MODULE: the third line says why, which makes the launcher's first prompt `/thimble open`, and the notes
    say thimble's agents can't start. Safe mode gets its warning."""
    def run(**kw) -> list[str]:
        return cli.launch_args(corpus, **kw).split("\n")

    assert run()[MODULES_OFF] == ""
    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setattr(cc_plugin, "MANAGED_DIRS", {cc_plugin.sys.platform: managed})
    for key in ("disableAllHooks", "allowManagedHooksOnly"):
        (managed / "managed-settings.json").write_text(json.dumps({key: True}))
        why = f"your organization's managed settings set {key}"
        got = run()
        assert got[MODULES_OFF] == why and cli.MODULES_OFF_LINE.format(reason=why) in got[NOTES].split("\t")
    (managed / "managed-settings.json").write_text(json.dumps({"allowManagedHooksOnly": True,
                                                               "enabledPlugins": {"thimble@thimble-local": True}}))
    assert run()[MODULES_OFF] == "", "thimble is a managed plugin there"
    (managed / "managed-settings.json").unlink()
    monkeypatch.setenv(cli.NO_MODULE_ENV, "1")
    assert run()[MODULES_OFF] == f"{cli.NO_MODULE_ENV} is set"
    monkeypatch.delenv(cli.NO_MODULE_ENV)
    (tmp_path / "cc").mkdir(exist_ok=True)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    assert run()[MODULES_OFF] == "your Claude Code settings set disableAllHooks"
    (tmp_path / "cc" / "settings.json").write_text("{}")
    assert run(settings='{"disableAllHooks": true}')[MODULES_OFF] == "your --settings set disableAllHooks"
    assert cli.SAFE_MODE_LINE in run(safe_mode=True)[NOTES].split("\t")


def test_the_launch_and_the_doctor_name_the_security_plugin_s_allow_managed_mods_only(corpus, monkeypatch):
    """Where the organization's managed settings set the security plugin's allowManagedModsOnly, Claude Code loads no
    hooks module of a plugin a person installs: the launch's third line, the doctor's check and its fix name the
    setting, as for allowManagedHooksOnly."""
    why = "your organization's managed settings set allowManagedModsOnly"
    monkeypatch.setattr(cc_plugin, "managed", lambda environ=None: {
        "pluginConfigs": {"cc-plugin-sec-default@builtin": {"options": {"allowManagedModsOnly": True}}}})
    assert cli.modules_off(corpus) == why
    assert cli.launch_args(corpus).split("\n")[MODULES_OFF] == why
    assert cli.module_line(corpus).startswith(f"off: Claude Code's hooks modules are off ({why})")
    assert cli._hooks_fix(why) == ("Ask your administrator: your organization's Claude Code settings set "
                                   "allowManagedModsOnly")


def test_without_the_plugin_registered_launch_args_name_this_tree_s_plugin_folder(tmp_path, monkeypatch):
    """thimble is not in every Claude Code session unless installed (install.sh --plugin, `thimble plugin on`): when
    Claude Code lists no thimble copy of this install (installed_copy), launch-args names this tree's plugin folder;
    when it lists this install's (a directory marketplace at this tree), none."""
    path = tmp_path / "path"
    path.mkdir()
    (path / "claude").write_text('#!/bin/sh\ncase "$*" in *"plugin list"*|*"marketplace list"*) echo "[]";; esac\n')
    (path / "claude").chmod(0o755)
    monkeypatch.setenv("PATH", f"{path}:/usr/bin:/bin")
    assert INSTALLED_COPY(tmp_path) is None
    name = config.marketplace_name()
    listed = json.dumps([{"id": f"thimble@{name}", "enabled": True}])
    markets = json.dumps([{"name": name, "source": "directory", "path": str(config.REPO_ROOT)}])
    (path / "claude").write_text(f"#!/bin/sh\ncase \"$*\" in *\"marketplace list\"*) echo '{markets}';; "
                                 f"*\"plugin list\"*) echo '{listed}';; esac\n")
    assert INSTALLED_COPY(tmp_path) == cli.Installed(cli.PLUGIN_DIR.resolve(), name)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(cli, "claude_code_version", lambda: None)
    assert cli.launch_args(tmp_path).split("\n")[LOAD] == str(cli.plugin_root()), "conftest: installed_copy None"
    monkeypatch.setattr(cli, "installed_copy", INSTALLED_COPY)
    assert cli.launch_args(tmp_path).split("\n")[LOAD] == "", "this install's copy, which Claude Code loads already"


# ----------------------------------------------------------------------------- the launcher itself


def _tree(tmp_path: Path, lines: list[str]) -> tuple[Path, Path, Path]:
    """plugin/bin/thimble in a tree of stubs (STUB_LAUNCH_ARGS for launch-args), and a `claude` that writes its argv,
    one per line, and its environment: (the launcher, the PATH folder, the file launch-args counts its runs in)."""
    tree = tmp_path / "tree"
    bin_ = tree / "plugin" / "bin"
    bin_.mkdir(parents=True)
    shutil.copy(ROOT / "plugin" / "bin" / "thimble", bin_ / "thimble")
    (tree / "plugin" / ".claude-plugin").mkdir()
    (tree / "plugin" / ".claude-plugin" / "plugin.json").write_text('{"name": "thimble", "version": "9.9.9"}')
    (tree / "backend").mkdir()
    src = tmp_path / "launch-args.txt"
    src.write_text("\n".join(lines))
    (tmp_path / "stub_launch_args.py").write_text(STUB_LAUNCH_ARGS)
    stubs = {"thimble-app-dir": f'#!/bin/sh\necho "{tree}"\n',
             "thimble-python": f'#!/bin/sh\nshift 2\nexec python3 "{tmp_path}/stub_launch_args.py" "{src}" "$@"\n'}
    for name, body in stubs.items():
        (bin_ / name).write_text(body)
        (bin_ / name).chmod(0o755)
    path = tmp_path / "path"
    path.mkdir()
    (path / "claude").write_text('#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$ARGV_OUT"\n'
                                 'env > "$ENV_OUT"\n')
    (path / "claude").chmod(0o755)
    return bin_ / "thimble", path, src.with_name("launch-args.txt.runs")


BASE_ENV = ("PATH", "HOME", "THIMBLE_HOME", "CLAUDE_CONFIG_DIR", "ARGV_OUT", "ENV_OUT", "PWD", "SHLVL", "_", "OLDPWD")


def _run(launcher: Path, path: Path, tmp_path: Path, *args: str, **env: str) -> tuple[list[str], dict, str]:
    (tmp_path / "home").mkdir(exist_ok=True)
    base = {"PATH": f"{path}:/usr/bin:/bin", "HOME": str(tmp_path), "THIMBLE_HOME": str(tmp_path / "home"),
            "CLAUDE_CONFIG_DIR": str(tmp_path / "cc"), "ARGV_OUT": str(tmp_path / "argv.txt"),
            "ENV_OUT": str(tmp_path / "env.txt")}
    done = subprocess.run(["bash", str(launcher), *args], check=True, capture_output=True, text=True,
                          cwd=tmp_path, env={**base, **env}, timeout=60)
    seen = dict(line.split("=", 1) for line in (tmp_path / "env.txt").read_text().splitlines() if "=" in line)
    return (tmp_path / "argv.txt").read_text().splitlines(), seen, done.stderr


def test_the_launcher_execs_claude_with_exactly_its_four_variables_and_no_appended_prompt(tmp_path):
    tools = "Agent,mcp__plugin_thimble_thimble__add_card"
    launcher, path, runs = _tree(tmp_path, [str(tmp_path / "tree" / "plugin"), tools, "", "thimble: a note"])
    argv, env, err = _run(launcher, path, tmp_path, "--model", "opus", "-c", "--new")
    assert argv == ["--plugin-dir", str(tmp_path / "tree" / "plugin"), "--model", "opus", "-c"], \
        "every flag as given, but 0.8.0's --new"
    assert "--append-system-prompt" not in argv and "--settings" not in argv and "--name" not in argv
    added = {k: v for k, v in env.items() if k not in BASE_ENV}
    assert added == {"THIMBLE_OPEN": "1", "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
                     "CLAUDE_CODE_TERMINAL_MCP_TOOLS": tools}, added
    assert err.strip() == "thimble: a note"
    assert runs.read_text().splitlines() == ["run"]
    # the next launch reads launcher.json under the same key: no backend Python, in well under 0.3 s
    started = time.monotonic()
    argv2, env2, err2 = _run(launcher, path, tmp_path, "--model", "opus", "-c")
    took = time.monotonic() - started
    assert argv2 == argv and env2["THIMBLE_OPEN"] == "1" and err2.strip() == "thimble: a note"
    assert runs.read_text().splitlines() == ["run"], "read from launcher.json"
    assert took < 0.3, took


def test_the_launcher_adds_no_plugin_dir_for_an_installed_plugin_and_opens_through_the_skill_without_the_module(tmp_path):
    launcher, path, _ = _tree(tmp_path, ["", "", "", ""])
    argv, env, _ = _run(launcher, path, tmp_path)
    assert argv == [] and "CLAUDE_CODE_TERMINAL_MCP_TOOLS" not in env, "an installed copy, and a claude without the switch"
    (tmp_path / "launch-args.txt").write_text("\n".join(["", "", "THIMBLE_NO_MODULE is set", ""]))
    (tmp_path / "home" / "launcher.json").unlink()
    argv, env, _ = _run(launcher, path, tmp_path, "--model", "opus")
    assert argv == ["--model", "opus", "--", "/thimble", "open"], "without the hooks module the skill opens it"
    assert env["THIMBLE_OPEN"] == "1"


def test_the_launcher_s_key_changes_with_what_its_values_depend_on(tmp_path):
    """A change of Claude Code's plugin registry or of the folder's settings, or the analyst's own --settings, makes the
    next launch ask launch-args again."""
    launcher, path, runs = _tree(tmp_path, ["", "", "", ""])
    _run(launcher, path, tmp_path)
    _run(launcher, path, tmp_path)
    assert len(runs.read_text().splitlines()) == 1
    (tmp_path / "cc" / "plugins").mkdir(parents=True)
    (tmp_path / "cc" / "plugins" / "installed_plugins.json").write_text("{}")
    _run(launcher, path, tmp_path)
    assert len(runs.read_text().splitlines()) == 2
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.json").write_text('{"disableAllHooks": true}')
    _run(launcher, path, tmp_path)
    assert len(runs.read_text().splitlines()) == 3
    _run(launcher, path, tmp_path, "--settings", '{"a": 1}')
    assert len(runs.read_text().splitlines()) == 4, "the analyst's own --settings"


def test_the_launcher_keeps_the_session_off_the_proxy_and_hands_a_subcommand_the_shells_no_proxy(tmp_path):
    """The session gets 127.0.0.1 and localhost in NO_PROXY and no_proxy, so its hooks module and MCP shim reach
    thimble's server past a proxy the shell sets. A subcommand gets the shell's own values: /thimble's hook runs in a
    plain `claude`'s environment, and its proxy line reads what that session sets (cli.proxy_unsafe)."""
    launcher, path, _ = _tree(tmp_path, ["", "", "", ""])
    _, env, _ = _run(launcher, path, tmp_path, HTTP_PROXY="http://127.0.0.1:9", NO_PROXY="corp.example")
    assert env["NO_PROXY"] == "corp.example,127.0.0.1,localhost" and env["no_proxy"] == "127.0.0.1,localhost"
    seen = tmp_path / "seen.txt"
    (launcher.parent / "thimble-python").write_text(f'#!/bin/sh\nprintf "%s|%s\\n" "${{NO_PROXY-unset}}" '
                                                    f'"${{no_proxy-unset}}" > "{seen}"\n')
    subprocess.run(["bash", str(launcher), "doctor"], check=True, capture_output=True, cwd=tmp_path,
                   env={"PATH": f"{path}:/usr/bin:/bin", "HOME": str(tmp_path), "NO_PROXY": "corp.example"})
    assert seen.read_text().strip() == "corp.example|unset"


@pytest.mark.parametrize("word", ["mode", "cc-mod"])
def test_mode_and_cc_mod_say_there_are_no_modes_and_change_nothing(tmp_path, word):
    home = tmp_path / "home"
    out = subprocess.run(["bash", str(ROOT / "plugin" / "bin" / "thimble"), word, "terminal"], capture_output=True,
                         text=True, cwd=tmp_path, timeout=30,
                         env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "THIMBLE_HOME": str(home)})
    assert out.returncode == 0 and out.stderr == ""
    assert out.stdout == ("thimble has no modes now. Type /thimble open, or press o in thimble's panel, to open the "
                          "browser.\n")
    assert not home.exists()


def test_the_launcher_names_nothing_of_0_8_0_s_launch():
    text = (ROOT / "plugin" / "bin" / "thimble").read_text()
    for gone in ("--append-system-prompt", "THIMBLE_LAUNCHED", "CLAUDE_CODE_DISABLE_AGENT_VIEW",
                 "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "launch_mode", "THIMBLE_MODE", "--session-id", "mode_line"):
        assert gone not in text, gone
    assert os.access(ROOT / "plugin" / "bin" / "thimble", os.X_OK)
