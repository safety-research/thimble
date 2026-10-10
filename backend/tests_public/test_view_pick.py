"""Views round 5, pipeline 5 (exploration): pick_views keeps two of about eight concepts (app/view_pick.py). One model call
reads prompts/view-pick.md with the concepts in an order shuffled by their names; the tool answers with the two kept in
main's own numbering, each with its reason, and keeps every call in the workspace's views/picks.json. No model is
called here: model.structured is faked."""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import model, tools, view_pick

CORPUS = "mini"
REPO = Path(__file__).resolve().parents[2]
CONCEPTS = [{"name": f"Form {k}", "concept": f"Concept {k}: one mark per thread, position the reply count."} for k in "ABCDEFGH"]


def prompts_with_picker(tmp_path: Path) -> Path:
    """A copy of the tree's prompts with a picker prompt and tools.md's `## pick_views` section, which a tree whose
    prompts have them already keeps as they are."""
    d = tmp_path / "prompts"
    shutil.copytree(REPO / "prompts", d)
    if not (d / "view-pick.md").is_file():
        (d / "view-pick.md").write_text("Keep two.\n\n{{concepts}}\n", "utf-8")
    text = (d / "tools.md").read_text("utf-8")
    if "## pick_views\n" not in text:
        section = ('## pick_views\n\nPick two.\n\n```json\n{"type": "object", "properties": {\n  "concepts": '
                   '{"type": "array", "items": {"type": "object"}}\n}, "required": ["concepts"]}\n```\n\n')
        (d / "tools.md").write_text(text.replace("## write_document\n", section + "## write_document\n"), "utf-8")
    return d


def test_the_concepts_are_checked_and_read_in_one_shuffled_order():
    ok, problem = view_pick.check({"concepts": CONCEPTS})
    assert problem is None and ok == CONCEPTS
    assert view_pick.check({"concepts": json.dumps(CONCEPTS)})[0] == CONCEPTS, "a list sent as JSON text"
    assert "not 2" in view_pick.check({"concepts": CONCEPTS[:2]})[1]
    assert "concept 3 has no concept" in view_pick.check({"concepts": [*CONCEPTS[:2], {"name": "X"}, *CONCEPTS[3:]]})[1]
    order = view_pick.shuffled(CONCEPTS)
    assert sorted(order) == list(range(8)) and order == view_pick.shuffled(CONCEPTS) and order != list(range(8))
    assert view_pick.listing(CONCEPTS[:2]).startswith("1. Form A\nConcept A:")


async def test_the_tool_answers_the_two_kept_in_main_s_numbering_and_keeps_the_call(tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(prompts_with_picker(tmp_path)))
    seen: list[str] = []

    async def fake(prompt, **kw):
        seen.append(prompt)
        return SimpleNamespace(status="ok", output={"keep": [1, 2], "why": ["a floor plan", "a ranked list"]},
                               model_used="claude-opus-5-5", cost_usd=0.01, detail=None)

    monkeypatch.setattr(model, "structured", fake)
    assert "pick_views" in [t["name"] for t in tools.list(tools.ANALYST)]
    res = await tools.call(CORPUS, "pick_views", {"concepts": CONCEPTS}, actor=tools.ANALYST)
    assert not res.is_error, res.text
    order = view_pick.shuffled(CONCEPTS)
    kept = json.loads(res.text.split("\n", 1)[1])["kept"]  # after the call line
    assert [k["n"] for k in kept] == [order[0] + 1, order[1] + 1], "the picker's numbers, as main numbered them"
    assert [k["name"] for k in kept] == [CONCEPTS[order[0]]["name"], CONCEPTS[order[1]]["name"]]
    assert [k["why"] for k in kept] == ["a floor plan", "a ranked list"]
    assert f"1. {CONCEPTS[order[0]]['name']}" in seen[0]
    rows = json.loads(view_pick.picks_path(CORPUS).read_text("utf-8"))
    assert rows[-1]["kept"] == kept and rows[-1]["order"] == [i + 1 for i in order]


async def test_a_picker_that_keeps_no_two_concepts_is_an_error_the_call_still_kept(tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(prompts_with_picker(tmp_path)))

    async def fake(prompt, **kw):
        return SimpleNamespace(status="ok", output={"keep": [3, 3], "why": ["", ""]}, model_used="m", cost_usd=0.0,
                               detail=None)

    monkeypatch.setattr(model, "structured", fake)
    res = await tools.call(CORPUS, "pick_views", {"concepts": CONCEPTS}, actor=tools.ANALYST)
    assert res.is_error and "gave no two concepts" in res.text
    assert "kept" not in json.loads(view_pick.picks_path(CORPUS).read_text("utf-8"))[-1]


@pytest.mark.parametrize("args", [{}, {"concepts": "not json"}, {"concepts": [1, 2, 3]}])
async def test_bad_concepts_never_reach_the_picker(args, tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(prompts_with_picker(tmp_path)))

    async def never(prompt, **kw):
        raise AssertionError("the picker ran")

    monkeypatch.setattr(model, "structured", never)
    res = await tools.call(CORPUS, "pick_views", args, actor=tools.ANALYST)
    assert res.is_error and "pick_views:" in res.text
