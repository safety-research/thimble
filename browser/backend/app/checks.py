"""Report checks: each an independent prompt that leaves comments on a document's passages, reads the document with all
the context, can do work, and can be created and run from the chat. A check runs again after a writer saves the
document, but is cached: a passage whose text did not change, or that is locked, is not checked again.

A check is `workspaces/<c>/checks/<id>.json` = {id, name, prompt, colour, shown, shown_set, builtin, created_by, ts,
version, runs: {doc: Run}}. The built-ins (`heads-up`, `explainers`, `judgment`: Heads up, Explainers and Judgment
calls) are prompts/checks/<id>.md, read from the prompt file until first changed: Heads up and Explainers are the
terminal's heads-up and explainer lenses (plugin/prompts/lens-heads.md, lens-explain.md) as checks, and cover the
documents and Claude's answers; Judgment calls covers the documents and the cards. The front matter's `shown` says
whether a built-in is on until the analyst turns it on or off (Heads up and Explainers on, Judgment calls off). A stored
copy still holding a name, a prompt or covers its built-in had before reads as the built-in is now (FORMER_NAMES,
FORMER_PROMPTS, FORMER_COVERS, FORMER_DEFAULT_COVERS), since thimble stores a built-in whole when it is turned on or off
or runs. Its `shown` stays as stored once the analyst set it (`shown_set`, which edit records for the analyst's switch
and for main's run_check and stop_check) or when it is off; one stored on without `shown_set` reads as its built-in is
now (_shown_now), since 0.7.0 and 0.8.0 turned every built-in on and stored it on when it ran or a save marked it
stale. A stored copy under an id its built-in had before (FORMER_IDS: Important details and, before it, You should
know, now Heads up) is renamed to the id now when the checks are read (_migrate), and a comment that names a former id
reads as naming the id now, written so on the store's next write. A former built-in (RETIRED: `verified`, before 0.7.0,
and `unverified`, Unverifiable) is listed only where the workspace stored it, as any stored check is, so its comments
stay readable there; it never runs again, and no new check takes its id. An active
extension's report checks, checks/<slug>/check.json (its name and colour)
and check.md (its prompt) in its folder, follow the built-ins as `<extension>-<slug>`, read from the extension until
first changed as the built-ins are, and off. A run is a `thimble:check`, a subagent of the analyst's Claude Code session
(subagents.py), registered from prompts/check.md (definition) on Settings' checks row, with the corpus read-only and a
work folder of its own, check-work/<id>-<doc>/. Its task file there, task.md, holds the context engine's part
(context.render) and then the document, the check's prompt and the passages it covers (a run of Heads up or Explainers,
LENS_CHECKS, reads the terminal observer's context in place of the whole transcript: main's conversation in brief, what
the answer it checks rests on, and a digest of what the check already said, digest); a task too large for one Read
call is written as task.md, task-2.md… (read_parts), each small enough that Read returns it whole. Its prompt names that
file or those files in order (`## check-task-file`, `## check-task-files`). It comments with add_comment and hands back
one line, its run's summary. At most MAX_SESSIONS run at once; the others wait queued. A run has no time limit, and the
analyst's Stop ends it (through thimble's plugin module, subagents.stop). A check made or changed (its name, prompt,
colour, shown or covers) emits `checks` on the stream, so every Comments pane, the Report's and the canvas's in any tab,
reads the checks again.

How a run starts: a writer's end starts each shown check on its document, a follow-on start of the writer's own start
(_writer_ended); Run on a check's row, or turning a check on, is the analyst's click; main's run_check gives main the
exact Agent call (tool_run_check), and a thread's fork's gives it to main in a `start_agent` event (tools._ask_main).
The analyst's own edits start nothing: each shown check's run records how many passages changed since it checked them
(`stale`, mark_stale), and Run is one click.

The cache: a passage (paragraph, heading, slide, beat or free sentence) is fingerprinted by the sentence_key of its
words. A run covers only passages whose fingerprint its check has not seen on that document; a run that ends `done`
supersedes the check's earlier open comments on those passages and records their fingerprints in `seen`. Main hears
`checked {check, doc, status, comments}` when a run run_check started ends with no agent of main's, such as an
extension's program; a run that ran as main's subagent says nothing more, since its hand-back already tells main, which
answers it in one line.

The cards. A check `covers` the documents, the cards or both (COVERS; the built-ins say so in their frontmatter, a new
check covers the documents unless made for the cards). The cards are one more run target beside the documents' slugs,
CANVAS (`@canvas`), whose passages are canvas_comments.passages: each card of the analyst's and the threads' groups and
each step of a plan card. Its comments are canvas_comments' store, and Done resolves them. Main's turn end starts each
shown check that covers the cards, a follow-on start (main_turn_ended), on the cards that changed since its last run
there and that it has not seen; Run on its row in the canvas's Comments pane and main's run_check with `on: cards` start
one too.

Claude's answers. A check also covers Claude's answers in the chat (`answers` in COVERS, the sidebar's Show in: Chat;
Heads up and Explainers by default), a third run target, ANSWERS (`@answers`), whose passages are the sentences of the
answers answer_comments.py keeps. When main's turn ends with an answer (session._end_turn) answer_ended keeps the answer
and starts each shown check that covers answers, a follow-on start, on the passages of the answers since that check's
last run there that it has not seen (the new answer alone at its first run). A check turned on, or whose Chat is
checked, runs on the last MAX_ANSWERS answers' passages it has not seen (refresh). Its comments are answer_comments'
store, which the chat tints in the check's color. A run over answers never wakes main: neither its start nor its end
sends main an event, a hand-back or a delivery; its end changes only answer-comments.json.

Notices. A run that ends failed (its agent's API error, a start that did not happen, a program's error) is told in the
foreground with Open on its chat, since the analyst may be in another chat (notices.post, under the run's key); its
next start and a run that ends done clear it (_notice).
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

from . import answer_comments, canvas_comments, config, investigation, prompts, read_parts, tools, userconf, work_files
from .kernel_thimble import LABEL_ORDER
from .ledger import read_json, write_json

log = logging.getLogger("thimble.checks")
router = APIRouter()

AGENT = "check"  # prompts/check.md, the check agent's definition
ROLE = "check"  # a run's chat role, and its role among subagents.TYPES (`thimble:check`, on Settings' `checks` row)
WRITER_ROLE = "writer"  # the chat role of a writer, whose end starts the shown checks (_writer_ended)
AUTHOR = "check"  # a check's comment's author (report.CHECK_AUTHOR)
DIR = "checks"  # workspaces/<c>/checks/<id>.json
WORK_DIR = "check-work"  # workspaces/<c>/check-work/<id>-<doc>/, a run's own folder, where its Bash may write
TASK_FILE = "task.md"  # in a run's own folder: what its agent reads first, with task-2.md… when one file is too large
OWN_TOOLS = ("read_ref", "list_cards", "add_comment")  # a check's thimble tools
BUILTINS = ("heads-up", "explainers", "judgment")  # prompts/checks/<id>.md, listed first in this order
# former built-ins: listed only where the workspace stored them, never run again, and no new check takes their ids
RETIRED = ("verified", "unverified")
# the ids the built-ins had before, each with its id now: a workspace's stored copy, and a comment, under a former id
# reads under the id now (_migrate, current_id); the first one stored wins. Internal only: no surface shows a former id.
FORMER_IDS = {"important-details": "heads-up", "you-should-know": "heads-up"}
# what the built-ins were named before, the sha1 of the words (collapsed) of each prompt they shipped with before, and
# what they covered before: a workspace's stored copy of a built-in that still holds one reads as the built-in is now
# (_as_now)
FORMER_NAMES = {"heads-up": ("You should know", "Important details")}
FORMER_COVERS = {"judgment": (["documents"],)}
# what a built-in covered by default before: a stored copy that holds it, and whose covers the analyst never set
# (`covers_set`), reads as covering what its built-in covers now (_as_now)
FORMER_DEFAULT_COVERS = {"heads-up": (["documents", "cards"], ["documents", "cards", "answers"])}
FORMER_PROMPTS = {
    "judgment": ("20b914af87f96860649651e3c44b4a1217752e90",),
    "heads-up": ("af5c7de4b07f80efaa866258cc65be5a34a91981", "f3bce900c61feda9b38b72f34d5e8fdc34e5dec5",
                 "0829a23430817c86bc793d3a14a4cac5f644a93b", "7ad911bc447c64e183a48130f7d7d8857b3c2de4",
                 "9e461822a6def677feec8fe2461061831bd35234", "bafaba148b11b6a45197bf6fb4112ee3c230f5a7"),
    "explainers": ("9478d19fb7bf335552308b11f88df81af897e591", "17bb4469222f1f6bb27a4a032a03ac7aaf9dd511",
                   "3c9a674810ff281086d46d169514db9f0b1650fc"),
}
CANVAS = canvas_comments.CANVAS  # the run target of a check over the cards, among `runs` beside the documents' slugs
CANVAS_NAME = "cards"  # how a line, a chat and main's `checked` event name that target
ANSWERS = answer_comments.ANSWERS  # the run target of a check over Claude's answers
ANSWERS_NAME = "answers"  # how a line and a chat name that target
COVERS = ("documents", "cards", "answers")  # what a check comments on
RUN_ON = ("documents", "cards")  # what run_check's `on` names: a run over answers starts only after an answer
DEFAULT_COVERS = ("documents",)
MAX_CARDS = 40  # the cards a run over the canvas covers at most, the ones that changed last
MAX_ANSWERS = 3  # the answers a run over answers covers at most, the last ones
COLOURS = tuple(range(1, 9))  # the label palette's places a check's color may take (kernel_thimble.LABEL_COLOURS)
NEW_COLOURS = tuple(m for m in LABEL_ORDER if m in COLOURS)  # the order new checks take them, as new label values do
CONTEXT_CHARS = 400_000  # of the context engine's part of a run's first message
# the built-ins that are the terminal's lenses, each with the digest it reads: a run of one reads what the terminal's
# observer reads (first_message), main's conversation in brief, the cards, the documents, what the answer it checks rests
# on, and what the check already said (digest), in LENS_CONTEXT_CHARS
LENS_CHECKS = {"heads-up": "heads", "explainers": "glossed"}
LENS_PARTS = ("brief", "canvas", "views", "documents", "evidence")
LENS_CONTEXT_CHARS = 160_000
DIGEST_KEEP = {"heads": 20, "glossed": 100}  # the newest comments a digest lists, as the terminal's lens digests keep
DIGEST_CHARS = 300  # of one comment's text in a digest
DIGEST_QUOTE_CHARS = 100  # of the passage a heads-up is on
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


def covers_of(raw: Any) -> list[str]:
    """What a check comments on, in COVERS' order, from a stored or a front matter's `covers`: the documents when it
    names none."""
    want = [raw] if isinstance(raw, str) else raw if isinstance(raw, (list, tuple)) else []
    out = [k for k in COVERS if k in {str(x).strip().lower() for x in want}]
    return out or list(DEFAULT_COVERS)


def covers(check: dict[str, Any] | None, what: str) -> bool:
    """Whether `check` comments on `what`, `documents`, `cards` or `answers`."""
    return bool(check) and what in covers_of(check.get("covers"))  # type: ignore[union-attr]


def builtin(cid: str) -> dict[str, Any] | None:
    """A built-in check as its prompt file defines it, never run, off unless its front matter says `shown: true`; None
    for another id."""
    import yaml  # noqa: PLC0415 — only the check files need it

    if cid not in BUILTINS:
        return None
    text = prompts.load(f"{prompts.CHECKS_DIR}/{cid}")
    head, sep, body = text.removeprefix("---\n").partition("\n---\n")
    front = yaml.safe_load(head) if sep else {}
    front = front if isinstance(front, dict) else {}
    colour = front.get("color", front.get("colour"))  # `colour`, the British spelling, is its alias
    return {"id": cid, "name": _collapse(front.get("name") or cid), "prompt": body.strip(),
            "colour": colour if colour in COLOURS else COLOURS[0], "shown": front.get("shown") is True, "builtin": True,
            "covers": covers_of(front.get("covers")), "created_by": "thimble", "ts": "", "version": 1, "runs": {}}


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
            colour = raw.get("color", raw.get("colour"))  # `colour`, the British spelling, is its alias
            colour = int(colour) if isinstance(colour, (int, str)) and str(colour).isdigit() else None
            if not slug or not prompt or not ID_RE.match(cid) or cid in BUILTINS:
                continue
            out[cid] = {"id": cid, "name": _collapse(raw.get("name") or slug)[:NAME_CHARS], "prompt": prompt,
                        "colour": colour if colour in COLOURS else NEW_COLOURS[len(out) % len(NEW_COLOURS)], "shown": False,
                        "builtin": True, "covers": covers_of(raw.get("covers")), "created_by": str(e["name"]), "ts": "",
                        "version": 1, "runs": {}}
    return out


def _words_key(text: Any) -> str:
    return hashlib.sha1(_collapse(text).encode("utf-8")).hexdigest()


def _shown_now(stored: dict[str, Any], now: dict[str, Any], *, before_cards: bool) -> bool:
    """Whether a stored built-in is on: as stored when the analyst set it (`shown_set`) or it is off, and when it was
    stored before checks covered the cards (`before_cards`: before 0.7.0, when the built-ins started off, so on was the
    analyst's choice); else, stored on by 0.7.0 or 0.8.0, which turned every built-in on, as its built-in is now."""
    if stored.get("shown_set") or stored.get("shown") is not True or before_cards:
        return bool(stored.get("shown"))
    return bool(now.get("shown"))


def _as_now(stored: dict[str, Any], *, before_cards: bool = False) -> dict[str, Any]:
    """A stored built-in with the name, the prompt and the covers its built-in has now in place of a former one it still
    holds (FORMER_NAMES, FORMER_PROMPTS, FORMER_COVERS), and `shown` as _shown_now reads it; one the analyst changed
    stays. A former built-in (RETIRED) reads as stored, but on only where the analyst turned it on."""
    cid = str(stored.get("id") or "")
    if cid in RETIRED:
        stored["shown"] = _shown_now(stored, {"shown": False}, before_cards=before_cards)
        return stored
    now = builtin(cid) if cid in BUILTINS else None
    if now is None:
        return stored
    stored["shown"] = _shown_now(stored, now, before_cards=before_cards)
    if _collapse(stored.get("name")) in FORMER_NAMES.get(cid, ()):
        stored["name"] = now["name"]
    if _words_key(stored.get("prompt")) in FORMER_PROMPTS.get(cid, ()):
        stored["prompt"] = now["prompt"]
    if stored.get("covers") in FORMER_COVERS.get(cid, ()) or (
            not stored.get("covers_set") and stored.get("covers") in FORMER_DEFAULT_COVERS.get(cid, ())):
        stored["covers"] = now["covers"]
    return stored


def current_id(cid: Any) -> str:
    """The id a check has now: a built-in's former id (FORMER_IDS) as the built-in's id now, any other as it is."""
    return FORMER_IDS.get(str(cid or ""), str(cid or ""))


def chat_as_now(meta: dict[str, Any]) -> dict[str, Any]:
    """A check run's chat meta, in place, with its check under its id now (current_id) and, when its title is a former
    name of that check (FORMER_NAMES), the check's name now in its title and in its brief; the meta's file stays as it
    is until thimble writes it again."""
    cid = current_id(meta.get("check"))
    if not cid:
        return meta
    meta["check"] = cid
    old = _collapse(meta.get("title"))
    if old not in FORMER_NAMES.get(cid, ()):
        return meta
    name = str((builtin(cid) or {}).get("name") or old)
    meta["title"] = name
    if isinstance(meta.get("brief"), str):  # check-instructions names the check before its prompt: the first match
        meta["brief"] = meta["brief"].replace(old, name, 1)
    return meta


def _migrate(d: Path) -> None:
    """In the checks folder `d`, a built-in stored under a former id (FORMER_IDS) renamed to its id now, so a workspace
    from before reads and writes it under that id; a copy already stored under the id now wins, and the former file
    then stays unread."""
    for old, new in FORMER_IDS.items():
        src, dst = d / f"{old}.json", d / f"{new}.json"
        if not src.is_file() or dst.exists():
            continue
        x = read_json(src, None)
        if not isinstance(x, dict):
            continue
        x["id"] = new
        try:
            write_json(dst, x)
            src.unlink(missing_ok=True)
        except OSError:  # a folder that cannot be written reads the built-in from its prompt file
            log.warning("%s: stored check not renamed to %s", d, new, exc_info=True)


def read(c: str, cid: str) -> dict[str, Any] | None:
    """The check `cid` (a former id as its id now): its workspace file, else the built-in of that id, else an active
    extension's; None when none exists."""
    cid = current_id(cid)
    _migrate(_dir(c))
    stored = read_json(_path(c, cid), None)
    if isinstance(stored, dict):
        stored.setdefault("runs", {})
        before_cards = "covers" not in stored or covers_of(stored["covers"]) in FORMER_COVERS.get(cid, ())
        if "covers" not in stored:  # a check stored before checks covered the cards covers what its built-in says
            stored["covers"] = (builtin(cid) or {}).get("covers") or list(DEFAULT_COVERS)
        stored["covers"] = covers_of(stored["covers"])
        return _as_now(stored, before_cards=before_cards)
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
        if p.stem in BUILTINS or p.stem in theirs or p.stem in FORMER_IDS:
            continue
        x = read(c, p.stem) if p.stem in RETIRED else read_json(p, None)
        if isinstance(x, dict) and x.get("id") == p.stem:
            x.setdefault("runs", {})
            x["covers"] = covers_of(x.get("covers"))
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


def _announce(c: str, cid: str) -> None:
    """A check was made or changed (its name, prompt, colour, shown or covers): a `checks` record on the stream, so every
    surface that lists the checks (the Report's and the canvas's Comments panes, in any tab) reads them again."""
    try:
        investigation.emit(c, investigation.MAIN, {"type": "checks", "id": cid})
    except Exception:  # noqa: BLE001 — a surface reads the checks again on its next record
        log.debug("%s: checks record not emitted for %s", c, cid, exc_info=True)


def _new_id(c: str, name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "check"
    base = base if ID_RE.match(base) else "check"
    taken = {x["id"] for x in list_checks(c)}
    cid, k = base, 2
    while cid in taken or cid in BUILTINS or cid in RETIRED:
        cid, k = f"{base}-{k}", k + 1
    return cid


def _free_colour(c: str) -> int:
    """The first color no check has, else the one fewest have, in the order new checks take them (NEW_COLOURS)."""
    used = [x.get("colour") for x in list_checks(c)]
    return next((k for k in NEW_COLOURS if k not in used), min(NEW_COLOURS, key=used.count))


def create(c: str, name: str, prompt: str, *, created_by: str, covers: Any = None) -> dict[str, Any]:
    """A new check, off, commenting on what `covers` names (the documents by default); 409 when a check has that name,
    400 for an empty name or prompt."""
    name, prompt = _collapse(name)[:NAME_CHARS], str(prompt or "").strip()[:PROMPT_CHARS]
    if not name or not prompt:
        raise HTTPException(400, "a check needs a name and a prompt")
    if by_name(c, name) is not None:
        raise HTTPException(409, f"a check named {name!r} exists")
    made = save(c, {"id": _new_id(c, name), "name": name, "prompt": prompt, "colour": _free_colour(c), "shown": False,
                    "builtin": False, "covers": covers_of(covers), "created_by": created_by, "ts": _now(), "version": 1,
                    "runs": {}})
    _announce(c, str(made["id"]))
    return made


def edit(c: str, cid: str, *, name: str | None = None, prompt: str | None = None, colour: int | None = None,
         shown: bool | None = None, covers: Any = None) -> dict[str, Any]:
    """The check with the fields given changed and written; a new prompt bumps `version` and empties each document's `seen`
    but for its locked blocks' fingerprints (the cards' `seen` whole). 404, 409 for a name another check has, 400 for a
    colour outside 1 to 8 or an empty name or prompt."""
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
                d = report_types.read_doc(c, inv.MAIN, doc) if doc not in (CANVAS, ANSWERS) else None
                locked = {p["fp"] for p in passages(doc, d) if p["locked"]} if d else set()
                run["seen"] = [fp for fp in run.get("seen") or [] if fp in locked]
    if colour is not None:
        if colour not in COLOURS:
            raise HTTPException(400, f"a color is one of {COLOURS[0]} to {COLOURS[-1]}")
        check["colour"] = colour
    if shown is not None:  # the analyst's switch, or main's run_check or stop_check: a choice that stays (_shown_now)
        check["shown"], check["shown_set"] = bool(shown), True
    if covers is not None:  # the analyst's Show in, or main's run_check: a choice that stays (_as_now)
        check["covers"], check["covers_set"] = covers_of(covers), True
    saved = save(c, check)
    _announce(c, cid)
    if shown is not None or colour is not None or covers is not None:
        answer_comments._emit(c)  # the chat draws its answer comments again, with or without this check's
    return saved


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


def passages_of(c: str, doc: str) -> list[dict[str, Any]]:
    """The passages of a run target: a written document's (passages), the cards' (canvas_comments.passages), or the
    sentences of the answers kept (answer_comments.all_passages)."""
    if doc == CANVAS:
        return canvas_comments.passages(c)
    if doc == ANSWERS:
        return answer_comments.all_passages(c)
    return passages(doc, _doc(c, doc))


def canvas_cover(c: str, check: dict[str, Any], wanted: list[str] | None = None, force: bool = False,
                 since: str | None = None) -> list[dict[str, Any]]:
    """The passages of the cards a run of `check` covers: the ones `wanted` names, else every one when `force`, else the
    ones whose fingerprint the check has not seen, of the cards that changed at or after `since` when it is given. At
    most the MAX_CARDS cards that changed last, each with the steps of it that are covered."""
    ps = canvas_comments.passages(c, None if wanted or force else since)
    if wanted:
        refs = {p["ref"] for w in wanted if (p := canvas_comments.passage_of(c, w, ps)) is not None}
        return [p for p in ps if p["ref"] in refs]
    seen = set(((check.get("runs") or {}).get(CANVAS) or {}).get("seen") or [])
    out = [p for p in ps if force or p["fp"] not in seen]
    changed = {p["card"]: p["changed"] for p in out}
    keep = set(sorted(changed, key=lambda k: canvas_comments._stamp(changed[k]), reverse=True)[:MAX_CARDS])
    return [p for p in out if p["card"] in keep]


def answer_cover(c: str, check: dict[str, Any], wanted: list[str] | None = None, force: bool = False,
                 since: float | None = None) -> list[dict[str, Any]]:
    """The sentences of Claude's answers a run of `check` covers: the ones `wanted` names, else every one of the last
    MAX_ANSWERS answers when `force`, else those it has not seen of the last MAX_ANSWERS answers kept at or after
    `since` (a time) when it is given."""
    kept = answer_comments.answers(c)
    if wanted:
        ps = answer_comments.all_passages(c)
        refs = {p["ref"] for w in wanted if (p := answer_comments.passage_of(c, w, ps)) is not None}
        return [p for p in ps if p["ref"] in refs]
    if since is not None and not force:
        kept = [a for a in kept if float(a.get("at") or 0) >= since]
    turns = [a["turn"] for a in kept[-MAX_ANSWERS:]]
    seen = set(((check.get("runs") or {}).get(ANSWERS) or {}).get("seen") or [])
    return [p for p in answer_comments.all_passages(c, turns) if force or p["fp"] not in seen]


def target_name(doc: str) -> str:
    """How a line names a run target: `report:<slug>`, the cards, or Claude's answers."""
    if doc == ANSWERS:
        return "Claude's answers"
    return f"the {CANVAS_NAME}" if doc == CANVAS else f"report:{doc}"


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
    for d in sorted(root.glob(f"*/{DIR}")) if root.is_dir() else []:
        _migrate(d)
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
    """A run's own folder, check-work/<id>-<doc>, among the agents' work folders (subagents.write_dirs)."""
    return config.workspace_dir(c) / WORK_DIR / f"{cid}-{doc}"


def _stream(c: str, cid: str, doc: str, status: str, run: str, chat: str, **extra: Any) -> None:
    try:
        investigation.emit(c, investigation.MAIN, {"type": "check", "id": cid, "doc": doc, "status": status, "run": run,
                                                   "chat": chat, **extra})
    except Exception:  # noqa: BLE001 — the browser rereads the checks on its next record
        log.debug("%s: check record not emitted for %s on %s", c, cid, doc, exc_info=True)


def _replaced_part(c: str, check: dict[str, Any], doc: str, cover: list[dict[str, Any]],
                   d: dict[str, Any] | None = None) -> str:
    """The check's open comments on the passages a run covers, which the run's end supersedes (_finish): listed in its
    task as the ones it replaces, so it leaves again each that still holds. Live check 0.7.0: the task's cards section
    showed them as the cards' comments, so a run of Important details over unchanged cards took them as said, left one
    new comment, and its end superseded the six still open."""
    from . import cite  # noqa: PLC0415

    cid = str(check["id"])
    if doc == CANVAS:
        keys = {canvas_comments.key_of(p) for p in cover}
        found = [canvas_comments.line(c, cm) for cm in canvas_comments.open_comments(c)
                 if cm.get("check") == cid and canvas_comments.key_of(cm) in keys]
    elif doc == ANSWERS:
        refs = {p["ref"] for p in cover}
        found = [f"comment {cm['id']} on {cm['ref']} · {_collapse(cm.get('text'))}"
                 + (f" — {_collapse(cm.get('details'))}" if _collapse(cm.get("details")) else "")
                 for cm in answer_comments.open_comments(c) if cm.get("check") == cid and cm.get("ref") in refs]
    else:
        ps, covered, found = passages(doc, d), {p["ref"] for p in cover}, []
        for cm in (d or {}).get("comments") or []:
            if (isinstance(cm, dict) and cm.get("check") == cid and (cm.get("status") or "open") == "open"
                    and _of_comment(doc, ps, str(cm.get("sentence_id"))) in covered):
                note = canvas_comments.note_of(cm, str(check.get("name") or ""))
                text, more = (_collapse(cite.canon_text(note[k])) for k in ("text", "details"))
                found.append(f"comment {cm.get('id')} on report:{doc}#{cm.get('sentence_id')} · {text}"
                             + (f" — {more}" if more else ""))
    return tools.hint("check-replaces", comments="\n".join(f"- {x}" for x in found)) if found else ""


def task_text(c: str, check: dict[str, Any], doc: str, cover: list[dict[str, Any]]) -> str:
    """The task of a run's task file."""
    from . import investigation as inv, report_types  # noqa: PLC0415

    if doc == CANVAS:
        parts = [tools.hint("check-instructions", check=check["name"], prompt=str(check.get("prompt") or "").strip()),
                 tools.hint("check-canvas", cards=canvas_comments.card_lines(c, [p["ref"] for p in cover])),
                 _replaced_part(c, check, doc, cover)]
        return "\n\n".join(p.strip() for p in parts if p.strip())
    if doc == ANSWERS:
        lines = "\n".join(f"- {p['ref']} {_collapse(p['text'])}" for p in cover)
        parts = [tools.hint("check-instructions", check=check["name"], prompt=str(check.get("prompt") or "").strip()),
                 f"{answer_comments.TASK_HEADING}\n\n{lines}", _replaced_part(c, check, doc, cover)]
        return "\n\n".join(p.strip() for p in parts if p.strip())
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
    parts.append(_replaced_part(c, check, doc, cover, d))
    return "\n\n".join(p.strip() for p in parts if p.strip())


def _cut_words(text: Any, cap: int) -> str:
    t = _collapse(text)
    return t if len(t) <= cap else t[: cap - 1] + "…"


def digest(c: str, cid: str, cover: list[dict[str, Any]] | None = None) -> str:
    """What check `cid` already said in workspace `c`, for a run of it (LENS_CHECKS): its comments on Claude's answers,
    the documents and the cards, open or dismissed by the analyst, oldest first, the newest DIGEST_KEEP of them; a
    comment a later run superseded and one on a passage of `cover` (which the task lists as the ones the run replaces,
    _replaced_part) left out. A heads-up as its text and the passage it is on, an explainer as its text."""
    from . import investigation as inv, report_types  # noqa: PLC0415

    slot = LENS_CHECKS.get(cid, "heads")
    covered = {p["ref"] for p in cover or []}
    rows: list[tuple[str, str, str, str]] = []  # (ts, ref, text, quote)
    name = str((read(c, cid) or {}).get("name") or "")

    def keep(cm: dict[str, Any]) -> bool:
        return current_id(cm.get("check")) == cid and cm.get("resolution") != answer_comments.RESOLUTION_SUPERSEDED

    for cm in answer_comments._read(c):
        if keep(cm) and cm.get("ref") not in covered:
            rows.append((str(cm.get("ts") or ""), str(cm.get("ref") or ""), str(cm.get("text") or ""),
                         str(cm.get("quote") or "")))
    for cm in canvas_comments.all_comments(c):
        if keep(cm) and str(cm.get("ref") or "") not in covered and f"card:{cm.get('card')}" not in covered:
            rows.append((str(cm.get("ts") or ""), str(cm.get("ref") or ""), str(cm.get("text") or ""), ""))
    for t in report_types.list_types(c):
        slug = str(t["slug"])
        d = report_types.read_doc(c, inv.MAIN, slug)
        if not d:
            continue
        ps = passages(slug, d)
        for cm in d.get("comments") or []:
            if not isinstance(cm, dict) or not keep(cm) or _of_comment(slug, ps, str(cm.get("sentence_id"))) in covered:
                continue
            note = canvas_comments.note_of(cm, name)
            rows.append((str(cm.get("ts") or ""), f"report:{slug}#{cm.get('sentence_id')}", note["text"], ""))
    rows.sort(key=lambda r: r[0])
    out = []
    for _, ref, text, quote in rows[-DIGEST_KEEP[slot]:]:
        line = f"- {_cut_words(text, DIGEST_CHARS)}"
        if slot == "heads":
            line += f" (on {ref}" + (f": \"{_cut_words(quote, DIGEST_QUOTE_CHARS)}\"" if quote.strip() else "") + ")"
        out.append(line)
    return "\n".join(out)


def first_message(c: str, check: dict[str, Any], doc: str, cover: list[dict[str, Any]]) -> str:
    """A run's task file: the context engine's part (CONTEXT_CHARS), then the task (task_text). A run of Heads up or
    Explainers (LENS_CHECKS) reads what the terminal's observer reads instead: main's conversation in brief, the cards,
    the views, the documents, for a run over answers what those answers rest on, and the check's digest, in
    LENS_CONTEXT_CHARS."""
    from . import context  # noqa: PLC0415 — context imports this module for the check names

    focus = (tuple(dict.fromkeys(f"card:{p['card']}" for p in cover)) if doc == CANVAS else () if doc == ANSWERS
             else (f"report:{doc}",))
    task = task_text(c, check, doc, cover)
    slot = LENS_CHECKS.get(str(check["id"]))
    if slot is None:
        return context.render(c, task, budget=CONTEXT_CHARS, focus=focus)
    turns = {p["turn"] for p in cover} if doc == ANSWERS else set()
    answers = [a for a in answer_comments.answers(c) if a["turn"] in turns]
    return context.render(c, task, budget=LENS_CONTEXT_CHARS, focus=focus, parts=(*LENS_PARTS, slot), answers=answers,
                          given={slot: digest(c, str(check["id"]), cover)})


async def start_run(c: str, cid: str, doc: str, *, passages_: list[str] | None = None, force: bool = False,
                    notify: bool = False, route: str = "follow-on", call: str | None = None,
                    since: str | float | None = None) -> dict[str, Any] | None:
    """Start a run of check `cid` on the written document `doc`, on the cards (CANVAS, canvas_cover, of the cards that
    changed since `since` when it is given), or on Claude's answers (ANSWERS, answer_cover, of the answers kept since
    `since`, a time), and return its record, or None when it has nothing to cover, the document is not written, the
    check does not cover the cards or the answers, or it is a former built-in (RETIRED). A running run of it on `doc` is stopped first. `notify` tells main
    when it ends, never for a run over answers. Its agent starts as `route` says (subagents.start_job): a click (Run) or a follow-on start (a
    writer's end, main's turn end) through main's module when a place is free (MAX_SESSIONS), queued otherwise; a typed
    start (main's run_check) at once, as the exact Agent call main makes, which the record's `_answer` holds for the
    tool."""
    from . import investigation as inv, report_types  # noqa: PLC0415

    check = read(c, cid)
    if check is None:
        raise ValueError(f"no check {cid!r}")
    if check["id"] in RETIRED:  # a former built-in keeps its comments but never runs again
        return None
    if doc == CANVAS:
        cover = canvas_cover(c, check, passages_, force, since) if covers(check, "cards") else []  # type: ignore[arg-type]
    elif doc == ANSWERS:
        cover = answer_cover(c, check, passages_, force, since) if covers(check, "answers") else []  # type: ignore[arg-type]
        notify, route, call = False, route if route != TYPED else "follow-on", None  # a run over answers wakes no one
    else:
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
    if doc in (CANVAS, ANSWERS):
        rec["since"] = since  # the time its cover looked from, which the next turn's run looks from if this one fails
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
    cover = [p for p in passages_of(c, act.doc) if p["ref"] in set(act.covered)]
    text = await asyncio.to_thread(first_message, c, check, act.doc, cover)
    if act.ended:
        return
    part = tasks.program(c, "checks")
    if part is not None:
        await _program(act, check, cover, text, part)
        return
    work = work_dir(c, act.check, act.doc)
    paths = await asyncio.to_thread(_write_task, c, work / TASK_FILE, text)
    if act.route == subagents.FOLLOW_ON:
        await _wait_out_of_plan(act)
    if act.ended:
        return
    ans = await subagents.start_job(
        c, ROLE, session_key(act.check, act.doc), read_parts.named(paths, "check-task-file", "check-task-files"),
        subagents.values_for(c, ROLE), act.route,
        description=f"check: {check['name']} · "
                    f"{CANVAS_NAME if act.doc == CANVAS else ANSWERS_NAME if act.doc == ANSWERS else act.doc}",
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


def _write_task(c: str, path: Path, text: str) -> list[Path]:
    """The run's task file, `path`, and the files after it when the task outgrows what one Read call returns
    (read_parts.write), in a folder its agent and main's Bash can write, so never through a link. The paths, in
    order."""
    return read_parts.write(config.workspace_dir(c), path, text + "\n")


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
    _notice(act, None, "running", "", run.chat)


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

    if doc in (CANVAS, ANSWERS):
        return None
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
        canvas = act.doc == CANVAS
        answers = act.doc == ANSWERS
        # the run's comments as the document (or the cards' store) holds them: in terminal mode the shim takes them, in
        # another process
        act.comments = max(act.comments, canvas_comments.count(c, act.check, act.run) if canvas else
                           answer_comments.count(c, act.check, act.run) if answers else
                           sum(1 for cm in (doc or {}).get("comments") or []
                               if isinstance(cm, dict) and cm.get("check") == act.check and cm.get("run") == act.run))
        rec.update(status=status, ended=_now(), summary=last[:SUMMARY_CHARS], comments=act.comments)
        rec.pop("waiting", None)
        if status == "done":
            ps = passages_of(c, act.doc)
            covered = set(act.covered)
            if canvas:
                canvas_comments.supersede(c, act.check, act.run,
                                          {canvas_comments.key_of(p) for p in ps if p["ref"] in covered})
            elif answers:
                answer_comments.supersede(c, act.check, act.run, covered)
            elif doc is not None:
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
                    # the open pages read the document again, so the comments this run replaced leave its margin
                    report_types._emit(c, {"type": "report", "slug": act.doc, "status": "commented"})
            now = {p["fp"] for p in ps}
            rec["seen"] = sorted({fp for fp in rec.get("seen") or [] if fp in now} | set(act.fps))
        rec["stale"] = len(to_cover(check, act.doc, doc)) if doc is not None and check.get("shown") else 0
        save(c, check)
        _stream(c, act.check, act.doc, status, act.run, str(rec.get("chat") or ""), stale=rec["stale"])
        _notice(act, check, status, str(summary or ""), str(rec.get("chat") or ""))
        # main's subagent hands back itself: one line in main's chat, not two; a run over answers tells main nothing
        if act.notify and not act.agent and not answers:
            try:
                events.post(c, CHECKED_KIND, {"text": rec["summary"] or status, "check": act.check,
                                               "doc": CANVAS_NAME if canvas else act.doc, "status": status,
                                               "comments": act.comments})
            except HTTPException as e:
                log.info("%s: main did not hear that check %s ended on %s (%s %s)", c, act.check, act.doc,
                         e.status_code, e.detail)
    finally:
        _pump()


# the notice of a run that failed (module note, notices): {subject} the check, {target} what it ran on, {why} why
FAILED_TEXT = "{subject} on {target} failed: {why}."


def _notice(act: _Active, check: dict[str, Any] | None, status: str, summary: str, chat: str) -> None:
    """A run started or ended: a failed one is told in the foreground with Open on its chat, under the run's key, and
    a start or a run that ended done clears it. Never raises."""
    from . import notices  # noqa: PLC0415

    key = session_key(act.check, act.doc)
    try:
        if status != "failed":
            if status in ("running", "done"):
                notices.cleared(act.c, key)
            return
        name, subject = notices.who(ROLE, str((check or {}).get("name") or act.check))
        target = (f"the {CANVAS_NAME}" if act.doc == CANVAS else "Claude's answer" if act.doc == ANSWERS
                  else f"the document {act.doc}")
        why, fix = notices.reason(summary or "it ended with no summary")
        notices.post(act.c, kind="agent", text=FAILED_TEXT.format(subject=subject, target=target, why=why), agent=name,
                     chat=chat or None, action=fix, key=notices.agent_key(key))
    except Exception:  # noqa: BLE001 — the run has ended either way
        log.exception("%s: the end of check %s on %s was not told", act.c, act.check, act.doc)


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


def targets_of(c: str, check: dict[str, Any] | None) -> list[str]:
    """Where `check` runs: each written document when it covers the documents, then the cards when it covers them."""
    if not check:
        return []
    return (_written(c) if covers(check, "documents") else []) + ([CANVAS] if covers(check, "cards") else [])


async def refresh(c: str, cid: str, route: str = "click") -> list[dict[str, Any]]:
    """Run check `cid` on every written document it covers, on the cards and on Claude's last answers (MAX_ANSWERS)
    when it covers them, where it has passages to cover and no run running (a check turned on in the browser, or its
    Show in widened, a click)."""
    out = []
    check = read(c, cid)
    for doc in targets_of(c, check) + ([ANSWERS] if covers(check, "answers") else []):
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
    shown = [x for x in list_checks(c) if x.get("shown") and covers(x, "documents")]
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
        if not x.get("shown") or not covers(x, "documents") or running(c, x["id"], slug):
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


def main_turn_ended(c: str, since: str | None = None) -> None:
    """Main's turn ended (session._end_turn): each shown check that covers the cards runs on them, a follow-on start,
    covering the cards it has not seen that changed since its last run there began (since the time that run looked
    from, when it did not end done), else since the turn began (`since`). A check whose run there goes is left to it."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    shown = [x for x in list_checks(c) if x.get("shown") and covers(x, "cards")]
    if shown:
        _spawn(c, _run_on_cards(c, [str(x["id"]) for x in shown], since))


async def _run_on_cards(c: str, ids: list[str], since: str | None) -> None:
    for cid in ids:
        if running(c, cid, CANVAS):
            continue
        rec = ((read(c, cid) or {}).get("runs") or {}).get(CANVAS)
        base = since
        if isinstance(rec, dict) and rec.get("run"):
            base = rec.get("started") if rec.get("status") == "done" else rec.get("since")
        try:
            await start_run(c, cid, CANVAS, route="follow-on", since=str(base) if base else None)
        except Exception:  # noqa: BLE001 — one check's failure leaves the others to run
            log.exception("%s: check %s did not run on the cards after main's turn", c, cid)


def answer_ended(c: str, turn: dict[str, Any]) -> None:
    """Main's turn ended with an answer (session._end_turn), `turn` = {sid, turn, rows: [{uuid, text}], at}, `turn` the
    id its `done` record names and each row a text of the turn as the chat shows it: the answer is kept and each shown
    check that covers answers runs on it, a follow-on start, covering the sentences of the answers since its last run
    there that it has not seen (this answer alone at its first run); a check whose run over answers goes is left to it.
    Such a run never wakes main (module note)."""
    if not isinstance(turn, dict):
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    try:
        kept = answer_comments.store_answer(c, turn)
        shown = [x for x in list_checks(c) if x.get("shown") and covers(x, "answers")]
    except Exception:  # noqa: BLE001 — a check that does not run is no reason to fail the mirror
        log.exception("%s: the answer of turn %s was not kept for the checks", c, turn.get("turn"))
        return
    if kept is None or not shown:
        return
    _spawn(c, _run_on_answers(c, [str(x["id"]) for x in shown], float(kept["at"])))


async def _run_on_answers(c: str, ids: list[str], at: float) -> None:
    for cid in ids:
        if running(c, cid, ANSWERS):
            continue
        rec = ((read(c, cid) or {}).get("runs") or {}).get(ANSWERS)
        since: Any = at
        if isinstance(rec, dict) and rec.get("run"):
            since = rec.get("since") if rec.get("status") != "done" else _epoch(rec.get("started"))
        try:
            await start_run(c, cid, ANSWERS, route="follow-on", since=float(since) if since is not None else None)
        except Exception:  # noqa: BLE001 — one check's failure leaves the others to run
            log.exception("%s: check %s did not run on Claude's answer", c, cid)


def _epoch(ts: Any) -> float | None:
    try:
        return datetime.fromisoformat(str(ts)).timestamp() if ts else None
    except ValueError:
        return None


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
    on = _collapse(args.get("on")).lower() or None
    if not name:
        return tools.err("run_check: `name` is required")
    if on is not None and on not in RUN_ON:
        return tools.err(f"run_check: `on` is one of {', '.join(RUN_ON)}")
    check = by_name(ctx.c, name)
    how = "rerun"
    try:
        if check is None:
            if not instructions:
                return tools.err(tools.hint("run_check-no-instructions", check=name,
                                            names=", ".join(x["name"] for x in list_checks(ctx.c))))
            check = create(ctx.c, name, instructions, created_by=ctx.cell_author, covers=[on] if on else None)
            how = "new"
        # a check run on what it does not cover yet covers it from now on
        more = [*covers_of(check.get("covers")), on] if on and not covers(check, on) else None
        check = edit(ctx.c, check["id"], prompt=instructions or None, shown=True, covers=more)
    except HTTPException as e:
        return tools.err(f"run_check: {e.detail}")
    docs: dict[str, list[str] | None] = {}
    for w in wanted:
        m = _REF_RE.match(w)
        if m:
            docs.setdefault(m.group(1), []).append(w)  # type: ignore[union-attr]
        elif canvas_comments.parse_ref(w) is not None and covers(check, "cards"):
            docs.setdefault(CANVAS, []).append(w)  # type: ignore[union-attr]
    if wanted and not docs:
        return tools.err(tools.hint("run_check-no-passage", passages=", ".join(wanted)))
    written = _written(ctx.c)
    places = [d for d in targets_of(ctx.c, check) if on is None or (d == CANVAS) == (on == "cards")]
    targets = [d for d in (docs or dict.fromkeys(places)) if d in written or (d == CANVAS and covers(check, "cards"))]
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
            res = await tools._ask_main(ctx, ans, what=f"a run of the check {check['name']} on {target_name(doc)}",
                                        thread=fork, agent="the check")
            (refused if res.is_error else lines).append(res.text)
            continue
        lines.append(tools.hint("run_check-started", check=check["name"], how=how, doc=target_name(doc),
                                passages=_plural(len(rec["covered"]), "passage")))
        lines.append(tools.hint("start_job-subagent", input=json.dumps(ans["input"], ensure_ascii=False)))
    if lines:
        return tools.ok("\n\n".join(lines))
    if refused:
        return tools.err(f"run_check: {refused[0]}")
    if wanted:
        return tools.err(tools.hint("run_check-no-passage", passages=", ".join(wanted)))
    if CANVAS in places:
        return tools.ok(tools.hint("run_check-no-cards", check=check["name"]))
    return tools.ok(tools.hint("run_check-no-doc", check=check["name"]))


async def tool_add_comment(ctx: Any, args: dict[str, Any]) -> Any:
    """The `add_comment` tool. From main's shim it is a note of main's (comments.tool_add_comment); in a check's session it is
    a comment of the run beside a passage it covers: its statement `text` and its `details` (note_parts). A paragraph's
    comment goes on its first sentence, marked `paragraph`."""
    from . import report, report_types  # noqa: PLC0415

    act = _of_session(ctx.c, ctx.session)
    if act is None:
        if tools.session_kind(ctx.session) is None:  # main's shim, its forks and subagents among it: a note of main's
            from . import comments  # noqa: PLC0415

            return await comments.tool_add_comment(ctx, args)
        return tools.err(tools.hint("add_comment-not-check"))
    if act.doc == CANVAS:
        return _add_card_comment(ctx, act, args)
    if act.doc == ANSWERS:
        return _add_answer_comment(ctx, act, args)
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
    shown, details, evidence = note_parts(ctx.c, text, args.get("details"), doc_ids=used)
    if not shown:
        return tools.err("add_comment: `text` holds nothing but citations")
    comments = doc.setdefault("comments", [])
    same = next((cm for cm in comments if isinstance(cm, dict) and cm.get("check") == act.check and cm.get("run") == act.run
                 and str(cm.get("sentence_id")) == uid and bool(cm.get("paragraph")) == whole
                 and _collapse(cm.get("text")) == shown and canvas_comments.clean_details(cm.get("details")) == details),
                None)
    if same is None:
        comments.append({"id": report._new_id(used), "sentence_id": uid, **({"paragraph": True} if whole else {}),
                         "text": shown, "details": details, "author": AUTHOR, "check": act.check, "run": act.run,
                         "evidence": evidence, "ts": _now(), "status": "open",
                         "generation": int(doc.get("generation") or 1)})
        report_types.write_doc(ctx.c, investigation.MAIN, act.doc, doc)
        act.comments += 1
        check = read(ctx.c, act.check)
        rec = ((check or {}).get("runs") or {}).get(act.doc)
        if check is not None and rec is not None and rec.get("run") == act.run:
            rec["comments"] = act.comments
            save(ctx.c, check)
        report_types._emit(ctx.c, {"type": "report", "slug": act.doc, "status": "commented", "span": f"report:{act.doc}#{uid}"})
    return tools.ok(f"commented on report:{act.doc}#{uid}")


def note_parts(c: str, text: str, details: Any = None, doc_ids: set[str] | None = None) -> tuple[str, str, str]:
    """(the statement a reader sees, its details, the refs both cite) of a comment: the statement's [[…]] markup
    flattened to the values, the details' kept for the chips they show, a card named by its id read as card:<id> in
    both, a document's own ids (`doc_ids`) dropped, and every ref cited kept as evidence."""
    from . import refs, report, report_types  # noqa: PLC0415

    cells = report_types.workspace_cell_ids(c)
    details = canvas_comments.clean_details(details)
    cited = list(dict.fromkeys([*refs.extract_refs(text), *refs.extract_refs(details)]))
    shown = report_types.readable_ids(report.plain_text(text), cells=cells, doc_ids=doc_ids)
    more = report_types.readable_ids(details, cells=cells, doc_ids=doc_ids) if details else ""
    return shown, more, " ".join(cited)


def _add_card_comment(ctx: Any, act: _Active, args: dict[str, Any]) -> Any:
    """add_comment in a run over the cards: a comment beside a card or a step the run covers (a comment on a card whose
    step alone is covered goes too), stored in the cards' comments (canvas_comments.add)."""
    ref = str(args.get("ref") or "").strip().strip("[]").strip()
    text = _collapse(args.get("text"))
    if not text:
        return tools.err("add_comment: `text` is empty")
    ps = canvas_comments.passages(ctx.c)
    p = canvas_comments.passage_of(ctx.c, ref, ps)
    if p is None:
        return tools.err(tools.hint("add_comment-no-card", ref=ref or "(no ref)"))
    covered = set(act.covered)
    if p["ref"] not in covered and not (p["kind"] == "card" and any(q["card"] == p["card"] and q["ref"] in covered
                                                                     for q in ps)):
        return tools.err(tools.hint("add_comment-uncovered", ref=ref))
    shown, details, evidence = note_parts(ctx.c, text, args.get("details"))
    if not shown:
        return tools.err("add_comment: `text` holds nothing but citations")
    _, new = canvas_comments.add(ctx.c, card=p["card"], step=p["step"], text=shown, details=details, author=AUTHOR,
                                 check=act.check, run=act.run, evidence=evidence, fp=p["fp"])
    if new:
        act.comments += 1
        check = read(ctx.c, act.check)
        rec = ((check or {}).get("runs") or {}).get(act.doc)
        if check is not None and rec is not None and rec.get("run") == act.run:
            rec["comments"] = act.comments
            save(ctx.c, check)
    return tools.ok(f"commented on {p['ref']}")


def _add_answer_comment(ctx: Any, act: _Active, args: dict[str, Any]) -> Any:
    """add_comment in a run over Claude's answers: a comment beside a sentence the run covers, `answer:<turn>#s<n>`,
    stored with the sentence's raw text and offsets (answer_comments.add)."""
    ref = str(args.get("ref") or "").strip().strip("[]").strip()
    text = _collapse(args.get("text"))
    if not text:
        return tools.err("add_comment: `text` is empty")
    if ref not in set(act.covered):
        return tools.err(tools.hint("add_comment-uncovered", ref=ref or "(no ref)"))
    p = answer_comments.passage_of(ctx.c, ref)
    if p is None:
        return tools.err(tools.hint("add_comment-uncovered", ref=ref))
    shown, details, evidence = note_parts(ctx.c, text, args.get("details"))
    if not shown:
        return tools.err("add_comment: `text` holds nothing but citations")
    _, new = answer_comments.add(ctx.c, passage=p, text=shown, details=details, author=AUTHOR, check=act.check,
                                 run=act.run, evidence=evidence)
    if new:
        act.comments += 1
        check = read(ctx.c, act.check)
        rec = ((check or {}).get("runs") or {}).get(act.doc)
        if check is not None and rec is not None and rec.get("run") == act.run:
            rec["comments"] = act.comments
            save(ctx.c, check)
    return tools.ok(f"commented on {p['ref']}")


# --------------------------------------------------------------------------- routes


class CheckBody(BaseModel):
    name: str = Field(max_length=200)
    prompt: str = Field(max_length=PROMPT_CHARS * 2)
    covers: list[str] | None = None


class CheckEdit(BaseModel):
    shown: bool | None = None
    name: str | None = Field(default=None, max_length=200)
    prompt: str | None = Field(default=None, max_length=PROMPT_CHARS * 2)
    colour: int | None = None
    covers: list[str] | None = None


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
    check = create(c, body.name, body.prompt, created_by="analyst", covers=body.covers)
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
    wider = body.covers is not None and bool(set(covers_of(body.covers)) - set(covers_of(before.get("covers"))))
    starts = body.shown is True or (body.prompt is not None and (before.get("shown") or body.shown)
                                    and str(body.prompt).strip() != before.get("prompt")) or (wider and before.get("shown"))
    if starts or (body.shown is False and any(k[0] == c and k[1] == cid for k in _active)):
        _click(request)
    check = edit(c, cid, name=body.name, prompt=body.prompt, colour=body.colour, shown=body.shown, covers=body.covers)
    if body.shown is False:
        await stop_check(c, cid)
    elif check.get("shown") and (body.shown is True or check.get("version") != before.get("version") or wider):
        _spawn(c, refresh(c, cid))
    return read(c, cid) or check


async def _run(c: str, cid: str, body: RunBody) -> dict[str, Any]:
    from . import report_types  # noqa: PLC0415

    _ws(c)
    if read(c, cid) is None:
        raise HTTPException(404, f"no check {cid!r}")
    doc = str(body.doc or "").strip().lower().removeprefix("report:")
    if doc != CANVAS and (not report_types.SLUG_RE.match(doc) or report_types.read_type(c, doc) is None):
        raise HTTPException(404, f"no document {doc!r}")
    if doc == CANVAS and not covers(read(c, cid), "cards"):
        raise HTTPException(409, f"check {cid!r} does not cover the cards")
    rec = await start_run(c, cid, doc, passages_=body.passages or None, force=True, route="click")
    if rec is None:
        raise HTTPException(409, "no card to check" if doc == CANVAS else f"report:{doc} has no passage to check")
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


@router.get("/ws/{c}/answer-comments")
async def answer_comments_route(c: str, session: str | None = None, status: str = "open") -> dict[str, Any]:
    """The checks' comments on Claude's answers (answer_comments.state): {comments, running}, of one session's answers
    when `session` is given; `status` open (the default) or all."""
    _ws(c)
    if status not in ("open", "all"):
        raise HTTPException(400, "status is open or all")
    return await asyncio.to_thread(answer_comments.state, c, session, status)


@router.post("/ws/{c}/answer-comments/{cid}/dismiss")
async def answer_comment_dismiss_route(c: str, cid: str) -> dict[str, Any]:
    """The analyst's Done on a comment on an answer, which takes its tint away. The comment; 404 for none."""
    _ws(c)
    return await asyncio.to_thread(answer_comments.set_status, c, cid, answer_comments.SETTLED)


@router.post("/ws/{c}/answer-comments/{cid}/reopen")
async def answer_comment_reopen_route(c: str, cid: str) -> dict[str, Any]:
    """A dismissed comment on an answer open again. The comment; 404 for none."""
    _ws(c)
    return await asyncio.to_thread(answer_comments.set_status, c, cid, "open")


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
