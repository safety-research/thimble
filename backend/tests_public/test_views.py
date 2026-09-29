"""app.views: viewers written for how a corpus arranges its records. The reader resolves lines and keys, the frame
document blocks every load, and the worked examples a view ticket reads pass the view checks over their own samples, one
of them with its page loaded headless.

A temp DATA_DIR holds the corpus `boards`: `board.jsonl`, one post per line, each {thread, author, time, body}, and
`notes.md`. The `ws` fixture saves the view `threads`, whose reader (THREADS_READER) groups the posts by thread: it
accepts `board.jsonl#L<n>` (the post) and declares `view:threads/<thread>` (a whole thread). Most tests run the reader
in this process (the `inproc` fixture replaces views._runner with an exec of the same snippet the kernel gets)."""
from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import io
import json
import os
import re
import shutil
import sys
import tracemalloc
from pathlib import Path

import pytest

from app import config, extensions, views

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
# (prompts/dev-view.md), and the Swarm extension's view (extensions/swarm) is checked as one. Each ships an invented sample of the files it claims under sample/, and passes
# over it the checks a view a session writes must pass. Each sample is copied into the temp DATA_DIR as a corpus named
# after its example.

# the example, the slug it is saved under, and a key of each kind it declares
EXAMPLES = {
    "incident-timeline": ("incident-timeline", ["view:incident-timeline/INC-312",
                                                "view:incident-timeline/2026-05-16T08:00..2026-05-16T09:00"]),
    "repository": ("repository", ["view:repository/r1/pull/11", "view:repository/r3", "view:repository/r2/issues/6",
                                  "view:repository/r3/discussions/2", "view:repository/r4/agents/moss"]),
    "linked-sessions": ("linked-sessions", ["view:linked-sessions/r1", "view:linked-sessions/a07a4da7"]),
    "swarm": ("swarm", ["view:swarm/agent/lamplighter", "view:swarm/place/Night-14/Schedule"]),
}


def _example_dir(name: str) -> Path:
    return extensions.builtin_dir() / "swarm" / "views" / "swarm" if name == "swarm" else views.EXAMPLES_DIR / name


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
    "swarm": [("roster.csv", 'nightjar,"Watch the\nweather",2026-04-11\n', 0),
              ("chat/help-desk.jsonl", '{"id": "m109", "te\n', 1)],
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
    for label in json.loads((_example_dir(name) / "labels.json").read_text("utf-8")):
        pattern = re.compile(label["spec"])
        over = [p for p in files if any(fnmatch.fnmatchcase(p.relative_to(root).as_posix(), g) for g in label["paths"])]
        assert any(pattern.search(line) for p in over for line in p.read_text("utf-8").splitlines()), label["name"]
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


@pytest.mark.parametrize("name", ["repository", "swarm"])
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


async def test_the_swarm_view_draws_as_cards_the_records_a_label_marks_with_the_links_they_carry(samples, inproc, bound):
    """With no label on, the Swarm view opens on the records where accounts answer or name each other. A question from
    it is answered with labels, and the chart is what they mark: a regex label over the sample's chat and wiki marks the
    records about the gain, and once it is on the chart's cards are exactly those records in event order, coloured by
    the label's value, with a reply the chat carries and the save before on the same page as links; a save that changed
    one value reads as that change."""
    from app import concepts

    slug = _save_example("swarm")
    first = await views.reader_call("swarm", slug, "records", {"op": "chart"})
    assert first["source"] == "addressed" and [p["name"] for p in first["places"]] == ["help-desk", "Night-14/Schedule"]
    s = await concepts.apply_scoped("swarm", scope="files", name="gain", kind="regex", text=r"(?i)\bgain\b|1\.84|1\.48",
                                    values=["about the gain", "other"], paths=["chat/*.jsonl", "wiki/pages/**/*.jsonl"],
                                    limit=None, comment=False, filter=False, created_by="test", chat=None, group=None, card=False)
    await concepts.wait_apply("swarm", s["concept"], 60)
    marked = {r["ref"] for r in concepts.read_labels(config.WORKSPACES_DIR / "swarm", s["concept"]) if r["label"] == "about the gain"}
    assert "wiki/pages/Calibration/Gain.jsonl#L4" not in marked  # a regex reads a save as what it changed: a replay, nothing
    marked -= {"chat/help-desk.jsonl#L8"}  # a post sent twice
    concepts.show_concept("swarm", s["concept"], True)
    views._memo.clear()
    chart = await views.reader_call("swarm", slug, "records", {"op": "chart"})
    assert chart["source"] == "labels" and {c["ref"] for c in chart["cards"]} == marked
    assert [c["id"] for c in chart["cards"]] == list(range(1, len(marked) + 1))
    assert all(c["m"] == 0 for c in chart["cards"]) and chart["marks"][0]["value"] == "about the gain"
    types = {x["type"] for x in chart["links"]}
    assert {"reply", "same place"} <= types, chart["links"]
    assert any(c["line"] == "1.84 → 1.48" for c in chart["cards"]), [c["line"] for c in chart["cards"]]


async def test_the_swarm_overview_counts_every_record_and_lists_a_cells_records(samples, inproc, bound):
    """The Swarm view's overview counts every record it reads, per account and per place across time bins; a zoomed
    window counts only its records, and a cell's listing holds the records the cell counts."""
    slug = _save_example("swarm")
    ov = await views.reader_call("swarm", slug, "records", {"op": "overview", "bins": 40})
    total = ov["counts"]["records"]
    assert ov["chosen"]["shown"] == total and sum(r["n"] for r in ov["accounts"]) + (ov["accounts_rest"] or {"n": 0})["n"] == total
    assert sum(r["n"] for r in ov["places"]) + (ov["places_rest"] or {"n": 0})["n"] == total
    row = ov["accounts"][0]
    cell = max(row["cells"], key=lambda c: c["n"])
    q = {"op": "bin", "accounts": [row["name"]]}
    if cell["b"] < ov["bins"]:
        q |= {"from": ov["start"] + cell["b"] * ov["step"], "to": ov["start"] + (cell["b"] + 1) * ov["step"]}
    else:
        q |= {"untimed": True}
    got = await views.reader_call("swarm", slug, "records", q)
    assert got["total"] == cell["n"] and {r["account"] for r in got["records"]} == {row["name"]}
    lo, hi = ov["window"]
    mid = lo + (hi - lo) / 2
    zoomed = await views.reader_call("swarm", slug, "records", {"op": "overview", "from": lo, "to": mid})
    assert zoomed["zoomed"] and 0 < zoomed["chosen"]["shown"] < total


async def test_a_save_that_only_re_encodes_its_page_changes_nothing_on_the_swarm_view(samples, inproc, bound):
    """A wiki that re-encodes a page's text on each save ("é" read back as "Ã©") changes lines no one edited: such a
    save reads as changing nothing and names no one, while a save that changes only non-ASCII text reads as that
    change."""
    d = samples / "wiki"
    d.mkdir()
    page = ["Plan for the café night", "I will bring the café tests. -- ann"]
    moji = [s.encode("utf-8").decode("latin-1") for s in page]
    saves = [("ann", page), ("bo", moji), ("cy", [*moji, "状态：测试已完成"]), ("dee", [*moji, "状态：测试失败了"])]
    (d / "pages.jsonl").write_text("".join(json.dumps({"page": "Plan", "rev": i, "user": u, "ts": f"2026-04-14T2{i}:00:00Z",
                                                        "text": "\n".join(t)}, ensure_ascii=False) + "\n"
                                           for i, (u, t) in enumerate(saves, 1)), "utf-8")
    (d / "manifest.json").write_text(json.dumps({"name": "wiki", "description": "a wiki"}))
    src = _example_dir("swarm")
    raw = json.loads((src / "view.json").read_text("utf-8"))
    views.write_view("wiki", "swarm", reader=(src / "reader.py").read_text("utf-8"), html=(src / "view.html").read_text("utf-8"),
                     **{**{k: raw[k] for k in ("name", "why", "accepts", "declares", "default", "libs")}, "claims": ["pages.jsonl"]})
    refs = [f"pages.jsonl#L{n}" for n in range(1, 5)]
    chart = await views.reader_call("wiki", "swarm", "records", {"op": "chart", "keep": refs})
    line = {c["ref"]: c["line"] for c in chart["cards"]}
    assert line["pages.jsonl#L2"] == "Changed only spacing or encoding", line
    assert line["pages.jsonl#L4"] == "状态：测试已完成 → 状态：测试失败了", line
    assert not [x for x in chart["links"] if x["type"] == "names"], chart["links"]


async def test_the_swarm_extension_installs_its_view_where_it_applies_outside_the_orientations_four(samples, inproc, bound):
    """The Swarm view is opt-in: thimble proposes it nowhere until the Swarm extension is added. Added, it runs on a
    corpus where many accounts act on pages they share and name each other, installed at once claiming the files that
    hold their actions, outside the orientation's four, and once deleted is not installed again; on the worked
    examples' samples, a small team's, it does not run."""
    d = samples / "big-swarm"
    d.mkdir()
    rows = [{"page": f"p{i % 4}", "user": f"bot{i % 35}", "text": f"Relay from bot{(i + 1) % 35}: the value is {i}."}
            for i in range(140)]
    (d / "saves.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (d / "manifest.json").write_text(json.dumps({"name": "big-swarm", "description": "a swarm"}))
    assert await views.propose_builtins("big-swarm") == []
    assert extensions.add("swarm", yes=True, say=lambda _: None) == "swarm"
    for name in EXAMPLES:
        assert not (await extensions.refresh(name))["extensions"]["swarm"]["active"], name
    assert (await extensions.refresh("big-swarm"))["extensions"]["swarm"]["active"]
    prop = views.read_proposal("big-swarm", "swarm")
    assert prop["extension"] == "swarm" and prop["orientation"] is False and prop["claims"] == ["saves.jsonl"]
    assert "35 accounts" in prop["why"] and views.orientation_views("big-swarm") == []
    assert views.read_view("big-swarm", "swarm")["ok"]
    views.delete_proposal("big-swarm", "swarm")
    await extensions.refresh("big-swarm")
    assert views.read_view("big-swarm", "swarm") is None  # one the analyst deleted is not installed again


async def test_whether_swarm_applies_is_read_from_the_head_of_a_big_csv(samples, inproc, bound):
    """Deciding whether the Swarm extension applies reads the first records of each file, so a big CSV that is no swarm
    costs little memory."""
    d = samples / "metrics"
    d.mkdir()
    with open(d / "metrics.csv", "w") as f:
        f.write("ts,host,metric,value,status\n" + "2026-05-16T08:00:00Z,web-1,cpu,0.93,ok\n" * 1_000_000)
    (d / "manifest.json").write_text(json.dumps({"name": "metrics", "description": "metrics"}))
    extensions.add("swarm", yes=True, say=lambda _: None)
    tracemalloc.start()
    try:
        assert not (await extensions.refresh("metrics"))["extensions"]["swarm"]["active"]
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < (d / "metrics.csv").stat().st_size / 2, peak
