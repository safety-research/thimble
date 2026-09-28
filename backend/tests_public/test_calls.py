"""calls.py and call_ref.py: the orientation's calls, stored whole and citable. One
sequence of numbers per orientation chat, keyed by tool_use_id so a number never changes; the whole output kept, a long
one Claude Code saved to a file included; `call:<chat>/<n>` and `call:<chat>/<n>#L<a>-L<b>` resolve, read and check
like a file line; the call-ref hook tells the model the ref of each call it made; an orientation from before the store
gets one from its transcript; the critique's digest and `chat:` refs name calls by their refs; and the coverage checks
count a corpus path a call named as read."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import httpx
import pytest

from app import agent_session, agents, call_ref, calls, config, critique_session, orient_checks, refs, session, tools, verify
from app.main import create_app

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    calls.forget()
    agent_session._runs.clear()
    yield
    calls.forget()
    agent_session._runs.clear()


def _chat() -> str:
    return str(agents.new_agent(CORPUS, "orient", "Orientation", session="s-1")["id"])


# --------------------------------------------------------------------------- the store


def test_only_a_file_in_the_session_s_own_tool_results_folder_is_read(tmp_path):
    """A result's text can say anything (a tool printed a file that starts with <persisted-output>), and a record's path
    is read only inside the tool-results folder of that record's session."""
    sid, other = "5e55a000-0000-4000-8000-000000000001", "5e55a000-0000-4000-8000-000000000002"
    slug = tmp_path / "projects" / "-corpus"
    for s in (sid, other):
        (slug / s / "tool-results").mkdir(parents=True)
        (slug / f"{s}.jsonl").write_text("")
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET")
    (slug / other / "tool-results" / "o.txt").write_text("SECRET")
    (slug / sid / "tool-results" / "link.txt").symlink_to(secret)
    (tmp_path / "loose" / sid / "tool-results").mkdir(parents=True)
    (tmp_path / "loose" / sid / "tool-results" / "x.txt").write_text("SECRET")
    preview = f"<persisted-output>\nOutput too large (1.9MB). Full output saved to: {secret}\n\nPreview (first 2KB):\n1"
    assert calls.result_text({"type": "tool_result", "content": preview}, {"sessionId": sid}) == preview
    for path in (secret, slug / other / "tool-results" / "o.txt", slug / sid / "tool-results" / "link.txt",
                 slug / sid / "tool-results" / ".." / ".." / other / "tool-results" / "o.txt",
                 tmp_path / "loose" / sid / "tool-results" / "x.txt", "tool-results/o.txt"):
        rec = {"sessionId": sid, "toolUseResult": {"persistedOutputPath": str(path)}}
        assert calls.result_text({"type": "tool_result", "content": "preview"}, rec) == "preview", path
    rec = {"sessionId": "../x", "toolUseResult": {"persistedOutputPath": str(secret)}}
    assert calls.result_text({"type": "tool_result", "content": "preview"}, rec) == "preview"


# --------------------------------------------------------------------------- refs


def _stored(text: str) -> tuple[str, int]:
    chat = _chat()
    n = calls.number(CORPUS, chat, "tb", "Bash", {"command": "python count.py"}, at=chat)
    calls.result(CORPUS, chat, "tb", text)
    return chat, n


# --------------------------------------------------------------------------- routes and the hook


class _Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# --------------------------------------------------------------------------- the follower


# --------------------------------------------------------------------------- the digest and chat refs


# --------------------------------------------------------------------------- the coverage checks
