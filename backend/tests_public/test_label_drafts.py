"""Label from prompt (concepts.py draft_route): the labels model defines a label from the analyst's description after
reading the first records of the files it would apply to. The model is scripted at concepts._labels_call (CallResults;
no subprocess, no network); the records are the synthetic corpus `mini` (mini_corpus.py)."""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import concepts
from app import model as model_mod


@pytest.fixture()
async def api(workspaces_tmp):
    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=30) as c:
        yield c


@pytest.fixture()
def calls(monkeypatch):
    """The labels calls made, each (prompt, tool name), answered from `calls.answers` in turn."""

    class Made(list):
        answers: list[model_mod.CallResult]

    made = Made()
    answers: list[model_mod.CallResult] = []

    async def fake(c, prompt, tool):
        made.append((prompt, tool.name))
        return answers.pop(0)

    monkeypatch.setattr(concepts, "_labels_call", fake)
    made.answers = answers
    return made


async def test_a_draft_reads_the_files_first_records_and_answers_a_label_the_bar_can_run(api, calls):
    calls.answers.append(model_mod.CallResult(status="ok", output={
        "name": "claims a PR", "scope": "files", "kind": "regex", "text": r"(?i)forge pr claim", "values": ["claim", "other"],
        "marks": "span"}))
    r = await api.post("/api/ws/mini/concepts/draft", json={"text": "  posts that claim a PR ", "paths": ["board.jsonl"]})
    assert r.status_code == 200
    assert r.json() == {"name": "claims a PR", "over": "files", "marks": "span", "glob": "board.jsonl", "kind": "regex",
                        "text": r"(?i)forge pr claim", "values": ["claim", "other"]}
    [(prompt, tool)] = calls
    assert tool == "label"
    assert "posts that claim a PR" in prompt
    # the records part names the files and carries the first lines of the first, as the file holds them
    first = (concepts.config.corpus_dir("mini") / "board.jsonl").read_text("utf-8").splitlines()[0]
    assert "board.jsonl" in prompt and first[: concepts.SAMPLE_CUT] in prompt


async def test_a_draft_over_cards_has_no_glob_and_a_bad_regex_or_no_answer_is_an_error(api, calls):
    calls.answers.append(model_mod.CallResult(status="ok", output={
        "name": "about deletions", "scope": "canvas", "kind": "prompt", "text": "The card is about deleted pages.", "values": ["yes"]}))
    got = (await api.post("/api/ws/mini/concepts/draft", json={"text": "cards about deletions"})).json()
    assert (got["over"], got["glob"], got["marks"], got["values"]) == ("cards", "", None, ["yes", "no match"])
    assert "The label would apply to" not in calls[-1][0], "no file named, so no records part"
    calls.answers.append(model_mod.CallResult(status="ok", output={"name": "x", "scope": "files", "kind": "regex", "text": "(unclosed", "values": ["a", "b"]}))
    r = await api.post("/api/ws/mini/concepts/draft", json={"text": "anything", "paths": ["board.jsonl"]})
    assert r.status_code == 422 and "does not compile" in r.json()["detail"]
    calls.answers.append(model_mod.CallResult(status="rate_limited", detail="429 at capacity"))
    assert (await api.post("/api/ws/mini/concepts/draft", json={"text": "anything"})).status_code == 429
    assert (await api.post("/api/ws/mini/concepts/draft", json={"text": "  "})).status_code == 400
