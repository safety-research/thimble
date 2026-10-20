"""A label run never holds the chat's turn (labels/asks.py, labels/chat.py): a model label over many records asks the
analyst first and the turn ends at once; a long run goes on in the background as a row of the chat; how a run ended
reaches the agent with the next message; and a run's calls go many at once, slowing down when the API is busy."""
import asyncio
import copy
import json
import time
from types import SimpleNamespace as NS

import pytest

from thimble_browser import agent, chats, home, llm, tools
from thimble_browser.labels import asks, chat, run, store


class Block(NS):
    def model_dump(self, **kw):
        return {k: v for k, v in self.__dict__.items() if v is not None}


def usage():
    return NS(input_tokens=10, output_tokens=5, cache_read_input_tokens=0, cache_creation_input_tokens=0)


class Stream:
    def __init__(self, reply):
        self.reply = reply

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def __aiter__(self):
        return self._events()

    async def _events(self):
        for b in self.reply.content:
            if b.type == "text":
                yield NS(type="text", text=b.text)
            else:
                yield NS(type="content_block_stop", content_block=b)

    async def get_final_message(self):
        return self.reply


class Client:
    """Main's requests: the replies in order, each request kept as it was sent."""

    def __init__(self, replies):
        self.replies, self.requests = list(replies), []
        self.beta = NS(messages=NS(stream=self.stream))

    def stream(self, **req):
        self.requests.append(copy.deepcopy(req))
        return Stream(self.replies.pop(0))


def reply(*blocks):
    calls = any(b.type == "tool_use" for b in blocks)
    return NS(content=list(blocks), stop_reason="tool_use" if calls else "end_turn", usage=usage(), stop_details=None)


def answer_all(value="yes"):
    async def fake_call(concept, system, user, rec):
        await asyncio.sleep(0.01)
        n = user.count("### record ")
        return json.dumps({"records": [{"i": i, "value": value, "confidence": 0.9} for i in range(1, n + 1)]})
    return fake_call


@pytest.fixture
def big(folder, monkeypatch):
    """The folder with 2,000 records of about 600 characters each: a model label over them asks first."""
    (folder / "edits.jsonl").write_text("".join(json.dumps({"n": i, "body": "word " * 120}) + "\n"
                                                for i in range(1, 2001)))
    ws = home.open_folder(folder)
    chats.ensure_main(ws)
    monkeypatch.setattr(agent, "AFTER_TURN", [])
    monkeypatch.setitem(tools.EXTRA, "apply_label", chat.apply_label)
    return ws


def label_runs(ws, chat_id="main"):
    return [r for r in chats.records(ws, chat_id) if r["type"] == "label_run"]


async def test_a_big_model_label_asks_first_and_the_turn_goes_on(big, folder, monkeypatch):
    """The stall: main called apply_label over 14,591 records and its turn waited for every model call. Now the call
    asks the analyst and answers at once, and main's turn ends with its answer."""
    ws = big
    monkeypatch.setattr(run, "_call", answer_all())
    client = Client([
        reply(Block(type="tool_use", id="t1", name="apply_label", input={
            "scope": "files", "name": "edit purpose", "paths": ["edits.jsonl"],
            "predicate": {"kind": "prompt", "text": "What the edit is for."}, "values": ["yes", "no"]})),
        reply(Block(type="text", text="Here is what the files hold; the label waits for your choice.")),
    ])
    monkeypatch.setattr(llm, "client", lambda: client)
    s = agent.Sessions().get(ws, "main")
    t0 = time.monotonic()
    await s.send("What's going on in this dataset?")
    await asyncio.wait_for(s.task, 10)
    assert time.monotonic() - t0 < 10
    k = store.find(ws, "edit purpose")
    assert not run.running(ws, k["id"]) and store.stats(ws, k["id"])["n_labeled"] == 0
    (asked,) = label_runs(ws)
    assert asked["state"] == "asked" and asked["units"] == 2000 and asked["sample"] == asks.SAMPLE
    assert asked["text"].startswith("Read 2,000 records of edits.jsonl with Claude: about ") and " calls, about " in asked["text"]
    result = client.requests[1]["messages"][-1]["content"][0]["content"]
    assert "It has not run." in result and "waits for their choice" in result
    assert chats.records(ws, "main")[-1]["type"] == "done"

    # the analyst picks a sample: the run reads that many, at random, and the row says how it ended
    await asks.answer(ws, folder, asked["id"], "sample")
    await run.wait(ws, k["id"], 30)
    states = [r["state"] for r in label_runs(ws)]
    assert states == ["asked", "running", "done"]
    assert run.record(ws, k["id"])["total"] == asks.SAMPLE
    assert label_runs(ws)[-1]["text"] == f"Read {asks.SAMPLE} records of edits.jsonl: yes {asks.SAMPLE} · no 0."
    with pytest.raises(store.LabelError):
        await asks.answer(ws, folder, asked["id"], "all")

    # main hears the choice and the counts with the analyst's next message
    client.replies.append(reply(Block(type="text", text="The sample says yes.")))
    await s.send("And the label?")
    await asyncio.wait_for(s.task, 10)
    first = client.requests[-1]["messages"][-1]["content"]
    assert first[0]["text"].startswith(agent.NOTES_HEAD)
    assert "chose to run the label edit purpose" in first[0]["text"] and f"yes [{asks.SAMPLE}](concept:{k['id']}/yes)" in first[0]["text"]
    assert first[1] == {"type": "text", "text": "And the label?"}
    assert agent.take_notes(ws, "main") == []


def test_the_estimate_counts_the_real_batches_and_prices_the_model(big, folder):
    ws = big
    concept = store.new_concept("e", description="x", kind="prompt", unit="record", labels=None,
                                created_by="chat:main", glob=["edits.jsonl"])
    found = run.scope_units(ws, folder, concept, ["edits.jsonl"], None)
    est = asks.estimate(concept, found)
    from thimble_browser.labels import classify
    assert est["units"] == 2000 and est["calls"] == len(classify.batches(found))
    assert est["dollars"] and est["dollars"] > 0 and est["seconds"] > 0
    assert asks.needs_asking(est)
    assert not asks.needs_asking({**est, "units": asks.SAMPLE})


def test_the_label_editors_run_asks_first_with_the_same_ask(big, folder, monkeypatch):
    """The page's own Run (POST /concepts/{id}/apply) over many records: the same line and choices as the chat, answered
    through the same route, and no chat gets a row or a note."""
    from fastapi.testclient import TestClient

    from thimble_browser.app import build

    monkeypatch.setattr(run, "_call", answer_all("no"))
    port = 21099
    app, auth, _ = build(port)
    with TestClient(app, base_url=f"http://127.0.0.1:{port}") as c:
        r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": f"http://127.0.0.1:{port}"})
        key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]
        c.headers.update({"cookie": cookie, "origin": f"http://127.0.0.1:{port}"})
        base = f"/b/{key}/api/ws/{big}"
        made = c.post(f"{base}/concepts", json={"name": "purpose", "kind": "prompt", "description": "What it is for.",
                                                "labels": ["yes", "no"], "glob": "edits.jsonl"})
        cid = made.json()["id"]
        got = c.post(f"{base}/concepts/{cid}/apply", json={}).json()
        assert got["status"] == "asked" and not run.running(big, cid)
        ask = got["ask"]
        assert ask["text"].startswith("Read 2,000 records of edits.jsonl with Claude: about ")
        assert ask["units"] == 2000 and ask["sample"] == asks.SAMPLE
        assert c.post(f"{base}/concepts/{cid}/apply", json={}).json()["ask"]["id"] == ask["id"]  # one ask, not two
        assert c.get(f"{base}/concepts/{cid}").json()["ask"]["id"] == ask["id"]  # the editor shows it when it opens
        assert c.post(f"{base}/label-runs/{ask['id']}", json={"choice": "sample"}).status_code == 200
        for _ in range(200):
            if not run.running(big, cid):
                break
            time.sleep(0.05)
        assert run.record(big, cid)["total"] == asks.SAMPLE and run.record(big, cid)["status"] == "done"
        assert c.get(f"{base}/concepts/{cid}").json()["ask"] is None
    assert label_runs(big) == [] and agent.take_notes(big, "main") == []


async def test_a_label_described_with_no_files_reads_every_file(big, folder, monkeypatch):
    """The Labels sidebar's New label chooses no files: the drafted label applies to every file, so its Run reaches
    the ask instead of failing with "applies to no files"."""
    from thimble_browser.labels import api

    seen = {}

    async def complete(system, user, **kw):
        seen["prompt"] = system
        return json.dumps({"scope": "files", "kind": "prompt", "name": "asks", "text": "Asks a question.",
                           "values": ["yes", "no"], "marks": "span"})

    monkeypatch.setattr(llm, "complete", complete)
    got = await api.draft(big, folder, "edits that ask a question", [])
    assert got["glob"] == "*" and "edits.jsonl" in seen["prompt"]
