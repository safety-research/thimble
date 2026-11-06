"""thimble's config (app/userconf.py): where the Settings pane saves a change."""
from __future__ import annotations

import json

import pytest

from app import ledger, userconf

CORPUS = "mini"


def test_the_settings_pane_saves_each_change_where_the_value_it_shows_came_from(workspaces_tmp, analyst):
    """A change goes to the workspace's file when that file sets the key, else to thimble's home; back to the default
    removes it; a value the config does not take is refused and nothing is written."""
    userconf.workspace_file(CORPUS).parent.mkdir(parents=True, exist_ok=True)
    userconf.workspace_file(CORPUS).write_text(json.dumps({"agents": {"writer": {"effort": "low"}}}))
    ledger.put_settings_route(CORPUS, analyst, {"models": {"writer": {"effort": "high"}, "critic": {"effort": "max"}}})
    assert json.loads(userconf.workspace_file(CORPUS).read_text()) == {"agents": {"writer": {"effort": "high"}}}
    assert json.loads(userconf.global_file().read_text()) == {"agents": {"critic": {"effort": "max"}}}
    got = ledger.get_settings(CORPUS)["models"]
    assert got["writer"]["effort"] == "high" and got["critic"]["effort"] == "max"
    ledger.put_settings_route(CORPUS, analyst, {"models": {"critic": {"effort": ""}}})
    assert "critic" not in json.loads(userconf.global_file().read_text()).get("agents", {}), "back to the default"
    before = userconf.global_file().read_text()
    with pytest.raises(Exception) as e:
        ledger.put_settings_route(CORPUS, analyst, {"models": {"critic": {"effort": "ultracode"}}})
    assert getattr(e.value, "status_code", None) == 400 and userconf.global_file().read_text() == before
