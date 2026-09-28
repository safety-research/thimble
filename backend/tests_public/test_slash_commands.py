"""start_orientation, as /thimble:orient calls it: the permission mode is the analyst's, and a model's call may lower it
but never raise it."""
from __future__ import annotations

import json

import pytest

from app import agents, cc_settings, channel, orient_session, orientation, session, tools

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    channel._subs.clear()
    session._live.clear()
    agents._busy.clear()
    yield
    channel._subs.clear()


def _analyst_mode(monkeypatch, tmp_path, mode: str) -> None:
    user = tmp_path / "cc" / "settings.json"
    user.parent.mkdir(parents=True, exist_ok=True)
    user.write_text(json.dumps({"permissions": {"defaultMode": mode}}))
    monkeypatch.setattr(cc_settings, "config_dir", lambda: user.parent)


async def test_a_start_orientation_call_may_lower_the_mode_but_never_raise_it(monkeypatch, tmp_path):
    """The mode is the analyst's (Start's switcher, the stored choice, their own mode); a model's call can only ask for
    less."""
    seen: dict = {}

    async def fake_start(c, brief, passes, call=None, chosen=None):
        seen.update(chosen=chosen)

    monkeypatch.setattr(orient_session, "start", fake_start)
    _analyst_mode(monkeypatch, tmp_path, "default")
    for asked in ("auto", "bypass", "run"):
        await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": asked})
        assert seen["chosen"] == {}, asked
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "manual"})
    assert seen["chosen"] == {"permissions": "manual"}
    _analyst_mode(monkeypatch, tmp_path, "auto")
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "bypass"})
    assert seen["chosen"] == {}
    orientation.request(CORPUS, "", ["views"], permissions="bypass")  # the analyst's Start, with Bypass on its switcher
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "auto"})
    assert seen["chosen"] == {"permissions": "auto"}, "below the Bypass Start chose"
