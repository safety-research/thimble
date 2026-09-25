"""cc_settings.py: the analyst's own Claude Code settings decide main's effort, thimble's default (high) applies only
where they say nothing, and the composer's effort chip changes main's effort through the one file Claude Code re-reads
while it runs, taking back only what thimble wrote."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cc_settings


@pytest.fixture()
def folder(tmp_path, monkeypatch) -> Path:
    """A corpus folder, an empty Claude config dir and thimble home, and no effort in the environment."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.delenv(cc_settings.EFFORT_ENV, raising=False)
    monkeypatch.setattr(cc_settings, "MANAGED", {})
    (tmp_path / "claude").mkdir()
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    return corpus


def _write(path: Path, d: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(d))


def test_thimble_s_default_applies_only_where_the_analyst_s_settings_say_nothing(folder, tmp_path, monkeypatch):
    assert not cc_settings.names_effort(folder) and cc_settings.main_effort_flag(folder) == "high"
    user = tmp_path / "claude" / "settings.json"
    for d in ({"ultracode": True}, {"env": {cc_settings.EFFORT_ENV: "low"}},
              {"model": "opus[1m]", "modelSettings": {"claude-opus-5-5": {"effortLevel": "low"}}}):
        _write(user, d)
        assert cc_settings.names_effort(folder) and cc_settings.main_effort_flag(folder) == "", d
    _write(user, {"ultracode": False, "theme": "dark"})
    assert cc_settings.main_effort_flag(folder) == "high", "ultracode off says nothing about the effort"
    _write(folder / cc_settings.PROJECT_SETTINGS, {"effortLevel": "high"})
    assert cc_settings.main_effort_flag(folder) == ""
    (folder / cc_settings.PROJECT_SETTINGS).unlink()
    monkeypatch.setenv(cc_settings.EFFORT_ENV, "max")
    assert cc_settings.main_effort_flag(folder) == ""


def test_the_chip_writes_the_level_into_the_local_settings_and_keeps_what_else_is_there(folder):
    local = folder / cc_settings.LOCAL_SETTINGS
    _write(local, {"permissions": {"allow": ["Bash(ls)"]}, "env": {"FOO": "1"}})
    assert cc_settings.set_main_effort(folder, "high") == "high"
    d = json.loads(local.read_text())
    assert d == {"permissions": {"allow": ["Bash(ls)"]}, "env": {"FOO": "1", cc_settings.EFFORT_ENV: "high"}}
    assert cc_settings.set_main_effort(folder, "ultracode") == "xhigh", "ultracode runs at xhigh"
    assert not cc_settings.names_effort(folder), "thimble's own key is not the analyst's choice"
    with pytest.raises(ValueError):
        cc_settings.set_main_effort(folder, "extreme")
    assert cc_settings.clear_override(folder)
    assert json.loads(local.read_text()) == {"permissions": {"allow": ["Bash(ls)"]}, "env": {"FOO": "1"}}
    assert not cc_settings.clear_override(folder), "nothing of thimble's is left"


def test_a_level_the_analyst_changed_by_hand_is_theirs_and_stays(folder):
    local = folder / cc_settings.LOCAL_SETTINGS
    cc_settings.set_main_effort(folder, "low")
    _write(local, {"env": {cc_settings.EFFORT_ENV: "max"}})
    assert cc_settings.names_effort(folder), "a value thimble did not write is the analyst's"
    assert not cc_settings.clear_override(folder)
    assert json.loads(local.read_text()) == {"env": {cc_settings.EFFORT_ENV: "max"}}


def test_a_file_the_chip_made_is_removed_when_its_key_goes(folder):
    cc_settings.set_main_effort(folder, "medium")
    assert cc_settings.clear_override(folder) and not (folder / cc_settings.LOCAL_SETTINGS).exists()


def test_the_effort_menus_open_on_the_analyst_s_own_choice(folder, tmp_path, monkeypatch):
    """The effort menus open on the level the analyst's own settings define. The environment's level outranks every
    file, a file's env level outranks ultracode and effortLevel, ultracode on outranks effortLevel, and a higher file
    decides over a lower one; thimble's own key is not the analyst's."""
    user = tmp_path / "claude" / "settings.json"
    assert cc_settings.analyst_effort(folder) is None
    _write(user, {"effortLevel": "xhigh", "ultracode": True})
    assert cc_settings.analyst_effort(folder) == "ultracode"
    _write(folder / cc_settings.PROJECT_SETTINGS, {"ultracode": False})
    assert cc_settings.analyst_effort(folder) == "xhigh", "the project turns ultracode off; the user's level stays"
    _write(folder / cc_settings.PROJECT_SETTINGS, {"effortLevel": "low"})
    assert cc_settings.analyst_effort(folder) == "ultracode"
    _write(user, {"effortLevel": "high"})
    assert cc_settings.analyst_effort(folder) == "low", "the project's level outranks the user's"
    cc_settings.set_main_effort(folder, "max")
    assert cc_settings.analyst_effort(folder) == "low", "the chip's key is thimble's"
    _write(user, {"env": {cc_settings.EFFORT_ENV: "medium"}})
    assert cc_settings.analyst_effort(folder) == "medium"
    monkeypatch.setenv(cc_settings.EFFORT_ENV, "HIGH")
    assert cc_settings.analyst_effort(folder) == "high"


def test_the_fast_mode_key_is_written_and_taken_back_like_the_effort_key(folder):
    local = folder / cc_settings.LOCAL_SETTINGS
    _write(local, {"permissions": {"allow": ["Bash(ls)"]}})
    cc_settings.set_main_fast(folder, False)
    cc_settings.set_main_effort(folder, "low")
    assert json.loads(local.read_text())["env"] == {cc_settings.FAST_OFF_ENV: "1", cc_settings.EFFORT_ENV: "low"}
    cc_settings.set_main_fast(folder, True)
    assert json.loads(local.read_text())["env"][cc_settings.FAST_OFF_ENV] == "0"
    assert cc_settings.clear_override(folder)
    assert json.loads(local.read_text()) == {"permissions": {"allow": ["Bash(ls)"]}}, "both keys go, the rest stays"
    cc_settings.set_main_fast(folder, False)
    _write(local, {"env": {cc_settings.FAST_OFF_ENV: "0"}})
    assert not cc_settings.clear_override(folder), "a value the analyst changed by hand is theirs"
    assert json.loads(local.read_text()) == {"env": {cc_settings.FAST_OFF_ENV: "0"}}


def test_the_user_file_s_top_level_effort_is_passed_as_the_flag_for_a_model_that_does_not_read_it(folder, tmp_path, monkeypatch):
    """`"effortLevel": "xhigh"` at the top of ~/.claude/settings.json, Opus 5.5 as the model and an effort for another
    model under modelSettings. Claude Code 2.1.282 reads that key only for older models (LEGACY_EFFORT_MODELS), so the
    launcher passes the level as main's --effort and the menus open on it; an entry for main's own model, where /effort
    saves a pick, or a top-level level in the project's files is Claude Code's and wins."""
    user = tmp_path / "claude" / "settings.json"
    user_settings = {"model": "opus[1m]", "effortLevel": "xhigh", "fastMode": True, "modelSettings": {"claude-fable-5-1": {"effortLevel": "high"}}}
    _write(user, user_settings)
    assert not cc_settings.names_effort(folder), "another model's entry and the unread key choose nothing for Opus 5.5"
    assert cc_settings.main_effort_flag(folder) == "xhigh" and cc_settings.analyst_effort(folder) == "xhigh"
    _write(user, {k: v for k, v in user_settings.items() if k != "model"})
    assert cc_settings.main_effort_flag(folder) == "xhigh", "no model named: Claude Code's default, a later model"
    _write(user, {**user_settings, "model": "claude-opus-4-8"})
    assert cc_settings.names_effort(folder) and cc_settings.main_effort_flag(folder) == "", "an older model reads it"
    assert cc_settings.analyst_effort(folder) == "xhigh"
    _write(user, {**user_settings, "modelSettings": {"claude-opus-5-5[1m]": {"effortLevel": "medium"}}})
    assert cc_settings.main_effort_flag(folder) == "" and cc_settings.analyst_effort(folder) == "medium", "/effort's pick"
    _write(user, user_settings)
    _write(folder / cc_settings.LOCAL_SETTINGS, {"effortLevel": "low"})
    assert cc_settings.main_effort_flag(folder) == "" and cc_settings.analyst_effort(folder) == "low"
    (folder / cc_settings.LOCAL_SETTINGS).unlink()
    monkeypatch.setenv(cc_settings.MODEL_ENV, "claude-sonnet-5")
    assert cc_settings.main_effort_flag(folder) == "", "the environment's model is the one that runs"
    assert cc_settings.model_key("opus[1m]") == "claude-opus-5-5" and cc_settings.model_key("claude-haiku-4-5-20251001") == "claude-haiku-4-5"
