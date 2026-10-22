"""The lenses (features/lenses.py): the explainers and important details read Claude's answer and the report after a
turn, with the terminal plugin's lens texts; a lens's scope is set through one route and its marks follow; a check of
the analyst's own is added and removed. Made-up data only."""
import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from thimble_browser import home, llm, prompts
from thimble_browser.app import build

from fakes import ScriptedClient

PORT = 21099
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


def test_a_lens_scope_is_set_through_one_route_and_its_marks_follow(api, monkeypatch):
    reply = {"glosses": [{"where": "answer", "term": "merge queue", "body": "Where changes wait to merge.", "here": ""}]}
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=lambda s, u: json.dumps(reply)))
    lenses = {x["id"]: x for x in api("GET", "/lenses").json()}
    assert lenses["explain"]["scope"] == {"chat": True, "cards": False, "report": True}
    assert lenses["details"]["scope"] == {"chat": True, "cards": False, "report": True}
    from thimble_browser import chats
    from thimble_browser.features import lenses as lens_mod
    n = asyncio.run(lens_mod.read(api.ws, chat="main", answer="It sat in the merge queue for a day."))
    assert n == 1
    assert [r for r in chats.records(api.ws, "main") if r.get("type") == "lens_marks"][0]["marks"][0]["term"] == "merge queue"
    assert [(m["term"], m["shown"]) for m in api("GET", "/lens-marks?surface=chat").json()["marks"]] == [("merge queue", True)]
    r = api("PUT", "/lenses/explain", json={"scope": {"chat": False}})
    assert r.status_code == 200 and r.json()["scope"]["chat"] is False
    assert [m["shown"] for m in api("GET", "/lens-marks?surface=chat").json()["marks"]] == [False]
    assert api("PUT", "/lenses/explain", json={"scope": {"elsewhere": True}}).status_code == 400
    # the analyst's choice is kept for the surfaces they set; the others follow the default
    assert lens_mod._conf(api.ws)["builtin"]["explain"]["scope"] == {"chat": False}
    assert api("PUT", "/lenses/details", json={"surfaces": ["cards"]}).json()["scope"] == \
        {"chat": False, "cards": True, "report": False}
    api("PUT", "/lenses/explain", json={"scope": {"chat": True}})
    mid = api("GET", "/lens-marks").json()["marks"][0]["id"]
    assert api("POST", f"/lens-marks/{mid}/dismiss").status_code == 200
    assert api("GET", "/lens-marks").json()["marks"] == []


def test_important_details_mark_the_report_and_the_answer_in_one_reading(api, monkeypatch):
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
    assert [(m["lens"], m["term"]) for m in doc["lens_marks"]] == [("details", "one address range")]


def test_a_mark_never_stands_on_a_citation_and_terms_already_explained_are_named(api, monkeypatch):
    from thimble_browser.features import lenses as lens_mod
    first = {"glosses": [{"where": "answer", "term": "41 of the 44", "body": "x"}, {"where": "answer", "term": "p95", "body": "y"}]}
    client = ScriptedClient(answer=lambda s, u: json.dumps(first))
    monkeypatch.setattr(llm, "client", lambda: client)
    n = asyncio.run(lens_mod.read(api.ws, chat="main", answer="[41 of the 44](#) runs passed the p95 check."))
    assert n == 1
    asyncio.run(lens_mod.read(api.ws, chat="main", answer="The p95 rose again."))
    assert "explainer in this session: p95" in str(client.completions[1]["system"])


def test_a_check_of_the_analysts_own_is_added_and_removed(api, monkeypatch):
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=lambda s, u: "{}"))
    r = api("POST", "/lenses", json={"name": "Unsupported", "instructions": "Mark the claims no file shows."})
    assert r.status_code == 201
    lid = r.json()["id"]
    assert r.json()["scope"] == {"chat": False, "cards": False, "report": True}
    assert api("DELETE", f"/lenses/{lid}").status_code == 200
    assert api("DELETE", "/lenses/explain").status_code == 404


def test_the_lenses_hold_the_terminal_lenses_whole(folder):
    from thimble_browser.features import lenses
    ws = home.open_folder(folder)
    text = prompts.render("lenses.md", {"lenses": lenses._lens_text(ws, lenses.lens(ws, "explain"))})
    assert prompts.shared("explain") in text
    assert "(the squeezed text" not in text
    text = prompts.render("lenses.md", {"lenses": lenses._lens_text(ws, lenses.lens(ws, "details"))})
    assert prompts.shared("heads") in text
    assert '"heads" holds at most one heads-up for each text' in text
