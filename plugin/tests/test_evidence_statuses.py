"""B19 changed the words of the validator's reasons and no status: each case of the validator's tests (test_evidence.py)
ends as it ended before B19, which evidence_statuses.json keeps for each test of that file then, so a citation that
failed still fails and one that verified still verifies; and no reason of a case names the folder the case made, where
its files lie on this machine."""
from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any

import pytest

import test_evidence

SNAPSHOT = Path(__file__).with_name("evidence_statuses.json")
STATUS = {"verified": "v", "corrected": "c", "failed": "f"}
BY = {"evidence": "e", "check": "c", "none": "n"}


def code(r: dict[str, Any]) -> str:
    """A result as the snapshot keeps it: its status, a failure's with who failed it (`fe`, `fc`, `fn`)."""
    status = str(r.get("status"))
    return STATUS.get(status, f"<{status}>") + (BY.get(str(r.get("failedBy")), "?") if status == "failed" else "")


def run_case(name: str, module: Any, ev: Any, folder: Path) -> tuple[list[str], list[str]]:
    """Test `name` of `module`, run once with the validator `ev` and its files in `folder`: the result of each
    check_mark it called and of each check_all (`a` before it), in order, and each reason that names `folder`. A test
    that stops on its own assertion ends its results with `!` and the error's kind."""
    got: list[str] = []
    leaks: list[str] = []
    real_mark, real_all = ev.check_mark, ev.check_all

    def note(r: dict[str, Any], head: str = "") -> None:
        got.append(head + code(r))
        if str(folder) in str(r.get("reason") or ""):
            leaks.append(str(r.get("reason")))

    def check_mark(*a: Any, **k: Any) -> dict[str, Any]:
        r = real_mark(*a, **k)
        note(r)
        return r

    def check_all(*a: Any, **k: Any) -> dict[str, Any]:
        out = real_all(*a, **k)
        for r in out["results"]:
            note(r, "a")
        return out

    fn = getattr(module, name)
    with pytest.MonkeyPatch.context() as mine:
        for where in (ev, module):
            mine.setattr(where, "check_mark", check_mark)
            mine.setattr(where, "check_all", check_all)
        with pytest.MonkeyPatch.context() as theirs:
            given = {"tmp_path": folder, "monkeypatch": theirs}
            try:
                fn(**{p: given[p] for p in inspect.signature(fn).parameters})
            except Exception as e:  # noqa: BLE001 — what it ran up to, and that it stopped
                got.append(f"!{type(e).__name__}")
    return got, leaks


def test_each_case_of_the_validator_s_tests_ends_as_before_b19_and_no_reason_names_its_folder(tmp_path_factory):
    import kernel.evidence as E

    want: dict[str, str] = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert len(want) >= 90 and all(hasattr(test_evidence, n) for n in want), "a test of test_evidence.py the snapshot keeps is gone"
    changed: dict[str, tuple[str, str]] = {}
    leaks: dict[str, list[str]] = {}
    for name, codes in want.items():
        got, leaked = run_case(name, test_evidence, E, tmp_path_factory.mktemp("case"))
        if " ".join(got) != codes:
            changed[name] = (codes, " ".join(got))
        if leaked:
            leaks[name] = leaked
    assert changed == {}, "a case ends otherwise than before B19 (before, now)"
    assert leaks == {}, "a reason names where the case's files lie"
