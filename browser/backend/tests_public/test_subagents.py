"""thimble's agents as subagents of main (app/subagents.py): the roles the module registers, a click's start, follow-up
and stop through the module (a fake of lane M's bridge), a typed start's exact call, the answers a start can get, the
runs and their one end, main's quit and moves, the caller of a thimble tool, and the clicks that take the analyst's
cookie."""
from __future__ import annotations

from pathlib import Path

import pytest

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


def test_the_work_folders_main_s_bash_may_write():
    ws = config.workspace_path(CORPUS)
    assert subagents.write_dirs(CORPUS) == [ws / "orient/work", ws / "writers", ws / "critique-work",
                                             ws / "check-work", ws / "views-work", ws / "extension/views",
                                             ws / "card-libs"]


# --------------------------------------------------------------------------- the files the hooks trust


def test_a_new_workspace_has_the_trusted_files_and_the_kernel_reads_them_only(tmp_path):
    """The kernel binds the workspace read-only as a whole, the trusted folder in it, and never a file of it: the
    writers replace a file whole, and Linux takes the bind off a file another namespace renames a new file over. No
    folder the kernel writes holds the trusted folder (test_kernel_sandbox has the kernel's own test)."""
    ws = config.workspace_dir(CORPUS)
    trusted = ws / kernel_wrap.TRUSTED_DIR
    assert trusted == sf.trusted_dir(ws) and kernel_wrap.TRUSTED_DIR in kernel_wrap.READ_ONLY_DIRS
    for name in sf.FILES:
        assert (trusted / name).is_file(), name
    argv = kernel_wrap.kernel_wrap_argv(["python"], corpus_dir=tmp_path / "c", workspace_dir=ws, venv=None,
                                        python="/usr/bin/python3")
    i = argv.index(str(ws))
    assert argv[i - 1] == "--ro-bind" and argv[i + 1] == str(ws)
    writable = [Path(argv[j + 2]) for j, a in enumerate(argv) if a in ("--bind", "--bind-try", "--bind-fd")]
    assert not [w for w in writable if w == trusted or w in trusted.parents], writable
    assert not any(str(trusted / name) in argv for name in sf.FILES), "no bind of a file the writers replace"
    rules = kernel_wrap.srt_rules(corpus_dir=tmp_path / "c", workspace_dir=ws, venv=None, python="/usr/bin/python3",
                                  srt_dir=tmp_path, home=tmp_path / "h", platform="linux")
    assert not [w for w in map(Path, rules["filesystem"]["allowWrite"]) if w == trusted or w in trusted.parents]


def test_the_kernel_can_neither_hold_nor_swap_the_lock_of_subagents_json(tmp_path):
    """A read-only lock can still be opened and flocked, which would make every writer wait for it and then write
    without it, so the lock lies in the workspace's locks folder, which the kernel sees as an empty read-only folder
    (bwrap) or not at all (srt)."""
    ws = config.workspace_dir(CORPUS)
    locks = ws / kernel_wrap.LOCKS_DIR
    assert sf.LOCKS == kernel_wrap.LOCKS_DIR and sf.lock_path(ws) == locks / sf.LOCK and sf.lock_path(ws).is_file()
    argv = kernel_wrap.kernel_wrap_argv(["python"], corpus_dir=tmp_path / "c", workspace_dir=ws, venv=None,
                                        python="/usr/bin/python3")
    i = argv.index("--tmpfs", argv.index(str(ws)))
    assert argv[i:i + 4] == ["--tmpfs", str(locks), "--remount-ro", str(locks)]
    rules = kernel_wrap.srt_rules(corpus_dir=tmp_path / "c", workspace_dir=ws, venv=None, python="/usr/bin/python3",
                                  srt_dir=tmp_path, home=tmp_path / "h", platform="linux")["filesystem"]
    assert str(locks) in rules["denyRead"] and str(locks) in rules["denyWrite"]


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
])
async def test_each_answer_of_the_module_ends_the_request_with_its_kind(bridge, models, answer, kind):
    bridge.answers.append(answer)
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert ans.kind == kind
    r = subagents.request(CORPUS, ans["request"])
    assert r["refused_kind"] == kind and r["state"] == "refused"


@pytest.mark.parametrize("route", [subagents.CLICK, subagents.TYPED])
async def test_a_start_makes_its_agent_s_work_folder_which_main_s_sandbox_cannot(bridge, models, route, tmp_path):
    """Main's sandbox lets Bash write in a work folder but not in the workspace around it, so the agent could not make
    a missing folder itself (live check L16: orient/work was missing). A folder outside the workspace is not made."""
    ws = config.workspace_dir(CORPUS)
    work = ws / "writers" / "report"
    assert not work.exists()
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, route, work=work)
    assert work.is_dir() and not ans.refused
    work.rmdir()
    outside = tmp_path / "elsewhere"
    await subagents.start_job(CORPUS, "writer", "writer:other", "w", {}, route, work=outside)
    assert not outside.exists()


# --------------------------------------------------------------------------- follow-ups and stops


async def test_a_browser_follow_up_sends_with_the_run_s_values(bridge, models):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {"model": "m", "effort": "max"},
                                        subagents.CLICK)
    ans = await subagents.send(CORPUS, started.agent_id, "and April?")
    assert not ans.refused
    [send] = bridge.ops("send")
    assert send["agent"] == started.agent_id and send["text"] == "and April?"
    assert send["values"] == {"model": "m", "effort": "max"}, "the module registers the run's own values first (V1)"
    bridge.answers.append({"error": "the agent belongs to another session", "gone": True})
    assert (await subagents.send(CORPUS, started.agent_id, "and May?")).kind == "earlier-session"


async def test_a_stop_of_an_ended_agent_counts_as_done(bridge, models):
    started = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK)
    assert not (await subagents.stop(CORPUS, started.agent_id)).refused
    bridge.answers.append({"error": "Task a1 is not running"})
    done = await subagents.stop(CORPUS, started.agent_id)
    assert not done.refused and done.get("done")
    bridge.answers.append({"error": "the agent had ended", "gone": True})
    assert (await subagents.stop(CORPUS, started.agent_id)).get("done"), "module_bridge's `gone`"


# --------------------------------------------------------------------------- runs and ends


@pytest.fixture()
def ended(monkeypatch) -> list[tuple]:
    """Every role's end handler records (role, run, status, report) instead of doing its work."""
    for role, t in list(subagents.TYPES.items()):
        if t.ended:
            monkeypatch.setitem(subagents.TYPES, role, subagents.Type(
                t.role, t.kind, t.chat_role, t.row, t.agent, t.define, t.own, "", f"{__name__}:_ended",
                t.refused, left_work=t.left_work, gated=t.gated))
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


# --------------------------------------------------------------------------- the clicks are the analyst's


def test_the_click_routes_are_the_ones_the_module_is_reached_by():
    """Every route of subagents that reaches the module takes the analyst's cookie (subagents.analyst_only)."""
    import inspect

    for fn in subagents.CLICK_ROUTES:
        assert "analyst_only(" in inspect.getsource(fn), fn.__name__


