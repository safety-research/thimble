"""What the server reads from a file that sandboxed code can write is untrusted input: a card's code writes its whole
workspace but for a few names (kernel_wrap), so a value the server reads from a file there names no file or folder
until it is checked the way a route checks the same kind of value (a slug, an id, a name). Each case below is one where
such a value led the server, which runs in no sandbox, to a file outside the workspace."""
from __future__ import annotations

import base64
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
    by its `target`, its investigation by `inv` and a deleted label's files by `trash`, each taken as it was, so the
    next Undo or Redo wrote, removed or moved files wherever their ../ parts led."""
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


SID = "e7b0a1f2-0000-4000-8000-0000000000ab"


def _human(text: str) -> str:
    """A transcript's line of the analyst's message `text`, as Claude Code writes it."""
    return json.dumps({"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}) + "\n"


@pytest.fixture()
def mirror(tmp_path, monkeypatch):
    """The mirror (session.py) with no session attached, and Claude Code's config dir the test's own, whose projects
    folder holds a project's folder with session SID's transcript, as Claude Code keeps it. Yields that transcript."""
    from app import events, session

    claude = tmp_path / "claude-config"
    project = claude / "projects" / "-made-up-project"
    project.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    monkeypatch.setattr(config, "_served_config", None)
    for table in (session._live, session._shim_pids, session._shim_configs, events._subs):
        table.clear()
    transcript = project / f"{SID}.jsonl"
    transcript.write_text(_human("hello"))
    yield transcript
    for table in (session._live, session._shim_pids, session._shim_configs, events._subs):
        table.clear()


def _restored(sid: str) -> None:
    """What a card's code can write so that the next attach of `sid` reads as the server's restart under it: main's
    meta naming it attached."""
    from app import agents

    meta = agents.ensure_main(CORPUS)
    meta["attached"] = {"session": sid, "cwd": str(config.corpus_dir(CORPUS)), "since": "2026-11-03T00:00:00+00:00"}
    agents.write_meta(CORPUS, meta)


def test_what_sessions_json_names_is_taken_only_where_the_mirror_itself_keeps_it(mirror, tmp_path_factory):
    """sessions.json, which a card's code writes, keeps each session's transcript, working folder and pid and where the
    tail stood; after a restart the mirror took them as they were, so a record that named a file outside had the server
    read it into main's chat and into its agents' context, run the checker's fork of main in a folder of the card's
    choosing, and give claude a word that starts with a dash as an option (the turn's cut, --resume-session-at)."""
    from app import agents, context, session

    outside = _outside(tmp_path_factory)
    planted = outside / f"{SID}.jsonl"
    planted.write_text(_human("OUTSIDE-SECRET"))
    (config.workspace_dir(CORPUS) / "sessions.json").write_text(json.dumps({SID: {
        "session": SID, "cwd": str(outside), "transcript_path": str(planted), "pid": "../made-up",
        "since": "2026-11-03T00:00:00+00:00",
        "cursor": {"transcript": str(planted), "offset": 0, "last_cut": "--made-up-option"},
        "continues": {"session": "made-up", "transcript": str(outside / "made-up.jsonl"), "at": 0}}}))
    _restored(SID)
    lv = session.attach(CORPUS, SID, "")
    assert lv is not None
    session.tail_once(lv)
    assert (lv.transcript_path, lv.cwd, lv.pid, lv.last_cut) == (str(mirror), "", None, None)
    assert "OUTSIDE-SECRET" not in agents.paths(CORPUS, agents.MAIN_ID)[1].read_text()
    session._live.clear()
    assert context.transcript_path(CORPUS) == mirror


def test_an_orientation_s_session_a_card_names_in_its_chat_backfills_no_file_outside(mirror, tmp_path_factory):
    """An orientation's calls are stored from its session's transcripts on their first read, the session named by the
    orientation's chat's meta, chats/<id>.meta.json, which a card's code writes; the server found the transcript by
    that name as it was, so a name that was a path had it store the calls of any transcript-shaped file into the
    workspace, where the card reads them."""
    from app import agents, calls

    outside = _outside(tmp_path_factory)
    (outside / "made-up.jsonl").write_text("\n".join(json.dumps(r) for r in (
        {"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_made_up", "name": "Read", "input": {"file_path": "made-up"}}]}},
        {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_made_up", "content": "OUTSIDE-SECRET"}]}})) + "\n")
    chat = agents.new_agent(CORPUS, "orient", "made-up orientation", announce=False)
    agents.update_agent(CORPUS, chat["id"], session=str(outside / "made-up"))
    assert calls.backfill(CORPUS, chat["id"]) == 0
    assert not calls.path(CORPUS, chat["id"]).exists()


def test_a_workflow_s_folder_a_card_names_in_its_chat_is_not_read(mirror, tmp_path_factory):
    """A workflow's chat keeps the folder of its agents' transcripts in its meta, chats/<id>.meta.json, which a card's
    code writes; after a restart the mirror read every agent-*.jsonl of the folder the meta named into the chat, where
    the card reads it."""
    from app import agents, session

    outside = _outside(tmp_path_factory)
    (outside / "agent-made0up.jsonl").write_text(json.dumps(
        {"type": "user", "origin": {"kind": "human"}, "message": {"content": "OUTSIDE-SECRET"}}) + "\n")
    chat = agents.new_agent(CORPUS, session.SUBAGENT_ROLE, "made-up workflow", announce=False, session=SID)
    agents.update_agent(CORPUS, chat["id"], workflow_dir=str(outside), status="running")
    (config.workspace_dir(CORPUS) / "sessions.json").write_text(json.dumps({SID: {
        "session": SID, "transcript_path": str(mirror), "since": "2026-11-03T00:00:00+00:00", "subs": {}}}))
    _restored(SID)
    lv = session.attach(CORPUS, SID, "")
    assert lv is not None
    session.tail_once(lv)
    assert "OUTSIDE-SECRET" not in agents.paths(CORPUS, chat["id"])[1].read_text()


def test_a_fork_s_transcript_is_read_only_from_main_s_session_folder(tmp_path_factory):
    """An agent's context renders main's conversation from main's transcript, each thread's fork's calls read from the
    fork's transcript, subagents/agent-<id>.jsonl beside it, by the id a task notification in main's transcript names;
    on the Messages API that transcript lies in the workspace, which a card's code writes, so an id with ../ parts had
    the server read a file wherever they led into the agent's context."""
    from app import context

    outside = _outside(tmp_path_factory)
    call = {"type": "tool_use", "id": "toolu_x", "name": "Read", "input": {"file_path": "OUTSIDE-SECRET"}}
    (outside / "made-up.jsonl").write_text(
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [call]}}) + "\n")
    d = config.workspace_dir(CORPUS) / "runtime"
    subagents = d / "made-up-session" / "subagents"
    (subagents / "agent-x").mkdir(parents=True)  # what a card's code can make there
    agent = _up_from(subagents, outside / "made-up")
    main = d / "made-up-session.jsonl"
    main.write_text("\n".join(json.dumps(r) for r in (
        {"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_fork", "name": "Agent",
             "input": {"description": "thread:made-up", "prompt": "thread:made-up"}}]}},
        {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": (
            f"<task-notification><task-id>{agent}</task-id><tool-use-id>toolu_fork</tool-use-id>"
            "<status>completed</status></task-notification>")}})) + "\n")
    assert "OUTSIDE-SECRET" not in json.dumps([e.__dict__ for e in context._entries(main)])


def test_a_long_output_claude_code_saved_is_read_through_no_link_a_card_left_on_its_way(tmp_path_factory):
    """An orientation's long tool outputs are stored whole from the file Claude Code saved each to, which the call's
    record names (toolUseResult.persistedOutputPath, <session>/tool-results/<file> beside the session's transcript). On
    the Messages API the transcripts lie in the workspace, which a card's code writes, and the server followed a link
    put in place of tool-results/, so it stored the file the link led to among the calls, where the card reads it."""
    from app import calls

    outside = _outside(tmp_path_factory)
    (outside / "made-up.txt").write_text("OUTSIDE-SECRET\n")
    d = config.workspace_dir(CORPUS) / "runtime"
    (d / SID).mkdir(parents=True)
    (d / f"{SID}.jsonl").write_text("")
    (d / SID / calls.TOOL_RESULTS).symlink_to(outside, target_is_directory=True)
    rec = {"type": "user", "sessionId": SID,
           "toolUseResult": {"persistedOutputPath": str(d / SID / calls.TOOL_RESULTS / "made-up.txt")}}
    block = {"type": "tool_result", "tool_use_id": "toolu_made_up", "content": "the output's preview"}
    calls.number(CORPUS, "made-up-orient", "toolu_made_up", "Bash", {"command": "made-up"})
    calls.Numbering(CORPUS, "made-up-orient").result("toolu_made_up", block, rec)
    assert calls.get(CORPUS, "made-up-orient", 1)["result"] == "the output's preview"


async def test_a_thread_s_picture_is_read_only_where_the_server_keeps_it(tmp_path_factory):
    """The picture the browser took when a thread opened is kept at anchors/<thread>.png, and the thread's meta,
    chats/<id>.meta.json, which a card's code writes, names it; `screenshot` of the thread read the file the meta named,
    as it was, and handed it to the model that asked, so a meta that named a file outside gave a model that file."""
    from app import agents, tools

    outside = _outside(tmp_path_factory)
    (outside / "made-up.png").write_bytes(b"OUTSIDE-SECRET")
    meta = agents.new_thread(CORPUS, "board.jsonl:L1", "made-up words")
    agents.update_agent(CORPUS, meta["id"], anchor_image=str(outside / "made-up.png"))
    got = await tools.call(CORPUS, "screenshot", {"ref": f"thread:{meta['id']}"})
    assert base64.b64encode(b"OUTSIDE-SECRET").decode() not in json.dumps(got.content)


async def test_a_side_thread_s_calls_are_read_only_from_its_fork_s_transcript(monkeypatch, tmp_path_factory):
    """The citations of a side thread's answer are checked against the Bash calls of the thread's fork, read from the
    fork's transcript, whose path the reply's record, marks/<turn>.json, keeps; a card's code writes that file, and the
    server read whatever file it named."""
    from app import marks

    outside = _outside(tmp_path_factory)
    (outside / "made-up.jsonl").write_text("{}\n")
    turn = "0123abcd"
    p = config.workspace_dir(CORPUS) / "marks" / f"{turn}.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"turn": turn, "items": [], "thread": {"chat": "made-up", "about": "made-up",
                                                                   "calls": str(outside / "made-up.jsonl")}}))
    read: list = []
    monkeypatch.setattr(marks, "_transcript_messages", lambda path: read.append(path) or [])

    async def fork(*_a, **_k):
        return {"answer": "", "calls": []}

    with contextlib.suppress(Exception):
        await marks._check_share(CORPUS, {"sid": SID}, turn, "", [{"n": 1, "words": "made-up", "sentence": "made-up"}],
                                 (str(config.corpus_dir(CORPUS)), str(config.corpus_dir(CORPUS))), fork)
    assert str(outside / "made-up.jsonl") not in map(str, read)


def _other_report() -> Path:
    """Another workspace's report, as its writer kept it: what a name with ../ parts in this one could reach."""
    p = config.WORKSPACES_DIR / "made-up-other" / "investigations" / investigation.MAIN / "report.json"
    p.parent.mkdir(parents=True)
    (p.parent / "investigation.json").write_text("{}")
    p.write_text(json.dumps({"title": "OUTSIDE-SECRET", "sections": [{"heading": "Made-up", "paragraphs": [
        {"sentences": [{"id": "s1", "text": "A made-up sentence of the other workspace."}]}]}]}))
    return p


async def test_a_document_a_writer_s_chat_names_is_one_a_route_would_take(monkeypatch):
    """When a writer's chat ends done, each shown check runs on the document its meta, chats/<id>.meta.json, names; a
    card's code writes that file, and the server took the name as it was for the document's file, the run's own folder
    and its comments, so a name with ../ parts had it read another workspace's report and write there."""
    from app import checks, report_types

    other = _other_report()
    before = other.read_text()
    planted = "x/../../../../made-up-other/investigations/main/report"
    assert report_types.read_doc(CORPUS, investigation.MAIN, planted) is None
    with pytest.raises(HTTPException):
        report_types.write_doc(CORPUS, investigation.MAIN, planted, {"title": "chosen by the card", "sections": []})
    try:
        assert await checks.start_run(CORPUS, "heads-up", planted, route="follow-on") is None
    finally:
        for act in list(checks._active.values()):
            if act.task is not None:
                act.task.cancel()
        checks._active.clear()
    assert other.read_text() == before
    assert sorted(p.name for p in other.parent.iterdir()) == ["investigation.json", "report.json"]


async def test_a_document_type_a_model_names_is_one_a_route_would_take():
    """read_ref("type:<name>") and a writer's save name a document type by the model's own words, which the server
    took as they were for the type's folder, so a name with ../ parts read any folder's type.json, prompt.md and
    rubric.md into the model's context."""
    from app import report_types, tools

    folder = config.WORKSPACES_DIR / "made-up-other" / "made-up-type"
    folder.mkdir(parents=True)
    (folder / "type.json").write_text(json.dumps({"slug": "made-up", "name": "Made-up", "renderer": "document"}))
    (folder / "prompt.md").write_text("OUTSIDE-SECRET\n")
    planted = "x/../../../made-up-other/made-up-type"
    assert report_types.read_type(CORPUS, planted) is None
    got = await tools.call(CORPUS, "read_ref", {"ref": f"type:{planted}"}, session="writer:report")
    assert "OUTSIDE-SECRET" not in json.dumps(got.content)


def test_a_card_s_id_names_its_check_s_pictures_only_when_a_route_would_take_it(tmp_path_factory):
    """A card check keeps its pictures, and a fix the card from before it, in card-checks/<card>/, by the card's id as
    the card's group's file holds it, which a card's code writes; an id with ../ parts had the server make folders and
    write pictures wherever they led."""
    from app import card_check, checkstore

    outside = _outside(tmp_path_factory)
    planted = _up_from(config.workspace_dir(CORPUS) / card_check.SHOTS_DIR, outside / "made-up")
    with pytest.raises(ValueError):
        card_check._keep(CORPUS, planted, "made-up-card.png", b"\x89PNG made-up")
    with pytest.raises(ValueError):
        checkstore._before_path(CORPUS, planted, "fix_made_up")
    assert sorted(os.listdir(outside)) == ["made-up-settings.json"]


def test_the_export_copies_a_chat_s_log_only_by_a_chat_s_id(tmp_path_factory, tmp_path):
    """The workspace's export copies each chat's log, chats/<id>.jsonl, by the id its meta, chats/<id>.meta.json, holds;
    a card's code writes the meta, and an id with ../ parts had the export copy any .jsonl file the person can read into
    the zip they download and share, under a name that unpacks outside its folder."""
    import zipfile

    from app import agents, export

    outside = _outside(tmp_path_factory)
    (outside / "made-up.jsonl").write_text(json.dumps({"ts": "2026-11-03T00:00:00Z", "text": "OUTSIDE-SECRET"}) + "\n")
    agents.ensure_main(CORPUS)
    chats = config.workspace_dir(CORPUS) / "chats"
    (chats / "made-up.meta.json").write_text(json.dumps({"id": _up_from(chats, outside / "made-up")}))
    (chats / "x").mkdir()  # and the folder its ../ parts start from
    export.build(CORPUS, tmp_path / "made-up.zip")
    with zipfile.ZipFile(tmp_path / "made-up.zip") as z:
        assert not [n for n in z.namelist() if ".." in n.split("/")]
        assert all(b"OUTSIDE-SECRET" not in z.read(n) for n in z.namelist())


def test_an_earlier_version_s_session_a_chat_names_ends_only_a_claude_code_session(tmp_path_factory):
    """At its start the server ends the processes an earlier version's sessions left running, by the pid a chat's meta,
    chats/<id>.meta.json, keeps, when that process's command line names the meta's session; a card's code writes the
    meta, so a meta that named any process and a word of its command line had the server stop that process, and one
    whose background session started with a dash gave `claude stop` an option."""
    from app import agents, subagents

    victim = _sleeper("made-up-victim")
    ran: list = []
    real_run = subprocess.run

    def spy(argv, *a, **k):
        ran.append(list(argv))
        return real_run(["true"], *a, **k)

    try:
        chat = agents.new_agent(CORPUS, "orient", "made-up orientation", announce=False)
        agents.update_agent(CORPUS, chat["id"], status="running", pid=victim.pid, session="made-up-victim",
                            bg="--made-up-option")
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(subprocess, "run", spy)
            subagents.stop_old_background(CORPUS)
            subagents.close_old(CORPUS)
        assert victim.poll() is None, "the server stopped a process a chat's meta named"
        assert not [r for r in ran if "--made-up-option" in r]
    finally:
        _stop(victim)
