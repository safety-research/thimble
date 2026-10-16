"""Checks' comments on Claude's answers (0.9.0 build spec 3.12, contract C9): the passages of an answer, the comments a
check's session adds on them (`answer:<turn>#s<n>` refs), and their resolution.

    <ws>/answer-comments.json      {comments: [{id, turn, row, ref, start, end, quote, check, run, author, text, details,
                                   evidence, fp, ts, status, resolution}]}

SCAFFOLD STUB (features lane): no comment is stored yet; listing answers none and resolving answers nothing.
"""
from __future__ import annotations

from typing import Any


def comments(c: str, sid: str | None = None, status: str = "open") -> list[dict[str, Any]]:
    """The comments on answers, open ones by default (C9's rows). The stub has none."""
    return []


def running(c: str) -> list[dict[str, Any]]:
    """The checks reading an answer now ({check, check_name, turn}). The stub has none."""
    return []


def resolve(c: str, comment_id: str, reopen: bool = False) -> None:
    """A comment dismissed, or opened again. The stub stores none."""
    return None
