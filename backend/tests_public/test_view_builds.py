"""A view ticket's build session (app/dev.py) may read the corpus but not change it."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from app import agents, config, dev, ledger, modes, orientation, userconf, views

CORPUS = "boards"


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first post", "second post")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return corpus


def test_a_view_build_s_session_may_read_the_corpus_but_not_change_it(board, monkeypatch):
    """The session runs in the corpus folder with Edit and Bash allowed, so its flags deny edits in the corpus and in
    the worked examples, and put Bash in the sandbox with no network where it can run, beside the dev role's fast
    mode, with its check command the one command run outside the sandbox; the prompt names that same command. A code
    ticket's session, in its own worktree, gets none of it."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setattr(config, "models_for", lambda c=None: {"dev": {"model": "claude-opus-4-8", "fast": True}})
    corpus = config.corpus_dir(CORPUS)
    folder = views.views_dir(CORPUS) / "posts"
    conf = dev.dev_config(CORPUS, sandbox=True)
    flags = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), dev.view_fence(CORPUS, "posts", corpus, folder, conf))
    settings = json.loads(flags[flags.index("--settings") + 1])
    assert settings["permissions"]["deny"][:2] == [f"Edit(/{corpus}/**)", f"Edit(/{views.EXAMPLES_DIR}/**)"]
    box = settings["sandbox"]
    assert box["network"] == {"deniedDomains": ["*"]} and not box["allowUnsandboxedCommands"]
    check = dev.view_check_command(CORPUS, "posts")
    assert box["excludedCommands"] == [check, f"{check} *"] and check.endswith(f"/api/ws/{CORPUS}/views/posts/check")
    assert settings["fastMode"] is True and "Read" in flags[flags.index("--allowedTools") + 1].split(",")
    prompt = dev.build_view_prompt(CORPUS, {"slug": "posts", "name": "Posts", "claims": ["board.jsonl"]}, folder, corpus)
    assert f"`{check} '<ref>'`" in prompt and "curl" not in prompt
    code = json.loads((c := dev.Sessions()._flags(CORPUS, "thimble ticket 1: x"))[c.index("--settings") + 1])
    assert "sandbox" not in code and not any(r.startswith(f"Edit(/{corpus}") for r in code["permissions"]["deny"]), \
        "a code ticket is not fenced"
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    assert "sandbox" not in dev.read_only_fence([corpus]), "no sandbox where it cannot run; the deny stays"
    inside = corpus / ".thimble" / "views" / "posts"
    assert dev.view_read_only(corpus, inside) == (views.EXAMPLES_DIR,), "a corpus that holds the view's folder is left out"


@pytest.mark.parametrize("sandbox", ["1", "0"])
def test_a_view_build_stays_off_the_network_in_every_mode(board, monkeypatch, tmp_path, sandbox):
    """With the dev agent's network off, as by default, a view build's session has no web tools, and deny rules, which
    hold in every permission mode, refuse the commands that reach the network or install software: by name, at a path,
    as a module and in a nested shell. Its Bash commands find the package managers offline and every connection refused
    but loopback's. Where the sandbox cannot run, every Bash command but its check goes to the analyst, in Bypass too.
    A code ticket's session, which never runs in the sandbox, asks for every Bash command."""
    monkeypatch.setenv("THIMBLE_SANDBOX", sandbox)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    corpus, folder = config.corpus_dir(CORPUS), views.views_dir(CORPUS) / "posts"
    conf = dev.dev_config(CORPUS, sandbox=True)
    fence, asking = dev.view_fence(CORPUS, "posts", corpus, folder, conf), dev.view_asking(CORPUS, "posts", folder, conf)
    refused = {"WebFetch", "WebSearch", "Bash(playwright:*)", "Bash(*/playwright *)", "Bash(* -m playwright *)",
               "Bash(curl:*)", "Bash(npx:*)", "Bash(* -m pip *)", "Bash(git clone:*)", "Bash(bash -c:*)"}
    for mode in modes.MODES:
        ledger.put_settings(CORPUS, {modes.SETTING: {"dev": mode}})
        flags = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), fence, asking)
        settings = json.loads(flags[flags.index("--settings") + 1])
        perms, env = settings["permissions"], settings["env"]
        assert refused <= set(perms["deny"]), mode
        assert ("Bash" in perms["ask"]) == (sandbox == "0"), mode
        assert {"WebFetch", "WebSearch"} <= set(flags[flags.index("--disallowedTools") + 1].split(","))
    check = dev.view_check_command(CORPUS, "posts")
    assert conf.verdict("Bash", {"command": f"{check} 'posts'"}) == ("own" if sandbox == "0" else "")
    assert conf.verdict("Bash", {"command": f"{check} x; python3 -c 'import urllib'"}) == ("ask" if sandbox == "0" else "")
    code = dev.Sessions()._flags(CORPUS, "thimble ticket 1: x", asking={"key": "ticket:1"})
    perms = json.loads(code[code.index("--settings") + 1])["permissions"]
    assert "WebFetch" in code[code.index("--disallowedTools") + 1] and "Bash" in perms["ask"]

    assert env[dev.SESSION_ENV] == "view:posts" and env["UV_OFFLINE"] == env["PIP_NO_INDEX"] == "1"
    shown = subprocess.run(["sh", "-c", f'. "{env[dev.ENV_FILE]}"; echo "$HTTPS_PROXY $no_proxy"'],
                           env={"PATH": os.environ["PATH"]}, capture_output=True, text=True, check=True).stdout.split()
    assert shown == ["http://127.0.0.1:9", "127.0.0.1,localhost,::1"]


def test_the_dev_agent_s_network_and_web_on_lift_the_fence(board, monkeypatch, tmp_path):
    """With `network` and `web` set for the dev agent in thimble's config, a view build keeps its read-only folders
    but gets the network in the sandbox, no offline rules or environment, and the web tools, which ask."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps({"agents": {"dev": {"network": "on", "web": "ask"}}}))
    corpus, folder = config.corpus_dir(CORPUS), views.views_dir(CORPUS) / "posts"
    conf = dev.dev_config(CORPUS, sandbox=True)
    flags = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), dev.view_fence(CORPUS, "posts", corpus, folder, conf),
                                  dev.view_asking(CORPUS, "posts", folder, conf))
    settings = json.loads(flags[flags.index("--settings") + 1])
    assert "network" not in settings["sandbox"] and "Bash(bash -c:*)" not in settings["permissions"]["deny"]
    assert "UV_OFFLINE" not in settings["env"] and f"Edit(/{corpus}/**)" in settings["permissions"]["deny"]
    assert "WebFetch" not in flags[flags.index("--disallowedTools") + 1] and "WebFetch" in settings["permissions"]["ask"]


def test_a_view_build_runs_on_the_model_of_the_session_that_asked(board, monkeypatch, tmp_path):
    """An orientation's proposal is built on the orientation's model, without the 1M tag, at the effort and speed it runs
    at; one the analyst asked for on main's model, effort and speed as its replies report them, and before main's first
    reply on the analyst's own Claude Code settings. What the analyst chose for the dev agent in Settings wins, field by
    field."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    monkeypatch.setattr(orientation, "read_run", lambda c: {"ultracode": True})
    folder = views.views_dir(CORPUS) / "posts"

    def flags(prop: dict) -> dict:
        got = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), None, None, dev.view_models(CORPUS, prop))
        return {"model": got[got.index("--model") + 1] if "--model" in got else None,
                "effort": got[got.index("--effort") + 1] if "--effort" in got else None,
                "fast": json.loads(got[got.index("--settings") + 1]).get("fastMode")}

    ledger.put_settings(CORPUS, {config.MODELS_KEY: {"orient": {"model": "claude-sonnet-5", "fast": False}}})
    assert flags({"orientation": True}) == {"model": "claude-sonnet-5", "effort": "xhigh", "fast": False}
    assert flags({"asked": True}) == {"model": None, "effort": "high", "fast": None}, "before main's first reply"
    agents.write_meta(CORPUS, {**agents.ensure_main(CORPUS), "attached": {"session": "s", "model": "claude-opus-4-8",
                                                                          "effort": "medium", "fast": False}})
    assert flags({"asked": True}) == {"model": "claude-opus-4-8", "effort": "medium", "fast": False}
    ledger.put_settings(CORPUS, {config.MODELS_KEY: {"dev": {"model": "claude-opus-5-5", "fast": True}}})
    assert flags({"asked": True}) == {"model": "claude-opus-5-5", "effort": "medium", "fast": True}
    assert flags({"orientation": True}) == {"model": "claude-opus-5-5", "effort": "xhigh", "fast": True}
