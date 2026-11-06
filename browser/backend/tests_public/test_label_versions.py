"""B19: a citation of a label's counts is checked against the label as it was when the cited words were written, from
the versions thimble keeps of it outside the workspace (label_versions), never as the label is now; and no change of the
label's files, store or rows in the workspace, which a card's code can write, nor a version named by the check, makes a
false count verify. The check lists each label of the workspace as the terminal lists its labels, `card:label-<label
id>` (marks.session_cards), and the label's card, which apply_label makes, reads the same versions under its own id.
The fork is replaced here; main's apply_label, the labels, the marks, the validator and the records are real, on
the suite's made-up mini corpus (board.jsonl: 8 posts, "forge pr claim" in 3 of them). The tests named after an attack
(P…, S…) are the attacks that broke the earlier designs (r108-labelcite rounds 1 and 2)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from test_marks import CORPUS, SID, _answer, _fresh, _log, _main_at, _seed_card, _wait_all  # noqa: F401 — _fresh is autouse

from app import cite, config, label_versions, marks

# model calls go through Claude Code, which the tests fake (conftest claude_code_sign_in)
pytestmark = pytest.mark.usefixtures("claude_code_sign_in")

NAME = "claims a PR"
TITLE = f"label {NAME}"  # the label's heading in the checker's file, as the terminal titles its labels


async def _apply(text: str, limit: int | None, name: str = NAME) -> dict:
    """A regex label of the board's posts, applied as main applies it (apply_label, a trial with a limit), which makes
    the label's card, and its run waited for: {concept, cell, card}, the label's id, the id the check cites it by and
    the id of the label's card, which the result names."""
    from app import concepts, tools

    args = {"scope": "files", "name": name, "predicate": {"kind": "regex", "text": text}, "values": ["yes", "no"],
            "paths": ["board.jsonl"], **({"limit": limit} if limit else {})}
    r = await tools.call(CORPUS, "apply_label", args)
    assert not r.is_error, r.text
    ws = config.workspace_dir(CORPUS)
    kid = concepts.find_concept(ws, name)["id"]
    ((_, card),) = concepts._label_cards(ws, kid)
    assert f"The label's card is [[card:{card['id']}]]" in r.text, r.text
    await concepts.wait_apply(CORPUS, kid, 60)
    return {"concept": kid, "cell": marks.LABEL_PLACE + kid, "card": card["id"]}


def _newest(kid: str) -> dict:
    return label_versions.read(CORPUS, kid)[-1]


def _place(cid: str, value: str, version: int | None = None) -> str:
    return f"card:{cid}" + (f"@v{version}" if version else "") + f"#records/{cite.encode_label(value)}"


def _item(refs, status: str = "verified", correction: dict | None = None, reason: str = "the card shows it", mark: int = 1) -> dict:
    return {"mark": mark, "kind": "card", "evidence": {"ref": refs}, "status": status, "correction": correction, "reason": reason}


async def _check(texts: list[str], answer, during=None, calls=(), seen: list[str] | None = None,
                 listed: list[str] | None = None, turn: str | None = None):
    """A reply's check: `answer` the checker's items (or a function of the prompt that gives them); `during` runs while
    the fork works, after the reply's words were written. The reply's marks as stored, and the turn."""
    async def fork(c, main, cut, prompt):
        if seen is not None:
            seen.append(prompt)
        if listed is not None:
            index = next(w for w in prompt.split("`") if w.endswith("cards-index.tsv"))
            listed.append(Path(index).read_text(encoding="utf-8"))
        if during is not None:
            got = during()
            if asyncio.iscoroutine(got):
                await got
        items = answer(prompt) if callable(answer) else answer
        return {"answer": _answer(items), "calls": list(calls), "error": None}

    turn = turn or marks.new_turn()
    main = {"sid": SID, "cwd": str(config.corpus_dir(CORPUS)), "transcript_path": None}
    await marks.start_check(CORPUS, main, turn, texts, "cut-1", fork=fork)
    await _wait_all()
    return marks.stored(CORPUS, turn)["items"], turn


def _trial_then_redefined():
    """The case of the report: a trial over 4 posts, then main redefines the label in its own turn, which drops the
    trial's rows, before it writes its reply. (label id, the id the check cites the label by, the trial's version)."""
    async def go():
        from app import concepts

        s = await _apply("forge pr claim", 4)
        trial = _newest(s["concept"])
        concepts.define_concept(CORPUS, NAME, "", "regex", "(?i)claim", "record", ["yes", "no"], "main", glob="board.jsonl")
        return s["concept"], s["cell"], trial
    return asyncio.run(go())


def test_a_trial_s_counts_hold_against_the_trial_after_main_redefined_the_label_and_the_full_run_replaced_it(_fresh, monkeypatch):
    """B19 as reported: main cited a trial's counts after it redefined the label in its own turn; the analyst then ran
    it on every post while the check ran. The check lists the label as it was when the reply was written (redefined, no
    counts) and the trial before it, never the full run; a citation of the trial's version verifies, with which version
    it is and what changed after it; and the label as it was then, which shows no trial count, does not."""
    kid, cid, trial = _trial_then_redefined()
    _main_at(monkeypatch, None)  # no repair: what the first check found stands
    yes, n = trial["counts"].get("yes", 0), trial["n"]
    listed: list[str] = []

    async def full_run():
        await _apply("(?i)claim", None)

    async def go():
        return await _check([f"In the trial, [{yes} of the {n}](#) posts claimed a PR, and the label now holds [{yes}](#)."],
                            [_item([_place(cid, "yes", trial["v"]), _place(cid, "all", trial["v"])]),
                             _item(_place(cid, "yes"), mark=2)], during=full_run, listed=listed)
    (m1, m2), _ = asyncio.run(go())
    assert m1["status"] == "verified", m1
    ev = m1["evidence"]
    # what changed after it by the time the check began: the full run came while the check ran
    assert (ev["version"], ev["made"], ev["after"]) == (trial["v"], "run over 4 records", "redefined"), ev
    # the label as it was when the reply was written had no trial count
    assert (m2["status"], m2["failedBy"]) == ("failed", "evidence"), m2
    index = listed[0]
    assert cid == f"label-{kid}"
    assert (f"# card:{cid} {TITLE} (as it was when the cited words were written; made by: redefined)\n"
            f"card:{cid}@out0\ta table of 3 rows: value, records, share\n{_place(cid, 'yes')}\t0\n") in index, index
    assert (f"# card:{cid}@v{trial['v']} {TITLE} (an earlier version; made by: run over 4 records; it changed "
            f"after: redefined)\ncard:{cid}@v{trial['v']}@out0\ta table of 3 rows: value, records, share\n"
            f"{_place(cid, 'yes', trial['v'])}\t{yes}\n") in index, index
    assert "run over 8" not in index


def test_a_version_made_after_the_words_confirms_nothing_and_a_repair_cannot_correct_them_to_it(_fresh, monkeypatch):
    """The full run's counts were made after the reply: cited by their version they are no evidence of it, and the
    repair thimble starts cannot turn the trial's sentence into the full run's numbers (round 3's open item)."""
    kid, cid, trial = _trial_then_redefined()
    _main_at(monkeypatch, "cut-1")
    yes, n = trial["counts"].get("yes", 0), trial["n"]
    seen: list[str] = []

    async def full_run():
        await _apply("(?i)claim", None)

    def answer(prompt):
        full = _newest(kid)
        refs = [_place(cid, "yes", full["v"]), _place(cid, "all", full["v"])]
        if "pressed x to repair citation 1." in prompt:
            # the repair reads the full run, which it can see now, and turns the trial's words into its numbers
            return [_item(refs, "corrected", {"words": f"{full['counts']['yes']} of the {full['n']}"})]
        return [_item(refs, "verified")]

    async def go():
        return await _check([f"In the trial, [{yes} of the {n}](#) posts claimed a PR."], answer, during=full_run, seen=seen)
    (m,), turn = asyncio.run(go())
    full = _newest(kid)
    first = [r["items"][0] for r in _log() if r["type"] == "marks" and r["turn"] == turn and r["items"][0]["status"] == "failed"][0]
    # the check's own cards were read before the full run: it has no such version
    assert (first["failedBy"], first["reason"]) == ("evidence", f"The card has no version {full['v']}."), first
    assert len(seen) == 2, "the failed mark was repaired at once"
    assert (m["status"], m["failedBy"], m["shown"]) == ("failed", "evidence", f"{yes} of the {n}"), m
    assert m["reason"] == f"The check offered other words, but the card's version {full['v']} was made after these words were written.", m


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
    for _ in range(2):  # the reply right after the change, and a later one: no version holds the change
        listed: list[str] = []
        (fake, planted, real), _ = asyncio.run(_check(reply, answer, listed=listed))
        assert (fake["status"], fake["failedBy"]) == ("failed", "evidence"), fake
        assert (planted["status"], planted["reason"]) == ("failed", "The card has no version 9."), planted
        assert real["status"] == "verified", real
        assert f"{_place(cid, 'yes')}\t{yes}\n" in listed[0] and "@v9" not in listed[0], listed[0]
        assert label_versions.read(CORPUS, kid)[-1] == true, "no version keeps what only the label's files show"
    # the newest version is read as no longer shown: it stands beside no card as it is now
    (newest,) = [x for x in marks.session_cards(CORPUS) if x["id"] == cid and x["version"] == true["v"]]
    assert newest["after"] == label_versions.CHANGED and newest["to"] >= true["at"], newest


def test_a_repair_reads_the_label_as_it_was_when_its_words_were_written_whatever_the_reply_s_record_says(_fresh, monkeypatch):
    """The time a reply's words were written is kept where no card's code writes (label_versions.times): moving the
    reply's own record of it later, so that a later version would count, leaves a repair reading the label as it was."""
    from app import concepts

    async def first():
        s = await _apply("forge pr claim", 4)
        return s, _newest(s["concept"])
    s, trial = asyncio.run(first())
    kid, cid = s["concept"], s["cell"]
    _main_at(monkeypatch, "cut-1")
    yes, n = trial["counts"].get("yes", 0), trial["n"]
    lie = yes + 1

    async def go():
        return await _check([f"[{lie} of the {n}](#) posts claimed a PR."],
                            [_item([_place(cid, "yes"), _place(cid, "all")], "verified")])
    (m,), turn = asyncio.run(go())
    assert m["status"] == "failed", m
    # later the label shows the lie (a change through the server, as the analyst's correction), and the reply's record
    # is moved to after it
    ws = config.workspace_dir(CORPUS)
    k = concepts.read_concept(ws, kid)
    no = next(r for r in concepts.read_labels(ws, kid) if r["label"] == "no")
    concepts.record_verdict(ws, k, no["ref"], "yes")
    assert _newest(kid)["counts"]["yes"] == lie
    p = config.workspace_dir(CORPUS) / "marks" / f"{turn}.json"
    rec = json.loads(p.read_text())
    rec["times"]["reply_end"] = _newest(kid)["at"] + 60
    p.write_text(json.dumps(rec))

    async def repair():
        async def fork(c, main, cut, prompt):
            return {"answer": _answer([_item([_place(cid, "yes"), _place(cid, "all")], "verified")]), "calls": [], "error": None}
        assert await marks.repair(CORPUS, turn, 1, fork=fork) == ""
        await _wait_all()
    asyncio.run(repair())
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert (m["status"], m["failedBy"]) == ("failed", "evidence"), m


def test_p1_a_trial_then_the_same_rule_on_every_post_cites_the_trial_by_its_version(_fresh, monkeypatch):
    async def go():
        s = await _apply("forge pr claim", 4)
        trial = _newest(s["concept"])
        s = await _apply("forge pr claim", None)
        return s, trial
    s, trial = asyncio.run(go())
    cid = s["cell"]
    _main_at(monkeypatch, None)
    yes, n = trial["counts"].get("yes", 0), trial["n"]
    (m,), _ = asyncio.run(_check([f"In the trial, [{yes} of the {n}](#) posts claimed a PR."],
                                 [_item([_place(cid, "yes", trial["v"]), _place(cid, "all", trial["v"])])]))
    assert m["status"] == "verified", m


@pytest.mark.parametrize("other_card", [False, True])
def test_p2_s8_a_trial_s_count_beside_a_later_total_confirms_nothing(_fresh, monkeypatch, other_card):
    """P2: the trial's yes beside the full run's total, true of no version; S8: beside another card's total."""
    total = _seed_card("", [{"text/html": "<table><tr><th>board</th><th>posts</th></tr><tr><th>all</th><td>8</td></tr></table>"}]) if other_card else ""

    async def go():
        s = await _apply("forge pr claim", 4)
        trial = _newest(s["concept"])
        s = await _apply("(?i)claim", None)
        return s, trial
    s, trial = asyncio.run(go())
    cid = s["cell"]
    _main_at(monkeypatch, None)
    yes = trial["counts"].get("yes", 0)
    refs = [_place(cid, "yes", trial["v"]), f"card:{total}#posts/all" if other_card else _place(cid, "all")]
    (m,), _ = asyncio.run(_check([f"[{yes} of the 8](#) posts claimed a PR."], [_item(refs)]))
    assert (m["status"], m["failedBy"]) == ("failed", "evidence"), m


def test_p3_s4_s5_a_deleted_label_is_no_place_and_its_undo_brings_its_versions_back(_fresh, monkeypatch):
    """P3: a label deleted after the reply is no evidence: its place is gone, and the failure says so plainly, never that
    the label only changed. S4: a label of the same name made again is another label, with a place of its own. S5: Undo
    of the delete brings the label back with the versions thimble kept, so the trial's citation verifies again."""
    from app import concepts, undo

    async def go():
        s = await _apply("forge pr claim", 4)
        return s, _newest(s["concept"])
    s, trial = asyncio.run(go())
    kid, cid = s["concept"], s["cell"]
    yes, n = trial["counts"].get("yes", 0), trial["n"]
    _main_at(monkeypatch, None)
    asyncio.run(concepts.delete_concept_route(CORPUS, kid))
    text = [f"In the trial, [{yes} of the {n}](#) posts claimed a PR."]
    refs = [_place(cid, "yes", trial["v"]), _place(cid, "all", trial["v"])]
    (m,), _ = asyncio.run(_check(text, [_item(refs)]))
    assert (m["status"], m["failedBy"], m["reason"]) == ("failed", "evidence", f"There is no card {cid} in this session."), m
    told = [t for _, t in _fresh if not t.startswith("notice")]
    assert any("is flagged as not confirmed" in t for t in told) and not any("changed since" in t for t in told), told
    again = asyncio.run(_apply("(?i)claim", 4))
    assert again["concept"] != kid and again["cell"] != cid
    for _ in range(3):  # the steps of the second label, if any, then the delete
        if concepts.read_concept(config.workspace_dir(CORPUS), kid) is not None:
            break
        undo.undo(CORPUS)
    assert concepts.read_concept(config.workspace_dir(CORPUS), kid) is not None, "Undo brought the label back"
    (m,), _ = asyncio.run(_check(text, [_item(refs)]))
    assert m["status"] == "verified", m


def test_p6_each_correction_is_a_version_a_citation_of_the_label_after_them_holds_against(_fresh, monkeypatch):
    from app import concepts

    s = asyncio.run(_apply("forge pr claim", 4))
    kid, cid = s["concept"], s["cell"]
    ws = config.workspace_dir(CORPUS)
    for r in [r for r in concepts.read_labels(ws, kid) if r["label"] == "no"][:2]:
        concepts.record_verdict(ws, concepts.read_concept(ws, kid), r["ref"], "yes")
    after = _newest(kid)
    asyncio.run(_apply("forge pr claim", None))
    _main_at(monkeypatch, None)
    kept = label_versions.read(CORPUS, kid)
    assert [v["made"] for v in kept][-4:-1] == ["run over 4 records", "1 value corrected", "1 value corrected"], kept
    assert label_versions.after_text(kept, kept.index(after) - 1).startswith("1 value corrected; run over"), kept
    yes, n = after["counts"]["yes"], after["n"]
    (m,), _ = asyncio.run(_check([f"After the two corrections, [{yes} of the {n}](#) posts claimed a PR."],
                                 [_item([_place(cid, "yes", after["v"]), _place(cid, "all", after["v"])])]))
    assert m["status"] == "verified", m


def test_p7_s1_s2_s3_what_the_checker_found_on_a_version_stands(_fresh, monkeypatch):
    """The checker found main's trial count wrong, citing the trial's version: the mark stays wrong with its reason, main
    hears so and a repair runs; a correction the checker gave as a sentence or a narrowing that changes the count is
    judged against the version's values like any card's; an unconfirmed claim keeps the checker's reason."""
    s = asyncio.run(_apply("forge pr claim", 4))
    kid, cid = s["concept"], s["cell"]
    trial = _newest(kid)
    yes, n = trial["counts"].get("yes", 0), trial["n"]
    refs = [_place(cid, "yes", trial["v"]), _place(cid, "all", trial["v"])]
    wrong = f"{yes + 1} of the {n}"
    sentence = f"In the trial, [{wrong}](#) posts claimed a PR."
    _main_at(monkeypatch, "cut-1")
    seen: list[str] = []

    def answer(prompt):
        if "pressed x to repair" in prompt:
            return [_item(refs, "corrected", {"words": f"{yes} of the {n}"})]
        return [_item(refs, "wrong", reason=f"The trial counted {yes}, not {yes + 1}.")]
    (m,), turn = asyncio.run(_check([sentence], answer, seen=seen))
    first = [r["items"][0] for r in _log() if r["type"] == "marks" and r["turn"] == turn and r["items"][0]["status"] == "failed"][0]
    assert (first["failedBy"], first["reason"]) == ("check", f"The trial counted {yes}, not {yes + 1}."), first
    assert any(f'"{wrong}" is flagged as wrong' in t for _, t in _fresh), _fresh
    assert len(seen) == 2 and (m["status"], m["shown"]) == ("corrected", f"{yes} of the {n}"), m
    _main_at(monkeypatch, None)
    for got, want in (
        (_item(refs, "verified", {"sentence": f"In the trial, [{yes} of the {n}] posts claimed a PR."}), ("corrected", None)),
        (_item(refs, "narrowed", {"words": f"{yes} of the {n}"}), ("failed", "evidence")),
        (_item(refs, "unconfirmed", reason=f"The trial counted {yes} of the {n}."), ("failed", "evidence")),
    ):
        (m,), _ = asyncio.run(_check([sentence], [got]))
        assert (m["status"], m.get("failedBy")) == want, (got, m)


def test_p8_a_version_of_a_card_that_keeps_none_names_no_place_and_the_checker_s_wrong_stands(_fresh, monkeypatch):
    from test_marks import TABLE

    cid = _seed_card("", [TABLE])
    _main_at(monkeypatch, None)
    (m,), _ = asyncio.run(_check(["agent-07 merged [15](#) pull requests."],
                                 [_item(f"card:{cid}@v1#merged/agent-07", "wrong", reason="The card shows 12 merged for agent-07, not 15.")]))
    assert (m["status"], m["failedBy"], m["reason"]) == ("failed", "check", "The card shows 12 merged for agent-07, not 15."), m
    (m,), _ = asyncio.run(_check(["agent-07 merged [12](#) pull requests."], [_item(f"card:{cid}@v1#merged/agent-07")]))
    assert (m["status"], m["reason"]) == ("failed", "The card has no version 1."), m


@pytest.mark.parametrize("own", [False, True])
def test_a_takeaway_citing_a_label_is_read_at_its_check_and_its_repair_at_that_same_time(_fresh, monkeypatch, own):
    """A card's takeaway is checked as its write lands, against the label as it was then; a repair of it later reads
    the label at that same time, whatever ran since. The takeaway is a card's that cites the label's places, or the
    takeaway of the label's own card, which cites that card's places."""
    from app import notebook
    from test_marks import TABLE

    s = asyncio.run(_apply("forge pr claim", 4))
    kid = s["concept"]
    trial = _newest(kid)
    yes, n = trial["counts"].get("yes", 0), trial["n"]
    card = s["card"] if own else _seed_card("", [TABLE])
    cited = card if own else s["cell"]
    notebook.edit_cell(CORPUS, card, takeaway=f"[{yes} of the {n}](#) posts in the trial claim a PR.")
    _main_at(monkeypatch, "cut-1")
    refs = [_place(cited, "yes"), _place(cited, "all")]

    async def first():
        main = {"sid": SID, "cwd": str(config.corpus_dir(CORPUS)), "transcript_path": None}

        async def fork(c, main, cut, prompt):
            return {"answer": _answer([_item(refs, "unconfirmed", reason="not sure")]), "calls": [], "error": None}
        await marks.start_check(CORPUS, main, marks.new_turn(), [], "cut-1", fork=fork, cards={card})
        await _wait_all()
    repair_now = marks.repair
    monkeypatch.setattr(marks, "repair", _no_repair)
    asyncio.run(first())
    monkeypatch.setattr(marks, "repair", repair_now)
    # the label changes after the takeaway: a correction makes another version
    from app import concepts

    ws = config.workspace_dir(CORPUS)
    no = next(r for r in concepts.read_labels(ws, kid) if r["label"] == "no")
    concepts.record_verdict(ws, concepts.read_concept(ws, kid), no["ref"], "yes")
    assert _newest(kid)["v"] == trial["v"] + 1

    async def repair():
        async def fork(c, main, cut, prompt):
            return {"answer": _answer([_item(refs, "verified")]), "calls": [], "error": None}
        assert await marks.repair(CORPUS, card=card, k=0, fork=fork) == ""
        await _wait_all()
    asyncio.run(repair())
    (m,) = notebook.get_cell(CORPUS, card)["takeaway_marks"]["items"]
    assert m["status"] == "verified" and (m["evidence"]["card"], m["evidence"]["version"]) == (cited, trial["v"]), m


def test_the_label_s_card_reads_its_label_s_versions_and_the_check_lists_the_label_once(_fresh, monkeypatch):
    """The label's card, which apply_label made: a citation of its places reads its label's versions, as the label was
    when the words were written or an earlier one by `@v<n>`, judged as the label's own places are, so a false count by
    the card fails, and so does the card's trial beside the label as it is now. The checker's file lists the label
    once, by its own id, and not the card: the card adds no second set of versions."""
    async def go():
        s = await _apply("forge pr claim", 4)
        trial = _newest(s["concept"])
        await _apply("(?i)claim", None)
        return s, trial
    s, trial = asyncio.run(go())
    kid, place, old = s["concept"], s["cell"], s["card"]
    full = _newest(kid)
    _main_at(monkeypatch, None)  # no repair: what the first check found stands
    yes, n = trial["counts"]["yes"], trial["n"]
    assert full["n"] != n and full["counts"]["yes"] != yes
    trial_refs = [_place(old, "yes", trial["v"]), _place(old, "all", trial["v"])]
    listed: list[str] = []
    reply = [f"In the trial, [{yes} of the {n}](#) posts claimed a PR.", f"By another count, [{yes + 1} of the {n}](#) did.",
             f"Of all the posts, [{yes} of the {full['n']}](#) did."]
    answer = [_item(trial_refs), _item(trial_refs, mark=2), _item([_place(old, "yes", trial["v"]), _place(place, "all")], mark=3)]
    (m1, m2, m3), _ = asyncio.run(_check(reply, answer, listed=listed))
    assert m1["status"] == "verified" and (m1["evidence"]["card"], m1["evidence"]["version"]) == (old, trial["v"]), m1
    assert (m2["status"], m2["failedBy"]) == ("failed", "evidence"), m2
    assert (m3["status"], m3["failedBy"], m3["reason"]) == (
        "failed", "evidence", "The cited cards never showed these values at one time."), m3
    index = listed[0]
    assert f"# card:{place} {TITLE} (as it was when the cited words were written; " in index and old not in index, index
    assert index.count(f"@v{trial['v']}@out0\t") == 1, index
    # the card's entries are its label's, under the card's own id, and the file leaves them out
    cards = marks.session_cards(CORPUS)
    mine = [{k: v for k, v in x.items() if k not in ("id", "title", "listed")} for x in cards if x["id"] == old]
    its = [{k: v for k, v in x.items() if k not in ("id", "title")} for x in cards if x["id"] == place]
    assert mine == its and len(its) == len(label_versions.read(CORPUS, kid))
    assert all(x.get("listed") is False for x in cards if x["id"] == old) and not any("listed" in x for x in cards if x["id"] == place)


async def _no_repair(*a, **k):
    return ""


def test_versions_lie_in_thimble_s_home_and_only_thimble_s_own_steps_keep_them(_fresh, monkeypatch):
    """Where no kernel or agent writes: thimble's home, which the kernels' sandbox hides, never the workspace. A label
    gets its first version from its first run, or, from before thimble kept versions, before main's turn; rows no step
    of thimble's wrote give none; a label that runs is left to its run's end. A purge of the workspace takes its
    labels' versions with it."""
    from app import cli, concepts, ledger, notebook, runtime

    ws = config.workspace_dir(CORPUS)
    where = label_versions.folder(CORPUS)
    assert cli.home() in where.parents and ws not in where.parents and where not in ws.parents
    assert Path(cli.home()).resolve() in [Path(p) for p in notebook._kernel_hides()]
    k = concepts.define_concept(CORPUS, "mentions a test", "", "regex", "test", "record", ["yes", "no"], "main")
    assert label_versions.read(CORPUS, k["id"]) == [], "a label gets its first version from its first run"
    runtime._keep_label_versions(CORPUS)  # as for a label from before thimble kept versions
    assert [v["made"] for v in label_versions.read(CORPUS, k["id"])] == [label_versions.FIRST]
    # rows no step of thimble's wrote: no version keeps them, before main's turn or at a check
    concepts.labels_file(ws, k["id"]).parent.mkdir(parents=True, exist_ok=True)
    concepts.labels_file(ws, k["id"]).write_text(json.dumps({"ref": "board.jsonl#L1", "label": "yes", "confidence": 1,
                                                             "source": "regex", "ts": "t"}) + "\n")
    runtime._keep_label_versions(CORPUS)
    asyncio.run(marks._cards_and_index(CORPUS, None))
    assert len(label_versions.read(CORPUS, k["id"])) == 1
    # a label that runs gets its first version from its run's end
    other = concepts.define_concept(CORPUS, "mentions a review", "", "regex", "review", "record", ["yes", "no"], "main")
    concepts._runs[(CORPUS, other["id"])] = {"status": "running"}
    try:
        runtime._keep_label_versions(CORPUS)
        assert label_versions.read(CORPUS, other["id"]) == []
    finally:
        concepts._runs.pop((CORPUS, other["id"]), None)
    asyncio.run(ledger.reset_workspace(CORPUS))
    assert not (where / f"{k['id']}.jsonl").exists()


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_card_s_code_can_neither_read_nor_write_the_versions(wrap, _fresh, monkeypatch):
    """In the wrapped kernel a card's code finds no versions where thimble keeps them: the folder it sees there is the
    sandbox's own, empty, so what it reads fails and what it writes there, or through a link it leaves in the workspace,
    stays inside the sandbox. The versions stay as thimble kept them."""
    from app import notebook
    from test_kernel_sandbox import _wrap_works

    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    s = await _apply("forge pr claim", 4)
    kept = label_versions.folder(CORPUS) / f"{s['concept']}.jsonl"
    before = kept.read_bytes()
    code = (
        "import os, pathlib\n"
        f"p = pathlib.Path({str(kept)!r})\n"
        "said = []\n"
        "for act in (lambda: p.read_text(), lambda: p.open('a').write('{}'), lambda: p.parent.mkdir(parents=True)):\n"
        "    try:\n"
        "        act(); said.append('done')\n"
        "    except OSError:\n"
        "        said.append('refused')\n"
        "link = pathlib.Path.cwd().parent / 'tmp' / 'versions-link'\n"
        "try:\n"
        "    os.symlink(p, link); link.open('a').write('{}'); said.append('done')\n"
        "except OSError:\n"
        "    said.append('refused')\n"
        "print(*said)\n")
    try:
        cell = await notebook.run_code(CORPUS, code, "main")
        said = "".join(b.get("text/plain", "") for b in cell["outputs"]).split()
        assert said[:2] == ["refused", "refused"] and len(said) == 4, cell["outputs"]
        assert kept.read_bytes() == before and label_versions.read(CORPUS, s["concept"])[-1]["made"] == "run over 4 records"
    finally:
        await notebook.shutdown_all()


def test_a_cell_written_with_a_label_s_id_or_a_label_card_s_adds_no_other_versions_under_it(_fresh, monkeypatch):
    """Cells written into the canvas's files (a card's code can write those files) with a label's id in the check, a
    table that claims other counts and a label card of another label, add nothing under the label: no card's id is a
    label's. One written with the id of the label's card, showing another label, leaves that card read once, by the
    first cell of its id, so the versions under it are one label's, never two labels' mixed into a history neither
    had."""
    from app import notebook
    from test_marks import TABLE

    async def two():
        a = await _apply("forge pr claim", 4)
        b = await _apply("(?i)review", None, name="asks for a review")
        return a, b
    a, b = asyncio.run(two())
    old = a["card"]
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "planted", role="exploration")
    table = {**notebook.new_cell("code", "run", "planted", nb["id"], code="print()"), "id": a["cell"], "status": "ok",
             "outputs": [TABLE]}
    other = {**notebook.new_cell("label", "main", "planted", nb["id"], payload={"concept": b["concept"]})}
    nb["cells"] += [table, {**other, "id": a["cell"]}, {**other, "id": old}]
    notebook.write_notebook(ws, nb)
    cards = marks.session_cards(CORPUS)
    one = [[json.dumps(marks._version_outputs(v)) for v in label_versions.read(CORPUS, k)] for k in (a["concept"], b["concept"])]
    label = [x for x in cards if x["id"] == a["cell"]]
    assert [json.dumps(x["outputs"]) for x in label] == one[0] and {x["title"] for x in label} == {TITLE}, label
    card = [x for x in cards if x["id"] == old]
    assert len({x["title"] for x in card}) == 1 and [json.dumps(x["outputs"]) for x in card] in one, card
    assert not any(TABLE["text/html"] in json.dumps(x) for x in cards if x["id"] in (a["cell"], old))


def test_labels_that_cannot_be_listed_leave_the_check_its_cards(_fresh, monkeypatch):
    """A label's definition that cannot be read (a file a card's code wrote in the workspace before B25) leaves the
    labels out of the check, never its cards, as one label card that could not be read left out only itself before."""
    from app import concepts
    from test_marks import TABLE

    asyncio.run(_apply("forge pr claim", 4))
    cid = _seed_card("", [TABLE])
    (concepts.concepts_dir(config.workspace_dir(CORPUS)) / "broken.json").write_text(json.dumps({"version": "x"}))
    assert [x["id"] for x in marks.session_cards(CORPUS)] == [cid]


def test_a_count_of_a_label_s_values_reads_the_version_the_words_could_read(_fresh, monkeypatch):
    """B19 with B20: each version a label kept is also a table a count of its rows names (concepts.card_rows, its row
    `all` the total left out of the count), listed as the label was when the reply was written. A count of the trial by
    its version verifies after main redefined the label; the label as it was then (redefined: no rows) does not, nor the
    full run made while the check ran, nor the total row counted as a value."""
    kid, cid, trial = _trial_then_redefined()
    _main_at(monkeypatch, None)  # no repair: what the first check found stands
    listed: list[str] = []
    started: list = []

    async def full_run():  # once, though the reply's marks may go to more than one fork
        if not started:
            started.append(asyncio.ensure_future(_apply("(?i)claim", None)))
        await started[0]

    def count(ref, mark: int) -> dict:
        return {"mark": mark, "kind": "card", "evidence": {"ref": ref, "count": {"records": 2}}, "status": "verified",
                "correction": None, "reason": "the label counts it"}

    def answer(prompt):
        v, full = trial["v"], _newest(kid)["v"]
        return [count(f"card:{cid}@v{v}@out0", 1), count(f"card:{cid}@out0", 2), count(f"card:{cid}@v{full}@out0", 3),
                count(f"card:{cid}@v{v}@out0", 4)]

    reply = ["In the trial, [2 of the 2](#) values came up in 2 records each, and then [2 of the 2](#) values did. "
             "After the full run, [2 of the 2](#) values came up in 2 records each, and in the trial [2 of the 3](#) "
             "rows did."]
    got, _ = asyncio.run(_check(reply, answer, during=full_run, listed=listed))
    by = {m["n"]: m for m in got}
    assert by[1]["status"] == "verified" and by[1]["evidence"]["version"] == trial["v"], by[1]
    assert by[1]["evidence"]["count"] == "2 of 2 rows with records 2 besides the row all that sums them up", by[1]
    assert [(by[n]["status"], by[n]["reason"]) for n in (2, 3, 4)] == [
        ("failed", "The card's table has 0 rows with records 2, not 2."),
        ("failed", f"The card's version {_newest(kid)['v']} was made after these words were written."),  # while the check ran
        ("failed", "The card's table has 2 rows besides the row all that sums them up, not 3.")], by
    assert f"card:{cid}@v{trial['v']}@out0\ta table of 3 rows: value, records, share\n" in listed[0], listed[0]
