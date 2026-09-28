"""app/swarm.py: the check of a swarm map against its corpus, and the test for a corpus of agents acting on shared
places."""
import copy
import json
from pathlib import Path

import pytest

from app import swarm

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


def test_the_check_passes_a_map_whose_refs_and_quotes_hold_and_names_each_error(corpus):
    errors, warnings = swarm.check(corpus, GOOD)
    assert errors == [] and [w.split(":")[0] for w in warnings] == ["agents", "threads", "actions"]
    for edit, expected in [
        (lambda d: d["actions"][0].update(quote="LOCKED by runner-9"), "is not in saves.jsonl#L2"),
        (lambda d: d["actions"][0].update(ref="saves.jsonl#L9"), "has no line 9"),
        (lambda d: d["actions"][1].update(quote="LOCKED by runner-07"), "already in the save before"),
        (lambda d: d["actions"][1].update(agent="runner-07"), "does not name the agent"),
        (lambda d: d["links"][0].update({"from": 1, "to": 2}), "from > to"),
    ]:
        doc = copy.deepcopy(GOOD)
        edit(doc)
        assert any(expected in e for e in swarm.check(corpus, doc)[0]), (expected, swarm.check(corpus, doc)[0])


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
