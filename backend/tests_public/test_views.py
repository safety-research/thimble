"""app.views: viewers written for how a corpus arranges its records. The reader resolves lines and keys, the frame
document blocks every load, and the worked examples a view ticket reads pass the view checks over their own samples, one
of them with its page loaded headless, and one on a machine without the headless browser.

A temp DATA_DIR holds the corpus `boards`: `board.jsonl`, one post per line, each {thread, author, time, body}, and
`notes.md`. The `ws` fixture saves the view `threads`, whose reader (THREADS_READER) groups the posts by thread: it
accepts `board.jsonl#L<n>` (the post) and gives the unit `view:threads/<thread>` (a whole thread). Most tests run the
reader in this process (the `inproc` fixture replaces views._runner with an exec of the same snippet the kernel gets)."""
from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import io
import json
import logging
import os
import re
import shutil
import sys
from pathlib import Path

import pytest

from app import config, headless, tools, userconf, views

CORPUS = "boards"
POSTS = [  # (thread, author, time, body); line n of board.jsonl is POSTS[n-1]
    ("t1", "ada", "2026-06-01T10:00:00Z", "The release branch is cut at 14:00.\n-- ada"),
    ("t2", "bo", "2026-06-01T10:05:00Z", "Anyone have the build number?"),
    ("t1", "cy", "2026-06-01T10:07:00Z", "Confirmed: 4127 tests pass.\n-- cy"),
    ("t2", "ada", "2026-06-01T10:09:00Z", "The build is 3316."),
    ("t1", "bo", "2026-06-01T10:11:00Z", "Thanks, tagging the release now."),
]

THREADS_READER = '''
import json


def build_index(paths):
    threads, lines, bad = {}, {}, []
    for path in paths:
        with open(path) as f:
            for n, line in enumerate(f, 1):
                try:
                    r = json.loads(line)
                except ValueError:
                    bad.append({"ref": f"{path}#L{n}", "why": "not JSON"})
                    continue
                threads.setdefault(r["thread"], []).append([path, n, r["author"], r["body"]])
                lines[f"{path}#L{n}"] = r["thread"]
    return {"threads": threads, "lines": lines, "bad": bad}


def problems(index):
    return index["bad"]


def records(index, query):
    query = query or {}
    if query.get("thread"):
        return [{"ref": f"{p}#L{n}", "author": a, "body": b} for p, n, a, b in index["threads"].get(query["thread"], [])]
    return sorted(index["threads"])


def resolve(index, locator):
    if "key" in locator:
        posts = index["threads"].get(locator["key"])
        if not posts:
            return None
        return {"excerpt": "\\n".join(b for _, _, _, b in posts), "label": f"thread {locator['key']}, which has a name longer than a chip",
                "refs": [f"{p}#L{n}" for p, n, _, _ in posts], "key": locator["key"], "target": {"thread": locator["key"]}}
    ref = f"{locator['path']}#{locator['fragment']}"
    thread = index["lines"].get(ref)
    if thread is None:
        return None
    for p, n, a, b in index["threads"][thread]:
        if f"{p}#L{n}" == ref:
            return {"excerpt": b, "label": a, "refs": [ref], "key": thread, "target": {"thread": thread, "line": n}}
'''

THREADS_HTML = """<!doctype html><html><head><style>body{font:13px sans-serif}</style></head><body><div id="out"></div>
<script>
thimble.onOpen(async (place) => {
  const t = (place && place.target && place.target.thread) || 't1'
  const posts = await thimble.fetch({ thread: t })
  document.getElementById('out').textContent = posts.map((p) => p.author + ': ' + p.body).join('\\n')
})
</script></body></html>"""

VIEW = dict(name="Threads", description="The board's posts grouped by thread.", claims=["board.jsonl"],
            accepts=[{"form": "L<n>", "means": "one post"}], units=[{"form": "<thread>", "means": "one whole thread"}],
            libs=[])


@pytest.fixture()
def data(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"thread": t, "author": a, "time": ts, "body": b}) + "\n" for t, a, ts, b in POSTS))
    (corpus / "notes.md").write_text("# notes\n\nnothing here\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    """The kernel's part run in this process, in the corpus folder, its stdout captured as the kernel's would be."""
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the same snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    views._folder_cache.clear()
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    views._memo.clear()
    views._ready.clear()
    sys.modules.pop("_thimble_views", None)
    yield
    views._memo.clear()
    views._ready.clear()
    sys.modules.pop("_thimble_views", None)


@pytest.fixture()
def inproc(monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)


@pytest.fixture()
async def ws(data, workspaces_tmp) -> Path:
    """The workspace with the view `threads` saved, on the test's loop (the stream's events are the loop's)."""
    views.write_view(CORPUS, "threads", reader=THREADS_READER, html=THREADS_HTML, **VIEW)
    return config.workspace_dir(CORPUS)


@pytest.fixture()
async def bound():
    """The test's loop is the one reader calls run on, as the server's is (views._lifespan)."""
    views._bind_loop()
    yield


# ----------------------------------------------------------------------------------------------------------- disk


async def test_a_reader_resolves_a_line_and_a_key_and_its_answer_is_kept(ws, inproc):
    post = await views.resolve_locator(CORPUS, "threads", {"path": "board.jsonl", "fragment": "L3"})
    assert post == {"excerpt": "Confirmed: 4127 tests pass.\n-- cy", "label": "cy", "refs": ["board.jsonl#L3"], "key": "t1",
                    "target": {"thread": "t1", "line": 3}}
    thread = await views.resolve_locator(CORPUS, "threads", {"key": "t1"})
    assert thread["refs"] == ["board.jsonl#L1", "board.jsonl#L3", "board.jsonl#L5"]
    assert len(thread["label"]) <= views.LABEL_MAX and thread["label"].endswith("…"), "a long label is cut"
    assert await views.resolve_locator(CORPUS, "threads", {"path": "board.jsonl", "fragment": "L99"}) is None
    kept = views.key_refs(CORPUS)["view:threads/t1"]
    assert kept["refs"] == thread["refs"] and kept["name"] == "Threads"
    assert await views.reader_call(CORPUS, "threads", "records", {"thread": "t2"}) == [
        {"ref": "board.jsonl#L2", "author": "bo", "body": "Anyone have the build number?"},
        {"ref": "board.jsonl#L4", "author": "ada", "body": "The build is 3316."}]
    # the index is cached by the files' fingerprint, outside the views folder, which a kernel may only read
    assert list(views.index_dir(CORPUS, "threads").glob("*.index.pickle"))


def test_the_context_says_what_each_view_is_for(ws):
    from app import context  # noqa: PLC0415

    assert "- view:threads · Threads · claims board.jsonl\n  The board's posts grouped by thread." in context.views(CORPUS)


SOME_READER = '''
import json


def build_index(paths):
    with open("big.jsonl") as f:
        first = json.loads(f.readline())
    board = []
    if READ_BOARD:
        with open("board.jsonl", "rb") as f:
            board = f.read().splitlines()
    return {"first": first, "board": len(board)}


def records(index, query):
    return [index["first"]]


def resolve(index, locator):
    return None


def hidden(index):
    return [{"path": "notes.md", "why": WHY}] + ([{"path": "big.jsonl", "why": "only its first line is shown"}] if READ_BOARD else [])


def derived(index):
    return [{"field": "day", "from": "time", "how": "the date of the time"}, {"field": "time", "from": "-", "how": "-"}]
'''


async def test_the_harness_counts_what_build_index_reads_and_the_checks_fail_on_a_file_neither_read_nor_hidden(
        ws, inproc, bound, monkeypatch):
    """A file build_index read only the start of, or not at all, is not shown, and so is one hidden() lists; the checks
    fail until each is read to the end or hidden with a why. The counts outlive the kernel with the index. The view's
    derived fields are view.json's, then those derived() adds, and its page gets them."""
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0, "records": 1} for _ in states]

    monkeypatch.setattr(views, "shoot_states", no_page)
    (config.corpus_dir(CORPUS) / "big.jsonl").write_text("".join(json.dumps({"n": i, "pad": "x" * 60}) + "\n" for i in range(2000)))
    size = (config.corpus_dir(CORPUS) / "big.jsonl").stat().st_size

    def save(read_board: bool, why: str) -> None:
        views.write_view(CORPUS, "some", name="Some", description="The first record.", claims=["*.jsonl", "notes.md"],
                         derived=[{"field": "time", "from": "ts or timestamp", "how": "parsed to UTC"}], html=THREADS_HTML,
                         reader=f"READ_BOARD = {read_board}\nWHY = {why!r}\n" + SOME_READER)

    save(False, "")
    out = await views.shown(CORPUS, "some")
    rows = {r["path"]: r for r in out["not_shown"]["files"]}
    assert out["files"] == 3 and set(rows) == {"big.jsonl", "board.jsonl", "notes.md"}
    assert rows["board.jsonl"]["read"] == 0 and 0 < rows["big.jsonl"]["read"] < size
    assert out["not_shown"]["unexplained"] == 3, "a file hidden with no why is not explained"
    assert [d["field"] for d in out["derived"]] == ["time", "day"] and out["derived"][0]["how"] == "parsed to UTC"
    sys.modules.pop("_thimble_views", None)  # a new kernel reads the index and its counts from the cache
    assert (await views.shown(CORPUS, "some"))["not_shown"] == out["not_shown"]
    rep = await views.check(CORPUS, "some")
    assert any("big.jsonl (read" in p and "board.jsonl (read 0 of" in p for p in rep["problems"]), rep["problems"]
    doc = views.frame_document(views.read_view(CORPUS, "some"), derived=out["derived"])
    assert '"field": "day"' in doc

    save(True, "an index of the notes, not records")
    out = await views.shown(CORPUS, "some")
    assert {r["path"]: r["why"] for r in out["not_shown"]["files"]} == {
        "big.jsonl": "only its first line is shown", "notes.md": "an index of the notes, not records"}
    assert out["not_shown"]["unexplained"] == 0
    rep = await views.check(CORPUS, "some")
    assert not any("(read" in p for p in rep["problems"]), rep["problems"]


def test_a_view_of_one_run_leaves_the_other_runs_files_not_shown():
    """Folders beside a claimed one that hold the same files, as runs do, have their files counted as not shown; a
    folder of another kind is left alone though some of its names match."""
    every = [f"runs/sweep1-{r}/{f}" for r in ("managed", "emergent") for f in ("events.jsonl", "manifest.json",
                                                                               "agents/a1.jsonl", "agents/a2.jsonl")]
    every += ["runs/sweep1-emergent/notes.md", "chat/2026-01-01.jsonl", "events/2026-01-01.jsonl"]
    claimed = [p for p in every if "managed" in p]
    assert views.sibling_files(claimed, every) == [
        "runs/sweep1-emergent/agents/a1.jsonl", "runs/sweep1-emergent/agents/a2.jsonl",
        "runs/sweep1-emergent/events.jsonl", "runs/sweep1-emergent/manifest.json"]
    assert views.sibling_files(["chat/2026-01-01.jsonl"], every) == []
    assert views.sibling_files([p for p in every if p.startswith("runs/")], every) == []


def test_the_count_is_what_the_reader_takes_not_what_the_buffers_read(tmp_path):
    """A file counts as read to the end only when the reader took all of it: one line of a small file, or a stop in a
    file's last buffer, counts as far as the reader got. An unbuffered read counts too."""
    from app import view_host  # noqa: PLC0415

    small, big = tmp_path / "small.jsonl", tmp_path / "big.jsonl"
    small.write_text("".join(json.dumps({"n": i}) + "\n" for i in range(200)))
    big.write_text("".join(json.dumps({"n": i, "pad": "x" * 60}) + "\n" for i in range(3000)))
    paths = [str(small), str(big)]
    with view_host._Reads(paths) as seen:
        with open(small) as f:
            first = f.readline()
        with open(big, encoding="utf-8") as f:
            for n, _ in enumerate(f):
                if n == 2990:
                    break
    counts = seen.counts()
    assert counts[str(small)] == len(first) and counts[str(big)] < big.stat().st_size
    with view_host._Reads(paths) as seen:
        with open(small, "rb", buffering=0) as f:
            f.read()
        with open(big) as f:
            sum(1 for _ in f)
    assert seen.counts() == {str(small): small.stat().st_size, str(big): big.stat().st_size}


DERIVING_READER = THREADS_READER.replace(
    '[{"ref": f"{p}#L{n}", "author": a, "body": b}',
    '[{"ref": f"{p}#L{n}", "author": a.upper(), "body": b, "score": len(b) * 1.5, "replies": 7, "thread_key": "k" + a,'
    ' "mood": "unknown"}')


async def test_a_field_whose_values_the_cited_lines_do_not_hold_fails_the_checks_until_the_view_lists_it(
        ws, inproc, bound, monkeypatch):
    """The checks compare the records the reader hands the page with the lines they cite, by code: every field whose
    values are not in those lines and that `derived` does not list is named in one problem, with no model call, and a
    listed one is not."""
    async def page(c, slug, states, **k):
        answer = await views.reader_call(c, slug, "records", {"thread": "t1"})
        return [{"ok": True, "errors": [], "fetches": 1, "answers": [answer], "shown": {"records": 3, "due": 0}}
                for _ in states]

    monkeypatch.setattr(views, "shoot_states", page)
    views.write_view(CORPUS, "threads", reader=DERIVING_READER, html=THREADS_HTML, **VIEW)
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert not rep["ok"], views.gate_lines(rep)
    noted = [n for n in rep["problems"] if "`derived`" in n]
    assert len(noted) == 1 and "author ('ADA' on board.jsonl#L1)" in noted[0] and "score (" in noted[0], noted
    for field in ("body", "replies", "thread_key", "mood"):
        assert f"{field} (" not in noted[0], f"{field}: a raw value, a count, a key or a default needs no entry"
    views.write_view(CORPUS, "threads", reader=DERIVING_READER, html=THREADS_HTML,
                     **{**VIEW, "derived": [{"field": "author", "from": "author", "how": "upper-cased"},
                                            {"field": "score", "from": "body", "how": "its length", "kind": "inferred"}]})
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert rep["ok"] and not [n for n in rep["problems"] + rep["notes"] if "`derived`" in n], views.gate_lines(rep)
    assert [d["field"] for d in rep["coverage"]["derived"]] == ["score", "author"], "an inferred field comes first"


def test_a_file_one_folder_lacks_beside_the_others_is_missing():
    """A claim of a file in each of several folders names the file a folder lacks that holds other claimed files."""
    claimed = ["runs/r1/events.jsonl", "runs/r1/manifest.json", "runs/r2/events.jsonl", "runs/r2/manifest.json",
               "runs/r3/events.jsonl", "runs/r3/agents/a1.jsonl"]
    out = views.missing_files(["runs/*/events.jsonl", "runs/*/manifest.json", "runs/*/agents/*.jsonl", "notes/*.md"], claimed)
    paths = [m["path"] for m in out]
    assert "runs/r3/manifest.json" in paths and "notes/*.md" in paths
    assert "runs/r1/manifest.json" not in paths and not any("agents" in x for x in paths), "one run's agents set no rule"


def test_files_beside_a_claimed_folder_are_named_only_where_the_view_reads_their_like():
    """In a folder beside a claimed one, a file is named when a claimed file has its path below the claimed folder, or
    when the claimed folder holds only claimed files of its subfolder and type; other files of that type are not."""
    every = ["P7/transcript.md", "P7/return/events.jsonl", "P7/return/hooks.jsonl", "P7/return/dialogs.jsonl",
             "P8/transcript.md", "P8/return/events.jsonl", "P8/return/hooks.jsonl", "P8/return/dialogs.jsonl"]
    assert views.sibling_files(["P7/transcript.md", "P7/return/events.jsonl"], every) == [
        "P8/return/events.jsonl", "P8/transcript.md"]
    assert views.sibling_files(["P7/transcript.md", *[p for p in every if p.startswith("P7/return/")]], every) == [
        "P8/return/dialogs.jsonl", "P8/return/events.jsonl", "P8/return/hooks.jsonl", "P8/transcript.md"]


async def test_the_checks_run_the_view_on_a_copy_with_a_file_missing_and_a_line_cut_short(ws, inproc, bound, monkeypatch):
    """The gate runs the reader on a copy of the corpus with one claimed file left out and a torn line after the last
    of a JSON lines file: a reader that fails there, or does not report the torn line, fails the gate."""
    pages = []

    async def page(c, slug, states, **k):
        pages.append(k.get("prepared"))
        return [{"ok": True, "errors": [], "fetches": 1, "shown": {"records": 3, "due": 0}} for _ in states]

    monkeypatch.setattr(views, "shoot_states", page)
    corpus = config.corpus_dir(CORPUS)
    (corpus / "more.jsonl").write_text((corpus / "board.jsonl").read_text())
    view = {**VIEW, "claims": ["*.jsonl"]}
    views.write_view(CORPUS, "threads", reader=THREADS_READER, html=THREADS_HTML, **view)
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert rep["ok"], views.gate_lines(rep)
    copy = pages[-1]
    assert copy and copy["root"].endswith("/robust/corpus") and len(copy["paths"]) == 1
    assert not (views.index_dir(CORPUS, "threads") / views.ROBUST_SUBDIR).exists(), "the copy is removed after"
    strict = THREADS_READER.replace("                try:\n                    r = json.loads(line)\n                except ValueError:\n"
                                    "                    bad.append({\"ref\": f\"{path}#L{n}\", \"why\": \"not JSON\"})\n"
                                    "                    continue\n", "                r = json.loads(line)\n")
    assert strict != THREADS_READER
    views.write_view(CORPUS, "threads", reader=strict, html=THREADS_HTML, **view)
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert not rep["ok"] and any("missing and a torn line at" in p and "the reader failed" in p for p in rep["problems"]), rep["problems"]
    quiet = THREADS_READER.replace("    return index[\"bad\"]", "    return []")
    views.write_view(CORPUS, "threads", reader=quiet, html=THREADS_HTML, **view)
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert not rep["ok"] and any("does not report it" in p for p in rep["problems"]), rep["problems"]


def test_the_test_label_answers_thimble_labels_as_a_label_would(tmp_path):
    """Under the test label, thimble.labels() lists it and thimble.labels("test label") gives the lines it marks of the
    view's files, every line with negatives."""
    from app import kernel_thimble as kt  # noqa: PLC0415

    path = tmp_path / "board.jsonl"
    path.write_text("".join(f'{{"n": {i}}}\n' for i in range(1, 16)))
    kt._view_ctx, kt._view_paths = views.probe_context(), [str(path)]
    try:
        assert list(kt.labels()["name"]) == [kt.PROBE_NAME]
        df = kt.labels(kt.PROBE_NAME)
        assert list(df["line"]) == [7, 14] and set(df["effective"]) == {kt.PROBE_NAME}
        assert len(kt.labels(kt.PROBE_NAME, negatives=True)) == 15
    finally:
        kt._view_ctx, kt._view_paths = None, []


def _shot(state: str, **shown) -> dict:
    return {"ok": True, "state": state, "fetched_records": shown.pop("fetched", 0), "shown": shown}


def test_the_checks_fail_a_page_whose_records_do_not_show_the_test_label():
    """What the test label's states show decides by code: no anchored record, too few of those fetched, or a marked record
    drawn without its mark fail; records shown under the filter whose anchor it does not keep are a note."""
    view = {"slug": "threads"}
    files = [("board.jsonl", 100, 0)]

    def run(*shots):
        return views.label_problems(view, files, list(shots))

    good = (_shot("overview", records=40, units=0, due=6, drawn=6, fetched=40),
            _shot("filtered", records=6, units=0, due=6, drawn=6, unkept=0),
            _shot("detail", records=5, units=1, due=1, drawn=1))
    assert run(*good) == ([], [])
    assert "no element" in run(_shot("overview", records=0, units=0, fetched=40))[0][0]
    assert "only 2 shown elements" in run(_shot("overview", records=2, units=0, due=0, fetched=400))[0][0]
    assert run(_shot("overview", records=2, units=3, fetched=400)) == ([], []), "a view may anchor units instead"
    assert "3 of the 6" in run(_shot("overview", records=40, due=6, drawn=3, fetched=40))[0][0]
    problems, notes = run(good[0], _shot("filtered", records=10, unkept=8), good[2])
    assert not problems and "anchors 8 of them" in notes[0] and "shows 10 records" in notes[0]
    assert run(*good[:1]) == ([], []) and views.label_problems(view, [("doc.pdf", 9, 0)], [_shot("overview")]) == ([], [])


async def test_a_claim_that_matches_no_file_is_listed_as_missing(ws, inproc, bound, monkeypatch):
    """A claim that matches no file shows above the view as missing, and the checks say so without failing."""
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0} for _ in states]

    monkeypatch.setattr(views, "shoot_states", no_page)
    views.write_view(CORPUS, "two", name="Two", description="Posts and a log.", claims=["board.jsonl", "logs/*.log"],
                     accepts=VIEW["accepts"], reader=THREADS_READER, html=THREADS_HTML)
    assert (await views.shown(CORPUS, "two"))["missing"] == [{"path": "logs/*.log", "why": "no file matches it"}]
    rep = await views.check(CORPUS, "two", ["board.jsonl#L3"])
    assert rep["ok"] and any("logs/*.log" in n for n in rep["notes"]), views.gate_lines(rep)


async def test_the_review_reads_one_picture_asks_for_more_and_sends_its_problems_for_a_revision(ws, bound, monkeypatch):
    """The review starts from one picture of the view as it opens; the reading may ask for other states, which are shot
    and read once more with the first, and that reading's problems go to a revision. The view revised, it is reviewed
    again from one picture, and a reading with no problems ends it."""
    from app import card_check, model, view_review  # noqa: PLC0415

    monkeypatch.setattr(views, "_queue", lambda c, slug: None)
    views.propose(CORPUS, "Threads", "The posts by thread.", ["board.jsonl"], "Unit: a post", asked=True)
    views.mark_built(CORPUS, "threads")
    taken: list[list[str]] = []
    asked: list[tuple] = []

    async def shoot_states(c, slug, states, **k):
        taken.append([("filtered" if (st.get("labels") or {}).get("filter") else "on" if (st.get("labels") or {}).get("probe")
                       else "plain") for st in states])
        asked.extend((st.get("size"), st.get("actions")) for st in states)
        for st in states:
            Path(st["out"]).parent.mkdir(parents=True, exist_ok=True)
            Path(st["out"]).write_bytes(b"png")
        return [{"ok": True, "errors": [], "fonts": True, "png": str(st["out"]), "answers": [[{"ref": "board.jsonl#L1"}]]}
                for st in states]

    answers = [{"problems": ["picture 1: the list is cut off"],
                "more": [{"state": "filtered", "why": "the filter"}, {"state": "control", "controls": ["Day"], "why": "days"},
                         {"state": "control", "why": "names no control"}]},
               {"problems": ["picture 2: the filter keeps every post"]},
               {"problems": [], "more": []}]
    readings: list[tuple[int, bool, str]] = []

    async def reading(c, system, user, tool, images, effort):
        readings.append((len(images), "more" in tool.input_schema["properties"], user))
        return model.CallResult(status="ok", output=answers[len(readings) - 1])

    revisions: list[list[str]] = []

    async def revise(c, slug, prop, problems, shots):
        revisions.append(problems)
        return True, "fixed"

    monkeypatch.setattr(views, "shoot_states", shoot_states)
    monkeypatch.setattr(view_review, "_call", reading)
    monkeypatch.setattr(view_review, "revise", revise)
    monkeypatch.setattr(card_check, "fit_image", lambda b: b)
    await view_review._review(view_review._Run(CORPUS, "threads"))
    assert taken == [["plain"], ["filtered", "plain"], ["plain"]]
    assert asked[:3] == [(views.PANE_SIZE, None), (views.PANE_NARROW, None), (views.PANE_SIZE, ["Day"])]
    assert [(n, more) for n, more, _ in readings] == [(1, True), (3, False), (1, True)]
    assert "3: the overview after clicking nothing" in readings[1][2], "the stub clicked nothing"
    assert f"2: the overview filtered to the test label, {views.PANE_NARROW[0]} px wide (asked for: the filter)" in readings[1][2]
    assert revisions == [["picture 2: the filter keeps every post"]]
    review = views.read_proposal(CORPUS, "threads")["review"]
    assert review["state"] == "done" and review["revised"] == revisions[0] and review["shots"] == 4 and not review["left"]


async def test_a_workspace_gets_four_views_from_the_orientation_and_a_deleted_one_stays_deleted(ws, monkeypatch):
    monkeypatch.setattr(views, "_queue", lambda c, slug: None)

    def propose(name, **k):
        return views.propose(CORPUS, name, "The posts.", ["board.jsonl"], "Unit: a post", **k)

    first = [propose(n, orientation=True) for n in ("One", "Two", "Three", "Four")]
    with pytest.raises(views.HTTPException) as e:
        propose("Five", orientation=True)
    assert e.value.status_code == 409
    assert propose("Two", orientation=True)["slug"] == first[1]["slug"], "one of the four is improved under its name"
    # the analyst deletes a proposal and a view: neither frees a place or comes back, and their own asks still build
    views.delete_proposal(CORPUS, first[0]["slug"])
    views.delete_view(CORPUS, "threads")
    for name in ("One", "Threads", "Five"):
        with pytest.raises(views.HTTPException) as e:
            propose(name, orientation=True)
        assert e.value.status_code == 409, name
    assert propose("One", asked=True)["status"] == "queued"
    assert [p["name"] for p in views.list_proposals(CORPUS)] == ["Two", "Three", "Four", "One"]


def test_a_viewer_thimble_ships_runs_from_a_copy_in_the_workspace(ws):
    """The views kernel's sandbox holds the workspace, not thimble's own folder."""
    _, req = views._prepare(CORPUS, "pdf")
    assert Path(req["reader"]).is_relative_to(ws.resolve())
    assert Path(req["reader"]).read_text("utf-8") == (views.VIEWERS_DIR / "pdf" / "reader.py").read_text("utf-8")


def test_the_frame_document_blocks_every_host_before_any_script(ws):
    doc = views.frame_document(views.read_view(CORPUS, "threads"))
    assert doc.lower().startswith("<!doctype html>")
    csp = doc.index("Content-Security-Policy")
    assert csp < doc.index("<script") and "default-src 'none'" in doc and "connect-src 'none'" in doc
    assert "window.thimble" in doc and '"slug": "threads"' in doc
    v = dict(views.read_view(CORPUS, "threads"), libs=views._libs(["vega-embed"]))
    with_libs = views.frame_document(v)
    if views.LIBS["vega"].is_file():
        assert with_libs.count("<script>") == 6, "the view's name, the bridge, vega, vega-lite, vega-embed and the view's own"
    assert views._script_text("a</script>b") == "a<\\/script>b"
    assert views._libs(["vega-embed"]) == ["vega", "vega-lite", "vega-embed"]


async def test_no_thread_is_read_as_a_question_from_a_view_s_own_box(ws, inproc, bound):
    """Views have no question box: a thread about a view, a record it shows or with the box's old selector gets the
    anchor's content only."""
    import httpx  # noqa: PLC0415

    from app import channel  # noqa: PLC0415
    from app.main import app  # noqa: PLC0415

    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    click = {"surface": "files", "element": "view:threads", "selector": "", "image": None, "parent": None}
    cases = [{**click, "anchor": "view:threads", "anchor_text": "Legend"},
             {**click, "anchor": "board.jsonl#L3", "anchor_text": "Confirmed"},
             {**click, "anchor": "view:threads", "selector": "question box", "parent": "main"}]
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
            for body in cases:
                r = await client.post(f"/api/ws/{CORPUS}/chats", json={**body, "text": "which posts confirm the release?"})
                assert r.status_code == 201
                content = q.get_nowait()["content"]
                assert "asked: in the view's own box" not in content, body
                assert "The records the view reads" not in content, body
    finally:
        channel._subs.pop(CORPUS, None)


# ------------------------------------------------------------------------------------------------- worked examples
#
# plugin/viewers/linked-sessions, incident-timeline and repository are the worked examples a view ticket's session reads
# (prompts/dev-view.md), and pdf the file-type viewer thimble ships. Each ships an invented sample of the files it
# claims under sample/, and passes over it the checks a view a session writes must pass. Each sample is copied into the
# temp DATA_DIR as a corpus named after its example.

# the example, the slug it is saved under, and a key of each unit it gives (for pdf, pages it cites)
EXAMPLES = {
    "incident-timeline": ("incident-timeline", ["view:incident-timeline/INC-312",
                                                "view:incident-timeline/2026-05-16T08:00..2026-05-16T09:00"]),
    "repository": ("repository", ["view:repository/r1/pull/11", "view:repository/r3", "view:repository/r2/issues/6",
                                  "view:repository/r3/discussions/2", "view:repository/r4/agents/moss"]),
    "linked-sessions": ("linked-sessions", ["view:linked-sessions/r1", "view:linked-sessions/a07a4da7"]),
    "pdf": ("pdf", ["reports/harbor-line-safety-2026.pdf#p2", "runs/r2/summary.pdf#p1-p2"]),
}


def _example_dir(name: str) -> Path:
    return views.EXAMPLES_DIR / name


@pytest.fixture()
def samples(workspaces_tmp, tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    for name in EXAMPLES:
        shutil.copytree(_example_dir(name) / "sample", d / name)
        (d / name / "manifest.json").write_text(json.dumps({"name": name, "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d.resolve()


def _save_example(name: str) -> str:
    """Save the worked example `name` as a view of its sample, as a session writes one; returns its slug."""
    d = _example_dir(name)
    raw = json.loads((d / "view.json").read_text("utf-8"))
    slug = EXAMPLES[name][0]
    views.write_view(name, slug, reader=(d / "reader.py").read_text("utf-8"), html=(d / "view.html").read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "claims", "accepts", "units", "derived", "libs")})
    return slug


# per example, lines a sample file gets appended that its reader must report rather than fail on: (file, text, problems
# they add); a file that is not there, or a .json or .pdf file, is written whole
BROKEN = {
    "incident-timeline": [("agents.log", '2026-05-16T05:00:00Z INFO autoheal action=scan result=ok msg="matched \\d+"\n', 1),
                          ("deploys.csv", '2026-05-16T03:10:00+01:00,dep-90,started,api,1.2.0,ops,,,"two\nlines"\n', 0),
                          ("alerts/monitor-20260516-0431.jsonl", '{"ts": 1778910000000, "state": "firing"}\n', 1),
                          ("chat/random.json", "[1, 2]", 1)],
    "repository": [("runs/r3/export/comments.csv", '4,hazel,2026-05-20T10:00:00,"Repro:\n2 failures"\n', 0),
                   ("runs/r2/manifest.json", "{", 1),
                   ("runs/r1/events.jsonl",
                    '{"id": "x1", "type": "label.added", "ts": "2026-05-20T10:00:00Z", "number": 11}\n'
                    '{"id": "x2", "type": "comment", "ts": "yesterday", "actor": "ash", "number": 11}\n', 2)],
    "linked-sessions": [("runs/r1/sessions-index.json", "not json", 1),
                        ("runs/r1/36fe6b9d-6e6d-4582-aef9-c97a0fe8f576.jsonl",
                         '{"type": "user", "uuid": "x9", "timestamp": "2026-09-12T14:50:00Z", "message": {"role": '
                         '"user", "content": [{"type": "tool_result", "tool_use_id": "toolu_gone", "content": "ok"}]}}\n',
                         1)],
    "pdf": [("uploads/half.pdf", "%PDF-1.4\n1 0 obj\n", 1)],
}


@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_every_worked_example_answers_the_checks_over_its_sample(name, samples, inproc, bound, tmp_path, monkeypatch):
    """The reader's half of the checks: the index builds, the sampled lines and the declared keys resolve, each answer
    cites its place back, and every excerpt is literal text of the records it cites. The page's half is a test below.
    Lines that do not parse, a CSV cell over two lines among them, are reported (reader_problems) rather than failing.
    Each sample label the example ships (labels.json) marks some line of the files it runs over."""
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0, "records": 1} for _ in states]

    monkeypatch.setattr(views, "shoot_states", no_page)
    root = samples / name
    files = [p for p in root.rglob("*") if p.is_file()]
    labels = _example_dir(name) / "labels.json"
    for label in json.loads(labels.read_text("utf-8")) if labels.is_file() else []:
        pattern = re.compile(label["spec"])
        over = [p for p in files if any(fnmatch.fnmatchcase(p.relative_to(root).as_posix(), g) for g in label["paths"])]
        assert any(pattern.search(line) for p in over for line in p.read_text("utf-8").splitlines()), label["name"]
    slug = _save_example(name)
    before = (await views.reader_problems(name, slug))["count"]
    for rel, text, _ in BROKEN[name]:
        path = samples / name / rel
        old = path.read_text("utf-8") if path.is_file() and not rel.endswith((".json", ".pdf")) else ""
        path.write_text(old + ("\n" if old and not old.endswith("\n") else "") + text, "utf-8")
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    checked = [r["locator"] for r in rep["checks"]]
    assert set(EXAMPLES[name][1]) <= set(checked)
    assert name == "pdf" or any(re.search(r"#L\d+$", c) for c in checked), "sampled lines were checked beside the keys"
    problems = await views.reader_problems(name, slug)
    assert problems["count"] == before + sum(n for *_, n in BROKEN[name]), problems
    assert not rep["coverage"]["not_shown"]["count"] and rep["coverage"]["derived"], "every file is read, and what the reader made is listed"


@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_every_worked_example_s_page_loads_headless_at_its_first_place(name, samples, inproc, bound, tmp_path):
    """The whole check a view ticket's session runs, the headless page included, where this machine has Node and the
    frontend's packages with their Chromium (scripts/check.sh install)."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)  # CI installs them, so there the page is always loaded
        pytest.skip(why)
    slug = _save_example(name)
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path, picture=True)
    assert rep["ok"], views.gate_lines(rep)
    assert rep["page"]["fetches"] >= 1 and Path(rep["page"]["png"]).is_file()
    assert [s["state"] for s in rep["shots"]] == list(views.CHECK_STATES)
    assert [s["state"] for s in rep["shots"] if s.get("png")] == ["opened"], "only the picture asked for is taken"
    if name != "pdf":
        shown = rep["shots"][0]["shown"]
        assert shown["due"] and shown["drawn"] == shown["due"], "the test label shows on the records a worked example shows"


async def test_a_check_run_where_it_cannot_reach_the_server_leaves_its_request_in_the_view_s_folder(ws, monkeypatch):
    """view_check.py run inside the sandbox reaches neither the server nor server.json: it leaves its request as a file
    in the view's folder, which the server watches while the session runs, and prints the answer written beside it."""
    import importlib.util  # noqa: PLC0415

    spec = importlib.util.spec_from_file_location("view_check_t", Path(views.__file__).with_name("view_check.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    asked: list[tuple] = []

    async def answer(c, slug, locators, picture):
        asked.append((c, slug, locators, picture))
        return {"ok": True, "lines": ["page: loaded"], "png": None}

    monkeypatch.setattr(views, "check_answer", answer)
    monkeypatch.setattr(views, "CHECK_POLL_S", 0.05)
    monkeypatch.setattr(mod, "POLL_S", 0.05)
    folder = views.views_dir(CORPUS) / "threads"
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    watch = views.watch_checks(CORPUS, "threads")
    try:
        code = await asyncio.to_thread(mod.main, ["--home", str(folder / "nowhere"), "--folder", str(folder),
                                                  "http://127.0.0.1:9/api/ws/boards/views/threads/check", "board.jsonl#L3",
                                                  "--picture"])
    finally:
        watch.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watch
    assert code == 0 and json.loads(out.getvalue())["lines"] == ["page: loaded"]
    assert asked == [(CORPUS, "threads", ["board.jsonl#L3"], True)]
    assert not (folder / views.CHECK_DROP).exists(), "the folder goes when the session's watch ends"
    monkeypatch.setattr(mod, "PICKUP_S", 0.2)
    code = await asyncio.to_thread(mod.main, ["--folder", str(folder), "http://127.0.0.1:9/api/ws/boards/views/threads/check"])
    assert code == 1 and not list((folder / views.CHECK_DROP).glob("*.json")), "with no server watching it gives up"


FIT_HTML = """<!doctype html><html><head><style>body{font:13px sans-serif;margin:8px}</style></head><body>
<div style="position:relative;height:40px"><span style="position:absolute;left:0;top:0">Overlapping label one</span>
<span style="position:absolute;left:12px;top:2px">Second label here</span></div>
<div style="width:60px;overflow:hidden;white-space:nowrap">A text far too long for its box</div>
<div style="width:300px">Narrow column</div>
<button id="more">Show more</button><div id="extra" hidden data-anchor="board.jsonl#L2">bo: Anyone have the build number?</div>
<video id="clip" width="160" height="90"></video>
<script>
document.getElementById('clip').src = thimble.mediaUrl('clip.mp4')
document.getElementById('more').onclick = () => { document.getElementById('extra').hidden = false }
thimble.onOpen(() => {})
</script></body></html>"""


async def test_the_headless_page_measures_how_its_text_fits_and_clicks_a_control_a_state_names(ws, inproc, bound):
    """The checks' page reports text drawn over other text, text its box cuts off and how much of a wide pane the page
    uses, lists its controls by their text, and a state's actions click a control by its text before it is measured."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    (config.corpus_dir(CORPUS) / "clip.mp4").write_bytes(b"\0\0\0\x18ftypmp42" + bytes(64))
    views.write_view(CORPUS, "fit", reader=THREADS_READER, html=FIT_HTML,
                     **{**VIEW, "name": "Fit", "claims": ["board.jsonl", "clip.mp4"]})
    plain, clicked = await views.shoot_states(CORPUS, "fit", [
        {"open": {}, "size": views.PANE_WIDE}, {"open": {}, "actions": ["Show more", "No such control"]}])
    assert plain["ok"] and clicked["ok"], (plain["errors"], clicked["errors"])
    lay = plain["layout"]
    assert lay["overlaps"] == 1 and lay["pairs"][0] == ["Overlapping label one", "Second label here"], lay
    assert lay["cut"] == 1 and lay["cuts"] == ["A text far too long for its box"], lay
    assert lay["width"] == views.PANE_WIDE[0] and lay["used"] < views.WIDE_USED * lay["width"] and not lay["overflow"]
    assert "Show more" in plain["controls"]
    assert plain["shown"]["records"] == 0 and clicked["shown"]["records"] == 1, "the click showed the hidden record"
    assert clicked["actions"] == [{"control": "Show more", "found": True}, {"control": "No such control", "found": False}]
    assert plain["unplayable"] == 1, "an MP4 this Chromium cannot decode is named, not taken for the view's fault"
    notes = views.layout_notes([{**plain, "state": "wide"}])
    assert len(notes) == 2 and "1 audio or video player stayed blank" in notes[0]
    assert "overlaps other text in 1 place," in notes[1] and "rest of the pane is empty" in notes[1]


# what Playwright's own error says to run, which never reaches a model
INSTALL_WORDS = re.compile(r"playwright install|npx|download new browsers|Executable doesn't exist|install\.sh", re.I)


@pytest.mark.parametrize("name", ["repository"])
async def test_without_the_headless_browser_a_view_is_checked_on_its_reader_and_nothing_says_how_to_install_it(
        name, samples, inproc, bound, tmp_path, monkeypatch, caplog):
    """Where Playwright finds no browser and there is no system browser, a view's checks pass on its reader, the session
    hears only that screenshots are unavailable, the log warns once, and the screenshot tool says only that."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    empty = tmp_path / "browsers"
    empty.mkdir()
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(empty))
    monkeypatch.setattr(userconf, "system_browser", lambda: "")
    monkeypatch.setattr(headless, "_missing", {})
    caplog.set_level(logging.WARNING, logger="thimble.headless")
    slug = _save_example(name)
    for _ in range(2):
        rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
        lines = views.gate_lines(rep)
        assert rep["ok"] and rep["page"].get("unavailable"), lines
        assert not any(INSTALL_WORDS.search(ln) for ln in lines), lines
    assert len(caplog.records) == 1, [r.getMessage() for r in caplog.records]
    monkeypatch.setattr(headless, "_missing", {})  # the page screenshot's own script finds the browser missing too
    monkeypatch.setenv("THIMBLE_PORT", "8921")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    shot = await tools._shot_page("http://127.0.0.1:8921/", None)
    assert shot.is_error and shot.text == headless.NO_SCREENSHOTS
