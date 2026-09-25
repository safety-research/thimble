"""app.cc_channel: whether a Claude Code session loaded thimble's channel, read from its `claude` process's command line
(the entry of --dangerously-load-development-channels or --channels that names this plugin copy), with THIMBLE_CHANNEL
as the explicit signal. The processes here are real: a Python process whose command line carries the flags stands in
for `claude`, so /proc (and `ps` without it) is read as it would be in a session. Then what Claude Code still refuses
after the flag (the provider, the org's managed settings, the `--channels` allowlist) and whether the plugin's hooks
run, which make the route delivery names: the channel, the hooks or the Monitor."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app import cc_channel, config, procs

PLUGIN = config.REPO_ROOT / "plugin"
LAUNCHER_ARGS = ["claude", "--plugin-dir", str(PLUGIN), "--dangerously-load-development-channels", "plugin:thimble@inline",
                 "--allowedTools", "mcp__plugin_thimble_thimble", "--append-system-prompt", "# thimble", "--", "/thimble"]


@pytest.fixture()
def claude():
    """Start a stand-in `claude` process with the given arguments; every one started is killed afterwards."""
    started: list[subprocess.Popen] = []

    def start(*args: str) -> int:
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", *args])
        started.append(p)
        # Popen returns once the child is forked, and until its exec its command line reads as this process's
        deadline = time.monotonic() + 5
        while "time.sleep(60)" not in " ".join(procs.argv(p.pid)) and time.monotonic() < deadline:
            time.sleep(0.01)
        return p.pid

    yield start
    for p in started:
        p.kill()
        p.wait()


def test_entries_are_read_the_way_claude_code_parses_the_flags():
    assert cc_channel.entries(LAUNCHER_ARGS) == ["plugin:thimble@inline"]
    assert cc_channel.entries(["claude", "--dangerously-load-development-channels", "plugin:thimble@inline", "server:probe",
                               "--effort", "high"]) == ["plugin:thimble@inline", "server:probe"], "one or more, up to the next option"
    assert cc_channel.entries(["claude", "--dangerously-load-development-channels=plugin:thimble@x", "hello"]) == \
        ["plugin:thimble@x"], "`--flag=value` gives exactly one"
    assert cc_channel.entries(["claude", "--channels", "plugin:thimble@x"]) == ["plugin:thimble@x"]
    assert cc_channel.entries(["claude", "--", "--dangerously-load-development-channels", "plugin:thimble@inline"]) == [], \
        "after `--` it is the prompt"
    assert cc_channel.entries(["claude", "--plugin-dir", "plugin"]) == []
    assert cc_channel.entries(["claude", "--dangerously-load-development-channels"]) == []


def test_the_marketplace_is_inline_for_a_folder_and_the_cache_s_for_an_installed_copy(tmp_path):
    installed = tmp_path / ".claude" / "plugins" / "cache" / "thimble-local" / "thimble" / "0.5.0"
    assert cc_channel.marketplace(PLUGIN) == "inline" and cc_channel.channel(PLUGIN) == "plugin:thimble@inline"
    assert cc_channel.marketplace(installed) == "thimble-local"
    assert cc_channel.channel(installed) == "plugin:thimble@thimble-local"
    assert cc_channel.marketplace(tmp_path / "plugins" / "cache" / "m" / "other" / "1.0") == "inline", "another plugin's path"


def test_the_session_is_on_when_its_claude_process_names_this_copy_s_channel(tmp_path, claude, monkeypatch):
    no_env: dict[str, str] = {}
    with_flag = claude(*LAUNCHER_ARGS[1:])
    plain = claude("--plugin-dir", str(PLUGIN))
    installed_entry = claude("--dangerously-load-development-channels", "plugin:thimble@thimble-local")
    installed = tmp_path / "plugins" / "cache" / "thimble-local" / "thimble" / "0.5.0"
    assert cc_channel.on(with_flag, PLUGIN, no_env)
    assert not cc_channel.on(plain, PLUGIN, no_env), "the plugin loaded without the channel flag"
    assert not cc_channel.on(installed_entry, PLUGIN, no_env), "Claude Code skips an entry for another marketplace"
    assert cc_channel.on(installed_entry, installed, no_env) and not cc_channel.on(with_flag, installed, no_env)
    assert not cc_channel.on(None, PLUGIN, no_env)
    assert cc_channel.on(plain, PLUGIN, {"THIMBLE_CHANNEL": "plugin:thimble@inline"}), "the launcher's explicit signal"
    assert cc_channel.on(None, PLUGIN, {"THIMBLE_CHANNEL": "plugin:thimble@inline"})
    monkeypatch.setattr(procs, "HAVE_PROC", False)  # macOS: `ps` instead of /proc
    assert cc_channel.on(with_flag, PLUGIN, no_env) and not cc_channel.on(plain, PLUGIN, no_env)


def test_claude_pid_walks_up_to_claude_pid_or_to_a_process_with_a_session_file(tmp_path):
    """A skill's command runs in a shell under `claude`, which names itself in CLAUDE_PID; without it, the nearest
    ancestor with a sessions/<pid>.json in Claude Code's config dir is the one. A CLAUDE_PID that is no ancestor (one
    inherited from another session) is passed over."""
    parent = os.getppid()
    grandparent = procs.ppid(parent)
    assert grandparent and grandparent > 1
    config_dir = tmp_path / "cc"
    (config_dir / "sessions").mkdir(parents=True)
    env = {"CLAUDE_CONFIG_DIR": str(config_dir)}
    assert cc_channel.claude_pid({**env, "CLAUDE_PID": str(grandparent)}) == grandparent
    assert cc_channel.claude_pid({**env, "CLAUDE_PID": str(os.getpid())}) is None, "this process is not its own ancestor"
    assert cc_channel.claude_pid(env) is None
    (config_dir / "sessions" / f"{grandparent}.json").write_text("{}")
    assert cc_channel.claude_pid(env) == grandparent


def test_a_command_under_a_claude_process_with_the_flag_finds_it(tmp_path):
    """End to end, as the skill's command runs: a stand-in `claude` with the flag starts a shell with CLAUDE_PID set to
    itself, and that shell's Python asks cc_channel."""
    probe = ("from app import cc_channel, config; "
             "pid = cc_channel.claude_pid(); print(pid, cc_channel.on(pid, config.REPO_ROOT / 'plugin'))")
    fake_claude = ("import os, subprocess, sys; "
                   "sys.exit(subprocess.call(['sh', '-c', sys.argv[1]], env={**os.environ, 'CLAUDE_PID': str(os.getpid())}))")
    env = {k: v for k, v in os.environ.items() if k not in ("THIMBLE_CHANNEL", "CLAUDE_PID")}
    env["CLAUDE_CONFIG_DIR"] = str(tmp_path)
    shell = f"{sys.executable} -c \"{probe}\""
    backend = Path(__file__).resolve().parents[1]
    for args, expect in ((LAUNCHER_ARGS[1:], "True"), (["--plugin-dir", str(PLUGIN)], "False")):
        p = subprocess.Popen([sys.executable, "-c", fake_claude, shell, *args], cwd=backend, env=env, stdout=subprocess.PIPE,
                             text=True)
        out, _ = p.communicate(timeout=60)
        assert out.split() == [str(p.pid), expect], args


# ----------------------------------------------------------------------------- what Claude Code refuses after the flag


CLAUDE_AI = {"claudeAiOauth": {"accessToken": "t", "refreshToken": "r", "subscriptionType": "max",
                                "scopes": ["user:inference", "user:profile"]}}  # a claude.ai login's credentials file


@pytest.fixture()
def cc(tmp_path, monkeypatch):
    """Claude Code's config dir, logged in to claude.ai (a credentials file with the inference scope), and the
    managed-settings folder, empty, both under the test's tmp dir: (environ with the flag, environ without it,
    write(path, data), the config dir, the managed folder)."""
    config_dir = tmp_path / "cc"
    config_dir.mkdir()
    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setattr(cc_channel, "MANAGED_DIRS", {sys.platform: managed})

    def write(path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(__import__("json").dumps(data))

    write(config_dir / ".credentials.json", CLAUDE_AI)
    base = {"CLAUDE_CONFIG_DIR": str(config_dir)}
    return {**base, "THIMBLE_CHANNEL": "plugin:thimble@inline"}, base, write, config_dir, managed


def test_delivery_is_the_channel_unless_the_provider_or_the_org_refuses_it(tmp_path, cc):
    """Claude Code 2.1.281's gate, in its order: Bedrock, Vertex or Foundry get no channels; then a login that is not a
    claude.ai one (test_an_api_key_login_gets_no_channel); then the managed tier (the server-managed
    remote-settings.json when it exists, else managed-settings.json with its drop-ins): channelsEnabled true allows,
    false forbids, and unset forbids for a Team or Enterprise seat. Without the flag it is the hook route, with why."""
    flagged, plain, write, config_dir, managed = cc
    cwd = tmp_path / "corpus"
    D = cc_channel.Delivery
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("channel")
    assert cc_channel.delivery(None, PLUGIN, cwd, plain) == D("hook", "session")
    assert cc_channel.delivery(None, PLUGIN, cwd, {**flagged, "CLAUDE_CODE_USE_BEDROCK": "1"}) == D("hook", "provider")
    assert cc_channel.delivery(None, PLUGIN, cwd, {**flagged, "CLAUDE_CODE_USE_VERTEX": "0"}) == D("channel")
    write(config_dir / ".claude.json", {"oauthAccount": {"organizationType": "claude_enterprise"}})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("hook", "org"), "Team and Enterprise: off unless allowed"
    assert cc_channel.delivery(None, PLUGIN, cwd, plain) == D("hook", "org"), "the admin's fix, not the flag's"
    write(config_dir / "remote-settings.json", {"channelsEnabled": True})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("channel")
    write(config_dir / ".claude.json", {"oauthAccount": {"organizationType": "claude_max"}})
    write(config_dir / "remote-settings.json", {"channelsEnabled": False})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("hook", "org")
    (config_dir / "remote-settings.json").unlink()
    write(managed / "managed-settings.json", {"model": "x"})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("channel"), "unset: on for a claude.ai Max seat"
    write(config_dir / ".credentials.json", {"claudeAiOauth": {**CLAUDE_AI["claudeAiOauth"], "subscriptionType": "team"}})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("hook", "org"), "the token's own subscription type counts"
    write(managed / "managed-settings.d" / "10-channels.json", {"channelsEnabled": True})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("channel"), "a drop-in counts"
    write(config_dir / "remote-settings.json", {})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("hook", "org"), "server-managed first: the file alone"


def test_an_api_key_login_gets_no_channel(tmp_path, cc, claude, monkeypatch):
    """Claude Code 2.1.281 says "Channels are not currently available" to a session whose login is not a claude.ai one,
    and loads no channel: an API key or an auth token in its environment or a settings file's `env` block, an
    apiKeyHelper in any tier of its settings (the user's, the project's, the folder's local file, the managed tier, a
    `--settings` on its command line), an Anthropic profile, or no OAuth token with the inference scope. Such a session
    gets the hook route and the generic note, before the org's policy is asked."""
    flagged, plain, write, config_dir, managed = cc
    cwd = tmp_path / "corpus"
    D = cc_channel.Delivery
    account = D("hook", "account")
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("channel")
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "ANTHROPIC_PROFILE"):
        assert cc_channel.delivery(None, PLUGIN, cwd, {**flagged, name: "x"}) == account, name
    assert cc_channel.delivery(None, PLUGIN, cwd, {**plain, "ANTHROPIC_API_KEY": "x"}) == account, "no flag: still why"
    helper = {"apiKeyHelper": "print-api-key --profile work"}
    for path in (config_dir / "settings.json", cwd / ".claude" / "settings.json", cwd / ".claude" / "settings.local.json",
                 managed / "managed-settings.json", config_dir / "remote-settings.json"):
        write(path, helper)
        assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == account, path
        path.unlink()
    write(config_dir / "settings.json", {"env": {"ANTHROPIC_API_KEY": "x"}})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == account, "a settings file's env block"
    (config_dir / "settings.json").unlink()
    write(config_dir / "settings.json", {"apiKeyHelper": ""})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("channel"), "an empty helper is none"
    inline = claude(*LAUNCHER_ARGS[1:3], "--settings", '{"apiKeyHelper": "echo k"}', *LAUNCHER_ARGS[3:])
    assert cc_channel.delivery(inline, PLUGIN, cwd, plain) == account, "--settings with inline JSON"
    write(cwd / "s.json", helper)
    by_file = claude(*LAUNCHER_ARGS[1:5], "--settings=s.json")
    assert cc_channel.delivery(by_file, PLUGIN, cwd, plain) == account, "--settings naming a file in the folder"
    (config_dir / ".credentials.json").unlink()
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == account, "no login at all"
    assert cc_channel.delivery(None, PLUGIN, cwd, {**flagged, "CLAUDE_CODE_OAUTH_TOKEN": "t"}) == D("channel"), \
        "a `claude setup-token` token is a claude.ai login"
    assert cc_channel.delivery(None, PLUGIN, cwd, {**flagged, "CLAUDE_CODE_OAUTH_TOKEN": "t",
                                                   "CLAUDE_CODE_OAUTH_SCOPES": "user:profile"}) == account
    write(config_dir / ".credentials.json", {"claudeAiOauth": {"accessToken": "t", "scopes": ["org:create_api_key"]}})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == account, "a Console login has no inference scope"
    write(config_dir / ".claude.json", {"oauthAccount": {"organizationType": "claude_max"}})
    (config_dir / ".credentials.json").unlink()
    monkeypatch.setattr(sys, "platform", "darwin")  # the Keychain holds the token there; the account stands for it
    monkeypatch.setattr(cc_channel, "MANAGED_DIRS", {"darwin": managed})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("channel")


def test_the_test_config_s_api_key_login_is_not_a_claude_ai_one(tmp_path):
    """A config dir whose settings name an apiKeyHelper and that holds no credentials file, as a test config kept apart
    from the analyst's own does, with the launcher's flag: /thimble prints the generic note on the hook route instead of
    promising the channel."""
    from app import cli

    config_dir = tmp_path / "test-config"
    config_dir.mkdir()
    (config_dir / "settings.json").write_text('{"apiKeyHelper": "print-api-key", "theme": "dark"}')
    env = {"CLAUDE_CONFIG_DIR": str(config_dir), "THIMBLE_CHANNEL": "plugin:thimble@inline"}
    route = cc_channel.delivery(None, PLUGIN, tmp_path, env)
    assert route == cc_channel.Delivery("hook", "account")
    note = cli.delivery_lines(route, tmp_path, "s-1")
    assert note == [cli.HOOK_NOTES[cc_channel.PROVIDER]]
    assert "not available in this session" in note[0] and "{command}" not in note[0]


def test_the_channels_flag_needs_the_org_s_allowlist_and_the_development_flag_does_not(tmp_path, cc, claude):
    _, plain, write, config_dir, _ = cc
    pid = claude("--channels", "plugin:thimble@inline")
    cwd = tmp_path / "corpus"
    assert cc_channel.flags(pid, PLUGIN, plain) == {"--channels"}
    assert cc_channel.delivery(pid, PLUGIN, cwd, plain) == cc_channel.Delivery("hook", "org")
    write(config_dir / "remote-settings.json", {"channelsEnabled": True,
                                                "allowedChannelPlugins": [{"plugin": "thimble", "marketplace": "inline"}]})
    assert cc_channel.delivery(pid, PLUGIN, cwd, plain) == cc_channel.Delivery("channel")
    dev = claude("--dangerously-load-development-channels", "plugin:thimble@inline")
    write(config_dir / "remote-settings.json", {"channelsEnabled": True})
    assert cc_channel.delivery(dev, PLUGIN, cwd, plain) == cc_channel.Delivery("channel")


def test_with_hooks_off_too_it_is_the_monitor_route(tmp_path, cc):
    """The managed tier's disableAllHooks, or its allowManagedHooksOnly unless it enables this plugin, or disableAllHooks
    as the analyst's, the project's and the folder's local settings resolve it (the later wins)."""
    flagged, plain, write, config_dir, managed = cc
    cwd = tmp_path / "corpus"
    D = cc_channel.Delivery
    write(config_dir / "remote-settings.json", {"channelsEnabled": False, "disableAllHooks": True})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("monitor", "org")
    write(config_dir / "remote-settings.json", {"channelsEnabled": False, "allowManagedHooksOnly": True})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("monitor", "org")
    write(config_dir / "remote-settings.json", {"channelsEnabled": False, "allowManagedHooksOnly": True,
                                                "enabledPlugins": {"thimble@inline": True}})
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("hook", "org"), "a plugin the org enables keeps its hooks"
    (config_dir / "remote-settings.json").unlink()
    write(config_dir / "settings.json", {"disableAllHooks": True})
    assert cc_channel.delivery(None, PLUGIN, cwd, plain) == D("monitor", "session")
    write(cwd / ".claude" / "settings.local.json", {"disableAllHooks": False})
    assert cc_channel.delivery(None, PLUGIN, cwd, plain) == D("hook", "session"), "the folder's local settings win"
    assert cc_channel.delivery(None, PLUGIN, cwd, flagged) == D("channel"), "hooks do not matter with the channel"
