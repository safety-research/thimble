"""agents.py's settings route: the browser changes only the settings it owns."""
from __future__ import annotations

import json

import pytest
from conftest import UI_KEY
from fastapi.testclient import TestClient

from app import userconf

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
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"hide_chat": True, "terminal_first": False,
                                                       "run_cell_result_lines": 20})
    assert r.status_code == 200 and r.json()["hide_chat"] is True
    assert set(json.loads(path.read_text())) == {"hide_chat", "terminal_first", "run_cell_result_lines"}
    assert json.loads(userconf.global_file().read_text()) == {"agents": {"dev": {"permissionMode": "bypass"}}}, \
        "the permission modes are thimble's config's"


def test_a_retired_setting_an_earlier_build_stored_loads_and_is_dropped(client, workspaces_tmp):
    """orient_route, which 0.2 dev builds stored to pick how terminal-first mode ran the orientation, breaks nothing:
    GET leaves it out, a PUT from a tab of an earlier build that sends it succeeds without storing it, and the next PUT
    removes it from the file (ledger.RETIRED_KEYS)."""
    from app import bg_session, config, ledger

    path = config.workspace_dir(CORPUS) / "settings.json"
    path.write_text(json.dumps({"terminal_first": True, "orient_route": "subagent", "hide_chat": True}))
    got = client.get(f"/api/ws/{CORPUS}/settings").json()
    assert "orient_route" not in got and got["terminal_first"] is True and got["hide_chat"] is True
    assert bg_session.wanted(CORPUS, "orient"), "a stored subagent route still runs the orientation as a session"
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"orient_route": "session", "hide_chat": False})
    assert r.status_code == 200 and "orient_route" not in r.json()
    assert json.loads(path.read_text()) == {"terminal_first": True, "hide_chat": False}
    assert "orient_route" not in ledger.SETTINGS_DEFAULTS
