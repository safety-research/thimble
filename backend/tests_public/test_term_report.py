"""The report in terminal mode (app/term_report.py, mods/thimble-term hooks/report.ts): `thimble state checks` gives the
checks route's list, `thimble act comment-resolve` and `comment-reopen` change a comment as the margin's ✓ does, and
`thimble act doc-save` saves the panel's edit as the browser's editor saves its blocks, so a kept passage keeps its id and
its comments."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cardrun, config, investigation, local, notebook, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def doc(workspaces_tmp, mini_dir, monkeypatch) -> dict:
    """A terminal-mode workspace with a report of two sections, a check's comment on a sentence of the first, a note of
    Claude's on the second section's heading, and a resolved comment."""
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    ws = config.workspace_dir(CORPUS)
    (ws / "trusted").mkdir(exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": "terminal"}))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    count = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"].append(count)
    notebook.write_notebook(ws, nb)
    text = (f"# One account issued every deletion\n\n## One account\n\nAll [[27|card:{count['id']}]] deletions came from one "
            "account. The log covers one week.\n\n## Caveats\n\nNothing before June.\n")

    async def write() -> None:
        r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
        assert not r.is_error, r.text

    import asyncio

    asyncio.run(write())
    d = report_types.read_doc(CORPUS, MAIN, "report")
    first, second = d["sections"]
    s1, s2 = report_types.unit_sentences(first)
    d["comments"] = [
        {"id": "c1", "sentence_id": s2["id"], "text": "Which week?", "check": "judgment", "status": "open"},
        {"id": "c2", "sentence_id": second["id"], "text": "Say what came before.", "author": "claude", "status": "open"},
        {"id": "c3", "sentence_id": s1["id"], "text": "Checked.", "check": "verified", "status": "dismissed"},
    ]
    report_types.write_doc(CORPUS, MAIN, "report", d)
    yield d
    cardrun.CardWatch.stop_all()
    local._started.clear()


def _comments() -> dict[str, dict]:
    return {cm["id"]: cm for cm in report_types.read_doc(CORPUS, MAIN, "report")["comments"]}


async def test_state_checks_gives_the_checks_route_s_list(doc):
    got = await local.state(CORPUS, "checks")
    assert [c["id"] for c in got][:3] == ["unverified", "verified", "judgment"]
    assert all({"name", "colour", "shown", "runs"} <= set(c) for c in got)
    assert "checks" in local.STATE_USAGE


async def test_act_resolves_and_reopens_a_comment_as_the_margin_does(doc):
    got = await local.act(CORPUS, "comment-resolve", {"doc": "report", "comment": "c1"})
    assert got == {"ok": True, "doc": "report", "comment": "c1", "status": "dismissed"}
    assert _comments()["c1"]["status"] == "dismissed"
    got = await local.act(CORPUS, "comment-reopen", {"doc": "report:report", "comment": "c3"})
    assert got["status"] == "open" and _comments()["c3"]["status"] == "open"
    with pytest.raises(local.StateError, match="no such comment"):
        await local.act(CORPUS, "comment-resolve", {"doc": "report", "comment": "nope"})
    with pytest.raises(local.StateError, match="`comment` is empty"):
        await local.act(CORPUS, "comment-resolve", {"doc": "report"})
    with pytest.raises(local.StateError, match="`doc` is empty"):
        await local.act(CORPUS, "comment-reopen", {"comment": "c1"})
    assert "comment-resolve" in local.ACT_USAGE and "doc-save" in local.ACT_USAGE


async def test_act_doc_save_keeps_the_ids_and_comments_of_what_the_edit_kept(doc):
    """The editor's blocks with one sentence rewritten, a heading reworded and a paragraph added: the unchanged sentence
    keeps its id and its check's comment, the heading its note; no `title` keeps the title."""
    first, second = doc["sections"]
    s1, s2 = report_types.unit_sentences(first)
    blocks = [b.model_dump(exclude_none=True) for b in report_types.editor_blocks(doc)]
    para = next(b for b in blocks if b["type"] == "paragraph")
    para["text"] = para["text"].replace("All", "Every one of the")
    head = next(b for b in blocks if b["type"] == "heading" and b["id"] == second["id"])
    head["text"] = "What it leaves out"
    blocks.append({"id": "", "type": "paragraph", "text": "A new paragraph of the analyst's."})
    got = await local.act(CORPUS, "doc-save", {"doc": "report", "blocks": blocks})
    assert got == {"ok": True, "doc": "report", "title": "One account issued every deletion", "sections": 2, "comments": 2}
    saved = report_types.read_doc(CORPUS, MAIN, "report")
    a, b = saved["sections"]
    assert [x["id"] for x in report_types.unit_sentences(a)][1] == s2["id"] and b["id"] == second["id"]
    assert b["heading"] == "What it leaves out"
    assert [x["text"] for x in report_types.unit_sentences(b)] == ["Nothing before June.", "A new paragraph of the analyst's."]
    assert _comments()["c1"]["sentence_id"] == s2["id"] and _comments()["c2"]["sentence_id"] == second["id"]
    # the rewritten sentence's resolved comment goes with the words it was on
    assert "c3" not in _comments() and report_types.unit_sentences(a)[0]["id"] != s1["id"]
    events = [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == "report"]
    assert events[-1] == {**events[-1], "slug": "report", "status": "edited", "by": "analyst", "client": "terminal"}
    # a title given is the new title
    got = await local.act(CORPUS, "doc-save", {"doc": "report", "title": "A new title", "blocks": blocks})
    assert report_types.read_doc(CORPUS, MAIN, "report")["title"] == "A new title"


async def test_act_doc_save_refuses_what_is_not_the_editor_s_blocks(doc):
    with pytest.raises(local.StateError, match="must be a list"):
        await local.act(CORPUS, "doc-save", {"doc": "report", "blocks": "## A heading"})
    with pytest.raises(local.StateError, match="do not read as the editor's"):
        await local.act(CORPUS, "doc-save", {"doc": "report", "blocks": [{"text": "no type"}]})
    with pytest.raises(local.StateError, match="unknown block type"):
        await local.act(CORPUS, "doc-save", {"doc": "report", "blocks": [{"type": "table", "text": "x"}]})


def test_the_command_line_runs_the_report_s_acts(doc):
    import os
    import subprocess
    import sys

    backend = Path(__file__).resolve().parents[1]
    corpus = config.corpus_dir(CORPUS)
    r = subprocess.run([sys.executable, "-m", "app.local", "act", "comment-resolve", "--cwd", str(corpus),
                        json.dumps({"doc": "report", "comment": "c2"})], cwd=backend, env=dict(os.environ),
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads(r.stdout) == {"ok": True, "doc": "report", "comment": "c2", "status": "dismissed"}
    r = subprocess.run([sys.executable, "-m", "app.local", "state", "checks", "--cwd", str(corpus)], cwd=backend,
                       env=dict(os.environ), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and json.loads(r.stdout)[0]["id"] == "unverified"
