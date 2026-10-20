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


def test_a_line_ref_opens_its_record(folder):
    got = corpus.resolve(folder, "runs/a.jsonl#L2")
    assert got["kind"] == "record" and got["line"] == 2 and got["record"]["outcome"] == "merged"
    rng = corpus.resolve(folder, "runs/a.jsonl#L1-L2")
    assert rng["kind"] == "range" and rng["meta"]["end"] == 2


def test_a_csv_row_ref(folder):
    got = corpus.resolve(folder, "results.csv#row=2")
    assert got["record"] == {"run": "b", "outcome": "failed"} and got["line"] == 3


def test_pages_and_search(folder):
    page = corpus.page(folder, "notes.md", 1, 10)
    assert page["total_lines"] == 3 and page["records"][0]["blocks"][0]["text"] == "# Notes"
    assert corpus.find_in_file(folder, "notes.md", "one")["lines"] == [3]
    hits = list(corpus.grep(folder, "parser"))
    assert hits[0]["path"] == "runs/a.jsonl" and hits[-1]["done"] is True
