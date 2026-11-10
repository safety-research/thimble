"""A label sorts the records of files or the report's sentences, never the cards of the canvas (thimble 1.0): main's
apply_label takes no canvas scope and its text names none, set_filter puts no label on the canvas while the canvas keeps
its card filter, and a label over cards that an older thimble left in a workspace is no label: the Labels list, the
tools, a card's code and the canvas's filter leave it out, and its files stay. The workspace is the suite's made-up mini
corpus."""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app import concepts, config, kernel_thimble, tools

CORPUS = "mini"


def _ws():
    return config.workspace_dir(CORPUS)


def _files_label() -> dict:
    k = concepts.new_concept("claims a PR", kind="regex", spec="(?i)forge pr claim")
    concepts.write_concept(_ws(), k)
    return k


async def test_apply_label_labels_records_of_files_or_report_sentences_not_cards(workspaces_tmp):
    desc, schema = tools.tool_sections(("apply_label",))["apply_label"]
    scope = schema["properties"]["scope"]
    assert scope["enum"] == ["files", "report"] and "card" not in scope["description"], scope
    assert "A card is a dict" not in schema["properties"]["predicate"]["properties"]["kind"]["description"]
    r = await tools.call(CORPUS, "apply_label", {"scope": "canvas", "name": "shows a failure",
                                                 "predicate": {"kind": "regex", "text": "(?i)fail"}})
    assert r.is_error and "`scope` must be one of files, report" in r.text, r.text
    assert concepts.find_concept(_ws(), "shows a failure") is None  # nothing was defined


async def test_set_filter_puts_no_label_on_the_canvas_which_keeps_its_card_filter(workspaces_tmp):
    desc = tools.tool_sections(("set_filter",))["set_filter"][0]
    assert desc.startswith("Filter the records in Files or the report's sentences by a value of a label that exists, "
                           "and the cards by their kind, group, maker"), desc
    k = _files_label()
    r = await tools.call(CORPUS, "set_filter", {"scope": "canvas", "label": "claims a PR", "value": "yes"})
    assert r.is_error and "a label filters the records in Files or the report's sentences" in r.text, r.text
    with pytest.raises(HTTPException):
        concepts.set_filter(CORPUS, "canvas", k["id"], "yes")
    assert concepts.read_filters(_ws()) == {}
    r = await tools.call(CORPUS, "set_filter", {"scope": "canvas", "starred": True})
    assert not r.is_error, r.text
    assert concepts.read_filters(_ws()) == {"canvas": {"starred": True}}


def test_a_label_over_cards_an_older_thimble_left_is_no_label(workspaces_tmp):
    ws = _ws()
    _files_label()
    old = {"id": "kcards", "name": "shows a failure", "unit": "cell", "kind": "prompt", "spec": "The card shows a failure.",
           "labels": ["yes", "no"], "ts": "2026-10-01T00:00:00+00:00"}
    concepts._concept_file(ws, "kcards").write_text(json.dumps(old))
    concepts.filters_file(ws).write_text(json.dumps({"canvas": {"concept": "kcards", "value": "yes", "starred": True}}))
    assert [k["name"] for k in concepts.list_concepts(ws)] == ["claims a PR"]
    assert concepts.read_concept(ws, "kcards") is None and concepts.find_concept(ws, "shows a failure") is None
    assert [k["name"] for k in kernel_thimble._concepts(ws)] == ["claims a PR"]
    # the canvas keeps the card part of its filter, and no label
    assert concepts.read_filters(ws) == {"canvas": {"starred": True}}
    assert concepts._concept_file(ws, "kcards").is_file()  # its files stay as they were
