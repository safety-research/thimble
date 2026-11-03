"""The built-in tools of an agent the server runs on the Messages API (runtime_tools.py): Read and Grep number a file's
lines as the citation check does (the terminal's validator, plugin/engine/kernel/evidence.py read_lines), so a line
either names is the line a citation of it names."""
from __future__ import annotations

import json
import os
import stat
import sys

import pytest

from app import config, marks, runtime_tools


async def test_read_and_grep_count_lines_at_newlines_alone_as_the_citation_check_does(tmp_path):
    """A JSON string may hold U+2028, U+2029 or U+0085 as they are (json.dumps with ensure_ascii=False writes them so),
    and str.splitlines() breaks a line at each; the check, wc -l, sed -n and grep -n count "\\n" alone, and a "\\r"
    before it is the line's end. Every line after such a character keeps its own number in Read and Grep."""
    corpus, ws = tmp_path / "corpus", tmp_path / "ws"
    corpus.mkdir()
    ws.mkdir()
    breaks = ["\u2028", "\u0085", "\u2029"]
    rows = [json.dumps({"id": i, "text": f"message {i}" + (f"{breaks[i % 3]}more" if i % 4 == 0 else "")},
                       ensure_ascii=False) for i in range(1, 41)]
    rows[29] = json.dumps({"id": 30, "text": "the total was 136.48"})
    f = corpus / "chat_messages.jsonl"
    f.write_bytes("\r\n".join(rows[:20]).encode() + b"\r\n" + "\n".join(rows[20:]).encode() + b"\n")
    box = runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus], write_roots=[ws])

    found = await runtime_tools.call(box, "Grep", {"pattern": r"136\.48", "path": str(f)})
    assert found.text == f"{f}:30: {rows[29]}"
    read = await runtime_tools.call(box, "Read", {"file_path": str(f), "offset": 30, "limit": 1})
    assert read.text == f"{30:>6}\t{rows[29]}\n[10 more lines: read on with offset 31]"
    assert marks.evidence().read_lines(str(f), 30, 30) == (30, [rows[29]])
    # the lines with those characters read whole, and a CRLF line without its "\r"
    whole = await runtime_tools.call(box, "Read", {"file_path": str(f), "offset": 1, "limit": 40})
    assert whole.text.split("\n") == [f"{n:>6}\t{row}" for n, row in enumerate(rows, 1)]


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


# a card's code that keeps swapping the folder `tmp` with a link to `target` from a thread of its own
FLIP_CELL = """
import os, threading, time
T, O = {tmp!r}, {target!r}
said = {{"flips": 0}}
def loop():
    end = time.monotonic() + 60
    while time.monotonic() < end:
        try:
            os.rename(T, T + '.real')
            os.symlink(O, T)
            time.sleep(0.0003)
            os.unlink(T)
            os.rename(T + '.real', T)
            said["flips"] += 1
            time.sleep(0.0003)
        except OSError:
            time.sleep(0.001)
threading.Thread(target=loop, daemon=True, name="made-up-flipper").start()
time.sleep(0.3)
print(said["flips"] > 0)
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_main_s_tools_never_go_through_a_link_a_card_swaps_in_while_they_run(wrap, monkeypatch, workspaces_tmp,
                                                                                   tmp_path_factory):
    """Box checks a path by its real path, and the tools then opened it again by that path, so a link a card's code put
    in place of a folder on the way between the two led the open outside: with a card swapping the workspace's tmp/
    with a link to an outside folder, some of main's Writes there landed in that folder and some Reads returned its
    file. Now each tool opens the real path Box checked one part at a time without following a link (nofollow): a call
    the swap catches fails, and none reaches the folder."""
    from app import kernel_wrap, notebook, runtime, srt

    works = kernel_wrap.srt_works(srt.node(), srt.package(config.REPO_ROOT)) if wrap == "srt" else (
        sys.platform.startswith("linux") and kernel_wrap.works())
    if not works:
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    monkeypatch.setattr(runtime, "engine", lambda: "api")
    outside = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    (outside / "secret.txt").write_text("OUTSIDE-SECRET")
    ws, temp, corpus = config.workspace_dir("mini"), config.temp_dir("mini"), config.corpus_dir("mini")
    (temp / "secret.txt").write_text("the workspace's own\n")
    box = runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus, ws], write_roots=[ws / "card-libs", temp],
                            temp=temp)
    wrote = read = 0
    seen: list[str] = []
    try:
        flipping = await notebook.run_code("mini", FLIP_CELL.format(tmp=str(temp.resolve()), target=str(outside)), "main",
                                           kernel="k1")
        assert "True" in str(flipping["outputs"]), flipping["outputs"]
        for i in range(600):
            got = await runtime_tools.call(box, "Write", {"file_path": str(temp / f"main-{i}.txt"), "content": "by main"})
            wrote += not got.is_error
            for tool, args in (("Read", {"file_path": str(temp / "secret.txt")}),
                               ("Grep", {"pattern": "SECRET|own", "path": str(temp)}),
                               ("Edit", {"file_path": str(temp / "secret.txt"), "old_string": "own",
                                         "new_string": "own"})):
                r = await runtime_tools.call(box, tool, args)
                read += not r.is_error
                if "OUTSIDE-SECRET" in r.text:
                    seen.append(f"{tool}: {r.text[:80]}")
    finally:
        await notebook.shutdown_all()
    landed = sorted(p for p in os.listdir(outside) if p != "secret.txt")
    assert wrote and read, "the swap left no call to land"
    assert not landed and not seen, (landed[:5], seen[:3])
    assert (outside / "secret.txt").read_text() == "OUTSIDE-SECRET"

