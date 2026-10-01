"""Labels in every view: a reader marks and keeps its records by the labels and the Files label filter, and a label that
ran over two files keeps the units its value is on in either.

The corpus is invented: board.jsonl has twelve posts in three threads, and the posts that ask for help say "help". A
regex label `asks` marks them ("asks" on a match, "other" from the covers over the rest)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, kernel_thimble, views

CORPUS = "helpdesk"
POSTS = [  # (thread, body); line n is POSTS[n-1]
    ("t1", "help: the build fails"), ("t1", "try a clean checkout"), ("t2", "release notes are out"),
    ("t1", "help again: still failing"), ("t3", "lunch at noon"), ("t2", "typo in the notes"),
    ("t3", "who is in"), ("t2", "help me find the notes"), ("t3", "me"), ("t1", "fixed it"),
    ("t2", "thanks"), ("t3", "see you"),
]

READER = '''
import json

import thimble


def build_index(paths):
    threads, lines = {}, {}
    for path in paths:
        with open(path) as f:
            for n, line in enumerate(f, 1):
                r = json.loads(line)
                threads.setdefault(r["thread"], []).append(f"{path}#L{n}")
                lines[f"{path}#L{n}"] = r["thread"]
    return {"threads": threads, "lines": lines}


def records(index, query):
    out = []
    for key, refs in sorted(index["threads"].items()):
        kept = [r for r in refs if thimble.kept(r)]
        if kept:
            out.append({"key": key, "posts": kept, "marked": [r for r in kept if thimble.marked(r)]})
    return {"threads": out, "labels": thimble.view_labels()}


def resolve(index, locator):
    if "key" in locator:
        refs = index["threads"].get(locator["key"])
        return None if not refs else {"excerpt": locator["key"], "label": locator["key"], "refs": refs,
                                      "key": locator["key"], "target": {}}
    ref = f"{locator['path']}#{locator['fragment']}"
    key = index["lines"].get(ref)
    return None if key is None else {"excerpt": key, "label": key, "refs": [ref], "key": key, "target": {}}
'''
HTML = "<!doctype html><html><body><div data-anchor='board.jsonl#L1'>x</div></body></html>"
VIEW = dict(name="Threads", description="The posts by thread.", claims=["board.jsonl"],
            accepts=[{"form": "L<n>", "means": "a post"}], units=[{"form": "<thread>", "means": "a thread"}], libs=[])


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    data = tmp_path / "data"
    root = data / CORPUS
    root.mkdir(parents=True)
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (root / "board.jsonl").write_text("".join(json.dumps({"thread": t, "body": b}) + "\n" for t, b in POSTS))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
                  concepts._building_answers):
        table.clear()
    views._memo.clear()
    views._ready.clear()
    return root


async def _inproc(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture()
async def app(corpus, monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc)
    views._bind_loop()
    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    a.include_router(views.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=120) as c:
        yield c
    sys.modules.pop("_thimble_views", None)


async def _asks(api) -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "asks", "kind": "regex", "spec": r"(?i)\bhelp\b",
                                                         "labels": ["asks", "other"]})
    assert r.status_code == 200, r.text
    k = r.json()
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 200, r.text
    return k


def _refs(lines) -> list[str]:
    return [f"board.jsonl#L{n}" for n in lines]


async def test_a_label_that_ran_over_two_files_keeps_the_units_its_value_is_on_in_either(app, corpus):
    """A label run over both of a view's files that takes its value only in one, as deletions in an events file beside
    the revisions of the same pages: the filter drops every record of the other file, since the label ran over it and
    gave them its other value, so the view keeps a unit by a kept record of either file (prompts/dev-view.md) and shows
    the units whose records of the one file the label marks, where keeping units by the other file's records alone
    would show none."""
    (corpus / "notes.jsonl").write_text("".join(json.dumps({"thread": t, "body": b}) + "\n"
                                                for t, b in (("t3", "deleted: the lunch post"), ("t1", "moved"))))
    r = await app.post(f"/api/ws/{CORPUS}/concepts", json={"name": "deleted", "kind": "regex", "spec": r"\bdeleted\b",
                                                         "labels": ["deleted", "no"]})
    k = r.json()
    r = await app.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply",
                       json={"wait": True, "paths": ["board.jsonl", "notes.jsonl"]})
    assert r.status_code == 200, r.text
    views.write_view(CORPUS, "threads", reader=READER, html=HTML, **{**VIEW, "claims": ["board.jsonl", "notes.jsonl"]})
    concepts.set_filter(CORPUS, "files", k["id"], "deleted")
    ctx = views.labels_context(CORPUS)
    assert not any(kernel_thimble._kept(ctx, f"board.jsonl#L{n}") for n in range(1, 13)), "the label ran over board.jsonl"
    assert kernel_thimble._kept(ctx, "notes.jsonl#L1") and not kernel_thimble._kept(ctx, "notes.jsonl#L2")
    got = await views.reader_call(CORPUS, "threads", "records", {})
    assert [(t["key"], t["posts"]) for t in got["threads"]] == [("t3", ["notes.jsonl#L1"])]
    marks = await views.marks_for(CORPUS, "threads", ["view:threads/t1", "view:threads/t3"])
    assert {r: m.get("keep") for r, m in marks.items()} == {"view:threads/t3": True}


async def test_a_reader_marks_and_keeps_records_by_the_labels_and_the_filter(app):
    k = await _asks(app)
    views.write_view(CORPUS, "threads", reader=READER, html=HTML, **VIEW)
    plain = await views.reader_call(CORPUS, "threads", "records", {})
    assert [t["key"] for t in plain["threads"]] == ["t1", "t2", "t3"] and all(not t["marked"] for t in plain["threads"])
    concepts.show_concept(CORPUS, k["id"], True)
    views._memo.clear()
    on = (await app.post(f"/api/ws/{CORPUS}/views/threads/records", json={"query": {}})).json()["data"]
    assert {t["key"]: t["marked"] for t in on["threads"]} == {"t1": _refs([1, 4]), "t2": _refs([8]), "t3": []}
    concepts.set_filter(CORPUS, "files", k["id"], "asks")
    got = (await app.post(f"/api/ws/{CORPUS}/views/threads/records", json={"query": {}})).json()["data"]
    assert {t["key"]: t["posts"] for t in got["threads"]} == {"t1": _refs([1, 4]), "t2": _refs([8])}
    assert got["labels"]["filter"]["value"] == "asks"
    # the checks' test label, whatever the workspace's labels
    probe = await views.reader_call(CORPUS, "threads", "records", {}, labels=views.probe_context(True))
    assert [p for t in probe["threads"] for p in t["posts"]] == _refs([7])


UNITS_READER = '''
import thimble

UNITS = {"t1": ["board.jsonl#L1", "board.jsonl#L4"], "t3": ["board.jsonl#L5"], "empty": []}


def build_index(paths):
    for path in paths:
        open(path).read()
    return UNITS


def records(index, query):
    return [key for key, refs in index.items() if thimble.kept_unit(refs)]


def resolve(index, locator):
    key = locator.get("key")
    if key not in index:
        return None
    return {"excerpt": key, "label": key, "refs": index[key], "key": key, "target": {}}
'''


async def test_the_filter_drops_a_unit_that_has_no_records(app):
    """A unit that gathers no records, such as an empty cell of a matrix, has no record the filter's value is on, so the
    filter drops it, in the reader's own lists and in the marks thimble gives the page."""
    k = await _asks(app)
    views.write_view(CORPUS, "units", reader=UNITS_READER, html=HTML,
                     **{**VIEW, "name": "Units", "units": [{"form": "<key>", "means": "a unit"}]})
    assert await views.reader_call(CORPUS, "units", "records", {}) == ["t1", "t3", "empty"], "with no filter, every unit"
    concepts.set_filter(CORPUS, "files", k["id"], "asks")
    assert await views.reader_call(CORPUS, "units", "records", {}) == ["t1"]
    marks = await views.marks_for(CORPUS, "units", ["view:units/t1", "view:units/t3", "view:units/empty"])
    assert {r: m.get("keep") for r, m in marks.items()} == {"view:units/t1": True}
    probe = await views.reader_call(CORPUS, "units", "records", {}, labels=views.probe_context(True))
    assert probe == [], "the test label's filter keeps no unit without a seventh line either"


async def test_the_view_head_counts_the_records_the_reader_left_out_for_the_filter_once_each(app):
    """A reader that keeps its records by thimble.kept leaves out what the filter drops, and the records route says how
    many distinct records that is across its calls under the filter, so the view's head can say what the filter hides.
    A record the analyst marks with the filter's value is counted out again, and with no filter there is no count."""
    k = await _asks(app)
    views.write_view(CORPUS, "threads", reader=READER, html=HTML, **VIEW)
    route = f"/api/ws/{CORPUS}/views/threads/records"
    assert "hidden" not in (await app.post(route, json={"query": {}})).json()
    concepts.set_filter(CORPUS, "files", k["id"], "asks")
    first = (await app.post(route, json={"query": {}})).json()
    assert first["hidden"] == 9, "the twelve posts but the three that ask for help"
    assert (await app.post(route, json={"query": {"again": True}})).json()["hidden"] == 9, "each record counted once"
    r = await app.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", json={"ref": "board.jsonl#L2", "label": "asks"})
    assert r.status_code == 200, r.text
    assert (await app.post(route, json={"query": {}})).json()["hidden"] == 8
    concepts.clear_filter(CORPUS, "files")
    assert "hidden" not in (await app.post(route, json={"query": {}})).json()


def test_a_count_of_what_the_filter_left_out_is_given_only_when_exact():
    key = ("asks-id", "asks", (1, 2))
    views._left_out.clear()
    assert views.note_left_out(CORPUS, "v", None, {"filter_key": key, "left_out": ["a#L1", "a#L2"], "left_out_n": 2}) == 2
    assert views.note_left_out(CORPUS, "v", None, {"filter_key": key, "left_out": ["a#L2", "a#L3"], "left_out_n": 2}) == 3
    assert views.note_left_out(CORPUS, "v", None, {"filter_key": key, "left_out_n": 5}) is None
    other = ("asks-id", "other", (1, 2))
    assert views.note_left_out(CORPUS, "v", None, {"filter_key": other, "left_out": ["a#L9"], "left_out_n": 1}) == 1


def test_the_count_is_of_what_the_frame_shows_now():
    """A fetch with a key replaces what its last call left out, as the page replaces what it showed (a run picked in
    place of another), while fetches without one add up, as pages of a list do. Another file shown starts the count
    afresh, a call from before that changes nothing, and each frame counts on its own."""
    key = ("asks-id", "asks", (1, 2))
    views._left_out.clear()

    def note(refs, **kw):
        return views.note_left_out(CORPUS, "v", None, {"filter_key": key, "left_out": refs, "left_out_n": len(refs)}, **kw)

    assert note(["run1#L1", "run1#L2"], frame="f", part="runs") == 2
    assert note(["run2#L1"], frame="f", part="runs") == 1, "the run picked in place of the first"
    assert note(["page#L1"], frame="f") == 2
    assert note(["page#L2"], frame="f") == 3, "a second page adds to the first"
    assert note(["other#L1"], frame="f", turn=1) == 1, "another file shown"
    assert note(["late#L1", "late#L2"], frame="f", turn=0) == 1, "a call from before the file changed"
    assert note(["run1#L1"], frame="g") == 1


async def test_every_record_the_analyst_marks_counts_as_marked_by_hand(app, corpus):
    """A view marks a record through the label's verdict route; the Labels pane says how many records were marked by
    hand, a record the label's run never reached among them."""
    (corpus / "notes.jsonl").write_text(json.dumps({"thread": "t1", "body": "help, from the notes"}) + "\n")
    k = await _asks(app)
    for ref, n_marked, n_reviewed in (("notes.jsonl#L1", 1, 0), ("board.jsonl#L2", 2, 1)):
        r = await app.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", json={"ref": ref, "label": "asks"})
        assert r.status_code == 200, r.text
        got = (await app.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()
        assert (got["n_marked"], got["n_reviewed"]) == (n_marked, n_reviewed), (ref, got)


async def test_the_views_list_says_which_pages_draw_label_controls_of_their_own(app):
    """A page whose source gives an element `data-label`, even one only a menu shows, and switches labels draws label
    controls of its own, so the Labels sidebar need not open beside it; the list says so from the source, before the
    page loads. A legend's `data-label` alone, with no switch, is not one."""
    menu = HTML.replace("</body>", "<script>const item = (id) => `<button data-label=\"${id}\" onclick=\"thimble.setLabel('${id}', true)\">on</button>`</script></body>")
    legend = HTML.replace("</body>", "<script>const item = (id) => `<span data-label=\"${id}\">a</span>`</script></body>")
    views.write_view(CORPUS, "threads", reader=READER, html=HTML, **VIEW)
    views.write_view(CORPUS, "menu", reader=READER, html=menu, **{**VIEW, "name": "Menu"})
    views.write_view(CORPUS, "legend", reader=READER, html=legend, **{**VIEW, "name": "Legend"})
    got = {v["slug"]: v["label_controls"] for v in (await app.get(f"/api/ws/{CORPUS}/views")).json()}
    assert got == {"threads": False, "menu": True, "legend": False}


def _old_members(rows: list[tuple]) -> dict[str, str]:
    """A label's {ref: value} as a dict, from rows (path, line, label, source, verdict, confidence, ref)."""
    values: dict[str, str] = {}
    starts: dict[str, str] = {}
    for path, line, label, _source, verdict, _confidence, ref in rows:
        v = verdict if verdict is not None else label
        if v is not None:
            values[str(ref)] = str(v)
            if path is not None and line is not None and kernel_thimble._ref_parts(str(ref))[1] is None:
                starts.setdefault(f"{path}#L{int(line)}", str(v))
    for ref, v in starts.items():
        values.setdefault(ref, v)
    return values


@pytest.mark.parametrize("fresh_store", [True, False])
def test_a_labels_members_are_kept_compact_and_read_as_every_row_says(tmp_path, fresh_store):
    """A label over every line of a large file keeps one code per line rather than a ref per record, and a sparse one
    keeps its lines alone, while every lookup, the listing and the count read as the rows say: the analyst's verdict
    over the classifier's, a record of another reader by its own ref and by the line it starts on, a ref written
    another way under its own spelling, and the covers apart."""
    from app import labels_store  # noqa: PLC0415

    big = 20_000
    rows = [{"ref": f"turns.jsonl#L{n}", "label": ("shell" if n % 3 else "gui"), "source": "code", "confidence": 1.0,
             "ts": "t"} for n in range(1, big + 1)]
    rows += [{"ref": "turns.jsonl#L7", "label": "gui", "source": "analyst", "ts": "t"},
             {"ref": "notes.jsonl#L5", "label": "shell", "source": "code"},
             {"ref": "notes.jsonl#L900000", "label": "other", "source": "code"},
             {"ref": "table.csv#row=4", "line": 12, "label": "gui", "source": "code"},
             {"ref": "table.csv#L12", "label": "shell", "source": "code"},
             {"ref": "table.csv#row=9", "line": 30, "label": "gui", "source": "code"},
             {"ref": "turns.jsonl#L012", "label": "odd", "source": "code"},
             {"ref": "card:abc", "label": "gui", "source": "analyst"},
             labels_store.cover_row("other.jsonl", 1, 50, "quiet", "regex", "t")]
    jsonl = tmp_path / "k.jsonl"
    jsonl.write_text("".join(json.dumps(r) + "\n" for r in rows))
    if fresh_store:
        labels_store.rebuild_file(str(jsonl))
        assert kernel_thimble._store_fresh(jsonl, jsonl.with_suffix(".sqlite"))
    kernel_thimble._MEMBERS.clear()
    values, spans, paths = kernel_thimble._members(jsonl)
    want = _old_members(kernel_thimble._jsonl_parts(jsonl)[0])
    assert dict(values.items()) == want and len(values) == len(want)
    assert values.get("turns.jsonl#L7") == "gui" and values["turns.jsonl#L3"] == "gui" and values["turns.jsonl#L4"] == "shell"
    assert values.get("turns.jsonl#L012") == "odd" and values.get("turns.jsonl#L12") == "gui"
    assert values.get("table.csv#L12") == "shell", "a line's own row over the record that starts on it"
    assert values.get("table.csv#L30") == "gui" and values.get("table.csv#row=9") == "gui"
    assert values.get("notes.jsonl#L900000") == "other" and "notes.jsonl#L6" not in values
    assert values.get("turns.jsonl#L0") is None and values.get(f"turns.jsonl#L{big + 1}") is None
    assert spans == {"other.jsonl": [(1, 50, "quiet")]} and {"turns.jsonl", "notes.jsonl", "other.jsonl"} <= paths
    assert isinstance(values._lines["turns.jsonl"], bytes), "a dense file: one byte per line"
    assert isinstance(values._lines["notes.jsonl"], tuple), "a sparse file: its lines alone"
    assert kernel_thimble._value_of({"_members": (values, spans, paths)}, "other.jsonl#L9") == "quiet"


def test_the_kernel_keeps_the_members_of_a_few_labels_at_once(tmp_path, monkeypatch):
    """The members of the labels read most recently stay, at most MEMBERS_KEPT of them, so a workspace with many labels
    does not keep them all in memory."""
    monkeypatch.setattr(kernel_thimble, "MEMBERS_KEPT", 2)
    kernel_thimble._MEMBERS.clear()
    files = []
    for i in range(3):
        p = tmp_path / f"{i}.jsonl"
        p.write_text(json.dumps({"ref": f"a.jsonl#L{i + 1}", "label": "x", "source": "code"}) + "\n")
        files.append(p)
    for p in (files[0], files[1], files[0], files[2]):
        kernel_thimble._members(p)
    assert list(kernel_thimble._MEMBERS) == [str(files[0]), str(files[2])]
    kernel_thimble._MEMBERS.clear()


def test_a_labels_file_of_many_cleared_blocks_reads_as_its_store_and_in_one_pass(tmp_path):
    """A code label's run writes each block of records as a clear, its rows and a cover. Read from the file while its
    store is behind, it gives the rows and covers the store gives, a rerun's clear dropping the rows it covers and the
    analyst's verdicts staying, and it reads in about the time one pass takes."""
    import time  # noqa: PLC0415

    from app import labels_store  # noqa: PLC0415

    lines: list[dict] = []
    for first in range(1, 40_001, 1000):
        last = first + 999
        lines.append(labels_store.clear_row("turns.jsonl", first, last))
        lines += [{"ref": f"turns.jsonl#L{n}", "label": "gui" if n % 2 else "shell", "source": "code"}
                  for n in range(first, last + 1) if n % 5]
        lines.append(labels_store.cover_row("turns.jsonl", first, last, "other", "code", "t"))
    lines.append({"ref": "turns.jsonl#L12", "label": "shell", "source": "analyst"})
    lines.append(labels_store.clear_row("turns.jsonl", 11, 20))
    lines += [{"ref": "turns.jsonl#L13", "label": "gui", "source": "code"}, {"ref": "card:x", "label": "gui", "source": "code"}]
    lines.append(labels_store.clear_row("turns.jsonl", 39_990))
    jsonl = tmp_path / "k.jsonl"
    jsonl.write_text("".join(json.dumps(r) + "\n" for r in lines))
    t0 = time.monotonic()
    rows, covers = kernel_thimble._jsonl_parts(jsonl)
    took = time.monotonic() - t0
    labels_store.rebuild_file(str(jsonl))
    want_rows, want_covers = kernel_thimble._store_parts(jsonl.with_suffix(".sqlite"))
    norm = lambda rs: sorted(json.dumps([p, n, lab, src, v, ref]) for p, n, lab, src, v, _c, ref in rs)  # noqa: E731
    assert norm(rows) == norm(want_rows)
    assert sorted(covers) == sorted(want_covers)
    assert ("turns.jsonl", 12, None, None, "shell", None, "turns.jsonl#L12") in rows, "the verdict stays"
    assert not any(r[6] in ("turns.jsonl#L11", "turns.jsonl#L39995") for r in rows), "the clears dropped them"
    assert took < 5, took


async def test_marking_a_views_records_leaves_the_server_free_while_a_label_is_read(app, monkeypatch):
    """A label's first use reads all its rows, seconds for millions of them, so the marks are worked out off the event
    loop, which goes on serving other requests."""
    import asyncio  # noqa: PLC0415
    import time  # noqa: PLC0415

    k = await _asks(app)
    r = await app.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"shown": True})
    assert r.status_code == 200, r.text
    views.write_view(CORPUS, "threads", reader=READER, html=HTML, **VIEW)
    read = kernel_thimble._members

    def slow(jsonl):
        time.sleep(1.0)
        return read(jsonl)

    monkeypatch.setattr(kernel_thimble, "_members", slow)
    work = asyncio.create_task(views.marks_for(CORPUS, "threads", _refs(range(1, 13))))
    t0 = time.monotonic()
    await asyncio.sleep(0.05)
    assert time.monotonic() - t0 < 0.5, "the loop ran while the label was read"
    marks = await work
    assert set(marks) == set(_refs((1, 4, 8)))


def test_a_context_of_many_labels_reads_each_label_once_and_parallel_reads_share_one(tmp_path, monkeypatch):
    """Every records call and every marks request looks up each label that is on. A workspace with a dozen labels on
    reads each one once, not once per call, and four marks requests that come at once read a label once between them."""
    import threading  # noqa: PLC0415
    import time  # noqa: PLC0415

    kernel_thimble._MEMBERS.clear()
    reads: list[str] = []
    parts = kernel_thimble._jsonl_parts

    def counted(jsonl):
        reads.append(str(jsonl))
        time.sleep(0.05)
        return parts(jsonl)

    monkeypatch.setattr(kernel_thimble, "_jsonl_parts", counted)
    files = []
    for i in range(12):
        p = tmp_path / f"{i}.jsonl"
        p.write_text(json.dumps({"ref": f"a.jsonl#L{i + 1}", "label": "x", "source": "code"}) + "\n")
        files.append(p)
    for _ in range(3):
        for p in files:
            assert kernel_thimble._members(p)[0].get(f"a.jsonl#L{files.index(p) + 1}") == "x"
    assert len(reads) == len(files), "each label read once"

    kernel_thimble._MEMBERS.clear()
    reads.clear()
    got: list = []
    threads = [threading.Thread(target=lambda: got.append(kernel_thimble._members(files[0])[0].get("a.jsonl#L1")))
               for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert got == ["x"] * 4 and reads == [str(files[0])]
    kernel_thimble._MEMBERS.clear()
