"""The server's own file access below a folder that sandboxed code writes (app/nofollow.py): a path is opened one part
at a time from its root without following a link, so a link a card's code put in a workspace leads no read, write,
move or removal of the server's outside it, and a FIFO there holds none of them. The server's writes in a workspace
go through it: each case below is one a link a card left there led outside before."""
from __future__ import annotations

import json
import os
import sys
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


def deep_chain(top: Path, depth: int) -> int:
    """A chain of `depth` folders named d below the folder `top`, made one folder at a time by descriptor (its path is
    longer than a path may be), as a card's code can make one; the descriptor of its last folder, which the caller
    closes."""
    fd = os.open(top, os.O_RDONLY | os.O_DIRECTORY)
    for _ in range(depth):
        os.mkdir("d", dir_fd=fd)
        below = os.open("d", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
        os.close(fd)
        fd = below
    return fd


def test_a_tree_deeper_than_python_s_recursion_limit_goes_and_no_link_in_it_is_followed(tmp_path_factory):
    """A card's code can make a chain of folders deeper than Python's recursion limit where the server removes a tree
    (an srt kernel's HOME, a folder in scratch/). The removal recursed and raised RecursionError, which is no OSError, so
    neither its ignore_errors nor its callers' suppress(OSError) caught it, and every later start of the kernel failed.
    Now the removal walks with a stack of its own: the whole tree goes, and a link at its bottom goes as a link."""
    outside = _outside(tmp_path_factory)
    top = config.workspace_dir(CORPUS) / "made-up-home"
    top.mkdir(parents=True)
    fd = deep_chain(top, sys.getrecursionlimit() + 500)
    try:
        os.symlink(outside, "a-link", dir_fd=fd)
        os.close(os.open("a-file", os.O_WRONLY | os.O_CREAT, 0o600, dir_fd=fd))
    finally:
        os.close(fd)
    nofollow.rmtree(top)
    assert not os.path.lexists(top)
    assert sorted(os.listdir(outside)) == ["made-up-dotfile"]
    assert (outside / "made-up-dotfile").read_text() == "# the person's own\n"


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
    readers = {"whole": lambda: investigation._read_jsonl(log),
               "after": lambda: investigation._read_jsonl_after(log, 0),
               "tail": lambda: investigation._last_stored_seq(log), "id": lambda: investigation.log_id(CORPUS)}
    threads = [threading.Thread(target=lambda k=k, f=f: got.__setitem__(k, f()), daemon=True)
               for k, f in readers.items()]
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


def test_a_report_type_s_texts_are_read_through_no_link_a_card_left_in_their_place(tmp_path_factory):
    """A custom document type is a folder of the workspace, report-types/<slug>/, which a card's code writes: its
    type.json was read as nofollow reads it, but its prompt.md and rubric.md by their paths, so a link a card's code put
    in their place had the server hand a writer, which reads the type's text (read_ref "type:<slug>"), the file it
    points to."""
    from app import report_types

    outside = _outside(tmp_path_factory)
    (outside / "made-up-credentials").write_text("MADE-UP-SECRET-TOKEN 0123456789\n")
    d = report_types.types_dir(CORPUS) / "notes"
    d.mkdir(parents=True)
    (d / "type.json").write_text(json.dumps({"slug": "notes", "name": "Notes", "renderer": "document",
                                             "created_by": "analyst"}))
    for name in ("prompt.md", "rubric.md"):
        (d / name).symlink_to(outside / "made-up-credentials")
    t = report_types.read_type(CORPUS, "notes")
    assert t is not None and (t["prompt"], t["rubric"]) == ("", "")
    assert "MADE-UP-SECRET-TOKEN" not in report_types.type_form(t)


def test_a_label_s_definition_is_read_through_no_link_a_card_left_in_its_place(tmp_path_factory):
    """A label's definition, concepts/<id>.json, was read by its path, so a link a card's code put in its place had the
    server read the file it points to as the label, its name and rule shown to main and the analyst."""
    from app import concepts

    outside = _outside(tmp_path_factory)
    (outside / "made-up.json").write_text(json.dumps({"name": "OUTSIDE-SECRET", "spec": "OUTSIDE-SECRET"}))
    ws = config.workspace_dir(CORPUS)
    concepts.concepts_dir(ws).mkdir(parents=True)
    (concepts.concepts_dir(ws) / "made-up0.json").symlink_to(outside / "made-up.json")
    assert concepts.read_concept(ws, "made-up0") is None
    assert concepts.list_concepts(ws) == []


# --------------------------------------------------------------------- the server's reads of the workspace's files
# A file of the workspace that the server reads may be a FIFO or a link a card's code left in its place: a FIFO held the
# read (and, on the event loop, the whole server), and a link had it read the file it points to into a chat, an agent's
# context, a store of the workspace's or the export. Each case below plants one where a reader of the server's reads,
# and the reader reads it as no file.

_FIFOS: list[Path] = []


def _fifo(path: Path) -> Path:
    """A FIFO at `path`, as a card's code can make one in its workspace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.exists():
        path.unlink()
    os.mkfifo(path)
    _FIFOS.append(path)
    return path


def _link(path: Path, outside: Path, text: str) -> Path:
    """A link at `path` to a file outside the workspace that holds `text`, as a card's code can leave one."""
    target = outside / f"made-up-{len(list(outside.iterdir()))}"
    target.write_text(text)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.exists():
        path.unlink()
    path.symlink_to(target)
    return path


def _line(**rec) -> str:
    return json.dumps(rec) + "\n"


def _ws() -> Path:
    return config.workspace_dir(CORPUS)


def _secret_line() -> str:
    return _line(type="user", origin={"kind": "human"}, message={"content": "OUTSIDE-SECRET"},
                 ts="2026-11-03T00:00:00Z", text="OUTSIDE-SECRET", n=1, id="toolu_made_up", seq=99, uuid="u-1")


def _case_tail_records(out):
    from app import plans
    return lambda: plans.tail_records(_fifo(_ws() / "chats" / "made-up.jsonl")), lambda r: r == []


def _case_last_uuid(out):
    from app import runtime
    return lambda: runtime._last_uuid(_fifo(_ws() / "runtime" / "made-up.jsonl")), lambda r: r is None


def _case_chat_of(out):
    from app import runtime
    return lambda: runtime._chat_of(_fifo(_ws() / "runtime" / "made-up.jsonl")), lambda r: r["turns"] == 0


def _case_context_records(out):
    from app import context
    return lambda: context._records(_fifo(_ws() / "runtime" / "made-up.jsonl")), lambda r: r == []


def _case_marks_transcript(out):
    from app import marks
    return lambda: marks._transcript_messages(str(_fifo(_ws() / "runtime" / "made-up.jsonl"))), lambda r: r == []


def _case_session_cost(out):
    from app import proposer
    return lambda: proposer.session_cost(str(_fifo(_ws() / "runtime" / "made-up.jsonl"))), lambda r: r == 0.0


def _case_sub_meta(out):
    from app import session
    path = _ws() / "runtime" / "s" / "subagents" / "agent-made-up.jsonl"
    _fifo(path.with_name("agent-made-up.meta.json"))
    return lambda: session._read_meta_json(path), lambda r: r == {}


def _case_fork_ref(out):
    from app import session
    return lambda: session._file_fork_ref(_fifo(_ws() / "runtime" / "made-up.jsonl"), "toolu_made_up"), \
        lambda r: r is None


def _case_continued_in(out):
    from app import session
    return lambda: session._continued_in(str(_fifo(_ws() / "runtime" / "made-up.jsonl"))), lambda r: r is None


def _case_held_events(out):
    from app import events
    events._held.pop(CORPUS, None)
    _fifo(_ws() / events.HELD_FILE)
    return lambda: events.held(CORPUS), lambda r: r == []


def _case_citing_documents(out):
    from app import investigation, tools
    _fifo(investigation.ensure_main(CORPUS) / "made-up.json")
    return lambda: tools._citing_documents(CORPUS, "c0ffee01"), lambda r: r == []


def _case_mark_interrupted(out):
    from app import checkstore, notebook
    return lambda: notebook._mark_interrupted(_fifo(_ws() / "notebooks" / "madeup01.json"), checkstore), \
        lambda r: r == []


def _case_work_texts(out):
    from app import work_files
    _fifo(_ws() / "notebooks" / "madeup01.json")
    return lambda: work_files._texts(_ws()), lambda r: r == []


def _case_work_read_text(out):
    from app import work_files
    return lambda: work_files._read_text(_fifo(_ws() / "check-work" / "made-up" / "notes.txt")), lambda r: r is None


def _case_render_theme(out):
    from app import render
    _fifo(_ws() / render.THEMES_FILE)
    return lambda: render.theme(CORPUS), lambda r: r == dict(render.DEFAULT_THEME)


def _case_libs_lock(out):
    from app import card_libs, view_libs
    _fifo(card_libs.folder(CORPUS) / view_libs.LIB_DIR / view_libs.LOCK_FILE)
    return lambda: view_libs.lock(card_libs.folder(CORPUS)), lambda r: r == {}


def _case_last_seq(out):
    from app import ledger
    return lambda: ledger.last_seq(_fifo(_ws() / "chats" / "made-up.jsonl")), lambda r: r == -1


def _case_label_rows(out):
    from app import labels_store
    return lambda: list(labels_store._read_rows(_fifo(_ws() / "labels" / "made-up.jsonl"), 0, 100)), lambda r: r == []


def _case_view_progress(out):
    from app import view_calls
    view_calls._calls[(CORPUS, "made-up")] = view_calls.Call("made-up", CORPUS, "made-up", 0.0,
                                                             progress=_fifo(_ws() / "view-indexes" / "made-up.json"))
    return lambda: view_calls.progress(CORPUS, "made-up"), lambda r: r is not None and "done" not in r


def _case_undo_journal(out):
    from app import undo
    undo.forget()
    _link(undo.log_path(CORPUS), out, _line(type="step", id="made0001", ts="2026-11-03T00:00:00Z", kind="card",
                                             op="deleted", target="madeup01", by="", label="OUTSIDE-SECRET",
                                             before={"id": "madeup01"}, after=None))
    return lambda: (undo.labels(CORPUS), undo.forget())[0], lambda r: r["undo"] is None


def _case_chat_events(out):
    from app import agents
    return lambda: agents.read_events(_link(_ws() / "chats" / "made-up.jsonl", out, _secret_line())), lambda r: r == []


def _case_chat_lines(out):
    from app import agents
    return lambda: agents.count_lines(_link(_ws() / "chats" / "made-up.jsonl", out, _secret_line())), \
        lambda r: r == 0


def _case_chat_meta(out):
    from fastapi import HTTPException

    from app import agents
    agents.ensure_main(CORPUS)
    _link(_ws() / "chats" / "madeup01.meta.json", out, json.dumps({"id": "madeup01", "title": "OUTSIDE-SECRET"}))

    def read():
        try:
            return agents.read_meta(CORPUS, "madeup01")
        except HTTPException as e:
            return e.status_code
    return read, lambda r: r == 404


def _case_chats_listed(out):
    from app import agents
    agents.ensure_main(CORPUS)
    _link(_ws() / "chats" / "madeup01.meta.json", out, json.dumps({"id": "madeup01", "title": "OUTSIDE-SECRET"}))
    return lambda: json.dumps(agents.list_chats(CORPUS)), lambda r: "OUTSIDE-SECRET" not in r


def _case_telemetry_events(out):
    from app import telemetry
    log = _link(_ws() / "investigations" / "main" / "events.jsonl", out, _secret_line())
    return lambda: telemetry._read_jsonl(log), lambda r: r == []


READERS = {f.__name__.removeprefix("_case_"): f for f in (
    _case_tail_records, _case_last_uuid, _case_chat_of, _case_context_records, _case_marks_transcript,
    _case_session_cost, _case_sub_meta, _case_fork_ref, _case_continued_in, _case_held_events,
    _case_citing_documents, _case_mark_interrupted, _case_work_texts, _case_work_read_text,
    _case_render_theme, _case_libs_lock, _case_last_seq, _case_label_rows, _case_view_progress,
    _case_undo_journal, _case_chat_events,
    _case_chat_lines, _case_chat_meta, _case_chats_listed, _case_telemetry_events)}


@pytest.mark.parametrize("reader", sorted(READERS))
def test_a_reader_of_the_workspace_s_files_reads_a_fifo_or_a_link_a_card_left_as_no_file(reader, tmp_path_factory):
    outside = _outside(tmp_path_factory)
    _FIFOS.clear()
    call, ok = READERS[reader](outside)
    got: dict = {}
    t = threading.Thread(target=lambda: got.setdefault("result", call()), daemon=True)
    t.start()
    t.join(3.0)
    held = t.is_alive()
    for fifo in _FIFOS:  # a read still held on a FIFO sees its end and goes
        try:
            os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
        except OSError:
            pass
    t.join(3.0)
    assert not held, f"{reader} was held by a FIFO in the workspace"
    assert "result" in got and ok(got["result"]), f"{reader} read {got.get('result')!r}"


def test_the_mirror_reads_no_link_a_card_left_in_place_of_main_s_transcript(tmp_path_factory):
    """On the Messages API main's transcript lies in the workspace's runtime folder (runtime.py), which a card's code
    writes; the mirror read it by its path, so a link left in its place had the server put the file it points to into
    main's chat."""
    from app import agents, session

    outside = _outside(tmp_path_factory)
    t = _ws() / "runtime" / "made-up-session.jsonl"
    t.parent.mkdir(parents=True)
    t.write_text("")
    session._live.clear()
    try:
        lv = session.attach(CORPUS, "made-up-session", str(config.corpus_dir(CORPUS)), str(t))
        assert lv is not None
        session.tail_once(lv)  # the tail stands at the transcript's end
        _link(t, outside, _secret_line())
        session.tail_once(lv)
        assert "OUTSIDE-SECRET" not in agents.paths(CORPUS, agents.MAIN_ID)[1].read_text()
    finally:
        session._live.clear()


def test_the_export_copies_no_link_and_waits_on_no_fifo_a_card_left_in_the_workspace(tmp_path_factory, tmp_path):
    """The export reads the workspace's files by their paths: a link a card's code left in place of a chat's log had
    the person's own file copied into the zip they share, and a FIFO in place of sessions.json held the export."""
    import zipfile

    from app import agents, export

    outside = _outside(tmp_path_factory)
    agents.ensure_main(CORPUS)
    (_ws() / "chats" / "madeup01.meta.json").write_text(json.dumps({"id": "madeup01", "title": "made-up"}))
    _link(_ws() / "chats" / "madeup01.jsonl", outside, _secret_line())
    _FIFOS.clear()
    _fifo(_ws() / "sessions.json")
    done: dict = {}
    t = threading.Thread(target=lambda: done.setdefault("manifest", export.build(CORPUS, tmp_path / "made-up.zip")),
                         daemon=True)
    t.start()
    t.join(10.0)
    held = t.is_alive()
    for fifo in _FIFOS:
        try:
            os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
        except OSError:
            pass
    t.join(10.0)
    assert not held, "the export was held by a FIFO in the workspace"
    with zipfile.ZipFile(tmp_path / "made-up.zip") as z:
        assert all(b"OUTSIDE-SECRET" not in z.read(n) for n in z.namelist())


def test_undo_of_a_document_s_first_save_removes_no_file_through_a_link_a_card_left(tmp_path_factory):
    """The undo of a document's first save removes the document, investigations/main/<slug>.json, by its path: a card's
    code that put a link to another folder in place of investigations/main had the next Undo remove the file of that
    name in the folder the link led to."""
    from fastapi import HTTPException

    from app import investigation, report_types, undo

    outside = _outside(tmp_path_factory)
    (outside / "report.json").write_text('{"made": "up", "keep": true}\n')
    undo.forget()
    try:
        report_types.write_doc(CORPUS, investigation.MAIN, "report", {"title": "Made-up report", "sections": []})
        inv = investigation.inv_dir(CORPUS, investigation.MAIN)
        _swap_for_link(inv, outside)
        for _ in range(3):  # the analyst's Undo, until it reaches the document's first save
            if undo.labels(CORPUS)["undo"] is None:
                break
            try:
                undo.undo(CORPUS)
            except HTTPException:
                pass
    finally:
        undo.forget()
    assert (outside / "report.json").read_text() == '{"made": "up", "keep": true}\n'


def test_a_rewrite_writes_into_the_file_that_is_there_and_through_no_link(tmp_path_factory):
    """nofollow.rewrite (the workspace's settings.json and config.json, which a kernel wrapper hides by a mount on each
    file) writes the file in place, never a new file renamed over it: the file keeps its inode, a shorter text leaves
    nothing of the longer one, and a link at its name is replaced by a file of the server's own, never followed."""
    outside = _outside(tmp_path_factory)
    ws = config.workspace_dir(CORPUS)
    p = ws / "settings.json"
    p.write_text('{"a": "a long value the next text is shorter than"}\n')
    inode = p.stat().st_ino
    nofollow.rewrite(p, b'{"a": 1}\n')
    assert p.read_text() == '{"a": 1}\n' and p.stat().st_ino == inode and p.stat().st_mode & 0o777 == 0o600
    p.unlink()
    p.symlink_to(outside / "made-up-dotfile")
    nofollow.rewrite(p, b'{"b": 2}\n')
    assert not p.is_symlink() and p.read_text() == '{"b": 2}\n'
    assert (outside / "made-up-dotfile").read_text() == "# the person's own\n"
