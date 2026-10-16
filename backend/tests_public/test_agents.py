"""agents.py's settings route: the browser changes only the settings it owns."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import hook_auth, userconf
from conftest import sign_in

CORPUS = "mini"


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def test_the_settings_route_changes_only_the_browser_s_settings(client, workspaces_tmp, analyst):
    """A kernel cell or a session's command can reach the route on loopback, so the wrapper's switch and the
    orientation's instructions are not among the keys it takes, and a permission mode changes only with the cookie the
    page gets for the sign-in code in thimble's link (app/hook_auth.py), and must be one; Bypass is none (D47,
    0.9.0)."""
    path = workspaces_tmp / CORPUS / "settings.json"
    auto = {"run_cell_result_lines": 20, "permission_modes": {"dev": "auto"}}
    assert client.put(f"/api/ws/{CORPUS}/settings", json=auto).status_code == 403
    assert client.post("/api/ui/key", json={"code": "a guess"}).status_code == 410
    sign_in(client, hook_auth.mint(CORPUS))
    for key, value in (("kernel_wrap", "none"), ("orient_instructions", "x"), ("card_check", False), ("anything", 1),
                       ("permission_modes", {"dev": "yolo"}), ("permission_modes", {"main": "bypass"}),
                       ("permission_modes", {"dev": "bypass"})):
        r = client.put(f"/api/ws/{CORPUS}/settings", json={"run_cell_result_lines": 20, key: value})
        assert r.status_code == 400, (key, value)
    assert not path.exists() or not json.loads(path.read_text()), "a refused PUT changes nothing"
    assert client.put(f"/api/ws/{CORPUS}/settings", json=auto).json()["permission_modes"] == {"dev": "auto"}
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"run_cell_result_lines": 30})
    assert r.status_code == 200 and r.json()["run_cell_result_lines"] == 30
    assert json.loads(path.read_text()) == {"run_cell_result_lines": 30}
    assert json.loads(userconf.global_file().read_text()) == {"agents": {"dev": {"permissionMode": "auto"}}}, \
        "the permission modes are thimble's config's"


def test_a_subagent_s_web_switch_takes_the_analyst_s_cookie_and_goes_to_thimble_s_config(client, workspaces_tmp, analyst):
    """Settings' web switch keeps one of thimble's subagents off WebFetch and WebSearch (its disallowedTools): `web`
    {row: "off" | null} is written to thimble's config only from the analyst's browser, since turning it back on loosens
    a rule; the orientation's web is main's fence's, so it is no row. GET says each agent's web and CLAUDE.md files, and
    how long a code ticket's request waits."""
    off = {"web": {"critic": "off"}}
    assert client.put(f"/api/ws/{CORPUS}/settings", json=off).status_code == 403
    sign_in(client, hook_auth.mint(CORPUS))
    for bad in ({"orient": "off"}, {"critic": "allow"}, ["critic"]):
        assert client.put(f"/api/ws/{CORPUS}/settings", json={"web": bad}).status_code == 400, bad
    got = client.put(f"/api/ws/{CORPUS}/settings", json=off).json()
    assert got["agents"]["critic"]["web"] == "off" and got["agents"]["writer"]["web"] != "off"
    assert json.loads(userconf.global_file().read_text())["agents"]["critic"] == {"web": "off"}
    got = client.put(f"/api/ws/{CORPUS}/settings", json={"web": {"critic": None}}).json()
    assert got["agents"]["critic"]["web"] != "off"
    assert "web" not in json.loads((workspaces_tmp / CORPUS / "settings.json").read_text() if (workspaces_tmp / CORPUS / "settings.json").exists() else "{}")
    got = client.get(f"/api/ws/{CORPUS}/settings").json()
    assert got["card_wait"] == userconf.CARD_WAIT_MINUTES
    assert {got["agents"][a]["memory"] for a in ("orient", "critic", "writer", "checks")} == {"inherit"}
