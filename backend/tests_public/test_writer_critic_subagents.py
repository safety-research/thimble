"""The writer and the critic as subagents (write_session.py, critique_session.py): Write in the browser starts a writer
through thimble's module with its context in a file its prompt names, two writers of two documents are told apart by
their request ids, and a second writer of one document is refused; the orientation's `critique` writes the digest and
the brief, records a pending critic start that only the orientation's own Agent call can claim, pauses its chat, and
finds its descendants' transcripts by `parentAgentId`. Main's permission requests wait for the analyst as before, while
a request of one of thimble's agents is answered in the terminal at once and its card has no buttons (U6b)."""
from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

import pytest

from app import (agents, config, critique_session, events, orientation, read_parts, report_types, subagents, tools,
                 write_session)
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"


@pytest.fixture()
def models(monkeypatch):
    rows = {"orient": {"model": "claude-opus-5-5[1m]", "effort": "max", "fast": False},
            "subagents": {"model": "claude-sonnet-5", "effort": "medium", "fast": False},
            "critic": {"model": "claude-opus-5-5", "effort": "xhigh", "fast": False},
            "writer": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    monkeypatch.setattr(config, "models_for", lambda c=None: {k: dict(v) for k, v in rows.items()})


async def test_write_starts_the_writer_through_the_module_with_its_context_file(bridge, models, workspaces_tmp):
    ans = await write_session.start(CORPUS, "report", "Shorter, please.", route=subagents.CLICK)
    assert ans.started
    [spawn] = bridge.ops("spawn")
    path = write_session.work_dir(CORPUS, "report") / write_session.CONTEXT_FILE
    assert path.is_file() and "report:report" in path.read_text() and "Shorter, please." in path.read_text()
    assert f"READ {path} FIRST" in spawn["prompt"] and spawn["values"] == {"model": "claude-opus-5-5", "effort": "high"}
    assert spawn["description"] == "writer: report" and spawn["what"] == "report"
    meta = agents.read_meta(CORPUS, subagents.agent(CORPUS, ans.agent_id)["chat"])
    assert meta["role"] == "writer" and meta["doc"] == "report" and meta["title"] == "Write report"
    assert "orient" in meta and meta["orient"] is None, "no report pass, so the browser guesses none (orientWriters)"
    again = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    assert again.kind == "hook", "a second writer of the document"


async def test_a_large_context_is_written_in_files_a_read_call_returns_whole(bridge, models, workspaces_tmp, monkeypatch):
    """A context past the Read tool's caps as one file (#17) is written as files of at most read_parts.READ_UNITS,
    every one named in the writer's prompt, so the writer reads each whole without tripping a cap."""
    monkeypatch.setattr(read_parts, "READ_UNITS", 1_000)
    big = "\n".join(f"line {i} " + "x" * 90 for i in range(60))  # ~6k characters: past the (patched) cap
    monkeypatch.setattr(write_session.context, "render", lambda *a, **k: big)
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    assert ans.started
    folder = write_session.work_dir(CORPUS, "report")
    first = folder / write_session.CONTEXT_FILE
    others = sorted(folder.glob("context-*.md"), key=lambda p: int(p.stem.split("-")[1]))
    assert first.is_file() and len(others) >= 1
    paths = [first, *others]
    assert all(len(p.read_text()) <= 1_000 for p in paths)
    assert "".join(p.read_text() for p in paths) == big + "\n", "the parts are the whole context"
    [spawn] = bridge.ops("spawn")
    assert f"READ {len(paths)} FILES" in spawn["prompt"] and all(str(p) in spawn["prompt"] for p in paths)


def test_a_shrunken_context_removes_the_extra_files_of_an_earlier_one(workspaces_tmp, monkeypatch):
    monkeypatch.setattr(read_parts, "READ_UNITS", 100)
    t = {"slug": "report", "name": "Report"}
    monkeypatch.setattr(write_session.context, "render", lambda *a, **k: "x" * 350)
    assert len(write_session.write_context(CORPUS, t, "", "")) == 4
    monkeypatch.setattr(write_session.context, "render", lambda *a, **k: "y" * 50)
    paths = write_session.write_context(CORPUS, t, "", "")
    assert [p.name for p in paths] == ["context.md"]
    folder = write_session.work_dir(CORPUS, "report")
    assert sorted(p.name for p in folder.glob("context*.md")) == ["context.md"]


def test_a_full_context_file_of_dense_table_lines_is_under_the_read_file_size_cap(workspaces_tmp, monkeypatch):
    """A context file as full as read_parts.READ_UNITS lets it be, of dense table rows with characters UTF-8 writes in
    two to four bytes, is under the Read tool's file-size cap (256KB) on disk, and so is any part, at three bytes a
    UTF-16 code unit at most. The tool's other cap, 25k tokens a call, Read does not count a file of at most READ_UNITS
    code units against (test_read_parts)."""
    cap = 256 * 1024
    row = "|{i:06d}|r{i}.jsonl#L{i}|0.{i:04d}|✓|€{i}|東京|🙂|—|\n"
    text = "".join(row.format(i=i) for i in range(4 * read_parts.READ_UNITS // len(row)))
    monkeypatch.setattr(write_session.context, "render", lambda *a, **k: text)
    paths = write_session.write_context(CORPUS, {"slug": "report", "name": "Report"}, "", "")
    assert len(paths) >= 3
    full = max(read_parts.units(p.read_text("utf-8")) for p in paths)
    assert read_parts.READ_UNITS >= full > read_parts.READ_UNITS - 2 * read_parts.units(row), "as full as a part gets"
    assert all(p.stat().st_size < cap for p in paths)
    assert 3 * read_parts.READ_UNITS < cap


async def test_two_typed_writers_of_two_documents_are_claimed_by_their_request_ids(bridge, models, workspaces_tmp):
    report_types.create_document_type(CORPUS, "casefile", name="Cases", slug="cases")
    got = {}
    for doc in ("report", "cases"):
        res = await tools.call(CORPUS, "start_writing", {"doc": doc, "model": "sonnet"})
        assert not res.is_error, res.text
        got[doc] = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    with subagents.update(CORPUS) as state:
        for i, doc in enumerate(("cases", "report")):
            assert sf.check_call(state, {"tool_name": "Agent", "tool_use_id": f"toolu_{i}", "tool_input": got[doc]}) is None
    reqs = {r["key"]: r for r in subagents.read(CORPUS)["requests"].values()}
    assert reqs["writer:cases"]["claimed_by"] == "toolu_0" and reqs["writer:report"]["claimed_by"] == "toolu_1"
    assert reqs["writer:report"]["values"]["model"] == "claude-sonnet-5"


async def test_a_refused_writer_start_shows_on_its_document(bridge, models, workspaces_tmp, monkeypatch):
    seen: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, rec: seen.append(rec))
    bridge.answers.append({"limit": "Claude Code runs at most 20 concurrent subagents"})
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    assert ans.kind == "limit"
    refused = [r for r in seen if r.get("status") == "refused"]
    assert refused and refused[-1]["slug"] == "report" and refused[-1]["refused"]["kind"] == "limit"
    assert report_types.write_pending(CORPUS, "report") is None


async def test_the_writer_s_end_tells_main_and_lets_go_of_its_work_files(bridge, models, workspaces_tmp, monkeypatch):
    told: list[tuple] = []
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: told.append((kind, payload)))
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    subagents.run_ended(CORPUS, ans.agent_id, "done", "Wrote the report.", source="handback")
    assert told == [(write_session.WRITTEN_KIND, {"text": "Wrote the report.", "status": "done", "doc": "report"})]


async def test_a_writer_main_s_plan_mode_caught_mid_run_fails_its_write_and_says_why(bridge, models, workspaces_tmp,
                                                                                    monkeypatch):
    """Live check L21: main went into plan mode while a writer ran, and the writer with it, so it wrote a plan file and
    no document; with the document already there, thimble took that for a revision that changed nothing. The plan_mode
    attachment in its transcript marks the run, so its end fails the write with what to do, its run and chat end
    failed with that line, main hears it failed, and a next run clears the mark."""
    seen: list[dict] = []
    told: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, rec: seen.append(rec))
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: told.append(payload))
    monkeypatch.setattr(report_types, "read_doc", lambda c, inv, slug: {"sections": []})  # the document exists
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    subagents.saw_plan_mode(CORPUS, ans.agent_id)
    chat = subagents.agent(CORPUS, ans.agent_id)["chat"]
    assert agents.read_meta(CORPUS, chat)["plan_mode"] is True
    subagents.run_ended(CORPUS, ans.agent_id, "done", "I was put into plan mode partway.", source="handback")
    line = subagents.plan_failed_line("writer")
    assert line == ("Your Claude Code session went into plan mode while the writer ran, so it could not save the "
                    "document. Switch out of plan mode (shift+tab in your terminal), then write it again.")
    [end] = [r for r in seen if r.get("status") in ("generated", "failed")]
    assert end["status"] == "failed" and end["note"] == line and not end.get("unchanged")
    meta = agents.read_meta(CORPUS, chat)
    assert (meta["status"], meta["result"]) == ("failed", line)
    assert subagents.agent(CORPUS, ans.agent_id)["status"] == "failed"
    assert told == [{"text": line, "status": "failed", "doc": "report"}]
    subagents.run_again(CORPUS, ans.agent_id, "human")
    assert agents.read_meta(CORPUS, chat).get("plan_mode") is None


async def test_a_writer_that_saved_before_plan_mode_held_it_or_ran_on_after_it_ends_done(bridge, models, workspaces_tmp,
                                                                                         monkeypatch):
    """A writer whose run plan mode held at its end but which had saved its document left its work (its Type's
    left_work), and one whose transcript then said main left plan mode (plan_mode_exit) went on with it: both end
    done as before."""
    seen: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, rec: seen.append(rec))
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: None)
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    report_types.write_pending(CORPUS, "report")["saved"] = True
    subagents.saw_plan_mode(CORPUS, ans.agent_id)
    subagents.run_ended(CORPUS, ans.agent_id, "done", "Wrote the report.", source="handback")
    assert subagents.agent(CORPUS, ans.agent_id)["status"] == "done"
    assert [r["status"] for r in seen if r.get("status") in ("generated", "failed")] == ["generated"]
    report_types.create_document_type(CORPUS, "casefile", name="Cases", slug="cases")
    notes = await write_session.start(CORPUS, "cases", route=subagents.CLICK)
    chat = subagents.agent(CORPUS, notes.agent_id)["chat"]
    subagents.saw_plan_mode(CORPUS, notes.agent_id)
    subagents.saw_plan_mode(CORPUS, notes.agent_id, False)
    assert agents.read_meta(CORPUS, chat).get("plan_mode") is None
    assert not subagents.ended_in_plan(CORPUS, notes.agent_id)
    subagents.run_ended(CORPUS, notes.agent_id, "done", "Nothing to change.", source="handback")
    assert subagents.agent(CORPUS, notes.agent_id)["status"] == "done"


# --------------------------------------------------------------------------- the critic


async def test_critique_writes_the_brief_and_gives_the_orientation_its_agent_call(bridge, models, workspaces_tmp,
                                                                                monkeypatch):
    from app import orient_session

    async def no_checks(c, chat=None):
        return None

    monkeypatch.setattr(critique_session, "checks_text", no_checks)
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
    ctx = type("Ctx", (), {"c": CORPUS, "session": "orient", "tool_use_id": "toolu_cq"})()
    res = await critique_session.tool_critique(ctx, {"context": "My account."})
    assert not res.is_error, res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    chat = subagents.agent(CORPUS, ans.agent_id)["chat"]
    brief = config.workspace_dir(CORPUS) / "critique" / chat / critique_session.BRIEF_FILE
    assert brief.is_file() and "My account." in brief.read_text()
    assert inp["subagent_type"] == "thimble:critic" and f"READ {brief} FIRST" in inp["prompt"]
    assert agents.read_meta(CORPUS, chat)["paused"] == "critique"
    r = next(r for r in subagents.read(CORPUS)["requests"].values() if r["role"] == "critic")
    assert r["values"] == {"model": "claude-opus-5-5", "effort": "xhigh"} and r["caller_role"] == "orientation"
    assert r["work"] == str(config.workspace_dir(CORPUS) / "critique-work" / chat)
    with subagents.update(CORPUS) as state:
        main_call = {"tool_name": "Agent", "tool_use_id": "toolu_m", "tool_input": inp}
        assert sf.check_call(state, main_call) is not None, "main cannot start the critic"
        assert sf.check_call(state, {**main_call, "agent_id": ans.agent_id}) is None
        entry = sf.register(state, {"agent_id": "crit1", "agent_type": "thimble:critic", "session_id": "s"})
    assert entry["parent"] == ans.agent_id and entry["key"] == "critique:orient"
    meta = subagents.ensure_chat(CORPUS, "crit1")
    assert meta["role"] == agents.STEP_ROLE and meta["parent"] == chat and meta["title"] == "critique"
    subagents.run_ended(CORPUS, "crit1", "done", "The critic's report.", source="handback")
    assert agents.read_meta(CORPUS, chat).get("paused") is None, "the report continues the orientation's run"


async def test_a_large_brief_is_written_in_files_a_read_call_returns_whole(bridge, models, workspaces_tmp,
                                                                          monkeypatch):
    """The orientation's account of its analysis, which has no limit, and the coverage checks' findings can take the
    brief past what one Read call returns: it is written as brief.md, brief-2.md… of at most read_parts.READ_UNITS
    code units each, under the Read tool's file-size cap, and the critic's prompt names every one in order."""
    from app import orient_session

    found = "\n".join(f"- logs/day-{i:04d}.jsonl: no call opened it, and no card names its field `actor_id`"
                      for i in range(900))

    async def many_checks(c, chat=None):
        return found

    monkeypatch.setattr(critique_session, "checks_text", many_checks)
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
    ctx = type("Ctx", (), {"c": CORPUS, "session": "orient", "tool_use_id": "toolu_cq"})()
    account = "\n\n".join(f"Finding {i}: account a{i:04d} deleted {i % 97} files on night {i % 7}, as "
                           f"[[card:c{i:04d}]] counts." for i in range(700))
    res = await critique_session.tool_critique(ctx, {"context": account})
    assert not res.is_error, res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    folder = config.workspace_dir(CORPUS) / "critique" / subagents.agent(CORPUS, ans.agent_id)["chat"]
    paths = read_parts.paths(folder / critique_session.BRIEF_FILE, len(list(folder.glob("brief*.md"))))
    text = "".join(p.read_text() for p in paths)
    assert len(text) > 100_000, "one file would fail a Read call whole"
    assert len(paths) >= 3 and all(p.is_file() for p in paths)
    assert all(read_parts.units(p.read_text()) <= read_parts.READ_UNITS and p.stat().st_size < 256 * 1024
               for p in paths)
    assert "Finding 0:" in text and "Finding 699:" in text and "day-0899" in text, "the brief whole"
    assert f"READ {len(paths)} FILES {', '.join(str(p) for p in paths)} FIRST" in inp["prompt"]


async def test_a_critic_start_the_orientation_never_makes_ends_with_its_run(bridge, models, workspaces_tmp,
                                                                            monkeypatch):
    """The R3 check of main's turns skips an agent's own starts, so the orientation's end refuses a critic start its
    `critique` call made and its Agent call never claimed: it waits no more, and a late call of it is denied."""
    from app import orient_session

    async def no_checks(c, chat=None):
        return None

    monkeypatch.setattr(critique_session, "checks_text", no_checks)
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
    ctx = type("Ctx", (), {"c": CORPUS, "session": "orient", "tool_use_id": "toolu_cq"})()
    res = await critique_session.tool_critique(ctx, {"context": "My account."})
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    subagents.run_ended(CORPUS, ans.agent_id, "done", "The analysis.", source="handback")
    r = next(r for r in subagents.read(CORPUS)["requests"].values() if r["role"] == "critic")
    assert (r["state"], r["refused_kind"], r["reason"]) == ("refused", "no-call", critique_session.NEVER_STARTED)
    with subagents.update(CORPUS) as state:
        late = {"tool_name": "Agent", "tool_use_id": "toolu_late", "tool_input": inp, "agent_id": ans.agent_id}
        assert sf.check_call(state, late) is not None, "a late call of it is denied"


async def test_critique_is_the_orientation_s_alone(bridge, models, workspaces_tmp):
    ctx = type("Ctx", (), {"c": CORPUS, "session": None, "tool_use_id": "t"})()
    res = await critique_session.tool_critique(ctx, {})
    assert res.is_error and res.text == tools.hint("critique-not-orientation")


def test_the_digest_of_a_subagent_orientation_holds_its_descendants_found_by_parent_agent_id(workspaces_tmp, tmp_path,
                                                                                            monkeypatch):
    from app import session

    sid = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
    proj = tmp_path / "projects" / "-corpus"
    folder = proj / sid / "subagents"
    folder.mkdir(parents=True)
    (proj / f"{sid}.jsonl").write_text("")
    monkeypatch.setattr(session, "find_transcript", lambda s, config_dir=None: str(proj / f"{s}.jsonl"))

    def put(agent: str, text: str, **meta) -> None:
        rec = {"type": "assistant", "timestamp": f"2026-10-06T00:0{len(meta)}:00Z",
               "message": {"content": [{"type": "text", "text": text}]}}
        (folder / f"agent-{agent}.jsonl").write_text(json.dumps(rec) + "\n")
        (folder / f"agent-{agent}.meta.json").write_text(json.dumps(meta))

    put("o1", "the orientation's own words", agentType="thimble:orientation")
    put("h1", "a helper's words", agentType="thimble:orient-helper", parentAgentId="o1", description="survey")
    put("g1", "a grandchild's words", agentType="Explore", parentAgentId="h1", description="look closer")
    put("x1", "another agent's words", agentType="general-purpose", description="not ours")
    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, route="subagent", agent_id="o1",
                            session=sid, sessions=[sid])["id"]
    digest = critique_session.chat_digest(CORPUS, chat)
    assert "the orientation's own words" in digest and "a helper's words" in digest and "a grandchild's words" in digest
    assert "another agent's words" not in digest


def test_the_digest_wraps_a_long_line_of_an_agent_s_text_so_no_line_passes_call_chars(tmp_path):
    """A paragraph an agent wrote on one line, a long prompt and a long heading come out as lines of at most CALL_CHARS
    with every word kept, so a window of lines the brief gives (read_parts.window) holds however the agents wrote."""
    words = [f"w{i:05d}" for i in range(2_000)]
    para = " ".join(words)
    recs = [{"type": "user", "message": {"role": "user", "content": para}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": f"Found it.\n{para}\n# {para}"}]}}]
    path = tmp_path / "agent.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in recs))
    out = critique_session.render("Orientation", path)
    lines = out.split("\n")
    assert max(len(x) for x in lines) <= critique_session.CALL_CHARS
    seen = " ".join(x.removeprefix("> ").removeprefix("\\").removeprefix("# ") for x in lines[1:]).split()
    assert seen == [*words, "Found", "it.", *words, *words], "every word, in order"
    assert sum(x.startswith("> ") for x in lines) > 1 and not any(x.startswith("#") for x in lines[1:])


def test_a_wrapped_piece_of_an_agent_s_line_never_starts_with_a_space():
    """A break that falls in a run of spaces drops the run, so no continuation starts with INDENT and reads to the critic
    as a result line indented under a call."""
    for line in ("| " + "a" * 1_495 + "      | Account a0042 deleted 97 files |",  # spaces across the break
                 "b" * 1_499 + "    tail of the line",  # no space before the break, which falls before the spaces
                 "> " + "c" * 1_495 + "     quoted",
                 "d" * 1_499 + "      "):
        pieces = critique_session._wrap(line)
        assert len(pieces) > 1 or line.endswith(" ")
        assert not any(p.startswith(" ") for p in pieces[1:]), pieces[1:]
        assert all(0 < len(p) <= critique_session.CALL_CHARS - 1 for p in pieces)
        assert " ".join(p.removeprefix("> ") for p in pieces).split() == line.removeprefix("> ").split()


async def test_a_long_digest_s_brief_gives_a_window_one_read_call_returns_whole(bridge, models, workspaces_tmp,
                                                                             monkeypatch):
    """A digest past what one Read call returns is named in the brief with its line count and a window of lines one
    call returns whole wherever it starts: every run of that many lines, with Read's line-number prefix, is at most
    read_parts.READ_UNITS code units. A digest that fits is named as before."""
    from app import orient_session

    async def no_checks(c, chat=None):
        return None

    monkeypatch.setattr(critique_session, "checks_text", no_checks)
    real = tools.descriptions
    hints = {"critique-transcript-window": "TRANSCRIPT {path} LINES {lines} WINDOW {window}",
             "critique-transcript": "TRANSCRIPT {path} WHOLE"}
    monkeypatch.setattr(tools, "descriptions", lambda: {**real(), **hints})
    rows = [f"call:c1/{i} Bash " + "x" * (1_400 if i % 3 == 0 else 120) for i in range(1_200)]
    monkeypatch.setattr(critique_session, "digest", lambda caller: "\n".join(rows))
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
    ctx = type("Ctx", (), {"c": CORPUS, "session": "orient", "tool_use_id": "toolu_cq"})()
    res = await critique_session.tool_critique(ctx, {"context": "My account."})
    assert not res.is_error, res.text
    folder = config.workspace_dir(CORPUS) / "critique" / subagents.agent(CORPUS, ans.agent_id)["chat"]
    transcript = folder / critique_session.DIGEST_FILE
    assert len(transcript.read_text()) > 500_000
    brief = "".join(p.read_text() for p in sorted(folder.glob("brief*.md")))
    [line] = [x for x in brief.splitlines() if x.startswith("TRANSCRIPT ")]
    assert line.startswith(f"TRANSCRIPT {transcript} LINES 1,200 WINDOW ")
    window = int(line.rsplit(" ", 1)[1])
    sizes = [read_parts.units(r) + 1 + read_parts.LINE_PREFIX_CHARS
             for r in transcript.read_text().rstrip("\n").split("\n")]
    assert 1 < window < len(sizes)
    assert all(sum(sizes[i:i + window]) <= read_parts.READ_UNITS for i in range(len(sizes))), "safe from any line"
    assert any(sum(sizes[i:i + window + 1]) > read_parts.READ_UNITS for i in range(len(sizes))), "and no smaller"
    transcript.write_text("call:c1/1 Bash ls\n")
    assert critique_session.transcript_line(transcript) == f"TRANSCRIPT {transcript} WHOLE"


async def test_read_ref_pages_a_long_digest_in_results_that_stay_under_claude_code_s_tool_result_cap(
        workspaces_tmp, tmp_path, monkeypatch):
    """A page of `chat:<orientation chat>` holds at most DIGEST_PAGE_CHARS characters, so one read_ref result stays
    under the 50,000 characters past which Claude Code 2.1.300 saves a tool result to a file and shows a 2KB preview
    (and under its 25,000-token cap on an MCP result), where 600 lines of CALL_CHARS were 900,000. Each page's
    `digest-more` line names the next page from the line after its last, so paging reads the whole digest, every line
    once."""
    from app import session

    sid = "70e0e27e-eb46-462b-8a9a-57b2e924dca2"
    proj = tmp_path / "projects" / "-corpus"
    folder = proj / sid / "subagents"
    folder.mkdir(parents=True)
    (proj / f"{sid}.jsonl").write_text("")
    monkeypatch.setattr(session, "find_transcript", lambda s, config_dir=None: str(proj / f"{s}.jsonl"))
    paras = "\n".join(" ".join(f"p{i:03d}w{j:03d}" for j in range(160)) for i in range(700))
    rec = {"type": "assistant", "timestamp": "2026-10-06T00:00:00Z",
           "message": {"content": [{"type": "text", "text": paras}]}}
    (folder / "agent-o1.jsonl").write_text(json.dumps(rec) + "\n")
    (folder / "agent-o1.meta.json").write_text(json.dumps({"agentType": "thimble:orientation"}))
    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, route="subagent", agent_id="o1",
                            session=sid, sessions=[sid])["id"]
    digest = critique_session.chat_digest(CORPUS, chat)
    assert len(digest) > 1_000_000 and max(len(x) for x in digest.split("\n")) > 1_400
    total = f"{len(digest.split(chr(10))):,}"
    ref, pages, seen = f"chat:{chat}", 0, []
    while ref:
        r = await tools.call(CORPUS, "read_ref", {"ref": ref})
        assert not r.is_error, r.text
        assert len(r.text) <= 50_000, f"{ref}: {len(r.text):,} characters"
        body = r.text.split(f"{ref} (chat)\n", 1)[1]
        page, _, last = body.rpartition("\n")
        found = re.search(r"chat:[\w-]+#L\d+-L\d+", last)
        ref = found.group(0) if found and last == tools.hint("digest-more", ref=found.group(0), total=total) else ""
        seen.append(page if ref else body)
        pages += 1
    assert pages > 25 and "\n".join(seen) == digest, "every line once, in order"


def test_a_digest_page_ends_before_the_line_that_would_pass_its_cap(monkeypatch):
    monkeypatch.setattr(critique_session, "DIGEST_PAGE_CHARS", 100)
    lines = ["a" * 40, "b" * 40, "c" * 40, "d" * 300, "e"]
    assert critique_session._page_end(lines, 1, 5) == 2, "81 characters with the line break, and a third line is 122"
    assert critique_session._page_end(lines, 3, 5) == 3
    assert critique_session._page_end(lines, 4, 5) == 4, "a line longer than a page alone, which the page cuts"
    assert critique_session._page_end(lines, 1, 1) == 1 and critique_session._page_end(lines, 5, 5) == 5


# --------------------------------------------------------------------------- permission requests


class Hook:
    def __init__(self) -> None:
        self.gone = False

    async def is_disconnected(self) -> bool:
        return self.gone


async def test_a_thimble_agent_s_request_is_answered_at_once_and_its_card_has_no_buttons(bridge, models,
                                                                                       workspaces_tmp):
    from app import session

    sid = "5e55a000-0000-4000-8000-0000000000aa"
    session._live[CORPUS] = session.Live(CORPUS, sid, str(config.corpus_dir(CORPUS)), None, None)
    try:
        ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
        body = events.HookPermission(cwd=str(config.corpus_dir(CORPUS)), session=sid, tool_name="WebFetch",
                                     tool_input={"url": "https://example.com"}, agent_id=ans.agent_id)
        got = await asyncio.wait_for(events.hook_permission_route(Hook(), body), 2)
        assert got["behavior"] is None, "the terminal asks at once (U6b)"
        [card] = agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"]
        assert card["terminal"] is True and card["chat"] == subagents.agent(CORPUS, ans.agent_id)["chat"]
        events.calls_done(CORPUS, ans.agent_id, [(events.call_key("WebFetch", {"url": "https://example.com"}), 0.0)])
        assert agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"] == [], "the call ran: the terminal answered it"
        main = asyncio.ensure_future(events.hook_permission_route(Hook(), events.HookPermission(
            cwd=str(config.corpus_dir(CORPUS)), session=sid, tool_name="Edit", tool_input={"file_path": "/c/x"})))
        await asyncio.sleep(0.2)
        assert not main.done(), "main's own request waits for the analyst, as before"
        [card] = agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"]
        assert "terminal" not in card
        events.calls_done(CORPUS, None, [(events.call_key("Edit", {"file_path": "/c/x"}), time.time() + 1)])
        assert (await asyncio.wait_for(main, 2))["behavior"] is None, "answered in the terminal: the hook lets go"
        assert agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"] == [], "the tool's PostToolUse closed the card"
    finally:
        session._live.pop(CORPUS, None)


def test_a_code_ticket_s_runner_reads_no_project_settings(workspaces_tmp, monkeypatch):
    """A `claude -p` job the server starts (a code ticket, `thimble fix`) runs none of the folder's own hooks, settings or
    MCP servers (U17)."""
    from app import dev, userconf

    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    flags = dev.Sessions()._flags(CORPUS, "thimble:dev · mini")
    assert flags[flags.index("--setting-sources") + 1] == "user" and "--strict-mcp-config" in flags


def test_main_s_prompt_comes_back_only_when_main_itself_compacted(tmp_path):
    from datetime import datetime, timezone

    from app import cli

    main = tmp_path / "main.jsonl"
    main.write_text(json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n")
    hook = {"hook_event_name": "SessionStart", "source": "compact", "transcript_path": str(main)}
    assert not cli.main_itself(hook), "a subagent's compaction writes no boundary into main's transcript (U2)"
    now = datetime.now(timezone.utc).isoformat()
    with main.open("a") as f:
        f.write(json.dumps({"type": "system", "subtype": "compact_boundary", "timestamp": now}) + "\n")
    assert cli.main_itself(hook)
    assert cli.main_itself({**hook, "source": "clear"}), "only main clears"
    old = tmp_path / "old.jsonl"
    old.write_text(json.dumps({"type": "system", "subtype": "compact_boundary",
                               "timestamp": "2026-01-01T00:00:00+00:00"}) + "\n")
    assert not cli.main_itself({**hook, "transcript_path": str(old)}), "an earlier compaction of main's"
    assert Path(old).is_file()
