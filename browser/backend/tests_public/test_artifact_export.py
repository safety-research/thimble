"""Export, Claude artifact (artifact_export.py): with an API key or WIF nothing is published, the notice says why with the
fix, and the page downloads the artifact page; on Claude Code sign-in main gets the request, publishes the page with its
Artifact tool and nothing else, and the page gets the link, or the notice says why there is none. No model call and no
`claude`: the Agent SDK is a fake ClaudeSDKClient, and the card harness's pictures are faked."""
from __future__ import annotations

from typing import Any

import httpx
import pytest
from claude_agent_sdk import (AssistantMessage, PermissionResultAllow, PermissionResultDeny, ResultMessage, SystemMessage,
                              TextBlock, ToolPermissionContext, ToolResultBlock, ToolUseBlock, UserMessage)
from fastapi import FastAPI

from app import agents, artifact_export, claude_access, exports, investigation, notices, runtime, runtime_cc
from test_exports import BASE, _write_with_figure, artifact_rules, chart, harness  # noqa: F401 — `chart`, `harness` are fixtures
from test_runtime import CORPUS, fake_sdk, main_records, on  # noqa: F401 — `on` is a fixture

LINK = "https://claude.ai/code/artifact/5f3a1c2e-7b4d-4c8a-9e21-0d6b7f8a9c10"
MODEL = "claude-opus-5-5"


@pytest.fixture()
def records(monkeypatch) -> list[dict[str, Any]]:
    """The `export` records the workspace stream gets."""
    got: list[dict[str, Any]] = []
    real = investigation.emit

    def emit(c: str, inv: str, event: dict) -> None:
        if event.get("type") == artifact_export.RECORD:
            got.append(dict(event))
        real(c, inv, event)

    monkeypatch.setattr(investigation, "emit", emit)
    return got


def client() -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(exports.router, prefix="/api")
    app.include_router(artifact_export.router, prefix="/api")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def told() -> list[dict[str, Any]]:
    return [n for n in notices.open_notices(CORPUS) if n.get("key") == artifact_export.KEY]


def session(*middle: Any, tools: tuple[str, ...] = ("Read", "Artifact")) -> list[Any]:
    """A turn of main's Claude Code session: its start, which lists its tools, `middle`, and its end."""
    return [SystemMessage(subtype="init", data={"session_id": "sess-art", "tools": list(tools)}), *middle,
            ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                          session_id="sess-art")]


async def export_now() -> None:
    """Export, Claude artifact, on the report, and main's turn on it."""
    async with client() as api:
        r = await api.post(f"{BASE}/report/export/artifact")
        assert r.status_code == 200 and r.json() == {"publishing": True}, r.text
    task = runtime.ensure(CORPUS).main.task
    assert task is not None
    await task


async def test_with_an_api_key_nothing_is_published_the_notice_says_why_and_the_page_downloads(on, chart, harness,
                                                                                               records):
    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    await _write_with_figure(chart)
    async with client() as api:
        r = await api.post(f"{BASE}/report/export/artifact")
        assert r.status_code == 200 and r.json() == {"publishing": False}
        assert [n["text"] for n in told()] == [
            "The report was not published as a Claude artifact: only a Claude Code sign-in can publish one, and thimble "
            "reaches Claude with an Anthropic API key. Its page downloaded instead. To publish from thimble, choose your "
            "Claude Code sign-in in Settings, Claude access."]
        assert told()[0]["action"] == notices.SETTINGS
        # main is asked nothing, and the page the page downloads in its place keeps claude.ai's rules
        main = runtime.ensure(CORPUS).main
        assert main.queue == [] and not main.running and records == []
        r = await api.get(f"{BASE}/report/export/artifact")
        assert r.status_code == 200 and artifact_rules(r.text) == []


async def test_on_claude_code_sign_in_main_publishes_the_page_with_its_artifact_tool_and_the_page_gets_the_link(
        on, chart, harness, records, monkeypatch):
    await _write_with_figure(chart)
    page = artifact_export.page_path(CORPUS, "report")
    seen: dict[str, Any] = {}
    fake_sdk(monkeypatch, session(
        AssistantMessage(content=[ToolUseBlock(id="toolu_art", name="Artifact",
                                               input={"file_path": str(page), "icon": "report"})], model=MODEL),
        UserMessage(content=[ToolResultBlock(tool_use_id="toolu_art", content=f"Published {LINK} as a private artifact.")]),
        AssistantMessage(content=[TextBlock(text=LINK)], model=MODEL)), seen)
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    agents.ensure_main(CORPUS)
    notices.post(CORPUS, kind="export", key=artifact_export.KEY, text="An earlier export published nothing.")
    await export_now()
    # main got the request, which names the page it publishes: the report's artifact page, in the workspace
    assert artifact_rules(page.read_text()) == []
    assert f"thimble wrote the report as one page: {page}. Publish that file as it is, with your Artifact tool." in seen["prompt"]
    # the turn had the Artifact tool, which Claude Code asks about (the permission callback), and main's chat shows the
    # analyst's line
    opts = seen["options"]
    assert "Artifact" in opts.tools and "Artifact" not in opts.allowed_tools
    assert any(r["type"] == "user" and r.get("text") == "Export the report as a Claude artifact" for r in main_records())
    # the link reached the page, the earlier export's notice went, and main's next turn has no Artifact tool
    assert records == [{"type": "export", "format": "artifact", "doc": "report", "status": "published", "link": LINK}]
    assert told() == [] and not artifact_export.waiting(CORPUS)
    assert "Artifact" not in runtime.ensure(CORPUS).main.spec().builtins


async def test_main_s_artifact_tool_publishes_only_the_page_of_an_export_that_waits(on, monkeypatch):
    fake_sdk(monkeypatch, [], {})
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    sp = runtime.ensure(CORPUS)
    page = artifact_export.page_path(CORPUS, "report")
    assert "Artifact" not in sp.main.spec().builtins, "no export waits"
    monkeypatch.setitem(artifact_export._waiting, CORPUS, {"e1": artifact_export.Waiting("report", page, "e1")})
    spec = sp.main.spec()
    assert "Artifact" in spec.builtins
    opts = runtime_cc.options(sp.main, spec, {})
    pre = opts.hooks["PreToolUse"][0].hooks[0]
    ctx = ToolPermissionContext(tool_use_id="toolu_a")
    publish = {"file_path": str(page), "icon": "report", "description": "A thimble report."}
    assert isinstance(await opts.can_use_tool("Artifact", publish, ctx), PermissionResultAllow)
    assert await pre({"tool_name": "Artifact", "tool_input": publish}, "toolu_a", {}) == {}
    for other in ({"file_path": str(page.with_name("notes.html"))}, {"action": "read", "url": LINK},
                  {"action": "delete", "url": LINK}, {**publish, "files": {"a.png": "a.png"}}):
        assert isinstance(await opts.can_use_tool("Artifact", other, ctx), PermissionResultDeny), other
        refused = (await pre({"tool_name": "Artifact", "tool_input": other}, "toolu_b", {}))["hookSpecificOutput"]
        assert refused["permissionDecision"] == "deny" and "only the page" in refused["permissionDecisionReason"]
    # a side thread's fork has no Artifact tool, whatever waits
    fork = runtime.Conv(sp, "a1", "fork", agent_id="a1", agent_type=runtime.FORK_TYPE, base=runtime.MAIN)
    assert "Artifact" not in fork.spec().builtins


async def test_on_claude_code_sign_in_without_the_artifact_tool_the_notice_says_how_to_get_it_and_the_page_downloads(
        on, chart, harness, records, monkeypatch):
    await _write_with_figure(chart)
    seen: dict[str, Any] = {}
    fake_sdk(monkeypatch, session(AssistantMessage(content=[TextBlock(text="I have no Artifact tool here.")], model=MODEL),
                                  tools=("Read",)), seen)
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    agents.ensure_main(CORPUS)
    await export_now()
    assert [n["text"] for n in told()] == [
        "The report was not published as a Claude artifact: Claude Code offered no Artifact tool, which it has only when "
        "it is signed in to claude.ai and artifacts are allowed there. Its page downloaded instead. In your terminal: "
        "run `claude`, sign in to claude.ai with /login, then export again."]
    # the record has the page download the artifact page, and nothing waits any more
    assert records == [{"type": "export", "format": "artifact", "doc": "report", "status": "failed"}]
    assert not artifact_export.waiting(CORPUS)
