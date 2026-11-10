"""The tool calls of one message on the Messages API runtime (runtime_api._calls). They run at the same time, except a
call that reads what the others may write (tools.Spec.in_order): a view's check written after an edit of the view
starts when the edit has ended, so it checks the edited files. The Messages API is test_runtime's fake client, and the
calls are stand-ins that take a moment: no model is called and no tool runs."""
from __future__ import annotations

import asyncio
from typing import Any

from app import runtime_api
from test_runtime import api_key, call, main_turn, on, text  # noqa: F401 — `on` is a fixture


async def test_a_view_check_starts_when_the_calls_written_before_it_in_its_message_have_ended(on, monkeypatch):
    """A read and an edit run at the same time. The check after them starts when both have ended, and the read after
    the check starts when the check has ended. The results go to the model in the calls' order."""
    seen: list[str] = []

    async def takes_a_moment(conv: Any, box: Any, block: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        seen.append(f"{block['id']} starts")
        await asyncio.sleep(0.02)
        seen.append(f"{block['id']} ends")
        result = {"type": "tool_result", "tool_use_id": block["id"], "content": "done"}
        return result, result

    monkeypatch.setattr(runtime_api, "_call", takes_a_moment)
    message = [*call("Read", {"file_path": "view.html"}, "read"),
               *call("Bash", {"command": "sed -i s/red/blue/ view.html"}, "edit"),
               *call("view_check", {}, "check"),
               *call("Read", {"file_path": "view.json"}, "read again")]
    client = api_key(monkeypatch, [message, text("The view passes.")])
    await main_turn("Make the marks blue.")
    assert seen[:2] == ["read starts", "edit starts"], "calls that are not checks run at the same time"
    assert sorted(seen[2:4]) == ["edit ends", "read ends"]
    assert seen[4:] == ["check starts", "check ends", "read again starts", "read again ends"]
    results = client.bodies[1]["messages"][-1]["content"]
    assert [r["tool_use_id"] for r in results] == ["read", "edit", "check", "read again"]
