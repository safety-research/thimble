"""The analyst's changes to a document's comments (the margin's Comment, Done in the margin or in the top bar's Comments,
and a comment opened again) put `report {status: commented, by: analyst}` on the stream, as a check's or main's comment
does: every open page reads that document's comments again, so the top bar's Comments and the Report's margin follow a
Done made elsewhere (frontend report/docComments.ts). Through the route functions, as the browser reaches them; no
model call."""
from __future__ import annotations

from app import investigation, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN


def _commented() -> list[dict]:
    """The stream's records that a document's comments changed, each as {slug, span, by}."""
    path = investigation.inv_dir(CORPUS, MAIN) / "events.jsonl"
    rows = investigation._read_jsonl(path) if path.exists() else []
    return [{k: e.get(k) for k in ("slug", "span", "by")} for e in rows
            if e.get("type") == "report" and e.get("status") == "commented"]


async def test_a_comment_added_resolved_and_opened_again_tells_the_open_pages_that_its_document_changed(workspaces_tmp):
    report_types.create_document_type(CORPUS, "casefile", name="Cases", slug="cases")
    r = await tools.call(CORPUS, "write_document", {"doc": "cases", "text": "# Two tests fail\n\n## test_upload_retry\n\n"
                                                                           "It timed out after 30 seconds.\n"},
                         actor="analyst")
    assert not r.is_error, r.text
    sid = report_types.all_sentences(report_types.read_doc(CORPUS, MAIN, "cases"))[0]["id"]
    said = {"slug": "cases", "span": f"report:cases#{sid}", "by": "analyst"}
    cm = await report_types.post_comment(CORPUS, MAIN, "cases", report_types.CommentBody(sentence_id=sid, text="Which run?"))
    assert _commented() == [said]
    doc = await report_types.dismiss(CORPUS, MAIN, "cases", cm["id"])
    assert [c["status"] for c in doc["comments"]] == ["dismissed"]
    assert _commented() == [said, said]
    await report_types.reopen(CORPUS, MAIN, "cases", cm["id"])
    assert _commented() == [said, said, said]
    # opened again while open: nothing changed, nothing said
    await report_types.reopen(CORPUS, MAIN, "cases", cm["id"])
    assert len(_commented()) == 3
