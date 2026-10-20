"""The features' routes through the signed-in server, with a fake Messages API client: the switches, a lens's scope
and its marks, and a view built only on the analyst's Accept."""
import json

import pytest
from fastapi.testclient import TestClient

from thimble_browser import home, llm
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
    assert lenses["explain"]["scope"] == {"chat": True, "cards": False, "report": True}
    assert lenses["details"]["scope"] == {"chat": True, "cards": False, "report": True}
    import asyncio
    from thimble_browser.features import lenses as lens_mod
    n = asyncio.run(lens_mod.read(api.ws, chat="main", answer="It sat in the merge queue for a day."))
    assert n == 1
    assert [(m["term"], m["shown"]) for m in api("GET", "/marks?surface=chat").json()["marks"]] == [("merge queue", True)]
    r = api("PUT", "/lenses/explain", json={"scope": {"chat": False}})
    assert r.status_code == 200 and r.json()["scope"]["chat"] is False
    assert [m["shown"] for m in api("GET", "/marks?surface=chat").json()["marks"]] == [False]
    assert api("PUT", "/lenses/explain", json={"scope": {"elsewhere": True}}).status_code == 400
    # the analyst's choice is kept for the surfaces they set; the others follow the default
    assert lens_mod._conf(api.ws)["builtin"]["explain"]["scope"] == {"chat": False}
    assert api("PUT", "/lenses/details", json={"surfaces": ["cards"]}).json()["scope"] == \
        {"chat": False, "cards": True, "report": False}
    api("PUT", "/lenses/explain", json={"scope": {"chat": True}})
    mid = api("GET", "/marks").json()["marks"][0]["id"]
    assert api("POST", f"/marks/{mid}/dismiss").status_code == 200
    assert api("GET", "/marks").json()["marks"] == []


def test_important_details_mark_the_report_and_the_answer_in_one_reading(api, monkeypatch):
    import asyncio
    from thimble_browser import report
    from thimble_browser.features import lenses as lens_mod
    report.save(api.ws, "# Edits\n\nMost edits came from one address range in June.", by="claude")
    heads = [{"where": "answer", "term": "for a day", "title": "One day only", "bullets": ["The log ends that day."],
              "todo": "Count again later."},
             {"where": "report", "term": "one address range", "title": "Shared addresses", "bullets": ["A range is many"
              " machines."], "todo": "Name the range."}]
    client = ScriptedClient(answer=lambda s, u: json.dumps({"glosses": [], "heads": heads}))
    monkeypatch.setattr(llm, "client", lambda: client)
    n = asyncio.run(lens_mod.read(api.ws, chat="main", answer="It sat in the queue for a day.", with_report=True))
    assert n == 2
    schema = client.completions[0]["output_config"]["format"]["schema"]
    assert schema["properties"]["heads"]["type"] == "array"
    doc = api("GET", "/investigations/main/types/report").json()
    assert [(m["lens"], m["term"]) for m in doc["marks"]] == [("details", "one address range")]


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
