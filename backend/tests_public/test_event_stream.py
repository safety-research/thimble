"""The workspace event stream when the log beneath it is replaced. `/thimble fresh` moves the workspace's folder aside
and `/thimble restore <name>` moves an archive back, so the log starts over or becomes another. An open stream gets
`reset` and the new log's history, then `live`; a tab that reopens with a seq past the log's end, or with the id of
another log, gets the same, so it never waits for numbers the new log will not reach for a long time."""
from __future__ import annotations

import asyncio
import json

from starlette.requests import Request

from app import investigation, ledger

C = "mini"


def _request() -> Request:
    return Request({"type": "http", "method": "GET", "path": f"/api/ws/{C}/events", "headers": [], "query_string": b""})


async def _records(it, n: int) -> list[dict]:
    return [await asyncio.wait_for(it.__anext__(), timeout=5) for _ in range(n)]


def _emit(status: str) -> None:
    investigation.emit(C, investigation.MAIN, {"type": "report", "slug": "report", "status": status})


def test_an_open_stream_starts_over_when_the_workspace_is_archived(workspaces_tmp):
    """The tab has seen the old log; `/thimble fresh` archives the workspace. The stream sends `reset`, the new log's
    (empty) history and `live` with the new log's id, and the next event is numbered from 0 in the new log."""
    async def run() -> tuple[list[dict], list[dict], str, str]:
        _emit("generating")
        old_log = investigation.log_id(C)
        resp = await investigation._stream(C, investigation.MAIN, _request())
        it = resp.body_iterator
        try:
            first = await _records(it, 3)  # open, the event, live
            await ledger.archive_workspace(C)
            investigation.ensure_main(C)  # the next touch starts the empty workspace
            after = await _records(it, 2)  # reset, live
            _emit("failed")
            after += await _records(it, 1)
        finally:
            await it.aclose()
        return first, after, old_log, investigation.log_id(C)

    first, after, old_log, new_log = asyncio.run(run())
    assert first[2] == {"event": "live", "data": json.dumps({"log": old_log})}
    assert after[0] == {"event": "reset", "data": "{}"}
    assert after[1] == {"event": "live", "data": json.dumps({"log": new_log})} and new_log != old_log
    assert after[2]["id"] == "0" and '"failed"' in after[2]["data"]


def test_a_reopen_past_the_log_s_end_or_onto_another_log_starts_over(workspaces_tmp):
    """After a restart the tab reopens with the last seq it saw. The new log is shorter (fresh after the restart), so
    that seq is past its end: `reset`, then the whole log. A reopen naming another log's id does the same even when the
    seq is within this log; one naming this log reads on from its seq."""
    async def reopen(after: int | None, log: str | None, n: int) -> list[dict]:
        resp = await investigation._stream(C, investigation.MAIN, _request(), after, log)
        it = resp.body_iterator
        try:
            return await _records(it, n)
        finally:
            await it.aclose()

    async def run() -> tuple[list[str], list[dict], list[dict], list[dict]]:
        _emit("generating")
        _emit("failed")
        # the seq goes on from what earlier tests of this process emitted, so the ids are read from the log
        log = investigation.inv_dir(C, investigation.MAIN) / "events.jsonl"
        ids = [str(e["seq"]) for e in investigation._read_jsonl(log)]
        past = await reopen(int(ids[-1]) + 4696, None, 5)  # open, reset, two events, live
        other = await reopen(int(ids[0]), "a log of another workspace", 5)
        same = await reopen(int(ids[0]), investigation.log_id(C), 3)  # open, the second event, live
        return ids, past, other, same

    ids, past, other, same = asyncio.run(run())
    for recs in (past, other):
        assert recs[1] == {"event": "reset", "data": "{}"}
        assert [r.get("id") for r in recs[2:4]] == ids and recs[4]["event"] == "live"
    assert same[1]["id"] == ids[1] and same[2]["event"] == "live"
