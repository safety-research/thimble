"""The notebook kernel's sandbox (app/kernel_wrap.py, app/kernel_srt.mjs), in Anthropic's sandbox runtime (srt) and in
bubblewrap: a card's code reads and writes no file outside the workspace and the corpus, also through a link it left in
the workspace, and in the workspace it writes only its own folders, so none of the server's files is input a card's
code can forge. Each test runs a real kernel, and skips where its wrapper can't sandbox a process."""
from __future__ import annotations

import json
import os
import shutil
import stat
import sys

import pytest

from app import config, kernel_wrap, notebook, srt

SRT = srt.package(config.REPO_ROOT)
NODE = srt.node()
LINUX = sys.platform.startswith("linux")


def _wrap_works(wrap: str) -> bool:
    if wrap == "srt":
        return kernel_wrap.srt_works(NODE, SRT)
    return LINUX and kernel_wrap.works()


# a cell that tries to read `secret` and write `write` in a folder outside the workspace, then writes its own TMPDIR
OUTSIDE_CELL = """
import os
said = []
try:
    with open({secret!r}) as f:
        said.append(f.read().strip())
except OSError as e:
    said.append(type(e).__name__)
try:
    with open({write!r}, 'w') as f:
        f.write('written by a card')
    said.append('wrote')
except OSError as e:
    said.append(type(e).__name__)
t = os.environ['TMPDIR']
with open(os.path.join(t, 'own.csv'), 'w') as f:
    f.write('night,minutes\\n')
print(*said, os.path.islink(t), os.path.realpath(t) == t)
"""


def _outside(tmp_path_factory) -> tuple:
    """A folder outside the workspace, readable by all (0755), that holds a file a card must not read."""
    outside = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    os.chmod(outside, 0o755)
    (outside / "secret.txt").write_text("OUTSIDE-SECRET")
    return outside, outside / "secret.txt"


def _said(cell: dict) -> list[str]:
    return "".join(b.get("text/plain", "") for b in cell["outputs"]).split()


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_card_code_reads_and_writes_no_file_outside_the_workspace_even_through_a_link_left_at_its_tmp(
        wrap, monkeypatch, workspaces_tmp, tmp_path_factory):
    """A card's code reads no file of a folder outside the workspace and writes none there. On the Messages API every
    kernel's TMPDIR is the workspace's tmp/ (config.temp_dir), and a link left in its place (as an earlier version's
    kernel could leave one) gives the next kernel nothing: its TMPDIR is tmp/ made again as a folder, and the folder
    the link led to stays as it was."""
    from app import runtime

    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    monkeypatch.setattr(runtime, "engine", lambda: "api")
    outside, secret = _outside(tmp_path_factory)
    try:
        tmp = config.temp_dir("mini")
        shutil.rmtree(tmp)
        tmp.symlink_to(outside, target_is_directory=True)
        cell = await notebook.run_code("mini", OUTSIDE_CELL.format(secret=str(secret), write=str(outside / "k.txt")),
                                       "main")
    finally:
        await notebook.shutdown_all()
    said = _said(cell)
    assert len(said) == 4 and "OUTSIDE-SECRET" not in said and "wrote" not in said, said
    assert said[2:] == ["False", "True"], said
    assert sorted(os.listdir(outside)) == ["secret.txt"]
    assert stat.S_IMODE(os.stat(outside).st_mode) == 0o755
    assert (config.temp_dir("mini") / "own.csv").is_file()


# B25: the kernel writes only its own folders of the workspace.
#
# made-up files where the server keeps its own state in a workspace, each by the name the server gives it, which no
# card's run makes the server write
SERVER_FILES = {
    "sessions.json": '{"sessions": {}}\n', "held-events.json": "[]\n", "answers.json": "{}\n", "notices.json": "[]\n",
    "render-theme.json": "{}\n", "runtime/main.json": '{"session": "made-up"}\n',
    "runtime/convs/main-made-up.api.json": "[]\n", "runtime/made-up.jsonl": "{}\n", "chats/made-up.jsonl": "{}\n",
    "chats/made-up.meta.json": "{}\n", "notebooks/made-up.json": "{}\n", "concepts/made-up.json": "{}\n",
    "labels/made-up.jsonl": '{"ref": "a.jsonl#L1", "label": "yes", "source": "code", "ts": "t"}\n',
    "marks/0000abcd.json": "{}\n", "report-types/notes/type.json": "{}\n", "report-types/notes/prompt.md": "made-up\n",
    "checks/made-up.json": "{}\n", "card-libs/lib/libs.json": "{}\n", "registry/made-up.json": "{}\n",
    "views/made-up.json": "{}\n", "extension/made-up.json": "{}\n", "writers/report/context.md": "made-up\n",
    "check-work/made-up/task.md": "made-up\n", "views-work/posts/notes.md": "made-up\n",
    "orient/work/notes.md": "made-up\n", ".trash/made-up/step.json": "{}\n",
}
# a card's code that tries every way to change the workspace outside its own folders (OWN, and its HOME) and prints
# what it managed as JSON: a file written, emptied, linked into its own temp folder, removed, moved, or its mode or
# times changed; a file, a folder, a link or a FIFO made in a folder; a folder moved; one of its own folders moved. A
# folder the sandbox hides (HIDDEN) shows the kernel a stand-in, under srt an empty tmpfs of the sandbox's own whose
# writes never reach the disk: it is only moved
ATTACK_SRC = r"""
import json, os
ws = os.path.realpath('..')
own = [os.path.join(ws, n) for n in OWN]
stand_ins = [os.path.join(ws, n) for n in HIDDEN]
home = os.path.realpath(os.environ['HOME'])
def mine(p):
    return any(p == o or p.startswith(o + os.sep) for o in [*own, *stand_ins, home])
done, tried = [], 0
def attempt(what, fn):
    global tried
    tried += 1
    try:
        fn()
        done.append(what)
    except OSError:
        pass
entries = [(ws, True)]
for root, dirs, files in os.walk(ws):
    dirs[:] = [d for d in dirs if not mine(os.path.join(root, d))]
    entries += [(os.path.join(root, d), True) for d in dirs] + [(os.path.join(root, f), False) for f in files]
hard = os.path.join(ws, 'tmp', 'made-up-hard-link')
for s in stand_ins:
    attempt('move ' + s, lambda: os.rename(s, s + '.moved'))
for p, folder in entries:
    if folder:
        attempt('file in ' + p, lambda: open(os.path.join(p, 'planted.json'), 'x').close())
        attempt('folder in ' + p, lambda: os.mkdir(os.path.join(p, 'planted-folder')))
        attempt('link in ' + p, lambda: os.symlink('/', os.path.join(p, 'planted-link')))
        attempt('FIFO in ' + p, lambda: os.mkfifo(os.path.join(p, 'planted-fifo')))
    else:
        attempt('write ' + p, lambda: open(p, 'a').write('planted'))
        attempt('empty ' + p, lambda: os.truncate(p, 0))
        attempt('hard link ' + p, lambda: os.link(p, hard))
        attempt('remove ' + p, lambda: os.unlink(p))
    if p != ws:
        attempt('move ' + p, lambda: os.rename(p, p + '.moved'))
        attempt('mode of ' + p, lambda: os.chmod(p, 0o777))
        attempt('times of ' + p, lambda: os.utime(p, (0, 0)))
for o in own:
    attempt('move ' + o, lambda: os.rename(o, o + '.moved'))
print(json.dumps({'tried': tried, 'entries': len(entries), 'done': done}))
"""


def _text(cell: dict) -> str:
    return "".join(b.get("text/plain", "") for b in cell["outputs"])


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_card_s_code_changes_nothing_of_the_workspace_but_its_own_folders(wrap, monkeypatch, workspaces_tmp):
    """The server keeps its own state in the workspace (the undo journal, the chats and their metas, the sessions, the
    groups, the canvas history, the labels and their stores, the kernels' records, the agents' folders and the rest),
    and the kernels could write all of it but a few hidden or read-only names, so each such file was input a card's
    code could forge. Now a kernel writes only its own folders (scratch/, tmp/, view-indexes/, and under srt its HOME):
    in every other folder of the workspace a card's code can make no file, folder, link or FIFO, and no file or folder
    there can it write, empty, link into its own folders, remove, move or change the mode or times of, nor can it move
    one of its own folders. The server's files stay as they were."""
    from app import labels_store

    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    ws = config.workspace_dir("mini")
    for rel, text in SERVER_FILES.items():
        (ws / rel).parent.mkdir(parents=True, exist_ok=True)
        (ws / rel).write_text(text)
    labels_store.rebuild_file(str(ws / "labels" / "made-up.jsonl"))
    kept = {p: p.read_bytes() for p in [*(ws / rel for rel in SERVER_FILES), ws / "labels" / "made-up.sqlite",
                                         *(ws / "trusted").iterdir()]}
    try:
        await notebook.run_code("mini", "print('a first card')", "main")  # the kernel's files, the group, the history
        cell = await notebook.run_code(
            "mini", f"OWN = {list(kernel_wrap.KERNEL_DIRS)!r}\nHIDDEN = {[kernel_wrap.LOCKS_DIR]!r}\n{ATTACK_SRC}", "main")
    finally:
        await notebook.shutdown_all()
    got = json.loads(_text(cell))
    assert got["done"] == [], got["done"][:20]
    assert got["entries"] > len(SERVER_FILES) and got["tried"] > 7 * len(SERVER_FILES), got
    assert [p for p, b in kept.items() if p.read_bytes() != b] == []
    assert [p for p in ws.rglob("*") if "planted" in p.name or p.name.endswith(".moved")] == []
    assert all(os.path.isdir(ws / name) and not os.path.islink(ws / name) for name in kernel_wrap.KERNEL_DIRS)
