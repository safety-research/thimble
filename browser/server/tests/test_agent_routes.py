"""The routes of the orientation, the card check and the report checks, through the signed-in server, with a fake
Messages API client."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from thimble_browser import canvas, home, llm, report
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


def test_check_again_runs_the_card_s_check_and_undo_puts_it_back(api, monkeypatch):
    reply = {"assessment": [{"problem": "The question asks two things."}] + [{"problem": ""}] * 4,
             "question": "How did run a end?", "code": "", "takeaway": "Run a was merged."}
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=lambda s, u: json.dumps(reply)))
    cell = canvas.new_card(api.ws, {"question": "How did run a end, and who reviewed it?", "kind": "note",
                                    "text": "Merged.", "takeaway": "Run a was merged."}, by="main")
    r = api("POST", f"/cells/{cell['id']}/check")
    assert r.status_code == 200 and r.json()["card"] == cell["id"]
    got = until(lambda: (c := api("GET", f"/cells/{cell['id']}").json()).get("check", {}).get("status") == "fixed" and c)
    fix = got["fixes"][0]
    assert got["title"] == "How did run a end?" and fix["fields"] == ["title"]
    assert api("GET", "/card-checks").json()["enabled"] is True
    r = api("POST", f"/cells/{cell['id']}/fixes/{fix['id']}/undo")
    assert r.status_code == 200 and r.json()["title"] == "How did run a end, and who reviewed it?"
    assert api("POST", f"/cells/{cell['id']}/fixes/{fix['id']}/undo").status_code == 409
    mine = canvas.new_card(api.ws, {"question": "Q?", "kind": "note", "text": "t", "takeaway": "A."}, by="analyst")
    assert api("POST", f"/cells/{mine['id']}/check").status_code == 409


def test_the_orientation_and_the_checks_answer_before_anything_ran(api):
    assert api("GET", "/orientation").json() == {}
    assert api("POST", "/orientation/message", json={"text": "More?"}).status_code == 409
    checks = api("GET", "/checks").json()
    assert [c["id"] for c in checks] == ["judgment", "unverified", "important-details"]
    assert [c["shown"] for c in checks] == [False, False, True]
    assert api("POST", "/checks/judgment/run", json={"doc": "report"}).status_code == 409


def test_the_analyst_comments_on_a_sentence_and_dismisses_it(api, monkeypatch):
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(lambda req: ["Commented on 0 passages."]))
    report.save(api.ws, "# Title\n\n## Part\n\nOne sentence. Two sentences.\n", by="chat:w1")
    r = api("POST", "/investigations/main/types/report/comments", json={"sentence_id": "t1.0.1", "text": "Why?"})
    assert r.status_code in (200, 201) and r.json()["author"] == "analyst"  # comments.py keeps the analyst's own
    doc = api("GET", "/investigations/main/types/report").json()
    assert [c["text"] for c in doc["comments"]] == ["Why?"]
    assert api("GET", "/investigations/main/types").json()["report"]["open_comments"] == 1
    r = api("POST", f"/investigations/main/types/report/comments/{doc['comments'][0]['id']}/dismiss")
    assert r.status_code == 200 and not [c for c in r.json()["comments"] if c.get("status", "open") == "open"]
    r = api("PATCH", "/checks/judgment", json={"shown": True})
    assert r.status_code == 200 and r.json()["shown"] is True
