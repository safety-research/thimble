"""The server's own file access below a folder that sandboxed code writes (app/nofollow.py): a path is opened one part
at a time from its root without following a link, so a link a card's code put in a workspace leads no read, write,
move or removal of the server's outside it, and a FIFO there holds none of them. The server's writes in a workspace
go through it: each case below is one a link a card left there led outside before."""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import pytest

from app import config, nofollow

CORPUS = "mini"


def _outside(tmp_path_factory) -> Path:
    """A folder outside the workspace that holds a made-up dotfile of the person's."""
    d = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    (d / "made-up-dotfile").write_text("# the person's own\n")
    return d


def _swap_for_link(folder: Path, target: Path) -> None:
    """What a card's code can do to a folder of its workspace: move it aside and put a link to `target` in its place."""
    if folder.exists():
        folder.rename(folder.with_name(folder.name + ".moved"))
    folder.parent.mkdir(parents=True, exist_ok=True)
    folder.symlink_to(target, target_is_directory=True)


def test_a_link_on_the_way_fails_the_open_and_a_link_at_the_name_is_replaced_by_the_server_s_own_file(
        tmp_path_factory):
    outside = _outside(tmp_path_factory)
    ws = config.workspace_dir(CORPUS)
    _swap_for_link(ws / "made-up-folder", outside)
    for call in (lambda: nofollow.read_bytes(ws / "made-up-folder" / "made-up-dotfile"),
                 lambda: nofollow.append_bytes(ws / "made-up-folder" / "made-up-dotfile", b"x\n"),
                 lambda: nofollow.replace(ws / "made-up-folder" / "made-up-dotfile", b"x\n"),
                 lambda: nofollow.makedirs(ws / "made-up-folder" / "below"),
                 lambda: nofollow.rmtree(ws / "made-up-folder" / "made-up-dotfile")):
        with pytest.raises(nofollow.Linked):
            call()
    (ws / "log.jsonl").symlink_to(outside / "made-up-dotfile")
    nofollow.append_bytes(ws / "log.jsonl", b"{}\n")
    assert not (ws / "log.jsonl").is_symlink() and (ws / "log.jsonl").read_bytes() == b"{}\n"
    assert sorted(os.listdir(outside)) == ["made-up-dotfile"]
    assert (outside / "made-up-dotfile").read_text() == "# the person's own\n"


def test_a_fifo_where_the_server_reads_holds_no_thread(tmp_path):
    ws = config.workspace_dir(CORPUS)
    os.mkfifo(ws / "made-up.json")
    got: list = []
    reader = threading.Thread(target=lambda: got.append(json.dumps(__import__("app.ledger").ledger.read_json(
        ws / "made-up.json", "none"))), daemon=True)
    reader.start()
    reader.join(5)
    assert got == ['"none"']


def test_a_resolved_path_is_opened_from_the_root_and_a_path_outside_every_root_as_before(tmp_path):
    real = tmp_path.resolve() / "real"
    real.mkdir()
    (real / "f.txt").write_text("in place\n")
    assert nofollow.read_text(real / "f.txt", root="/") == "in place\n"
    (tmp_path / "link").symlink_to(real, target_is_directory=True)
    with pytest.raises(nofollow.Linked):
        nofollow.read_text(tmp_path.resolve() / "link" / "f.txt", root="/")
    assert nofollow.split(tmp_path / "link" / "f.txt") is None  # outside the workspaces: followed, as before
    assert nofollow.read_text(tmp_path / "link" / "f.txt") == "in place\n"


def test_main_s_conversation_state_is_saved_through_no_link_left_at_its_temp_file_s_name(tmp_path_factory):
    """runtime_api._save wrote `<state>.tmp`, a name a card's code can know, then renamed it over the state: a link
    left at that name had the server write main's whole conversation into the file it points to."""
    from app import runtime_api

    outside = _outside(tmp_path_factory)
    state = config.workspace_dir(CORPUS) / "runtime" / "convs" / "main-made-up.api.json"
    state.parent.mkdir(parents=True)
    state.with_name(state.name + ".tmp").symlink_to(outside / "made-up-dotfile")
    runtime_api._save(state, [{"role": "user", "content": "the analyst's words"}])
    assert json.loads(state.read_text())[0]["content"] == "the analyst's words"
    assert (outside / "made-up-dotfile").read_text() == "# the person's own\n"


def test_a_deleted_view_s_indexes_go_without_removing_a_folder_a_link_at_view_indexes_leads_to(tmp_path_factory):
    """The indexes of a deleted view were removed with shutil.rmtree by their path, workspaces/<c>/view-indexes/<slug>,
    which follows a link a card's code put in place of view-indexes/: the folder of that name where it leads went."""
    from app import view_indexes

    outside = _outside(tmp_path_factory)
    (outside / "made-up-view").mkdir()
    (outside / "made-up-view" / "the-person-s.txt").write_text("kept\n")
    _swap_for_link(config.workspace_dir(CORPUS) / view_indexes.INDEXES_SUBDIR, outside)
    view_indexes.drop(CORPUS, "made-up-view")
    assert (outside / "made-up-view" / "the-person-s.txt").read_text() == "kept\n"


def test_a_card_s_long_output_lands_in_no_folder_a_link_at_its_outputs_folder_leads_to(tmp_path_factory, monkeypatch):
    """A card's output past the limit is kept whole in notebooks/outputs/<card>-<n>.txt, a write of the card's own text,
    and the side files of its earlier runs are removed there: by their paths, so a link a card's code left in place of
    the folder had the server write and remove files in the folder it points to."""
    from app import notebook

    for name, n in (("OUTPUT_MAX_LINES", 4), ("OUTPUT_HEAD_LINES", 2), ("OUTPUT_TAIL_LINES", 2)):
        monkeypatch.setattr(notebook, name, n)
    outside = _outside(tmp_path_factory)
    (outside / "c0ffee-0.txt").write_text("the person's own\n")
    ws = config.workspace_dir(CORPUS)
    _swap_for_link(ws / notebook.OUTPUTS_DIR, outside)
    text = "".join(f"row {i}\n" for i in range(40))
    bundle = {"_stream": "stdout", "text/plain": text}
    with pytest.raises(OSError):
        notebook.bound_outputs(ws, "c0ffee", [bundle], fresh=True)
    assert sorted(os.listdir(outside)) == ["c0ffee-0.txt", "made-up-dotfile"]
    assert (outside / "c0ffee-0.txt").read_text() == "the person's own\n"


def test_a_chat_s_log_is_appended_to_through_no_link_left_in_its_place(tmp_path_factory):
    """A chat's log, chats/<id>.jsonl, gets a line per record (agents.append), by its path: a link a card's code put in
    its place had the server append the record to the file it points to."""
    from app import agents

    outside = _outside(tmp_path_factory)
    agents.ensure_main(CORPUS)
    _, log = agents.paths(CORPUS, agents.MAIN_ID)
    log.unlink()
    log.symlink_to(outside / "made-up-dotfile")
    agents.append(log, {"type": "user", "text": "made-up words"})
    assert (outside / "made-up-dotfile").read_text() == "# the person's own\n"
    assert not log.is_symlink() and "made-up words" in log.read_text()


def test_a_group_s_file_is_read_through_no_link_left_in_its_place(tmp_path_factory):
    """A group's file, notebooks/<id>.json, was read by its path, so a link a card's code put in its place had the server
    read the file it points to as the group, its title and cards shown to main and the analyst."""
    from app import notebook

    outside = _outside(tmp_path_factory)
    (outside / "made-up.json").write_text(json.dumps({"title": "OUTSIDE-TITLE", "cells": []}))
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "made-up group")
    path = notebook._nb_file(ws, nb["id"])
    path.unlink()
    path.symlink_to(outside / "made-up.json")
    notebook.clear_cache()
    assert notebook.read_notebook(ws, nb["id"]) is None


def test_main_s_conversation_state_is_read_through_no_link_left_in_its_place(tmp_path_factory):
    """The conversation the Messages API runtime sends the model again is loaded from the workspace's runtime folder
    (runtime_api._load), by its path, so a link a card's code put in its place had the server send the model the file
    it points to as main's conversation."""
    from app import runtime_api

    outside = _outside(tmp_path_factory)
    (outside / "made-up.json").write_text(json.dumps([{"role": "user", "content": "OUTSIDE-SECRET"}]))
    state = config.workspace_dir(CORPUS) / "runtime" / "convs" / "main-made-up.api.json"
    state.parent.mkdir(parents=True)
    state.symlink_to(outside / "made-up.json")
    assert runtime_api._load(state) == []


def _writer_after(fifo: Path, wait_s: float, seen: dict) -> None:
    """The test's own way out of a read held on `fifo`: after `wait_s`, a writer opens it, so the read sees its end, and
    `seen` notes that it had to."""
    def run() -> None:
        time.sleep(wait_s)
        try:
            os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
        except OSError:  # no reader held on it
            return
        seen["released"] = True

    threading.Thread(target=run, daemon=True).start()


async def test_a_fifo_a_card_puts_at_the_event_log_holds_no_emit(tmp_path_factory):
    """investigation.emit runs on the server's one event loop, and to number the next event it read the tail of
    investigations/main/events.jsonl by its path, after the server's first emit for the workspace: a FIFO a card's code
    put there held the loop, and every workspace, request and session with it, until a writer came."""
    from app import investigation

    investigation.emit(CORPUS, investigation.MAIN, {"type": "made-up"})
    log = investigation.inv_dir(CORPUS, investigation.MAIN) / "events.jsonl"
    log.unlink()
    os.mkfifo(log)
    seen: dict = {}
    _writer_after(log, 3.0, seen)
    investigation.emit(CORPUS, investigation.MAIN, {"type": "made-up"})
    assert not seen, "the emit waited on the card's FIFO until a writer came"


def test_the_event_log_s_readers_read_no_fifo_and_no_link_a_card_left_as_the_log(tmp_path_factory):
    """The event stream reads the log whole on a reopen, its tail every few seconds for another process's events, and
    the log's id from investigation.json, each by its path: a FIFO a card's code put there held the reader, and a link
    had the server stream the file it points to as the workspace's events."""
    from app import investigation

    outside = _outside(tmp_path_factory)
    (outside / "made-up.jsonl").write_text(json.dumps({"seq": 7, "type": "OUTSIDE-SECRET"}) + "\n")
    (outside / "made-up.json").write_text(json.dumps({"created": "OUTSIDE-SECRET"}))
    d = investigation.ensure_main(CORPUS)
    log, meta = d / "events.jsonl", d / "investigation.json"
    meta.unlink()
    for path, target in ((log, outside / "made-up.jsonl"), (meta, outside / "made-up.json")):
        path.symlink_to(target)
    assert investigation._read_jsonl(log) == []
    assert investigation._read_jsonl_after(log, 0) == ([], 0)
    assert investigation._last_stored_seq(log) == -1
    assert investigation.log_id(CORPUS) == ""
    for path in (log, meta):
        path.unlink()
        os.mkfifo(path)
    got: dict = {}
    readers = {"whole": lambda: investigation._read_jsonl(log), "after": lambda: investigation._read_jsonl_after(log, 0),
               "tail": lambda: investigation._last_stored_seq(log), "id": lambda: investigation.log_id(CORPUS)}
    threads = [threading.Thread(target=lambda k=k, f=f: got.__setitem__(k, f()), daemon=True) for k, f in readers.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join(3.0)
    for path in (log, meta):  # a reader still held on a FIFO sees its end and goes
        try:
            os.close(os.open(path, os.O_WRONLY | os.O_NONBLOCK))
        except OSError:
            pass
    assert got == {"whole": [], "after": ([], 0), "tail": -1, "id": ""}
