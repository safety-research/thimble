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
