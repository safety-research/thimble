"""Label from prompt in the browser (0.9.0 bug hunt D1): the drafted label applies to what the new-label card's Applies
to says, `*` (every file) when it names nothing, and the card's Run creates the label only once its run starts
(concepts.create_and_run): a run that cannot start leaves no label behind and says in the card's words what to change.
The draft is one model call through the fake bridge; the regex kind runs for real over the synthetic corpus `mini`."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from app import concepts, config, undo
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
PATTERN = r"(?i)forge pr claim"  # 3 of the 8 board posts match
DRAFTED = {"name": "Claims a fix", "scope": "files", "kind": "regex", "text": PATTERN, "values": ["claims", "no claim"],
           "marks": "record"}


@pytest.fixture(autouse=True)
def _clean_state(workspaces_tmp):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    undo.forget()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    undo.forget()


@pytest.fixture()
async def api():
    app = FastAPI()
    app.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=60) as c:
        yield c


def _body(draft: dict, **kw) -> dict:
    """POST /concepts as the browser sends a draft (frontend labels.ts draftBody), with `run`."""
    return {"name": draft["name"], "unit": "record", "marks": draft["marks"], "glob": draft["glob"], "kind": draft["kind"],
            "model": "", "classes": [{"name": v, "color": i + 1, "highlight": i == 0} for i, v in enumerate(draft["values"])],
            "spec": draft["text"], "shown": True, "run": True, **kw}


async def _labels(api) -> list[dict]:
    r = await api.get(f"/api/ws/{CORPUS}/concepts")
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_draft_applies_to_what_the_card_names_and_to_every_file_when_it_names_nothing(api, bridge):
    bridge.respond = lambda op, args: {"text": json.dumps(DRAFTED)}
    r = await api.post(f"/api/ws/{CORPUS}/concepts/draft", json={"text": "posts that claim a fix", "paths": []})
    assert r.status_code == 200, r.text
    assert r.json()["glob"] == "*", "no file open: the card's Applies to says *, and so does the draft"
    r = await api.post(f"/api/ws/{CORPUS}/concepts/draft", json={"text": "posts that claim a fix", "paths": ["board.jsonl"]})
    assert r.json()["glob"] == "board.jsonl"
    # the model read the first records of the files the label applies to
    [_, (op, args)] = bridge.calls
    assert op == "complete" and "board.jsonl" in json.dumps(args)


async def test_label_from_prompt_with_nothing_open_drafts_creates_and_runs_the_label_over_every_file(api, bridge):
    bridge.respond = lambda op, args: {"text": json.dumps(DRAFTED)}
    draft = (await api.post(f"/api/ws/{CORPUS}/concepts/draft", json={"text": "posts that claim a fix", "paths": []})).json()
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json=_body(draft))
    assert r.status_code == 200, r.text
    k = r.json()
    assert k["glob"] == "*" and k["run"]["status"] == "running" and k["run"]["paths"] == ["*"]
    s = await concepts.wait_apply(CORPUS, k["id"], 30)
    assert s["status"] == "done" and s["total"] > 8 and s["counts"]["claims"] >= 3, "every file, not the board alone"
    ws = config.workspace_dir(CORPUS)
    assert [cell["payload"]["concept"] for _, cell in concepts._label_cards(ws, k["id"])] == [k["id"]], "it has its card"


@pytest.mark.parametrize(("glob", "said"), [
    ("", "Applies to is empty. Name the files the label runs over, such as * for every file."),
    (" , ", "Applies to is empty. Name the files the label runs over, such as * for every file."),
    ("nowhere/*.txt", "No file matches Applies to (nowhere/*.txt). Change Applies to, or use * for every file."),
], ids=["empty", "only commas", "no match"])
async def test_a_run_the_card_cannot_start_says_what_to_change_and_leaves_no_label(api, glob, said):
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json=_body({**DRAFTED, "glob": glob}))
    assert (r.status_code, r.json()["detail"]) == (400, said)
    assert await _labels(api) == []
    assert not list(concepts.concepts_dir(config.workspace_dir(CORPUS)).glob("*.json")), "no label file is left"


async def test_a_prompt_label_over_too_many_records_says_to_narrow_applies_to_and_leaves_no_label(api, monkeypatch):
    monkeypatch.setattr(concepts, "PROMPT_APPLY_MAX", 3)
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json=_body({**DRAFTED, "kind": "prompt", "text": "claims a fix",
                                                                 "glob": "*"}, description="claims a fix", spec=""))
    assert r.status_code == 400 and r.json()["detail"].endswith("Narrow Applies to to some files."), r.text
    assert await _labels(api) == []


async def test_a_run_that_does_not_start_takes_the_new_label_away_again_with_no_undo_step(api, monkeypatch):
    async def refused(*a, **kw):
        raise HTTPException(409, "a run of this label is going on")

    monkeypatch.setattr(concepts, "start_apply", refused)
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json=_body({**DRAFTED, "glob": "board.jsonl"}))
    assert r.status_code == 409
    assert await _labels(api) == []
    assert not list(concepts.concepts_dir(config.workspace_dir(CORPUS)).glob("*.json"))
    assert undo.labels(CORPUS)["undo"] is None, "taking back a label nobody saw is no step to undo"


async def test_a_new_label_without_run_is_created_as_before(api):
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "Claims a fix", "kind": "regex", "spec": PATTERN})
    assert r.status_code == 200 and r.json()["glob"] == "" and not r.json().get("run")
    assert [k["name"] for k in await _labels(api)] == ["Claims a fix"]


async def test_the_terminal_s_and_thimble_label_s_way_refuses_before_the_label_is_defined_too(api):
    """The terminal's new label and /thimble:label go through main's apply_label (concepts.apply_scoped), which with no
    paths runs over every file and refuses what the run would refuse before the label is defined."""
    with pytest.raises(HTTPException) as refused:
        await concepts.apply_scoped(CORPUS, scope="files", name="Claims a fix", kind="regex", text=PATTERN, values=None,
                                    paths=["nowhere/*.txt"], limit=None, comment=False, filter=False, created_by="main",
                                    chat=None, group=None, card=False)
    assert refused.value.status_code == 400
    assert await _labels(api) == []
