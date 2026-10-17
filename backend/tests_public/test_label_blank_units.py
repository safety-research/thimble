"""A prompt label over a markdown transcript's lines (bug hunt B21): the blank lines between turns need no label, so the
run skips them quietly, without a notice, and the tool's result says once how many it skipped; and when units do fail,
the notice says each reason once, after how many units it failed, so the counts add up to the units that failed.

Called through tools.call as a browser chat running as the analyst, over a copy of `mini` with a markdown file added.
The classifier is scripted at concepts.classify_structured."""
from __future__ import annotations

import pytest

from app import concepts, config, notebook, notices, tools
from app import call_result as model_mod

CORPUS = "mini"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, data_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    tools._last_cell.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    await notebook.shutdown_all()


class Classify:
    """Scripted concepts.classify_structured: a call over a text with `boom` fails as overloaded, each with its own
    request id; one over `mute` answers with no labels; any other gets `yes` when it says `confused`."""

    def __init__(self):
        self.items: list[tuple[str, str]] = []

    async def __call__(self, c, concept, items, comment=True, on_retry=None):
        self.items += items
        if any("boom" in t for _r, t in items):
            return model_mod.CallResult(status="overloaded", detail=f"Overloaded (request req_{len(self.items)})", attempts=1)
        if any("mute" in t for _r, t in items):
            return model_mod.CallResult(status="ok", output={"labels": []}, attempts=1)
        labels = [{"i": n, "label": "yes" if "confused" in t else "no", "confidence": 0.9} for n, (_r, t) in enumerate(items, 1)]
        return model_mod.CallResult(status="ok", output={"labels": labels}, attempts=1)


@pytest.fixture()
def classify(monkeypatch) -> Classify:
    fake = Classify()
    monkeypatch.setattr(concepts, "classify_structured", fake)
    return fake


def write(data_tmp, name: str, lines: list[str]) -> None:
    (data_tmp / CORPUS / "talk").mkdir(exist_ok=True)
    (data_tmp / CORPUS / "talk" / name).write_text("\n".join(lines) + "\n")


async def apply(name: str, glob: str) -> str:
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "paths": [glob], "name": name,
                                                 "predicate": {"kind": "prompt", "text": "The speaker is confused."}},
                         actor="analyst", notebook=None, terminal=False)
    assert not r.is_error, r.text
    return r.text


def label(name: str) -> dict:
    k = concepts.find_concept(config.workspace_dir(CORPUS), name)
    assert k is not None
    return k


def notice(name: str) -> dict | None:
    key = f"label:{label(name)['id']}"
    return next((n for n in notices.open_notices(CORPUS) if n.get("key") == key), None)


async def test_blank_lines_are_skipped_quietly_and_said_once(data_tmp, classify):
    write(data_tmp, "p1.md", ["# P1 session", "", "**00:00:01**", "", "**P1:** wait, I'm confused", "",
                              "**Researcher:** okay", ""])
    text = await apply("confused", "talk/*.md")
    assert classify.items and all(t.strip() for _r, t in classify.items), "no call is asked about a blank line"
    run = label("confused")["applications"][-1]
    assert run["labeled"] == 4 and run["failed"] == 0 and run["skipped"] == 4, run
    assert "failed" not in text and "no readable text" not in text, text
    assert text.count("It skipped 4 blank record(s).") == 1, text
    assert notice("confused") is None, "a blank line is no failure"


async def test_failures_say_each_reason_once_with_counts_that_add_up(data_tmp, classify, monkeypatch):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)  # a call per line, so three calls fail as overloaded
    write(data_tmp, "p2.md", ["boom one", "", "boom two", "mute one", "boom three", "", "mute two", "fine"])
    text = await apply("confused", "talk/*.md")
    run = label("confused")["applications"][-1]
    assert run["failed"] == 5 and run["labeled"] == 1 and run["skipped"] == 2, run
    said = notice("confused")
    assert said is not None
    words = said["text"]
    assert words.startswith("The label confused couldn't label 5 of 8 records: "), words
    assert "3 because " in words and "2 because " in words, words
    assert words.lower().count("overloaded") == 1 and words.count("no usable labels") == 1, words
    assert "no readable text" not in words and "req_" not in words, words
    # the tool's result says each reason once too, with its count
    failed = text[text.index("5 record(s) failed:"):]
    assert failed.count("overloaded:") == 1 and "(3)" in failed and "(2)" in failed, text
