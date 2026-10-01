"""The product tour's first-launch state lives in thimble's own home (THIMBLE_HOME/tour.json), never in Claude Code's
config: unseen on a new install, seen once the page records the offer, for every workspace."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main


def test_the_tour_is_offered_once_per_install_and_recorded_in_thimble_home(claude_global_config):
    home = Path(os.environ["THIMBLE_HOME"])
    claude_before = claude_global_config.read_text()
    c = TestClient(main.create_app())
    assert c.get("/api/tour").json() == {"seen": False}
    assert not (home / "tour.json").exists()
    assert c.post("/api/tour/seen").json() == {"seen": True}
    assert c.get("/api/tour").json() == {"seen": True}
    assert json.loads((home / "tour.json").read_text())["seen"]
    # a new app on the same home (a restarted server) still knows
    assert TestClient(main.create_app()).get("/api/tour").json() == {"seen": True}
    assert claude_global_config.read_text() == claude_before


def test_an_unreadable_state_file_offers_the_tour_again():
    home = Path(os.environ["THIMBLE_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "tour.json").write_text("not json")
    c = TestClient(main.create_app())
    assert c.get("/api/tour").json() == {"seen": False}
    assert c.post("/api/tour/seen").json() == {"seen": True}
    assert c.get("/api/tour").json() == {"seen": True}


@pytest.mark.real_write_guard
def test_only_the_browser_or_a_local_tool_records_the_offer(monkeypatch):
    """Recording the offer is a write like any other: a page or a notebook kernel that proves neither the browser's
    cookie nor the token records nothing."""
    from conftest import UI_KEY, _record

    from app import hook_auth

    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    monkeypatch.setenv("THIMBLE_PORT", "8300")
    _record(ui_key=UI_KEY)
    c = TestClient(main.create_app(), base_url="http://testserver")
    assert c.post("/api/tour/seen").status_code == 403
    assert c.get("/api/tour").json() == {"seen": False}
    c.cookies.set(hook_auth.ui_cookie(), UI_KEY)
    assert c.post("/api/tour/seen").json() == {"seen": True}
