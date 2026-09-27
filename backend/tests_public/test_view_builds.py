"""A view ticket's run (app/dev.py run_view) when the API is at capacity or the build fails. A turn that Claude Code
ended on `API Error: Repeated 529 Overloaded errors` is no attempt: the build waits on the schedule a session's retry
uses (30 s, 60 s, 120 s, 240 s, then 5 min four times) and wakes the same session, and the view is built with no Retry
click. When the API stays at capacity through every wait, the build stops and names the API's error, not a file the
gate found empty. A view the analyst asked for that fails keeps its failure, with Retry; the orientation's proposals,
which the analyst never asked for, start again in a new session told what failed, and one that still fails is dropped
from the proposals with one line in the orientation's thread. The background session is a stand-in that writes the
view's files; the view's reader runs in this process and its headless page is a stand-in too. The board is invented."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import agent_session, agents, config, dev, ledger, orientation, tools, views

CORPUS = "boards"
SCHEDULE = [30.0, 60.0, 120.0, 240.0, 300.0, 300.0, 300.0, 300.0]  # agent_session.retry_waits' defaults, 27.5 min
ERROR_529 = ("API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again "
             "in a moment.")
READER = '''
import json


def build_index(paths):
    return {"lines": {f"{p}#L{n}": json.loads(line)["body"] for p in paths for n, line in enumerate(open(p), 1)}}


def records(index, query):
    return [{"ref": r, "body": b} for r, b in index["lines"].items()]


def resolve(index, locator):
    ref = f"{locator.get('path')}#{locator.get('fragment')}"
    body = index["lines"].get(ref)
    return None if body is None else {"excerpt": body, "label": "a post", "refs": [ref], "key": None, "target": {"ref": ref}}
'''
HTML = """<!doctype html><html><body><div id="out"></div><script>
thimble.onOpen(async () => { document.getElementById('out').textContent = JSON.stringify(await thimble.fetch({})) })
</script></body></html>"""


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first post", "second post")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return corpus


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


async def test_a_view_build_at_capacity_waits_and_goes_on_without_a_retry(board, monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)
    monkeypatch.setattr(views, "build_problem", lambda: "")
    monkeypatch.setattr(dev, "_view_chat", lambda c, prop: None)

    async def page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 1, "refs": 2, "records": 2, "fetched_records": 2} for _ in states]

    monkeypatch.setattr(views, "shoot_states", page)
    waits: list[float] = []

    async def no_wait(s: float) -> None:
        waits.append(s)

    monkeypatch.setattr(dev, "_capacity_sleep", no_wait)
    turns: list[str | None] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append(resume)
        run.session, run.session_id = "s1", "session-1"
        if len(turns) < 4:
            return ERROR_529
        d = views.views_dir(CORPUS) / "posts"
        d.mkdir(parents=True, exist_ok=True)
        (d / "reader.py").write_text(READER)
        (d / "view.html").write_text(HTML)
        (d / "view.json").write_text(json.dumps({"name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                                                 "accepts": [{"form": "L<n>", "means": "a post"}], "declares": []}))
        return "The view is written."

    monkeypatch.setattr(dev, "_worker_turn", turn)
    views._save_proposals(CORPUS, [{"slug": "posts", "name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                                    "arrangement": "one post per page", "proposed_by": "analyst", "status": "queued",
                                    "ts": "2026-09-25T00:00:00+00:00"}])
    views._bind_loop()
    run = dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now())
    await dev.run_view(CORPUS, "posts", run)
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "built" and prop.get("attempts") == 1, prop
    assert waits == [30.0, 60.0, 120.0], "three capacity waits, more than the attempts a build has, then the view"
    assert turns == [None, "session-1", "session-1", "session-1"], "the same session is woken after each wait"
    assert views.read_built(CORPUS, "posts") is not None


def _stand_ins(monkeypatch) -> list[float]:
    """The reader and page stand-ins, no chat, and waits that are only recorded."""
    monkeypatch.setattr(views, "_runner", _inproc_run)
    monkeypatch.setattr(views, "build_problem", lambda: "")
    monkeypatch.setattr(dev, "_view_chat", lambda c, prop: None)

    async def page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 1, "refs": 2, "records": 2, "fetched_records": 2} for _ in states]

    monkeypatch.setattr(views, "shoot_states", page)
    waits: list[float] = []

    async def no_wait(s: float) -> None:
        waits.append(s)

    monkeypatch.setattr(dev, "_capacity_sleep", no_wait)
    monkeypatch.setattr(dev.SESSIONS, "stop", lambda short: None)
    return waits


def _queued(asked: bool = True) -> None:
    """The proposal `posts`: one the analyst asked for in main, or with `asked` off one of the orientation's."""
    views._save_proposals(CORPUS, [{"slug": "posts", "name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                                    "arrangement": "one post per page", "proposed_by": "analyst", "status": "queued",
                                    "ts": "2026-09-25T00:00:00+00:00", **({"asked": True} if asked else {})}])
    views._bind_loop()


def _orientation() -> str:
    """An orientation that has ended, whose thread a dropped proposal's line goes to; its chat's id."""
    chat = agents.new_agent(CORPUS, "orient", "Orientation")["id"]
    orientation._write_run(CORPUS, {"status": "done", "chats": {orientation.ROLE: chat}})
    return chat


def _lines(chat: str) -> list[str]:
    """The stage lines of a chat's log (dev.Log.stage), in order."""
    _, log = agents.paths(CORPUS, chat)
    recs = [json.loads(x) for x in log.read_text().splitlines() if x.strip()]
    return [r["delta"].strip()[2:] for r in recs if r.get("type") == "text" and r.get("delta", "").startswith("\n· ")]


def _write(files: dict[str, str]) -> None:
    d = views.views_dir(CORPUS) / "posts"
    d.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        (d / name).write_text(text)


VIEW_JSON = json.dumps({"name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                        "accepts": [{"form": "L<n>", "means": "a post"}], "declares": []})


@pytest.mark.parametrize("raised", [False, True])
async def test_a_build_the_api_stops_through_every_wait_fails_with_the_api_s_error(board, monkeypatch, raised):
    """The session had written view.json but not yet view.html when the API stopped answering. Once the waits are
    spent the build stops at once, without the attempts left, and its failure names the API's error rather than the
    empty view.html the gate found. The error reaches the build either as the turn's last text or as the session's
    failure (SessionError)."""
    waits = _stand_ins(monkeypatch)
    turns: list[str | None] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append(resume)
        run.session, run.session_id = "s1", "session-1"
        d = views.views_dir(CORPUS) / "posts"
        d.mkdir(parents=True, exist_ok=True)
        (d / "view.json").write_text(json.dumps({"name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                                                 "accepts": [], "declares": []}))
        (d / "reader.py").write_text(READER)
        (d / "view.html").write_text("")
        if raised:
            raise dev.SessionError(f"the background session ended failed: {ERROR_529}")
        return ERROR_529

    monkeypatch.setattr(dev, "_worker_turn", turn)
    _queued()
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "failed"
    assert waits == SCHEDULE, "as long as a session thimble starts would wait, not four minutes"
    assert turns == [None] + ["session-1"] * len(SCHEDULE)
    assert prop["error"].startswith("Anthropic's API was overloaded each time the build tried over 28 min"), prop["error"]
    assert "Repeated 529 Overloaded errors" in prop["error"] and "view.html" not in prop["error"]


async def test_the_capacity_schedule_starts_afresh_after_a_turn_that_worked_a_while(board, monkeypatch):
    """A session's retry starts a new streak when its process ran longer than agent_session.RETRY_MAX_S before it
    failed again; a view build's turn follows the same rule, so a long build that meets two overloads apart gets the
    whole schedule for the second."""
    waits = _stand_ins(monkeypatch)
    monkeypatch.setattr(dev, "_retry_streak_s", lambda: 0.0)  # every turn counts as one that worked a while
    turns: list[str | None] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append(resume)
        run.session, run.session_id = "s1", "session-1"
        if len(turns) < 4:
            return ERROR_529
        _write({"reader.py": READER, "view.html": HTML, "view.json": VIEW_JSON})
        return "The view is written."

    monkeypatch.setattr(dev, "_worker_turn", turn)
    _queued()
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    assert views.read_proposal(CORPUS, "posts")["status"] == "built"
    assert waits == [30.0, 30.0, 30.0], "each overload after a long turn waits the schedule's first wait again"


async def test_a_turn_the_session_ends_itself_is_an_attempt_and_its_checks_say_why(board, monkeypatch):
    waits = _stand_ins(monkeypatch)
    turns: list[str | None] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append(resume)
        run.session, run.session_id = "s1", "session-1"
        d = views.views_dir(CORPUS) / "posts"
        d.mkdir(parents=True, exist_ok=True)
        (d / "view.json").write_text(json.dumps({"name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                                                 "accepts": [], "declares": []}))
        (d / "reader.py").write_text(READER)
        (d / "view.html").write_text("")
        return "I wrote the view."

    monkeypatch.setattr(dev, "_worker_turn", turn)
    _queued()
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "failed" and waits == [] and len(turns) == dev.MAX_ATTEMPTS
    assert "view.html is empty" in prop["error"], prop["error"]


async def test_an_orientation_s_proposal_that_keeps_failing_repairs_itself_then_is_dropped_quietly(board, monkeypatch):
    """The analyst never asked for the orientation's view, so a failure shows nowhere: when its attempts run out, a new
    session starts from the ticket with what failed, VIEW_REPAIRS times, and when that fails too the proposal is
    dropped, its draft folder removed, `view {dropped}` sent, and one line added to the orientation's thread. Main gets
    no chip and the row keeps no `failed`."""
    _stand_ins(monkeypatch)
    orient = _orientation()
    events: list[tuple] = []
    monkeypatch.setattr(views, "_emit", lambda c, slug, status, **kw: events.append((slug, status)))
    chips: list[tuple] = []
    monkeypatch.setattr(agents, "chip", lambda c, kind, text, **kw: chips.append((kind, text)))
    turns: list[tuple[str | None, str]] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append((resume, prompt))
        run.session, run.session_id = f"s{len(turns)}", f"session-{len(turns)}"
        _write({"view.json": VIEW_JSON, "reader.py": READER, "view.html": ""})
        return "I wrote the view."

    monkeypatch.setattr(dev, "_worker_turn", turn)
    _queued(asked=False)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "dropped" and "view.html is empty" in prop["error"], prop
    assert len(turns) == dev.MAX_ATTEMPTS * (1 + dev.VIEW_REPAIRS)
    starts = [i for i, (resume, _) in enumerate(turns) if resume is None]
    assert starts == [0, dev.MAX_ATTEMPTS, 2 * dev.MAX_ATTEMPTS], "each repair is a new session"
    for i in starts[1:]:
        prompt = turns[i][1]
        assert prompt.startswith(dev.build_view_prompt(CORPUS, prop, views.views_dir(CORPUS) / "posts", config.corpus_dir(CORPUS)))
        assert "did not pass" in prompt and "view.html is empty" in prompt, "the new session is told what failed"
    assert not (views.views_dir(CORPUS) / "posts").exists(), "the draft goes with the proposal"
    assert ("posts", "dropped") in events and ("posts", "failed") not in events
    assert chips == [], "nothing in main"
    line = _lines(orient)[-1]
    assert line.startswith("The view Posts could not be built, so it was left out of the proposals: ") and "view.html is empty" in line


async def test_an_orientation_s_proposal_is_built_by_its_repair(board, monkeypatch):
    """The first session fails its checks every time and never recovers; the repair's new session writes the view."""
    _stand_ins(monkeypatch)
    orient = _orientation()
    turns: list[str | None] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append(resume)
        run.session, run.session_id = f"s{len(turns)}", f"session-{len(turns)}"
        _write({"view.json": VIEW_JSON, "reader.py": READER, "view.html": HTML if resume is None and len(turns) > 1 else ""})
        return "I wrote the view."

    monkeypatch.setattr(dev, "_worker_turn", turn)
    _queued(asked=False)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    assert views.read_proposal(CORPUS, "posts")["status"] == "built"
    assert len(turns) == dev.MAX_ATTEMPTS + 1 and turns[-1] is None
    assert views.read_built(CORPUS, "posts") is not None
    assert not [x for x in _lines(orient) if "could not be built" in x]


async def test_an_orientation_s_build_whose_session_fails_starts_again_rather_than_giving_up(board, monkeypatch):
    """A session that ends failed for a reason of its own (not the API at capacity) left the build with nothing to
    wake; for the orientation's proposal a new session starts at once, told the session's error."""
    _stand_ins(monkeypatch)
    _orientation()
    turns: list[tuple[str | None, str]] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append((resume, prompt))
        run.session, run.session_id = "s1", "session-1"
        if len(turns) == 1:
            raise dev.SessionError("the background session ended failed: it hit its turn limit")
        _write({"view.json": VIEW_JSON, "reader.py": READER, "view.html": HTML})
        return "The view is written."

    monkeypatch.setattr(dev, "_worker_turn", turn)
    _queued(asked=False)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    assert views.read_proposal(CORPUS, "posts")["status"] == "built"
    assert [r for r, _ in turns] == [None, None] and "it hit its turn limit" in turns[1][1]


async def test_an_orientation_s_build_the_api_stops_through_every_wait_is_dropped_without_a_repair(board, monkeypatch):
    """A new session cannot help while the API is at capacity, so the build is dropped once the schedule is spent, and
    the orientation's line names the API rather than Retry, which the analyst has nowhere to press."""
    waits = _stand_ins(monkeypatch)
    orient = _orientation()
    turns: list[str | None] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append(resume)
        run.session, run.session_id = "s1", "session-1"
        return ERROR_529

    monkeypatch.setattr(dev, "_worker_turn", turn)
    _queued(asked=False)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    assert views.read_proposal(CORPUS, "posts")["status"] == "dropped"
    assert waits == SCHEDULE and turns.count(None) == 1
    line = _lines(orient)[-1]
    assert line.endswith("Anthropic's API was overloaded each time the build tried over 28 min") and "Retry" not in line


async def test_a_view_the_analyst_asks_for_is_built_in_a_dev_thread_of_main_s(board, monkeypatch):
    """The analyst's view is announced in main as a dev ticket is (an `agent` record of role dev) and its chat is marked
    `asked`; the orientation's proposal gets a chat with no row in main. When the analyst later asks for a change to
    the orientation's view, its build's chat becomes their dev thread then."""
    agents.ensure_main(CORPUS)
    _, main_log = agents.paths(CORPUS, agents.MAIN_ID)

    def announced() -> list[dict]:
        return [r for r in map(json.loads, main_log.read_text().splitlines()) if r.get("type") == "agent"]

    mine = dev._view_chat(CORPUS, {"slug": "posts", "name": "Posts", "asked": True})
    meta = agents.read_meta(CORPUS, mine)
    assert meta["role"] == "dev" and meta["view"] == "posts" and meta["asked"] is True
    assert [(r["chat"], r["role"]) for r in announced()] == [(mine, "dev")]
    theirs = dev._view_chat(CORPUS, {"slug": "threads", "name": "Threads"})
    assert not agents.read_meta(CORPUS, theirs).get("asked") and len(announced()) == 1
    again = dev._view_chat(CORPUS, {"slug": "threads", "name": "Threads", "chat": theirs, "asked": True})
    assert again == theirs and agents.read_meta(CORPUS, theirs)["asked"] is True
    assert [(r["chat"], r["role"]) for r in announced()] == [(mine, "dev"), (theirs, "dev")]


def test_a_change_s_stage_line_reads_a_filed_title_as_its_first_sentence():
    assert dev._one_line("Day Counts: add a total column\n\nThe rows need\na total.") == \
        "Day Counts: add a total column. The rows need a total."
    assert dev._one_line("Why? Because.\n\n") == "Why? Because."


def test_only_an_api_error_line_is_a_capacity_failure():
    assert dev.capacity_failure(ERROR_529) == dev.CAPACITY_WORDS["overloaded"]
    assert dev.capacity_failure("the background session ended failed: API Error: 429 rate limited") != ""
    assert dev.capacity_failure("The page was overloaded with dots, so I grouped them.") == ""
    assert dev.capacity_failure("") == ""


def test_a_view_build_s_session_may_read_the_corpus_but_not_change_it(board, monkeypatch):
    """The session runs in the corpus folder with Edit and Bash allowed, so its flags deny edits in the corpus and in
    the worked examples, and put Bash in the sandbox with no network where it can run, beside the dev role's fast
    mode, with its check command the one command run outside the sandbox; the prompt names that same command. A code
    ticket's session, in its own worktree, gets none of it."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setattr(config, "models_for", lambda c=None, settings=None: {"dev": {"model": "claude-opus-4-8", "fast": True}})
    corpus = config.corpus_dir(CORPUS)
    folder = views.views_dir(CORPUS) / "posts"
    flags = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), dev.view_fence(CORPUS, "posts", corpus, folder))
    settings = json.loads(flags[flags.index("--settings") + 1])
    assert settings["permissions"]["deny"] == [f"Edit(/{corpus}/**)", f"Edit(/{views.EXAMPLES_DIR}/**)"]
    box = settings["sandbox"]
    assert box["network"] == {"deniedDomains": ["*"]} and not box["allowUnsandboxedCommands"]
    check = dev.view_check_command(CORPUS, "posts")
    assert box["excludedCommands"] == [check, f"{check} *"] and check.endswith(f"/api/ws/{CORPUS}/views/posts/check")
    assert settings["fastMode"] is True and "Read" in flags[flags.index("--allowedTools") + 1].split(",")
    prompt = dev.build_view_prompt(CORPUS, {"slug": "posts", "name": "Posts", "claims": ["board.jsonl"]}, folder, corpus)
    assert f"`{check} '<ref>'`" in prompt and "curl" not in prompt
    code = dev.Sessions()._flags(CORPUS, "thimble ticket 1: x")
    assert json.loads(code[code.index("--settings") + 1]) == {"fastMode": True}, "a code ticket is not fenced"
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    assert "sandbox" not in dev.read_only_fence([corpus]), "no sandbox where it cannot run; the deny stays"
    inside = corpus / ".thimble" / "views" / "posts"
    assert dev.view_read_only(corpus, inside) == (views.EXAMPLES_DIR,), "a corpus that holds the view's folder is left out"


def test_a_dev_session_has_the_default_tools_less_mcp_servers_and_the_later_turn_tools(board, monkeypatch):
    """A view build's or a code ticket's session names no tool set, so it has every tool of a default Claude Code
    session. It gets no MCP server, since its task needs none of the analyst's, and not the tools that schedule a later
    turn, since the session is stopped once its turn ends. A fenced session, a view build in the corpus folder, also gets
    no EnterWorktree, which would write a worktree into that folder past the fence's denies, and none of the tools that
    wait for an answer nobody gives there. A session with no workspace has nobody to ask, so what it does in its
    folders, skills and workflows are allowed and it has no web tools (test_web_permissions has a hosted session's)."""
    from app import agent_session

    monkeypatch.setattr(config, "models_for", lambda c=None, settings=None: {"dev": {"model": "claude-opus-4-8", "fast": False}})
    flags = dev.Sessions()._flags(None, "thimble ticket 1: x")
    assert "--tools" not in flags
    assert flags[flags.index("--allowedTools") + 1].split(",") == dev.UNHOSTED_TOOLS
    assert flags[flags.index("--disallowedTools") + 1].split(",") == [*agent_session.LATER_TOOLS, *agent_session.WEB_TOOLS]
    assert "--strict-mcp-config" in flags and flags[flags.index("--permission-mode") + 1] == "default"
    fenced = dev.Sessions()._flags(CORPUS, "thimble view: x", fence=dev.read_only_fence([Path("/corpus")]),
                                   asking={"key": "view:x", "allow": []})
    assert fenced[fenced.index("--disallowedTools") + 1].split(",") == \
        [*agent_session.LATER_TOOLS, "EnterWorktree", "ExitWorktree", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]


def test_the_view_check_posts_its_locators_to_a_view_s_check_route_on_localhost_only(capsys):
    """view_check.py, the one command a fenced view build runs outside the sandbox: it posts its arguments as the
    locators and prints the answer, and refuses any URL that is not a view's check route on 127.0.0.1."""
    import http.server
    import threading

    from app import view_check

    got: list[dict] = []

    class Route(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            got.append({"path": self.path, "body": json.loads(self.rfile.read(int(self.headers["Content-Length"])))})
            out = json.dumps({"ok": True, "lines": ["ok  board.jsonl#L1"]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Route)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/api/ws/{CORPUS}/views/posts/check"
        assert view_check.main([url, "board.jsonl#L1", "view:posts/p2"]) == 0
        assert got == [{"path": f"/api/ws/{CORPUS}/views/posts/check", "body": {"locators": ["board.jsonl#L1", "view:posts/p2"]}}]
        assert json.loads(capsys.readouterr().out)["ok"] is True
        for bad in ("http://example.com/api/ws/a/views/b/check", f"http://127.0.0.1:{server.server_port}/api/ws/a/labels",
                    f"{url}?x=1", "file:///etc/passwd"):
            assert view_check.main([bad, "x"]) == 2, bad
        assert len(got) == 1
    finally:
        server.shutdown()


async def test_run_view_starts_its_session_with_the_corpus_fenced(board, monkeypatch):
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setattr(views, "build_problem", lambda: "")
    monkeypatch.setattr(dev, "_view_chat", lambda c, prop: None)
    seen: list[dict] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        seen.append(kw["fence"])
        run.session, run.session_id = "s1", "session-1"
        raise dev.SessionError("the background session ended failed: stopped")

    monkeypatch.setattr(dev, "_worker_turn", turn)
    _queued()
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    folder = views.views_dir(CORPUS) / "posts"
    assert seen == [dev.view_fence(CORPUS, "posts", config.corpus_dir(CORPUS), folder)]
    assert seen[0]["permissions"]["deny"][0] == f"Edit(/{config.corpus_dir(CORPUS)}/**)"


async def test_a_change_whose_session_cannot_start_fails_and_leaves_the_view_as_it_was(board, monkeypatch):
    """A change asked in the view build's thread (views.message) whose session cannot start is no built change: the
    view's folder still holds the view as it was, which passes its checks, so the run fails with the session's error
    and the view stays as it was, rather than reporting the change built."""
    _stand_ins(monkeypatch)
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: None)
    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: False)
    views._bind_loop()
    views.write_view(CORPUS, "posts", name="Posts", why="one post at a time", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "a post"}], declares=[], reader=READER, html=HTML)
    views.message(CORPUS, "posts", "Put the newest post first")
    assert views.read_proposal(CORPUS, "posts")["changed"] is True

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        raise RuntimeError("the dev agent's session could not start")

    monkeypatch.setattr(dev, "_worker_turn", turn)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "built" and "could not start" in (prop.get("error") or ""), prop
    assert not prop.get("changed") and not prop.get("change")
    assert views.read_built(CORPUS, "posts")["why"] == "one post at a time"


BUILT_AT = "2026-09-01T00:00:00+00:00"
CHANGE = "Put the newest post first"
NEW_HTML = HTML.replace('<div id="out">', '<div id="out" class="newest-first">')


def _built_with_change(monkeypatch) -> str:
    """The view `posts`, built at BUILT_AT, with CHANGE asked in its build's thread (views.message) and not yet run;
    the build's chat's id. Runs are not queued, so the test runs the change itself."""
    agents.ensure_main(CORPUS)
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: None)
    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: False)
    views._bind_loop()
    views.write_view(CORPUS, "posts", name="Posts", why="one post at a time", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "a post"}], declares=[], reader=READER, html=HTML)
    vj = views.views_dir(CORPUS) / "posts" / views.VIEW_JSON
    vj.write_text(json.dumps({**json.loads(vj.read_text()), "built": BUILT_AT}))
    chat = agents.new_agent(CORPUS, "dev", "view: Posts", view="posts", announce=True, asked=True)["id"]
    views._save_proposals(CORPUS, [{"slug": "posts", "name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                                    "arrangement": "one post per page", "proposed_by": "analyst", "status": "built",
                                    "asked": True, "chat": chat, "ts": "2026-09-25T00:00:00+00:00"}])
    views.message(CORPUS, "posts", CHANGE)
    return chat


def _gates(monkeypatch) -> list[str]:
    """The gate, run as it is, with each run recorded."""
    seen: list[str] = []
    real = views.gate

    async def gate(c, slug, locators=None, **kw):
        seen.append(slug)
        return await real(c, slug, locators, **kw)

    monkeypatch.setattr(views, "gate", gate)
    return seen


async def test_a_change_the_api_stops_through_every_wait_fails_with_retry_and_leaves_the_view_as_built(board, monkeypatch):
    """A change whose every turn Claude Code ends on `API Error: Repeated 529` is not checked against the view as it
    was, which passes: the build waits the whole schedule, waking the same session to carry on after each wait, then
    fails. The view is as it was, `built` is not stamped again, the build's thread ends failed rather than done, main
    gets the failure's chip, and Retry changes the view again with the same request."""
    real_chat = dev._view_chat
    waits = _stand_ins(monkeypatch)
    monkeypatch.setattr(dev, "_view_chat", real_chat)
    chips: list[tuple] = []
    monkeypatch.setattr(agents, "chip", lambda c, kind, text, **kw: chips.append((kind, text, kw.get("status"))))
    chat = _built_with_change(monkeypatch)
    gates = _gates(monkeypatch)
    turns: list[tuple[str | None, str]] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append((resume, prompt))
        run.session, run.session_id = "s1", "session-1"
        return ERROR_529

    monkeypatch.setattr(dev, "_worker_turn", turn)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "built" and not prop.get("changed") and not prop.get("revision"), prop
    assert prop["error"].startswith("Anthropic's API was overloaded each time the build tried over 28 min"), prop["error"]
    assert prop["failed_change"] == CHANGE
    assert gates == [], "the view as it was is never taken for the change"
    assert waits == SCHEDULE and len(turns) == 1 + len(SCHEDULE)
    retry = tools.hint(agent_session.RETRY_PROMPT)
    assert retry and all(r == "session-1" and p == retry for r, p in turns[1:]), "each wake carries on"
    assert views.read_built(CORPUS, "posts")["built"] == BUILT_AT, "built is not stamped again"
    assert agents.read_meta(CORPUS, chat)["status"] == "failed"
    assert [(k, s) for k, _, s in chips] == [("ticket", "failed")] and "Retry goes on from there" in chips[0][1]
    queued: list[str] = []
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: queued.append(slug))
    again = views.retry(CORPUS, "posts")
    assert (again["status"], again["change"], again["changed"], again["asked"]) == ("queued", CHANGE, True, True)
    assert "failed_change" not in views.read_proposal(CORPUS, "posts") and queued == ["posts"]


async def test_a_change_the_api_cuts_short_is_built_once_the_session_changes_the_view(board, monkeypatch):
    """Two turns end on the API's error, with the view as it was; after the waits the same session carries on and
    changes the view, which is built then, and not before."""
    waits = _stand_ins(monkeypatch)
    _built_with_change(monkeypatch)
    gates = _gates(monkeypatch)
    turns: list[str] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append(prompt)
        run.session, run.session_id = "s1", "session-1"
        if len(turns) < 3:
            return ERROR_529
        _write({"view.html": NEW_HTML})
        return "The newest post comes first."

    monkeypatch.setattr(dev, "_worker_turn", turn)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "built" and not prop.get("error") and not prop.get("failed_change"), prop
    assert waits == [30.0, 60.0] and gates == ["posts"], "one check, after the turn that ended well"
    assert "newest-first" in (views.views_dir(CORPUS) / "posts" / views.VIEW_HTML).read_text()
    assert views.read_built(CORPUS, "posts")["built"] != BUILT_AT


async def test_a_change_whose_session_ends_its_turn_with_the_view_unchanged_fails_with_its_words(board, monkeypatch):
    """A turn that ended well but left the view's files as they were built is no built change: the build fails at once
    with the session's own words, rather than reporting the change built."""
    waits = _stand_ins(monkeypatch)
    _built_with_change(monkeypatch)
    turns: list[str] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        turns.append(prompt)
        run.session, run.session_id = "s1", "session-1"
        return "The board already lists the newest post first."

    monkeypatch.setattr(dev, "_worker_turn", turn)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "built" and prop["failed_change"] == CHANGE, prop
    assert prop["error"] == f"{dev.UNCHANGED_LINE}: The board already lists the newest post first."
    assert len(turns) == 1 and waits == []
    assert views.read_built(CORPUS, "posts")["built"] == BUILT_AT


def test_the_view_s_digest_leaves_out_the_built_stamp_and_its_subfolders(tmp_path):
    d = tmp_path / "v"
    (d / "cache").mkdir(parents=True)
    (d / "view.json").write_text(json.dumps({"name": "Posts", "built": "a"}))
    (d / "reader.py").write_text(READER)
    first = views.view_digest(d)
    (d / "view.json").write_text(json.dumps({"built": "b", "name": "Posts"}))
    (d / "cache" / "index.json").write_text("{}")
    assert views.view_digest(d) == first
    (d / "reader.py").write_text(READER + "\n# newest first\n")
    assert views.view_digest(d) != first


def _app() -> FastAPI:
    a = FastAPI()
    a.include_router(views.router, prefix="/api")
    a.include_router(ledger.router, prefix="/api")
    return a


async def test_a_build_a_stop_interrupted_is_queued_again_after_fresh_and_resume_in_one_server(board, monkeypatch):
    """`/thimble fresh`, then `/thimble restore` of that archive, in one server process: the fresh workspace's views
    are listed in between, and the restored proposal a server stop left building is queued again the next time the
    proposals are listed, its session stopped first, and once only."""
    stopped: list[str] = []
    monkeypatch.setattr(dev.SESSIONS, "stop", lambda short: stopped.append(short))
    views._save_proposals(CORPUS, [{"slug": "posts", "name": "Posts", "why": "w", "claims": ["board.jsonl"],
                                    "arrangement": "one post per page", "proposed_by": "analyst", "status": "building",
                                    "asked": True, "session": "s1", "session_id": "session-1",
                                    "ts": "2026-09-25T00:00:00+00:00"}])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://t", timeout=60) as client:
        archived = (await client.post(f"/api/ws/{CORPUS}/archive")).json()["archived"]
        assert (await client.get(f"/api/ws/{CORPUS}/views/proposals")).json() == []
        r = await client.post(f"/api/ws/{CORPUS}/restore", json={"archive": Path(archived).name})
        assert r.status_code == 200, r.text
        rows = (await client.get(f"/api/ws/{CORPUS}/views/proposals")).json()
        assert [p["status"] for p in rows] == ["building"]
        assert dev._view_queue == [(CORPUS, "posts")] and stopped == ["s1"]
        await client.get(f"/api/ws/{CORPUS}/views/proposals")
    assert dev._view_queue == [(CORPUS, "posts")] and stopped == ["s1"], "queued once"


async def test_archiving_a_workspace_stops_its_builds_and_restoring_it_builds_them_again(board, monkeypatch):
    """A build running when the workspace is archived is stopped and waited for before the folder moves, its proposal
    left `building`, so the restored archive builds it again."""
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    runs: list[str] = []

    async def run_view(c, slug, run):
        views.update_proposal(c, slug, status="building")
        runs.append(slug)
        await asyncio.Event().wait()

    monkeypatch.setattr(dev, "run_view", run_view)
    _queued()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://t", timeout=60) as client:
        await client.get(f"/api/ws/{CORPUS}/views/proposals")
        await asyncio.sleep(0)
        assert runs == ["posts"] and (CORPUS, "posts") in dev._view_runs
        archived = (await client.post(f"/api/ws/{CORPUS}/archive")).json()["archived"]
        assert not dev._view_runs and not dev._view_stopping and not dev._view_queue
        assert json.loads((Path(archived) / "views" / views.PROPOSALS_FILE).read_text())[0]["status"] == "building"
        await client.post(f"/api/ws/{CORPUS}/restore", json={"archive": Path(archived).name})
        await client.get(f"/api/ws/{CORPUS}/views/proposals")
        await asyncio.sleep(0)
        assert runs == ["posts", "posts"] and (CORPUS, "posts") in dev._view_runs
        await dev.stop_views(CORPUS)


def test_a_build_that_is_winding_down_is_not_queued_again(board, monkeypatch):
    """Between stop_view and the end of its task (a dismissed change puts the view back only then), the proposal still
    reads building; the proposals route leaves it alone."""
    monkeypatch.setattr(dev.SESSIONS, "stop", lambda short: None)
    views._save_proposals(CORPUS, [{"slug": "posts", "name": "Posts", "why": "w", "claims": ["board.jsonl"],
                                    "arrangement": "a", "proposed_by": "analyst", "status": "building",
                                    "ts": "2026-09-25T00:00:00+00:00"}])
    dev._view_stopping[(CORPUS, "posts")] = dev.Run(ticket_id="view:posts", title="Posts", ts_start="")
    dev.recover_views(CORPUS)
    assert dev._view_queue == []
    del dev._view_stopping[(CORPUS, "posts")]
    dev.recover_views(CORPUS)
    assert dev._view_queue == [(CORPUS, "posts")]


async def test_a_review_revision_wakes_the_build_session_and_passes_once_the_view_passes_its_checks(board, monkeypatch):
    """The view review's revision (dev.review_revision): the build's session is woken with the review's message, the
    view's checks run after its turn, and what they find goes back to it; a view that still fails after MAX_ATTEMPTS
    turns is a failed revision with the checks' first failure. Its session asks on the view's chat as a build's does. A
    built view is reviewed after its build."""
    _stand_ins(monkeypatch)
    chat = str(agents.new_agent(CORPUS, "dev", "view: Posts", view="posts", announce=False)["id"])
    monkeypatch.setattr(dev, "_view_chat", lambda c, prop: chat)
    _queued()
    _write({"reader.py": READER, "view.html": HTML, "view.json": VIEW_JSON})
    views.mark_built(CORPUS, "posts")
    views.update_proposal(CORPUS, "posts", session="s1", session_id="session-1")
    prompts_seen: list[tuple[str | None, str]] = []

    async def turn(run, run_log, corpus, prompt, resume, **kw):
        prompts_seen.append((resume, prompt))
        run.session, run.session_id = "s1", "session-1"
        assert kw["turn_timeout_s"] == dev.REVIEW_TURN_TIMEOUT_S
        assert kw["asking"]["key"] == dev.view_key("posts") and agent_session.asker(CORPUS, dev.view_key("posts"))
        # the first turn breaks the page, the second fixes it
        _write({"view.html": "" if len(prompts_seen) == 1 else HTML.replace("out", "posts")})
        return "fixed"

    monkeypatch.setattr(dev, "_worker_turn", turn)
    ok, text = await dev.review_revision(CORPUS, "posts", "## A review of the view\n\n- picture 1: cut off")
    assert ok and text == "fixed"
    assert prompts_seen[0] == ("session-1", "## A review of the view\n\n- picture 1: cut off")
    assert prompts_seen[1][0] == "session-1" and "view.html is empty" in prompts_seen[1][1]
    assert agent_session.asker(CORPUS, dev.view_key("posts")) is None, "its requests are answered only while it runs"

    async def broken(run, run_log, corpus, prompt, resume, **kw):
        _write({"view.html": ""})
        return "done"

    monkeypatch.setattr(dev, "_worker_turn", broken)
    ok, why = await dev.review_revision(CORPUS, "posts", "fix it")
    assert not ok and why == "problem: view.html is empty"

    reviewed: list[str] = []
    from app import view_review

    monkeypatch.setattr(view_review, "after_built", lambda c, slug: reviewed.append(slug))

    async def builds(run, run_log, corpus, prompt, resume, **kw):
        run.session, run.session_id = "s1", "session-1"
        _write({"reader.py": READER, "view.html": HTML, "view.json": VIEW_JSON})
        return "built"

    monkeypatch.setattr(dev, "_worker_turn", builds)
    views.update_proposal(CORPUS, "posts", status="queued", session_id=None)
    await dev.run_view(CORPUS, "posts", dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now()))
    assert reviewed == ["posts"]
