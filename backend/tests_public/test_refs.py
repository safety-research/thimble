"""refs.py's resolve over the synthetic `mini` corpus: a file line and a card resolve to an excerpt with its context."""
import json

import pytest

from app import config, refs


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


def test_a_line_of_a_markdown_chat_log_resolves_with_its_turn(tmp_path):
    """Bug hunt D9: a quote of a markdown chat log's line showed `**R3:**`, since the line resolved as its raw text alone.
    It resolves with the turn the line starts (`meta.turn`, as the Transcript mode reads it), so a quote can show the
    speaker apart from the words."""
    lines = ["# Session R3", "", "**Moderator:** What did you try first?", "", "**R3:** I could not find the stop button.",
             "", "**00:01:26**", "", "**Moderator:** And then?", "", "**R3:** I asked the chat instead."]
    (tmp_path / "R3").mkdir()
    (tmp_path / "R3" / "notes.md").write_text("\n".join(lines) + "\n")
    out = refs.resolve(tmp_path, "R3/notes.md#L5.b0:c8-28")
    assert out["meta"]["turn"] == {"speaker": "R3", "at": 8} and out["excerpt"] == "I could not find the"
    assert "turn" not in refs.resolve(tmp_path, "R3/notes.md#L7")["meta"], "a time's own line starts no turn"


def test_bug_hunt_e2_a_link_whose_words_are_in_double_brackets_cites_its_target():
    # main wrote `[[↗]](card:<id>)`: the chat's text and every reader of citations take it as the card, never a ref `↗`
    from app import cite

    said = "Most runs finished [[↗]](card:tally-ends), 221 rows [[221]](card:session-rows#n/all), see [[↗]](notes.md#L3)."
    chat = "Most runs finished [[card:tally-ends]], 221 rows [[221|card:session-rows#n/all]], see [[notes.md#L3]]."
    assert cite.from_links(said) == chat and cite.from_links(chat) == chat
    assert cite.normalise_markup(said) == chat
    assert refs.extract_refs(said) == ["card:tally-ends", "card:session-rows#n/all", "notes.md#L3"]
    # a citation followed by words in parentheses, and a web link, stay as written
    assert cite.from_links("[[card:tally-ends]](above)") == "[[card:tally-ends]](above)"
    assert cite.from_links("[[↗]](https://example.org/a)") == "[[↗]](https://example.org/a)"


def test_an_answer_s_quote_in_single_brackets_is_a_citation(workspaces_tmp):
    """Bug hunt L9: a thread's answer quoted records as `["…"|transcript.jsonl#L2059]`, which a takeaway reads as a
    citation (normalise_markup) but the thread showed as raw markup and never checked. An answer's text, main's or a
    thread's, writes it as `[["…"|ref]]`; code is left as written, and so are brackets whose part after the bar is no
    ref."""
    from app import agents, cite, session, threads

    said = ('It looped on ["Filename \'wren-ui-2.7.1.tar.gz\' is invalid…"|logs/run.jsonl#L2059]; then '
            '["200 OK"|logs/run.jsonl#L2061] and [3 retries|logs/run.jsonl#L12-L14]. '
            'Code `x = a[i|j.k]` and [left|right] stay.\n\n```\nm = [tag|notes.md]\n```')
    chat = ('It looped on [["Filename \'wren-ui-2.7.1.tar.gz\' is invalid…"|logs/run.jsonl#L2059]]; then '
            '[["200 OK"|logs/run.jsonl#L2061]] and [[3 retries|logs/run.jsonl#L12-L14]]. '
            'Code `x = a[i|j.k]` and [left|right] stay.\n\n```\nm = [tag|notes.md]\n```')
    assert cite.chat_form(said) == chat and cite.chat_form(chat) == chat
    assert session.visible(said) == chat
    meta = agents.new_agent("mini", agents.KIND_THREAD, "Why did it loop?", announce=False)
    threads.reply("mini", meta["id"], said, by="fork")
    texts = [r.get("delta") for r in agents.read_events(agents.paths("mini", meta["id"])[1]) if r.get("type") == "text"]
    assert texts == [chat]
