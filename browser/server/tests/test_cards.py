"""Cards: the card tool and the runner are the terminal plugin's (plugin/cards/), started the same way; a card's data
file must be in the folder or the temp folder; v starts a copy of the chat whose card stands under the answer, and main
hears of it with the analyst's next message."""
import json
import re
import shutil
import time

import pytest
from fakes import ScriptedClient, turns
from fastapi.testclient import TestClient

from thimble_browser import agent, cardrunner, chats, home, llm, tools
from thimble_browser.app import build
from thimble_browser.features import cards

node = pytest.mark.skipif(shutil.which("node") is None, reason="the card runner runs on Node")

ARGV = """
import { runnerCommand } from './cards/argv.mjs'
console.log(JSON.stringify(runnerCommand({ plugin: process.argv[1], node: 'node', cards: '/c', run: '/r', sock: '/r/s.sock' })))
"""


@node
def test_the_runner_starts_as_the_terminal_starts_it():
    import subprocess

    got = subprocess.run(["node", "--input-type=module", "-e", ARGV, str(cardrunner.PLUGIN)], cwd=cardrunner.PLUGIN,
                         capture_output=True, text=True, check=True)
    # both start it in srt with an empty environment, each with its own rules (the browser's: cards/sandbox.py)
    assert json.loads(got.stdout) == cardrunner.argv("node", "/c", "/r", "/r/s.sock")


async def test_a_data_file_outside_the_folder_and_the_temp_folder_is_refused(folder, tmp_path):
    ws = home.open_folder(folder)
    (tmp_path / "rows.json").write_text("[]")
    t = tools.Tools(ws, "main", folder)
    for data, why in ((str(tmp_path / "rows.json"), "outside this folder and the temp folder"), ("", "`data` is empty"),
                      ("$TMPDIR/none.json", "there is no file")):
        r = await cards.card(t, {"title": "t", "data": data, "view": "function view(){}"})
        assert r.is_error and why in r.text, r.text


VIEW = "function view(props, surface) { const { Text } = surface.elements; return Text({ children: `${props.rows.length} runs` }) }"


@node
async def test_a_new_version_may_keep_the_rows_and_edit_the_view_on_screen(folder):
    ws = home.open_folder(folder)
    (home.temp_dir(ws) / "runs.json").write_text(json.dumps([{"run": "a"}, {"run": "b"}]))
    t = tools.Tools(ws, "main", folder, unsandboxed=True)
    first = await cards.card(t, {"title": "Runs", "data": "$TMPDIR/runs.json", "view": VIEW})
    cid = first.extra["card"]
    bad = await cards.card(t, {"title": "Runs", "id": cid, "edits": [{"old": "no such text", "new": "x"}]})
    assert bad.is_error and "is not in the view of your last call" in bad.text
    r = await cards.card(t, {"title": "Runs", "id": cid, "edits": [{"old": "runs`", "new": "runs kept`"}]})
    assert not r.is_error and r.extra["version"] == 2, r.text
    assert "It read 2 rows from runs.json" in r.text and "2 runs kept" in r.text
    await cardrunner.close_all()


@node
async def test_a_version_keeps_its_title_and_place_and_edits_fix_a_view_that_did_not_draw(folder):
    ws = home.open_folder(folder)
    (home.temp_dir(ws) / "runs.json").write_text(json.dumps([{"run": "a"}, {"run": "b"}]))
    t = tools.Tools(ws, "main", folder, unsandboxed=True)
    untitled = await cards.card(t, {"data": "$TMPDIR/runs.json", "view": VIEW})
    assert untitled.is_error and "`title` is empty" in untitled.text
    # a new card whose view does not parse: the error names its id, and edits by that id fix it
    broken = await cards.card(t, {"title": "Runs", "data": "$TMPDIR/runs.json", "view": VIEW + ")"})
    assert broken.is_error and "`edits` change the view of this call" in broken.text
    cid = re.search(r'id "(c[0-9a-f]{8})"', broken.text)[1]
    first = await cards.card(t, {"id": cid, "edits": [{"old": "}) })", "new": "}) }"}]})
    assert not first.is_error and first.extra["title"] == "Runs", first.text
    assert "“Runs” is drawn where this call stands" in first.text
    # a later version with no title keeps it, and takes the card's place
    again = await cards.card(t, {"id": cid, "edits": [{"old": "runs`", "new": "runs kept`"}]})
    assert not again.is_error and again.extra["title"] == "Runs" and again.extra["version"] == 2, again.text
    assert "is drawn in place of version 1, under the call that first drew the card" in again.text
    await cardrunner.close_all()


def designer(req):
    asked = req["messages"][-1]["content"]
    asked = asked if isinstance(asked, str) else json.dumps(asked)
    if "pressed v under your last answer" in asked:
        if turns(req) == 1:  # the designer's first step, after main's one answer
            return [{"tool": "card", "input": {"title": "Runs", "data": "$TMPDIR/runs.json", "view": VIEW}}]
        return ["Runs, as a count."]
    if turns(req) == 0:
        return ["There are 2 runs."]
    return ["Noted."]


@node
def test_v_draws_a_card_under_the_answer_and_main_hears_of_it(folder, monkeypatch):
    ws = home.open_folder(folder)
    (home.temp_dir(ws) / "runs.json").write_text(json.dumps([{"run": "a"}, {"run": "b"}]))
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(script=designer))
    monkeypatch.setattr(agent, "AFTER_TURN", [])
    app, auth, _ = build(21097, unsandboxed=True)
    own = "http://127.0.0.1:21097"
    with TestClient(app, base_url=own) as c:
        r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": own})
        key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]

        def api(method, path, **kw):
            return c.request(method, f"/b/{key}/api/ws/{ws}{path}", headers={"cookie": cookie, "origin": own}, **kw)

        assert api("POST", "/v", json={"chat": "main"}).status_code == 409  # no answer yet
        api("POST", "/events", json={"kind": "main", "payload": {"text": "How many runs?"}})
        t0 = time.time()
        while not any(r["type"] == "done" for r in api("GET", "/chats/main").json()["events"]):
            assert time.time() - t0 < 10
            time.sleep(0.05)
        started = api("POST", "/v", json={"chat": "main"})
        assert started.status_code == 200, started.text
        turn = started.json()["turn"]
        t0 = time.time()
        while not agent.load_messages(ws, "main") or not (notes := home.read_json(agent._notes_path(ws, "main"), [])):
            assert time.time() - t0 < 10
            time.sleep(0.05)
        drawn = [r for r in chats.records(ws, "main") if r["type"] == "card"]
        assert [d["turn"] for d in drawn] == [turn]
        card = api("GET", f"/cards/{drawn[0]['card']}").json()
        assert card["title"] == "Runs" and "2 runs" in json.dumps(card["tree"])
        assert "a copy of you drew a card under it" in notes[0] and "2 runs" in notes[0]
        assert [m["id"] for m in api("GET", "/chats").json()] == ["main"]
