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
    bypass = {"run_cell_result_lines": 20, "permission_modes": {"dev": "bypass"}}
    assert client.put(f"/api/ws/{CORPUS}/settings", json=bypass).status_code == 403
    assert client.post("/api/ui/key", json={"key": "a guess"}).status_code == 403
    assert client.post("/api/ui/key", json={"key": UI_KEY}).status_code == 204
    for key, value in (("kernel_wrap", "none"), ("orient_instructions", "x"), ("card_check", False), ("anything", 1),
                       ("permission_modes", {"orient": "yolo"}), ("permission_modes", {"main": "bypass"})):
        r = client.put(f"/api/ws/{CORPUS}/settings", json={"run_cell_result_lines": 20, key: value})
        assert r.status_code == 400, (key, value)
    assert not path.exists() or not json.loads(path.read_text()), "a refused PUT changes nothing"
    assert client.put(f"/api/ws/{CORPUS}/settings", json=bypass).json()["permission_modes"] == {"dev": "bypass"}
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"run_cell_result_lines": 30})
    assert r.status_code == 200 and r.json()["run_cell_result_lines"] == 30
    assert json.loads(path.read_text()) == {"run_cell_result_lines": 30}
    assert json.loads(userconf.global_file().read_text()) == {"agents": {"dev": {"permissionMode": "bypass"}}}, \
        "the permission modes are thimble's config's"


def test_a_retired_setting_an_earlier_build_stored_loads_and_is_dropped(client, workspaces_tmp):
    """orient_route and terminal_first, which earlier builds stored to pick how the orientation ran, and hide_chat,
    which hid the chat column, break nothing: GET leaves them out, a PUT from a tab of an earlier build that sends them
    succeeds without storing them, and the next PUT removes them from the file (ledger.RETIRED_KEYS)."""
    from app import config, ledger

    retired = {"orient_route", "terminal_first", "hide_chat"}
    path = config.workspace_dir(CORPUS) / "settings.json"
    path.write_text(json.dumps({"orient_route": "subagent", "terminal_first": False, "hide_chat": True,
                                "run_cell_result_lines": 20}))
    got = client.get(f"/api/ws/{CORPUS}/settings").json()
    assert not retired & set(got) and got["run_cell_result_lines"] == 20
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"orient_route": "session", "hide_chat": False})
    assert r.status_code == 200 and not retired & set(r.json())
    assert json.loads(path.read_text()) == {"run_cell_result_lines": 20}
    assert retired <= ledger.RETIRED_KEYS and not ledger.RETIRED_KEYS & set(ledger.SETTINGS_DEFAULTS)
