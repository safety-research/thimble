"""Report checks as subagents of main (checks.py): a writer's end starts each shown check on its document through
thimble's module, as a follow-on start of the writer's own, at most MAX_SESSIONS at once, each with its task file in
check-work/; the analyst's own edits start nothing and mark the checks stale with the count of passages that changed;
Run is a click; main's run_check gives the exact Agent call. A run's end supersedes its check's earlier comments on the
passages it covered and records their fingerprints. The module is the fake bridge (subagent_fakes); an agent's end is
subagents.run_ended."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import agents, checks, config, investigation, read_parts, report_types, subagents, tools
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
TEXT = ("# One account did it\n\n## One account\n\nAll the deletions came from one account. It ran at night.\n\n"
        "## Caveats\n\nThe log covers one week.\n")


@pytest.fixture()
def doc(workspaces_tmp, monkeypatch):
    """The checks `explainers` and `judgment` on, on Settings' checks row; each test writes the report (_write)."""
    _checks_row(monkeypatch)
    for cid in ("explainers", "judgment"):
        checks.edit(CORPUS, cid, shown=True)
    checks.edit(CORPUS, "heads-up", shown=False)  # Heads up starts on: these two are the shown checks


def _checks_row(monkeypatch) -> None:
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})


async def _write(text: str = TEXT) -> None:
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text


async def _until(cond, what: str) -> None:
    for _ in range(300):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


def _run(cid: str, docname: str = "report") -> dict:
    return ((checks.read(CORPUS, cid) or {}).get("runs") or {}).get(docname) or {}


async def _started(cid: str, docname: str = "report") -> checks._Active:
    """A run of `cid` started with route click, once its agent has started through the module."""
    rec = await checks.start_run(CORPUS, cid, docname, force=True, route="click")
    assert rec is not None
    act = checks._active[(CORPUS, cid, docname)]
    await _until(lambda: act.agent or act.ended, f"the run of {cid} never started")
    return act


def _writer_done(docname: str = "report") -> None:
    meta = agents.new_agent(CORPUS, "writer", f"Write {docname}", doc=docname, announce=False)
    agents.finish_agent(CORPUS, meta["id"], "done", "Wrote it.")


async def test_a_writer_s_end_starts_each_shown_check_through_the_module_with_its_task_file(doc, bridge, monkeypatch):
    monkeypatch.setattr(checks, "MAX_SESSIONS", 1)
    await _write()
    assert not bridge.ops("spawn"), "a save starts nothing"
    _writer_done()
    await _until(lambda: len(bridge.ops("spawn")) == 1, "no check started at the writer's end")
    await asyncio.sleep(0.05)
    assert len(bridge.ops("spawn")) == 1, "at most MAX_SESSIONS run at once"
    [spawn] = bridge.ops("spawn")
    cid = "explainers" if "explainers" in spawn["what"] else "judgment"
    other = "judgment" if cid == "explainers" else "explainers"
    path = checks.work_dir(CORPUS, cid, "report") / checks.TASK_FILE
    assert path.is_file() and "report:report" in path.read_text()
    assert str(path) in spawn["prompt"] and spawn["role"] == "check"
    assert spawn["values"] == {"model": "claude-opus-5-5", "effort": "high"}
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
    assert _run(other).get("waiting") == checks.WAITING_QUEUED
    agent = _run(cid)["agent_id"]
    meta = agents.read_meta(CORPUS, _run(cid)["chat"])
    assert meta["role"] == "check" and meta["check"] == cid and meta["agent_id"] == agent
    subagents.run_ended(CORPUS, agent, "done", "Commented on 0 of 3 passages.", source="handback")
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the queued check never started")
    assert _run(cid)["status"] == "done" and _run(cid)["summary"] == "Commented on 0 of 3 passages."
    assert _run(cid)["stale"] == 0


async def test_a_large_workspace_s_task_is_written_in_files_a_read_call_returns_whole(doc, bridge):
    """A task past what one Read call returns, here one with a long report, which the task never cuts, is written as
    task.md, task-2.md… of at most read_parts.READ_UNITS code units each, under the Read tool's file-size cap, and the
    run's prompt names every one in order."""
    paras = "\n\n".join(f"Account a{i:04d} deleted {i % 97} files on night {i % 7} from host h{i % 13}, as line {i} of "
                         f"the log shows." for i in range(900))
    await _write("# A long report\n\n## Findings\n\n" + paras + "\n")
    await _started("explainers")
    [spawn] = bridge.ops("spawn")
    work = checks.work_dir(CORPUS, "explainers", "report")
    paths = read_parts.paths(work / checks.TASK_FILE, len(list(work.glob("task*.md"))))
    text = "".join(p.read_text() for p in paths)
    assert len(text) > 100_000, "one file would fail a Read call whole"
    assert len(paths) >= 3 and all(p.is_file() for p in paths)
    assert all(read_parts.units(p.read_text()) <= read_parts.READ_UNITS and p.stat().st_size < 256 * 1024
               for p in paths)
    assert "Account a0000 deleted" in text and "Account a0899 deleted" in text, "the document whole"
    assert f"READ {len(paths)} FILES {', '.join(str(p) for p in paths)} FIRST" in spawn["prompt"]


async def test_a_check_on_a_report_in_chinese_gets_task_files_one_read_call_returns_whole(doc, bridge):
    """A report written in Chinese, as a corpus of Chinese tickets gives, runs to more than a token a character: each
    task file is still one Read call returns whole (test_read_parts.read_returns_whole), and the prompt names each."""
    from test_read_parts import ZH, read_returns_whole

    await _write("# 报告\n\n## 发现\n\n" + "\n\n".join(f"第{i}条：{ZH}" for i in range(900)) + "\n")
    await _started("explainers")
    [spawn] = bridge.ops("spawn")
    work = checks.work_dir(CORPUS, "explainers", "report")
    paths = read_parts.paths(work / checks.TASK_FILE, len(list(work.glob("task*.md"))))
    assert len(paths) >= 2 and all(str(p) in spawn["prompt"] for p in paths)
    over = [(p.name, len(p.read_text("utf-8"))) for p in paths if not read_returns_whole(p.read_text("utf-8"), "zh")]
    assert not over, f"task files past Read's token cap: {over}"


async def test_in_a_new_workspace_a_writer_s_end_starts_heads_up_and_explainers_and_each_switch_the_analyst_sets_stays(
        workspaces_tmp, bridge, monkeypatch):
    """Of the built-ins Heads up and Explainers are on in a workspace that stored none of them: a writer's end starts
    both on its document, and Judgment calls stays off. One the analyst turns on runs at the next writer's end, and one
    they turn off is stored so and starts no run."""
    _checks_row(monkeypatch)
    await _write()
    assert not bridge.ops("spawn"), "a save starts nothing"
    defaults = [("heads-up", True), ("explainers", True), ("judgment", False)]
    assert [(x["id"], x["shown"]) for x in checks.list_checks(CORPUS)] == defaults
    _writer_done()
    await _until(lambda: len(bridge.ops("spawn")) == 2, "Heads up and Explainers never started at the writer's end")
    await asyncio.sleep(0.05)
    assert sorted(s["what"] for s in bridge.ops("spawn")) == ["explainers on report", "heads-up on report"]
    for cid in ("heads-up", "explainers"):
        subagents.run_ended(CORPUS, _run(cid)["agent_id"], "done", "Done.", source="handback")
        await _until(lambda: _run(cid)["status"] == "done", "the run never ended")
    assert [(x["id"], x["shown"]) for x in checks.list_checks(CORPUS)] == defaults, "a run's save keeps the defaults"
    checks.edit(CORPUS, "judgment", shown=True)
    checks.edit(CORPUS, "heads-up", shown=False)
    checks.edit(CORPUS, "explainers", shown=False)
    assert checks.read(CORPUS, "judgment")["shown"] is True, "the analyst's choice is stored and wins"
    assert checks.read(CORPUS, "heads-up")["shown"] is False, "the analyst's choice is stored and wins"
    await _write(TEXT.replace("It ran at night.", "It ran in the morning."))
    _writer_done()
    await _until(lambda: len(bridge.ops("spawn")) == 3, "the check turned on never started")
    await asyncio.sleep(0.05)
    assert [s["what"] for s in bridge.ops("spawn")[2:]] == ["judgment on report"]


async def test_the_analyst_s_edit_starts_nothing_and_marks_the_checks_stale_with_the_count(doc, bridge):
    await _write()
    _writer_done()
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the checks never started")
    for cid in ("explainers", "judgment"):
        subagents.run_ended(CORPUS, _run(cid)["agent_id"], "done", "Done.", source="handback")
    await _until(lambda: all(_run(c)["status"] == "done" for c in ("explainers", "judgment")), "the runs never ended")
    await _write(TEXT.replace("It ran at night.", "It ran in the morning."))
    assert len(bridge.ops("spawn")) == 2, "an edit starts no run"
    assert _run("explainers")["stale"] == 1 and _run("judgment")["stale"] == 1, "one paragraph changed"


async def test_run_is_a_click_that_starts_one_and_stop_goes_through_the_module(doc, bridge):
    await _write()
    act = await _started("judgment")
    assert len(bridge.ops("spawn")) == 1
    assert subagents.request(CORPUS, bridge.ops("spawn")[0]["request"])["route"] == "click"
    await checks.stop(act)
    assert bridge.ops("stop")[0]["agent"] == act.agent
    subagents.run_ended(CORPUS, act.agent, "stopped", "", source="notification")
    assert _run("judgment")["status"] == "stopped"


async def test_a_run_s_end_supersedes_its_covered_comments_and_records_what_it_saw(doc, bridge):
    await _write()
    first = await _started("judgment")
    key = checks.session_key("judgment", "report")
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    sid = report_types.all_sentences(d)[0]["id"]
    tid = "toolu_c1"
    sf.add_caller(config.workspace_dir(CORPUS), tid, first.agent, "thimble:check")
    res = await tools.call(CORPUS, "add_comment", {"ref": f"report:report#{sid}", "text": "No card shows this."},
                           session=key, tool_use_id=tid)
    assert not res.is_error, res.text
    subagents.run_ended(CORPUS, first.agent, "done", "Commented on 1 passage.", source="handback")
    assert _run("judgment")["comments"] == 1 and len(_run("judgment")["seen"]) == len(first.fps)
    second = await _started("judgment")
    told = _commented()
    subagents.run_ended(CORPUS, second.agent, "done", "Commented on 0 passages.", source="handback")
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    [cm] = [c for c in d.get("comments") or [] if c.get("check") == "judgment"]
    assert cm["status"] != "open" and cm["superseded_by"] == second.run
    assert _commented() == told + 1, "the open pages hear that the report's comments changed, and drop the replaced one"


def _commented() -> int:
    """How many records on the stream said that the report's comments changed (a page reads the report again)."""
    path = investigation.inv_dir(CORPUS, investigation.MAIN) / "events.jsonl"
    rows = investigation._read_jsonl(path) if path.exists() else []
    return sum(1 for e in rows
               if e.get("type") == "report" and e.get("slug") == "report" and e.get("status") == "commented")


async def test_a_run_s_task_file_is_never_written_through_a_link(doc, bridge, tmp_path):
    """check-work/ is a folder the agents' Bash and a kernel can write, and the server, which no sandbox holds, writes
    each run's task file there: a link planted at the file is replaced, never followed, and a run whose folder is a link
    fails without writing through it (ledger.write_under, which the writers' context files and the critic's brief use
    too)."""
    from app import ledger

    await _write()
    outside = tmp_path / "outside.txt"
    outside.write_text("keep me")
    task = checks.work_dir(CORPUS, "explainers", "report") / checks.TASK_FILE
    task.parent.mkdir(parents=True, exist_ok=True)
    task.symlink_to(outside)
    await _started("explainers")
    assert outside.read_text() == "keep me" and not task.is_symlink() and task.read_text().strip()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    checks.work_dir(CORPUS, "judgment", "report").symlink_to(elsewhere, target_is_directory=True)
    act = await _started("judgment")
    assert act.ended and _run("judgment")["status"] == "failed" and not list(elsewhere.iterdir())
    with pytest.raises(OSError):
        ledger.write_under(config.workspace_dir(CORPUS), checks.work_dir(CORPUS, "judgment", "report") / "x.md", "x")


CHECK_CLICKS = [("post", "/api/ws/mini/checks/explainers/run", {"doc": "report"}),
                ("post", "/api/ws/mini/checks/explainers/runs", {"doc": "report"}),
                ("post", "/api/ws/mini/checks", {"name": "Dates", "prompt": "Mark the dates."}),
                ("patch", "/api/ws/mini/checks/judgment", {"shown": True})]


@pytest.mark.real_write_guard
def test_every_check_click_route_refuses_the_server_s_token_without_the_analyst_s_cookie(doc, bridge, plugin_headers):
    from app import main

    client = TestClient(main.create_app())
    for method, path, body in CHECK_CLICKS:
        r = getattr(client, method)(path, json=body, headers=plugin_headers())
        assert r.status_code == 403, (path, r.status_code, r.text)
        r = getattr(client, method)(path, json=body)
        assert r.status_code == 403, ("neither cookie nor token, as a kernel cell posts it", path)
    assert not bridge.calls, "the module is never asked"
