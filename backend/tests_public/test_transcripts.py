"""Transcript for anything close to a transcript, and PDFs as themselves: the sniff over a file's head in each format, the
turns of a whole-file JSON transcript and a citation of words in one, the PDF route and a citation of a PDF's page."""
import json
import shutil

import pytest
from fastapi.testclient import TestClient

from app import transcripts
from app.main import app

client = TestClient(app)
CHATS = "/api/corpora/chats"

LINES = [("user", "Why does the nightly build fail?"), ("assistant", "The groupby test drops the NaN key.\nIt started with the patch."),
         ("user", "Draft a fix."), ("assistant", "Done, with a test.")]


# name -> (content, the format the sniff gives, or None for a file that is no transcript)
FIXTURES = {
    "chat.txt": ("User: hi there\nAssistant: hello, how can I help?\nUser: a joke\nAssistant: why did the chicken...\n", "text"),
    "tickets.csv": ("timestamp,speaker,message\n2024-10-01,customer,hi\n2024-10-01,agent,\"hello, there\"\n2024-10-02,customer,bye\n", "csv"),
    "messages.jsonl": ("\n".join(json.dumps({"role": r, "content": t}) for r, t in LINES) + "\n", "messages"),
    "sharegpt.jsonl": ("\n".join(json.dumps({"conversations": [{"from": "human", "value": "q"}, {"from": "gpt", "value": "a"}]})
                                 for _ in range(3)) + "\n", "conversations"),
    "lines.json": ("\n".join(json.dumps({"sender": {"name": n}, "body": t, "ts": 1700000000 + i})
                             for i, (n, t) in enumerate([("dana", "hi"), ("bot", "yo"), ("dana", "ok")])) + "\n", "messages"),
    "eval.json": (json.dumps({"id": "s1", "messages": [{"role": r, "content": t} for r, t in LINES]}, indent=2), "json"),
    "slack.json": (json.dumps([{"type": "message", "user": f"U{i % 2}", "text": t, "ts": f"{1700000000 + i}.0001"}
                               for i, (_, t) in enumerate(LINES)], indent=4), "json"),
    "claude-export.json": (json.dumps([{"uuid": "c1", "name": "Trip", "chat_messages": [
        {"sender": "human" if r == "user" else "assistant", "text": t} for r, t in LINES]}]), "json"),
    "discord.json": (json.dumps({"channel": {"name": "general"}, "messages": [
        {"author": {"name": "amy" if r == "user" else "ben"}, "content": t, "timestamp": "2024-10-01"} for r, t in LINES]},
        indent=2), "json"),
    "service.log": ("2026-09-01 10:00:00 [INFO] started\n2026-09-01 10:00:05 [WARN] slow\n2026-09-01 10:01:00 [INFO] done\n", None),
    "config.json": (json.dumps({"name": "x", "version": "1", "scripts": {"a": "b"}}, indent=2), None),
}


def chatgpt_export() -> str:
    mapping = {"root": {"id": "root", "message": None, "parent": None, "children": ["n0"]}}
    prev = "root"
    for i, (r, t) in enumerate(LINES):
        mapping[prev]["children"] = [f"n{i}"]
        mapping[f"n{i}"] = {"id": f"n{i}", "parent": prev, "children": [], "message": {
            "id": f"n{i}", "author": {"role": r}, "content": {"content_type": "text", "parts": [t]}, "create_time": 1700000000 + i}}
        prev = f"n{i}"
    # a branch the analyst left: not on the current node's path, so not a turn
    mapping["n1"]["children"].append("old")
    mapping["old"] = {"id": "old", "parent": "n1", "children": [], "message": {
        "author": {"role": "user"}, "content": {"parts": ["an edit left behind"]}}}
    return json.dumps([{"title": "Nightly build", "current_node": prev, "mapping": mapping}])


def tiny_pdf(pages: list[str]) -> bytes:
    """A valid PDF whose pages each hold one line of text in Helvetica."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", ""]
    kids = []
    for text in pages:
        stream = f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET"
        content = len(objs) + 1
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        kids.append(len(objs) + 1)
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content} 0 R "
                    f"/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


@pytest.fixture()
def chats(tmp_path, monkeypatch, mini_dir):
    """A DATA_DIR whose corpus `chats` (a copy of mini) also holds every fixture under logs/, the ChatGPT export and two
    PDFs under docs/."""
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "chats")
    root = data / "chats"
    (root / "logs").mkdir()
    for name, (content, _) in FIXTURES.items():
        (root / "logs" / name).write_text(content)
    (root / "logs" / "chatgpt.json").write_text(chatgpt_export())
    (root / "docs").mkdir()
    (root / "docs" / "postmortem.pdf").write_bytes(tiny_pdf(["Timeline of the failures", "Root cause in reindex", "The fix"]))
    (root / "docs" / "broken.pdf").write_bytes(b"%PDF-1.4\n1 0 obj\n")
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    monkeypatch.setattr(transcripts, "_SNIFFS", type(transcripts._SNIFFS)())
    monkeypatch.setattr(transcripts, "_TURNS", type(transcripts._TURNS)())
    return root


@pytest.mark.parametrize("name", sorted(FIXTURES))
def test_the_sniff_reads_each_format_from_its_head(chats, name):
    got = transcripts.sniff(chats / "logs" / name, f"logs/{name}")
    want = FIXTURES[name][1]
    assert (got or {}).get("format") == want, got
    if got:
        assert got["score"] in (transcripts.STRONG, transcripts.WEAK, 1.0)


def test_the_turns_of_whole_file_json_transcripts(chats):
    def turns(name, **params):
        r = client.get(f"{CHATS}/source/turns", params={"path": f"logs/{name}", **params})
        assert r.status_code == 200, r.text
        return r.json()

    gpt = turns("chatgpt.json")
    assert [(t["speaker"], t["text"]) for t in gpt["turns"]] == [(r, t) for r, t in LINES], "the current branch, in order"
    assert gpt["groups"] == {"0": {"title": "Nightly build", "first": 0}} and gpt["n_groups"] == 1
    assert gpt["turns"][0]["time"] == "2023-11-14T22:13:20Z"
    claude = turns("claude-export.json")
    assert [t["role"] for t in claude["turns"]] == ["user", "assistant", "user", "assistant"]
    ev = turns("eval.json")
    raw = (chats / "logs" / "eval.json").read_text().split("\n")
    assert all(json.dumps(t["text"])[1:30] in raw[t["line"] - 1] for t in ev["turns"]), "each turn stands on its line"
    assert turns("eval.json", line=ev["turns"][-1]["line"])["start"] == 0
    lines = turns("lines.json")
    assert [(t["line"], t["speaker"]) for t in lines["turns"]] == [(1, "dana"), (2, "bot"), (3, "dana")]
    assert lines["turns"][0]["time"] == "2023-11-14T22:13:20Z"
    assert turns("discord.json")["groups"]["0"]["title"] == "general"
    share = turns("sharegpt.jsonl", start=2, count=2)
    assert share["total"] == 6 and share["n_groups"] == 3 and list(share["groups"]) == ["1"]
    page = turns("slack.json", start=2, count=1)
    assert page["total"] == 4 and [t["i"] for t in page["turns"]] == [2]
    assert client.get(f"{CHATS}/source/turns", params={"path": "logs/config.json"}).status_code == 415
    assert client.get(f"{CHATS}/source/turns", params={"path": "../x.json"}).status_code == 400


def _cited_page(chats, rel: str, quote: str) -> dict:
    """The turns page a citation of `quote` in `rel` opens at: the span refs.span_of_quote makes, passed as the Reader
    passes it."""
    from app import refs

    p = refs.parse_ref(refs.span_of_quote(chats, rel, quote))
    r = client.get(f"{CHATS}/source/turns", params={"path": rel, "line": p["line"], "block": p["block"],
                                                    "char_start": p["start"], "char_end": p["end"]})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_message_cited_by_its_pointer_in_a_one_line_store_of_messages_opens_at_its_turn(chats):
    """Bug hunt L6: a document on one line that keeps its messages by id and lists them in conversations
    (`{"messages": {"<id>": …}, "conversations": {"c1": {"messages": ["<id>", …]}}}`) starts every record on line 1, so a
    citation of a message by its pointer opened at the first turn. Each such turn names its message (`ref`), and a page
    asked with the citation's `ref` opens at that turn (`target`), also for a part of the message."""
    order = ["k9", "a1", "z3", "m~2/b"]
    words = {"k9": ("user", "Run the vote."), "a1": ("assistant", "VOTE: lottery"), "z3": ("user", "pushed"),
             "m~2/b": ("assistant", "done")}
    doc = {"agent": "u7", "system": "You keep the ledger.",
           "messages": {k: {"id": k, "role": words[k][0], "content": words[k][1]} for k in ["a1", "z3", "k9", "m~2/b"]},
           "conversations": {"c1": {"id": "c1", "messages": order}}}
    (chats / "logs" / "store.json").write_text(json.dumps(doc))
    rel = "logs/store.json"

    def page(**params):
        r = client.get(f"{CHATS}/source/turns", params={"path": rel, **params})
        assert r.status_code == 200, r.text
        return r.json()

    whole = page()
    assert {t["line"] for t in whole["turns"]} == {1} and "target" not in whole
    by_text = {t["text"]: t for t in whole["turns"]}
    assert by_text["VOTE: lottery"]["ref"] == f"{rel}#/messages/a1"
    assert by_text["done"]["ref"] == f"{rel}#/messages/m~02~1b"
    voted = page(ref=f"{rel}#/messages/a1", line=1)
    assert [t["text"] for t in voted["turns"] if t["i"] == voted["target"]] == ["VOTE: lottery"]
    assert page(ref=f"{rel}#/messages/a1/content")["target"] == voted["target"]
    assert [t["text"] for t in whole["turns"] if t["i"] == page(ref=f"{rel}#/messages/m~02~1b")["target"]] == ["done"]
    assert "target" not in page(ref=f"{rel}#/messages/nope", line=1)


def test_a_citation_of_words_in_a_one_line_json_transcript_opens_at_the_turn_that_holds_them(chats, monkeypatch):
    msgs = {"messages": [{"role": "user", "content": "Why does the nightly build fail?"},
                         {"role": "assistant", "content": "The groupby test drops the NaN key."},
                         {"role": "user", "content": "Draft a fix."}]}
    (chats / "logs" / "minified.json").write_text(json.dumps(msgs))
    page = _cited_page(chats, "logs/minified.json", "drops the NaN key")
    assert page["cited"] == {"i": 1, "quote": "drops the NaN key"}
    assert 1 in [t["i"] for t in page["turns"]] and {t["line"] for t in page["turns"]} == {1}
    bare = client.get(f"{CHATS}/source/turns", params={"path": "logs/minified.json", "line": 1}).json()
    assert "cited" not in bare and bare["start"] == 0 and len(bare["turns"]) == 3
    monkeypatch.setattr(transcripts, "TURN_TEXT_MAX", 10)
    cut = _cited_page(chats, "logs/minified.json", "drops the NaN key")
    held = next(t for t in cut["turns"] if t["i"] == 1)
    assert held["text"] == "The groupby test drops the NaN key" and held["cut"] == len("The groupby test drops the NaN key.")


def test_the_pdf_route_serves_the_file_for_the_browsers_viewer(chats):
    r = client.get(f"{CHATS}/pdf/docs/postmortem.pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content == (chats / "docs" / "postmortem.pdf").read_bytes()
    assert r.headers["content-security-policy"] == "frame-ancestors 'self'" and r.headers["x-frame-options"] == "SAMEORIGIN"
    assert r.headers["x-content-type-options"] == "nosniff"
    ranged = client.get(f"{CHATS}/pdf/docs/postmortem.pdf", headers={"Range": "bytes=0-7"})
    assert ranged.status_code == 206 and ranged.content == b"%PDF-1.4"
    assert client.get(f"{CHATS}/pdf/logs/chat.txt").status_code == 415
    assert client.get(f"{CHATS}/pdf/docs/gone.pdf").status_code == 404
    assert client.get(f"{CHATS}/pdf/..%2F..%2Fetc%2Fx.pdf").status_code == 400


def test_a_citation_of_a_pdf_page_resolves_to_the_page_text(chats):
    def ref(r):
        got = client.get(f"{CHATS}/ref", params={"ref": r})
        assert got.status_code == 200, got.text
        return got.json()

    page = ref("docs/postmortem.pdf#p2")
    assert page["excerpt"] == "Root cause in reindex" and page["meta"]["page"] == 2 and page["meta"]["pages"] == 3
    span = ref("docs/postmortem.pdf#p2-p3")
    assert span["excerpt"] == "Root cause in reindex\n\nThe fix" and span["meta"]["last_page"] == 3
    assert ref("docs/postmortem.pdf")["excerpt"] == "Timeline of the failures"
    gone = client.get(f"{CHATS}/ref", params={"ref": "docs/postmortem.pdf#p9"})
    assert gone.status_code == 404 and "3 pages" in gone.json()["detail"], "a page past the last is a broken citation"
    broken = ref("docs/broken.pdf#p1")
    assert broken["meta"]["error"] and broken["excerpt"] == "(a PDF that does not open)"
