"""A takeaway's citation of a number the card's code types in rather than computes (cite.typed_citations, verify.py,
card_check.py). Matt (2026-10-08): a diagram card's takeaway cited 14,591 at a node label the code typed as
"revisions.jsonl: 14,591 saves", and the links check passed, while the same card printed len(R) = 14591 on another line.
Cards are written to disk with handmade outputs, no kernel and no model."""
from __future__ import annotations

import pytest

from app import card_check, cite, config, notebook, verify

CORPUS = "mini"
LOAD = 'import json\nimport thimble\nR = [json.loads(line) for line in open("revisions.jsonl")]\n'
PRINT = 'print("len(R) =", len(R))\n'
TYPED = 'thimble.diagram(edges=[("revisions.jsonl: 14,591 saves", "pages.jsonl: 312 pages", "edits")])\n'
COMPUTED = 'thimble.diagram(edges=[(f"revisions.jsonl: {len(R):,} saves", "pages.jsonl: 312 pages", "edits")])\n'


def drawn(edges: list) -> dict:
    """The bundle thimble.diagram shows for `edges` (kernel_thimble.diagram, its display caught)."""
    from app import kernel_thimble

    shown: list[dict] = []
    real = kernel_thimble._show
    kernel_thimble._show = shown.append
    try:
        kernel_thimble.diagram(edges=edges)
    finally:
        kernel_thimble._show = real
    return shown[0]


EDGE = [("revisions.jsonl: 14,591 saves", "pages.jsonl: 312 pages", "edits")]
PRINTED = {"_stream": "stdout", "text/plain": "len(R) = 14591\n"}


def card(code: str, outputs: list[dict], takeaway: str) -> dict:
    """A card that ran `code` clean and showed `outputs`, with `takeaway` stored as add_card stores one (its `SELF` the
    card's id), the verification hook run: the card as the notebook holds it."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Exploration", role="exploration")
    cell = notebook.new_cell("diagram", "run", "How many saves does revisions.jsonl hold?", nb["id"], code=code)
    cell.update(status="ok", exec_count=1, outputs=outputs)
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    assert notebook.append_takeaway(CORPUS, cell["id"], takeaway.replace("SELF", cell["id"]), overwrite=True,
                                    author="model")
    return notebook.get_cell(CORPUS, cell["id"])


def test_the_literals_of_a_cards_code_are_its_numbers_and_strings_never_a_comment_or_a_setting():
    code = (LOAD + "# 14591 rows\n" + PRINT + TYPED + "fig, ax = plt.subplots(figsize=(10, 6)); ax.set_ylim(0, 100)\n"
            "big = [r for r in R if r['size'] > 20.]\nlabel = f\"{len(R):,} saves, about 14.6k {{x}} {len(R):>100}\"\n"
            "chart = chart.properties(width=600)\nshare = n * 100\nrows = [14591, 13403, 12]\nnote = 'line\\n14,591 more'\n")
    got = [(lit.text, lit.line, lit.window) for lit in cite.code_literals(code)]
    assert got == [("14,591", 6, "ions.jsonl: 14,591 saves"), ("312", 6, "ages.jsonl: 312 pages"), ("20.", 8, ""),
                   ("14.6k", 9, "aves, about 14.6k {x}"), ("14591", 12, ""), ("13403", 12, ""), ("14,591", 13, "14,591 more")]
    assert cite.code_literals("!wc -l revisions.jsonl\n" + TYPED)[0].line == 2, "an IPython line keeps the numbering"
    assert cite.code_literals("def broken(:\n") == []
    # a number in the takeaway's form, against a literal's
    assert cite.same_number("14,591", "14591") and cite.same_number("14.6k", "14591") and cite.same_number("91%", "91.2%")
    assert not cite.same_number("14,591", "14.6k") and not cite.same_number("6,500", "6,543")


def test_a_citation_of_a_typed_label_moves_to_the_value_the_card_printed(workspaces_tmp):
    """Matt's card: the takeaway cites 14,591 at the diagram's label, typed in the code, and the card printed len(R) on
    its first output. The citation moves there, and is linked, with the typed place kept as where it was cited."""
    cell = card(LOAD + PRINT + TYPED, [PRINTED, drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out1#L2]] saves.")
    cid = cell["id"]
    assert cell["takeaway"] == f"revisions.jsonl holds [[14,591|card:{cid}@out0#L1]] saves."
    links = cell["verification"]["links"]
    assert links["typed"] == [] and links["status"] == "ok"
    assert links["resolved"] == [{"value": "14,591", "ref": f"card:{cid}@out0#L1", "tier": 2, "how": cite.COMPUTED,
                                  "from": f"card:{cid}@out1#L2"}]


def test_a_citation_of_a_typed_label_with_no_computed_place_is_typed_with_its_line(workspaces_tmp):
    """The same card without the print: nothing on it computes 14,591, so the citation stays where it is and is typed,
    with the line of the code that types it, and the links check counts it as a problem."""
    cell = card(LOAD + TYPED, [drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out0#L2]] saves.")
    cid = cell["id"]
    assert cell["takeaway"] == f"revisions.jsonl holds [[14,591|card:{cid}@out0#L2]] saves."
    links = cell["verification"]["links"]
    assert links["typed"] == [{"value": "14,591", "ref": f"card:{cid}@out0#L2", "line": 4,
                               "why": "typed in the code, line 4, not computed"}]
    assert links["resolved"] == [] and links["status"] == "unresolved"
    # a number the takeaway leaves plain, linked to the one place that shows it, is typed the same way
    cell = card(LOAD + TYPED, [drawn(EDGE)], "revisions.jsonl holds 14,591 saves.")
    assert [t["ref"] for t in cell["verification"]["links"]["typed"]] == [f"card:{cell['id']}@out0#L2"]


def test_a_label_built_from_a_computed_value_is_linked(workspaces_tmp):
    """The label as an f-string of len(R): the code writes no 14,591, so the citation is linked where it is."""
    cell = card(LOAD + COMPUTED, [drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out0#L2]] saves.")
    links = cell["verification"]["links"]
    assert links["typed"] == [] and links["status"] == "ok"
    assert links["resolved"] == [{"value": "14,591", "ref": f"card:{cell['id']}@out0#L2", "tier": 2}]


def test_a_threshold_the_takeaway_does_not_cite_changes_nothing(workspaces_tmp):
    """A literal that is a threshold or a parameter matters only when it equals a cited value: the record is the one
    the card without it gets."""
    takeaway = "revisions.jsonl holds [[14,591|card:SELF@out0#L1]] saves."
    plain = card(LOAD + PRINT + COMPUTED, [PRINTED, drawn(EDGE)], takeaway)
    gated = card(LOAD + "big = [r for r in R if r['size'] > 1000.]\nR = R[:20000]\n" + PRINT + COMPUTED,
                 [PRINTED, drawn(EDGE)], takeaway)
    strip = lambda c: (c["takeaway"].replace(c["id"], "X"), str(c["verification"]["links"]).replace(c["id"], "X"))  # noqa: E731
    assert strip(plain) == strip(gated)
    # cited, the threshold is a typed value like any other
    cell = card(LOAD + "big = [r for r in R if r['size'] > 1000.]\nprint('over', 1000., 'bytes:', len(big))\n",
                [{"_stream": "stdout", "text/plain": "over 1000.0 bytes: 52\n"}], "Saves over [[1,000|card:SELF@out0#L1]] bytes.")
    assert [t["line"] for t in cell["verification"]["links"]["typed"]] == [4]


async def test_the_links_job_moves_or_types_as_the_hook_does(workspaces_tmp, monkeypatch):
    """The links job (healing first, then the typed pass over every card the takeaway cites) leaves the record the
    hook left: Matt's citation moved to the printed value, kept there on a later run, or typed without the print."""
    cell = card(LOAD + PRINT + TYPED, [PRINTED, drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out1#L2]] saves.")
    cid = cell["id"]
    await verify._links_job(CORPUS, cid, verify._links_version(notebook.get_cell(CORPUS, cid)))
    after = notebook.get_cell(CORPUS, cid)
    assert after["takeaway"] == f"revisions.jsonl holds [[14,591|card:{cid}@out0#L1]] saves."
    links = after["verification"]["links"]
    assert links["status"] == "ok" and links["typed"] == [] and links["checked"]
    assert links["resolved"] == [{"value": "14,591", "ref": f"card:{cid}@out0#L1", "tier": 2, "how": cite.COMPUTED,
                                  "from": f"card:{cid}@out1#L2"}]
    cell = card(LOAD + TYPED, [drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out0#L2]] saves.")
    await verify._links_job(CORPUS, cell["id"], verify._links_version(notebook.get_cell(CORPUS, cell["id"])))
    links = notebook.get_cell(CORPUS, cell["id"])["verification"]["links"]
    assert links["status"] == "unresolved" and links["resolved"] == []
    assert [(t["value"], t["line"]) for t in links["typed"]] == [("14,591", 4)]


async def test_the_card_check_reads_a_typed_link_and_a_rule_to_compute_it(workspaces_tmp, monkeypatch):
    """The card check's "What each link resolves to" names the typed link and its line, and its instructions say to
    compute such a number in the replacement's code."""
    cell = card(LOAD + TYPED, [drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out0#L2]] saves.")
    cid = cell["id"]
    text = card_check._citations_text(CORPUS, cell)
    assert text.startswith(f"- card:{cid}@out0#L2, 14,591 typed in the code, line 4, not computed: diagram: 2 nodes")
    seen: dict[str, str] = {}

    async def call(c, system, user, tool, images, *, effort, model=None):
        seen.update(system=system, user=user)

    monkeypatch.setattr(card_check, "_call", call)
    await card_check.check_task(CORPUS, {"card": {"id": cid, "kind": "diagram", "question": cell["title"],
                                                  "takeaway": cell["takeaway"], "citations": text, "code": cell["code"]},
                                         "effort": "low"})
    assert "typed in the code, line 4, not computed" in seen["user"].split("What each link resolves to", 1)[1]
    assert 'f"revisions.jsonl: {len(R):,} saves"' in seen["system"]
    # a linked card's citations say nothing of the kind
    ok = card(LOAD + COMPUTED, [drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out0#L2]] saves.")
    assert "typed" not in card_check._citations_text(CORPUS, ok)


@pytest.mark.parametrize("failed, code_changed, applied", [([], True, True), ([], False, False), (["The question is vague."], True, True)])
def test_a_typed_link_is_a_problem_the_check_may_fix_by_changing_the_code(workspaces_tmp, failed, code_changed, applied):
    """A card that meets every criterion stays as it is, unless the links check found a typed link and the
    replacement's code changes: then the replacement is applied, the typed link its reason when no criterion failed."""
    cell = card(LOAD + TYPED, [drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out0#L2]] saves.")
    patch = {"code": LOAD + COMPUTED} if code_changed else {"title": "How many saves?"}
    got = card_check._problems(cell, failed, patch)
    assert bool(got) == applied
    if applied and not failed:
        assert got == ["The card shows 14,591 typed in its code, line 4, not computed."]
    if failed:
        assert got[0] == failed[0]
