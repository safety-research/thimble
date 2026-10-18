"""The Manual-mode notice in browser mode (session.note_mode): while main reports Claude Code's Manual mode, the notice
`manual-mode` (notices.py) says so in the words of modes.manual_notice, in red above the chat's composer; it goes when
main reports another mode or a new session attaches, and the analyst's x holds for the workspace. Terminal mode's
notice is local_hooks' mode-notice (test_local_hooks)."""
from __future__ import annotations

import json

import pytest

from app import config, events, modes, notices, session

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setattr(session, "_ensure_tail", lambda lv: None)
    session._live.clear()
    session._modes.clear()
    session._before_plan.clear()
    yield
    session._live.clear()
    session._modes.clear()


def _shown() -> list[str]:
    """The texts of the open `manual-mode` notices."""
    return [n["text"] for n in notices.open_notices(CORPUS) if n.get("key") == "manual-mode"]


async def _report(mode: str, sid: str = "sid-main") -> None:
    await events.mode_route(events.ModeBody(cwd=str(config.corpus_dir(CORPUS)), session=sid, permission_mode=mode))


async def test_a_manual_report_shows_the_notice_in_the_hint_s_words_and_an_auto_report_takes_it_away(tmp_path):
    session.attach(CORPUS, "sid-main", str(config.corpus_dir(CORPUS)))
    await _report("auto")
    assert _shown() == [], "auto mode shows none"
    await _report("default")
    assert _shown() == [modes.manual_notice("default")] == [modes.MANUAL_NOTICES["switch"]]
    n = next(n for n in notices.open_notices(CORPUS) if n["key"] == "manual-mode")
    assert n["kind"] == "manual-mode" and n["action"] is None
    assert "shift+tab" in n["text"] and "`thimble --permission-mode auto`" in n["text"]
    await _report("manual")
    assert len(_shown()) == 1, "still Manual mode: the one notice"
    await _report("default", sid="sid-other")
    await _report("auto")
    assert _shown() == [], "gone with auto mode"
    user = tmp_path / "claude-config" / "settings.json"
    user.parent.mkdir(parents=True, exist_ok=True)
    user.write_text(json.dumps({"disableAutoMode": "disable"}))
    await _report("default")
    assert _shown() == [modes.MANUAL_NOTICES["settings"]], "auto mode turned off: who did, and no fix"
    assert modes.manual_notice("auto") == modes.manual_notice(None) == ""
