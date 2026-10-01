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


def jsonl(records: list[dict]) -> str:
    return "\n".join(json.dumps(r) for r in records) + "\n"


# A village's logs, as a database export writes them: people's and agents' talk beside agents' actions, chat rows whose
# speaker is an agent's or a person's id, and Agent SDK messages each kept under `content` beside the row's columns
VILLAGE = jsonl([
    {"day": 1, "timestamp": "2026-04-02T17:47:10.816Z", "type": "USER_TALK", "speakerName": "host", "content": "Welcome, all."},
    {"day": 1, "timestamp": "2026-04-02T17:47:42.909Z", "type": "AGENT_TALK", "speakerName": "Agent A", "content": "Hello."},
    {"day": 1, "timestamp": "2026-04-02T17:48:02.001Z", "type": "START_USING_COMPUTER", "agentName": "Agent A", "goal": "Look up charities"},
    {"day": 1, "timestamp": "2026-04-02T17:49:30.500Z", "type": "AGENT_TALK", "speakerName": "Agent B", "content": "I can help."},
    {"day": 1, "timestamp": "2026-04-02T17:50:11.250Z", "type": "USER_TALK", "speakerName": "host", "content": "Thanks."},
])
CHAT_ROWS = jsonl([
    {"id": f"m{i}", "agent_speaker_id": None if i == 2 else f"a-{i % 3}", "user_speaker_id": "u-1" if i == 2 else None,
     "speaker_type": "user" if i == 2 else "agent", "content": f"message {i}", "room_id": "r1",
     "created_at": f"2026-0{(i * 5) % 9 + 1}-10 21:09:27.837523", "has_been_approved": None} for i in range(8)])
SDK_ROWS = jsonl([
    {"id": "c1", "agent_id": "a-1", "sdk_session_id": "s1", "message_type": "system", "created_at": "2026-03-24 20:51:20.1",
     "content": {"type": "system", "subtype": "status", "session_id": "s1"}},
    {"id": "c2", "agent_id": "a-1", "sdk_session_id": "s1", "message_type": "assistant", "created_at": "2026-03-24 20:51:25.9",
     "content": {"type": "assistant", "uuid": "u2", "session_id": "s1", "message": {"role": "assistant", "content": [
         {"type": "text", "text": "I'll list the files."}, {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}}},
    {"id": "c3", "agent_id": "a-1", "sdk_session_id": "s1", "message_type": "user", "created_at": "2026-03-24 20:51:27.0",
     "content": {"type": "user", "uuid": "u3", "session_id": "s1", "message": {"role": "user", "content": [
         {"type": "tool_result", "tool_use_id": "t1", "content": "notes.txt"}]}}},
])
FRONT_MATTER = ("---\npretty_name: Toy village\nlicense: other\nconfigs:\n" + "".join(
    f"  - config_name: {n}\n    data_files: {n}.jsonl.gz\n" for n in ("events", "chat", "turns", "memories", "goals"))
    + "---\n\n# Toy village\n\nLogs of a few agents.\n\n## Files\n\n- events.jsonl\n- chat.jsonl\n")

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
    "cc-export.txt": ("╭────────────────────────────╮\n│ ✻ Welcome to Claude Code!  │\n╰────────────────────────────╯\n\n"
                      "> Why does the nightly build fail?\n\n⏺ I'll read the log.\n\n⏺ Bash(tail ci.log)\n  ⎿  1 failed\n\n"
                      "⏺ The groupby test drops the NaN key.\n\n> Draft a fix.\n\n⏺ Done, with a test.\n", "text"),
    ".aider.chat.history.md": ("\n# aider chat started at 2026-09-01 10:00:00\n\n> Aider v0.60.0\n> Main model: m\n\n"
                               "#### Why does the nightly build fail?\n\nThe groupby test drops the NaN key.\nIt started with the patch.\n\n"
                               "#### Draft a fix.\n#### Keep it small.\n\nDone, with a test.\n\n> Applied edit to groupby.py\n", "text"),
    "rollout.jsonl": ("\n".join(json.dumps(x) for x in [
        {"timestamp": "2026-09-01T10:00:00Z", "type": "session_meta", "payload": {"id": "s"}},
        {"timestamp": "2026-09-01T10:00:01Z", "type": "response_item",
         "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Why does it fail?"}]}},
        {"timestamp": "2026-09-01T10:00:02Z", "type": "response_item", "payload": {"type": "reasoning", "summary": []}},
        {"timestamp": "2026-09-01T10:00:03Z", "type": "response_item", "payload": {"type": "function_call", "name": "shell"}},
        {"timestamp": "2026-09-01T10:00:04Z", "type": "response_item", "payload": {"type": "function_call_output", "output": "x"}},
        {"timestamp": "2026-09-01T10:00:05Z", "type": "response_item",
         "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "The NaN key."}]}},
        {"timestamp": "2026-09-01T10:00:06Z", "type": "event_msg", "payload": {"type": "token_count"}}]) + "\n", "messages"),
    "langchain.jsonl": ("\n".join(json.dumps({"type": "human" if r == "user" else "ai", "data": {"content": t}}) for r, t in LINES)
                        + "\n", "messages"),
    "tagged.log": ("".join(f"2026-09-01 10:0{i}:00 [{r}] {t.splitlines()[0]}\n" for i, (r, t) in enumerate(LINES)), "text"),
    "village-transcript.jsonl": (VILLAGE, "messages"),
    "chat_messages.jsonl": (CHAT_ROWS, "messages"),
    "sdk_messages.jsonl": (SDK_ROWS, "stream"),
    "camel.jsonl": (jsonl([{"Speaker-Name": n, "messageText": t, "sentAt": f"2026-01-01T10:0{i}:00Z"}
                           for i, (n, t) in enumerate([("amy", "hi"), ("ben", "yo"), ("amy", "ok")])]), "messages"),
    # not transcripts
    "service.log": ("2026-09-01 10:00:00 [INFO] started\n2026-09-01 10:00:05 [WARN] slow\n2026-09-01 10:01:00 [INFO] done\n", None),
    "quotes.md": ("# Notes\n\n> a quote\n\nSome text.\n\n> another quote\n\n> a third\n", None),
    "guide.md": ("# Guide\n\n#### Install\n\nrun it\n\n#### Usage\n\nuse it\n\n#### Notes\n\nmore\n", None),
    "notes.md": ("# Notes\n\nNote: slow.\n\n## Plan\n\n- fix\n\nWarning: check.\n\nname: x\nversion: 2\n", None),
    "prices.csv": ("id,price,qty\n1,2,3\n4,5,6\n", None),
    "config.json": (json.dumps({"name": "x", "version": "1", "scripts": {"a": "b"}}, indent=2), None),
    "events.jsonl": ("\n".join(json.dumps({"ts": "t", "agent": "a", "action": "b", "params": {}}) for _ in range(3)) + "\n", None),
    "script.py": ("User: hi\nAssistant: hello\nUser: ok\n", None),
    "README.md": (FRONT_MATTER, None),
    "dataset.yaml.txt": ("configs:\n" + "".join(f"  - name: {n}\n    data_files: {n}.gz\n" for n in "abcd"), None),
    # documents, each by its own author: no one takes turns
    "essays.jsonl": (jsonl([{"author": f"writer {i}", "text": f"essay {i}"} for i in range(6)]), None),
    "one.jsonl": (jsonl([{"speakerName": "amy", "content": "hi"}]), None),
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


def test_a_chat_export_larger_than_the_sniff_s_head_is_offered_transcript_and_read_whole(chats):
    """An export is judged by its head, whatever its size, and its turns are read from the whole file."""
    convs = [{"uuid": f"c{i}", "name": f"Chat {i}", "chat_messages": [
        {"sender": "human" if r == "user" else "assistant", "text": f"{t} ({i})", "created_at": "2026-09-01T10:00:00Z"}
        for r, t in LINES]} for i in range(3000)]
    big = chats / "logs" / "conversations.json"
    big.write_text(json.dumps(convs))
    assert big.stat().st_size > 2 * transcripts.HEAD_BYTES
    assert transcripts.sniff(big, "logs/conversations.json") == {"format": "json", "score": transcripts.STRONG}
    page = client.get(f"{CHATS}/source/turns", params={"path": "logs/conversations.json", "start": 11996}).json()
    assert page["total"] == 12000 and page["n_groups"] == 3000 and page["turns"][-1]["text"] == "Done, with a test. (2999)"


def test_the_turns_of_other_tools_chat_logs(chats):
    """Claude Code's /export and aider's chat history start a turn at each prompt and each reply."""
    def speakers(name):
        page = client.get(f"{CHATS}/source", params={"path": f"logs/{name}"}).json()
        return [r["meta"]["turn"]["speaker"] for r in page["records"] if r["meta"].get("turn")]

    assert speakers("cc-export.txt") == ["User", "Claude", "Claude", "Claude", "User", "Claude"]
    assert speakers(".aider.chat.history.md") == ["Aider", "User", "Assistant", "User", "Assistant", "Aider"]
    assert transcripts.sniff(chats / "logs" / "langchain.jsonl", "logs/langchain.jsonl")["score"] == transcripts.STRONG


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


def test_the_sniff_reads_who_speaks_under_any_key_and_nesting(chats):
    """Speaker keys in any case style, a second key where some records keep who speaks, and a stream nested under a
    key; a head of turns out of time order offers Transcript but leaves the table first."""
    def sniff(name):
        return transcripts.sniff(chats / "logs" / name, f"logs/{name}")

    village = sniff("village-transcript.jsonl")
    assert village == {"format": "messages", "score": transcripts.STRONG,
                       "keys": {"speaker": "speakerName|agentName", "text": "content", "time": "timestamp"}}
    chat = sniff("chat_messages.jsonl")
    assert chat["keys"] == {"speaker": "agent_speaker_id|user_speaker_id", "text": "content", "time": "created_at"}
    assert chat["score"] == transcripts.WEAK, "rows out of time order read better as a table"
    assert sniff("sdk_messages.jsonl") == {"format": "stream", "score": 1.0, "wrap": "content"}
    assert sniff("camel.jsonl")["keys"] == {"speaker": "Speaker-Name", "text": "messageText", "time": "sentAt"}
    nested = jsonl([{"id": i, "data": {"speakerId": f"a{i % 2}", "speakerType": "agent", "content": f"said {i}"},
                    "created_at": f"2026-01-0{i + 1} 10:00"} for i in range(4)]
                   + [{"id": 9, "data": {"agentId": "a1", "actionType": "WAIT"}, "created_at": "2026-01-09 10:00"}])
    (chats / "logs" / "events2.jsonl").write_text(nested)
    assert sniff("events2.jsonl")["keys"] == {"speaker": "data.speakerId|data.agentId", "text": "data.content",
                                              "time": "created_at"}
    for key in ("reply_to_user", "user_agent", "is_user", "message_type"):
        assert transcripts._speaker_rank(key) is None, key
    assert transcripts._speaker_rank("agent_speaker_id") < transcripts._speaker_rank("speaker_type")
    assert transcripts._speaker_rank("speakerName") < transcripts._speaker_rank("agent_speaker_id")


def test_whole_file_turns_read_who_speaks_under_either_key(chats):
    (chats / "logs" / "village.txt").write_text(VILLAGE)
    got = transcripts.sniff(chats / "logs" / "village.txt", "logs/village.txt")
    assert got["lines"] and got["keys"]["speaker"] == "speakerName|agentName"
    turns = client.get(f"{CHATS}/source/turns", params={"path": "logs/village-transcript.jsonl"}).json()["turns"]
    assert [t["speaker"] for t in turns] == ["host", "Agent A", "Agent B", "host"]


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


def test_a_citation_of_a_pdf_page_reads_only_that_page(chats, monkeypatch):
    import pypdf

    from app import pdfs

    (chats / "docs" / "long.pdf").write_bytes(tiny_pdf([f"Page {n}" for n in range(1, 41)]))
    monkeypatch.setattr(pdfs, "_TEXTS", type(pdfs._TEXTS)())
    read = []
    real = pypdf.PageObject.extract_text
    monkeypatch.setattr(pypdf.PageObject, "extract_text", lambda self, *a, **k: read.append(1) or real(self, *a, **k))
    got = client.get(f"{CHATS}/ref", params={"ref": "docs/long.pdf#p7"}).json()
    assert got["excerpt"] == "Page 7" and got["meta"]["pages"] == 40 and len(read) == 1
    client.get(f"{CHATS}/ref", params={"ref": "docs/long.pdf#p7"})
    assert len(read) == 1, "a page is read once"
    span = client.get(f"{CHATS}/ref", params={"ref": "docs/long.pdf#p10-p40"}).json()
    assert span["meta"]["last_page"] == 40 and span["excerpt"].startswith("Page 10") and len(read) == 1 + pdfs.SPAN_PAGES_READ


def test_a_role_that_first_speaks_past_the_head_still_starts_a_turn(chats, monkeypatch):
    monkeypatch.setattr(transcripts, "TEXT_HEAD_LINES", 4)
    log = "Note: a heading-like line\nUser: hi\nAssistant: hello\nUser: again\nAssistant: yes\nSystem: the session ended\n"
    (chats / "logs" / "late.md").write_text(log)
    page = client.get(f"{CHATS}/source", params={"path": "logs/late.md"}).json()
    assert page["transcript"]["speakers"] == ["assistant", "user"]
    assert [r["meta"].get("turn", {}).get("speaker") for r in page["records"]] == [None, "User", "Assistant", "User", "Assistant", "System"]
