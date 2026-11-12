"""Export, Claude artifact (artifact_export.py): with an API key or WIF nothing is published, the notice says why with the
fix, and the page downloads the artifact page; on Claude Code sign-in main gets the request, publishes the page with its
Artifact tool and nothing else, and the page gets the link, or the notice says why there is none. The page holds the
citations and the comments when the Export menu asks for them. A document is one artifact: a later export updates the
artifact the first published. No model call and no `claude`: the Agent SDK is a
fake ClaudeSDKClient, and the card harness's pictures are faked."""
from __future__ import annotations

from typing import Any

import httpx
import pytest
from claude_agent_sdk import (AssistantMessage, PermissionResultAllow, PermissionResultDeny, ResultMessage, SystemMessage,
                              TextBlock, ToolPermissionContext, ToolResultBlock, ToolUseBlock, UserMessage)
from fastapi import FastAPI

from app import agents, artifact_export, claude_access, exports, investigation, notices, runtime, runtime_cc
from test_claude_access_setup import wif_file
from test_exports import BASE, _comment_on, _write_with_figure, artifact_rules, chart, harness  # noqa: F401 — `chart`, `harness` are fixtures
from test_runtime import CORPUS, fake_sdk, main_records, main_turn, on  # noqa: F401 — `on` is a fixture

LINK = "https://claude.ai/code/artifact/5f3a1c2e-7b4d-4c8a-9e21-0d6b7f8a9c10"
OTHER = "https://claude.ai/code/artifact/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
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


async def export_now(asked: str = "") -> None:
    """Export, Claude artifact, on the report, with what the Export menu `asked` for, and main's turn on it."""
    async with client() as api:
        r = await api.post(f"{BASE}/report/export/artifact{asked}")
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
    await _comment_on(chart)
    await export_now("?citations=true&comments=true")
    # main got the request, which names the page it publishes: the report's artifact page, in the workspace, with the
    # citations and the comments the Export menu asked for
    assert artifact_rules(page.read_text()) == []
    assert 'id="note-1"' in page.read_text() and '<div class="cm-name">Comment</div>' in page.read_text()
    assert f"thimble wrote the report as one page: {page}. Publish that file as it is, with your Artifact tool." in seen["prompt"]
    # it says the artifact is private and that sharing it is up to the analyst's settings, so main's reply promises none
    assert "The artifact is private. Whether it can be shared depends on the analyst's claude.ai settings." in seen["prompt"]
    # the turn had the Artifact tool, which Claude Code asks about (the permission callback), and main's chat shows the
    # analyst's line
    opts = seen["options"]
    assert "Artifact" in opts.tools and "Artifact" not in opts.allowed_tools
    assert any(r["type"] == "user" and r.get("text") == "Export the report as a Claude artifact" for r in main_records())
    # the link reached the page, the earlier export's notice went, and main's next turn has no Artifact tool
    assert records == [{"type": "export", "format": "artifact", "doc": "report", "status": "published", "link": LINK}]
    assert told() == [] and not artifact_export.waiting(CORPUS)
    assert "Artifact" not in runtime.ensure(CORPUS).main.spec().builtins


async def test_only_the_export_turn_s_claude_code_session_starts_with_the_variable_that_gives_it_the_artifact_tool(
        on, chart, harness, monkeypatch, tmp_path):
    await _write_with_figure(chart)
    # with an API key or WIF no `claude` starts for an export, so none gets the variable
    for how, given in ((claude_access.API_KEY, {"key": "sk-ant-test-key"}),
                       (claude_access.WIF, {"wif_file": str(wif_file(tmp_path))})):
        seen: dict[str, Any] = {}
        fake_sdk(monkeypatch, session(), seen)
        claude_access.save(how, **given)
        async with client() as api:
            r = await api.post(f"{BASE}/report/export/artifact")
            assert r.status_code == 200 and r.json() == {"publishing": False}, how
        assert "options" not in seen and not runtime.ensure(CORPUS).main.running, how
    # on Claude Code sign-in the export turn's session starts with it, since a headless session has no Artifact tool
    # without it, and leaves out the tools Claude Code adds with that tool
    seen = {}
    fake_sdk(monkeypatch, session(AssistantMessage(content=[TextBlock(text="It could not be published.")], model=MODEL)),
             seen)
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    agents.ensure_main(CORPUS)
    await export_now()
    opts = seen["options"]
    assert "Artifact" in opts.tools and opts.env["CLAUDE_CODE_ARTIFACT"] == "1"
    assert sorted(opts.disallowed_tools) == ["ArtifactComments", "ArtifactData"]
    # main's next turn starts a session with neither
    await main_turn("Thanks.")
    opts = seen["options"]
    assert "Artifact" not in opts.tools and "CLAUDE_CODE_ARTIFACT" not in opts.env and opts.disallowed_tools == []


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
        "The report was not published as a Claude artifact: Claude Code had no Artifact tool, which needs a claude.ai "
        "sign-in that allows artifacts. Its page downloaded instead. In your terminal: sign in to claude.ai with /login, "
        "then export again."]
    # the record has the page download the artifact page, and nothing waits any more
    assert records == [{"type": "export", "format": "artifact", "doc": "report", "status": "failed"}]
    assert not artifact_export.waiting(CORPUS)


def published(tool_id: str, inp: dict[str, Any], said: str, is_error: bool = False) -> list[Any]:
    """Main's call of its Artifact tool with `inp`, and the tool's answer."""
    return [AssistantMessage(content=[ToolUseBlock(id=tool_id, name="Artifact", input=inp)], model=MODEL),
            UserMessage(content=[ToolResultBlock(tool_use_id=tool_id, content=said, is_error=is_error)])]


async def test_a_second_export_updates_the_artifact_the_first_published_also_from_a_new_chat_of_main(
        on, chart, harness, records, monkeypatch):
    await _write_with_figure(chart)
    page = artifact_export.page_path(CORPUS, "report")
    first = {"file_path": str(page), "icon": "report"}
    fake_sdk(monkeypatch, session(*published("toolu_1", first, f"Published {LINK} as a private artifact."),
                                  AssistantMessage(content=[TextBlock(text=LINK)], model=MODEL)), {})
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    agents.ensure_main(CORPUS)
    await export_now()
    # with nothing asked, the page holds the report's text and figures alone
    assert "note-" not in page.read_text() and "<figure" in page.read_text()
    # the link is kept with the report, in the workspace
    assert artifact_export.kept_link(CORPUS, "report") == LINK
    # a new chat of main: the next export asks main to publish the page to that link; the tool refuses until this
    # session read the artifact, main reads it and publishes again, and the same artifact has the new page
    assert await runtime._spaces[CORPUS].switch(None)
    seen: dict[str, Any] = {}
    update = {**first, "url": LINK}
    fake_sdk(monkeypatch, session(
        *published("toolu_2", update, "Refused: this session has not read that artifact. Read it, then publish again.",
                   is_error=True),
        *published("toolu_3", {"action": "read", "url": LINK}, "The artifact as it is now."),
        *published("toolu_4", update, f"Published {LINK}."),
        AssistantMessage(content=[TextBlock(text=LINK)], model=MODEL)), seen)
    await export_now()
    assert f"It was published before as {LINK}." in seen["prompt"]
    assert f"Publish that file as it is, with your Artifact tool, and give {LINK} as its `url`." in seen["prompt"]
    assert records[-1] == {"type": "export", "format": "artifact", "doc": "report", "status": "published", "link": LINK}
    assert told() == [] and artifact_export.kept_link(CORPUS, "report") == LINK
    # an update the tool answers with an error: the notice says the next export publishes a new artifact, and it does
    fake_sdk(monkeypatch, session(*published("toolu_5", update, "No artifact has that link.", is_error=True),
                                  AssistantMessage(content=[TextBlock(text="That artifact no longer exists.")],
                                                   model=MODEL)), seen)
    await export_now()
    assert [n["text"] for n in told()] == [
        "The report was not published as a Claude artifact: Claude Code's Artifact tool answered: No artifact has that "
        "link. Its page downloaded instead. Export again to publish it as a new Claude artifact."]
    assert artifact_export.kept_link(CORPUS, "report") == ""
    fake_sdk(monkeypatch, session(*published("toolu_6", first, f"Published {OTHER} as a private artifact."),
                                  AssistantMessage(content=[TextBlock(text=OTHER)], model=MODEL)), seen)
    await export_now()
    assert "It was published before" not in seen["prompt"]
    assert told() == [] and artifact_export.kept_link(CORPUS, "report") == OTHER


async def test_main_may_read_the_artifact_an_export_updates_and_publish_the_page_to_it_and_to_no_other(on, monkeypatch):
    fake_sdk(monkeypatch, [], {})
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    sp = runtime.ensure(CORPUS)
    page = artifact_export.page_path(CORPUS, "report")
    monkeypatch.setitem(artifact_export._waiting, CORPUS,
                        {"e1": artifact_export.Waiting("report", page, "e1", link=LINK)})
    opts = runtime_cc.options(sp.main, sp.main.spec(), {})
    pre = opts.hooks["PreToolUse"][0].hooks[0]
    ctx = ToolPermissionContext(tool_use_id="toolu_a")
    publish = {"file_path": str(page), "icon": "report"}
    for ok in ({**publish, "url": LINK}, publish, {"action": "read", "url": LINK}):
        assert isinstance(await opts.can_use_tool("Artifact", ok, ctx), PermissionResultAllow), ok
        assert await pre({"tool_name": "Artifact", "tool_input": ok}, "toolu_a", {}) == {}, ok
    for other in ({**publish, "url": OTHER}, {"action": "read", "url": OTHER},
                  {"action": "read", "url": LINK, "out_dir": "/made-up/elsewhere"}, {"action": "delete", "url": LINK}):
        assert isinstance(await opts.can_use_tool("Artifact", other, ctx), PermissionResultDeny), other
        refused = (await pre({"tool_name": "Artifact", "tool_input": other}, "toolu_b", {}))["hookSpecificOutput"]
        assert refused["permissionDecision"] == "deny", other
    # with no artifact to update, the page goes to no artifact by its link
    monkeypatch.setitem(artifact_export._waiting, CORPUS, {"e1": artifact_export.Waiting("report", page, "e1")})
    assert isinstance(await opts.can_use_tool("Artifact", {**publish, "url": LINK}, ctx), PermissionResultDeny)
    assert isinstance(await opts.can_use_tool("Artifact", {"action": "read", "url": LINK}, ctx), PermissionResultDeny)
