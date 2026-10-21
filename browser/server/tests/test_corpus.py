"""Files are read only inside the folder, and refs open the lines they name (corpus.py)."""
import os

import pytest

from thimble_browser import corpus


def test_paths_outside_the_folder_are_refused(folder, tmp_path):
    (tmp_path / "secret.txt").write_text("no")
    os.symlink(tmp_path / "secret.txt", folder / "link.txt")
    for rel in ("../secret.txt", "/etc/passwd", "link.txt", "runs/../../secret.txt"):
        with pytest.raises(corpus.OutsideFolder):
            corpus.inside(folder, rel)
    assert all(f["path"] != "link.txt" for f in corpus.walk(folder))


def test_a_folder_of_only_folders_counts_their_files(tmp_path):
    d = tmp_path / "tasks"
    for task in ("alpha", "beta"):
        (d / task / "logs").mkdir(parents=True)
        (d / task / "logs" / "run.jsonl").write_text("{}\n")
        (d / task / "notes.md").write_text("x\n")
    (d / "alpha" / ".hidden").write_text("x\n")
    (d / ".git").mkdir()
    (d / ".git" / "HEAD").write_text("x\n")
    top = corpus.folder(d, "")
    assert top["files"] == [] and top["n_files"] == 4
    assert [f["n_files"] for f in top["folders"]] == [2, 2]
