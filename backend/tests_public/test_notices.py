"""notices.py: one short line in a chat that says what failed and how to fix it. Notices under one key are one row; a
fix that worked (clear) or the analyst's × (dismiss) hides the row."""
from __future__ import annotations

import pytest

from app import agents, notices

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    yield


def _notices(chat: str = agents.MAIN_ID) -> list[dict]:
    return [r for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r["type"] == notices.TYPE]


def _shown_notice(chat: str = agents.MAIN_ID, key: str = "k") -> dict | None:
    """The notice row the chat shows under `key`: its latest record, unless that one dismissed it."""
    last = next((r for r in reversed(_notices(chat)) if r.get("key") == key), None)
    return None if last is None or last.get("dismissed") else last


def test_a_notice_with_a_key_is_one_row_and_clear_or_dismiss_hides_it(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(notices, "_emit", lambda c, ev: sent.append(ev))
    a = notices.post(CORPUS, kind="proposals", text="First  try.", key="k", action={"label": "Try again",
                                                                                     "do": "proposals-retry"})
    b = notices.post(CORPUS, kind="proposals", text="Second try.", key="k")
    assert a["text"] == "First try." and a["action"] == {"label": "Try again", "do": "proposals-retry"}
    assert sent[0] == {"type": "notice", "chat": "main", "id": a["id"], "key": "k", "kind": "proposals",
                       "text": "First try.", "action": a["action"]}
    assert _shown_notice(key="k")["id"] == b["id"]
    assert notices.clear(CORPUS, "k") and _shown_notice(key="k") is None and not notices.clear(CORPUS, "k")
    c = notices.post(CORPUS, kind="view", text="The view Board failed to build: no reader.",
                     action={"label": "Retry", "do": "view-retry", "slug": "board"})
    assert c["action"]["slug"] == "board" and "key" not in c
    assert notices.dismiss(CORPUS, c["id"]) and not notices.dismiss(CORPUS, c["id"])
    assert sent[-1] == {"type": "notice", "chat": "main", "dismissed": True, "id": c["id"]}
    with pytest.raises(ValueError):
        notices.post(CORPUS, kind="x", text="y", action={"label": "Go", "do": "rm -rf"})


def test_a_notice_for_a_chat_that_is_gone_writes_nothing():
    assert notices.post(CORPUS, chat="nochat", kind="safeguards", text="Gone.") is None
