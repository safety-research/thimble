"""propose_view's fields (views.SPEC_FIELDS): beside the free-text `why`, a proposal stores them as its `spec`, writes
them out as its arrangement, and the view ticket, a change to the view and the review list them one per line. A field
left out is refused. A viewer of an unusual file type the orientation proposes is stored `suggested`, to be built when
the analyst picks it in the File browser, while main's is built at once, and a view whose claim is the glob of a type
the files view reads is built at once. The corpus is invented: a support desk's tickets and recorded call captions."""
from __future__ import annotations

import json

import pytest

from app import config, dev, investigation, prompts, session, tools, views

CORPUS = "desk"
FIELDS = {"unit": "one ticket, keyed by ticket_id, 40 of them",
          "overview": "every conversation listed down the side, newest first",
          "zoom": "picking a conversation opens it as one thread",
          "filter": "labels keep the tickets they mark, and a search narrows by subject",
          "details": "a ticket's whole body and its status history"}
INBOX = {"name": "Inbox", "why": "Each customer's tickets read as one email thread.", "claims": ["tickets.jsonl"],
         **FIELDS}


@pytest.fixture()
def desk(tmp_path, monkeypatch, workspaces_tmp) -> list[dict]:
    d = tmp_path / "data"
    corpus = d / CORPUS
    (corpus / "calls").mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (corpus / "tickets.jsonl").write_text("".join(json.dumps({"ticket_id": i, "body": f"ticket {i}"}) + "\n"
                                                  for i in range(3)))
    (corpus / "calls" / "one.vtt").write_text("WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    monkeypatch.setattr(views, "build_problem", lambda: None)
    events: list[dict] = []
    monkeypatch.setattr(views, "_thread_loop", lambda: object())
    monkeypatch.setattr(investigation, "emit", lambda c, chat, ev: events.append(ev))
    monkeypatch.setattr(session, "push_event", lambda c, kind, text, **m: True)
    return events


async def test_a_proposal_stores_its_fields_and_the_ticket_lists_them(desk):
    res = await tools.call(CORPUS, "propose_view", INBOX)
    assert not res.is_error, res.text
    prop = views.read_proposal(CORPUS, "inbox")
    assert prop["spec"] == FIELDS and prop["status"] == "queued"
    assert prop["arrangement"].splitlines()[0] == "Unit: one ticket, keyed by ticket_id, 40 of them"

    ticket = dev.build_view_prompt(CORPUS, prop, views.views_dir(CORPUS) / "inbox", config.corpus_dir(CORPUS))
    assert "- What the analyst sees in it and why that helps: Each customer's tickets read as one email thread." in ticket
    assert "- Unit: one ticket, keyed by ticket_id, 40 of them\n- Overview: every conversation" in ticket
    assert "- Zoom: picking a conversation" in ticket and "- Filter: labels keep the tickets" in ticket
    assert "- Details: a ticket's whole body" in ticket
    change = dev.build_view_change_prompt({**prop, "change": "newest first"}, views.views_dir(CORPUS) / "inbox")
    assert "- Overview: every conversation listed down the side" in change


def test_a_proposal_without_fields_lists_its_arrangement_as_one_line():
    assert views.spec_lines({"arrangement": "one post per page"}) == "- The unit and the layout: one post per page"
    assert views.spec_lines({"spec": {"unit": " a day \n", "filter": "labels"}}) == "- Unit: a day\n- Filter: labels"


@pytest.mark.parametrize("missing", ["why", "unit", "overview", "zoom", "filter", "details"])
async def test_a_field_left_out_is_refused(desk, missing):
    res = await tools.call(CORPUS, "propose_view", {k: v for k, v in INBOX.items() if k != missing})
    assert res.is_error and f"`{missing}` is required" in res.text
    assert views.read_proposal(CORPUS, "inbox") is None


CAPTIONS = {"name": "Call Captions", "why": "A call's captions as a transcript.", "claims": ["**/*.vtt"],
            **FIELDS, "unit": "one cue", "filter": "labels keep the cues they mark"}


async def test_the_orientation_s_file_type_viewer_is_offered_and_main_s_is_built(desk, monkeypatch):
    queued: list[str] = []
    monkeypatch.setattr(views, "_queue", lambda c, slug: queued.append(slug))
    res = await tools.call(CORPUS, "propose_view", CAPTIONS, session=tools.ORIENT_SESSION)
    assert not res.is_error and "offers it beside Raw" in res.text
    prop = views.read_proposal(CORPUS, "call-captions")
    assert prop["status"] == "suggested" and prop["spec"]["unit"] == "one cue" and queued == []

    res = await tools.call(CORPUS, "propose_view", {**CAPTIONS, "name": "Caption Player"})
    assert not res.is_error and views.read_proposal(CORPUS, "caption-player")["status"] == "queued"
    assert queued == ["caption-player"]


async def test_the_orientation_s_view_over_a_type_the_files_view_reads_is_built_at_once(desk, monkeypatch):
    queued: list[str] = []
    monkeypatch.setattr(views, "_queue", lambda c, slug: queued.append(slug))
    res = await tools.call(CORPUS, "propose_view", {**INBOX, "claims": ["*.jsonl"]}, session=tools.ORIENT_SESSION)
    prop = views.read_proposal(CORPUS, "inbox")
    assert not res.is_error and prop["status"] == "queued" and prop["held"] and queued == ["inbox"]


def test_the_tool_s_schema_asks_for_the_form_in_free_text_and_the_fields_the_build_needs():
    desc, schema = tools.split_section(prompts.section("tools", "propose_view"))
    assert list(schema["properties"]) == ["name", "why", "claims", *(k for k, _ in views.SPEC_FIELDS)]
    assert schema["required"] == list(schema["properties"])
    assert all(p.get("type") == "string" and "enum" not in p for k, p in schema["properties"].items() if k != "claims")
    assert "whatever form fits the records" in schema["properties"]["why"]["description"]
    asks = {k: schema["properties"][k]["description"] for k in ("overview", "zoom", "filter", "details")}
    assert asks == {"overview": "What does the overview look like?", "zoom": "How do you zoom?",
                    "filter": "How do you filter? Labels are the main filter, every field the records carry can be "
                              "selected, and several runs or sources can be compared side by side.",
                    "details": "What details might you want on demand?"}
