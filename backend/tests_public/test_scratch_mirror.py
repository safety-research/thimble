"""The kernels' scratch mirror of the corpus (notebook.mirror_corpus) and the shared walk under it (corpus_walk): every
corpus file is linked, a change reaches the mirror on its next pass, what a kernel wrote stays, and an unchanged corpus
is mirrored again without reading any folder, also after a restart (the manifest under thimble's home)."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from app import corpus_walk, notebook


def _age(root: Path, seconds: float = 60) -> None:
    """Every folder under `root` last changed `seconds` ago, outside corpus_walk's racy window."""
    t = time.time() - seconds
    for d, _, _ in os.walk(root):
        os.utime(d, (t, t))


@pytest.fixture()
def corpus(tmp_path) -> Path:
    c = tmp_path / "corpus"
    for run in ("a", "b"):
        (c / "runs" / run / "agents").mkdir(parents=True)
        (c / "runs" / run / "manifest.json").write_text("{}")
        (c / "runs" / run / "agents" / "agent-1.jsonl").write_text("{}\n")
    (c / "README.md").write_text("hi")
    (c / ".git" / "objects").mkdir(parents=True)
    (c / ".git" / "objects" / "x").write_text("blob")
    _age(c)
    corpus_walk.forget()
    return c


@pytest.fixture()
def passes(monkeypatch) -> list[str]:
    """The folders each mirror pass synced (notebook._mirror_folder's calls, by scratch folder)."""
    seen: list[str] = []
    real = notebook._mirror_folder

    def spy(src, dest, names, links):
        seen.append(str(dest))
        return real(src, dest, names, links)

    monkeypatch.setattr(notebook, "_mirror_folder", spy)
    return seen


def _links(scratch: Path) -> set[str]:
    return {str((Path(d) / n).relative_to(scratch)) for d, ds, fs in os.walk(scratch) for n in [*fs, *ds]
            if (Path(d) / n).is_symlink()}


def test_every_corpus_file_is_linked_and_git_is_left_out(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    assert _links(scratch) == {"README.md", "runs/a/manifest.json", "runs/a/agents/agent-1.jsonl",
                               "runs/b/manifest.json", "runs/b/agents/agent-1.jsonl"}
    assert os.readlink(scratch / "runs/a/manifest.json") == str(corpus / "runs/a/manifest.json")
    assert not (scratch / ".git").exists()


def test_an_unchanged_corpus_is_mirrored_again_without_reading_a_folder(corpus, tmp_path, passes):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    assert len(passes) == 6
    passes.clear()
    notebook.mirror_corpus(corpus, scratch)
    assert passes == []
    corpus_walk.forget()  # a restart: only the manifest is left
    notebook.mirror_corpus(corpus, scratch)
    assert passes == []


def test_a_file_added_or_removed_reaches_the_mirror_on_its_next_pass(corpus, tmp_path, passes):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    passes.clear()
    (corpus / "runs" / "a" / "new.jsonl").write_text("{}\n")
    (corpus / "runs" / "b" / "manifest.json").unlink()
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "runs/a/new.jsonl").is_symlink()
    assert not os.path.lexists(scratch / "runs/b/manifest.json")
    assert sorted(passes) == [str(scratch / "runs/a"), str(scratch / "runs/b")]


def test_a_removed_folder_takes_its_links_and_a_kernels_files_stay(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    (scratch / "runs" / "a" / "made-by-a-cell.csv").write_text("x")
    (scratch / "runs" / "a" / "agents" / "agent-1.jsonl").unlink()  # a cell removed a link
    for p in sorted((corpus / "runs" / "b").rglob("*"), reverse=True):
        p.rmdir() if p.is_dir() else p.unlink()
    (corpus / "runs" / "b").rmdir()
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "runs/a/made-by-a-cell.csv").read_text() == "x"
    assert (scratch / "runs/a/agents/agent-1.jsonl").is_symlink()
    assert _links(scratch / "runs" / "b") == set()


def test_a_kernels_file_where_the_corpus_has_a_folder_wins(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "runs").write_text("mine")
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "runs").read_text() == "mine"
    assert (scratch / "README.md").is_symlink()


def test_a_corpus_link_is_mirrored_only_while_its_target_exists(corpus, tmp_path):
    (corpus / "runs" / "a" / "to-readme").symlink_to(corpus / "README.md")
    (corpus / "runs" / "a" / "broken").symlink_to(corpus / "nowhere")
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "runs/a/to-readme").read_text() == "hi"
    assert not os.path.lexists(scratch / "runs/a/broken")


def test_the_walk_lists_again_only_the_folders_that_changed(corpus, monkeypatch):
    listed: list[str] = []
    real = corpus_walk._list

    def spy(path, mtime_ns, prune):
        listed.append(path)
        return real(path, mtime_ns, prune)

    monkeypatch.setattr(corpus_walk, "_list", spy)
    first = corpus_walk.walk(corpus)
    assert set(first) == {"", ".git", ".git/objects", "runs", "runs/a", "runs/a/agents", "runs/b", "runs/b/agents"}
    assert first["runs/a"].file_names() == ["manifest.json"] and first["runs/a"].dirs == ("agents",)
    listed.clear()
    assert corpus_walk.walk(corpus) == first and listed == []
    (corpus / "runs" / "b" / "agents" / "agent-2.jsonl").write_text("{}\n")
    again = corpus_walk.walk(corpus)
    assert listed == [str(corpus / "runs" / "b" / "agents")]
    assert again["runs/b/agents"].file_names() == ["agent-1.jsonl", "agent-2.jsonl"]
    assert again["runs/b/agents"].racy  # changed just now: listed again by the next walk
    assert set(corpus_walk.walk(corpus, frozenset({".git"}))) == set(first) - {".git", ".git/objects"}
