"""The browser's smoke test, server half: through the signed-in server's routes, a question to main gets an answer with
a card drawn under its call and a mark that the checker verifies. Claude is a fake: main draws a card from rows its
code wrote in the temp folder, then answers with a mark; the checker (a copy of main) answers with a quote's place,
which the terminal's validator finds in the file. The card runner and the validator are the real ones (the runner runs
without the sandbox here, which tests/test_sandbox.py covers).

The page half is browser/frontend/tests/public/render.test.tsx: it draws SMOKE (the records this turn leaves, kept in
tests/public/smoke.json) as the chat's rows. This test checks that the server still leaves records of that form."""
import json
import shutil
import time
from pathlib import Path

import pytest
from fakes import ScriptedClient, turns
from fastapi.testclient import TestClient

from thimble_browser import agent, home, llm
from thimble_browser.app import build

PORT = 21096
OWN = f"http://127.0.0.1:{PORT}"
SMOKE = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "public" / "smoke.json"
VIEW = """
const keys = "n"
function onKey(key, surface) { surface.setState({ n: ((surface.state || {}).n || 0) + 1 }) }
function view(props, surface) {
  const { Box, Text } = surface.elements
  const n = (surface.state || {}).n || 0
  return Box({ flexDirection: "column", children: [
    ...props.rows.map(r => Text({ children: `${r.run}: ${r.outcome}` })),
    Text({ dimColor: true, children: `pressed ${n}` })] })
}
"""
ANSWER = 'One of the two runs ["merged"](#).'
CHECK = [{"mark": 1, "words": '"merged"', "kind": "quote",
          "evidence": {"file": "results.csv", "line": 2, "substring": "merged"},
          "status": "verified", "correction": None, "reason": "run a merged"}]


def claude(req):
    asked = req["messages"][-1]["content"]
    asked = asked if isinstance(asked, str) else json.dumps(asked)
    if "check your last reply" in asked:
        return ["```json\n" + json.dumps(CHECK) + "\n```"]
    if turns(req) == 0:
        return [{"tool": "card", "input": {"title": "How the runs ended", "data": "$TMPDIR/runs.json", "view": VIEW}}]
    return [ANSWER]


def shape(records):
    """Each record's type, and a tool call's name."""
    return [(r["type"], r.get("name")) for r in records]


@pytest.mark.skipif(shutil.which("node") is None, reason="the card runner and the marks run on Node")
def test_a_question_gets_an_answer_with_a_card_and_a_checked_mark(folder, monkeypatch):
    ws = home.open_folder(folder)
    (home.temp_dir(ws) / "runs.json").write_text(json.dumps([{"run": "a", "outcome": "merged"},
                                                             {"run": "b", "outcome": "failed"}]))
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(script=claude))
    app, auth, _ = build(PORT, unsandboxed=True)
    with TestClient(app, base_url=OWN) as c:
        r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
        key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]

        def api(method, path, **kw):
            return c.request(method, f"/b/{key}/api/ws/{ws}{path}", headers={"cookie": cookie, "origin": OWN}, **kw)

        sent = api("POST", "/events", json={"kind": "main", "payload": {"text": "How did the runs end?"}})
        assert sent.status_code == 200, sent.text

        def settled(records):
            marks = [r for r in records if r["type"] == "marks"]
            return marks and all(m["status"] != "checking" for m in marks[-1]["items"])

        t0 = time.time()
        while not settled(records := api("GET", "/chats/main").json()["events"]):
            assert time.time() - t0 < 20, records
            time.sleep(0.05)
        drawn = next(r for r in records if r["type"] == "tool_result")
        assert drawn.get("card"), drawn
        assert "It read 2 rows from runs.json, with the columns run, outcome." in drawn["summary"]
        assert "a: merged" in drawn["summary"]
        card = api("GET", f"/cards/{drawn['card']}").json()
        assert card["title"] == "How the runs ended" and card["keys"] == ["n"]
        pressed = api("POST", f"/cards/{drawn['card']}/key", json={"key": "n"}).json()
        assert "pressed 1" in json.dumps(pressed["tree"])
        marks = [r for r in records if r["type"] == "marks"][-1]
        assert [(m["words"], m["status"]) for m in marks["items"]] == [('"merged"', "verified")]
        assert marks["items"][0]["evidence"]["kind"] == "quote"
        # the checker is a copy the thread list does not show
        assert [m["id"] for m in api("GET", "/chats").json()] == ["main"]
    assert not agent.take_notes(ws, "main"), "a check that changed nothing tells main nothing"
    main = [r for r in records if r["type"] != "marks" or r is marks]
    # the page draws records of this form (render.test.tsx)
    assert shape(main) == shape(json.loads(SMOKE.read_text()))
