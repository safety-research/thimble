"""A label over the records of whole files stores its matches and counts, not a row for every record (labels_store,
covers): a regex or code run writes a row for each record that took another value than the negative, and a clear line
and a cover line for each range of records it labeled. Every read adds the records the covers hold: the label card's
counts ("10 of 9,005 records matched"), a page of a file's rows, the rows of the negative value, the files' presence,
the ruler, a verdict on a record with no row, and a card's thimble.labels(negatives=True). A later run over the same
records clears the rows an earlier one left there, and a store rebuilt from the labels file answers the same.

The corpus is invented: logs/big.jsonl has 9,000 records (three scan chunks), every thousandth a merge conflict, and
logs/small.jsonl five records, one of them a conflict."""
from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, kernel_thimble, labels_store

CORPUS = "covers"
PATTERN = r"(?i)merge conflict"
BIG, SMALL = "logs/big.jsonl", "logs/small.jsonl"
N_BIG, N_SMALL = 9_000, 5
HITS_BIG = [n for n in range(1, N_BIG + 1) if n % 1000 == 0]  # 9 lines
HITS_SMALL = [3]


def _record(n: int, hit: bool) -> dict:
    return {"type": "event", "n": n, "text": f"step {n}: merge conflict in main.py" if hit else f"step {n}: tests pass"}


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    data = tmp_path / "data"
    root = data / CORPUS
    (root / "logs").mkdir(parents=True)
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (root / BIG).write_text("".join(json.dumps(_record(n, n in HITS_BIG)) + "\n" for n in range(1, N_BIG + 1)))
    (root / SMALL).write_text("".join(json.dumps(_record(n, n in HITS_SMALL)) + "\n" for n in range(1, N_SMALL + 1)))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
                  concepts._building_answers):
        table.clear()
    return root


@pytest.fixture()
async def api(corpus):
    app = FastAPI()
    app.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


def _ws() -> Path:
    return config.workspace_dir(CORPUS)


async def _regex_label(api, spec: str = PATTERN) -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "merge conflict", "kind": "regex", "spec": spec,
                                                         "labels": ["conflict", "no conflict"]})
    assert r.status_code == 200, r.text
    k = r.json()
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["logs/*.jsonl"]})
    assert r.status_code == 200, r.text
    return {**k, "summary": r.json()}


def _hits() -> dict[str, str]:
    return {**{f"{BIG}#L{n}": "conflict" for n in HITS_BIG}, **{f"{SMALL}#L{n}": "conflict" for n in HITS_SMALL}}


# ----------------------------------------------------------------------------- a regex label over whole files


async def test_a_regex_label_writes_its_matches_and_covers_and_the_card_counts_every_record(api):
    k = await _regex_label(api)
    s = k["summary"]
    total, matched = N_BIG + N_SMALL, len(HITS_BIG) + len(HITS_SMALL)
    assert s["labeled"] == total and s["counts"] == {"conflict": matched, "no conflict": total - matched}
    card = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()
    assert card["n_labeled"] == total and card["counts"] == s["counts"]  # the card's "10 of 9,005 records matched"
    # the labels file: a row per match, a clear and a cover line per chunk the scan read (three of big, one of small)
    rows = concepts.read_labels(_ws(), k["id"])
    assert {r["ref"]: r["label"] for r in rows} == _hits()
    lines = [json.loads(x) for x in concepts.labels_file(_ws(), k["id"]).read_text().splitlines()]
    covers = [x for x in lines if labels_store.COVER in x]
    assert len(covers) == 4 and len([x for x in lines if labels_store.CLEAR in x]) == 4
    assert sum(c["to"] - c["from"] + 1 for c in covers) == total and {c["value"] for c in covers} == {"no conflict"}
    assert concepts.labels_file(_ws(), k["id"]).stat().st_size < 10_000, "no row for the 8,995 records that did not match"


async def test_every_read_holds_the_records_the_covers_hold(api):
    k = await _regex_label(api)
    base = f"/api/ws/{CORPUS}/concepts/{k['id']}"
    # a page of a file's lines, as the reader asks for it
    page = (await api.get(f"{base}/labels", params={"path": BIG, "lines": "995-1005"})).json()["rows"]
    assert sorted(r["ref"] for r in page) == sorted(f"{BIG}#L{n}" for n in range(995, 1006))
    by = {r["ref"]: r for r in page}
    assert by[f"{BIG}#L1000"]["label"] == "conflict" and by[f"{BIG}#L1000"]["spans"] == ["merge conflict"]
    assert by[f"{BIG}#L999"]["label"] == "no conflict" and by[f"{BIG}#L999"]["source"] == "regex"
    assert len((await api.get(f"{base}/labels", params={"path": SMALL})).json()["rows"]) == N_SMALL
    # the rows of the negative value, paged by cursor to the end, and of the match
    seen: list[str] = []
    after = None
    while True:
        params = {"value": "no conflict", "limit": 2000, **({"after": after} if after is not None else {})}
        got = (await api.get(f"{base}/rows", params=params)).json()
        assert got["total"] == N_BIG + N_SMALL - 10
        seen += [r["ref"] for r in got["rows"]]
        after = got["next"]
        if after is None:
            break
    assert len(seen) == len(set(seen)) == N_BIG + N_SMALL - 10 and not set(seen) & set(_hits())
    got = (await api.get(f"{base}/rows", params={"value": "conflict"})).json()
    assert got["total"] == 10 and {r["ref"] for r in got["rows"]} == set(_hits())
    offset = (await api.get(f"{base}/rows", params={"value": "no conflict", "limit": 3, "offset": N_BIG - 12})).json()
    assert [r["ref"] for r in offset["rows"]] == seen[N_BIG - 12:N_BIG - 9]
    # the files' presence, the coverage and the ruler
    presence = {x["concept_id"]: x for x in (await api.get(f"/api/ws/{CORPUS}/labels/presence")).json()}
    assert presence[k["id"]]["paths"][BIG] == {"conflict": 9, "no conflict": N_BIG - 9}
    cov = (await api.get(f"{base}/coverage")).json()
    assert {f["path"]: f["rows"] for f in cov["files"] if f["covered"]} == {BIG: N_BIG, SMALL: N_SMALL}
    st = labels_store.Store(concepts.labels_file(_ws(), k["id"]))
    bins = st.line_bins(BIG, N_BIG, 90)  # 100 lines a bin
    assert bins["conflict"] == [9, 19, 29, 39, 49, 59, 69, 79, 89] and bins["no conflict"] == list(range(90))


async def test_a_verdict_on_a_record_without_a_row_and_a_later_run_that_clears_the_old_matches(api):
    k = await _regex_label(api)
    base = f"/api/ws/{CORPUS}/concepts/{k['id']}"
    r = await api.post(f"{base}/labels", json={"ref": f"{BIG}#L2", "label": "conflict"})
    assert r.status_code == 200, r.text
    st = labels_store.Store(concepts.labels_file(_ws(), k["id"]))
    stats = st.stats()
    assert stats["counts"] == {"conflict": 10, "no conflict": N_BIG + N_SMALL - 10}, "the classifier's counts"
    assert stats["n_reviewed"] == 1 and st.calibration_pairs() == [("no conflict", "conflict")]
    row = next(r for r in st.rows_for_path(BIG, (1, 3)) if r["ref"] == f"{BIG}#L2")
    assert row["label"] == "no conflict" and row["analyst"] == "conflict"
    assert (await api.get(f"{base}/rows", params={"value": "conflict"})).json()["total"] == 11
    # the Files pane changes the pattern (a new version, the rows kept) and the label runs again over the same files
    r = await api.put(base, json={"spec": r"step 3: merge conflict"})
    assert r.status_code == 200 and r.json()["version"] == 2
    r = await api.post(f"{base}/apply", json={"wait": True, "paths": ["logs/*.jsonl"]})
    assert r.json()["counts"] == {"conflict": 1, "no conflict": N_BIG + N_SMALL - 1}, "the old matches were cleared"
    assert {x["ref"] for x in concepts.read_labels(_ws(), k["id"]) if x["source"] == "regex" and x["label"] == "conflict"} >= {f"{SMALL}#L3"}
    assert next(r for r in st.rows_for_path(BIG, (2, 2)) if r["ref"] == f"{BIG}#L2")["analyst"] == "conflict", "the verdict stays"
    before = (st.stats(), st.rows_for_path(BIG, (990, 1010)), st.presence(), st.rows("no conflict", 50, 8990))
    # a store rebuilt from the labels file answers the same, and so does the pass over the file while it is built
    labels_store.remove(concepts.labels_file(_ws(), k["id"]))
    st.rebuild()
    assert (st.stats(), st.rows_for_path(BIG, (990, 1010)), st.presence(), st.rows("no conflict", 50, 8990)) == before
    scanned = labels_store.scan_jsonl(concepts.labels_file(_ws(), k["id"]), BIG, (990, 1010))
    assert {(r["ref"], r["label"], r["analyst"]) for r in scanned} == {(r["ref"], r["label"], r["analyst"]) for r in before[1]}


def test_a_cover_trims_the_covers_it_overlaps_and_a_clear_keeps_the_verdicts(tmp_path):
    jsonl = tmp_path / "k.jsonl"
    st = labels_store.Store(jsonl)
    ts = "2026-09-25T00:00:00+00:00"
    rows = [labels_store.clear_row("f.jsonl", 1, 100), labels_store.cover_row("f.jsonl", 1, 100, "no", "code", ts),
            {"ref": "f.jsonl#L5", "label": "yes", "confidence": 1.0, "source": "code", "ts": ts},
            {"ref": "f.jsonl#L7", "label": "yes", "confidence": 1.0, "source": "analyst", "ts": ts},
            labels_store.clear_row("f.jsonl", 40, None), labels_store.cover_row("f.jsonl", 40, 60, "no", "code", ts),
            labels_store.clear_row("f.jsonl", 1, 10)]
    jsonl.write_text("".join(json.dumps(r) + "\n" for r in rows))
    st.rebuild()
    # records 11..60 are covered (1..10 cleared, 61..100 cleared by the open-ended clear); L5's match is gone, L7's
    # verdict stays and reads the classifier's label from no cover, since 1..10 lost theirs
    assert st.stats()["counts"] == {"no": 50} and st.n_refs() == 51
    assert [r["ref"] for r in st.rows_for_path("f.jsonl", (5, 12))] == ["f.jsonl#L7", "f.jsonl#L11", "f.jsonl#L12"]
    assert labels_store.trim([(1, 10, "a"), (20, 30, "b")], 5, 25) == [(1, 4, "a"), (26, 30, "b")]


# ----------------------------------------------------------------------------- a code label over whole files


def test_a_code_label_writes_no_row_for_its_negative_and_counts_a_failed_record_nowhere(corpus, tmp_path, monkeypatch):
    monkeypatch.setattr(concepts, "CODE_COVER_LINES", 4)  # covers of four records, so a file has several
    spec = ("def label(unit):\n"
            "    if unit.get('n') == 7:\n"
            "        raise ValueError('a record the code cannot read')\n"
            "    return ('yes', 1.0, ['merge conflict']) if 'merge conflict' in unit['text'] else 'no'\n")
    concept = {"name": "conflict", "unit": "record", "spec": spec}
    groups = [{"ref": SMALL, "paths": [SMALL]}, {"ref": BIG, "paths": [BIG]}]
    rows_file = tmp_path / "rows.tmp"
    code = concepts.build_code_wrapper(concept, groups, None, rows_file, quiet=concepts.implicit_value(["yes", "no"]),
                                       ts="2026-09-25T00:00:00+00:00")
    cwd = os.getcwd()
    os.chdir(corpus)
    try:
        exec(compile(code, "wrapper", "exec"), {"__name__": "wrapper"})
    finally:
        os.chdir(cwd)
    out = tmp_path / "labels" / "k1.jsonl"
    out.parent.mkdir()
    labeled, errors, message, matches = concepts._collect_code_rows([], rows_file, out, "yes")
    total = N_BIG + N_SMALL
    assert errors == 1 and "a record the code cannot read" in message  # record 7 of big (small has five)
    assert labeled == total - 1 and matches == len(HITS_BIG) + len(HITS_SMALL)
    written = [json.loads(x) for x in out.read_text().splitlines()]
    assert {r["ref"] for r in written if r.get("ref")} == set(_hits()), "rows for the matches alone"
    st = labels_store.Store(out)
    assert st.stats()["counts"] == {"yes": 10, "no": total - 11}
    refs = {r["ref"] for r in st.rows_for_path(SMALL)}
    assert refs == {f"{SMALL}#L{n}" for n in range(1, 6)}, "every record of the small file, record 7 being in big"
    assert f"{BIG}#L7" not in {r["ref"] for r in st.rows_for_path(BIG, (1, 12))}, "a failed record is not labeled"


def test_the_implicit_value_of_a_code_label_is_its_negative():
    assert concepts.implicit_value(["match", "no match"]) == "no match"
    assert concepts.implicit_value(["tool", "text", "other"]) == "other"
    assert concepts.implicit_value(["no", "yes"]) == "yes", "the second of two, never the first value"
    assert concepts.implicit_value(["a", "b", "c"]) is None


# ----------------------------------------------------------------------------- a card's thimble.labels


async def test_a_card_s_label_frame_holds_every_record_with_negatives(api, monkeypatch):
    pytest.importorskip("pandas")
    k = await _regex_label(api)
    monkeypatch.setattr(kernel_thimble, "WS", str(_ws()))
    matches = kernel_thimble.labels("merge conflict")
    assert len(matches) == 10 and set(matches["effective"]) == {"conflict"}
    every = kernel_thimble.labels("merge conflict", negatives=True)
    assert len(every) == N_BIG + N_SMALL and (every["effective"] == "no conflict").sum() == N_BIG + N_SMALL - 10
    jsonl = concepts.labels_file(_ws(), k["id"])
    from_file = kernel_thimble._rows_from_jsonl(jsonl, True)
    from_store = kernel_thimble._rows_from_store(jsonl.with_suffix(".sqlite"), True)
    assert sorted(map(str, from_file)) == sorted(map(str, from_store)), "the labels file and the store agree"


# ----------------------------------------------------------------------------- the store's reads at their edges


def _seeded(tmp_path: Path, rows: list[dict]) -> labels_store.Store:
    jsonl = tmp_path / "k.jsonl"
    jsonl.write_text("".join(json.dumps(r) + "\n" for r in rows))
    st = labels_store.Store(jsonl)
    st.rebuild()
    return st


def test_the_rows_of_a_value_page_from_its_own_rows_into_the_covered_records(tmp_path):
    """A page that ends where the value's own rows end hands on to the covered records, and the cursor chain reads
    every row once."""
    ts = "2026-09-25T00:00:00+00:00"
    own = [{"ref": f"f.jsonl#L{n}", "label": v, "confidence": 1.0, "source": "regex", "ts": ts}
           for n, v in ((2, "no"), (5, "yes"), (8, "no"))]
    st = _seeded(tmp_path, [labels_store.clear_row("f.jsonl", 1, 10), labels_store.cover_row("f.jsonl", 1, 10, "no", "regex", ts), *own])
    rows, total, cursor = st.rows("no", 2)
    assert [r["ref"] for r in rows] == ["f.jsonl#L2", "f.jsonl#L8"] and total == 9 and cursor == -1
    seen = [r["ref"] for r in rows]
    while cursor is not None:
        rows, total, cursor = st.rows("no", 2, after=cursor)
        seen += [r["ref"] for r in rows]
    assert seen == [f"f.jsonl#L{n}" for n in (2, 8, 1, 3, 4, 6, 7, 9, 10)]
    assert [r["ref"] for r in st.rows(None, 3, offset=2)[0]] == ["f.jsonl#L8", "f.jsonl#L1", "f.jsonl#L3"]


def test_the_ruler_puts_a_covered_record_in_the_bin_its_line_falls_in(tmp_path):
    """The bins of the covered records match the bins the query gives the rows: line n of `total` is in bin
    (n - 1) * bins // total, here with a total the bins do not divide."""
    ts = "2026-09-25T00:00:00+00:00"
    total, bins = 10, 4  # bins of lines 1-3, 4-5, 6-8, 9-10
    for lines in ([4, 5], [3], [6], [9, 10], [1, 2, 3]):
        st = _seeded(tmp_path, [labels_store.cover_row("f.jsonl", n, n, "no", "regex", ts) for n in lines])
        assert st.line_bins("f.jsonl", total, bins) == {"no": sorted({(n - 1) * bins // total for n in lines})}, lines
    own = [{"ref": f"f.jsonl#L{n}", "label": "yes", "confidence": 1.0, "source": "regex", "ts": ts} for n in (4, 5)]
    st = _seeded(tmp_path, [labels_store.cover_row("f.jsonl", 1, 10, "no", "regex", ts), *own])
    assert st.line_bins("f.jsonl", total, bins) == {"no": [0, 2, 3], "yes": [1]}, "bin 1 holds no covered record without a row"
