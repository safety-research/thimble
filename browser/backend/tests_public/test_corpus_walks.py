"""The walks of the corpus. The kernels' scratch mirror (notebook.mirror_corpus): a link to each entry of the corpus
folder, so every corpus file is read by its relative path, a pass lists the corpus folder alone however many files lie
under it, a change below an entry shows at once, what a kernel wrote stays, and a folder the per-file mirror of earlier
versions left becomes its link. Callers of a view's folder walk at the same time share one walk, and `thimble list` does
not stat a workspace's mirror links."""
from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

import pytest

from app import notebook, runs, views


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
    return c


def _links(scratch: Path) -> set[str]:
    return {str((Path(d) / n).relative_to(scratch)) for d, ds, fs in os.walk(scratch) for n in [*fs, *ds]
            if (Path(d) / n).is_symlink()}


def test_each_entry_of_the_corpus_folder_is_one_link_and_git_is_left_out(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    assert _links(scratch) == {"README.md", "runs"}
    assert os.readlink(scratch / "runs") == str(corpus / "runs")
    assert (scratch / "runs/a/agents/agent-1.jsonl").read_text() == "{}\n"  # every corpus file, by its relative path
    assert not (scratch / ".git").exists()


def test_a_pass_lists_the_corpus_folder_alone_however_many_files_lie_under_it(corpus, tmp_path, monkeypatch):
    """A folder of a million screenshots (AI Village's) costs the kernel's start what a folder of ten does."""
    for i in range(500):
        (corpus / "runs" / "a" / "agents" / f"agent-{i + 2}.jsonl").write_text("{}\n")
    listed: list[str] = []
    real = os.scandir

    def spy(path="."):
        listed.append(str(path))
        return real(path)

    monkeypatch.setattr(notebook.os, "scandir", spy)
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    notebook.mirror_corpus(corpus, scratch)
    monkeypatch.undo()
    assert set(listed) == {str(corpus.resolve()), str(scratch)}
    assert _links(scratch) == {"README.md", "runs"}


def test_a_file_added_or_removed_below_the_corpus_folder_shows_at_once(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    (corpus / "runs" / "a" / "new.jsonl").write_text("{}\n")
    (corpus / "runs" / "b" / "manifest.json").unlink()
    assert (scratch / "runs/a/new.jsonl").read_text() == "{}\n"  # with no pass between
    assert not os.path.lexists(scratch / "runs/b/manifest.json")
    (corpus / "NOTES.md").write_text("n")
    (corpus / "README.md").unlink()
    notebook.mirror_corpus(corpus, scratch)  # an entry of the corpus folder itself: at the next pass
    assert (scratch / "NOTES.md").read_text() == "n" and not os.path.lexists(scratch / "README.md")


def test_a_removed_folder_takes_its_link_and_a_kernels_files_stay(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    (scratch / "made-by-a-cell.csv").write_text("x")
    (scratch / "README.md").unlink()  # a cell removed a link
    shutil.rmtree(corpus / "runs")
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "made-by-a-cell.csv").read_text() == "x"
    assert (scratch / "README.md").is_symlink()
    assert not os.path.lexists(scratch / "runs")


def test_a_kernels_file_where_the_corpus_has_a_folder_wins(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "runs").write_text("mine")
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "runs").read_text() == "mine"
    assert (scratch / "README.md").is_symlink()


def test_a_corpus_link_is_mirrored_only_while_its_target_exists(corpus, tmp_path):
    (corpus / "to-readme").symlink_to(corpus / "README.md")
    (corpus / "broken").symlink_to(corpus / "nowhere")
    (corpus / "runs" / "a" / "to-readme").symlink_to(corpus / "README.md")
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "to-readme").read_text() == "hi"
    assert not os.path.lexists(scratch / "broken")
    assert (scratch / "runs/a/to-readme").read_text() == "hi"  # below an entry, the corpus's own link


def test_callers_of_a_folder_walk_at_the_same_time_share_one_walk(corpus, monkeypatch):
    from app import corpus_tree

    walks: list[str] = []
    gate = threading.Event()
    real = corpus_tree.os.scandir

    def slow(path):
        if str(path) == str(corpus):
            walks.append(str(path))
            gate.wait(5)
        return real(path)

    monkeypatch.setattr(corpus_tree.os, "scandir", slow)
    corpus_tree.forget(corpus)
    got: list[int] = []
    threads = [threading.Thread(target=lambda: got.append(len(views.folder_paths(corpus)))) for _ in range(4)]
    for t in threads:
        t.start()
    time.sleep(0.2)
    gate.set()
    for t in threads:
        t.join()
    assert walks == [str(corpus)] and got == [5, 5, 5, 5]


def test_last_used_counts_a_workspace_s_files_and_folders_but_not_its_mirror_links(corpus, tmp_path):
    ws = tmp_path / "ws"
    notebook.mirror_corpus(corpus, ws / "scratch")
    made = ws / "notebooks" / "main.json"
    made.parent.mkdir(parents=True)
    made.write_text("{}")
    t = time.time() - 3600
    for d, ds, fs in os.walk(ws):
        for n in [*ds, *fs]:
            p = Path(d) / n
            later = t + 600 if p.is_symlink() else t  # a link's own time is never read
            os.utime(p, (later, later), follow_symlinks=False)
    os.utime(ws, (t, t))
    os.utime(made, (t + 60, t + 60))
    assert runs.last_used(ws) == pytest.approx(t + 60)


def test_a_folder_removed_soon_after_it_was_made_takes_its_links(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    (corpus / "runs" / "c").mkdir()
    (corpus / "runs" / "c" / "manifest.json").write_text("{}")  # made just now
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "runs/c/manifest.json").read_text() == "{}"
    (corpus / "runs" / "c" / "manifest.json").unlink()
    (corpus / "runs" / "c").rmdir()
    notebook.mirror_corpus(corpus, scratch)
    assert not os.path.lexists(scratch / "runs/c/manifest.json")


def test_a_corpus_file_that_becomes_a_folder_is_mirrored_as_a_folder(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "README.md").is_symlink()
    (corpus / "README.md").unlink()
    (corpus / "README.md").mkdir()
    (corpus / "README.md" / "part.md").write_text("one")
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "README.md").is_dir()
    assert (scratch / "README.md/part.md").read_text() == "one"


def test_a_corpus_link_whose_target_appears_later_is_mirrored(corpus, tmp_path):
    target = tmp_path / "elsewhere.txt"
    (corpus / "late").symlink_to(target)
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    assert not os.path.lexists(scratch / "late")
    target.write_text("here now")
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "late").read_text() == "here now"


def test_a_pass_does_not_follow_a_kernel_s_link(corpus, tmp_path):
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "dangling").symlink_to(tmp_path / "nothing")
    (scratch / "runs").unlink()
    (scratch / "runs").symlink_to(outside)  # a cell put a link where the mirror had runs
    shutil.rmtree(corpus / "runs")
    notebook.mirror_corpus(corpus, scratch)
    assert os.path.lexists(outside / "dangling")


def test_a_folder_the_per_file_mirror_of_earlier_versions_left_becomes_its_link_unless_a_kernel_wrote_in_it(
        corpus, tmp_path):
    """Earlier versions mirrored the corpus file by file: a folder in scratch for each corpus folder, a link for each
    file, a million links for AI Village's screenshots. Such a folder goes at the next pass and its link takes its
    place; one a cell wrote a file into is the kernel's, and keeps its links and the file."""
    (corpus / "logs").mkdir()
    (corpus / "logs" / "l.txt").write_text("l")
    scratch = tmp_path / "scratch"
    for d, ds, fs in os.walk(corpus):
        ds[:] = [x for x in ds if x != ".git"]
        here = scratch / os.path.relpath(d, corpus)
        here.mkdir(parents=True, exist_ok=True)
        for f in fs:
            (here / f).symlink_to(Path(d) / f)
    (scratch / "logs" / "made-by-a-cell.csv").write_text("x")
    notebook.mirror_corpus(corpus, scratch)
    assert os.readlink(scratch / "runs") == str(corpus / "runs")
    assert (scratch / "runs/b/agents/agent-1.jsonl").read_text() == "{}\n"
    assert (scratch / "logs" / "made-by-a-cell.csv").read_text() == "x"
    assert os.readlink(scratch / "logs" / "l.txt") == str(corpus / "logs" / "l.txt")
