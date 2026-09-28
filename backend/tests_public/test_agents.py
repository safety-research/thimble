"""agents.py's settings route: the browser changes only the settings it owns."""
from __future__ import annotations

import json

import pytest
from conftest import UI_KEY
from fastapi.testclient import TestClient

CORPUS = "mini"


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def test_the_settings_route_changes_only_the_browser_s_settings(client, workspaces_tmp, analyst):
    """A kernel cell or a session's command can reach the route on loopback, so the wrapper's switch and the
    orientation's instructions are not among the keys it takes, and a permission mode changes only with the cookie the
    page gets for the key in thimble's link (app/hook_auth.py), and must be one."""
    path = workspaces_tmp / CORPUS / "settings.json"
    bypass = {"hide_chat": True, "permission_modes": {"dev": "bypass"}}
    assert client.put(f"/api/ws/{CORPUS}/settings", json=bypass).status_code == 403
    assert client.post("/api/ui/key", json={"key": "a guess"}).status_code == 403
    assert client.post("/api/ui/key", json={"key": UI_KEY}).status_code == 204
    for key, value in (("kernel_wrap", "none"), ("orient_instructions", "x"), ("card_check", False), ("anything", 1),
                       ("permission_modes", {"orient": "yolo"}), ("permission_modes", {"main": "bypass"})):
        r = client.put(f"/api/ws/{CORPUS}/settings", json={"hide_chat": True, key: value})
        assert r.status_code == 400, (key, value)
    assert not path.exists() or "hide_chat" not in json.loads(path.read_text()), "a refused PUT changes nothing"
    assert client.put(f"/api/ws/{CORPUS}/settings", json=bypass).json()["permission_modes"] == {"dev": "bypass"}
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"hide_chat": True, "terminal_first": False, "orient_route": "subagent",
                                                       "run_cell_result_lines": 20})
    assert r.status_code == 200 and r.json()["hide_chat"] is True
    assert set(json.loads(path.read_text())) == {"hide_chat", "terminal_first", "orient_route", "run_cell_result_lines",
                                                 "permission_modes"}
