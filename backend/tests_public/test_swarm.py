"""app/swarm.py: the check of a swarm map against its corpus, and the run loop around a faked `claude -p`."""
import copy
import json
import os
import stat
import sys
from pathlib import Path

import pytest

from app import prompts, swarm

# An invented swarm: build runners passing a deploy lock on a shared board, each save holding the whole page.
SAVES = [
    ("runner-07", "2031-03-04T01:58:10Z", "FREE"),
    ("runner-07", "2031-03-04T02:00:02Z", "LOCKED by runner-07"),
    ("qa-bot", "2031-03-04T02:14:40Z",
     "LOCKED by runner-07\n\nlock from runner-07 is stale, setting FREE -- QAWatcher"),
    ("runner-11", "2031-03-04T02:15:05Z", "LOCKED by runner-11"),
]


def _corpus(root: Path) -> Path:
    root.mkdir()
    rows = [{"page": "board/DeployLock", "seq": i + 1, "user": u, "time": t, "body": b}
            for i, (u, t, b) in enumerate(SAVES)]
    (root / "saves.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), "utf-8")
    (root / "pages.jsonl").write_text(json.dumps({"page": "board/DeployLock", "saves": len(rows)}) + "\n", "utf-8")
    return root


GOOD = {
    "title": "QA freed a lock runner-07 held, and runner-11 took it",
    "agents": [
        {"username": "runner-07", "goal": "Hold the deploy lock for its build",
         "evidence": [{"ref": "saves.jsonl#L2", "quote": "LOCKED by runner-07"}]},
        {"username": "qa-bot", "goal": "Free locks it judges stale", "signs_as": ["QAWatcher"],
         "evidence": [{"ref": "saves.jsonl#L3", "quote": "is stale, setting FREE"}]},
        {"username": "runner-11", "goal": "Unknown beyond taking the lock once",
         "evidence": [{"ref": "saves.jsonl#L4", "quote": "LOCKED by runner-11"}]},
    ],
    "threads": [{"tag": "T1", "id": "board/DeployLock", "ref": "pages.jsonl#L1"}],
    "actions": [
        {"id": 1, "agent": "runner-07", "thread": "T1", "time": "2031-03-04T02:00:02Z",
         "action": "Set the lock to runner-07",
         "ref": "saves.jsonl#L2", "before": "saves.jsonl#L1", "quote": "LOCKED by runner-07"},
        {"id": 2, "agent": "qa-bot", "thread": "T1", "time": "2031-03-04T02:14:40+00:00",
         "action": "Reported the lock stale",
         "ref": "saves.jsonl#L3", "before": "saves.jsonl#L2", "quote": "lock from runner-07 is stale"},
        {"id": 3, "agent": "runner-11", "thread": "T1", "time": "2031-03-04T02:15:05Z",
         "action": "Set the lock to runner-11",
         "ref": "saves.jsonl#L4", "before": "saves.jsonl#L3", "quote": "LOCKED by runner-11"},
    ],
    "links": [
        {"from": 2, "to": 1, "type": "contradicts", "reason": "Calls runner-07's lock stale and frees it",
         "evidence": [{"ref": "saves.jsonl#L3", "quote": "lock from runner-07 is stale, setting FREE"}]},
        {"from": 3, "to": 2, "type": "related", "reason": "Takes the lock qa-bot freed",
         "evidence": [{"ref": "saves.jsonl#L4", "quote": "LOCKED by runner-11"}]},
    ],
}


@pytest.fixture()
def corpus(tmp_path) -> Path:
    return _corpus(tmp_path / "corpus")


def _errors(corpus: Path, doc: dict) -> list[str]:
    return swarm.check(corpus, doc)[0]


def test_a_map_whose_refs_and_quotes_hold_passes_with_scale_warnings(corpus):
    errors, warnings = swarm.check(corpus, GOOD)
    assert errors == []
    assert [w.split(":")[0] for w in warnings] == ["agents", "threads", "actions"]


@pytest.mark.parametrize("edit, expected", [
    (lambda d: d["actions"][0].update(quote="LOCKED by runner-9"), "is not in saves.jsonl#L2"),
    (lambda d: d["actions"][0].update(ref="saves.jsonl#L9"), "has no line 9"),
    (lambda d: d["actions"][0].update(ref="../saves.jsonl#L2"), "no file"),
    (lambda d: d["actions"][1].update(quote="LOCKED by runner-07"), "already in the save before"),
    (lambda d: d["actions"][1].update(time="2031-03-04T02:14:41Z"), "is not a time of its record"),
    (lambda d: d["actions"][1].update(agent="runner-07"), "does not name the agent"),
    (lambda d: d["actions"][2].update(time="2031-03-04T01:00:00Z"), "ids follow event order"),
    (lambda d: d["threads"][0].update(id="threads/DeployLock"), "does not name the thread"),
    (lambda d: d["agents"][1].update(signs_as=["QABot"]), "signs_as 'QABot'"),
    (lambda d: d["links"][0].update({"from": 1, "to": 2}), "from > to"),
    (lambda d: d["links"][0].update(type="agrees"), "is not one of"),
    (lambda d: d["links"][0].update(evidence=[]), "evidence must be a non-empty list"),
    (lambda d: d["agents"].append({"username": "idle", "goal": "x",
                                   "evidence": [{"ref": "saves.jsonl#L1", "quote": "FREE"}]}),
     "has no action"),
])
def test_the_check_names_each_kind_of_error(corpus, edit, expected):
    doc = copy.deepcopy(GOOD)
    edit(doc)
    assert any(expected in e for e in _errors(corpus, doc)), _errors(corpus, doc)


def test_an_agent_is_a_whole_value_of_its_record(corpus):
    doc = copy.deepcopy(GOOD)
    doc["agents"][0]["username"] = doc["actions"][0]["agent"] = "runner-0"
    assert any("does not name the agent 'runner-0'" in e for e in _errors(corpus, doc))


def test_the_run_messages_are_in_tools_md(monkeypatch):
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    assert "{out}" in prompts.section("tools", "swarm-start")
    assert "{errors}" in prompts.section("tools", "swarm-check-failed")


FAKE = """#!{python}
import json, os, sys
from pathlib import Path
state = Path(os.environ["SWARM_FAKE_STATE"])
calls = json.loads(state.read_text()) if state.exists() else []
calls.append(sys.argv[1:])
state.write_text(json.dumps(calls))
draft = Path(os.environ["SWARM_FAKE_DRAFT"])
n = len(calls)
if n == 1 and os.environ.get("SWARM_FAKE_REFUSE"):
    print(json.dumps({{"type": "assistant", "message": {{"stop_reason": "refusal", "content": []}}}}))
    print(json.dumps({{"type": "result", "is_error": False, "result": ""}}))
    sys.exit(0)
if n == 1:
    print(json.dumps({{"type": "result", "is_error": True, "result": "API Error: 529 overloaded_error"}}))
    sys.exit(1)
doc = json.loads(os.environ["SWARM_FAKE_DOC"])
if n == 2:
    doc["actions"][0]["quote"] = "not in the record"
draft.write_text(json.dumps(doc))
print(json.dumps({{"type": "result", "is_error": False, "result": "Done.", "total_cost_usd": 0.01}}))
"""


def _fake_claude(tmp_path, monkeypatch) -> tuple[Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "claude"
    fake.write_text(FAKE.format(python=sys.executable))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    work, out = tmp_path / "work", tmp_path / "swarm.json"
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("SWARM_FAKE_STATE", str(tmp_path / "calls.json"))
    monkeypatch.setenv("SWARM_FAKE_DRAFT", str(work / out.name))
    monkeypatch.setenv("SWARM_FAKE_DOC", json.dumps(GOOD))
    monkeypatch.setattr(swarm.time, "sleep", lambda s: None)
    return work, out


def test_run_retries_capacity_and_sends_check_errors_back(corpus, tmp_path, monkeypatch):
    work, out = _fake_claude(tmp_path, monkeypatch)

    errors, _ = swarm.run(corpus, out, work)

    assert errors == []
    assert json.loads(out.read_text()) == GOOD
    calls = json.loads((tmp_path / "calls.json").read_text())
    assert [("--resume" in c) for c in calls] == [False, True, True]
    assert "at capacity" in calls[1][-1]
    assert "is not in saves.jsonl#L2" in calls[2][-1]
    runs = [json.loads(ln) for ln in out.with_name("swarm.runs.jsonl").read_text().splitlines()]
    assert len(runs) == 3 and runs[0]["is_error"] is True


def test_run_resumes_a_refused_session_on_the_fallback_model(corpus, tmp_path, monkeypatch):
    work, out = _fake_claude(tmp_path, monkeypatch)
    monkeypatch.setenv("SWARM_FAKE_REFUSE", "1")

    swarm.run(corpus, out, work, model="model-a", fallback_model="model-b")

    calls = json.loads((tmp_path / "calls.json").read_text())
    models = [c[c.index("--model") + 1] for c in calls]
    assert models[:2] == ["model-a", "model-b"] and "--resume" in calls[1]
    assert "model-b" in calls[1][-1]


def test_detect_finds_agents_addressing_each_other_on_shared_threads(tmp_path):
    board, log = tmp_path / "board", tmp_path / "log"
    board.mkdir()
    log.mkdir()
    posts = [{"thread_id": t, "author": f"bot-{a}", "body": f"bot-{(a + 1) % 6} can you take this?"}
             for t in (1, 2) for a in range(6)]
    (board / "posts.jsonl").write_text("".join(json.dumps(p) + "\n" for p in posts), "utf-8")
    steps = [{"session": "s1", "author": "bot-0", "text": f"step {i}"} for i in range(20)]
    (log / "steps.jsonl").write_text("".join(json.dumps(p) + "\n" for p in steps), "utf-8")

    found = swarm.detect(board)
    assert found["swarm"] is True
    assert (found["actor_field"], found["place_field"]) == ("author", "thread_id")
    assert (found["actors"], found["places"]) == (6, 2)
    assert found["addressing"] == 1.0
    assert swarm.detect(log)["swarm"] is False


def test_a_thread_id_may_be_split_over_fields(tmp_path):
    root = tmp_path / "split"
    root.mkdir()
    rows = [{"wiki": "board", "page": "DeployLock", "user": u, "time": t, "body": b} for u, t, b in SAVES]
    (root / "saves.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), "utf-8")
    (root / "pages.jsonl").write_text(json.dumps({"page": "board/DeployLock"}) + "\n", "utf-8")
    assert _errors(root, GOOD) == []
