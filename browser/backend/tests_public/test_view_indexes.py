"""app.view_indexes: the indexes view readers pickle stay bounded. Each reader's folder keeps its newest fingerprints,
a deleted view's folder goes, and all of them together stay under the cap, least recently used first."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import time
from pathlib import Path

import pytest

from app import config, view_indexes, views

CORPUS = "boards"

READER = '''
import json


def build_index(paths):
    out = []
    for p in paths:
        with open(p) as f:
            out += [json.loads(line) for line in f]
    return out


def records(index, query):
    return len(index)


def resolve(index, locator):
    return None
'''


def _pickle(d: Path, fp: str, size: int, age_s: float) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{fp}{view_indexes.PICKLE}"
    p.write_bytes(b"x" * size)
    (d / f"{fp}{view_indexes.READS}").write_text("{}")
    t = time.time() - age_s
    os.utime(p, (t, t))
    return p


@pytest.fixture()
def data(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"n": i}) + "\n" for i in range(4)))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d


def test_a_folder_keeps_its_newest_fingerprints_and_the_one_just_built(tmp_path):
    d = tmp_path / "v"
    old = [_pickle(d, f"fp{i}", 10, 3600 * (5 - i)) for i in range(5)]  # fp4 newest
    (d / "fp9.index.pickle.123.tmp").write_bytes(b"half")
    os.utime(d / "fp9.index.pickle.123.tmp", (time.time() - 7200,) * 2)
    freed = view_indexes.prune_dir(d, keep="fp0")
    left = sorted(p.name for p in d.iterdir())
    assert left == ["fp0.index.pickle", "fp0.reads.json", "fp4.index.pickle", "fp4.reads.json"]
    assert freed == 3 * (10 + 2) + 4
    assert not old[1].exists()


def test_a_folder_keeps_the_index_a_built_view_used_last_beside_newer_drafts(tmp_path):
    d = tmp_path / "v"
    page = _pickle(d, "page", 10, 7200)
    view_indexes.used(page, built=True)
    os.utime(page, (time.time() - 7200,) * 2)
    old = _pickle(d, "older", 10, 9000)
    (d / "older.built").touch()
    os.utime(d / "older.built", (time.time() - 9000,) * 2)
    drafts = [_pickle(d, f"draft{i}", 10, 600 * (4 - i)) for i in range(4)]
    view_indexes.prune_dir(d)
    assert page.exists(), "the index of the version a page is on stays while a change's checks build new ones"
    assert not old.exists() and not (d / "older.built").exists()
    assert [p.exists() for p in drafts] == [False, False, True, True]


def test_the_cap_deletes_the_least_recently_used_but_none_in_use(workspaces_tmp, monkeypatch):
    a = workspaces_tmp / "a" / view_indexes.INDEXES_SUBDIR
    b = workspaces_tmp / "b" / view_indexes.INDEXES_SUBDIR
    oldest = _pickle(a / "v1", "f1", 100, 7200)
    middle = _pickle(b / ".extensions" / "kit" / "views" / "t1", "f2", 100, 5400)
    newest = _pickle(a / "v2", "f3", 100, 3600)
    live = _pickle(b / "v3", "f4", 100, 10)
    freed = view_indexes.enforce_cap(limit=150)
    assert not oldest.exists() and not middle.exists() and not newest.exists()
    assert live.exists(), "an index used within IN_USE_S stays even over the cap"
    assert freed == 3 * (100 + 2)
    assert view_indexes.usage()["indexes"] == 1


async def test_a_new_fingerprint_prunes_its_folder_and_the_start_drops_deleted_views(data, workspaces_tmp, monkeypatch):
    async def inproc(c: str, code: str, timeout):
        buf = io.StringIO()
        here = os.getcwd()
        os.chdir(config.corpus_dir(c))
        try:
            with contextlib.redirect_stdout(buf):
                exec(code, {})  # noqa: S102 — the snippet a reader kernel runs
        finally:
            os.chdir(here)
        return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"

    monkeypatch.setattr(views, "_runner", inproc)
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    sys.modules.pop("_thimble_views", None)
    built = []
    real = view_indexes.built

    def note(c, pickle, *rest):
        built.append(pickle)
        real(c, pickle, *rest)

    monkeypatch.setattr(view_indexes, "built", note)
    for i in range(4):  # each edit of reader.py is a new fingerprint, and a new pickle
        views.write_view(CORPUS, "count", name="Count", description="Counts.", claims=["board.jsonl"],
                         reader=READER + f"\n# edit {i}\n", html="<!doctype html><p>x</p>")
        assert await views.reader_call(CORPUS, "count", "records", {}) == 4
        time.sleep(0.05)
    folder = views.index_dir(CORPUS, "count")
    for _ in range(50):
        if len(list(folder.glob("*.index.pickle"))) <= view_indexes.KEEP_PER_DIR:
            break
        time.sleep(0.05)
    assert len(built) == 4
    assert sorted(p.name for p in folder.glob("*.index.pickle")) == sorted(p.name for p in built[-2:])

    gone = views.indexes_dir(CORPUS) / "deleted-view"
    _pickle(gone, "f", 10, 10)
    types = _pickle(views.indexes_dir(CORPUS) / ".cardtypes" / "swarm", "f", 10, 10)
    ext = views.indexes_dir(CORPUS) / ".extensions" / "kit" / "cards" / "tally"
    ext_old = [_pickle(ext, f"e{i}", 10, 3600 * (4 - i)) for i in range(3)]
    calls = views.indexes_dir(CORPUS) / ".calls"
    calls.mkdir()
    (calls / "old.json").write_text("{}")
    os.utime(calls / "old.json", (time.time() - 2 * view_indexes.TMP_AGE_S,) * 2)
    (calls / "new.json").write_text("{}")
    views.prune_indexes()
    assert not gone.exists(), "a folder whose view is gone is deleted"
    assert types.exists() and folder.is_dir()
    assert [p.exists() for p in ext_old] == [False, True, True], "an extension's card type keeps its newest indexes"
    assert sorted(p.name for p in calls.iterdir()) == ["new.json"], "an old call's progress file goes"
    assert view_indexes.usage(CORPUS)["indexes"] == 5
    sys.modules.pop("_thimble_views", None)
