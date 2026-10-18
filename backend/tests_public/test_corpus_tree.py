"""The Files tree's folder listings, the corpus's folder tree (corpus_tree) and the files a view claims.

A folder reached through a symlink is not listed, and a walk follows symlinked folders only when asked. The folder tree
reads a folder again when it changed, even within its modification time. The files a view claims carry sizes and times,
so a changed file still changes the view's fingerprint."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config, corpus, corpus_tree, views
from app.main import app

client = TestClient(app)
NAME = "treecorpus"


def _write(root: Path, rel: str, text: str = "x\n") -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


@pytest.fixture()
def tree_corpus(tmp_path, monkeypatch) -> Path:
    data = tmp_path / "data"
    root = data / NAME
    for rel in ("big.jsonl", "README.md", ".hidden.txt", "runs/r1/manifest.json", "runs/r1/agents/a.jsonl",
                "runs/r2/agents/b.jsonl", "runs/r3/notes.txt", "images/d1/x.png", "images/d1/y.png", "docs/paper.pdf",
                "db/forge.db", "db/forge.db-wal", ".git/objects/o1"):
        _write(root, rel)
    (root / "manifest.json").write_text(json.dumps({"name": NAME, "description": ""}))
    (root / "empty").mkdir()
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    corpus.forget_sources()
    return config.corpus_dir(NAME)


def _folder(path: str, **params) -> dict:
    r = client.get(f"/api/corpora/{NAME}/sources", params={"path": path, "depth": 1, **params})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_folder_reached_through_a_symlink_is_not_listed(tree_corpus):
    os.symlink(tree_corpus / "runs", tree_corpus / "linked")
    assert "linked" not in [d["name"] for d in _folder(".")["folders"]]
    assert _folder("linked")["files"] == [] and _folder("linked")["folders"] == []


def test_a_folder_changed_again_within_its_modification_time_is_read_again(tmp_path):
    root = tmp_path / "c"
    _write(root, "a/1.txt")
    t = corpus_tree.Tree(root)
    t.walk(links=False, hidden=False)
    st = os.stat(root / "a")
    _write(root, "a/2.txt")
    os.utime(root / "a", ns=(st.st_atime_ns, st.st_mtime_ns))  # the same mtime as when it was read
    assert t.walk(links=False, hidden=False)[1] == ["a/1.txt", "a/2.txt"]


def test_a_walk_follows_symlinked_folders_only_when_asked_and_never_round_a_loop(tmp_path):
    root = tmp_path / "c"
    _write(root, "real/f.txt")
    os.symlink(root / "real", root / "link")
    os.symlink(root, root / "real" / "loop")  # back to the corpus root
    t = corpus_tree.Tree(root)
    assert t.walk(links=False, hidden=False)[1] == ["real/f.txt"]
    assert t.walk(links=True, hidden=False)[1] == ["link/f.txt", "real/f.txt"]


def test_the_files_a_view_claims_carry_sizes_and_times(tree_corpus, workspaces_tmp, monkeypatch):
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    views._folder_cache.clear()
    view = {"claims": ["runs/*/agents/*.jsonl"]}
    files = views.claimed_files(NAME, view)
    assert [f[0] for f in files] == ["runs/r1/agents/a.jsonl", "runs/r2/agents/b.jsonl"]
    assert files[0][1] == 2 and files[0][2] == os.stat(tree_corpus / "runs/r1/agents/a.jsonl").st_mtime_ns
    before = views.fingerprint(files)
    (tree_corpus / "runs/r1/agents/a.jsonl").write_text("x\ny\n")
    assert views.fingerprint(views.claimed_files(NAME, view)) != before
    assert views.claimed_paths(NAME, {"claims": ["*.pdf"]}) == ["docs/paper.pdf"]
    assert views.claimed_paths(NAME, {"claims": ["db/*"]}) == ["db/forge.db"]  # no side file
    assert views.claimed_paths(NAME, {"claims": []}) == []


PATTERNS = ["*", "", "*.pdf", "*.jsonl", "big.jsonl", "runs/*/agents/*.jsonl", "r?n*/*", "*/x.png", "[ab]*.md",
            "a.json*", "*agents*", "runs/r1/manifest.json", "*a?b", "[!/]*.md", "**/*.md", "runs/**/a.jsonl"]
PATHS = sorted(["big.jsonl", "README.md", "docs/paper.pdf", "runs/r1/agents/a.jsonl", "runs/r1/manifest.json",
                "images/d1/x.png", "deep/big.jsonl", "a.md", "b.md", "a.json", "agents.txt", "a/b", "sub/a.md"])


def test_a_claims_matcher_agrees_with_glob_matches():
    for pattern in PATTERNS:
        test = views._matcher(pattern)
        want = [p for p in PATHS if views.glob_matches(p, pattern)]
        assert [p for p in PATHS if test(p)] == want, pattern
        assert views.match_all([pattern], PATHS) == want, pattern


def test_bug_hunt_e3_a_label_reads_a_glob_as_a_view_does(tree_corpus):
    # `*/**/README.md` over runs: a `**/` may stand for no folder, so a run's top-level README.md is in its scope, as a
    # view's claims read it (views.glob_matches); a label read it with fnmatch alone and left it out
    from app import concepts

    for rel in ("runs/r1/README.md", "runs/r2/report/README.md"):
        _write(tree_corpus, rel)
    corpus.forget_sources()
    assert [s["path"] for s in concepts.match_paths(tree_corpus, ["runs/*/**/README.md"])] == ["runs/r1/README.md", "runs/r2/report/README.md"]
    every = [s["path"] for s in corpus.list_sources(tree_corpus)]
    for pattern in ("*/**/README.md", "runs/**/agents/*.jsonl", "**/*.md", "runs/**/r1/**/a.jsonl", "runs/*/agents/*"):
        labeled = [s["path"] for s in concepts.match_paths(tree_corpus, [pattern])]
        assert labeled == [p for p in every if views.glob_matches(p, pattern)] and labeled, pattern
