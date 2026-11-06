"""thimble fix (engine/kernel/fixes.py) in a fix's temp folder (tmp/<id>/), which the fixer's sandbox and its tests' write
too: nothing thimble writes there, or has git make or remove there, follows a link that was left under the name. The
world is test_fixes.py's made-up thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, world  # noqa: E402, F401  (world is the fixture)


def test_nothing_thimble_writes_in_a_fixs_temp_folder_follows_a_link(world, monkeypatch, tmp_path):
    outside = tmp_path / "notes.txt"
    outside.write_text("the person's own notes\n")
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "echo made-up test output")
    r = made(world)
    tmp = FX.tmp_dir(r["id"])
    # the fixer's sandbox writes its temp folder: a link left where thimble writes the tests' log
    (tmp / "tests.log").symlink_to(outside)
    assert FX.done(r["id"], "Bar says read", "", within=30)["state"] == "ready"
    assert outside.read_text() == "the person's own notes\n"
    assert not (tmp / "tests.log").is_symlink() and "made-up test output" in (tmp / "tests.log").read_text()
    # the change of a fix that a round's words name, in the temp folder of the fix the round changes
    c = FX.new("a note")
    (FX.tmp_dir(c["id"]) / f"fix-{r['id']}.patch").symlink_to(outside)
    assert FX.round_(c["id"], f"fold in fix {r['id']}")["patches"]
    assert outside.read_text() == "the person's own notes\n"
    assert "read" in (FX.tmp_dir(c["id"]) / f"fix-{r['id']}.patch").read_text()
    # the earlier change r gives its next fixer
    (tmp / "earlier.patch").symlink_to(outside)
    FX.not_now(r["id"])
    FX.redo(r["id"])
    assert outside.read_text() == "the person's own notes\n" and not (tmp / "earlier.patch").is_symlink()
