"""thimble's feature switches (app/features.py, contract C6): each is on until thimble's config turns it off, a set
reads back as written, the five switches with no Settings row of their own travel as the Settings payload's
`features` and only the analyst's browser may change them, `thimble features` reads and sets them, and a switched-off
feature's tools refuse with one line."""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app import features, ledger, tools, userconf

CORPUS = "mini"
ALL_ON = {k: True for k in features.KEYS}


def _write(path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def test_every_switch_is_on_until_the_config_turns_it_off(workspaces_tmp):
    assert features.KEYS == ("autoActivate", "viewProposals", "labels", "checks", "citationMarks", "coverage",
                             "cardCheck")
    assert features.settings() == ALL_ON and features.settings(CORPUS) == ALL_ON
    assert features.flags() == {"labels", "checks"}
    _write(userconf.global_file(), {"features": {"labels": False, "coverage": None, "citationMarks": True},
                                    "views": {"propose": False}, "agents": {"cardCheck": {"auto": False}}})
    got = features.settings()
    assert got == {**ALL_ON, "labels": False, "viewProposals": False, "cardCheck": False}
    assert features.flags() == {"checks"} and not features.on(None, "labels") and features.on(None, "coverage")
    assert not features.auto(None, "labels") and features.auto(None, "checks") and not features.auto(CORPUS, "proposer")
    assert not features.auto(CORPUS, "card_check")
    with pytest.raises(features.FeatureError):
        features.on(None, "residue")
    with pytest.raises(features.FeatureError):
        features.auto(None, "tray")


def test_the_settings_payload_carries_the_switches_and_only_the_analyst_changes_them(workspaces_tmp, analyst):
    got = ledger.get_settings(CORPUS)
    assert got[ledger.FEATURES_KEY] == {k: True for k in features.BLOCK_KEYS}
    assert set(features.BLOCK_KEYS) == {"autoActivate", "labels", "checks", "citationMarks", "coverage"}
    out = ledger.put_settings_route(CORPUS, analyst, {ledger.FEATURES_KEY: {"labels": False, "autoActivate": False}})
    assert out[ledger.FEATURES_KEY] == {**{k: True for k in features.BLOCK_KEYS}, "labels": False, "autoActivate": False}
    assert not features.on(CORPUS, "labels") and not features.on(None, "autoActivate")
    assert json.loads(userconf.global_file().read_text())["features"] == {"labels": False, "autoActivate": False}
    stored = ledger.ws_dir(CORPUS) / "settings.json"
    assert not stored.exists() or ledger.FEATURES_KEY not in json.loads(stored.read_text()), "never settings.json"
    with pytest.raises(HTTPException) as e:
        ledger.put_settings_route(CORPUS, _not_analyst(), {ledger.FEATURES_KEY: {"labels": True}})
    assert e.value.status_code == 403 and not features.on(CORPUS, "labels"), "a request from no signed-in browser"
    for bad in ({"labels": "on"}, {"viewProposals": False}, ["labels"]):
        with pytest.raises(HTTPException) as e:
            ledger.put_settings_route(CORPUS, analyst, {ledger.FEATURES_KEY: bad})
        assert e.value.status_code == 400, bad
    out = ledger.put_settings_route(CORPUS, analyst, {ledger.FEATURES_KEY: {"labels": None, "autoActivate": None}})
    assert out[ledger.FEATURES_KEY] == {k: True for k in features.BLOCK_KEYS}


def _not_analyst():
    from starlette.requests import Request

    return Request({"type": "http", "headers": []})


@pytest.mark.parametrize("tool, key", sorted(tools.FEATURE_TOOLS.items())[:1])
async def test_a_switched_off_feature_s_tool_stays_listed_and_refuses_with_one_line(workspaces_tmp, tool, key):
    """apply_label with labels off and run_check with checks off: listed (thimble's agents share main's listing), and
    a call answers the tool's `-off` hint as an error, running nothing."""
    assert tool in {t["name"] for t in tools.list(tools.ANALYST)}
    features.set_settings({key: "off"}, "test")
    res = await tools.call(CORPUS, tool, {"name": "x", "scope": "files", "predicate": {"kind": "regex", "text": "x"}})
    assert res.is_error
    line = tools.hint(f"{tool}-off")
    assert line and line in res.text and f"/config → thimble → {key.capitalize()}" in line
    assert "\n" not in line
