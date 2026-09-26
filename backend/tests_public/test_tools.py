"""The registry of app.tools and its terminal path: the tool set and its roles, the call line every result starts with,
`read_ref` over the route, the MCP server instructions the shim carries (a short pointer from prompts/tools.md, since
Claude Code cuts them at 2 KB and main's prompt is the launcher's append), and the `GET /api/tools/holdings` route
behind the /thimble line. Nothing here runs the CLI. prompts/tools.md itself, where each tool's description and schema
live, is test_tools_md.py's.
"""
from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from app import agents, config, notebook, tools

CORPUS = "mini"


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


async def read_ref(ref: str):
    return await tools.call(CORPUS, "read_ref", {"ref": ref}, actor="analyst")


def _body(result) -> str:
    """A result's text after its first line, the call as run (`$ read_ref ref="type:report"`; tools.call_line)."""
    first, _, rest = result.text.partition("\n")
    assert first.startswith("$ "), result.text
    return rest


# ----------------------------------------------------------------------------- the registry

# The tool set, pinned on purpose: a new tool, or a tool renamed or removed, updates this list and its tests.
MERGED = ["read_ref", "list_cards", "add_card", "edit_card", "delete_card", "apply_label", "show_label", "set_filter",
          "clear_filter", "set_layout", "propose_view", "write_document", "edit_document", "add_comment", "resolve_comment",
          "reply_in_thread", "message_thread", "wait_session", "list_agents", "rename_thread", "delete_thread", "screenshot",
          "start_orientation", "start_writing", "critique", "message_orientation", "run_check", "stop_check", "file_dev_ticket"]
# what main lists: the merged set less critique, the orientation's check of its own analysis, which its session alone
# lists (critique_session.py)
MAIN = [n for n in MERGED if n != "critique"]
# message_orientation, run_check, stop_check, resolve_comment, message_thread, rename_thread, delete_thread and
# set_layout are main's alone, add_comment main's and a check's run's (comments.py), critique the orientation's alone
MAIN_ONLY = ("message_orientation", "run_check", "stop_check", "resolve_comment", "message_thread", "rename_thread", "delete_thread",
             "set_layout", "wait_session", "list_agents")
OTHERS = [n for n in MAIN if n not in (*MAIN_ONLY, "add_comment")]
# the retired names of the card tools and start_orientation: a call by one still reaches the tool, no listing shows it
RENAMED = {"add_cell": "add_card", "edit_cell": "edit_card", "delete_cell": "delete_card", "list_cells": "list_cards",
           "orient": "start_orientation"}


def test_the_analyst_gets_the_tools_of_the_merged_set():
    """Main's list is the tool set in its order, start_orientation, which starts the orientation's own session (orient_session.py), and
    start_writing, which starts a writer's (write_session.py). The orientation's session lists critique too, its check
    of its own analysis, which starts a critique's session and returns its list (critique_session.py); a writer's
    session, `writer:<doc>`, and a critique's list neither, and a check's run, `check:<id>:<doc>`, lists add_comment,
    as main does; run_check, stop_check and resolve_comment are main's. No session lists a permission tool: their
    requests reach the server through a hook
    (agent_session, permissions)."""
    assert [t["name"] for t in tools.list("analyst")] == MAIN
    assert [t["name"] for t in tools.list("analyst", session=tools.ORIENT_SESSION)] == [
        *(n for n in MERGED if n not in (*MAIN_ONLY, "add_comment"))]
    assert [t["name"] for t in tools.list("analyst", session="writer:report")] == OTHERS
    assert [t["name"] for t in tools.list("analyst", session="critique:orient")] == OTHERS
    check = [n for n in MERGED if n not in ("critique", *MAIN_ONLY)]
    assert [t["name"] for t in tools.list("analyst", session="check:unverified:report")] == check
    assert "ask_permission" not in tools.REGISTRY and not tools.known("ask_permission")
    for old, new in RENAMED.items():
        assert tools.known(old) and old not in tools.REGISTRY and tools.canonical(old) == new
        assert old not in {t["name"] for s in (None, tools.ORIENT_SESSION) for t in tools.list("analyst", s)}
    assert "orient" not in tools.ROLES
    assert "dev" not in tools.ROLES, "the dev worker is a Claude Code background session with its own tools"
    assert "writer" not in tools.ROLES
    assert tools.allowed_tools("analyst") == [f"mcp__thimble__{n}" for n in OTHERS]


async def test_a_call_by_a_tool_s_old_name_runs_the_tool_under_its_name_now():
    """A session given the retired names keeps calling them, and the calls run; the call line names the tool by its
    current name."""
    res = await tools.call(CORPUS, "list_cells", {"group": "nothing-here"})
    assert res.is_error and res.text.startswith('$ list_cards group="nothing-here"') and "list_cards: no group" in res.text


def test_a_delegated_tool_runs_its_modules_function():
    """A tool whose machinery belongs to another module runs `tool_<name>` of that module (the registry names the
    path). The names resolve, so no call ends in an AttributeError."""
    paths = {n: tools.REGISTRY[n].handler for n in ("write_document", "edit_document", "add_comment", "run_check", "reply_in_thread")}
    assert paths == {"write_document": "app.report_types:tool_write_document",
                     "edit_document": "app.report_types:tool_edit_document", "add_comment": "app.checks:tool_add_comment",
                     "run_check": "app.checks:tool_run_check", "reply_in_thread": "app.threads:tool_reply_in_thread"}
    for path in [*paths.values(), "app.views:tool_read_ref", "app.views:tool_screenshot", "app.report_types:tool_screenshot",
                 "app.threads:tool_screenshot"]:
        assert callable(tools._resolve(path)), path
    assert not hasattr(tools, "not_built"), "every tool is built, so no result says otherwise"


async def test_a_comment_comes_from_main_or_a_check_s_session(workspaces_tmp):
    """From main's shim add_comment is main's note, which needs a passage of a written document (comments.py); a
    writer's session comments nothing."""
    r = await tools.call(CORPUS, "add_comment", {"ref": "card:x", "text": "t"}, actor="analyst")
    assert r.is_error and "is no passage of a written document" in r.text, r.text
    r = await tools.call(CORPUS, "add_comment", {"ref": "card:x", "text": "t"}, actor="analyst", session="writer:report")
    assert r.is_error and tools.hint("add_comment-not-check") in r.text, r.text
    r = await tools.call(CORPUS, "screenshot", {"ref": "report:report#s1"}, actor="analyst")
    assert r.is_error and "no report yet" in r.text, r.text


def test_the_instructions_are_a_short_pointer_at_the_launcher():
    """The shim's MCP instructions are the `## instructions` section of prompts/tools.md: under Claude Code's 2 KB cut,
    naming the `thimble` command a session must be started with, with no slot to fill and no colon or semicolon outside
    its code spans."""
    text = tools.instructions()
    assert text == tools.hint(tools.INSTRUCTIONS_HINT).strip() and text
    assert len(text.encode("utf-8")) < 2048
    assert "`thimble`" in text and "{" not in text
    prose = re.sub(r"`[^`]*`", "", text)
    assert ":" not in prose and ";" not in prose


# ----------------------------------------------------------------------------- the call as run


def test_every_result_starts_with_the_call_as_run():
    """Every thimble tool's result is printed like a Bash command in Claude Code. The first line of
    every result is `$ <tool> k=v ...`, the arguments as given: strings quoted, JSON-escaped and cut to 80 chars,
    numbers and booleans as JSON, lists and objects as compact JSON, arguments that were not given left out."""
    long = "How many agents stalled over the run and why does it matter for the outcome here, in words?"
    line = tools.call_line("add_card", {"kind": "plot", "question": long, "code": "import x\nprint(1)", "limit": 30,
                                        "comment": True, "predicate": {"kind": "regex", "text": "a"}, "refs": ["a#L1", "b#L2"],
                                        "group": None})
    assert line == ('$ add_card kind="plot" question="' + long[:79] + '…" code="import x\\nprint(1)" limit=30 comment=true '
                    'predicate={"kind":"regex","text":"a"} refs=["a#L1","b#L2"]')
    assert len(long[:79] + "…") == tools.CALL_ARG_CHARS
    assert tools.call_line("list_cards", {}) == "$ list_cards" and tools.call_line("list_cards", None) == "$ list_cards"
    # ok and error results alike, the line ahead of the first text block; a result with no text block gets one
    res = tools.with_call_line("read_ref", {"ref": "card:ab"}, tools.err("read_ref: no cell ab"))
    assert res.is_error and res.text == '$ read_ref ref="card:ab"\nread_ref: no cell ab'
    res = tools.with_call_line("screenshot", {"ref": "http://127.0.0.1:1/"}, tools.ToolResult([{"type": "image", "data": "x", "mimeType": "image/png"}]))
    assert res.content[0] == {"type": "text", "text": '$ screenshot ref="http://127.0.0.1:1/"'} and res.content[1]["type"] == "image"


async def test_a_refused_call_carries_the_line_too(workspaces_tmp):
    r = await tools.call(CORPUS, "write_document", {"doc": "report"}, actor="dev", notebook=None)
    assert r.is_error and r.text == '$ write_document doc="report"\nunknown actor/role \'dev\'; one of analyst'
    with pytest.raises(KeyError):  # a retired name is unknown, as the route's 404 says
        await tools.call(CORPUS, "cells", {"group": "all"}, actor="analyst")


# ----------------------------------------------------------------------------- read_ref


async def test_read_ref_runs_over_the_route_with_the_cwd_mapped_to_the_workspace(client):
    """The shim's call: the cwd maps to the workspace. A chat is no ref (a thread is a fork of main, so nothing
    reads a chat's log), and read_chat is no tool."""
    body = {"args": {"ref": "events.jsonl#L1"}, "actor": "analyst", "cwd": str(config.corpus_dir(CORPUS) / "agents")}
    r = client.post("/api/tools/read_ref", json=body)
    assert r.status_code == 200 and not r.json()["is_error"]
    assert r.json()["content"][0]["text"].splitlines()[1].startswith("events.jsonl#L1 (")
    assert client.post("/api/tools/read_chat", json=body).status_code == 404, "a retired name is no tool"
    assert not hasattr(tools, "chat_lines") and not hasattr(tools, "_read_chat")


async def test_a_session_thimble_started_in_its_work_folder_reaches_its_workspace_over_the_route(client):
    """The orientation's process runs in its work folder, workspaces/<c>/orient/work (agent_session, the fence), and
    its shim sends that folder as its cwd, which lies in no corpus; the route maps it to the workspace whose folder
    holds it, for a session thimble started (THIMBLE_SESSION) alone."""
    work = config.workspace_dir(CORPUS) / "orient" / "work"
    work.mkdir(parents=True, exist_ok=True)
    body = {"args": {"ref": "events.jsonl#L1"}, "actor": "analyst", "cwd": str(work), "session": "orient"}
    r = client.post("/api/tools/read_ref", json=body)
    assert r.status_code == 200 and not r.json()["is_error"], r.text
    assert client.post("/api/tools/read_ref", json={**body, "session": None}).status_code == 400, "main's shim is not in it"
    assert config.workspace_for_folder(config.WORKSPACES_DIR / "no-such-corpus" / "orient") is None
    assert config.workspace_for_folder(config.corpus_dir(CORPUS)) is None


async def test_read_ref_on_a_document_type_returns_what_the_type_asks_its_writer_for(workspaces_tmp):
    from app import report_types

    r = await read_ref("type:report")
    assert not r.is_error and _body(r).splitlines()[0] == "type:report (Report, document)"
    assert report_types.type_form(report_types.read_type(CORPUS, "report")).strip() in r.text and "## " in r.text
    r = await read_ref("type:nope")
    assert r.is_error and "report" in r.text and "story" in r.text


async def test_read_ref_resolves_a_file_line_and_says_when_a_ref_does_not_resolve(workspaces_tmp):
    r = await read_ref("events.jsonl#L1")
    assert not r.is_error and _body(r).splitlines()[0].startswith("events.jsonl#L1 (")
    r = await read_ref("no-such-file.jsonl#L1")
    assert r.is_error and "does not resolve" in r.text
    assert (await read_ref("")).is_error


# ----------------------------------------------------------------------------- holdings and instructions


def test_holdings_counts_cards_labels_and_the_documents_present(workspaces_tmp):
    from app import agents, concepts, investigation, report_types

    assert tools.holdings(CORPUS) == {"workspace": CORPUS, "cards": 0, "labels": 0, "documents": [], "chats": 0,
                                      "text": "no cards, no labels, no documents"}
    # a chat counts once someone wrote in it; the /thimble command every session opens with, its reply and a chip do not
    agents.mirror(CORPUS, "user", by=agents.TERMINAL, text="/thimble:thimble")
    agents.mirror(CORPUS, "text", delta="thimble: http://127.0.0.1:8300/?ws=mini")
    agents.chip(CORPUS, "session", "terminal attached")
    agents.mirror(CORPUS, "user", by=agents.TERMINAL, text="/thimble fresh")
    assert tools.holdings(CORPUS)["chats"] == 0
    agents.mirror(CORPUS, "user", by=agents.BROWSER, text="what do the agents do?")
    assert tools.holdings(CORPUS)["chats"] == 1
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")["id"]
    for i in range(3):
        notebook.insert_cell(CORPUS, nb, notebook.new_cell("note", "terminal", f"n{i}", nb, payload={"text": "x"}))
    concepts.write_concept(ws, concepts.new_concept("rename", kind="regex", spec="rename"))
    h = tools.holdings(CORPUS)
    assert (h["cards"], h["labels"], h["documents"]) == (3, 1, []) and h["text"] == "3 cards, 1 label, no documents"
    report_types.doc_file(CORPUS, investigation.MAIN, "report").parent.mkdir(parents=True, exist_ok=True)
    report_types.doc_file(CORPUS, investigation.MAIN, "report").write_text(json.dumps({"title": "r", "sections": []}))
    assert tools.holdings(CORPUS)["text"] == "3 cards, 1 label, document report"
    report_types.doc_file(CORPUS, investigation.MAIN, "story").write_text(json.dumps({"title": "s", "scenes": []}))
    assert tools.holdings(CORPUS)["text"].endswith("documents report and story")
    assert tools._docs_phrase(["report", "story", "slides"]) == "documents report, story and slides"


def test_the_holdings_route_and_no_instructions_route(client):
    """/thimble's resume line reads GET /api/tools/holdings; the server has no instructions
    route."""
    cwd = str(config.corpus_dir(CORPUS) / "agents")
    r = client.get("/api/tools/holdings", params={"workspace": CORPUS})
    assert r.status_code == 200 and r.json() == tools.holdings(CORPUS)
    r = client.get("/api/tools/holdings", params={"cwd": cwd})
    assert r.status_code == 200 and r.json()["workspace"] == CORPUS
    r = client.get("/api/tools/holdings", params={"cwd": "/nowhere/at/all"})
    assert r.status_code == 400 and "/thimble" in r.json()["detail"]
    r = client.get("/api/tools/holdings", params={"workspace": "no-such-corpus"})
    assert r.status_code == 404
    assert client.get("/api/tools/instructions", params={"workspace": CORPUS}).status_code in (404, 405)


def test_the_shim_reads_its_instructions_from_disk_and_declares_the_channel():
    shim = (config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp").read_text()
    assert "/api/tools/instructions" not in shim and "tools.instructions()" in shim
    assert '"claude/channel"' in shim and "notifications/claude/channel" in shim and "THIMBLE_CHANNEL" in shim
    assert '"--instructions" in sys.argv[1:]' in shim


def test_the_loose_group_is_never_the_analysts_notebook(workspaces_tmp):
    # a card dragged out of every frame lands in the loose group, the newest analyst group with a card: new cards of the
    # analyst's still go to their own group
    from app import notebook

    ws = config.workspace_dir(CORPUS)
    mine = notebook.create_notebook(ws, "Your work", role="analyst", created_by="user")
    card = notebook.new_cell("note", "user", "q", mine["id"], payload={"text": "t"})
    notebook.insert_cell(CORPUS, mine["id"], card)
    other = notebook.new_cell("note", "user", "q2", mine["id"], payload={"text": "t"})
    notebook.insert_cell(CORPUS, mine["id"], other)
    notebook.move_cells(CORPUS, [other["id"]], None, pos={"x": 900, "y": 40})
    assert tools.analyst_notebook(CORPUS) == mine["id"]


async def test_the_session_s_question_frames_hang_in_one_root_and_a_thread_s_frame_is_never_adopted(workspaces_tmp):
    """Main's question frames are children of the one root analyst frame, Your work, beside Orientation; a thread's
    frame whose one card was the fork's (`terminal`) is never adopted as the session's notebook, and nothing is
    renamed."""
    ws = config.workspace_dir(CORPUS)
    final = tools.group_path(ws, "Orientation / Final")
    anchor = notebook.new_cell("note", "terminal", "q", final, payload={"text": "t"})
    notebook.insert_cell(CORPUS, final, anchor)
    frame = notebook.create_notebook(ws, "main/the-export-has-four", role="analyst", parent=final, anchor=anchor["id"], chat="t1")
    notebook.insert_cell(CORPUS, frame["id"], notebook.new_cell("note", "terminal", "fork's", frame["id"], payload={"text": "t"}))
    try:
        parents = []
        for title in ("Did the admin act alone?", "Grouping the message boards by round"):
            r = await tools.call(CORPUS, "add_card", {"kind": "note", "question": title, "text": "t", "group": title}, actor="analyst")
            assert not r.is_error, r.text
            made = next(g for g in notebook.list_notebooks(ws) if g["title"] == title)
            assert made.get("created_by") != "terminal", "a frame the session's add_card makes is not the session's notebook"
            parents.append(made["parent"])
        root = notebook.read_notebook(ws, parents[0])
        assert parents[0] == parents[1] and root["parent"] is None and root["title"] == "Your work" and root["role"] == "analyst"
        assert tools.terminal_notebook(CORPUS) == root["id"]
        kept = notebook.read_notebook(ws, frame["id"])
        assert kept["title"] == "main/the-export-has-four" and kept["role"] == "analyst" and not kept.get("created_by")
    finally:
        await notebook.shutdown_all()


def test_claim_cell_credits_a_subagent_s_card_and_keeps_the_kernel_it_ran_on(workspaces_tmp):
    """The mirror credits a card a subagent or a fork made to its chat; only a `terminal` stamp is replaced, a card in
    the orientation's deck keeps the kernel it ran on (the terminal's cards run on the deck's own, notebook._kernel_for),
    and an edit is claimed only while it is the one just read."""
    from datetime import datetime, timedelta, timezone

    from app import orientation

    ws = config.workspace_dir(CORPUS)
    groups = orientation.ensure_groups(CORPUS, deck=True)
    final = groups["orientation"]
    mine = notebook.new_cell("code", "terminal", "q", final, code="1")
    theirs = notebook.new_cell("note", "user", "q2", final, payload={"text": "t"})
    notebook.insert_cell(CORPUS, final, mine)
    notebook.insert_cell(CORPUS, final, theirs)
    before = notebook._kernel_for(notebook.read_notebook(ws, final), None, mine, ws)
    assert before == groups["orientation"], "the orientation's session's card runs on the deck's kernel"
    agents.claim_cell(CORPUS, mine["id"], "orient1")
    agents.claim_cell(CORPUS, theirs["id"], "orient1")
    agents.claim_cell(CORPUS, mine["id"], "other")
    nb = notebook.read_notebook(ws, final)
    got = {c["id"]: c for c in nb["cells"]}
    assert got[mine["id"]]["created_by"] == "chat:orient1" and got[theirs["id"]]["created_by"] == "user"
    assert notebook._kernel_for(nb, None, got[mine["id"]], ws) == before
    now = datetime.now(timezone.utc)
    got[mine["id"]]["edited"] = [{"by": "terminal", "ts": (now - timedelta(hours=1)).isoformat()}]
    notebook.write_notebook(ws, nb)
    agents.claim_cell(CORPUS, mine["id"], "orient1", edit=True)
    assert notebook.get_cell(CORPUS, mine["id"])["edited"][-1]["by"] == "terminal", "an old edit is not this call's"
    got[mine["id"]]["edited"].append({"by": "terminal", "ts": now.isoformat()})
    notebook.write_notebook(ws, nb)
    agents.claim_cell(CORPUS, mine["id"], "orient1", edit=True)
    assert notebook.get_cell(CORPUS, mine["id"])["edited"][-1]["by"] == "chat:orient1"
