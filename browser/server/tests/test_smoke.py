"""The browser's smoke test, server half: through the signed-in server's routes, a question to main gets an answer that
cites the card Claude made, and the card is on the canvas. Claude is a fake that makes a note card, then answers.

The page half is browser/frontend/tests/public/render.test.tsx: it draws SMOKE (the records this turn leaves, kept in
tests/public/smoke.json) as the chat's rows. This test checks that the server still leaves records of that form."""
import json
import re
import time
from pathlib import Path

from fakes import ScriptedClient, last_result, turns
from fastapi.testclient import TestClient

from thimble_browser import agent, home, llm
from thimble_browser.app import build

PORT = 21096
OWN = f"http://127.0.0.1:{PORT}"
SMOKE = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "public" / "smoke.json"


def claude(req):
    if turns(req) == 0:
        return ["I will put the outcomes on a card.",
                {"tool": "add_card", "input": {"kind": "note", "question": "How did the runs end?",
                                               "text": "One merged, one failed [↗](results.csv#row=1).",
                                               "takeaway": "[1](results.csv#row=1) of 2 runs merged."}}]
    card = re.search(r"card:([0-9a-f]+)", last_result(req)).group(1)
    return [f"One of the two runs merged [1](card:{card})."]


def shape(records):
    """Each record's type, and a tool call's name."""
    return [(r["type"], r.get("name")) for r in records]


def test_a_question_gets_an_answer_with_a_card(folder, monkeypatch):
    ws = home.open_folder(folder)
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(script=claude))
    app, auth, _ = build(PORT)
    monkeypatch.setattr(agent, "AFTER_TURN", [])  # the lenses' reading after a turn is not this test's
    with TestClient(app, base_url=OWN) as c:
        r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
        key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]

        def api(method, path, **kw):
            return c.request(method, f"/b/{key}/api/ws/{ws}{path}", headers={"cookie": cookie, "origin": OWN}, **kw)

        sent = api("POST", "/events", json={"kind": "main", "payload": {"text": "How did the runs end?"}})
        assert sent.status_code == 200, sent.text
        t0 = time.time()
        while True:
            records = api("GET", "/chats/main").json()["events"]
            if records and records[-1]["type"] in ("done", "error"):
                break
            assert time.time() - t0 < 10, records
            time.sleep(0.02)
        assert records[-1]["type"] == "done", records[-1]
        cards = api("GET", "/canvas").json()["cells"]
    assert [cell["title"] for cell in cards] == ["How did the runs end?"], cards
    card = cards[0]["id"]
    assert cards[0]["takeaway"] == "[[1|results.csv#row=1]] of 2 runs merged."
    answer = "".join(r.get("text") or r.get("delta") or "" for r in records if r["type"] == "text")
    assert f"[1](card:{card})" in answer or f"[[1|card:{card}]]" in answer, answer
    made = [r for r in records if r["type"] == "tool_result"]
    assert made and made[0].get("cell_id") == card
    # the page draws records of this form (render.test.tsx)
    assert shape(records) == shape(json.loads(SMOKE.read_text()))
