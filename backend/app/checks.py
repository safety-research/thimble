"""Report checks: each an independent prompt that leaves comments on a document's passages, reads the document with all
the context, can do work, and can be created and run from the chat. A check runs again after a writer saves the
document, but is cached: a passage whose text did not change, or that is locked, is not checked again.

A check is `workspaces/<c>/checks/<id>.json` = {id, name, prompt, colour, shown, builtin, created_by, ts, version,
runs: {doc: Run}}. The built-ins (`unverified`, `verified`, `judgment`) are prompts/checks/<id>.md, read from the
prompt file until first changed. An active extension's report checks, checks/<slug>/check.json (its name and colour)
and check.md (its prompt) in its folder, follow the built-ins as `<extension>-<slug>`, off and read from the extension
until first changed, as the built-ins are. A run is a `thimble:check`, a subagent of the analyst's Claude Code session
(subagents.py), registered from prompts/check.md (definition) on Settings' checks row, with the corpus read-only and a
work folder of its own, check-work/<id>-<doc>/. Its task file there, task.md, holds the context engine's part
(context.render) and then the document, the check's prompt and the passages it covers; its prompt names that file
(`## check-task-file`). It comments with add_comment and hands back one line, its run's summary. At most MAX_SESSIONS
run at once; the others wait queued. A run has no time limit, and the analyst's Stop ends it (through thimble's plugin
module, subagents.stop).

How a run starts: a writer's end starts each shown check on its document, a follow-on start of the writer's own start
(_writer_ended); Run on a check's row, or turning a check on, is the analyst's click; main's run_check gives main the
exact Agent call (tool_run_check), and a thread's fork's gives it to main in a `start_agent` event (tools._ask_main).
The analyst's own edits start nothing: each shown check's run records how many passages changed since it checked them
(`stale`, mark_stale), and Run is one click.

The cache: a passage (paragraph, heading, slide, beat or free sentence) is fingerprinted by the sentence_key of its
words. A run covers only passages whose fingerprint its check has not seen on that document; a run that ends `done`
supersedes the check's earlier open comments on those passages and records their fingerprints in `seen`. Main hears
`checked {check, doc, status, comments}` when a run run_check started ends.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import config, investigation, prompts, tools, userconf, work_files
from .kernel_thimble import LABEL_ORDER
from .ledger import read_json, write_json, write_under

log = logging.getLogger("thimble.checks")
router = APIRouter()

AGENT = "check"  # prompts/check.md, the check agent's definition
ROLE = "check"  # a run's chat role, and its role among subagents.TYPES (`thimble:check`, on Settings' `checks` row)
WRITER_ROLE = "writer"  # the chat role of a writer, whose end starts the shown checks (_writer_ended)
AUTHOR = "check"  # a check's comment's author (report.CHECK_AUTHOR)
DIR = "checks"  # workspaces/<c>/checks/<id>.json
WORK_DIR = "check-work"  # workspaces/<c>/check-work/<id>-<doc>/, a run's own folder, where its Bash may write
TASK_FILE = "task.md"  # in a run's own folder: what its agent reads first
OWN_TOOLS = ("read_ref", "list_cards", "add_comment")  # a check's thimble tools
BUILTINS = ("unverified", "verified", "judgment")  # prompts/checks/<id>.md, listed first in this order
COLOURS = tuple(range(1, 9))  # the label palette's places a check's color may take (kernel_thimble.LABEL_COLOURS)
NEW_COLOURS = tuple(m for m in LABEL_ORDER if m in COLOURS)  # the order new checks take them, as new label values do
CONTEXT_CHARS = 400_000  # of the context engine's part of a run's first message
WAITING_QUEUED = "queued"  # a run's `waiting` while it waits for a place (MAX_SESSIONS)
WAITING_PLAN = "plan"  # a run's `waiting` while main is in plan mode, where a writer's end holds the runs it starts
MAX_SESSIONS = 3  # runs whose agents run at once
LIMIT_RETRY_S = 30.0  # a start Claude Code refused at its subagent limit is tried again after this long, or at an end
TYPED = "typed"  # subagents.TYPED: main's run_check makes the Agent call
INTERRUPTED = "thimble's server stopped, and this run's agent was not running when it came back"  # recover
CHANGED = ("generated", "rewritten", "edited")  # the `report` statuses of a save that changes text
CHECKED_KIND = "checked"  # the browser event that tells main a run it started ended (prompts/main.md)
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


def from_extensions(c: str) -> dict[str, dict[str, Any]]:
    """{id: check} of the report checks of the active extensions in workspace `c`, each off and never run, by
    `<extension>-<slug>`; one whose check.md is empty or missing is left out."""
    from . import extensions  # noqa: PLC0415 — extensions imports the views module

    out: dict[str, dict[str, Any]] = {}
    for e in extensions.active(c):
        for k in e.get("checks") or []:
            slug = str(k.get("slug") or "") if isinstance(k, dict) else ""
            cid = f"{e['name']}-{slug}"
            folder = Path(str(e["src"])) / "checks" / slug
            try:
                prompt = (folder / "check.md").read_text("utf-8").strip()[:PROMPT_CHARS]
            except OSError:
                prompt = ""
            raw = read_json(folder / "check.json", {})
            raw = raw if isinstance(raw, dict) else {}
            colour = raw.get("colour")
            colour = int(colour) if isinstance(colour, (int, str)) and str(colour).isdigit() else None
            if not slug or not prompt or not ID_RE.match(cid) or cid in BUILTINS:
                continue
            out[cid] = {"id": cid, "name": _collapse(raw.get("name") or slug)[:NAME_CHARS], "prompt": prompt,
                        "colour": colour if colour in COLOURS else NEW_COLOURS[len(out) % len(NEW_COLOURS)], "shown": False,
                        "builtin": True, "created_by": str(e["name"]), "ts": "", "version": 1, "runs": {}}
    return out


def read(c: str, cid: str) -> dict[str, Any] | None:
    """The check `cid`: its workspace file, else the built-in of that id, else an active extension's; None when none
    exists."""
    stored = read_json(_path(c, cid), None)
    if isinstance(stored, dict):
        stored.setdefault("runs", {})
        return stored
    return builtin(cid) or from_extensions(c).get(cid)


def list_checks(c: str) -> list[dict[str, Any]]:
    """Every check, the built-ins first in their order, then the active extensions' checks, then the others in the
    order they were made."""
    out = [x for cid in BUILTINS if (x := read(c, cid)) is not None]
    theirs = from_extensions(c)
    out += [x for cid in theirs if (x := read(c, cid)) is not None]
    d = _dir(c)
    others = []
    for p in sorted(d.glob("*.json")) if d.is_dir() else []:
        if p.stem in BUILTINS or p.stem in theirs:
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
    """The first color no check has, else the one fewest have, in the order new checks take them (NEW_COLOURS)."""
    used = [x.get("colour") for x in list_checks(c)]
    return next((k for k in NEW_COLOURS if k not in used), min(NEW_COLOURS, key=used.count))


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
    the whole passage goes on and `ids` every id that names the passage or a sentence in it. The title comes first, at
    `report:<slug>#title`, since it states the document's main claim (live check term-fix8: a wrong span of time in the
    title, which no check read)."""
    from . import report_types as rt  # noqa: PLC0415

    if not doc:
        return []
    key = rt.sentence_key
    out: list[dict[str, Any]] = []
    in_units: set[str] = set()
    title = _collapse(doc.get("title"))
    if title:
        out.append({"ref": f"report:{slug}#{rt.TITLE_BLOCK}", "kind": "title", "fp": fingerprint("t", [key(title)]),
                    "locked": doc.get("title_locked") is True, "anchor": rt.TITLE_BLOCK, "ids": [rt.TITLE_BLOCK]})

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
    """A run of a check on a document while it goes: queued for a place (MAX_SESSIONS), started (its pending request,
    then its agent, a `thimble:check` subagent of main), or an extension's program's job."""

    c: str
    check: str
    doc: str
    run: str
    notify: bool  # run_check started it, so main hears when it ends
    covered: list[str]
    fps: list[str]
    route: str = "follow-on"  # how its agent starts (subagents.ROUTES)
    call: str | None = None  # main's run_check call, for a typed start (R3)
    request: str | None = None  # its pending request (subagents.json)
    agent: str | None = None  # its agent, once it started
    answer: Any = None  # the start's answer: for a typed start the exact Agent call main makes
    task: asyncio.Task | None = None
    program: bool = False  # an extension's program runs the checks task (tasks.program), in harness.py
    comments: int = 0
    ended: bool = False


_active: dict[tuple[str, str, str], _Active] = {}  # (workspace, check, doc) -> its run
_queue: list[_Active] = []  # runs waiting for a place, in the order they came
_tasks: dict[asyncio.Task, str] = {}  # the starts and refreshes that run -> their workspace
_retry_handle: asyncio.TimerHandle | None = None


def session_key(cid: str, doc: str) -> str:
    """The key of a run of check `cid` on `doc`, the session its calls run as (tools.session_kind reads `check`)."""
    return f"{tools.CHECK_SESSION}:{cid}:{doc}"


def _of_session(c: str, key: str | None) -> _Active | None:
    parts = str(key or "").split(":")
    if len(parts) != 3 or parts[0] != tools.CHECK_SESSION:
        return None
    return _current(c, parts[1], parts[2])


def running(c: str, cid: str, doc: str) -> bool:
    return _current(c, cid, doc) is not None


def _terminal(c: str) -> bool:
    from . import subagent_files  # noqa: PLC0415

    try:
        return subagent_files.terminal(config.workspace_dir(c))
    except (OSError, ValueError):
        return False


def _current(c: str, cid: str, doc: str) -> _Active | None:
    """The run of check `cid` on `doc` that goes. In browser mode the server holds every run (_active). In terminal mode
    the process that starts a run (the shim for main's run_check, a hook's process for a writer's follow-on) is not the
    one that hears its agent start and end (a hook's process) or takes its comments (the shim), so the check's file
    decides: a run it records `running` that this process does not hold is taken up from the record, as recover takes
    up a previous server's, and a run this process holds that the file records ended, or replaced, is let go."""
    act = _active.get((c, cid, doc))
    if not _terminal(c):
        return act
    rec = ((read(c, cid) or {}).get("runs") or {}).get(doc)
    live = isinstance(rec, dict) and rec.get("status") == "running" and bool(rec.get("run"))
    if act is not None and not act.ended and (not live or rec.get("run") != act.run):
        under_way = act.task is not None and not act.task.done()  # a start this process has under way
        unsaved = not act.agent and not act.request and act.task is None  # one start_run makes before its record
        if not under_way and not unsaved:
            _active.pop((c, cid, doc), None)
            if act in _queue:
                _queue.remove(act)
            act = None
    if act is None and live:
        act = _Active(c, cid, doc, str(rec["run"]), bool(rec.get("notify")), list(rec.get("covered") or []),
                      list(rec.get("fps") or []), agent=str(rec.get("agent_id") or "") or None,
                      comments=int(rec.get("comments") or 0))
        _active[(c, cid, doc)] = act
    return act


def _prune(c: str | None = None) -> None:
    """In terminal mode, let go of the runs this process holds that another process ended (_current)."""
    for (cc, cid, doc) in list(_active):
        if c is None or cc == c:
            _current(cc, cid, doc)


def recover(root: Path | None = None) -> list[str]:
    """Server start: a run a check's file records as `running` belonged to a previous server. Its agent, a subagent of
    main, may run on: the run takes its place again (_active), so its comments still land. A run with no agent running
    ends `stopped`, its passages stale (Run starts it again). Returns `<workspace>/<check>/<doc>` per run ended."""
    from . import subagents  # noqa: PLC0415

    root = config.WORKSPACES_DIR if root is None else root
    ended: list[str] = []
    for p in sorted(root.glob(f"*/{DIR}/*.json")) if root.is_dir() else []:
        check = read_json(p, None)
        if not isinstance(check, dict) or not isinstance(check.get("runs"), dict):
            continue
        c = p.parent.parent.name
        changed = False
        for doc, rec in check["runs"].items():
            if not isinstance(rec, dict) or rec.get("status") != "running":
                continue
            aid = str(rec.get("agent_id") or "")
            try:
                a = subagents.agent(c, aid) if aid else None
            except Exception:  # noqa: BLE001 — a workspace that cannot be read ends its runs
                a = None
            if a is not None and a.get("status") in ("running", "waiting"):
                _active[(c, str(check["id"]), str(doc))] = _Active(
                    c, str(check["id"]), str(doc), str(rec.get("run") or ""), bool(rec.get("notify")),
                    list(rec.get("covered") or []), list(rec.get("fps") or []), agent=aid)
                continue
            rec.update(status="stopped", ended=_now(), summary=INTERRUPTED)
            rec.pop("waiting", None)
            changed = True
            ended.append(f"{c}/{p.stem}/{doc}")
        if changed:
            write_json(p, check)
    return ended


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    """The router's lifespan: the runs the previous server left take their places again or end (recover)."""
    try:
        ended = await asyncio.to_thread(recover)
        if ended:
            log.info("check runs the previous server left with no agent, ended stopped: %s", ", ".join(ended))
    except Exception:  # noqa: BLE001 — never fails the start
        log.exception("recovering check runs failed")
    yield


router.lifespan_context = _lifespan


def agent_definition() -> tuple[str, dict[str, Any]]:
    """(name, definition) of the check agent, from prompts/check.md (cli.agent_definition)."""
    from . import cli  # noqa: PLC0415 — cli is large, and the definition's shape is the launcher's

    return cli.agent_definition(AGENT)


def definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:check` for workspace `c` (subagents.roles adds its model, effort and `background`):
    check.md's body and its frontmatter's description, as the config or the active extensions change it, and the
    thimble tools that are not a check's taken away."""
    with prompts.custom(userconf.prompt_files(c, "checks")):
        _, agent = agent_definition()
    out = {k: agent[k] for k in ("description", "prompt") if k in agent}
    out["disallowedTools"] = tools.not_own(OWN_TOOLS)
    return out


def work_dir(c: str, cid: str, doc: str) -> Path:
    """A run's own folder, check-work/<id>-<doc>, which main's fence lets its agent write (subagents.write_dirs)."""
    return config.workspace_dir(c) / WORK_DIR / f"{cid}-{doc}"


def _stream(c: str, cid: str, doc: str, status: str, run: str, chat: str, **extra: Any) -> None:
    try:
        investigation.emit(c, investigation.MAIN, {"type": "check", "id": cid, "doc": doc, "status": status, "run": run,
                                                   "chat": chat, **extra})
    except Exception:  # noqa: BLE001 — the browser rereads the checks on its next record
        log.debug("%s: check record not emitted for %s on %s", c, cid, doc, exc_info=True)


def task_text(c: str, check: dict[str, Any], doc: str, cover: list[dict[str, Any]]) -> str:
    """The task of a run's task file."""
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
    """A run's task file: the context engine's part (CONTEXT_CHARS), then the task (task_text)."""
    from . import context  # noqa: PLC0415 — context imports this module for the check names

    return context.render(c, task_text(c, check, doc, cover), budget=CONTEXT_CHARS, focus=(f"report:{doc}",))


async def start_run(c: str, cid: str, doc: str, *, passages_: list[str] | None = None, force: bool = False,
                    notify: bool = False, route: str = "follow-on", call: str | None = None) -> dict[str, Any] | None:
    """Start a run of check `cid` on the written document `doc` and return its record, or None when it has nothing to
    cover or the document is not written. A running run of it on `doc` is stopped first. `notify` tells main when it
    ends. Its agent starts as `route` says (subagents.start_job): a click (Run) or a follow-on start (a writer's end)
    through main's module when a place is free (MAX_SESSIONS), queued otherwise; a typed start (main's run_check) at
    once, as the exact Agent call main makes, which the record's `_answer` holds for the tool."""
    from . import investigation as inv, report_types  # noqa: PLC0415

    check = read(c, cid)
    if check is None:
        raise ValueError(f"no check {cid!r}")
    d = report_types.read_doc(c, inv.MAIN, doc)
    cover = to_cover(check, doc, d, passages_, force) if d is not None else []
    if not cover:
        return None
    old = _current(c, cid, doc)
    if old is not None:
        await stop(old)
        check = read(c, cid) or check
    prev = (check.get("runs") or {}).get(doc) or {}
    rec = {"run": secrets.token_hex(4), "status": "running", "chat": "", "started": _now(), "ended": None,
           "covered": [p["ref"] for p in cover], "fps": [p["fp"] for p in cover], "seen": list(prev.get("seen") or []),
           "comments": 0, "summary": "", "stale": 0, "notify": notify or None, "agent_id": None, "refused": None}
    act = _Active(c, cid, doc, rec["run"], notify, rec["covered"], rec["fps"], route=route, call=call)
    _active[(c, cid, doc)] = act
    if route == TYPED:
        check.setdefault("runs", {})[doc] = rec
        save(c, check)
        await _launch(act)
        if act.ended:
            return {**rec, **(((read(c, cid) or {}).get("runs") or {}).get(doc) or {}), "_answer": act.answer}
        return {**rec, "_answer": act.answer}
    queued = _places() >= MAX_SESSIONS
    if queued:
        rec["waiting"] = WAITING_QUEUED
        _queue.append(act)
    check.setdefault("runs", {})[doc] = rec
    save(c, check)
    _stream(c, cid, doc, "running", rec["run"], "", **({"waiting": WAITING_QUEUED} if queued else {}))
    if not queued:
        act.task = asyncio.get_running_loop().create_task(_go(act), name=f"check:{c}:{cid}:{doc}")
    return rec


def _places() -> int:
    """The runs holding a place: started, or starting; in terminal mode not one another process ended (_prune)."""
    _prune()
    return sum(1 for a in _active.values() if not a.ended and a not in _queue
               and (a.agent or a.request or (a.task is not None and not a.task.done()) or a.program))


async def _wait_out_of_plan(act: _Active) -> None:
    """A run a writer's end started waits while main is in plan mode (subagents.out_of_plan), its record `waiting` for
    plan mode meanwhile, so its row says what it waits for (live check L21: it said it waited for a free session)."""
    from . import session, subagents  # noqa: PLC0415
    from .subagent_files import PLAN_MODE  # noqa: PLC0415

    if session.main_mode(act.c) != PLAN_MODE:
        return
    _set_waiting(act, WAITING_PLAN)
    try:
        await subagents.out_of_plan(act.c)
    finally:
        _set_waiting(act, None)


def _set_waiting(act: _Active, waiting: str | None) -> None:
    check = read(act.c, act.check)
    rec = ((check or {}).get("runs") or {}).get(act.doc)
    if check is None or not isinstance(rec, dict) or rec.get("run") != act.run:
        return
    if waiting:
        rec["waiting"] = waiting
    else:
        rec.pop("waiting", None)
    save(act.c, check)
    _stream(act.c, act.check, act.doc, "running", act.run, "", **({"waiting": waiting} if waiting else {}))


def _pump() -> None:
    """Start the queued runs a place frees for, in order."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    while _queue and _places() < MAX_SESSIONS:
        act = _queue.pop(0)
        if act.ended:
            continue
        check = read(act.c, act.check)
        rec = ((check or {}).get("runs") or {}).get(act.doc)
        if check is not None and isinstance(rec, dict) and rec.get("run") == act.run and rec.pop("waiting", None):
            save(act.c, check)
        _stream(act.c, act.check, act.doc, "running", act.run, "")
        act.task = loop.create_task(_go(act), name=f"check:{act.c}:{act.check}:{act.doc}")


def _retry_later(delay: float | None = None) -> None:
    """Look at the queue again in `delay` seconds (LIMIT_RETRY_S), once however many ask."""
    global _retry_handle
    delay = LIMIT_RETRY_S if delay is None else delay
    if _retry_handle is not None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    def again() -> None:
        global _retry_handle
        _retry_handle = None
        _pump()

    _retry_handle = loop.call_later(delay, again)


async def _go(act: _Active) -> None:
    """A run's start once it has a place (_launch); a failure to start ends it failed."""
    try:
        await _launch(act)
    except asyncio.CancelledError:
        _finish(act, "stopped", "")
        raise
    except Exception as e:  # noqa: BLE001 — a run that cannot start is failed, never left running
        log.exception("%s: the run of check %s on %s did not start", act.c, act.check, act.doc)
        _finish(act, "failed", f"{type(e).__name__}: {e}")


async def _launch(act: _Active) -> None:
    """Write the run's task file (first_message), then start its agent (subagents.start_job, `thimble:check`) on
    Settings' checks row, as its route says; or the run as an extension's program of the checks task (_program)."""
    from . import subagents, tasks  # noqa: PLC0415 — tasks reads the extensions

    c = act.c
    check = read(c, act.check)
    if check is None:
        _finish(act, "failed", f"no check {act.check}")
        return
    cover = [p for p in passages(act.doc, _doc(c, act.doc)) if p["ref"] in set(act.covered)]
    text = await asyncio.to_thread(first_message, c, check, act.doc, cover)
    if act.ended:
        return
    part = tasks.program(c, "checks")
    if part is not None:
        await _program(act, check, cover, text, part)
        return
    work = work_dir(c, act.check, act.doc)
    path = work / TASK_FILE
    await asyncio.to_thread(_write_task, c, path, text)
    if act.route == subagents.FOLLOW_ON:
        await _wait_out_of_plan(act)
    if act.ended:
        return
    ans = await subagents.start_job(
        c, ROLE, session_key(act.check, act.doc), tools.hint("check-task-file", path=str(path)),
        subagents.values_for(c, ROLE), act.route, description=f"check: {check['name']} · {act.doc}",
        chat={"title": str(check["name"]), "check": act.check, "doc": act.doc, "run_id": act.run, "announce": False,
              "brief": tools.hint("check-instructions", check=check["name"],
                                  prompt=str(check.get("prompt") or "").strip())},
        work=work, call=act.call)
    act.answer = ans
    if ans.refused:
        if ans.get("request") is None:  # refused before a request was made (subagents.refusal_before)
            _refused(act, ans.kind or subagents.ERROR, ans.reason, None)
        return  # a request refused went through subagent_refused
    if not act.agent:  # a typed start's request, until its agent starts (subagent_started)
        act.request = str(ans.get("request") or "") or None


def _write_task(c: str, path: Path, text: str) -> None:
    """The run's task file, in a folder its agent and main's Bash can write, so never through a link (write_under)."""
    write_under(config.workspace_dir(c), path, text + "\n")


def subagent_started(c: str, run: Any, req: dict[str, Any]) -> None:
    """A check's agent started (subagents.Type.started): its run names the agent and its chat. A later run of the same
    agent (a message typed to it in the agent tray) changes nothing here."""
    act = _of_session(c, run.key)
    if act is None or (act.agent and act.agent != run.agent_id):
        return
    act.agent, act.request = run.agent_id, None
    check = read(c, act.check)
    rec = ((check or {}).get("runs") or {}).get(act.doc)
    if check is not None and isinstance(rec, dict) and rec.get("run") == act.run:
        rec.update(agent_id=run.agent_id, chat=run.chat)
        rec.pop("waiting", None)
        save(c, check)
    _stream(c, act.check, act.doc, "running", act.run, run.chat)


def subagent_ended(c: str, run: Any, status: str, report: str) -> None:
    """A check's agent's run ended (subagents.Type.ended): its run ends with the agent's last line (_finish), and its
    work folder lets go of what it no longer needs."""
    act = _of_session(c, run.key)
    if act is None or act.agent != run.agent_id:
        return
    work_files.after_run(c, work_dir(c, act.check, act.doc), status)
    _finish(act, status, report)


def subagent_refused(c: str, req: dict[str, Any]) -> None:
    """A check's start that did not happen (subagents.Type.refused): at Claude Code's subagent limit it goes back to the
    queue and starts again when a place frees; otherwise its run ends failed with the refusal, which its row shows
    with Start it."""
    if req.get("kind") != "start":
        return
    act = _of_session(c, str(req.get("key") or ""))
    if act is None or (act.request and req.get("id") and act.request != req.get("id")):
        return
    _refused(act, str(req.get("refused_kind") or "error"), str(req.get("reason") or ""), req.get("id"),
             expired=bool(req.get("expired")))


def _refused(act: _Active, kind: str, reason: str, rid: Any, expired: bool = False) -> None:
    from . import subagents  # noqa: PLC0415

    if kind == subagents.LIMIT and act.route != subagents.TYPED:
        act.request = None
        act.task = None
        if act not in _queue:
            _queue.insert(0, act)
        _retry_later()
        return
    check = read(act.c, act.check)
    rec = ((check or {}).get("runs") or {}).get(act.doc)
    if check is not None and isinstance(rec, dict) and rec.get("run") == act.run:
        rec["refused"] = {"kind": kind, "reason": reason, "request": rid, "expired": expired or None, "at": _now()}
        save(act.c, check)
    _finish(act, "failed", reason)


async def _program(act: _Active, check: dict[str, Any], cover: list[dict[str, Any]], prompt: str, part: Any) -> None:
    """The run as an extension's program of the checks task, in an agent chat of its own; it comments through
    add_comment as the run's session, and what it returns is the run's summary. It runs until it ends or is stopped."""
    from . import harness  # noqa: PLC0415

    c = act.c
    job = harness.task_job(c, "checks", check_input(check, act.doc, cover, prompt), key=session_key(act.check, act.doc),
                           title=str(check["name"]), work=work_dir(c, act.check, act.doc), chat_role=ROLE,
                           fields={"check": act.check, "doc": act.doc, "run_id": act.run})
    done: asyncio.Future = asyncio.get_running_loop().create_future()

    def ended(run: harness.Run, status: str, summary: str) -> None:
        _finish(act, status, summary)
        if not done.done():
            done.set_result(status)

    try:
        run = harness.start(job, part, on_end=ended)
    except RuntimeError as e:
        _finish(act, "failed", str(e))
        return
    act.program = True
    _chat(act, run.chat)
    try:
        await asyncio.shield(done)
    except asyncio.CancelledError:
        if not act.ended:
            with contextlib.suppress(Exception):
                await harness.stop(c, session_key(act.check, act.doc))
        raise


def check_input(check: dict[str, Any], doc: str, cover: list[dict[str, Any]], context: str) -> dict[str, Any]:
    """The checks task's input (tasks.py): the check (its id, name and prompt), the document, the passages the run
    covers ({ref, kind, anchor}, the id a comment on the whole passage goes on) and the run's task file's text, which
    holds the document and the context engine's part."""
    return {"check": {"id": str(check["id"]), "name": str(check["name"]), "prompt": str(check.get("prompt") or "").strip()},
            "doc": doc, "passages": [{"ref": p["ref"], "kind": p["kind"], "anchor": p["anchor"]} for p in cover],
            "context": context}


async def check_task(c: str, inp: dict[str, Any], *, model: str | None = None, program: Any = None) -> Any:
    """thimble's own checks task (tasks.py), lent to a program that runs it: a Claude Code session as the check agent
    (prompts/check.md) on the input's `context`, run as the program's run (harness.session_call), which comments
    with add_comment as thimble's own run does, on Settings' checks row. A model.CallResult whose output is the
    session's last reply."""
    from . import harness, model as model_mod, subagents  # noqa: PLC0415

    if program is None:
        return model_mod.CallResult(status="error", detail="the checks task runs only in a program's run")
    with prompts.custom(userconf.prompt_files(c, "checks")):
        _, agent = agent_definition()
    values = subagents.values_for(c, ROLE, {"model": model} if model else None)
    payload = {"prompt": str(inp.get("context") or ""), "system": str(agent.get("prompt") or ""),
               "model": values["model"], "effort": values["effort"]}
    try:
        reply = await harness.session_call(program, payload)
    except harness.HarnessError as e:
        return model_mod.CallResult(status="error", detail=str(e))
    return model_mod.CallResult(status="ok", output=reply)


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
    covered superseded and their fingerprints seen; main told when run_check started it. The passages that changed
    meanwhile, or that a run that did not finish left, count as stale. A queued run takes its place."""
    from . import events, report  # noqa: PLC0415

    if act.ended:
        return
    act.ended = True
    c = act.c
    if _active.get((c, act.check, act.doc)) is act:
        _active.pop((c, act.check, act.doc), None)
    if act in _queue:
        _queue.remove(act)
    try:
        status = status if status in ("done", "failed", "stopped") else "failed"
        last = next((ln.strip() for ln in reversed(str(summary or "").strip().splitlines()) if ln.strip()), "")
        check = read(c, act.check)
        rec = ((check or {}).get("runs") or {}).get(act.doc)
        if check is None or rec is None or rec.get("run") != act.run:
            return  # a newer run took its place
        doc = _doc(c, act.doc)
        # the run's comments as the document holds them: in terminal mode the shim takes them, in another process
        act.comments = max(act.comments, sum(1 for cm in (doc or {}).get("comments") or []
                                             if isinstance(cm, dict) and cm.get("check") == act.check
                                             and cm.get("run") == act.run))
        rec.update(status=status, ended=_now(), summary=last[:SUMMARY_CHARS], comments=act.comments)
        rec.pop("waiting", None)
        if status == "done":
            ps = passages(act.doc, doc)
            covered = set(act.covered)
            if doc is not None:
                gone = 0
                for cm in doc.get("comments") or []:
                    if (isinstance(cm, dict) and cm.get("check") == act.check and cm.get("run") != act.run
                            and (cm.get("status") or "open") == "open"
                            and _of_comment(act.doc, ps, str(cm.get("sentence_id"))) in covered):
                        cm.update(status=report.SETTLED_STATUS, resolution=report.RESOLUTION_SUPERSEDED,
                                  superseded_by=act.run)
                        gone += 1
                if gone:
                    from . import report_types  # noqa: PLC0415

                    report_types.write_doc(c, investigation.MAIN, act.doc, doc)
            now = {p["fp"] for p in ps}
            rec["seen"] = sorted({fp for fp in rec.get("seen") or [] if fp in now} | set(act.fps))
        rec["stale"] = len(to_cover(check, act.doc, doc)) if doc is not None and check.get("shown") else 0
        save(c, check)
        _stream(c, act.check, act.doc, status, act.run, str(rec.get("chat") or ""), stale=rec["stale"])
        if act.notify:
            try:
                events.post(c, CHECKED_KIND, {"text": rec["summary"] or status, "check": act.check, "doc": act.doc,
                                               "status": status, "comments": act.comments})
            except HTTPException as e:
                log.info("%s: main did not hear that check %s ended on %s (%s %s)", c, act.check, act.doc,
                         e.status_code, e.detail)
    finally:
        _pump()


async def stop(act: _Active) -> None:
    """Stop a run: its agent through main's module (subagents.stop), whose end ends the run stopped; its program; a
    typed start main has yet to make, which thimble's hook denies from now on; or its place in the queue."""
    from . import harness, subagents  # noqa: PLC0415

    if act.ended:
        return
    if act.agent:
        ans = await subagents.stop(act.c, act.agent)
        if not ans.refused and not ans.get("done"):
            return  # the agent's end (subagent_ended) ends the run
    elif act.program:
        await harness.stop(act.c, session_key(act.check, act.doc))
    elif act.request:
        subagents.refuse(act.c, act.request, "the run was stopped", subagents.HOOK)
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


async def refresh(c: str, cid: str, route: str = "click") -> list[dict[str, Any]]:
    """Run check `cid` on every written document where it has passages to cover and no run running (a check turned on
    in the browser, a click)."""
    out = []
    for doc in _written(c):
        if running(c, cid, doc):
            continue
        rec = await start_run(c, cid, doc, route=route)
        if rec is not None:
            out.append(rec)
    return out


def _spawn(c: str, coro: Any) -> None:
    t = asyncio.ensure_future(coro)
    _tasks[t] = c
    t.add_done_callback(lambda done: _tasks.pop(done, None))


# --------------------------------------------------------------------------- saves


def _writer_ended(c: str, meta: dict[str, Any]) -> None:
    """A writer's chat ended (agents.on_agent_finished): when it finished, each shown check runs on its document, as a
    follow-on start of the writer's own start (Q5), covering the passages it has not seen."""
    if meta.get("role") != WRITER_ROLE or meta.get("status") != "done" or not meta.get("doc"):
        return
    doc = str(meta["doc"])
    shown = [x for x in list_checks(c) if x.get("shown")]
    if not shown:
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    _spawn(c, _run_shown(c, doc, [str(x["id"]) for x in shown]))


async def _run_shown(c: str, doc: str, ids: list[str]) -> None:
    for cid in ids:
        if running(c, cid, doc):
            continue
        try:
            await start_run(c, cid, doc, route="follow-on")
        except Exception:  # noqa: BLE001 — one check's failure leaves the others to run
            log.exception("%s: check %s did not run on %s after its writer", c, cid, doc)


def mark_stale(c: str, slug: str) -> None:
    """A save that changed the text of document `slug` (the analyst's own edits, an edit of main's): no run starts;
    each shown check's run on it records how many of its passages changed since it checked them (`stale`, to_cover),
    which its row shows with Run (Q8). A run that goes counts them when it ends."""
    from . import investigation as inv, report_types  # noqa: PLC0415

    d = report_types.read_doc(c, inv.MAIN, slug)
    if d is None:
        return
    for x in list_checks(c):
        if not x.get("shown") or running(c, x["id"], slug):
            continue
        check = read(c, x["id"]) or x
        rec = (check.get("runs") or {}).get(slug)
        n = len(to_cover(check, slug, d))
        if isinstance(rec, dict):
            if rec.get("stale") == n:
                continue
            rec["stale"] = n
        elif not n:
            continue
        else:
            check.setdefault("runs", {})[slug] = {"run": "", "status": "stale", "stale": n, "covered": [], "seen": [],
                                                  "comments": 0, "summary": "", "chat": ""}
        save(c, check)
        _stream(c, str(x["id"]), slug, "stale", str((check["runs"][slug]).get("run") or ""), "", stale=n)


def on_report(c: str, event: dict[str, Any]) -> None:
    """report_types._emit's record: a save that changed text marks the shown checks stale on that document (mark_stale);
    a writer's end starts them (_writer_ended)."""
    if event.get("type") == "report" and event.get("status") in CHANGED and event.get("slug"):
        try:
            mark_stale(c, str(event["slug"]))
        except Exception:  # noqa: BLE001 — a stale count is no reason to fail a save
            log.exception("%s: the checks' stale counts of %s were not kept", c, event.get("slug"))


# --------------------------------------------------------------------------- the tools


def _plural(k: int, noun: str) -> str:
    return f"{k} {noun}" if k == 1 else f"{k} {noun}s"


async def tool_run_check(ctx: Any, args: dict[str, Any]) -> Any:
    """The `run_check` tool, main's: the check made or changed and turned on, and for each written document a run whose
    agent main starts with the exact Agent call the result gives (`## start_job-subagent`), as a typed start. A thread's
    fork's call starts each run the same way, by main's Agent call on a `start_agent` event of its own
    (tools._ask_main), since the fork may not make it."""
    import json  # noqa: PLC0415

    from . import subagents  # noqa: PLC0415

    fork = await tools._fork_of(ctx) if ctx.session is None else None
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
    if targets and (before := subagents.refusal_before(ctx.c)) is not None:
        return tools.err(before.reason or f"run_check: {before.kind}")
    lines, refused = [], []
    for doc in targets:
        # a fork's run keeps no call of the fork's: main's Agent call claims it (tools._ask_main)
        rec = await start_run(ctx.c, check["id"], doc, passages_=docs.get(doc) if docs else None, force=True, notify=True,
                              route=TYPED, call=None if fork is not None else ctx.tool_use_id)
        if rec is None:
            continue
        ans = rec.get("_answer")
        if ans is None or getattr(ans, "refused", False) or "input" not in ans:
            refused.append(getattr(ans, "reason", "") or str(rec.get("summary") or "") or "it did not start")
            continue
        if fork is not None:
            res = await tools._ask_main(ctx, ans, what=f"a run of the check {check['name']} on report:{doc}",
                                        thread=fork, agent="the check")
            (refused if res.is_error else lines).append(res.text)
            continue
        lines.append(tools.hint("run_check-started", check=check["name"], how=how, doc=doc,
                                passages=_plural(len(rec["covered"]), "passage")))
        lines.append(tools.hint("start_job-subagent", input=json.dumps(ans["input"], ensure_ascii=False)))
    if lines:
        return tools.ok("\n\n".join(lines))
    if refused:
        return tools.err(f"run_check: {refused[0]}")
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


def _click(request: Request) -> None:
    """403 unless the request carries the analyst's browser cookie: a click that starts or stops a check's agent, which
    auto mode does not judge (subagents.analyst_only)."""
    from . import subagents  # noqa: PLC0415

    subagents.analyst_only(request)


@router.post("/ws/{c}/checks", status_code=201)
async def create_route(c: str, body: CheckBody, request: Request) -> dict[str, Any]:
    """A new check, made by the analyst and turned on, a click: it runs on every written document at once."""
    _click(request)
    _ws(c)
    check = create(c, body.name, body.prompt, created_by="analyst")
    check = edit(c, check["id"], shown=True)
    _spawn(c, refresh(c, check["id"]))
    return check


@router.patch("/ws/{c}/checks/{cid}")
async def edit_route(c: str, cid: str, body: CheckEdit, request: Request) -> dict[str, Any]:
    """A check's name, prompt, colour or shown changed. Turned on, it runs where it has passages to cover; turned off,
    its runs stop; a new prompt on a shown check runs it again. Each that starts or stops a run is a click."""
    _ws(c)
    before = read(c, cid)
    if before is None:
        raise HTTPException(404, f"no check {cid!r}")
    starts = body.shown is True or (body.prompt is not None and (before.get("shown") or body.shown)
                                    and str(body.prompt).strip() != before.get("prompt"))
    if starts or (body.shown is False and any(k[0] == c and k[1] == cid for k in _active)):
        _click(request)
    check = edit(c, cid, name=body.name, prompt=body.prompt, colour=body.colour, shown=body.shown)
    if body.shown is False:
        await stop_check(c, cid)
    elif check.get("shown") and (body.shown is True or check.get("version") != before.get("version")):
        _spawn(c, refresh(c, cid))
    return read(c, cid) or check


async def _run(c: str, cid: str, body: RunBody) -> dict[str, Any]:
    from . import report_types  # noqa: PLC0415

    _ws(c)
    if read(c, cid) is None:
        raise HTTPException(404, f"no check {cid!r}")
    doc = str(body.doc or "").strip().lower().removeprefix("report:")
    if not report_types.SLUG_RE.match(doc) or report_types.read_type(c, doc) is None:
        raise HTTPException(404, f"no document {doc!r}")
    rec = await start_run(c, cid, doc, passages_=body.passages or None, force=True, route="click")
    if rec is None:
        raise HTTPException(409, f"report:{doc} has no passage to check")
    return rec


@router.post("/ws/{c}/checks/{cid}/run", status_code=202)
async def run_click_route(c: str, cid: str, body: RunBody, request: Request) -> dict[str, Any]:
    """Run on a check's row, a click: a run of the check on one document, the passages named, else every passage but the
    locked blocks seen before, its agent started through main's module (or queued for a place). 409 when the document
    is not written or has nothing to check."""
    _click(request)
    return await _run(c, cid, body)


@router.post("/ws/{c}/checks/{cid}/runs", status_code=202)
async def run_route(c: str, cid: str, body: RunBody, request: Request) -> dict[str, Any]:
    """The same as run_click_route, at the path the browser used before."""
    _click(request)
    return await _run(c, cid, body)


@router.post("/ws/{c}/checks/{cid}/runs/{doc}/stop")
async def stop_route(c: str, cid: str, doc: str, request: Request) -> dict[str, Any]:
    """Stop the check's run on one document, running or queued, a click: its agent stops through main's module and the
    run ends `stopped`, keeping the comments it left. Answers the check; 404 for a check that does not exist."""
    _ws(c)
    check = read(c, cid)
    if check is None:
        raise HTTPException(404, f"no check {cid!r}")
    act = _active.get((c, cid, doc))
    if act is not None:
        _click(request)
        await stop(act)
    else:
        rec = (check.get("runs") or {}).get(doc)
        if isinstance(rec, dict) and rec.get("status") == "running":
            rec.update(status="stopped", ended=_now())
            rec.pop("waiting", None)
            save(c, check)
            _stream(c, cid, doc, "stopped", str(rec.get("run") or ""), str(rec.get("chat") or ""))
    return read(c, cid) or check


def stop_workspace(c: str) -> int:
    """Main's session ended in workspace `c` (agents.stop_all): its queued runs and its programs' runs stop, and a typed
    start main never made ends. Its runs' agents were subagents of main and ended with it: subagents.close_running ends
    them, and their runs end `stopped`, their passages stale (Run starts them again). How many runs it stopped here."""
    from . import subagents  # noqa: PLC0415

    for t, cc in list(_tasks.items()):
        if cc == c:
            t.cancel()
    n = 0
    for act in [a for (cc, _, _), a in list(_active.items()) if cc == c]:
        if act.agent:
            continue
        if act.request:
            subagents.refuse(c, act.request, "your Claude Code session ended", subagents.HOOK)
        if act.task is not None and not act.task.done():
            act.task.cancel()
        _finish(act, "stopped", "")
        n += 1
    return n


async def shutdown() -> None:
    """The server is going down: the starts waiting are dropped and the programs' runs stop. The runs' agents are
    subagents of main, which go on: the next server takes them up again (recover)."""
    for act in list(_active.values()):
        if act.task is not None and not act.task.done():
            act.task.cancel()
    for t in list(_tasks):
        t.cancel()


def _hear_writers() -> None:
    """A writer's end starts the shown checks on its document (_writer_ended)."""
    from . import agents  # noqa: PLC0415 — agents imports this module lazily

    agents.on_agent_finished(_writer_ended)


_hear_writers()
