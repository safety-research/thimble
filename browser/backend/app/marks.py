"""Checks in the chat: the claims of main's reply that the analyst would want to check, which main writes as `[words](#)`
(prompts/shared.md, Citations). They are checked after the reply, as the terminal plugin checks them
(plugin/marks/checker.ts):

1. At the end of main's turn (session._end_turn), the marks of the turn's texts (marks_of.mjs, with the terminal's
   plugin/marks/message.js) are kept, all `checking`, under the turn id that main's `done` record names; the page draws
   each with a spinner.
2. The checker: forks of main's session at the turn's end (`claude -p --resume <main> --resume-session-at <cut>
   --fork-session`, as the view proposer forks it), up to MAX_FORKS at once, each with a share of the marks, read the
   terminal's checker.md (CHECKER, with the few changes CHECKER_CHANGES lists) and give one JSON item per mark:
   verified, corrected, wrong or unconfirmed, with its evidence. A fork reads with Read, Grep and Glob, and runs code
   only as Python (Bash `python3 …`).
3. The validator, the terminal's own (plugin/engine/kernel/evidence.py), checks that evidence with no model call and no
   code run: a quote must stand in the file's line, and computed evidence names one of the conversation's real Bash
   calls (the fork's or main's) by a part of its output, and that call's real output must show the words. Its result
   is what the analyst sees.
4. When the reply's last mark settles, main reads what the check changed with its next event (a quiet `citations`
   event, events.QUIET_KINDS), in the terminal's words (tell_text).
5. Repair in a failed mark's label (repair, the terminal's x) checks that one mark again: a fork of main reads the
   checker's text with the terminal's repair request, the validator decides, and main hears how it ended.

The cards are evidence too: before the forks start, every place of the workspace's cards and its value (a table's cell,
a chart's data row, a line of printed output) is written to a file the checker greps first (session_cards, the
validator's card_index), and the validator confirms a card's place by reading it (check_card).

A card's takeaway is checked the same way: its marks, `[words](#)`, are checked as soon as the card's write lands
(card_written: after the add_card or edit_card call that wrote it, after the card check that may rewrite it, after the
analyst's edit), and any takeaway still waiting is checked with main's reply (the takeaways no check has started on,
notebook.takeaways_to_check); their line names the card, so the check looks in its output first. A takeaway a check
has claimed (_claimed) is never checked twice. What the check found is kept on the card (`takeaway_marks`,
notebook.set_takeaway_marks), and the page draws the takeaway's marks as it draws the chat's.

Every way a check ends (an answer, an error, a timeout) leaves none of its marks `checking`. A reply's marks are kept in
`<workspace>/marks/<turn>.json`, and each change is written to main's log as a `marks` record {turn, items}, which the
page reads (the newest record of a turn wins).

The fork (run_fork) is the one place that knows main runs in Claude Code; another runtime gives its own.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import logging
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import agents, config, ledger, sdk

log = logging.getLogger("thimble.marks")
router = APIRouter()

HERE = Path(__file__).resolve().parent
MARKS_OF = HERE / "marks_of.mjs"
PLUGIN = HERE.parents[2] / "plugin"  # the terminal plugin, whose checker prompt and validator this module runs
CHECKER = PLUGIN / "prompts" / "checker.md"
EVIDENCE = PLUGIN / "engine" / "kernel" / "evidence.py"
# The terminal's checker.md as the browser's fork reads it: exact strings, each of which must stand in the terminal's
# text (tests/test_marks.py), so an edit there that touches one stops the test until someone looks at it.
CHECKER_CHANGES: tuple[tuple[str, str], ...] = (
    (" Label values come from `thimble label NAME --csv`.", ""),
    ("its `--code` file or `--regex` command.", "the code or regex its apply_label call gave."),
)
# A reply with many marks is split between forks, each with about PER_FORK marks (at most MAX_FORKS forks), which run at
# once, so the reply settles when its slowest share does (the terminal's checker.ts).
PER_FORK = 4
MAX_FORKS = 8
FORK_TIMEOUT_S = 900
CHECKER_TOOLS = ("Read", "Grep", "Glob", "Bash")
ALLOWED = ("Read", "Grep", "Glob", "Bash(python3:*)", "Bash(python:*)")
TELL_KIND = "citations"

_locks: dict[tuple[str, str], asyncio.Lock] = {}
# (workspace, card, takeaway) of the takeaways a check has taken until their marks are on the card, so a check that
# starts meanwhile (main's reply ending as the card's write lands) leaves them alone
_claimed: set[tuple[str, str, str]] = set()
_procs: set[asyncio.subprocess.Process] = set()


# ---- the terminal's texts and validator

def checker_prompt(marks: str, folder: str, cards: str = "") -> str:
    text = CHECKER.read_text(encoding="utf-8")
    for old, new in CHECKER_CHANGES:
        text = text.replace(old, new)
    # REPLY: what holds the marks; the browser checks main's replies only (the terminal also a side thread's answers)
    for slot, value in (("MARKS", marks), ("CWD", folder), ("ROOT", folder), ("CARDS", cards), ("REPLY", "your last reply")):
        text = text.replace("{{" + slot + "}}", value)
    return text


def session_cards(c: str) -> list[dict[str, Any]]:
    """The workspace's cards as the validator reads them (evidence.check_card): each card that ran with outputs, its
    title, and per output the cells of its table (a frame's shown values, a chart's data rows, an html table) or the
    lines of its printed text, as the card's citations name them (cite.bundle_cells, cite.numbered_lines)."""
    from . import cite, notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    out: list[dict[str, Any]] = []
    for _, nb in notebook._stored(ws):
        for cell in nb.get("cells") or []:
            if not notebook.runnable(cell) or not cell.get("outputs") or not cell.get("id"):
                continue
            outs: list[dict[str, Any]] = []
            for i, b in cite.iter_outputs(notebook.hydrate_outputs(ws, cell["outputs"])):
                if notebook.ERROR_MIME in b:
                    continue
                cells = cite.bundle_cells(b)
                if cells:
                    outs.append({"out": i, "corner": cite._row_names(b)[0], "cells": [list(x) for x in cells]})
                elif cite.chart_spec(b) is None and not any(k.startswith("image/") for k in b):
                    lines = [[n, t] for n, t in cite.numbered_lines(b) if t.strip()]
                    if lines:
                        outs.append({"out": i, "lines": lines})
            if outs:
                out.append({"id": str(cell["id"]), "title": str(cell.get("title") or ""), "outputs": outs})
    return out


def cards_index(c: str, cards: list[dict[str, Any]]) -> str:
    """The file the checker greps for a value a card shows (the validator's card_index), in a folder of its own in the
    workspace's temp folder; its path. Each check has its own: a card rewritten while a check runs starts another
    check, whose index must not take the place of the one this check's validator reads `cards` as."""
    folder = _temp_dir(c) / f"check-{secrets.token_hex(4)}"
    folder.mkdir()
    p = folder / "cards-index.tsv"
    p.write_text(evidence().card_index(cards), encoding="utf-8")
    return str(p)


def _drop_index(index: str) -> None:
    """A check's index, gone with its folder once the check ended."""
    if index:
        with contextlib.suppress(OSError):
            Path(index).unlink()
            Path(index).parent.rmdir()


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


# ---- a reply's marks: <workspace>/marks/<turn>.json {turn, items, times}

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


def _save(c: str, reply: dict[str, Any]) -> None:
    p = _path(c, reply["turn"])
    p.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_json(p, reply)
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


def tell_text(items: list[dict[str, Any]]) -> str:
    """What main reads with its next event: each mark the check corrected or flagged, as the analyst reads it, and each
    note, which the analyst does not see (the terminal's tellText). The check's own words are quoted, since they may
    quote the records."""
    def q(w: str) -> str:
        return w if re.match(r"^[\"“]", w) else f"\"{w}\""

    def why(m: dict[str, Any]) -> str:
        return f" (the check: {q(m['reason'])})" if m.get("reason") else ""

    said = []
    for m in items:
        if m["status"] == "corrected":
            said.append(f"- {q(m.get('was') or m['words'])} is corrected to {q(m['shown'])}{why(m)}")
        elif m["status"] == "failed" and m.get("failedBy") == "evidence":
            said.append(f"- {q(m['words'])} is flagged as not confirmed{why(m)}")
        elif m["status"] == "failed":
            said.append(f"- {q(m['words'])} is flagged as wrong{why(m)}")
    notes = [f"- {q(n)}" for n in dict.fromkeys(m["note"] for m in items if m.get("note"))]
    if not said and not notes:
        return ""
    fence = "```"
    parts = ["thimble checked the citations of your last reply against the data. Its words in the blocks below may quote "
             "the records."]
    if said:
        parts.append("The analyst sees these changes in the reply:\n" + f"{fence}text\n" + "\n".join(said) + f"\n{fence}")
    if notes:
        parts.append("The check also found these uncited statements false. The analyst does not see these:\n"
                     + f"{fence}text\n" + "\n".join(notes) + f"\n{fence}")
    parts.append("Use the corrected facts from now on. The analyst has read the changes in the reply, so a correction "
                 "of them in your next reply would tell them twice. A claim the check could not confirm may still be "
                 "true: when you need it again, check it first.")
    return "\n".join(parts)


def _notice(c: str, text: str) -> None:
    from . import notices  # noqa: PLC0415

    try:
        notices.post(c, kind="agent", text=text, agent="Citation check", chat=agents.MAIN_ID, key="citations")
    except Exception:  # noqa: BLE001 — a notice not posted is no reason to fail the check
        log.exception("%s: the citation check's notice was not posted", c)


def _tell(c: str, text: str) -> None:
    from . import events  # noqa: PLC0415

    try:
        events.post(c, TELL_KIND, {"text": text})
    except Exception:  # noqa: BLE001 — no session listens: main misses the corrections, the analyst still sees them
        log.info("%s: main was not told what the citation check changed", c)


async def _edit(c: str, turn: str, change: Callable[[dict[str, Any]], dict[str, Any]], tell: bool = True) -> dict[str, Any] | None:
    """A change of a reply's marks, one at a time; when it settles the reply's last mark, main is told what the check
    changed (`tell`; a repair tells main of its own mark, repair_tell_text)."""
    async with _locks.setdefault((c, turn), asyncio.Lock()):
        reply = stored(c, turn)
        if reply is None:
            return None
        was_open = any(m["status"] == "checking" for m in reply["items"])
        reply = change(reply)
        settled = was_open and not any(m["status"] == "checking" for m in reply["items"])
        if settled:
            reply.setdefault("times", {})["settled"] = time.time()
        _save(c, reply)
    if tell and settled and (text := tell_text(reply["items"])):
        _tell(c, text)
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
        from . import card_check, notebook, runtime, session  # noqa: PLC0415

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
        cut = lv.last_cut or ("" if runtime.enabled() else None)
        if cut is None:
            return
        main = {"sid": lv.sid, "cwd": lv.cwd, "config": lv.config, "config_known": lv.config_known,
                "transcript_path": lv.transcript_path, "model": lv.model, "effort": lv.effort,
                "context_tokens": lv.context_tokens}
        _spawn(start_check(c, main, new_turn(), [], cut, cards={cid}))
    except Exception:  # noqa: BLE001 — a takeaway not checked now is checked with main's next reply
        log.exception("%s: the check of card %s's takeaway did not start", c, cid)


async def start_check(c: str, main: dict[str, Any], turn: str, texts: list[str], cut: str | None,
                      fork: Callable[..., Awaitable[dict[str, Any]]] | None = None,
                      cards: set[str] | None = None) -> None:
    """Check the marks of main's `texts` and of the takeaways waiting for a check (only those of `cards` when given,
    with no reply's record when there are no texts), each takeaway claimed until its marks are on its card."""
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
        await _start_check(c, main, turn, texts, cut, fork, takeaways, claims, saved=cards is None or bool(texts))
    finally:
        _claimed.difference_update(claims)


async def _start_check(c: str, main: dict[str, Any], turn: str, texts: list[str], cut: str | None,
                       fork: Callable[..., Awaitable[dict[str, Any]]] | None, takeaways: list[tuple[str, str, str]],
                       claims: set[tuple[str, str, str]], saved: bool) -> None:
    from . import notebook  # noqa: PLC0415

    try:
        found = await marks_of(list(texts) + [t for _, _, t in takeaways])
    except (OSError, RuntimeError, ValueError) as e:
        _notice(c, f"thimble could not read the citations of the last reply ({str(e)[:120]}), so they are not checked.")
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
    if chat or (takes and saved):
        _save(c, {"turn": turn, "items": chat, "times": {"reply_end": time.time()}})
    for cid, text in dict.fromkeys((m["card"], m["takeaway"]) for m in takes):
        mine = [_takeaway_item(m) for m in takes if m["card"] == cid]
        notebook.set_takeaway_marks(c, cid, text, lambda _old, mine=mine: mine)
    _claimed.difference_update(claims)  # their marks are on their cards: takeaways_to_check passes them by now
    if cut is None:
        await _give_up(c, turn, {m["n"] for m in chat}, "the reply was stopped before its citations were checked")
        return
    folder = str(main.get("cwd") or config.corpus_dir(c))
    cards, index = await _cards_and_index(c)
    try:
        await asyncio.gather(*(_check_share(c, main, turn, cut, share, folder, fork or run_fork, cards, index)
                               for share in split_marks(chat + takes)))
    finally:
        _drop_index(index)


async def _cards_and_index(c: str) -> tuple[list[dict[str, Any]], str]:
    """The workspace's cards as the validator reads them, and the index the checker greps; none when they cannot be
    read (the check runs without the cards)."""
    try:
        cards = await asyncio.to_thread(session_cards, c)
        return cards, cards_index(c, cards)
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
    from . import notebook  # noqa: PLC0415

    by_card: dict[tuple[str, str], dict[int, dict[str, Any]]] = {}
    for m in takes:
        by_card.setdefault((m["card"], m["takeaway"]), {})[m["k"]] = m

    for (cid, text), mine in by_card.items():
        def change(items: list[dict[str, Any]], mine: dict[int, dict[str, Any]] = mine) -> list[dict[str, Any]]:
            return [judged({**it, "n": mine[it["k"]]["n"]}) if it.get("k") in mine and it.get("status") == "checking" else it
                    for it in items]

        try:
            notebook.set_takeaway_marks(c, cid, text, change)
        except Exception:  # noqa: BLE001 — a card gone or unwritable keeps what it had
            log.exception("%s: the takeaway marks of card %s were not written", c, cid)


# ---- 2, 3: a fork's check, then the validator

async def _check_share(c: str, main: dict[str, Any], turn: str, cut: str, share: list[dict[str, Any]], folder: str,
                       fork: Callable[..., Awaitable[dict[str, Any]]], cards: list[dict[str, Any]] | None = None,
                       index: str = "", request: str = "") -> None:
    """One fork's check of a share of the marks. `request`: what follows the checker's text for a repair (Repair in a
    mark's label, the terminal's x), whose end tells main how its one mark ended."""
    takes = [m for m in share if m.get("card")]
    mine = {m["n"] for m in share if not m.get("card")}
    lines = "\n".join(_line(m) for m in share)

    async def give_up(why: str) -> None:
        await _give_up(c, turn, mine, why)
        await _takeaways_change(c, takes, lambda m: {**m, "status": "unchecked", "reason": why})

    try:
        prompt = checker_prompt(lines, folder, index)
        got = await fork(c, main, cut, f"{prompt}\n\n{request}" if request else prompt)
        if got.get("error"):
            await give_up(f"the check ended: {got['error']}")
            _notice(c, f"The check of the citations stopped ({str(got['error'])[:100]}), so some are not checked. The "
                       "next reply is checked again.")
            return
        answer = str(got.get("answer") or "")
        ev = evidence()
        cited = cited_outputs(answer)
        mains = [k for k in bash_calls(_transcript_messages(main.get("transcript_path")), "main")
                 if any(ev.printed(o, k["output"]) is not None for o in cited)]
        calls = list(got.get("calls") or []) + mains
        result = await asyncio.to_thread(ev.check_all, [{k: m[k] for k in ("n", "words", "sentence")} for m in share],
                                         answer, calls, folder, folder, str(_temp_dir(c)), cards or [])
        if not result["parsed"]:
            await give_up("the check gave no answer thimble could read")
            _notice(c, "The check of the citations gave no answer thimble could read, so some are not checked.")
            return
        by_n = {int(r["n"]): r for r in result["results"]}

        def change(r: dict[str, Any]) -> dict[str, Any]:
            def judged(m: dict[str, Any]) -> dict[str, Any]:
                res = by_n.get(m["n"])
                if m["n"] not in mine or m["status"] != "checking":
                    return m
                if res is None:
                    return {**m, "status": "unchecked", "reason": "the check gave no answer for this citation"}
                return {**m, **{k: v for k, v in res.items() if k != "n"}, "shown": str(res.get("shown") or m["words"])}

            r["items"] = [judged(m) for m in r["items"]]
            return r

        reply = await _edit(c, turn, change, tell=not request)
        if request and reply and (text := repair_tell_text([m for m in reply["items"] if m["n"] in mine])):
            _tell(c, text)

        def judged_takeaway(m: dict[str, Any]) -> dict[str, Any]:
            res = by_n.get(m["n"])
            if res is None:
                return {**m, "status": "unchecked", "reason": "the check gave no answer for this citation"}
            return {**m, **{k: v for k, v in res.items() if k != "n"}, "shown": str(res.get("shown") or m["words"])}

        await _takeaways_change(c, takes, judged_takeaway)
    except Exception as e:  # noqa: BLE001 — a check that cannot be validated leaves its marks unchecked, and says so
        log.exception("%s: the check of the marks failed", c)
        _notice(c, f"thimble could not check the citations ({type(e).__name__}: {str(e)[:80]}), so some are not "
                   "checked.")
    finally:
        await give_up("the check ended before it judged this citation")


def _temp_dir(c: str) -> Path:
    p = config.workspace_dir(c) / "tmp"
    p.mkdir(parents=True, exist_ok=True)
    return p


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


def _transcript_messages(path: Any) -> list[dict[str, Any]]:
    """Main's transcript records, each a dict (a line that does not parse is skipped)."""
    out: list[dict[str, Any]] = []
    if not path:
        return out
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                with contextlib.suppress(ValueError):
                    rec = json.loads(line)
                    if isinstance(rec, dict):
                        out.append(rec)
    except OSError:
        pass
    return out


# ---- repair: a failed mark checked again (the terminal's x, marks/checker.ts repairOf, repairRequest, launchRepair)

def _q(w: str) -> str:
    return w if re.match(r"^[\"“]", w) else f"\"{w}\""


# The terminal's repairRequest (plugin/marks/checker.ts) in its exact words; tests/test_marks.py checks that each
# stands in checker.ts, so an edit there stops the test until someone looks at it.
REPAIR_NOT_RUN = "The analyst pressed x to check citation {n}, whose first check did not run. It may stand in an earlier reply than your last."
REPAIR_FIRST = "The analyst pressed x to repair citation {n}. It may stand in an earlier reply than your last. The first check {found}"
REPAIR_TASK = (
    "Check it again from the start. When the cited words hold, answer `verified` with the evidence that shows them. Else make the citation correct: change the cited words or the sentence, whatever makes it true to the records, and answer `corrected` with the evidence that shows the new cited words.",
    "When the value is right but the cited words also hold your own words that no record shows, such as a translation or an explanation, answer `narrowed` with only the part of the cited words that the evidence shows.",
)


def repair_request(m: dict[str, Any], n: int) -> str:
    """What follows the checker's text for a repair of mark `m`, numbered `n` in it: which mark, what the first check
    found (its reason quoted, since it may quote the records), and the task. A mark whose check did not run (unchecked,
    or failed by none) is checked as any reply's is."""
    if m.get("status") == "unchecked" or m.get("failedBy") in (None, "none"):
        return REPAIR_NOT_RUN.format(n=n)
    found = "could not confirm it" if m.get("failedBy") == "evidence" else "found it wrong"
    first = REPAIR_FIRST.format(n=n, found=found) + (f": {_q(m['reason'])}" if m.get("reason") else ".")
    return "\n".join((first, *REPAIR_TASK))


def repair_tell_text(items: list[dict[str, Any]]) -> str:
    """What main reads when a repair ended: how its mark ended, as the analyst reads it (the terminal's
    repairTellText)."""
    def why(m: dict[str, Any]) -> str:
        return f" (the check: {_q(m['reason'])})" if m.get("reason") else ""

    lines = []
    for m in items:
        if m["status"] == "corrected":
            lines.append(f"- {_q(m.get('was') or m['words'])} is corrected to {_q(m['shown'])}{why(m)}")
        elif m["status"] == "verified":
            lines.append(f"- {_q(m['words'])} is verified as written{why(m)}")
        elif m["status"] == "failed":
            lines.append(f"- {_q(m['words'])} is still flagged as {'not confirmed' if m.get('failedBy') == 'evidence' else 'wrong'}{why(m)}")
        else:
            lines.append(f"- {_q(m['words'])} could not be checked again{why(m)}")
    if not lines:
        return ""
    fence = "```"
    return ("The analyst pressed Repair on a citation of yours, and thimble checked it against the data. Its words in "
            f"the block below may quote the records.\n{fence}text\n" + "\n".join(lines) + f"\n{fence}\n"
            "The analyst sees the result in the reply. Use it from now on.")


REPAIRABLE = ("failed", "unchecked")
# what a repair clears of a mark: its earlier result goes, its place and words stay
CLEARED = ("status", "was", "reason", "failedBy", "evidence", "note", "narrowed", "rewrite", "shown")


def _main_now(c: str) -> tuple[dict[str, Any], str] | str:
    """What a fork of main needs, at main's last finished turn: (main, cut), or why there is none (card_written's)."""
    from . import runtime, session  # noqa: PLC0415

    lv = session.current(c)
    cut = (lv.last_cut or ("" if runtime.enabled() else None)) if lv is not None else None
    if lv is None or cut is None:
        return "main has no finished turn to check from yet"
    return ({"sid": lv.sid, "cwd": lv.cwd, "config": lv.config, "config_known": lv.config_known,
             "transcript_path": lv.transcript_path, "model": lv.model, "effort": lv.effort,
             "context_tokens": lv.context_tokens}, cut)


async def repair(c: str, turn: str | None = None, n: int | None = None, card: str | None = None, k: int | None = None,
                 fork: Callable[..., Awaitable[dict[str, Any]]] | None = None) -> str:
    """Repair a failed mark: a reply's (`turn`, `n`) or a card's takeaway's (`card`, its order `k`). It is `checking`
    again while a fork of main checks it with the terminal's repair request, and the validator decides its end as for
    any check. '' when it started, else why not. The check runs in the background."""
    from . import notebook  # noqa: PLC0415

    got = _main_now(c)
    if isinstance(got, str):
        return got
    main, cut = got
    share: dict[str, Any] | None = None
    if card:
        cell = notebook.get_cell(c, card)
        kept = (cell or {}).get("takeaway_marks") or {}
        text = str((cell or {}).get("takeaway") or "")
        m = next((x for x in kept.get("items") or [] if x.get("k") == k), None) if kept.get("text") == text else None
        if not m or m.get("status") not in REPAIRABLE:
            return "this citation is not one that failed"
        request = repair_request(m, 1)
        base = {key: v for key, v in m.items() if key not in CLEARED}
        share = {**base, "n": 1, "status": "checking", "shown": m["words"], "card": card,
                 "title": str(cell.get("title") or ""), "takeaway": text}

        def change(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return [{**base, "status": "checking", "shown": it["words"], "repair": True} if it.get("k") == k else it
                    for it in items]

        notebook.set_takeaway_marks(c, card, text, change)
        turn = new_turn()
    else:
        reply = stored(c, turn or "")
        m = next((x for x in (reply or {}).get("items") or [] if x.get("n") == n), None)
        if not m or m.get("status") not in REPAIRABLE:
            return "this citation is not one that failed"
        request = repair_request(m, int(m["n"]))
        base = {key: v for key, v in m.items() if key not in CLEARED}
        share = {**base, "status": "checking", "shown": m["words"]}

        def change_reply(r: dict[str, Any]) -> dict[str, Any]:
            r["items"] = [{**base, "status": "checking", "shown": x["words"], "repair": True} if x["n"] == n else x
                          for x in r["items"]]
            return r

        await _edit(c, str(turn), change_reply, tell=False)

    async def run() -> None:
        cards, index = await _cards_and_index(c)
        folder = str(main.get("cwd") or config.corpus_dir(c))
        try:
            await _check_share(c, main, str(turn), cut, [share], folder, fork or run_fork, cards, index, request)
        finally:
            _drop_index(index)

    _spawn(run())
    return ""


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


def fork_argv(main: dict[str, Any], cut: str | None, model_id: str, effort: str) -> list[str]:
    sent = effort if config.has_effort(model_id) else None
    settings = {**json.loads(sdk.cli_settings(model_id, sent, None)), "advisorModel": "off"}
    at = ["--resume-session-at", cut] if cut else []
    return [str(config.CLI_PATH or config.CLAUDE_BIN), "-p", "--resume", str(main["sid"]), *at,
            "--fork-session", "--no-session-persistence", "--model", model_id, *(["--effort", sent] if sent else []),
            "--tools", ",".join(CHECKER_TOOLS), "--allowedTools", ",".join(ALLOWED), "--strict-mcp-config",
            "--disable-slash-commands", "--safe-mode", "--setting-sources", "user", "--permission-mode", "dontAsk",
            "--settings", json.dumps(settings), "--output-format", "stream-json", "--verbose"]


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
            error = str(rec.get("result") or rec.get("subtype") or "error")[:200]
    return {"answer": "\n".join(texts), "calls": bash_calls(messages, "checker"), "error": error}


def allowed_call(name: str, args: dict[str, Any]) -> bool:
    """What a fork of the Messages API runtime may run, as ALLOWED lets Claude Code's: Read, Grep, Glob, and Bash only
    for a python command."""
    if name in ("Read", "Grep", "Glob"):
        return True
    cmd = str(args.get("command") or "").lstrip()
    return name == "Bash" and re.match(r"python3?(\s|$)", cmd) is not None


async def run_fork(c: str, main: dict[str, Any], cut: str | None, prompt: str) -> dict[str, Any]:
    """One fork of main at `cut` with the checker's prompt: {answer, calls, error}. On the runtime that the person's
    way to reach Claude chose (runtime.py): the Messages API in this process for an API key or WIF (no `claude`
    process), their Claude Code session's fork for a Claude Code sign-in; 0.8's `claude -p` fork when the runtime is
    off."""
    from . import runtime, runtime_api  # noqa: PLC0415

    model_id, effort = _model(c, main, prompt)
    if runtime.enabled():
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
        main, cut = {**main, "sid": sid, "config_known": False}, None
    argv = fork_argv(main, cut, model_id, effort)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=str(main.get("cwd") or config.corpus_dir(c)), env=_env(main), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
    except OSError as e:
        return {"error": f"Claude Code could not start: {e}"}
    _procs.add(proc)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(prompt.encode("utf-8")), FORK_TIMEOUT_S)
    except asyncio.TimeoutError:
        _kill(proc)
        return {"error": "it took too long"}
    except asyncio.CancelledError:
        _kill(proc)
        raise
    finally:
        _procs.discard(proc)
    got = parse_stream(stdout.decode("utf-8", "replace"))
    if proc.returncode not in (0, None) and not got["answer"]:
        tail = stderr.decode("utf-8", "replace").strip().splitlines()
        got["error"] = got["error"] or (tail[-1][:200] if tail else f"Claude Code exited with code {proc.returncode}")
    return got


def _kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)


def stop_all() -> None:
    """The server stops: the forks that run end with it."""
    for proc in list(_procs):
        _kill(proc)
