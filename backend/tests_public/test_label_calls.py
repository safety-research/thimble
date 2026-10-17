"""A prompt label's run as model calls through the analyst's Claude Code session (concepts.labels_task,
model_call.structured): each classifier batch is one completion (the fake bridge, subagent_fakes, plays the plugin
module's $.model.complete), several run at once, every batch carries the same system prompt for the prompt cache, and
the run writes the same rows and counts as before; with no Claude Code session the run ends with the fix; the
analyst's cancel aborts the calls that run. No agent starts."""
from __future__ import annotations

import asyncio
import json
import re

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, refs, subagent_files as sf, subagents
from app import module_bridge as real_bridge
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
MINI = config.corpus_dir(CORPUS)
ITEM = re.compile(r"^### item (\d+) \[([^\]\n]+)\]\n(.*?)(?=^### item |\Z)", re.S | re.M)


@pytest.fixture(autouse=True)
def _clean_state(workspaces_tmp, monkeypatch):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    monkeypatch.setattr(concepts, "BACKOFF_POLL", 0.01)
    sf.ensure(subagents.ws(CORPUS))
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()


@pytest.fixture()
async def api():
    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=60) as c:
        yield c


def _expected() -> dict[str, str]:
    exp = {}
    for i, line in enumerate((MINI / "board.jsonl").read_text("utf-8").splitlines(), 1):
        text = "\n\n".join(b["text"] for b in refs.record_blocks(json.loads(line), "board"))
        exp[f"board.jsonl#L{i}"] = "yes" if "claim" in text.lower() else "no"
    return exp


def _answer(text: str) -> str:
    """The reply a model gives a batch's items: yes for a text that mentions a claim, as JSON."""
    return json.dumps({"labels": [{"i": int(m.group(1)), "label": "yes" if "claim" in m.group(3).lower() else "no",
                                   "confidence": 0.9, "rationale": "because"} for m in ITEM.finditer(text)]})


def _reply(op: str, args: dict) -> dict:
    return {"text": _answer(args["prompt"][0]["text"]), "usage": {"output_tokens": 30}}


async def _label(api, **kw) -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "claims a PR", "description": "a post that claims a PR",
                                                           **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_prompt_label_s_batches_are_completions_that_run_together_with_one_cached_system_prompt(
        api, bridge, monkeypatch, workspaces_tmp):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)

    async def slow(op, args):
        await asyncio.sleep(0.05)
        return _reply(op, args)

    bridge.respond = slow
    k = await _label(api)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    s = r.json()
    expected = _expected()
    assert s["status"] == "done" and s["total"] == 8 and s["labeled"] == 8 and s["failed"] == 0, s
    assert s["counts"] == {"yes": sum(v == "yes" for v in expected.values()), "no": sum(v == "no" for v in expected.values())}
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"]: r["label"] for r in rows} == expected and [r["ref"] for r in rows] == list(expected)
    assert all(r["source"] == "model" and r["confidence"] == 0.9 and r["rationale"] == "because" for r in rows)
    calls = bridge.ops("complete")
    assert len(calls) == 3, "3 + 3 + 2 items"
    assert bridge.most == 3, "the batches run at once"
    systems = {json.dumps(c["system"]) for c in calls}
    assert len(systems) == 1, "every batch sends the same system prompt, read from the cache after the first"
    [system] = calls[0]["system"]
    assert system["cache"] is True and "claims a PR" in system["text"] and '"labels"' in system["text"]
    assert any("### item 3 [board.jsonl#L3]" in c["prompt"][0]["text"] for c in calls)
    assert not bridge.ops("spawn"), "no agent starts"


async def test_a_prompt_label_with_no_claude_code_session_ends_with_the_fix(api, bridge):
    bridge.is_live, bridge.reason = False, real_bridge.NO_MAIN
    k = await _label(api)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 502 and "prompt labels cannot run" in r.text and "type /thimble" in r.text
    got = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()
    assert got["applications"][-1]["status"] == "error" and not bridge.ops("spawn")


async def test_the_analyst_s_cancel_aborts_the_label_s_calls_that_run(api, bridge, monkeypatch, workspaces_tmp):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)
    hung = asyncio.Event()

    async def first_then_hang(op, args):
        if "### item 1 [board.jsonl#L1]" in args["prompt"][0]["text"]:
            return _reply(op, args)
        hung.set()
        await asyncio.sleep(60)

    bridge.respond = first_then_hang
    k = await _label(api)
    run = asyncio.create_task(api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply",
                                       json={"wait": True, "paths": ["board.jsonl"]}))
    await asyncio.wait_for(hung.wait(), 10)
    await asyncio.sleep(0.1)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply/cancel")
    assert r.status_code == 200, r.text
    s = (await asyncio.wait_for(run, 10)).json()
    assert s["status"] == "done" and s["stopped"] is True and s["labeled"] == 3 and s["failed"] == 0, s
    assert "canceled by the analyst" in (s["message"] or "")
    assert bridge.running == 0, "the calls that ran were cancelled"
    assert len(concepts.read_labels(workspaces_tmp / CORPUS, k["id"])) == 3
