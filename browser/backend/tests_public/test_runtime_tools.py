"""The built-in tools of an agent the server runs on the Messages API (runtime_tools.py): main's Read, Write and Edit
touch only the folders they may, a link a card's code left in the workspace leads them nowhere outside it, and while
Settings' Read only is on, what they and main's prompt say of the corpus folder names that switch."""
from __future__ import annotations

import os
import re
import stat

import pytest

from app import config, events, runtime_tools


def test_while_read_only_is_on_main_is_told_so_and_that_the_analyst_can_turn_it_off(workspaces_tmp):
    """Settings' Read only keeps main and its thread forks from writing the corpus folder (corpus_edits false). While it
    is on, a write there is refused, and the refusal, the Bash, Write and Edit descriptions and main's prompt say that
    Read only is on, and how the analyst turns it off. While it is off, main's prompt says that turning it on stops the
    writes."""
    ws, corpus = config.workspace_dir("mini"), config.corpus_dir("mini")
    box = runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus, ws], write_roots=[ws / "card-libs"],
                            corpus_edits=False)
    with pytest.raises(ValueError) as refused:
        box.path("notes.md", write=True)
    bash, write, edit = (runtime_tools.describe(n, False) for n in ("Bash", "Write", "Edit"))
    prompt = {"on": events.CORPUS_WRITES[False], "off": events.CORPUS_WRITES[True]}  # main's, by Read only
    for text in (str(refused.value), bash, write, edit, prompt["on"]):
        assert re.search(r'"Read only" is on|turned on "Read only"', text), text
    for text in (str(refused.value), write, edit, prompt["on"]):
        assert re.search(r'turn (it |"Read only" )?off', text), text
    assert 'turn on "Read only"' in prompt["off"]


def test_a_link_a_card_left_in_the_workspace_leads_neither_thimble_nor_main_s_tools_outside_it(workspaces_tmp,
                                                                                               tmp_path_factory):
    """A card's code writes the workspace, so it can put a link to any folder in place of one there, such as tmp/, the
    TMPDIR of main's commands on the Messages API (config.temp_dir). thimble took the link for the folder: the server
    made the folder it points to private (0700), and main's Read, Write and Edit, which resolve the folders they may
    touch, read and wrote in it. Now thimble makes tmp/ again in place of a link whenever it asks for the folder, and a
    folder of the workspace whose real path lies outside the workspace is none of the tools' folders."""
    ws = config.workspace_dir("mini")
    outside = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    os.chmod(outside, 0o755)
    (outside / "secret.txt").write_text("OUTSIDE-SECRET")
    temp = config.temp_dir("mini")
    temp.rmdir()
    temp.symlink_to(outside, target_is_directory=True)
    assert config.temp_dir("mini") == temp and temp.is_dir() and not temp.is_symlink()
    assert stat.S_IMODE(os.stat(outside).st_mode) == 0o755
    # a link left there after thimble asked for the folder, during a turn of main's
    temp.rmdir()
    temp.symlink_to(outside, target_is_directory=True)
    corpus = config.corpus_dir("mini")
    box = runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus, ws], write_roots=[ws / "card-libs", temp],
                            temp=temp)
    for path, write in ((outside / ".bashrc", True), (temp / "secret.txt", False), (outside / "secret.txt", False)):
        with pytest.raises(ValueError, match="outside the folders"):
            box.path(str(path), write=write)
    assert box.path(str(ws / "card-libs" / "lib.py"), write=True) == ws.resolve() / "card-libs" / "lib.py"
    assert sorted(os.listdir(outside)) == ["secret.txt"]
