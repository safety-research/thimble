"""The product tour's first-launch state lives in thimble's own home (THIMBLE_HOME/tour.json), never in Claude Code's
config: unseen on a new install, seen once the page records the offer, for every workspace and in the pages of
thimble's other home."""
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


@pytest.mark.parametrize("answered_in", ["THIMBLE_BROWSER_HOME", "THIMBLE_PLUGIN_HOME"])
def test_an_answer_given_in_a_page_of_another_of_thimble_s_homes_counts_here(monkeypatch, tmp_path, answered_in):
    """The offer is the person's: thimble-browser runs its server in the browser workbench's home and `thimble` in the
    terminal plugin's, and a page of either reads the answer a page of the other recorded in its own home."""
    homes = {"THIMBLE_BROWSER_HOME": tmp_path / "browser-home", "THIMBLE_PLUGIN_HOME": tmp_path / "plugin-home"}
    for name, home in homes.items():
        monkeypatch.setenv(name, str(home))
    monkeypatch.setenv("THIMBLE_HOME", str(homes[answered_in]))
    assert TestClient(main.create_app()).get("/api/tour").json() == {"seen": False}
    assert TestClient(main.create_app()).post("/api/tour/seen").json() == {"seen": True}
    other = next(h for name, h in homes.items() if name != answered_in)
    monkeypatch.setenv("THIMBLE_HOME", str(other))
    assert TestClient(main.create_app()).get("/api/tour").json() == {"seen": True}
    assert not (other / "tour.json").exists(), "each server records the answer in its own home"


def test_an_unreadable_state_file_offers_the_tour_again():
    home = Path(os.environ["THIMBLE_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "tour.json").write_text("not json")
    c = TestClient(main.create_app())
    assert c.get("/api/tour").json() == {"seen": False}
    assert c.post("/api/tour/seen").json() == {"seen": True}
    assert c.get("/api/tour").json() == {"seen": True}


@pytest.mark.real_write_guard
def test_only_a_signed_in_browser_records_the_offer(monkeypatch):
    """Recording the offer is a write like any other: a page or a notebook kernel without a signed-in browser's cookie
    records nothing."""
    from conftest import UI_COOKIE_VALUE, UI_KEY_VALUE, _record_paired

    from app import hook_auth

    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    monkeypatch.setenv("THIMBLE_PORT", "8300")
    _record_paired(UI_COOKIE_VALUE)
    c = TestClient(main.create_app(), base_url="http://testserver")
    assert c.post("/api/tour/seen").status_code == 403
    assert c.get("/api/tour").json() == {"seen": False}
    c.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    assert c.post(f"/b/{UI_KEY_VALUE}/api/tour/seen").json() == {"seen": True}  # under the page's key (hook_auth)
