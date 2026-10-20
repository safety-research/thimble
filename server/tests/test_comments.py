"""Comments beside the cards and the report's passages (comments.py): the analyst writes them, resolves them and opens
them again; a report comment follows its words when the report changes."""
from browser_client import Signed

from thimble_browser import canvas, comments, report

REPORT = "# Most runs merged\n\nThe folder has two runs. One failed.\n\n## Why\n\nIt edited the wrong file.\n"


def test_a_comment_on_a_card(folder):
    api = Signed(folder)
    cell = canvas.new_card(api.ws, {"kind": "note", "question": "What is here?", "text": "Two runs."})
    r = api("POST", "/ws/{ws}/canvas/comments", json={"card": cell["id"], "text": "Check  the second run."})
    assert r.status_code == 201
    cm = r.json()["comment"]
    assert cm["text"] == "Check the second run." and cm["author"] == "analyst" and cm["ref"] == f"card:{cell['id']}"
    assert [x["id"] for x in api("GET", "/ws/{ws}/canvas/comments").json()["comments"]] == [cm["id"]]
    assert api("POST", f"/ws/{{ws}}/canvas/comments/{cm['id']}/resolve").json()["comments"] == []
    assert api("POST", f"/ws/{{ws}}/canvas/comments/{cm['id']}/resolve").status_code == 404
    again = api("POST", f"/ws/{{ws}}/canvas/comments/{cm['id']}/reopen").json()["comments"]
    assert [x["id"] for x in again] == [cm["id"]] and again[0]["status"] == "open"
    assert api("POST", "/ws/{ws}/canvas/comments", json={"card": "nope", "text": "x"}).status_code == 404
    # a model's comment shares the store and the shape
    comments.add_card_comment(api.ws, card=cell["id"], text="Unverified: no source.", author="check", check="unverified",
                              run="r1")
    assert {x["author"] for x in api("GET", "/ws/{ws}/canvas/comments").json()["comments"]} == {"analyst", "check"}
    # a deleted card's comments are not served
    canvas.delete_card(api.ws, cell["id"], by="analyst")
    assert api("GET", "/ws/{ws}/canvas/comments").json()["comments"] == []


def test_a_comment_on_the_report(folder):
    api = Signed(folder)
    report.save(api.ws, REPORT, by="chat:w1")
    doc = api("GET", "/ws/{ws}/investigations/main/types/report").json()
    sid = doc["sections"][0]["paragraphs"][0]["sentences"][1]["id"]
    r = api("POST", "/ws/{ws}/investigations/main/types/report/comments", json={"sentence_id": sid, "text": "Which one?"})
    assert r.status_code == 201
    cm = r.json()
    doc = api("GET", "/ws/{ws}/investigations/main/types/report").json()
    assert [(x["sentence_id"], x["text"], x["status"]) for x in doc["comments"]] == [(sid, "Which one?", "open")]
    assert api("GET", "/ws/{ws}/investigations/main/types").json()["report"]["open_comments"] == 1
    heading = api("POST", "/ws/{ws}/investigations/main/types/report/comments", json={"sentence_id": doc["sections"][1]["id"], "text": "Why?"})
    assert heading.status_code == 201
    assert api("POST", "/ws/{ws}/investigations/main/types/report/comments",
               json={"sentence_id": "t9.9.9", "text": "x"}).status_code == 404
    done = api("POST", f"/ws/{{ws}}/investigations/main/types/report/comments/{cm['id']}/dismiss").json()
    assert next(x for x in done["comments"] if x["id"] == cm["id"])["status"] == "dismissed"
    back = api("POST", f"/ws/{{ws}}/investigations/main/types/report/comments/{cm['id']}/reopen").json()
    assert next(x for x in back["comments"] if x["id"] == cm["id"])["status"] == "open"


def test_a_report_comment_follows_its_words(folder):
    api = Signed(folder)
    report.save(api.ws, REPORT, by="chat:w1")
    first = report.writeup(api.ws)["sections"][0]["paragraphs"][0]["sentences"][1]
    assert first["text"] == "One failed."
    cm = comments.add_report_comment(api.ws, first["id"], "Which one?")
    # a new first paragraph moves every sentence's place; the comment stays with "One failed."
    report.save(api.ws, REPORT.replace("## Why", "A new paragraph here.\n\n## Why").replace(
        "# Most runs merged\n\n", "# Most runs merged\n\nFirst, a word.\n\n"), by="analyst")
    doc = report.writeup(api.ws)
    at = next(x for x in doc["comments"] if x["id"] == cm["id"])["sentence_id"]
    words = {s["id"]: s["text"] for sec in doc["sections"] for p in sec["paragraphs"] for s in p["sentences"]}
    assert words[at] == "One failed."
    # a reworded sentence keeps it; one rewritten past recognition drops it from the page
    report.save(api.ws, REPORT.replace("One failed.", "One of them failed."), by="analyst")
    assert [x["id"] for x in report.writeup(api.ws)["comments"]] == [cm["id"]]
    report.save(api.ws, "# Something else\n\nAll new words entirely.\n", by="chat:w1")
    assert report.writeup(api.ws)["comments"] == []
