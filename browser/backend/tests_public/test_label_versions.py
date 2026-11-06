"""B19: a citation of a label's counts is checked against the label as it was when the cited words were written, from
the versions thimble keeps of it outside the workspace (label_versions), never as the label is now: no change of the
label's files, store or rows in the workspace, which a card's code can write, makes a false count verify. The fork is
replaced here; main's apply_label, the labels, the marks, the validator and the records are real, on the suite's
made-up mini corpus (board.jsonl: 8 posts, "forge pr claim" in 3 of them)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from test_marks import CORPUS, SID, _answer, _fresh, _main_at, _wait_all  # noqa: F401 — `_fresh` is a fixture

from app import cite, config, label_versions, marks

# model calls go through Claude Code, which the tests fake (conftest claude_code_sign_in)
pytestmark = pytest.mark.usefixtures("claude_code_sign_in")

NAME = "claims a PR"


async def _apply(text: str, limit: int | None) -> dict:
    """A regex label of the board's posts, applied as main applies it (apply_label, a trial with a limit), which makes
    the label's card, and its run waited for: {concept, cell, card}, the label's id, the id the check cites it by and
    the id of the label's card, which the result names."""
    from app import concepts, tools

    args = {"scope": "files", "name": NAME, "predicate": {"kind": "regex", "text": text}, "values": ["yes", "no"],
            "paths": ["board.jsonl"], **({"limit": limit} if limit else {})}
    r = await tools.call(CORPUS, "apply_label", args)
    assert not r.is_error, r.text
    ws = config.workspace_dir(CORPUS)
    kid = concepts.find_concept(ws, NAME)["id"]
    ((_, card),) = concepts._label_cards(ws, kid)
    assert f"The label's card is [[card:{card['id']}]]" in r.text, r.text
    await concepts.wait_apply(CORPUS, kid, 60)
    return {"concept": kid, "cell": marks.LABEL_PLACE + kid, "card": card["id"]}


def _newest(kid: str) -> dict:
    return label_versions.read(CORPUS, kid)[-1]


def _place(cid: str, value: str, version: int | None = None) -> str:
    return f"card:{cid}" + (f"@v{version}" if version else "") + f"#records/{cite.encode_label(value)}"


def _item(refs, mark: int = 1) -> dict:
    return {"mark": mark, "kind": "card", "evidence": {"ref": refs}, "status": "verified", "correction": None,
            "reason": "the card shows it"}


async def _check(texts: list[str], answer, listed: list[str]):
    """A reply's check: `answer` the checker's items; `listed` gets the cards' index the checker read. The reply's
    marks as stored."""
    async def fork(c, main, cut, prompt):
        index = next(w for w in prompt.split("`") if w.endswith("cards-index.tsv"))
        listed.append(Path(index).read_text(encoding="utf-8"))
        return {"answer": _answer(answer), "calls": [], "error": None}

    turn = marks.new_turn()
    main = {"sid": SID, "cwd": str(config.corpus_dir(CORPUS)), "transcript_path": None}
    await marks.start_check(CORPUS, main, turn, texts, "cut-1", fork=fork)
    await _wait_all()
    return marks.stored(CORPUS, turn)["items"]


def test_a_change_of_the_label_s_files_store_or_rows_changes_no_version(_fresh, monkeypatch):
    """What a card's code can write: the label's definition (its change log, its kept stats, its revision), its rows,
    its store, and files in the workspace named like versions. After the trial was kept, each is changed to show one
    more post as yes; a reply then cites that count, and the check, reading the label as it was when the reply was
    written, confirms only the trial's true count."""
    from app import concepts

    async def trial():
        return await _apply("forge pr claim", 4)
    s = asyncio.run(trial())
    kid, cid = s["concept"], s["cell"]
    true = _newest(kid)
    yes, n = true["counts"].get("yes", 0), true["n"]
    ws = config.workspace_dir(CORPUS)
    # the definition: every change and its kept stats claim one more yes
    k = json.loads((concepts.concepts_dir(ws) / f"{kid}.json").read_text())
    k["label_stats"]["counts"]["yes"] = yes + 1
    k["changes"] = [{**e, "shown": {"values": ["yes", "no"], "counts": {"yes": yes + 1}, "n": n, "unit": "record"}} for e in k["changes"]]
    k["rev"] = 99
    (concepts.concepts_dir(ws) / f"{kid}.json").write_text(json.dumps(k))
    # the rows: one more yes; the store goes, so the next read builds it from these rows
    lf = concepts.labels_file(ws, kid)
    rows = [json.loads(x) for x in lf.read_text().splitlines() if x.strip()]
    flip = next(r for r in rows if r.get("label") == "no")
    lf.write_text("".join(json.dumps({**r, "label": "yes"} if r is flip else r) + "\n" for r in rows))
    for p in lf.parent.glob(f"{kid}.sqlite*"):
        p.unlink()
    # files that look like kept versions, in the workspace
    for planted in (ws / label_versions.DIR / f"{kid}.jsonl", ws / "tmp" / label_versions.DIR / CORPUS / f"{kid}.jsonl"):
        planted.parent.mkdir(parents=True, exist_ok=True)
        planted.write_text(json.dumps({"v": 9, "at": 0, "made": "x", "values": ["yes", "no"], "counts": {"yes": yes + 1, "no": 0},
                                       "n": n, "unit": "record"}) + "\n")
    assert concepts.card_values(ws, concepts.read_concept(ws, kid))["counts"]["yes"] == yes + 1, "the label now shows the change"
    _main_at(monkeypatch, None)
    reply = [f"[{yes + 1} of the {n}](#) posts claimed a PR, a version holds [{yes + 1}](#), and the trial found [{yes} of the {n}](#)."]
    answer = [_item([_place(cid, "yes"), _place(cid, "all")]), _item(_place(cid, "yes", 9), mark=2),
              _item([_place(cid, "yes"), _place(cid, "all")], mark=3)]
    listed: list[str] = []
    fake, planted, real = asyncio.run(_check(reply, answer, listed))
    assert (fake["status"], fake["failedBy"]) == ("failed", "evidence"), fake
    assert (planted["status"], planted["reason"]) == ("failed", "The card has no version 9."), planted
    assert real["status"] == "verified", real
    assert f"{_place(cid, 'yes')}\t{yes}\n" in listed[0] and "@v9" not in listed[0], listed[0]
    assert label_versions.read(CORPUS, kid)[-1] == true, "no version keeps what only the label's files show"
