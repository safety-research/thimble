"""View builds and view reviews as subagents of main (dev.py, view_tools.py, view_review.py, views.py's digest rule):
a builder (`thimble:view-builder`) starts through thimble's module for a click or a follow-on start, or by main's exact
Agent call for main's propose_view; it checks with `view_check`, finishes with `finish_view`, where the server runs the
gates of record and counts the attempts; its end is the backstop, which gates once, repairs an orientation's proposal or
fails the view with Retry. Readers see only files a gate passed. A reviewer (`thimble:view-reviewer`) takes pictures
with `view_pictures` and ends each round with `finish_review`.

The module is the fake bridge (subagent_fakes); an agent's calls are made through tools.call with the caller hook's line
written first, as the PreToolUse hook writes it, and its end is subagents.run_ended, as the mirror or the module's
`ended` post ends a run. The gate is faked: a view passes when its folder holds view.json and its page says no FAIL."""
from __future__ import annotations

import asyncio
import json
import types
from pathlib import Path

import pytest
from conftest import earlier_orientation_proposal
from fastapi.testclient import TestClient

from app import agents, config, dev, prompts, session, subagents, tools, view_review, view_tools, views
from app import subagent_files as sf
from subagent_fakes import bridge, hints  # noqa: F401 — fixtures

CORPUS = "boards"
READER = '''
def build_index(paths):
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    return None
'''


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (corpus / "board.jsonl").write_text(json.dumps({"body": "first post"}) + "\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    rows = {"dev": {"model": "claude-opus-5-5", "effort": "high", "fast": False},
            "checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    return corpus


@pytest.fixture()
def gates(monkeypatch):
    """views.gate faked: a view passes when its folder holds view.json and its page says no FAIL. The slugs gated."""
    seen: list[str] = []

    async def gate(c, slug, locators=None, **_kw):
        d = views.views_dir(c) / slug
        html = (d / views.VIEW_HTML).read_text() if (d / views.VIEW_HTML).is_file() else ""
        ok = (d / views.VIEW_JSON).is_file() and "FAIL" not in html
        seen.append(slug)
        return {"ok": ok, "checks": [], "page": {"ok": ok}, "problems": [] if ok else ["problem: the page says FAIL"]}

    monkeypatch.setattr(views, "gate", gate)
    monkeypatch.setattr(views, "gate_lines", lambda rep: list(rep.get("problems") or []) or ["the checks passed"])
    monkeypatch.setattr(views, "build_problem", lambda: "")
    return seen


@pytest.fixture()
def heard(monkeypatch):
    """The `view` events main hears (session.push_event)."""
    got: list[tuple[str, dict]] = []
    monkeypatch.setattr(session, "push_event", lambda c, kind, text, **meta: got.append((kind, meta)) or True)
    return got


def _draft(slug: str, html: str = "<p>posts</p>") -> None:
    """A builder writes the view's three files, as a draft: view.json without thimble's `built` stamp."""
    d = views.views_dir(CORPUS) / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / views.VIEW_JSON).write_text(json.dumps({"name": slug.title(), "description": "The board's posts.",
                                                  "scope": ["board.jsonl"], "accepts": [{"form": "L<n>", "means": "a post"}],
                                                  "units": [], "libs": []}))
    (d / views.READER_PY).write_text(READER)
    (d / views.VIEW_HTML).write_text(html)


def _propose(name: str = "Posts", **kw) -> str:
    return views.propose(CORPUS, name, "to read the board", ["board.jsonl"], "one row per post", **kw)["slug"]


def _earlier(name: str = "Posts") -> str:
    """A proposal as an orientation from before 0.8.0 stored it: held, with its build queued."""
    return earlier_orientation_proposal(CORPUS, name, "to read the board", ["board.jsonl"], "one row per post")


def _prop(slug: str) -> dict:
    return views.read_proposal(CORPUS, slug) or {}


async def _call(tool: str, args: dict, agent: str, key: str, n: list[int] = [0]) -> tools.ToolResult:  # noqa: B006
    """A call of `tool` by the agent `agent`, whose calls run as `key`, the caller hook's line written first."""
    n[0] += 1
    tid = f"toolu_t{n[0]:06d}"
    a = subagents.agent(CORPUS, agent) or {}
    sf.add_caller(config.workspace_dir(CORPUS), tid, agent, str(a.get("type") or "thimble:orient-helper"))
    return await tools.call(CORPUS, tool, args, session=key, tool_use_id=tid)


async def _until(cond, what: str, tries: int = 300) -> None:
    for _ in range(tries):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


async def _started(slug: str, route: str = subagents.CLICK, values: dict | None = None) -> str:
    """A builder of `slug` started through the module: its agent id."""
    ans = await dev.start_build(CORPUS, slug, route, values)
    assert ans.started, dict(ans)
    return str(ans.agent_id)


# --------------------------------------------------------------------------- starts and values


async def test_a_click_starts_a_builder_through_the_module_on_the_values_it_names(board, bridge, gates):
    slug = _propose(asked=True)
    agent = await _started(slug, values={"model": "sonnet", "effort": "max"})
    [spawn] = bridge.ops("spawn")
    assert spawn["role"] == "view-builder" and spawn["values"] == {"model": "claude-sonnet-5", "effort": "max"}
    assert spawn["description"] == "view: Posts" and spawn["what"] == slug
    folder, work = views.views_dir(CORPUS) / slug, dev.view_work_dir(CORPUS, slug)
    assert str(folder) in spawn["prompt"] and str(work) in spawn["prompt"]
    assert "<<<the proposal" in spawn["prompt"] or "the proposal" in spawn["prompt"], "the proposal is fenced as data"
    prop = _prop(slug)
    assert (prop["status"], prop["agent_id"], prop["attempt"]) == ("building", agent, 0)
    meta = agents.read_meta(CORPUS, prop["chat"])
    assert meta["role"] == "dev" and meta["view"] == slug and meta["agent_id"] == agent
    again = await _started(_propose("Threads", asked=True))
    assert bridge.ops("spawn")[-1]["values"] == {"model": "claude-opus-5-5", "effort": "high"}, "the dev row by default"
    assert again != agent


def test_main_s_note_of_a_view_build_names_its_view_and_a_ticket_s_names_none(board):
    # live check L25 (live-d): main's chat said "Dev ticket started" for a typed view build
    agents.new_agent(CORPUS, "dev", "view: Posts", view="posts")
    agents.new_agent(CORPUS, "dev", "Ticket t1")
    rows = [r for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1]) if r.get("type") == "agent"]
    assert [r.get("view") for r in rows[-2:]] == ["posts", None]


async def test_a_design_the_analyst_asked_main_for_reaches_the_builder_and_the_reviewer_word_for_word(board, bridge,
                                                                                                     gates, hints):
    # the reviewer keeps a visual design the proposal asks for (prompts/view-review.md), so main's propose_view fields,
    # which carry the analyst's request, reach the builder's task and the reviewer's task whole
    description = ("Each post as the board drew it, in the old forum's look: serif titles, blue links, quoted replies "
                   "indented.")
    task = "Scan the thread list in a dense grid in the style of a spreadsheet, one row per post, with no gaps."
    res = await tools.call(CORPUS, "propose_view", {"name": "Posts", "description": description, "task": task,
                                                    "claims": ["board.jsonl"]},
                           tool_use_id="toolu_main2")
    assert not res.is_error, res.text
    builder = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])["prompt"]
    slug = next(p["slug"] for p in views.list_proposals(CORPUS))
    reviewer = view_review.task(CORPUS, _prop(slug))
    for prompt in (builder, reviewer):
        assert description in prompt and task in prompt


async def test_the_reviewer_s_task_holds_the_proposal_and_no_analyst_context(board, bridge, gates, hints, monkeypatch):
    """The review is a light pass over how the view draws, so its run's prompt holds the view and the proposal, and none
    of the analyst's work: the context engine is not asked for it."""
    res = await tools.call(CORPUS, "propose_view", {"name": "Posts", "description": "The posts by thread.",
                                                    "task": "Find the threads where an agent asks for help.",
                                                    "claims": ["board.jsonl"]}, tool_use_id="toolu_ctx")
    assert not res.is_error, res.text
    slug = next(p["slug"] for p in views.list_proposals(CORPUS))
    seen = []
    monkeypatch.setattr("app.context.render", lambda c, **kw: seen.append(kw) or "## The conversation\n\n[analyst] hi")
    reviewer = view_review.task(CORPUS, _prop(slug))
    assert "The posts by thread." in reviewer and "Find the threads where an agent asks for help." in reviewer
    assert "- The files it reads: board.jsonl" in reviewer and f"`{slug}`" in reviewer
    assert "[analyst] hi" not in reviewer and "The analyst's work" not in reviewer and not seen


async def test_propose_view_takes_a_description_a_task_and_claims_and_the_builder_reads_the_layout_from_the_files(
        board, bridge, gates, hints):
    """0.8.0: propose_view takes name, description, task and claims; the overview, zoom, filter and details
    emerge from the build, not up front. A call with the 0.7.0 fields alone is refused, and the proposal it stores
    gives the builder what the analyst sees and does, the files, and no layout."""
    old = {"name": "Posts", "why": "to read the board", "claims": ["board.jsonl"], "unit": "a post",
           "overview": "a list", "zoom": "a post", "filter": "labels", "details": "the body"}
    res = await tools.call(CORPUS, "propose_view", old, tool_use_id="toolu_old")
    assert res.is_error and "`description` is required" in res.text
    res = await tools.call(CORPUS, "propose_view", {"name": "Posts", "description": "The posts by thread.",
                                                    "claims": ["board.jsonl"]}, tool_use_id="toolu_notask")
    assert res.is_error and "`task` is required" in res.text
    assert not views.list_proposals(CORPUS), "nothing is stored for a refused call"
    res = await tools.call(CORPUS, "propose_view", {"name": "Posts", "description": "The posts by thread.",
                                                    "task": "Find the threads where an agent asks for help.",
                                                    "claims": ["board.jsonl"]}, tool_use_id="toolu_new")
    assert not res.is_error, res.text
    [row] = views.read_json(views.proposals_path(CORPUS), [])
    assert (row["description"], row["task"], row["arrangement"]) == (
        "The posts by thread.", "Find the threads where an agent asks for help.", "")
    assert "why" not in row and "spec" not in row
    builder = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])["prompt"]
    assert "- What the analyst sees: The posts by thread." in builder
    assert "- What the analyst wants to accomplish: Find the threads where an agent asks for help." in builder
    assert "- The files it reads: board.jsonl" in builder
    assert "Find the fields, keys and counts in the files themselves." in builder
    assert "Unit:" not in builder and "The unit and the layout" not in builder


def test_a_viewer_for_a_file_type_keeps_its_arrangement_for_the_builder(board, monkeypatch):
    """A viewer suggested for a file type (views.suggest, prompts/file-viewer.md) gives a description and a free-text
    arrangement, which the builder gets as the unit and the layout; a proposal without a description is refused."""
    from fastapi import HTTPException

    monkeypatch.setattr(views, "_queue", lambda c, slug: None)
    monkeypatch.setattr(views, "build_problem", lambda: "")
    row, why = views.offer(CORPUS, name="Board Lines", description="Each line of the board as a post.", task="",
                           claims=["board.jsonl"], after="file", why="Lines read as posts.", proposed_by="files",
                           arrangement="One post per line, its body in full.")
    assert why == ""
    prop = _prop(row["slug"])
    assert (prop["status"], prop["description"], prop["task"]) == ("suggested", "Each line of the board as a post.", "")
    assert views.proposal_lines(prop).endswith("- The unit and the layout: One post per line, its body in full.")
    with pytest.raises(HTTPException) as e:
        views.propose(CORPUS, "Blank", " ", ["board.jsonl"])
    assert e.value.status_code == 400 and "`description`" in str(e.value.detail)


@pytest.mark.parametrize("mode", prompts.MODES)
def test_the_builder_and_the_reviewer_are_registered_to_keep_a_design_the_proposal_asks_for(board, mode):
    # prompts/dev-view.md's "A good view" and prompts/view-review.md's principles say so in both modes, and each reaches
    # its agent's registered prompt as the module registers it (subagents.roles)
    with prompts.rendering(mode):
        roles = subagents.roles(CORPUS)
    builder, reviewer = roles["view-builder"]["prompt"], roles["view-reviewer"]["prompt"]
    ask = "When the proposal asks for a visual design"
    assert ask in builder and "build that design" in builder
    assert ask in reviewer and "keep that design" in reviewer


@pytest.mark.parametrize("mode", prompts.MODES)
def test_the_builder_and_the_reviewer_use_color_for_the_task_hold_back_the_detail_panel_and_mirror_the_data(board, mode):
    # prompts/dev-view.md's "A good view", in both modes: color one encoding at a time, Color by on the task's field (or
    # a few of its values), never categories in shades of gray; the detail panel closed, or one short line until a click
    # (the side panel's `empty`); a first screen in the chosen form, not a table of raw records; the data's structure
    # mirrored, a network among the forms; and the units the data repeats compared before their details.
    # prompts/view-review.md's clear problems keep the detail panel's rule
    with prompts.rendering(mode):
        roles = subagents.roles(CORPUS)
    builder, reviewer = roles["view-builder"]["prompt"], roles["view-reviewer"]["prompt"]
    assert "one encoding at a time" in builder and "shades of gray" in builder and "take a hue" in builder
    assert "detail panel stays closed" in builder and "Click a session" in builder
    assert "not a table of raw records" in builder
    assert "who works with whom as a network" in builder and "before the details within one" in builder
    assert "`initial`" in builder and "`{field, on: [values]}`" in builder and "`empty` option" in builder
    # the reviewer is a light pass for clear problems in how the view draws: of these it keeps the detail panel
    assert "detail panel stays closed" in reviewer and "Click a session" in reviewer


# --------------------------------------------------------------------------- a thread's fork's start, which main makes


async def test_a_start_refused_at_the_subagent_limit_goes_back_to_the_queue_with_no_failure(board, bridge, gates,
                                                                                           monkeypatch):
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    monkeypatch.setattr(dev, "LIMIT_RETRY_S", 0.05)
    bridge.answers.append({"limit": "Claude Code runs at most 20 concurrent subagents"})
    slug = _propose(asked=True)
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the refused start was never tried again")
    await _until(lambda: _prop(slug).get("status") == "building", "it never started")
    assert not _prop(slug).get("refused") and not _prop(slug).get("error")


async def test_a_start_refused_otherwise_fails_the_view_with_its_refusal_and_start_it(board, bridge, gates):
    bridge.answers.append({"deny": "PreToolUse:Agent hook error: PLAN MODE"})
    slug = _propose(asked=True)
    ans = await dev.start_build(CORPUS, slug, subagents.CLICK)
    assert ans.kind == "hook"
    prop = _prop(slug)
    assert prop["status"] == "failed" and prop["refused"]["kind"] == "hook" and prop["refused"]["request"]
    bridge.is_live, bridge.reason = False, "THIMBLE_NO_MODULE is set"
    slug2 = _propose("Threads", asked=True)
    ans = await dev.start_build(CORPUS, slug2, subagents.CLICK)
    assert ans.kind == "no-module" and _prop(slug2)["refused"]["kind"] == "no-module"


# --------------------------------------------------------------------------- the sandbox of a build's commands

# what srt's seccomp helper says when the user namespace it makes inside bubblewrap gets no capabilities, and what
# bubblewrap says when it cannot make its own: a kernel that restricts unprivileged user namespaces (Ubuntu 24.04)
NESTED_USERNS = ("apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide "
                 "CAP_SYS_ADMIN)")
UID_MAP = "bwrap: setting up uid map: Permission denied"
SYSCTL_FIX = "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"


def _bwrap(tmp_path: Path, monkeypatch, said: str, restricted: str) -> None:
    """This machine, as the build's sandbox finds it: a bwrap first on PATH that says `said` and fails, and AppArmor's
    switch for unprivileged user namespaces reading `restricted`."""
    import os  # noqa: PLC0415
    import shlex  # noqa: PLC0415

    from app import cc_settings, kernel_wrap  # noqa: PLC0415

    bin_ = tmp_path / "fake-bin"
    if not bin_.is_dir():
        bin_.mkdir()
        monkeypatch.setenv("PATH", f"{bin_}{os.pathsep}{os.environ.get('PATH', '')}")
    (bin_ / "bwrap").write_text(f"#!/bin/sh\necho {shlex.quote(said)} >&2\nexit 1\n")
    (bin_ / "bwrap").chmod(0o755)
    (tmp_path / "userns").write_text(f"{restricted}\n")
    monkeypatch.setattr(cc_settings, "APPARMOR_USERNS", tmp_path / "userns")
    monkeypatch.setattr(kernel_wrap, "_srt_works", {})  # probed afresh, and the real answers kept for the next tests


async def test_a_build_whose_sandbox_cannot_start_tells_the_analyst_in_its_thread_and_in_main(board, bridge, gates,
                                                                                            tmp_path, monkeypatch):
    """The build's commands run in the sandbox (srt, or Claude Code's on its sign-in), which a kernel that restricts
    user namespaces keeps from starting: one notice, in the foreground of every chat and as a row in the build's thread,
    says that the view build can't run commands, why, and the sysctl the terminal plugin gives when AppArmor's switch is
    on; a later build's start where the sandbox starts takes it away."""
    from app import kernel_wrap, notices, srt  # noqa: PLC0415

    if why := srt.missing(config.REPO_ROOT, srt.node()):
        pytest.skip(why)
    works = kernel_wrap.srt_works(srt.node(), srt.package(config.REPO_ROOT))

    def box() -> list[dict]:
        return [n for n in notices.open_notices(CORPUS) if n.get("key") == dev.NO_BOX_KEY]

    def told(slug: str) -> bool:
        return bool(box()) and box()[0]["chat"] == _prop(slug)["chat"]

    _bwrap(tmp_path, monkeypatch, NESTED_USERNS, "1")
    slug = _propose(asked=True)
    await _started(slug)
    await _until(lambda: told(slug), "no notice said the build can't run commands", tries=1000)
    [n] = box()
    assert n["text"] == ("The view build can't run commands on this machine: its sandbox can't start, because the "
                         f"kernel restricts user namespaces. Allow them: `{SYSCTL_FIX}`"), n["text"]
    assert (n["agent"], n["kind"]) == ("View build: Posts", "sandbox")
    rows = [r for r in agents.read_events(agents.paths(CORPUS, n["chat"])[1]) if r["type"] == notices.TYPE]
    assert [r["text"] for r in rows] == [n["text"]], "a row in the build's thread"

    # bubblewrap's own words where AppArmor's switch is off: the why without the sysctl, in the same one notice
    _bwrap(tmp_path, monkeypatch, UID_MAP, "0")
    slug = _propose("Threads", asked=True)
    await _started(slug)
    await _until(lambda: told(slug), "the second build's start told nothing", tries=1000)
    [n] = box()
    assert n["text"].endswith("because the kernel restricts user namespaces.") and SYSCTL_FIX not in n["text"]

    # another cause: the sandbox's own words, as the plugin says them
    _bwrap(tmp_path, monkeypatch, "bwrap: execvp /made-up/bash: No such file or directory", "1")
    slug = _propose("Boards", asked=True)
    await _started(slug)
    await _until(lambda: told(slug), "the third build's start told nothing", tries=1000)
    [n] = box()
    assert n["text"] == ("The view build can't run commands on this machine: its sandbox can't start (bwrap: execvp "
                         "/made-up/bash: No such file or directory)."), n["text"]

    # the sandbox starts again: the next build's start takes the notice away
    if works:
        (tmp_path / "fake-bin" / "bwrap").unlink()
        kernel_wrap._srt_works.clear()
        await _started(_propose("Replies", asked=True))
        await _until(lambda: not box(), "the notice stayed after a build whose sandbox started", tries=1000)


# --------------------------------------------------------------------------- the gate tools


async def test_finish_view_registers_a_passing_view_once_and_tells_main(board, bridge, gates, heard, hints):
    slug = _propose(asked=True)
    agent = await _started(slug)
    key = view_tools.build_key(slug)
    _draft(slug)
    res = await _call("view_check", {"locators": ["board.jsonl#L1"]}, agent, key)
    assert not res.is_error and "The checks pass." in res.text and _prop(slug)["locators"] == ["board.jsonl#L1"]
    res = await _call("finish_view", {}, agent, key)
    assert not res.is_error and res.text.endswith(tools.hint("finish-view-pass"))
    prop = _prop(slug)
    assert prop["status"] == "built" and prop["finish"] == {"agent": agent, "result": "pass",
                                                             "version": views.read_view(CORPUS, slug)["version"]}
    assert [k for k, _ in heard] == ["view"] and heard[0][1]["view"] == slug
    again = await _call("finish_view", {}, agent, key)
    assert again.text.endswith(tools.hint("finish-view-pass")) and len(heard) == 1 and gates.count(slug) == 2, \
        "a second finish runs no gate and tells main nothing more"


async def test_finish_view_counts_the_attempts_and_a_call_after_the_last_runs_nothing(board, bridge, gates, hints):
    slug = _propose(asked=True)
    agent = await _started(slug)
    key = view_tools.build_key(slug)
    _draft(slug, "<p>FAIL</p>")
    for n in range(1, dev.MAX_ATTEMPTS):
        res = await _call("finish_view", {}, agent, key)
        assert f"attempt {n} of {dev.MAX_ATTEMPTS}" in res.text and "problem: the page says FAIL" in res.text
        assert res.is_error, "a failed gate is an error result, which the build's thread marks failed (live check L25)"
    res = await _call("finish_view", {}, agent, key)
    assert res.text.endswith(tools.hint("finish-view-stop")) and res.is_error
    gated = len(gates)
    _draft(slug)
    res = await _call("finish_view", {}, agent, key)
    assert res.text.endswith(tools.hint("finish-view-stop")) and len(gates) == gated, "no gate after the last attempt"
    assert res.is_error
    assert _prop(slug)["status"] == "building" and views.read_built(CORPUS, slug) is None


async def test_the_gate_tools_refuse_main_another_view_s_builder_and_a_builder_s_own_subagent(board, bridge, gates):
    slug, other = _propose(asked=True), _propose("Threads", asked=True)
    agent = await _started(slug)
    theirs = await _started(other)
    _draft(slug)
    res = await _call("finish_view", {}, theirs, view_tools.build_key(slug))
    assert res.is_error and "not that agent's" in res.text, "another view's builder"
    with subagents.update(CORPUS) as state:
        sf.registry(state)["child1"] = {"type": "general-purpose", "parent": agent, "root": agent, "status": "running"}
    res = await _call("finish_view", {}, "child1", view_tools.build_key(slug))
    assert res.is_error, "the builder's own subagent"
    res = await tools.call(CORPUS, "finish_view", {}, session=None, tool_use_id="toolu_main")
    assert res.is_error
    assert _prop(slug)["status"] == "building" and not gates


async def test_a_gate_whose_builder_was_stopped_meanwhile_registers_nothing(board, bridge, gates, heard, monkeypatch):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    real = views.gate

    async def slow(c, s, locators=None, **kw):
        subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")  # TaskStop while the gate runs
        return await real(c, s, locators, **kw)

    monkeypatch.setattr(views, "gate", slow)
    res = await _call("finish_view", {}, agent, view_tools.build_key(slug))
    assert res.is_error and not heard and _prop(slug).get("finish") is None


async def test_a_builder_still_running_after_its_pass_is_stopped_after_the_grace(board, bridge, gates, monkeypatch):
    monkeypatch.setattr(view_tools, "FINISH_GRACE_S", 0.05)
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    await _until(lambda: bridge.ops("stop"), "the builder was never stopped")
    assert bridge.ops("stop")[0]["agent"] == agent
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await asyncio.sleep(0.05)
    assert _prop(slug)["status"] == "built", "its run ends as the finish tool said"


# --------------------------------------------------------------------------- the digest rule


async def test_readers_see_only_what_a_gate_passed(board, bridge, gates):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    v1 = views.read_built(CORPUS, slug)
    assert v1 is not None and v1["dir"] == str(views.views_dir(CORPUS) / slug)
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>an edit after the pass</p>")
    kept = views.read_built(CORPUS, slug)
    assert kept["version"] == v1["version"] and kept["dir"] != v1["dir"], "the copy kept at the pass"
    assert (Path(kept["dir"]) / views.VIEW_HTML).read_text() == "<p>v1</p>"
    assert [v["dir"] for v in views.list_views(CORPUS) if v["slug"] == slug] == [kept["dir"]]
    raw = json.loads((views.views_dir(CORPUS) / slug / views.VIEW_JSON).read_text())
    forged = {**raw, "built": "2026-10-06T00:00:00+00:00", "version": "0123456789ab"}
    (views.views_dir(CORPUS) / slug / views.VIEW_JSON).write_text(json.dumps(forged))
    assert views.read_built(CORPUS, slug)["version"] == v1["version"], "a stamp with no kept copy is ignored"
    fresh = _propose("Threads", asked=True)
    _draft(fresh)
    d = views.views_dir(CORPUS) / fresh
    (d / views.VIEW_JSON).write_text(json.dumps({**json.loads((d / views.VIEW_JSON).read_text()),
                                                  "built": "x", "version": "abcdefabcdef"}))
    assert views.read_built(CORPUS, fresh) is None, "a view no gate passed reaches no reader"


async def test_a_reader_call_without_a_version_runs_the_reader_a_gate_passed(board, bridge, gates, monkeypatch):
    """A citation, main's screenshot, the views kernel and a page loaded without a version reach the reader through
    _prepare with no version: they run reader.py as the view last passed, never an edit made after the pass. The checks
    (views.check) and a reviewer's pictures read the live folder (views.live_reads)."""
    from app import notebook  # noqa: PLC0415 — the kernel's scratch mirror, which these calls need not build

    monkeypatch.setattr(notebook, "scratch_dir", lambda *a, **k: None)
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    live = views.views_dir(CORPUS) / slug / views.READER_PY
    live.write_text(READER + "\nEDITED_AFTER_THE_PASS = True\n")
    _, req = views._prepare(CORPUS, slug)
    assert Path(req["reader"]).read_text() == READER, "the reader as it passed"
    with views.live_reads():
        _, req = views._prepare(CORPUS, slug)
    assert req["reader"] == str(live.resolve()), "the checks read the draft"
    fresh = _propose("Threads", asked=True)
    _draft(fresh)
    with pytest.raises(views.ReaderError):
        views._prepare(CORPUS, fresh)


async def test_the_builder_s_end_gates_a_folder_that_changed_after_its_pass(board, bridge, gates):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    v1 = views.read_view(CORPUS, slug)["version"]
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>FAIL</p>")
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await _until(lambda: (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>",
                 "a failing change after the pass was not put back")
    assert views.read_view(CORPUS, slug)["version"] == v1 and views.passed_as_is(CORPUS, slug)

    other = _propose("Threads", asked=True)
    theirs = await _started(other)
    _draft(other, "<p>v1</p>")
    await _call("finish_view", {}, theirs, view_tools.build_key(other))
    first = views.read_view(CORPUS, other)["version"]
    (views.views_dir(CORPUS) / other / views.VIEW_HTML).write_text("<p>v2</p>")
    subagents.run_ended(CORPUS, theirs, "done", "Built.", source="handback")
    await _until(lambda: views.read_view(CORPUS, other)["version"] != first, "a passing change was not stamped")
    assert views.passed_as_is(CORPUS, other)


async def test_a_change_found_with_no_agent_of_the_view_running_is_gated_once(board, bridge, gates, monkeypatch):
    monkeypatch.setattr(views, "FOUND_GATE_S", 0.01)
    views._bind_loop()
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await asyncio.sleep(0.05)
    gated = len(gates)
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>the analyst's edit</p>")
    views.read_built(CORPUS, slug)
    views.read_built(CORPUS, slug)
    await _until(lambda: views.passed_as_is(CORPUS, slug), "the change found was never gated")
    assert len(gates) == gated + 1 and (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == \
        "<p>the analyst's edit</p>"


# --------------------------------------------------------------------------- build ends


async def test_a_builder_that_ends_without_finish_view_gets_the_gate_once(board, bridge, gates, heard):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    subagents.run_ended(CORPUS, agent, "done", "Done.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "built", "the backstop gate never registered the view")
    assert gates == [slug] and [k for k, _ in heard] == ["view"]


async def test_a_builder_stopped_after_its_last_attempt_ends_as_finish_view_said_and_is_repaired(board, bridge, gates,
                                                                                                hints, monkeypatch):
    monkeypatch.setattr(view_tools, "FINISH_GRACE_S", 0.05)
    slug = _earlier()
    agent = await _started(slug, route=subagents.FOLLOW_ON)
    _draft(slug, "<p>FAIL</p>")
    for _ in range(dev.MAX_ATTEMPTS):
        res = await _call("finish_view", {}, agent, view_tools.build_key(slug))
    assert res.text.endswith(tools.hint("finish-view-stop"))
    await _until(lambda: bridge.ops("stop"), "the builder that went on was never stopped")
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await _until(lambda: len(bridge.ops("spawn")) == 2, "no repair started from what failed")
    assert "repair 1 of" in bridge.ops("spawn")[-1]["prompt"] and _prop(slug).get("error") != dev.VIEW_STOPPED


async def test_a_repair_s_builder_reads_at_most_error_chars_of_the_last_builder_s_long_report(board, bridge, gates):
    """A builder that ended on a long report and no view: the repair's builder reads the report as it reads the gate's
    and finish_view's, at most ERROR_CHARS of it, though the notice takes it whole (for its first sentence and its
    last)."""
    slug = _earlier()
    agent = await _started(slug, route=subagents.FOLLOW_ON)
    report = " ".join(["I could not build Posts.", *["Every write to its folder was refused."] * 30,
                       "To finish, copy the draft into the view's folder."])
    assert len(report) > dev.ERROR_CHARS
    subagents.run_ended(CORPUS, agent, "done", report, source="handback")
    await _until(lambda: len(bridge.ops("spawn")) == 2, "no repair started from what failed")
    prompt = bridge.ops("spawn")[-1]["prompt"]
    assert "repair 1 of" in prompt and report[:dev.ERROR_CHARS] in prompt
    assert "To finish, copy the draft" not in prompt


async def test_a_reviewer_a_change_stopped_leaves_the_folder_to_the_change_s_builder(board, bridge, gates, pictures):
    slug = _propose(asked=True)
    reviewer, _ = await _reviewed(slug)
    views.revise(CORPUS, slug, "a legend", asked=True)  # the change stops the review (views._stop_review)
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>FAIL, the change half made</p>")
    subagents.run_ended(CORPUS, reviewer, "stopped", "", source="notification")
    await _until(lambda: (_prop(slug).get("review") or {}).get("state") == "stopped", "the review never ended")
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>FAIL, the change half made</p>"
    assert _prop(slug)["review"]["note"] == view_review.CHANGED_NOTE


async def test_the_analyst_s_stop_and_main_s_quit_end_a_build_failed_with_retry(board, bridge, gates):
    slug = _propose(asked=True)
    agent = await _started(slug)
    assert views.stop_build(CORPUS, slug) == {"ok": True}
    await _until(lambda: bridge.ops("stop"), "no TaskStop through the module")
    assert (CORPUS, slug) not in dev._view_runs, "its place in the pool frees at once"
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await _until(lambda: _prop(slug).get("status") == "failed", "the stopped build never failed")
    assert _prop(slug)["error"] == dev.VIEW_STOPPED

    other = _propose("Threads", asked=True)
    await _started(other)
    subagents.close_running(CORPUS)
    await _until(lambda: _prop(other).get("status") == "failed", "main's quit left the build running")
    assert _prop(other)["error"] == dev.MAIN_ENDED and _prop(other)["stopped_by"] == "quit", "its chip says why"
    assert "stopped_by" not in _prop(slug), "the analyst's Stop is no quit"
    views.retry(CORPUS, other)
    assert "stopped_by" not in _prop(other), "Retry clears it"


# --------------------------------------------------------------------------- changes


async def test_a_change_goes_to_the_last_builder_when_it_can_be_reached_else_to_a_new_one(board, bridge, gates,
                                                                                          monkeypatch):
    slug = _propose(asked=True)
    agent = await _started(slug)
    monkeypatch.setattr(dev, "VIEW_POOL", 2)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await asyncio.sleep(0.05)
    monkeypatch.setattr(dev, "_reachable", lambda c, a: a == agent)
    views.revise(CORPUS, slug, "show the threads too", asked=True)
    await _until(lambda: bridge.ops("send"), "the change never reached the last builder")
    send = bridge.ops("send")[0]
    assert send["agent"] == agent and "show the threads too" in send["text"] and len(bridge.ops("spawn")) == 1
    subagents.run_again(CORPUS, agent, "coordinator")
    assert _prop(slug)["status"] == "building" and _prop(slug)["attempt"] == 0
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>FAIL</p>")
    subagents.run_ended(CORPUS, agent, "done", "It fails.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "built" and _prop(slug).get("failed_change"),
                 "a failed change did not leave the view as it was")
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>"

    monkeypatch.setattr(dev, "_reachable", lambda c, a: False)
    views.revise(CORPUS, slug, "a legend", asked=True)
    await _until(lambda: len(bridge.ops("spawn")) == 2, "an unreachable builder's change got no new builder")
    assert "a legend" in bridge.ops("spawn")[-1]["prompt"] and len(bridge.ops("send")) == 1



async def _built_in_two_attempts(slug: str, monkeypatch) -> str:
    """A builder of `slug` that passed at its second attempt and ended, reachable from main's session: its agent id. The
    pool has room beside the view's review, which its pass starts."""
    monkeypatch.setattr(dev, "VIEW_POOL", 2)
    agent = await _started(slug)
    _draft(slug, "<p>FAIL</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "built" and (CORPUS, slug) not in dev._view_runs,
                 "the view was not built")
    monkeypatch.setattr(dev, "_reachable", lambda c, a: a == agent)
    return agent


def _thread_texts(slug: str) -> list[str]:
    _, log = agents.paths(CORPUS, str(_prop(slug)["chat"]))
    return [json.loads(ln).get("text") for ln in log.read_text().splitlines() if '"user"' in ln]


async def test_a_message_about_a_built_view_shows_in_its_thread_as_written_not_in_thimble_s_wrapping(
        board, bridge, gates, monkeypatch):
    slug = _propose(asked=True)
    agent = await _built_in_two_attempts(slug, monkeypatch)
    views.message(CORPUS, slug, "Why is run 3 missing? It may be a bug.")
    await _until(lambda: bridge.ops("send"), "the message never reached the builder")
    sent = bridge.ops("send")[0]
    assert sent["agent"] == agent and "Why is run 3 missing? It may be a bug." in sent["text"]
    assert "finish_view" in sent["text"], "the builder gets the message with what a change asks of it"
    # the mirror reads the builder's prompt: thimble's wrapping is no message in the thread, the analyst's words are
    lv, sub = types.SimpleNamespace(c=CORPUS), session.Sub(CORPUS, str(_prop(slug)["chat"]), None, agent, role="dev")
    sub.thimble = view_tools.BUILDER
    line = json.dumps({"type": "user", "origin": {"kind": "coordinator"},
                       "message": {"role": "user", "content": sent["text"]}})
    assert session.translate_sub(lv, sub, line) == 0
    assert _thread_texts(slug) == ["Why is run 3 missing? It may be a bug."]


async def test_a_message_that_asks_for_no_change_is_answered_with_no_build_round_and_its_attempts_kept(
        board, bridge, gates, monkeypatch):
    slug = _propose(asked=True)
    agent = await _built_in_two_attempts(slug, monkeypatch)
    gated = len(gates)
    views.message(CORPUS, slug, "Why is run 3 missing? It may be a bug.")
    await _until(lambda: bridge.ops("send"), "the message never reached the builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    assert _prop(slug)["status"] == "built" and _prop(slug)["attempt"] == 2, "an answer starts no build round"
    subagents.run_ended(CORPUS, agent, "done", "Run 3 has no tickets in March.", source="handback")
    await _until(lambda: (CORPUS, slug) not in dev._settling and not _prop(slug).get("answering"),
                 "the answer's run was not settled")
    p = _prop(slug)
    assert p["status"] == "built" and p["attempt"] == 2 and not p.get("revision") and not p.get("failed_change")
    assert not p.get("error") and len(gates) == gated, "a message that asks for no change is gated never"
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>"


async def test_a_message_that_changes_the_built_view_is_a_change_with_its_attempts_counted_afresh(
        board, bridge, gates, monkeypatch):
    slug = _propose(asked=True)
    agent = await _built_in_two_attempts(slug, monkeypatch)
    views.message(CORPUS, slug, "Make the lanes taller.")
    await _until(lambda: bridge.ops("send"), "the message never reached the builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    _draft(slug, "<p>v2</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    p = _prop(slug)
    assert p["status"] == "built" and p["attempt"] == 1 and p.get("finish", {}).get("result") == "pass"
    subagents.run_ended(CORPUS, agent, "done", "Taller lanes.", source="handback")
    await _until(lambda: (CORPUS, slug) not in dev._settling, "the change's run was not settled")
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v2</p>"
    assert _prop(slug)["status"] == "built" and not _prop(slug).get("answering")


async def _answer_changes(slug: str, html: str, bridge, monkeypatch) -> str:
    """The builder of `slug`, built in two attempts, runs again for a message and writes `html` into the view without
    calling finish_view: its agent id, the run still going."""
    agent = await _built_in_two_attempts(slug, monkeypatch)
    views.message(CORPUS, slug, "Make the lanes taller.")
    await _until(lambda: bridge.ops("send"), "the message never reached the builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    assert _prop(slug).get("answering")
    _draft(slug, html)
    return agent


async def _settled_end(slug: str) -> dict:
    await _until(lambda: (CORPUS, slug) not in dev._settling and not _prop(slug).get("answering"),
                 "the run was not settled")
    return _prop(slug)


@pytest.mark.parametrize("html", ["<p>v2</p>", "<p>FAIL v2</p>"])
async def test_a_message_s_run_that_changes_the_view_without_finish_view_is_gated_once_as_a_change(
        board, bridge, gates, monkeypatch, html):
    slug = _propose(asked=True)
    agent = await _answer_changes(slug, html, bridge, monkeypatch)
    subagents.run_ended(CORPUS, agent, "done", "Done.", source="handback")
    p = await _settled_end(slug)
    passed = "FAIL" not in html
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == (html if passed else "<p>v1</p>")
    assert p["status"] == "built" and not p.get("revision") and not p.get("change")
    assert (CORPUS, slug) not in dev._view_runs
    assert p.get("failed_change") == (None if passed else "Make the lanes taller."), "a failed change is kept for Retry"
    views.message(CORPUS, slug, "Why is run 3 missing?")
    assert _prop(slug)["status"] == "built" and not _prop(slug).get("changed"), "a later message is no build round"


@pytest.mark.parametrize("end", ["quit", "error"])
async def test_main_s_quit_and_an_error_end_a_message_s_run_that_changed_the_view_as_they_end_a_change(
        board, bridge, gates, monkeypatch, end):
    slug = _propose(asked=True)
    agent = await _answer_changes(slug, "<p>v2</p>" if end == "quit" else "<p>FAIL v2</p>", bridge, monkeypatch)
    if end == "quit":
        subagents.close_running(CORPUS)
    else:
        subagents.run_ended(CORPUS, agent, "failed", "API Error: 500", source="notification")
    p = await _settled_end(slug)
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>", "the view is as it was"
    assert p["status"] == "built" and not p.get("revision") and p.get("failed_change") == "Make the lanes taller."
    assert p.get("error") == (dev.MAIN_ENDED if end == "quit" else "problem: the page says FAIL")
    assert p.get("stopped_by") == ("quit" if end == "quit" else None)


@pytest.mark.parametrize("html", [None, "<p>v2</p>"])
async def test_the_stop_in_the_thread_stops_a_message_s_run_and_leaves_the_view_as_it_was(
        board, bridge, gates, monkeypatch, html):
    slug = _propose(asked=True)
    shown: list[tuple[str, str]] = []
    real = views._emit
    monkeypatch.setattr(views, "_emit", lambda c, s, st, **kw: shown.append((s, st)) or real(c, s, st, **kw))
    agent = await _built_in_two_attempts(slug, monkeypatch)
    views.message(CORPUS, slug, "Make the lanes taller.")
    await _until(lambda: bridge.ops("send"), "the message never reached the builder")
    shown.clear()
    subagents.run_again(CORPUS, agent, "coordinator")
    assert shown == [(slug, "built")], "the thread hears of the run that answers, which its Stop stops"
    if html:
        _draft(slug, html)  # a change made before finish_view
    assert views.stop_build(CORPUS, slug) == {"ok": True}
    await _until(lambda: bridge.ops("stop"), "no TaskStop through the module")
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    p = await _settled_end(slug)
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>", "the view is as it was"
    assert p["status"] == "built" and not p.get("revision")
    if html:
        assert p.get("error") == dev.VIEW_STOPPED and p.get("failed_change") == "Make the lanes taller."
    else:
        assert not p.get("error") and not p.get("failed_change") and p["attempt"] == 2


@pytest.mark.parametrize("wait", [False, True])
async def test_two_messages_before_the_builder_s_run_starts_reach_it_once_each(board, bridge, gates, monkeypatch, wait):
    slug = _propose(asked=True)
    agent = await _built_in_two_attempts(slug, monkeypatch)
    views.message(CORPUS, slug, "Why is run 3 missing?")
    if wait:  # the first is sent before the second is written
        await _until(lambda: bridge.ops("send"), "the first message never reached the builder")
    views.message(CORPUS, slug, "And where is run 4?")
    await asyncio.sleep(0.1)
    texts = " ".join(s["text"] for s in bridge.ops("send"))
    assert texts.count("Why is run 3 missing?") == 1 and texts.count("And where is run 4?") == 1
    subagents.run_again(CORPUS, agent, "coordinator")
    await asyncio.sleep(0.1)
    texts = " ".join(s["text"] for s in bridge.ops("send"))
    assert texts.count("Why is run 3 missing?") == 1 and texts.count("And where is run 4?") == 1
    assert _prop(slug)["answering"]["text"] == "Why is run 3 missing?\n\nAnd where is run 4?"
    assert not _prop(slug).get("message"), "nothing is left to send"


async def test_an_extension_s_program_builds_the_view_turn_by_turn_in_place_of_a_builder(board, bridge, gates, heard,
                                                                                         monkeypatch):
    turns: list[str] = []
    part = type("Part", (), {"extension": "builder"})()

    async def turn(c, slug, message, folders, p, rec):
        turns.append(message)
        _draft(slug, "<p>FAIL</p>" if len(turns) == 1 else "<p>fixed</p>")
        return "wrote it"

    monkeypatch.setattr(dev, "view_program", lambda c: part)
    monkeypatch.setattr(dev, "program_view_turn", turn)
    slug = _propose(asked=True)
    ans = await dev.start_build(CORPUS, slug, subagents.CLICK)
    assert ans.get("program") == "builder" and not bridge.ops("spawn")
    await _until(lambda: _prop(slug).get("status") == "built", "the program's build never passed")
    assert len(turns) == 2 and "problem: the page says FAIL" in turns[1], "what failed goes back to the program"
    assert [k for k, _ in heard] == ["view"] and (CORPUS, slug) not in dev._view_runs


# --------------------------------------------------------------------------- the review


@pytest.fixture()
def pictures(monkeypatch):
    """views.shoot_states faked: each state a picture file written where the review asks, with a fitting page."""
    asked: list[list[dict]] = []

    async def shoot_states(c, slug, states, *, answers=0, **_kw):
        asked.append(states)
        out = []
        for st in states:
            Path(st["out"]).parent.mkdir(parents=True, exist_ok=True)
            Path(st["out"]).write_bytes(b"\x89PNG\r\n\x1a\n")
            out.append({"ok": True, "fonts": True, "png": str(st["out"]), "layout": {}, "answers": [{"n": 1}],
                        "controls": ["Day"]})
        return out

    monkeypatch.setattr(views, "shoot_states", shoot_states)
    monkeypatch.setattr(view_review.headless, "missing", lambda what: False)
    return asked


async def _reviewed(slug: str) -> tuple[str, str]:
    """A view built and its reviewer started: (the reviewer's agent id, its key)."""
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await _until(lambda: (CORPUS, slug) not in dev._settling, "the build's end was never settled")
    ans = await view_review.begin(CORPUS, slug, route=subagents.FOLLOW_ON)
    assert ans.started, dict(ans)
    return str(ans.agent_id), view_tools.review_key(slug)


async def test_view_pictures_writes_the_overview_and_the_states_asked_for_into_the_round_s_folder(
        board, bridge, gates, pictures, hints):
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    res = await _call("view_pictures", {"states": [{"state": "wide", "why": "the layout"}]}, reviewer, key)
    assert not res.is_error, res.text
    [states] = pictures
    assert [Path(s["out"]).parent for s in states] == [dev.view_work_dir(CORPUS, slug) / "review" / "1"] * 2
    assert all(str(s["out"]) in res.text for s in states) and "1528" in res.text
    more = [{"state": "narrow", "why": "x"}, {"state": "labels", "why": "y"}, {"state": "filtered", "why": "z"}]
    left = view_review.EXTRA_SHOTS - 1
    while left > 0:
        res = await _call("view_pictures", {"states": more}, reviewer, key)
        assert len(pictures[-1]) == min(len(more), left), "the round's overview is taken; the states left are shot"
        left -= len(pictures[-1])
    res = await _call("view_pictures", {"states": more}, reviewer, key)
    assert res.is_error and "No picture is left" in res.text


async def test_finish_review_keeps_a_passing_revision_and_ends_the_review(board, bridge, gates, pictures, hints):
    """One light pass: a revision that passes the view's checks is kept, and the review is done with it."""
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    folder = views.views_dir(CORPUS) / slug
    (folder / views.VIEW_HTML).write_text("<p>v2</p>")
    res = await _call("finish_review", {"revised": ["the axis names days"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-done"))
    review = _prop(slug)["review"]
    assert (review["round"], review["revised"], review["state"]) == (1, ["the axis names days"], "done")
    assert review["finished"] and views.passed_as_is(CORPUS, slug)
    assert (folder / views.VIEW_HTML).read_text() == "<p>v2</p>"
    res = await _call("finish_review", {}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-done")), "a call after the review ended runs nothing"
    subagents.run_ended(CORPUS, reviewer, "done", "Revised the axis.", source="handback")
    await _until(lambda: not view_review.running(CORPUS, slug), "the reviewer never ended")
    assert view_review.undo(CORPUS, slug)["undo"] and (folder / views.VIEW_HTML).read_text() == "<p>v1</p>"


async def test_finish_review_restores_a_failing_revision_and_ends_the_review(board, bridge, gates, pictures, hints):
    """A revision that fails the view's checks is undone, back to the view as it last passed, and ends the review."""
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    folder = views.views_dir(CORPUS) / slug
    (folder / views.VIEW_HTML).write_text("<p>FAIL</p>")
    res = await _call("finish_review", {"revised": ["a legend"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-restored"))
    assert (folder / views.VIEW_HTML).read_text() == "<p>v1</p>" and views.passed_as_is(CORPUS, slug)
    review = _prop(slug)["review"]
    assert review["note"] == view_review.REVISION_FAILED_NOTE and review["finished"] and review["state"] == "done"
    res = await _call("finish_review", {}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-done")), "a call after the review ended runs nothing"


async def test_a_review_with_no_problems_is_done_after_its_last_round_at_the_latest(board, bridge, gates, pictures,
                                                                                  hints):
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    res = await _call("finish_review", {"left": ["a taste in colours"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-done")) and _prop(slug)["review"]["left"] == ["a taste in colours"]
    other = _propose("Threads", asked=True)
    second, key2 = await _reviewed(other)
    folder = views.views_dir(CORPUS) / other
    for n in range(1, view_review.ROUNDS + 1):
        (folder / views.VIEW_HTML).write_text(f"<p>v{n + 1}</p>")
        res = await _call("finish_review", {"revised": [f"fix {n}"]}, second, key2)
    assert res.text.endswith(tools.hint("finish-review-done")) and _prop(other)["review"]["round"] == view_review.ROUNDS


async def test_a_reviewer_that_ends_without_finish_review_has_its_edit_gated_once(board, bridge, gates, pictures):
    slug = _propose(asked=True)
    reviewer, _ = await _reviewed(slug)
    folder = views.views_dir(CORPUS) / slug
    (folder / views.VIEW_HTML).write_text("<p>FAIL</p>")
    subagents.run_ended(CORPUS, reviewer, "done", "I fixed it.", source="handback")
    await _until(lambda: (_prop(slug).get("review") or {}).get("state") == "done", "the review never ended")
    assert (folder / views.VIEW_HTML).read_text() == "<p>v1</p>"
    assert _prop(slug)["review"]["note"] == view_review.REVISION_FAILED_NOTE


async def test_a_build_s_pass_starts_its_review_as_a_follow_on_start(board, bridge, gates, pictures, monkeypatch):
    monkeypatch.setenv("THIMBLE_VIEW_REVIEW", "on")
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await _until(lambda: any(s["role"] == "view-reviewer" for s in bridge.ops("spawn")), "no review started")
    spawn = next(s for s in bridge.ops("spawn") if s["role"] == "view-reviewer")
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
    assert str(views.views_dir(CORPUS) / slug) in spawn["prompt"] and spawn["description"] == "review: Posts"


def test_a_view_s_builds_and_reviews_take_the_tree_s_names_which_find_each_one(board):
    """Live check L25: a view's two builds and two reviews were four threads all called dev/wiki-page-history. The
    names the browser's tree gives them (threads.view_names) find each one, as /thimble:ask and rename_thread look."""
    from app import threads

    made = [agents.new_agent(CORPUS, "dev", title, view="posts", **({"review": True} if title.startswith("review") else {}))
            for title in ("view: Posts", "review: Posts", "view: Posts", "review: Posts")]
    ids = [m["id"] for m in made]
    names = threads.view_names(agents.list_chats(CORPUS))
    assert [names[i] for i in ids] == ["posts", "posts-review", "posts-2", "posts-review-2"]
    for chat_id, name in zip(ids, ("dev/posts", "dev/posts-review", "dev/posts-2", "dev/posts-review-2")):
        assert [m["id"] for m in threads.find_threads(CORPUS, name)] == [chat_id], name


# --------------------------------------------------------------------------- the clicks are the analyst's


VIEW_CLICKS = [("post", "/api/ws/boards/views/posts/build", {"effort": "low"}),
               ("post", "/api/ws/boards/views/proposals/posts/retry", None),
               ("post", "/api/ws/boards/views/proposals/posts/stop", None),
               ("post", "/api/ws/boards/views/proposals/posts/accept", None),
               ("post", "/api/ws/boards/views/proposals/posts/message", {"text": "a legend"}),
               ("post", "/api/ws/boards/views/posts/review", None),
               ("delete", "/api/ws/boards/views/posts/review", None)]


@pytest.mark.real_write_guard
def test_every_job_click_route_refuses_the_server_s_token_without_the_analyst_s_cookie(board, bridge, plugin_headers):
    from app import main

    _propose(asked=True)
    client = TestClient(main.create_app())
    for method, path, body in VIEW_CLICKS:
        kw = {"json": body} if body is not None else {}
        r = getattr(client, method)(path, headers=plugin_headers(), **kw)
        assert r.status_code == 403, (path, r.status_code, r.text)
        r = getattr(client, method)(path, **kw)
        assert r.status_code == 403, ("neither cookie nor token, as a kernel cell posts it", path)
    assert not bridge.calls, "the module is never asked"


def test_the_finish_tools_stop_their_gate_when_their_caller_drops_the_call_and_main_lists_none_of_them_as_its_own():
    """A finish tool blocks while its gate runs and is cancelled when Claude Code closes the call of a stopped agent
    (tools.Spec.drop_stops, call_route's until_dropped, V6); each names only the job sessions that may call it."""
    for name, kinds in (("view_check", ("view", "review")), ("finish_view", ("view",)),
                        ("view_pictures", ("review",)), ("finish_review", ("review",))):
        spec = tools.REGISTRY[name]
        assert spec.drop_stops and spec.sessions == kinds, name
    assert all(n in tools.tool_sections() for n in ("view_check", "finish_view", "view_pictures", "finish_review"))


def test_a_later_probe_that_fails_never_takes_the_sandbox_away_and_one_that_works_gives_it_back(monkeypatch):
    """A build's start probes srt again (srt_problem). A probe that fails says why for the notice but leaves srt_works as
    it was, so what runs in srt keeps its sandbox; one that works makes srt_works True (the sysctl fixed, no restart);
    one that does not answer in time says nothing (a busy machine)."""
    import subprocess
    from pathlib import Path

    from app import kernel_wrap, srt

    monkeypatch.setattr(srt, "node_version", lambda node: (99, 0, 0))
    monkeypatch.setattr(kernel_wrap, "srt_argv", lambda argv, **kw: ["true"])
    monkeypatch.setattr(kernel_wrap, "_srt_works", {})
    answers: list = []

    def run(*a, **kw):
        a = answers.pop(0)
        if isinstance(a, BaseException):
            raise a
        return subprocess.CompletedProcess(["true"], a[0], "", a[1])

    monkeypatch.setattr(kernel_wrap.subprocess, "run", run)
    node, box = "/usr/bin/node", Path("/x/srt")
    answers[:] = [(0, "")]
    assert kernel_wrap.srt_works(node, box) is True
    answers[:] = [(1, "apply-seccomp: unshare(CLONE_NEWUSER): No space left on device")]
    assert "apply-seccomp" in kernel_wrap.srt_problem(node, box)
    assert kernel_wrap.srt_works(node, box) is True  # never taken away by a later probe
    answers[:] = [subprocess.TimeoutExpired(["true"], 30)]
    assert kernel_wrap.srt_problem(node, box) == ""  # a busy machine says nothing about the sandbox
    monkeypatch.setattr(kernel_wrap, "_srt_works", {})
    answers[:] = [(1, "bwrap: setting up uid map: Permission denied")]
    assert kernel_wrap.srt_works(node, box) is False
    answers[:] = [(0, "")]
    assert kernel_wrap.srt_problem(node, box) == ""
    assert kernel_wrap.srt_works(node, box) is True  # given back once a probe works
