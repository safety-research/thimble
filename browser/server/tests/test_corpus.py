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
