"""app.views: viewers written for how a corpus arranges its records. The reader resolves lines and keys, view refs
resolve and outlive their view, the frame document blocks every host, the media route serves only the media files a view
claims inside the corpus, the built-in viewers open workbooks and PDFs, and the worked examples a view ticket reads pass
the view checks over their own samples.

A temp DATA_DIR holds the corpus `boards`: `board.jsonl`, one post per line, each {thread, author, time, body}, and
`notes.md`. The `ws` fixture saves the view `threads`, whose reader (THREADS_READER) groups the posts by thread: it
accepts `board.jsonl#L<n>` (the post) and declares `view:threads/<thread>` (a whole thread). Most tests run the reader
in this process (the `inproc` fixture replaces views._runner with an exec of the same snippet the kernel gets).
"""
from __future__ import annotations

import asyncio
import contextlib
import csv
import io
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from app import config, refs, verify, views

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


def _events(ws: Path) -> list[dict]:
    p = ws / "investigations" / "main" / "events.jsonl"
    return [json.loads(ln) for ln in p.read_text().splitlines() if ln.strip()] if p.is_file() else []


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


needs_browser = pytest.mark.skipif(shutil.which("node") is None or not (config.REPO_ROOT / "frontend" / "node_modules" / "playwright").is_dir(),
                                   reason="the headless page load needs node and frontend/node_modules/playwright")


@pytest.fixture()
def app() -> FastAPI:
    a = FastAPI()
    a.include_router(views.router, prefix="/api")
    return a


@pytest.fixture()
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=120) as c:
        yield c


CLIP = bytes(range(256)) * 4  # 1,024 bytes, each byte's value its offset mod 256, so a range's bytes name where it is
PATHS_READER = """
def build_index(paths):
    return {"paths": list(paths)}


def records(index, query):
    return index["paths"]


def resolve(index, locator):
    return None
"""


@pytest.fixture()
def clips(ws, data, tmp_path) -> Path:
    """The view `clips` over `clips/*` (a video, a text file and a dot-file under it), beside `secret.mp4`, which it does
    not claim, and `clips/out.mp4`, a symlink to a file outside the corpus."""
    corpus = data / CORPUS
    (corpus / "clips").mkdir()
    (corpus / "clips" / "a.mp4").write_bytes(CLIP)
    (corpus / "clips" / "notes.txt").write_text("not media\n")
    (corpus / "clips" / ".hidden.mp4").write_bytes(CLIP)
    (corpus / "secret.mp4").write_bytes(CLIP)
    (tmp_path / "outside.mp4").write_bytes(CLIP)
    (corpus / "clips" / "out.mp4").symlink_to(tmp_path / "outside.mp4")
    views.write_view(CORPUS, "clips", reader=PATHS_READER, html=THREADS_HTML,
                     **dict(VIEW, name="Clips", claims=["clips/*"], default=False))
    return corpus


PLAYER_HTML = """<!doctype html><html><head></head><body><audio id="a" controls></audio><div id="d"></div><script>
const a = document.getElementById('a')
a.addEventListener('loadedmetadata', () => { document.getElementById('d').textContent = 'duration ' + a.duration; thimble.fetch({ duration: a.duration }) })
a.addEventListener('error', () => { throw new Error('the audio did not load') })
a.src = thimble.mediaUrl(SRC)
thimble.onOpen(() => {})
</script></body></html>"""


def _workbook(path: Path) -> None:
    import openpyxl

    wb = openpyxl.Workbook()
    wb.active.title = "Q2"
    wb.active.append(["dept", "travel"])
    q3 = wb.create_sheet("Q3")
    q3.append(["dept", "item", "", "amount"])
    for i in range(2, 20):
        q3.append([f"Dept {i}", "Travel", "", 1000 * i + (200 if i == 17 else 0)])
    wb.save(path)


def _pdf(path: Path, pages: list[list[str]]) -> None:
    """A PDF with one Helvetica text line per string, written by hand (no writer library is installed)."""
    objs: list[bytes] = [b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    pages_id = 1 + 2 * len(pages) + 1
    kids = []
    for lines in pages:
        body = b"BT /F1 12 Tf 72 720 Td 16 TL " + b" ".join(b"(" + ln.encode() + b") '" for ln in lines) + b" ET"
        objs.append(b"<< /Length %d >>\nstream\n" % len(body) + body + b"\nendstream")
        objs.append(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 1 0 R >> >> >>"
                    % (pages_id, len(objs)))
        kids.append(len(objs))
    objs.append(b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids) + b"] /Count %d >>" % len(kids))
    objs.append(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    out, offs = bytearray(b"%PDF-1.4\n"), []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, len(objs), xref)
    path.write_bytes(bytes(out))


@pytest.fixture()
async def docs(data, workspaces_tmp) -> Path:
    corpus = config.corpus_dir(CORPUS)
    _workbook(corpus / "budget.xlsx")
    _pdf(corpus / "policy.pdf", [["Travel policy"], ["Section 2. Claims", "Receipts are filed within a 30-day limit."]])
    return corpus


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


@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_every_worked_example_answers_the_checks_over_its_sample(name, samples, inproc, bound, tmp_path, monkeypatch):
    """The reader's half of the checks: the index builds, the sampled lines and the declared keys resolve, each answer
    cites its place back, and every excerpt is literal text of the records it cites. The page's half is a test below."""
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0, "records": 1} for _ in states]

    monkeypatch.setattr(views, "shoot_states", no_page)
    slug = _save_example(name)
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    checked = [r["locator"] for r in rep["checks"]]
    assert set(EXAMPLES[name][1]) <= set(checked)
    assert any(re.search(r"#L\d+$", c) for c in checked), "sampled lines were checked beside the keys"


def _fields(path: Path) -> set[str]:
    """The field names of a sample file's records: a CSV file's columns, else the keys of its JSON objects, in one
    document or one per line (a line that does not parse is left out)."""
    text = path.read_text("utf-8")
    if path.suffix == ".csv":
        return set(next(csv.reader(text.splitlines()[:1]), []))
    try:
        docs = [json.loads(text)]
    except ValueError:
        docs = []
        for ln in text.splitlines():
            with contextlib.suppress(ValueError):
                docs.append(json.loads(ln))
    return {k for doc in docs for r in (doc if isinstance(doc, list) else [doc]) if isinstance(r, dict) for k in r}


def _sample_line(path: Path, n: int) -> str:
    return path.read_text("utf-8").splitlines()[n - 1]


def _sample_line_of(path: Path, needle: str) -> int:
    """The number of the first line of the file that holds `needle`."""
    return next(n for n, ln in enumerate(path.read_text("utf-8").splitlines(), 1) if needle in ln)


# the repository sample's runs: each one's team and the approvals a merge needs, and its number of pull requests
REPO_RUNS = {"r1": (3, 1, 8), "r2": (3, 2, 7), "r3": (5, 1, 11), "r4": (5, 2, 9)}


def _transcripts(d: Path) -> dict[str, list[dict]]:
    """The sample's transcripts by session id (a lead's file name, a subagent's agent id), each line that parses once."""
    out = {}
    for p in sorted(d.glob("runs/**/*.jsonl")):
        seen, lines = set(), []
        for ln in p.read_text("utf-8").splitlines():
            with contextlib.suppress(ValueError):
                r = json.loads(ln)
                if r["uuid"] not in seen:
                    seen.add(r["uuid"])
                    lines.append(r)
        out[p.stem.removeprefix("agent-")] = lines
    return out


def _uses(lines: list[dict]) -> list[dict]:
    return [b for r in lines if isinstance(r["message"]["content"], list) for b in r["message"]["content"] if b["type"] == "tool_use"]


@pytest.mark.parametrize("name", ["repository"])
async def test_every_worked_example_s_page_loads_headless_at_its_first_place(name, samples, inproc, bound, tmp_path):
    """The whole check a view ticket's session runs, the headless page included, where this machine has Node and the
    frontend's packages with their Chromium (scripts/check.sh install)."""
    if why := views.build_problem():
        pytest.skip(why)
    slug = _save_example(name)
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    assert rep["page"]["fetches"] >= 1 and Path(rep["page"]["png"]).is_file()
    assert not views.unmarked(rep["page"]), "the records a worked example shows carry their file refs, for the labels"


def views_time(ts: str) -> float:
    t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()
