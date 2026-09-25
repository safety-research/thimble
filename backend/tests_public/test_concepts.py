"""app.concepts, the labels: define and validate, a regex apply writes one row per unit, a classifier apply batches
its units through a scripted model, the analyst's verdicts override the model's rows, and an apply the run would refuse
leaves no label behind.

The prompt kind's classifier is scripted at concepts.classify_structured (CallResults; no subprocess, no network), or,
for the fallback after a refusal, runs through model.structured against a stubbed Messages API (stub_messages). The
regex kind runs for real over the synthetic corpus `mini`.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

import stub_messages
from app import concepts, config, labels_store, notebook, refs
from app import model as model_mod

CORPUS = "mini"
MINI = config.corpus_dir(CORPUS)
PATTERN = r"(?i)forge pr claim"  # 3 of the 8 board posts match


# ----------------------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def _clean_state(workspaces_tmp):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
                  concepts._building_answers):
        table.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks, concepts._building, concepts._building_answers):
        table.clear()


@pytest.fixture()
def app() -> FastAPI:
    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    return a


@pytest.fixture()
async def api(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


def _board_expected(pattern: str = PATTERN) -> dict[str, str]:
    rx = re.compile(pattern)
    exp = {}
    for i, line in enumerate((MINI / "board.jsonl").read_text("utf-8").splitlines(), 1):
        text = "\n\n".join(b["text"] for b in refs.record_blocks(json.loads(line), "board"))
        exp[f"board.jsonl#L{i}"] = "yes" if rx.search(text) else "no"
    return exp


async def _create(api, **kw) -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "claims a PR", **kw})
    assert r.status_code == 200, r.text
    return r.json()


def _seed_rows(ws: Path, cid: str, rows: list[dict]) -> None:
    p = concepts.labels_file(ws, cid)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(json.dumps(r) + "\n" for r in rows))


def _model_row(ref: str, label: str, conf: float) -> dict:
    return {"ref": ref, "label": label, "confidence": conf, "source": "model", "ts": "2026-01-01T00:00:00+00:00"}


def _ok(labels: list[dict]) -> "model_mod.CallResult":
    return model_mod.CallResult(status="ok", output={"labels": labels})


def _bad(status: str, detail: str = "") -> "model_mod.CallResult":
    return model_mod.CallResult(status=status, detail=detail)


class FakeClassify:
    """Scripted concepts.classify_structured. `plan` entries are used in order (a CallResult, or a callable given the
    batch's items); when the plan is empty, items are labelled YES when their text mentions 'claim'."""

    calls: list[dict] = []
    plan: list = []

    @staticmethod
    async def call(c, concept, items, comment=True):
        FakeClassify.calls.append({"workspace": c, "concept": dict(concept), "items": list(items), "comment": comment})
        if FakeClassify.plan:
            nxt = FakeClassify.plan.pop(0)
            return nxt(items) if callable(nxt) else nxt
        return _ok(FakeClassify.rule(items))

    @staticmethod
    def rule(items: list[tuple[str, str]]) -> list[dict]:
        return [{"i": n, "label": "YES" if "claim" in t.lower() else "no",
                 "confidence": 0.9 if "claim" in t.lower() else 0.7, "rationale": "because"}
                for n, (_ref, t) in enumerate(items, 1)]


async def _no_api() -> bool:
    return False


@pytest.fixture()
def fake_classify(monkeypatch):
    """The scripted classifier on the CLI lane (batches of BATCH_ITEMS, CONCURRENCY in flight), whatever credential the
    shell running the suite has; the HTTP lane's tests switch model.api_path_ready on themselves."""
    FakeClassify.calls = []
    FakeClassify.plan = []
    monkeypatch.setattr(concepts, "classify_structured", FakeClassify.call)
    monkeypatch.setattr(model_mod, "api_path_ready", _no_api)
    return FakeClassify


def _canvas(ws: Path) -> tuple[dict, list[dict]]:
    """A group with three cards: a code cell with output, a note and a label card (never a unit)."""
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    code = notebook.new_cell("code", "user", "How many posts claim a PR?", nb["id"], code="df.claim.sum()")
    code["status"], code["outputs"] = "ok", [{"text/plain": "3", "_stream": True}]
    code["takeaway"] = "Three posts claim a PR."
    note = notebook.new_cell("note", "user", "", nb["id"], payload={"text": "The backlog is about merges, not claims."})
    label = notebook.new_cell("label", "user", "old label", nb["id"], payload={"concept": "deadbeef"})
    nb["cells"] += [code, note, label]
    notebook.write_notebook(ws, nb)
    return nb, [code, note, label]


async def test_create_defaults_list_get_put_delete(api, workspaces_tmp):
    k = await _create(api, description="a board post that claims a PR")
    assert re.fullmatch(r"[0-9a-f]{8}", k["id"])
    assert k["kind"] == "prompt" and k["unit"] == "record" and k["labels"] == ["yes", "no"] and k["spec"] == ""
    assert k["version"] == 1 and k["n_labeled"] == 0 and k["est_precision"] is None and k["run"] is None
    assert k["calibration"] == {"n": 0, "agreed": 0, "disagreed": 0, "est_precision": {}}
    assert (workspaces_tmp / CORPUS / "concepts" / f"{k['id']}.json").is_file()
    for gone in ("examples", "auto_apply", "draft_notes", "scope", "coverage", "label_stats"):
        assert gone not in k, gone

    r = await api.get(f"/api/ws/{CORPUS}/concepts")
    assert [x["id"] for x in r.json()] == [k["id"]]
    assert r.json()[0]["last_run"] is None and "applications" not in r.json()[0]

    r = await api.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"description": "sharper", "labels": ["yes", "no", "unclear"]})
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["labels"] == ["yes", "no", "unclear"]
    r = await api.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"name": "  renamed   concept "})
    assert r.json()["version"] == 2 and r.json()["name"] == "renamed concept"
    assert (await api.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"kind": "sql"})).status_code == 400
    assert (await api.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"unit": "cell"})).json()["unit"] == "cell"

    r = await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")
    assert r.status_code == 200 and r.json()["description"] == "sharper"
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/zzzz")).status_code == 404
    assert (await api.get("/api/ws/nope/concepts")).status_code == 404

    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", json={"ref": "board.jsonl#L1", "label": "yes"})
    assert r.status_code == 200
    assert concepts.labels_file(workspaces_tmp / CORPUS, k["id"]).is_file()
    r = await api.delete(f"/api/ws/{CORPUS}/concepts/{k['id']}")
    assert r.json() == {"ok": True}
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).status_code == 404
    assert not concepts.labels_file(workspaces_tmp / CORPUS, k["id"]).exists()


async def test_create_validation(api):
    assert (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "x", "kind": "sql"})).status_code == 400
    assert (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "x", "unit": "galaxy"})).status_code == 400
    assert (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "   "})).status_code == 400
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "x", "labels": ["a", " a ", "", "b"]})
    assert r.json()["labels"] == ["a", "b"]
    for unit in concepts.UNITS:
        assert (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": unit, "unit": unit})).json()["unit"] == unit


def test_match_paths_flat_and_nested(nested_data):
    flat = config.corpus_dir("mini")
    assert [s["path"] for s in concepts.match_paths(flat, ["board.jsonl"])] == ["board.jsonl"]
    assert [s["path"] for s in concepts.match_paths(flat, ["agents/*.jsonl"])] == [
        "agents/agent-01.jsonl", "agents/agent-02.jsonl", "agents/agent-03.jsonl"]
    everything = {s["path"] for s in concepts.match_paths(flat, ["*"])}
    assert "forge.db" not in everything and {"board.jsonl", "events.jsonl", "README.md", "prompts/worker.md"} <= everything
    assert concepts.match_paths(flat, ["nope/*.jsonl"]) == [] and concepts.match_paths(flat, []) == []

    nested = config.corpus_dir("nested")
    assert [s["path"] for s in concepts.match_paths(nested, ["*/board.jsonl"])] == ["run-a/board.jsonl", "run-b/board.jsonl"]
    under = [s["path"] for s in concepts.match_paths(nested, ["run-a"])]
    assert under and all(p.startswith("run-a/") for p in under) and "run-a/forge.db" not in under
    srcs = concepts.match_paths(nested, ["*/board.jsonl", "*/events.jsonl"])
    assert [g["ref"] for g in concepts.groups_for(srcs, "run")] == ["run-a", "run-b"]
    assert concepts.groups_for(srcs, "run")[0]["paths"] == ["run-a/board.jsonl", "run-a/events.jsonl"]
    assert [g["ref"] for g in concepts.groups_for(concepts.match_paths(flat, ["board.jsonl"]), "run")] == ["."]
    assert len(concepts.groups_for(srcs, "run")) == 2 and len(concepts.groups_for(srcs, "agent")) == 4


async def test_regex_apply_records_for_real(api, workspaces_tmp):
    k = await _create(api, kind="regex", spec=PATTERN)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 200, r.text
    s = r.json()
    expected = _board_expected()
    assert set(expected.values()) == {"yes", "no"}
    assert s["status"] == "done" and s["total"] == 8 and s["labeled"] == 8 and s["failed"] == 0
    assert s["counts"] == {"yes": sum(v == "yes" for v in expected.values()), "no": sum(v == "no" for v in expected.values())}
    assert s["n_labeled"] == 8 and s["kind"] == "regex" and s["paths"] == ["board.jsonl"]

    # the labels file holds a row for each match alone, and a cover for the file's records (labels_store, covers)
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"]: r["label"] for r in rows} == {ref: v for ref, v in expected.items() if v == "yes"}
    assert all(r["source"] == "regex" and r["confidence"] == 1.0 and r["ts"] and r["rationale"] for r in rows)  # the matched text
    for r in rows:
        assert refs.resolve(MINI, r["ref"])["kind"] == "record"

    r = await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", params={"path": "board.jsonl"})
    body = r.json()
    assert body["concept"]["id"] == k["id"] and {row["ref"]: row["label"] for row in body["rows"]} == expected
    assert all(row["analyst"] is None and row["source"] == "regex" and row["confidence"] == 1.0 for row in body["rows"])
    assert all(not row["rationale"] for row in body["rows"] if row["label"] == "no")
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", params={"path": "events.jsonl"})).json()["rows"] == []

    k2 = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()
    assert k2["n_labeled"] == 8 and k2["counts"] == s["counts"] and k2["run"]["status"] == "done" and k2["run"]["done"] == 8
    assert k2["applications"][-1]["labeled"] == 8 and k2["applications"][-1]["status"] == "done"

    # a second run appends; the latest row per ref wins (still 8 labeled); a trial's sampled records have a row each
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"], "limit": 2})
    assert r.json()["total"] == 2 and r.json()["labeled"] == 2 and r.json()["n_labeled"] == 8 and r.json()["counts"] == s["counts"]
    assert len(concepts.read_labels(workspaces_tmp / CORPUS, k["id"])) == 3 + 2


async def test_apply_errors_and_limit(api, workspaces_tmp):
    k = await _create(api, kind="regex", spec=PATTERN)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"], "limit": 3})
    s = r.json()
    assert s["total"] == 3 and s["labeled"] == 3
    assert s["matched_total"] == 8 and concepts._runs[(CORPUS, k["id"])]["matched_total"] == 8
    assert s["labels_path"] == str(concepts.labels_file(workspaces_tmp / CORPUS, k["id"])) and Path(s["labels_path"]).is_absolute()
    stored = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()
    assert stored["applications"][-1]["total"] == 3 and stored["applications"][-1]["matched_total"] == 8
    [card] = [x for x in (await api.get(f"/api/ws/{CORPUS}/concepts")).json() if x["id"] == k["id"]]
    assert card["last_run"]["matched_total"] == 8
    s = (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})).json()
    assert s["total"] == s["matched_total"] == 8
    # the run's count of the first value is kept on the application, the numerator of the Files pane's outcome line
    [card] = [x for x in (await api.get(f"/api/ws/{CORPUS}/concepts")).json() if x["id"] == k["id"]]
    assert s["matches"] == card["last_run"]["matches"] == 3
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["nope/*.jsonl"]})).status_code == 400
    # no paths: the label's glob, which its first apply over board.jsonl set; a label with neither is refused
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()["glob"] == "board.jsonl"
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": []})).json()["paths"] == ["board.jsonl"]
    bare = await _create(api, name="no glob yet", kind="regex", spec=PATTERN)
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{bare['id']}/apply", json={"wait": True, "paths": []})).status_code == 400
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/zzzz/apply", json={"wait": True, "paths": ["board.jsonl"]})).status_code == 404
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["forge.db"]})).status_code == 400

    # an invalid regex is stored (no gate on save) and reported when applied
    assert (await api.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"spec": "(unclosed"})).status_code == 200
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 400 and "invalid regex" in r.json()["detail"]
    r = await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")
    assert r.json()["run"]["status"] == "error" and "invalid regex" in r.json()["run"]["message"]
    assert r.json()["applications"][-1]["status"] == "error"


async def test_prompt_apply_batches_rows(api, workspaces_tmp, fake_classify, monkeypatch):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)
    k = await _create(api, description="a board post that claims a PR")
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"], "created_by": "chat:ab12"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["total"] == 8 and s["labeled"] == 8 and s["failed"] == 0 and s["message"] is None
    assert len(fake_classify.calls) == 3  # 3 + 3 + 2 items
    call = fake_classify.calls[0]
    assert call["workspace"] == CORPUS and call["concept"]["description"] == "a board post that claims a PR"
    assert [ref for ref, _t in call["items"]] == [f"board.jsonl#L{i}" for i in (1, 2, 3)]
    assert "review someone else's pending request in return" in call["items"][0][1]  # the block text, not raw JSON
    assert '"thread_title"' not in call["items"][0][1]
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert len(rows) == 8 and all(r["source"] == "model" and 0 <= r["confidence"] <= 1 and r["rationale"] == "because" for r in rows)
    expected = _board_expected(r"(?i)claim")
    assert {r["ref"]: r["label"] for r in rows} == expected  # 'YES' is coerced to the concept's 'yes'
    assert s["counts"] == {"yes": sum(v == "yes" for v in expected.values()), "no": sum(v == "no" for v in expected.values())}
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()["applications"][-1]["created_by"] == "chat:ab12"


async def test_prompt_apply_skips_bad_batches_and_continues(api, fake_classify, monkeypatch):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)
    monkeypatch.setattr(concepts, "CONCURRENCY", 1)
    monkeypatch.setattr(concepts, "RETRY_DELAYS", (0.0,))
    fake_classify.plan = [
        _bad("rate_limited", "the subscription's rate limit is exhausted"),
        _bad("rate_limited", "slow down"),
        _bad("no_tool_call", "the model answered in prose without calling the labels tool"),
        _ok([{"i": 1, "label": "yes", "confidence": "85", "rationale": "r"}, {"label": "maybe", "confidence": 2}]),
    ]
    k = await _create(api)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["labeled"] == 2 and s["failed"] == 6 and s["total"] == 8 and "rate_limited: slow down" in s["message"]
    assert "exhausted" not in s["message"]
    assert "no_tool_call: the model answered in prose" in s["message"]
    assert len(fake_classify.calls) == 4
    rows = concepts.read_labels(config.WORKSPACES_DIR / CORPUS, k["id"])
    assert [(x["ref"], x["label"], x["confidence"]) for x in rows] == [("board.jsonl#L7", "yes", 0.85), ("board.jsonl#L8", "maybe", 0.02)]


async def test_classifier_calls_the_labels_model_refuses_run_on_the_fallback_and_the_run_says_so(api, workspaces_tmp,
                                                                                                  monkeypatch):
    """Every call the labels model's safeguards refuse runs again on the fallback model (model.structured), its units
    are labeled, and the run's record begins with one line counting those calls."""
    labels_model = concepts.labels_model(CORPUS)[0]
    assert labels_model != stub_messages.FALLBACK

    def answer(req: dict) -> dict:
        n = req["messages"][0]["content"][-1]["text"].count("### item ")
        return {"labels": [{"i": i, "label": "yes", "confidence": 0.9} for i in range(1, n + 1)]}

    stub = stub_messages.install(monkeypatch, stub_messages.refusing(labels_model, answer))
    k = await _create(api, description="a board post that claims a PR")
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["labeled"] == 8 and s["failed"] == 0
    assert s["message"] == "Downgrading Opus 5.5 to Opus 4.8"
    models = [q["model"] for q in stub.requests]
    assert models.count(labels_model) == 8 and models.count(stub_messages.FALLBACK) == 8
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()["applications"][-1]["message"] == s["message"]
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert len(rows) == 8 and {r["label"] for r in rows} == {"yes"}


async def test_prompt_apply_without_model_access_is_502(api, fake_classify, monkeypatch, tmp_path):
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(config, "HAS_API_KEY", False)
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "empty-config"))
    k = await _create(api)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 502 and "claude login" in r.json()["detail"]
    assert fake_classify.calls == []
    state = concepts._runs[(CORPUS, k["id"])]
    assert state["status"] == "error" and "claude login" in state["message"]
    assert concepts.read_labels(config.WORKSPACES_DIR / CORPUS, k["id"]) == []


async def test_analyst_verdicts_update_est_precision(api, workspaces_tmp):
    k = await _create(api)
    ws = workspaces_tmp / CORPUS
    _seed_rows(ws, k["id"], [
        _model_row("board.jsonl#L1", "yes", 0.9), _model_row("board.jsonl#L2", "yes", 0.8),
        _model_row("board.jsonl#L3", "no", 0.7), _model_row("board.jsonl#L4", "no", 0.6),
    ])
    url = f"/api/ws/{CORPUS}/concepts/{k['id']}/labels"
    r = await api.post(url, json={"ref": "board.jsonl#L1", "label": "yes"})
    assert r.status_code == 200
    assert r.json()["row"]["source"] == "analyst" and r.json()["row"]["confidence"] == 1.0
    assert r.json()["calibration"] == {"n": 1, "agreed": 1, "disagreed": 0, "est_precision": {"yes": 1.0, "no": None}}
    await api.post(url, json={"ref": "board.jsonl#L2", "label": "no", "note": "asks, does not claim"})
    r = await api.post(url, json={"ref": "board.jsonl#L3", "label": "no"})
    assert r.json()["calibration"] == {"n": 3, "agreed": 2, "disagreed": 1, "est_precision": {"yes": 0.5, "no": 1.0}}
    r = await api.post(url, json={"ref": "board.jsonl#L2", "label": "yes"})
    assert r.json()["calibration"]["agreed"] == 3 and r.json()["calibration"]["est_precision"]["yes"] == 1.0
    r = await api.post(url, json={"ref": "board.jsonl#L8", "label": "yes"})
    assert r.json()["calibration"]["n"] == 3
    assert (await api.post(url, json={"ref": "", "label": "yes"})).status_code == 400

    rows = {x["ref"]: x for x in (await api.get(url, params={"path": "board.jsonl"})).json()["rows"]}
    assert rows["board.jsonl#L2"]["analyst"] == "yes" and rows["board.jsonl#L2"]["label"] == "yes"
    assert rows["board.jsonl#L4"]["analyst"] is None
    assert rows["board.jsonl#L8"] == {**rows["board.jsonl#L8"], "label": None, "source": None, "analyst": "yes"}
    k2 = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()
    assert k2["est_precision"] == 1.0 and k2["n_reviewed"] == 3 and k2["n_labeled"] == 4
    assert (await api.get(f"/api/ws/{CORPUS}/concepts")).json()[0]["est_precision"] == 1.0

    # the rows route honours the verdicts: L2 reads as yes (the verdict), L8 is in by hand alone
    body = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}/rows", params={"value": "yes"})).json()
    assert body["total"] == 3 and [x["ref"] for x in body["rows"]] == ["board.jsonl#L1", "board.jsonl#L2", "board.jsonl#L8"]
    assert body["rows"][1] == {"ref": "board.jsonl#L2", "label": "yes", "confidence": 0.8, "rationale": None, "analyst": "yes"}
    body = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}/rows", params={"value": "no", "limit": 1, "offset": 1})).json()
    assert body["total"] == 2 and [x["ref"] for x in body["rows"]] == ["board.jsonl#L4"]
    body = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}/rows", params={"limit": 2})).json()
    assert body["total"] == 5 and len(body["rows"]) == 2
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/zzzz/rows")).status_code == 404

    # the workspace-wide view for one file: every concept with rows on that path
    k_other = await _create(api, name="other")
    _seed_rows(ws, k_other["id"], [_model_row("events.jsonl#L1", "yes", 0.9)])
    r = await api.get(f"/api/ws/{CORPUS}/labels", params={"path": "board.jsonl"})
    assert [x["concept_id"] for x in r.json()] == [k["id"]] and len(r.json()[0]["rows"]) == 5 and r.json()[0]["created_by"] == "user"
    r = await api.get(f"/api/ws/{CORPUS}/labels", params={"path": "events.jsonl"})
    assert [x["concept_id"] for x in r.json()] == [k_other["id"]]


async def test_apply_scoped_defines_applies_cards_and_filters(workspaces_tmp, fake_classify, monkeypatch):
    monkeypatch.setattr(concepts, "_loop", asyncio.get_running_loop())
    ws = workspaces_tmp / CORPUS
    nb, (code_cell, note, _label) = _canvas(ws)
    s = await concepts.apply_scoped(CORPUS, scope="canvas", name="claims a PR", kind="prompt", text="a card about claiming a PR",
                                    values=["yes", "no"], paths=None, limit=None, comment=True, filter=True,
                                    created_by="user", chat="ab12", group=nb["id"])
    assert set(s) == {"concept", "name", "unit", "total", "counts", "partial", "cell", "filter", "labels_path", "unchanged", "stale"}
    assert s["stale"] == []
    assert s["unchanged"] is False
    assert s["name"] == "claims a PR" and s["unit"] == "cell" and s["total"] == 2 and s["partial"] is False
    assert s["counts"] == {"yes": 2} and s["filter"] == {"concept": s["concept"], "value": "yes"}
    assert Path(s["labels_path"]) == concepts.labels_file(ws, s["concept"])
    concept = concepts.read_concept(ws, s["concept"])
    assert concept["created_by"] == "chat:ab12" and concept["description"] == "a card about claiming a PR" and concept["spec"] == ""
    # the label card sits in the given group, after the cards it labeled, and is not itself a unit
    stored = notebook.read_notebook(ws, nb["id"])
    card = stored["cells"][-1]
    assert card["id"] == s["cell"] and card["kind"] == "label" and card["payload"] == {"concept": s["concept"]}
    assert card["title"] == "claims a PR" and card["created_by"] == "chat:ab12" and card["labels"] == [s["concept"]] and card["created_ts"]
    assert [ref for ref, _t in fake_classify.calls[0]["items"]] == [f"card:{code_cell['id']}", f"card:{note['id']}"]
    assert concepts.read_filters(ws) == {"canvas": {"concept": s["concept"], "value": "yes"}}
    # the run was followed by an agent chat of role labels, and the filter left a chip in main
    from app import agents

    chats = agents.list_chats(CORPUS)
    labels_chat = next(m for m in chats if m.get("role") == "labels")
    assert labels_chat["kind"] == "agent" and labels_chat["title"] == "label claims a PR"
    for _ in range(20):
        await asyncio.sleep(0.01)
    meta = agents.read_meta(CORPUS, labels_chat["id"])
    assert meta["status"] == "done" and meta["result"].startswith("labeled 2 of 2 cell(s): yes 2")
    main_events = agents.read_events(agents.paths(CORPUS, "main")[1])
    chips = [e for e in main_events if e.get("type") == "chip"]
    assert [(e["kind"], e["ref"]) for e in chips] == [("filter", f"concept:{s['concept']}")]
    assert [e["role"] for e in main_events if e.get("type") == "agent"] == ["labels"]
    # the same name again redefines the concept, keeps its card and clears the old rows
    s2 = await concepts.apply_scoped(CORPUS, scope="canvas", name="claims a PR", kind="regex", text=r"(?i)claim",
                                     values=None, paths=None, limit=None, comment=False, filter=False,
                                     created_by="terminal", chat=None, group=nb["id"])
    assert s2["concept"] == s["concept"] and s2["cell"] == s["cell"] and s2["filter"] is None and s2["counts"] == {"yes": 2}
    assert concepts.read_concept(ws, s["concept"])["version"] == 2 and concepts.read_concept(ws, s["concept"])["kind"] == "regex"
    assert len([x for x in notebook.read_notebook(ws, nb["id"])["cells"] if x.get("kind") == "label"]) == 2  # the fixture's and ours
    assert len(concepts.read_labels(ws, s["concept"])) == 2
    # a label card is a card like any other: apply_label's question becomes its title, and a later apply without one
    # leaves it
    s3 = await concepts.apply_scoped(CORPUS, scope="canvas", name="claims a PR", kind="regex", text=r"(?i)claim",
                                     values=None, paths=None, limit=None, comment=False, filter=False,
                                     created_by="terminal", chat=None, group=nb["id"], question="How many cards claim a PR?")
    assert s3["cell"] == s["cell"] and notebook.get_cell(CORPUS, s["cell"])["title"] == "How many cards claim a PR?"
    # the same predicate again keeps the label: no new version, no new run, the counts it has
    assert s3["unchanged"] is True and s3["counts"] == {"yes": 2} and s3["total"] == 2
    assert concepts.read_concept(ws, s["concept"])["version"] == 2 and len(concepts.read_labels(ws, s["concept"])) == 2
    await concepts.apply_scoped(CORPUS, scope="canvas", name="claims a PR", kind="regex", text=r"(?i)claim",
                                values=None, paths=None, limit=None, comment=False, filter=False,
                                created_by="terminal", chat=None, group=nb["id"])
    assert notebook.get_cell(CORPUS, s["cell"])["title"] == "How many cards claim a PR?"
    # the workspace stream saw the card and the filter
    p = workspaces_tmp / CORPUS / "investigations" / "main" / "events.jsonl"
    events = [json.loads(line) for line in p.read_text().splitlines() if line.strip()]
    assert {"type": "cell", "notebook": nb["id"], "cell": s["cell"], "kind": "note"} == {k: v for k, v in next(e for e in events if e["type"] == "cell").items() if k in ("type", "notebook", "cell", "kind")}
    assert any(e["type"] == "filter" and e["scope"] == "canvas" for e in events)
    # deleting the concept removes its card
    concepts._stop_apply((CORPUS, s["concept"]))
    await concepts.delete_concept_route(CORPUS, s["concept"])
    assert [x for x in notebook.read_notebook(ws, nb["id"])["cells"] if x.get("kind") == "label"] == [_label]


async def test_apply_scoped_refused_leaves_no_label(workspaces_tmp):
    """An apply the run would refuse (paths that match only a database, paths that match nothing, a regex that does not
    compile) is refused before the label is defined, so no empty label is left in Files and no card on the canvas."""
    ws = workspaces_tmp / CORPUS
    kw = dict(scope="files", values=None, limit=None, comment=False, filter=False, created_by="user", chat=None, group=None)
    with pytest.raises(concepts.HTTPException) as e:
        await concepts.apply_scoped(CORPUS, name="db probe", kind="regex", text="merged", paths=["forge.db"], **kw)
    assert e.value.status_code == 400 and "database forge.db" in e.value.detail and "in a card" in e.value.detail
    with pytest.raises(concepts.HTTPException) as e:
        await concepts.apply_scoped(CORPUS, name="nothing", kind="regex", text="merged", paths=["runs/*.jsonl"], **kw)
    assert e.value.detail == "no files match ['runs/*.jsonl']"
    with pytest.raises(concepts.HTTPException) as e:
        await concepts.apply_scoped(CORPUS, name="bad", kind="regex", text="(unclosed", paths=["board.jsonl"], **kw)
    assert "invalid regex" in e.value.detail
    assert concepts.list_concepts(ws) == []
    assert not any(x.get("kind") == "label" for info in notebook.list_notebooks(ws)
                   for x in notebook.read_notebook(ws, info["id"])["cells"])


async def test_resolve_concept_ref(api, workspaces_tmp):
    k = await _create(api, kind="regex", spec=PATTERN, description="board posts that claim a PR")
    await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    out = concepts.resolve_concept_ref(MINI, f"concept:{k['id']}")
    assert out["kind"] == "concept" and out["concept_id"] == k["id"] and out["record"]["n_labeled"] == 8
    assert out["excerpt"].startswith("claims a PR (regex, per record): board posts that claim a PR")
    assert "8 labeled (no: 5, yes: 3)" in out["excerpt"] and "uncalibrated" in out["excerpt"]
    assert out["meta"]["est_precision"] is None
    assert concepts.resolve_concept_ref(CORPUS, f"concept:{k['id']}")["concept_id"] == k["id"]
    await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", json={"ref": "board.jsonl#L1", "label": "yes"})
    assert "est. precision 100% on 1 reviewed" in concepts.resolve_concept_ref(MINI, f"concept:{k['id']}")["excerpt"]
    with pytest.raises(refs.RefError) as e:
        concepts.resolve_concept_ref(MINI, "concept:deadbeef")
    assert e.value.status == 404
    with pytest.raises(refs.RefError) as e:
        concepts.resolve_concept_ref(MINI, "board.jsonl#L1")
    assert e.value.status == 400


def test_define_concept_and_redefinition(workspaces_tmp):
    ws = config.workspace_dir(CORPUS)
    k = concepts.define_concept(CORPUS, "Force push", "an agent force-pushes", "regex", spec=r"(?i)push\s+--force", created_by="chat:chat1")
    assert k["created_by"] == "chat:chat1" and k["kind"] == "regex" and k["unit"] == "record" and k["labels"] == ["yes", "no"]
    assert concepts.find_concept(ws, "  force   PUSH ")["id"] == k["id"]
    assert concepts.find_concept(ws, k["id"])["id"] == k["id"]
    assert concepts.find_concept(ws, "nope") is None
    with pytest.raises(Exception) as e:
        concepts.define_concept(CORPUS, "x", "d", kind="sql")
    assert getattr(e.value, "status_code", None) == 400
    k2 = concepts.define_concept(CORPUS, "review ask", "asks for a review", labels=["review", "other"], unit="span")
    assert concepts.read_concept(ws, k2["id"])["labels"] == ["review", "other"] and k2["unit"] == "span"
    # the same name redefines: the id stays, the version steps, the old labels and store are cleared
    concepts.labels_file(ws, k["id"]).parent.mkdir(parents=True, exist_ok=True)
    concepts.labels_file(ws, k["id"]).write_text('{"ref": "events.jsonl#L1", "label": "yes"}\n')
    labels_store.Store(concepts.labels_file(ws, k["id"])).rebuild()
    second = concepts.define_concept(CORPUS, "Force  PUSH", "a git.ref event whose force flag is set", kind="prompt")
    assert second["id"] == k["id"] and second["version"] == 2 and second["kind"] == "prompt"
    assert not concepts.labels_file(ws, k["id"]).exists() and not labels_store.store_path(concepts.labels_file(ws, k["id"])).exists()
    assert sorted(c["id"] for c in concepts.list_concepts(ws)) == sorted([k["id"], k2["id"]])
    assert concepts.read_concept(ws, k["id"])["ts"] == k["ts"]  # a redefinition keeps the definition's first ts


