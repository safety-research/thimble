"""report_format.py: the writer's markdown into sentence records and back, the report's roles and takeaway links, the
figures of a section. No model call anywhere."""
from __future__ import annotations

import re

import pytest

from app import report, report_format, report_types
from app.report_format import assign_roles, link_takeaways, segment_body

CORPUS = "mini"


def flat(body: str) -> list[str]:
    return [s for para in segment_body(body) for s in para]


# --------------------------------------------------------------------------- segmentation


def test_a_paragraph_splits_into_its_sentences_and_question_and_exclamation_marks_split_too():
    assert segment_body("One thing. Another thing! A third? The last.") == [["One thing.", "Another thing!", "A third?", "The last."]]


def test_abbreviations_numbers_and_lowercase_continuations_do_not_split():
    text = ("The first batch (e.g. the alpha rows) came early, i.e. before noon. It ran vs. the second, cf. the log. "
            "Approx. 1,019 rows took 3.5 s each, etc. The mean was 2.75. Fig. 3 shows it. Dr. Who and J. Smith agreed. "
            "The answer was no. The logs say so, see No. 4. it continued in lowercase. Done.")
    out = flat(text)
    assert out == [
        "The first batch (e.g. the alpha rows) came early, i.e. before noon.",
        "It ran vs. the second, cf. the log.",
        "Approx. 1,019 rows took 3.5 s each, etc. The mean was 2.75.",
        "Fig. 3 shows it.",
        "Dr. Who and J. Smith agreed.",
        "The answer was no.",
        "The logs say so, see No. 4. it continued in lowercase.",
        "Done.",
    ]
    assert all("3.5" not in s or "3.5 s" in s for s in out) and any("1,019" in s for s in out)


def test_a_closing_quote_or_parenthesis_after_the_period_still_splits():
    assert flat('He said "stop." Then it stopped (at once.) The end.') == ['He said "stop."', "Then it stopped (at once.)", "The end."]


def test_citations_are_never_split_and_a_citation_alone_is_a_sentence():
    text = ("There are [[38|card:abcd1234#count/alpha]] alpha rows. The line [[card:abcd1234@out0#L3-L5]] shows it. "
            "The record agents/agent-03.jsonl#L412 says so [[agents/agent-03.jsonl#L412]]. The mean [[3.5|card:abcd1234@out0#L3]] held.")
    out = flat(text)
    assert out == [
        "There are [[38|card:abcd1234#count/alpha]] alpha rows.",
        "The line [[card:abcd1234@out0#L3-L5]] shows it.",
        "The record agents/agent-03.jsonl#L412 says so [[agents/agent-03.jsonl#L412]].",
        "The mean [[3.5|card:abcd1234@out0#L3]] held.",
    ]
    assert flat("[[card:abcd1234]]") == ["[[card:abcd1234]]"]
    assert flat("A value of [[3.5|card:abcd1234]]. Next.") == ["A value of [[3.5|card:abcd1234]].", "Next."]


def test_a_bare_ref_after_the_full_stop_attaches_to_the_previous_sentence_and_a_value_ref_starts_the_next():
    text = "Agent-03 stopped after an admin action. [[card:abcd1234]] [[README.md#L1]] The next sentence starts here. [[3.5|card:abcd1234]] is the mean."
    assert flat(text) == [
        "Agent-03 stopped after an admin action. [[card:abcd1234]] [[README.md#L1]]",
        "The next sentence starts here.",
        "[[3.5|card:abcd1234]] is the mean.",
    ]
    # a trailing bare ref inside the same chunk stays with its sentence; a bare ref opening the body stays a sentence
    assert flat("[[card:abcd1234]] The cell shows it.") == ["[[card:abcd1234]] The cell shows it."]


def test_markdown_paragraphs_lists_emphasis_headings_and_fences():
    """Emphasis markers are stored as written; the frontend renders them."""
    body = ("First paragraph. Two sentences.\n\nSecond paragraph with **bold** and _under_ and `code` kept.\n\n"
            "- **First** item [[card:abcd1234]]\n- second item. With two sentences.\n  continued here.\n* third\n\n"
            "### A heading inside\n\n```py\nx = 1\n\ny = 2\n```\n\n| when | what |\n|---|---|\n| 09:12 | deploy |\n\n> quoted line. Second.\n\nLast paragraph.")
    out = segment_body(body)
    assert out == [
        ["First paragraph.", "Two sentences."],
        ["Second paragraph with **bold** and _under_ and `code` kept."],
        ["**First** item [[card:abcd1234]]", "second item. With two sentences. continued here.", "third"],  # one unit per item
        ["A heading inside"],
        ["```py x = 1 y = 2 ```"],
        ["when | what", "09:12 | deploy"],
        ["quoted line.", "Second."],
        ["Last paragraph."],
    ]
    assert segment_body("") == [] and segment_body("\n\n  \n") == []
    assert segment_body("Windows\r\nlines.\r\n\r\nNext.") == [["Windows lines."], ["Next."]]
    assert flat("The analyst kept this. [locked] And this. [locked]") == ["The analyst kept this.", "And this."]  # an echoed mark goes


def test_a_list_item_is_one_unit_with_its_marker_kept_apart_and_body_of_renders_the_list_again():
    """A bullet is the unit a slide, a beat or a section states one thing in, so a list item is
    one unit whole — never split into sentences — with the marker out of its text and kept as `bullet` (BULLET for -, *,
    +, •; NUMBER for 1. / 1)), and body_of renders the list again (numbered from one), ` [locked]` after a locked one."""
    body = "Lead in. Second.\n\n- **First** point [[card:abcd1234]]\n- Second point. Two sentences.\n  continued.\n* third\n\n1. one\n2) two\n\nTail."
    paras = report_format.segment_units(body)
    assert paras[0] == [{"text": "Lead in.", "bullet": None}, {"text": "Second.", "bullet": None}]
    assert paras[1] == [{"text": "**First** point [[card:abcd1234]]", "bullet": report_format.BULLET},
                        {"text": "Second point. Two sentences. continued.", "bullet": "-"}, {"text": "third", "bullet": "-"}]
    assert paras[2] == [{"text": "one", "bullet": report_format.NUMBER}, {"text": "two", "bullet": "1."}]
    assert paras[3] == [{"text": "Tail.", "bullet": None}]
    assert segment_body(body) == [[u["text"] for u in para] for para in paras]
    valid = _Valid({"abcd1234"}, {})
    used: set[str] = set()
    recs = report_format.sentence_units(body, valid, used)
    assert [r.get("bullet") for r in recs] == [None, None, "-", "-", "-", "1.", "1.", None]
    assert all(set(r) >= {"id", "text", "refs", "tags", "tag_notes"} and r["tags"] == [] and r["tag_notes"] == {} for r in recs)
    assert "bullet" not in recs[0] and recs[2]["refs"] == ["card:abcd1234"] and len({r["id"] for r in recs}) == 8 == len(used)
    rendered = report_format.body_of(recs, {recs[3]["id"], recs[7]["id"]})
    assert rendered == ("Lead in. Second.\n\n- **First** point [[card:abcd1234]]\n- Second point. Two sentences. continued. [locked]\n- third\n\n"
                        "1. one\n2. two\n\nTail. [locked]")
    assert segment_body(rendered) == segment_body(body)  # the round trip: body -> units -> body -> the same units, the mark stripped
    assert report_format.records_of(paras[1], valid, set(), section=None)[0]["section"] is None  # extra keys ride along
    assert report_format.body_of([]) == "" and report_format.body_of([{"id": "a", "text": "  "}]) == ""
    one = report_format.one_sentence("**Both** halves. [[card:abcd1234]] And more.", valid, set())
    assert one["text"] == "**Both** halves. [[card:abcd1234]] And more." and one["refs"] == ["card:abcd1234"] and "bullet" not in one
    assert report_format.one_sentence("- a bullet", valid, set())["text"] == "a bullet"
    assert report_format.one_sentence("", valid, set()) is None and report_format.one_sentence(None, valid, set()) is None
    assert report_format.sentence_units(["Para one.", "Para two."], valid, set())[1]["text"] == "Para two."  # a list body is joined


# A writer that sets each citation in backticks, as the page shows it: once with the chips read as their labels, once
# with the refs. Both are ONE sentence.
PASTED_LABELS = ("A note on checking: the line ranges quoted from the sample cards did not resolve as ranges, so I checked "
                 "the single lines I quote — `ticket-samples · line 15 of the 2nd output`, "
                 "`queue-lengths-by-hour · line 15 of the output`, … — and each resolves to the text shown here.")
PASTED_REFS = ("A note on checking: the line ranges quoted from the sample cards did not resolve as ranges, so I checked "
               "the single lines I quote — `[[card:a1b2c3d4@out1#L15]]`, "
               "`[[card:b2c3d4e5@out0#L15]]`, `[[card:c3d4e5f6@out0#L15]]`, `[[card:d4e5f6a7@out0#L22]]` — and each resolves "
               "to the text shown here.")


def test_a_citation_set_in_backticks_is_unwrapped_at_store_time():
    """A citation inside backticks is a citation, not code. `[[ref]]` is [[ref]]; a span
    holding only refs and what separates them is the refs; a span with other words stays code (the frontend renders the
    ref inside it as a ref); a code span without a ref is untouched."""
    unwrap = report_format.unwrap_code_refs
    assert unwrap("See `[[card:abcd1234]]` here.") == "See [[card:abcd1234]] here."
    assert unwrap("See `[[card:abcd1234]] [[README.md#L1]]` and `[[3|card:abcd1234@out0#L3]], [[card:abcd1234]]`.") == \
        "See [[card:abcd1234]] [[README.md#L1]] and [[3|card:abcd1234@out0#L3]], [[card:abcd1234]]."
    assert unwrap("Run `grep [[card:abcd1234]]` twice.") == "Run `grep [[card:abcd1234]]` twice."
    assert unwrap("The corpus is `tickets.db`.") == "The corpus is `tickets.db`."
    # through the store path: the sentence holds the refs bare, records_of extracts all four
    [para] = report_format.segment_units(PASTED_REFS)
    assert len(para) == 1 and "`" not in para[0]["text"]
    assert para[0]["text"].count("[[card:") == 4
    recs = report_format.records_of(para, _Valid({"a1b2c3d4", "b2c3d4e5", "c3d4e5f6", "d4e5f6a7"}, {}), set())
    assert recs[0]["refs"] == ["card:a1b2c3d4@out1#L15", "card:b2c3d4e5@out0#L15", "card:c3d4e5f6@out0#L15", "card:d4e5f6a7@out0#L22"]


def test_no_split_inside_a_code_span_or_a_citation():
    """The pasted paragraph (both shapes) is one sentence; a period inside backticks never ends a sentence; a sentence may
    open with a code span; a citation is never split."""
    assert segment_body(PASTED_LABELS) == [[PASTED_LABELS]]
    assert segment_body(PASTED_REFS) == [[PASTED_REFS.replace("`", "")]]
    assert flat("The corpus is `tickets.db`. It has [[12|card:abcd1234@out0#L1]] tables.") == \
        ["The corpus is `tickets.db`.", "It has [[12|card:abcd1234@out0#L1]] tables."]
    assert flat("See `x = 1. Y = 2` there. Then `[[card:abcd1234]] [[README.md#L1]]` again.") == \
        ["See `x = 1. Y = 2` there.", "Then [[card:abcd1234]] [[README.md#L1]] again."]
    assert flat("Done. `tickets.db` is the corpus. `a`. `b. C` d.") == ["Done.", "`tickets.db` is the corpus.", "`a`.", "`b. C` d."]
    assert flat("A `code span` with a [[card:abcd1234]] inside `it [[README.md#L1]]`. Next.") == \
        ["A `code span` with a [[card:abcd1234]] inside `it [[README.md#L1]]`.", "Next."]
    assert flat("Odd ` single backtick. Next.") == ["Odd ` single backtick.", "Next."]  # an unclosed backtick is text


def test_emphasis_markers_are_kept_and_a_sentence_may_open_or_close_with_one():
    assert flat("First. **Second** thing. Third is *here.* _Fourth_ ends **so.** Fifth.") == \
        ["First.", "**Second** thing.", "Third is *here.*", "_Fourth_ ends **so.**", "Fifth."]
    assert flat("Keep 3 * 4 * 5 and snake_case_names and **e.g.** this. Done.") == ["Keep 3 * 4 * 5 and snake_case_names and **e.g.** this.", "Done."]


class _Valid:
    """report._Refs's interface over a fixed cell set: every cell ref valid, one artifact cell."""

    def __init__(self, cells: set[str], artifacts: dict[str, str]):
        self.cells, self.artifacts = cells, artifacts

    def clean(self, raw, text=""):
        from app import refs as _refs

        out = []
        for r in (list(raw) if isinstance(raw, list) else []) + _refs.extract_refs(text or ""):
            if r in out:
                continue
            cid = re.match(r"^card:([A-Za-z0-9_-]+)", r)
            if (cid and cid.group(1) in self.cells) or (not cid and not r.startswith(("claim:", "chat:")) and "/" not in r.split("#")[0][:1]):
                out.append(r)
        return out

    def artifact_id(self, raw):
        m = re.match(r"^card:([A-Za-z0-9_-]+)", str(raw or ""))
        return m.group(1) if m and m.group(1) in self.artifacts else None


def _round_trip(doc: dict) -> None:
    """Every stored section rendered to a body by DocumentFormat.raw_body and segmented again gives the same sentence
    texts and the same refs: the byte-compatibility proof."""
    cells = set()
    for s in doc["sections"]:
        for p in s["paragraphs"]:
            for x in p["sentences"]:
                cells.update(re.findall(r"card:([A-Za-z0-9_-]+)", " ".join([x["text"], *x.get("refs", [])])))
    valid = _Valid(cells, {})
    for s in doc["sections"]:
        body = "\n\n".join(b for b in (report_format.body_of(p["sentences"]) for p in s["paragraphs"]) if b)
        got = segment_body(body)
        want = [[x["text"] for x in p["sentences"]] for p in s["paragraphs"]]
        assert got == want, (s.get("heading"), got, want)
        for para in got:
            for text in para:
                x = next(x for p in s["paragraphs"] for x in p["sentences"] if x["text"] == text)
                inline = valid.clean([], text)
                assert all(r in x.get("refs", []) or r in inline for r in inline)


def test_round_trip_over_the_report_tool_fixture():
    from test_report import tool_output

    cells = {"chart": "aaaa1111", "table": "bbbb2222", "text": "cccc3333"}
    raw = tool_output(cells)
    valid = _Valid(set(cells.values()), {cells["chart"]: "chart", cells["table"]: "table"})
    doc = report._normalize(raw, valid)
    _round_trip(doc)


# --------------------------------------------------------------------------- roles and links


def test_roles_by_heading_then_by_position():
    assert assign_roles(["What this data is and what we analyzed", "Main takeaways", "The admin action", "The deletions", "Limitations"]) == \
        ["data", "takeaways", "finding", "finding", "caveats"]
    assert assign_roles(["TL;DR", "The data", "A finding", "Caveats and limits"]) == ["takeaways", "data", "finding", "caveats"]
    assert assign_roles(["Summary", "Data", "One", "Two"]) == ["takeaways", "data", "finding", "caveats"]  # position fills only the unclaimed slots
    assert assign_roles(["Intro", "Second", "Third", "Last"]) == ["data", "takeaways", "finding", "caveats"]  # four or more: by position
    assert assign_roles(["Intro", "Second", "Third"]) == ["finding", "finding", "finding"]  # three: no positional roles
    assert assign_roles(["Key takeaways", "Other takeaways"]) == ["takeaways", "finding"]  # each role once


def test_link_takeaways_picks_the_finding_by_heading_tokens_else_none():
    sections = [
        {"id": "t", "role": "takeaways", "heading": "Main takeaways", "paragraphs": [{"id": "p", "sentences": [
            {"id": "s1", "text": "The admin action stopped agent-03 within minutes.", "refs": [], "tags": [], "tag_notes": {}},
            {"id": "s2", "text": "Nothing here names a section.", "refs": [], "tags": [], "tag_notes": {}},
            {"id": "s3", "text": "The deletions followed the spike.", "refs": [], "tags": [], "tag_notes": {}}]}]},
        {"id": "f1", "role": "finding", "heading": "The admin action", "paragraphs": [{"id": "q", "sentences": [
            {"id": "s4", "text": "An admin action.", "refs": [], "tags": [], "tag_notes": {}}]}]},
        {"id": "f2", "role": "finding", "heading": "The deletions and their timing", "paragraphs": []},
    ]
    link_takeaways(sections)
    s = {x["id"]: x for sec in sections for p in sec["paragraphs"] for x in p["sentences"]}
    assert s["s1"]["section"] == "f1" and s["s2"]["section"] is None and s["s4"]["section"] is None
    assert s["s3"]["section"] == "f2"  # "deletions" is one of the two content tokens (deletions, timing): a half, the threshold


# --------------------------------------------------------------------------- DocumentFormat.normalize


def _raw_document(cells: dict[str, str]) -> dict:
    return {"title": "Agent-03 stopped after an admin action", "sections": [
        {"heading": "What this data is and what we analyzed",
         "body": f"The corpus holds one run of agent logs [[README.md#L1]]. It spans **one afternoon**.\n\nWe read the admin log by hand [[card:{cells['table']}]]."},
        {"heading": "Main takeaways",
         "body": f"Agent-03 stopped after an admin action [[card:{cells['chart']}]].\n\nThere are [[38|card:{cells['table']}#count/alpha]] alpha rows."},
        {"heading": "The admin action",
         "body": f"Three admin actions cluster on day 3 [[card:{cells['chart']}]]. The deletions follow within minutes. An invented ref is dropped [[card:nope]].",
         "figures": [{"cell": f"card:{cells['chart']}", "caption": "Admin actions per day."},
                     {"cell": f"card:{cells['table']}", "caption": "Counts by kind.", "after_paragraph": 1},
                     {"cell": f"card:{cells['text']}", "caption": "Not chart- or table-bearing; dropped."}]},
        {"heading": "Limitations", "body": "Motive was not checked."},
    ]}


def test_normalize_produces_the_stored_sentence_shape(monkeypatch):
    cells = {"chart": "aaaa1111", "table": "bbbb2222", "text": "cccc3333"}
    valid = _Valid(set(cells.values()), {cells["chart"]: "How many chart?", cells["table"]: "How many table?"})
    raw = _raw_document(cells)
    doc = report._normalize(raw, valid)
    assert doc["id"] == "report" and doc["title"] == raw["title"] and doc["title_ok"] is True and doc["comments"] == []
    assert [s["role"] for s in doc["sections"]] == ["data", "takeaways", "finding", "caveats"]
    assert [s["heading"] for s in doc["sections"]] == [s["heading"] for s in raw["sections"]]  # stored as written
    sentences = [x for s in doc["sections"] for p in s["paragraphs"] for x in p["sentences"]]
    assert len(sentences) == 9 and all(report_types.is_sentence(x) for x in sentences)
    assert all(re.fullmatch(r"[0-9a-f]{8}", x["id"]) for x in sentences) and len({x["id"] for x in sentences}) == 9
    assert all(x["tags"] == [] and x["tag_notes"] == {} for x in sentences)
    assert sentences[0]["text"] == "The corpus holds one run of agent logs [[README.md#L1]]." and sentences[0]["refs"] == ["README.md#L1"]
    assert sentences[1]["text"] == "It spans **one afternoon**."  # the emphasis markers are stored as written (the frontend renders them)
    assert "[[card:nope]]" in sentences[7]["text"] and sentences[7]["refs"] == []  # an invalid ref is kept in the text, not in refs
    assert sentences[8]["text"] == "Motive was not checked." and sentences[8]["refs"] == []
    # the key set of a section and of a sentence equals the sentences path's for the same content
    from test_report import tool_output

    ref_doc = report._normalize(tool_output(cells), valid)
    assert set(doc["sections"][0]) == set(ref_doc["sections"][0]) and set(sentences[0]) == set(ref_doc["sections"][0]["paragraphs"][0]["sentences"][0])
    assert set(doc["sections"][2]["figures"][0]) == set(ref_doc["sections"][2]["figures"][0])
    # figures: on artifact cells only, the 1-based after_paragraph resolved to a paragraph id
    figs = doc["sections"][2]["figures"]
    assert [f["cell"] for f in figs] == [f"card:{cells['chart']}", f"card:{cells['table']}"]
    assert figs[0]["after_paragraph"] is None and figs[1]["after_paragraph"] == doc["sections"][2]["paragraphs"][0]["id"]
    # the takeaways link to the finding by heading tokens
    takeaways = doc["sections"][1]["paragraphs"]
    assert takeaways[0]["sentences"][0]["section"] == doc["sections"][2]["id"] and takeaways[1]["sentences"][0]["section"] is None
    # every reader of the stored shape agrees
    assert len(report_types.all_sentences(doc)) == 9 and [u["heading"] for u in report_types.units(doc)] == [s["heading"] for s in raw["sections"]]
    with pytest.raises(Exception):
        report._normalize({"title": "x", "sections": [{"heading": "h", "body": "   "}]}, valid)


def test_a_bulleted_section_stores_one_sentence_per_bullet_and_round_trips():
    cells = {"chart": "aaaa1111", "table": "bbbb2222", "text": "cccc3333"}
    valid = _Valid(set(cells.values()), {})
    raw = {"title": "T", "sections": [
        {"heading": "Data", "body": "Prose first."},
        {"heading": "Takeaways", "body": f"- One account did it [[card:{cells['chart']}]]. It kept going.\n- The rest followed.\n\nA closing line."},
        {"heading": "A finding", "body": "1. first step\n2. second step"},
        {"heading": "Limitations", "body": "None checked."}]}
    doc = report._normalize(raw, valid)
    take = doc["sections"][1]["paragraphs"]
    assert [[(x["text"], x.get("bullet")) for x in p["sentences"]] for p in take] == [
        [(f"One account did it [[card:{cells['chart']}]]. It kept going.", "-"), ("The rest followed.", "-")], [("A closing line.", None)]]
    assert all(set(x) == {"id", "text", "refs", "tags", "tag_notes", "section", "bullet"} for x in take[0]["sentences"])
    assert set(take[1]["sentences"][0]) == {"id", "text", "refs", "tags", "tag_notes", "section"}  # prose carries no bullet key
    assert [x.get("bullet") for x in doc["sections"][2]["paragraphs"][0]["sentences"]] == ["1.", "1."]
    assert "\n\n".join(report_format.body_of(p["sentences"]) for p in doc["sections"][1]["paragraphs"]) == f"- One account did it [[card:{cells['chart']}]]. It kept going.\n- The rest followed.\n\nA closing line."
    assert report_format.body_of(doc["sections"][2]["paragraphs"][0]["sentences"]) == "1. first step\n2. second step"
    _round_trip(doc)
