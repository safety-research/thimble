"""Events to main in terminal mode (app/event_files.py, events.post's terminal branch): no server holds them, so a post
writes the event to the workspace's queue, a quiet one to held-events.json, and main's watcher takes it from the file;
the held hook prints each event's line once. The watcher's side is test_terminal_hooks.py."""
from __future__ import annotations

import os
import subprocess
import sys
import threading

import pytest
from terminal_fakes import CORPUS, MAIN, write_launch

from app import config, event_files, events, session


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
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


def test_the_watcher_takes_each_event_once_in_order_and_the_held_hook_prints_only_the_analyst_s_words_once(ws):
    """Main's terminal prints the analyst's own words from the browser, each once, and no line of thimble's own events
    (bug hunt 9, friction 5: `UserPromptSubmit says: new thread …`, `The orientation has finished: … / Coverage: …`):
    main's reply, a fork's row or a `↳` row says those."""
    a = events.post(CORPUS, "label_done", {"text": "first", "name": "a"}, check_kind=False)
    events.post(CORPUS, "orient", {"text": "The orientation has finished: 3 labels, 8 cards.\nCoverage: read 0.1%"},
                check_kind=False)
    b = events.post(CORPUS, "main", {"text": "what kinds of pages did the admin delete?"}, check_kind=False)
    c = events.post(CORPUS, "rerun", {"text": "second", "name": "b"}, check_kind=False)
    assert [r["id"] for r in event_files.waiting(ws)] == [a["id"], b["id"], c["id"]]
    assert event_files.take(ws, MAIN)["id"] == a["id"]
    assert event_files.unshown(ws, MAIN) == [], "a label's run: main's reply says it"
    events.show(CORPUS, "› follow-up to the orientation: and April?")
    assert event_files.take(ws, MAIN)["id"] == b["id"]
    assert event_files.take(ws, MAIN)["id"] == c["id"]
    assert event_files.take(ws, MAIN) is None
    assert event_files.unshown(ws, MAIN) == ["› follow-up to the orientation: and April?",
                                             "› what kinds of pages did the admin delete?"]
    assert event_files.unshown(ws, MAIN) == [], "a line is printed once"


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


def test_the_event_files_module_is_standard_library_only():
    """The watcher imports app/event_files.py under `python -S`."""
    backend = os.path.dirname(os.path.dirname(os.path.abspath(event_files.__file__)))
    done = subprocess.run([sys.executable, "-S", "-c", "import sys; sys.path.insert(0, sys.argv[1]); "
                           "import app.event_files, app.subagent_files; print('ok')", backend],
                          capture_output=True, text=True, timeout=30)
    assert done.stdout.strip() == "ok", done.stderr
