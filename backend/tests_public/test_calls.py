"""calls.py: an orientation call's output that Claude Code saved to a file is read only from the session's own
tool-results folder."""
from __future__ import annotations

import pytest

from app import calls


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    calls.forget()
    yield
    calls.forget()


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
