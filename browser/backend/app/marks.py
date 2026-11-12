"""Checks in the chat: the claims of main's reply that the analyst would want to check, which main writes as `[words](#)`
(plugin/prompts/citing.md, Citing claims). A card's value that main cites in the older form,
`[[4 of 24|card:<id>@out0#L2]]`, reaches the chat as a mark too (cite.chat_form, session.visible). They are checked
after the reply, as the terminal plugin checks them (plugin/marks/checker.ts):

1. At the end of main's turn (session._end_turn), the marks of the turn's texts (marks_of.mjs, with the terminal's
   plugin/marks/message.js) are kept, all `checking`, under the turn id that main's `done` record names; the page draws
   each with a spinner.
2. The checker: forks of main's session at the turn's end (on Claude Code sign-in, `claude --resume <main>
   --resume-session-at <cut> --fork-session` through the Agent SDK), up to MAX_FORKS at once, each with a share of the
   marks, read the terminal's checker.md as the workbench reads it (CHECKER, prompts.py: with the workbench's words in
   its slots of a mode's own words) and give one JSON item per mark: verified, corrected, wrong or unconfirmed, with its
   evidence. A fork reads with Read, Grep and Glob, and runs code only as Python (Bash `python3 …`), on Claude Code
   sign-in in Claude Code's sandbox where it can run; its one Python script runs whatever Claude Code's own rule makes
   of the code, as the terminal's check's does (run_fork, fork_options).
3. The validator, the terminal's own (plugin/engine/kernel/evidence.py), checks that evidence with no model call and no
   code run: a quote must stand in the file's line, and computed evidence names one of the conversation's real Bash
   calls (the fork's or main's) by a part of its output, and that call's real output must show the words. A cited file
   lies in the corpus folder or main's, or is a label's definition, which holds the label's rule (_rules_dir); code
   may also cite the workspace's temp folder, and the one Claude Code's sandbox gives main's commands on Claude Code
   sign-in (_temp_dirs). Its result is what the analyst sees. A label is read as it was when the reply was written
   (`at`, the time thimble keeps for the check's words, label_versions.keep_time), from the versions thimble kept of
   it, never from the label's files in the workspace (session_cards).
4. When the reply's last mark settles, main reads what the check changed with its next event (a quiet `citations`
   event, events.QUIET_KINDS), under the frame that heads thimble's reports: the terminal's notices, the same text
   (plugin/prompts/notices.md) built by the same module (plugin/marks/notices.mjs, through notices_of.mjs).
5. Repair in a failed mark's label (repair, the terminal's x) checks that one mark again: a fork of main reads the
   checker's text with the terminal's repair request (notices.mjs), the validator decides, and main hears how it
   ended. A check that finds a mark wrong or cannot confirm it starts that repair itself, as soon as it ends
   (_check_share, the terminal's autoRepair); a repair's own end starts none, so a mark that fails again waits for
   Repair.
6. A mark the check verified or corrected keeps what its evidence rests on (`sources`, the validator's: the cited lines
   of a quote or of code, the files its code read when the validator ran it again in the terminal's sandbox and the
   files its code names, as the check read them; for a card's value, the files the card's code read when it last ran,
   _card_rests), and one index of the cited files lists the marks that rest on each (`<workspace>/marks/cited.json`,
   kept as each reply and each takeaway's marks are saved: _note_cited). Whenever the page reads a chat (agents.py),
   refresh_soon makes one pass in the background, as the terminal does after Claude's calls that can write
   (plugin/marks/stale.ts): a stat of each cited file, and only for a file whose stat changed since the last pass, the
   marks that rest on it, from the replies and the takeaways that hold them, to evidence.examine, which reads the file
   once for all of them. A mark whose source changed is stale, which the page draws (marks.ts lookOf); cited lines that
   only moved take their new numbers, with no other sign. A mark whose evidence printed a value is stale only when the
   value changed: computed evidence's code runs again in the sandbox (`rerun`, evidence.examine, through validate.py),
   and a card's code runs again on its kernel, not kept (notebook.trial_run), and its cited places are read again
   (_card_now); the same value, and the mark rests on what that run read. Repair checks a stale mark again against the
   files as they are now, its computed evidence only a call of that check's own (`fresh`), and so each Repair of it
   until one of those checks passes (the mark's `fresh`: the files that changed). That check takes the other such
   marks of its sentence (of its takeaway, for a takeaway's) with it, so that one rewrite of the sentence corrects them
   all. A mark that rests on a card's value, and a stale mark of a card's takeaway, has that card run again first, so
   its check reads the card as the files make it now, and its request says that the card ran again.

The cards are evidence too: before the forks start, every place of the workspace's cards and its value (a table's cell,
a chart's data row, a line of printed output) is written to a file the checker greps first (session_cards, the
validator's card_index), and the validator confirms a card's place by reading it (check_card). So is every label of the
workspace, as the terminal lists its labels: `card:label-<label id>`, a place for each value's count and share, from
the versions the label kept (label_versions): the label as it was when the cited words were written, then its earlier
versions (`card:label-<id>@v<n>#…`), never a version made after the words. So a trial's counts cited before the run on
everything replaced them hold against the trial, and no later change of the label (a run, a correction, a write to its
files by a card's code) confirms words written before it. A label's card, which apply_label makes, reads the same
versions under its own id, which the file leaves out, so the checker finds each label once.

A card's takeaway is checked the same way: its marks, `[words](#)`, are checked as soon as the card's write lands
(card_written: after the add_card or edit_card call that wrote it, after the card check that may rewrite it, after the
analyst's edit), and any takeaway still waiting is checked with main's reply (the takeaways no check has started on,
notebook.takeaways_to_check); their line names the card, so the check looks in its output first. A takeaway a check
has claimed (_claimed) is never checked twice. What the check found is kept on the card (`takeaway_marks`,
notebook.set_takeaway_marks), and the page draws the takeaway's marks as it draws the chat's.

A side thread's answer is checked as a reply is, as the terminal checks it (checker.ts checkAnswer): when the thread's
fork ends a run (session._finish_sub), the marks of its answer are checked under the turn id that the run's `done`
record names in the thread's chat (answer_ended). The fork of main that checks them never read the answer, so the
checker's text says what holds them (THREAD_ANSWER), and the Bash calls of the thread's fork are evidence where main's
are for a reply. Main hears nothing of that check, nor of a repair of one of its marks.

Every way a check ends (an answer, an error, a timeout) leaves none of its marks `checking`, and an error a mark's reason
or a notice quotes names each path of this machine in it as the validator names a file (_error_words). A reply's marks
are kept in
`<workspace>/marks/<turn>.json`, and each change is written to main's log, or to the thread's chat for a side thread's
answer, as a `marks` record {turn, items}, which the page reads (the newest record of a turn wins).

The fork (run_fork) is the one place that knows main runs in Claude Code; another runtime gives its own.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.util
import json
import logging
import os
import re
import secrets
import stat
import subprocess
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import agents, config, ledger, nofollow, prompts, sdk

log = logging.getLogger("thimble.marks")
router = APIRouter()

HERE = Path(__file__).resolve().parent
MARKS_OF = HERE / "marks_of.mjs"
NOTICES_OF = HERE / "notices_of.mjs"
PLUGIN = HERE.parents[2] / "plugin"  # the terminal plugin, whose validator this module runs
CHECKER = "plugin:checker"  # the terminal's checker.md (prompts.py reads a text of the plugin by this name)
EVIDENCE = PLUGIN / "engine" / "kernel" / "evidence.py"
VALIDATE = PLUGIN / "engine" / "validate.py"  # the terminal's validator as a command, whose sandbox runs a mark's code again
RUN_S = 90  # seconds a run of a mark's code through the validator may take: its own limit, 60 s, and its start
# A reply with many marks is split between forks, each with about PER_FORK marks (at most MAX_FORKS forks), which run at
# once, so the reply settles when its slowest share does (the terminal's checker.ts).
PER_FORK = 4
MAX_FORKS = 8
FORK_TIMEOUT_S = 900
# a failed fork's error: its stderr's last lines (stderr_error), and at most this many characters of its own words
STDERR_LINES = 3
ERROR_CHARS = 2000
CHECKER_TOOLS = ("Read", "Grep", "Glob", "Bash")
ALLOWED = ("Read", "Grep", "Glob", "Bash(python3:*)", "Bash(python:*)")
TELL_KIND = "citations"
# What holds the marks the checker checks (its {{REPLY}}): main's last reply, or a side thread's answer, which the fork
# of main that checks it never read. The terminal's LAST_REPLY and threadAnswer (plugin/marks/checker.ts), word for
# word (tests/test_marks.py); a thread is named by its title.
LAST_REPLY = "your last reply"
THREAD_ANSWER = ("an answer that a side thread of this session gave the analyst about {about}. That thread's work is "
                 "not in your conversation, so find the evidence in the files")
# the id a label is cited by in the check, `card:label-<label id>`, as the terminal names its labels
# (evidence.LABEL_CARD): session_cards
LABEL_PLACE = "label-"

_locks: dict[tuple[str, str], asyncio.Lock] = {}
# (workspace, card, takeaway) of the takeaways a check has taken until their marks are on the card, so a check that
# starts meanwhile (main's reply ending as the card's write lands) leaves them alone
_claimed: set[tuple[str, str, str]] = set()
_forks: set[asyncio.Future[dict[str, Any]]] = set()  # the forks that run (run_fork), which stop_all ends


# ---- the terminal's texts and validator

def checker_prompt(marks: str, cwd: str, cards: str = "", root: str | None = None, reply: str = LAST_REPLY) -> str:
    """The checker's text for `marks`, which `reply` holds (LAST_REPLY, or a side thread's THREAD_ANSWER): its shell in
    `cwd`, its paths from `root` (check_folders; `cwd` when None)."""
    return prompts.render(CHECKER, {"MARKS": marks, "CWD": cwd, "ROOT": root or cwd, "CARDS": cards, "REPLY": reply})


def check_folders(c: str, main: dict[str, Any]) -> tuple[str, str]:
    """(cwd, root) of a check, as the terminal's checker.ts gives them: the folder main's session runs in, where the
    fork's shell starts, and the workspace's corpus folder, which the cards' and the refs' paths start from. Main may run
    in a folder inside the corpus folder (claude started in one run's folder of a registered folder), and every file of
    the corpus folder is still the records: the validator reads a cited path from either folder, and a file inside
    neither is outside. A corpus whose folder cannot be found leaves main's folder alone."""
    try:
        root = str(config.corpus_dir(c))
    except ValueError:
        root = ""
    return str(main.get("cwd") or root), root or str(main.get("cwd") or "")


def session_cards(c: str) -> list[dict[str, Any]]:
    """The workspace's cards and labels as the validator reads them (evidence.check_card): each card that ran with
    outputs, its title, and per output the cells of its table (a frame's shown values, a chart's data rows, an html
    table) or the lines of its printed text, as the card's citations name them (cite.bundle_cells,
    cite.numbered_lines), with the tables the output holds as data (card_tables), whose rows a count counts
    (evidence.check_count). Then each label of the workspace, as the terminal gives its labels
    (evidence.terminal_label_cards): `label-<label id>`, titled `label <name>`, an entry for each version the label kept
    (label_versions), its table as the label showed it then (concepts.card_table) and as data, which names the row that
    totals its values (`totals`), with when that version was made, what made it and what changed after it. The
    validator reads a label as it was when the cited words were written, never from its files in the workspace, which a
    card's code can write. A label's card (kind `label`, which apply_label makes) gives its label's entries again under
    its own id, so a citation of it reads the same versions, `listed` False: the checker's file lists each label once
    (cards_index)."""
    from . import cite, concepts, notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    label_cards: list[tuple[dict[str, Any], str]] = []  # the labels' cards: (the card, its label's id)
    for _, nb in notebook._stored(ws):
        for cell in nb.get("cells") or []:
            cid = str(cell.get("id") or "")
            # a card is read once, by the first cell of its id: a second cell of that id (the canvas's files are the
            # workspace's, which a card's code writes) adds no versions or values under it; nor does a cell whose id is
            # a label's (no card's id starts so: notebook._new_id)
            if not cid or cid in seen or cid.startswith(LABEL_PLACE):
                continue
            seen.add(cid)
            card = {"id": cid, "title": str(cell.get("title") or "")}
            if cell.get("kind") == "label":
                payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
                label_cards.append((card, str(payload.get("concept") or "")))
            elif notebook.runnable(cell) and cell.get("outputs"):
                outs = _outputs(list(cite.iter_outputs(notebook.hydrate_outputs(ws, cell["outputs"]))))
                if outs:
                    out.append({**card, "outputs": outs})
    labels: dict[str, list[dict[str, Any]]] = {}
    try:
        listed = concepts.list_concepts(ws)
    except Exception:  # noqa: BLE001 — labels that cannot be listed leave the cards to the check
        log.exception("%s: the labels were not read for the check", c)
        listed = []
    for concept in listed:
        try:
            labels[concept["id"]] = _label_versions(c, concept)
        except Exception:  # noqa: BLE001 — a label that cannot be read is left out, not the others
            log.exception("%s: the versions of label %s were not read", c, concept["id"])
        out += labels.get(concept["id"]) or []
    for card, kid in label_cards:
        out += [{**v, **card, "listed": False} for v in labels.get(kid) or []]
    return out


def _label_versions(c: str, concept: dict[str, Any]) -> list[dict[str, Any]]:
    """A label as the validator reads it (session_cards): an entry for each version it kept, oldest first."""
    from . import label_versions  # noqa: PLC0415

    kept = label_versions.read(c, concept["id"])
    # a label that shows other counts now than its newest version, which no step of thimble's kept (a write to its
    # files): that version is shown no longer, and nothing is evidence of what the label shows
    since = time.time() if kept and label_versions.shows_other(c, concept, kept[-1]) else None
    card = {"id": f"{LABEL_PLACE}{concept['id']}", "title": f"label {concept['name']}"}
    out = []
    for i, v in enumerate(kept):
        newest = since is not None and i == len(kept) - 1
        out.append({**card, "version": v["v"], "from": v["at"], "made": v["made"],
                    "after": label_versions.CHANGED if newest else label_versions.after_text(kept, i),
                    **({"to": since} if newest else {}), "outputs": _version_outputs(v)})
    return out


def _version_outputs(v: dict[str, Any]) -> list[dict[str, Any]]:
    """A label version's output as the validator reads it (session_cards): the cells of its table as the card showed it
    (concepts.card_table), and the same rows as data (concepts.card_rows), which a count of the label's values counts,
    with the row that totals them (`totals`)."""
    from . import concepts  # noqa: PLC0415

    t = concepts.card_rows(v)
    totals = t.pop("totals")
    return [{**o, "tables": [t], **({"totals": totals} if totals else {})}
            for o in _outputs([(0, concepts.card_table(v))])]


def _outputs(bundles: list[tuple[int, dict[str, Any]]]) -> list[dict[str, Any]]:
    """A card's output bundles as the validator reads them (session_cards): each table's cells, else the lines of each
    printed text, each with the tables it holds as data (card_tables)."""
    from . import cite, notebook  # noqa: PLC0415

    outs: list[dict[str, Any]] = []
    for i, b in bundles:
        if notebook.ERROR_MIME in b:
            continue
        cells = cite.bundle_cells(b)
        tables = card_tables(b)
        if cells:
            outs.append({"out": i, "corner": cite._row_names(b)[0], "cells": [list(x) for x in cells],
                         **({"tables": tables} if tables else {})})
        elif cite.chart_spec(b) is None and not any(k.startswith("image/") for k in b):
            lines = [[n, t] for n, t in cite.numbered_lines(b) if t.strip()]
            if lines:
                outs.append({"out": i, "lines": lines, **({"tables": tables} if tables else {})})
    return outs


def card_tables(b: dict[str, Any]) -> list[dict[str, Any]]:
    """The tables an output holds as data, which a count of a card's rows counts (evidence.check_count), each {columns,
    rows, names, label, total, lines?}: a table card's DataFrame (frames.py), the rows of a chart's main part (none when
    another part draws rows of the same columns, so the chart's rows are split), a diagram's edges and a timeline's
    events (on the lines of their listing after its first), and each table the card's code printed (on its lines). The
    rows are the values themselves, never their text; names are the rows' names as the output's citations write them."""
    from . import cite, frames  # noqa: PLC0415
    from .kernel_thimble import DIAGRAM_MIME, TIMELINE_MIME  # noqa: PLC0415

    def frame_table(f: dict[str, Any], lines: list[int] | None = None) -> dict[str, Any]:
        t = {"columns": [str(x) for x in f["columns"]], "rows": f["rows"], "names": frames.row_labels(f), "label": f.get("label"),
             "total": int(f.get("total") or len(f["rows"]))}
        return {**t, "lines": lines} if lines else t

    f = frames.frame_of(b)
    if f is not None:
        return [frame_table(f)]
    spec = cite.chart_spec(b)
    if spec is not None:
        main = cite._main_part(spec)
        table = cite.chart_table(b)
        if main is None or table is None:
            return []
        part, raw = main
        rows = [r for r in raw[:cite.CHART_ROWS_MAX] if isinstance(r, dict)]
        cols = list(dict.fromkeys(str(k) for r in rows for k in r))
        # another part with other rows of the columns draws the rest of them (a layer each for some services, one with a
        # column more); a part that draws the same rows again (a layer of labels over its bars) splits nothing
        if any(p is not part and got is not raw and got != raw and {str(k) for r in got if isinstance(r, dict) for k in r} >= set(cols)
               for p, got in cite._row_parts(spec)):
            return []
        return [{"columns": cols, "rows": [[r.get(k) for k in cols] for r in rows], "names": table.labels, "label": table.label,
                 "total": len(raw)}]
    drawn = b.get(DIAGRAM_MIME) if isinstance(b.get(DIAGRAM_MIME), dict) else b.get(TIMELINE_MIME) if isinstance(b.get(TIMELINE_MIME), dict) else None
    if drawn is not None:
        edges = DIAGRAM_MIME in b
        items = [x for x in drawn.get("edges" if edges else "events") or [] if isinstance(x, dict)]
        cols = ["source", "target", "label"] if edges else ["time", "label", "lane", "end"]
        names = [f"{x.get('source')} -> {x.get('target')}" if edges else str(x.get("time") or "") for x in items]
        return [{"columns": cols, "rows": [[x.get(k) for k in cols] for x in items], "names": names, "label": None,
                 "total": len(items), "lines": [2, 1 + len(items)]}] if items else []
    return [frame_table(f, span) for span, f in frames.printed_frames(b)]


def cards_index(c: str, cards: list[dict[str, Any]], at: float | None = None) -> str:
    """The file the checker greps for a value a card or a label shows (the validator's card_index), the labels as they
    were at `at`, when the cited words were written, in a folder of its own in the workspace's temp folder; its path.
    The entries of a label's card are left out (`listed` False, session_cards): its label is listed by its own id. Each check has its own: a card rewritten while a check runs starts another check, whose index must not
    take the place of the one this check's validator reads `cards` as."""
    folder = _temp_dir(c) / f"check-{secrets.token_hex(4)}"
    p = folder / "cards-index.tsv"
    # in the temp folder a card's code writes: made and written as nofollow does, never through a link put there
    nofollow.write_text(p, evidence().card_index([x for x in cards if x.get("listed", True)], at), make=True)
    return str(p)


def _drop_index(index: str) -> None:
    """A check's index, gone with its folder once the check ended."""
    if index:
        with contextlib.suppress(OSError):
            nofollow.unlink(index)
            nofollow.rmdir(Path(index).parent)


def evidence() -> ModuleType:
    """The terminal's validator (plugin/engine/kernel/evidence.py, standard library only), loaded once by its path."""
    name = "thimble_kernel_evidence"
    mod = sys.modules.get(name)
    if mod is None:
        spec = importlib.util.spec_from_file_location(name, EVIDENCE)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod


def _srt_folder() -> str | None:
    """The folder srt is installed in, for the validator's runs of a mark's code: the plugin's pin in the plugin's
    home, where the install and each terminal session's start put it (plugin/sandbox/setup.mjs); None when it is not
    there, and the validator looks in its own home (THIMBLE_HOME)."""
    from . import fixes  # noqa: PLC0415

    try:
        pin = json.loads((PLUGIN / "sandbox" / "package.json").read_text())["dependencies"]["@anthropic-ai/sandbox-runtime"]
    except (OSError, ValueError, KeyError):
        return None
    at = fixes.plugin_home() / "srt" / pin
    return str(at) if (at / "node_modules").is_dir() else None


def runner(c: str, folders: tuple[str, str]) -> Callable[..., dict[str, Any] | None]:
    """The runner the validator takes (evidence.Runner): a mark's code run again in the terminal's sandbox, through the
    validator as a command (validate.py "run"), which reads the check's folders (`folders`, check_folders) and the
    workspace's temp folders, writes only a temp folder of its own and reaches no network. A run that cannot start
    answers None, as one that ran out of time."""
    shown = [f for f in (*folders, *_temp_dirs(c)) if f]
    srt = _srt_folder()

    def run(script: str, folder: str, python: str = "python3", flags: Any = (), argv: Any = ("-",)) -> dict[str, Any] | None:
        req = {"run": {"script": script, "folder": folder, "python": python, "flags": list(flags), "argv": list(argv),
                       "folders": shown}, "srt": srt}
        try:
            done = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps(req), capture_output=True, text=True,
                                  env=config.passed_environ(), timeout=RUN_S, cwd=folder)
            got = json.loads(done.stdout).get("ran")
        except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
            return None
        return got if isinstance(got, dict) else None

    return run


# ---- a reply's marks: <workspace>/marks/<turn>.json {turn, items, times}, and for a side thread's answer `thread`
# {chat, about, calls} (answer_ended)

def _path(c: str, turn: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{8}", turn):
        raise KeyError(turn)
    return config.workspace_dir(c) / "marks" / f"{turn}.json"


def stored(c: str, turn: str) -> dict[str, Any] | None:
    try:
        got = ledger.read_json(_path(c, turn), None)
    except KeyError:
        return None
    return got if isinstance(got, dict) else None


def _save(c: str, reply: dict[str, Any], cited: dict[str, dict[str, Any]] | None = None) -> None:
    """Write a reply's marks, and the index of cited files when the files its marks rest on changed from `cited`, those
    of the reply as it was (_cited_by; a new reply rests on none)."""
    p = _path(c, reply["turn"])
    nofollow.makedirs(p.parent)
    ledger.write_json(p, reply)
    if {f: sorted(x["ns"]) for f, x in _cited_by(reply).items()} != {f: sorted(x["ns"]) for f, x in (cited or {}).items()}:
        _note_cited(c, reply)
    thread = (reply.get("thread") or {}).get("chat")
    if thread:  # a side thread's answer, which its chat draws
        agents.Recorder(c, thread).record("marks", turn=reply["turn"], items=reply["items"])
    else:
        agents.mirror(c, "marks", turn=reply["turn"], items=reply["items"])


async def marks_of(texts: list[str]) -> list[dict[str, Any]]:
    """Each mark of the texts: {piece, k, words, sentence} (marks_of.mjs). Node runs in a worker thread, not as an
    asyncio subprocess: the check that asks runs in the background, so the loop's close can cancel it while Node starts
    (a server that stops, a test that ends), and on Python 3.12.3, Ubuntu 24.04's, an asyncio subprocess cancelled
    before its pipes connect leaves that close waiting for it forever."""
    done = await asyncio.to_thread(subprocess.run, ["node", str(MARKS_OF)], input=json.dumps({"texts": texts}).encode(),
                                   capture_output=True)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode(errors="replace").strip()[-300:] or "marks_of.mjs failed")
    return json.loads(done.stdout.decode())


def split_marks(items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """The marks split into the forks' shares, in order: one share up to PER_FORK marks, else as many as PER_FORK gives
    (at most MAX_FORKS), of about equal size. The marks of one sentence stay in one share up to a share's size, since a
    fork writes the notes on its sentences; each run of a sentence's marks goes to the share its middle falls in."""
    k = min(MAX_FORKS, max(1, -(-len(items) // PER_FORK)))
    size = -(-len(items) // k)
    runs: list[list[dict[str, Any]]] = []
    for m in items:
        if runs and runs[-1][0]["sentence"] == m["sentence"] and len(runs[-1]) < size:
            runs[-1].append(m)
        else:
            runs.append([m])
    out: list[list[dict[str, Any]]] = [[] for _ in range(k)]
    before = 0
    for run in runs:
        out[min(k - 1, int((before + len(run) / 2) * k / len(items)))].extend(run)
        before += len(run)
    return [s for s in out if s]


def notices(payload: dict[str, Any]) -> dict[str, str]:
    """notices_of.mjs's answer for `payload` (its note): {text, frame}, the words built from plugin/prompts/notices.md
    with the workbench's words in its slots, as the terminal builds them (plugin/marks/notices.mjs)."""
    done = subprocess.run(["node", str(NOTICES_OF)], input=json.dumps(payload).encode(), capture_output=True)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode(errors="replace").strip()[-300:] or "notices_of.mjs failed")
    return json.loads(done.stdout.decode())


def tell_text(items: list[dict[str, Any]]) -> str:
    """What main reads with its next event: each mark the check corrected (a narrowing and a rewrite each in its own
    words) or flagged, as the analyst reads it, and each note, which the analyst does not see (the terminal's tellText);
    '' for nothing to tell."""
    return notices({"kind": "tell", "items": items})["text"]


def _notice(c: str, text: str, details: str | None = None) -> None:
    """The check's notice; `details`: its whole text when `text` holds an error's words shortened (_stopped)."""
    from . import notices  # noqa: PLC0415

    try:
        notices.post(c, kind="agent", text=text, agent="Citation check", chat=agents.MAIN_ID, key="citations",
                     details=details)
    except Exception:  # noqa: BLE001 — a notice not posted is no reason to fail the check
        log.exception("%s: the citation check's notice was not posted", c)


def _framed(told: dict[str, str]) -> str:
    """A notice (notices) as main reads it in its `citations` event: under the frame that heads thimble's reports, which
    says that what it quotes from the records is data, as the terminal's report does (core/tell.ts reportOf)."""
    return f"{told['frame']}\n\n{told['text']}"


def _tell(c: str, text: str) -> None:
    from . import events  # noqa: PLC0415

    try:
        events.post(c, TELL_KIND, {"text": text})
    except Exception:  # noqa: BLE001 — no session listens: main misses the corrections, the analyst still sees them
        log.info("%s: main was not told what the citation check changed", c)


def _checked(m: dict[str, Any]) -> bool:
    """Whether the reply's own check still checks this mark: a mark a repair checks again is the repair's to tell of."""
    return m["status"] == "checking" and not m.get("repair")


async def _edit(c: str, turn: str, change: Callable[[dict[str, Any]], dict[str, Any]], tell: bool = True) -> dict[str, Any] | None:
    """A change of a reply's marks, one at a time; when it settles the last mark the reply's check judges, main is told
    what the check changed (`tell`; a repair tells main of its own mark, repair_tell_text). Main never read a side
    thread's answer, so it hears nothing of its check."""
    async with _locks.setdefault((c, turn), asyncio.Lock()):
        reply = stored(c, turn)
        if reply is None:
            return None
        was_open = any(m["status"] == "checking" for m in reply["items"])
        was_checked = any(_checked(m) for m in reply["items"])
        cited = _cited_by(reply)
        reply = change(reply)
        settled = was_open and not any(m["status"] == "checking" for m in reply["items"])
        if settled:
            reply.setdefault("times", {})["settled"] = time.time()
        _save(c, reply, cited)
    if reply.get("thread"):
        return reply
    if tell and was_checked and not any(_checked(m) for m in reply["items"]):
        told = await asyncio.to_thread(notices, {"kind": "tell", "items": reply["items"]})
        if told["text"]:
            _tell(c, _framed(told))
    return reply


async def _give_up(c: str, turn: str, ns: set[int], why: str) -> None:
    """Each of these marks still checked becomes unchecked: no check gave an answer for it."""
    def change(r: dict[str, Any]) -> dict[str, Any]:
        r["items"] = [{**m, "status": "unchecked", "reason": why} if m["n"] in ns and m["status"] == "checking" else m
                      for m in r["items"]]
        return r

    await _edit(c, turn, change)


# ---- 1: the turn ended

def new_turn() -> str:
    return secrets.token_hex(4)


def turn_ended(c: str, main: dict[str, Any], turn: str, texts: list[str], cut: str | None) -> None:
    """Main's turn `turn` ended (session._end_turn) with these texts, at the turn_duration record `cut` (None for a turn
    that was stopped or never got one). `main` is what the fork needs of main's session: {sid, cwd, config,
    config_known, transcript_path, model, effort, context_tokens}. Runs on the server's loop; nothing without one.
    A turn whose texts hold no mark still starts a check when a card's takeaway waits for one."""
    from . import notebook  # noqa: PLC0415

    if not any("](#)" in t for t in texts or []):
        try:
            if not notebook.takeaways_to_check(c):
                return
        except Exception:  # noqa: BLE001 — no takeaway to check
            return
    _spawn(start_check(c, main, turn, list(texts), cut))


def _spawn(coro: Awaitable[None]) -> None:
    """Run `coro` on the server's loop: the running one, else the one notices keeps; nothing without one."""
    try:
        asyncio.get_running_loop().create_task(coro)  # type: ignore[arg-type]
        return
    except RuntimeError:
        pass
    from . import notices  # noqa: PLC0415 — the server's loop, which notices keeps (notices._lifespan)

    loop = notices._loop
    if loop is not None and loop.is_running() and not loop.is_closed():
        asyncio.run_coroutine_threadsafe(coro, loop)  # type: ignore[arg-type]
    else:
        coro.close()  # type: ignore[attr-defined]


def card_written(c: str, cid: str | None) -> None:
    """Card `cid`'s write landed (an add_card or edit_card call, the end of its card check, the analyst's edit): the
    marks of its takeaway that no check has started on are checked now, from a fork of main, rather than with main's
    next reply. Not while the card runs, nor while its card check may still rewrite the takeaway (that check's end
    calls this again). Never raises."""
    if not cid:
        return
    try:
        from . import card_check, notebook, session  # noqa: PLC0415

        cell = notebook.get_cell(c, cid)
        if not cell or cell.get("status") == "running" or "](#)" not in str(cell.get("takeaway") or ""):
            return
        run = card_check._runs.get((c, cid))
        if run is not None and run.task is not None and not run.task.done():
            return
        if not any(t[0] == cid for t in notebook.takeaways_to_check(c)):
            return
        lv = session.current(c)
        if lv is None:
            return  # no main to fork: main's next reply checks it
        # the fork resumes main at its last finished turn; the runtime's forks take main's conversation as it stands
        cut = lv.last_cut or ""
        main = {"sid": lv.sid, "cwd": lv.cwd, "config": lv.config, "config_known": lv.config_known,
                "transcript_path": lv.transcript_path, "model": lv.model, "effort": lv.effort,
                "context_tokens": lv.context_tokens}
        _spawn(start_check(c, main, new_turn(), [], cut, cards={cid}))
    except Exception:  # noqa: BLE001 — a takeaway not checked now is checked with main's next reply
        log.exception("%s: the check of card %s's takeaway did not start", c, cid)


def answer_ended(c: str, chat: str, turn: str, texts: list[str], calls: str) -> None:
    """Side thread `chat`'s fork ended a run with these texts, its answer, under the turn that the run's `done` record
    names (session._finish_sub). Their marks are checked as a reply's are, by a fork of main at its last finished turn
    whose text says what holds them (THREAD_ANSWER); the Bash calls in `calls`, the transcript of the thread's fork,
    are evidence where main's are for a reply. No takeaway waiting is checked with them. With no main to fork (a
    Claude Code session whose first turn still runs), they wait, not checked. Runs on the server's loop; nothing
    without one."""
    if not any("](#)" in t for t in texts):
        return
    got = _main_now(c)
    if isinstance(got, str):
        log.info("%s: the citations of thread %s's answer are not checked: %s", c, chat, got)
        return
    main, cut = got
    about = f'"{(agents.meta_or_none(c, chat) or {}).get("title") or "thread"}"'
    thread = {"chat": chat, "about": about, "calls": calls}
    _spawn(start_check(c, main, turn, list(texts), cut, cards=set(), thread=thread))


async def start_check(c: str, main: dict[str, Any], turn: str, texts: list[str], cut: str | None,
                      fork: Callable[..., Awaitable[dict[str, Any]]] | None = None,
                      cards: set[str] | None = None, thread: dict[str, Any] | None = None) -> None:
    """Check the marks of main's `texts`, or of side thread `thread`'s answer (answer_ended), whose record keeps it, and
    of the takeaways waiting for a check (only those of `cards` when given, with no reply's record when there are no
    texts), each takeaway claimed until its marks are on its card."""
    from . import notebook  # noqa: PLC0415

    try:
        takeaways = notebook.takeaways_to_check(c) if cut is not None else []
    except Exception:  # noqa: BLE001 — the reply's marks are checked without the takeaways
        log.exception("%s: the takeaways to check could not be read", c)
        takeaways = []
    takeaways = [t for t in takeaways if (c, t[0], t[2]) not in _claimed and (cards is None or t[0] in cards)]
    claims = {(c, cid, text) for cid, _, text in takeaways}
    _claimed.update(claims)  # before the first await, so a check starting meanwhile leaves them alone
    try:
        await _start_check(c, main, turn, texts, cut, fork, takeaways, claims, saved=cards is None or bool(texts),
                           thread=thread)
    finally:
        _claimed.difference_update(claims)


async def _start_check(c: str, main: dict[str, Any], turn: str, texts: list[str], cut: str | None,
                       fork: Callable[..., Awaitable[dict[str, Any]]] | None, takeaways: list[tuple[str, str, str]],
                       claims: set[tuple[str, str, str]], saved: bool, thread: dict[str, Any] | None = None) -> None:
    from . import notebook  # noqa: PLC0415

    try:
        found = await marks_of(list(texts) + [t for _, _, t in takeaways])
    except (OSError, RuntimeError, ValueError) as e:
        said = _error_words(e, check_folders(c, main))
        _notice(c, f"thimble could not read the citations of the last reply ({said[:120]}), so they are not checked.")
        return
    if not found:
        return
    items = [{**m, "n": n, "status": "checking", "shown": m["words"]} for n, m in enumerate(found, 1)]
    chat = [m for m in items if m["piece"] < len(texts)]
    takes: list[dict[str, Any]] = []
    for m in items:
        if m["piece"] >= len(texts):
            cid, title, text = takeaways[m["piece"] - len(texts)]
            takes.append({**m, "card": cid, "title": title, "takeaway": text})
    # when the words were written, as thimble keeps it where no card's code writes (label_versions), for this check
    # and a later repair of one of its marks: a label is read as it was then
    at = time.time()
    if chat or (takes and saved):
        reply = {"turn": turn, "items": chat, "times": {"reply_end": at}}
        _save(c, {**reply, "thread": thread} if thread else reply)
    keys = [_time_key(turn=turn)] if chat else []
    keys += [_time_key(card=cid, text=text) for cid, text in dict.fromkeys((m["card"], m["takeaway"]) for m in takes)]
    for cid, text in dict.fromkeys((m["card"], m["takeaway"]) for m in takes):
        mine = [_takeaway_item(m) for m in takes if m["card"] == cid]
        _set_takeaway(c, cid, text, lambda _old, mine=mine: mine)
    _claimed.difference_update(claims)  # their marks are on their cards: takeaways_to_check passes them by now
    for key in keys:
        await asyncio.to_thread(_keep_time, c, key, at)
    if cut is None:
        await _give_up(c, turn, {m["n"] for m in chat}, "the reply was stopped before its citations were checked")
        return
    folders = check_folders(c, main)
    cards, index = await _cards_and_index(c, at)
    try:
        await asyncio.gather(*(_check_share(c, main, turn, cut, share, folders, fork or run_fork, cards, index, at=at)
                               for share in split_marks(chat + takes)))
    finally:
        _drop_index(index)


def _time_key(turn: str | None = None, card: str | None = None, text: str = "") -> str:
    """The key under which thimble keeps when a check's words were written (label_versions.keep_time): a reply's or a
    side thread's answer's turn, or a card's takeaway as its text then read."""
    if card:
        return f"takeaway:{card}:{hashlib.sha256(text.encode('utf-8')).hexdigest()[:32]}"
    return f"turn:{turn}"


def _keep_time(c: str, key: str, at: float) -> None:
    from . import label_versions  # noqa: PLC0415

    label_versions.keep_time(c, key, at)


def _time_of(c: str, key: str) -> float | None:
    from . import label_versions  # noqa: PLC0415

    return label_versions.time_of(c, key)


async def _cards_and_index(c: str, at: float | None) -> tuple[list[dict[str, Any]], str]:
    """The workspace's cards as the validator reads them, and the index the checker greps, the labels as they were at
    `at`; none when they cannot be read (the check runs without the cards). A label from before thimble kept versions
    first gets one (label_versions.keep_first), made after the words, so its card says it has none from before them."""
    from . import label_versions  # noqa: PLC0415

    try:
        await asyncio.to_thread(label_versions.keep_first, c)
        cards = await asyncio.to_thread(session_cards, c)
        return cards, cards_index(c, cards, at)
    except Exception:  # noqa: BLE001 — the check runs without the cards
        log.exception("%s: the cards' index was not written", c)
        return [], ""


def _takeaway_item(m: dict[str, Any]) -> dict[str, Any]:
    """A takeaway's mark as the card keeps it: its order `k` in the takeaway, its words and sentence, and its check."""
    return {k: v for k, v in m.items() if k not in ("piece", "card", "title", "takeaway")}


def _line(m: dict[str, Any]) -> str:
    """A mark's line in the checker's prompt; a takeaway's names its card, whose output the check reads first."""
    if m.get("card"):
        title = f" ({m['title']})" if m.get("title") else ""
        return f"{m['n']}. [{m['words']}] in the takeaway of card:{m['card']}{title}: {m['sentence']}"
    return f"{m['n']}. [{m['words']}] in: {m['sentence']}"


async def _takeaways_change(c: str, takes: list[dict[str, Any]], judged: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
    """Each card's takeaway marks of this share, as `judged` changes each one still checked."""
    by_card: dict[tuple[str, str], dict[int, dict[str, Any]]] = {}
    for m in takes:
        by_card.setdefault((m["card"], m["takeaway"]), {})[m["k"]] = m

    for (cid, text), mine in by_card.items():
        def change(items: list[dict[str, Any]], mine: dict[int, dict[str, Any]] = mine) -> list[dict[str, Any]]:
            return [judged({**it, "n": mine[it["k"]]["n"]}) if it.get("k") in mine and it.get("status") == "checking" else it
                    for it in items]

        try:
            _set_takeaway(c, cid, text, change)
        except Exception:  # noqa: BLE001 — a card gone or unwritable keeps what it had
            log.exception("%s: the takeaway marks of card %s were not written", c, cid)


def _set_takeaway(c: str, cid: str, text: str, change: Callable[[list[dict[str, Any]]], list[dict[str, Any]]]) -> bool:
    """A change of the marks of card `cid`'s takeaway `text` (notebook.set_takeaway_marks), and the index of cited files
    after it: its marks on the files they rest on now, under the card (`card:<id>`, each mark by its order `k`)."""
    from . import notebook  # noqa: PLC0415

    got: list[list[dict[str, Any]]] = []

    def keep(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        got.append(change(items))
        return got[-1]

    done = notebook.set_takeaway_marks(c, cid, text, keep)
    if done and got:
        _note_cited(c, {"items": got[-1]}, f"{CARD_KEY}{cid}", "k")
    return done


# ---- 2, 3: a fork's check, then the validator

async def _check_share(c: str, main: dict[str, Any], turn: str, cut: str, share: list[dict[str, Any]],
                       folders: tuple[str, str], fork: Callable[..., Awaitable[dict[str, Any]]],
                       cards: list[dict[str, Any]] | None = None, index: str = "", request: str = "",
                       auto: bool = False, at: float | None = None, fresh: bool = False) -> None:
    """One fork's check of a share of the marks. `request`: what follows the checker's text for a repair (Repair in a
    mark's label, the terminal's x, or one this check's end started, `auto`), whose end tells main how its marks
    ended, unless they are a side thread's. A check that is no repair repairs each mark it found wrong or could not
    confirm, as soon as it ends. `folders`: the check's (cwd, root), check_folders; `at`: when the marks' words were
    written, the time the validator reads a label at (None: now); `fresh`: a repair of stale marks, whose computed
    evidence is only a call of this check's own (the validator's check_all)."""
    takes = [m for m in share if m.get("card")]
    mine = {m["n"] for m in share if not m.get("card")}
    lines = "\n".join(_line(m) for m in share)
    thread = (stored(c, turn) or {}).get("thread")  # a side thread's answer (answer_ended)
    found: list[dict[str, Any]] = []  # the marks this check failed, which it repairs at its end

    async def give_up(why: str) -> None:
        await _give_up(c, turn, mine, why)
        await _takeaways_change(c, takes, lambda m: {**m, "status": "unchecked", "reason": why})

    try:
        cwd, root = folders
        holds = THREAD_ANSWER.format(about=thread["about"]) if thread else LAST_REPLY
        prompt = checker_prompt(lines, cwd, index, root, holds)
        got = await fork(c, main, cut, f"{prompt}\n\n{request}" if request else prompt)
        if got.get("error"):
            error = _error_words(got["error"], folders)
            await give_up(f"the check ended: {error}")
            _stopped(c, error)
            return
        answer = str(got.get("answer") or "")
        ev = evidence()
        cited = cited_outputs(answer)
        # the calls of whoever wrote the marks: main, or the thread's fork for a side thread's answer
        wrote = _fork_transcript(c, thread) if thread else main.get("transcript_path")
        mains = [k for k in bash_calls(_transcript_messages(wrote), "main")
                 if any(ev.printed(o, k["output"]) is not None for o in cited)]
        calls = list(got.get("calls") or []) + mains
        # the code of computed evidence runs again in the sandbox, to see which files it reads
        result = await asyncio.to_thread(ev.check_all, [{k: m[k] for k in ("n", "words", "sentence")} for m in share],
                                         answer, calls, cwd, root, _temp_dirs(c), cards or [], str(_rules_dir(c)), at,
                                         fresh, runner(c, folders))
        if not result["parsed"]:
            await give_up("the check gave no answer thimble could read")
            _notice(c, "The check of the citations gave no answer thimble could read, so some are not checked.")
            return
        by_n = {int(r["n"]): r for r in result["results"]}
        # a card's value rests on the files the card's code read
        rests = await asyncio.to_thread(lambda: {n: _card_rests(c, cards or [], r) for n, r in by_n.items()})

        def judged_one(m: dict[str, Any]) -> dict[str, Any]:
            res = by_n.get(m["n"])
            if res is None:
                return {**m, "status": "unchecked", "reason": "the check gave no answer for this citation"}
            # what it rests on is what this check read, if anything; a check that passed read the files as they are
            passed = res.get("status") in ("verified", "corrected")
            was = {k: v for k, v in m.items() if k not in ("sources", "rerun") and not (k == "fresh" and passed)}
            return {**was, **{k: v for k, v in res.items() if k != "n"}, "shown": str(res.get("shown") or m["words"]),
                    **rests.get(m["n"], {})}

        def change(r: dict[str, Any]) -> dict[str, Any]:
            def judged(m: dict[str, Any]) -> dict[str, Any]:
                if m["n"] not in mine or m["status"] != "checking":
                    return m
                return judged_one(m)

            r["items"] = [judged(m) for m in r["items"]]
            return r

        reply = await _edit(c, turn, change, tell=not request)
        if request and reply and not thread:  # main never read a side thread's answer
            told = await asyncio.to_thread(notices, {"kind": "repair", "items": [m for m in reply["items"]
                                                                                  if m["n"] in mine], "auto": auto})
            if told["text"]:
                _tell(c, _framed(told))

        await _takeaways_change(c, takes, judged_one)
        if not request:
            found = [m for m in share if _found_failed(by_n.get(m["n"]))]
    except Exception as e:  # noqa: BLE001 — a check that cannot be validated leaves its marks unchecked, and says so
        log.exception("%s: the check of the marks failed", c)
        _notice(c, f"thimble could not check the citations ({type(e).__name__}: {_error_words(e, folders)[:80]}), so "
                   "some are not checked.")
    finally:
        await give_up("the check ended before it judged this citation")
    # after give_up, which would leave unchecked a mark whose repair already runs
    for m in found:
        if m.get("card") and not _takeaway_now(c, m):
            continue  # the card's takeaway was written again meanwhile: its own check judges the new words
        why = await repair(c, turn=None if m.get("card") else turn, n=None if m.get("card") else m["n"],
                           card=m.get("card"), k=m.get("k"), fork=fork, auto=True)
        # a mark that is not failed now has nothing to repair: a takeaway written again meanwhile is under its own check
        if why and why != NOT_FAILED:
            _notice(c, f"The repair of a failed citation did not start ({why[:100]}). Press Repair on it to try again.")


STOPPED_TEXT = "The check of the citations stopped ({why}), so some are not checked. The next reply is checked again."


def _stopped(c: str, error: str) -> None:
    """The notice of a check whose fork stopped with `error`: its words in short, at a sentence's end (notices.gist),
    and whole in the notice's details, which Show more opens."""
    from . import notices  # noqa: PLC0415

    why = error.strip().rstrip(".") or "no reason was given"
    short = notices.gist(why, notices.REASON_CHARS).rstrip(".")
    _notice(c, STOPPED_TEXT.format(why=short), STOPPED_TEXT.format(why=why) if short != why else None)


def _error_words(error: Any, folders: tuple[str, str]) -> str:
    """An error's text as a mark's reason or a notice quotes it: each path of this machine in it named as the validator
    names a cited file, from the check's folders (`folders`, check_folders) when it lies there, else by its name alone
    (the validator's error_words). The error is thimble's or Claude Code's own, never the records' nor the check's."""
    cwd, root = folders
    return evidence().error_words(str(error), cwd, root)


def _takeaway_now(c: str, m: dict[str, Any]) -> bool:
    """Whether the card of takeaway mark `m` still has the takeaway this check read."""
    from . import notebook  # noqa: PLC0415

    try:
        return str((notebook.get_cell(c, m["card"]) or {}).get("takeaway") or "") == m["takeaway"]
    except Exception:  # noqa: BLE001 — a card that cannot be read has no takeaway to repair
        return False


def _found_failed(res: dict[str, Any] | None) -> bool:
    """Whether a check's result failed its mark by a finding: wrong, or not confirmed. A mark it gave no answer for is
    unchecked, and Repair checks it: what stopped this check would stop another."""
    return bool(res) and res.get("status") == "failed" and res.get("failedBy") in ("check", "evidence")


def _temp_dir(c: str) -> Path:
    return config.temp_dir(c)


def _temp_dirs(c: str) -> list[str]:
    """The temp folders Claude's own code may lie in, the validator's `tmp`: the workspace's, and the TMPDIR of main's
    shell commands (runtime.shell_temp), which is the temp folder Claude Code's sandbox gives them on Claude Code
    sign-in."""
    from . import runtime  # noqa: PLC0415

    return [str(p) for p in dict.fromkeys((_temp_dir(c), runtime.shell_temp(c)))]


def _rules_dir(c: str) -> Path:
    """The workspace's labels' definitions (concepts.concepts_dir), each of which holds its label's rule, as the
    terminal keeps a `--code` rule in its temp folder: the validator's `rules`. Beside the workspace's temp folder, it
    is the one folder of the workspace a citation may name: the workspace's answers, marks and chats are no evidence."""
    from . import concepts  # noqa: PLC0415 — concepts imports much of the app

    return concepts.concepts_dir(config.workspace_dir(c))


def cited_outputs(answer: str) -> list[str]:
    """The outputs the checker's answer cites as evidence (`"output": "…"`): a call of main's whose output holds none of
    them cannot be a mark's evidence, so the validator is not sent it (the terminal's checker.ts citedOutputs)."""
    out = []
    for m in re.finditer(r'"output"\s*:\s*("(?:[^"\\]|\\.)*")', answer):
        try:
            out.append(str(json.loads(m.group(1))))
        except ValueError:
            continue
    return out


def _result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return "".join(x.get("text", "") for x in content or [] if isinstance(x, dict))


def bash_calls(messages: list[dict[str, Any]], by: str) -> list[dict[str, Any]]:
    """The Bash calls of a conversation with their output as Claude read it, as the validator reads a call: {command,
    output, by}. A call that ended with an error counts too, since what it printed before the error is real output."""
    command: dict[str, str] = {}
    out = []
    for m in messages:
        content = (m.get("message") or {}).get("content") if isinstance(m.get("message"), dict) else m.get("content")
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and b.get("name") == "Bash":
                command[str(b.get("id"))] = str((b.get("input") or {}).get("command") or "")
            elif b.get("type") == "tool_result" and str(b.get("tool_use_id")) in command:
                out.append({"command": command[str(b["tool_use_id"])], "output": _result_text(b.get("content")),
                            "by": by})
    return out


def _fork_transcript(c: str, thread: dict[str, Any]) -> str | None:
    """The transcript of a side thread's fork that a reply's record keeps (answer_ended): a subagent's file,
    agent-<id>.jsonl in the folder of a session whose transcript is where the mirror finds one (session.own_transcript),
    or in its subagents/; None for any other path, since a card's code writes the record."""
    from . import session  # noqa: PLC0415

    path = thread.get("calls")
    if not isinstance(path, str) or not os.path.isabs(path):
        return None
    p = Path(os.path.normpath(path))
    folder = p.parent.parent if p.parent.name == "subagents" else p.parent
    sid = folder.name
    return path if session.AGENT_FILE_RE.match(p.name) and session.own_transcript(
        c, sid, str(folder.with_name(f"{sid}.jsonl"))) else None


def _transcript_messages(path: Any) -> list[dict[str, Any]]:
    """Main's transcript records, each a dict (a line that does not parse is skipped)."""
    out: list[dict[str, Any]] = []
    if not path:
        return out
    try:  # a transcript in the workspace (the server's own runtime's) lies where a card's code writes (nofollow)
        with nofollow.reader(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                with contextlib.suppress(ValueError):
                    rec = json.loads(line)
                    if isinstance(rec, dict):
                        out.append(rec)
    except OSError:
        pass
    return out


# ---- repair: a failed mark checked again (the terminal's x, marks/checker.ts repairOf, launchRepair; the request and
# what main hears after it, plugin/marks/notices.mjs repairRequest and repairTellText)

def repair_request(m: dict[str, Any], n: int, auto: bool = False, also: list[dict[str, Any]] | None = None,
                   ran: list[str] | None = None) -> str:
    """What follows the checker's text for a repair of mark `m`, numbered `n` in it (the terminal's repairRequest): who
    asked, the analyst with Repair or thimble (`auto`, as the check failed it), what the first check found (its reason
    quoted, since it may quote the records), and the task. A mark whose check did not run (unchecked, or failed by
    none) is checked as any reply's is; a stale one with the other stale marks of its sentence (`also`), and the cards
    that ran again before its check (`ran`, each `card:<id>`), whose cells hold the values as the files are now."""
    return notices({"kind": "request", "mark": m, "n": n, "auto": auto, "also": also or [], "ran": ran or []})["text"]


def repair_tell_text(items: list[dict[str, Any]], auto: bool = False) -> str:
    """What main reads when a repair ended: how its mark ended, as the analyst reads it, and who started it: the analyst
    with Repair, or thimble (`auto`, as the check failed it) (the terminal's repairTellText)."""
    return notices({"kind": "repair", "items": items, "auto": auto})["text"]


REPAIRABLE = ("failed", "unchecked")
# repair's answer for a mark that is not failed or stale now: checked as it stands, or under a check again
NOT_FAILED = "this citation is not one that failed"
# what a repair clears of a mark: its earlier result goes, its place and words stay
CLEARED = ("status", "was", "reason", "failedBy", "evidence", "note", "narrowed", "rewrite", "shown", "sources", "rerun")


def stale_sources(m: dict[str, Any]) -> list[dict[str, Any]]:
    """The sources of a mark that changed after its check (the terminal's plugin/tray/tray.mjs staleOf): none unless
    the check verified or corrected it."""
    if m.get("status") not in ("verified", "corrected") or not isinstance(m.get("sources"), list):
        return []
    return [s for s in m["sources"] if isinstance(s, dict) and (s.get("changed") or s.get("gone"))]


def _main_now(c: str) -> tuple[dict[str, Any], str] | str:
    """What a fork of main needs, at main's last finished turn: (main, cut), or why there is none (card_written's)."""
    from . import session  # noqa: PLC0415

    lv = session.current(c)
    if lv is None:
        return "main has no finished turn to check from yet"
    return ({"sid": lv.sid, "cwd": lv.cwd, "config": lv.config, "config_known": lv.config_known,
             "transcript_path": lv.transcript_path, "model": lv.model, "effort": lv.effort,
             "context_tokens": lv.context_tokens}, lv.last_cut or "")


async def repair(c: str, turn: str | None = None, n: int | None = None, card: str | None = None, k: int | None = None,
                 fork: Callable[..., Awaitable[dict[str, Any]]] | None = None, auto: bool = False) -> str:
    """Repair a failed or stale mark: a reply's (`turn`, `n`) or a card's takeaway's (`card`, its order `k`). It is
    `checking` again while a fork of main checks it with the terminal's repair request, and the validator decides its
    end as for any check; a stale mark's check takes the other stale marks of its sentence (of its takeaway, for a
    takeaway's) with it, and first runs again each card whose value one of them rests on, and a takeaway's own card, so
    the check reads the card as the files make it now; its request names each card that ran. '' when it started, else
    why not. The check runs in the background. `auto`: the check that failed it started it, not the analyst (main hears
    so)."""
    from . import notebook  # noqa: PLC0415

    got = _main_now(c)
    if isinstance(got, str):
        return got
    main, cut = got
    shares: list[dict[str, Any]] = []
    again = False  # a stale mark, or one whose check since it went stale did not pass: checked against the files now

    def cleared(x: dict[str, Any]) -> dict[str, Any]:
        """A mark as its check again starts: its earlier result gone; a stale mark keeps the files that changed, so each
        check of it reads them fresh until one passes."""
        base = {key: v for key, v in x.items() if key not in CLEARED}
        if stale_sources(x):
            base["fresh"] = list(dict.fromkeys(str(src.get("file")) for src in stale_sources(x)))
        return base

    if card:
        cell = notebook.get_cell(c, card)
        text = str((cell or {}).get("takeaway") or "")
        items = _takeaway_marks(cell)
        m = next((x for x in items if x.get("k") == k), None)
        stale = stale_sources(m) if m else []
        if not m or (m.get("status") not in REPAIRABLE and not stale):
            return NOT_FAILED
        again = bool(stale or m.get("fresh"))
        # a stale mark's check takes each other such mark of the takeaway with it, after one run of the card
        group = sorted([m, *(x for x in items if again and x.get("k") != k and x.get("status") != "checking"
                             and (stale_sources(x) or x.get("fresh")))], key=lambda x: int(x["k"]))
        bases = {x["k"]: cleared(x) for x in group}
        numbered = {kk: i for i, kk in enumerate(bases, 1)}
        also = [{**x, "n": numbered[x["k"]]} for x in group if x["k"] != k]
        asked = (m, numbered[k], auto, also)
        request = await asyncio.to_thread(repair_request, *asked)
        shares = [{**base, "n": numbered[kk], "status": "checking", "shown": base["words"], "card": card,
                   "title": str(cell.get("title") or ""), "takeaway": text} for kk, base in bases.items()]

        def change(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return [{**bases[it["k"]], "status": "checking", "shown": it["words"], "repair": True} if it.get("k") in bases else it
                    for it in items]

        _set_takeaway(c, card, text, change)
        turn = new_turn()
    else:
        reply = stored(c, turn or "")
        items = (reply or {}).get("items") or []
        m = next((x for x in items if x.get("n") == n), None)
        stale = stale_sources(m) if m else []
        if not m or (m.get("status") not in REPAIRABLE and not stale):
            return NOT_FAILED
        again = bool(stale or m.get("fresh"))
        # a stale mark's check takes each other such mark of its sentence with it: the check rewrites a sentence whole,
        # and a rewrite that changed another citation's words would not stand alone (the terminal's repairOf)
        also = [x for x in items if again and x.get("n") != n and x.get("piece") == m.get("piece")
                and x.get("sentence") == m.get("sentence") and x.get("status") != "checking"
                and (stale_sources(x) or x.get("fresh"))]
        asked = (m, int(m["n"]), auto, also)
        request = await asyncio.to_thread(repair_request, *asked)
        group = sorted([m, *also], key=lambda x: int(x["n"]))
        bases = {x["n"]: cleared(x) for x in group}
        shares = [{**base, "status": "checking", "shown": base["words"]} for base in bases.values()]

        def change_reply(r: dict[str, Any]) -> dict[str, Any]:
            r["items"] = [{**bases[x["n"]], "status": "checking", "shown": x["words"], "repair": True}
                          if x["n"] in bases else x for x in r["items"]]
            return r

        await _edit(c, str(turn), change_reply, tell=False)
    # the cards whose values the stale marks rest on, and a stale takeaway's own card, which run again before the check
    # reads them
    runs = sorted({str(x["rerun"]["card"]) for x in group if again and isinstance(x.get("rerun"), dict) and x["rerun"].get("card")}
                  | ({card} if card and again else set()))

    # the time its words were written, which the first check kept: a label is read as it was then, never as a later
    # change made it (a mark checked before thimble kept the time is read as its labels are now)
    key = _time_key(card=card, text=str(shares[0].get("takeaway") or "")) if card else _time_key(turn=turn)

    async def run() -> None:
        ran = []
        for cid in runs:
            if await _run_card(c, cid):
                ran.append(f"card:{cid}")
        told = request
        if ran:
            # the check is told which cards ran again, whose cells it may then cite as the values now
            try:
                told = await asyncio.to_thread(repair_request, *asked, ran)
            except Exception:  # noqa: BLE001 — the check runs with the request that names no card
                log.exception("%s: the repair's request was not written again with the cards that ran", c)
        at = await asyncio.to_thread(_time_of, c, key)
        cards, index = await _cards_and_index(c, at)
        try:
            await _check_share(c, main, str(turn), cut, shares, check_folders(c, main), fork or run_fork, cards, index,
                               told, auto, at, again)
        finally:
            _drop_index(index)

    _spawn(run())
    return ""


async def _run_card(c: str, cid: str) -> bool:
    """Card `cid` run again, as a run the analyst asks for runs it (notebook._run_cell): its outputs as its files make
    them now. Whether it ran well. A card that is gone, or runs no code, runs nothing; a run that fails shows on the
    card, as any does."""
    from . import notebook  # noqa: PLC0415

    hit = notebook.find_cell(config.workspace_dir(c), cid)
    if hit is None or not notebook.runnable(hit[1]):
        return False
    try:
        return (await notebook._run_cell(c, hit[0], cid)).get("status") == "ok"
    except Exception:  # noqa: BLE001 — the check reads the card as it stands
        log.exception("%s: card %s did not run again for the repair of its takeaway", c, cid)
        return False


# ---- 6: a citation whose source changed after its check (the terminal's plugin/marks/stale.ts)

# the workspaces whose comparison runs now, each with whether another was asked for meanwhile
_refreshing: dict[str, bool] = {}


def _confirmed(m: dict[str, Any]) -> bool:
    """Whether a mark rests on what its check read: verified or corrected, with sources."""
    return m.get("status") in ("verified", "corrected") and isinstance(m.get("sources"), list) and bool(m["sources"])


def _seen_of(path: str) -> dict[str, Any]:
    """A cited file as the server sees it now: its size and mtime (in milliseconds, as the validator keeps them), or
    gone when it is not there or is no regular file."""
    try:
        st = os.stat(path)
    except (OSError, ValueError):
        return {"gone": True}
    return {"size": st.st_size, "mtime": st.st_mtime_ns / 1e6} if stat.S_ISREG(st.st_mode) else {"gone": True}


def _same_seen(a: Any, b: Any) -> bool:
    """Whether two sights of a file are the same: both gone, or the same size and mtime to the millisecond. None is no
    sight (a file the index made due): it matches nothing."""
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    if a.get("gone") or b.get("gone"):
        return bool(a.get("gone") and b.get("gone"))
    try:
        return a.get("size") == b.get("size") and abs(float(a["mtime"]) - float(b["mtime"])) < 1
    except (KeyError, TypeError, ValueError):
        return False


def _cited_path(c: str) -> Path:
    return config.workspace_dir(c) / "marks" / "cited.json"


# the key in the index of cited files of the marks of a card's takeaway: this, then the card's id (a reply's is its turn)
CARD_KEY = "card:"


def _cited_by(reply: dict[str, Any] | None, ident: str = "n") -> dict[str, dict[str, Any]]:
    """The files a reply's marks rest on (or a takeaway's, {items}): by real path, the marks that rest on each by
    `ident` (`ns`: their numbers, or for a takeaway's their order `k`) and the stat their checks read it at (`read`, None
    when they read it at different times)."""
    out: dict[str, dict[str, Any]] = {}
    for m in (reply or {}).get("items") or []:
        for src in m.get("sources") or [] if isinstance(m, dict) else []:
            if not isinstance(src, dict) or not src.get("path"):
                continue
            read = {"size": src.get("size"), "mtime": src.get("mtime")}
            x = out.setdefault(str(src["path"]), {"ns": [], "read": read})
            if m.get(ident) not in x["ns"]:
                x["ns"].append(m.get(ident))
            if not _same_seen(x["read"], read):
                x["read"] = None
    return out


def _takeaway_marks(cell: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The marks of a card's takeaway as its check left them, while the takeaway reads as they were checked in."""
    kept = (cell or {}).get("takeaway_marks") if isinstance((cell or {}).get("takeaway_marks"), dict) else {}
    return list(kept.get("items") or []) if kept.get("text") == str((cell or {}).get("takeaway") or "") else []


def _cited(c: str) -> dict[str, Any]:
    """The workspace's index of cited files, {files: {path: {seen, by: {key: [n, ...]}}}}: what the last pass saw of
    each file (_seen_of; None when due), and the marks that rest on it, by their reply's turn (a takeaway's by its card,
    CARD_KEY). A workspace with no index yet gets one from its replies and its cards, once."""
    from . import notebook  # noqa: PLC0415

    path = _cited_path(c)
    got = ledger.read_json(path, None)
    if isinstance(got, dict) and isinstance(got.get("files"), dict):
        return got
    files: dict[str, Any] = {}
    held = [(p.stem, _cited_by(stored(c, p.stem))) for p in sorted(path.parent.glob("*.json"))]
    held += [(f"{CARD_KEY}{cell['id']}", _cited_by({"items": _takeaway_marks(cell)}, "k"))
             for _, nb in notebook._stored(config.workspace_dir(c)) for cell in nb.get("cells") or [] if cell.get("id")]
    for key, by in held:
        for f, x in by.items():
            had = files.get(f)
            seen = None if had and not _same_seen(had["seen"], x["read"]) else x["read"]
            files[f] = {"seen": seen, "by": {**(had or {}).get("by", {}), key: x["ns"]}}
    index = {"files": files}
    nofollow.makedirs(path.parent)
    ledger.write_json(path, index)
    return index


def _note_cited(c: str, reply: dict[str, Any], key: str | None = None, ident: str = "n") -> None:
    """The index after reply `reply` was saved (or a takeaway's marks, {items}, under its `key`, each by `ident`): its
    marks put on the files they rest on now and taken off those they no longer rest on, a file new to the index as their
    checks read it, a file no mark rests on any more left out. Written only when it changes."""
    turn, mine = key or reply["turn"], _cited_by(reply, ident)
    path = _cited_path(c)
    with ledger.locked(path):
        index = _cited(c)
        files = index["files"]
        changed = False
        for p in set(files) | set(mine):
            f = files.get(p)
            by = dict((f or {}).get("by") or {})
            ns = mine[p]["ns"] if p in mine else []
            if sorted(by.get(turn, [])) == sorted(ns):
                continue
            changed = True
            by.pop(turn, None)
            if ns:
                by[turn] = ns
            if by:
                files[p] = {"seen": f["seen"] if f else mine[p]["read"], "by": by}
            else:
                files.pop(p, None)
        if changed:
            ledger.write_json(path, index)


def _saw(c: str, seen: dict[str, dict[str, Any]]) -> None:
    """What a pass saw of the files it compared, kept for the next pass."""
    path = _cited_path(c)
    with ledger.locked(path):
        index = _cited(c)
        for p, s in seen.items():
            if p in index["files"]:
                index["files"][p]["seen"] = s
        ledger.write_json(path, index)


def _same_source(a: Any, b: dict[str, Any]) -> bool:
    return isinstance(a, dict) and all(a.get(k) == b.get(k) for k in ("path", "sha256", "line"))


def _read_sources(c: str, reads: Any) -> list[dict[str, Any]]:
    """The files a card's code read (the kernel's reads record, notebook.reads_bundle: paths from the card's working
    folder, where the corpus's entries are linked, or from the corpus folder), each as the validator keeps a source,
    read whole; a folder the code listed is none."""
    from . import notebook  # noqa: PLC0415

    try:
        roots = [config.workspace_dir(c) / notebook.SCRATCH_DIR, config.corpus_dir(c)]
    except ValueError:
        roots = [config.workspace_dir(c) / notebook.SCRATCH_DIR]
    out: dict[str, dict[str, Any]] = {}
    for rel in reads if isinstance(reads, list) else []:
        at = next((r / rel for r in roots if isinstance(rel, str) and rel not in ("", ".") and (r / rel).is_file()), None)
        got = evidence().source(str(at), rel) if at else None
        if got and got["path"] not in out:
            out[got["path"]] = got
    return list(out.values())


def _card_rests(c: str, cards: list[dict[str, Any]], res: dict[str, Any]) -> dict[str, Any]:
    """What a check's card evidence rests on (`res`, the validator's result): the files the cited card's code read when it
    last ran (_read_sources), and what compares the card's values again (`rerun`: the card and what each cited place
    showed to the check, evidence.card_values); {} for other evidence, a result that did not pass, a label's card, which
    keeps its versions, and a card whose code read no file."""
    from . import notebook  # noqa: PLC0415

    ev = res.get("evidence")
    if res.get("status") not in ("verified", "corrected") or not isinstance(ev, dict) or ev.get("kind") != "card":
        return {}
    cid = str(ev.get("card") or "")
    if not cid or cid.startswith(LABEL_PLACE):
        return {}
    refs = [r for r in evidence().shown_refs(ev) if r == f"card:{cid}" or r.startswith((f"card:{cid}#", f"card:{cid}@"))]
    cell = notebook.get_cell(c, cid)
    sources = _read_sources(c, cell.get("reads")) if cell and notebook.runnable(cell) else []
    if not refs or not sources:
        return {}
    return {"sources": sources, "rerun": {"card": cid, "values": evidence().card_values(refs, cards)}}


async def _card_now(c: str, cid: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]] | None:
    """Card `cid`'s code run again on its kernel, with no model and not kept (notebook.trial_run, whose names are put
    back after): (the files that run read, as sources; the card as the validator reads its places, evidence.card_values),
    or None when the card is gone, runs no code, or did not run well."""
    from . import cite, notebook  # noqa: PLC0415

    cell = notebook.get_cell(c, cid)
    if not cell or not notebook.runnable(cell):
        return None
    try:
        trial = await notebook.trial_run(c, cid, str(cell.get("code") or ""))
    except (KeyError, ValueError):
        return None
    try:
        if trial.get("status") != "ok":
            return None
        outs = _outputs(list(cite.iter_outputs(notebook.hydrate_outputs(config.workspace_dir(c), trial["outputs"]))))
        sources = await asyncio.to_thread(_read_sources, c, trial.get("reads"))
        return sources, [{"id": cid, "title": str(cell.get("title") or ""), "outputs": outs}]
    finally:
        await notebook.trial_settle(c, cid, str(trial.get("trial") or ""), keep=False)


def _held(c: str, key: str) -> list[tuple[int, dict[str, Any]]]:
    """The marks the index lists under `key`, each by its id there: a reply's by its number, a takeaway's by its order."""
    from . import notebook  # noqa: PLC0415

    if key.startswith(CARD_KEY):
        return [(m["k"], m) for m in _takeaway_marks(notebook.get_cell(c, key[len(CARD_KEY):])) if isinstance(m.get("k"), int)]
    return [(m["n"], m) for m in (stored(c, key) or {}).get("items") or []]


def _changing(c: str, key: str, edit: Callable[[list[dict[str, Any]]], list[dict[str, Any]]]) -> Awaitable[Any]:
    """`edit` of the marks the index lists under `key`: a reply's (_edit, which tells main nothing of it), or a card's
    takeaway's as it reads now (_set_takeaway)."""
    from . import notebook  # noqa: PLC0415

    if key.startswith(CARD_KEY):
        cid = key[len(CARD_KEY):]
        text = str((notebook.get_cell(c, cid) or {}).get("takeaway") or "")
        return asyncio.to_thread(_set_takeaway, c, cid, text, edit)
    return _edit(c, key, lambda r: {**r, "items": edit(r["items"])}, tell=False)


async def refresh_sources(c: str) -> None:
    """One pass over the workspace's cited files (_cited): a stat of each, and only for the files whose stat changed
    since the last pass, the marks that rest on them, from the replies and the takeaways that hold them, to
    evidence.examine, which reads each file once for all of them and runs computed evidence's code again where a file of
    it changed, once for each code. A mark that rests on a card's value has the card's code run again, once for each
    card, and is stale only when a place it cites shows another value (_card_now). A reply or a takeaway whose marks
    changed is written again, so the page draws them stale, no longer stale, or at the lines they moved to."""
    files = (await asyncio.to_thread(_cited, c))["files"]
    now = await asyncio.to_thread(lambda: {p: _seen_of(p) for p in files})
    due = {p: s for p, s in now.items() if not _same_seen(s, files[p].get("seen"))}
    if not due:
        return
    # the marks that rest on those files, each with its sources there: (key, its id there, places in its sources, sent,
    # evidence, what runs its code again while it is not stale)
    asked: list[tuple[str, int, list[int], list[dict[str, Any]], Any, Any]] = []
    for key in sorted({t for p in due for t in files[p].get("by") or {}}):
        for ident, m in await asyncio.to_thread(_held, c, key):
            ks = [k for k, src in enumerate(m["sources"]) if isinstance(src, dict) and src.get("path") in due] if _confirmed(m) else []
            if ks:
                again = m.get("rerun") if isinstance(m.get("rerun"), dict) and not stale_sources(m) else None
                asked.append((key, ident, ks, [m["sources"][k] for k in ks], m.get("evidence"), again))
    if asked:
        ev = evidence()
        items = [{"sources": sent, **({"evidence": e} if e else {}), **({"rerun": r} if r else {})} for *_, sent, e, r in asked]
        got = await asyncio.to_thread(ev.examine, items, runner(c, check_folders(c, {})))
        # a card's value whose files changed: the card's code runs again, once for each card
        moved = {a[5]["card"] for a, x in zip(asked, got) if a[5] and a[5].get("card")
                 and any(s.get("changed") or s.get("gone") for s in x["sources"])}
        cards = {cid: await _card_now(c, cid) for cid in sorted(moved)}
        for i, a in enumerate(asked):
            card = cards.get((a[5] or {}).get("card")) if a[5] else None
            values = (a[5] or {}).get("values") or {}
            if card and values and ev.card_values(list(values), card[1]) == values:
                clear = [{k: v for k, v in s.items() if k not in ("changed", "gone")} for s in got[i]["sources"]]
                got[i] = {**got[i], "sources": clear, "rests": card[0]}
        changed = [(a, x) for a, x in zip(asked, got) if "evidence" in x or "rests" in x or x["sources"] != a[3]]
        for key in sorted({a[0] for a, _ in changed}):
            mine = [(a, x) for a, x in changed if a[0] == key]
            ident = "k" if key.startswith(CARD_KEY) else "n"

            def edit(items: list[dict[str, Any]], mine: list[tuple[Any, dict[str, Any]]] = mine, ident: str = ident) -> list[dict[str, Any]]:
                # a mark checked again meanwhile keeps the sources of its new check
                for m in items:
                    for (_, n, ks, sent, _, _), x in mine:
                        if m.get(ident) == n and _confirmed(m) and all(k < len(m["sources"]) and _same_source(m["sources"][k], s)
                                                                       for k, s in zip(ks, sent)):
                            if "rests" in x:
                                # its value is as its check read it: it rests on what that run read
                                m["sources"] = x["rests"]
                                continue
                            for k, s in zip(ks, x["sources"]):
                                m["sources"][k] = s
                            if "evidence" in x:
                                m["evidence"] = x["evidence"]
                return items

            await _changing(c, key, edit)
    await asyncio.to_thread(_saw, c, due)


def refresh_soon(c: str) -> None:
    """refresh_sources in the background, as the page reads a chat; one asked for while one runs runs once after it.
    Never raises."""
    if c in _refreshing:
        _refreshing[c] = True
        return
    _refreshing[c] = False

    async def run() -> None:
        try:
            while True:
                _refreshing[c] = False
                await refresh_sources(c)
                if not _refreshing.get(c):
                    break
        except Exception:  # noqa: BLE001 — a mark not compared now is compared at the next read
            log.exception("%s: the cited files were not compared with what their checks read", c)
        finally:
            _refreshing.pop(c, None)

    _spawn(run())


class RepairBody(BaseModel):
    turn: str | None = None
    n: int | None = None
    card: str | None = None
    k: int | None = None


@router.post("/ws/{c}/marks/repair")
async def repair_route(c: str, body: RepairBody) -> dict[str, Any]:
    """Repair in a failed mark's label: check it again and make it correct (repair)."""
    if not ((body.turn and body.n is not None) or (body.card and body.k is not None)):
        raise HTTPException(422, "name a reply's mark (turn, n) or a takeaway's (card, k)")
    why = await repair(c, body.turn, body.n, body.card, body.k)
    if why:
        raise HTTPException(409, why)
    return {"ok": True}


# ---- the fork: Claude Code

def _model(c: str, main: dict[str, Any], prompt: str) -> tuple[str, str]:
    """(model, effort): main's own, so the fork reads main's cached conversation, else the `checks` row's; the model
    with Claude Code's 1M-token window when main's context and the prompt would not fit the plain one."""
    conf = config.call_settings(c, "checks")
    m = str(main.get("model") or conf["model"])
    if int(main.get("context_tokens") or 0) + len(prompt) // 4 > config.CONTEXT_TOKENS - 20_000:
        m = config.long_context(m)
    return m, str(main.get("effort") or conf["effort"])


# The one Python script the check runs its code as (plugin/prompts/checker.md): `python3 - <<'PY'`, the code, `PY`,
# after a `cd` at most, and nothing else in the call, as the terminal's check runs it (plugin/marks/checker.ts oneScript,
# runsPython)
ONE_SCRIPT = re.compile(r"(?:cd\s+\S+\s*(?:&&|;)\s*)?python3?\s+(?:-\S+\s+)*-\s*<<-?[ \t]*(['\"]?)(\w+)\1[ \t]*")


def one_script(command: str) -> bool:
    """Whether a Bash command only runs one Python script from a here-document, by python3 or python, after a `cd` at
    most (with `&&`, `;` or a line of its own): the terminal's oneScript and runsPython (plugin/marks/checker.ts)."""
    lines = re.sub(r"^\s*(cd\s+\S+)[ \t]*\n", r"\1; ", str(command).rstrip()).split("\n")
    m = ONE_SCRIPT.fullmatch(lines[0])
    if not m or len(lines) < 3:
        return False
    return lines[-1].strip() == m.group(2) and not any(line.strip() == m.group(2) for line in lines[1:-1])


async def _one_script_runs(inp: Any, _tool_use_id: str | None, _ctx: Any) -> dict[str, Any]:
    """The fork's PreToolUse hook: its Bash call of one Python script (one_script) runs, as the terminal lets its
    check's run (plugin/marks/checker.ts allowsPython). Claude Code's rule for python3 does not match a script it cannot
    read as a shell's words, such as a heredoc whose code holds `{'major': 0}`, which dontAsk mode would refuse, and a
    check that may not run its code cannot compute. Any other call is left to Claude Code's rules."""
    call = inp if isinstance(inp, dict) else {}
    if call.get("tool_name") == "Bash" and one_script(str((call.get("tool_input") or {}).get("command") or "")):
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
                                       "permissionDecisionReason": "the check's one Python script"}}
    return {}


def fork_options(main: dict[str, Any], cut: str | None, model_id: str, effort: str, cwd: Path, env: dict[str, str],
                 sandbox: bool = False, stderr: Callable[[str], None] | None = None) -> Any:
    """The fork's Agent SDK options, the flags of a fork of main as Claude Code takes them (`--resume` main at `cut`,
    `--fork-session`, no transcript kept, main's user settings with none of their customizations), its tools, its
    rules (ALLOWED, in dontAsk mode) and the hook that lets its one Python script run (_one_script_runs). With
    `sandbox` its commands run only in Claude Code's sandbox (cc_settings.offline_sandbox, required), with no network
    and none of the ANTHROPIC_* variables Claude Code signs in with. `env` is the fork's whole environment: each
    variable of this process's that it leaves out is "" (the SDK starts `claude` with this process's environment under
    the options' own)."""
    from claude_agent_sdk import ClaudeAgentOptions, HookMatcher  # noqa: PLC0415

    from . import cc_settings  # noqa: PLC0415

    sent = effort if config.has_effort(model_id) else None
    settings = {**json.loads(sdk.cli_settings(model_id, sent, None)), "advisorModel": "off"}
    if sandbox:
        settings["sandbox"] = cc_settings.offline_sandbox(required=True)
    return ClaudeAgentOptions(
        cwd=str(cwd), tools=list(CHECKER_TOOLS), allowed_tools=list(ALLOWED), permission_mode="dontAsk",
        model=model_id, effort=sent, settings=json.dumps(settings), cli_path=str(config.CLI_PATH or config.CLAUDE_BIN),
        setting_sources=["user"], strict_mcp_config=True, max_buffer_size=sdk.MAX_BUFFER_SIZE,
        env={**{k: "" for k in os.environ if k not in env}, **env}, stderr=stderr,
        resume=str(main["sid"]), fork_session=True, resume_session_at=cut or None,
        extra_args={"no-session-persistence": None, "disable-slash-commands": None, "safe-mode": None},
        hooks={"PreToolUse": [HookMatcher(matcher="Bash", hooks=[_one_script_runs])]},
    )


def _env(main: dict[str, Any]) -> dict[str, str]:
    """The fork's environment, as the view proposer's (proposer._env): main's own config dir when its shim reported it."""
    env = config.launch_environ()
    if main.get("config_known"):
        if main.get("config"):
            env[config.CONFIG_DIR_ENV] = str(main["config"])
        else:
            env.pop(config.CONFIG_DIR_ENV, None)
    env.update(dict.fromkeys(sdk.SCRUBBED_ENV, ""))
    env["SHLVL"] = "1"
    return env


def parse_stream(stdout: str) -> dict[str, Any]:
    """A fork's stream-json output: {answer, calls, error}. The answer is its texts in order; `error` names a result
    that was not a success."""
    messages: list[dict[str, Any]] = []
    texts: list[str] = []
    error = None
    for line in stdout.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        if rec.get("type") in ("assistant", "user"):
            messages.append(rec)
            if rec["type"] == "assistant":
                for b in (rec.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "text":
                        texts.append(str(b.get("text") or ""))
        elif rec.get("type") == "result" and (rec.get("is_error") or rec.get("subtype") not in (None, "success")):
            error = _clip(str(rec.get("result") or rec.get("subtype") or "error"))
    return {"answer": "\n".join(texts), "calls": bash_calls(messages, "checker"), "error": error}


def allowed_call(name: str, args: dict[str, Any]) -> bool:
    """What a fork of the Messages API runtime may run, as ALLOWED lets Claude Code's: Read, Grep, Glob, and Bash only
    for a python command."""
    if name in ("Read", "Grep", "Glob"):
        return True
    cmd = str(args.get("command") or "").lstrip()
    return name == "Bash" and re.match(r"python3?(\s|$)", cmd) is not None


async def run_fork(c: str, main: dict[str, Any], cut: str | None, prompt: str) -> dict[str, Any]:
    """One fork of main at `cut` with the checker's prompt: {answer, calls, error}, on the way to reach Claude the
    person chose (runtime.py): the Messages API in this process for an API key or WIF (no `claude` process), their
    Claude Code session's fork for a Claude Code sign-in."""
    from . import cc_settings, runtime, runtime_api, runtime_cc  # noqa: PLC0415

    model_id, effort = _model(c, main, prompt)
    kind = runtime.engine()
    if kind == "api":
        try:
            out = await asyncio.wait_for(runtime_api.fork_stream(c, prompt, model=model_id, effort=effort,
                                                                 allow=allowed_call), FORK_TIMEOUT_S)
        except asyncio.TimeoutError:
            return {"error": "it took too long"}
        except Exception as e:  # noqa: BLE001 — the check says it stopped, in words
            from . import llm  # noqa: PLC0415

            return {"error": llm.failure(e)}
        return parse_stream(out)
    sid = runtime_api.cc_main_session(c) if kind == "cc" else None
    if not sid:
        return {"error": "thimble cannot reach Claude yet" if not kind else "main has no Claude Code session yet"}
    main, cut = {**main, "sid": sid, "config_known": False}, runtime_api.cc_main_cut(c)
    # the fork's python runs in Claude Code's sandbox where it can, as main's Bash does on Claude Code sign-in (in a
    # short TMPDIR of its own), so it never reads the ANTHROPIC_* variables Claude Code signs in with; the sandbox's
    # .claude/.cc-writes/ in the corpus goes when the last session there ends (runtime_cc._tidy)
    box = cc_settings.sandbox_ok()
    cwd = Path(main.get("cwd") or config.corpus_dir(c))
    tmp = runtime_cc.short_tmp() if box else None
    env = {**_env(main), **({"TMPDIR": str(tmp), "CLAUDE_CODE_TMPDIR": str(tmp)} if tmp else {})}
    if box:
        runtime_cc._enter(cwd)
    said: list[str] = []  # what Claude Code wrote to stderr, for the error of a fork that failed
    task: asyncio.Future[dict[str, Any]] | None = None
    try:
        task = asyncio.ensure_future(_sdk_fork(fork_options(main, cut, model_id, effort, cwd, env, box, said.append),
                                               prompt, said))
        _forks.add(task)
        return await asyncio.wait_for(task, FORK_TIMEOUT_S)
    except asyncio.TimeoutError:
        return {"answer": "", "error": "it took too long"}
    except Exception as e:  # noqa: BLE001 — the check says it stopped, in words
        return {"answer": "", "error": stderr_error(e, said)}
    finally:
        if task is not None:
            _forks.discard(task)
        if tmp is not None:
            nofollow.rmtree(tmp, root=tmp.parent, ignore_errors=True)  # the fork's python wrote it: no link followed
        if box:
            runtime_cc._tidy(cwd)


async def _sdk_fork(options: Any, prompt: str, said: list[str]) -> dict[str, Any]:
    """Run the fork (fork_options) on the prompt: {answer, calls, error}. The answer is its texts in order; `error`
    names a result that was not a success, or why Claude Code stopped before it answered (`said`: what it wrote to
    stderr)."""
    from claude_agent_sdk import (AssistantMessage, ResultMessage, TextBlock, ToolResultBlock,  # noqa: PLC0415
                                  ToolUseBlock, UserMessage, query)

    os.environ.setdefault(sdk.SKIP_VERSION_CHECK_ENV, "1")
    messages: list[dict[str, Any]] = []
    texts: list[str] = []
    error = None
    try:
        async for msg in query(prompt=prompt, options=options):
            if isinstance(msg, AssistantMessage):
                texts += [b.text for b in msg.content if isinstance(b, TextBlock)]
                messages.append({"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input or {}}
                    for b in msg.content if isinstance(b, ToolUseBlock)]}})
            elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
                messages.append({"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": b.tool_use_id, "content": "" if b.content is None else b.content}
                    for b in msg.content if isinstance(b, ToolResultBlock)]}})
            elif isinstance(msg, ResultMessage) and (msg.is_error or msg.subtype not in (None, "success")):
                error = _clip(str(msg.result or msg.subtype or "error"))
    except Exception as e:  # noqa: BLE001 — Claude Code stopped with an error: the answer it gave stands, else why
        if not texts:
            error = stderr_error(e, said)
    return {"answer": "\n".join(texts), "calls": bash_calls(messages, "checker"), "error": error}


def stderr_error(error: Any, stderr: list[str]) -> str:
    """A failed fork's error: the last STDERR_LINES lines Claude Code wrote to stderr, whole, else the error's own
    words."""
    lines = [ln.strip() for ln in stderr if ln.strip()]
    return _clip(" ".join(lines[-STDERR_LINES:]) or str(error).strip() or type(error).__name__)


def _clip(text: str) -> str:
    """`text` at most ERROR_CHARS long, marked with an ellipsis where it was cut."""
    return text if len(text) <= ERROR_CHARS else text[:ERROR_CHARS - 1].rstrip() + "…"


def stop_all() -> None:
    """The server stops: the forks that run end with it."""
    for task in list(_forks):
        task.cancel()
