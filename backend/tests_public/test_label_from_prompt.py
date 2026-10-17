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


async def test_the_glob_route_counts_the_units_a_run_reads_for_the_new_label_card_s_run(api, monkeypatch):
    """The new-label card's Run names how many units it reads ("Run on 8 records"), so a draft from Label from prompt is
    checked before anything runs (0.9.0 bug hunt G12: a prompt label started over 42,205 records with no count)."""
    r = await api.get(f"/api/ws/{CORPUS}/labels/glob", params={"pattern": "board.jsonl", "unit": "record"})
    assert r.status_code == 200, r.text
    assert r.json() == {"files": ["board.jsonl"], "total": 1, "units": 8, "units_more": False}
    r = await api.get(f"/api/ws/{CORPUS}/labels/glob", params={"pattern": "agents/*.jsonl", "unit": "agent"})
    assert (r.json()["total"], r.json()["units"]) == (3, 3), "a label that marks files reads each file once"
    both = {"pattern": "agents/*.jsonl, board.jsonl", "unit": "record"}
    r = await api.get(f"/api/ws/{CORPUS}/labels/glob", params=both)
    assert r.json()["units"] == 3 * 20 + 8
    # past the most it counts, it says there are more
    monkeypatch.setattr(concepts, "GLOB_COUNTED", 10)
    r = await api.get(f"/api/ws/{CORPUS}/labels/glob", params={"pattern": "agents/*.jsonl", "unit": "record"})
    assert (r.json()["units"], r.json()["units_more"]) == (10, True)
    # without a unit, the files alone, as before
    r = await api.get(f"/api/ws/{CORPUS}/labels/glob", params={"pattern": "board.jsonl"})
    assert r.json() == {"files": ["board.jsonl"], "total": 1}


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


def _chats(data: "Path") -> str:
    """A corpus of chat transcripts shaped as one JSON document each: one system prompt in an array, and the messages
    as the entries of an object, which thimble does not read as records by default (it reads `#/system/0`)."""
    root = data / "chats"
    for ep in (1, 2, 3):
        doc = {"agent": f"bot-{ep}", "system": [{"role": "system", "content": "You maintain the build."}],
               "messages": {f"m{i}": {"from": f"bot-{ep}", "text": f"message {i}: shall we vote on who owns deploys?"}
                            for i in range(1, 5)},
               "conversations": {"c1": {"members": ["bot-1", "bot-2"]}, "c2": {"members": ["bot-2", "bot-3"]}}}
        (root / f"ep{ep}" / "transcripts").mkdir(parents=True)
        (root / f"ep{ep}" / "transcripts" / "u1_conversations.json").write_text(json.dumps(doc, indent=1))
    (root / "manifest.json").write_text(json.dumps({"name": "chats"}))
    return "chats"


async def test_a_draft_with_applies_to_left_at_every_file_chooses_the_records_the_description_names(api, bridge, data_tmp):
    """Bug hunt I8: a label of the agents' messages, drafted with Applies to left at `*`, ran on each transcript's system
    prompt alone (`#/system/0`, the records thimble reads by default) and reported a confident 0. The draft is shown the
    other places of records the files hold, and the records it names are what the label applies to; Applies to that the
    analyst gave stays, and a place that holds no records leaves `*`."""
    c = _chats(data_tmp)
    asked = {**DRAFTED, "kind": "prompt", "text": "The message proposes a rule to settle who owns deploys.",
             "records": "*/transcripts/*.json#/messages"}
    bridge.respond = lambda op, args: {"text": json.dumps(asked)}
    r = await api.post(f"/api/ws/{c}/concepts/draft", json={"text": "agent messages that propose a rule", "paths": []})
    assert r.status_code == 200, r.text
    assert r.json()["glob"] == "*/transcripts/*.json#/messages"
    sent = json.dumps(bridge.calls[-1][1])
    assert "#/messages" in sent and "12 entries of an object, in 3 files" in sent and "`#/system`" in sent
    r = await api.get(f"/api/ws/{c}/labels/glob", params={"pattern": r.json()["glob"], "unit": "record"})
    assert r.json()["units"] == 12, "the 12 messages, not the 3 system prompts"
    # Applies to the analyst gave stays, and the model is not asked to choose
    r = await api.post(f"/api/ws/{c}/concepts/draft", json={"text": "agent messages that propose a rule",
                                                           "paths": ["ep1/transcripts/u1_conversations.json"]})
    assert r.json()["glob"] == "ep1/transcripts/u1_conversations.json"
    assert "entries of an object" not in json.dumps(bridge.calls[-1][1]), "no places shown"
    # records that match no record leave every file
    asked["records"] = "*.json#/nowhere"
    r = await api.post(f"/api/ws/{c}/concepts/draft", json={"text": "agent messages that propose a rule", "paths": []})
    assert r.json()["glob"] == "*"
