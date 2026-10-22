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
    monkeypatch.setattr(agent, "AFTER_TURN", [])
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


async def test_a_report_write_shows_in_the_report_as_it_streams_in(ws, monkeypatch):
    import json

    from thimble_browser import report, tools
    from thimble_browser.features import report as report_feature
    monkeypatch.setitem(tools.EXTRA, "write_document", report_feature.write_document)
    monkeypatch.setitem(agent.ON_INPUT, "write_document", report_feature._on_input("write_document"))
    monkeypatch.setattr(agent, "NOTIFY_S", 0)
    text_out = "# Runs\n\nTwo runs merged. One failed on a flaky test."
    body = json.dumps({"text": text_out})
    seen = []

    class Streaming(FakeStream):
        async def _events(self):
            b = self.reply.content[0]
            if b.type != "tool_use":
                yield NS(type="text", text=b.text)
                return
            yield NS(type="content_block_start", index=0, content_block=b)
            for i in range(0, len(body), 12):
                yield NS(type="content_block_delta", index=0, delta=NS(type="input_json_delta",
                                                                       partial_json=body[i:i + 12]))
                doc = report.writeup(ws)
                seen.append((doc.get("drafting"), " ".join(s["text"] for sec in doc["sections"]
                                                           for p in sec["paragraphs"] for s in p["sentences"])))
            yield NS(type="content_block_stop", content_block=b)

    client = FakeClient([
        NS(content=[call("t1", "write_document", {"text": text_out})], stop_reason="tool_use", usage=usage(),
           stop_details=None),
        NS(content=[text("Written.")], stop_reason="end_turn", usage=usage(), stop_details=None),
    ])
    client.beta.messages.stream = lambda **req: (client.requests.append(req), Streaming(client.replies.pop(0), 0))[1]
    s = await run_turn(ws, client, monkeypatch)
    await s.task
    drafts = [t for d, t in seen if d]
    # the report grew while the call streamed in, then the saved report took the draft's place
    assert len(drafts) >= 3 and all(a != b and b.startswith(a[:-1]) for a, b in zip(drafts, drafts[1:]))
    assert drafts[-1].startswith("Two runs merged. One failed")
    final = report.writeup(ws)
    assert not final.get("drafting") and "flaky test" in report.markdown(ws)


async def test_the_reply_after_a_turn_is_the_text_after_its_last_call(ws, monkeypatch):
    heard = []
    monkeypatch.setattr(agent, "AFTER_TURN", [lambda s, answer, result: heard.append(answer)])
    client = FakeClient([
        NS(content=[text("Let me count the runs first."), call("t1", "Read", {"file_path": "results.csv"})],
           stop_reason="tool_use", usage=usage(), stop_details=None),
        NS(content=[text("2 runs [2](results.csv#row=1).")], stop_reason="end_turn", usage=usage(), stop_details=None),
    ])
    s = await run_turn(ws, client, monkeypatch)
    await s.task
    assert heard == ["2 runs [2](results.csv#row=1)."]
    # the note stays in the log, where the steps show it
    assert any(r.get("delta") == "Let me count the runs first." for r in chats.records(ws, "main"))


def turn_steps(*steps):
    """A made-up turn's replies, each a list of blocks; the last ends the turn."""
    out = [NS(content=list(b), stop_reason="tool_use", usage=usage(), stop_details=None) for b in steps[:-1]]
    return out + [NS(content=list(steps[-1]), stop_reason="end_turn", usage=usage(), stop_details=None)]


async def heard_and_texts(ws, monkeypatch, client):
    """What the after-turn work hears as the turn's reply, and the turn's texts, which the marks are read from."""
    heard = []
    monkeypatch.setattr(agent, "AFTER_TURN", [lambda s, answer, result: heard.append(answer)])
    s = await run_turn(ws, client, monkeypatch)
    await s.task
    return heard, s.texts


async def test_an_answer_and_then_a_call_with_nothing_after_keeps_the_answer_as_the_reply(ws, monkeypatch):
    answer = "Three of the five runs merged [3](#)."
    client = FakeClient(turn_steps([text(answer), call("t1", "Glob", {"pattern": "*.csv"})], []))
    assert await heard_and_texts(ws, monkeypatch, client) == ([answer], [answer])


async def test_a_note_a_call_and_then_the_answer_reads_only_the_answer(ws, monkeypatch):
    client = FakeClient(turn_steps([text("Let me count the runs first."), call("t1", "Read", {"file_path": "results.csv"})],
                                   [text("Three of the five runs merged.")]))
    assert await heard_and_texts(ws, monkeypatch, client) == (
        ["Three of the five runs merged."], ["Let me count the runs first.", "Three of the five runs merged."])


async def test_a_note_the_answer_and_then_calls_reads_the_answer_not_the_note(ws, monkeypatch):
    client = FakeClient(turn_steps(
        [text("Let me count the runs first."), call("t1", "Read", {"file_path": "results.csv"})],
        [text("Three of the five runs merged."), call("t2", "Glob", {"pattern": "*.csv"})],
        [call("t3", "Glob", {"pattern": "*.md"})],
        [text("\n\n")]))
    heard, texts = await heard_and_texts(ws, monkeypatch, client)
    assert heard == ["Three of the five runs merged."]
    assert texts == ["Let me count the runs first.", "Three of the five runs merged.", "\n\n"]


def test_a_turns_texts_join_the_words_between_two_calls():
    assert agent.texts_of([(False, "A "), (False, "b."), (True, ""), (False, "C.")]) == ["A b.", "C."]
    assert agent.texts_of([(True, ""), (True, "")]) == []


def test_reply_of_is_the_text_after_the_last_call_else_the_last_text_before_it():
    assert agent.reply_of([(False, "Note."), (True, ""), (False, "Answer.")]) == "Answer."
    assert agent.reply_of([(False, "Note."), (True, ""), (False, "Answer."), (True, ""), (True, "")]) == "Answer."
    assert agent.reply_of([(False, "Just words.")]) == "Just words."
    assert agent.reply_of([(True, "")]) == ""
