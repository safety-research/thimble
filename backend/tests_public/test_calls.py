"""calls.py and call_ref.py: the orientation's calls, stored whole and citable. One
sequence of numbers per orientation chat, keyed by tool_use_id so a number never changes; the whole output kept, a long
one Claude Code saved to a file included; `call:<chat>/<n>` and `call:<chat>/<n>#L<a>-L<b>` resolve, read and check
like a file line; the call-ref hook tells the model the ref of each call it made; an orientation from before the store
gets one from its transcript; the critique's digest and `chat:` refs name calls by their refs; and the coverage checks
count a corpus path a call named as read."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import httpx
import pytest

from app import agent_session, agents, call_ref, calls, config, critique_session, orient_checks, refs, session, tools, verify
from app.main import create_app

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    calls.forget()
    agent_session._runs.clear()
    yield
    calls.forget()
    agent_session._runs.clear()


def _chat() -> str:
    return str(agents.new_agent(CORPUS, "orient", "Orientation", session="s-1")["id"])


# --------------------------------------------------------------------------- the store


def test_a_call_keeps_its_number_and_its_output_is_stored_once_and_read_back_after_a_restart():
    chat = _chat()
    assert calls.number(CORPUS, chat, "t1", "Bash", {"command": "wc -l runs.jsonl"}, at=chat) == 1
    assert calls.number(CORPUS, chat, "t2", "Read", {"file_path": "runs.jsonl"}, at=chat) == 2
    assert calls.number(CORPUS, chat, "t1", "Bash", {"command": "wc -l runs.jsonl"}) == 1, "the same call, the same number"
    assert calls.result(CORPUS, chat, "t1", "12 runs.jsonl\n") == 1
    assert calls.result(CORPUS, chat, "t1", "something else") == 1
    assert calls.result(CORPUS, chat, "nope", "x") is None, "a call not numbered stores nothing"
    calls.forget()  # a restart: the file is the record
    row = calls.get(CORPUS, chat, 1)
    assert row["name"] == "Bash" and row["result"] == "12 runs.jsonl\n" and row["chat"] == chat
    assert calls.number(CORPUS, chat, "t3", "Grep", {"pattern": "x"}) == 3, "numbers go on after the stored ones"
    lines = calls.path(CORPUS, chat).read_text().splitlines()
    assert sum(1 for ln in lines if '"result"' in ln) == 1, "the store is append-only and each result is written once"


def test_the_hook_s_number_comes_first_and_the_follower_adds_the_chat_that_holds_the_record():
    chat = _chat()
    n = calls.number(CORPUS, chat, "t9", "Bash", {"command": "ls"}, agent="a1")
    assert calls.get(CORPUS, chat, n)["chat"] is None
    assert calls.number(CORPUS, chat, "t9", "Bash", {"command": "ls"}, agent="a1", at="stepchat") == n
    calls.forget()
    assert calls.get(CORPUS, chat, n)["chat"] == "stepchat"
    assert calls.listing(CORPUS, chat)[0] == {"n": n, "id": "t9", "chat": "stepchat", "name": "Bash", "line": "ls",
                                               "done": False, "is_error": False, "agent": "a1"}


def test_a_long_output_claude_code_saved_to_a_file_is_stored_whole(tmp_path):
    sid = "5e505c4b-742a-4361-9a19-808f80f408cc"
    slug = tmp_path / "projects" / "-corpus"
    (slug / sid / "tool-results").mkdir(parents=True)
    (slug / f"{sid}.jsonl").write_text("")
    saved = slug / sid / "tool-results" / "b1.txt"
    saved.write_text("\n".join(str(i) for i in range(1, 50001)))
    rec = {"sessionId": sid, "toolUseResult": {"persistedOutputPath": str(saved)}}
    assert calls.result_text({"type": "tool_result", "content": "short"}, rec).startswith("1\n2\n3")
    assert calls.result_text({"type": "tool_result", "content": [{"type": "text", "text": "plain"}]}, {}) == "plain"


def test_only_a_file_in_the_session_s_own_tool_results_folder_is_read(tmp_path):
    """A result's text can say anything (a tool printed a file that starts with <persisted-output>), and a record's path
    is read only inside the tool-results folder of that record's session."""
    sid, other = "5e505c4b-742a-4361-9a19-808f80f408cc", "9c0a1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3"
    slug = tmp_path / "projects" / "-corpus"
    for s in (sid, other):
        (slug / s / "tool-results").mkdir(parents=True)
        (slug / f"{s}.jsonl").write_text("")
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET")
    (slug / other / "tool-results" / "o.txt").write_text("SECRET")
    (slug / sid / "tool-results" / "link.txt").symlink_to(secret)
    (tmp_path / "loose" / sid / "tool-results").mkdir(parents=True)
    (tmp_path / "loose" / sid / "tool-results" / "x.txt").write_text("SECRET")
    preview = f"<persisted-output>\nOutput too large (1.9MB). Full output saved to: {secret}\n\nPreview (first 2KB):\n1"
    assert calls.result_text({"type": "tool_result", "content": preview}, {"sessionId": sid}) == preview
    for path in (secret, slug / other / "tool-results" / "o.txt", slug / sid / "tool-results" / "link.txt",
                 slug / sid / "tool-results" / ".." / ".." / other / "tool-results" / "o.txt",
                 tmp_path / "loose" / sid / "tool-results" / "x.txt", "tool-results/o.txt"):
        rec = {"sessionId": sid, "toolUseResult": {"persistedOutputPath": str(path)}}
        assert calls.result_text({"type": "tool_result", "content": "preview"}, rec) == "preview", path
    rec = {"sessionId": "../x", "toolUseResult": {"persistedOutputPath": str(secret)}}
    assert calls.result_text({"type": "tool_result", "content": "preview"}, rec) == "preview"


def test_output_lines_split_at_newlines_only_as_the_browser_numbers_them():
    assert calls.lines_of("a\nb\n") == ["a", "b"]
    assert calls.lines_of("a\x0cb\nc") == ["a\x0cb", "c"], "a form feed opens no line"
    assert calls.lines_of("") == []


def test_the_chip_line_reads_like_the_command():
    root = str(config.corpus_dir(CORPUS))
    assert calls.chip_line("Bash", {"command": "grep -c refund tickets/\n| sort"}) == "grep -c refund tickets/ | sort"
    assert calls.chip_line("Grep", {"pattern": "refund", "path": "tickets/"}) == "grep refund tickets/"
    assert calls.chip_line("Read", {"file_path": f"{root}/runs.jsonl"}, root) == "Read runs.jsonl"
    assert calls.chip_line("mcp__plugin_thimble_thimble__add_card", {"description": "a count"}) == "add_card a count"
    work = config.workspace_dir(CORPUS) / "orient" / "work"
    long = f"python3 {work}/followup.py > {root}/x"
    assert calls.chip_line("Bash", {"command": long}, calls._root(CORPUS)) == "python3 orient/work/followup.py > x", \
        "a script in the work folder reads as the thread's Write chip names it"


# --------------------------------------------------------------------------- refs


def _stored(text: str) -> tuple[str, int]:
    chat = _chat()
    n = calls.number(CORPUS, chat, "tb", "Bash", {"command": "python count.py"}, at=chat)
    calls.result(CORPUS, chat, "tb", text)
    return chat, n


def test_a_call_ref_parses_formats_and_resolves_to_the_call_or_exactly_its_cited_lines():
    chat, n = _stored("kinds\nrefund 4,120\nfailure 310\n")
    ref = f"call:{chat}/{n}#L2-L3"
    assert refs.format_ref(refs.parse_ref(ref)) == ref
    assert refs.format_ref(refs.parse_ref(f"call:{chat}/{n}")) == f"call:{chat}/{n}"
    corpus = config.corpus_dir(CORPUS)
    whole = refs.resolve(corpus, f"call:{chat}/{n}")
    assert whole["kind"] == "call" and whole["excerpt"].startswith("$ python count.py\nkinds")
    one = refs.resolve(corpus, f"call:{chat}/{n}#L2")
    assert one["excerpt"] == "refund 4,120" and one["meta"]["span"] == {"line": 2, "end_line": 2, "text": "refund 4,120"}
    assert refs.resolve(corpus, ref)["excerpt"] == "refund 4,120\nfailure 310"
    assert refs.resolve(corpus, f"call:{chat}/{n}#L9")["meta"]["span_missing"] is True
    with pytest.raises(refs.RefError) as e:
        refs.resolve(corpus, f"call:{chat}/{n}#L3-L2")
    assert e.value.status == 400
    with pytest.raises(refs.RefError) as e:
        refs.resolve(corpus, f"call:{chat}/99")
    assert e.value.status == 404
    with pytest.raises(refs.RefError) as e:
        refs.resolve(corpus, "call:abc")
    assert e.value.status == 400


async def test_a_takeaway_s_call_citation_is_checked_against_the_cited_lines_like_a_file_line():
    chat, n = _stored("kinds\nrefund 4,120\nfailure 310\n")
    corpus = config.corpus_dir(CORPUS)
    assert await verify._ref_check(corpus, f"call:{chat}/{n}#L2", "4,120") is None
    assert await verify._ref_check(corpus, f"call:{chat}/{n}#L3", "4,120") is not None, "the number is not on that line"
    assert await verify._ref_check(corpus, f"call:{chat}/{n}#L7", "4,120") == verify.WHY_SPAN_MISSING


async def test_read_ref_reads_a_call_whole_with_its_output_numbered():
    chat, n = _stored("kinds\nrefund 4,120\n")
    res = await tools.call(CORPUS, "read_ref", {"ref": f"call:{chat}/{n}"})
    assert not res.is_error, res.text
    assert "python count.py" in res.text and "2\trefund 4,120" in res.text
    one = await tools.call(CORPUS, "read_ref", {"ref": f"call:{chat}/{n}#L2"})
    assert "2\trefund 4,120" in one.text and "1\tkinds" not in one.text
    gone = await tools.call(CORPUS, "read_ref", {"ref": f"call:{chat}/42"})
    assert gone.is_error


# --------------------------------------------------------------------------- routes and the hook


async def test_the_routes_list_the_calls_and_give_one_whole_and_the_hook_route_numbers_a_session_s_call():
    chat, n = _stored("one\ntwo\n")
    app = create_app()
    run = agent_session.Run(CORPUS, "orient", chat, "sid", config.corpus_dir(CORPUS), "orient")
    run.calls = chat
    agent_session._runs[(CORPUS, "orient")] = run
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        listed = (await client.get(f"/api/ws/{CORPUS}/calls/{chat}")).json()
        assert [c["n"] for c in listed] == [n]
        one = (await client.get(f"/api/ws/{CORPUS}/calls/{chat}/{n}")).json()
        assert one["result"] == "one\ntwo\n" and one["ref"] == f"call:{chat}/{n}" and one["chat"] == chat
        assert (await client.get(f"/api/ws/{CORPUS}/calls/{chat}/77")).status_code == 404
        body = {"session": "orient", "tool_use_id": "hook1", "tool_name": "Bash", "tool_input": {"command": "grep x ."}}
        hooked = (await client.post(f"/api/ws/{CORPUS}/calls/ref", json=body)).json()
        assert hooked["ref"] == f"call:{chat}/{n + 1}"
        assert hooked["context"] == tools.hint("call-ref", ref=f"call:{chat}/{n + 1}")
        again = (await client.post(f"/api/ws/{CORPUS}/calls/ref", json=body)).json()
        assert again["ref"] == hooked["ref"], "a hook fired twice for one call gets one number"
        thimble = {**body, "tool_use_id": "hook2", "tool_name": "mcp__plugin_thimble_thimble__add_card"}
        assert (await client.post(f"/api/ws/{CORPUS}/calls/ref", json=thimble)).json() == {}
        other = {**body, "tool_use_id": "hook3", "session": "writer:report"}
        assert (await client.post(f"/api/ws/{CORPUS}/calls/ref", json=other)).json() == {}


class _Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_the_hook_script_hands_the_server_s_ref_to_the_model_and_skips_thimble_s_tools(monkeypatch, capsys):
    posted: list[dict] = []

    def fake_open(req, timeout=None):
        posted.append(json.loads(req.data))
        return _Reply(json.dumps({"context": "This call's ref is `call:c1/3`."}).encode())

    monkeypatch.setattr(call_ref.urllib.request, "urlopen", fake_open)
    monkeypatch.setenv("THIMBLE_SESSION", "orient")
    hook = {"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_use_id": "t1", "tool_input": {"command": "false"},
            "error": "Exit code 1", "agent_id": "a7"}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(hook)))
    assert call_ref.main(["--ws", CORPUS]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out == {"hookSpecificOutput": {"hookEventName": "PostToolUseFailure", "additionalContext": "This call's ref is `call:c1/3`."}}
    assert posted[0] == {"session": "orient", "tool_use_id": "t1", "tool_name": "Bash", "tool_input": {"command": "false"}, "agent_id": "a7"}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({**hook, "tool_name": "mcp__plugin_thimble_thimble__add_card"})))
    assert call_ref.main(["--ws", CORPUS]) == 0
    assert capsys.readouterr().out == "" and len(posted) == 1


def test_the_hook_script_prints_nothing_when_the_server_is_down(monkeypatch, capsys):
    def down(req, timeout=None):
        raise OSError("refused")

    monkeypatch.setattr(call_ref.urllib.request, "urlopen", down)
    monkeypatch.setenv("THIMBLE_SESSION", "orient")
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "t"})))
    assert call_ref.main(["--ws", CORPUS]) == 0
    assert capsys.readouterr().out == ""


def test_a_session_with_calls_gets_the_hook_on_both_events():
    hooks = agent_session.call_hooks(CORPUS)
    assert set(hooks) == {"PostToolUse", "PostToolUseFailure"}
    command = hooks["PostToolUse"][0]["hooks"][0]["command"]
    assert "call_ref.py" in command and "--ws mini" in command and hooks["PostToolUse"][0]["matcher"] == "*"


# --------------------------------------------------------------------------- the follower


def test_the_follower_numbers_each_call_it_writes_and_stores_its_result():
    chat = _chat()
    lv = session.Live(CORPUS, "s-1", str(config.corpus_dir(CORPUS)), None, None)
    sub = session.Sub(CORPUS, chat, None, None, role="orient")
    sub.calls = calls.Numbering(CORPUS, chat, at=chat)
    use = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "u1", "name": "Bash", "input": {"command": "ls"}}]}}
    res = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "u1", "content": "a\nb"}]}}
    session.translate_sub(lv, sub, json.dumps(use))
    session.translate_sub(lv, sub, json.dumps(res))
    log = agents.read_events(agents.paths(CORPUS, chat)[1])
    tool_use = next(r for r in log if r["type"] == "tool_use")
    assert tool_use["n"] == 1 and tool_use["id"] == "u1"
    assert calls.get(CORPUS, chat, 1)["result"] == "a\nb"


def test_an_orientation_from_before_the_store_gets_one_from_its_transcript(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    sid = "0f0f0f0f-1111-2222-3333-444444444444"
    chat = str(agents.new_agent(CORPUS, "orient", "Orientation", session=sid)["id"])
    proj = tmp_path / "cc" / "projects" / "-corpus"
    (proj / sid / "subagents").mkdir(parents=True)
    rows = [{"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "m1", "name": "Bash", "input": {"command": "wc -l runs.jsonl"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "m1", "content": "12 runs.jsonl"}]}}]
    (proj / f"{sid}.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    sub = [{"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "s1", "name": "Read", "input": {"file_path": "runs.jsonl"}}]}}]
    (proj / sid / "subagents" / "agent-a1.jsonl").write_text(json.dumps(sub[0]) + "\n")
    listed = calls.listing(CORPUS, chat)
    assert [(c["n"], c["id"]) for c in listed] == [(1, "m1"), (2, "s1")]
    assert calls.get(CORPUS, chat, 1)["result"] == "12 runs.jsonl" and listed[1]["agent"] == "a1"
    assert calls.path(CORPUS, chat).is_file()


# --------------------------------------------------------------------------- the digest and chat refs


def test_the_digest_names_each_call_by_its_ref_and_a_chat_ref_pages_through_it(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    sid = "1f1f1f1f-1111-2222-3333-444444444444"
    chat = str(agents.new_agent(CORPUS, "orient", "Orientation", session=sid)["id"])
    proj = tmp_path / "cc" / "projects" / "-corpus"
    proj.mkdir(parents=True)
    rows = []
    for i in range(3):
        rows.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"m{i}", "name": "Bash", "input": {"command": f"echo {i}"}}]}})
        rows.append({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"m{i}", "content": str(i)}]}})
    (proj / f"{sid}.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    calls.number(CORPUS, chat, "m1", "Bash", {"command": "echo 1"}, at=chat)  # the follower saw this one first
    text = critique_session.chat_digest(CORPUS, chat)
    assert f"call:{chat}/1 Bash" in text and '{"command": "echo 1"}' in text.split(f"call:{chat}/1 Bash", 1)[1].split("\n")[0]
    assert f"call:{chat}/2 Bash" in text and f"call:{chat}/3 Bash" in text
    page = refs.resolve(config.corpus_dir(CORPUS), f"chat:{chat}")
    assert page["kind"] == "chat" and page["excerpt"].startswith("# Orientation")
    monkeypatch.setattr(critique_session, "DIGEST_PAGE_LINES", 3)
    critique_session._digests.clear()
    first = refs.resolve(config.corpus_dir(CORPUS), f"chat:{chat}")
    assert tools.hint("digest-more", ref=f"chat:{chat}#L4-L6", total=f"{first['meta']['lines']:,}") in first["excerpt"]
    assert refs.resolve(config.corpus_dir(CORPUS), f"chat:{chat}#L4-L6")["meta"]["line"] == 4
    with pytest.raises(refs.RefError):
        refs.resolve(config.corpus_dir(CORPUS), "chat:main")


# --------------------------------------------------------------------------- the coverage checks


def test_a_corpus_path_a_call_named_counts_as_read_and_a_field_it_printed_as_used():
    chat = _chat()
    corpus = config.corpus_dir(CORPUS)
    before = orient_checks.check(CORPUS)
    assert any(f.check == "unread" and "board.jsonl" in f.text for f in before)
    calls.number(CORPUS, chat, "c1", "Bash", {"command": f"head {corpus}/board.jsonl"}, at=chat)
    calls.result(CORPUS, chat, "c1", "thread_id thread_title author body")
    after = orient_checks.check(CORPUS)
    assert not any(f.check == "unread" and "`board.jsonl`" in f.text for f in after)
    assert not any(f.check == "unused" and "`thread_title`" in f.text for f in after), "a field a call printed is used"


def test_a_folder_a_call_named_counts_every_file_under_it_as_read():
    files = {"tickets/march.jsonl", "tickets/april.jsonl", "orders.csv", "notes/a.md"}
    got = orient_checks._read_by_calls("grep -c refund tickets/ | sort", Path("/c"), files)
    assert got == {"tickets/march.jsonl", "tickets/april.jsonl"}
    assert orient_checks._read_by_calls("cat /c/orders.csv", Path("/c"), files) == {"orders.csv"}
    assert orient_checks._read_by_calls("see mytickets/x", Path("/c"), files) == set(), "a longer name is not the folder"
