"""Labels in every view: the labels context a view's reader gets (views.labels_context), thimble.marked, thimble.kept
and thimble.view_labels over a label whose records a cover holds, the test label the checks use, the marks of a view's
units (views.marks_for and the marks route), and a reader that filters its records by the Files label filter, which
leaves alone the files its label never ran over.

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
ASKS = [1, 4, 8]  # the lines that say "help"

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
VIEW = dict(name="Threads", why="The posts by thread.", claims=["board.jsonl"], accepts=[{"form": "L<n>", "means": "a post"}],
            declares=[{"form": "<thread>", "means": "a thread"}], default=True, libs=[])


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
