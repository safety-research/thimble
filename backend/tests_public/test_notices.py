"""notices.py: a failure of one of thimble's agents told in the foreground with its fix. An open notice is one per key,
kept in the workspace's notices file (GET /notices) and written as a row in its agent's chat; clear (a later success)
and dismiss (the analyst's x) take it away, each with its `notice` event."""
from __future__ import annotations


import pytest

from app import notices

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    yield


@pytest.fixture()
def sent(monkeypatch) -> list[dict]:
    """The `notice` events, as the workspace stream would get them."""
    got: list[dict] = []
    monkeypatch.setattr(notices.investigation, "emit", lambda c, inv, ev: got.append(ev))
    return got


async def test_a_notice_with_a_key_is_one_open_notice_that_clear_takes_away(sent):
    retry = {"label": "Try again", "do": "proposals-retry"}
    a = notices.post(CORPUS, kind="proposals", text="First  try.", agent="View proposals", key="k", action=retry)
    b = notices.post(CORPUS, kind="proposals", text="Second try.", agent="View proposals", key="k")
    assert a["text"] == "First try." and a["action"] == retry and a["chat"] is None
    assert sent[0] == {"type": "notice", "id": a["id"], "key": "k", "kind": "proposals", "text": "First try.",
                       "agent": "View proposals", "chat": None, "action": retry, "foreground": True}
    assert [n["id"] for n in notices.open_notices(CORPUS)] == [b["id"]], "the later one replaced it in place"
    assert notices.clear(CORPUS, "k") and notices.open_notices(CORPUS) == []
    assert sent[-1] == {"type": "notice", "id": b["id"], "key": "k", "cleared": True}
    assert not notices.clear(CORPUS, "k")


@pytest.mark.parametrize("line,words,fix", [
    ("API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup).",
     "Claude's safeguards stopped its request; rephrase or narrow the request and try again", None),
    ("API Error: 404 model: claude-x not found", "its model isn't available to your account; pick another model in "
     "Settings", notices.SETTINGS),
])
def test_a_failure_s_words_name_the_fix(line, words, fix):
    assert notices.reason(line) == (words, fix)
