"""Views round 5 (exploration): profile_data, main's description of the data checked against the records
(app/profile_data.py, app/profile_types.py), and the data brief each view's builder gets as its build starts
(app/dev.py write_data_brief, plugin/bin/.thimble-watch data_brief). The corpus is the suite's `mini`."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from app import config, dev, profile_data, profile_types, prompts, tools
from app import subagent_files as sf

CORPUS = "mini"
REPO = Path(__file__).resolve().parents[2]
WATCHER = REPO / "plugin" / "bin" / ".thimble-watch"
MAIN_SID = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
BUILDER = "ab5c0ffee0d1e2f3a"

TYPES = '''/** @records board.jsonl */
type Post = {
  id: number
  thread_id: number
  author: "agent-01" | "agent-02" | "agent-03"
  body: string
  created_at: Time
  /** @derived (p, all) => all.Post.filter((q) => q.thread_id === p.thread_id).length */ in_thread: number
}
'''
NEEDS_NODE = pytest.mark.skipif(shutil.which("node") is None, reason="a derived field in JavaScript runs in node")


def prompts_dir(tmp_path: Path, *, tool_section: bool, brief: bool) -> Path:
    """A copy of the tree's prompts with or without tools.md's `## profile_data` section and dev-view-data.md."""
    d = tmp_path / "prompts"
    shutil.copytree(REPO / "prompts", d)
    secs = tools._sections_of((d / "tools.md").read_text("utf-8"))
    text = (d / "tools.md").read_text("utf-8")
    if "profile_data" in secs and not tool_section:
        text = text.replace(f"## profile_data\n\n{secs['profile_data']}\n\n", "")
    elif "profile_data" not in secs and tool_section:
        section = ('## profile_data\n\nCheck types.\n\n```json\n{"type": "object", "properties": {\n  "types": '
                   '{"type": "string", "description": "The types."}\n}, "required": ["types"]}\n```\n\n')
        text = text.replace("## write_document\n", section + "## write_document\n")
    (d / "tools.md").write_text(text, "utf-8")
    (d / "dev-view-data.md").unlink(missing_ok=True)
    if brief:
        (d / "dev-view-data.md").write_text("## The data\n\n{{data}}\n\n{{profile}}\n", "utf-8")
    return d


@NEEDS_NODE
def test_the_types_engine_profiles_each_field_with_its_fit_and_saves_types_and_profile(tmp_path):
    corpus = config.corpus_dir(CORPUS)
    out = tmp_path / "profile"
    code, text, saved = profile_types.run("types", TYPES, root=corpus, globs=None, budget=profile_types.BUDGET,
                                          ws=None, out=out, node=shutil.which("node"))
    assert code == 0, text
    assert "Post  ←  board.jsonl: 1 file" in text and "8 records" in text
    assert "every required field fits: 7 of 8 (88%)" in text
    assert 'fits 88%; the rest: "agent-04" 1; e.g. "agent-04" at board.jsonl#L8' in text, "a misfit, cited"
    assert "created_at  Time  2026-03-12 09:04:27 .. 2026-03-12 09:31:15 UTC" in text
    assert "in_thread   derived number  1 .. 5" in text
    assert "in the record but not in the types: thread_title" in text
    assert saved == out and (out / "types.ts").read_text("utf-8") == TYPES
    assert (out / "profile.txt").read_text("utf-8").strip() == text.strip()


def test_types_that_do_not_parse_name_the_line_and_save_nothing(tmp_path):
    out = tmp_path / "profile"
    code, text, _ = profile_types.run("types", "/** @records board.jsonl */\ntype Post = {\n  id: number\n",
                                      root=config.corpus_dir(CORPUS), globs=None, budget=100, ws=None, out=out,
                                      node=None)
    assert code == 2 and "line" in text
    assert not (out / "profile.txt").exists()


def test_the_files_engine_profiles_the_named_files_beside_the_plain_description(tmp_path):
    out = tmp_path / "profile"
    desc = "Posts on the agents' board, one per line, each with its thread and author."
    code, text, _ = profile_types.run("files", desc, root=config.corpus_dir(CORPUS), globs=["board.jsonl"],
                                      budget=100, ws=None, out=out, node=None)
    assert code == 0, text
    assert "board.jsonl  1 file" in text and "8 records" in text
    assert "thread_id" in text and "author" in text and "events.jsonl" not in text
    assert (out / "description.md").read_text("utf-8").strip() == desc


def test_profile_data_is_listed_for_main_only_where_tools_md_has_its_section(tmp_path, monkeypatch):
    names = lambda: [t["name"] for t in tools.list(tools.ANALYST)]  # noqa: E731
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(prompts_dir(tmp_path / "without", tool_section=False, brief=False)))
    assert "profile_data" not in names() and "propose_view" in names()
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(prompts_dir(tmp_path / "with", tool_section=True, brief=False)))
    assert "profile_data" in names()
    assert "profile_data" not in [t["name"] for t in tools.list(tools.ANALYST, session="orient")]


@NEEDS_NODE
async def test_the_tool_saves_main_s_last_types_and_the_build_gets_them_in_its_brief(tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(prompts_dir(tmp_path, tool_section=True, brief=True)))
    monkeypatch.setattr(config, "resolve_kernel_wrap", lambda *a, **k: (config.KERNEL_WRAP_NONE, "test"))
    assert profile_data.saved(CORPUS) is None and dev.data_text(CORPUS) == ""
    bad = await tools.call(CORPUS, "profile_data", {}, actor=tools.ANALYST)
    assert bad.is_error and "give `types`" in bad.text
    res = await tools.call(CORPUS, "profile_data", {"types": TYPES}, actor=tools.ANALYST)
    assert not res.is_error, res.text
    assert "every required field fits: 7 of 8 (88%)" in res.text
    types, profile = profile_data.saved(CORPUS)
    assert types == TYPES.strip() and "in_thread" in profile
    brief = dev.data_text(CORPUS)
    assert brief.startswith("## The data") and "type Post = {" in brief and "fits: 7 of 8 (88%)" in brief
    dev.view_work_dir(CORPUS, "board").mkdir(parents=True)
    dev.write_data_brief(CORPUS, "board")
    assert (dev.view_work_dir(CORPUS, "board") / dev.DATA_BRIEF).read_text("utf-8").strip() == brief
    monkeypatch.setenv("THIMBLE_VIEW_DATA_BRIEF", "off")
    dev.write_data_brief(CORPUS, "board")
    assert not (dev.view_work_dir(CORPUS, "board") / dev.DATA_BRIEF).exists(), "no brief, no file"


def run_hook(tmp_path: Path, flag: str, stdin: dict) -> subprocess.CompletedProcess:
    """The watcher as main's hooks run it (test_subagent_hooks.run_hook): in the corpus folder, with no server."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_SESSION"))}
    env.update(THIMBLE_HOME=str(tmp_path / "hook-home"), THIMBLE_WORKSPACES_DIR=str(config.WORKSPACES_DIR),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)))
    return subprocess.run([str(WATCHER), flag], input=json.dumps(stdin), capture_output=True, text=True, env=env,
                          timeout=30, cwd=str(config.corpus_dir(CORPUS)))


def pending_build(ws: Path, tmp_path: Path, slug: str, brief: str) -> str:
    """A view's typed build start as propose_view records it, its brief in its work folder, claimed by main's Agent
    call as the agent-check hook decides it: the call's id."""
    work = tmp_path / "views-work" / slug
    work.mkdir(parents=True)
    (work / dev.DATA_BRIEF).write_text(brief + "\n", "utf-8")
    rid = f"req_r5{slug}"
    inp = {"subagent_type": sf.type_name("view-builder"), "description": f"view-builder: {slug}",
           "prompt": f"{rid}\n## The view\n\nBuild the view {slug}."}
    with sf.update(ws) as state:
        sf.requests(state)[rid] = {"kind": "start", "route": "typed", "role": "view-builder", "key": f"view:{slug}",
                                   "work": str(work), "input": inp, "values": {"model": "m", "effort": "high"},
                                   "created": time.time(), "claimed_by": None, "state": "pending"}
    call = f"toolu_r5{slug}"
    said = run_hook(tmp_path, "--agent-check", {"hook_event_name": "PreToolUse", "tool_name": "Agent",
                                                "session_id": MAIN_SID, "tool_use_id": call,
                                                "permission_mode": "auto", "tool_input": inp})
    assert said.stdout.strip() == "", said.stdout
    return call


def started(tmp_path: Path, agent: str) -> str:
    """The context the SubagentStart hook gives the builder `agent`, '' for none."""
    done = run_hook(tmp_path, "--subagent-start", {"hook_event_name": "SubagentStart", "session_id": MAIN_SID,
                                                   "agent_id": agent, "agent_type": sf.type_name("view-builder")})
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)["hookSpecificOutput"]["additionalContext"] if done.stdout.strip() else ""


def test_a_view_builder_gets_the_data_brief_at_its_first_start_only(tmp_path):
    ws = config.workspace_dir(CORPUS)
    sf.ensure(ws)
    pending_build(ws, tmp_path, "board", "## The data\n\nthe types and their profile")
    assert started(tmp_path, BUILDER) == "## The data\n\nthe types and their profile"
    assert sf.read(ws)["agents"][BUILDER]["key"] == "view:board"
    assert started(tmp_path, BUILDER) == "", "a follow-up has it already"


def test_two_builds_started_in_one_turn_each_get_the_brief_before_they_know_their_start(tmp_path):
    """Main proposes two views and makes both Agent calls in one turn (pipeline 5 always does): neither builder knows
    its own start at its SubagentStart (app/subagent_files.py register), and both starts hold one brief, main's last
    description of the data, so each gets it then. Briefs that differ, as when main described the data again between
    the builds, are no one's to guess: neither builder gets one."""
    ws = config.workspace_dir(CORPUS)
    sf.ensure(ws)
    brief = "## The data\n\nthe types and their profile"
    pending_build(ws, tmp_path, "board", brief)
    pending_build(ws, tmp_path, "forge", brief)
    assert started(tmp_path, "a0000000000000001") == brief
    assert started(tmp_path, "a0000000000000002") == brief
    assert set(sf.read(ws).get(sf.UNSETTLED) or {}) == {"a0000000000000001", "a0000000000000002"}, "both still wait"
    with sf.update(ws) as state:
        state[sf.UNSETTLED] = {}
        for r in sf.requests(state).values():
            r["state"] = "refused"
    other = tmp_path / "other"
    pending_build(ws, other, "posts", brief)
    pending_build(ws, other, "runs", brief + " (described again)")
    assert started(other, "a0000000000000003") == "" and started(other, "a0000000000000004") == ""


def test_the_data_brief_template_holds_both_slots_where_the_prompts_have_one():
    if not (REPO / "prompts" / "dev-view-data.md").is_file():
        pytest.skip("this tree's prompts give the builder no data brief")
    assert set(prompts.slots("dev-view-data")) == {"data", "profile"}
