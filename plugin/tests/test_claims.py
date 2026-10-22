"""The folder's map of claims (engine/kernel/claims.py): `thimble claims save --from FILE` checks every citation's quote
against the record its ref names, keeps the map under THIMBLE_HOME (never in the folder), and tells the session's change
feed, which brings the map into the Claims pane (plugin/claims/term.ts). Made-up data only.
Run: python3 -m pytest plugin/tests/test_claims.py"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

THIMBLE = Path(__file__).resolve().parents[1] / "bin" / "thimble"


def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "THIMBLE_PYTHON": sys.executable, "THIMBLE_ROOT": str(root)}
    return subprocess.run([str(THIMBLE), *args], text=True, capture_output=True, cwd=root, env=env, timeout=120)


def test_the_save_checks_each_quote_keeps_the_map_and_tells_the_feed(tmp_path: Path, monkeypatch) -> None:
    d = tmp_path / "data"
    (d / "runs").mkdir(parents=True)
    with open(d / "runs" / "r1.jsonl", "w") as f:
        f.write(json.dumps({"type": "assistant", "text": "start"}) + "\n")
        f.write(json.dumps({"type": "assistant", "text": "The test fails because of a timezone mismatch."}) + "\n")
    home = tmp_path / "th"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    monkeypatch.setenv("THIMBLE_SESSION", "s-claims")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    m = {"title": "1 run", "data": {"clusters": [{"id": "tz", "name": "timezone detour"}], "claims": [
        {"id": "a", "name": "Agents blame a timezone bug", "cluster": "tz", "evidence": [{"ref": "runs/r1.jsonl#L2", "quote": "a  Timezone mismatch"}]},
        {"id": "b", "name": "The test was rerun", "cluster": "tz", "evidence": [{"ref": "runs/r1.jsonl#L1", "quote": "reran the test 200 times"}, {"ref": "runs/r9.jsonl#L1", "quote": "x"}]}]}}
    f = tmp_path / "map.json"
    f.write_text(json.dumps(m))
    out = run(d, "claims", "save", "--from", str(f))
    assert out.returncode == 0, out.stderr
    assert "saved the folder's claims: 2 claims in 1 clusters" in out.stdout
    assert "1 of 3 citations hold" in out.stdout
    assert "problem: /claims/1/evidence/0: the quote 'reran the test 200 times' is not in runs/r1.jsonl#L1" in out.stdout
    assert "problem: /claims/1/evidence/1: runs/r9.jsonl#L1 names no record of the folder" in out.stdout
    # kept under THIMBLE_HOME, not in the folder
    assert not (d / "thimble").exists()
    feed = [json.loads(x) for x in (home / "events" / "s-claims.jsonl").read_text().splitlines()]
    line = [x for x in feed if x["kind"] == "folder_claims"][-1]
    assert line["holds"] == 1 and line["total"] == 3
    kept = json.loads(Path(line["path"]).read_text())
    assert str(home) in line["path"] and kept["data"]["claims"][0]["id"] == "a"
    # a map with no claims list is refused
    f.write_text(json.dumps({"data": {}}))
    bad = run(d, "claims", "save", "--from", str(f))
    assert bad.returncode == 1 and 'no "claims" list' in bad.stderr
