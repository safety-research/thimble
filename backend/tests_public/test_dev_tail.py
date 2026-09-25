"""How a dev agent's background session is followed after a wake (app/dev.py Sessions._identify, _worker_turn). For a
moment after `claude --bg --resume`, `claude agents --json` can list the woken session's id with another session id.
Only an entry whose session id begins with its id identifies a session, so the run follows the woken session's own
transcript and the turn ends with its last words. The CLI is a stand-in over an invented transcript."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import dev

SID = "5e1f0c2a-0000-4000-8000-00000000000a"
PASSING = "a62efc32-0000-4000-8000-00000000000b"  # the other session id the listing shows for a moment
WAKE = "The server ran the gates over your work and they did not pass.\n\ngate output (data):\n```\nproblem: no page\n```"
ERROR = "API Error: Repeated 529 Overloaded errors. The API is at capacity."


def _line(rec: dict) -> str:
    return json.dumps(rec) + "\n"


def _turn(prompt: str, text: str) -> str:
    """One turn as Claude Code writes it: the message, the assistant's text, the turn's end."""
    return "".join([_line({"type": "user", "message": {"role": "user", "content": prompt}}),
                    _line({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}),
                    _line({"type": "system", "subtype": "turn_duration", "durationMs": 3000})])


class Chat:
    """Stands in for the ticket's chat (dev.Log): the texts written to it."""

    def __init__(self) -> None:
        self.texts: list[str] = []

    def text(self, delta: str, **extra) -> None:
        self.texts.append(delta)


class CLI(dev.Sessions):
    """dev.Sessions with the `claude` CLI stood in for: `claude --bg --resume` appends a turn that ended on the API's
    error to the session's transcript, and the listing's first entry after it names the session's id with PASSING;
    the listings after that are right and call the turn blocked, as Claude Code lists a turn that ended on an error."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.listings = 0
        self.resumed = 0
        self.stopped: list[str] = []

    async def _run(self, args: list[str], cwd: Path, env: dict[str, str] | None = None) -> tuple[int, str]:
        assert args[:3] == ["--bg", "--resume", SID], args
        self.resumed += 1
        with self.path.open("a") as f:
            f.write(_turn(args[-1], ERROR))
        return 0, f"backgrounded · {SID[:8]} · thimble view: toy\n"

    async def _listing(self, cwd: Path) -> list[dict]:
        self.listings += 1
        entry = {"id": SID[:8], "kind": "background", "sessionId": SID, "state": "blocked", "status": "idle"}
        if self.resumed and self.listings == 2:  # the first listing after the wake (the first is _running's)
            entry = {**entry, "sessionId": PASSING, "state": "working", "status": None}
        return [entry]

    def transcript(self, session_id: str) -> Path | None:
        return self.path if session_id == SID else None

    def stop(self, short: str | None) -> None:
        self.stopped.append(short or "")


@pytest.fixture()
def cli(tmp_path, monkeypatch) -> CLI:
    path = tmp_path / f"{SID}.jsonl"
    path.write_text(_turn("Build the view.", ERROR))
    stand_in = CLI(path)
    monkeypatch.setattr(dev, "SESSIONS", stand_in)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setattr(dev, "IDENTIFY_POLL_S", 0.01)
    monkeypatch.setattr(dev, "ASK_TIMEOUT_S", 1.0)  # a run that follows the wrong transcript fails fast
    return stand_in


def test_an_entry_whose_session_id_is_another_s_does_not_identify_the_session(cli):
    assert not dev._names_itself({"id": SID[:8], "sessionId": PASSING})
    assert dev._names_itself({"id": SID[:8], "sessionId": SID}) and dev._names_itself({"sessionId": SID})
    got = asyncio.run(cli.resume(cli.path.parent, SID, WAKE))
    assert got == {"id": SID[:8], "session_id": SID}, "the woken session keeps its own id"
    assert cli.listings >= 3, "the listing that named another session id was passed over"


def test_a_woken_view_build_follows_its_own_transcript_to_the_turn_s_end(cli):
    chat = Chat()
    run = dev.Run(ticket_id="view:toy", title="toy", ts_start="")
    text = asyncio.run(dev._worker_turn(run, dev.Log(chat), cli.path.parent, WAKE, SID, name="thimble view: toy",
                                        workspace=None, on_session=lambda short, sid: None, answered=False))
    assert text == ERROR, "the API's error is the turn's report, which the build's capacity check reads"
    assert run.session_id == SID, "the next wake resumes the same session"
    assert ERROR + "\n" in chat.texts
    assert not any("waiting for an answer" in t for t in chat.texts), "the turn is over, so nobody is asked"
    assert cli.stopped == [SID[:8]]


class Racing(dev.Sessions):
    """dev.Sessions with the CLI stood in for, for a session that starts and whose turn the API ends: the listing that
    first calls it blocked writes the API's error message into the transcript as it answers, and the turn's end comes
    with it (`split` False) or with the next listing (`split` True), as Claude Code lists the turn blocked a moment
    before it writes the turn_duration record."""

    def __init__(self, path: Path, split: bool) -> None:
        self.path, self.split = path, split
        self.listings = 0
        self.stopped: list[str] = []

    async def _run(self, args: list[str], cwd: Path, env: dict[str, str] | None = None) -> tuple[int, str]:
        assert args[0] == "--bg", args
        self.path.write_text(_line({"type": "user", "message": {"role": "user", "content": args[-1]}}))
        return 0, f"backgrounded · {SID[:8]} · thimble view: toy\n"

    async def _listing(self, cwd: Path) -> list[dict]:
        self.listings += 1
        entry = {"id": SID[:8], "kind": "background", "sessionId": SID, "state": "working", "status": "busy"}
        if self.listings == 3:
            with self.path.open("a") as f:
                f.write(_line({"type": "assistant", "isApiErrorMessage": True,
                               "message": {"content": [{"type": "text", "text": ERROR}]}}))
                if not self.split:
                    f.write(_line({"type": "system", "subtype": "turn_duration", "durationMs": 3000}))
        elif self.listings == 4 and self.split:
            with self.path.open("a") as f:
                f.write(_line({"type": "system", "subtype": "turn_duration", "durationMs": 3000}))
        if self.listings >= 3:
            entry = {**entry, "state": "blocked", "status": "idle"}
        return [entry]

    def transcript(self, session_id: str) -> Path | None:
        return self.path if session_id == SID and self.path.is_file() else None

    def stop(self, short: str | None) -> None:
        self.stopped.append(short or "")


@pytest.mark.parametrize("split", [False, True])
def test_a_turn_the_api_ended_is_no_question_and_its_thread_names_no_claude_attach(tmp_path, monkeypatch, split):
    """A view build's session whose turn the API ended is listed blocked before the transcript's turn has ended: the
    turn ends with the API's error as its report, and the build's thread gets neither the line that the session waits
    for an answer nor any line naming `claude attach`, since nobody attaches to a view build."""
    stand_in = Racing(tmp_path / f"{SID}.jsonl", split)
    monkeypatch.setattr(dev, "SESSIONS", stand_in)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setattr(dev, "IDENTIFY_POLL_S", 0.01)
    chat = Chat()
    run = dev.Run(ticket_id="view:toy", title="toy", ts_start="")
    text = asyncio.run(dev._worker_turn(run, dev.Log(chat), tmp_path, "Build the view.", None, name="thimble view: toy",
                                        workspace=None, on_session=lambda short, sid: None, answered=False))
    assert text == ERROR
    assert not any("waiting for an answer" in t or "claude attach" in t for t in chat.texts), chat.texts


def test_a_code_ticket_s_turn_the_api_ended_fails_with_the_api_s_error(tmp_path, monkeypatch):
    """A code ticket's session may be answered by whoever attaches, but a turn the API ended waits for nobody: it fails
    at once with the API's error rather than after the wait for an answer."""
    stand_in = Racing(tmp_path / f"{SID}.jsonl", True)
    monkeypatch.setattr(dev, "SESSIONS", stand_in)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setattr(dev, "IDENTIFY_POLL_S", 0.01)
    monkeypatch.setattr(dev, "ASK_TIMEOUT_S", 30.0)
    chat = Chat()
    run = dev.Run(ticket_id="t1", title="toy", ts_start="")
    with pytest.raises(dev.SessionError) as e:
        asyncio.run(dev._worker_turn(run, dev.Log(chat), tmp_path, "Fix the chip.", None, name="thimble ticket 1: toy",
                                     workspace=None, on_session=lambda short, sid: None))
    assert str(e.value) == f"Anthropic's API ended the session's turn: {ERROR}"
    assert not any("waiting for an answer" in t for t in chat.texts), chat.texts
    assert any(f"`claude attach {SID[:8]}` opens it" in t for t in chat.texts), "a code ticket still names its session"
