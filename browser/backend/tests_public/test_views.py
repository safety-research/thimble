"""app.views: viewers written for how a corpus arranges its records. A view's reader resolves lines and keys, and the
frame document a view's page loads in blocks every load from the network before any script.

A temp DATA_DIR holds the corpus `boards`: `board.jsonl`, one post per line, each {thread, author, time, body}, and
`notes.md`. The `ws` fixture saves the view `threads`, whose reader (THREADS_READER) groups the posts by thread: it
accepts `board.jsonl#L<n>` (the post) and gives the unit `view:threads/<thread>` (a whole thread). The reader runs in
this process (the `inproc` fixture replaces views._runner with an exec of the same snippet the kernel gets)."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import sys
from pathlib import Path

import pytest

from app import config, views

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
        return {"excerpt": "\\n".join(b for _, _, _, b in posts), "label": f"thread {locator['key']}",
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
    views._derived_kept.clear()
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


async def test_a_reader_resolves_a_line_and_a_key_and_its_answer_is_kept(ws, inproc):
    post = await views.resolve_locator(CORPUS, "threads", {"path": "board.jsonl", "fragment": "L3"})
    assert post == {"excerpt": "Confirmed: 4127 tests pass.\n-- cy", "label": "cy", "refs": ["board.jsonl#L3"], "key": "t1",
                    "target": {"thread": "t1", "line": 3}}
    thread = await views.resolve_locator(CORPUS, "threads", {"key": "t1"})
    assert thread["refs"] == ["board.jsonl#L1", "board.jsonl#L3", "board.jsonl#L5"]
    assert await views.resolve_locator(CORPUS, "threads", {"path": "board.jsonl", "fragment": "L99"}) is None
    kept = views.key_refs(CORPUS)["view:threads/t1"]
    assert kept["refs"] == thread["refs"] and kept["name"] == "Threads"
    assert await views.reader_call(CORPUS, "threads", "records", {"thread": "t2"}) == [
        {"ref": "board.jsonl#L2", "author": "bo", "body": "Anyone have the build number?"},
        {"ref": "board.jsonl#L4", "author": "ada", "body": "The build is 3316."}]


@pytest.fixture()
async def bound():
    """The test's loop is the one reader calls run on, as the server's is (views._lifespan)."""
    views._bind_loop()
    yield


async def test_a_builder_s_draft_check_of_a_view_over_many_files_reads_a_sample_and_finish_view_s_gate_reads_them_all(
        ws, inproc, bound, monkeypatch):
    """A view of thousands of files on a slow drive took minutes a check, each check reading every file through the
    reader: a builder's draft check (view_check) reads DRAFT_FILES of them, spread over the claimed folders and kinds
    of file, with each file a locator names, and says so; the gates of record (finish_view) read every one."""
    async def no_page(c, slug, states, **_kw):
        return [{"ok": True, "errors": [], "fetches": 0} for _ in states]

    monkeypatch.setattr(views, "shoot_states", no_page)
    monkeypatch.setattr(views, "DRAFT_FILES", 6)
    corpus = config.corpus_dir(CORPUS)
    for day in ("day-1", "day-2"):
        (corpus / "logs" / day).mkdir(parents=True)
        for n in range(1, 11):
            (corpus / "logs" / day / f"part-{n:02d}.jsonl").write_text(
                json.dumps({"thread": f"t{n}", "author": "ada", "time": "2026-06-01T10:00:00Z", "body": day}) + "\n")
    read: list[int] = []
    reader = THREADS_READER.replace("def build_index(paths):", "def build_index(paths):\n    READ.append(len(paths))")
    monkeypatch.setitem(__builtins__ if isinstance(__builtins__, dict) else vars(__builtins__), "READ", read)
    views.write_view(CORPUS, "logs", name="Logs", description="The logs.", claims=["logs/**/*.jsonl"],
                     accepts=VIEW["accepts"], reader=reader, html=THREADS_HTML)
    named = "logs/day-2/part-07.jsonl#L1"
    files, of = views.draft_files(CORPUS, views.read_view(CORPUS, "logs"), [named])
    assert of == 20 and len(files) == 6 and "logs/day-2/part-07.jsonl" in [f[0] for f in files]
    assert {f[0].split("/")[1] for f in files} == {"day-1", "day-2"}, "a sample of each folder"
    read.clear()
    out = await views.check_answer(CORPUS, "logs", [named], picture=False)
    assert max(read) == 6, read  # and the checks' run on a copy with one of them missing
    assert any(ln.startswith("index: 6 of the 20 files the view claims, a sample") for ln in out["lines"])
    read.clear()
    rep = await views.gate(CORPUS, "logs", [named])
    assert max(read) == 20 and rep["index"]["files"] == 20 and "of" not in rep["index"]


async def test_a_check_tries_the_choices_and_a_damaged_copy_only_once_the_rest_passes_and_then_both_at_once(
        ws, inproc, bound, monkeypatch):
    """The choices of a view's controls and its run on a damaged copy took most of a check's time, and a check a
    locator had failed paid for both, though neither could count before the locator opened: a check that fails loads
    the page in its five states alone and notes the two checks that are left, and one that passes so far runs the
    two at the same time."""
    runs: list[tuple[list[dict], dict]] = []
    both = asyncio.Event()

    def last(states, kw) -> bool:
        return any(s.get("sweep") for s in states) or kw.get("prepared") is not None

    async def page(c, slug, states, **kw):
        runs.append((states, kw))
        if last(states, kw):
            if sum(1 for r in runs if last(*r)) == 2:
                both.set()
            await asyncio.wait_for(both.wait(), 5)  # each of the two waits here until the other has begun
        return [{"ok": True, "errors": [], "fetches": 0, **({"choices": []} if s.get("sweep") else {})} for s in states]

    monkeypatch.setattr(views, "shoot_states", page)
    failed = await views.gate(CORPUS, "threads", ["board.jsonl#L99"])
    lines = views.gate_lines(failed)
    assert not failed["ok"] and views.first_failure(failed).startswith("bad board.jsonl#L99")
    assert [(len(states), last(states, kw)) for states, kw in runs] == [(len(views.CHECK_STATES), False)]
    assert [ln for ln in lines if ln.startswith("page: ")] == [f"page: {state}, 0 records and 0 units shown"
                                                               + (", 0 of the 0 the test label marks drawn marked"
                                                                  if state in views.LABELLED_STATES else "")
                                                               + (", 0 records shown that the filter drops"
                                                                  if state == "filtered" else "")
                                                               for state in views.CHECK_STATES]
    assert lines.count("note: " + views.CHECKS_LEFT) == 1
    runs.clear()
    passed = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    lines = views.gate_lines(passed)
    assert passed["ok"], lines
    assert [(len(states), last(states, kw)) for states, kw in runs] == [(len(views.CHECK_STATES), False), (1, True), (1, True)]
    assert sorted((any(s.get("sweep") for s in states), kw.get("prepared") is not None) for states, kw in runs[1:]) == [
        (False, True), (True, False)]
    assert [s["state"] for s in passed["shots"]] == [*views.CHECK_STATES, "choices"]
    assert "page: choices, 0 records and 0 units shown" in lines and not any(views.CHECKS_LEFT in ln for ln in lines)


def test_a_view_s_page_loads_in_a_frame_that_blocks_every_host_before_any_script(ws, tmp_path, monkeypatch):
    # the built interface's chart drawing (views.KIT_CHART_JS), a stand-in, so the count does not hang on a build
    (tmp_path / "dist" / "kit").mkdir(parents=True)
    (tmp_path / "dist" / views.KIT_CHART_JS).write_text("window.__thimbleCharts = {}")
    monkeypatch.setattr(config, "FRONTEND_DIST", tmp_path / "dist")
    doc = views.frame_document(views.read_view(CORPUS, "threads"))
    assert doc.lower().startswith("<!doctype html>")
    csp = doc.index("Content-Security-Policy")
    assert csp < doc.index("<script") and "default-src 'none'" in doc and "connect-src 'none'" in doc
    assert "window.thimble" in doc and '"slug": "threads"' in doc
