"""The canvas as the analyst arranges it: groups, moves and the analyst's own cards (canvas_layout.py)."""
from fastapi.testclient import TestClient

from thimble_browser import canvas, home
from thimble_browser.app import build

PORT = 21096
OWN = f"http://127.0.0.1:{PORT}"


def client(folder):
    ws = home.open_folder(folder)
    app, auth, _ = build(PORT)
    c = TestClient(app, base_url=OWN)
    r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
    key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]
    h = {"cookie": cookie, "origin": OWN}

    def call(method, path, **kw):
        return c.request(method, f"/b/{key}/api/ws/{ws}{path}", headers=h, **kw)
    return ws, call


def test_groups_are_made_placed_nested_and_deleted_with_their_cards(folder):
    ws, call = client(folder)
    a = call("POST", "/notebooks", json={"title": "Failures", "pos": {"x": 40, "y": 80}}).json()
    b = call("POST", "/notebooks", json={"title": "Parser", "parent": a["id"], "order": 0}).json()
    assert a["pos"] == {"x": 40, "y": 80} and b["parent"] == a["id"] and a["role"] == "analyst"
    assert call("POST", "/notebooks", json={"parent": "nope"}).status_code == 404
    assert call("PUT", f"/notebooks/{a['id']}", json={"parent": b["id"]}).status_code == 400  # no cycle
    assert call("PUT", f"/notebooks/{a['id']}", json={"pos": {"x": "far"}}).status_code == 400
    got = call("PUT", f"/notebooks/{b['id']}", json={"title": "Parser bugs", "parent": None, "pos": None}).json()
    assert got["title"] == "Parser bugs" and got["parent"] is None
    canvas.new_card(ws, {"kind": "note", "question": "Why?", "text": "x", "group": a["id"]})
    assert {g["title"] for g in call("GET", "/notebooks").json()} == {"Failures", "Parser bugs"}
    assert call("DELETE", f"/notebooks/{a['id']}").json() == {"ok": True}
    assert [g["title"] for g in canvas.canvas(ws)["groups"]] == ["Parser bugs"] and canvas.canvas(ws)["cells"] == []
    assert (home.workspace_dir(ws) / "trash" / "notebooks").is_dir()


def test_cards_move_in_order_or_free_and_the_analyst_adds_an_empty_one(folder):
    ws, call = client(folder)
    g = call("POST", "/notebooks", json={"title": "Your work"}).json()
    one = call("POST", f"/notebooks/{g['id']}/cells", json={"kind": "code", "title": "New card", "code": ""}).json()
    assert one["code"] == "" and one["created_by"] == "user" and one["notebook"] == g["id"]
    two = canvas.new_card(ws, {"kind": "note", "question": "Two", "text": "b"})
    three = canvas.new_card(ws, {"kind": "note", "question": "Three", "text": "c"})
    moved = call("POST", "/cells/move", json={"cells": [three["id"], two["id"]], "group": g["id"], "after": None}).json()
    assert [c["id"] for c in moved] == [three["id"], two["id"]]
    assert [c["id"] for c in canvas.load(ws, g["id"])["cells"]] == [three["id"], two["id"], one["id"]]
    free = call("POST", "/cells/move", json={"cells": [one["id"]], "group": None, "pos": {"x": 10, "y": 20}}).json()
    assert free[0]["pos"] == {"x": 10, "y": 20} and free[0]["notebook"] == canvas.MAIN
    assert call("POST", "/cells/move", json={"cells": [one["id"], two["id"]], "group": g["id"],
                                             "pos": {"x": 1, "y": 1}}).status_code == 400
    assert call("POST", "/cells/move", json={"cells": ["nope"], "group": g["id"]}).status_code == 404
