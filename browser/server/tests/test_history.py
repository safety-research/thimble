"""A card's earlier versions, and Undo and Redo over the cards and the report (history.py)."""
from browser_client import Signed

from thimble_browser import canvas, history, report


def note(api, question="What is here?", text="Two runs.", by="main"):
    return canvas.new_card(api.ws, {"kind": "note", "question": question, "text": text}, by=by)


def test_an_edit_keeps_the_card_as_it_was_and_restore_brings_it_back(folder):
    api = Signed(folder)
    cell = note(api)
    canvas.update_card(api.ws, cell["id"], {"takeaway": "Two runs, one merged."}, by="main")
    canvas.update_card(api.ws, cell["id"], {"text": "Three runs."}, by="analyst")
    # a star is no edit: the history lists only what the card says
    canvas.update_card(api.ws, cell["id"], {"starred": True}, by="analyst")
    edited = canvas.find(api.ws, cell["id"])[1]["edited"]
    assert [(e["by"], e["fields"]) for e in edited] == [("main", ["takeaway"]), ("analyst", ["payload"])]
    first = api("GET", f"/ws/{{ws}}/cells/{cell['id']}/versions/{edited[0]['id']}").json()
    assert first["fields"] == ["takeaway"] and first["by"] == "main"
    assert first["version"]["takeaway"] == "" and first["version"]["text"] == "Two runs."
    second = api("GET", f"/ws/{{ws}}/cells/{cell['id']}/versions/{edited[1]['id']}").json()
    assert second["version"]["text"] == "Two runs." and second["version"]["takeaway"] == "Two runs, one merged."
    assert api("GET", f"/ws/{{ws}}/cells/{cell['id']}/versions/nope").status_code == 404
    back = api("POST", f"/ws/{{ws}}/cells/{cell['id']}/versions/{edited[1]['id']}/restore").json()
    assert back["text"] == "Two runs." and back["edited"][-1]["by"] == "analyst"


def test_a_code_cards_version_shows_the_outputs_of_its_code(folder):
    api = Signed(folder)
    cell = canvas.new_card(api.ws, {"kind": "code", "question": "How many?", "code": "print(1)"}, by="main")
    canvas.set_run(api.ws, cell["id"], status="ok", outputs=[{"text/plain": "1"}])
    canvas.update_card(api.ws, cell["id"], {"code": "print(2)"}, by="analyst")
    canvas.set_run(api.ws, cell["id"], status="ok", outputs=[{"text/plain": "2"}])
    entry = canvas.find(api.ws, cell["id"])[1]["edited"][-1]["id"]
    v = api("GET", f"/ws/{{ws}}/cells/{cell['id']}/versions/{entry}").json()["version"]
    assert v["code"] == "print(1)" and v["outputs"] == [{"text/plain": "1"}]
    back = api("POST", f"/ws/{{ws}}/cells/{cell['id']}/versions/{entry}/restore").json()
    assert back["code"] == "print(1)" and back["outputs"] == [{"text/plain": "1"}]


def test_undo_and_redo_over_cards(folder):
    api = Signed(folder)
    assert api("GET", "/ws/{ws}/undo").json() == {"undo": None, "redo": None, "held": None}
    cell = note(api)
    # Claude's takeaway on the card it just added joins that step
    canvas.update_card(api.ws, cell["id"], {"takeaway": "Two runs."}, by="main")
    assert api("GET", "/ws/{ws}/undo").json()["undo"] == f"add card {cell['slug']}"
    canvas.update_card(api.ws, cell["id"], {"takeaway": "Only two runs."}, by="analyst")
    assert api("GET", "/ws/{ws}/undo").json()["undo"] == f"edit the takeaway of card {cell['slug']}"
    r = api("POST", "/ws/{ws}/undo").json()
    assert r["applied"] == f"edit the takeaway of card {cell['slug']}" and r["redo"] == r["applied"]
    assert canvas.find(api.ws, cell["id"])[1]["takeaway"] == "Two runs."
    api("POST", "/ws/{ws}/undo")
    assert canvas.canvas(api.ws)["cells"] == []
    assert api("POST", "/ws/{ws}/undo").status_code == 409
    api("POST", "/ws/{ws}/redo")
    assert canvas.find(api.ws, cell["id"])[1]["takeaway"] == "Two runs."
    api("POST", "/ws/{ws}/redo")
    assert canvas.find(api.ws, cell["id"])[1]["takeaway"] == "Only two runs."
    # a delete comes back in its place
    other = note(api, "And this?", by="analyst")
    canvas.delete_card(api.ws, cell["id"], by="analyst")
    api("POST", "/ws/{ws}/undo")
    assert [c["id"] for c in canvas.canvas(api.ws)["cells"]] == [cell["id"], other["id"]]
    # a new change empties the redo stack
    canvas.update_card(api.ws, other["id"], {"starred": True}, by="analyst")
    assert api("GET", "/ws/{ws}/undo").json() == {"undo": f"star card {other['slug']}", "redo": None, "held": None}


def test_undo_waits_for_claude_and_covers_the_report(folder):
    api = Signed(folder)
    report.save(api.ws, "# A\n\nOne.\n", by="analyst")
    report.save(api.ws, "# A\n\nTwo.\n", by="chat:w1")
    assert api("GET", "/ws/{ws}/undo").json()["undo"] == "write the report"
    api.sessions.running = lambda ws: {"main"}
    held = api("GET", "/ws/{ws}/undo").json()
    assert held["undo"] is None and "once Claude stops" in held["held"]
    assert api("POST", "/ws/{ws}/undo").status_code == 409
    api.sessions.running = lambda ws: set()
    api("POST", "/ws/{ws}/undo")
    assert report.markdown(api.ws) == "# A\n\nOne.\n"
    api("POST", "/ws/{ws}/undo")
    assert report.markdown(api.ws) is None
    assert history.labels(api.ws)["redo"] == "edit the report"
