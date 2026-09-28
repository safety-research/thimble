"""app.views: viewers written for how a corpus arranges its records. The reader resolves lines and keys, the frame
document blocks every host, and the worked examples a view ticket reads pass the view checks over their own samples, one
of them with its page loaded headless.

A temp DATA_DIR holds the corpus `boards`: `board.jsonl`, one post per line, each {thread, author, time, body}, and
`notes.md`. The `ws` fixture saves the view `threads`, whose reader (THREADS_READER) groups the posts by thread: it
accepts `board.jsonl#L<n>` (the post) and declares `view:threads/<thread>` (a whole thread). Most tests run the reader
in this process (the `inproc` fixture replaces views._runner with an exec of the same snippet the kernel gets)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
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
    threads, lines = {}, {}
    for path in paths:
        with open(path) as f:
            for n, line in enumerate(f, 1):
                r = json.loads(line)
                threads.setdefault(r["thread"], []).append([path, n, r["author"], r["body"]])
                lines[f"{path}#L{n}"] = r["thread"]
    return {"threads": threads, "lines": lines}


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

VIEW = dict(name="Threads", why="The board's posts grouped by thread.", claims=["board.jsonl"],
            accepts=[{"form": "L<n>", "means": "one post"}], declares=[{"form": "<thread>", "means": "one whole thread"}],
            default=True, libs=[])


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
    # the index is cached by the files' fingerprint, beside the view
    assert list((ws / "views" / "threads" / "cache").glob("*.index.pickle"))


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


# ------------------------------------------------------------------------------------------------- worked examples
#
# plugin/viewers/linked-sessions, incident-timeline and repository are the worked examples a view ticket's session
# reads (prompts/dev-view.md). Each ships an invented sample of the files it claims under sample/, and passes over it
# the checks a view a session writes must pass. Each sample is copied into the temp DATA_DIR as a corpus named after
# its example.

# the example, the slug it is saved under, and a key of each kind it declares
EXAMPLES = {
    "incident-timeline": ("incident-timeline", ["view:incident-timeline/INC-312",
                                                "view:incident-timeline/2026-05-16T08:00..2026-05-16T09:00"]),
    "repository": ("repository", ["view:repository/r1/pull/11", "view:repository/r3", "view:repository/r2/issues/6",
                                  "view:repository/r3/discussions/2", "view:repository/r4/agents/moss"]),
    "linked-sessions": ("linked-sessions", ["view:linked-sessions/r1", "view:linked-sessions/a07a4da7"]),
}


@pytest.fixture()
def samples(workspaces_tmp, tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    for name in EXAMPLES:
        shutil.copytree(views.EXAMPLES_DIR / name / "sample", d / name)
        (d / name / "manifest.json").write_text(json.dumps({"name": name, "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d.resolve()


def _save_example(name: str) -> str:
    """Save the worked example `name` as a view of its sample, as a session writes one; returns its slug."""
    d = views.EXAMPLES_DIR / name
    raw = json.loads((d / "view.json").read_text("utf-8"))
    slug = EXAMPLES[name][0]
    views.write_view(name, slug, reader=(d / "reader.py").read_text("utf-8"), html=(d / "view.html").read_text("utf-8"),
                     **{k: raw[k] for k in ("name", "why", "claims", "accepts", "declares", "default", "libs")})
    return slug


# per example, lines a sample file gets appended that its reader must report rather than fail on: (file, text, problems
# they add)
BROKEN = {
    "incident-timeline": [("agents.log", '2026-05-16T05:00:00Z INFO autoheal action=scan result=ok msg="matched \\d+"\n', 1),
                          ("deploys.csv", '2026-05-16T03:10:00+01:00,dep-90,started,api,1.2.0,ops,,,"two\nlines"\n', 0)],
    "repository": [("runs/r3/export/comments.csv", '4,hazel,2026-05-20T10:00:00,"Repro:\n2 failures"\n', 0),
                   ("runs/r2/manifest.json", "{", 1)],
    "linked-sessions": [("runs/r1/sessions-index.json", "not json", 1)],
}


@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_every_worked_example_answers_the_checks_over_its_sample(name, samples, inproc, bound, tmp_path, monkeypatch):
    """The reader's half of the checks: the index builds, the sampled lines and the declared keys resolve, each answer
    cites its place back, and every excerpt is literal text of the records it cites. The page's half is a test below.
    Lines that do not parse, a CSV cell over two lines among them, are reported (reader_problems) rather than failing."""
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0, "records": 1} for _ in states]

    monkeypatch.setattr(views, "shoot_states", no_page)
    slug = _save_example(name)
    before = (await views.reader_problems(name, slug))["count"]
    for rel, text, _ in BROKEN[name]:
        path = samples / name / rel
        old = "" if rel.endswith(".json") else path.read_text("utf-8")
        path.write_text(old + ("\n" if old and not old.endswith("\n") else "") + text, "utf-8")
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    checked = [r["locator"] for r in rep["checks"]]
    assert set(EXAMPLES[name][1]) <= set(checked)
    assert any(re.search(r"#L\d+$", c) for c in checked), "sampled lines were checked beside the keys"
    problems = await views.reader_problems(name, slug)
    assert problems["count"] == before + sum(n for *_, n in BROKEN[name]), problems


@pytest.mark.parametrize("name", ["repository"])
async def test_every_worked_example_s_page_loads_headless_at_its_first_place(name, samples, inproc, bound, tmp_path):
    """The whole check a view ticket's session runs, the headless page included, where this machine has Node and the
    frontend's packages with their Chromium (scripts/check.sh install)."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)  # CI installs them, so there the page is always loaded
        pytest.skip(why)
    slug = _save_example(name)
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    assert rep["page"]["fetches"] >= 1 and Path(rep["page"]["png"]).is_file()
    assert not views.unmarked(rep["page"]), "the records a worked example shows carry their file refs, for the labels"
