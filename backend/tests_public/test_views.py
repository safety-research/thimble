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
import functools
import io
import json
import logging
import os
import re
import shutil
import sys
from pathlib import Path

import pytest
from conftest import Listener

from app import config, dev, extension_manifest, headless, tools, userconf, views

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
# THREADS_HTML with a label switch, as a view of many files draws its own label controls
SWITCHED_HTML = THREADS_HTML.replace(
    "</body>", "<button data-label=\"asks\" onclick=\"thimble.setLabel('asks', true)\">asks</button></body>")

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


ANY_KEY_READER = '''
def build_index(paths):
    for path in paths:
        open(path).read()
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    if "key" not in locator:
        return None
    n = int(locator["key"][1:])
    return {"excerpt": f"unit {n}", "label": f"unit {n}", "refs": [f"board.jsonl#L{n + 1}"], "key": locator["key"],
            "target": {}}
'''


async def test_marking_many_units_writes_their_kept_answers_once_and_off_the_event_loop(ws, inproc, monkeypatch):
    """With a label on, the marks of a page's units resolve them all at once, and their answers are kept in
    key-refs.json in one read and one write, made off the event loop, so the server answers other requests meanwhile."""
    views.write_view(CORPUS, "units", reader=ANY_KEY_READER, html=THREADS_HTML,
                     **{**VIEW, "name": "Units", "units": [{"form": "k<n>", "means": "one unit"}]})
    reads, writes = [], []
    real_read, real_write = views.key_refs, views.write_json

    def on_loop() -> bool:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return False
        return True

    def counted_read(c):
        reads.append(on_loop())
        return real_read(c)

    def counted_write(path, obj):
        if Path(path).name == views.KEY_REFS_FILE:
            writes.append(on_loop())
        real_write(path, obj)

    monkeypatch.setattr(views, "key_refs", counted_read)
    monkeypatch.setattr(views, "write_json", counted_write)
    units = [f"view:units/k{n}" for n in range(300)]
    marks = await views.marks_for(CORPUS, "units", units, views.probe_context())
    assert marks, "the test label marks some of the units"
    assert reads == [False] and writes == [False]
    kept = real_read(CORPUS)
    assert len(kept) == 300 and kept["view:units/k7"]["refs"] == ["board.jsonl#L8"]
    views._memo.clear()
    await views.marks_for(CORPUS, "units", units, views.probe_context())
    assert writes == [False], "answers it already holds are not written again"


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


async def test_a_file_viewer_s_notes_are_those_of_the_file_it_shows(ws, inproc, bound):
    """A file viewer open on one file says what it leaves out of that file only: its unreadable lines, and nothing of the
    other files it claims, so a clean file has nothing to say. Where the reader gives a count beyond the lines it lists,
    one file's count is not known."""
    corpus = config.corpus_dir(CORPUS)
    (corpus / "more.jsonl").write_text((corpus / "board.jsonl").read_text() + "{torn\nnot json\n")
    views.write_view(CORPUS, "posts", name="Posts", description="One file of posts.", claims=["*.jsonl"], unit="file",
                     accepts=VIEW["accepts"], reader=THREADS_READER, html=THREADS_HTML)
    whole = await views.reader_problems(CORPUS, "posts")
    torn = await views.reader_problems(CORPUS, "posts", path="more.jsonl")
    clean = await views.reader_problems(CORPUS, "posts", path="board.jsonl")
    assert whole["count"] == torn["count"] == 2 and clean == {"count": 0, "examples": []}, (whole, torn, clean)
    assert [x["ref"] for x in torn["examples"]] == [f"more.jsonl#L{len(POSTS) + 1}", f"more.jsonl#L{len(POSTS) + 2}"]
    one = await views.shown(CORPUS, "posts", path="board.jsonl")
    assert one["files"] == 1 and one["not_shown"]["files"] == [] and one["missing"] == [], one
    assert (await views.shown(CORPUS, "posts"))["files"] == 2
    many = {"count": 5, "examples": [{"ref": "more.jsonl#L3", "why": "bad"}, {"ref": "board.jsonl#L1", "why": "bad"}]}
    assert views.problems_of_file(many, "more.jsonl") == {"count": None, "examples": [{"ref": "more.jsonl#L3", "why": "bad"}]}
    assert views.problems_of_file({**many, "count": 2}, "more.jsonl")["count"] == 1


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


SHOTS_READER = '''
def build_index(paths):
    posts = []
    for path in paths:
        if path.endswith(".jsonl"):
            with open(path) as f:
                posts += [f"{path}#L{n}" for n, _ in enumerate(f, 1)]
    return {"posts": posts, "media": [p for p in paths if not p.endswith(".jsonl")]}


def records(index, query):
    return [{"ref": ref, "shot": index["media"][i]} for i, ref in enumerate(index["posts"])]


def resolve(index, locator):
    return None
'''


async def test_images_and_pdfs_a_page_shows_count_as_shown_unopened_and_their_paths_go_to_the_kernel_only_to_build(
        ws, inproc, bound, monkeypatch):
    """A view of many screenshots and a PDF beside the records it parses: the images and the PDF count as shown without
    a stat or a read each, the residue rule still holds for the records file, and once the index is built a reader call
    no longer names every claimed file. The damaged copy the checks run on links a bounded number of them."""
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0, "records": 1} for _ in states]

    from app import view_host  # noqa: PLC0415

    assert set(views.MEDIA_TYPES) | {".pdf"} == set(view_host.SHOWN_SUFFIXES)
    monkeypatch.setattr(views, "shoot_states", no_page)
    corpus = config.corpus_dir(CORPUS)
    (corpus / "shots").mkdir()
    n = views.PATHS_SENT + 10
    for i in range(n):
        (corpus / "shots" / f"{i:05d}.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
    (corpus / "slides.pdf").write_bytes(b"%PDF-1.4\n" + b"\0" * 64)
    sent: list[dict] = []

    async def counted(c, code, timeout):
        import ast  # noqa: PLC0415

        sent.append(json.loads(ast.literal_eval(code.rsplit(".call(", 1)[1].rstrip().removesuffix(")"))))
        return await _inproc_run(c, code, timeout)

    monkeypatch.setattr(views, "_runner", counted)
    views.write_view(CORPUS, "shots", name="Shots", description="Posts beside their screenshots.",
                     claims=["board.jsonl", "shots/*.png", "*.pdf"], accepts=VIEW["accepts"], reader=SHOTS_READER,
                     html=THREADS_HTML)
    view = views.read_view(CORPUS, "shots")
    files = views.claimed_files(CORPUS, view)
    assert len(files) == n + 2 and {f[1] for f in files if f[0] != "board.jsonl"} == {0}, "images are not stat'ed"
    assert dict((f[0], f[1]) for f in files)["board.jsonl"] == (corpus / "board.jsonl").stat().st_size

    out = await views.shown(CORPUS, "shots")
    assert out["files"] == n + 2 and out["not_shown"]["count"] == 0, out["not_shown"]
    assert "paths" not in sent[0] and len(sent[1]["paths"]) == n + 2, "the paths go again only for the kernel to build"
    reads = json.loads(Path(sent[1]["reads"]).read_text())
    assert list(reads) == ["board.jsonl"], "the reads of images and PDFs are not counted"

    sent.clear()
    got = await views.reader_call(CORPUS, "shots", "records", None, labels=views.probe_context())
    assert len(got) == len(POSTS) and len(sent) == 1 and "paths" not in sent[0]
    assert sent[0]["view_paths"] == ["board.jsonl"], "the test label gives lines of the parsed files only"

    sys.modules.pop("_thimble_views", None)  # a new kernel loads the pickle without the paths
    sent.clear()
    assert len(await views.reader_call(CORPUS, "shots", "records", None)) == len(POSTS)
    assert len(sent) == 1 and "paths" not in sent[0]

    (corpus / "board.jsonl").write_text((corpus / "board.jsonl").read_text() + "{torn\n")
    rep = await views.check(CORPUS, "shots", need_locators=False)
    assert not any("neither read to the end" in p for p in rep["problems"]), rep["problems"]
    (corpus / "board.jsonl").write_text("".join(json.dumps({"n": i}) + "\n" for i in range(3)))
    views.write_view(CORPUS, "shots", name="Shots", description="Posts beside their screenshots.",
                     claims=["board.jsonl", "shots/*.png", "*.pdf"], accepts=VIEW["accepts"], html=THREADS_HTML,
                     reader=SHOTS_READER.replace('if path.endswith(".jsonl"):', 'if path.endswith(".none"):'))
    rep = await views.check(CORPUS, "shots", need_locators=False)
    assert any("neither read to the end" in p and "board.jsonl" in p for p in rep["problems"]), rep["problems"]

    monkeypatch.setattr(views, "ROBUST_SHOWN", 5)
    copy = views.robust_copy(CORPUS, "shots", view, views.claimed_files(CORPUS, view))
    assert copy["cut"] and sum(1 for f in copy["files"] if f[0].endswith(".png")) <= 5
    assert any(f[0] == "board.jsonl" for f in copy["files"]), "the records file goes in before the images"


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
    ' "mood": "unknown", "flagged": n % 3 == 0, "topics": ["deploy"] if n % 3 else ["ops", "bug"],'
    ' "words": b.split()[:2]}')


async def test_a_field_whose_values_the_cited_lines_do_not_hold_fails_the_checks_until_the_view_lists_it(
        ws, inproc, bound, monkeypatch):
    """The checks compare the records the reader hands the page with the lines they cite, by code: every field whose
    values are not in those lines and that `derived` does not list is named in one problem, with no model call, and a
    listed one is not."""
    async def page(c, slug, states, **k):
        answer = await views.reader_call(c, slug, "records", {"thread": "t1"})
        return [{"ok": True, "errors": [], "fetches": 1, "answers": [answer], "shown": {"records": 3, "due": 0},
                 "label_controls": 1} for _ in states]

    monkeypatch.setattr(views, "shoot_states", page)
    views.write_view(CORPUS, "threads", reader=DERIVING_READER, html=SWITCHED_HTML, **VIEW)
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert not rep["ok"], views.gate_lines(rep)
    noted = [n for n in rep["problems"] if "listed as derived" in n]
    assert len(noted) == 1 and "author ('ADA' on board.jsonl#L1)" in noted[0] and "score (" in noted[0], noted
    assert "flagged (" in noted[0] and "topics (" in noted[0], "a true or false and a list the lines do not hold"
    for field in ("body", "replies", "thread_key", "mood", "words"):
        assert f"{field} (" not in noted[0], f"{field}: a raw value, a count, a key or a default needs no entry"
    views.write_view(CORPUS, "threads", reader=DERIVING_READER, html=SWITCHED_HTML,
                     **{**VIEW, "derived": [{"field": "author", "from": "author", "how": "upper-cased"},
                                            {"field": "score", "from": "body", "how": "its length", "kind": "inferred"},
                                            {"field": "flagged", "from": "body", "how": "a classifier", "kind": "inferred"},
                                            {"field": "topics", "from": "body", "how": "a classifier", "kind": "inferred"}]})
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert rep["ok"] and not [n for n in rep["problems"] + rep["notes"] if "listed as derived" in n], views.gate_lines(rep)
    assert [d["field"] for d in rep["coverage"]["derived"]] == ["score", "flagged", "topics", "author"], "inferred first"
    # the schema's form: `scope`, and each derived field marked in `records`
    d = views.views_dir(CORPUS) / "threads"
    old = json.loads((d / "view.json").read_text())
    (d / "view.json").write_text(json.dumps({
        "name": old["name"], "description": old["description"], "scope": old["claims"], "accepts": old["accepts"],
        "units": old["units"], "libs": [],
        "records": [{"name": "post", "one": "one post", "fields": [
            {"name": "ref", "type": "ref"}, {"name": "body", "type": "text"},
            {"name": "author", "type": "category", "derived": "cleaned", "from": "author", "how": "upper-cased"},
            {"name": "score", "type": "number", "derived": "computed", "from": "body", "how": "its length"},
            {"name": "flagged", "type": "category", "derived": "computed", "from": "body", "how": "a classifier"},
            {"name": "topics", "type": "list", "derived": "computed", "from": "body", "how": "a classifier"}]}]}))
    views._memo.clear()
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert rep["ok"], views.gate_lines(rep)
    assert [d["field"] for d in rep["coverage"]["derived"]] == ["score", "flagged", "topics", "author"]
    assert [d["kind"] for d in rep["coverage"]["derived"]] == ["inferred"] * 3 + [""]
    assert views._exempt("files", 3) and views._exempt("n_calls", 2) and views._exempt("call count", 18), \
        "a count needs no entry"
    assert not views._exempt("ts", 1781741180000) and not views._exempt("status", 200), "a short or singular name is no count"


def test_a_file_one_folder_lacks_beside_the_others_is_missing():
    """A claim of a file in each of several folders names the file a folder lacks that holds other claimed files."""
    claimed = ["runs/r1/events.jsonl", "runs/r1/manifest.json", "runs/r2/events.jsonl", "runs/r2/manifest.json",
               "runs/r3/events.jsonl", "runs/r3/agents/a1.jsonl"]
    out = views.missing_files(["runs/*/events.jsonl", "runs/*/manifest.json", "runs/*/agents/*.jsonl", "notes/*.md"], claimed)
    paths = [m["path"] for m in out]
    assert "runs/r3/manifest.json" in paths and "notes/*.md" in paths
    assert "runs/r1/manifest.json" not in paths and not any("agents" in x for x in paths), "one run's agents set no rule"
    assert views.missing_files(["**/*.jsonl", "docs/*.md"], ["a/x.jsonl", "b/y.jsonl", "docs/r.md"]) == [], \
        "a claim of any file of a type in any folder names nothing a folder lacks"


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

    (corpus / "a-small.jsonl").write_text('{"thread": "t1", "author": "a", "body": "b"}\n')
    (corpus / "a-skipped.jsonl").write_text('{"thread": "t9", "author": "x", "body": "an export of last year"}\n')
    skipping = THREADS_READER.replace("    for path in paths:\n", "    for path in [p for p in paths if 'skipped' not in p]:\n") \
        + "\n\ndef hidden(index):\n    return [{\"path\": \"a-skipped.jsonl\", \"why\": \"an old export\"}]\n"
    views.write_view(CORPUS, "threads", reader=skipping, html=THREADS_HTML, **view)
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert rep["ok"], "the torn line goes in a file the reader reads, not one it hides: " + "; ".join(views.gate_lines(rep))

    planted = views.index_dir(CORPUS, "threads") / views.ROBUST_SUBDIR
    outside = config.workspace_dir(CORPUS).parent / "outside"
    outside.mkdir()
    planted.symlink_to(outside)
    v = views.read_view(CORPUS, "threads")
    copy = views.robust_copy(CORPUS, "threads", v, views.claimed_files(CORPUS, v))
    assert copy and not list(outside.iterdir()) and not planted.is_symlink(), "a symlink a reader left is not followed"


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
    return {"ok": True, "state": state, "fetched_records": shown.pop("fetched", 0), "label_controls": shown.pop("controls", 1),
            "shown": shown}


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
    assert run(*good[:1]) == ([], []) and views.label_problems(view, [("talk.mp4", 9, 0)], [_shot("overview")]) == ([], [])
    assert views.label_problems(view, [("doc.pdf", 9, 0)], [_shot("overview")])[0], "a PDF's pages are records labels mark"
    bare = [_shot("overview", records=40, units=0, due=6, drawn=6, fetched=40, controls=0),
            _shot("filtered", records=6, units=0, due=6, drawn=6, controls=0)]
    (problem,) = run(*bare)[0]
    assert "draws no label controls" in problem, "a corpus view draws its own label controls"
    assert run(bare[0], {**bare[1], "label_controls": 2})[0] == [], "one state that shows them is enough"
    (problem,) = views.label_problems(view, files, list(good), switch=False)[0]
    assert "never calls `thimble.setLabel`" in problem, "a legend's data-label with no switch is not a label control"
    viewer = {"slug": "logs", "claims": ["**/*.log"]}
    assert views.label_problems(viewer, [("a.log", 9, 0)], bare) == ([], []), "a file viewer beside the Labels pane need not"


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


async def test_the_review_s_pictures_take_each_state_in_its_pane_with_its_label_and_its_clicks(ws, bound, monkeypatch):
    """view_pictures (view_review.pictures): a round's first call takes the overview, then the states the reviewer asks
    for, each in its pane, with the test label on or filtered to, and the controls it names clicked; a `control` that
    names none is left out. Each picture's line says what it shows and why it was asked for."""
    from app import view_review  # noqa: PLC0415

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

    monkeypatch.setattr(views, "shoot_states", shoot_states)
    monkeypatch.setattr(view_review.headless, "missing", lambda what: False)
    more = [{"state": "filtered", "why": "the filter"}, {"state": "control", "controls": ["Day"], "why": "days"},
            {"state": "control", "why": "names no control"}]
    paths, records, reading = await view_review.pictures(CORPUS, "threads", "a1", more)
    assert reading == "", "no extension's program replaces the view-review task"
    assert taken == [["plain", "filtered", "plain"]]
    assert asked == [(views.PANE_SIZE, None), (views.PANE_NARROW, None), (views.PANE_SIZE, ["Day"])]
    assert f"the overview filtered to the test label, {views.PANE_NARROW[0]} px wide, asked for: the filter" in paths
    assert "the overview after clicking nothing" in paths, "the stub clicked nothing"
    assert "board.jsonl#L1" in records
    assert views.read_proposal(CORPUS, "threads")["review"]["shots"] == 3


async def test_a_program_that_replaces_the_view_review_task_reads_the_reviewer_s_pictures(ws, bound, monkeypatch):
    """An extension's program that replaces the view-review task gets each view_pictures call's pictures as the task's
    input (docs/agents.md), and the reviewer gets the problems it found to fix; a program that fails ends the review
    failed with why, and the reviewer is told to end."""
    import types  # noqa: PLC0415

    from app import model, tasks, view_review  # noqa: PLC0415

    monkeypatch.setattr(views, "_queue", lambda c, slug: None)
    views.propose(CORPUS, "Threads", "The posts by thread.", ["board.jsonl"], "Unit: a post", asked=True)
    views.mark_built(CORPUS, "threads")

    async def shoot_states(c, slug, states, **k):
        for st in states:
            Path(st["out"]).parent.mkdir(parents=True, exist_ok=True)
            Path(st["out"]).write_bytes(b"png")
        return [{"ok": True, "errors": [], "fonts": True, "png": str(st["out"]), "answers": []} for st in states]

    monkeypatch.setattr(views, "shoot_states", shoot_states)
    monkeypatch.setattr(view_review.headless, "missing", lambda what: False)
    monkeypatch.setattr(tasks, "program", lambda c, task: types.SimpleNamespace(extension="vote") if task == "view-review"
                        else None)
    inputs: list[dict] = []
    answer = model.CallResult(status="ok", output={"problems": ["picture 1: the header covers the first post"]})

    async def call(c, task, inp, schema=None, **k):
        inputs.append(inp)
        return answer

    monkeypatch.setattr(tasks, "call", call)
    paths, _, reading = await view_review.pictures(CORPUS, "threads", "a1", [])
    [inp] = inputs
    assert inp["view"]["slug"] == "threads" and inp["ask"] is False
    assert [p["path"] for p in inp["pictures"]] == [paths.split(" ", 2)[1]]
    assert "vote's program" in reading and "- picture 1: the header covers the first post" in reading
    answer = model.CallResult(status="error", detail="it crashed")
    stopped: list[str] = []
    from app import view_tools  # noqa: PLC0415

    monkeypatch.setattr(view_tools, "stop_after_grace", lambda c, key, agent_id: stopped.append(agent_id))
    with pytest.raises(view_review.NoPictures, match="vote's program .* failed: it crashed"):
        await view_review.pictures(CORPUS, "threads", "a1", [{"state": "narrow", "why": "the width"}])
    review = views.read_proposal(CORPUS, "threads")["review"]
    assert review["state"] == "failed" and review["finished"] and "it crashed" in review["note"] and stopped == ["a1"]


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
    for slug in (first[0]["slug"], "threads"):
        dev.view_work_dir(CORPUS, slug).mkdir(parents=True, exist_ok=True)
        (dev.view_work_dir(CORPUS, slug) / "sample.jsonl").write_text("{}\n")
    views.delete_proposal(CORPUS, first[0]["slug"])
    views.delete_view(CORPUS, "threads")
    assert not any(dev.view_work_dir(CORPUS, s).exists() for s in (first[0]["slug"], "threads")), "the builds' folders go"
    for name in ("One", "Threads", "Five"):
        with pytest.raises(views.HTTPException) as e:
            propose(name, orientation=True)
        assert e.value.status_code == 409, name
    assert propose("One", asked=True)["status"] == "queued"
    assert [p["name"] for p in views.list_proposals(CORPUS)] == ["Two", "Three", "Four", "One"]


def test_a_viewer_thimble_ships_runs_from_a_copy_in_the_workspace(ws, tmp_path, monkeypatch):
    """The views kernel's sandbox holds the workspace, not thimble's own folder."""
    shipped = tmp_path / "viewers" / "board"
    shipped.mkdir(parents=True)
    (shipped / "view.json").write_text(json.dumps({**VIEW, "name": "Board"}), "utf-8")
    (shipped / "reader.py").write_text(THREADS_READER, "utf-8")
    (shipped / "view.html").write_text(THREADS_HTML, "utf-8")
    monkeypatch.setattr(views, "VIEWERS_DIR", shipped.parent)
    monkeypatch.setattr(views, "BUILTIN_VIEWERS", ("board",))
    _, req = views._prepare(CORPUS, "board")
    assert Path(req["reader"]).is_relative_to(ws.resolve())
    assert Path(req["reader"]).read_text("utf-8") == THREADS_READER


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

    from app.main import app  # noqa: PLC0415

    q = Listener(CORPUS)
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
        q.close()


# ------------------------------------------------------------------------------------------------- worked examples
#
# plugin/viewers/timeline, linked-sessions and repository are the worked examples a view ticket's session reads
# (prompts/dev-view.md), and never views of a workspace. Each ships an invented sample of the files it claims under
# sample/, and passes over it the checks a view a session writes must pass. Each sample is copied into the temp DATA_DIR
# as a corpus named after its example.

# the example, the slug it is saved under, and a key of each unit it gives
EXAMPLES = {
    "timeline": ("timeline", ["view:timeline/INC-312", "view:timeline/2026-05-18",
                              "view:timeline/2026-05-16T08:00..2026-05-16T09:00"]),
    "repository": ("repository", ["view:repository/r1/pull/11", "view:repository/r3", "view:repository/r2/issues/6",
                                  "view:repository/r3/discussions/2", "view:repository/r4/agents/moss"]),
    "linked-sessions": ("linked-sessions", ["view:linked-sessions/r1", "view:linked-sessions/a07a4da7"]),
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
                     **{k: raw.get(k) for k in ("name", "description", "scope", "records", "accepts", "units", "libs")})
    return slug


# per example, lines a sample file gets appended that its reader must report rather than fail on: (file, text, problems
# they add); a file that is not there, or a .json file, is written whole
BROKEN = {
    "timeline": [("agents.log", '2026-05-16T05:00:00Z INFO autoheal action=scan result=ok msg="matched \\d+"\n', 1),
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
}


def test_every_worked_example_s_view_json_is_in_the_schema_s_form():
    """The examples teach view.json as the dev agent's prompt does: they follow the extension schema and use none of the
    older names thimble still reads."""
    for name in EXAMPLES:
        text = (_example_dir(name) / "view.json").read_text("utf-8")
        raw = json.loads(text)
        assert not extension_manifest._validate(raw, text, f"{name}/view.json", "view"), name
        old = {k for k, v in extension_manifest.schema()["$defs"]["view"]["properties"].items() if v.get("deprecated")}
        assert not old & set(raw), (name, old & set(raw))
        assert raw.get("scope") and raw.get("records"), name


def test_a_derived_field_is_listed_for_each_kind_of_record_that_holds_it():
    """A field name two kinds of record share, such as a pull request's state and an issue's, is listed for each, under
    its record, the records in view.json's order and the computed fields first in each."""
    raw = json.loads((_example_dir("repository") / "view.json").read_text("utf-8"))
    declared = [(r["name"], f["name"], f["derived"]) for r in raw["records"] for f in r["fields"] if f.get("derived")]
    got = views._normalize_view("repository", raw)["derived"]
    assert sorted((d["record"], d["field"]) for d in got) == sorted((r, f) for r, f, _ in declared)
    assert len({d["field"] for d in got}) < len(got), "the example has a name two kinds share"
    assert list(dict.fromkeys(d["record"] for d in got)) == [r["name"] for r in raw["records"]]
    for rec in raw["records"]:
        kinds = [d["kind"] for d in got if d["record"] == rec["name"]]
        assert kinds == sorted(kinds, key=lambda k: k != "inferred"), rec["name"]
    again = views._derived([*got, {"field": "state", "from": "a reader's derived()", "how": "again"},
                            {"field": "busy", "from": "a reader's derived()", "how": "new"}])
    assert again[:-1] == got and again[-1]["field"] == "busy", "a field a record has is not listed again without one"


def test_the_worked_examples_are_never_views_of_a_workspace(samples):
    """A corpus that holds an example's own sample gets none of the examples as views: none is listed, none opens a
    citation of its files, and none adds a citation form to main's table."""
    for name in EXAMPLES:
        slugs = {v["slug"] for v in views.list_views(name)}
        assert not slugs & {p.name for p in views.EXAMPLES_DIR.iterdir()}, name
        assert not views.forms_text(name), name
        for p in sorted((samples / name).rglob("*"))[:20]:
            if p.is_file():
                assert not views.views_for(name, p.relative_to(samples / name).as_posix(), "L1"), (name, p)


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
        old = path.read_text("utf-8") if path.is_file() and not rel.endswith(".json") else ""
        path.write_text(old + ("\n" if old and not old.endswith("\n") else "") + text, "utf-8")
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    checked = [r["locator"] for r in rep["checks"]]
    assert set(EXAMPLES[name][1]) <= set(checked)
    assert any(re.search(r"#L\d+$", c) for c in checked), "sampled lines were checked beside the keys"
    problems = await views.reader_problems(name, slug)
    assert problems["count"] == before + sum(n for *_, n in BROKEN[name]), problems
    assert not rep["coverage"]["not_shown"]["count"] and rep["coverage"]["derived"], "every file is read, and what the reader made is listed"


async def _every_answer(name: str, slug: str) -> list:
    """What the example's page fetches, over every place: each Timeline event in full, each session's transcript and
    the runs and sessions compared, each Repository tab and unit."""
    call = functools.partial(views.reader_call, name, slug, "records")
    if name == "timeline":
        rows = (await call({"op": "overview"}))["cols"]["r"]
        return [{"ref": got["ref"], **got["record"]} for got in [await call({"op": "record", "r": r}) for r in rows]]
    if name == "linked-sessions":
        ov = await call({"op": "overview"})
        out = [await call({"op": "session", "id": s["id"]}) for s in ov["sessions"]]
        for s in ov["sessions"]:
            out += [await call({"op": "moment", "run": s["run"], "t": c["time"], "session": s["id"]})
                    for c in ov["calls"] if c["session"] == s["id"]][:3]
        return [*out, ov, await call({"op": "compare", "ids": [r["id"] for r in ov["runs"]]}),
                await call({"op": "compare", "ids": [s["id"] for s in ov["sessions"]][:6]})]
    out = []
    for tab in ("pulls", "issues", "discussions", "agents"):
        got = await call({"op": "view", "tab": tab, "runs": ["r1", "r2", "r3", "r4"], "compare": True})
        out += [got, *[await call({"op": "unit", "key": it["key"]}) for it in got["items"]]]
    return out


@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_every_record_a_worked_example_serves_lists_the_fields_its_lines_do_not_hold(name, samples, inproc, bound,
                                                                                         monkeypatch):
    """The derived check over every record the example's reader answers, not only the checks' sample: each field whose
    values the cited lines do not hold is in view.json's records."""
    monkeypatch.setattr(views, "DERIVED_SAMPLE", 100_000)
    slug = _save_example(name)
    declared = {k for d in views.read_view(name, slug)["derived"] for k in (d["field"], d.get("key")) if k}
    answers = await _every_answer(name, slug)
    seen: dict = {}
    views._answer_records(answers, seen)
    assert len(seen) > 100, "the answers hold the example's records"
    assert not views.unlisted_derived(name, [{"answers": answers}], declared)


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


FIT_HTML = """<!doctype html><html><head><style>body{font:13px sans-serif;margin:8px}</style></head><body>
<div style="position:relative;height:40px"><span style="position:absolute;left:0;top:0">Overlapping label one</span>
<span style="position:absolute;left:12px;top:2px">Second label here</span></div>
<div style="width:60px;overflow:hidden;white-space:nowrap">A text far too long for its box</div>
<div style="width:300px">Narrow column</div>
<div style="width:120px;overflow-x:auto;white-space:nowrap">Lanes that run on past their box</div>
<button id="more">Show more</button><div id="extra" hidden data-anchor="board.jsonl#L2">bo: Anyone have the build number?</div>
<div style="height:2000px"></div><div data-anchor="board.jsonl#L3">cy: Confirmed</div>
<script>
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
    views.write_view(CORPUS, "fit", reader=THREADS_READER, html=FIT_HTML, **{**VIEW, "name": "Fit"})
    plain, clicked = await views.shoot_states(CORPUS, "fit", [
        {"open": {}, "size": views.PANE_WIDE}, {"open": {}, "actions": ["Show more", "No such control"]}])
    assert plain["ok"] and clicked["ok"], (plain["errors"], clicked["errors"])
    lay = plain["layout"]
    assert lay["overlaps"] == 1 and lay["pairs"][0] == ["Overlapping label one", "Second label here"], lay
    assert lay["cut"] == 1 and lay["cuts"] == ["A text far too long for its box"], lay
    assert lay["width"] == views.PANE_WIDE[0] and lay["used"] < views.WIDE_USED * lay["width"] and not lay["overflow"]
    assert lay["sideways"] == 1 and lay["wide"] == ["Lanes that run on past their box"], lay
    assert (lay["anchored"], lay["outside"]) == (1, 1), "the record far below the pane is out of view"
    assert "Show more" in plain["controls"]
    assert plain["shown"]["records"] == 1 and clicked["shown"]["records"] == 2, "the click showed the hidden record"
    assert clicked["actions"] == [{"control": "Show more", "found": True}, {"control": "No such control", "found": False}]
    notes = views.layout_notes([{**plain, "state": "wide"}])
    assert len(notes) == 1 and "overlaps other text in 1 place," in notes[0] and "rest of the pane is empty" in notes[0]



async def test_the_headless_page_waits_for_a_slow_answer_and_its_run_gets_the_time_the_answer_took(ws, inproc, bound,
                                                                                                monkeypatch):
    """A view's data call has no time limit, so a fetch the reader takes long to answer is waited for: the run's own
    time grows by the time its answers take, and the page is measured once the answer is in."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    views.write_view(CORPUS, "threads", reader=THREADS_READER, html=THREADS_HTML, **VIEW)
    real = views.reader_call

    async def slow(*a, **k):
        await asyncio.sleep(8)
        return await real(*a, **k)

    monkeypatch.setattr(views, "reader_call", slow)
    monkeypatch.setattr(views, "SHOT_TIMEOUT_S", 4.0)
    monkeypatch.setattr(views, "SHOT_STATE_S", 1.0)
    (s,) = await views.shoot_states(CORPUS, "threads", [{"open": {}}])
    assert s["ok"] and s["fetches"] == 1, s["errors"]


UNMARKED_HTML = """<!doctype html><html><head><style>body{font:13px sans-serif;margin:8px}</style></head><body>
<div data-anchor="board.jsonl#L7" style="padding-left:8px">seven</div>
<div data-anchor="board.jsonl#L14" data-anchor-unmarked style="padding-left:8px">fourteen, in the label's colour</div>
<div data-anchor="board.jsonl#L3" style="padding-left:8px">three</div>
<div data-anchor="notes.pdf#p2" style="padding-left:8px">a page</div>
<script>thimble.onOpen(() => {})</script></body></html>"""


async def test_a_record_the_page_marks_itself_is_not_held_to_thimble_s_mark(ws, inproc, bound):
    """An element with data-anchor-unmarked draws the labels' colours itself, so the bridge gives it no bar and the
    checks count its record as shown but do not look for the bar on it; the picture then looks for the label's colour
    on the element, which this page does not draw. A record of a file other than a line, such as a PDF's page, counts
    as shown too."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    views.write_view(CORPUS, "unmarked", reader=THREADS_READER, html=UNMARKED_HTML, **{**VIEW, "name": "Unmarked"})
    (s,) = await views.shoot_states(CORPUS, "unmarked", [{"open": {}, "labels": views.probe_context()}])
    assert s["ok"], s["errors"]
    assert s["shown"]["records"] == 4 and s["shown"]["due"] == s["shown"]["drawn"] >= 1, s["shown"]
    assert s["painted"]["unseen"] == ["board.jsonl#L14"] and s["painted"]["seen"] == 1, s["painted"]


ROWS = "".join(f'<tr data-anchor="board.jsonl#L{n}"{{own}}><td>post {n}</td><td>by someone</td></tr>' for n in range(1, 30))
MARK_PAGES = {  # name: (style, extra attribute on each row, script), and whether the test label's colour shows
    "compact table in a box that scrolls sideways, at the pane's edge": (
        "body{margin:0} .wrap{overflow-x:auto} td{padding:4px}", "", "", True),
    "rows with no left padding at the pane's edge": ("body{margin:0} td{padding:4px 4px 4px 0}", "", "", True),
    "the page turns the bar off": ("td{padding:10px} #t tr,#t td{box-shadow:none!important}", "", "", False),
    "rows that draw no colour of their own": ("td{padding:10px}", " data-anchor-unmarked", "", False),
    "rows that scroll under a sticky header, which are not in view": (
        "body{margin:0} .wrap{height:400px;overflow:auto} td{height:20px;padding:0 0 0 8px}"
        " th{position:sticky;top:0;height:60px;background:#fff}", "",
        "const h = document.getElementById('t').createTHead().insertRow(); h.innerHTML = '<th>post</th><th>by</th>';"
        " document.querySelector('.wrap').scrollTop = 150", True),
    "rows under a clear layer that takes the pointer, which are in view, with the bar turned off": (
        "td{padding:10px} #t tr,#t td{box-shadow:none!important} .cover{position:fixed;inset:0;z-index:5}", "",
        "document.body.insertAdjacentHTML('beforeend', '<div class=cover></div>')", False),
    "rows that draw the label's colour themselves": (
        "td{padding:10px}", " data-anchor-unmarked",
        "const paint = () => { for (const r of document.querySelectorAll('tr')) { const m = thimble.markOf(r.dataset.anchor);"
        " r.firstChild.style.background = m ? m.bar : '' } }; thimble.onMarks(paint); paint()", True),
}


@pytest.mark.parametrize("name", sorted(MARK_PAGES))
async def test_the_checks_look_for_the_label_s_colour_in_a_picture_of_the_page(name, ws, inproc, bound):
    """The checks count a mark only where a picture of the page shows the test label's colour on the record: a bar a
    box hiding overflow would cut is drawn inside the row, and a page that turns the bar off, or an element marked
    data-anchor-unmarked that draws no colour, fails. A row the list scrolls under a sticky header is not in view, so
    it is not looked at, but a row under a clear layer, such as one that catches a chart's zoom, is."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    style, own, script, seen = MARK_PAGES[name]
    legend = ("thimble.onLabels((s) => { document.getElementById('labs').innerHTML = (s.all || [])"
              ".map((l) => `<span data-label=\"${l.id}\">${l.name}</span>`).join('') })")
    html = (f"<!doctype html><html><head><style>body{{font:13px sans-serif}} table{{border-collapse:collapse}} {style}"
            f"</style></head><body><div id=labs></div><div class=wrap><table id=t>{ROWS.replace('{own}', own)}</table></div>"
            f"<script>thimble.onOpen(() => {{}}); {legend}; {script}</script></body></html>")
    views.write_view(CORPUS, "rows", reader=THREADS_READER, html=html, **{**VIEW, "name": "Rows"})
    (s,) = await views.shoot_states(CORPUS, "rows", [{"open": {}, "labels": views.probe_context(), "size": views.PANE_NARROW}])
    assert s["ok"], s["errors"]
    view = views.read_view(CORPUS, "rows")
    problems, _ = views.label_problems(view, [("board.jsonl", 100, 0)], [{**s, "state": "overview"}])
    p = s["painted"]
    assert p["due"] == 4 and p["checked"] >= 2, p
    if seen:
        assert p["seen"] == p["checked"] and problems == [], (p, problems)
    else:
        n = p["checked"]
        assert p["seen"] == 0 and len(problems) == 1, (p, problems)
        assert f"does not show the test label's colour on {n} of the {n}" in problems[0], problems

async def test_the_end_to_end_test_s_fixture_view_passes_the_checks(workspaces_tmp, tmp_path, monkeypatch, inproc, bound):
    """scripts/e2e/fixture-view, the view the release test opens with a label on, passes the whole check as the tab in
    Files it is there: its rows are anchored as units, so the test label marks them, and it draws its own label
    switches."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    corpus = tmp_path / "data" / "e2e"
    (corpus / "agents").mkdir(parents=True)
    for i in range(3):
        rows = [json.dumps({"type": "message" if n % 3 else "tool", "text": f"post {n} about the forge"}) for n in range(12)]
        (corpus / "agents" / f"agent-{i}.jsonl").write_text("\n".join(rows) + "\n" + ("{torn\n" if i == 2 else ""))
    (corpus / "manifest.json").write_text(json.dumps({"name": "e2e", "description": "agents' posts"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    fixture = config.REPO_ROOT / "scripts" / "e2e" / "fixture-view"
    raw = json.loads((fixture / "view.json").read_text("utf-8"))
    views.write_view("e2e", "record-counts", reader=(fixture / "reader.py").read_text("utf-8"),
                     html=(fixture / "view.html").read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "claims", "accepts", "units", "derived", "libs", "unit")})
    assert not views.file_type_viewer(views.read_view("e2e", "record-counts"))
    rep = await views.check("e2e", "record-counts", ["view:record-counts/agents/agent-1.jsonl"], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    shown = rep["shots"][0]["shown"]
    assert shown["units"] == 3 and shown["due"] == shown["drawn"] == 3, shown
    assert rep["shots"][0]["painted"]["seen"] == 3, rep["shots"][0]["painted"]
    assert rep["shots"][0]["label_controls"] == 1, rep["shots"][0]


SELF_LABEL_HTML = """<!doctype html><html><head><style>body{font:13px sans-serif;margin:8px}</style></head><body>
<button id="on" data-label="asks">Turn on asks</button><div data-anchor="board.jsonl#L1">one</div>
<script>
thimble.onOpen(() => {})
thimble.setLabel('asks', true).catch(() => {})
setTimeout(() => thimble.setFilter('asks', 'yes').catch(() => {}), 300)
document.getElementById('on').onclick = () => thimble.setLabel('asks', true).catch(() => {})
</script></body></html>"""


async def test_a_page_that_changes_labels_by_itself_fails_the_checks_and_a_click_does_not(ws, inproc, bound):
    """A view may draw label controls of its own, but a label call it makes on load or on a timer is refused, and the
    checks name the calls as a problem; the same call from a control the analyst clicks is not counted."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    views.write_view(CORPUS, "selfish", reader=THREADS_READER, html=SELF_LABEL_HTML, **{**VIEW, "name": "Selfish"})
    plain, clicked = await views.shoot_states(CORPUS, "selfish", [{"open": {}}, {"open": {}, "actions": ["Turn on asks"]}])
    assert plain["ok"] and clicked["ok"], (plain["errors"], clicked["errors"])
    assert plain["self_labels"] == ["on", "filter"], plain["self_labels"]
    assert clicked["actions"] == [{"control": "Turn on asks", "found": True}]
    assert clicked["self_labels"] == ["on", "filter"], "the click's call is the analyst's"
    (problem,) = views.self_label_problems([plain])
    assert "`thimble.setLabel`, `thimble.setFilter`" in problem and "2 label calls by itself" in problem
    assert views.self_label_problems([{**plain, "self_labels": []}]) == []


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
