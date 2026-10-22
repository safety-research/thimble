"""The features' routes through the signed-in server, with a fake Messages API client: the switches, and a view built
only on the analyst's Accept."""
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
    assert names == ["marks", "cards", "lenses", "labels", "report", "views"]


def test_a_feature_turned_off_keeps_its_routes_and_leaves_the_others(api):
    r = api("PUT", "/settings", json={"features": {"report": False}})
    assert r.status_code == 200
    got = {f["name"]: f["on"] for f in api("GET", "/features").json()}
    assert got == {"marks": True, "cards": True, "lenses": True, "labels": True, "report": False, "views": True}
    assert api("GET", "/investigations/main/types").status_code == 200
    assert api("GET", "/canvas").status_code == 200
    assert api("PUT", "/settings", json={"features": {"report": "no"}}).status_code == 400


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
