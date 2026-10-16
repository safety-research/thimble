"""The walks of the corpus. The kernels' scratch mirror (notebook.mirror_corpus) and the walk under it (corpus_walk):
every corpus file is linked, a change reaches the mirror on its next pass, what a kernel wrote stays, and an unchanged
corpus is mirrored again without reading any folder, also after a restart (the manifest under thimble's home). Callers
of a view's folder walk at the same time share one walk, and `thimble list` does not stat a workspace's mirror links."""
from __future__ import annotations

import os
import shutil
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


def test_a_gone_folder_s_sweep_does_not_follow_a_kernel_s_link(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "dangling").symlink_to(tmp_path / "nothing")
    shutil.rmtree(scratch / "runs" / "b")
    (scratch / "runs" / "b").symlink_to(outside)  # a cell put a link where the mirror had runs/b
    shutil.rmtree(corpus / "runs" / "b")
    notebook.mirror_corpus(corpus, scratch)
    assert os.path.lexists(outside / "dangling")
