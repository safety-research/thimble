"""One run state for a label's run in every process (bug hunt round 8, I1-I4).

A label's run is a task of the process that started it: thimble's server, the session's MCP shim or a `thimble act
label-run`. These tests hold a prompt label's run open in this process (the classifier, scripted at
concepts.classify_structured, answers its first calls and holds the rest) and ask about it from another process, a
`python -m app.local` as the terminal runs `thimble state` and `thimble act`:
- I1: the terminal's stop of a run main started (`stop` of the chat that follows it, `label-stop`) stops it, and says so
  when no run is going, never that Claude Code did not load thimble's hooks module;
- I2: `thimble state` gives that run as the label's run, with the counts this process gives, and a second run of the
  label is refused;
- I4: a label within another counts its scope by the records it runs over, not its whole glob."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import Response

from app import call_result as model_mod
from app import concepts, config, events, local, model_call

CORPUS = "mini"
BACKEND = Path(__file__).resolve().parents[1]
KW = dict(scope="files", values=None, paths=["board.jsonl"], limit=None, comment=False, filter=False,
          created_by="test", chat=None, group=None, card=False)
PROMPT = "Does the post ask another agent for something?"
BOARD = [f"board.jsonl#L{i}" for i in range(1, 9)]  # the corpus's 8 board posts


@pytest.fixture(autouse=True)
def _clean_state(workspaces_tmp, mini_dir, monkeypatch):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    ws = config.workspace_dir(CORPUS)
    (ws / "trusted").mkdir(parents=True, exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": "terminal"}))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    monkeypatch.setattr(events, "post", lambda *a, **k: {"id": "e1", "delivered": 1})
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    monkeypatch.setattr(concepts, "APPLY_WAIT_S", 0.3)
    monkeypatch.setattr(concepts, "STOP_POLL_S", 0.05, raising=False)
    monkeypatch.setattr(model_call, "parallel", lambda: 2)
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()


class Gate:
    """The classifier: answers `open` calls, then holds each call until `release` is set; every value is `yes`."""

    def __init__(self, open_calls: int):
        self.open = open_calls
        self.asked: list[str] = []
        self.release = asyncio.Event()

    async def __call__(self, c, concept, items, comment=True, on_retry=None):
        if len(self.asked) >= self.open:
            await self.release.wait()
        self.asked += [r for r, _t in items]
        return model_mod.CallResult(status="ok", output={"labels": [{"i": n, "label": "yes", "confidence": 0.9}
                                                                    for n, _ in enumerate(items, 1)]}, attempts=1)

    async def asked_at_least(self, n: int) -> None:
        for _ in range(200):
            if len(self.asked) >= n:
                return
            await asyncio.sleep(0.02)
        raise AssertionError(f"the classifier was asked {len(self.asked)} times, not {n}")


def _cli(*argv: str) -> dict | list:
    """`thimble state` or `thimble act` in a process of its own, as the terminal runs it: its printed JSON."""
    out = subprocess.run([sys.executable, "-m", "app.local", *argv, "--cwd", str(config.corpus_dir(CORPUS))],
                         cwd=BACKEND, env=dict(os.environ), capture_output=True, text=True, timeout=120)
    return json.loads(out.stdout)


async def other_process(*argv: str) -> dict | list:
    return await asyncio.to_thread(_cli, *argv)


def _labels_chat(cid: str) -> str:
    from app import agents

    return next(str(m["id"]) for m in agents.list_chats(CORPUS) if m.get("role") == "labels" and m.get("concept") == cid)


async def test_a_run_main_started_is_seen_and_stopped_from_another_process(monkeypatch):
    gate = Gate(3)
    monkeypatch.setattr(concepts, "classify_structured", gate)
    got = await concepts.apply_scoped(CORPUS, name="asks", kind="prompt", text=PROMPT, **KW)
    cid = got["concept"]
    ws = config.workspace_dir(CORPUS)
    await gate.asked_at_least(3)
    await asyncio.sleep(0.2)  # the third row written
    here = await asyncio.to_thread(concepts.with_stats, ws, concepts.read_concept(ws, cid))
    # I2: `thimble state` in another process gives this process's run, with the same counts
    there = next(k for k in await other_process("state", "labels") if k["id"] == cid)
    assert there["run"] and there["run"]["status"] == "running" and there["run"]["total"] == 8
    assert there["run"]["run_id"] == here["run"]["run_id"]
    assert there["counts"] == here["counts"] == {"yes": 3}
    one = await other_process("state", "label", cid)
    assert one["run"]["status"] == "running" and one["counts"] == {"yes": 3}
    # a second run of it from another process is refused while this one goes on
    second = await other_process("act", "label-run", json.dumps({"label": cid}))
    assert "already being applied" in second["error"]
    # I1: the stop of the chat that follows main's run, from another process, stops the run after its current unit
    stopped = await other_process("act", "stop", json.dumps({"agent": _labels_chat(cid)}))
    assert stopped == {"ok": True, "stopped": True, "label": cid}
    summary = await concepts.wait_apply(CORPUS, cid, 10)
    last = concepts.read_concept(ws, cid)["applications"][-1]
    assert summary["stopped"] is True and last["stopped"] is True and last["labeled"] == 3 and last["total"] == 8
    assert not concepts.run_file(ws, cid).exists() and not concepts.stop_file(ws, cid).exists()
    # with no run going, a stop says so
    assert await other_process("act", "label-stop", json.dumps({"label": cid})) == {
        "ok": True, "label": cid, "stopping": False, "reason": local.LABEL_NOT_RUNNING}
    again = await other_process("act", "stop", json.dumps({"agent": _labels_chat(cid)}))
    assert again["stopped"] is False and again["reason"] == local.LABEL_NOT_RUNNING
    assert "hooks module" not in json.dumps(again)
    after = next(k for k in await other_process("state", "labels") if k["id"] == cid)
    assert (after["run"] or {}).get("status") != "running" and after["last_run"]["stopped"] is True


async def test_a_label_within_another_counts_its_scope_by_the_records_it_runs_over(monkeypatch):
    await concepts.apply_scoped(CORPUS, name="claims", kind="regex", text=r"(?i)forge pr claim", **KW)  # 3 of the 8
    gate = Gate(1)
    monkeypatch.setattr(concepts, "classify_structured", gate)
    cid = (await concepts.apply_scoped(CORPUS, name="asks", kind="prompt", text=PROMPT,
                                       within={"label": "claims", "value": "yes"}, **KW))["concept"]
    ws = config.workspace_dir(CORPUS)
    await gate.asked_at_least(1)
    there = next(k for k in await other_process("state", "labels") if k["id"] == cid)
    assert there["run"]["status"] == "running" and there["run"]["total"] == 3
    gate.release.set()
    await concepts.wait_apply(CORPUS, cid, 10)
    # a label with rows and no run kept (Claude Code quit under its first run): its scope is its narrowing's 3 records
    k = concepts.read_concept(ws, cid)
    concepts.write_concept(ws, {**k, "applications": []})
    listed = next(x for x in await local.state(CORPUS, "labels") if x["id"] == cid)
    assert listed["scope_total"] == 3
