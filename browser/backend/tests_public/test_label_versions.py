"""B19: a citation of a label's counts is checked against the label as it was when the cited words were written, from
the versions thimble keeps of it outside the workspace (label_versions), never as the label is now; and no change of the
label's files, store or rows in the workspace, which a card's code can write, nor a version named by the check, makes a
false count verify. The fork is replaced here; the labels, the marks, the validator and the records are real, on the
suite's made-up mini corpus (board.jsonl: 8 posts, "forge pr claim" in 3 of them). The tests named after an attack
(P…, S…) are the attacks that broke the earlier designs (r108-labelcite rounds 1 and 2)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from test_marks import CORPUS, SID, _answer, _fresh, _log, _main_at, _seed_card, _wait_all  # noqa: F401 — _fresh is autouse

from app import cite, config, label_versions, marks

KW = dict(scope="files", values=["yes", "no"], paths=["board.jsonl"], comment=False, filter=False, created_by="main",
          chat=None, group=None, question="Which posts claim a PR?")
NAME = "claims a PR"


async def _apply(text: str, limit: int | None, name: str = NAME) -> dict:
    """A regex label of the board's posts, run as the server runs it (a trial with a limit), and its run waited for."""
    from app import concepts

    s = await concepts.apply_scoped(CORPUS, name=name, kind="regex", text=text, limit=limit, **KW)
    await concepts.wait_apply(CORPUS, s["concept"], 60)
    return s


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
    trial's rows, before it writes its reply. (label id, card id, the trial's version)."""
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
    assert (f"# card:{cid} Which posts claim a PR? (as it was when the cited words were written; made by: redefined)\n"
            f"{_place(cid, 'yes')}\t0\n") in index, index
    assert (f"# card:{cid}@v{trial['v']} Which posts claim a PR? (an earlier version; made by: run over 4 records; it changed "
            f"after: redefined)\n{_place(cid, 'yes', trial['v'])}\t{yes}\n") in index, index
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


def test_p3_s4_s5_a_deleted_label_s_card_is_no_card_and_its_undo_brings_its_versions_back(_fresh, monkeypatch):
    """P3: a label deleted after the reply is no evidence: its card is gone, and the failure says so plainly, never that
    the label only changed. S4: a label of the same name made again is another label, with a card of its own. S5: Undo
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
    undo.undo(CORPUS)  # the trial of the second label
    undo.undo(CORPUS)
    if concepts.read_concept(config.workspace_dir(CORPUS), kid) is None:
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


def test_a_takeaway_on_a_label_card_is_read_at_its_check_and_its_repair_at_that_same_time(_fresh, monkeypatch):
    """A card's takeaway is checked as its write lands, against the label as it was then; a repair of it later reads
    the label at that same time, whatever ran since."""
    from app import notebook

    s = asyncio.run(_apply("forge pr claim", 4))
    kid, cid = s["concept"], s["cell"]
    trial = _newest(kid)
    yes, n = trial["counts"].get("yes", 0), trial["n"]
    notebook.edit_cell(CORPUS, cid, takeaway=f"[{yes} of the {n}](#) posts in the trial claim a PR.")
    _main_at(monkeypatch, "cut-1")
    refs = [_place(cid, "yes"), _place(cid, "all")]

    async def first():
        main = {"sid": SID, "cwd": str(config.corpus_dir(CORPUS)), "transcript_path": None}

        async def fork(c, main, cut, prompt):
            return {"answer": _answer([_item(refs, "unconfirmed", reason="not sure")]), "calls": [], "error": None}
        await marks.start_check(CORPUS, main, marks.new_turn(), [], "cut-1", fork=fork, cards={cid})
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
        assert await marks.repair(CORPUS, card=cid, k=0, fork=fork) == ""
        await _wait_all()
    asyncio.run(repair())
    (m,) = notebook.get_cell(CORPUS, cid)["takeaway_marks"]["items"]
    assert m["status"] == "verified" and m["evidence"]["version"] == trial["v"], m


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
