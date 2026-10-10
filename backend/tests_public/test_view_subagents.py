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
from conftest import Listener
from fastapi.testclient import TestClient

from app import agents, config, dev, events, orient_session, orientation, session, subagents, tools, view_review, view_tools, views
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


async def test_main_s_propose_view_gives_the_exact_agent_call_its_hook_lets_through(board, bridge, gates, hints):
    res = await tools.call(CORPUS, "propose_view", {"name": "Posts", "why": "to read the board",
                                                    "claims": ["board.jsonl"], "unit": "a post", "overview": "a list",
                                                    "zoom": "a post", "filter": "labels", "details": "the body",
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
    why = "Each post as the board drew it, in the old forum's look: serif titles, blue links, quoted replies indented."
    overview = "The thread list in a dense grid in the style of a spreadsheet, one row per post, with no gaps."
    res = await tools.call(CORPUS, "propose_view", {"name": "Posts", "why": why, "claims": ["board.jsonl"],
                                                    "unit": "a post", "overview": overview, "zoom": "a post",
                                                    "filter": "labels", "details": "the body"},
                           tool_use_id="toolu_main2")
    assert not res.is_error, res.text
    builder = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])["prompt"]
    slug = next(p["slug"] for p in views.list_proposals(CORPUS))
    reviewer = view_review.task(CORPUS, _prop(slug))
    for prompt in (builder, reviewer):
        assert why in prompt and overview in prompt


async def test_main_s_message_to_a_view_s_build_thread_gives_the_exact_agent_call(board, bridge, gates, hints):
    """/thimble:ask typed into a view's build thread (message_thread, main's tool) is a typed change, as main's
    file_dev_ticket on a view is: main's exact Agent call starts its builder, so auto mode judges the start, and the
    module neither starts nor messages a builder for it."""
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    builders = lambda: [a for a in bridge.ops("spawn") if "view-builder" in str(a.get("role"))]  # noqa: E731
    spawned, sent = len(builders()), len(bridge.ops("send"))
    res = await tools.call(CORPUS, "message_thread", {"thread": _prop(slug)["chat"], "message": "Make the rows blue."},
                           tool_use_id="toolu_main2")
    assert not res.is_error, res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    assert inp["subagent_type"] == "thimble:view-builder"
    await asyncio.sleep(0.05)
    assert (len(builders()), len(bridge.ops("send"))) == (spawned, sent), "main makes the call, not the module"
    assert _prop(slug)["route"] == "typed" and "Make the rows blue." in _prop(slug)["change"]


# --------------------------------------------------------------------------- a thread's fork's start, which main makes


SPEC = {"why": "to read the tasks", "claims": ["board.jsonl"], "unit": "a task", "overview": "a table",
        "zoom": "a task", "filter": "labels", "details": "the body"}


@pytest.fixture()
def fork_thread(board):
    """A side thread the analyst opened with a ⌘-click on a header of the view `tasks`, answered by the fork `fork1`,
    which main's session (a Listener) follows into the thread's chat. (thread meta, the Listener, a function that
    writes the caller hook's line of one of the fork's calls and gives its id.)"""
    meta = agents.new_thread(CORPUS, "view:tasks/col-c", "C", "C and F headers", surface="view",
                             element="view:tasks", selector="table thead th:nth-child(3)")
    q = Listener(CORPUS)
    session._live[CORPUS].subs.append(session.Sub(CORPUS, meta["id"], "toolu_forked", "fork1", thread=True))
    n = [0]

    def call() -> str:
        n[0] += 1
        tid = f"toolu_fork{n[0]:04d}"
        sf.add_caller(config.workspace_dir(CORPUS), tid, "fork1", sf.FORK_TYPE)
        return tid

    yield meta, q, call
    q.close()


def _start_event(q: Listener) -> tuple[dict, dict]:
    """The start_agent event main got: its note, and the exact Agent call its text carries."""
    note = q.get_nowait()
    assert note["meta"]["kind"] == events.START_AGENT, note
    line = next(ln for ln in note["content"].splitlines() if ln.startswith("{"))
    return note, json.loads(line)


def _rid(inp: dict) -> str:
    return sf.REQUEST_RE.search(inp["prompt"].split("\n", 1)[0]).group(0)


def _main_claims(inp: dict, call: str) -> str | None:
    """Main's own Agent call with `inp`, as thimble's --agent-check decides it: None when it goes on."""
    with subagents.update(CORPUS) as state:
        return sf.check_call(state, {"tool_name": "Agent", "tool_use_id": call, "tool_input": inp})


async def test_a_fork_s_ticket_on_a_view_asks_main_to_start_its_builder_with_the_thread_s_anchor(board, bridge, gates,
                                                                                               fork_thread):
    """Matt's thread on a custom view ("I think C and F aren't aligned properly here"): its fork files the change with
    file_dev_ticket, which Claude Code does not let it start. The change is recorded on the view as main's typed one,
    and main gets a start_agent event that names it and the thread's anchor and carries the exact Agent call, so main
    starts the builder in its next turn with no step of the analyst's; the builder's task holds what the analyst
    ⌘-clicked. The fork is told to say in one line that it is filed, and nothing tells the analyst to file it by hand."""
    meta, q, call = fork_thread
    slug = _propose("Tasks", asked=True, route=views.TYPED)
    res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Align the C and F headers", "view": "Tasks",
                                                       "body": "The C and F headers don't line up with their columns."},
                           tool_use_id=call())
    assert not res.is_error, res.text
    assert res.text.endswith(tools.hint("start_agent-fork", what=f"the change to the view Tasks (view:{slug})",
                                        agent=tools.DEV_AGENT))
    assert "AGENT CALL" not in res.text and "Report a problem" not in res.text, "the fork makes no call and sends nobody"
    assert not bridge.ops("spawn"), "main makes the call, not the module"
    note, inp = _start_event(q)
    assert note["meta"]["filed"] == f"the change to the view Tasks (view:{slug})" and note["meta"]["view"] == slug
    assert (note["meta"]["from_thread"], note["meta"]["anchor"]) == ("C and F headers", "view:tasks/col-c")
    assert note["terminal"] == f"start the dev agent for the change to the view Tasks (view:{slug}) (thread C and F headers)"
    assert inp["subagent_type"] == "thimble:view-builder"
    req = subagents.request(CORPUS, _rid(inp))
    assert (req["route"], req["state"], req["call"], req["via_main"], req["from_thread"]) == (
        "typed", "pending", note["meta"]["event"], True, meta["id"])
    assert not req.get("caller_agent"), "main's Agent call claims it, not the fork's"
    prop = _prop(slug)
    assert prop["status"] == "building" and prop["route"] == "typed" and prop["asked"]
    for part in ("don't line up", "- selector: table thead th:nth-child(3)", "- element: view:tasks", "- text: C",
                 "C and F headers"):
        assert part in prop["change"] and part in inp["prompt"], part
    assert _main_claims(inp, "toolu_main_start") is None and subagents.request(CORPUS, _rid(inp))["state"] == "claimed"


async def test_a_second_fork_call_before_main_s_start_replaces_the_first_so_one_builder_starts(board, bridge, gates,
                                                                                              fork_thread):
    """A second change the fork files before main made the first start replaces that start: main's call from the first
    event is denied, and the one from the second, whose task holds both changes, starts the only builder."""
    _, q, call = fork_thread
    slug = _propose("Tasks", asked=True, route=views.TYPED)
    for body in ("Align the C header.", "Align the F header."):
        res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Align", "view": "Tasks", "body": body},
                               tool_use_id=call())
        assert not res.is_error, res.text
    (_, first), (_, second) = _start_event(q), _start_event(q)
    assert subagents.request(CORPUS, _rid(first))["state"] == "replaced"
    assert "Align the C header." in second["prompt"] and "Align the F header." in second["prompt"]
    assert _main_claims(first, "toolu_main_a") is not None, "the replaced start is denied"
    assert _main_claims(second, "toolu_main_b") is None
    open_starts = [r for r in subagents.read(CORPUS)["requests"].values()
                   if r.get("key") == view_tools.build_key(slug) and r.get("state") in sf.OPEN]
    assert len(open_starts) == 1 and open_starts[0]["state"] == "claimed", "one builder starts"
    assert not bridge.ops("spawn")


async def test_a_fork_s_propose_view_asks_main_to_start_its_build_once(board, bridge, gates, fork_thread):
    """A fork's propose_view is built as main's is, by main's Agent call on a start_agent event; proposing it again
    before main's start leaves one start that can still be made."""
    _, q, call = fork_thread
    res = await tools.call(CORPUS, "propose_view", {"name": "Tasks", **SPEC}, tool_use_id=call())
    assert not res.is_error, res.text
    slug = next(p["slug"] for p in views.list_proposals(CORPUS) if p["name"] == "Tasks")
    assert res.text.endswith(tools.hint("start_agent-fork", what=f"the view Tasks (view:{slug})", agent=tools.DEV_AGENT))
    note, inp = _start_event(q)
    assert note["meta"]["view"] == slug and note["meta"]["from_thread"] == "C and F headers"
    assert inp["subagent_type"] == "thimble:view-builder" and not bridge.ops("spawn")
    prop = _prop(slug)
    assert (prop["status"], prop["route"], prop["asked"]) == ("building", "typed", True)
    res = await tools.call(CORPUS, "propose_view", {"name": "Tasks", **SPEC}, tool_use_id=call())
    assert not res.is_error, res.text
    _, again = _start_event(q)
    assert _main_claims(inp, "toolu_main_a") is not None and _main_claims(again, "toolu_main_b") is None
    assert len([r for r in subagents.read(CORPUS)["requests"].values()
                if r.get("key") == view_tools.build_key(slug) and r.get("state") in sf.OPEN]) == 1


async def test_a_fork_s_start_whose_call_is_longer_than_an_event_s_body_reaches_main_whole(board, bridge, gates,
                                                                                        fork_thread):
    """An event's body is cut at events.BODY_CHARS, but a start_agent event's text is the exact Agent call, which main
    makes unchanged: a call longer than that (here a second change added to a start main has not made yet, whose task
    holds both) reaches main whole, and main's call from it starts the builder."""
    _, q, call = fork_thread
    slug = _propose("Tasks", asked=True, route=views.TYPED)
    for body in ("The C header is one column left of its values. " * 120, "The F header is off too. " * 200):
        res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Align", "view": "Tasks", "body": body},
                               tool_use_id=call())
        assert not res.is_error, res.text
    _start_event(q)
    note, inp = _start_event(q)
    assert len(note["content"]) > events.BODY_CHARS
    assert inp == subagents.request(CORPUS, _rid(inp))["input"], "the call main gets is the one thimble lets through"
    assert _main_claims(inp, "toolu_main_long") is None
    assert subagents.request(CORPUS, _rid(inp))["state"] == "claimed" and _prop(slug)["status"] == "building"


async def test_a_fork_s_start_that_cannot_reach_main_is_refused_and_the_fork_says_why(board, bridge, gates, fork_thread,
                                                                                    monkeypatch):
    """A fork's change in plan mode, or with no session of main's listening, starts nothing and asks main for nothing:
    the view's change fails with the refusal, and the fork's result says why, never that it is filed."""
    _, q, call = fork_thread
    slug = _propose("Tasks", asked=True, route=views.TYPED)
    monkeypatch.setattr(session, "main_mode", lambda c: "plan")
    res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Align", "view": "Tasks", "body": "Align C."},
                           tool_use_id=call())
    assert res.is_error and tools.hint("start-plan-mode") in res.text and "Filed" not in res.text
    assert q.empty() and _prop(slug)["status"] == "failed" and _prop(slug)["refused"]["kind"] == subagents.HOOK
    monkeypatch.setattr(session, "main_mode", lambda c: "default")
    events._subs[CORPUS].discard(q.sub)  # main's shim dropped its subscription: no event reaches main
    res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Align", "view": "Tasks", "body": "Align F."},
                           tool_use_id=call())
    assert res.is_error and "no Claude Code session is listening" in res.text and "Filed" not in res.text
    assert q.empty() and not bridge.ops("spawn")
    prop = _prop(slug)
    assert prop["status"] == "failed" and prop["refused"]["kind"] == subagents.NO_CALL
    assert not [r for r in subagents.read(CORPUS)["requests"].values() if r.get("state") in sf.OPEN]


async def test_main_s_turn_that_got_a_fork_s_start_and_made_no_call_refuses_it(board, bridge, gates, fork_thread):
    """R3 for a fork's start: a turn of main's that got the start_agent event and made its Agent call refuses nothing.
    A turn that got it and ended without the call does not refuse it at once: the event is posted once more (see
    test_a_fork_s_start_main_s_turn_missed_is_asked_for_once_more_then_refused). A turn that misses that event too
    refuses the start (no-call), the view says why with Retry, and main is asked for nothing more."""
    _, q, call = fork_thread
    slug = _propose("Tasks", asked=True, route=views.TYPED)
    lv = session._live[CORPUS]
    for made in (True, False):
        res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Align", "view": "Tasks", "body": "Align C."},
                               tool_use_id=call())
        assert not res.is_error, res.text
        note, inp = _start_event(q)
        session._browser_event(lv, events.render(note), mid_turn=False)
        if made:
            assert _main_claims(inp, "toolu_main_made") is None
        session._end_turn(lv)
        if not made:  # the event posted once more, which main's next turn misses too
            again, _ = _start_event(q)
            session._browser_event(lv, events.render(again), mid_turn=False)
            session._end_turn(lv)
        req = subagents.request(CORPUS, _rid(inp))
        if made:
            assert req["state"] == "claimed"
            assert q.empty(), "a start main made is asked for no more"
            dev._view_runs.pop((CORPUS, slug), None)  # the builder it started, which this test does not follow
            views.update_proposal(CORPUS, slug, status="built")
        else:
            assert (req["state"], req["refused_kind"]) == ("refused", subagents.NO_CALL)
            assert _prop(slug)["refused"]["kind"] == subagents.NO_CALL
            assert q.empty(), "a start missed twice is posted no third time"


async def test_a_fork_s_start_main_s_turn_missed_is_asked_for_once_more_then_refused(board, bridge, gates, fork_thread):
    """Two fork starts reach main in one turn, as when the second start_agent event comes with the end-the-turn note
    of the first start (`## agent-launched`): main makes the first call and ends the turn. The second start is not
    refused: its event is posted once more, with the same Agent call under a new id that the request keeps, and main's
    call from it in its next turn starts the second builder."""
    _, q, call = fork_thread
    tasks, posts = _propose("Tasks", asked=True, route=views.TYPED), _propose("Posts", asked=True, route=views.TYPED)
    lv = session._live[CORPUS]
    for view in ("Tasks", "Posts"):
        res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Align", "view": view, "body": "Align C."},
                               tool_use_id=call())
        assert not res.is_error, res.text
    (first, first_inp), (second, second_inp) = _start_event(q), _start_event(q)
    session._browser_event(lv, events.render(first), mid_turn=False)
    session._browser_event(lv, events.render(second), mid_turn=True)
    assert _main_claims(first_inp, "toolu_main_first") is None
    session._end_turn(lv)
    assert subagents.request(CORPUS, _rid(first_inp))["state"] == "claimed"
    req = subagents.request(CORPUS, _rid(second_inp))
    assert req["state"] == "pending" and req["asked_again"] and req["call"] != second["meta"]["event"]
    assert _prop(posts)["status"] == "building" and not _prop(posts).get("refused")
    again, again_inp = _start_event(q)
    assert again_inp == second_inp, "the same Agent call, which thimble still lets through"
    assert again["meta"]["event"] == req["call"]
    for k in ("filed", "view", "from_thread", "anchor"):
        assert again["meta"][k] == second["meta"][k], k
    assert again["terminal"] == second["terminal"] and q.empty()
    session._browser_event(lv, events.render(again), mid_turn=False)
    assert _main_claims(again_inp, "toolu_main_second") is None
    session._end_turn(lv)
    assert subagents.request(CORPUS, _rid(second_inp))["state"] == "claimed" and q.empty()
    assert _prop(tasks)["status"] == _prop(posts)["status"] == "building"


async def test_a_fork_s_start_main_missed_is_refused_when_its_turn_was_stopped_or_its_event_cannot_be_posted(
        board, bridge, gates, fork_thread):
    """A start main's turn missed is refused (no-call) at the end of that turn, as before, and asked for no more, when
    the turn was stopped (the analyst's Esc, or the safety check's stop), or when its event cannot be posted again since
    no session of main's listens any more."""
    _, q, call = fork_thread
    slug = _propose("Tasks", asked=True, route=views.TYPED)
    lv = session._live[CORPUS]
    for case in ("stopped", "not listening"):
        res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Align", "view": "Tasks", "body": "Align C."},
                               tool_use_id=call())
        assert not res.is_error, res.text
        note, inp = _start_event(q)
        session._browser_event(lv, events.render(note), mid_turn=False)
        if case == "stopped":
            session._interrupted(lv)
        else:
            events._subs[CORPUS].discard(q.sub)  # main's shim dropped its subscription: no event reaches main
        session._end_turn(lv)
        req = subagents.request(CORPUS, _rid(inp))
        assert (req["state"], req["refused_kind"]) == ("refused", subagents.NO_CALL), case
        assert q.empty(), case
        if case == "stopped":
            assert not req.get("asked_again"), "a stopped turn's start is not asked for again"
        assert _prop(slug)["refused"]["kind"] == subagents.NO_CALL


async def test_an_orientation_s_proposal_builds_as_a_follow_on_start_when_the_pool_has_room(board, bridge, gates,
                                                                                             monkeypatch):
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    first, second = _propose("Posts", orientation=True), _propose("Threads", orientation=True)
    await _until(lambda: len(bridge.ops("spawn")) == 1, "the first build never started")
    await asyncio.sleep(0.05)
    assert len(bridge.ops("spawn")) == 1 and (CORPUS, second) in dev._view_queue, "at most VIEW_POOL builds start"
    req = subagents.request(CORPUS, bridge.ops("spawn")[0]["request"])
    assert req["route"] == "follow-on" and _prop(first)["held"]


async def test_a_held_proposal_s_build_sends_its_view_events_marked_held_for_its_chip(board, bridge, gates,
                                                                                    monkeypatch):
    """Live checks L19 and L25: the orientation's proposals sent no `view` event before their first pass, so their chips
    in its thread showed no build state, or stayed "queued" after the build started, until a reload. Each now goes out
    marked `held`, which the chip follows and the views bar and the view-ready toast leave alone."""
    from app import investigation

    sent: list[dict] = []
    monkeypatch.setattr(investigation, "emit", lambda c, inv, event: sent.append(event))
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    first, second = _propose("Posts", orientation=True), _propose("Threads", orientation=True)
    await _until(lambda: any(e["slug"] == first and e["status"] == "building" for e in sent), "no building event")
    held = [e for e in sent if e["slug"] in (first, second)]
    assert held and all(e.get("held") is True for e in held), held
    assert any(e["slug"] == second and e["status"] == "queued" for e in held), "the queued one says so too"
    asked = _propose("Replies", asked=True)
    assert all(not e.get("held") for e in sent if e["slug"] == asked), "a view the analyst asked for is no held one"


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


async def test_an_orientation_s_failing_proposal_is_repaired_then_fails_with_retry_as_an_asked_one_does(
        board, bridge, gates, monkeypatch):
    """U3: an orientation's proposal whose build fails gets VIEW_REPAIRS fresh builders; after the last one it fails
    with Retry, never dropped: its chip shows ✕ (status failed, the gate's line as why) in the views list and in the
    orientation's thread, which also gets one line with the view's chip. A view the analyst asked for fails at once."""
    orient = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE)["id"]
    orientation._write_run(CORPUS, {"status": "running", "chats": {orientation.ROLE: orient}})
    slug = _propose(orientation=True)
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


async def test_a_builder_stopped_after_its_last_attempt_ends_as_finish_view_said_and_is_repaired(board, bridge, gates,
                                                                                                hints, monkeypatch):
    monkeypatch.setattr(view_tools, "FINISH_GRACE_S", 0.05)
    slug = _propose(orientation=True)
    agent = await _started(slug, route=subagents.FOLLOW_ON)
    _draft(slug, "<p>FAIL</p>")
    for _ in range(dev.MAX_ATTEMPTS):
        res = await _call("finish_view", {}, agent, view_tools.build_key(slug))
    assert res.text.endswith(tools.hint("finish-view-stop"))
    await _until(lambda: bridge.ops("stop"), "the builder that went on was never stopped")
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await _until(lambda: len(bridge.ops("spawn")) == 2, "no repair started from what failed")
    assert "repair 1 of" in bridge.ops("spawn")[-1]["prompt"] and _prop(slug).get("error") != dev.VIEW_STOPPED


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


async def test_a_build_main_s_plan_mode_held_at_its_end_fails_with_retry_saying_why_and_no_repair(board, bridge, gates):
    """Main went into plan mode while a builder ran, and thimble stopped nothing, as Claude Code stops no subagent then:
    the builder followed main and could only read and plan. A build that ends there with no view that passes fails
    with Retry and the line that says why, and no repair starts; an orientation's proposal shows in the views list,
    failed. A builder that left a passing view before plan mode held it is built, as the gate says after any run."""
    slug = _propose(orientation=True)
    agent = await _started(slug, route=subagents.FOLLOW_ON)
    subagents.saw_plan_mode(CORPUS, agent)
    subagents.run_ended(CORPUS, agent, "done", "My plan is in the plan file.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "failed", "the build plan mode held never failed")
    line = subagents.plan_failed_line("view-builder")
    assert _prop(slug)["error"] == line and line.endswith(", then choose Retry on the view.")
    assert len(bridge.ops("spawn")) == 1, "no repair"
    assert slug not in views.held_slugs(CORPUS), "the views list shows it"
    views.retry(CORPUS, slug, {})
    assert _prop(slug)["status"] == "queued", "Retry builds it again"
    dev.stop_view(CORPUS, slug, dev.VIEW_STOPPED)

    built = _propose("Threads", asked=True)
    theirs = await _started(built)
    _draft(built)
    subagents.saw_plan_mode(CORPUS, theirs)
    subagents.run_ended(CORPUS, theirs, "done", "I wrote the view before plan mode came.", source="handback")
    await _until(lambda: _prop(built).get("status") == "built", "the view it left was not built")


async def test_main_s_quit_stops_a_change_to_a_built_view_which_says_so_and_keeps_the_view(board, bridge, gates,
                                                                                            monkeypatch):
    """A change to a built view that main's quit stopped leaves the view as it passed, and its chip and main's line say
    it stopped, not that it failed (live check L11)."""
    slug = _propose(asked=True)
    agent = await _started(slug)
    monkeypatch.setattr(dev, "VIEW_POOL", 2)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await asyncio.sleep(0.05)
    monkeypatch.setattr(dev, "_reachable", lambda c, a: a == agent)
    views.revise(CORPUS, slug, "a legend", asked=True)
    await _until(lambda: bridge.ops("send"), "the change never reached the last builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>half a legend</p>")
    subagents.close_running(CORPUS)
    await _until(lambda: _prop(slug).get("failed_change"), "main's quit left the change running")
    prop = _prop(slug)
    assert (prop["status"], prop["error"], prop["stopped_by"]) == ("built", dev.MAIN_ENDED, "quit"), "its chip says why"
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>"
    _, log = agents.paths(CORPUS, agents.MAIN_ID)
    [chip] = [e for e in agents.read_events(log) if e.get("type") == "chip" and e.get("ref") == f"view:{slug}"]
    assert chip["status"] == "stopped" and "stopped when your Claude Code session ended" in chip["text"]
    views.retry(CORPUS, slug)
    assert "stopped_by" not in _prop(slug), "Retry clears it"


async def test_retry_in_a_plain_claude_or_without_the_module_is_refused_at_once_and_queues_nothing(board, bridge, gates,
                                                                                                monkeypatch):
    """Live check L15: Retry clicked while main was a plain `claude` queued the build under the session launch.json
    named, where it waited and would have started by itself once that session came back. A Build, Retry or accept click
    is refused at once as Start is: the proposal stays failed with the refusal, and nothing is queued or spawned."""
    from app import cc_plugin

    row = {"name": "Posts", "why": "to read the board", "claims": ["board.jsonl"], "arrangement": "one row per post",
           "proposed_by": "analyst", "status": "failed", "ts": "2026-10-01T00:00:00+00:00", "route": subagents.CLICK}
    views._save_proposals(CORPUS, [{**row, "slug": "posts"}, {**row, "slug": "viewer", "name": "Viewer",
                                                               "status": "suggested"}])
    views._bind_loop()  # as the click routes do
    monkeypatch.setattr(dev, "VIEW_POOL", 2)
    monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: False, raising=False)
    got = views.retry(CORPUS, "posts")
    assert got["status"] == "failed" and got["refused"]["kind"] == subagents.NOT_LAUNCHED
    assert got["error"] == got["refused"]["reason"], "the toast and the chip say why it did not start"
    assert views.accept(CORPUS, "viewer")["refused"]["kind"] == subagents.NOT_LAUNCHED
    assert _prop("viewer")["status"] == "suggested"
    monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: True, raising=False)
    bridge.is_live, bridge.reason = False, "THIMBLE_NO_MODULE is set"
    assert views.retry(CORPUS, "posts")["refused"]["kind"] == subagents.NO_MODULE
    await asyncio.sleep(0.05)
    assert (CORPUS, "posts") not in dev._view_queue and not bridge.ops("spawn")
    bridge.is_live = True
    assert views.retry(CORPUS, "posts")["status"] == "queued"
    await _until(lambda: bridge.ops("spawn"), "Retry did not start the build once nothing stood in the way")


async def test_a_proposal_an_earlier_version_queued_starts_no_builder_and_waits_for_retry(board, bridge, gates,
                                                                                         monkeypatch):
    """A proposal still queued from before this version (no route) belongs to no click or start of this one: when the
    server finds it (recover_views, at each listing) it starts nothing and fails it with Retry, the click that builds
    it. One a click queued is queued again, as part of that click."""
    monkeypatch.setattr(dev, "VIEW_POOL", 2)
    row = {"name": "Posts", "why": "to read the board", "claims": ["board.jsonl"], "arrangement": "one row per post",
           "proposed_by": "orient", "status": "queued", "ts": "2026-10-01T00:00:00+00:00"}
    views._save_proposals(CORPUS, [{**row, "slug": "posts"}, {**row, "slug": "threads", "name": "Threads",
                                                               "route": subagents.CLICK, "queued_in": bridge.main}])
    dev.recover_views(CORPUS)
    await _until(lambda: bridge.ops("spawn"), "the click's queued build never started")
    await asyncio.sleep(0.05)
    assert [a.get("prompt", "").count("threads") > 0 for a in bridge.ops("spawn")] == [True]
    assert _prop("posts")["status"] == "failed" and _prop("posts")["error"] == dev.OLD_BUILD_LINE


async def test_a_build_queued_in_a_main_session_that_ended_starts_no_builder_in_a_new_one(board, bridge, gates,
                                                                                        monkeypatch):
    """A click's build still queued when the server restarted is queued again (recover_views), and starts only in the
    main session that queued it, or the one /clear or /resume moved it to: in a new main session it fails with
    MAIN_ENDED and Retry, as main's quit fails a queued build while the server runs. A build queued here records main's
    session (`queued_in`)."""
    monkeypatch.setattr(dev, "VIEW_POOL", 3)
    row = {"why": "to read the board", "claims": ["board.jsonl"], "arrangement": "one row per post",
           "proposed_by": "analyst", "status": "queued", "ts": "2026-10-01T00:00:00+00:00", "route": subagents.CLICK}
    bridge.main, bridge.moved = "new-session", {"cleared": "new-session"}
    views._save_proposals(CORPUS, [{**row, "slug": "posts", "name": "Posts", "queued_in": "old-session"},
                                   {**row, "slug": "threads", "name": "Threads", "queued_in": "cleared"},
                                   {**row, "slug": "replies", "name": "Replies"}])
    dev.recover_views(CORPUS)
    await _until(lambda: bridge.ops("spawn"), "the build of the session /clear moved never started")
    await asyncio.sleep(0.05)
    assert [a.get("prompt", "").count("threads") > 0 for a in bridge.ops("spawn")] == [True]
    for slug in ("posts", "replies"):
        assert _prop(slug)["status"] == "failed" and _prop(slug)["error"] == dev.MAIN_ENDED, slug
        assert _prop(slug)["stopped_by"] == "quit", "its chip says it stopped when Claude Code quit, with Retry"
    views.retry(CORPUS, "posts")
    assert _prop("posts")["queued_in"] == "new-session", "Retry, a click in this session, queues it here"
    await _until(lambda: len(bridge.ops("spawn")) == 2, "Retry did not start the build")


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
    res = await _call("view_pictures", {"states": more}, reviewer, key)
    assert len(pictures[-1]) == 2, "the round's overview is taken, and two more states are left"
    res = await _call("view_pictures", {"states": more}, reviewer, key)
    assert res.is_error and "No picture is left" in res.text


async def test_finish_review_keeps_a_passing_revision_counts_the_round_and_restores_a_failing_one(
        board, bridge, gates, pictures, hints):
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    folder = views.views_dir(CORPUS) / slug
    (folder / views.VIEW_HTML).write_text("<p>v2</p>")
    res = await _call("finish_review", {"revised": ["the axis names days"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-again"))
    review = _prop(slug)["review"]
    assert (review["round"], review["revised"], review["state"]) == (1, ["the axis names days"], "running")
    assert views.passed_as_is(CORPUS, slug) and (folder / views.VIEW_HTML).read_text() == "<p>v2</p>"
    (folder / views.VIEW_HTML).write_text("<p>FAIL</p>")
    res = await _call("finish_review", {"revised": ["a legend"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-restored"))
    assert (folder / views.VIEW_HTML).read_text() == "<p>v2</p>" and views.passed_as_is(CORPUS, slug)
    review = _prop(slug)["review"]
    assert review["note"] == view_review.REVISION_FAILED_NOTE and review["finished"]
    res = await _call("finish_review", {}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-done")), "a call after the review ended runs nothing"
    subagents.run_ended(CORPUS, reviewer, "done", "Revised the axis.", source="handback")
    await _until(lambda: not view_review.running(CORPUS, slug), "the reviewer never ended")
    assert view_review.undo(CORPUS, slug)["undo"] and (folder / views.VIEW_HTML).read_text() == "<p>v1</p>"


async def test_a_review_with_no_problems_is_done_after_its_second_round_at_the_latest(board, bridge, gates, pictures,
                                                                                    hints):
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    res = await _call("finish_review", {"left": ["a taste in colours"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-done")) and _prop(slug)["review"]["left"] == ["a taste in colours"]
    other = _propose("Threads", asked=True)
    second, key2 = await _reviewed(other)
    folder = views.views_dir(CORPUS) / other
    for n, html in enumerate(("<p>v2</p>", "<p>v3</p>"), 1):
        (folder / views.VIEW_HTML).write_text(html)
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


async def test_a_review_main_s_plan_mode_held_at_its_end_fails_saying_why_unless_it_finished(board, bridge, gates,
                                                                                                pictures, hints):
    """A reviewer main's plan mode held at its end, which could only read and plan, did not finish its review: the
    review fails with the line that says why and to choose Review again, not done. One that finished it (finish_review)
    before plan mode held it is done."""
    slug = _propose(asked=True)
    reviewer, _ = await _reviewed(slug)
    subagents.saw_plan_mode(CORPUS, reviewer)
    subagents.run_ended(CORPUS, reviewer, "done", "My plan is in the plan file.", source="handback")
    await _until(lambda: (_prop(slug).get("review") or {}).get("state") == "failed", "the review never failed")
    line = subagents.plan_failed_line("view-reviewer")
    assert _prop(slug)["review"]["note"] == line and line.endswith(", then choose Review again on the view.")
    other = _propose("Threads", asked=True)
    second, key = await _reviewed(other)
    res = await _call("finish_review", {"left": ["a taste in colours"]}, second, key)
    assert res.text.endswith(tools.hint("finish-review-done"))
    subagents.saw_plan_mode(CORPUS, second)
    subagents.run_ended(CORPUS, second, "done", "Reviewed.", source="handback")
    await _until(lambda: not view_review.running(CORPUS, other), "the reviewer never ended")
    assert subagents.agent(CORPUS, second)["status"] == "done" and _prop(other)["review"]["state"] == "done"


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


async def test_a_review_refused_at_the_subagent_limit_waits_and_starts_when_tried_again(board, bridge, gates,
                                                                                       pictures, monkeypatch):
    """Live check L19: with a cap of 2 the reviewer started while the builder that had just passed still counted, so
    Claude Code refused it at its limit and the review failed. It now waits, queued with that said, and its start is
    tried again LIMIT_RETRY_S later, as a build's is; a refusal of another kind still fails it."""
    monkeypatch.setattr(dev, "LIMIT_RETRY_S", 0.05)
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await _until(lambda: (CORPUS, slug) not in dev._settling, "the build's end was never settled")
    bridge.answers.append({"error": "thimble: $.agent.spawn refused: 2 spawns are running at once"})
    ans = await view_review.begin(CORPUS, slug, route=subagents.FOLLOW_ON)
    assert ans.kind == subagents.LIMIT
    review = view_review.review_of(_prop(slug))
    assert (review["state"], review["note"]) == ("queued", view_review.QUEUED_NOTE)
    await _until(lambda: view_review.review_of(_prop(slug)).get("state") == "running"
                 and view_review.review_of(_prop(slug)).get("agent_id"), "the review never started on its next try")
    assert sum(s["role"] == "view-reviewer" for s in bridge.ops("spawn")) == 2
    reviewer = str(view_review.review_of(_prop(slug))["agent_id"])
    subagents.run_ended(CORPUS, reviewer, "stopped", None, source="module")
    await _until(lambda: not view_review.running(CORPUS, slug), "the reviewer never ended")
    await asyncio.sleep(0.05)
    bridge.answers.append({"deny": "PreToolUse:Agent hook error: PLAN MODE"})
    await view_review.begin(CORPUS, slug, route=subagents.FOLLOW_ON)
    assert view_review.review_of(_prop(slug))["state"] == "failed", "a refusal of another kind fails it"


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


def test_the_module_registers_the_three_job_roles_on_their_settings_rows(board):
    """subagents.roles holds `thimble:view-builder` and `thimble:view-reviewer` on Settings' dev row and `thimble:check`
    on its checks row, each with an explicit effort, a fixed description, and the thimble tools that are not its own
    taken away."""
    roles = subagents.roles(CORPUS)
    assert {"orientation", "critic", "writer", "view-builder", "view-reviewer", "check", "orient-helper"} <= set(roles)
    own = {"view-builder": view_tools.BUILDER_TOOLS, "view-reviewer": view_tools.REVIEWER_TOOLS,
           "check": ("read_ref", "list_cards", "add_comment")}
    for role, mine in own.items():
        r = roles[role]
        assert r["type"] == f"thimble:{role}" and r["background"] and r["description"].strip()
        assert (r["model"], r["effort"]) == ("claude-opus-5-5", "high")
        assert not [n for n in mine if tools.thimble_tool(n) in r["disallowedTools"]]
        assert tools.thimble_tool("add_card") in r["disallowedTools"]
        assert "{{" not in r["prompt"] and len(r["prompt"]) > 500
    assert str(views.EXAMPLES_DIR) in roles["view-builder"]["prompt"] and "finish_view" in roles["view-builder"]["prompt"]
    assert "view_pictures" in roles["view-reviewer"]["prompt"] and "finish_review" in roles["view-reviewer"]["prompt"]
    assert "WebFetch" in roles["view-builder"]["disallowedTools"], "the dev agent's web is off by default"


def test_the_finish_tools_stop_their_gate_when_their_caller_drops_the_call_and_main_lists_none_of_them_as_its_own():
    """A finish tool blocks while its gate runs and is cancelled when Claude Code closes the call of a stopped agent
    (tools.Spec.drop_stops, call_route's until_dropped, V6); each names only the job sessions that may call it."""
    for name, kinds in (("view_check", ("view", "review")), ("finish_view", ("view",)),
                        ("view_pictures", ("review",)), ("finish_review", ("review",))):
        spec = tools.REGISTRY[name]
        assert spec.drop_stops and spec.sessions == kinds, name
    assert all(n in tools.tool_sections() for n in ("view_check", "finish_view", "view_pictures", "finish_review"))
