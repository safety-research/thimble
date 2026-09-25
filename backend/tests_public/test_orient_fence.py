"""The fence and permissions of the sessions thimble starts: the process runs in its work folder, where alone it
writes; Edit, Write and sandboxed Bash refuse the whole corpus folder; nothing limits what it reads; Claude Code's Bash
sandbox runs where it can (no network) and its absence never blocks the session; the fence allows nothing of thimble's
own, so Claude Code's own permission mode decides; and Start's mode switcher becomes the session's mode, defaulting to
the one the analyst's own stands for. install.sh never runs sudo."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from app import agent_session, cc_settings, channel, config, ledger, orient_session

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _config(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    (tmp_path / "cc").mkdir()
    monkeypatch.delenv("THIMBLE_SANDBOX", raising=False)
    cc_settings._sandbox.clear()
    yield
    cc_settings._sandbox.clear()


def test_the_fence_denies_the_whole_corpus_folder_blocks_no_read_and_adds_the_sandbox_where_it_runs():
    cwd, work = config.corpus_dir(CORPUS), orient_session.work_dir(CORPUS)
    plain = agent_session.fence(cwd, work, sandbox=False)
    # the session's process runs in the work folder, so the corpus folder is an added working directory and is denied
    # whole, to the file tools and to the sandbox's Bash alike: no write, append, delete or new file (a deny of
    # each existing entry would leave `touch <corpus>/probe.txt` open)
    assert plain == {"permissions": {"additionalDirectories": [str(cwd)], "deny": [f"Edit(/{cwd}/**)"]},
                     "claudeMdExcludes": agent_session.memory_excludes(cwd, work)}, "no allow of thimble's own"
    boxed = agent_session.fence(cwd, work, sandbox=True)
    # no read block and no Read deny: thimble's own tree is read under the analyst's permission mode like any other
    # folder outside the corpus
    for settings in (plain, boxed):
        assert "blockReadsOutsideWorkingDirectories" not in settings["permissions"]
        assert not [r for r in settings["permissions"]["deny"] if r.startswith(("Read", "Grep", "Glob"))]
    sandbox = boxed["sandbox"]
    assert sandbox["enabled"] and not sandbox["allowUnsandboxedCommands"]
    assert sandbox["autoAllowBashIfSandboxed"] is False, "which Bash calls ask is Claude Code's own asking in the mode"
    unasked = agent_session.fence(cwd, work, sandbox=True, unasked=True)
    assert unasked["permissions"]["allow"] == [f"Edit(/{work}/**)"] and unasked["sandbox"]["autoAllowBashIfSandboxed"], \
        "a check's run, which nobody watches, keeps its own allows"
    assert sandbox["failIfUnavailable"] is False, "the sandbox's absence never blocks the session"
    # Bash stays offline although the session has the web tools, so a script cannot send the corpus anywhere
    assert sandbox["network"] == {"deniedDomains": ["*"]}
    assert "filesystem" not in sandbox, "nothing hides a folder from Bash, so no read needs re-opening"
    env = agent_session.fence_env(work)
    assert env["PATH"].split(":")[0] == str(Path(sys.prefix) / "bin")
    assert env["XDG_CACHE_HOME"] == str(work / agent_session.CACHE_DIR) and (work / agent_session.CACHE_DIR).is_dir()
    assert env[agent_session.MEMORY_ENV] == "1", "the corpus's CLAUDE.md, read as the added folder's"


def test_the_shared_skill_s_command_prints_the_prompts_rendered_for_the_corpus_from_the_work_folder(tmp_path):
    """The shared skill's command (plugin/skills/shared) runs with --cwd naming the orientation's work folder, which is
    no corpus folder, so the prompts it would render there lack the corpus's citation forms. skill_prompts_env renders the prompts that command names for the corpus
    folder into the work folder, and plugin/bin/thimble prints them from there, the text the supervisor prints for the
    corpus. A copy of the launcher outside the tree shows the route alone: without the variable it finds no tree."""
    cwd, work = config.corpus_dir(CORPUS), orient_session.work_dir(CORPUS)
    skill = (agent_session.PLUGIN_DIR / "skills" / "shared" / "SKILL.md").read_text("utf-8")
    assert f"/bin/thimble prompt {' '.join(agent_session.SKILL_PROMPTS)} --cwd " in skill
    env = agent_session.skill_prompts_env(cwd, work)
    assert env == {agent_session.RENDERED_ENV: str(work / agent_session.RENDERED_DIR)}
    bin_ = tmp_path / "plugin" / "bin"
    bin_.mkdir(parents=True)
    for name in ("thimble", "thimble-app-dir"):
        shutil.copy2(agent_session.PLUGIN_DIR / "bin" / name, bin_ / name)
    base = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "THIMBLE_HOME": str(tmp_path / "home")}
    args = [str(bin_ / "thimble"), "prompt", *agent_session.SKILL_PROMPTS, "--cwd", str(work)]
    run = subprocess.run(args, env={**base, **env}, capture_output=True, text=True, timeout=30)
    assert (run.returncode, run.stdout) == (0, channel.render_prompts(agent_session.SKILL_PROMPTS, str(cwd)) + "\n")
    bare = subprocess.run(args, env=base, capture_output=True, text=True, timeout=30)
    assert bare.returncode == 1 and "thimble tree was not found" in bare.stderr
    # a prompt that was not rendered, or another option, is left to the supervisor
    for other in (["main", "--cwd", str(work)], ["shared", "--if-main"]):
        run = subprocess.run([*args[:2], *other], env={**base, **env}, capture_output=True, text=True, timeout=30)
        assert (run.returncode, run.stdout) == (1, "") and "thimble tree was not found" in run.stderr

def test_the_memory_of_the_work_folder_s_own_ancestry_is_left_out():
    """Claude Code loads the CLAUDE.md of its process's folder and of each folder above it, so with the process in the
    work folder a checkout of thimble that holds the workspaces would give the orientation thimble's own notes. The
    folders above the corpus folder stay."""
    corpus, work = Path("/home/a/data/tickets"), Path("/home/a/dev/thimble/workspaces/tickets/orient/work")
    out = agent_session.memory_excludes(corpus, work, home=Path("/home/a"))
    assert "/home/a/dev/thimble/CLAUDE.md" in out and "/home/a/dev/thimble/.claude/rules/**" in out
    assert f"{work}/CLAUDE.local.md" in out and "/home/a/dev/CLAUDE.md" in out
    assert not any(p.startswith(("/home/a/CLAUDE", "/home/a/.claude", "/CLAUDE")) for p in out), "shared with the corpus"
    assert not any(p.startswith(str(corpus)) for p in out)
    assert len(out) == 6 * len(agent_session.MEMORY_FILES)  # work, orient, tickets, workspaces, thimble, dev
    # a corpus outside the home folder: the walk still stops below it, whose .claude/CLAUDE.md is the analyst's memory
    elsewhere = agent_session.memory_excludes(Path("/data/tickets"), work, home=Path("/home/a"))
    assert elsewhere == out
    inside = agent_session.memory_excludes(corpus, corpus / "work", home=Path("/home/a"))
    assert inside == [f"{corpus}/work/{name}" for name in agent_session.MEMORY_FILES], "the corpus's own stays"


def test_whether_the_sandbox_runs_is_probed_once_and_an_override_decides(monkeypatch):
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    assert cc_settings.sandbox_ok() is False
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    assert cc_settings.sandbox_ok() is True
    monkeypatch.delenv("THIMBLE_SANDBOX")
    monkeypatch.setattr(cc_settings.sys, "platform", "linux")
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert cc_settings.sandbox_ok(refresh=True) is False and cc_settings.sandbox_missing() == ["bwrap", "socat"]
    ran: list = []
    monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}")

    class Done:
        returncode = 1

    monkeypatch.setattr("subprocess.run", lambda argv, **kw: ran.append(argv) or Done())
    assert cc_settings.sandbox_ok(refresh=True) is False and ran[0][0] == "/usr/bin/bwrap", "bwrap is run, not only found"
    assert cc_settings.sandbox_missing() == ["user namespaces for bwrap"]
    Done.returncode = 0
    assert cc_settings.sandbox_ok(refresh=True) is True
    assert cc_settings.sandbox_ok() is True and len(ran) == 3, "kept once probed"


def test_the_command_resumes_and_carries_the_permission_mode_the_tools_allowed_and_the_tools_taken_away():
    cwd = config.corpus_dir(CORPUS)
    argv = agent_session.command(["--agent", "x"], "sid-1", "high", "{}", cwd, append_shared=False, resume=True,
                                 permission_mode="auto", disallowed=["Tool1", "Tool2"])
    assert argv[argv.index("--resume") + 1] == "sid-1" and "--session-id" not in argv
    assert argv[argv.index("--permission-mode") + 1] == "auto"
    i = argv.index("--disallowedTools")
    later = list(agent_session.LATER_TOOLS)
    assert argv[i + 1:] == ["Tool1", "Tool2", *later], "the last flag: no permission-prompt tool (agent_session, permissions)"
    rules = argv[argv.index("--allowedTools") + 1:i]
    assert rules == agent_session.own_rules(), "thimble's own tools and skills, and no other rule of thimble's"
    plain = agent_session.command(["--agent", "x"], "sid-1", "high", "{}", cwd, append_shared=False)
    assert "--permission-mode" not in plain and "--session-id" in plain
    i = plain.index("--disallowedTools")
    assert plain[i + 1:] == later, \
        "no session gets the tools that schedule a later turn (agent_session's module note, background work)"
    assert "--add-dir" not in plain
    added = agent_session.command(["--agent", "x"], "sid-1", "high", "{}", cwd, append_shared=False, add_dirs=[cwd])
    i = added.index("--add-dir")
    assert added[i + 1] == str(cwd) and added[i + 2] == "--agent", "a flag ends --add-dir's list of folders"


@pytest.mark.parametrize("mode,choice,runs", [
    ("default", "manual", "manual"), ("default", "auto", "auto"), ("default", "bypass", "bypass"), ("default", None, "manual"),
    ("acceptEdits", "auto", "auto"), ("acceptEdits", None, "manual"), ("auto", None, "auto"), ("auto", "manual", "manual"),
    ("bypassPermissions", None, "bypass"), ("bypassPermissions", "manual", "manual"), ("dontAsk", None, "manual"),
    ("plan", None, "manual"), ("plan", "bypass", "bypass"),
])
def test_the_orientation_runs_in_start_s_mode_else_the_one_the_analyst_s_mode_stands_for(tmp_path, mode, choice, runs):
    """The mode switcher is Claude Code's (manual | auto | bypass), and Manual is Claude Code's manual mode, whose
    permission requests thimble relays. The orientation always runs in one of the three, the one its card shows: Start's, else the one the switcher opens
    on for the analyst's own mode (Manual for any mode it does not offer). Auto passes Claude Code's auto mode; Manual
    and Bypass both pass its manual mode, since in Bypass thimble grants each request, which lets the two switch while
    the session runs."""
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": mode}}))
    cwd = config.corpus_dir(CORPUS)
    assert cc_settings.permission_mode(cwd) == mode
    assert cc_settings.orient_mode(cwd, choice) == runs
    assert cc_settings.orient_mode_default(cwd) == {"auto": "auto", "bypassPermissions": "bypass"}.get(mode, "manual")
    assert cc_settings.orient_permission_flag(runs) == ("auto" if runs == "auto" else "default")


def test_the_folder_s_own_settings_outrank_the_user_s_and_the_settings_route_opens_on_the_default(tmp_path):
    cwd = config.corpus_dir(CORPUS)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": "auto"}}))
    assert ledger.get_settings(CORPUS)["orient_permissions"] == "auto"
    ledger.put_settings(CORPUS, {"orient_permissions": "manual"})
    assert ledger.get_settings(CORPUS)["orient_permissions"] == "manual", "a stored choice wins"
    assert orient_session.mode_of(CORPUS, None) == "manual", "and a tool-started orientation takes it"
    assert orient_session.mode_of(CORPUS, "bypass") == "bypass", "Start's choice wins over it"
    assert cc_settings.permission_mode(cwd) == "auto"


def _hook(argv: list[str], event: dict, capsys) -> str:
    import io

    from app import sandbox_allow

    sys_stdin = sys.stdin
    try:
        sys.stdin = io.StringIO(json.dumps(event))
        assert sandbox_allow.main(argv) == 0
    finally:
        sys.stdin = sys_stdin
    return capsys.readouterr().out


def test_the_sandbox_hook_allows_bash_and_leaves_an_excluded_command_and_other_tools_to_the_mode(capsys):
    bash = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": "python3 -c \"rows=[json.loads(l) for l in open('t.jsonl')]\""}}
    out = json.loads(_hook([], bash, capsys))
    assert out["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert out["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    excluded = ["--exclude", "docker"]
    docker = {**bash, "tool_input": {"command": "cd x && /usr/bin/docker run img"}}
    assert _hook(excluded, docker, capsys) == "", "an excluded command runs outside the sandbox: the mode decides"
    assert json.loads(_hook(excluded, bash, capsys))["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert _hook([], {**bash, "tool_name": "Write"}, capsys) == ""
    assert _hook([], {**bash, "hook_event_name": "PostToolUse"}, capsys) == ""
    assert _hook([], {**bash, "tool_input": {}}, capsys) == ""


def test_the_sandbox_hook_answers_a_permission_request_the_pretooluse_allow_could_not_settle(capsys):
    """Claude Code sends a Bash call a safety check asks about (the read block's, while the fence set it) to the full
    permission pipeline despite the PreToolUse allow, and runs PermissionRequest hooks before it would prompt, for a
    subagent too. The hook answers that request by the same rule, and leaves a command the analyst's own Bash ask rule
    names to their mode, since an answer there would override the rule."""
    req = {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "cd runs && wc -l *.jsonl"}}
    out = json.loads(_hook([], req, capsys))
    assert out == {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}
    asks = ["--ask", "git push:*", "--exclude", "docker"]
    assert _hook(asks, {**req, "tool_input": {"command": "cd repo; git push origin main"}}, capsys) == ""
    assert _hook(asks, {**req, "tool_input": {"command": "docker ps"}}, capsys) == ""
    assert json.loads(_hook(asks, req, capsys))["hookSpecificOutput"]["decision"] == {"behavior": "allow"}
    pre = {**req, "hook_event_name": "PreToolUse", "tool_input": {"command": "git push"}}
    assert _hook(asks, pre, capsys) == "", "the rule is the same before the call"
    assert _hook(["--ask", "*"], req, capsys) == "", "a bare Bash ask rule asks about every command"
    assert _hook([], {**req, "tool_name": "Write", "tool_input": {"file_path": "x"}}, capsys) == ""


def test_an_ask_rule_matches_its_words_anywhere_in_the_command():
    from app import sandbox_allow

    assert sandbox_allow.matches_ask("cd x && npm publish --tag next", ["npm publish:*"])
    assert sandbox_allow.matches_ask("git push -f origin", ["git push *"])
    assert sandbox_allow.matches_ask("rm -rf build/tmp", ["rm * build/*"])
    assert not sandbox_allow.matches_ask("git status", ["git push:*", "npm publish"])
    assert sandbox_allow.matches_ask("anything", ["*"]) and not sandbox_allow.matches_ask("ls", [])
    assert sandbox_allow.allows("Bash", {"command": "ls"}) and not sandbox_allow.allows("Bash", {"command": " "})
    assert not sandbox_allow.allows("Bash", {"command": "ls"}, rules=["ls:*"])


def test_the_analyst_s_bash_ask_rules_are_read_from_every_settings_file(tmp_path):
    cwd = config.corpus_dir(CORPUS)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"permissions": {"ask": ["Bash(git push:*)", "Read(./x)", 3]}}))
    local = cwd / ".claude" / "settings.local.json"
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_text(json.dumps({"permissions": {"ask": ["Bash", "Bash(git push:*)", "Bash()"]}}))
    assert cc_settings.bash_ask_rules(cwd) == ["git push:*", "*"]
    local.unlink()
    assert cc_settings.bash_ask_rules(cwd) == ["git push:*"]


def test_the_commands_the_analyst_runs_outside_the_sandbox_are_read_from_every_settings_file(tmp_path):
    cwd = config.corpus_dir(CORPUS)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"sandbox": {"excludedCommands": ["docker *", "git:*"]}}))
    local = cwd / ".claude" / "settings.local.json"
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_text(json.dumps({"sandbox": {"excludedCommands": ["docker compose *", "kubectl"]}}))
    assert cc_settings.sandbox_excluded(cwd) == ["docker", "git", "kubectl"]
    local.unlink()
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"sandbox": {"enabled": True}}))
    assert cc_settings.sandbox_excluded(cwd) == []


def test_the_sandbox_s_root_commands_are_named_for_this_machine_and_never_run(tmp_path, monkeypatch):
    """install.sh and `thimble doctor` print the root commands that would turn the sandbox on (cc_settings.sandbox_setup):
    bubblewrap and socat from the system's package manager, and on Ubuntu 23.10 or later, where user namespaces need an
    AppArmor profile, that profile; nothing when it runs or nobody can run them."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")  # the sandbox does not run
    monkeypatch.setattr(cc_settings.sys, "platform", "linux")
    userns, profiles = tmp_path / "userns", tmp_path / "apparmor.d"
    profiles.mkdir()
    userns.write_text("0\n")
    monkeypatch.setattr(cc_settings, "APPARMOR_USERNS", userns)
    monkeypatch.setattr(cc_settings, "APPARMOR_DIR", profiles)
    tools_here = {"sudo", "apt-get"}
    monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}" if name in tools_here else None)
    monkeypatch.setattr(cc_settings.os, "geteuid", lambda: 1000)
    assert cc_settings.sandbox_setup() == (["sudo apt-get install -y bubblewrap socat"], "set up bubblewrap and socat")
    userns.write_text("1\n")  # Ubuntu 23.10 and later
    cmds, what = cc_settings.sandbox_setup()
    assert cmds[0] == "sudo apt-get install -y bubblewrap socat" and "AppArmor profile" in what
    assert cmds[1].startswith("printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\\n  userns,")
    assert cmds[1].endswith(f"| sudo tee {profiles / 'bwrap'} >/dev/null") and cmds[2] == f"sudo apparmor_parser -r {profiles / 'bwrap'}"
    (profiles / "bwrap").write_text(cc_settings.APPARMOR_PROFILE.format(bwrap="/usr/bin/bwrap"))
    assert cc_settings.sandbox_setup()[0] == ["sudo apt-get install -y bubblewrap socat"], "a profile in place is kept"
    tools_here |= {"bwrap", "socat"}
    (profiles / "bwrap").unlink()
    assert cc_settings.sandbox_setup()[0] == cmds[1:], "installed, and only the profile missing"
    monkeypatch.setattr(cc_settings.os, "geteuid", lambda: 0)
    assert cc_settings.sandbox_setup()[0] == [c.replace("sudo ", "") for c in cmds[1:]], "root runs them without sudo"
    monkeypatch.setattr(cc_settings.os, "geteuid", lambda: 1000)
    tools_here -= {"sudo"}
    assert cc_settings.sandbox_setup() == ([], "setting up an AppArmor profile that lets bwrap create user namespaces "
                                               "needs root: ask an administrator")
    userns.write_text("0\n")
    assert cc_settings.sandbox_setup()[0] == [] and "cannot create a sandbox" in cc_settings.sandbox_setup()[1]
    tools_here = {"sudo", "brew"}
    assert cc_settings.sandbox_setup() == ([], "install bubblewrap and socat with this system's package manager")
    monkeypatch.setattr(cc_settings.sys, "platform", "darwin")
    assert cc_settings.sandbox_setup() == ([], ""), "macOS has sandbox-exec"


def test_the_doctor_and_install_sh_print_the_same_commands_and_install_sh_runs_no_sudo(monkeypatch):
    from app import cli

    monkeypatch.setattr(cc_settings, "sandbox_missing", lambda: ["bwrap", "socat"])
    monkeypatch.setattr(cc_settings, "sandbox_setup", lambda: (["sudo apt-get install -y bubblewrap socat"], "set up bubblewrap and socat"))
    assert cli.sandbox_lines() == ["  bash sandbox: off, missing bwrap, socat; the orientation's Bash asks under your permission "
                                   "mode. To turn it on, run these, which set up bubblewrap and socat, then `thimble restart`:",
                                   "    sudo apt-get install -y bubblewrap socat"]
    monkeypatch.setattr(cc_settings, "sandbox_missing", lambda: [])
    [runs] = cli.sandbox_lines()
    assert runs.startswith("  bash sandbox: runs") and ".claude/.cc-writes/" in runs, "it names the folder Claude Code adds"
    script = (config.REPO_ROOT / "scripts" / "install.sh").read_text("utf-8")
    assert "cli.sandbox_lines()" in script and "check_sandbox\n  build_ui" in script
    code = [ln.split("#", 1)[0] for ln in script.splitlines()]
    assert not [ln for ln in code if "sudo" in ln and "say " not in ln], "install.sh prints root commands, never runs one"
