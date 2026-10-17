"""A prompt label's run as one model call of many parts (concepts._LabelCall, agent_call.run): each classifier batch is a
part that a `thimble:call` agent, a subagent of main started through the module (the fake bridge, subagent_fakes),
reads and answers, and the run writes the same rows and counts as before; a run of one batch gives it in its agent's
first message; with no Claude Code session the run ends with the fix; the analyst's cancel stops the agents."""
from __future__ import annotations

import asyncio
import json
import re

import httpx
import pytest
from fastapi import FastAPI

from app import agent_call, concepts, config, refs, subagent_files as sf, subagents, tools
from app import module_bridge as real_bridge
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
MINI = config.corpus_dir(CORPUS)
ITEM = re.compile(r"^### item (\d+) \[([^\]\n]+)\]\n(.*?)(?=^### item |\Z)", re.S | re.M)


@pytest.fixture(autouse=True)
def _clean_state(workspaces_tmp, monkeypatch):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    monkeypatch.setattr(agent_call, "POLL_S", 0.01)
    monkeypatch.setattr(agent_call, "END_GRACE_S", 0.0)
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


def _answer(text: str) -> dict:
    """The labels a scripted agent gives a part's items: yes for a text that mentions a claim."""
    return {"labels": [{"i": int(m.group(1)), "label": "yes" if "claim" in m.group(3).lower() else "no",
                        "confidence": 0.9, "rationale": "because"} for m in ITEM.finditer(text)]}


class Agents:
    """The call's agents as scripted subagents: each reads its parts and answers every one, as call-task.md asks."""

    def __init__(self) -> None:
        self.n = 0
        self.done: set[str] = set()
        self.parts: list[int] = []

    async def tool(self, aid: str, key: str, name: str, args: dict) -> tools.ToolResult:
        self.n += 1
        tid = f"toolu_{name}_{self.n}"
        sf.add_caller(subagents.ws(CORPUS), tid, aid, "thimble:call")
        return await tools.call(CORPUS, name, args, session=key, tool_use_id=tid)

    async def serve(self, aid: str, key: str, first: str) -> None:
        text = first if "### item" in first else (await self.tool(aid, key, "read_call", {})).text
        while "### item" in text:
            self.parts.append(len(self.parts) + 1)
            text = (await self.tool(aid, key, "send_answer", {"answer": _answer(text)})).text
            text = text.split("Your next part follows.", 1)[1] if "Your next part follows." in text else text
            if "Call read_call" in text:
                text = (await self.tool(aid, key, "read_call", {})).text
        self.done.add(aid)
        subagents.run_ended(CORPUS, aid, "done", "Done")

    async def run(self, bridge, until) -> None:
        """Serve each agent the call starts until `until` is done."""
        served: set[str] = set()
        while not until.done():
            for (aid, a), spawn in zip(list(subagents.agents_of(CORPUS, role="call").items()), bridge.ops("spawn")):
                if aid not in served:
                    served.add(aid)
                    await self.serve(aid, str(a["key"]), spawn["prompt"])
            await asyncio.sleep(0.01)


async def _label(api, **kw) -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "claims a PR", "description": "a post that claims a PR",
                                                           **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_prompt_label_s_batches_are_parts_of_one_call_that_subagents_answer(api, bridge, monkeypatch,
                                                                                  workspaces_tmp):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)
    k = await _label(api)
    run = asyncio.create_task(api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply",
                                       json={"wait": True, "paths": ["board.jsonl"]}))
    agents = Agents()
    await asyncio.wait_for(agents.run(bridge, run), 20)
    s = (await run).json()
    expected = _expected()
    assert s["status"] == "done" and s["total"] == 8 and s["labeled"] == 8 and s["failed"] == 0, s
    assert s["counts"] == {"yes": sum(v == "yes" for v in expected.values()), "no": sum(v == "no" for v in expected.values())}
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"]: r["label"] for r in rows} == expected and [r["ref"] for r in rows] == list(expected)
    assert all(r["source"] == "model" and r["confidence"] == 0.9 and r["rationale"] == "because" for r in rows)
    assert len(agents.parts) == 3, "3 + 3 + 2 items"
    spawns = bridge.ops("spawn")
    assert 1 <= len(spawns) <= concepts.LABEL_AGENTS
    assert {sp["role"] for sp in spawns} == {"call"} and spawns[0]["description"] == "thimble label: claims a PR"
    assert spawns[0]["drop"] == 'thimble labeled records for the label "claims a PR"'
    assert "claims a PR" in spawns[0]["prompt"] and "Call read_call to get the first part" in spawns[0]["prompt"]
    assert not agent_call.tasks_running(CORPUS), "the call ended with the run"


async def test_a_run_of_one_batch_gives_it_in_its_agent_s_first_message(api, bridge):
    k = await _label(api)
    run = asyncio.create_task(api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply",
                                       json={"wait": True, "paths": ["board.jsonl"]}))
    agents = Agents()
    await asyncio.wait_for(agents.run(bridge, run), 20)
    s = (await run).json()
    assert s["labeled"] == 8 and s["failed"] == 0
    [spawn] = bridge.ops("spawn")
    assert "### item 8 [board.jsonl#L8]" in spawn["prompt"] and "read_call" not in spawn["prompt"]


async def test_a_prompt_label_with_no_claude_code_session_ends_with_the_fix(api, bridge):
    bridge.is_live, bridge.reason = False, real_bridge.NO_MAIN
    k = await _label(api)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 502 and "prompt labels cannot run" in r.text and "type /thimble" in r.text
    got = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()
    assert got["applications"][-1]["status"] == "error" and not bridge.ops("spawn")


async def test_the_analyst_s_cancel_stops_the_label_s_agents(api, bridge, monkeypatch, workspaces_tmp):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)
    k = await _label(api)
    run = asyncio.create_task(api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply",
                                       json={"wait": True, "paths": ["board.jsonl"]}))
    for _ in range(500):
        if subagents.agents_of(CORPUS, role="call"):
            break
        await asyncio.sleep(0.01)
    [(aid, a)] = list(subagents.agents_of(CORPUS, role="call").items())[:1]
    agents = Agents()
    first = (await agents.tool(aid, str(a["key"]), "read_call", {})).text
    nxt = (await agents.tool(aid, str(a["key"]), "send_answer", {"answer": _answer(first)})).text
    assert "# Part 2" in nxt
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply/cancel")
    assert r.status_code == 200, r.text
    s = (await asyncio.wait_for(run, 10)).json()
    assert s["status"] == "done" and s["stopped"] is True and s["labeled"] == 3 and s["failed"] == 0, s
    assert "canceled by the analyst" in (s["message"] or "")
    for _ in range(500):
        if bridge.ops("stop"):
            break
        await asyncio.sleep(0.01)
    assert aid in {op["agent"] for op in bridge.ops("stop")}
    late = await agents.tool(aid, str(a["key"]), "send_answer", {"answer": _answer(nxt)})
    assert "stopped this task" in late.text
    assert len(concepts.read_labels(workspaces_tmp / CORPUS, k["id"])) == 3
