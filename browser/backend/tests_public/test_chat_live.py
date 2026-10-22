"""What the page sees of main's turn before the turn's records land (runtime.Conv.live_text, runtime_api._stream): the
words of a reply as Claude writes them, pushed to the open pages and never logged; the client built off the event loop,
so the analyst's own message is not held behind the SDK's import; and main's model, which the composer's menu picks
(events.model_route) and main's next turn runs on. The Messages API is test_runtime's fake client."""
from __future__ import annotations

import asyncio
import threading
from typing import Any

from fastapi.testclient import TestClient

from app import agents, config, investigation, llm, runtime
from test_runtime import CORPUS, Block, FakeClient, FakeStream, Final, api_key, main_records, main_turn, on, shape, text  # noqa: F401


class Ev:
    def __init__(self, **kw: Any) -> None:
        self.__dict__.update(kw)


def deltas(*parts: str) -> list[Ev]:
    """The stream events of one text block written in `parts`."""
    evs = [Ev(type="message_start"), Ev(type="content_block_start", index=0, content_block=Ev(type="text"))]
    evs += [Ev(type="content_block_delta", index=0, delta=Ev(type="text_delta", text=p)) for p in parts]
    return evs + [Ev(type="content_block_stop", index=0), Ev(type="message_stop")]


class DeltaStream(FakeStream):
    """A streamed reply: its events one by one, each after a short wait, then its final message."""

    def __init__(self, final: Final, events: list[Ev], wait: float) -> None:
        super().__init__(final)
        self.events, self.wait = list(events), wait

    async def __anext__(self) -> Any:
        if not self.events:
            raise StopAsyncIteration
        await asyncio.sleep(self.wait)
        return self.events.pop(0)


class DeltaClient(FakeClient):
    def __init__(self, parts: list[str], wait: float = 0.06) -> None:
        super().__init__([])
        self.parts, self.wait = parts, wait

    def stream(self, **body: Any) -> DeltaStream:
        self.bodies.append(body)
        return DeltaStream(Final([Block(type="text", text="".join(self.parts))]), deltas(*self.parts), self.wait)


def listen() -> tuple[list[dict[str, Any]], Any]:
    """What a page open on the workspace's stream gets: its queue, read as a list."""
    investigation.ensure_main(CORPUS)
    q: asyncio.Queue = asyncio.Queue()
    investigation._subscribers.setdefault((CORPUS, investigation.MAIN), set()).add(q)
    got: list[dict[str, Any]] = []

    def drain() -> list[dict[str, Any]]:
        while not q.empty():
            got.append(q.get_nowait())
        return got

    return got, drain


async def test_main_s_words_reach_the_page_while_claude_writes_them(on, monkeypatch):
    api_key(monkeypatch, [])
    parts = ["Since ", "[March 3](#), ", "41 of the 44 ", "nightly runs failed."]
    client = DeltaClient(parts)
    monkeypatch.setattr(llm, "client", lambda: client)
    _, drain = listen()
    seen: list[tuple[str, Any]] = []  # each live record, with whether the log held the reply when it came

    def watch() -> None:
        for ev in drain()[len(seen):]:
            logged = ("text", "".join(parts)) in shape(main_records())
            seen.append((ev.get("type"), {**ev, "logged": logged}))

    events_post = asyncio.create_task(main_turn("Why did the nightly build start failing?"))
    while not events_post.done():
        watch()
        await asyncio.sleep(0.01)
    watch()
    live = [ev for kind, ev in seen if kind == "chat-live"]
    texts = [ev["text"] for ev in live if "text" in ev]
    # the words grow as they are written, each push the text so far, and none of them is in the log yet
    assert len(texts) >= 3
    assert texts == sorted(texts, key=len) and texts[-1] == "".join(parts)
    assert all(t.startswith("Since") for t in texts)
    assert not any(ev["logged"] for ev in live if "text" in ev)
    # then the message is complete: the log holds it before the page is told to drop the words
    ends = [ev for ev in live if ev.get("end")]
    assert len(ends) == 1 and ends[0]["logged"] and ends[0]["piece"] == live[0]["piece"]
    assert all(ev["chat"] == agents.MAIN_ID and "seq" not in ev for ev in live)
    # never written to the workspace's log, so a page that opens later never replays them
    stored = investigation._read_jsonl(investigation._existing(CORPUS, investigation.MAIN) / "events.jsonl")
    assert not [e for e in stored if e.get("type") == "chat-live"]


async def test_the_end_token_never_flashes_while_it_is_written(on, monkeypatch):
    api_key(monkeypatch, [])
    client = DeltaClient(["Done.\n\n", "(sho", "wn in the dash", "board)"], wait=0.07)
    monkeypatch.setattr(llm, "client", lambda: client)
    _, drain = listen()
    await main_turn("go")
    texts = [ev["text"] for ev in drain() if ev.get("type") == "chat-live" and "text" in ev]
    assert texts and all("(sh" not in t for t in texts), texts
    assert texts[-1] == "Done."


async def test_the_client_is_built_off_the_event_loop(on, monkeypatch):
    api_key(monkeypatch, [])
    loop_thread = threading.current_thread()
    built_in: list[threading.Thread] = []
    client = FakeClient([text("ok")])

    def build() -> FakeClient:
        built_in.append(threading.current_thread())
        return client

    monkeypatch.setattr(llm, "client", build)
    await main_turn("hello")
    assert built_in and all(t is not loop_thread for t in built_in)


def test_warm_never_raises_without_a_choice(monkeypatch):
    def boom() -> None:
        raise llm.NoCredentials("no choice")

    monkeypatch.setattr(llm, "client", boom)
    llm.warm()


async def test_the_composer_s_model_is_the_one_main_s_next_turn_runs_on(on, monkeypatch):
    from app.main import app

    client = api_key(monkeypatch, [text("one"), text("two")])
    await main_turn("first")
    assert client.bodies[0]["model"] == runtime.MAIN_MODEL == "claude-opus-5-5"
    with TestClient(app, base_url="http://127.0.0.1") as http:
        bad = http.put(f"/api/ws/{CORPUS}/session/model", json={"model": "gpt-9; rm -rf"})
        r = http.put(f"/api/ws/{CORPUS}/session/model", json={"model": "claude-sonnet-5[1m]"})
    assert bad.status_code == 400, bad.text
    assert r.status_code == 200 and r.json() == {"model": "claude-sonnet-5"}, r.text
    stored = config.workspace_dir(CORPUS) / "settings.json"
    assert '"claude-sonnet-5"' in stored.read_text()
    await main_turn("second")
    assert client.bodies[1]["model"] == "claude-sonnet-5"
