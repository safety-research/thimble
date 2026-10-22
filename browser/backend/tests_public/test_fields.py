"""app/fields.py: what a view's question is told about the records of its files."""
from __future__ import annotations

import json

from app import fields


def test_the_records_are_described_by_their_fields_and_how_they_relate(tmp_path):
    """Each field gets its values or its span, saves of whole pages say which field names the page and how a label reads
    them, and a field that holds other records' ids says so."""
    body = "\n".join(f"line {i}" for i in range(6))
    saves = [{"page": p, "rev": r, "user": u, "ts": f"2026-04-14T2{r}:00:00Z", "text": body + f"\nnote {r}"}
             for r, (p, u) in enumerate([("a", "ann"), ("b", "bo"), ("a", "bo"), ("a", "cy")], 1)]
    posts = [{"id": f"m{i}", "user": "ann", "text": "hi", "reply_to": f"m{i - 1}" if i > 1 else None} for i in range(1, 8)]
    (tmp_path / "saves.jsonl").write_text("".join(json.dumps(r) + "\n" for r in saves))
    (tmp_path / "chat.jsonl").write_text("".join(json.dumps(r) + "\n" for r in posts))
    text = fields.describe(tmp_path, ["saves.jsonl", "chat.jsonl"])
    assert "saves.jsonl: 4 records" in text and "chat.jsonl: 7 records" in text
    assert '`user`: "bo" (2), "ann" (1), "cy" (1)' in text
    assert "`ts`: times from 2026-04-14T21:00:00Z to 2026-04-14T24:00:00Z" in text
    assert "Each record saves a whole document again: `page` names the document (2 of them), `rev` numbers its saves" in text
    assert "`reply_to` names another record by its `id`." in text
