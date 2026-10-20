"""The features' routes through the signed-in server, with a fake Messages API client: the switches, the lenses and
their marks, the report written on request, and a view built only on the analyst's Accept."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from thimble_browser import home, llm, report
from thimble_browser.app import build

from fakes import ScriptedClient

PORT = 21098
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


def test_only_the_chat_agent_and_a_view_builder_exist(api):
    assert api("GET", "/orientation").json() == {} or api("GET", "/orientation").status_code == 404
    names = [f["name"] for f in api("GET", "/features").json()]
    assert names == ["cards", "citations", "lenses", "labels", "report", "views"]


def test_a_feature_turned_off_keeps_its_routes_and_leaves_the_others(api):
    r = api("PUT", "/settings", json={"features": {"report": False}})
    assert r.status_code == 200
    got = {f["name"]: f["on"] for f in api("GET", "/features").json()}
    assert got == {"cards": True, "citations": True, "lenses": True, "labels": True, "report": False, "views": True}
    assert api("GET", "/investigations/main/types").status_code == 200
    assert api("GET", "/canvas").status_code == 200
    assert api("PUT", "/settings", json={"features": {"report": "no"}}).status_code == 400


def test_a_lens_scope_is_set_through_one_route_and_its_marks_follow(api, monkeypatch):
    reply = {"glosses": [{"where": "answer", "term": "merge queue", "body": "Where changes wait to merge.", "here": ""}]}
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=lambda s, u: json.dumps(reply)))
    lenses = {x["id"]: x for x in api("GET", "/lenses").json()}
    assert lenses["explain"]["scope"] == {"chat": True, "cards": False, "report": False}
    assert lenses["details"]["scope"] == {"chat": False, "cards": False, "report": True}
    import asyncio
    from thimble_browser.features import lenses as lens_mod
    n = asyncio.run(lens_mod.read(api.ws, chat="main", answer="It sat in the merge queue for a day."))
    assert n == 1
    assert [m["term"] for m in api("GET", "/marks?surface=chat").json()["marks"]] == ["merge queue"]
    r = api("PUT", "/lenses/explain", json={"scope": {"chat": False}})
    assert r.status_code == 200 and r.json()["scope"]["chat"] is False
    assert api("GET", "/marks?surface=chat").json()["marks"] == []
    assert api("PUT", "/lenses/explain", json={"scope": {"elsewhere": True}}).status_code == 400
    api("PUT", "/lenses/explain", json={"scope": {"chat": True}})
    mid = api("GET", "/marks").json()["marks"][0]["id"]
    assert api("POST", f"/marks/{mid}/dismiss").status_code == 200
    assert api("GET", "/marks").json()["marks"] == []


def test_an_own_check_is_a_lens_that_reads_the_report_at_once(api, monkeypatch):
    calls = []

    from thimble_browser.features import lenses as lens_mod

    def answer(system, user):
        calls.append(user)
        key = next(x["id"] for x in lens_mod.lenses(api.ws) if not x["builtin"])
        return json.dumps({key: [{"where": "report", "term": "always", "title": "No source shows this.",
                                  "body": "No card counts it."}], "details": []})
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=answer))
    report.save(api.ws, "# Title\n\nThe runs always pass.\n", by="main")
    r = api("POST", "/lenses", json={"name": "Unsupported", "instructions": "Mark claims no source shows."})
    assert r.status_code == 201 and r.json()["scope"] == {"chat": False, "cards": False, "report": True}
    got = until(lambda: api("GET", "/investigations/main/types/report").json().get("marks"))
    assert got[0]["term"] == "always" and got[0]["lens"] == r.json()["id"]
    assert "<text place=\"report\">" in calls[0]
    assert api("DELETE", f"/lenses/{r.json()['id']}").status_code == 200
    assert api("GET", "/investigations/main/types/report").json()["marks"] == []
    assert api("DELETE", "/lenses/explain").status_code == 404


def test_write_asks_the_chat_agent_and_the_report_stays_the_analysts(api, monkeypatch):
    seen = []

    def script(req):
        seen.append(req["messages"][-1])
        if len(seen) == 1:
            return [{"tool": "edit_document", "input": {"old_text": "my note", "new_text": "My note, written up."}}]
        return ["Done."]
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(script))
    report.save(api.ws, "# Draft\n\nmy note\n\n![](card:abc12345)\n", by="analyst")
    r = api("POST", "/write", json={"text": "keep my order"})
    assert r.status_code == 200 and r.json()["chat"] == "main"
    until(lambda: api("GET", "/investigations/main/types").json()["report"].get("status") != "generating")
    assert seen[0]["content"] == "Write the report: keep my order"
    md = report.markdown(api.ws)
    assert "My note, written up." in md and "![](card:abc12345)" in md
    assert api("GET", "/investigations/main/types").json()["report"].get("status") is None


def test_a_view_is_proposed_and_built_only_on_accept(api, monkeypatch):
    import asyncio
    from thimble_browser import tools as tools_mod
    from thimble_browser.features import views as views_mod
    started = []

    async def fake_start(sessions, ws, slug):
        started.append(slug)
        return "dtest"
    monkeypatch.setattr(views_mod, "start_build", fake_start)
    t = tools_mod.Tools(api.ws, "main", home.corpus_of(api.ws))
    got = asyncio.run(views_mod.propose_view(t, {"name": "Run Trail", "description": "each run as a row",
                                                 "task": "see runs", "claims": ["runs/*.jsonl"]}))
    assert not got.is_error and started == []
    rows = api("GET", "/views/proposals").json()
    assert rows[0]["status"] == "suggested" and rows[0]["offered"]["at"]
    assert api("POST", f"/views/proposals/{rows[0]['slug']}/accept").status_code == 200
    assert started == [rows[0]["slug"]]


def test_the_checks_list_their_question_what_they_found_and_go_to_it(api, monkeypatch):
    reply = {"glosses": [{"where": "answer", "term": "merge queue", "body": "Where changes wait.", "here": ""}]}
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=lambda s, u: json.dumps(reply)))
    import asyncio
    from thimble_browser.features import lenses as lens_mod
    asyncio.run(lens_mod.read(api.ws, chat="main", answer="It sat in the merge queue."))
    rows = {x["id"]: x for x in api("GET", "/lenses").json()}
    assert list(rows)[:3] == ["explain", "details", "unverifiable"]
    assert rows["unverifiable"]["on"] is False and rows["explain"]["question"]
    assert rows["explain"]["found"] == {"chat": 1, "cards": 0, "report": 0}
    found = api("GET", "/lenses/explain/found").json()
    assert [(m["term"], m["surface"], m["place"], m["shown"]) for m in found] == [("merge queue", "chat", "main", True)]
    api("PUT", "/lenses/explain", json={"scope": {"chat": False}})
    assert api("GET", "/lenses/explain/found").json()[0]["shown"] is False
    assert api("GET", "/lenses").json()[0]["found"]["chat"] == 1  # still counted where it is hidden
    a = api("POST", "/lenses", json={"name": "No citation", "instructions": "Flag any claim with no citation."}).json()
    b = api("POST", "/lenses", json={"name": "Dates", "instructions": "Flag a date with no year."}).json()
    assert a["color"] != b["color"] and a["question"] == "Flag any claim with no citation."
    assert api("PUT", f"/lenses/{a['id']}", json={"instructions": "Flag a claim with no citation."}).json()["question"] == \
        "Flag a claim with no citation."
    assert api("PUT", "/lenses/explain", json={"instructions": "Something else."}).status_code == 400


def test_important_details_read_as_the_terminal_s_heads_up_and_take_surfaces(api, monkeypatch):
    reply = {"glosses": [], "heads": {"where": "answer", "term": "fell 40%", "title": "March is half a month",
                                      "bullets": ["The file ends on Mar 14."], "todo": "Quote the per-day drop."}}
    seen = []
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=lambda s, u: seen.append(s) or json.dumps(reply)))
    r = api("PUT", "/lenses/details", json={"surfaces": ["chat", "report"]})
    assert r.json()["surfaces"] == ["chat", "report"] and r.json()["key"] == "details" and r.json()["lens"] == "heads"
    import asyncio
    from thimble_browser.features import lenses as lens_mod
    assert asyncio.run(lens_mod.read(api.ws, chat="main", answer="Refunds fell 40% in March.")) == 1
    m = api("GET", "/marks?surface=chat").json()["marks"][0]
    assert (m["lens"], m["term"], m["title"], m["body"], m["here"]) == (
        "details", "fell 40%", "March is half a month", "- The file ends on Mar 14.", "Quote the per-day drop.")
    assert "## Heads-ups" in seen[0] and "Heads-ups the analyst already saw" in seen[0]


def test_the_lenses_read_the_report_without_its_authorship_notes(api, monkeypatch):
    seen = []
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=lambda s, u: seen.append(u) or json.dumps({"heads": None})))
    report.save(api.ws, "# Title\n\n<!-- by: claude -->\nThe runs always pass.\n", by="main")
    import asyncio
    from thimble_browser.features import lenses as lens_mod
    asyncio.run(lens_mod.read(api.ws, with_report=True))
    assert seen and "The runs always pass." in seen[0] and "<!--" not in seen[0]
