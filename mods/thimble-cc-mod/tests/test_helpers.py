"""Tests of the Python helpers: `python3 tests/test_helpers.py` (no dependencies)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")
sys.path.insert(0, HELPER)
from refs import resolve, resolve_many, shown_matches, value_in  # noqa: E402


def test_numbers() -> None:
    assert value_in("3,908", "pages = 3908")
    assert value_in("91%", "rate = 91.2%")
    assert not value_in("6,500", "peak = 6543")
    assert shown_matches("2.5", "2.45")


def test_lines_quotes_and_link_words() -> None:
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "ev.jsonl"), "w") as f:
            f.write('{"note": "Seite gelöscht.", "n": 7}\n')
        assert resolve(d, "ev.jsonl#L1", "7")["status"] == "ok"
        assert resolve(d, "ev.jsonl#L1", "8")["status"] == "differs"
        assert resolve(d, "ev.jsonl#L1", '"Seite gelöscht."')["status"] == "ok"
        assert resolve(d, "ev.jsonl#L1", '"Seite weg"')["status"] == "differs"
        assert resolve(d, "ev.jsonl#L1", "this record")["status"] == "unchecked"
        assert resolve(d, "ev.jsonl#L2", None)["status"] == "missing"
        assert resolve(d, "nope.jsonl#L1", None)["status"] == "missing"


def test_quote_with_escaped_inner_quotes() -> None:
    # a quoted line of code whose inner quote marks the writer escaped is the line as the output shows it
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".thimble-cc-mod", "calls"))
        with open(os.path.join(d, ".thimble-cc-mod", "calls", "c1.json"), "w") as f:
            json.dump({"id": "c1", "command": "grep -n dse s.py", "output": 'counts = {}\n6:    counts["dse"] += 100'}, f)
        assert resolve(d, "call:c1#L2", '"counts[\\"dse\\"] += 100"')["status"] == "ok"
        assert resolve(d, "call:c1#L2", '"counts["dse"] += 100"')["status"] == "ok"
        assert resolve(d, "call:c1#L2", '"counts[\\"wiki\\"] += 100"')["status"] == "differs"


def test_long_record_shows_every_field() -> None:
    with tempfile.TemporaryDirectory() as d:
        body = " ".join(f"word{i}?" for i in range(900))
        with open(os.path.join(d, "r.jsonl"), "w") as f:
            f.write(json.dumps({"body": body, "label": "AgentX", "time": "2026-06-18T19:59:28Z"}) + "\n")
        quoted, linked, example = resolve_many(d, [
            {"id": "a", "ref": "r.jsonl#L1", "display": '"AgentX"'},
            {"id": "b", "ref": "r.jsonl#L1", "display": "this save"},
            {"id": "c", "ref": "r.jsonl#L1", "display": None, "quote": "word700?"},
        ])
        for r in (quoted, linked, example):
            text = r["window"][0]["text"]
            assert len(text) < 700 and '"label": "AgentX"' in text and '"time": "2026-06-18T19:59:28Z"' in text
        for r, words in ((quoted, "AgentX"), (example, "word700?")):
            [[s, e]] = r["window"][0]["spans"]
            assert r["window"][0]["text"][s:e] == words


def test_card_params_and_single_card_rerun() -> None:
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".thimble-cc-mod", "scripts"))
        script = os.path.join(d, ".thimble-cc-mod", "scripts", "by.py")
        with open(script, "w") as f:
            f.write(
                f"import sys; sys.path.insert(0, {HELPER!r}); from tcard import card, param\n"
                "by = param('by', 'wiki', ['wiki', 'label'])\n"
                "rows = [('dse', 3), ('probier', 1)] if by == 'wiki' else [('Agent', 2)]\n"
                "card('bar', 'How many revisions per group?', rows=rows, y='revisions', total=True)\n"
                "card('table', 'Totals', columns=['what', 'n'], rows=[['all', 4]])\n"
            )
        run = lambda env: subprocess.run([sys.executable, script], cwd=d, env={**os.environ, **env}, capture_output=True, text=True, check=True)  # noqa: E731
        out = run({}).stdout
        assert "[[3|card:" in out and "controls on the card: by = wiki" in out
        cards = sorted(os.listdir(os.path.join(d, ".thimble-cc-mod", "cards")))
        assert len(cards) == 2
        run({"THIMBLE_CC_MOD_PARAMS": json.dumps({"by": "label"}), "THIMBLE_CC_MOD_ONLY": "0:keep01"})
        with open(os.path.join(d, ".thimble-cc-mod", "cards", "keep01.json")) as f:
            c = json.load(f)
        assert [r["label"] for r in c["rows"]] == ["Agent"] and c["params"][0]["value"] == "label"
        assert c["source"]["index"] == 0
        assert len(os.listdir(os.path.join(d, ".thimble-cc-mod", "cards"))) == 3  # the table was not written again


def test_example_quotes_are_checked() -> None:
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "r.jsonl"), "w") as f:
            f.write('{"body": "rv vandalism"}\n')
        cwd = os.getcwd()
        os.chdir(d)
        try:
            from tcard import card
            card("example", "How does a revert read?", examples=[{"ref": "r.jsonl#L1", "field": "body", "quote": "rv"}])
            try:
                card("example", "Bad quote", examples=[{"ref": "r.jsonl#L1", "field": "body", "quote": "not there"}])
            except ValueError as err:
                assert "not in the record" in str(err)
            else:
                raise AssertionError("a quote that is not in the record was accepted")
        finally:
            os.chdir(cwd)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
