"""versions.py and its routes: the list of a document's generations the Report tab's History reads, and one past
generation's text. No model call and no kernel."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app import agents, config, investigation, report_types, versions

CORPUS = "mini"
MAIN = investigation.MAIN


def _doc(gen: int, heading: str, text: str, ts: str) -> dict:
    return {"id": "report", "type": "report", "renderer": "document", "title": "One account issued every deletion",
            "generation": gen, "generated_at": ts, "written_by": "terminal", "words": None,
            "sections": [{"id": f"sec{gen}", "heading": heading, "figures": [],
                          "paragraphs": [{"id": f"p{gen}", "sentences": [
                              {"id": f"s{gen}", "text": text, "refs": [], "tags": ["fact"], "tag_notes": {}}]}]}],
            "comments": []}


def _save(prev: dict | None, doc: dict, source: str = "terminal") -> None:
    """What write_document does with a generation once it is checked: store it (archiving the previous one) and keep
    the version record that holds the previous one."""
    doc["words"] = report_types.doc_words(doc)
    report_types.store(CORPUS, MAIN, "report", doc)
    versions.record(CORPUS, MAIN, "report", prev, doc, source=source, instructions=None)


@pytest.fixture()
def three(workspaces_tmp):
    config.workspace_dir(CORPUS)
    investigation.ensure_main(CORPUS)
    # a writer's session of the report ran from 10:00 to 10:30 and saved the first two generations; the third came later
    writer = agents.new_agent(CORPUS, "writer", "Write report", announce=False, doc="report")
    meta = agents.read_meta(CORPUS, writer["id"])
    meta.update(created_at="2026-09-25T10:00:00.000+00:00", ts_end="2026-09-25T10:30:00.000+00:00", status="done")
    agents.write_meta(CORPUS, meta)
    g1 = _doc(1, "One account", "All deletions came from one account.", "2026-09-25T10:05:00+00:00")
    _save(None, g1)
    g2 = _doc(2, "One account", "Every deletion but two came from one account.", "2026-09-25T10:10:00+00:00")
    g2["what_changed"] = ["The count now leaves out the two deletions the administrator made."]
    _save(report_types.read_doc(CORPUS, MAIN, "report"), g2)
    g3 = _doc(3, "Two accounts", "Two accounts issued the deletions, one of them most.", "2026-09-25T11:00:00+00:00")
    _save(report_types.read_doc(CORPUS, MAIN, "report"), g3)
    return writer["id"]


async def test_the_history_lists_every_generation_newest_first_with_its_length_and_writer(three):
    # generations 1 and 2 were saved in one writer's chat: they fold into one draft
    h = await report_types.versions_route(CORPUS, MAIN, "report")
    assert h["generation"] == 3 and [v["n"] for v in h["versions"]] == [3, 2]
    v3, v2 = h["versions"]
    assert v3["current"] and not v2["current"] and all(v["available"] for v in h["versions"])
    assert v3["summary_from"] == "diff" and any("added" in line for line in v3["summary"]) and any("removed" in line for line in v3["summary"])
    assert v3["revisions"] == []
    # the folded draft is the run's: its first save is its revision, and it wrote the first draft
    assert v2["source"] == versions.FIRST_SOURCE and v2["summary"] == []
    assert v2["revisions"] == [{"i": 1, "ts": "2026-09-25T10:05:00+00:00", "available": True, "generation": 1,
                                "words": report_types.doc_words(_doc(1, "One account", "All deletions came from one account.", ""))}]
    assert v3["words"] == report_types.read_doc(CORPUS, MAIN, "report")["words"]
    # a save inside the writer's session is that writer's, though it is stamped `terminal`; one outside it is nobody's
    assert v2["writer"] == three and v3["writer"] is None
    first = await report_types.revision_route(CORPUS, MAIN, "report", 2, 1)
    assert first["generation"] == 1
    with pytest.raises(HTTPException):
        await report_types.revision_route(CORPUS, MAIN, "report", 3, 1)


async def test_a_past_generation_reads_as_it_stood_and_one_with_no_text_is_404(three):
    old = await report_types.version_route(CORPUS, MAIN, "report", 1)
    assert old["generation"] == 1 and old["sections"][0]["paragraphs"][0]["sentences"][0]["text"] == "All deletions came from one account."
    cur = await report_types.version_route(CORPUS, MAIN, "report", 3)
    assert cur["sections"][0]["heading"] == "Two accounts"
    for n in (0, 4):
        with pytest.raises(HTTPException) as e:
            await report_types.version_route(CORPUS, MAIN, "report", n)
        assert e.value.status_code == 404


async def test_a_generation_whose_record_is_gone_is_listed_but_not_available(three):
    versions.versions_dir(CORPUS, MAIN, "report").joinpath("2.json").unlink()
    h = await report_types.versions_route(CORPUS, MAIN, "report")
    # with no time of its own it cannot be told to be the writer's, so it stays a draft of its own
    v1 = h["versions"][2]
    assert v1["n"] == 1 and not v1["available"] and v1["words"] is None and v1["revisions"] == []
    with pytest.raises(HTTPException):
        await report_types.version_route(CORPUS, MAIN, "report", 1)


async def test_the_history_of_a_document_not_written_is_404(workspaces_tmp):
    config.workspace_dir(CORPUS)
    investigation.ensure_main(CORPUS)
    with pytest.raises(HTTPException) as e:
        await report_types.versions_route(CORPUS, MAIN, "report")
    assert e.value.status_code == 404


# --------------------------------------------------------------------------- one writer run, one generation

WRITER = "writer:report"


def _writer_run(chat: str, k: int = 0):
    """A writer's session of the report, running, as agent_session holds it while its shim posts write_document."""
    from app import agent_session

    run = agent_session.Run(CORPUS, WRITER, chat, "sid", config.workspace_dir(CORPUS), "writer", k=k)
    agent_session._runs[(CORPUS, WRITER)] = run
    return run


async def _write(text: str, session: str | None = WRITER):
    from app import tools

    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst", session=session)
    assert not r.is_error, r.text
    return report_types.read_doc(CORPUS, MAIN, "report")


def _chips() -> list[dict]:
    _, log_path = agents.paths(CORPUS, agents.MAIN_ID)
    return [e for e in investigation._read_jsonl(log_path) if e.get("type") == "chip" and e.get("kind") == "artifact"]


@pytest.fixture()
def fresh(workspaces_tmp):
    from app import agent_session

    config.workspace_dir(CORPUS)
    investigation.ensure_main(CORPUS)
    yield
    agent_session._runs.pop((CORPUS, WRITER), None)


async def test_a_writer_run_is_one_generation_its_earlier_saves_its_revisions(fresh):
    _writer_run("chatA")
    await _write("# Draft\n\n## One account\n\nOne account did it.\n")
    await _write("# Draft\n\n## One account\n\nOne account did most of it.\n")
    doc = await _write("# Final\n\n## One account\n\nOne account issued every deletion.\n")
    assert doc["generation"] == 1 and doc["revision"] == 3 and doc["writer_run"] == "chatA:0" and doc["title"] == "Final"
    h = await report_types.versions_route(CORPUS, MAIN, "report")
    assert [v["n"] for v in h["versions"]] == [1]
    revs = h["versions"][0]["revisions"]
    assert [(r["i"], r["generation"], r["available"]) for r in revs] == [(1, None, True), (2, None, True)]
    first = await report_types.revision_route(CORPUS, MAIN, "report", 1, 1)
    assert report_types.all_sentences(first)[0]["text"] == "One account did it."
    second = await report_types.revision_route(CORPUS, MAIN, "report", 1, 2)
    assert report_types.all_sentences(second)[0]["text"] == "One account did most of it."
    with pytest.raises(HTTPException):
        await report_types.revision_route(CORPUS, MAIN, "report", 1, 3)
    assert [c["text"] for c in _chips()] == ["wrote"], "one chat row per run"

    # the analyst's edit changes the generation in place, with no revision
    blocks = report_types.editor_blocks(doc)
    para = next(b for b in blocks if b.type == "paragraph")
    para.text = "One account issued all 27 deletions."
    report_types.save_blocks(CORPUS, MAIN, "report", "Final", blocks)
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert doc["generation"] == 1 and len((await report_types.versions_route(CORPUS, MAIN, "report"))["versions"][0]["revisions"]) == 2

    # the next run is the next generation, compared with the first run's last save
    _writer_run("chatB")
    doc = await _write("# Final\n\n## Two accounts\n\nTwo accounts issued the deletions.\n")
    assert doc["generation"] == 2 and doc["revision"] == 1
    doc = await _write("# Final\n\n## Two accounts\n\nTwo accounts issued the deletions, alice most.\n")
    assert doc["generation"] == 2 and doc["revision"] == 2
    h = await report_types.versions_route(CORPUS, MAIN, "report")
    v2, v1 = h["versions"]
    assert (v2["n"], len(v2["revisions"]), v1["n"], len(v1["revisions"])) == (2, 1, 1, 2)
    assert v2["summary_from"] == "diff" and any("added" in x for x in v2["summary"]) and any("removed" in x for x in v2["summary"])
    old = await report_types.version_route(CORPUS, MAIN, "report", 1)
    assert report_types.all_sentences(old)[0]["text"] == "One account issued all 27 deletions."
    assert [c["text"] for c in _chips()] == ["wrote", "revised"]
    # a save from main's own session is a generation of its own
    doc = await _write("# Final\n\n## Two accounts\n\nTwo accounts issued them.\n", session=None)
    assert doc["generation"] == 3 and "writer_run" not in doc


async def test_comments_carry_when_a_run_starts_a_generation_and_are_re_pointed_within_it(fresh):
    _writer_run("chatA")
    doc = await _write("# T\n\n## A\n\nKept sentence.\n\nChanged sentence.\n")
    kept, changed = (x["id"] for x in report_types.all_sentences(doc))
    doc["comments"] = [
        {"id": "c1", "sentence_id": kept, "text": "on kept", "author": "analyst", "status": "open"},
        {"id": "c2", "sentence_id": changed, "text": "on changed", "author": "analyst", "status": "open"},
        {"id": "c3", "sentence_id": changed, "text": "check says", "author": "check", "check": "unverified", "status": "open"},
    ]
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    _writer_run("chatB")
    doc = await _write("# T\n\n## A\n\nKept sentence.\n\nRewritten sentence.\n")
    by = {c["id"]: c for c in doc["comments"]}
    new_kept = next(x["id"] for x in report_types.all_sentences(doc) if x["text"] == "Kept sentence.")
    assert doc["generation"] == 2
    assert by["c1"]["sentence_id"] == new_kept and by["c1"]["status"] == "open"
    assert by["c2"]["status"] == "open" and by["c2"]["was_on"] == "Changed sentence."
    assert by["c3"]["status"] == "dismissed" and by["c3"]["superseded_generation"] == 2
    # a later save of the same run keeps the generation and its comments, re-pointed at the text that survived
    doc = await _write("# T\n\n## A\n\nKept sentence.\n\nRewritten again.\n")
    by = {c["id"]: c for c in doc["comments"]}
    new_kept = next(x["id"] for x in report_types.all_sentences(doc) if x["text"] == "Kept sentence.")
    assert doc["generation"] == 2 and set(by) == {"c1", "c2", "c3"}
    assert by["c1"]["sentence_id"] == new_kept and by["c3"]["superseded_generation"] == 2


def test_a_section_without_a_heading_is_named_by_its_whole_first_sentence():
    long = "From March 3 to April 9, editors with invented names such as BlueHeron made 8,212 saves."
    prev = _doc(1, "", long, "2026-09-25T10:05:00+00:00")
    doc = _doc(2, "", long, "2026-09-25T10:10:00+00:00")
    for d, more in ((prev, "They posted links."), (doc, "They posted lists of links.")):
        d["sections"][0]["paragraphs"][0]["sentences"].append({"id": "s9", "text": more, "refs": [], "tags": [], "tag_notes": {}})
    assert versions.fallback_summary(prev, doc) == [f"1 section reworded: “{long}”."]


async def test_a_stored_section_diff_is_measured_again_on_read(three):
    # a record stored when an unheaded section was named by its first 60 characters reads with the sentence whole
    path = versions.versions_dir(CORPUS, MAIN, "report") / "3.json"
    from app.ledger import read_json, write_json
    rec = read_json(path, None)
    rec["summary"] = ["1 section reworded: “Two accounts issued the dele”."]
    write_json(path, rec)
    h = await report_types.versions_route(CORPUS, MAIN, "report")
    assert h["versions"][0]["summary"] == versions.fallback_summary(rec["previous"], report_types.read_doc(CORPUS, MAIN, "report"))
