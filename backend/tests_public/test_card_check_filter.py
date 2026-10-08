"""The card filter's check states follow the mark a card shows (frontend lib/cardCheck.ts checkState): Failed is the red ✕
the card check puts on a real problem, so a card with that ✕ never reads as Verified, and a check that could not finish,
which shows nothing on the card, is Unverified."""
from __future__ import annotations

from app import filters


def _card(status: str, *, stages: dict | None = None, fixes: list | None = None, **over) -> dict:
    return {"id": "c1", "kind": "plot", "code": "plot()", "takeaway": "12 PRs.", "title": "Who merged most?",
            "check": {"id": "chk_1", "status": status, "stages": stages or {}}, "fixes": fixes or [], **over}


TYPED = {"render": {"status": "ok", "typed": ["12", "35", "44"]}}


def test_a_card_with_the_red_x_is_failed_and_one_whose_check_could_not_finish_is_unverified():
    rejected = {"id": "fix_1", "check": "chk_1", "state": "rejected", "fields": ["code"], "reason": "its code did not run clean"}
    older = {**rejected, "check": "chk_0"}
    code_fix = {"id": "fix_2", "check": "chk_1", "state": "applied", "fields": ["code"], "before": {"code": "x"},
                "after": {"code": "plot()"}}
    states = {
        "passed": filters.check_state(_card("ok")),
        "revised": filters.check_state(_card("fixed", fixes=[code_fix])),
        "running": filters.check_state(_card("pending")),
        "stopped": filters.check_state(_card("stopped")),
        "could not finish": filters.check_state(_card("error")),
        "typed in": filters.check_state(_card("ok", stages=TYPED)),
        "typed in, code since fixed": filters.check_state(_card("fixed", stages=TYPED, fixes=[code_fix])),
        "revision would not run": filters.check_state(_card("error", fixes=[rejected])),
        "an older check's revision": filters.check_state(_card("error", fixes=[older])),
        "never checked": filters.check_state({"id": "c2", "kind": "plot"}),
        "label card": filters.check_state(_card("ok", stages=TYPED, kind="label")),
    }
    assert states == {
        "passed": "verified", "revised": "verified", "running": "unverified", "stopped": "unverified",
        "could not finish": "unverified", "typed in": "failed", "typed in, code since fixed": "verified",
        "revision would not run": "failed", "an older check's revision": "unverified", "never checked": "unchecked",
        "label card": "unchecked",
    }
