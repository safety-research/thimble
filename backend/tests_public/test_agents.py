"""agents.py's settings route: the browser changes only the settings it owns."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import agents


CORPUS = "mini"


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _events(c: str, chat_id: str) -> list[dict]:
    _, log_path = agents.paths(c, chat_id)
    return agents.read_events(log_path)


# ----------------------------------------------------------------------------- routes


def test_the_settings_route_changes_only_the_browser_s_settings(client, workspaces_tmp):
    """The route is unauthenticated and a kernel cell or a session's command can reach it on loopback, so the wrapper's
    switch, the orientation's stored mode and its instructions are not among the keys it takes."""
    path = workspaces_tmp / CORPUS / "settings.json"
    for key, value in (("kernel_wrap", "none"), ("orient_permissions", "bypass"), ("orient_instructions", "x"),
                       ("card_check", False), ("anything", 1)):
        r = client.put(f"/api/ws/{CORPUS}/settings", json={"hide_chat": True, key: value})
        assert r.status_code == 400 and key in r.json()["detail"], key
    assert not path.exists() or "hide_chat" not in json.loads(path.read_text()), "a refused PUT changes nothing"
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"hide_chat": True, "terminal_first": False, "orient_route": "subagent",
                                                       "run_cell_result_lines": 20})
    assert r.status_code == 200 and r.json()["hide_chat"] is True
    assert set(json.loads(path.read_text())) == {"hide_chat", "terminal_first", "orient_route", "run_cell_result_lines"}
