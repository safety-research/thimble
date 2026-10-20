"""The report is the person's from the start: an empty report is a document they type into and place cards in, Write
sends their instructions to Claude in the chat, Claude edits their draft in place, and the draft before Claude's change
is kept as a version that History opens and restores."""
import time

import pytest
from fastapi.testclient import TestClient

from thimble_browser import home, llm, report
from thimble_browser.app import build

from fakes import ScriptedClient

PORT = 21097
OWN = f"http://127.0.0.1:{PORT}"


@pytest.fixture
def api(folder):
    ws = home.open_folder(folder)
    app, auth, _ = build(PORT)
    with TestClient(app, base_url=OWN) as c:
        r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
        key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]

        def call(method, path, **kw):
            return c.request(method, f"/b/{key}/api/ws/{ws}{path}", headers={"cookie": cookie, "origin": OWN}, **kw)
        call.ws = ws
        yield call


def until(fn, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        got = fn()
        if got:
            return got
        time.sleep(0.02)
    raise AssertionError("timed out")


def test_an_empty_report_is_a_document_to_type_into(api):
    got = api("GET", "/investigations/main/types/report")
    assert got.status_code == 200 and got.json()["sections"] == [] and got.json()["title"] == ""
    assert api("GET", "/investigations/main/types").json()["report"]["exists"] is False
    blocks = [{"type": "paragraph", "text": "most refunds are about one charger?"},
              {"type": "figure", "cell": "card:abc12345", "caption": ""},
              {"type": "heading", "level": 2, "text": "Batch 17"}]
    saved = api("PUT", "/investigations/main/types/report/blocks", json={"title": "", "blocks": blocks}).json()
    assert saved["title"] == ""
    assert [p["sentences"][0]["text"] for p in saved["sections"][0]["paragraphs"]] == ["most refunds are about one charger?"]
    assert saved["sections"][0]["figures"][0]["cell"] == "abc12345"
    assert [s["heading"] for s in saved["sections"]][1:] == ["Batch 17"]


def test_write_sends_the_instructions_and_the_draft_before_claude_is_kept(api, monkeypatch):
    seen = []

    def script(req):
        seen.append(req["messages"][-1])
        if len(seen) == 1:
            return [{"tool": "edit_document", "input": {"old_text": "my note", "new_text": "A cited paragraph."}}]
        return ["Done."]
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(script))
    report.save(api.ws, "#\n\nmy note\n\n![](card:abc12345)\n", by="analyst")
    r = api("POST", "/write", json={"text": "two pages, keep my order", "after_text": "my note"})
    assert r.status_code == 200
    until(lambda: api("GET", "/investigations/main/types").json()["report"].get("status") is None)
    assert seen[0]["content"].startswith("Write the report: two pages, keep my order\n(I put this request in it after")
    md = report.markdown(api.ws)
    assert "A cited paragraph." in md and "![](card:abc12345)" in md
    hist = api("GET", "/investigations/main/types/report/versions").json()
    assert [v["source"] for v in hist["versions"]] == ["analyst", "main"]
    assert hist["versions"][1]["current"] and hist["versions"][1]["instructions"] == "two pages, keep my order"
    first = api("GET", "/investigations/main/types/report/versions/1").json()
    assert first["sections"][0]["paragraphs"][0]["sentences"][0]["text"] == "my note"
    back = api("POST", "/investigations/main/types/report/versions/1/restore").json()
    assert back["sections"][0]["paragraphs"][0]["sentences"][0]["text"] == "my note"
    assert api("GET", "/investigations/main/types/report/versions/9").status_code == 404


def test_each_block_keeps_who_wrote_it_until_the_person_edits_it(api):
    report.save(api.ws, "# Runs\n\nmy note\n\n- first point\n\n![](card:abc12345)\n", by="analyst")
    report.save(api.ws, "# Runs\n\nmy note\n\nClaude's paragraph.\n\n- first point\n- second point\n\n![](card:abc12345)\n",
                by="main")
    doc = api("GET", "/investigations/main/types/report").json()
    paras = doc["sections"][0]["paragraphs"]
    assert [p.get("by") for p in paras[:2]] == [None, "claude"]
    assert [s.get("by") for s in paras[2]["sentences"]] == [None, "claude"]
    assert doc["sections"][0]["figures"][0].get("by") is None
    # the person edits Claude's paragraph: it is theirs now; Claude's untouched list item stays Claude's
    blocks = [{"type": "paragraph", "text": "my note"}, {"type": "paragraph", "text": "Claude's paragraph, my words."},
              {"type": "bullet", "text": "first point"}, {"type": "bullet", "text": "second point"},
              {"type": "figure", "cell": "card:abc12345"}, {"type": "quote", "text": "a quote from the data"}]
    doc = api("PUT", "/investigations/main/types/report/blocks", json={"title": "Runs", "blocks": blocks}).json()
    paras = doc["sections"][0]["paragraphs"]
    assert paras[1].get("by") is None
    assert [s.get("by") for s in paras[2]["sentences"]] == [None, "claude"]
    assert paras[3].get("quote") is True
    assert "<!-- by: claude -->\n- second point" in report.markdown(api.ws)


def test_new_makes_another_document_that_write_and_the_tools_reach(api, monkeypatch):
    made = api("POST", "/report-types/new", json={"kind": "document", "name": "Team update"})
    assert made.status_code == 200 and made.json()["slug"] == "team-update"
    assert api("POST", "/report-types/new", json={"kind": "page", "name": "x"}).status_code == 400
    types = api("GET", "/investigations/main/types").json()
    assert list(types) == ["report", "team-update"] and types["team-update"]["name"] == "Team update"
    assert api("GET", "/investigations/main/types/team-update").json()["sections"] == []
    api("PUT", "/investigations/main/types/team-update/blocks", json={"title": "Update", "blocks": [{"type": "paragraph", "text": "draft"}]})
    seen = []

    def script(req):
        seen.append(req["messages"][-1])
        if len(seen) == 1:
            return [{"tool": "edit_document", "input": {"doc": "team-update", "old_text": "draft", "new_text": "Written."}}]
        return ["Done."]
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(script))
    assert api("POST", "/write", json={"doc": "team-update", "text": "short"}).status_code == 200
    until(lambda: api("GET", "/investigations/main/types").json()["team-update"].get("status") is None)
    assert seen[0]["content"] == 'Write the document "Team update" (doc: team-update): short'
    assert "Written." in report.markdown(api.ws, "team-update") and report.markdown(api.ws) is None
    assert api("PUT", "/report-types/team-update", json={"name": "Team note"}).json()["name"] == "Team note"
    assert api("PUT", "/report-types/report", json={"name": "x"}).status_code == 404
    assert api("DELETE", "/report-types/team-update").status_code == 200
    assert list(api("GET", "/investigations/main/types").json()) == ["report"]
    assert api("GET", "/investigations/main/types/team-update").status_code == 404


def test_the_writing_guide_comes_with_the_first_read_of_a_chat(api, monkeypatch):
    import asyncio

    from thimble_browser import agent, tools
    from thimble_browser.features import report as feature

    t = tools.Tools(api.ws, "main", home.corpus_of(api.ws))
    first = asyncio.run(feature.read_document(t, {}))
    assert "is empty" in first.text and feature.GUIDE_HEAD in first.text and "## A good document" in first.text
    agent.save_messages(api.ws, "main", [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x",
                                                                       "content": first.text}]}])
    again = asyncio.run(feature.read_document(t, {}))
    assert feature.GUIDE_HEAD not in again.text
    assert "## A good document" not in agent.AGENTS["main"].prompt(home.corpus_of(api.ws))
