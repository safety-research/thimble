"""0.9.0's surfaces and acts beside local.py's (contracts C7, C8 and C9), which local.py registers:

  thimble state coverage --cwd DIR --session SID [--folder REL] [--summary]
                                       {"summary": Summary, "folder": REL, "rows": [Row], "counting": bool} (C7)
  thimble state label-unsure --cwd DIR [--label ID] [--n 20] [--offset 0] [--counts]
                                       {"labels": [{id, name, noFit, unsure, total, rows?}]} (C8)
  thimble state answer-comments --cwd DIR [--session SID] [--status open|all]
                                       {"comments": [...], "running": [...]} (C9)
  thimble act coverage --cwd DIR --stdin   {"session", "turn", "facts"} on standard input -> {"ok": true, "summary"}
  thimble act answer-comment-resolve --cwd DIR '{"comment": ID, "reopen": false}'   -> {"ok": true}

SCAFFOLD STUB (features lane): the answers are the stubs of coverage.py and answer_comments.py: no rows, no labels'
unsure records, no comments. A failure is an HTTPException, which local.state and local.act turn into `{error}`.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def _flag(args: list[str], name: str, default: str | None = None) -> str | None:
    if name in args:
        i = args.index(name)
        return args[i + 1] if i + 1 < len(args) else default
    return default


async def _coverage(c: str, args: list[str], pos: list[str]) -> Any:
    from . import coverage  # noqa: PLC0415

    sid = _flag(args, "--session") or ""
    folder = _flag(args, "--folder", "") or ""
    out: dict[str, Any] = {"summary": coverage.summary(c, sid), "folder": folder, "counting": False}
    if "--summary" not in args:
        out["rows"] = coverage.rows(c, sid, folder)
    return out


async def _label_unsure(c: str, args: list[str], pos: list[str]) -> Any:
    return {"labels": []}


async def _answer_comments(c: str, args: list[str], pos: list[str]) -> Any:
    from . import answer_comments  # noqa: PLC0415

    status = _flag(args, "--status", "open") or "open"
    return {"comments": answer_comments.comments(c, _flag(args, "--session"), status),
            "running": answer_comments.running(c)}


async def _act_coverage(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    from . import coverage  # noqa: PLC0415

    facts = payload.get("facts")
    if facts is not None and not isinstance(facts, list):
        raise HTTPException(400, "`facts` must be a list")
    return {"summary": coverage.add_facts(c, str(payload.get("session") or ""), str(payload.get("turn") or ""),
                                          facts or [])}


async def _act_answer_comment_resolve(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    from . import answer_comments  # noqa: PLC0415

    cid = str(payload.get("comment") or "").strip()
    if not cid:
        raise HTTPException(400, "`comment` is empty")
    answer_comments.resolve(c, cid, bool(payload.get("reopen")))
    return {}


SURFACES = {"coverage": _coverage, "label-unsure": _label_unsure, "answer-comments": _answer_comments}
ACTS = {"coverage": _act_coverage, "answer-comment-resolve": _act_answer_comment_resolve}
STATE_USAGE = (", coverage --session <sid> [--folder <rel>] [--summary], label-unsure [--label <id>] [--n <n>] "
               "[--offset <n>] [--counts], answer-comments [--session <sid>] [--status open|all]")
ACT_USAGE = ", coverage --stdin {session, turn, facts}, answer-comment-resolve {comment, reopen?}"
