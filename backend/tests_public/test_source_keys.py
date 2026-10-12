"""The keys a file's records can be coloured by in the File browser's Transcript mode (app/source_keys.py): over the whole
file, the keys that name a kind (few values) or a who (values that come back on several records), never one that names
each record (an id, a time) or holds texts or nested values; their values with counts, and where they fall in bins of
the file's lines; a CSV file's columns; a file of another kind has none; the route refuses a path outside the corpus.
A transcript's turns give their fields as keys too: an ATIF trajectory's steps (a whole-file JSON transcript, whose
turns stand on their lines), a Claude Code stream's messages beside its records' own keys, a text chat log's speakers."""
import json
import shutil

import pytest
from fastapi.testclient import TestClient

from app import source_keys
from app.main import app

client = TestClient(app)
CORPUS = "/api/corpora/keyed"


def rows(n: int) -> list[dict]:
    out = []
    for i in range(n):
        out.append({
            "id": f"r{i}",  # one per record
            "time": f"2026-06-18T20:{i // 60:02d}:{i % 60:02d}Z",  # one per record
            "type": "post" if i < n // 2 else "edit",  # two values, the first half then the second
            "user": f"u{i % 10}",  # ten users, each on many records
            "body": "x" * 200,  # a long text
            "meta": {"a": 1},  # nested
            "lane": None if i % 4 else "fast",  # one value and none: not a kind
        })
    return out


@pytest.fixture()
def keyed(tmp_path, monkeypatch, mini_dir):
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "keyed")
    root = data / "keyed"
    (root / "posts.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows(400)))
    (root / "table.csv").write_text("who,score,kind\n" + "".join(f"p{i % 3},{i},{'a' if i % 2 else 'b'}\n" for i in range(90)))
    (root / "notes.md").write_text("# notes\n\nplain text\n")
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    monkeypatch.setattr(source_keys, "_cache", type(source_keys._cache)())
    return root


def test_the_keys_that_name_a_kind_or_a_who_over_the_whole_file(keyed):
    got = client.get(f"{CORPUS}/source/keys", params={"path": "posts.jsonl", "bins": 4}).json()
    assert got["total"] == 400 and not got["partial"]
    keys = {k["key"]: k for k in got["keys"]}
    assert set(keys) == {"type", "user"}
    assert keys["type"]["values"] == [{"value": "post", "n": 200}, {"value": "edit", "n": 200}] or keys["type"]["values"] == [{"value": "edit", "n": 200}, {"value": "post", "n": 200}]
    ranks = {v["value"]: i for i, v in enumerate(keys["type"]["values"])}
    # the first half of the file is posts, the second edits
    assert keys["type"]["at"] == [ranks["post"], ranks["post"], ranks["edit"], ranks["edit"]]
    assert len(keys["user"]["values"]) == 10 and keys["user"]["none"] == 0
    assert len(got["bytes"]) == 4 and sum(got["bytes"]) == (keyed / "posts.jsonl").stat().st_size


def test_a_csv_file_s_columns(keyed):
    got = client.get(f"{CORPUS}/source/keys", params={"path": "table.csv"}).json()
    keys = {k["key"]: k for k in got["keys"]}
    # the scores are a number per row
    assert set(keys) == {"who", "kind"}
    assert sum(v["n"] for v in keys["who"]["values"]) == 90 and keys["who"]["none"] == 0


def test_a_file_of_another_kind_has_no_keys_and_a_path_outside_is_refused(keyed):
    assert client.get(f"{CORPUS}/source/keys", params={"path": "notes.md"}).json()["keys"] == []
    assert client.get(f"{CORPUS}/source/keys", params={"path": "../x.jsonl"}).status_code == 400


def test_many_values_list_the_commonest_and_count_the_rest(tmp_path, monkeypatch):
    monkeypatch.setattr(source_keys, "VALUES_LISTED", 5)
    p = tmp_path / "pages.jsonl"
    p.write_text("".join(json.dumps({"page": f"p{i % 40}"}) + "\n" for i in range(400)))
    got = source_keys.scan(p, 10)
    (page,) = got["keys"]
    assert len(page["values"]) == 5 and page["more"] == {"values": 35, "n": 350}


def atif() -> dict:
    """A synthetic ATIF-v1.7 trajectory (Harbor's trajectory.json): a system and a user step, agent steps by two models
    that call tools (one calls two), a follow-up from the user, and a last answer that calls none."""
    def agent(i, model, effort, phase, message, calls=()):
        step = {"step_id": i, "timestamp": f"2026-09-10T21:58:{i:02d}Z", "source": "agent", "model_name": model,
                "reasoning_effort": effort, "message": message, "llm_call_count": 1, "extra": {"phase": phase},
                "metrics": {"prompt_tokens": 1000 + 97 * i, "completion_tokens": 40 + i, "cost_usd": 0.001 * i}}
        if calls:
            step["tool_calls"] = [{"tool_call_id": f"call_{i}_{n}", "function_name": name, "arguments": {"command": "ls"}}
                                  for n, name in enumerate(calls)]
            step["observation"] = {"results": [{"source_call_id": f"call_{i}_{n}", "content": "ok"} for n in range(len(calls))]}
        if i == 3:
            step["reasoning_content"] = "List the folder before writing anything."
        return step

    steps = [
        {"step_id": 1, "timestamp": "2026-09-10T21:58:01Z", "source": "system", "message": "You are a coding agent in /app."},
        {"step_id": 2, "timestamp": "2026-09-10T21:58:02Z", "source": "user", "message": "Write hello.py and a test for it."},
        agent(3, "model-a", "high", "explore", "I'll look at the folder first.", ["bash"]),
        agent(4, "model-a", "medium", "edit", "Writing the script and running it.", ["write_file", "bash"]),
        {"step_id": 5, "timestamp": "2026-09-10T21:58:05Z", "source": "user", "message": "Also greet the world by default."},
        agent(6, "model-b", "low", "explore", "Reading the script again.", ["read_file"]),
        agent(7, "model-a", "medium", "edit", "Changing the default.", ["write_file"]),
        agent(8, "model-a", "low", "report", "Done: both tests pass."),
    ]
    tools = [{"type": "function", "function": {"name": n, "parameters": {"type": "object", "properties": {}}}}
             for n in ("bash", "read_file", "write_file")]
    return {"schema_version": "ATIF-v1.7", "session_id": "s-1",
            "agent": {"name": "toy-agent", "version": "0.1", "model_name": "model-a", "tool_definitions": tools},
            "steps": steps, "final_metrics": {"total_steps": len(steps)}}


def test_an_atif_trajectory_s_steps_give_their_fields_as_keys(keyed):
    """Harbor's trajectory.json is one JSON document: its lines are no records, its steps are. Each step is a turn on
    the line that holds its words, with its source, model, effort, metadata and the tools it calls as keys; never its
    id, its time, its words or its reasoning. GET /source/turns gives each turn those fields, which Color by reads."""
    (keyed / "run").mkdir()
    traj = keyed / "run" / "trajectory.json"
    traj.write_text(json.dumps(atif(), indent=2) + "\n")
    got = client.get(f"{CORPUS}/source/keys", params={"path": "run/trajectory.json", "bins": 8}).json()
    keys = {k["key"]: k for k in got["keys"]}
    assert {"source", "model_name", "reasoning_effort", "extra.phase", "tool"} <= set(keys), keys
    assert not set(keys) & {"step_id", "timestamp", "message", "reasoning_content", "schema_version", "session_id"}
    assert keys["source"]["values"] == [{"value": "agent", "n": 5}, {"value": "user", "n": 2}, {"value": "system", "n": 1}]
    assert keys["source"]["none"] == 0
    assert keys["model_name"]["values"] == [{"value": "model-a", "n": 4}, {"value": "model-b", "n": 1}]
    assert keys["model_name"]["none"] == 3, "the system and user steps name no model"
    # a step that calls two tools names both
    assert {v["value"]: v["n"] for v in keys["tool"]["values"]} == {"write_file": 1, "bash": 1, "write_file, bash": 1, "read_file": 1}
    assert keys["tool"]["none"] == 4
    raw = traj.read_text()
    assert got["total"] == raw.count("\n") and sum(got["bytes"]) == len(raw.encode())

    turns = client.get(f"{CORPUS}/source/turns", params={"path": "run/trajectory.json"}).json()["turns"]
    assert [t["fields"]["source"] for t in turns] == ["system", "user", "agent", "agent", "user", "agent", "agent", "agent"]
    assert turns[3]["fields"] == {"source": "agent", "model_name": "model-a", "reasoning_effort": "medium",
                                  "llm_call_count": 1, "extra.phase": "edit", "tool": "write_file, bash"}
    # the bins follow the lines the turns stand on: the agent's tool definitions at the top hold none
    total = got["total"]
    lit = {(t["line"] - 1) * 8 // total for t in turns}
    assert [b for b, r in enumerate(keys["source"]["at"]) if r != -1] == sorted(lit)
    assert keys["source"]["at"][0] == -1


def test_a_stream_keeps_its_own_keys_and_gains_its_messages_model_and_tools(keyed):
    """A Claude Code stream's records keep their own keys (`type`), and their turns add the model the message names and
    the tools it calls, which the source page gives each record beside its own keys (`meta.fields`)."""
    def assistant(i, model, blocks):
        return {"type": "assistant", "uuid": f"u{i}", "session_id": "s", "timestamp": f"2026-09-10T21:00:{i:02d}Z",
                "message": {"id": f"msg_{i}", "role": "assistant", "model": model, "content": blocks}}

    def user(i, content):
        return {"type": "user", "uuid": f"u{i}", "session_id": "s", "timestamp": f"2026-09-10T21:00:{i:02d}Z",
                "message": {"role": "user", "content": content}}

    rows = [user(0, "Why does the build fail?"),
            assistant(1, "model-a", [{"type": "text", "text": "Reading the log."},
                                     {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "tail ci.log"}}]),
            user(2, [{"type": "tool_result", "tool_use_id": "t1", "content": "1 failed"}]),
            assistant(3, "model-b", [{"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "a.py"}}]),
            assistant(4, "model-a", [{"type": "text", "text": "The NaN key."}])]
    (keyed / "session.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    got = client.get(f"{CORPUS}/source/keys", params={"path": "session.jsonl"}).json()
    keys = {k["key"]: k for k in got["keys"]}
    assert keys["type"]["values"] == [{"value": "assistant", "n": 3}, {"value": "user", "n": 2}], "its own key, as before"
    assert keys["message.model"]["values"] == [{"value": "model-a", "n": 2}, {"value": "model-b", "n": 1}]
    assert keys["tool"]["values"] == [{"value": "Bash", "n": 1}, {"value": "Read", "n": 1}] and keys["tool"]["none"] == 3
    assert "message.id" not in keys, "a turn field never names one record"
    page = client.get(f"{CORPUS}/source", params={"path": "session.jsonl"}).json()
    fields = [r["meta"].get("fields") for r in page["records"]]
    assert fields[1] == {"message.role": "assistant", "message.model": "model-a", "tool": "Bash"}
    assert fields[3]["tool"] == "Read" and "type" not in fields[3], "a record's own keys stay its own"


def test_a_text_chat_log_s_speakers_are_a_key(keyed):
    """A text chat log's records are its lines: who starts each turn is the key, on the line the turn starts on, and the
    source page gives that line its `meta.fields`."""
    (keyed / "chat.txt").write_text("User: hi there\nAssistant: hello\nmore of the reply\nUser: a joke\nAssistant: no\n")
    got = client.get(f"{CORPUS}/source/keys", params={"path": "chat.txt"}).json()
    (speaker,) = got["keys"]
    assert speaker["key"] == "speaker" and speaker["none"] == 0
    assert speaker["values"] == [{"value": "User", "n": 2}, {"value": "Assistant", "n": 2}]
    page = client.get(f"{CORPUS}/source", params={"path": "chat.txt"}).json()
    assert [r["meta"].get("fields") for r in page["records"]] == [
        {"speaker": "User"}, {"speaker": "Assistant"}, None, {"speaker": "User"}, {"speaker": "Assistant"}]
