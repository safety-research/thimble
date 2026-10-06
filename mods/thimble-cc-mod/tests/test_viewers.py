"""Tests of the worked examples' readers under helper/viewhost.py: `python3 tests/test_viewers.py` (Node 22.18 or newer
for the render check). Each reader runs on its own sample/, read to the end, with the counts design.md records; each
rows.json is what its reader gives now, and each view draws within 70 and 110 columns."""
from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(MOD, "helper"))
from viewhost import Viewer, glob_matches, locator_of  # noqa: E402


def viewer(name: str) -> Viewer:
    d = os.path.join(MOD, "viewers", name)
    return Viewer(d, os.path.join(d, "sample"))


def test_globs_match_as_thimble_does() -> None:
    assert glob_matches("runs/r1/a/subagents/agent-1.jsonl", "runs/*.jsonl")
    assert glob_matches("tickets/5501.txt", "tickets/*.txt")
    assert glob_matches("notes.vtt", "**/*.vtt")
    assert not glob_matches("chat/ops.json", "runs/*.json")
    assert locator_of("a.jsonl#L3") == {"path": "a.jsonl", "fragment": "L3"}
    assert locator_of("view:timeline/INC-312") == {"key": "INC-312"}


def test_linked_sessions() -> None:
    v = viewer("linked-sessions")
    s = v.shown()
    assert (s["files"], s["unread"], s["missing"]) == (20, [], [])
    assert s["problems"]["count"] == 1 and s["problems"]["examples"][0]["ref"].endswith(".jsonl#L34")
    o = v.records({})
    assert (len(o["runs"]), len(o["sessions"]), len(o["calls"])) == (3, 17, 316)
    wh = next(x for x in o["sessions"] if x["agent"] == "webhooks" and x["run"] == "r1")
    d = v.records({"op": "session", "id": wh["id"]})
    assert d["call count"] == 25
    on = v.records({}, labels={"on": ["Test runs", "Pagination"]})
    assert [c["n"] for c in on["classes"]] == [66, 15] and on["none"] == 236
    kept = v.records({}, labels={"on": ["Test runs"], "filter": {"label": "Test runs"}})
    assert len(kept["calls"]) == 66
    assert v.resolve(wh["ref"])["label"] == "webhooks · prompt 07:10"


def test_repository() -> None:
    v = viewer("repository")
    s = v.shown()
    assert (s["files"], s["unread"], s["hidden"]) == (31, [], [])
    assert [p["ref"] for p in s["problems"]["examples"]] == ["runs/r4/events.jsonl#L70"]
    o = v.records({"op": "view", "tab": "pulls"})
    assert o["tabs"] == {"pulls": 35, "issues": 36, "discussions": 12, "agents": 16}
    assert dict(o["facets"]["state"]) == {"merged": 28, "closed": 4, "open": 3}
    u = v.records({"op": "unit", "key": "r3/pull/15"})
    assert u["title"] == "Jump whole periods in between()" and len(u["records"]) == 4
    kept = v.records({"op": "view", "tab": "pulls"}, labels={"on": ["Clock change"], "filter": {"label": "Clock change"}})
    assert kept["total"] == 6
    assert v.resolve("view:repository/r3/pull/15")["refs"][0] == "runs/r3/export/pulls.csv#L8"


def test_timeline() -> None:
    v = viewer("timeline")
    s = v.shown()
    assert (s["files"], s["unread"]) == (39, [])
    assert [p["ref"] for p in s["problems"]["examples"]] == ["agents.log#L38"]
    o = v.records({})
    assert len(o["cols"]["r"]) == 198 and o["next"] is None
    assert list(o["starts"]) == ["INC-311", "INC-312", "INC-313"]
    on = v.records({}, labels={"on": ["Database connections", "Charged twice"]})
    assert sum(m == 0 for m in on["cols"]["m"]) == 22 and sum(m == 1 for m in on["cols"]["m"]) == 12
    assert len(v.records({}, labels={"on": ["Charged twice"], "filter": {"label": "Charged twice"}})["cols"]["r"]) == 12
    assert v.resolve("view:timeline/INC-312")["label"] == "INC-312 · 100 records"


NAMES = ("timeline", "linked-sessions", "repository")


def test_rows_json_is_what_the_reader_gives() -> None:
    for name in NAMES:
        with open(os.path.join(MOD, "viewers", name, "rows.json"), encoding="utf-8") as f:
            kept = json.load(f)
        assert json.loads(json.dumps(viewer(name).rows(), ensure_ascii=False)) == kept, f"{name}: rerun the rows op"


def test_rows_carry_keys_refs_and_units() -> None:
    for name in NAMES:
        got = viewer(name).rows()
        spec = json.load(open(os.path.join(MOD, "viewers", name, "view.json"), encoding="utf-8"))
        for c in spec["collections"]:
            rows = got["collections"][c["name"]]
            keys = [r[c["key"]] for r in rows]
            assert rows and len(set(keys)) == len(keys), (name, c["name"])
            assert all("#" in str(r.get("ref") or "") for r in rows), (name, c["name"])
        assert len(got["problems"]) == 1 and got["files"] > 0
        assert all(lab["units"] for lab in got["labels"]), name
    pulls = {k for k, v in viewer("repository").rows()["labels"][0]["units"].items()
             if k.startswith("pulls/") and v == "clock change"}
    assert len(pulls) == 6


def test_views_draw_within_70_and_110_columns() -> None:
    for name in NAMES:
        d = os.path.join(MOD, "viewers", name)
        for width in (70, 110):
            out = subprocess.run(["node", os.path.join(MOD, "tools", "render_view.mjs"), "--spec", os.path.join(d, "view.json"),
                                  "--rows", os.path.join(d, "rows.json"), "--check", "--width", str(width), "--height", "48"],
                                 capture_output=True, text=True)
            report = json.loads(out.stdout)
            assert report["ok"] and not report["notes"], (name, width, report)


def test_cli_answers_json() -> None:
    d = os.path.join(MOD, "viewers", "timeline")
    out = subprocess.run([sys.executable, os.path.join(MOD, "helper", "viewhost.py"), d, "resolve", "agents.log#L7",
                          "--root", os.path.join(d, "sample")], capture_output=True, text=True, check=True).stdout
    got = json.loads(out)
    assert got["ok"] and got["result"]["excerpt"] == "Opened INC-312: payments error rate 14%"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
