"""Events to main in terminal mode (app/event_files.py, events.post's terminal branch): no server holds them, so a post
writes the event to the workspace's queue, a quiet one to held-events.json, and main's watcher takes it from the file;
the held hook prints each event's line once. The watcher's side is test_terminal_hooks.py."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading

import pytest
from terminal_fakes import CORPUS, MAIN, write_launch

from app import config, event_files, events, session
from app import subagent_files as sf


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    events._held.clear()
    session._live.clear()
    session._shadows.clear()
    session._expected.clear()
    yield
    session._live.clear()
    session._shadows.clear()


@pytest.fixture()
def ws(workspaces_tmp):
    path = config.workspace_dir(CORPUS)
    write_launch(path)
    return path


def test_a_quiet_event_is_held_in_the_file_and_rides_along_with_the_next_event(ws):
    out = events.post(CORPUS, "orient", {"text": "The orientation made 7 cards."}, check_kind=False)
    assert out["held"] is True and out["delivered"] == 0
    assert [n["meta"]["kind"] for n in event_files.held(ws)] == ["orient"]
    assert not event_files.queue_path(ws).exists()
    assert events.held(CORPUS) == event_files.held(ws), "events reads the file, which other processes write"
    done = events.post(CORPUS, "label_done", {"text": "refunds: 12 yes, 30 no", "name": "refunds"}, check_kind=False)
    assert done["delivered"] == 1
    [rec] = event_files.waiting(ws)
    assert rec["id"] == done["id"] and rec["kind"] == "label_done"
    assert rec["text"].startswith(f'<thimble-event kind="label_done" event="{done["id"]}" name="refunds">')
    assert "meanwhile:\n[kind=\"orient\"] The orientation made 7 cards." in rec["text"]
    assert rec["line"] == "label finished: refunds\nThe orientation made 7 cards."
    assert event_files.held(ws) == [] and not event_files.held_path(ws).exists()


def test_an_event_needs_main_s_claude_process_to_run_and_no_subscription(ws):
    assert not events._subs.get(CORPUS)
    assert events.post(CORPUS, "label_done", {"text": "x"}, check_kind=False)["delivered"] == 1
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    write_launch(ws, pid=gone.pid)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        events.post(CORPUS, "label_done", {"text": "x"}, check_kind=False)
    assert e.value.status_code == 409


def test_reachable_is_main_s_claude_process_in_terminal_mode(ws):
    """The callers that ask first whether an event can reach main (a new thread with its question, message_thread, a
    thread's queued messages) see main's `claude` process in terminal mode, where no subscription exists."""
    assert not events._subs.get(CORPUS)
    assert events.reachable(CORPUS) is True
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    write_launch(ws, pid=gone.pid)
    assert events.reachable(CORPUS) is False


def test_the_watcher_takes_each_event_once_in_order_and_the_held_hook_prints_each_line_once(ws):
    a = events.post(CORPUS, "label_done", {"text": "first", "name": "a"}, check_kind=False)
    b = events.post(CORPUS, "rerun", {"text": "second", "name": "b"}, check_kind=False)
    assert [r["id"] for r in event_files.waiting(ws)] == [a["id"], b["id"]]
    assert event_files.take(ws, MAIN)["id"] == a["id"]
    assert event_files.unshown(ws, MAIN) == ["label finished: a"]
    assert event_files.unshown(ws, MAIN) == [], "a line is printed once"
    events.show(CORPUS, "› follow-up to the orientation: and April?")
    assert event_files.take(ws, MAIN)["id"] == b["id"]
    assert event_files.take(ws, MAIN) is None
    assert event_files.unshown(ws, MAIN) == ["› follow-up to the orientation: and April?", "cards run again: label b changed"]
    assert event_files.unshown(ws, MAIN) == []


def test_two_terminal_threads_on_one_citation_keep_its_words_as_their_title_and_their_forks_two_names(ws):
    """The terminal names a thread's subject by the citation's words (its title): a second thread on the same citation
    is titled by the same words, never `raises the 3,898 count-2`; the forks' names stay two (threads.fork_name)."""
    from app import agents, threads

    a = agents.new_thread(CORPUS, "agent-chat.jsonl#L2", "The reviewer raises the 3,898 count.", "raises the 3,898 count", surface="terminal")
    b = agents.new_thread(CORPUS, "agent-chat.jsonl#L2", "The reviewer raises the 3,898 count.", "raises the 3,898 count", surface="terminal")
    assert a["title"] == b["title"] == "raises the 3,898 count"
    names = {threads.fork_name(CORPUS, agents.read_meta(CORPUS, m["id"]), "Who wrote line 2?") for m in (a, b)}
    assert names == {"who-wrote-line-2", "who-wrote-line-2-2"}
    # the browser keeps its two names in the tree
    assert agents.new_thread(CORPUS, "agent-chat.jsonl#L2", "x", "raises the 3,898 count")["title"] == "raises the 3,898 count-2"


def test_the_held_hook_leaves_one_short_line_for_a_thread_which_the_terminal_s_own_rows_say(ws):
    """A thread's question shows in its fork's row and its `↳` row (thimble-term), so main's terminal does not show it
    again as `UserPromptSubmit says: › new thread: …`, only one short line under the `● thimble` row its wake opens; a
    quiet event riding along still shows its line, and the statusline still counts the question while it waits."""
    from app import agents

    meta = agents.new_thread(CORPUS, "card:abc#n/all", "Nearly all revisions are on one wiki.", surface="terminal")
    events.post(CORPUS, "label_done", {"text": "x", "name": "refunds"}, check_kind=False)
    event_files.take(ws, MAIN)
    assert event_files.unshown(ws, MAIN) == ["label finished: refunds"]
    events.post(CORPUS, "written", {"text": "Saved.", "doc": "report"}, check_kind=False)
    events.post(CORPUS, "thread", {"thread": meta["id"], "text": "Is that all of them?"})
    assert event_files.queued_words(ws)[0].startswith("new thread: Is that all of them?")
    event_files.take(ws, MAIN)
    # the thread's event wakes main, whose turn opens with a `● thimble` row no hook removes: one short line under it
    # (live check term-fix5, new quirk 7), never the whole `› new thread: …` line
    assert event_files.unshown(ws, MAIN) == ['new thread: "Is that all of them?"']
    assert event_files.said([{"terminal": "view built: pages", "meta": {"kind": "view"}},
                             {"terminal": "the report writer ended", "meta": {"kind": "written"}}]) == "view built: pages"
    long = "Which pages in pages.jsonl have a name that contains June and were saved on 18 June by a bot?"
    assert event_files.said([{"terminal": f"› new thread: {long}", "meta": {"kind": "thread"}}]) == \
        'new thread: "Which pages in pages.jsonl have a name that contains June…"'
    assert event_files.said([{"terminal": '› thread "Which pages in pages.jsonl…": And on 19 June?',
                              "meta": {"kind": "thread"}}]) == 'thread "Which pages in pages.jsonl…": "And on 19 June?"'


def test_a_take_from_two_processes_at_once_hands_each_event_to_one(ws):
    for i in range(20):
        events.post(CORPUS, "label_done", {"text": str(i)}, check_kind=False)
    got: list[str] = []

    def taker() -> None:
        while (rec := event_files.take(ws, MAIN)) is not None:
            got.append(rec["id"])

    threads = [threading.Thread(target=taker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(got) == 20 and len(set(got)) == 20


def test_the_queue_is_trimmed_to_what_is_still_needed(ws, monkeypatch):
    monkeypatch.setattr(event_files, "TRIM_BYTES", 2_000)
    monkeypatch.setattr(event_files, "KEEP_S", 0.0)
    for i in range(30):
        events.post(CORPUS, "label_done", {"text": "x" * 40}, check_kind=False)
        event_files.take(ws, MAIN)
    last = events.post(CORPUS, "label_done", {"text": "still waiting"}, check_kind=False)
    assert event_files.queue_path(ws).stat().st_size < 4_000
    assert [r["id"] for r in event_files.waiting(ws)] == [last["id"]]


def test_a_thread_event_server_code_sends_goes_to_the_queue(ws):
    out = events.send(CORPUS, "thread", "Which bot replied?", {"thread": "t1", "name": "bots"}, thread="t1",
                      line="› thread bots: Which bot replied?")
    assert out["delivered"] == 1
    [rec] = event_files.waiting(ws)
    assert rec["kind"] == "thread" and "Which bot replied?" in rec["text"]
    assert event_files.posted(ws, out["id"]) and not event_files.posted(ws, "nope")
    assert event_files.queued_words(ws) == ["thread bots: Which bot replied?"]
    assert events.queued_line(CORPUS, MAIN) == "thimble · queued: thread bots: Which bot replied?"


def test_a_thread_s_line_names_it_by_its_first_question_never_its_fork_name(ws):
    """Main's terminal shows a thread's question as `› new thread: <question>`, and a follow-up under the thread's first
    question in quotation marks; the fork's name (a slug) is Claude Code's agent tray's."""
    from app import agents, threads

    meta = agents.new_thread(CORPUS, "card:abc#n/all", "Nearly all revisions are on one wiki: 2994 of 3000.")
    events.post(CORPUS, "thread", {"thread": meta["id"], "text": "Is 2994 all of the dse revisions in this file?"})
    [first] = event_files.waiting(ws)
    assert first["line"] == "› new thread: Is 2994 all of the dse revisions in this file?"
    assert meta["title"] not in first["line"]
    # a follow-up (sent once the fork is known, threads.flush), under the first question
    name = threads.line_name(CORPUS, meta["id"], ["And dorfwiki?"])
    assert events.terminal_line("thread", "And dorfwiki?", {"name": name}) == '› thread "Is 2994 all of the dse revisions in…": And dorfwiki?'


def test_browser_mode_is_unchanged_when_launch_json_names_no_mode(workspaces_tmp):
    ws = config.workspace_dir(CORPUS)
    write_launch(ws, mode="")
    raw = json.loads(sf.launch_path(ws).read_text())
    raw.pop("mode")
    sf.launch_path(ws).write_text(json.dumps(raw))
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:  # browser mode: no subscription, no session listening
        events.post(CORPUS, "label_done", {"text": "x"}, check_kind=False)
    assert e.value.status_code == 409
    assert not event_files.queue_path(ws).exists()


def test_the_event_files_module_is_standard_library_only():
    """The watcher imports app/event_files.py under `python -S`."""
    backend = os.path.dirname(os.path.dirname(os.path.abspath(event_files.__file__)))
    done = subprocess.run([sys.executable, "-S", "-c", "import sys; sys.path.insert(0, sys.argv[1]); "
                           "import app.event_files, app.subagent_files; print('ok')", backend],
                          capture_output=True, text=True, timeout=30)
    assert done.stdout.strip() == "ok", done.stderr
