"""Transcript for anything close to a transcript, and PDFs as themselves: the sniff over a file's head in each format, the
source page that carries it, the turns of a whole-file JSON transcript, the PDF route and a citation of a PDF's page."""
import json
import os
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
    "session.md": ("# Session\n\n**Human:** hi\n\n**Claude:** hello\nmore\n\n**Human:** ok\n", "text"),
    "interview.md": ("## Interviewer\nhello\n\n## Interviewee\nhi\n\n## Interviewer\nthanks\n", "text"),
    "channel.log": ("[10:01] <alice> hey\n[10:02] <bob> yo\n[10:03] <alice> lunch?\n[10:04] <bob> sure\n", "text"),
    "whatsapp.txt": ("1/2/24, 10:32 - Alice: hi\n1/2/24, 10:33 - Bob: hey\n1/2/24, 10:34 - Alice: ok\nmore\n1/2/24, 10:35 - Bob: bye\n", "text"),
    "standup.txt": ("00:00:01 Speaker 1: welcome\n00:00:05 Speaker 2: thanks\n00:00:09 Speaker 1: so\n00:00:12 Speaker 2: yes\n", "text"),
    "tickets.csv": ("timestamp,speaker,message\n2024-10-01,customer,hi\n2024-10-01,agent,\"hello, there\"\n2024-10-02,customer,bye\n", "csv"),
    "dialogue.tsv": ("turn\tauthor\ttext\n0\tuser\thi\n1\tassistant\tyo\n2\tuser\tok\n", "csv"),
    "messages.jsonl": ("\n".join(json.dumps({"role": r, "content": t}) for r, t in LINES) + "\n", "messages"),
    "nested.jsonl": ("\n".join(json.dumps({"message": {"author": {"name": "bob"}, "content": [{"type": "text", "text": t}]}, "ts": 1})
                               for _, t in LINES) + "\n", "messages"),
    "sharegpt.jsonl": ("\n".join(json.dumps({"conversations": [{"from": "human", "value": "q"}, {"from": "gpt", "value": "a"}]})
                                 for _ in range(3)) + "\n", "conversations"),
    "pairs.jsonl": ("\n".join(json.dumps({"prompt": "p", "response": "r"}) for _ in range(3)) + "\n", "conversations"),
    "stream.jsonl": ("\n".join(json.dumps({"type": "user", "session_id": "s", "message": {"role": "user", "content": "hi"}})
                               for _ in range(3)) + "\n", "stream"),
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
    # a pretty-printed document whose last message sits on one line of its own is still read whole
    "pretty.json": ('{\n  "messages": [\n    {\n      "role": "user",\n      "content": "hi"\n    },\n'
                    '    {"role": "assistant", "content": "hello"}\n  ]\n}\n', "json"),
    # not transcripts
    "notes.md": ("# Notes\n\nNote: slow.\n\n## Plan\n\n- fix\n\nWarning: check.\n\nname: x\nversion: 2\n", None),
    "prices.csv": ("id,price,qty\n1,2,3\n4,5,6\n", None),
    "config.json": (json.dumps({"name": "x", "version": "1", "scripts": {"a": "b"}}, indent=2), None),
    "events.jsonl": ("\n".join(json.dumps({"ts": "t", "agent": "a", "action": "b", "params": {}}) for _ in range(3)) + "\n", None),
    "script.py": ("User: hi\nAssistant: hello\nUser: ok\n", None),
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


def test_the_sniff_is_kept_until_the_file_changes_and_reads_only_the_head(chats, monkeypatch):
    big = chats / "logs" / "big.txt"
    turns = "".join(f"{'User' if i % 2 else 'Assistant'}: line {i}\n" for i in range(200))
    big.write_text(turns + "x" * (2 * transcripts.HEAD_BYTES))
    seen = []
    real = transcripts.sniff_bytes
    monkeypatch.setattr(transcripts, "sniff_bytes", lambda head, rel, complete=False: seen.append(len(head)) or real(head, rel, complete))
    assert transcripts.sniff(big, "logs/big.txt")["format"] == "text"
    assert transcripts.sniff(big, "logs/big.txt")["format"] == "text"
    assert seen == [transcripts.HEAD_BYTES], "one read of the head, then the kept answer"
    big.write_text("no chat here\n")
    os.utime(big, ns=(1, 1))
    assert transcripts.sniff(big, "logs/big.txt") is None and len(seen) == 2


def test_a_source_page_carries_the_sniff_and_a_chat_logs_turns(chats):
    page = client.get(f"{CHATS}/source", params={"path": "logs/chat.txt"}).json()
    assert page["transcript"]["format"] == "text" and page["transcript"]["style"] == "colon"
    turns = [r["meta"].get("turn") for r in page["records"]]
    assert turns[0] == {"speaker": "User", "at": 6} and turns[1]["speaker"] == "Assistant"
    md = client.get(f"{CHATS}/source", params={"path": "logs/whatsapp.txt"}).json()
    assert [bool(r["meta"].get("turn")) for r in md["records"]] == [True, True, True, False, True], "a line goes on the turn before"
    assert md["records"][0]["meta"]["turn"]["time"] == "1/2/24, 10:32"
    plain = client.get(f"{CHATS}/source", params={"path": "logs/notes.md"}).json()
    assert "transcript" not in plain and all("turn" not in r["meta"] for r in plain["records"])


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


def test_a_json_file_too_large_to_parse_is_refused(chats, monkeypatch):
    monkeypatch.setattr(transcripts, "JSON_MAX_BYTES", 10)
    r = client.get(f"{CHATS}/source/turns", params={"path": "logs/eval.json"})
    assert r.status_code == 413


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
    assert ref("docs/postmortem.pdf#p9")["meta"]["missing"] is True
    broken = ref("docs/broken.pdf#p1")
    assert broken["meta"]["error"] and broken["excerpt"] == "(a PDF that does not open)"


def test_each_turn_stands_on_its_line_whatever_wrote_the_json(chats):
    import time

    parts = {"messages": [{"role": "user" if i % 2 else "assistant", "content": [
        {"type": "text", "text": f"ok {i}"}, {"type": "text", "text": "details " * 20}]} for i in range(3000)]}
    (chats / "logs" / "parts.json").write_text(json.dumps(parts, indent=1))
    slack = [{"type": "message", "user": f"U{i % 3}", "text": f"see https://example.com/issue/{i} for run {i}",
              "ts": f"{1700000000 + i}.0001"} for i in range(3000)]
    (chats / "logs" / "slack-escaped.json").write_text(json.dumps(slack, indent=1).replace("/", "\\/"))
    for name, first in (("parts.json", lambda t: t["text"].split("\n")[0]), ("slack-escaped.json", lambda t: t["text"][:10])):
        t0 = time.monotonic()
        got = transcripts.parse_turns(chats / "logs" / name, f"logs/{name}")
        assert time.monotonic() - t0 < 3, f"{name}: one pass, not one per turn"
        raw = (chats / "logs" / name).read_text().split("\n")
        assert len(got["turns"]) == 3000
        assert all(first(t) in raw[t["line"] - 1] for t in got["turns"]), name


def test_turns_whose_words_are_not_found_cost_a_few_passes(chats, monkeypatch):
    import time

    msgs = [{"role": "user", "content": f"message {i} " + "x" * 400} for i in range(4000)]
    (chats / "logs" / "missed.json").write_text(json.dumps(msgs, indent=1))
    monkeypatch.setattr(transcripts, "_needles", lambda t: ["\x01 not in the file"])
    t0 = time.monotonic()
    got = transcripts.parse_turns(chats / "logs" / "missed.json", "logs/missed.json")
    assert time.monotonic() - t0 < 3 and {t["line"] for t in got["turns"]} == {1}


def test_a_file_asked_for_at_once_by_many_is_parsed_once(chats, monkeypatch):
    import threading
    import time

    calls = []
    real = transcripts.conversations_in

    def slow(data, *a):
        calls.append(1)
        time.sleep(0.2)
        return real(data, *a)

    monkeypatch.setattr(transcripts, "conversations_in", slow)
    out = []
    threads = [threading.Thread(target=lambda: out.append(transcripts.parse_turns(chats / "logs" / "eval.json", "e"))) for _ in range(4)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert len(out) == 4 and len(calls) == 1


def test_the_sniff_says_where_line_records_keep_their_turns(chats):
    def sniff(name, content):
        (chats / "logs" / name).write_text(content)
        return transcripts.sniff(chats / "logs" / name, f"logs/{name}")

    share = sniff("share.ndjson", FIXTURES["sharegpt.jsonl"][0])
    assert share["format"] == "conversations" and share["lines"] is True
    assert share["keys"] == {"list": "conversations", "speaker": "from", "text": "value"}
    assert sniff("pairs2.jsonl", FIXTURES["pairs.jsonl"][0])["pair"] == ["prompt", "response"]
    stream = sniff("stream.txt", FIXTURES["stream.jsonl"][0])
    assert stream["format"] == "stream" and stream["lines"] and stream["keys"]["text"] == "message.content"
    log = sniff("app.log", FIXTURES["messages.jsonl"][0])
    assert log["format"] == "messages" and log["lines"] and log["keys"] == {"speaker": "role", "text": "content"}


def test_a_whole_json_file_too_large_to_parse_is_not_offered_transcript(chats, monkeypatch):
    monkeypatch.setattr(transcripts, "JSON_MAX_BYTES", 10)
    assert transcripts.sniff(chats / "logs" / "eval.json", "logs/eval.json") is None
    assert transcripts.sniff(chats / "logs" / "sharegpt.jsonl", "logs/sharegpt.jsonl")["format"] == "conversations"


def test_markdown_quoting_an_example_exchange_keeps_rendered_first(chats):
    prose = "\n".join(f"Paragraph {i} on why the support bot asks for an order number." for i in range(40))
    doc = f"# Prompting guide\n\n## Example\n\nUser: my order is late\nAssistant: what is its number?\n\n{prose}\n\n" \
          "## Another\n\nUser: where is my refund\nAssistant: it takes five days\n"
    (chats / "logs" / "guide.md").write_text(doc)
    got = transcripts.sniff(chats / "logs" / "guide.md", "logs/guide.md")
    assert got["format"] == "text" and got["score"] == transcripts.WEAK
    (chats / "logs" / "guide.txt").write_text(doc)
    assert transcripts.sniff(chats / "logs" / "guide.txt", "logs/guide.txt")["score"] == transcripts.STRONG
    assert transcripts.sniff(chats / "logs" / "session.md", "logs/session.md")["score"] == transcripts.STRONG
