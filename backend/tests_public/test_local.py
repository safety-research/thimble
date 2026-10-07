"""thimble's backend without its server (app/local.py): in a terminal-mode workspace every tool runs in the calling
process and opens no socket; a folder of no workspace and a browser-mode workspace are refused; `thimble state` gives
the JSON the server's GET routes give and `thimble act` makes the changes its POST routes make; a process that lost its
environment does nothing; and the MCP shim in terminal mode keeps fd 1 for its stream and subscribes to nothing."""
from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from app import cardrun, config, local, notebook, tools

CORPUS = "mini"
BACKEND = Path(__file__).resolve().parents[1]


def _mode(mode: str, c: str = CORPUS) -> Path:
    ws = config.workspace_dir(c)
    (ws / "trusted").mkdir(exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": mode}))
    return ws


@pytest.fixture()
def term(workspaces_tmp, mini_dir, monkeypatch) -> Path:
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    _mode("terminal")
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    yield mini_dir
    cardrun.CardWatch.stop_all()
    local._started.clear()


async def call(corpus: Path, tool: str, **args: Any) -> dict:
    return await local.call(tool, args, cwd=str(corpus))


def text(res: dict) -> str:
    return "\n".join(b.get("text", "") for b in res["content"] if b.get("type") == "text")


@pytest.fixture()
def no_sockets(monkeypatch):
    """A socket that connects, binds or listens fails the test: an in-process call reaches no server and starts no
    kernel. The event loop's own socket pair is made before this, with no connect."""
    opened: list[str] = []

    def refuse(name):
        def fn(self, *a, **k):
            opened.append(f"{name} {a!r}")
            raise AssertionError(f"socket.{name} {a!r}")
        return fn

    for name in ("connect", "connect_ex", "bind", "listen"):
        monkeypatch.setattr(socket.socket, name, refuse(name))
    return opened


def _args(c: str, corpus: Path) -> dict[str, dict]:
    """A call of every tool of prompts/tools.md, each with the arguments it takes."""
    return {
        "read_ref": {"ref": "board.jsonl#L1"},
        "list_cards": {"group": "all"},
        "add_card": {"question": "What is this corpus?", "kind": "note", "text": "A small synthetic corpus."},
        "edit_card": {"card": "card:nope", "question": "?"},
        "delete_card": {"card": "card:nope"},
        "apply_label": {"scope": "files", "name": "bash", "predicate": {"kind": "regex", "text": "Bash"},
                        "paths": ["agents/*.jsonl"]},
        "show_label": {"name": "bash", "on": True},
        "delete_label": {"name": "nope"},
        "set_filter": {"scope": "files", "label": "bash"},
        "clear_filter": {"scope": "files"},
        "set_layout": {"layout": "one", "surfaces": ["files"]},
        "open_view": {"view": "nope"},
        "propose_view": {"name": "Board", "why": "w", "claims": ["board.jsonl"], "unit": "a post", "overview": "o",
                         "zoom": "z", "filter": "f", "details": "d"},
        "write_document": {"doc": "report", "text": "# Report\n\n## What this data is and what we analyzed\n\nPosts."},
        "edit_document": {"span": "report:report#nope", "text": "x"},
        "add_comment": {"ref": "report:report#nope", "text": "a note"},
        "resolve_comment": {"comment": "nope"},
        "reply_in_thread": {"thread": "thread:nope", "text": "x"},
        "message_thread": {"thread": "nope", "message": "x"},
        "list_agents": {},
        "rename_thread": {"thread": "nope", "name": "x"},
        "delete_thread": {"thread": "nope"},
        "screenshot": {"ref": "card:nope"},
        "start_orientation": {"brief": ""},
        "start_writing": {"doc": "report"},
        "critique": {},
        "message_orientation": {"message": "x"},
        "run_check": {"name": "Unverified", "instructions": "Comment on numbers without a source."},
        "stop_check": {"name": "Unverified"},
        "file_dev_ticket": {"title": "t", "body": "b"},
        "view_check": {},
        "finish_view": {},
        "view_pictures": {},
        "finish_review": {},
        "ticket_checks": {},
        "finish_ticket": {},
    }


async def test_every_tool_runs_in_process_and_opens_no_socket(term, no_sockets, monkeypatch):
    assert not (Path(os.environ["THIMBLE_HOME"]) / "server.json").exists()
    args = _args(CORPUS, term)
    assert sorted(args) == sorted(tools.REGISTRY), "every tool of the registry is called"
    for name, given in args.items():
        res = await call(term, name, **given)
        assert isinstance(res.get("content"), list) and res["content"], name
        assert text(res).startswith(f"$ {name}") or res["is_error"], (name, text(res))
        assert "server" not in text(res).lower() or name in ("file_dev_ticket",), (name, text(res))
    assert no_sockets == []
    # what the calls made is in the workspace's files, as a server would have written it
    ws = config.workspace_dir(CORPUS)
    notes = [c for p in (ws / "notebooks").glob("*.json") for c in json.loads(p.read_text())["cells"] if c["kind"] == "note"]
    assert [c["title"] for c in notes] == ["What is this corpus?"]
    assert local.ui_records(CORPUS)[0]["kind"] in ("label", "filter", "layout")


async def test_list_agents_counts_a_side_threads_running_fork_in_terminal_mode(term):
    """No server follows main's session in terminal mode, so list_agents reads the forks from the workspace's files: a
    thread whose fork main started (subagents.json `forking`, the --agent-check hook's record) and whose question has no
    end yet runs; once its fork's run ended (`done`) it is not listed, and a fork that runs on in main's session (its
    meta's `fork`) is listed while a follow-up waits for its answer."""
    from app import agents, subagent_files, threads, tray

    meta = agents.new_thread(CORPUS, "board.jsonl#L2", "the second post", title="second-post")
    tid = meta["id"]
    name = threads.fork_name(CORPUS, meta)
    log_path = agents.paths(CORPUS, tid)[1]
    agents.append(log_path, {"type": "user", "ts": "2026-10-07T05:22:23Z", "text": "How many posts does the board hold? One number.", "by": "browser"})
    ws = config.workspace_dir(CORPUS)
    assert "No agent of thimble's runs now" in text(await call(term, "list_agents")), "asked, not forked yet"
    with subagent_files.update(ws) as state:
        state.setdefault(subagent_files.FORKING, {})[f"thread:{name}"] = __import__("time").time()
    out = text(await call(term, "list_agents"))
    assert 'thread "How many posts does the board hold? One number."' in out and "working" in out, out
    assert [r["chat"] for r in tray.agent_rows(CORPUS)] == [tid]
    agents.append(log_path, {"type": "text", "delta": "12 posts.", "reply": True, "by": "terminal"})
    # replied and still at work: done, as the thread's `↳` row in main's chat says it answered
    assert [r["state"] for r in tray.thread_rows_files(CORPUS)] == ["done"]
    assert "done" in text(await call(term, "list_agents"))
    agents.append(log_path, {"type": "done", "ts": "2026-10-07T05:22:35Z", "result": None})
    assert tray.thread_rows_files(CORPUS) == [], "its run ended"
    # a follow-up while its fork runs on in main's session (launch.json names the session)
    launch = json.loads((ws / "trusted" / "launch.json").read_text())
    (ws / "trusted" / "launch.json").write_text(json.dumps({**launch, "session": "s1"}))
    with subagent_files.update(ws) as state:
        state[subagent_files.FORKING] = {}
    agents.update_agent(CORPUS, tid, fork={"agent_id": "a1", "session": "s1"})
    agents.append(log_path, {"type": "user", "ts": "2026-10-07T05:23:00Z", "text": "And on 16 June?", "by": "browser"})
    assert [r["chat"] for r in tray.thread_rows_files(CORPUS)] == [tid]
    agents.update_agent(CORPUS, tid, fork={"agent_id": "a1", "session": "s0"})
    assert tray.thread_rows_files(CORPUS) == [], "a fork of another session does not run in this one"


async def test_the_tools_refuse_a_folder_of_no_workspace_and_a_browser_mode_workspace(term, tmp_path):
    res = await local.call("list_cards", {"group": "all"}, cwd=str(tmp_path))
    assert res["is_error"] and "not inside a corpus thimble knows" in text(res)
    assert not (config.WORKSPACES_DIR / tmp_path.name).exists(), "no tool call registers a folder"
    _mode("browser")
    res = await call(term, "list_cards", group="all")
    assert res["is_error"] and "browser mode" in text(res)


async def test_the_shims_end_ends_the_label_scan_pools_workers(term):
    """A regex label starts the scan pool's spawned workers in the shim; the shim's end (local.close) ends them, as the
    server's shutdown does, so none is left once Claude Code quits (live check T9 found one left)."""
    import time

    from app import concepts

    pool = concepts._pool_get()
    pool.submit(time.sleep, 60)
    for _ in range(200):
        if pool._processes:
            break
        time.sleep(0.05)
    pids = list(pool._processes)
    assert pids
    await local.close()
    assert concepts._pool is None
    for pid in pids:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        raise AssertionError(f"the pool's worker {pid} still runs after the shim's end")


async def test_a_code_ticket_is_refused_and_a_card_screenshot_needs_the_harness(term):
    res = await call(term, "file_dev_ticket", title="t", body="b")
    assert res["is_error"] and (tools.hint("ticket-terminal") or "browser mode") in text(res)
    cid = re.search(r"card:([A-Za-z0-9_-]+)", text(await call(term, "add_card", question="q", kind="note", text="x"))
                    .split("\n", 1)[1]).group(1)
    res = await call(term, "screenshot", ref=f"card:{cid}")
    assert res["is_error"], "THIMBLE_RENDER is off in the suite: the harness cannot draw"


async def test_the_ui_tools_leave_records_for_the_renderer(term):
    assert not (await call(term, "set_layout", layout="columns", surfaces=["files", "report"]))["is_error"]
    assert not (await call(term, "clear_filter", scope="canvas"))["is_error"]
    recs = local.ui_records(CORPUS)
    assert [(r["n"], r["kind"]) for r in recs] == [(1, "layout"), (2, "filter")]
    assert recs[0]["args"] == {"layout": "columns", "surfaces": ["files", "report"]}
    assert [r["n"] for r in local.ui_records(CORPUS, after=1)] == [2]
    _mode("browser")
    local.ui_note(CORPUS, "layout", {"layout": "one"})
    assert len(local.ui_records(CORPUS)) == 2, "browser mode's page hears the stream instead"


async def test_state_gives_what_the_routes_give(term):
    from app import agents, concepts

    await call(term, "add_card", question="Posts?", kind="note", text="Eight.", group="G")
    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    home = await local.state(CORPUS, "home")
    assert home["cards"] == 2 and home["labels"] == 1 and home["mode"] == "terminal" and home["unread"] == []
    assert home["views"] == [], "the views built for this corpus, as a list the home panel draws; no built-in viewer"
    assert home["coverage"] is None, "no orientation ran: no coverage line"
    # a view proposed and not built yet is listed with its state, when it was proposed and the files it claims; a
    # dropped one is not
    from app import views
    views._save_proposals(CORPUS, [
        {"slug": "edit-bursts", "name": "Edit Bursts", "status": "building", "ts": "2026-10-07T01:00:00Z", "claims": ["agents/*.jsonl"]},
        {"slug": "gone", "name": "Gone", "status": "dropped", "ts": "2026-10-07T01:00:00Z", "claims": ["board.jsonl"]},
    ])
    home = await local.state(CORPUS, "home")
    assert home["views"] == [{"slug": "edit-bursts", "name": "Edit Bursts", "status": "building", "ts": "2026-10-07T01:00:00Z", "files": ["agents/*.jsonl"]}]
    cards = await local.state(CORPUS, "cards", ["--since", "2000-01-01"])
    assert {c["title"] for c in cards["cells"]} >= {"Posts?"} and cards["groups"]
    assert (await local.state(CORPUS, "cards", ["--since", "2999-01-01"]))["cells"] == []
    cid = next(c["id"] for c in cards["cells"] if c["title"] == "Posts?")
    assert (await local.state(CORPUS, "card", [f"card:{cid}"]))["text"] == "Eight."
    labels = await local.state(CORPUS, "labels")
    assert [k["name"] for k in labels] == ["bash"]
    label = await local.state(CORPUS, "label", ["bash"])
    assert label["examples"]["yes"] and label["examples"]["yes"][0]["ref"].startswith("agents/")
    # its records as the rows route gives them with their words, for the label card's agree and disagree
    assert label["rows"] and {r["label"] for r in label["rows"]} <= set(label["labels"])
    assert all(r["ref"] and "text" in r and "analyst" in r for r in label["rows"])
    assert len([r for r in label["rows"] if r["label"] == "yes"]) <= local.LABEL_ROWS
    assert set(await local.state(CORPUS, "docs")) >= {"report"}
    meta = agents.new_thread(CORPUS, f"card:{cid}", "Eight.")
    threads = await local.state(CORPUS, "threads")
    assert any(t["id"] == meta["id"] and t["unread"] is False and t["answers"] == 0 for t in threads)
    thread = await local.state(CORPUS, "thread", [meta["id"], "--after", "0"])
    assert thread["meta"]["id"] == meta["id"] and thread["events"] == [] and thread["meta"]["answers"] == 0
    # each run that ends with an answer counts, which the renderer's row under main's latest reply follows
    _, log_path = agents.paths(CORPUS, meta["id"])
    for _ in range(2):
        agents.append(log_path, {"type": "user", "text": "Why?"})
        agents.append(log_path, {"type": "text", "delta": "Because.", "reply": True})
        agents.append(log_path, {"type": "done", "result": None})
    [row] = [t for t in await local.state(CORPUS, "threads") if t["id"] == meta["id"]]
    assert row["answers"] == 2 and row["unread"] is True
    assert row["question"] == "Why?", "its first question names the thread in the terminal"
    # main often answers with reply_in_thread alone (a `text` record marked `reply`, no `done`): that counts too, and a
    # reply and a `done` of one question count once
    agents.append(log_path, {"type": "user", "text": "And the rest?"})
    agents.append(log_path, {"type": "tool_use", "name": "Bash"})
    agents.append(log_path, {"type": "text", "delta": "All of it.", "reply": True})
    [row] = [t for t in await local.state(CORPUS, "threads") if t["id"] == meta["id"]]
    assert row["answers"] == 3
    agents.append(log_path, {"type": "text", "delta": "Also this.", "reply": True})
    agents.append(log_path, {"type": "done", "result": None})
    agents.append(log_path, {"type": "user", "text": "Still there?"})
    [row] = [t for t in await local.state(CORPUS, "threads") if t["id"] == meta["id"]]
    assert row["answers"] == 3, "one answer per question; the last question has none yet"
    # how the latest question stands, which the threads panel shows before it reads the thread (live check term-fix6,
    # new quirk 9: every row read `answered` until then, a stopped thread's too)
    assert row["turn"] == ""
    agents.append(log_path, {"type": "error", "message": "The Claude Code session ended before this thread finished",
                             "kind": "session-ended"})
    assert [t["turn"] for t in await local.state(CORPUS, "threads") if t["id"] == meta["id"]] == ["stopped"]
    agents.append(log_path, {"type": "user", "text": "Once more?"})
    agents.append(log_path, {"type": "error", "message": "boom", "kind": "failed"})
    assert [t["turn"] for t in await local.state(CORPUS, "threads") if t["id"] == meta["id"]] == ["failed"]
    agents.append(log_path, {"type": "text", "delta": "Here it is.", "reply": True})
    assert [t["turn"] for t in await local.state(CORPUS, "threads") if t["id"] == meta["id"]] == ["answered"]
    assert (await local.state(CORPUS, "files"))[0]["path"]
    assert [f["path"] for f in (await local.state(CORPUS, "files", ["agents"]))["files"]][0] == "agents/agent-01.jsonl"
    # a file: a page of its records from --start, as GET /source gives it, for the renderer's file view
    page = await local.state(CORPUS, "files", ["board.jsonl"])
    assert page["path"] == "board.jsonl" and page["start"] == 1 and page["records"] and page["total_lines"] >= 1
    later = await local.state(CORPUS, "files", ["board.jsonl", "--start", "2"])
    assert later["start"] == 2 and len(later["records"]) == len(page["records"]) - 1
    with pytest.raises(local.StateError):
        await local.state(CORPUS, "files", ["../outside.txt"])
    got = await local.state(CORPUS, "resolve", [json.dumps(["board.jsonl#L1", {"ref": "board.jsonl#L1", "value": "REVIEW WANTED"},
                                                           {"ref": "board.jsonl#L1", "value": "nope 4242"}, "gone.jsonl#L1"])])
    assert [g["state"] for g in got] == ["ok", "ok", "differs", "missing"]
    # each is the ref route's answer for its ref (refs.resolve), `error` where it does not resolve
    from app import refs

    assert {k: v for k, v in got[0].items() if k != "state"} == refs.resolve(config.corpus_dir(CORPUS), "board.jsonl#L1")
    assert got[3]["error"] and got[3]["ref"] == "gone.jsonl#L1"
    agents_ = await local.state(CORPUS, "agents", ["--tail", "1"])
    assert [a["role"] for a in agents_["agents"]] == ["labels"] and len(agents_["agents"][0]["tail"]) <= 1
    with pytest.raises(local.StateError, match="no surface"):
        await local.state(CORPUS, "nope")
    with pytest.raises(local.StateError, match="no such card"):
        await local.state(CORPUS, "card", ["nope"])
    assert concepts.find_concept(config.workspace_dir(CORPUS), "bash")


async def test_state_label_gives_the_scope_s_size_for_a_label_whose_run_never_ended(term):
    """Live check term-fix9, quirk 4: a label whose first run Claude Code's quit stopped part way read `not run yet`
    beside its counts, and its run's size was nowhere. `state label` and `state labels` give its scope's size
    (`scope_total`) for a label with rows and no run that ended; a label whose run ended gives none."""
    from app import concepts

    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    done = await local.state(CORPUS, "label", ["bash"])
    total = done["last_run"]["matched_total"] if done.get("last_run") else done["applications"][-1]["matched_total"]
    assert "scope_total" not in done and all("scope_total" not in k for k in await local.state(CORPUS, "labels"))
    # the run that ended forgotten, as a run stopped before its end leaves the label: rows, no run
    ws = config.workspace_dir(CORPUS)
    concept = concepts.load_concept(CORPUS, done["id"])[1]
    concepts.write_concept(ws, {**concept, "applications": []})
    stopped = await local.state(CORPUS, "label", ["bash"])
    assert stopped["n_labeled"] > 0 and stopped["scope_total"] == total
    [listed] = await local.state(CORPUS, "labels")
    assert listed["scope_total"] == total


async def test_state_label_keeps_a_record_the_analyst_set_under_the_value_they_gave(term):
    """A record the analyst set to another value in the label panel stays among its examples, under the value they gave,
    with the value the label gave it and its words (live check New 10: its row came past the page each value shows, so it
    left the list); a record they agreed with stays under its value."""
    from app import concepts

    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    first = await local.state(CORPUS, "label", ["bash"])
    no = (await concepts.rows_route(CORPUS, first["id"], value="no", limit=500))["rows"]
    yes = (await concepts.rows_route(CORPUS, first["id"], value="yes", limit=500))["rows"]
    assert len(yes) > local.LABEL_ROWS, "more yes records than the page shows: the moved one would fall past it"
    moved = no[-1]["ref"]
    assert moved not in {r["ref"] for r in first["rows"]}
    await local.act(CORPUS, "verdict", {"label": "bash", "ref": moved, "value": "yes"})
    agreed = yes[0]["ref"]
    await local.act(CORPUS, "verdict", {"label": "bash", "ref": agreed, "value": "yes"})
    label = await local.state(CORPUS, "label", ["bash"])
    [row] = [r for r in label["rows"] if r["ref"] == moved]
    assert (row["analyst"], row["label"]) == ("yes", "no") and row["text"]
    assert [r["analyst"] for r in label["rows"] if r["ref"] == agreed] == ["yes"]
    # each record once, the store's own page after the analyst's records
    refs = [r["ref"] for r in label["rows"]]
    assert len(refs) == len(set(refs))
    # the counts as thimble.labels() reads the rows: the moved record under the value the analyst gave, and how many
    # records the analyst set to another value (an agreement moves none) (live check term-fix5, new quirk 5)
    given = label["counts"]
    assert label["verdicts"] == {"counts": {**given, "yes": given["yes"] + 1, "no": given["no"] - 1}, "set": 1}
    [listed] = await local.state(CORPUS, "labels")
    assert listed["verdicts"] == label["verdicts"], "home's label row counts as the panel does"
    # the label tool's result says its counts apply the verdicts, and what the label itself gave
    again = text(await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
                            paths=["agents/*.jsonl"]))
    assert f"yes {given['yes'] + 1}" in again and "These counts apply the analyst's verdicts, as thimble.labels() does: " \
        "1 record(s) the analyst set to another value count under that value" in again
    assert f"(the label itself gave no {given['no']}, yes {given['yes']})" in again
    # a label's value cited by its count, and the label read whole, count with the verdicts too (live check term-fix6,
    # new quirk 1: `[32](concept:<id>/yes)` after one verdict was checked against the label's own 33, and read_ref said
    # the label's own counts)
    yes_now, no_now = given["yes"] + 1, given["no"] - 1
    cid = label["id"]
    [ok, old, whole] = await local.state(CORPUS, "resolve", [json.dumps([
        {"ref": f"concept:{cid}/yes", "value": str(yes_now)}, {"ref": f"concept:{cid}/yes", "value": str(given["yes"])},
        f"concept:{cid}"])])
    assert (ok["state"], ok["meta"]["count"], old["state"]) == ("ok", yes_now, "differs")
    assert ok["excerpt"].startswith(f"yes: {yes_now} records") and "with the analyst's verdicts" in ok["excerpt"]
    assert f"no: {no_now}, yes: {yes_now}" in whole["excerpt"] and "1 record(s) the analyst set to another value" in whole["excerpt"]
    read = text(await call(term, "read_ref", ref=f"concept:{cid}"))
    assert f"no: {no_now}, yes: {yes_now}" in read and f"no: {given['no']}," not in read
    # thimble.labels() says how many records the analyst set to another value, and its docstring that their verdicts
    # override the label (live check term-fix8, quirk 5: a thread called the one row a verdict moved a thimble bug)
    from app import kernel_thimble as kt

    was = kt.WS
    kt.WS = str(config.workspace_dir(CORPUS))
    try:
        listed_k = kt.labels()
        assert list(listed_k.loc[listed_k["id"] == cid, "set_by_analyst"]) == [1]
        df = kt.labels("bash")
        assert df.attrs["set_by_analyst"] == 1 and len(df) == yes_now and moved in set(df["ref"])
        assert "verdicts override the label" in (kt.labels.__doc__ or "")
    finally:
        kt.WS = was


async def test_state_opens_says_which_files_open_as_a_transcript(term):
    """What the file view opens a file as where that is not its lines, by path: `transcript` where its head reads as a
    transcript surely (transcripts.STRONG), which the renderer's type column shows (live check Q17); a file of lines,
    one that is not there and one outside the corpus are left out."""
    got = await local.state(CORPUS, "opens", [json.dumps(["agents/agent-01.jsonl", "board.jsonl", "events.jsonl",
                                                         "README.md", "nope.jsonl", "../outside.jsonl"])])
    assert got == {"agents/agent-01.jsonl": "transcript", "board.jsonl": "transcript"}
    with pytest.raises(local.StateError, match="JSON list"):
        await local.state(CORPUS, "opens", ['{"a": 1}'])
    with pytest.raises(local.StateError, match="needs"):
        await local.state(CORPUS, "opens")


async def test_act_makes_what_the_browser_makes(term, monkeypatch):
    from app import agents, concepts, events, subagents, threads

    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    got = await local.act(CORPUS, "verdict", {"label": "bash", "ref": "agents/agent-01.jsonl#L1", "value": "yes"})
    assert got["ok"] and got["row"]["source"] == "analyst" and got["row"]["label"] == "yes"
    ws = config.workspace_dir(CORPUS)
    rows = [json.loads(x) for x in (ws / "labels" / f"{got['label']}.jsonl").read_text().splitlines()]
    assert rows[-1]["ref"] == "agents/agent-01.jsonl#L1" and rows[-1]["source"] == "analyst"
    # a thread: the browser's ⌘-click, its first question posted as the thread's event
    posted: list[tuple[str, dict]] = []
    monkeypatch.setattr(events, "reachable", lambda c: True)

    def post(c, kind, payload, **kw):
        posted.append((kind, dict(payload)))
        return {"id": "e1", "kind": kind}

    monkeypatch.setattr(events, "post", post)
    made = await local.act(CORPUS, "thread", {"anchor": "board.jsonl#L1", "message": "Who wrote this?"})
    assert made["ok"] and posted == [("thread", {"thread": made["thread"], "text": "Who wrote this?"})]
    meta = agents.read_meta(CORPUS, made["thread"])
    assert meta["anchor"] == "board.jsonl#L1" and meta["anchor_surface"] == "terminal"
    # a sentence or a selection has no ref: the renderer sends its words as anchor_text, with a null anchor
    said = await local.act(CORPUS, "thread", {"anchor": None, "anchor_text": "Posts are short.", "message": "Why?"})
    meta2 = agents.read_meta(CORPUS, said["thread"])
    assert said["ok"] and meta2["anchor"] is None and meta2["anchor_text"] == "Posts are short."
    more = await local.act(CORPUS, "thread-message", {"thread": f"thread:{made['thread']}", "message": "And when?"})
    assert more["thread"] == made["thread"] and posted[-1] == ("thread", {"thread": made["thread"], "text": "And when?"})
    # an answer is unread until the thread is opened
    threads.reply(CORPUS, made["thread"], "agent-01 wrote it.", by="fork")
    assert threads.unread(CORPUS, agents.read_meta(CORPUS, made["thread"]))
    seen = await local.act(CORPUS, "seen", {"thread": made["thread"]})
    assert seen["seen"] >= 1 and not threads.unread(CORPUS, agents.read_meta(CORPUS, made["thread"]))
    # the fork's `done` after the reply seen is the same answer, never news again (live check term-fix9, low quirk: such
    # a thread read `new` after a relaunch); the next question's answer is
    log_path = agents.paths(CORPUS, made["thread"])[1]
    agents.append(log_path, {"type": "done", "result": "answered"})
    assert not threads.unread(CORPUS, agents.read_meta(CORPUS, made["thread"]))
    agents.append(log_path, {"type": "user", "text": "And after?"})
    agents.append(log_path, {"type": "done", "result": "answered"})
    assert threads.unread(CORPUS, agents.read_meta(CORPUS, made["thread"]))
    await local.act(CORPUS, "seen", {"thread": made["thread"]})
    # a stop goes through the module, as the browser's Stop does
    asked: list[str] = []

    async def stop(c, agent_id):
        asked.append(agent_id)
        return subagents.Answer({"done": True})

    monkeypatch.setattr(subagents, "stop", stop)
    assert (await local.act(CORPUS, "stop", {"agent": "a1234"}))["stopped"] is True and asked == ["a1234"]
    # a side thread is stopped by the fork of main that answers it
    agents.change_meta(CORPUS, made["thread"], lambda m: m.update(fork={"agent_id": "afork99"}))
    assert (await local.act(CORPUS, "stop", {"agent": made["thread"]}))["stopped"] is True and asked[-1] == "afork99"
    with pytest.raises(local.StateError, match="no act"):
        await local.act(CORPUS, "nope", {})
    with pytest.raises(local.StateError, match="empty"):
        await local.act(CORPUS, "thread", {"anchor": "x"})
    with pytest.raises(local.StateError, match="both empty"):
        await local.act(CORPUS, "thread", {"anchor": None, "message": "Why?"})
    assert concepts.find_concept(ws, "bash")


async def test_act_edits_and_runs_a_label_as_the_label_editor_does(term, monkeypatch):
    """The label panel's edits: `label` saves the kind, the prompt (or pattern or code) and the files as the browser's
    label editor saves them; `label-run` runs the label on a sample or on every record and answers with the run's
    summary once it ends; a code label's run waits for `thimble-run label` in main's Bash, whose command it gives."""
    from app import concepts

    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    ws = config.workspace_dir(CORPUS)
    before = concepts.find_concept(ws, "bash")
    got = await local.act(CORPUS, "label", {"label": "bash", "body": "Read", "glob": "agents/agent-01.jsonl"})
    after = concepts.find_concept(ws, "bash")
    assert got["ok"] and got["label"] == before["id"] and got["concept"]["spec"] == "Read"
    assert after["spec"] == "Read" and after["glob"] == "agents/agent-01.jsonl" and after["version"] == before["version"] + 1
    # a prompt label's prompt is its description, as the editor saves it (patchOf)
    await local.act(CORPUS, "label", {"label": "bash", "kind": "prompt", "body": "Does the record run a tool?"})
    k = concepts.find_concept(ws, "bash")
    assert (k["kind"], k["description"], k["spec"]) == ("prompt", "Does the record run a tool?", "")
    await local.act(CORPUS, "label", {"label": "bash", "kind": "regex", "body": "Bash"})
    ran = await local.act(CORPUS, "label-run", {"label": "bash", "limit": 3})
    s = ran["summary"]
    assert ran["ok"] and s["status"] == "done" and s["limit"] == 3 and s["labeled"] <= 3
    whole = await local.act(CORPUS, "label-run", {"label": "bash"})
    assert whole["summary"]["status"] == "done" and whole["summary"]["limit"] is None
    # `label-stop` from another process: the running label-run sees its stop file and stops after its current unit
    stop_seen: list[bool] = []
    real_wait = concepts.wait_apply

    async def wait_apply(c, cid, timeout=None, enough=None):
        await local.act(CORPUS, "label-stop", {"label": "bash"})
        for _ in range(100):
            if concepts._cancel_event(c, cid).is_set():
                break
            await asyncio.sleep(0.02)
        stop_seen.append(concepts._cancel_event(c, cid).is_set())
        return await real_wait(c, cid, timeout, enough)

    monkeypatch.setattr(local, "LABEL_STOP_POLL_S", 0.02)
    monkeypatch.setattr(concepts, "wait_apply", wait_apply)
    stopped = await local.act(CORPUS, "label-run", {"label": "bash"})
    monkeypatch.setattr(concepts, "wait_apply", real_wait)
    assert stop_seen == [True] and stopped["ok"] and not local._label_stop_file(CORPUS, before["id"]).exists()
    assert concepts.find_concept(ws, "bash")["applications"][-1]["paths"] == ["agents/agent-01.jsonl"]
    # a code label's code runs only where main's Bash runs it
    await local.act(CORPUS, "label", {"label": "bash", "kind": "code", "body": "def label(unit):\n    return 'yes', 1.0"})
    deferred = await local.act(CORPUS, "label-run", {"label": "bash", "limit": 5})
    assert deferred["deferred"] is True and deferred["command"].endswith(f"label {before['id']}")
    pending = concepts.find_concept(ws, "bash")[concepts.PENDING_RUN]
    assert pending["args"]["predicate"]["kind"] == "code" and pending["args"]["limit"] == 5
    await local.act(CORPUS, "label", {"label": "bash", "values": ["tool", "no tool"]})
    assert concepts.find_concept(ws, "bash")["labels"] == ["tool", "no tool"]
    with pytest.raises(local.StateError, match="two values"):
        await local.act(CORPUS, "label", {"label": "bash", "values": ["one"]})
    with pytest.raises(local.StateError, match="nothing to change"):
        await local.act(CORPUS, "label", {"label": "bash"})
    with pytest.raises(local.StateError, match="no label"):
        await local.act(CORPUS, "label-run", {"label": "nope"})


async def test_act_label_delete_deletes_the_label_its_marks_its_card_and_its_filter(term):
    """The label panel's delete: `label-delete` deletes the label as the browser's Delete label does, with its marks, its
    card and any filter that uses it; a `label-run` of it in another process stops once the label's file is gone; an
    unknown label is refused."""
    from app import concepts

    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    ws = config.workspace_dir(CORPUS)
    k = concepts.find_concept(ws, "bash")
    cid = k["id"]
    concepts.set_filter(CORPUS, "files", cid, "yes")
    assert concepts.read_filters(ws).get("files", {}).get("concept") == cid
    assert concepts._label_cards(ws, cid) and concepts.labels_file(ws, cid).is_file()
    got = await local.act(CORPUS, "label-delete", {"label": "Bash"})
    assert got == {"ok": True, "label": cid, "name": "bash", "deleted": True}
    assert concepts.find_concept(ws, cid) is None and not (concepts.concepts_dir(ws) / f"{cid}.json").exists()
    assert not concepts.labels_file(ws, cid).exists()
    assert not concepts._label_cards(ws, cid)
    assert "files" not in concepts.read_filters(ws)
    assert not local._label_stop_file(CORPUS, cid).exists()
    with pytest.raises(local.StateError, match="no label"):
        await local.act(CORPUS, "label-delete", {"label": "bash"})
    with pytest.raises(local.StateError, match="empty"):
        await local.act(CORPUS, "label-delete", {})


async def test_a_label_run_stops_when_another_process_deletes_its_label(term, monkeypatch):
    """`label-run` watches the label's file as it watches its stop file: a `label-delete` in another process removes the
    file, and the run stops after its current unit."""
    from app import concepts

    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    ws = config.workspace_dir(CORPUS)
    cid = concepts.find_concept(ws, "bash")["id"]
    seen: list[bool] = []
    real_wait = concepts.wait_apply

    async def wait_apply(c, k, timeout=None, enough=None):
        concepts._concept_file(ws, k).unlink()  # what the other process's delete leaves
        for _ in range(100):
            if concepts._cancel_event(c, k).is_set():
                break
            await asyncio.sleep(0.02)
        seen.append(concepts._cancel_event(c, k).is_set())
        return await real_wait(c, k, timeout, enough)

    monkeypatch.setattr(local, "LABEL_STOP_POLL_S", 0.02)
    monkeypatch.setattr(concepts, "wait_apply", wait_apply)
    await local.act(CORPUS, "label-run", {"label": cid})
    assert seen == [True]


def _cli(*argv: str, env: dict | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "app.local", *argv], cwd=cwd or BACKEND, env=env or dict(os.environ),
                          capture_output=True, text=True, timeout=120)


def test_the_command_line_prints_json_and_an_error(term):
    out = _cli("state", "home", "--cwd", str(term))
    assert out.returncode == 0 and json.loads(out.stdout)["workspace"] == CORPUS
    out = _cli("state", "card", "nope", "--cwd", str(term))
    assert out.returncode == 1 and json.loads(out.stdout) == {"error": "no such card: nope"}
    out = _cli("act", "seen", "{not json", "--cwd", str(term))
    assert out.returncode == 1 and "not JSON" in json.loads(out.stdout)["error"]
    _mode("browser")
    out = _cli("act", "seen", '{"thread": "x"}', "--cwd", str(term))
    assert out.returncode == 1 and "browser mode" in json.loads(out.stdout)["error"]


def test_a_process_that_lost_its_environment_does_nothing(term, tmp_path):
    """Every THIMBLE_* gone and another home: the folder is a corpus of the test's home only, so `thimble state`,
    `thimble-run` and the shim find no workspace, refuse, and make no ~/.thimble."""
    fake = tmp_path / "fakehome"
    fake.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("THIMBLE_")}
    env["HOME"] = str(fake)
    out = _cli("state", "home", "--cwd", str(term), env=env)
    assert out.returncode == 1 and "not inside a corpus" in json.loads(out.stdout)["error"]
    run = subprocess.run([str(cardrun.bin_path()), "card", "abc"], cwd=term, env=env, capture_output=True, text=True,
                         timeout=60)
    assert run.returncode == 1 and "not inside a corpus" in run.stdout
    shim = subprocess.run([str(config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"), "--list"], cwd=term, env=env,
                          capture_output=True, text=True, timeout=60)
    assert shim.returncode == 0
    assert not (fake / ".thimble").exists()


async def test_the_shim_in_terminal_mode_runs_calls_itself_keeps_fd_1_and_subscribes_to_nothing(term, tmp_path):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    from conftest import PLUGIN_TOKEN, _record

    # a server that records every request it gets: a browser-mode shim would subscribe and post its calls there
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    heard: list[str] = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            heard.append(f"GET {self.path}")
            self.send_response(503)
            self.end_headers()

        do_POST = do_GET  # noqa: N815

        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    _record(token=PLUGIN_TOKEN, port=httpd.server_address[1])
    env = {**os.environ, "THIMBLE_CARD_CHECK": "off", "THIMBLE_CWD": str(term),
           "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR)}
    params = StdioServerParameters(command=str(config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"), args=[], env=env,
                                   cwd=str(term))
    fds: dict[str, str] = {}

    async def run() -> str:
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                res = await s.call_tool("add_card", {"kind": "code", "question": "How many posts?",
                                                     "code": "print(sum(1 for _ in open('board.jsonl')))"})
                assert not res.is_error, res
                pid = next(p for p in _children() if "thimble-mcp" in _cmdline(p))
                fds["1"], fds["2"] = os.readlink(f"/proc/{pid}/fd/1"), os.readlink(f"/proc/{pid}/fd/2")
                return "\n".join(getattr(b, "text", "") for b in res.content)

    try:
        out = await asyncio.wait_for(run(), 60)
    finally:
        httpd.shutdown()
    assert heard == [], "the shim reached for a server"
    cid = re.search(r"^card:([A-Za-z0-9_-]+)\s*$", out, re.M).group(1)
    assert cardrun.command("card", cid) in out, "the card waits for thimble-run: the shim ran no code"
    assert notebook.get_cell(CORPUS, cid)["run"]["state"] == "waiting"
    assert fds["1"] == fds["2"], "fd 1 points at stderr, the stream kept a copy of its own"


def _children() -> list[int]:
    me = os.getpid()
    out = []
    for p in Path("/proc").iterdir():
        if p.name.isdigit():
            try:
                stat = (p / "stat").read_text().rsplit(")", 1)[1].split()
            except OSError:
                continue
            if int(stat[1]) == me or _descends(int(p.name), me):
                out.append(int(p.name))
    return out


def _descends(pid: int, root: int) -> bool:
    seen = 0
    while pid > 1 and seen < 20:
        try:
            pid = int((Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError):
            return False
        if pid == root:
            return True
        seen += 1
    return False


def _cmdline(pid: int) -> str:
    try:
        return (Path("/proc") / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode()
    except OSError:
        return ""
