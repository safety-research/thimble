"""scripts/dev/make_toy_corpus.py writes a corpus that verifies, and its result records state no model's limits or
price: the cost is an invented round figure per turn."""
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "dev" / "make_toy_corpus.py"


def test_the_toy_corpus_verifies_and_states_no_model_limits_or_price(tmp_path):
    out = tmp_path / "toy-incident"
    r = subprocess.run([sys.executable, str(SCRIPT), "--out", str(out)], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and "verify: ok" in r.stdout, r.stdout + r.stderr
    results = [rec for f in sorted((out / "agents").glob("*.jsonl")) for line in f.read_text().splitlines()
               if (rec := json.loads(line)).get("type") == "result"]
    assert results
    for rec in results:
        assert rec["total_cost_usd"] == round(0.01 * rec["num_turns"], 2)
        for usage in rec["modelUsage"].values():
            assert usage["costUSD"] == rec["total_cost_usd"]
            assert not {"contextWindow", "maxOutputTokens"} & set(usage)
