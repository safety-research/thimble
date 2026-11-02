"""What the page sees of main's turn before the turn's records land (runtime.Conv.live_text, runtime_api._stream): the
words of a reply as Claude writes them, pushed to the open pages and never logged; the client built off the event loop,
so the analyst's own message is not held behind the SDK's import; main's model, which the composer's menu picks
(events.model_route) and main's next turn runs on; and main's effort, the composer's choice, else the one Claude Code
runs main's model at by the analyst's settings (cc_settings.session_effort), which the composer's chip shows. The
Messages API is test_runtime's fake client."""
from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
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


def own_settings(monkeypatch, tmp_path: Path, settings: dict[str, Any] | None = None) -> Path:
    """The analyst's Claude Code settings file, in a config dir of the test's own, holding `settings` (no file for
    None); no effort or model comes from the environment."""
    cc = tmp_path / "claude-home"
    cc.mkdir(exist_ok=True)
    if settings is not None:
        (cc / "settings.json").write_text(json.dumps(settings))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cc))
    for name in ("CLAUDE_CODE_EFFORT_LEVEL", "ANTHROPIC_MODEL"):
        monkeypatch.delenv(name, raising=False)
    return cc / "settings.json"


async def test_main_runs_at_the_analyst_s_effort_for_its_model_else_claude_code_s_default_and_the_composer_s_wins(
        on, monkeypatch, tmp_path):
    """With no effort chosen in the composer, main runs at what Claude Code in a terminal runs its model at: the
    analyst's own setting for the model, else Claude Code's default for it (medium for Opus 5.5, high for Opus 5). The
    composer's choice wins."""
    from app.main import app

    settings = own_settings(monkeypatch, tmp_path)
    client = api_key(monkeypatch, [text("one"), text("two"), text("three"), text("four")])
    await main_turn("first")
    assert client.bodies[0]["output_config"] == {"effort": "medium"}
    settings.write_text(json.dumps({"modelSettings": {"claude-opus-5-5": {"effortLevel": "low"}}}))
    await main_turn("second")
    assert client.bodies[1]["output_config"] == {"effort": "low"}
    with TestClient(app, base_url="http://127.0.0.1") as http:
        assert http.put(f"/api/ws/{CORPUS}/session/model", json={"model": "claude-opus-5"}).status_code == 200
    await main_turn("third")
    assert (client.bodies[2]["model"], client.bodies[2]["output_config"]) == ("claude-opus-5", {"effort": "high"})
    with TestClient(app, base_url="http://127.0.0.1") as http:
        assert http.put(f"/api/ws/{CORPUS}/session/effort", json={"effort": "max"}).status_code == 200
    await main_turn("fourth")
    assert client.bodies[3]["output_config"] == {"effort": "max"}


async def test_sonnet_5_5_picked_in_the_menu_runs_main_at_its_own_default_effort_and_without_fast_mode(
        on, monkeypatch, tmp_path):
    from app.main import app

    own_settings(monkeypatch, tmp_path)
    client = api_key(monkeypatch, [text("one")])
    with TestClient(app, base_url="http://127.0.0.1") as http:
        assert http.put(f"/api/ws/{CORPUS}/session/fast", json={"fast": True}).status_code == 200
        r = http.put(f"/api/ws/{CORPUS}/session/model", json={"model": "claude-sonnet-5-5"})
    assert r.status_code == 200 and r.json() == {"model": "claude-sonnet-5-5"}, r.text
    await main_turn("first")
    body = client.bodies[0]
    assert (body["model"], body["output_config"], body["fallbacks"]) == ("claude-sonnet-5-5", {"effort": "medium"},
                                                                         "default")
    assert "speed" not in body  # Sonnet 5.5 has no fast mode


async def test_the_chip_s_effort_is_the_one_main_runs_at_for_the_model_it_runs_on(on, monkeypatch, tmp_path):
    """Main's `attached.settings_effort`, the effort the composer's chip shows while the composer chose none: the
    analyst's setting for main's model, else Claude Code's default for it, again for the model the menu picks."""
    from app.main import app

    own_settings(monkeypatch, tmp_path, {"modelSettings": {"claude-opus-5-5": {"effortLevel": "low"}}})
    runtime.ensure(CORPUS)

    def shown() -> str | None:
        return (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("attached", {}).get("settings_effort")

    assert shown() == "low"
    with TestClient(app, base_url="http://127.0.0.1") as http:
        assert http.put(f"/api/ws/{CORPUS}/session/model", json={"model": "claude-opus-5"}).status_code == 200
        assert shown() == "high"
        assert http.put(f"/api/ws/{CORPUS}/session/model", json={"model": "claude-sonnet-5-5"}).status_code == 200
        assert shown() == "medium"


def test_claude_code_s_default_effort_is_its_model_table_s():
    from app import cc_settings

    assert [cc_settings.default_effort(m) for m in ("claude-opus-5-5[1m]", "opus", "claude-sonnet-5-5", "claude-opus-5",
                                                    "claude-opus-4-8", "claude-fable-5-1", "claude-sonnet-5")] == [
        "medium", "medium", "medium", "high", "high", "high", "high"]
