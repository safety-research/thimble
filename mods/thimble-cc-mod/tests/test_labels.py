"""Tests of the label helper (helper/labels.py): `python3 tests/test_labels.py`."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")
sys.path.insert(0, HELPER)
import labels  # noqa: E402


def corpus(d: str) -> None:
    with open(os.path.join(d, "tickets.jsonl"), "w") as f:
        for i in range(1, 41):
            body = "I want my money back, the charger broke" if i % 4 == 0 else f"Where is my order number {i}?"
            f.write(json.dumps({"id": i, "body": body}) + "\n")
    with open(os.path.join(d, "orders.csv"), "w") as f:
        f.write("order,status\n" + "".join(f"{i},{'late' if i % 3 == 0 else 'ok'}\n" for i in range(1, 10)))


def spec(d: str, slug: str, **kw) -> None:
    os.makedirs(labels.folder(d, slug), exist_ok=True)
    with open(os.path.join(labels.folder(d, slug), "spec.json"), "w") as f:
        json.dump(kw, f)


def run(d: str, *args: str) -> dict:
    r = subprocess.run([sys.executable, os.path.join(HELPER, "labels.py"), *args, "--cwd", d], capture_output=True, text=True,
                       env={**os.environ, "THIMBLE_CC_MOD_ROOT": d})
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_sample_spreads() -> None:
    assert labels.sample(list(range(100)), 5) == [0, 25, 50, 74, 99]
    assert labels.sample([1, 2], 5) == [1, 2]


def test_regex_trial_then_all() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        spec(d, "refund", name="refund", kind="regex", definition="(?i)money back", values=["refund", "other"], paths=["tickets.jsonl"], field="body")
        got = run(d, "run", "refund", "--limit", "8")
        assert got["trial"] and got["labeled"] == 8 and got["total"] == 40, got
        got = run(d, "run", "refund")
        assert not got["trial"] and got["counts"] == {"refund": 10, "other": 30}, got
        # one label card: the counts, the label, and the first records picked, every value among them
        assert len(got["cards"]) == 1, got
        bar = json.load(open(os.path.join(d, ".thimble-cc-mod", "cards", f"{got['cards'][0]}.json")))
        assert bar["kind"] == "label" and bar["total"] == 40 and [r["value"] for r in bar["rows"]] == [10, 30], bar
        assert bar["source"]["script"] == ".thimble-cc-mod/scripts/label-refund.py", bar["source"]
        assert bar["label"]["slug"] == "refund" and bar["label"]["values"] == ["refund", "other"] and bar["label"]["labeled"] == 40, bar["label"]
        assert len(bar["examples"]) == 4 and [e["value"] for e in bar["examples"][:2]] == ["refund", "other"], bar["examples"]
        assert "[[10|card:" in got["card_output"] and "#records/refund]]" in got["card_output"], got["card_output"]
        reg = json.load(open(os.path.join(d, ".thimble-cc-mod", "labels.json")))
        assert reg[0]["slug"] == "refund" and reg[0]["scope"] == "all" and reg[0]["rows"].endswith("labels/refund/rows.json"), reg
        ex = [e for e in got["examples"] if e["value"] == "refund"]
        assert ex and "money back" in ex[0]["text"], got["examples"]


def test_code_on_csv_and_errors() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        spec(d, "late", name="late", kind="code", definition="def label(u):\n    return ('late' if u['status'] == 'late' else 'on time', 1.0)",
             values=["late", "on time"], paths=["orders.csv"])
        got = run(d, "run", "late")
        assert got["counts"] == {"late": 3, "on time": 6} and not got["errors"], got
        spec(d, "bad", name="bad", kind="code", definition="def label(u):\n    return 'maybe'", values=["yes", "no"], paths=["orders.csv"])
        got = run(d, "run", "bad")
        assert got["labeled"] == 0 and "not one of" in got["errors"][0], got
        spec(d, "broken", name="broken", kind="regex", definition="(", values=["yes", "no"], paths=["orders.csv"])
        assert "does not compile" in run(d, "run", "broken")["error"]


def test_prompt_units_and_finish_with_verdicts() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        spec(d, "asks", name="asks for a refund", kind="prompt", definition="The customer asks for their money back.", values=["refund", "other"],
             paths=["tickets.jsonl"], field="body")
        # the analyst set one record by hand: it is not sent to the model, and teaches it
        with open(os.path.join(labels.folder(d, "asks"), "verdicts.json"), "w") as f:
            json.dump({"tickets.jsonl#L4": {"value": "refund"}}, f)
        u = run(d, "units", "asks", "--limit", "10")
        assert u["total"] == 40 and u["trial"] and len(u["units"]) == 10, u
        assert [x.get("set") for x in u["units"] if x["ref"] == "tickets.jsonl#L4"] in ([], ["refund"]), u
        assert u["examples"] and u["examples"][0]["value"] == "refund", u
        # a page at a time, every record once
        pages = [run(d, "units", "asks", "--per", "15", "--page", str(k)) for k in range(3)]
        assert pages[0]["pages"] == 3 and [len(p["units"]) for p in pages] == [15, 15, 10], [len(p["units"]) for p in pages]
        assert len({x["ref"] for p in pages for x in p["units"]}) == 40 and not pages[1]["examples"]
        rows = {x["ref"]: {"value": "refund" if "money" in x["text"] else "other", "confidence": 0.9, "rationale": "r"} for x in u["units"]}
        rows["tickets.jsonl#L4"] = {"value": "other", "confidence": 0.5, "rationale": "the model's"}
        with open(os.path.join(labels.folder(d, "asks"), "rows.prompt.json"), "w") as f:
            json.dump({"rows": rows, "total": 40, "trial": True}, f)
        got = run(d, "finish", "asks")
        assert got["labeled"] == len(rows), got
        kept = labels.load_rows(d, "asks")
        assert kept["tickets.jsonl#L4"]["value"] == "refund" and kept["tickets.jsonl#L4"]["analyst"], kept["tickets.jsonl#L4"]


def test_verdict_updates_counts_and_views() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        spec(d, "refund", name="refund", kind="regex", definition="money back", values=["refund", "other"], paths=["tickets.jsonl"], field="body")
        run(d, "run", "refund")
        got = run(d, "verdict", "refund", "tickets.jsonl#L1", "refund")
        assert got["counts"] == {"refund": 11, "other": 29}, got
        # a later run keeps the analyst's value
        assert run(d, "run", "refund")["counts"] == {"refund": 11, "other": 29}
        # the views read the rows, not the regex, so they show the analyst's value too
        import viewhost  # noqa: PLC0415
        reg = json.load(open(os.path.join(d, ".thimble-cc-mod", "labels.json")))
        ctx = viewhost.Labels(reg, d, None)
        dfn = ctx.defs["refund"]
        assert ctx.value(dfn, "tickets.jsonl#L1") == "refund" and ctx.value(dfn, "tickets.jsonl#L2") == "other"
        assert ctx.value(dfn, "orders.csv#row=1") is None


def test_verdict_keeps_examples_and_agreement() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        spec(d, "refund", name="refund", kind="regex", definition="money back", values=["refund", "other"], paths=["tickets.jsonl"], field="body")
        first = run(d, "run", "refund")
        shown = [e["ref"] for e in first["examples"]]
        # disagreeing with an "other" record flips it; the examples stay the same records, in the same order
        other = next(e["ref"] for e in first["examples"] if e["value"] == "other")
        got = run(d, "verdict", "refund", other, "refund")
        assert [e["ref"] for e in got["examples"]] == shown, (shown, got["examples"])
        flipped = next(e for e in got["examples"] if e["ref"] == other)
        assert flipped["value"] == "refund" and flipped["analyst"] and flipped["was"] == "other", flipped
        # agreeing keeps the value and says so; no value changed, so the cards that read the label stay current
        agreed = next(e["ref"] for e in first["examples"] if e["value"] == "refund")
        reg = lambda: json.load(open(os.path.join(d, ".thimble-cc-mod", "labels.json")))[0]  # noqa: E731
        was = reg()["updated"]
        got = run(d, "verdict", "refund", agreed, "refund")
        assert reg()["updated"] == was, (reg(), was)
        ok = next(e for e in got["examples"] if e["ref"] == agreed)
        assert ok["value"] == "refund" and ok["analyst"] and ok["was"] == "refund", ok
        card = json.load(open(os.path.join(d, ".thimble-cc-mod", "cards", f"{got['cards'][0]}.json")))
        assert [e["ref"] for e in card["examples"]] == shown[:4] and any(e["set"] and e["was"] == "other" for e in card["examples"]), card["examples"]
        # changing one's mind again keeps the value the label gave first
        got = run(d, "verdict", "refund", other, "other")
        again = next(e for e in got["examples"] if e["ref"] == other)
        assert again["value"] == "other" and again["was"] == "other", again
        # a new run picks examples again, records the analyst has not judged first
        fresh = run(d, "run", "refund")
        assert not any(e["analyst"] for e in fresh["examples"]), fresh["examples"]


def test_mojibake_shown_as_written() -> None:
    from refs import demojibake  # noqa: PLC0415
    assert demojibake("jedoch mÃ¶chten wir, eintrÃ¤gst") == "jedoch möchten wir, einträgst"
    assert demojibake("itâ€™s â€œfineâ€\x9d") == "it’s “fine”"
    # text that reads right, or a run that is not one UTF-8 character, is kept
    for s in ("NÃO São Paulo café naïve", "Ã¶Â", "plain"):
        assert demojibake(s) == s.replace("Ã¶Â", "öÂ"), s
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "wiki.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"body": "Lieber Besucher, mÃ¶chten wir"}, ensure_ascii=False) + "\n")
        spec(d, "w", name="w", kind="regex", definition="Besucher", values=["yes", "no"], paths=["wiki.jsonl"], field="body")
        got = run(d, "run", "w")
        assert got["examples"][0]["text"] == "Lieber Besucher, möchten wir", got["examples"]


def test_card_script_reads_a_label() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        spec(d, "refund", name="asks for a refund", kind="regex", definition="money back", values=["refund", "other"], paths=["tickets.jsonl"], field="body")
        run(d, "run", "refund")
        os.makedirs(os.path.join(d, ".thimble-cc-mod", "scripts"), exist_ok=True)
        script = os.path.join(d, ".thimble-cc-mod", "scripts", "by.py")
        with open(script, "w") as f:
            f.write(f"""import sys; sys.path.insert(0, {HELPER!r}); from tcard import card, label
by = label("Asks for a refund")
card("example", "Which tickets ask for a refund?", examples=[{{"ref": "tickets.jsonl#L4", "note": by["tickets.jsonl#L4"]}}])
card("bar", "How many tickets of each kind?", rows=[("refund", 10), ("other", 30)])
""")
        r = subprocess.run([sys.executable, script], cwd=d, capture_output=True, text=True, env={**os.environ, "THIMBLE_CC_MOD_ROOT": d})
        assert r.returncode == 0, r.stderr
        cards = [json.load(open(os.path.join(d, ".thimble-cc-mod", "cards", n))) for n in os.listdir(os.path.join(d, ".thimble-cc-mod", "cards"))]
        ex = next(c for c in cards if c["kind"] == "example")
        assert ex["labels"] == [{"slug": "refund", "name": "asks for a refund", "values": ["refund", "other"], "marks": {"tickets.jsonl#L4": "refund"}}], ex["labels"]
        bar = next(c for c in cards if c["kind"] == "bar")
        assert bar["labels"] == [{"slug": "refund", "name": "asks for a refund", "values": ["refund", "other"]}], bar["labels"]
        bad = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {HELPER!r}); from tcard import label; label('nope')"],
                             cwd=d, capture_output=True, text=True, env={**os.environ, "THIMBLE_CC_MOD_ROOT": d})
        assert bad.returncode == 1 and "no label 'nope' in this folder (labels: 'asks for a refund')" in bad.stderr, bad.stderr


def test_within_narrows() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        spec(d, "refund", name="refund", kind="regex", definition="money back", values=["refund", "other"], paths=["tickets.jsonl"], field="body")
        run(d, "run", "refund")
        spec(d, "charger", name="charger", kind="regex", definition="charger", values=["charger", "other"], paths=["tickets.jsonl"],
             field="body", within={"label": "refund"})
        got = run(d, "run", "charger")
        assert got["total"] == 10 and got["counts"]["charger"] == 10, got


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
