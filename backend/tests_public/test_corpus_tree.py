"""The Files tree's folder listings, the corpus's folder tree (corpus_tree) and the files a view claims.

A folder listing reads that one folder, never the whole corpus. The folder tree reads a folder again only when it
changed, so a walk after the first stats folders and reads none. The views list answers from the tree as last walked,
and the files a view claims carry sizes and times, so a changed file still changes the view's fingerprint."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config, corpus
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


def test_the_source_list_still_lists_every_file(tree_corpus):
    paths = [s["path"] for s in corpus.list_sources(tree_corpus)]
    assert sorted(paths) == sorted(["big.jsonl", "README.md", "manifest.json", "runs/r1/manifest.json",
                                    "runs/r1/agents/a.jsonl", "runs/r2/agents/b.jsonl", "runs/r3/notes.txt",
                                    "images/d1/x.png", "images/d1/y.png", "docs/paper.pdf", "db/forge.db"])
    hidden = {s["path"]: s.get("hidden", False) for s in corpus.list_sources(tree_corpus, include_hidden=True)}
    assert hidden[".hidden.txt"] is True and hidden[".git/objects/o1"] is True and hidden["big.jsonl"] is False
    kinds = {s["path"]: s["kind"] for s in corpus.list_sources(tree_corpus)}
    assert kinds["runs/r1/agents/a.jsonl"] == "agent" and kinds["db/forge.db"] == "forge"
