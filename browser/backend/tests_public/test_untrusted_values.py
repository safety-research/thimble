"""What the server reads from a file that sandboxed code can write is untrusted input: a card's code writes its whole
workspace but for a few names (kernel_wrap), so a value the server reads from a file there names no file or folder
until it is checked the way a route checks the same kind of value (a slug, an id, a name). Each case below is one where
such a value led the server, which runs in no sandbox, to a file outside the workspace."""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import concepts, config, investigation, nofollow, notebook, undo

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh_undo():
    undo.forget()
    yield
    undo.forget()


def _outside(tmp_path_factory) -> Path:
    """A folder outside the workspace that holds a made-up file of the person's."""
    d = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    (d / "made-up-settings.json").write_text('{"made": "up"}\n')
    return d


def _up_to(folder: Path, target: Path) -> str:
    """`target` spelled from `folder` with ../ parts, as a value a card writes into a file of its workspace."""
    return "../" * len(folder.parts) + str(target).lstrip("/")


def test_undo_skips_a_step_a_card_appended_whose_names_lead_outside_the_workspace(tmp_path_factory):
    """undo.jsonl lies in the workspace: a step a card's code appended there named the document to restore or remove
    by its `target`, its investigation by `inv` and a deleted label's files by `trash`, each taken as it was, so the next
    Undo or Redo wrote, removed or moved files wherever their ../ parts led."""
    outside = _outside(tmp_path_factory)
    (outside / "made-up0.json").write_text(json.dumps({"name": "the person's own"}))
    inv = investigation.ensure_main(CORPUS).resolve()
    trash = (config.workspace_dir(CORPUS) / undo.TRASH_NAME).resolve()
    stamp = "2026-11-03T00:00:00.000+00:00"
    doc = {"type": "step", "ts": stamp, "kind": "doc", "op": "edited", "by": "", "label": "edit the report",
           "after": {"title": "x"}}
    steps = [
        {**doc, "id": "made0001", "target": _up_to(inv, outside / "made-up-settings"), "inv": "main", "which": "doc",
         "before": None},
        {**doc, "id": "made0002", "target": _up_to(inv, outside / "made-up-written"), "inv": "main", "which": "doc",
         "before": {"hooks": {"made-up": "chosen by the card"}}},
        {**doc, "id": "made0003", "target": _up_to(inv, outside / "made-up-frame"), "inv": "main", "which": "frame",
         "before": {"title": "chosen by the card"}},
        {"type": "step", "id": "made0004", "ts": stamp, "kind": "label", "op": "deleted", "target": "made-up0",
         "by": "", "label": "delete label made-up", "trash": _up_to(trash, outside), "cards": [], "filters": {}},
        {"type": "step", "id": "made0005", "ts": stamp, "kind": "card", "op": "deleted", "target": "../made-up",
         "by": "", "label": "delete card made-up", "before": {"id": "../made-up", "code": "1"}, "after": None},
        # a rewritten journal's redo stack, which Redo applies forward: a label deleted again into `trash`, a document
        # written as `after`
        {"type": "step", "id": "made0006", "ts": stamp, "kind": "label", "op": "deleted", "target": "made-up1",
         "by": "", "label": "delete label made-up", "trash": _up_to(trash, outside), "cards": [], "filters": {},
         "stack": "redo"},
        {**doc, "id": "made0007", "target": _up_to(inv, outside / "made-up-redone"), "inv": "main", "which": "doc",
         "before": None, "stack": "redo"},
    ]
    ws = config.workspace_dir(CORPUS)
    concepts.write_concept(ws, concepts.new_concept("made-up label") | {"id": "made-up1"})
    with undo.log_path(CORPUS).open("a") as f:  # what a card's code can append to its workspace's journal
        f.writelines(json.dumps(s) + "\n" for s in steps)
    trash.mkdir()  # the trash folder, which a card's code can make in its workspace too
    for press, side in ((undo.redo, "redo"), (undo.undo, "undo")):  # the analyst's Redo, then Undo, until none is left
        for _ in steps:
            if undo.labels(CORPUS)[side] is None:
                break
            with contextlib.suppress(HTTPException):
                press(CORPUS)
        assert sorted(os.listdir(outside)) == ["made-up-settings.json", "made-up0.json"]
        assert (outside / "made-up0.json").read_text() == json.dumps({"name": "the person's own"})
        assert concepts.read_concept(ws, "made-up0") is None and concepts.read_concept(ws, "made-up1") is not None
    assert undo.labels(CORPUS)["undo"] is None and undo.labels(CORPUS)["redo"] is None


def _up_from(folder: Path, target: Path) -> str:
    """`target` spelled below a made-up folder of `folder` with ../ parts, as a name a card writes into a file of its
    workspace that the server puts in a path under `folder` (the made-up folder need not exist: the server's paths are
    normalized before they are opened)."""
    return "x/" + "../" * (len(folder.parts) + 1) + str(target).lstrip("/")


def _sleeper(*argv: str) -> subprocess.Popen:
    """A process of the test's own, in a session of its own, that sleeps; `argv` its command line's other words."""
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", *argv], start_new_session=True,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _stop(*procs: subprocess.Popen) -> None:
    for p in procs:
        with contextlib.suppress(OSError):
            p.kill()
        p.wait()


async def test_the_kernel_a_card_names_in_its_group_s_file_names_no_file_outside_the_workspace(tmp_path_factory):
    """A card keeps the kernel it runs on in its group's file, notebooks/<id>.json, which a card's code writes, and the
    server took that name as it was for the kernel's files (kernels/k-<name>.json, .conn.json, .log and the rest), so a
    name with ../ parts had the server make, write, truncate and remove files wherever they led."""
    outside = _outside(tmp_path_factory)
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "made-up group")
    cell = notebook.new_cell("code", "analyst", "made-up card", nb["id"], code="print(6 * 7)")
    cell["kernel"] = _up_from(ws / notebook.KERNELS_DIR, outside / "made-up")  # what a card's code can write there
    (ws / notebook.KERNELS_DIR / "k-x").mkdir(parents=True)  # and the folder its ../ parts start from
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    notebook.clear_cache()
    mode = outside.stat().st_mode
    try:
        stored = await notebook.run_cell(CORPUS, nb["id"], cell["id"])
    finally:
        await notebook.shutdown_all()
    assert sorted(os.listdir(outside)) == ["made-up-settings.json"] and outside.stat().st_mode == mode
    assert stored["status"] == "ok" and "42" in json.dumps(stored["outputs"])


async def test_a_kernel_s_record_names_no_process_group_the_server_signals():
    """A kernel's record, kernels/<key>.json, which a card's code writes, names the kernel's pid and its process group;
    the server checked that the pid is the kernel's own before it signals it, but then signalled the group the record
    named, so a record that named another group of the person's had the server stop it."""
    k = notebook._kernel(CORPUS, "made-up")
    kernel, victim = _sleeper("ipykernel_launcher", "-f", str(k.conn)), _sleeper("made-up-victim")
    try:
        nofollow.makedirs(k.record.parent)
        k.record.write_text(json.dumps({"pid": kernel.pid, "pgid": victim.pid, "connection_file": str(k.conn)}))
        await notebook._kill(k)
        assert victim.poll() is None, "the server signalled the process group the kernel's record named"
        assert kernel.wait(5) is not None
    finally:
        _stop(kernel, victim)
        notebook._exec_kernels.pop((CORPUS, "made-up"), None)


def test_thimble_stop_signals_and_removes_only_what_is_a_kernel_s_own(tmp_path_factory):
    """`thimble stop` ends the workspaces' kernels from their records, kernels/<key>.json, which a card's code writes:
    it took the record's connection file for the kernel's own, so a record that named a word of another process's
    command line had it signal that process's group, and one that named any file under the workspaces folder had it
    remove that file."""
    from app import cli

    ws = config.workspace_dir(CORPUS)
    other = config.WORKSPACES_DIR / "made-up-other"
    other.mkdir()
    (other / "settings.json").write_text('{"made": "up"}')
    kernels = ws / notebook.KERNELS_DIR
    kernels.mkdir(exist_ok=True)
    kernel, victim = _sleeper("ipykernel_launcher", "-f", "/made-up/k.conn.json"), _sleeper("made-up-victim")
    try:
        (kernels / "k-one.json").write_text(json.dumps({"pid": kernel.pid, "pgid": victim.pid,
                                                        "connection_file": "ipykernel_launcher"}))
        (kernels / "k-two.json").write_text(json.dumps({"pid": 0, "connection_file": str(other / "settings.json")}))
        cli.stop_kernels(config.WORKSPACES_DIR)
        assert victim.poll() is None and kernel.poll() is None, "thimble stop signalled a process no record may name"
        assert (other / "settings.json").read_text() == '{"made": "up"}'
    finally:
        _stop(kernel, victim)


def test_a_kernel_s_connection_file_names_no_socket_but_the_loopback_s():
    """The connection file a kernel's channels open, kernels/<key>.conn.json, lies where a card's code writes; the
    server writes it with the loopback's address over TCP, and a file that names another transport or address (an ipc
    socket's path, another host) is not one of the server's."""
    k = notebook._kernel(CORPUS, "made-up")
    try:
        nofollow.makedirs(k.conn.parent)
        for info in ({"transport": "ipc", "ip": "/made-up/socket"}, {"transport": "tcp", "ip": "203.0.113.7"}):
            k.conn.write_text(json.dumps({**info, "shell_port": 1, "iopub_port": 2, "stdin_port": 3, "control_port": 4,
                                          "hb_port": 5, "key": "made-up", "signature_scheme": "hmac-sha256"}))
            kc = None
            with pytest.raises(ValueError):
                kc = notebook._client(k.conn)
            if kc is not None:
                notebook._close_client(kc)
    finally:
        notebook._exec_kernels.pop((CORPUS, "made-up"), None)


@pytest.fixture()
def runtime_on(monkeypatch):
    """The server's own runtime on (runtime.py), in workspace `mini`, as test_runtime's `on` fixture has it."""
    from app import runtime

    monkeypatch.setenv("THIMBLE_RUNTIME", "on")
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    runtime._spaces.clear()
    yield runtime
    runtime._spaces.clear()


def test_main_s_chat_that_runtime_main_json_names_is_one_a_route_would_take(runtime_on, tmp_path_factory):
    """runtime/main.json names main's chat, whose id the server puts in the names of main's transcript and state files
    (runtime/<id>.jsonl, runtime/convs/main-<id>.*.json); a card's code writes that file, so an id with ../ parts had
    the server move, write and read main's files wherever they led."""
    runtime = runtime_on
    outside = _outside(tmp_path_factory)
    d = config.workspace_dir(CORPUS) / runtime.DIR
    (d / "convs").mkdir(parents=True)
    (d / "convs" / "main.api.json").write_text('[{"role": "user", "content": "made-up"}]')  # a state from before chats
    planted = _up_from(d / "convs", outside / "made-up")
    (d / "main.json").write_text(json.dumps({"session": planted}))
    sp = runtime.ensure(CORPUS)
    assert runtime.SID_OK.match(sp.sid) and sp.main_path.parent == d
    assert json.loads((d / "main.json").read_text())["session"] == sp.sid
    assert sorted(os.listdir(outside)) == ["made-up-settings.json"]


def test_the_claude_code_session_a_card_names_in_a_state_file_is_never_resumed(runtime_on, tmp_path_factory):
    """On Claude Code sign-in, the session main and its agents resume is kept in runtime/convs/<chat>.cc.json, which a
    card's code writes; the server passed that id to Claude Code as it was (`--resume <id>` for the checker's fork of
    main, which runs outside any sandbox), so an id that starts with a dash was read as an option, and a link there had
    the server read the file it points to."""
    from app import runtime_api, runtime_cc

    outside = _outside(tmp_path_factory)
    (outside / "made-up.cc.json").write_text(json.dumps({"session_id": "0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"}))
    sp = runtime_on.ensure(CORPUS)
    state = sp.main.state_path("cc")
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps({"session_id": "--made-up-option"}))
    assert runtime_api.cc_main_session(CORPUS) is None
    assert runtime_cc.options(sp.main, sp.main.spec(), {}).resume is None
    state.unlink()
    state.symlink_to(outside / "made-up.cc.json")
    assert runtime_api.cc_main_session(CORPUS) is None
    state.unlink()
    state.write_text(json.dumps({"session_id": "0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"}))
    assert runtime_api.cc_main_session(CORPUS) == "0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
