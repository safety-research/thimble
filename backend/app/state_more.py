"""The surfaces and changes of coverage, the labels' unsure records and the checks' comments on Claude's answers, beside
local.py's (`thimble state` and `thimble act`), which registers them:

  thimble state coverage --session SID [--folder REL] [--match GROUP] [--summary]
        {summary, folder, match, rows?, more?, counting}: what the session's tool calls saw or searched in the corpus,
        one level of it, or with --match the files of one group of that level (a name pattern or a type); no rows with
        --summary (coverage.py)
  thimble state label-unsure [--label ID] [--n 20] [--offset 0] [--counts]
        {labels: [{id, name, noFit, unsure, total, rows?}]}: each label's records that no category fit, then those its
        model was unsure of (concepts.unsure); rows only with --label
  thimble state answer-comments [--session SID] [--status open|all]
        {comments, running}: the checks' comments on the passages of Claude's answers (answer_comments.py)

  thimble act coverage {session, turn, facts, cwd?}     a turn's facts (the terminal UI passes them on stdin)
  thimble act coverage-retry {}                        the index job started again (the coverage:count notice's act)
  thimble act answer-comment-resolve {comment, reopen?} a comment on an answer dismissed, or opened again

A failure is an HTTPException or a ValueError, which local.state and local.act turn into `{error}`."""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import HTTPException


def _flag(args: list[str], name: str, default: str | None = None) -> str | None:
    if name in args:
        i = args.index(name)
        if i + 1 < len(args) and not args[i + 1].startswith("--"):
            return args[i + 1]
    return default


def _int(args: list[str], name: str, default: int) -> int:
    v = _flag(args, name)
    if v is None:
        return default
    try:
        return int(v)
    except ValueError:
        raise HTTPException(400, f"{name} must be a whole number, not {v!r}") from None


def _session(v: Any) -> str:
    from . import coverage  # noqa: PLC0415

    sid = str(v or "").strip()
    if not coverage.SID_RE.match(sid):
        raise HTTPException(400, "`session` must be the session's id")
    return sid


async def _coverage(c: str, args: list[str], pos: list[str]) -> Any:
    from . import coverage  # noqa: PLC0415

    sid = _session(_flag(args, "--session"))
    folder = str(_flag(args, "--folder") or "").strip().strip("/")
    match = str(_flag(args, "--match") or "").strip() or None
    if match is not None and ("/" in match or len(match) > 256):
        raise HTTPException(400, "--match is a name pattern or a type of the folder's files")
    return await asyncio.to_thread(coverage.state, c, sid, folder, summary_only="--summary" in args, match=match)


async def _label_unsure(c: str, args: list[str], pos: list[str]) -> Any:
    from . import concepts  # noqa: PLC0415

    label = _flag(args, "--label")
    n, offset = max(1, min(_int(args, "--n", 20), 200)), max(0, _int(args, "--offset", 0))
    return await asyncio.to_thread(concepts.unsure_state, c, label, n, offset, counts_only="--counts" in args)


async def _answer_comments(c: str, args: list[str], pos: list[str]) -> Any:
    from . import answer_comments  # noqa: PLC0415

    status = _flag(args, "--status", "open") or "open"
    if status not in ("open", "all"):
        raise HTTPException(400, "--status is open or all")
    sid = _flag(args, "--session")
    return await asyncio.to_thread(answer_comments.state, c, sid, status)


async def _act_coverage(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    from . import coverage  # noqa: PLC0415

    sid = _session(payload.get("session"))
    facts = payload.get("facts")
    if not isinstance(facts, list):
        raise HTTPException(400, "`facts` must be a list")
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else None
    s = await asyncio.to_thread(coverage.add_facts, c, sid, str(payload.get("turn") or ""), facts, cwd)
    return {"summary": {k: s[k] for k in ("files", "records", "totals", "line")}, "counting": s["counting"]}


async def _act_coverage_retry(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    from . import coverage, notices  # noqa: PLC0415

    notices.clear(c, coverage.COUNT_NOTICE)
    return {"started": await asyncio.to_thread(coverage.start_index, c, force=True)}


async def _act_answer_comment_resolve(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    from . import answer_comments  # noqa: PLC0415

    cid = str(payload.get("comment") or "").strip()
    if not cid:
        raise HTTPException(400, "`comment` is empty")
    reopen = payload.get("reopen") is True
    got = await asyncio.to_thread(answer_comments.set_status, c, cid, "open" if reopen else "dismissed")
    return {"comment": cid, "status": got["status"]}


SURFACES = {"coverage": _coverage, "label-unsure": _label_unsure, "answer-comments": _answer_comments}
ACTS = {"coverage": _act_coverage, "coverage-retry": _act_coverage_retry,
        "answer-comment-resolve": _act_answer_comment_resolve}
STATE_USAGE = ", coverage --session SID [--folder REL] [--match GROUP] [--summary], label-unsure [--label ID] [--n N] [--offset K] " \
              "[--counts], answer-comments [--session SID] [--status open|all]"
ACT_USAGE = ", coverage {session, turn, facts, cwd?}, coverage-retry {}, answer-comment-resolve {comment, reopen?}"
