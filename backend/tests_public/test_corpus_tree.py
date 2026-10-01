"""The Files tree's folder listings, the corpus's folder tree (corpus_tree) and the files a view claims.

A folder listing reads that one folder, never the whole corpus. The folder tree reads a folder again only when it
changed, so a walk after the first stats folders and reads none. The views list answers from the tree as last walked,
and the files a view claims carry sizes and times, so a changed file still changes the view's fingerprint."""
from __future__ import annotations

import json
import os
import time
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config, corpus, corpus_tree, views
from app.main import app

client = TestClient(app)
NAME = "treecorpus"
OLD_NS = 1_600_000_000 * 10**9  # a modification time long past, so no folder reads as just changed (RACY_NS)


def _write(root: Path, rel: str, text: str = "x\n") -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def _age(root: Path, ns: int = OLD_NS) -> None:
    """Every folder under root (root included) modified long ago."""
    for d, _, _ in os.walk(root):
        os.utime(d, ns=(ns, ns))


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


def test_a_folder_listing_reads_that_folder_alone(tree_corpus, monkeypatch):
    def no_walk(*a, **k):
        raise AssertionError("a folder listing walked the corpus")

    monkeypatch.setattr(corpus_tree.Tree, "walk", no_walk)
    monkeypatch.setattr(corpus, "_walk_sources", no_walk)
    root = _folder(".")
    assert [f["path"] for f in root["files"]] == ["README.md", "big.jsonl", "manifest.json"]
    assert root["files"][1]["size_bytes"] == 2 and root["files"][1]["title"] == "big"
    assert [d["name"] for d in root["folders"]] == ["db", "docs", "empty", "images", "runs"]
    assert "n_files" not in root and all("n_files" not in d for d in root["folders"])  # no walk has counted them yet
    runs = _folder("runs")
    assert {d["name"]: d["is_run"] for d in runs["folders"]} == {"r1": True, "r2": True, "r3": False}
    assert [f["path"] for f in _folder("db")["files"]] == ["db/forge.db"]  # its sqlite side file is left out
    assert [f["kind"] for f in _folder("db")["files"]] == ["forge"]
    shown = _folder(".", include_hidden=1)
    assert {f["path"]: f.get("hidden", False) for f in shown["files"]}[".hidden.txt"] is True
    assert {d["name"]: d.get("hidden", False) for d in shown["folders"]}[".git"] is True
    assert _folder(".git") == {"path": ".git", "files": [], "folders": [], "n_files": 0}
    assert [f["path"] for f in _folder(".git/objects", include_hidden=1)["files"]] == [".git/objects/o1"]
    assert client.get(f"/api/corpora/{NAME}/sources", params={"path": "nope", "depth": 1}).status_code == 404


def test_a_folder_listing_counts_what_a_walk_already_read(tree_corpus):
    corpus.list_sources(tree_corpus)
    root = _folder(".")
    assert root["n_files"] == 11  # every file but the dot ones and the side file
    by_name = {d["name"]: d for d in root["folders"]}
    assert (by_name["runs"]["n_files"], by_name["runs"]["n_folders"]) == (4, 3)
    assert (by_name["empty"]["n_files"], by_name["empty"]["n_folders"]) == (0, 0)
    assert _folder(".", include_hidden=1).get("n_files") is None  # the dot folders were never read


def test_a_folder_listed_again_counts_a_file_added_to_it_or_gives_no_count(tree_corpus):
    """A folder listing checks that folder in the tree again, so the tree's count holds a file an agent just wrote there,
    and the root's count a file written in a subfolder listed before it. While a walk holds the tree, a folder that
    changed gets no count, since the one the tree holds is no longer exact."""
    corpus.list_sources(tree_corpus)
    _write(tree_corpus, "NOTES.md")
    assert _folder(".")["n_files"] == 12
    _write(tree_corpus, "runs/r3/more.txt")
    assert _folder("runs/r3")["n_files"] == 2 and _folder(".")["n_files"] == 13
    tree = corpus_tree.tree(tree_corpus)
    with tree.lock:
        _write(tree_corpus, "LATER.md")
        os.utime(tree_corpus, ns=(OLD_NS, OLD_NS))
        assert "n_files" not in _folder(".")
    assert _folder(".")["n_files"] == 14


def test_the_root_s_count_follows_a_file_added_in_a_folder_the_tree_does_not_show(tree_corpus, monkeypatch):
    """A file added in a folder no listing asks about (a collapsed folder) changes neither that folder's parents' times
    nor any shown folder's. A stamps request has the tree check its folders in the background, one stat each and no
    walk of the files, so a later stamp of the root carries the new count, and the root listed again gives it."""
    _age(tree_corpus)
    corpus.list_sources(tree_corpus)
    root = _folder(".")
    assert root["n_files"] == 11

    def stamp() -> str:
        r = client.get(f"/api/corpora/{NAME}/sources/stamps", params={"path": ["."]})
        assert r.status_code == 200, r.text
        return r.json()["stamps"]["."]

    assert stamp() == root["stamp"]

    def no_walk(*a, **k):
        raise AssertionError("the count's check walked the corpus's files")

    monkeypatch.setattr(corpus_tree.Tree, "walk", no_walk)
    monkeypatch.setattr(corpus, "_walk_sources", no_walk)
    monkeypatch.setattr(corpus, "COUNT_CHECK_S", 0.0)
    _write(tree_corpus, "images/d1/z.png")
    os.utime(tree_corpus / "images" / "d1", ns=(OLD_NS + 10**9, OLD_NS + 10**9))
    deadline = time.monotonic() + 10
    now = stamp()
    while now == root["stamp"] and time.monotonic() < deadline:
        time.sleep(0.05)
        now = stamp()
    assert now != root["stamp"], "the root's stamp did not follow the file"
    fresh = _folder(".")
    assert fresh["n_files"] == 12 and fresh["stamp"] == stamp()
    assert {d["name"]: d.get("n_files") for d in fresh["folders"]}["images"] == 3


def test_a_folder_reached_through_a_symlink_is_not_listed(tree_corpus):
    os.symlink(tree_corpus / "runs", tree_corpus / "linked")
    assert "linked" not in [d["name"] for d in _folder(".")["folders"]]
    assert _folder("linked")["files"] == [] and _folder("linked")["folders"] == []


def test_the_tree_asks_which_folders_changed_by_their_stamps_and_lists_only_those_again(tree_corpus):
    """A listing carries its folder's stamp, and GET /sources/stamps answers the stamps of the folders the tree shows
    with no listing read: a file added to a folder changes that folder's stamp alone, and a folder gone or left out
    has none. A listing read within the time's resolution of a change carries a stamp no later answer equals."""
    _age(tree_corpus)
    root, runs = _folder("."), _folder("runs")

    def stamps(*paths: str) -> dict:
        r = client.get(f"/api/corpora/{NAME}/sources/stamps", params={"path": list(paths)})
        assert r.status_code == 200, r.text
        return r.json()["stamps"]

    assert stamps(".", "runs") == {".": root["stamp"], "runs": runs["stamp"]}
    _write(tree_corpus, "NOTES.md")
    got = stamps(".", "runs", "runs/r9", ".git", "../outside")
    assert got["."] != root["stamp"] and got["runs"] == runs["stamp"]
    assert got["runs/r9"] is None and got[".git"] is None and got["../outside"] is None
    fresh = _folder(".")
    assert "NOTES.md" in [f["path"] for f in fresh["files"]]
    assert fresh["stamp"] != stamps(".")["."], "a folder changed just now is listed once more"
    _age(tree_corpus)
    assert _folder(".")["stamp"] == stamps(".")["."]
    assert client.get(f"/api/corpora/{NAME}/sources/stamps", params={"path": ["x"] * 201}).status_code == 400


def test_the_source_list_is_stamped_when_its_walk_ends(tree_corpus, monkeypatch):
    clock = [1000.0]
    walks = []

    def slow_walk(c, hidden):
        walks.append(c)
        clock[0] += corpus.SOURCES_MEMO_S + 5  # a walk longer than the memo lasts
        return []

    monkeypatch.setattr(corpus, "time", types.SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(corpus, "_walk_sources", slow_walk)
    corpus.list_sources(tree_corpus)
    corpus.list_sources(tree_corpus)
    assert len(walks) == 1


def test_the_source_list_still_lists_every_file(tree_corpus):
    paths = [s["path"] for s in corpus.list_sources(tree_corpus)]
    assert sorted(paths) == sorted(["big.jsonl", "README.md", "manifest.json", "runs/r1/manifest.json",
                                    "runs/r1/agents/a.jsonl", "runs/r2/agents/b.jsonl", "runs/r3/notes.txt",
                                    "images/d1/x.png", "images/d1/y.png", "docs/paper.pdf", "db/forge.db"])
    hidden = {s["path"]: s.get("hidden", False) for s in corpus.list_sources(tree_corpus, include_hidden=True)}
    assert hidden[".hidden.txt"] is True and hidden[".git/objects/o1"] is True and hidden["big.jsonl"] is False
    kinds = {s["path"]: s["kind"] for s in corpus.list_sources(tree_corpus)}
    assert kinds["runs/r1/agents/a.jsonl"] == "agent" and kinds["db/forge.db"] == "forge"


def _counting_scandir(monkeypatch, under: Path) -> list[str]:
    seen: list[str] = []
    real = os.scandir

    def counting(path="."):
        if str(path).startswith(str(under)):
            seen.append(str(path))
        return real(path)

    monkeypatch.setattr(corpus_tree.os, "scandir", counting)
    return seen


def test_a_walk_reads_again_only_the_folders_that_changed(tmp_path, monkeypatch):
    root = tmp_path / "c"
    for rel in ("a/1.txt", "a/x/2.txt", "b/3.txt", "c/4.txt"):
        _write(root, rel)
    _age(root)
    reads = _counting_scandir(monkeypatch, root)
    t = corpus_tree.Tree(root)
    _, paths = t.walk(links=False, hidden=False)
    assert paths == ["a/1.txt", "a/x/2.txt", "b/3.txt", "c/4.txt"] and len(reads) == 5
    reads.clear()
    v, again = t.walk(links=False, hidden=False)
    assert again is paths and reads == []  # every folder stat'ed, none read
    _write(root, "b/5.txt")
    os.utime(root / "b", ns=(OLD_NS + 10**9, OLD_NS + 10**9))
    v2, paths = t.walk(links=False, hidden=False)
    assert reads == [f"{root}/b"] and "b/5.txt" in paths and v2 > v
    # a folder checked within max_age is taken as it is until forget()
    _write(root, "c/6.txt")
    os.utime(root / "c", ns=(OLD_NS + 2 * 10**9, OLD_NS + 2 * 10**9))
    assert "c/6.txt" not in t.walk(links=False, hidden=False, max_age=3600)[1]
    t.not_before = time.monotonic()
    assert "c/6.txt" in t.walk(links=False, hidden=False, max_age=3600)[1]


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


PDF_READER = """
def build_index(paths):
    return list(paths)


def records(index, query):
    return index


def resolve(index, locator):
    return None
"""


def _pdf_view() -> None:
    """A view of the workspace that claims every PDF by a glob."""
    views.write_view(NAME, "papers", name="Papers", description="each paper", claims=["*.pdf"], reader=PDF_READER,
                     html="<p>papers</p>", unit="file")


def test_the_views_list_does_not_wait_for_the_corpus_walk(tree_corpus, workspaces_tmp):
    _pdf_view()
    corpus_tree.forget(tree_corpus)
    corpus_tree._trees.pop(str(tree_corpus), None)

    def papers() -> dict:
        r = client.get(f"/api/ws/{NAME}/views")
        assert r.status_code == 200, r.text
        return next(v for v in r.json() if v["slug"] == "papers")

    first = papers()
    assert first["files_pending"] is True and first["first_file"] is None and "n_files" not in first
    deadline = time.monotonic() + 10
    while (v := papers()).get("files_pending") and time.monotonic() < deadline:
        time.sleep(0.05)
    assert v["first_file"] == "docs/paper.pdf" and v["files"] == ["docs/paper.pdf"] and v["n_files"] == 1


def test_the_views_list_with_wait_answers_the_files_at_once(tree_corpus, workspaces_tmp):
    _pdf_view()
    corpus_tree._trees.pop(str(tree_corpus), None)
    r = client.get(f"/api/ws/{NAME}/views", params={"wait": 1})
    v = next(v for v in r.json() if v["slug"] == "papers")
    assert "files_pending" not in v and v["first_file"] == "docs/paper.pdf"


PATTERNS = ["*", "", "*.pdf", "*.jsonl", "big.jsonl", "runs/*/agents/*.jsonl", "r?n*/*", "*/x.png", "[ab]*.md",
            "a.json*", "*agents*", "runs/r1/manifest.json", "*a?b", "[!/]*.md", "**/*.md", "runs/**/a.jsonl"]
PATHS = sorted(["big.jsonl", "README.md", "docs/paper.pdf", "runs/r1/agents/a.jsonl", "runs/r1/manifest.json",
                "images/d1/x.png", "deep/big.jsonl", "a.md", "b.md", "a.json", "agents.txt", "a/b", "sub/a.md"])


@pytest.mark.parametrize("pattern", PATTERNS)
def test_a_claims_matcher_agrees_with_glob_matches(pattern):
    test = views._matcher(pattern)
    assert [p for p in PATHS if test(p)] == [p for p in PATHS if views.glob_matches(p, pattern)]
    assert views.match_all([pattern], PATHS) == [p for p in PATHS if views.glob_matches(p, pattern)]


@pytest.mark.parametrize("claims", [["*.pdf", "*.md"], ["big.jsonl", "runs/*/agents/*.jsonl"], ["[ab]*.md", "*.json"],
                                    ["README.md", "nope.txt", "a?b"]])
def test_claims_together_match_what_each_matches(claims):
    assert views.match_all(claims, PATHS) == [p for p in PATHS if any(views.glob_matches(p, g) for g in claims)]
