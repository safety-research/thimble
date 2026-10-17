"""thimble's agents as subagents of main (app/subagents.py): the roles the module registers, a click's start, follow-up
and stop through the module (a fake of lane M's bridge), a typed start's exact call, the answers a start can get, the
runs and their one end, main's quit and moves, the caller of a thimble tool, and the clicks that take the analyst's
cookie."""
from __future__ import annotations

import asyncio
import sys
import time

import pytest
from fastapi.testclient import TestClient

from app import agents, config, kernel_wrap, subagents
from app import subagent_files as sf
from subagent_fakes import HINTS, bridge, hints  # noqa: F401 — fixtures

CORPUS = "mini"


@pytest.fixture()
def models(monkeypatch):
    """Settings' rows as lane A resolves them: a full model id and an explicit effort for every role."""
    rows = {"orient": {"model": "claude-opus-5-5[1m]", "effort": "max", "fast": False},
            "subagents": {"model": "claude-sonnet-5", "effort": "medium", "fast": False},
            "critic": {"model": "claude-opus-5-5", "effort": "xhigh", "fast": False},
            "writer": {"model": "claude-opus-5-5", "effort": "high", "fast": False},
            "checks": {"model": "claude-sonnet-5", "effort": "medium", "fast": False},
            "dev": {"model": "claude-opus-5-5", "effort": "high", "fast": False},
            "labels": {"model": "claude-opus-5-5", "effort": "low", "fast": False},
            "verify": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    monkeypatch.setattr(config, "models_for", lambda c=None: {k: dict(v) for k, v in rows.items()})
    return rows


# --------------------------------------------------------------------------- the roles


def test_each_role_is_registered_with_a_full_model_id_an_explicit_effort_and_a_fixed_description(models, hints):
    roles = subagents.roles(CORPUS)
    assert {"orientation", "critic", "writer", "orient-helper"} <= set(roles)
    for name, d in roles.items():
        if name not in subagents.TYPES:
            continue
        assert d["type"] == f"thimble:{name}" and d["background"] is True
        assert d["model"].startswith("claude-") and d["effort"] in ("low", "medium", "high", "xhigh", "max")
        assert d["prompt"].strip() and isinstance(d.get("description"), str)
        assert "hooks" not in d
    assert roles["orientation"]["model"] == "claude-opus-5-5[1m]" and roles["orientation"]["effort"] == "max"
    assert roles["orient-helper"]["model"] == "claude-sonnet-5" and roles["orient-helper"]["effort"] == "medium", \
        "the helper runs on Settings' orientation-subagents row (Q10)"
    from app import prompts  # noqa: PLC0415

    front, body = prompts.frontmatter("orient-helper")
    assert roles["orient-helper"]["description"] == front["description"].strip() and roles["orient-helper"]["prompt"] == body.strip(), \
        "the helper's fixed description and prompt are prompts/orient-helper.md's"
    # 0.9.0 has no shared skill (SPEC-v2 3.1): the writer's and the critic's prompts end with the shared guidance
    assert "skills" not in roles["writer"] and "skills" not in roles["critic"]
    assert "## Communicating" in roles["writer"]["prompt"] and "## Communicating" in roles["critic"]["prompt"]
    # the preamble once: their own body opens with it, and the shared guidance after it does not repeat it
    from app import events  # noqa: PLC0415

    preamble = events.render_prompts(("preamble",), str(config.corpus_dir(CORPUS))).strip().splitlines()[0]
    for role in ("writer", "critic"):
        assert roles[role]["prompt"].count(preamble) == 1, f"the {role}'s prompt holds the preamble once"


# --------------------------------------------------------------------------- the files the hooks trust


def test_a_new_workspace_has_the_trusted_files_and_the_kernel_binds_their_folder_read_only(tmp_path):
    """The kernel binds the trusted folder, not each file: the writers replace a file whole, and Linux takes the bind
    off a file another namespace renames a new file over (test_kernel_sandbox has the kernel's own test)."""
    ws = config.workspace_dir(CORPUS)
    trusted = ws / kernel_wrap.TRUSTED_DIR
    assert trusted == sf.trusted_dir(ws) and kernel_wrap.TRUSTED_DIR in kernel_wrap.READ_ONLY_DIRS
    for name in sf.FILES:
        assert (trusted / name).is_file(), name
    argv = kernel_wrap.kernel_wrap_argv(["python"], corpus_dir=tmp_path / "c", workspace_dir=ws, connection_dir=tmp_path,
                                        venv=None, python="/usr/bin/python3")
    i = argv.index(str(trusted))
    assert argv[i - 1] == "--ro-bind" and argv[i + 1] == str(trusted)
    assert not any(str(trusted / name) in argv for name in sf.FILES), "no bind of a file the writers replace"
    rules = kernel_wrap.srt_rules(corpus_dir=tmp_path / "c", workspace_dir=ws, venv=None, python="/usr/bin/python3",
                                  srt_dir=tmp_path, home=tmp_path / "h", platform="linux")
    assert str(trusted) in rules["filesystem"]["denyWrite"]


def test_the_kernel_can_neither_hold_nor_swap_the_lock_of_subagents_json(tmp_path):
    """A read-only lock can still be opened and flocked, which would make every writer wait for it and then write
    without it, so the kernel sees an empty file in its place (bwrap) or none (srt)."""
    ws = config.workspace_dir(CORPUS)
    assert kernel_wrap.LOCK_FILES == (sf.LOCK,) and (ws / sf.LOCK).is_file()
    argv = kernel_wrap.kernel_wrap_argv(["python"], corpus_dir=tmp_path / "c", workspace_dir=ws, connection_dir=tmp_path,
                                        venv=None, python="/usr/bin/python3")
    i = argv.index(str(ws / sf.LOCK))
    assert argv[i - 2:i] == ["--ro-bind", kernel_wrap.EMPTY_FILE]
    rules = kernel_wrap.srt_rules(corpus_dir=tmp_path / "c", workspace_dir=ws, venv=None, python="/usr/bin/python3",
                                  srt_dir=tmp_path, home=tmp_path / "h", platform="linux")["filesystem"]
    assert str(ws / sf.LOCK) in rules["denyRead"] and str(ws / sf.LOCK) in rules["denyWrite"]


# --------------------------------------------------------------------------- starts


async def test_a_click_start_writes_the_request_then_spawns_through_the_module(bridge, models):
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "write it", {"model": "m", "effort": "high"},
                                    subagents.CLICK, description="writer: report", chat={"title": "Write report",
                                                                                         "doc": "report"})
    assert ans.started and ans.kind is None
    [spawn] = bridge.ops("spawn")
    assert spawn["role"] == "writer" and spawn["values"] == {"model": "m", "effort": "high"}
    assert spawn["prompt"] == "write it" and spawn["description"] == "writer: report" and spawn["what"] == "report"
    assert "model" not in spawn or spawn.get("model") is None
    r = subagents.request(CORPUS, ans["request"])
    assert r["state"] == "started" and r["agent"] == ans.agent_id and r["route"] == "click"
    a = subagents.agent(CORPUS, ans.agent_id)
    assert a["key"] == "writer:report" and a["plugin_started"] is True and a["chat"]
    meta = agents.read_meta(CORPUS, a["chat"])
    assert meta["route"] == "subagent" and meta["agent_id"] == ans.agent_id and meta["doc"] == "report"
    assert meta["values"] == {"model": "m", "effort": "high"} and meta["started_by"] == "click"


async def test_a_follow_on_start_waits_for_the_module_of_a_session_attached_just_now(bridge, models, monkeypatch):
    """At a press the server reads main's turn as it attaches the session, a moment before Claude Code's module, which
    switches to the server at the same press, says hello: a check that the turn's end starts waits for the module
    (module_settled) instead of being refused as still connecting. A click is answered at once, and a module that does
    not come is refused once the wait runs out."""
    not_loaded = "Claude Code did not load thimble's module"
    monkeypatch.setattr(sys.modules["app.module_bridge"], "NOT_LOADED", not_loaded, raising=False)
    monkeypatch.setattr(subagents, "connecting", lambda c: True)
    monkeypatch.setattr(subagents, "CONNECT_STEP_S", 0.01)
    bridge.is_live, bridge.reason = False, not_loaded

    async def hello() -> None:
        await asyncio.sleep(0.1)
        bridge.is_live, bridge.reason = True, ""

    said = asyncio.create_task(hello())
    ans = await subagents.start_job(CORPUS, "check", "check:c1:answers", "check it", {}, subagents.FOLLOW_ON,
                                    description="check: c1")
    await said
    assert ans.started and len(bridge.ops("spawn")) == 1
    bridge.is_live, bridge.reason = False, not_loaded
    t0 = time.monotonic()
    click = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert click.kind == "no-module" and time.monotonic() - t0 < 0.5, "a click waits for nothing"
    monkeypatch.setattr(subagents, "CONNECT_WAIT_S", 0.1)
    late = await subagents.start_job(CORPUS, "check", "check:c2:answers", "check it", {}, subagents.FOLLOW_ON)
    assert late.kind == "no-module" and len(bridge.ops("spawn")) == 1


async def test_a_typed_start_answers_the_exact_agent_call_with_the_request_id_on_its_first_line(bridge, models):
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "Write the report.", {"model": "m", "effort": "e"},
                                    subagents.TYPED, description="writer: report", call="toolu_tool")
    assert ans.typed and not bridge.calls
    inp = ans["input"]
    assert set(inp) == {"subagent_type", "description", "prompt"}, "no run_in_background (F1), no model"
    assert inp["subagent_type"] == "thimble:writer" and inp["prompt"].split("\n")[0] == f"[thimble request {ans['request']}]"
    r = subagents.request(CORPUS, ans["request"])
    assert r["values"] == {"model": "m", "effort": "e"} and r["call"] == "toolu_tool" and r["state"] == "pending"


# --------------------------------------------------------------------------- follow-ups and stops


async def test_a_stop_goes_through_the_module_and_one_of_an_ended_agent_counts_as_done(bridge, models):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert not (await subagents.stop(CORPUS, started.agent_id)).refused
    bridge.answers.append({"error": "Task a1 is not running"})
    done = await subagents.stop(CORPUS, started.agent_id)
    assert not done.refused and done.get("done")
    bridge.answers.append({"error": "the agent had ended", "gone": True})
    assert (await subagents.stop(CORPUS, started.agent_id)).get("done"), "module_bridge's `gone`"
    bridge.is_live = False
    assert (await subagents.stop(CORPUS, started.agent_id)).kind == "no-module"


# --------------------------------------------------------------------------- the caller of a thimble tool


async def test_a_call_runs_as_its_agent_s_key_and_a_descendant_s_as_its_ancestor_s(bridge, models):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    ws = config.workspace_dir(CORPUS)
    with subagents.update(CORPUS) as state:
        sf.registry(state)["helper1"] = {"type": "thimble:orient-helper", "role": "orient-helper", "parent": started.agent_id,
                                         "root": started.agent_id, "status": "running", "descendant": True}
    sf.add_caller(ws, "toolu_w", started.agent_id, "thimble:writer")
    sf.add_caller(ws, "toolu_h", "helper1", "thimble:orient-helper")
    who = await subagents.caller(CORPUS, "toolu_w")
    assert who.key == "writer:report" and who.role == "writer"
    helper = await subagents.caller(CORPUS, "toolu_h")
    assert helper.key == "writer:report" and helper.agent_id == "helper1"
    assert subagents.allowed(who, "write_document") and not subagents.allowed(who, "apply_label")


async def test_the_critic_may_not_add_a_card_and_main_may_not_critique(bridge, models, monkeypatch):
    from app import tools

    ws = config.workspace_dir(CORPUS)
    with subagents.update(CORPUS) as state:
        sf.registry(state)["crit1"] = {"key": "critique:orient", "role": "critic", "status": "running"}
    sf.add_caller(ws, "toolu_c", "crit1", "thimble:critic")
    refused, session = await tools._as_caller(CORPUS, "add_card", "toolu_c")
    assert refused and session is None
    refused, session = await tools._as_caller(CORPUS, "read_ref", "toolu_c")
    assert not refused and session == "critique:orient"
    monkeypatch.setattr(subagents, "CALLER_WAIT_S", 0.05)
    refused, _ = await tools._as_caller(CORPUS, "critique", "toolu_main")
    assert refused, "main's own call of the orientation's tool"


def test_bug_hunt_i12_install_s_allow_line_names_each_agent_s_own_server():
    """In Manual mode Claude Code offers no "don't ask again" for the tools of an agent's own server, so a settings rule
    is the analyst's only way to stop those asks: INSTALL's allow line names each such server (the card check's
    `mcp__thimble-call` was missing), and no other."""
    import re

    from app import tools

    text = (config.REPO_ROOT / "INSTALL.md").read_text()
    allow = re.search(r'"allow": \[(.*?)\]', text, re.S).group(1)
    named = set(re.findall(r'"mcp__(thimble-[a-z-]+)"', allow))
    servers = {f"thimble-{t.role}" for t in subagents.TYPES.values() if t.kind and tools.private_names(t.kind)}
    assert named == servers


def test_the_shim_of_main_lists_every_tool_but_the_agents_private_ones_which_their_own_shims_list(models):
    from app import tools

    names = [t["name"] for t in tools.list()]
    assert "message_orientation" in names and "add_comment" in names and "load_thimble" not in names
    private = ["critique", "view_check", "finish_view", "view_reference", "view_pictures", "finish_review", "ticket_checks",
               "finish_ticket", "read_call", "send_answer"]
    assert not set(private) & set(names), "main never lists a tool only thimble's agents call"
    assert [s.name for s in tools.REGISTRY.values() if tools.private(s)] == private
    assert [t["name"] for t in tools.private_list(tools.ORIENT_SESSION)] == ["critique"]
    assert tools.private_names(tools.VIEW_SESSION) == ["view_check", "finish_view", "view_reference"]
    assert tools.private_names(tools.REVIEW_SESSION) == ["view_check", "view_pictures", "finish_review"]
    assert tools.private_names(tools.TICKET_SESSION) == ["ticket_checks", "finish_ticket"]
    assert tools.private_names(tools.CRITIQUE_SESSION) == [] and tools.private_names(None) == []
    # a session thimble starts lists its kind's tools as before, the private ones among them
    assert "critique" in [t["name"] for t in tools.list(session="orient")]
    # each type with private tools declares its own shim, which Claude Code starts with the agent
    for role, kind in (("orientation", "orient"), ("view-builder", "view"), ("view-reviewer", "review"),
                       ("dev-ticket", "ticket"), ("call", "call")):
        got = subagents.private_server(CORPUS, subagents.TYPES[role])
        assert list(got) == [f"thimble-{role}"]
        server = got[f"thimble-{role}"]
        assert server["command"].endswith("plugin/bin/thimble-mcp") and server["args"] == ["--private", kind]
        assert server["alwaysLoad"] is True and server["env"]["THIMBLE_CWD"]
    for role in ("critic", "writer", "check", subagents.HELPER):
        assert subagents.private_server(CORPUS, subagents.TYPES[role]) is None
    specs = subagents.roles(CORPUS)
    assert [s for s in specs if specs[s].get("mcpServers")] == ["orientation", "view-builder", "view-reviewer"] + (
        ["dev-ticket"] if "dev-ticket" in specs else []) + ["call"]
    # a type whose thimble tools are limited takes away the others' private tools, which a parent's shim brings
    assert "mcp__thimble-orientation__critique" in specs["critic"]["disallowedTools"]
    assert "mcp__thimble-orientation__critique" not in specs["orientation"]["disallowedTools"]
    assert "mcp__thimble-view-builder__finish_view" in specs["orientation"]["disallowedTools"]
    assert not specs[subagents.HELPER].get("disallowedTools"), "the orientation's helpers keep every tool"


# --------------------------------------------------------------------------- the clicks are the analyst's


CLICKS = [("post", "/api/ws/mini/start", {"text": ""}),
          ("post", "/api/ws/mini/write", {"doc": "report"}),
          ("post", "/api/ws/mini/orientation/message", {"text": "hi"}),
          ("post", "/api/ws/mini/subagents/start-it", {"request": "req_0000000000"}),
          ("post", "/api/ws/mini/subagents/again", {"request": "req_0000000000"}),
          ("post", "/api/ws/mini/chats/main/interrupt", {})]


@pytest.mark.real_write_guard
def test_every_click_route_refuses_the_server_s_token_without_the_analyst_s_cookie(bridge, plugin_headers,
                                                                                    monkeypatch):
    from app import hook_auth, main

    client = TestClient(main.create_app())
    for method, path, body in CLICKS:
        r = getattr(client, method)(path, json=body, headers=plugin_headers())
        assert r.status_code == 403 and r.json()["detail"] == hook_auth.WRITE_REFUSED, (path, r.status_code, r.text)
        r = getattr(client, method)(path, json=body)
        assert r.status_code == 403, ("neither cookie nor token, as a kernel cell posts it", path)
    # behind the write guard each route refuses the token itself too, naming the clicks it guards, not only permission
    # answers (live check L32)
    monkeypatch.setattr(hook_auth, "write_guarded", lambda method, path: False)
    for method, path, body in CLICKS:
        r = getattr(client, method)(path, json=body, headers=plugin_headers())
        assert r.status_code == 403, (path, r.status_code, r.text)
        assert "start, message or stop thimble's agents" in r.json()["detail"], path
    meta = agents.new_agent(CORPUS, "writer", "Write report", route="subagent", agent_id="a1", status="running")
    r = client.post(f"/api/ws/mini/chats/{meta['id']}/interrupt", headers=plugin_headers())
    assert r.status_code == 403
    r = client.delete(f"/api/ws/mini/chats/{meta['id']}", headers=plugin_headers())
    assert r.status_code == 403, "deleting a running agent's chat stops it through the module"
    assert agents.meta_or_none(CORPUS, meta["id"]) is not None
    r = client.post("/api/ws/mini/extensions/any/orientation", json={"run": True}, headers=plugin_headers())
    assert r.status_code == 403, "Run now sends the extension's instructions to the orientation through the module"
    assert not bridge.calls, "the module is never asked"


def test_the_click_routes_are_the_ones_the_module_is_reached_by():
    """Every route of subagents that reaches the module takes the analyst's cookie (subagents.analyst_only)."""
    import inspect

    for fn in subagents.CLICK_ROUTES:
        assert "analyst_only(" in inspect.getsource(fn), fn.__name__
