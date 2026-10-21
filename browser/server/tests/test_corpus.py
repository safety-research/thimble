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


def test_a_path_cited_from_a_subfolder_opens_its_file(tmp_path):
    (tmp_path / "shift").mkdir()
    (tmp_path / "shift" / "notes.jsonl").write_text('{"who": "alpha"}\n{"who": "beta"}\n')
    got = corpus.resolve(tmp_path, "notes.jsonl#L2")
    assert got["path"] == "shift/notes.jsonl" and got["line"] == 2
    assert got["ref"] == "shift/notes.jsonl#L2" and got["moved_from"] == "notes.jsonl#L2"
    # a ref that names its file from the folder's top is read as written
    assert "moved_from" not in corpus.resolve(tmp_path, "shift/notes.jsonl#L1")


def test_a_path_several_files_end_with_is_the_one_the_session_read(tmp_path):
    for d in ("day1", "day2"):
        (tmp_path / d).mkdir()
        (tmp_path / d / "log.txt").write_text(f"{d}\n")
    corpus._LISTED.clear()
    with pytest.raises(ValueError, match="2 files end with /log.txt"):
        corpus.resolve(tmp_path, "log.txt#L1")
    assert corpus.resolve(tmp_path, "log.txt#L1", read=lambda: ["day2/log.txt"])["path"] == "day2/log.txt"


def test_a_cited_file_that_is_nowhere_fails_without_a_server_path(tmp_path):
    (tmp_path / "shift").mkdir()
    with pytest.raises(FileNotFoundError) as e:
        corpus.resolve(tmp_path, "gone.jsonl#L3")
    assert str(tmp_path) not in str(e.value) and "gone.jsonl" in str(e.value)
