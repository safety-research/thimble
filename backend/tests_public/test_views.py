"""app.views: viewers written for how a corpus arranges its records. The reader resolves lines and keys, the frame
document blocks every load, a view's media key reaches only its own media, the worked examples a view ticket reads pass
the view checks over their own samples, the headless page fails a page that changes labels by itself or loads a script by
its path, and a machine without the headless browser checks a view on its reader.

A temp DATA_DIR holds the corpus `boards`: `board.jsonl`, one post per line, each {thread, author, time, body}, and
`notes.md`. The `ws` fixture saves the view `threads`, whose reader (THREADS_READER) groups the posts by thread: it
accepts `board.jsonl#L<n>` (the post) and gives the unit `view:threads/<thread>` (a whole thread). Most tests run the
reader in this process (the `inproc` fixture replaces views._runner with an exec of the same snippet the kernel gets)."""
from __future__ import annotations

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


def test_the_frame_document_blocks_every_host_before_any_script(ws, tmp_path, monkeypatch):
    # the built interface's chart drawing (views.KIT_CHART_JS), a stand-in, so the count does not hang on a build
    (tmp_path / "dist" / "kit").mkdir(parents=True)
    (tmp_path / "dist" / views.KIT_CHART_JS).write_text("window.__thimbleCharts = {}")
    monkeypatch.setattr(config, "FRONTEND_DIST", tmp_path / "dist")
    doc = views.frame_document(views.read_view(CORPUS, "threads"))
    assert doc.lower().startswith("<!doctype html>")
    csp = doc.index("Content-Security-Policy")
    assert csp < doc.index("<script") and "default-src 'none'" in doc and "connect-src 'none'" in doc
    assert "window.thimble" in doc and '"slug": "threads"' in doc
    v = dict(views.read_view(CORPUS, "threads"), libs=views._libs(["vega-embed"]))
    with_libs = views.frame_document(v)
    if views.LIBS["vega"].is_file():
        assert with_libs.count("<script>") == 20, \
            "the view's name, the bridge, the kit's Color by, row controls, text, side panel, transcript, messages, " \
            "search, table, tree, diff, record viewer, chart drawing, charts and time range, vega, vega-lite, vega-embed " \
            "and the view's own"
    assert views._script_text("a</script>b") == "a<\\/script>b"
    assert views._libs(["vega-embed"]) == ["vega", "vega-lite", "vega-embed"]


PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da63646000"
                    "0000060002308150cf0000000049454e44ae426082")


@pytest.mark.real_read_guard
async def test_a_view_s_frame_loads_its_media_by_a_key_in_the_url_and_that_key_reaches_nothing_else(ws, inproc, bound):
    """The frame is sandboxed with an opaque origin, from which the browser sends no SameSite=Strict cookie, so the one
    URL it may load, its view's media route, carries the view's key in its path (hook_auth.media_key): the frame's
    policy and its media URL name that URL, the read guard lets it through with no cookie, Range included, and refuses
    another view's key, a made-up one and none. The page's own media route takes the cookie, as before, under the
    page's own path (hook_auth.browser_path); the frame's media URL is on the API's own path, with no browser's key."""
    import httpx  # noqa: PLC0415
    from conftest import UI_COOKIE_VALUE, _record_paired, browser_base  # noqa: PLC0415

    from app import hook_auth, main  # noqa: PLC0415

    (config.DATA_DIR / CORPUS / "shot.png").write_bytes(PNG)
    views.write_view(CORPUS, "shots", reader=THREADS_READER, html=THREADS_HTML,
                     **{**VIEW, "name": "Shots", "claims": ["board.jsonl", "shot.png"]})
    _record_paired(UI_COOKIE_VALUE)
    browser = f"browser:{hook_auth._sha(UI_COOKIE_VALUE)}"  # the key is bound to the browser that loads the frame
    key = hook_auth.media_key(CORPUS, "shots", browser)
    media = f"http://127.0.0.1:8300/api/ws/{CORPUS}/views/shots/media/{key}"
    base = f"/api/ws/{CORPUS}/views/shots/media"
    shot = {"path": "shot.png"}
    transport = httpx.ASGITransport(app=main.create_app())
    async with httpx.AsyncClient(transport=transport, base_url=browser_base("http://127.0.0.1")) as page, \
            httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as frame:
        page.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
        r = await page.get(f"/api/ws/{CORPUS}/views/shots/frame", params={"origin": "http://127.0.0.1:8300"})
        assert r.status_code == 200 and f"img-src data: blob: {media};" in r.text and f'"media": "{media}"' in r.text
        again = await page.get(f"/api/ws/{CORPUS}/views/shots/frame", params={"origin": "http://127.0.0.1:8300"})
        assert again.headers["etag"] == r.headers["etag"], "the key is the same for every load"
        got = await frame.get(f"{base}/{key}", params=shot)
        assert (got.status_code, got.content, got.headers["content-type"]) == (200, PNG, "image/png")
        part = await frame.get(f"{base}/{key}", params=shot, headers={"Range": "bytes=0-3"})
        assert (part.status_code, part.content) == (206, PNG[:4])
        assert (await frame.get(f"{base}/{key}", params={"path": "notes.md"})).status_code == 403, "claimed files only"
        for url in (f"{base}/{hook_auth.media_key(CORPUS, 'threads', browser)}", f"{base}/{'0' * 32}", f"{base}/x",
                    base):
            assert (await frame.get(url, params=shot)).status_code == 401, url
        assert (await frame.get(f"/api/ws/{CORPUS}/views/shots/frame")).status_code == 401
        assert (await page.get(base, params=shot)).content == PNG, "the page's own route, with the cookie"
        assert (await page.get(f"{base}/{'0' * 32}", params=shot)).status_code == 404, "the route checks the key too"


@pytest.mark.real_read_guard
async def test_a_view_s_media_key_works_only_while_the_browser_or_shot_that_loaded_the_frame_holds(ws, inproc, bound,
                                                                                                plugin_headers):
    """hook_auth.media_key is bound to who loaded the frame: a browser's key stops working when that browser is signed
    out (a sign-in notice's "Sign it out") and every browser's at `thimble unpair`; a shot's when its token ends; the
    CLI's when the server's token changes. Another browser's key is its own. The server log and a problem report show
    such a URL without its key."""
    import logging  # noqa: PLC0415

    import httpx  # noqa: PLC0415
    from conftest import UI_COOKIE_VALUE, UI_KEY_VALUE, _record_paired  # noqa: PLC0415

    from app import feedback, hook_auth, main  # noqa: PLC0415

    (config.DATA_DIR / CORPUS / "shot.png").write_bytes(PNG)
    views.write_view(CORPUS, "shots", reader=THREADS_READER, html=THREADS_HTML,
                     **{**VIEW, "name": "Shots", "claims": ["board.jsonl", "shot.png"]})
    other, other_key = "the-cookie-of-another-browser-in-this-test", "the-key-of-another-browser"
    _record_paired(UI_COOKIE_VALUE)
    _record_paired(other, other_key)
    frame_url = f"/api/ws/{CORPUS}/views/shots/frame"
    base = f"/api/ws/{CORPUS}/views/shots/media"
    shot = {"path": "shot.png"}
    transport = httpx.ASGITransport(app=main.create_app())

    def key_in(doc: str) -> str:
        return doc.split("/views/shots/media/", 1)[1][:32]

    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as c:
        async def frame_key(page: str = "", **kw) -> str:  # `page`: the browser's path the page asks under
            r = await c.get(page + frame_url, params={"origin": "http://127.0.0.1:8300"}, **kw)
            assert r.status_code == 200, r.text[:200]
            return key_in(r.text)

        async def works(key: str) -> bool:
            return (await c.get(f"{base}/{key}", params=shot)).status_code == 200

        mine = await frame_key(f"/b/{UI_KEY_VALUE}", headers={"cookie": f"{hook_auth.ui_cookie()}={UI_COOKIE_VALUE}"})
        theirs = await frame_key(f"/b/{other_key}", headers={"cookie": f"{hook_auth.ui_cookie()}={other}"})
        assert mine != theirs and await works(mine) and await works(theirs)
        assert hook_auth.sign_out(hook_auth._sha(UI_COOKIE_VALUE)[:12])
        assert not await works(mine), "signed out: its key is void"
        assert await works(theirs), "another browser's key is its own"
        hook_auth.unpair()
        assert not await works(theirs), "unpaired: every browser's key is void"
        tok = hook_auth.mint_shot()
        by_shot = await frame_key(headers={hook_auth.SHOT_HEADER: tok})
        assert await works(by_shot)
        hook_auth.drop_shot(tok)
        assert not await works(by_shot), "the shot's token ended"
        by_cli = await frame_key(headers=plugin_headers())
        assert await works(by_cli)
        from conftest import _record  # noqa: PLC0415

        _record(token="a-new-start-s-token")
        assert not await works(by_cli), "a new start's token"

    url = f"{base}/{mine}?path=shot.png"
    access = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5", "GET", url, "1.1", 401), None)
    assert main.HideMediaKeys().filter(access) and access.getMessage().endswith(
        f'"GET {base}/<key>?path=shot.png HTTP/1.1" 401') and mine not in access.getMessage()
    text, n = feedback.redact(f"INFO: 127.0.0.1:5 - \"GET {url} HTTP/1.1\" 401")
    assert n == 1 and mine not in text and "/media/[redacted:view-media-key]?path=shot.png" in text


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


SRC_HTML = """<!doctype html><html><head><script src="lib/marked/marked.min.js"></script></head><body>
<div data-anchor="board.jsonl#L1">one</div><script>thimble.onOpen(() => {})</script></body></html>"""


async def test_a_page_that_loads_a_script_by_its_path_fails_the_checks_as_the_browser_refuses_it(ws, inproc, bound):
    """Live check L31: a builder put `<script src="lib/marked/marked.min.js">` in the page. The browser resolves the
    path against thimble's address and the frame's policy refuses it ("which a view may not do"), but the checks' page
    sat at about:blank, where the path resolved to nothing, so the view passed and could not be shown. The checks' page
    has an http address too, so the page check fails with the same words."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    views.write_view(CORPUS, "src", reader=THREADS_READER, html=SRC_HTML, **{**VIEW, "name": "Src"})
    (state,) = await views.shoot_states(CORPUS, "src", [{"open": {}}])
    assert not state["ok"]
    assert any("lib/marked/marked.min.js, which a view may not do" in e for e in state["errors"]), state["errors"]


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
