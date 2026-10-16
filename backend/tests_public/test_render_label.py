"""The card harness's request for a label card (app.render.label_data, request_for): the label and the workspace
settings, which the card's face draws from, and none of the label's records, since the face shows none (Matt
2026-10-15: "examples in label card should always be collapsed by default, and we have to be very careful here"), so
none is read or quoted for it."""
from __future__ import annotations

import pytest

from app import concepts, ledger, render

CONCEPT = {"id": "k1", "name": "edit kind", "kind": "code", "unit": "record", "labels": ["links", "other"],
           "counts": {"links": 2, "other": 1}, "glob": "revisions.jsonl"}


@pytest.fixture
def label(monkeypatch):
    read: list[str] = []
    monkeypatch.setattr(concepts, "load_concept", lambda c, cid: ("ws", dict(CONCEPT)))
    monkeypatch.setattr(concepts, "coloured", lambda ws, k: k)
    monkeypatch.setattr(concepts, "with_stats", lambda ws, k: {**k, "n_labeled": 3})
    monkeypatch.setattr(ledger, "get_settings", lambda c: {"models": {}})

    def rows(*args, **kwargs):
        read.append(str(args[2] if len(args) > 2 else kwargs))
        return {"rows": [{"ref": "revisions.jsonl#L1", "label": "links", "text": "a record of the corpus"}]}

    monkeypatch.setattr(concepts, "concept_rows", rows)
    return read


def test_a_label_card_s_request_carries_its_label_and_settings_and_no_record(label):
    data = render.label_data("crew", {"id": "c1", "kind": "label", "payload": {"concept": "k1"}})
    assert data == {"concept": {**CONCEPT, "n_labeled": 3}, "settings": {"models": {}}}
    assert label == [], "no record of the label is read for its card"
    assert render.label_data("crew", {"id": "c2", "kind": "note", "payload": {"text": "x"}}) is None
