"""thimble's agents as subagents of main (app/subagents.py): the roles the module registers, a click's start, follow-up
and stop through the module (a fake of lane M's bridge), a typed start's exact call, the answers a start can get, the
runs and their one end, main's quit and moves, the caller of a thimble tool, and the clicks that take the analyst's
cookie."""
from __future__ import annotations

import asyncio
import json
import sys

import pytest
from fastapi.testclient import TestClient

import app
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
    assert {"orientation", "critic", "writer", "helper"} <= set(roles)
    for name, d in roles.items():
        if name not in subagents.TYPES:
            continue
        assert d["type"] == f"thimble:{name}" and d["background"] is True
        assert d["model"].startswith("claude-") and d["effort"] in ("low", "medium", "high", "xhigh", "max")
        assert d["prompt"].strip() and isinstance(d.get("description"), str)
        assert "hooks" not in d
    assert roles["orientation"]["model"] == "claude-opus-5-5[1m]" and roles["orientation"]["effort"] == "max"
    assert roles["helper"]["model"] == "claude-sonnet-5" and roles["helper"]["effort"] == "medium", \
        "the helper runs on Settings' orientation-subagents row (Q10)"
    from app import prompts  # noqa: PLC0415

    front, body = prompts.frontmatter("helper")
    assert roles["helper"]["description"] == front["description"].strip() and roles["helper"]["prompt"] == body.strip(), \
        "the helper's fixed description and prompt are prompts/helper.md's"
    assert roles["writer"]["skills"][0] == roles["critic"]["skills"][0] == "thimble:shared"


def test_the_orientation_s_registration_holds_every_part_and_takes_main_s_tools_away(models, hints):
    d = subagents.roles(CORPUS)["orientation"]
    denied = set(d["disallowedTools"])
    assert "mcp__plugin_thimble_thimble__start_orientation" in denied
    assert "mcp__plugin_thimble_thimble__message_orientation" in denied
    assert "mcp__plugin_thimble_thimble__add_card" not in denied and "mcp__plugin_thimble_thimble__critique" not in denied
    from app import tools  # noqa: PLC0415

    assert tools.hint("orient-no-request") not in d["prompt"], "a run's request is in its own prompt"
    for heading in ("The deck", "Views", "The report"):
        assert heading in d["prompt"], heading
    critic = set(subagents.roles(CORPUS)["critic"]["disallowedTools"])
    assert "mcp__plugin_thimble_thimble__add_card" in critic and "mcp__plugin_thimble_thimble__read_ref" not in critic


def test_web_off_takes_the_web_tools_and_memory_off_omits_claude_md(models, hints, monkeypatch):
    real = subagents._agent_conf
    monkeypatch.setattr(subagents, "_agent_conf",
                        lambda c, agent: {**real(c, agent), "web": "off", "memory": "off"} if agent == "writer"
                        else real(c, agent))
    roles = subagents.roles(CORPUS)
    assert {"WebFetch", "WebSearch"} <= set(roles["writer"]["disallowedTools"])
    assert roles["writer"]["omitClaudeMd"] is True
    assert "WebFetch" not in roles["critic"]["disallowedTools"]


def test_values_for_takes_the_run_s_arguments_over_settings(models):
    assert subagents.values_for(CORPUS, "orientation") == {"model": "claude-opus-5-5[1m]", "effort": "max"}
    assert subagents.values_for(CORPUS, "orientation", {"model": "sonnet", "effort": "high"}) == \
        {"model": "claude-sonnet-5[1m]", "effort": "high"}
    assert subagents.values_for(CORPUS, "writer", {"effort": "ultracode"})["effort"] == "xhigh"
    assert subagents.values_for(CORPUS, "writer", {"model": "haiku"}) == {"model": "claude-haiku-4-5-20251001",
                                                                           "effort": ""}, "Haiku runs at no effort"
    settings = subagents.values_for(CORPUS, "writer")["effort"]
    assert subagents.values_for(CORPUS, "writer", {"effort": "turbo"})["effort"] == settings, "not a level: Settings'"
    assert subagents.values_for(CORPUS, "writer", {"effort": "MAX"})["effort"] == "max"


def test_the_work_folders_main_s_bash_may_write():
    ws = config.workspace_path(CORPUS)
    assert subagents.write_dirs(CORPUS) == [ws / "orient/work", ws / "writers", ws / "critique-work",
                                             ws / "check-work", ws / "views-work", ws / "extension/views"]


# --------------------------------------------------------------------------- the files the hooks trust


def test_a_new_workspace_has_the_trusted_files_and_the_kernel_binds_them_read_only(tmp_path):
    ws = config.workspace_dir(CORPUS)
    for name in kernel_wrap.TRUSTED_FILES:
        assert (ws / name).is_file(), name
    argv = kernel_wrap.kernel_wrap_argv(["python"], corpus_dir=tmp_path / "c", workspace_dir=ws, connection_dir=tmp_path,
                                        venv=None, python="/usr/bin/python3")
    for name in kernel_wrap.TRUSTED_FILES:
        i = argv.index(str(ws / name))
        assert argv[i - 1] == "--ro-bind" and argv[i + 1] == str(ws / name), name
    rules = kernel_wrap.srt_rules(corpus_dir=tmp_path / "c", workspace_dir=ws, venv=None, python="/usr/bin/python3",
                                  srt_dir=tmp_path, home=tmp_path / "h", platform="linux")
    for name in kernel_wrap.TRUSTED_FILES:
        assert str(ws / name) in rules["filesystem"]["denyWrite"], name


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


@pytest.mark.parametrize("answer,kind", [
    ({"deny": "PreToolUse:Agent hook error: An orientation is already running."}, "hook"),
    ({"limit": "Claude Code runs at most 20 concurrent subagents"}, "limit"),
    ({"error": "Cannot spawn: 20 concurrent subagents are running; the limit is 20"}, "limit"),
    # $.agent.spawn's own text at CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS of the plugin's spawns (2.1.291, live check L19)
    ({"error": "HooksError: thimble: $.agent.spawn refused: 2 spawns are running at once"}, "limit"),
    ({"error": "something else"}, "error"),
    ("no-module", "no-module"),
])
async def test_each_answer_of_the_module_ends_the_request_with_its_kind(bridge, models, answer, kind):
    bridge.answers.append(answer)
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert ans.kind == kind
    r = subagents.request(CORPUS, ans["request"])
    assert r["refused_kind"] == kind and r["state"] == ("expired" if kind == "no-module" else "refused")


@pytest.mark.parametrize("route", [subagents.CLICK, subagents.TYPED])
async def test_a_start_makes_its_agent_s_work_folder_which_main_s_sandbox_cannot(bridge, models, route, tmp_path):
    """Main's sandbox lets Bash write in a work folder but not in the workspace around it, so the agent could not make
    a missing folder itself (live check L16: orient/work was missing). Start it makes it again; a folder outside the
    workspace is not made."""
    ws = config.workspace_dir(CORPUS)
    work = ws / "writers" / "report"
    assert not work.exists()
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, route, work=work)
    assert work.is_dir() and not ans.refused
    work.rmdir()
    if route == subagents.TYPED:
        subagents.refuse(CORPUS, ans["request"], "[Credential Exploration]", subagents.AUTO_MODE)
        assert (await subagents.start_it(CORPUS, ans["request"])).started and work.is_dir()
    outside = tmp_path / "elsewhere"
    await subagents.start_job(CORPUS, "writer", "writer:other", "w", {}, route, work=outside)
    assert not outside.exists()


async def test_without_a_live_module_a_start_is_refused_before_any_request(bridge, models):
    bridge.is_live, bridge.reason = False, "THIMBLE_NO_MODULE is set"
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert ans.kind == "no-module" and "THIMBLE_NO_MODULE is set" in ans.reason
    assert not bridge.calls and not sf.requests(subagents.read(CORPUS))


async def test_in_a_plain_claude_or_in_plan_mode_nothing_starts(bridge, models, monkeypatch):
    from app import cc_plugin, session

    monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: False, raising=False)
    assert (await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)).kind == \
        "not-launched"
    monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: True, raising=False)
    monkeypatch.setattr(session, "main_mode", lambda c: "plan")
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.TYPED)
    assert ans.kind == "hook" and ans.reason == HINTS["start-plan-mode"]
    assert not bridge.calls


async def test_a_typed_start_answers_the_exact_agent_call_with_the_request_id_on_its_first_line(bridge, models):
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "Write the report.", {"model": "m", "effort": "e"},
                                    subagents.TYPED, description="writer: report", call="toolu_tool")
    assert ans.typed and not bridge.calls
    inp = ans["input"]
    assert set(inp) == {"subagent_type", "description", "prompt"}, "no run_in_background (F1), no model"
    assert inp["subagent_type"] == "thimble:writer" and inp["prompt"].split("\n")[0] == f"[thimble request {ans['request']}]"
    r = subagents.request(CORPUS, ans["request"])
    assert r["values"] == {"model": "m", "effort": "e"} and r["call"] == "toolu_tool" and r["state"] == "pending"


async def test_start_it_starts_a_refused_typed_start_as_a_click_with_the_same_call(bridge, models):
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {"model": "m", "effort": "e"},
                                    subagents.TYPED)
    subagents.refuse(CORPUS, ans["request"], "[Credential Exploration]", subagents.AUTO_MODE)
    again = await subagents.start_it(CORPUS, ans["request"])
    assert again.started
    [spawn] = bridge.ops("spawn")
    assert spawn["prompt"] == ans["input"]["prompt"] and spawn["values"] == {"model": "m", "effort": "e"}
    assert subagents.request(CORPUS, ans["request"])["route"] == "click"


async def test_start_it_never_starts_an_agent_s_own_start_as_main_s_subagent(bridge, models):
    """The critic's start is the orientation's own Agent call; through the module it would be main's subagent, whose
    report never reaches the orientation."""
    ans = await subagents.start_job(CORPUS, "critic", "critique:orient", "c", {"model": "m", "effort": "e"},
                                    subagents.TYPED, caller_role="orientation")
    subagents.refuse(CORPUS, ans["request"], "[Credential Exploration]", subagents.AUTO_MODE)
    again = await subagents.start_it(CORPUS, ans["request"])
    assert again.refused and again.kind == subagents.HOOK and not bridge.ops("spawn")


async def test_start_it_is_refused_as_any_start_is_in_plan_mode_and_without_the_module(bridge, models, monkeypatch):
    """Start it is a click, and like every start it is refused while main is in plan mode (U20) or the module is not
    live; the request stays refused, so Start it works once that changes. Plan mode is --agent-check's to refuse, from
    main's mode as the module's call runs, since the mode the server keeps is stale after a shift+tab while main is idle
    (live check L21): a click in a remembered plan mode still reaches the module."""
    from app import session

    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {"model": "m", "effort": "e"},
                                    subagents.TYPED)
    subagents.refuse(CORPUS, ans["request"], "[Credential Exploration]", subagents.AUTO_MODE)
    monkeypatch.setattr(session, "main_mode", lambda c: "plan")
    bridge.answers.append({"deny": f"PreToolUse:Agent hook error: {HINTS['start-plan-mode']}"})  # main is in plan mode
    again = await subagents.start_it(CORPUS, ans["request"])
    assert again.refused and again.kind == subagents.HOOK and again.reason == HINTS["start-plan-mode"], \
        "thimble's own reason, without Claude Code's PreToolUse label"
    assert subagents.request(CORPUS, ans["request"])["state"] == "refused"
    assert (await subagents.start_it(CORPUS, ans["request"])).started, "main left plan mode while idle"
    monkeypatch.setattr(session, "main_mode", lambda c: "default")
    ans2 = await subagents.start_job(CORPUS, "writer", "writer:other", "w", {}, subagents.TYPED)
    subagents.refuse(CORPUS, ans2["request"], "[Credential Exploration]", subagents.AUTO_MODE)
    bridge.is_live, bridge.reason = False, "THIMBLE_NO_MODULE is set"
    spawns = len(bridge.ops("spawn"))
    assert (await subagents.start_it(CORPUS, ans2["request"])).kind == subagents.NO_MODULE
    assert len(bridge.ops("spawn")) == spawns, "nothing reaches a module that is not live"


# --------------------------------------------------------------------------- follow-ups and stops


async def test_a_browser_follow_up_sends_through_the_module_with_the_run_s_values(bridge, models):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {"model": "m", "effort": "max"},
                                        subagents.CLICK)
    ans = await subagents.send(CORPUS, started.agent_id, "and April?")
    assert not ans.refused
    [send] = bridge.ops("send")
    assert send["agent"] == started.agent_id and send["text"] == "and April?"
    assert send["values"] == {"model": "m", "effort": "max"}, "the module registers the run's own values first (V1)"
    bridge.answers.append({"error": "the agent belongs to another session", "gone": True})
    assert (await subagents.send(CORPUS, started.agent_id, "and May?")).kind == "earlier-session"
    bridge.is_live = False
    refused = await subagents.send(CORPUS, started.agent_id, "again")
    assert refused.kind == "no-module"


async def test_a_typed_follow_up_is_a_pending_message_request_and_its_exact_send_message(bridge, models):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    ans = subagents.message_request(CORPUS, started.agent_id, "and May?", call="toolu_m")
    assert ans["input"] == {"to": started.agent_id, "message": "and May?"}
    assert subagents.request(CORPUS, ans["request"])["kind"] == "message"


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


# --------------------------------------------------------------------------- runs and ends


@pytest.fixture()
def ended(monkeypatch) -> list[tuple]:
    """Every role's end handler records (role, run, status, report) instead of doing its work."""
    for role, t in list(subagents.TYPES.items()):
        if t.ended:
            monkeypatch.setitem(subagents.TYPES, role, subagents.Type(
                t.role, t.kind, t.chat_role, t.row, t.agent, t.define, t.own, "", f"{__name__}:_ended",
                t.refused))
    _seen.clear()
    yield _seen
    _seen.clear()


_seen: list[tuple] = []


def _ended(c, run, status, report) -> None:
    _seen.append((run.role, run.k, status, report))


async def test_a_run_ends_once_whatever_sign_comes_first(bridge, models, ended):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert subagents.run_ended(CORPUS, started.agent_id, "done", "the report", source="handback")
    assert not subagents.run_ended(CORPUS, started.agent_id, "done", "again", source="notification")
    assert ended == [("writer", 0, "done", "the report")]
    meta = agents.read_meta(CORPUS, subagents.agent(CORPUS, started.agent_id)["chat"])
    assert meta["status"] == "done"
    run = subagents.run_again(CORPUS, started.agent_id, "coordinator")
    assert run.k == 1 and subagents.agent(CORPUS, started.agent_id)["status"] == "running"
    subagents.run_ended(CORPUS, started.agent_id, "done", "follow-up done", source="module")
    assert ended[-1] == ("writer", 1, "done", "follow-up done")


async def test_a_turn_s_end_with_a_child_running_waits_and_without_one_ends_after_the_wait(bridge, models, ended,
                                                                                         monkeypatch):
    from app import session

    monkeypatch.setattr(subagents, "HANDBACK_WAIT_S", 0.05)
    monkeypatch.setattr(session, "agent_answer", lambda c, a: "that turn's answer")
    parent = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    with subagents.update(CORPUS) as state:
        sf.registry(state)["child1"] = {"role": "critic", "parent": parent.agent_id, "status": "running"}
    subagents.stopped(CORPUS, parent.agent_id)
    assert subagents.agent(CORPUS, parent.agent_id)["status"] == "waiting" and not ended
    with subagents.update(CORPUS) as state:
        sf.registry(state)["child1"]["status"] = "done"
    subagents.child_ended(CORPUS, parent.agent_id)
    assert subagents.agent(CORPUS, parent.agent_id)["status"] == "running"
    subagents.stopped(CORPUS, parent.agent_id)
    await asyncio.sleep(0.2)
    assert ended == [("writer", 0, "done", "that turn's answer")]


async def test_a_hand_back_within_the_wait_ends_the_run_with_its_report(bridge, models, ended, monkeypatch):
    monkeypatch.setattr(subagents, "HANDBACK_WAIT_S", 0.2)
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    subagents.stopped(CORPUS, started.agent_id)
    subagents.run_ended(CORPUS, started.agent_id, "done", "the hand-back", source="handback")
    await asyncio.sleep(0.4)
    assert ended == [("writer", 0, "done", "the hand-back")]


async def test_the_module_s_turn_end_ends_a_run_with_its_answer(bridge, models, ended):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert subagents.ended(CORPUS, started.agent_id, "the module's answer")
    assert ended == [("writer", 0, "done", "the module's answer")]
    cut = await subagents.start_job(CORPUS, "writer", "writer:story", "w", {}, subagents.CLICK)
    assert subagents.ended(CORPUS, cut.agent_id, "", "aborted")
    assert ended[-1] == ("writer", 0, "stopped", "")


def test_the_module_s_ended_posts_and_session_moves_reach_subagents(monkeypatch, workspaces_tmp):
    """Lane M's module_bridge calls `ended` for each `ended` post (on_ended) and hears each move --rekey reports."""
    import types

    heard, moves = [], []
    mod = types.ModuleType("app.module_bridge")
    mod.on_ended = heard.append
    mod.rekey = lambda c, old, new: moves.append((c, old, new))
    monkeypatch.setitem(sys.modules, "app.module_bridge", mod)
    monkeypatch.setattr(app, "module_bridge", mod, raising=False)  # read before sys.modules once the real one loaded
    subagents._hear_module()
    assert heard == [subagents.ended]
    body = subagents.HookBody(cwd=str(config.corpus_dir(CORPUS)), hook={"old": "s-old", "session_id": "s-new"})
    asyncio.run(subagents.rekey_route(body))
    assert moves == [(CORPUS, "s-old", "s-new")]


async def test_main_s_quit_closes_the_running_agents_chats(bridge, models, ended):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert subagents.close_running(CORPUS) == [started.agent_id]
    a = subagents.agent(CORPUS, started.agent_id)
    meta = agents.read_meta(CORPUS, a["chat"])
    assert a["status"] == "stopped" and meta["stopped_by"] == "quit" and meta["continue"] == "here"
    assert ended == [("writer", 0, "stopped", subagents.QUIT_LINE)]


async def test_rekey_moves_the_running_agents_and_their_chats_to_the_new_session(bridge, models):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    with subagents.update(CORPUS) as state:
        sf.registry(state)[started.agent_id]["sessions"] = ["old-sid"]
    assert subagents.rekey(CORPUS, "old-sid", "new-sid") == [started.agent_id]
    meta = agents.read_meta(CORPUS, subagents.agent(CORPUS, started.agent_id)["chat"])
    assert meta["session"] == "new-sid" and meta["sessions"] == ["old-sid", "new-sid"]


# --------------------------------------------------------------------------- the caller of a thimble tool


async def test_a_call_runs_as_its_agent_s_key_and_a_descendant_s_as_its_ancestor_s(bridge, models):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    ws = config.workspace_dir(CORPUS)
    with subagents.update(CORPUS) as state:
        sf.registry(state)["helper1"] = {"type": "thimble:helper", "role": "helper", "parent": started.agent_id,
                                         "root": started.agent_id, "status": "running", "descendant": True}
    sf.add_caller(ws, "toolu_w", started.agent_id, "thimble:writer")
    sf.add_caller(ws, "toolu_h", "helper1", "thimble:helper")
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


async def test_main_s_own_call_runs_at_once_and_a_subagent_s_is_found_by_its_transcript(bridge, tmp_path):
    """The caller hook writes a line only for a subagent's call, and before Claude Code makes it, so main's own call has
    none: it is told apart by main's transcript at once, not after CALLER_WAIT_S (live: each of main's thimble calls
    took 2 s longer, start_orientation 4.2 s). A subagent's call with no line yet is found by its own transcript."""
    import time

    from app import session, tools

    assert subagents.CALLER_WAIT_S >= 1.0, "the wait this test shows main's calls no longer take"
    t = time.monotonic()
    assert await subagents.caller(CORPUS, "toolu_main_no_session") is None
    assert time.monotonic() - t < 0.5, "with no session attached, main's call waits for nothing"
    main = tmp_path / "main.jsonl"
    main.write_text(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_main1", "name": "mcp__plugin_thimble_thimble__add_card"}]}}) + "\n")
    lv = session.Live(CORPUS, "sid-main", "/tmp", str(main), None)
    with subagents.update(CORPUS) as state:
        sf.registry(state)["orient1"] = {"key": "orient", "role": "orientation", "status": "running", "chat": "o1"}
    sub = session.Sub(CORPUS, "o1", None, "orient1", role="orient")
    sub.path = tmp_path / "agent-orient1.jsonl"
    sub.path.write_text(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_sub1", "name": "mcp__plugin_thimble_thimble__add_card"}]}}) + "\n")
    lv.subs.append(sub)
    session._live[CORPUS] = lv
    try:
        t = time.monotonic()
        refused, as_session = await tools._as_caller(CORPUS, "add_card", "toolu_main1")
        assert not refused and as_session is None
        assert time.monotonic() - t < 0.5, "main's own call runs at once"
        who = await subagents.caller(CORPUS, "toolu_sub1")
        assert who is not None and who.key == "orient", "a subagent's call is found by the transcript that holds it"
    finally:
        session._live.pop(CORPUS, None)


def test_the_shim_of_main_lists_every_tool_and_the_critique_among_them():
    from app import tools

    names = [t["name"] for t in tools.list()]
    assert "critique" in names and "message_orientation" in names and "wait_session" not in names


# --------------------------------------------------------------------------- the clicks are the analyst's


CLICKS = [("post", "/api/ws/mini/start", {"text": ""}),
          ("post", "/api/ws/mini/write", {"doc": "report"}),
          ("post", "/api/ws/mini/orientation/message", {"text": "hi"}),
          ("post", "/api/ws/mini/subagents/start-it", {"request": "req_0000000000"}),
          ("post", "/api/ws/mini/subagents/again", {"request": "req_0000000000"})]


@pytest.mark.real_write_guard
def test_every_click_route_refuses_the_server_s_token_without_the_analyst_s_cookie(bridge, plugin_headers):
    from app import main

    client = TestClient(main.create_app())
    for method, path, body in CLICKS:
        r = getattr(client, method)(path, json=body, headers=plugin_headers())
        assert r.status_code == 403, (path, r.status_code, r.text)
        # it names the clicks it guards, not only permission answers (live check L32)
        assert "start, message or stop thimble's agents" in r.json()["detail"], path
        r = getattr(client, method)(path, json=body)
        assert r.status_code == 403, ("neither cookie nor token, as a kernel cell posts it", path)
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


def test_a_second_fork_of_a_thread_is_refused_while_the_first_runs(monkeypatch):
    from app import session

    monkeypatch.setattr(session, "thread_for", lambda c, d: "t1")
    assert subagents.fork_check(CORPUS, {"subagent_type": "fork", "description": "thread:t1"}) is None
    assert subagents.fork_check(CORPUS, {"subagent_type": "fork", "description": "thread:t1"})
    subagents.fork_ended(CORPUS, "t1")
    assert subagents.fork_check(CORPUS, {"subagent_type": "fork", "description": "thread:t1"}) is None


def test_old_workspaces_have_their_background_sessions_stopped_once(monkeypatch):
    stopped: list[str] = []
    monkeypatch.setattr(subagents, "_stop_background", stopped.append)
    ws = config.workspace_dir(CORPUS)
    (ws / subagents.OLD_BG_FILE).write_text(json.dumps([{"short": "abc123"}]))
    assert subagents.stop_old_background(CORPUS) == ["abc123"] and stopped == ["abc123"]
    assert subagents.stop_old_background(CORPUS) == [], "the file is renamed once read"


def test_a_chat_an_earlier_version_left_running_closes_as_earlier_version(monkeypatch):
    monkeypatch.setattr(subagents, "kill_left", lambda meta: None)
    meta = agents.new_agent(CORPUS, "orient", "Orientation", session="s0", pid=12345)
    assert subagents.close_old(CORPUS) == [meta["id"]]
    after = agents.read_meta(CORPUS, meta["id"])
    assert after["status"] == "stopped" and after["continue"] == "earlier-version"


def test_what_agent_session_keeps_is_imported_only_by_the_jobs_thimble_still_starts():
    """agent_session.py keeps only what code tickets' `claude -p` sessions, `thimble fix` and an extension's programs
    need (Q6), so only dev.py and harness.py import it, besides main.py, which mounts its answer route."""
    import ast
    from pathlib import Path

    app = Path(subagents.__file__).parent
    importers = set()
    for path in sorted(app.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text("utf-8"))):
            names = ([a.name for a in node.names] if isinstance(node, ast.ImportFrom) and node.module in (None, "app")
                     else [node.module or ""] if isinstance(node, ast.ImportFrom) else [])
            if any(n == "agent_session" or n.endswith(".agent_session") for n in names):
                importers.add(path.stem)
    assert importers <= {"dev", "harness", "agent_session"}, sorted(importers - {"dev", "harness", "agent_session"})
