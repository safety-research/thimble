"""A message the analyst sends while main works (runtime.py, B14) reaches main at the turn's next tool call, as Claude
Code gives a message typed mid-turn to the model: on the Messages API with the call's results (runtime_api's loop).
Until main reads it, main's chat shows it waiting (its meta's `unread`) and logs nothing of it. The Messages API is
test_runtime's fake client: no model is called."""
from __future__ import annotations

import json
from typing import Any

from app import agents, events, runtime
from test_runtime import CORPUS, api_key, call, main_records, main_turn, on, shape, text  # noqa: F401 — `on` is a fixture

FIRST = "What happened?"
SECOND = "And how many files are there?"


def transcript() -> list[dict[str, Any]]:
    return [json.loads(ln) for ln in runtime._spaces[CORPUS].main_path.read_text("utf-8").splitlines()]


async def page_unread() -> list[str]:
    """The messages main's chat shows waiting, as the page reads them (agents.main_route, meta `unread`)."""
    return [m["text"] for m in json.loads((await agents.main_route(CORPUS)).body)["meta"]["unread"]]


async def test_a_message_sent_while_main_works_reaches_it_with_the_results_of_its_next_tool_call(on, monkeypatch):
    """The second message goes to the model with the results of the call that ran while it was sent, in the same turn,
    and main's chat logs it there, after the call; until then the chat shows it waiting and logs nothing of it."""
    meanwhile: dict[str, Any] = {}

    def ask_again_while_it_works(body: dict[str, Any]) -> list[Any]:
        events.post(CORPUS, "main", {"text": SECOND})
        meanwhile["unread"] = [m["text"] for m in runtime.unread(CORPUS)]
        meanwhile["logged"] = [r.get("text") for r in main_records() if r["type"] == "user"]
        return call("list_cards", {"group": "all"})

    client = api_key(monkeypatch, [ask_again_while_it_works, text("Nothing broke, and there are 12 files.")])
    await main_turn(FIRST)
    assert meanwhile == {"unread": [SECOND], "logged": [FIRST]}, "it waits, and is no line of the chat yet"
    assert len(client.bodies) == 2, "no turn of its own"
    last = client.bodies[1]["messages"][-1]["content"]
    assert [b["type"] for b in last] == ["tool_result", "text"]
    assert SECOND in last[1]["text"] and 'kind="main"' in last[1]["text"]
    assert shape(main_records()) == [("user", FIRST), ("tool_use", "list_cards"), ("tool_result", ""), ("user", SECOND),
                                     ("text", "Nothing broke, and there are 12 files."), ("done", "")]
    queued = [r["attachment"] for r in transcript() if r.get("type") == "attachment"]
    assert [a["type"] for a in queued] == ["queued_command"] and SECOND in queued[0]["prompt"]
    assert await page_unread() == [] and not runtime._spaces[CORPUS].main.queue
