"""An agent's event log as a transcript (readers/transcripts.py): JSON lines keyed by what each record is (`kind`,
`type`, `event`), with the task the agent was given, its messages, its tool calls and their results, and notes such as a
review. The sniff offers the Transcript mode for it, and a page of its records says who stands for each one: the task
is the person's turn, a tool call or its result is a block of the agent's turn under the agent's name, and a note names
no one, so the page heads it by its kind."""
import json
from pathlib import Path

from thimble_browser.readers import transcripts

LOG = [
    {"at": "2026-05-02T10:00:00", "kind": "task", "text": "Add a dark theme to the settings page."},
    {"at": "2026-05-02T10:00:05", "kind": "message", "role": "agent", "text": "I will look at the styles first."},
    {"at": "2026-05-02T10:00:09", "kind": "tool_call", "tool": "search", "args": {"pattern": "theme"}},
    {"at": "2026-05-02T10:00:12", "kind": "tool_result", "tool": "search", "ok": True, "text": "styles/app.css: 4 matches"},
    {"at": "2026-05-02T10:00:20", "kind": "tool_call", "tool": "edit", "args": {"path": "styles/app.css"}},
    {"at": "2026-05-02T10:00:24", "kind": "tool_result", "tool": "edit", "ok": True, "text": "2 changes"},
    {"at": "2026-05-02T10:01:00", "kind": "message", "role": "agent", "text": "The page now follows the system theme."},
    {"at": "2026-05-02T10:02:00", "kind": "review", "reviewer": "Pat Lindqvist", "verdict": "approved"},
    {"at": "2026-05-02T10:02:10", "kind": "end", "outcome": "merged"},
]


def write(tmp: Path, records: list[dict]) -> Path:
    p = tmp / "runs" / "run-07.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(json.dumps(r) + "\n" for r in records))
    return p


def test_an_event_log_of_an_agent_run_is_offered_the_transcript_mode(tmp_path):
    p = write(tmp_path, LOG)
    hint = transcripts.sniff(p, "runs/run-07.jsonl")
    assert hint is not None and hint["format"] == "messages"
    assert hint["keys"]["speaker"] == "role" and hint["keys"]["text"] == "text"


def test_the_same_log_keyed_by_type_or_event_is_offered_it_too(tmp_path):
    for key in ("type", "event"):
        recs = [{(key if k == "kind" else k): v for k, v in r.items()} for r in LOG]
        p = write(tmp_path, recs)
        assert transcripts.sniff(p, "runs/run-07.jsonl") is not None, key


def test_a_page_of_the_log_names_who_stands_for_each_record(tmp_path):
    p = write(tmp_path, LOG)
    records = [{"line": i + 1, "record": r} for i, r in enumerate(LOG)]
    page = transcripts.dress({"records": records}, p, "runs/run-07.jsonl")
    meta = [r.get("meta") or {} for r in page["records"]]
    # the task is the person's turn, under the name the log gives it
    assert meta[0]["speaker"] == "task" and transcripts._role("task") == "user"
    # a message names its speaker itself, so the page adds no name
    assert "speaker" not in meta[1]
    # tool calls and their results are blocks of the agent's turn, under the agent's name
    assert meta[2]["speaker"] == "agent" and meta[2]["blocks"][0]["kind"] == "tool_use"
    assert meta[2]["blocks"][0]["text"].startswith("search\n")
    assert meta[3]["speaker"] == "agent" and meta[3]["blocks"] == [{"kind": "tool_result",
                                                                    "text": "styles/app.css: 4 matches"}]
    # a note (a review, the end) names no one: the page heads it by its kind
    assert "speaker" not in meta[7] and "speaker" not in meta[8]


def test_a_table_with_a_kind_column_and_no_turns_is_not_offered_it(tmp_path):
    rows = [{"kind": "invoice", "id": i, "amount": 10 * i, "text": f"order {i}"} for i in range(1, 9)]
    p = write(tmp_path, rows)
    assert transcripts.sniff(p, "runs/run-07.jsonl") is None
