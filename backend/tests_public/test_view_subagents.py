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
from pathlib import Path

import pytest
from conftest import earlier_orientation_proposal

from app import agents, config, dev, orient_session, orientation, prompts, session, subagents, tools, view_review, view_tools, views
from app import subagent_files as sf
from subagent_fakes import bridge, hints  # noqa: F401 — fixtures
from target_blocks import target_blocks  # noqa: F401 — the core lane's target flags, where prompts.py lacks them

CORPUS = "boards"
BUILD_OTHER_PAGE = views.build_other_page  # the gates fixture fakes it; the second page's test builds it
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
    """views.gate faked: a view passes when its folder holds view.json and its page says no FAIL. The slugs gated. A
    build here ends with the page of its target: the page of the view's other place, which a build goes on to make
    where the machine can (views.build_other_page), is test_view_targets.py's."""
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
    monkeypatch.setattr(views, "build_other_page", lambda c, slug, **kw: False)
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


async def test_main_s_propose_view_gives_the_exact_agent_call_its_hook_lets_through(board, bridge, gates, hints):
    res = await tools.call(CORPUS, "propose_view", {"name": "Posts", "description": "The board's posts as a list.",
                                                    "task": "Read the board.", "claims": ["board.jsonl"],
                                                    "effort": "low"}, tool_use_id="toolu_main1")
    assert not res.is_error, res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    assert inp["subagent_type"] == "thimble:view-builder" and "run_in_background" not in inp and "model" not in inp
    assert not bridge.ops("spawn"), "main makes the call, not the module"
    rid = sf.REQUEST_RE.search(inp["prompt"].split("\n", 1)[0]).group(0)
    req = subagents.request(CORPUS, rid)
    assert (req["route"], req["values"]) == ("typed", {"model": "claude-opus-5-5", "effort": "low"})
    with subagents.update(CORPUS) as state:
        assert sf.check_call(state, {"tool_name": "Agent", "tool_use_id": "toolu_x", "tool_input": inp}) is None
    slug = views.built_slug(CORPUS, "Posts") or next(p["slug"] for p in views.list_proposals(CORPUS))
    assert _prop(slug)["status"] == "building" and (CORPUS, slug) in dev._view_runs


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


async def test_a_0_7_0_proposal_loads_with_its_why_as_its_description_and_its_layout_for_the_dev_agent(board, bridge,
                                                                                                    gates, hints):
    """A proposal stored by 0.7.0 (`why`, the layout fields as `spec` and as `arrangement`, as the demos' pre-caches
    keep them) still loads: its `why` reads as its description, and the builder, a change, the reviewer, read_ref,
    main's context and the critique show its layout fields as they were proposed. Proposed again under its name, the
    new fields replace the old layout."""
    from app import context, critique_session

    spec = {"unit": "One post, keyed by `id`.", "overview": "A list of threads.", "zoom": "Click a thread.",
            "filter": "By label.", "details": "The post's body."}
    arrangement = "\n".join(f"{label}: {spec[k]}" for k, label in views.LEGACY_SPEC_FIELDS)
    row = {"slug": "posts", "name": "Posts", "why": "Each post in its thread, as the board drew it.",
           "claims": ["board.jsonl"], "arrangement": arrangement, "spec": spec, "proposed_by": "orient",
           "orientation": True, "status": "failed", "ts": "2026-10-01T00:00:00+00:00", "route": subagents.CLICK}
    views._save_proposals(CORPUS, [row])
    prop = _prop("posts")
    assert (prop["description"], prop["task"]) == ("Each post in its thread, as the board drew it.", "")
    assert "why" not in prop
    layout = ["- Unit: One post, keyed by `id`.", "- Overview: A list of threads.", "- Zoom: Click a thread.",
              "- Filter: By label.", "- Details: The post's body."]
    builder = dev.build_task(CORPUS, prop)
    change = dev.change_text(CORPUS, {**prop, "change": "Make the rows blue."})
    reviewer = view_review.task(CORPUS, prop)
    for text in (builder, change, reviewer):
        assert "- What the analyst sees: Each post in its thread, as the board drew it." in text
        assert "- The files it reads: board.jsonl" in text and "\n".join(layout) in text
        assert "What the analyst does with it" not in text
    assert "Make the rows blue." in change
    # an orientation's view from before 0.8.0 is no draft of a critique since: its brief names the deck alone
    assert critique_session.drafts(CORPUS) == []
    assert "  Each post in its thread, as the board drew it." in context.views(CORPUS)
    res = await tools.call(CORPUS, "read_ref", {"ref": "view:posts"})
    assert "description: Each post in its thread, as the board drew it." in res.text and "Overview: A list" in res.text
    views.revise(CORPUS, "posts", "", description="The posts by thread.", task="Find the threads that ask for help.",
                 claims=["board.jsonl"], route=views.TYPED)
    prop = _prop("posts")
    assert (prop["description"], prop["task"], prop["arrangement"]) == (
        "The posts by thread.", "Find the threads that ask for help.", "")
    assert "spec" not in prop and "Unit:" not in dev.build_task(CORPUS, prop)


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


def test_bug_hunt_i12_only_a_code_ticket_s_prompt_names_where_thimble_s_code_is(board):
    """The builder's preamble, shared with code tickets, named thimble's code folders, which it then searched for what
    its docs did not say (about 20 of one build's 63 permission asks in Manual mode). Only a code ticket's prompt names
    them now."""
    from app import ticket_tools

    builder = subagents.roles(CORPUS)["view-builder"]["prompt"]
    code = "thimble's own code is the server `backend/app/`"
    assert code not in builder and code in ticket_tools.definition(CORPUS)["prompt"]


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


async def test_bug_hunt_i12_view_reference_gives_the_builder_the_docs_and_examples_it_names_in_one_call(
        board, bridge, gates):
    """In Manual mode the builder's Reads of thimble's docs and examples were one permission ask each (and it went on
    into thimble's code). view_reference gives the docs and worked examples it names, whole, for the page its build
    makes, in one call; a name it does not know lists the names; it is the builder's alone."""
    slug = _propose(asked=True)
    agent = await _started(slug)
    key = view_tools.build_key(slug)
    res = await _call("view_reference", {"docs": ["color", "charts.md"], "examples": ["repository"]}, agent, key)
    assert not res.is_error
    color = (config.REPO_ROOT / "docs" / "color.md").read_text().strip()
    reader = (views.EXAMPLES_DIR / "repository" / "reader.py").read_text().strip()
    assert f'<doc name="color">\n{color}\n</doc>' in res.text and '<doc name="charts">' in res.text
    assert f'<example view="repository" file="reader.py">\n{reader}\n</example>' in res.text
    page = "view.term.js" if views.target_of(CORPUS, slug) == views.HTML_PAGE else "view.html"
    assert 'file="view.json"' in res.text and f'file="{page}"' not in res.text
    assert '<doc name="time-range">' not in res.text and 'view="timeline"' not in res.text, "only what it named"
    res = await _call("view_reference", {"docs": ["kernel_thimble"]}, agent, key)
    assert res.is_error and "rows-and-filters" in res.text and "kernel_thimble" in res.text
    res = await tools.call(CORPUS, "view_reference", {"docs": ["color"]}, session=None, tool_use_id="toolu_main")
    assert res.is_error, "main's own call"


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


# --------------------------------------------------------------------------- build ends


async def test_a_builder_that_ends_without_finish_view_gets_the_gate_once(board, bridge, gates, heard):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    subagents.run_ended(CORPUS, agent, "done", "Done.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "built", "the backstop gate never registered the view")
    assert gates == [slug] and [k for k, _ in heard] == ["view"]


async def test_an_orientation_s_failing_proposal_is_repaired_then_fails_with_retry_as_an_asked_one_does(
        board, bridge, gates, monkeypatch):
    """U3: an orientation's proposal whose build fails gets VIEW_REPAIRS fresh builders; after the last one it fails
    with Retry, never dropped: its chip shows ✕ (status failed, the gate's line as why) in the views list and in the
    orientation's thread, which also gets one line with the view's chip. A view the analyst asked for fails at once."""
    orient = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE)["id"]
    orientation._write_run(CORPUS, {"status": "running", "chats": {orientation.ROLE: orient}})
    slug = _earlier()
    agent = await _started(slug, route=subagents.FOLLOW_ON)
    _draft(slug, "<p>FAIL</p>")
    for n in range(1, dev.VIEW_REPAIRS + 1):
        subagents.run_ended(CORPUS, agent, "done", "It still fails.", source="handback")
        await _until(lambda: len(bridge.ops("spawn")) == n + 1, f"repair {n} never started")
        spawn = bridge.ops("spawn")[-1]
        assert f"repair {n} of {dev.VIEW_REPAIRS}" in spawn["prompt"] and "problem: the page says FAIL" in spawn["prompt"]
        assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
        agent = _prop(slug)["agent_id"]
    subagents.run_ended(CORPUS, agent, "done", "It still fails.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "failed", "the proposal never failed after its repairs")
    assert len(bridge.ops("spawn")) == dev.VIEW_REPAIRS + 1
    assert "FAIL" in _prop(slug)["error"] and (views.views_dir(CORPUS) / slug).is_dir(), "its draft stays for Retry"
    assert "held" not in _prop(slug) and slug not in views.held_slugs(CORPUS), "the views list shows it"
    _, orient_log = agents.paths(CORPUS, orient)
    [line] = [r for r in agents.read_events(orient_log) if r.get("kind") == dev.VIEW_FAILED_KIND]
    assert line["ref"] == f"view:{slug}" and line["view"] == "Posts" and "FAIL" in line["text"]
    assert f"after {dev.VIEW_REPAIRS} repairs" in line["text"]
    assert orient_session.view_counts(CORPUS, None)["failed"] == 1, "the orientation's end line counts it as failed"
    views.retry(CORPUS, slug, {})
    assert (_prop(slug)["status"], _prop(slug)["repairs"]) == ("queued", 0), "Retry builds it again, with its repairs"
    dev.stop_view(CORPUS, slug, dev.VIEW_STOPPED)

    asked = _propose("Threads", asked=True)
    theirs = await _started(asked)
    _draft(asked, "<p>FAIL</p>")
    subagents.run_ended(CORPUS, theirs, "done", "It fails.", source="handback")
    await _until(lambda: _prop(asked).get("status") == "failed", "the asked view never failed")
    assert "FAIL" in _prop(asked)["error"] and len(bridge.ops("spawn")) == dev.VIEW_REPAIRS + 2, "no repair"
    views.retry(CORPUS, asked, {"effort": "low"})
    assert _prop(asked)["status"] == "queued" and _prop(asked)["values"] == {"effort": "low"}


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


async def test_bug_hunt_i12_the_check_s_and_the_review_s_pictures_come_in_the_tool_s_result(
        board, bridge, gates, pictures, hints, tmp_path, monkeypatch):
    """In Manual mode each picture the builder or the reviewer looked at was a Read of its path outside the analyst's
    folder, so one more permission ask each (6 in one build and review). view_check's picture and view_pictures'
    pictures are image blocks of the tool's result, so no Read is needed; a check without a picture has none."""
    import base64

    slug = _propose(asked=True)
    agent = await _started(slug)
    key = view_tools.build_key(slug)
    _draft(slug)
    png = tmp_path / "check.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\nthe page")

    async def answer(c, s, locators, picture):
        return {"ok": True, "lines": ["the checks passed"], "png": str(png) if picture else None, "drawing": None}

    real = views.check_answer
    monkeypatch.setattr(views, "check_answer", answer)
    res = await _call("view_check", {"picture": True}, agent, key)
    images = [b for b in res.content if b["type"] == "image"]
    assert not res.is_error and len(images) == 1 and images[0]["mimeType"] == "image/png"
    assert base64.b64decode(images[0]["data"]) == png.read_bytes()
    res = await _call("view_check", {}, agent, key)
    assert [b["type"] for b in res.content] == ["text"], "no picture asked, none given"
    monkeypatch.setattr(views, "check_answer", real)

    other = _propose("Threads", asked=True)
    reviewer, rkey = await _reviewed(other)
    res = await _call("view_pictures", {"states": [{"state": "narrow", "why": "fit"}]}, reviewer, rkey)
    images = [b for b in res.content if b["type"] == "image"]
    assert not res.is_error and len(images) == 2, "the overview and the narrow page"
    assert all(base64.b64decode(b["data"]).startswith(b"\x89PNG") for b in images)


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


async def test_bug_hunt_e4_a_page_for_the_other_place_waits_for_the_review_and_a_change_that_stops_one_says_so(
        board, bridge, gates, pictures, hints, monkeypatch):
    """The terminal's first open of a browser-built view while its reviewer ran stopped the review for good, with no
    word: building the page the view lacks is no change to it. The page waits for the review's end, then builds; a
    change that does stop a review tells so in a notice."""
    from app import notices

    slug = _propose("Run Board", asked=True)
    reviewer, key = await _reviewed(slug)
    queued: list[str] = []
    monkeypatch.setattr(dev, "queue_view", lambda c, s: queued.append(s))
    assert views.ensure_page(CORPUS, slug, views.TERM_PAGE) is True
    assert view_review.running(CORPUS, slug) and not bridge.ops("stop") and queued == []
    assert _prop(slug)["page_wanted"] == views.TERM_PAGE
    assert views.page_state(CORPUS, slug, views.TERM_PAGE)[0] == "building"
    subagents.run_ended(CORPUS, reviewer, "done", "Reviewed.", source="handback")
    await _until(lambda: queued == [slug], "the terminal page was never built after the review")
    prop = _prop(slug)
    assert (prop["status"], prop["target"], prop.get("page_wanted")) == ("queued", views.TERM_PAGE, None)
    assert prop["review"]["state"] == "done"
    # an analyst's change stops a review that runs, and a notice says so
    other = _propose("Thread Board", asked=True)
    reviewer, key = await _reviewed(other)
    views.revise(CORPUS, other, "Add a legend.")
    await _until(lambda: bridge.ops("stop"), "the review was never stopped")
    subagents.run_ended(CORPUS, reviewer, "stopped", "")
    await _until(lambda: _prop(other)["review"]["state"] == "stopped", "the review's stop was never settled")
    [notice] = [n for n in notices.open_notices(CORPUS) if n["key"] == notices.agent_key(key)]
    assert notice["text"].startswith("The review of the view Thread Board stopped because the view changed")


async def test_bug_hunt_k6_a_build_pressed_in_the_terminal_tells_the_module_where_it_was_pressed(board, bridge, gates):
    """Bug hunt round 10, K6: the module's note to main at a builder's start said every click was the browser's. The
    start of a build the analyst pressed in the terminal carries the place to the module and to the agent's entry,
    from which a new main hears of it after /clear; a follow-on start names none."""
    slug = _propose(asked=True)
    views.update_proposal(CORPUS, slug, place=views.TERMINAL)
    agent = await _started(slug)
    [spawn] = bridge.ops("spawn")
    assert (spawn["route"], spawn["place"]) == ("click", "terminal")
    assert subagents.agent(CORPUS, agent)["place"] == "terminal"
    other = _propose("Threads", asked=True)
    views.update_proposal(CORPUS, other, place=views.TERMINAL)
    await _started(other, route=subagents.FOLLOW_ON)
    assert "place" not in bridge.ops("spawn")[-1], "only a click is pressed somewhere"


async def _first_page_passed(monkeypatch, name: str = "Run Board") -> tuple[str, str, str, Path, list]:
    """A build pressed in the terminal whose terminal page just passed finish_view, with the browser page its next step:
    (slug, agent, key, folder, the reviews started)."""
    from app import headless

    monkeypatch.setattr(views, "build_other_page", BUILD_OTHER_PAGE)
    monkeypatch.setattr(views, "build_problem_for", lambda c, target=None: "")
    monkeypatch.setattr(headless, "missing", lambda kind: "")
    reviewed: list[tuple[str, str]] = []
    monkeypatch.setattr(view_review, "after_built", lambda c, s: reviewed.append((s, views.target_of(c, s))))
    slug = _propose(name, asked=True)
    views.update_proposal(CORPUS, slug, place=views.TERMINAL, target=views.TERM_PAGE)
    agent = await _started(slug)
    key = view_tools.build_key(slug)
    _draft(slug)
    d = views.views_dir(CORPUS) / slug
    (d / views.VIEW_HTML).unlink()
    (d / views.VIEW_TERM).write_text("draw((d) => d.text('runs'))\n")
    res = await _call("finish_view", {}, agent, key)
    assert not res.is_error and "## The view's page for the browser workbench" in res.text, res.text[:300]
    return slug, agent, key, d, reviewed


async def test_bug_hunt_l17_a_failed_second_page_says_that_page_failed_never_a_change_the_analyst_asked_for(
        board, bridge, gates, heard, hints, monkeypatch):
    """Bug hunt round 11, L17: the browser page a build went on to make failed with "The change to the view Run Grid
    failed, so the view is as it was", in both places, though the analyst asked for no change. The notice and main's
    chip say the view's page for the browser failed to build and the view keeps its terminal page; Retry builds it."""
    from app import notices

    slug, agent, key, d, reviewed = await _first_page_passed(monkeypatch)
    (d / views.VIEW_HTML).write_text("<p>FAIL</p>")
    subagents.run_ended(CORPUS, agent, "done", "The browser page still fails.", source="handback")
    await _until(lambda: reviewed, "the review of the terminal page never started")
    [notice] = [n for n in notices.open_notices(CORPUS) if n.get("kind") == "view"]
    assert notice["text"].startswith("The view Run Board's page for the browser workbench failed to build, so the "
                                     "view keeps its page for the terminal panel: "), notice["text"]
    assert "change" not in notice["text"] and "Retry" in json.dumps(notice.get("action"))
    [chip] = [r for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1])
              if r.get("type") == "chip" and r.get("kind") == "ticket"]
    assert (chip["status"], chip["page"]) == ("failed", views.HTML_PAGE) and "change" not in chip["text"]
    prop = _prop(slug)
    assert (prop["status"], prop["target"], views.missing_page_target(prop["failed_change"])) == (
        "built", views.TERM_PAGE, views.HTML_PAGE)
    assert reviewed == [(slug, views.TERM_PAGE)]
    # an analyst's change that fails still says so
    views.revise(CORPUS, slug, "Add a legend.")
    dev._change_failed_chip(CORPUS, _prop(slug), "problem: the page says FAIL")
    texts = [n["text"] for n in notices.open_notices(CORPUS) if n.get("kind") == "view"]
    assert texts[-1].startswith("The change to the view Run Board failed, so the view is as it was")


async def test_bug_hunt_l17_a_build_s_second_page_is_the_next_step_of_the_same_run_then_one_review(
        board, bridge, gates, heard, hints, monkeypatch):
    """Bug hunt round 11, L17: once the terminal page of a build pressed in the terminal passed, the builder handed back
    before thimble's message with the browser page reached it; thimble resumed it while that hand-back was on its way
    to main, failed the browser page as empty while the builder still wrote it, refused its checks, and said "The
    change to the view … failed", a change the analyst never asked for. The pass of the first page now gives the
    builder the second page as its next step, in finish_view's result: it goes on in the same run, with no message
    and no hand-back between the pages, its attempts count afresh, and the one review starts at its end."""
    from app import headless, notices

    monkeypatch.setattr(views, "build_other_page", BUILD_OTHER_PAGE)
    monkeypatch.setattr(views, "build_problem_for", lambda c, target=None: "")
    monkeypatch.setattr(headless, "missing", lambda kind: "")
    reviewed: list[tuple[str, str]] = []
    monkeypatch.setattr(view_review, "after_built", lambda c, s: reviewed.append((s, views.target_of(c, s))))
    slug = _propose("Run Board", asked=True)
    views.update_proposal(CORPUS, slug, place=views.TERMINAL, target=views.TERM_PAGE)
    agent = await _started(slug)
    key = view_tools.build_key(slug)
    _draft(slug)
    d = views.views_dir(CORPUS) / slug
    (d / views.VIEW_HTML).unlink()
    (d / views.VIEW_TERM).write_text("draw((d) => d.text('runs'))\n")
    res = await _call("finish_view", {}, agent, key)
    assert not res.is_error
    assert res.text.startswith(tools.hint("finish-view-pass-next", place="the terminal panel")), res.text[:300]
    assert "## The view's page for the browser workbench" in res.text and "the analyst asked for no change" in res.text
    assert not res.text.endswith(tools.hint("finish-view-pass")), "the builder does not end after its first page"
    assert [k for k, _ in heard] == ["view"], "main hears the terminal page is built"
    prop = _prop(slug)
    assert (prop["status"], prop["target"], prop["first_page"]) == ("building", views.HTML_PAGE, views.TERM_PAGE)
    assert (prop.get("attempt"), prop.get("finish"), prop.get("changed")) == (0, None, None)
    assert subagents.current(CORPUS, key).agent_id == agent and not bridge.ops("send"), "the same run, no message"
    # the second page: its checks and its finish are the builder's own, its attempts counted from the first
    (d / views.VIEW_HTML).write_text("<p>FAIL</p>")
    res = await _call("finish_view", {}, agent, key)
    assert res.is_error and f"attempt 1 of {dev.MAX_ATTEMPTS}" in res.text
    (d / views.VIEW_HTML).write_text("<p>runs</p>")
    assert "The checks pass." in (await _call("view_check", {}, agent, key)).text
    res = await _call("finish_view", {}, agent, key)
    assert not res.is_error and res.text.endswith(tools.hint("finish-view-pass"))
    assert [k for k, _ in heard] == ["view", "view"] and reviewed == []
    # its hand-back ends the build: one review, of the page it began with, and no failure anywhere
    subagents.run_ended(CORPUS, agent, "done", "Built both pages.", source="handback")
    await _until(lambda: reviewed, "the review never started")
    await asyncio.sleep(0.05)
    assert reviewed == [(slug, views.TERM_PAGE)]
    prop = _prop(slug)
    assert (prop["status"], prop.get("first_page"), prop.get("failed_change")) == ("built", None, None)
    view = views.read_built(CORPUS, slug)
    assert views.has_page(view, views.TERM_PAGE) and views.has_page(view, views.HTML_PAGE)
    assert not [n for n in notices.open_notices(CORPUS) if n.get("kind") == "view"], "no failure notice"
