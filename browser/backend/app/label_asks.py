"""The ask before a big prompt label's run: the person says whether a model reads many records, as the terminal asks.

A prompt label over more than SAMPLE units (the terminal's rule, plugin/engine/kernel/estimate.py, kept equal by a test)
does not start on its own, whoever started it: main's apply_label, the label editor's Run, the Labels sidebar's Run
again, or a card that brings a stale label up to date (concepts.bring_current). It waits as an ask, which the page shows
above the chat's composer and in the label's detail in the Labels sidebar: what the run reads ("Read 14,591 records
with Opus 5.5"), the choices Run all, Run on a sample of SAMPLE and Cancel, and under them the estimate, the model calls
the run makes in batches of concepts.BATCH_ITEMS ("about 292 model calls").

The person's choice (POST /ws/{c}/label-asks/{id}) starts the run over every unit (and this label, at this version and
scope, need not ask again), over a sample, or not at all. When main asked for the run, it hears the choice as a quiet
`label_ask` event with its next event, and a `label_done` event when a run it chose finishes.

The asks live in this process: a restart forgets them, and the label simply has not run.
"""
from __future__ import annotations

import math
import secrets
import time
from typing import Any

SAMPLE = 300  # the units "Run on a sample" reads; a prompt label over more asks first (plugin/engine/kernel/estimate.py)
CHOICES = ("all", "sample", "cancel")

_asks: dict[tuple[str, str], dict[str, Any]] = {}  # (workspace, label id) -> the ask that waits
_approved: dict[tuple[str, str], str] = {}  # (workspace, label id) -> the scope the person said to read whole


def needs_asking(units: int) -> bool:
    """Whether a prompt label's run asks the person first: it reads more units than a sample. Pure."""
    return units > SAMPLE


def calls_estimate(units: int, per_call: int) -> int:
    """The model calls a run over `units` makes, at `per_call` units a call (fewer when records are long). Pure."""
    return max(1, math.ceil(units / max(1, per_call))) if units else 0


def model_words(model: str) -> str:
    """A model id in the words the page uses: claude-opus-5-5 -> Opus 5.5; an unknown shape stays as it is. Pure."""
    parts = str(model or "").removeprefix("claude-").split("-")
    if len(parts) < 2 or not parts[0].isalpha():
        return str(model or "Claude")
    nums = [p for p in parts[1:] if p.isdigit() and len(p) < 4]  # a date suffix (20251001) is no version
    return parts[0].capitalize() + (" " + ".".join(nums) if nums else "")


def scope_key(concept: dict[str, Any], paths: list[str], limit: int | None) -> str:
    """The label's version and scope in one string: a yes holds for this exact definition and scope only. Pure."""
    return f"{concept.get('version')}|{','.join(sorted(paths))}|{limit or ''}|{concept.get('within') or ''}"


def ask_text(units: int, unit_word: str, where: str, model: str) -> str:
    """The ask's sentence: "Read 14,591 records of revisions.jsonl with Opus 5.5". Pure."""
    return f"Read {units:,} {unit_word}{f' of {where}' if where else ''} with {model_words(model)}"


def meta_line(calls: int) -> str:
    """The line under the choices: "about 292 model calls". Pure."""
    return f"about {calls:,} model {'call' if calls == 1 else 'calls'}"


def waiting(c: str, concept_id: str | None = None) -> list[dict[str, Any]]:
    """The asks that wait in workspace `c` (of one label when `concept_id`), oldest first."""
    out = [a for (w, cid), a in _asks.items() if w == c and (concept_id is None or cid == concept_id)]
    return sorted(out, key=lambda a: a["at"])


def find(c: str, ask_id: str) -> dict[str, Any] | None:
    return next((a for (w, _cid), a in _asks.items() if w == c and a["id"] == ask_id), None)


def approved(c: str, concept: dict[str, Any], paths: list[str], limit: int | None) -> bool:
    return _approved.get((c, concept["id"])) == scope_key(concept, paths, limit)


def hold(c: str, concept: dict[str, Any], *, units: int, unit_word: str, where: str, model: str, per_call: int,
         paths: list[str], limit: int | None, comment: bool, created_by: str, from_main: bool) -> dict[str, Any]:
    """Keep the ask for this label's run (one per label: a new ask replaces the one before). Returns it."""
    calls = calls_estimate(units, per_call)
    ask = {"id": "a" + secrets.token_hex(6), "concept": concept["id"], "name": concept["name"], "units": units,
           "sample": SAMPLE, "calls": calls, "model": model, "model_words": model_words(model),
           "text": ask_text(units, unit_word, where, model), "meta": meta_line(calls), "paths": list(paths),
           "limit": limit, "comment": comment, "created_by": created_by, "from_main": from_main,
           "scope": scope_key(concept, paths, limit), "at": time.time()}
    _asks[(c, concept["id"])] = ask
    return ask


def take(c: str, ask_id: str, choice: str) -> dict[str, Any]:
    """The person's choice for `ask_id`: the ask, gone from the waiting ones; with `all`, its scope approved.
    KeyError when no such ask waits, ValueError for another choice."""
    if choice not in CHOICES:
        raise ValueError("the choice is all, sample or cancel")
    ask = find(c, ask_id)
    if ask is None:
        raise KeyError(ask_id)
    _asks.pop((c, ask["concept"]), None)
    if choice == "all":
        _approved[(c, ask["concept"])] = ask["scope"]
    return ask


def drop(c: str, concept_id: str) -> None:
    """Forget a label's ask and approval (the label was deleted)."""
    _asks.pop((c, concept_id), None)
    _approved.pop((c, concept_id), None)


def choice_note(ask: dict[str, Any], choice: str) -> str:
    """What main hears of the person's choice (the `label_ask` event's text). Pure."""
    n, name = f"{ask['units']:,}", ask["name"]
    if choice == "cancel":
        return f"The analyst chose not to run the label {name}: the model reads none of its {n} units."
    if choice == "all":
        return f"The analyst chose to run the label {name} on all {n} units; a label_done event comes when it finishes."
    return (f"The analyst chose a sample of {min(SAMPLE, ask['units']):,} of the label {name}'s {n} units, not all of "
            f"them; a label_done event comes when it finishes. The other units stay without a value, and applying the "
            f"label again without a limit asks the analyst again.")


def reset() -> None:
    """For tests: no asks, no approvals."""
    _asks.clear()
    _approved.clear()
