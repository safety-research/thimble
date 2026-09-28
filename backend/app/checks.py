"""Report checks: each an independent prompt that leaves comments on a document's passages, reads the document with all
the context, can do work, and can be created and run from the chat. Checks rerun when the document changes, but are
cached: a passage whose text did not change, or that is locked, is not checked again.

A check is `workspaces/<c>/checks/<id>.json` = {id, name, prompt, colour, shown, builtin, created_by, ts, version,
runs: {doc: Run}}. The built-ins (`unverified`, `verified`, `judgment`) are prompts/checks/<id>.md, read from the
prompt file until first changed. A run is a Claude Code session of its own (agent_session.start) running as the check
agent (prompts/check.md) with the corpus read-only and a work folder of its own; its first message is the context
engine's (context.render) plus the document, the check's prompt and the passages it covers. At most MAX_SESSIONS run
at once; a session past RUN_LIMIT_S of active time is stopped and the run ends `failed`.

The cache: a passage (paragraph, heading, slide, beat or free sentence) is fingerprinted by the sentence_key of its
words. A run covers only passages whose fingerprint its check has not seen on that document; a run that ends `done`
supersedes the check's earlier open comments on those passages and records their fingerprints in `seen`. A save that
changes text reruns each shown check once QUIET_S pass with no further save and no writer running; a check started while
a writer runs is queued (`waiting: "writer"`) until it ends. run_check (from the chat) creates or reruns a check and
main hears `checked {check, doc, status, comments}` when each run ends.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import agent_session, config, investigation, prompts, tools
from .ledger import read_json, write_json

log = logging.getLogger("thimble.checks")
router = APIRouter()

AGENT = "check"  # prompts/check.md, the agent a run's session runs as
ROLE = "check"  # a run's chat role
MODEL_ROLE = "checks"  # config.models_for's role for the runs' sessions
AUTHOR = "check"  # a check's comment's author (report.CHECK_AUTHOR)
DIR = "checks"  # workspaces/<c>/checks/<id>.json
WORK_DIR = "work"  # workspaces/<c>/checks/work/<id>-<doc>/, a run's own folder, where its Bash may write
OWN_TOOLS = ("read_ref", "list_cards", "add_comment")  # a check's thimble tools
BUILTINS = ("unverified", "verified", "judgment")  # prompts/checks/<id>.md, listed first in this order
COLOURS = tuple(range(1, 9))
CONTEXT_CHARS = 400_000  # of the context engine's part of a run's first message
QUIET_S = float(os.environ.get("THIMBLE_CHECK_QUIET_S", "20") or "20")  # after a document's last save, before a rerun
WRITER_POLL_S = 2.0  # while a writer of the document runs, how often a rerun looks again
WAITING_WRITER = "writer"  # a run's `waiting` while it is queued behind the document's writer
MAX_SESSIONS = 3  # runs whose sessions run at once
# The most active time a run's session may take, by its effort (agent_session.wait_active: its process alive and no
# permission request waiting, so a retry's wait for capacity does not count). A run past it is stopped and ends
# `failed` saying so, so a session that hangs cannot hold one of the MAX_SESSIONS places for ever.
RUN_LIMIT_S = {"low": 900.0, "medium": 900.0, "high": 1200.0, "xhigh": 1800.0, "max": 2400.0}
INTERRUPTED = "the server stopped while this run ran"  # a run the previous server left running (mark_interrupted)
CHANGED = ("generated", "rewritten", "edited")  # the `report` statuses of a save that changes text
CHECKED_KIND = "checked"  # the channel event that tells main a run it started ended (prompts/main.md)
DEFAULT_EFFORT = "medium"  # when check.md names none
SUMMARY_CHARS = 300
NAME_CHARS = 80
PROMPT_CHARS = 8_000
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,48}$")
_REF_RE = re.compile(r"^report:([a-z0-9][a-z0-9-]*)#(p?)([A-Za-z0-9_-]+)$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


# --------------------------------------------------------------------------- the store


def _dir(c: str) -> Path:
    return config.workspace_dir(c) / DIR


def _path(c: str, cid: str) -> Path:
    if not ID_RE.match(cid or ""):
        raise HTTPException(404, f"no check {cid!r}")
    return _dir(c) / f"{cid}.json"


def builtin(cid: str) -> dict[str, Any] | None:
    """A built-in check as its prompt file defines it, off and never run; None for another id."""
    import yaml  # noqa: PLC0415 — only the check files need it

    if cid not in BUILTINS:
        return None
    text = prompts.load(f"{prompts.CHECKS_DIR}/{cid}")
    head, sep, body = text.removeprefix("---\n").partition("\n---\n")
    front = yaml.safe_load(head) if sep else {}
    front = front if isinstance(front, dict) else {}
    colour = front.get("colour")
    return {"id": cid, "name": _collapse(front.get("name") or cid), "prompt": body.strip(),
            "colour": colour if colour in COLOURS else COLOURS[0], "shown": False, "builtin": True,
            "created_by": "thimble", "ts": "", "version": 1, "runs": {}}


def read(c: str, cid: str) -> dict[str, Any] | None:
    """The check `cid`: its workspace file, else the built-in of that id; None when neither exists."""
    stored = read_json(_path(c, cid), None)
    if isinstance(stored, dict):
        stored.setdefault("runs", {})
        return stored
    return builtin(cid)


def list_checks(c: str) -> list[dict[str, Any]]:
    """Every check, the built-ins first in their order, then the others in the order they were made."""
    out = [x for cid in BUILTINS if (x := read(c, cid)) is not None]
    d = _dir(c)
    others = []
    for p in sorted(d.glob("*.json")) if d.is_dir() else []:
        if p.stem in BUILTINS:
            continue
        x = read_json(p, None)
        if isinstance(x, dict) and x.get("id") == p.stem:
            x.setdefault("runs", {})
            others.append(x)
    return out + sorted(others, key=lambda x: str(x.get("ts") or ""))


def names(c: str) -> dict[str, str]:
    """{id: name} of every check, for the lines that name a comment's check."""
    try:
        return {str(x["id"]): str(x.get("name") or x["id"]) for x in list_checks(c)}
    except Exception:  # noqa: BLE001 — a line that names a check by its id is no reason to fail a read
        return {}


def by_name(c: str, name: str) -> dict[str, Any] | None:
    """The check whose name, or id, is `name`, ignoring case."""
    want = _collapse(name).casefold()
    return next((x for x in list_checks(c) if str(x.get("name") or "").casefold() == want or x["id"] == want), None)


def save(c: str, check: dict[str, Any]) -> dict[str, Any]:
    _dir(c).mkdir(parents=True, exist_ok=True)
    write_json(_path(c, str(check["id"])), check)
    return check


def _new_id(c: str, name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "check"
    base = base if ID_RE.match(base) else "check"
    taken = {x["id"] for x in list_checks(c)}
    cid, k = base, 2
    while cid in taken or cid in BUILTINS:
        cid, k = f"{base}-{k}", k + 1
    return cid


def _free_colour(c: str) -> int:
    """The first colour no check has, else the one fewest have."""
    used = [x.get("colour") for x in list_checks(c)]
    return next((k for k in COLOURS if k not in used), min(COLOURS, key=used.count))


def create(c: str, name: str, prompt: str, *, created_by: str) -> dict[str, Any]:
    """A new check, off; 409 when a check has that name, 400 for an empty name or prompt."""
    name, prompt = _collapse(name)[:NAME_CHARS], str(prompt or "").strip()[:PROMPT_CHARS]
    if not name or not prompt:
        raise HTTPException(400, "a check needs a name and a prompt")
    if by_name(c, name) is not None:
        raise HTTPException(409, f"a check named {name!r} exists")
    return save(c, {"id": _new_id(c, name), "name": name, "prompt": prompt, "colour": _free_colour(c), "shown": False,
                    "builtin": False, "created_by": created_by, "ts": _now(), "version": 1, "runs": {}})


def edit(c: str, cid: str, *, name: str | None = None, prompt: str | None = None, colour: int | None = None,
         shown: bool | None = None) -> dict[str, Any]:
    """The check with the fields given changed and written; a new prompt bumps `version` and empties each document's `seen`
    but for its locked blocks' fingerprints. 404, 409 for a name another check has, 400 for a colour outside 1 to 8 or an
    empty name or prompt."""
    from . import investigation as inv, report_types  # noqa: PLC0415

    check = read(c, cid)
    if check is None:
        raise HTTPException(404, f"no check {cid!r}")
    if name is not None:
        name = _collapse(name)[:NAME_CHARS]
        other = by_name(c, name)
        if not name or (other is not None and other["id"] != cid):
            raise HTTPException(409 if name else 400, f"a check named {name!r} exists" if name else "a check needs a name")
        check["name"] = name
    if prompt is not None:
        prompt = str(prompt).strip()[:PROMPT_CHARS]
        if not prompt:
            raise HTTPException(400, "a check needs a prompt")
        if prompt != check.get("prompt"):
            check["prompt"] = prompt
            check["version"] = int(check.get("version") or 1) + 1
            for doc, run in (check.get("runs") or {}).items():
                d = report_types.read_doc(c, inv.MAIN, doc)
                locked = {p["fp"] for p in passages(doc, d) if p["locked"]} if d else set()
                run["seen"] = [fp for fp in run.get("seen") or [] if fp in locked]
    if colour is not None:
        if colour not in COLOURS:
            raise HTTPException(400, f"a colour is one of {COLOURS[0]} to {COLOURS[-1]}")
        check["colour"] = colour
    if shown is not None:
        check["shown"] = bool(shown)
    return save(c, check)


# --------------------------------------------------------------------------- passages


def fingerprint(kind: str, keys: list[str]) -> str:
    return hashlib.sha1("\x1f".join([kind, *keys]).encode("utf-8")).hexdigest()[:16]


def passages(slug: str, doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The passages of a written document in its order: {ref, kind, fp, locked, anchor, ids}, `anchor` the id a comment on
    the whole passage goes on and `ids` every id that names the passage or a sentence in it."""
    from . import report_types as rt  # noqa: PLC0415

    if not doc:
        return []
    key = rt.sentence_key
    out: list[dict[str, Any]] = []
    in_units: set[str] = set()

    def sentence(x: dict[str, Any]) -> None:  # a story's answer or a page's claim, which no lock holds
        sid = str(x.get("id"))
        out.append({"ref": f"report:{slug}#{sid}", "kind": "sentence", "fp": fingerprint("s", [key(x.get("text"))]),
                    "locked": False, "anchor": sid, "ids": [sid]})

    answer = doc.get("answer") if isinstance(doc.get("answer"), dict) else None
    if answer and rt.is_sentence(answer):
        sentence(answer)
        in_units.add(str(answer.get("id")))
    for u in rt.units(doc):
        uid = str(u.get("id"))
        sents = rt.unit_sentences(u)
        in_units.update(str(x.get("id")) for x in sents)
        if isinstance(u.get("paragraphs"), list):
            if _collapse(u.get("heading")):
                out.append({"ref": f"report:{slug}#{uid}", "kind": "heading", "fp": fingerprint("h", [key(u.get("heading"))]),
                            "locked": u.get("locked") is True, "anchor": uid, "ids": [uid]})
            for p in u["paragraphs"]:
                xs = [x for x in p.get("sentences") or [] if isinstance(x, dict)] if isinstance(p, dict) else []
                if not xs:
                    continue
                pid = str(p.get("id"))
                out.append({"ref": f"report:{slug}#p{pid}", "kind": "paragraph",
                            "fp": fingerprint("p", [key(x.get("text")) for x in xs]),
                            "locked": p.get("locked") is True or u.get("locked") is True, "anchor": str(xs[0].get("id")),
                            "ids": [f"p{pid}", *(str(x.get("id")) for x in xs)]})
        elif sents or _collapse(u.get("heading")):
            out.append({"ref": f"report:{slug}#{uid}", "kind": "unit",
                        "fp": fingerprint("u", [key(u.get("heading")), *(key(x.get("text")) for x in sents)]),
                        "locked": u.get("locked") is True, "anchor": uid, "ids": [uid, *(str(x.get("id")) for x in sents)]})
    for x in rt.all_sentences(doc):
        if str(x.get("id")) not in in_units:
            sentence(x)
    return out


def passage_of(slug: str, doc: dict[str, Any] | None, ref: str) -> dict[str, Any] | None:
    """The passage a ref names: a paragraph by `#p<id>`, a heading, a unit or a sentence by its id, a sentence's
    passage for a sentence inside one; None when it names none of this document's."""
    m = _REF_RE.match(str(ref or "").strip().strip("[]").strip())
    if not m or m.group(1) != slug:
        return None
    uid = f"p{m.group(3)}" if m.group(2) else m.group(3)
    return next((p for p in passages(slug, doc) if uid in p["ids"]), None)


def _of_comment(slug: str, ps: list[dict[str, Any]], sid: str) -> str | None:
    """The ref of the passage a comment's anchor is in."""
    return next((p["ref"] for p in ps if sid in p["ids"]), None)


def to_cover(check: dict[str, Any], slug: str, doc: dict[str, Any] | None, wanted: list[str] | None = None,
             force: bool = False) -> list[dict[str, Any]]:
    """The passages a run of `check` on `slug` covers: the ones `wanted` names, else every one but the locked blocks seen
    before when `force`, else the ones whose fingerprint the check has not seen."""
    ps = passages(slug, doc)
    seen = set(((check.get("runs") or {}).get(slug) or {}).get("seen") or [])
    if wanted:
        refs = {p["ref"] for w in wanted if (p := passage_of(slug, doc, w)) is not None}
        return [p for p in ps if p["ref"] in refs]
    if force:
        return [p for p in ps if not (p["locked"] and p["fp"] in seen)]
    return [p for p in ps if p["fp"] not in seen]


# --------------------------------------------------------------------------- runs


@dataclass
class _Active:
    c: str
    check: str
    doc: str
    run: str
    notify: bool  # run_check started it, so main hears when it ends
    covered: list[str]
    fps: list[str]
    after_writer: bool = False  # queued until the document's writer ends, what it covers read then
    task: asyncio.Task | None = None
    session: agent_session.Run | None = None
    comments: int = 0
    ended: bool = False
    effort: str = ""
    timed_out: float = 0.0  # the limit a run ran past (RUN_LIMIT_S), which ends it `failed`


_active: dict[tuple[str, str, str], _Active] = {}  # (workspace, check, doc) -> its running run
_dirty: set[tuple[str, str, str]] = set()  # runs whose document changed while they ran
_timers: dict[tuple[str, str], asyncio.TimerHandle] = {}  # (workspace, doc) -> its rerun, once quiet
_tasks: set[asyncio.Task] = set()
_sem: asyncio.Semaphore | None = None


def session_key(cid: str, doc: str) -> str:
    """The THIMBLE_SESSION of a run of check `cid` on `doc` (tools.session_kind reads its kind, `check`)."""
    return f"{tools.CHECK_SESSION}:{cid}:{doc}"


def _of_session(c: str, key: str | None) -> _Active | None:
    parts = str(key or "").split(":")
    if len(parts) != 3 or parts[0] != tools.CHECK_SESSION:
        return None
    return _active.get((c, parts[1], parts[2]))


def running(c: str, cid: str, doc: str) -> bool:
    return (c, cid, doc) in _active


def run_limit(effort: str) -> float:
    """RUN_LIMIT_S for a run at `effort`; the longest for a level the table does not name."""
    return RUN_LIMIT_S.get(effort, max(RUN_LIMIT_S.values()))


def mark_interrupted(root: Path | None = None) -> list[str]:
    """Server start: a run a check's file records as `running` belonged to a previous server, so it ends `failed` with
    INTERRUPTED as its summary. Returns `<workspace>/<check>/<doc>` per run marked."""
    root = config.WORKSPACES_DIR if root is None else root
    marked: list[str] = []
    for p in sorted(root.glob(f"*/{DIR}/*.json")) if root.is_dir() else []:
        check = read_json(p, None)
        if not isinstance(check, dict) or not isinstance(check.get("runs"), dict):
            continue
        changed = False
        for doc, rec in check["runs"].items():
            if isinstance(rec, dict) and rec.get("status") == "running":
                rec.update(status="failed", ended=_now(), summary=INTERRUPTED)
                rec.pop("waiting", None)
                changed = True
                marked.append(f"{p.parent.parent.name}/{p.stem}/{doc}")
        if changed:
            write_json(p, check)
    return marked


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    """The router's lifespan: the runs the previous server left running end before the first request (mark_interrupted)."""
    try:
        marked = await asyncio.to_thread(mark_interrupted)
        if marked:
            log.info("check runs left running by the previous server, marked failed: %s", ", ".join(marked))
    except Exception:  # noqa: BLE001 — never fails the start
        log.exception("marking interrupted check runs failed")
    yield


router.lifespan_context = _lifespan


def _semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(MAX_SESSIONS)
    return _sem


def agent_definition() -> tuple[str, dict[str, Any]]:
    """(name, definition) of the check agent for `--agents`, from prompts/check.md."""
    from . import cli  # noqa: PLC0415 — cli is large, and the definition's shape is the launcher's

    return cli.agent_definition(AGENT)


def work_dir(c: str, cid: str, doc: str) -> Path:
    return _dir(c) / WORK_DIR / f"{cid}-{doc}"


def _stream(c: str, cid: str, doc: str, status: str, run: str, chat: str) -> None:
    try:
        investigation.emit(c, investigation.MAIN, {"type": "check", "id": cid, "doc": doc, "status": status, "run": run,
                                                   "chat": chat})
    except Exception:  # noqa: BLE001 — the browser rereads the checks on its next record
        log.debug("%s: check record not emitted for %s on %s", c, cid, doc, exc_info=True)


def task_text(c: str, check: dict[str, Any], doc: str, cover: list[dict[str, Any]]) -> str:
    """The task of a run's first message."""
    from . import investigation as inv, report_types  # noqa: PLC0415

    t = report_types.read_type(c, doc)
    d = report_types.read_doc(c, inv.MAIN, doc) or {}
    every = {p["ref"] for p in cover} == {p["ref"] for p in passages(doc, d)}
    parts = [tools.hint("check-document", ref=f"report:{doc}", document=report_types.document_text(c, t or {"slug": doc}, d, True)),
             tools.hint("check-instructions", check=check["name"], prompt=str(check.get("prompt") or "").strip()),
             tools.hint("check-every-passage") if every else
             tools.hint("check-passages", passages="\n".join(p["ref"] for p in cover))]
    if check["id"] == "unverified":
        ids = {i for p in cover for i in p["ids"]}
        tags = [f"- report:{doc}#{x['id']} {_collapse((x.get('tag_notes') or {}).get('unverified'))}".rstrip()
                for x in report_types.all_sentences(d) if "unverified" in (x.get("tags") or []) and str(x.get("id")) in ids]
        if tags:
            parts.append(tools.hint("check-tags", tags="\n".join(tags)))
    return "\n\n".join(p.strip() for p in parts if p.strip())


def first_message(c: str, check: dict[str, Any], doc: str, cover: list[dict[str, Any]]) -> str:
    from . import context  # noqa: PLC0415 — context imports this module for the check names

    return context.render(c, task_text(c, check, doc, cover), budget=CONTEXT_CHARS, focus=(f"report:{doc}",))


async def start_run(c: str, cid: str, doc: str, *, passages_: list[str] | None = None, force: bool = False,
                    notify: bool = False, after_writer: bool = False) -> dict[str, Any] | None:
    """Start a run of check `cid` on the written document `doc` and return its Run, or None when it has nothing to cover or
    the document is not written. A running run of it on `doc` is stopped first. `notify` tells main when it ends;
    `after_writer` queues the run while a writer of `doc` runs."""
    from . import investigation as inv, report_types, write_session  # noqa: PLC0415

    check = read(c, cid)
    if check is None:
        raise ValueError(f"no check {cid!r}")
    queued = after_writer and write_session.running(c, doc)
    d = report_types.read_doc(c, inv.MAIN, doc)
    cover = [] if queued else to_cover(check, doc, d, passages_, force) if d is not None else []
    if not cover and not queued:
        return None
    old = _active.get((c, cid, doc))
    if old is not None:
        await stop(old)
        check = read(c, cid) or check
    prev = (check.get("runs") or {}).get(doc) or {}
    rec = {"run": secrets.token_hex(4), "status": "running", "chat": "", "started": _now(), "ended": None,
           "covered": [p["ref"] for p in cover], "seen": list(prev.get("seen") or []), "comments": 0, "summary": "",
           **({"waiting": WAITING_WRITER} if queued else {})}
    check.setdefault("runs", {})[doc] = rec
    save(c, check)
    act = _Active(c, cid, doc, rec["run"], notify, rec["covered"], [p["fp"] for p in cover], after_writer=queued)
    _active[(c, cid, doc)] = act
    act.task = asyncio.get_running_loop().create_task(_go(act), name=f"check:{c}:{cid}:{doc}")
    _stream(c, cid, doc, "running", rec["run"], "")
    return rec


async def _go(act: _Active) -> None:
    """Wait for a free session, then run the check's session and hold the place while it runs."""
    c = act.c
    done: asyncio.Future = asyncio.get_running_loop().create_future()

    def ended(run: agent_session.Run, status: str, summary: str) -> None:
        _finish(act, status, summary)
        if not done.done():
            done.set_result(status)

    try:
        if act.after_writer and not await _after_writer(act):
            return
        async with _semaphore():
            if act.ended:
                return
            check = read(c, act.check)
            if check is None:
                _finish(act, "failed", f"no check {act.check}")
                return
            cover = [p for p in passages(act.doc, _doc(c, act.doc)) if p["ref"] in set(act.covered)]
            prompt = await asyncio.to_thread(first_message, c, check, act.doc, cover or [])
            name, agent = agent_definition()
            conf = config.models_for(c)[MODEL_ROLE]
            agent = agent_session.role_agent(agent, conf)
            effort = str(agent.get("effort") or DEFAULT_EFFORT)
            if act.ended:
                return
            try:
                run = await agent_session.start(
                    c, session_key(act.check, act.doc), role=ROLE, title=str(check["name"]),
                    agent_args=["--agents", _json({name: agent}), "--agent", name], effort=effort,
                    settings=agent_session.settings_json(effort, fastMode=bool(conf["fast"])), prompt=prompt,
                    agent_type=name, on_end=ended, model=str(agent.get("model") or ""), agent="critic",
                    work=work_dir(c, act.check, act.doc), unasked=True, disallowed=agent_session.not_own(OWN_TOOLS),
                    announce=False,
                    check=act.check, doc=act.doc, run_id=act.run,
                    brief=tools.hint("check-instructions", check=check["name"], prompt=str(check.get("prompt") or "").strip()))
            except (RuntimeError, ValueError, OSError) as e:
                _finish(act, "failed", str(e))
                return
            act.session = run
            act.effort = effort
            _chat(act, run.chat)
            limit = run_limit(effort)
            if not await agent_session.wait_active(run, done, limit):
                act.timed_out = limit
                await agent_session.stop_run(run)
                if not act.ended:  # a follower that did not end the run after Stop
                    _finish(act, "stopped", "")
    except asyncio.CancelledError:
        if act.session is not None and not act.ended:
            with contextlib.suppress(Exception):
                await agent_session.stop_run(act.session)
        _finish(act, "stopped", "")
        raise
    except Exception as e:  # noqa: BLE001 — a run that cannot start is failed, never left running
        log.exception("%s: the run of check %s on %s failed", c, act.check, act.doc)
        _finish(act, "failed", f"{type(e).__name__}: {e}")


async def _after_writer(act: _Active) -> bool:
    """A run queued while a writer of its document ran: wait for the writer to end, then read what the run covers now; False
    when the run has ended meanwhile or has nothing to cover, which ends it `done`."""
    from . import write_session  # noqa: PLC0415

    c = act.c
    while write_session.running(c, act.doc):
        await asyncio.sleep(WRITER_POLL_S)
        if act.ended:
            return False
    check = read(c, act.check)
    cover = to_cover(check, act.doc, _doc(c, act.doc)) if check is not None else []
    act.covered, act.fps = [p["ref"] for p in cover], [p["fp"] for p in cover]
    rec = ((check or {}).get("runs") or {}).get(act.doc)
    if check is not None and rec is not None and rec.get("run") == act.run:
        rec["covered"] = act.covered
        rec.pop("waiting", None)
        save(c, check)
    if not cover:
        _finish(act, "done", "")
        return False
    _stream(c, act.check, act.doc, "running", act.run, "")
    return True


def _json(obj: Any) -> str:
    import json  # noqa: PLC0415

    return json.dumps(obj, ensure_ascii=False)


def _doc(c: str, doc: str) -> dict[str, Any] | None:
    from . import report_types  # noqa: PLC0415

    return report_types.read_doc(c, investigation.MAIN, doc)


def _chat(act: _Active, chat: str) -> None:
    check = read(act.c, act.check)
    rec = ((check or {}).get("runs") or {}).get(act.doc)
    if check is not None and rec is not None and rec.get("run") == act.run:
        rec["chat"] = chat
        save(act.c, check)
    _stream(act.c, act.check, act.doc, "running", act.run, chat)


def _finish(act: _Active, status: str, summary: str) -> None:
    """A run ended: its record written, and for a run that ended `done` the check's earlier comments on the passages it
    covered superseded and their fingerprints seen; main told when run_check started it."""
    from . import channel, report, report_types  # noqa: PLC0415

    if act.ended:
        return
    act.ended = True
    c = act.c
    if _active.get((c, act.check, act.doc)) is act:
        _active.pop((c, act.check, act.doc), None)
    status = status if status in ("done", "failed", "stopped") else "failed"
    last = next((ln.strip() for ln in reversed(str(summary or "").strip().splitlines()) if ln.strip()), "")
    if act.timed_out:
        status = "failed"
        last = (f"It ran past its {act.timed_out / 60:.0f} minutes at {act.effort or DEFAULT_EFFORT} effort and was "
                f"stopped; its comments so far stay.")
    check = read(c, act.check)
    rec = ((check or {}).get("runs") or {}).get(act.doc)
    if check is None or rec is None or rec.get("run") != act.run:
        return  # a newer run took its place
    rec.update(status=status, ended=_now(), summary=last[:SUMMARY_CHARS], comments=act.comments)
    if status == "done":
        doc = _doc(c, act.doc)
        ps = passages(act.doc, doc)
        covered = set(act.covered)
        if doc is not None:
            gone = 0
            for cm in doc.get("comments") or []:
                if (isinstance(cm, dict) and cm.get("check") == act.check and cm.get("run") != act.run
                        and (cm.get("status") or "open") == "open" and _of_comment(act.doc, ps, str(cm.get("sentence_id"))) in covered):
                    cm.update(status=report.SETTLED_STATUS, resolution=report.RESOLUTION_SUPERSEDED, superseded_by=act.run)
                    gone += 1
            if gone:
                report_types.write_doc(c, investigation.MAIN, act.doc, doc)
        now = {p["fp"] for p in ps}
        rec["seen"] = sorted({fp for fp in rec.get("seen") or [] if fp in now} | set(act.fps))
    save(c, check)
    _stream(c, act.check, act.doc, status, act.run, str(rec.get("chat") or ""))
    if act.notify:
        try:
            channel.post(c, CHECKED_KIND, {"text": rec["summary"] or status, "check": act.check, "doc": act.doc,
                                           "status": status, "comments": act.comments})
        except HTTPException as e:
            log.info("%s: main did not hear that check %s ended on %s (%s %s)", c, act.check, act.doc, e.status_code, e.detail)
    if (c, act.check, act.doc) in _dirty:
        _dirty.discard((c, act.check, act.doc))
        changed(c, act.doc)


async def stop(act: _Active) -> None:
    """Stop a run: its session when it has one, which ends it as stopped, else its place in the queue."""
    if act.session is not None and not act.ended:
        await agent_session.stop_run(act.session)
    elif act.task is not None and not act.task.done():
        act.task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await act.task
    _finish(act, "stopped", "")


async def stop_check(c: str, cid: str) -> None:
    for (cc, check, _), act in list(_active.items()):
        if cc == c and check == cid:
            await stop(act)


def _written(c: str) -> list[str]:
    from . import report_types  # noqa: PLC0415

    return [str(t["slug"]) for t in report_types.list_types(c) if report_types.read_doc(c, investigation.MAIN, t["slug"]) is not None]


def _writing(c: str) -> list[str]:
    """The documents a writer is writing now, written yet or not."""
    from . import report_types, write_session  # noqa: PLC0415

    return [str(t["slug"]) for t in report_types.list_types(c) if write_session.running(c, str(t["slug"]))]


async def refresh(c: str, cid: str) -> list[dict[str, Any]]:
    """Run check `cid` on every written document where it has passages to cover and no run running, queued behind the
    writer of a document one is writing."""
    out = []
    for doc in dict.fromkeys([*_written(c), *_writing(c)]):
        if running(c, cid, doc):
            continue
        rec = await start_run(c, cid, doc, after_writer=True)
        if rec is not None:
            out.append(rec)
    return out


def _spawn(coro: Any) -> None:
    t = asyncio.ensure_future(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


# --------------------------------------------------------------------------- reruns


def changed(c: str, slug: str) -> None:
    """A save changed the text of document `slug`: each shown check reruns on it once QUIET_S pass with no other save; a
    check whose run on it is running runs again after it."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    shown = [x for x in list_checks(c) if x.get("shown")]
    if not shown:
        return
    for x in shown:
        if running(c, x["id"], slug):
            _dirty.add((c, x["id"], slug))
    old = _timers.pop((c, slug), None)
    if old is not None:
        old.cancel()
    _timers[(c, slug)] = loop.call_later(QUIET_S, lambda: (_timers.pop((c, slug), None), _spawn(_rerun(c, slug))))


async def _rerun(c: str, slug: str) -> None:
    from . import write_session  # noqa: PLC0415

    while write_session.running(c, slug):
        await asyncio.sleep(WRITER_POLL_S)
        if (c, slug) in _timers:
            return  # a later save's timer runs it
    for x in list_checks(c):
        if x.get("shown") and not running(c, x["id"], slug):
            try:
                await start_run(c, x["id"], slug)
            except Exception:  # noqa: BLE001 — one check's failure leaves the others to run
                log.exception("%s: check %s did not rerun on %s", c, x["id"], slug)


def on_report(c: str, event: dict[str, Any]) -> None:
    """report_types._emit's record: a save that changed text reruns the shown checks (changed)."""
    if event.get("type") == "report" and event.get("status") in CHANGED and event.get("slug"):
        changed(c, str(event["slug"]))


# --------------------------------------------------------------------------- the tools


def _plural(k: int, noun: str) -> str:
    return f"{k} {noun}" if k == 1 else f"{k} {noun}s"


async def tool_run_check(ctx: Any, args: dict[str, Any]) -> Any:
    """The `run_check` tool."""
    name = _collapse(args.get("name"))
    instructions = str(args.get("instructions") or "").strip()
    wanted = [str(x).strip().strip("[]").strip() for x in args.get("passages") or [] if str(x).strip()]
    if not name:
        return tools.err("run_check: `name` is required")
    check = by_name(ctx.c, name)
    how = "rerun"
    try:
        if check is None:
            if not instructions:
                return tools.err(tools.hint("run_check-no-instructions", check=name,
                                            names=", ".join(x["name"] for x in list_checks(ctx.c))))
            check = create(ctx.c, name, instructions, created_by=ctx.cell_author)
            how = "new"
        check = edit(ctx.c, check["id"], prompt=instructions or None, shown=True)
    except HTTPException as e:
        return tools.err(f"run_check: {e.detail}")
    docs: dict[str, list[str] | None] = {}
    for w in wanted:
        m = _REF_RE.match(w)
        if m:
            docs.setdefault(m.group(1), []).append(w)  # type: ignore[union-attr]
    if wanted and not docs:
        return tools.err(tools.hint("run_check-no-passage", passages=", ".join(wanted)))
    written = _written(ctx.c)
    targets = [d for d in (docs or dict.fromkeys(written)) if d in written]
    lines = []
    for doc in targets:
        rec = await start_run(ctx.c, check["id"], doc, passages_=docs.get(doc) if docs else None, force=True, notify=True)
        if rec is not None:
            lines.append(tools.hint("run_check-started", check=check["name"], how=how, doc=doc,
                                    passages=_plural(len(rec["covered"]), "passage")))
    if lines:
        return tools.ok("\n".join(lines))
    if wanted:
        return tools.err(tools.hint("run_check-no-passage", passages=", ".join(wanted)))
    return tools.ok(tools.hint("run_check-no-doc", check=check["name"]))


async def tool_add_comment(ctx: Any, args: dict[str, Any]) -> Any:
    """The `add_comment` tool. From main's shim it is a note of main's (comments.tool_add_comment); in a check's session it is
    a comment of the run beside a passage it covers, citations flattened for reading and kept as `evidence`. A paragraph's
    comment goes on its first sentence, marked `paragraph`."""
    from . import report, report_types  # noqa: PLC0415

    act = _of_session(ctx.c, ctx.session)
    if act is None:
        if tools.session_kind(ctx.session) is None:  # main's shim, its forks and subagents among it: a note of main's
            from . import comments  # noqa: PLC0415

            return await comments.tool_add_comment(ctx, args)
        return tools.err(tools.hint("add_comment-not-check"))
    ref = str(args.get("ref") or "").strip().strip("[]").strip()
    text = _collapse(args.get("text"))
    if not text:
        return tools.err("add_comment: `text` is empty")
    doc = _doc(ctx.c, act.doc)
    p = passage_of(act.doc, doc, ref)
    if doc is None or p is None:
        return tools.err(tools.hint("add_comment-no-passage", ref=ref or "(no ref)", doc=act.doc))
    if p["ref"] not in set(act.covered):
        return tools.err(tools.hint("add_comment-uncovered", ref=ref))
    m = _REF_RE.match(ref)
    whole = m is not None and bool(m.group(2))  # a comment on a paragraph (`#p<id>`), which goes on its first sentence
    uid = p["anchor"] if m is None or whole else m.group(3)
    used = report_types._ids(doc)
    from . import refs  # noqa: PLC0415

    cited = list(dict.fromkeys(refs.extract_refs(text)))
    shown = report_types.readable_ids(report.plain_text(text), cells=report_types.workspace_cell_ids(ctx.c), doc_ids=used)
    if not shown:
        return tools.err("add_comment: `text` holds nothing but citations")
    comments = doc.setdefault("comments", [])
    same = next((cm for cm in comments if isinstance(cm, dict) and cm.get("check") == act.check and cm.get("run") == act.run
                 and str(cm.get("sentence_id")) == uid and bool(cm.get("paragraph")) == whole
                 and _collapse(cm.get("text")) == shown), None)
    if same is None:
        comments.append({"id": report._new_id(used), "sentence_id": uid, **({"paragraph": True} if whole else {}),
                         "text": shown, "author": AUTHOR, "check": act.check, "run": act.run, "evidence": " ".join(cited),
                         "ts": _now(), "status": "open", "generation": int(doc.get("generation") or 1)})
        report_types.write_doc(ctx.c, investigation.MAIN, act.doc, doc)
        act.comments += 1
        check = read(ctx.c, act.check)
        rec = ((check or {}).get("runs") or {}).get(act.doc)
        if check is not None and rec is not None and rec.get("run") == act.run:
            rec["comments"] = act.comments
            save(ctx.c, check)
        report_types._emit(ctx.c, {"type": "report", "slug": act.doc, "status": "commented", "span": f"report:{act.doc}#{uid}"})
    return tools.ok(f"commented on report:{act.doc}#{uid}")


# --------------------------------------------------------------------------- routes


class CheckBody(BaseModel):
    name: str = Field(max_length=200)
    prompt: str = Field(max_length=PROMPT_CHARS * 2)


class CheckEdit(BaseModel):
    shown: bool | None = None
    name: str | None = Field(default=None, max_length=200)
    prompt: str | None = Field(default=None, max_length=PROMPT_CHARS * 2)
    colour: int | None = None


class RunBody(BaseModel):
    doc: str
    passages: list[str] | None = None


def _ws(c: str) -> None:
    try:
        config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/ws/{c}/checks")
async def list_route(c: str) -> list[dict[str, Any]]:
    _ws(c)
    return list_checks(c)


@router.post("/ws/{c}/checks", status_code=201)
async def create_route(c: str, body: CheckBody) -> dict[str, Any]:
    """A new check, made by the analyst, turned on, so it runs on every written document at once."""
    _ws(c)
    check = create(c, body.name, body.prompt, created_by="analyst")
    check = edit(c, check["id"], shown=True)
    _spawn(refresh(c, check["id"]))
    return check


@router.patch("/ws/{c}/checks/{cid}")
async def edit_route(c: str, cid: str, body: CheckEdit) -> dict[str, Any]:
    """A check's name, prompt, colour or shown changed. Turned on, it runs where it has passages to cover; turned off,
    its runs stop; a new prompt on a shown check runs it again."""
    _ws(c)
    before = read(c, cid)
    if before is None:
        raise HTTPException(404, f"no check {cid!r}")
    check = edit(c, cid, name=body.name, prompt=body.prompt, colour=body.colour, shown=body.shown)
    if body.shown is False:
        await stop_check(c, cid)
    elif check.get("shown") and (body.shown is True or check.get("version") != before.get("version")):
        _spawn(refresh(c, cid))
    return read(c, cid) or check


@router.post("/ws/{c}/checks/{cid}/runs", status_code=202)
async def run_route(c: str, cid: str, body: RunBody) -> dict[str, Any]:
    """A run of the check on one document: the passages named, else every passage but the locked blocks seen before.
    409 when the document is not written or has nothing to check."""
    from . import report_types  # noqa: PLC0415

    _ws(c)
    if read(c, cid) is None:
        raise HTTPException(404, f"no check {cid!r}")
    doc = str(body.doc or "").strip().lower().removeprefix("report:")
    if not report_types.SLUG_RE.match(doc) or report_types.read_type(c, doc) is None:
        raise HTTPException(404, f"no document {doc!r}")
    rec = await start_run(c, cid, doc, passages_=body.passages or None, force=True)
    if rec is None:
        raise HTTPException(409, f"report:{doc} has no passage to check")
    return rec


@router.post("/ws/{c}/checks/{cid}/runs/{doc}/stop")
async def stop_route(c: str, cid: str, doc: str) -> dict[str, Any]:
    """Stop the check's run on one document, running or queued: its session ends and the run ends `stopped`, keeping the
    comments it left. Answers the check; 404 for a check that does not exist."""
    _ws(c)
    check = read(c, cid)
    if check is None:
        raise HTTPException(404, f"no check {cid!r}")
    act = _active.get((c, cid, doc))
    _dirty.discard((c, cid, doc))  # a Stop is not followed by the rerun a save during the run asked for
    if act is not None:
        await stop(act)
    else:
        rec = (check.get("runs") or {}).get(doc)
        if isinstance(rec, dict) and rec.get("status") == "running":
            rec.update(status="stopped", ended=_now())
            rec.pop("waiting", None)
            save(c, check)
            _stream(c, cid, doc, "stopped", str(rec.get("run") or ""), str(rec.get("chat") or ""))
    return read(c, cid) or check


async def shutdown() -> None:
    """The server is going down: the reruns waiting are dropped and the runs stop (agent_session.shutdown ends their
    sessions)."""
    for h in list(_timers.values()):
        h.cancel()
    _timers.clear()
    for act in list(_active.values()):
        if act.task is not None and not act.task.done():
            act.task.cancel()
    for t in list(_tasks):
        t.cancel()
