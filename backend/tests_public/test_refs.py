"""refs.py: every ref kind parses and formats back to itself (file line, range, block and span, database row and table,
card with its output line or td span, concept, report, view, and any file with a locator of its own type);
record_blocks; and resolve over the synthetic `mini` corpus, which answers an excerpt with its context or a RefError
with a 400 or 404 status, nested runs included."""
import json
import shutil

import pytest

from app import config, refs

CASES = {
    "agents/agent-03.jsonl#L412": {"kind": "record", "path": "agents/agent-03.jsonl", "line": 412},
    "agents/agent-03.jsonl#L412-L420": {"kind": "range", "path": "agents/agent-03.jsonl", "line": 412, "end_line": 420},
    "agents/agent-03.jsonl#L412.b2": {"kind": "block", "path": "agents/agent-03.jsonl", "line": 412, "block": 2},
    "agents/agent-03.jsonl#L412.b2:c10-40": {"kind": "span", "path": "agents/agent-03.jsonl", "line": 412, "block": 2,
                                             "start": 10, "end": 40},
    "board.jsonl#L17": {"kind": "record", "path": "board.jsonl", "line": 17},
    "prompts/worker.md#L3": {"kind": "record", "path": "prompts/worker.md", "line": 3},
    "forge.db#prs/4410": {"kind": "row", "path": "forge.db", "table": "prs", "pk": "4410"},
    "forge.db#agents/agent-01": {"kind": "row", "path": "forge.db", "table": "agents", "pk": "agent-01"},
    "forge.db#prs": {"kind": "table", "path": "forge.db", "table": "prs"},
    # nested corpora: (<dir>/)?forge.db#...
    "run-b/forge.db#prs/4410": {"kind": "row", "path": "run-b/forge.db",
                                                    "table": "prs", "pk": "4410"},
    "run-b/forge.db#prs": {"kind": "table", "path": "run-b/forge.db", "table": "prs"},
    "a/b/forge.db#messages/17": {"kind": "row", "path": "a/b/forge.db", "table": "messages", "pk": "17"},
    # any sqlite file is a database: <path ending in .db|.sqlite|.sqlite3>#<table>[/<pk>]
    "runs/x/ehr.db#patients/12": {"kind": "row", "path": "runs/x/ehr.db", "table": "patients", "pk": "12"},
    "runs/x/ehr.db#patients": {"kind": "table", "path": "runs/x/ehr.db", "table": "patients"},
    "notes.sqlite#wards/icu-2": {"kind": "row", "path": "notes.sqlite", "table": "wards", "pk": "icu-2"},
    "a/b/c.sqlite3#visits": {"kind": "table", "path": "a/b/c.sqlite3", "table": "visits"},
    "run-b/agents/agent-03.jsonl#L412": {"kind": "record", "path": "run-b/agents/agent-03.jsonl",
                                                            "line": 412},
    "run-b/board.jsonl#L17.b0:c1-5": {"kind": "span", "path": "run-b/board.jsonl", "line": 17,
                                                          "block": 0, "start": 1, "end": 5},
    "card:7f3a": {"kind": "cell", "cell_id": "7f3a", "exec": None},
    "card:7f3a@3": {"kind": "cell", "cell_id": "7f3a", "exec": 3},
    # td spans (cite.py): the labels are written encoded and parse decoded
    "card:7f3a#count/alpha": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "count", "row": "alpha"},
    "card:7f3a#mean%20score/α%2Fβ": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "mean score", "row": "α/β"},
    "card:7f3a#p%2A/x%7Ey": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "p*", "row": "x~y"},
    "card:7f3a#a%7Cb/%5Fid": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "a|b", "row": "_id"},
    "card:7f3a#%23items/50%25": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "#items", "row": "50%"},
    "card:7f3a@out0#L3": {"kind": "cell", "cell_id": "7f3a", "exec": None, "out": 0, "line": 3},
    # a line range of an output: the file range form, for cards
    "card:7f3a@out1#L3-L5": {"kind": "cell", "cell_id": "7f3a", "exec": None, "out": 1, "line": 3, "end_line": 5},
    "chat:ab12#7": {"kind": "chat", "chat_id": "ab12", "event_index": 7},
    "README.md": {"kind": "path", "path": "README.md"},
    # any other part of a file, in the notation of its own type: the file with the locator kept as text
    "budget.xlsx#Q3!B2:B40": {"kind": "path", "path": "budget.xlsx", "locator": "Q3!B2:B40"},
    "papers/a.pdf#page=4": {"kind": "path", "path": "papers/a.pdf", "locator": "page=4"},
    "poster.psd#layer=Title": {"kind": "path", "path": "poster.psd", "locator": "layer=Title"},
    "notes.txt#intro#2": {"kind": "path", "path": "notes.txt", "locator": "intro#2"},
    # a view, and a unit only that view defines: the key is the view's own text
    "view:ticket-threads": {"kind": "view", "slug": "ticket-threads", "key": None},
    "view:ticket-threads/queue~BillingEscalations2031": {"kind": "view", "slug": "ticket-threads", "key": "queue~BillingEscalations2031"},
    "view:budget/Q3/row-4": {"kind": "view", "slug": "budget", "key": "Q3/row-4"},
}


@pytest.mark.parametrize("ref,expected", CASES.items())
def test_parse_and_format_roundtrip(ref, expected):
    assert refs.parse_ref(ref) == expected
    assert refs.format_ref(expected) == ref


def test_parse_trims_whitespace():
    assert refs.parse_ref("  card:ab \n")["cell_id"] == "ab"


@pytest.mark.parametrize("bad", ["", "agents/x.jsonl#L", "agents/x.jsonl#L1.b", "cell:", "[[card:ab]]", "a b #L1",
                                 "x#L1-2", "x#L1:c0-3", "x#L1-L", "x.db#", "see the chart above", "a b#intro",
                                 "http://x.org/a#b", "claim:0badf00d", "claim:0badf00d#1"])
def test_parse_rejects_garbage(bad):
    with pytest.raises(ValueError):
        refs.parse_ref(bad)


@pytest.mark.parametrize("ref,expected", [
    ("run 1/agents/agent one.jsonl#L2", {"kind": "record", "path": "run 1/agents/agent one.jsonl", "line": 2}),
    ("a b#L1", {"kind": "record", "path": "a b", "line": 1}),
    ("Call log 3.md#L4-L9", {"kind": "range", "path": "Call log 3.md", "line": 4, "end_line": 9}),
    ("run 1/x.jsonl#L2.b0:c1-5", {"kind": "span", "path": "run 1/x.jsonl", "line": 2, "block": 0, "start": 1, "end": 5}),
    ("q3 data/sales db.sqlite#orders/7", {"kind": "row", "path": "q3 data/sales db.sqlite", "table": "orders", "pk": "7"}),
    ("Meeting notes.md", {"kind": "path", "path": "Meeting notes.md"}),
    ("a b.txt#intro", {"kind": "path", "path": "a b.txt", "locator": "intro"}),
    ("ünïcødé ✓/agents/α β.jsonl#L1", {"kind": "record", "path": "ünïcødé ✓/agents/α β.jsonl", "line": 1}),
])
def test_a_file_path_with_spaces_parses_and_formats_back(ref, expected):
    """A corpus whose file names hold spaces can be cited: a path may hold spaces inside it (never at its ends, never
    before the `#`), and one with no line fragment counts when it looks like a file (a `/` or an extension), so
    bracketed prose is not taken for a path."""
    assert refs.parse_ref(ref) == expected
    assert refs.format_ref(expected) == ref


@pytest.mark.parametrize("ref,path,locator", [
    ("x.txt#prs", "x.txt", "prs"), ("agents/x.jsonl#Lx", "agents/x.jsonl", "Lx"), ("forge.db#1prs", "forge.db", "1prs"),
    ("run/forge.db#1prs", "run/forge.db", "1prs"), ("x.dbx#prs", "x.dbx", "prs"), ("x.db#t/", "x.db", "t/"),
])
def test_a_locator_no_rule_reads_is_the_file_itself(ref, path, locator):
    """A link may name a part of a file in the notation of the file's own type: a `<path>#<locator>` the line and
    database rules do not read is the file with the locator kept as text, and it formats back to itself. A locator shaped like the line grammar
    (test_parse_rejects_garbage) stays an error, so a mistyped line ref is caught and repaired."""
    assert refs.parse_ref(ref) == {"kind": "path", "path": path, "locator": locator}
    assert refs.format_ref(refs.parse_ref(ref)) == ref


@pytest.mark.parametrize("ref,col,row", [
    ("card:c1d2e3f4#tickets reopened/total queues", "tickets reopened", "total queues"),
    ("card:a0b1c2d3#what 2.4.1 changed/summary", "what 2.4.1 changed", "summary"),
    ("card:9e8d7c6b#share of replies in common/pair 1", "share of replies in common", "pair 1"),
])
def test_a_raw_labelled_td_span_parses_with_its_spaces(ref, col, row):
    """A td span whose column or row label carries a space, written raw rather than percent-encoded (a form the model
    reaches for in a chat answer), parses to that column and row rather than being refused as 'not a ref'. It formats
    back encoded, since that is the canonical form."""
    p = refs.parse_ref(ref)
    assert p["kind"] == "cell" and p["col"] == col and p["row"] == row
    assert "%20" in refs.format_ref(p)


def test_extract_refs_dedupes_in_order():
    text = "see [[agents/a.jsonl#L1]] then [[card:7f]] and again [[agents/a.jsonl#L1]] [[ ]] [[x]]"
    assert refs.extract_refs(text) == ["agents/a.jsonl#L1", "card:7f", "x"]


def test_database_refs_format_default_and_extract():
    assert refs.format_ref({"kind": "row", "table": "prs", "pk": "1"}) == "forge.db#prs/1"  # no path stored: the default
    assert refs.format_ref({"kind": "table", "path": "runs/x/ehr.db", "table": "patients"}) == "runs/x/ehr.db#patients"
    text = "[[runs/x/ehr.db#patients/12]] and [[7|notes.sqlite#wards/icu-2]] and [[runs/x/ehr.db#patients/12]]"
    assert refs.extract_refs(text) == ["runs/x/ehr.db#patients/12", "notes.sqlite#wards/icu-2"]
    assert refs.parse_ref("other.db#L1.b0")["kind"] == "block"  # a line-style ref into a database parses; resolve refuses it


# --------------------------------------------------------------------------- record_blocks


def test_blocks_assistant_all_kinds():
    rec = {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "hmm", "signature": "sig"},
        {"type": "thinking", "thinking": "", "signature": "sig"},  # redacted: no block
        {"type": "text", "text": "Hello"},
        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
        {"type": "server_tool_use", "foo": 1},  # unknown block type: raw
    ]}}
    blocks = refs.record_blocks(rec)
    assert [b["kind"] for b in blocks] == ["thinking", "text", "tool_use", "raw"]
    assert blocks[0]["text"] == "hmm"
    assert blocks[1]["text"] == "Hello"
    assert blocks[2]["text"] == "Bash\n" + json.dumps({"command": "ls"}, indent=2)
    assert json.loads(blocks[3]["text"]) == {"type": "server_tool_use", "foo": 1}


def test_blocks_tool_result_string_list_and_none():
    rec = {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "out"},
        {"type": "tool_result", "tool_use_id": "t2", "content": [
            {"type": "text", "text": "a"}, {"type": "image", "source": {}}, {"type": "text", "text": "b"}]},
        {"type": "tool_result", "tool_use_id": "t3", "content": None},
    ]}}
    blocks = refs.record_blocks(rec)
    assert [b["kind"] for b in blocks] == ["tool_result"] * 3
    assert [b["text"] for b in blocks] == ["out", "a\nb", ""]


def test_blocks_plain_string_content():
    assert refs.record_blocks({"type": "user", "message": {"content": "plain"}}) == [{"kind": "text", "text": "plain"}]


def test_blocks_events_without_params_never_null():
    # an events.jsonl of another shape has no `params`, and its excerpt is the record, never 'null'
    other = {"event_id": "close:queue-7@3", "event_type": "close", "time": "2026-02-11T14:05:31Z", "desk": "north"}
    blocks = refs.record_blocks(other, "events")
    assert len(blocks) == 1 and blocks[0]["text"] != "null"
    assert json.loads(blocks[0]["text"]) == other
    # a text-like field wins over the raw record
    assert refs.record_blocks({"event_type": "save", "body": "hello"}, "events") == [{"kind": "event", "text": "hello"}]
    # the forge's shape
    assert refs.record_blocks({"ts": 1, "agent": "a", "action": "x", "params": {"k": 1}}, "events") == [
        {"kind": "event", "text": refs._dumps({"k": 1})}]


def test_blocks_board_events_text_and_raw():
    board = {"id": 1, "thread_id": 1, "thread_title": "t", "author": "a", "body": "hello", "created_at": "x"}
    assert refs.record_blocks(board) == [{"kind": "text", "text": "hello"}]
    assert refs.record_blocks(board, "board") == [{"kind": "text", "text": "hello"}]
    event = {"id": 1, "ts": "x", "agent": "a", "action": "pr.claim", "params": {"pr": 1}}
    assert refs.record_blocks(event) == [{"kind": "event", "text": json.dumps({"pr": 1})}]
    assert refs.record_blocks(event, "events")[0]["kind"] == "event"
    system = {"type": "system", "subtype": "init", "session_id": "s"}
    (raw,) = refs.record_blocks(system)
    assert raw["kind"] == "raw" and json.loads(raw["text"]) == system
    assert refs.record_blocks({"text": "line"}) == [{"kind": "text", "text": "line"}]
    assert refs.record_blocks({"text": "line"}, "prompt") == [{"kind": "text", "text": "line"}]
    assert refs.record_blocks([1, 2]) == [{"kind": "raw", "text": "[\n  1,\n  2\n]"}]
    # assistant/user records without a usable message.content fall back to raw
    assert refs.record_blocks({"type": "assistant", "message": "oops"})[0]["kind"] == "raw"


def test_utf16_slice_counts_like_the_browser():
    text = "a\U0001F600b"  # emoji is 2 UTF-16 units
    assert refs.utf16_slice(text, 0, 1) == "a"
    assert refs.utf16_slice(text, 1, 3) == "\U0001F600"
    assert refs.utf16_slice(text, 3, 4) == "b"
    assert refs.utf16_slice(text, 0, 99) == text
    assert refs.utf16_slice(text, 5, 2) == ""


# --------------------------------------------------------------------------- resolve


@pytest.fixture()
def mini():
    return config.corpus_dir("mini")


def lines(records):
    return [r["line"] for r in records]


def test_resolve_record(mini):
    out = refs.resolve(mini, "agents/agent-01.jsonl#L10")
    assert out["kind"] == "record" and out["path"] == "agents/agent-01.jsonl" and out["line"] == 10
    assert out["record"]["type"] == "assistant"
    assert out["blocks"][0]["kind"] == "text"
    assert out["excerpt"].startswith("The build compiles now")
    assert lines(out["context"]["before"]) == [7, 8, 9]
    assert lines(out["context"]["after"]) == [11, 12, 13]
    assert set(out["context"]["before"][0]) == {"line", "record", "blocks", "meta"}
    meta = out["meta"]
    assert meta["agent"] == "agent-01" and meta["type"] == "assistant"
    assert meta["timestamp"].startswith("2026-03-12T") and meta["session_id"]


def test_resolve_context_at_file_edges(mini):
    assert refs.resolve(mini, "agents/agent-01.jsonl#L1")["context"]["before"] == []
    out = refs.resolve(mini, "agents/agent-01.jsonl#L20")
    assert out["context"]["after"] == [] and lines(out["context"]["before"]) == [17, 18, 19]


def test_resolve_system_and_result_records_are_raw(mini):
    out = refs.resolve(mini, "agents/agent-01.jsonl#L4")
    assert out["record"]["type"] == "system" and out["blocks"][0]["kind"] == "raw"
    assert out["meta"]["subtype"] == "task_notification"
    out = refs.resolve(mini, "agents/agent-03.jsonl#L20")
    assert out["record"]["type"] == "result" and out["blocks"][0]["kind"] == "raw"


def test_resolve_range(mini):
    out = refs.resolve(mini, "agents/agent-01.jsonl#L10-L12")
    assert out["kind"] == "range" and out["line"] == 10 and out["end_line"] == 12
    assert lines(out["records"]) == [10, 11, 12]
    assert out["record"] == out["records"][0]["record"]
    assert "The build compiles now" in out["excerpt"] and "Bash\n" in out["excerpt"]
    assert lines(out["context"]["before"]) == [7, 8, 9] and lines(out["context"]["after"]) == [13, 14, 15]
    # end clamped to the file
    out = refs.resolve(mini, "agents/agent-01.jsonl#L18-L25")
    assert out["end_line"] == 20 and lines(out["records"]) == [18, 19, 20]
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, "agents/agent-01.jsonl#L12-L10")
    assert e.value.status == 400


def test_resolve_block_and_span(mini):
    out = refs.resolve(mini, "agents/agent-01.jsonl#L11.b0")
    assert out["kind"] == "block" and out["block"] == 0
    assert out["blocks"][0]["kind"] == "tool_use" and out["excerpt"] == out["blocks"][0]["text"]
    assert out["excerpt"].startswith("Bash\n{")
    span = refs.resolve(mini, "agents/agent-01.jsonl#L10.b0:c4-9")
    assert span["kind"] == "span" and (span["start"], span["end"]) == (4, 9)
    assert span["excerpt"] == "build"
    text = span["blocks"][0]["text"]
    assert refs.resolve(mini, "agents/agent-01.jsonl#L10.b0:c60-9999")["excerpt"] == text[60:]


def test_resolve_empty_thinking_record_has_no_blocks(mini):
    out = refs.resolve(mini, "agents/agent-01.jsonl#L9")
    assert out["record"]["message"]["content"][0]["type"] == "thinking" and out["blocks"] == []
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, "agents/agent-01.jsonl#L9.b0")
    assert e.value.status == 404


def test_resolve_board_events_text(mini):
    out = refs.resolve(mini, "board.jsonl#L1")
    assert out["blocks"] == [{"kind": "text", "text": out["record"]["body"]}]
    assert out["meta"]["author"] == "agent-01" and out["meta"]["thread_id"] == 1
    out = refs.resolve(mini, "events.jsonl#L18.b0")
    assert out["blocks"][0]["kind"] == "event"
    assert out["excerpt"] == json.dumps(out["record"]["params"]) == '{"ok": true, "pr": 7160}'
    assert out["meta"]["action"] == "pr.claim"
    out = refs.resolve(mini, "prompts/worker.md#L1")
    assert out["record"] == {"text": "# Your role"} and out["excerpt"] == "# Your role" and out["meta"] == {}
    out = refs.resolve(mini, "README.md#L1-L2")
    assert out["kind"] == "range" and out["records"][0]["record"] == {"text": "# mini"}


@pytest.mark.parametrize("ref,status", [
    ("agents/agent-01.jsonl#L99", 404),
    ("agents/agent-01.jsonl#L0", 404),
    ("agents/agent-99.jsonl#L1", 404),
    ("../../etc/passwd#L1", 400),
    ("/etc/passwd#L1", 400),
    ("agents/../../../etc/passwd#L1", 400),
    ("forge.db#L1", 404),
    ("forge.db#nope", 404),
    ("forge.db#nope/1", 404),
    ("forge.db#prs/1", 404),
    ("card:nope", 404),
    ("chat:abcd", 404),
    ("nope.md", 404),
    ("garbage ref", 400),
])
def test_resolve_errors(mini, ref, status):
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, ref)
    assert e.value.status == status and e.value.detail


@pytest.mark.parametrize("ref", ["@out0#L15", "@out1#L3-L5", "#count/total", "@out0"])
def test_a_span_without_its_cell_id_is_never_a_file(mini, ref):
    """A token starting with `@` or `#` names no card, and the file rules never take it for a path: parse_ref refuses it
    in plain words, resolve answers 400 with that cause and names the form, and the files resolver is never consulted."""
    with pytest.raises(ValueError) as pe:
        refs.parse_ref(ref)
    assert str(pe.value).startswith("no card named")
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, ref)
    assert e.value.status == 400
    assert e.value.detail.startswith("no card named") and "no such file" not in e.value.detail
    assert f"card:<id>{ref}" in e.value.detail


def test_resolve_whole_file(mini):
    """A whole-file ref resolves (the chat's link pass links a file the reply names to the file itself): the first lines as the excerpt, the line count in meta; a database file names its tables; a missing
    file is still 404 (test_resolve_errors)."""
    out = refs.resolve(mini, "README.md")
    assert out["kind"] == "path" and out["path"] == "README.md" and out["record"] is None
    assert out["excerpt"].startswith("# ") and out["meta"]["lines"] >= 1 and out["meta"]["kind"] == "text"
    db = refs.resolve(mini, "forge.db")
    assert db["kind"] == "path" and db["excerpt"].startswith("database: ") and "prs" in db["meta"]["tables"]
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, "../README.md")
    assert e.value.status == 400


def test_resolve_a_locator_to_its_file(mini, tmp_path):
    """A `<path>#<locator>` resolves as the whole file does, with the locator carried as `locator` and meta.locator and
    the excerpt the file's own (so the locator's characters never confirm a value-ref). A binary file shows what it is
    rather than raw bytes; a missing file is 404 and a path that escapes the corpus 400, as for any file ref."""
    out = refs.resolve(mini, "README.md#intro")
    whole = refs.resolve(mini, "README.md")
    assert out["kind"] == "path" and out["path"] == "README.md" and out["locator"] == "intro"
    assert out["excerpt"] == whole["excerpt"] and out["meta"] == {**whole["meta"], "locator": "intro"}
    assert "locator" not in whole and "locator" not in whole["meta"]
    db = refs.resolve(mini, "forge.db#1prs")
    assert db["excerpt"].startswith("database: ") and db["locator"] == "1prs"
    (tmp_path / "poster.psd").write_bytes(b"8BPS\x00\x01\x00\x00\x00\x00\x00\x00" + bytes(range(256)) * 4)
    psd = refs.resolve(tmp_path, "poster.psd#layer=Title")
    assert psd["meta"]["binary"] is True and psd["locator"] == "layer=Title" and "8BPS" not in psd["excerpt"]
    (tmp_path / "notes.txt").write_text("one\ntwo\n")
    assert refs.resolve(tmp_path, "notes.txt#two")["excerpt"] == "one\ntwo" and "binary" not in refs.resolve(tmp_path, "notes.txt")["meta"]
    for ref, status in (("nope.pdf#page=2", 404), ("../x.pdf#page=2", 400), ("README.md#L1-2", 400)):
        with pytest.raises(refs.RefError) as e:
            refs.resolve(mini, ref)
        assert e.value.status == status, ref


def test_resolve_forge_rows_and_tables(mini):
    out = refs.resolve(mini, "forge.db#prs/7101")
    assert out["kind"] == "row" and out["table"] == "prs" and out["pk"] == "7101"
    assert out["record"]["number"] == 7101 and out["record"]["state"] == "open"
    assert json.loads(out["excerpt"]) == out["record"] and ": " not in out["excerpt"][:20]
    assert "context" not in out
    # TEXT primary key
    assert refs.resolve(mini, "forge.db#agents/agent-01")["record"]["role"] == "worker"
    # composite pk -> rowid
    out = refs.resolve(mini, "forge.db#pr_closes/1")
    assert out["record"] == {"rowid": 1, "pr": 7101, "issue": 212} and out["meta"]["pk_column"] == "rowid"
    out = refs.resolve(mini, "forge.db#prs")
    assert out["kind"] == "table" and out["record"]["row_count"] == 5 and out["record"]["pk"] == "number"
    assert "number" in out["record"]["columns"] and out["excerpt"] == "prs: 5 rows"


def test_resolve_cell(mini, workspaces_tmp):
    with pytest.raises(refs.RefError):
        refs.resolve(mini, "card:7f3a")
    ws = workspaces_tmp / "mini"
    ws.mkdir()
    cells = [
        {"id": "7f3a", "code": "print(1+1)", "exec_count": 2, "status": "ok", "created_by": "user", "ts": "t",
         "outputs": [{"text/plain": "2\n", "_stream": "stdout"}]},
        {"id": "img1", "code": "plt.plot()", "exec_count": 1, "status": "ok", "created_by": "chat:ab", "ts": "t",
         "outputs": [{"image/png": "iVBORw0KGgo="}]},
        {"id": "err1", "code": "1/0", "exec_count": 3, "status": "error", "created_by": "user", "ts": "t",
         "outputs": [{"application/vnd.thimble.error+json": {"ename": "ZeroDivisionError", "evalue": "division by zero",
                                                             "traceback": []}}]},
        {"id": "new1", "code": "x = 1", "exec_count": None, "status": "idle", "created_by": "user", "ts": "t", "outputs": []},
    ]
    (ws / "notebooks").mkdir()
    (ws / "notebooks" / "main.json").write_text(json.dumps({"id": "main", "title": "Notebook", "ts": "t",
                                                            "cells": [{**c, "notebook": "main"} for c in cells]}))
    out = refs.resolve(mini, "card:7f3a")
    assert out["kind"] == "cell" and out["cell_id"] == "7f3a" and out["excerpt"] == "2\n"
    assert out["record"]["code"] == "print(1+1)" and out["meta"]["exec_count"] == 2
    assert out["notebook"] == "main" and out["meta"]["notebook"] == "main" and out["record"]["notebook"] == "main"
    # cards are searched across every group of the workspace
    (ws / "notebooks" / "nb2.json").write_text(json.dumps({"id": "nb2", "title": "Notebook 2", "ts": "t", "cells": [
        {"id": "beef", "notebook": "nb2", "code": "print('two')", "exec_count": 1, "status": "ok", "created_by": "user",
         "ts": "t", "outputs": [{"text/plain": "two\n", "_stream": "stdout"}]}]}))
    out = refs.resolve(mini, "card:beef")
    assert out["notebook"] == "nb2" and out["excerpt"] == "two\n" and out["record"]["notebook"] == "nb2"
    assert refs.resolve(mini, "card:7f3a")["notebook"] == "main"
    assert "requested_exec" not in refs.resolve(mini, "card:7f3a@2")["meta"]
    assert refs.resolve(mini, "card:7f3a@1")["meta"]["requested_exec"] == 1
    assert refs.resolve(mini, "card:img1")["excerpt"] == "[image]"
    assert refs.resolve(mini, "card:err1")["excerpt"] == "ZeroDivisionError: division by zero"
    assert refs.resolve(mini, "card:new1")["excerpt"] == "x = 1"
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, "card:nope")
    assert e.value.status == 404


def test_resolve_cell_output_line_range(mini, workspaces_tmp):
    """card:<id>@out<i>#L<n>-L<m>: the cited lines with SPAN_CONTEXT_LINES around them, span.text the lines themselves, the end clamped
    to the last line like _resolve_lines, an end before the start malformed, a start past the end span_missing (the
    verifier's failure). report._better_span_for_value reads a range as showing a value when any of its lines does."""
    from app import report

    ws = workspaces_tmp / "mini"
    ws.mkdir()
    (ws / "notebooks").mkdir()
    cells = [{"id": "7f3a", "code": "print(x)", "exec_count": 1, "status": "ok", "created_by": "user", "ts": "t",
              "outputs": [{"text/plain": "l1\nl2\nl3\nl4\nl5\nl6\nl7\n", "_stream": "stdout"}]}]
    (ws / "notebooks" / "main.json").write_text(json.dumps({"id": "main", "cells": cells}))
    out = refs.resolve(mini, "card:7f3a@out0#L3-L4")
    assert out["excerpt"] == "l1\nl2\nl3\nl4\nl5\nl6" and out["meta"]["span"] == {"out": 0, "line": 3, "end_line": 4, "text": "l3\nl4"}
    assert "span_missing" not in out["meta"]
    assert refs.resolve(mini, "card:7f3a@out0#L3")["meta"]["span"] == {"out": 0, "line": 3, "text": "l3"}  # a single line
    clamped = refs.resolve(mini, "card:7f3a@out0#L6-L99")
    assert clamped["meta"]["span"] == {"out": 0, "line": 6, "end_line": 7, "text": "l6\nl7"} and clamped["excerpt"] == "l4\nl5\nl6\nl7"
    assert refs.resolve(mini, "card:7f3a@out0#L9-L10")["meta"].get("span_missing") is True
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, "card:7f3a@out0#L4-L3")
    assert e.value.status == 400
    assert refs.format_ref(refs.parse_ref("card:7f3a@out0#L3-L4")) == "card:7f3a@out0#L3-L4"
    assert report._better_span_for_value(ws, "card:7f3a@out0#L3-L4", "l4") is None  # the range shows it
    assert report._better_span_for_value(ws, "card:7f3a@out0#L3-L4", "l6") == "card:7f3a@out0#L6"


def test_resolve_cell_of_a_registered_corpus_named_dataset(tmp_path, monkeypatch, workspaces_tmp):
    """A folder registered under another name (<bundle>/support-run/dataset as `support-run`) has a workspace that is
    not the folder's basename, so refs map the folder through the registry (config.workspace_for_corpus_dir), never
    through `corpus_dir.name`, for cards and concepts."""
    from app import concepts

    data = tmp_path / "data"
    data.mkdir()
    dataset = tmp_path / "bundle" / "support-run" / "dataset"
    shutil.copytree(config.corpus_dir("mini"), dataset)
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    (data / "support-run.corpus.json").write_text(json.dumps({"name": "support-run", "path": str(dataset),
                                                                "registered_at": "t", "manifest": {"name": "support-run"}}))
    assert config.corpus_dir("support-run") == dataset.resolve()
    assert config.workspace_for_corpus_dir(dataset) == "support-run"
    assert config.workspace_for_corpus_dir(tmp_path / "unregistered") == "unregistered"  # the fallback: fixtures, tests
    ws = workspaces_tmp / "support-run"
    (ws / "notebooks").mkdir(parents=True)
    (ws / "notebooks" / "main.json").write_text(json.dumps({"id": "main", "title": "Notebook", "ts": "t", "cells": [
        {"id": "7f3a", "notebook": "main", "code": "print(1+1)", "exec_count": 2, "status": "ok", "created_by": "user",
         "ts": "t", "outputs": [{"text/plain": "2\n", "_stream": "stdout"}]}]}))
    # a workspace called `dataset` must not be where the lookup lands, even when one exists
    (workspaces_tmp / "dataset" / "notebooks").mkdir(parents=True)
    (workspaces_tmp / "dataset" / "notebooks" / "main.json").write_text(json.dumps({"id": "main", "title": "x", "ts": "t", "cells": []}))
    out = refs.resolve(config.corpus_dir("support-run"), "card:7f3a")
    assert out["kind"] == "cell" and out["cell_id"] == "7f3a" and out["excerpt"] == "2\n"
    assert refs.resolve(dataset, "card:7f3a@out0#L1")["meta"]["span"]["text"] == "2"
    k = concepts.define_concept("support-run", name="Force push", description="d", kind="regex", spec=r"force", created_by="chat:c1")
    assert refs.resolve(dataset, f"concept:{k['id']}")["record"]["name"] == "Force push"
    with pytest.raises(refs.RefError) as e:
        refs.resolve(dataset, "card:nope")
    assert e.value.status == 404


# --------------------------------------------------------------------------- nested corpora


def test_resolve_nested_runs(nested_data):
    nested = config.corpus_dir("nested")
    out = refs.resolve(nested, "run-a/agents/agent-01.jsonl#L10")
    assert out["kind"] == "record" and out["path"] == "run-a/agents/agent-01.jsonl"
    assert out["blocks"][0]["kind"] == "text" and out["excerpt"].startswith("The build compiles now")
    assert out["meta"]["agent"] == "agent-01" and out["meta"]["session_id"]
    out = refs.resolve(nested, "run-b/board.jsonl#L1")
    assert out["blocks"] == [{"kind": "text", "text": out["record"]["body"]}] and out["meta"]["author"] == "agent-01"
    assert refs.resolve(nested, "run-a/events.jsonl#L18.b0")["blocks"][0]["kind"] == "event"
    assert refs.resolve(nested, "run-a/prompts/worker.md#L1")["excerpt"] == "# Your role"
    assert refs.resolve(nested, "README.md#L1")["excerpt"] == "# nested"
    # nested forge refs resolve against that run's database and report the nested path
    out = refs.resolve(nested, "run-b/forge.db#prs/7101")
    assert out["kind"] == "row" and out["path"] == "run-b/forge.db" and out["record"]["number"] == 7101
    out = refs.resolve(nested, "run-a/forge.db#prs")
    assert out["kind"] == "table" and out["path"] == "run-a/forge.db" and out["excerpt"] == "prs: 5 rows"
    # errors: no root forge.db in a nested corpus, missing run, escape attempts
    for ref, status in [("forge.db#prs/1", 404), ("run-z/forge.db#prs/1", 404), ("run-a/forge.db#nope", 404),
                        ("../mini/forge.db#prs/7101", 400), ("run-a/forge.db#L1", 404), ("run-a/agents/agent-01.jsonl#L99", 404)]:
        with pytest.raises(refs.RefError) as e:
            refs.resolve(nested, ref)
        assert e.value.status == status, ref
    # the flat corpus still works in the same DATA_DIR
    assert refs.resolve(config.corpus_dir("mini"), "forge.db#prs/7101")["path"] == "forge.db"


@pytest.fixture()
def databases(tmp_path, monkeypatch, mini_dir):
    """Corpus `dbs`: a copy of mini (so it has the root forge.db) plus `runs/x/other.db` (a real database) and
    `bad.db` (garbage bytes). Returns the corpus dir."""
    import sqlite3
    from contextlib import closing

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "dbs")
    other = data / "dbs" / "runs" / "x" / "other.db"
    other.parent.mkdir(parents=True)
    with closing(sqlite3.connect(other)) as con:
        con.executescript("CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT);"
                          "INSERT INTO patients VALUES (12, 'Ada'), (13, 'Grace');"
                          "CREATE TABLE visits (patient INTEGER, day TEXT); INSERT INTO visits VALUES (12, '2026-01-01');")
    (data / "dbs" / "bad.db").write_bytes(b"not a database\n" * 8)
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return config.corpus_dir("dbs")


def test_resolve_rows_and_tables_of_any_database(databases):
    out = refs.resolve(databases, "runs/x/other.db#patients/12")
    assert out["kind"] == "row" and out["path"] == "runs/x/other.db" and out["record"] == {"id": 12, "name": "Ada"}
    assert out["meta"] == {"table": "patients", "pk_column": "id"} and json.loads(out["excerpt"]) == out["record"]
    assert out["ref"] == refs.format_ref(refs.parse_ref(out["ref"])) == "runs/x/other.db#patients/12"
    assert refs.resolve(databases, "runs/x/other.db#visits/1")["record"] == {"rowid": 1, "patient": 12, "day": "2026-01-01"}
    out = refs.resolve(databases, "runs/x/other.db#patients")
    assert out["kind"] == "table" and out["excerpt"] == "patients: 2 rows" and out["record"]["pk"] == "id"
    assert refs.resolve(databases, "forge.db#prs/7101")["record"]["number"] == 7101  # the root forge.db is one of them
    for ref, status, needle in [("runs/x/other.db#patients/99", 404, "no row"), ("runs/x/other.db#prs", 404, "no such table"),
                                ("runs/y/none.db#t/1", 404, "corpus has no"), ("../mini/forge.db#prs/1", 400, "escapes"),
                                ("bad.db#t/1", 400, "SQLite"), ("runs/x/other.db#L1-L2", 400, "database file")]:
        with pytest.raises(refs.RefError) as e:
            refs.resolve(databases, ref)
        assert e.value.status == status and needle in e.value.detail, ref
    # the line-style refusal speaks of a database file, not of forge.db
    with pytest.raises(refs.RefError) as e:
        refs.resolve(databases, "runs/x/other.db#L1.b0")
    assert e.value.status == 400 and "database file" in e.value.detail and "forge.db" not in e.value.detail


def test_concept_refs(mini, workspaces_tmp):
    """`concept:<id>` parses, formats and resolves to the concept card via app.concepts."""
    from app import concepts

    assert refs.parse_ref("concept:k0ncept1") == {"kind": "concept", "concept_id": "k0ncept1"}
    assert refs.format_ref({"kind": "concept", "concept_id": "k0ncept1"}) == "concept:k0ncept1"
    assert refs.extract_refs("see [[concept:k0ncept1]] and [[card:7f3a]]") == ["concept:k0ncept1", "card:7f3a"]
    with pytest.raises(ValueError):
        refs.parse_ref("concept:")
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, "concept:deadbeef")
    assert e.value.status == 404
    k = concepts.define_concept("mini", name="Force push", description="an agent force-pushes", kind="regex",
                                spec=r"(?i)force.?push", created_by="chat:c1")
    out = refs.resolve(mini, f"concept:{k['id']}")
    assert out["kind"] == "concept" and out["concept_id"] == k["id"] and out["ref"] == f"concept:{k['id']}"
    assert out["record"]["name"] == "Force push" and out["meta"]["name"] == "Force push" and out["meta"]["kind"] == "regex"
    assert "Force push" in out["excerpt"]


def test_a_label_value_ref_parses_and_formats_and_a_model_s_own_form_says_the_right_one():
    """`concept:<id>/<value>` names one value of a label, raw or encoded as a td label is; `label:<name>/<value>`, a
    form a model may write, is refused with the form to use."""
    assert refs.parse_ref("concept:k1/refund request") == {"kind": "concept", "concept_id": "k1", "value": "refund request"}
    assert refs.parse_ref("concept:k1/late%20or%20missing")["value"] == "late or missing"
    assert refs.format_ref(refs.parse_ref("concept:k1/refund request")) == "concept:k1/refund request"
    assert refs.extract_refs("[[19|concept:k1/refund request]] of 30") == ["concept:k1/refund request"]
    with pytest.raises(ValueError) as e:
        refs.parse_ref("label:what the ticket asks for/refund request")
    assert "concept:<id>/<value>" in str(e.value)


def test_text_kind_structured_record_never_empty():
    """A jsonl typed `text` whose records are {ts, agent, kind, payload} never yields an empty excerpt."""
    from app.refs import record_blocks
    rec = {"ts": 1.0, "agent": "session-1", "kind": "assistant", "payload": {"content": "I will edit webhook.py"}}
    assert record_blocks(rec, "text") == [{"kind": "text", "text": "I will edit webhook.py"}]
    rec2 = {"ts": 1.0, "kind": "start", "payload": {"max_turns": 40}}
    blocks = record_blocks(rec2, "text")
    assert blocks and blocks[0]["text"].strip() and "max_turns" in blocks[0]["text"]
    assert record_blocks({"text": "plain"}, "text") == [{"kind": "text", "text": "plain"}]


def test_a_report_ref_resolves_to_the_title_a_paragraph_or_a_sentence(mini):
    """`report:<slug>` is the document's title, `#p<pid>` a paragraph's sentences joined, `#<sid>` one sentence (with its
    refs in meta) and a heading id its heading; a missing document or unit is a 404 RefError."""
    from app import investigation, report_types

    doc = {"id": "report", "type": "report", "renderer": "document", "title": "The board as a relay", "generation": 1,
           "sections": [{"id": "s1", "heading": "The data", "paragraphs": [{"id": "pp1", "sentences": [
               {"id": "a1", "text": "The export holds 8 posts.", "refs": ["README.md#L3"], "tags": []},
               {"id": "a2", "text": "One thread holds most of them.", "refs": [], "tags": []}]}]}]}
    report_types.write_doc("mini", investigation.MAIN, "report", doc)
    corpus = mini
    assert refs.resolve(corpus, "report:report")["excerpt"] == "The board as a relay"
    para = refs.resolve(corpus, "report:report#ppp1")
    assert para["excerpt"] == "The export holds 8 posts. One thread holds most of them." and para["meta"]["section"] == "The data"
    sent = refs.resolve(corpus, "report:report#a2")
    assert sent["kind"] == "report" and sent["excerpt"] == "One thread holds most of them." and sent["meta"]["refs"] == []
    assert refs.resolve(corpus, "report:report#s1")["excerpt"] == "The data"
    with pytest.raises(refs.RefError) as e:
        refs.resolve(corpus, "report:report#nope")
    assert e.value.status == 404
    with pytest.raises(refs.RefError):
        refs.resolve(corpus, "report:story#a1")


def test_a_view_ref_with_no_such_view_is_404_and_a_bad_slug_is_no_ref(tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "WORKSPACES_DIR", tmp_path / "ws")
    with pytest.raises(refs.RefError) as e:
        refs.resolve(config.corpus_dir("mini"), "view:boards/p1")
    assert e.value.status == 404
    with pytest.raises(ValueError):
        refs.parse_ref("view:Bad_Slug/x")


def test_a_file_line_cited_through_its_card_reads_and_resolves_as_the_line(mini):
    """A model cites an example card's excerpt as `card:<id>#<path>#L<n>…`. That is no td of the card (a td reader would
    take the path's first folder for a column), so it parses, formats and resolves as the file's line it names, and
    opens there."""
    ref = "card:ef56ab12#agents/agent-01.jsonl#L10.b0:c4-9"
    assert refs.parse_ref(ref) == refs.parse_ref("agents/agent-01.jsonl#L10.b0:c4-9")
    assert refs.format_ref(refs.parse_ref(ref)) == "agents/agent-01.jsonl#L10.b0:c4-9"
    assert refs.parse_ref("card:ef56ab12#agents/agent-01.jsonl#L10")["kind"] == "record"
    span = refs.resolve(mini, ref)
    assert span["kind"] == "span" and span["excerpt"] == "build"
    # a td whose labels hold no line form is still the card's td
    assert refs.parse_ref("card:ef56ab12#runs/agent-01")["col"] == "runs"
