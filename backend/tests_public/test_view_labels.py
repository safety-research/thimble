"""Labels in every view: the labels context a view's reader gets (views.labels_context), thimble.marked, thimble.kept
and thimble.view_labels over a label whose records a cover holds, the test label the checks use, the marks of a view's
units (views.marks_for and the marks route), and a reader that filters its records by the Files label filter.

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


async def test_the_labels_context_holds_the_labels_that_are_on_and_the_filter(app):
    k = await _asks(app)
    assert views.labels_context(CORPUS)["labels"] == [], "a label that is off is not in the context"
    concepts.show_concept(CORPUS, k["id"], True)
    ctx = views.labels_context(CORPUS)
    (lab,) = ctx["labels"]
    assert lab["name"] == "asks" and [v["name"] for v in lab["values"]] == ["asks", "other"]
    assert [v["highlight"] for v in lab["values"]] == [True, False] and ctx["filter"] is None
    assert lab["colour"] == lab["values"][0]["colour"] and lab["colour"].startswith("#")
    # marked: the highlighted value of a record's row; the covered records take the negative, which is not highlighted
    assert [n for n in range(1, 13) if kernel_thimble._marked(ctx, f"board.jsonl#L{n}")] == ASKS
    assert kernel_thimble._marked(ctx, "board.jsonl#L4") == [{"label": "asks", "value": "asks", "colour": lab["colour"]}]
    assert all(kernel_thimble._kept(ctx, r) for r in _refs(range(1, 13))), "no filter keeps everything"
    # a filter on the negative keeps the records the covers hold
    concepts.set_filter(CORPUS, "files", k["id"], "other")
    ctx = views.labels_context(CORPUS)
    assert ctx["filter"] == {"id": k["id"], "label": "asks", "value": "other", "colour": lab["values"][1]["colour"]}
    assert [n for n in range(1, 13) if kernel_thimble._kept(ctx, f"board.jsonl#L{n}")] == [n for n in range(1, 13) if n not in ASKS]
    st = kernel_thimble._view_labels(ctx)
    assert st["filter"] == {"label": "asks", "value": "other", "colour": lab["values"][1]["colour"]}
    assert st["labels"][0]["values"] == [{"name": "other", "colour": lab["values"][1]["colour"]}], "set_filter highlights the value"


def test_the_test_label_marks_every_seventh_record_and_its_filter_keeps_just_those():
    ctx = views.probe_context()
    assert [n for n in range(1, 30) if kernel_thimble._marked(ctx, f"a.jsonl#L{n}")] == [7, 14, 21, 28]
    assert all(kernel_thimble._kept(ctx, f"a.jsonl#L{n}") for n in (1, 7)) and kernel_thimble._marked(ctx, "view:x/k") == []
    filtered = views.probe_context(True)
    assert [n for n in range(1, 30) if kernel_thimble._kept(filtered, f"a.jsonl#L{n}")] == [7, 14, 21, 28]
    assert kernel_thimble._view_labels(filtered)["filter"]["label"] == kernel_thimble.PROBE_NAME
    assert kernel_thimble.marked("a.jsonl#L7") == [] and kernel_thimble.kept("a.jsonl#L1"), "outside a view's call no label is on"


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


async def test_a_unit_is_marked_by_its_records_and_kept_when_one_of_them_is(app):
    k = await _asks(app)
    views.write_view(CORPUS, "threads", reader=READER, html=HTML, **VIEW)
    concepts.show_concept(CORPUS, k["id"], True)
    refs = ["view:threads/t1", "view:threads/t2", "view:threads/t3", "board.jsonl#L4", "board.jsonl#L5", "view:other/t1"]
    marks = (await app.post(f"/api/ws/{CORPUS}/views/threads/marks", json={"refs": refs})).json()
    colour = views.labels_context(CORPUS)["labels"][0]["colour"]
    assert set(marks) == {"view:threads/t1", "view:threads/t2", "board.jsonl#L4"}
    assert marks["view:threads/t1"] == {"bar": colour, "names": ["asks"], "spans": []} and "keep" not in marks["board.jsonl#L4"]
    concepts.set_filter(CORPUS, "files", k["id"], "asks")
    marks = await views.marks_for(CORPUS, "threads", refs)
    assert {r: m.get("keep") for r, m in marks.items()} == {"view:threads/t1": True, "view:threads/t2": True, "board.jsonl#L4": True}
    # under the test label a unit is marked when a record of it is on a line that is a multiple of seven
    probe = await views.marks_for(CORPUS, "threads", refs, views.probe_context(True))
    assert set(probe) == {"view:threads/t3"} and probe["view:threads/t3"]["keep"] is True
    # no label on and no filter: nothing to mark
    concepts.clear_filter(CORPUS, "files")
    concepts.show_concept(CORPUS, k["id"], False)
    assert await views.marks_for(CORPUS, "threads", refs) == {}
