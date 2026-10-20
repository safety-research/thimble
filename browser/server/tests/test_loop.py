"""The agent loop against a fake Messages API: it streams text into the chat's log, runs the tools Claude calls, sends
their results back, ends the turn with its token use, and a stopped turn leaves the conversation valid."""
import asyncio
import copy
from types import SimpleNamespace as NS

import pytest

from thimble_browser import agent, chats, home, llm


class Block(NS):
    def model_dump(self, **kw):
        return {k: v for k, v in self.__dict__.items() if v is not None}


def text(t):
    return Block(type="text", text=t)


def call(id_, name, inp):
    return Block(type="tool_use", id=id_, name=name, input=inp)


def usage():
    return NS(input_tokens=10, output_tokens=5, cache_read_input_tokens=100, cache_creation_input_tokens=0)


class FakeStream:
    def __init__(self, reply, hold):
        self.reply, self.hold = reply, hold

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def __aiter__(self):
        return self._events()

    async def _events(self):
        if self.hold:
            await asyncio.sleep(30)
        for b in self.reply.content:
            if b.type == "text":
                yield NS(type="text", text=b.text)
            else:
                yield NS(type="content_block_stop", content_block=b)

    async def get_final_message(self):
        return self.reply


class FakeClient:
    def __init__(self, replies, hold_at=None):
        self.replies, self.requests, self.hold_at = list(replies), [], hold_at
        self.beta = NS(messages=NS(stream=self.stream))

    def stream(self, **req):
        self.requests.append(copy.deepcopy(req))  # the SDK sends the request as it is now
        hold = self.hold_at is not None and len(self.requests) - 1 == self.hold_at
        return FakeStream(self.replies.pop(0), hold)


@pytest.fixture
def ws(folder, monkeypatch):
    name = home.open_folder(folder)
    chats.ensure_main(name)
    monkeypatch.setattr(agent.explain, "after_turn", lambda *a, **k: asyncio.sleep(0))
    return name


async def run_turn(ws, client, monkeypatch, text_in="How many runs?"):
    monkeypatch.setattr(llm, "client", lambda: client)
    sessions = agent.Sessions()
    s = sessions.get(ws, "main")
    await s.send(text_in)
    return s


async def test_a_turn_runs_tools_and_ends_with_its_usage(ws, monkeypatch):
    client = FakeClient([
        NS(content=[text("Reading."), call("t1", "Read", {"file_path": "results.csv"})], stop_reason="tool_use",
           usage=usage(), stop_details=None),
        NS(content=[text("2 runs [2](results.csv#row=1).")], stop_reason="end_turn", usage=usage(), stop_details=None),
    ])
    s = await run_turn(ws, client, monkeypatch)
    await s.task
    recs = chats.records(ws, "main")
    kinds = [r["type"] for r in recs]
    assert kinds[:4] == ["user", "text", "tool_use", "tool_result"] and kinds[-1] == "done"
    assert recs[-1]["usage"]["requests"] == 2 and recs[-1]["usage"]["cache_read_input_tokens"] == 200
    second = client.requests[1]["messages"]
    assert second[-1]["role"] == "user" and second[-1]["content"][0]["tool_use_id"] == "t1"
    assert "run,outcome" in second[-1]["content"][0]["content"]
    assert client.requests[0]["system"][0]["cache_control"] == {"type": "ephemeral"}
    msgs = agent.load_messages(ws, "main")
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]


async def test_a_stopped_turn_leaves_the_conversation_valid(ws, monkeypatch):
    client = FakeClient([
        NS(content=[call("t1", "Read", {"file_path": "results.csv"})], stop_reason="tool_use", usage=usage(),
           stop_details=None),
        NS(content=[text("never")], stop_reason="end_turn", usage=usage(), stop_details=None),
    ], hold_at=1)
    s = await run_turn(ws, client, monkeypatch)
    for _ in range(50):
        if len(client.requests) == 2:
            break
        await asyncio.sleep(0.05)
    assert await s.interrupt()
    recs = chats.records(ws, "main")
    assert recs[-1]["type"] == "done" and recs[-1]["result"] == "stopped"
    msgs = agent.load_messages(ws, "main")
    # the tool call got its result before the stop, and the reply in progress was dropped
    assert msgs[-1]["role"] == "user" and msgs[-1]["content"][0]["tool_use_id"] == "t1"
    assert not s.running


async def test_a_refusal_is_a_row_not_a_crash(ws, monkeypatch):
    client = FakeClient([NS(content=[], stop_reason="refusal", usage=usage(), stop_details=NS(category="cyber"))])
    s = await run_turn(ws, client, monkeypatch)
    await s.task
    errs = [r for r in chats.records(ws, "main") if r["type"] == "error"]
    assert errs and "declined" in errs[0]["message"]
