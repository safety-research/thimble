"""The chat's label tools: apply_label, show_label, delete_label, set_filter and clear_filter (their texts are in
prompts/tools-labels.md).

apply_label never holds the chat's turn for long. A prompt label over many units asks the analyst first (asks.py) and
answers at once. Any other run starts, and apply_label waits APPLY_WAIT_S for it: a short run (a trial, a regex, code)
answers with its counts, and a longer one goes on in the background, shown as a row of the chat, while Claude answers
from what it has. Either way the chat's agent hears how the run ended with the analyst's next message. The chat's Stop,
during the wait, stops the run, keeping what it labeled so far.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from .. import tools
from ..tools import Result
from . import asks, define, run, store

TOOLS = ("apply_label", "show_label", "delete_label", "set_filter", "clear_filter")
APPLY_WAIT_S = 30.0  # apply_label waits this long for its run, then answers while the run goes on
UNIT_ARG = {"records": "record", "files": "agent", "runs": "run"}
UNIT_WORDS = {"record": "record", "agent": "file", "run": "run", "cell": "card", "span": "sentence"}


def _ok(text: str, **kw: Any) -> Result:
    return Result(text, False, **kw)


def _err(text: str) -> Result:
    return Result(text, True)


def _units(unit: str, n: int) -> str:
    w = UNIT_WORDS.get(unit, unit)
    return w if n == 1 else f"{w}s"


async def apply_label(t: tools.Tools, args: dict[str, Any]) -> Result:
    ws, folder = t.ws, t.folder
    scope = str(args.get("scope") or "files").strip().lower()
    name = " ".join(str(args.get("name") or "").split())
    pred = args.get("predicate") if isinstance(args.get("predicate"), dict) else {}
    kind = str(pred.get("kind") or "prompt").strip().lower()
    text = str(pred.get("text") or "").strip()
    if scope not in store.SCOPES:
        return _err(f"`scope` is one of {', '.join(store.SCOPES)}")
    if not name or not text:
        return _err("a label needs its `name` and its predicate's `text`: the definition, the pattern or the function")
    unit_arg = str(args.get("unit") or "").strip().lower()
    if unit_arg and scope != "files":
        return _err("`unit` is for a label over files")
    if kind == "regex":
        try:
            re.compile(text)
        except re.error as e:
            return _err(f"the pattern is not a regular expression: {e}")
    if kind == "code" and not re.search(r"^\s*def\s+label\s*\(", text, re.M):
        return _err("a code label's text defines `def label(unit):`, returning a value, or a value and a confidence")
    paths = args.get("paths") or []
    paths = [paths] if isinstance(paths, str) else [str(p).strip() for p in paths if str(p).strip()]
    if scope == "files" and not paths:
        paths = ["**/*"]
    limit = int(args["limit"]) if args.get("limit") else None
    prior = store.find(ws, name)
    if prior is not None and store.SCOPE_OF_UNIT.get(prior["unit"]) != scope:
        return _err(f"{prior['name']} [↗](concept:{prior['id']}) is a label over "
                    f"{store.SCOPE_OF_UNIT.get(prior['unit'])} already. A label over {scope} needs a name of its own.")
    unit = UNIT_ARG.get(unit_arg) or (prior["unit"] if prior is not None else store.SCOPES[scope])
    within = None
    if isinstance(args.get("within"), dict) and args["within"].get("label"):
        other = store.find(ws, str(args["within"]["label"]))
        if other is None:
            return _err(f"`within` names no label {args['within']['label']!r}")
        if unit != "record":
            return _err("`within` narrows a label over records of files")
        value = str(args["within"].get("value") or other["labels"][0])
        if value not in other["labels"]:
            return _err(f"{other['name']} has no value {value!r}; its values are {', '.join(other['labels'])}")
        within = {"label": other["id"], "value": value}
    values = args.get("values") if isinstance(args.get("values"), list) else None
    concept, how = await define.define(ws, name, kind=kind, text=text, unit=unit, values=values,
                                       by=f"chat:{t.chat}", glob=paths if unit in store.FILE_UNITS else [],
                                       trial=limit is not None, comment=bool(args.get("comment")), within=within)
    cid = concept["id"]
    card = await asyncio.to_thread(store.label_card, ws, concept, group=args.get("group") or None, by="main",
                                   chat=t.chat, question=args.get("question") or None)
    t.on_card(card["id"])
    if args.get("show") and unit in store.FILE_UNITS:
        store.show(ws, cid, True)
    unchanged = how == "same" and not run.running(ws, cid) and define.covered(concept, paths, limit)
    where = asks.where_of(unit, paths)
    if (waiting := asks.pending(ws, cid)) is not None:
        return _ok(f"The label {concept['name']} [↗](concept:{cid}) still waits for the analyst's choice in the chat: "
                   f"{waiting['text']} Answer from what you have.", extra={"label_card": card["id"]},
                   cell_id=card["id"])
    if not unchanged and not run.running(ws, cid):
        found = None
        if kind == "prompt":
            try:
                found = await asyncio.to_thread(run.scope_units, ws, folder, concept,
                                                paths if unit in store.FILE_UNITS else [], limit)
            except store.LabelError as e:
                return _err(f"defined the label {concept['name']} [↗](concept:{cid}), but it did not run: {e}")
            est = asks.estimate(concept, found)
            if asks.needs_asking(est):
                if args.get("filter"):
                    store.set_filter(ws, scope, cid, concept["labels"][0])
                asks.ask(ws, t.chat, concept, paths=paths if unit in store.FILE_UNITS else [], est=est, where=where)
                return _ok(asked(concept, card["id"], est, where), extra={"label_card": card["id"]},
                           cell_id=card["id"])
        try:
            await run.start(ws, folder, concept, paths=paths if unit in store.FILE_UNITS else [], limit=limit,
                            created_by=f"chat:{t.chat}", found=found or None)
        except store.LabelError as e:
            return _err(f"defined the label {concept['name']} [↗](concept:{cid}), but it did not run: {e}")
    if args.get("filter"):
        store.set_filter(ws, scope, cid, concept["labels"][0])
    try:
        rec = await run.wait(ws, cid, APPLY_WAIT_S)
    except asyncio.CancelledError:
        await run.cancel(ws, cid)
        raise
    if rec is not None and rec.get("status") == "running":
        if not rec.get("follow"):
            asks.follow(ws, t.chat, concept, rec, where)
    elif rec is not None:
        rec["told"] = True  # this answer has the counts, so the next turn need not hear them again
    return _ok(summary(ws, cid, rec, paths=paths, unchanged=unchanged), extra={"label_card": card["id"]},
               cell_id=card["id"])


def asked(concept: dict[str, Any], card: str, est: dict[str, Any], where: str) -> str:
    """apply_label's answer when the run waits for the analyst's go-ahead."""
    cid = concept["id"]
    run_all, sample, cancel = asks.choices()
    return (f"Defined the label {concept['name']} [↗](concept:{cid}); its card is card:{card}. It has not run. "
            f"{asks.size_line(concept, est, where)}, in {asks.calls_line(est)}. That is "
            f"the analyst's time and money, so the chat asks them first, with three buttons: \"{run_all}\", "
            f"\"{sample}\" (chosen at random) and \"{cancel}\". Their choice, and the counts once a run ends, reach "
            f"you with their next message. Answer now from what you have, such as a trial's records or what you computed, and say that "
            f"the label waits for their choice.")


def summary(ws: str, cid: str, rec: dict[str, Any] | None, *, paths: list[str], unchanged: bool) -> str:
    """apply_label's answer: the counts with their citations, what failed, and what Claude does next."""
    concept = store.read(ws, cid) or {}
    name, unit = concept.get("name", cid), concept.get("unit", "record")
    counts, moved = store.effective_counts(ws, cid)
    total = (rec or {}).get("total") or sum(counts.values())
    shown = ", ".join(f"{v} [{counts.get(v, 0):,}](concept:{cid}/{v})" for v in concept.get("labels", []))
    where = f" in {', '.join(paths)}" if unit in store.FILE_UNITS else ""
    lines = [f"Applied the label {name} [↗](concept:{cid}) over {total:,} {_units(unit, total)}{where}: {shown}."]
    if moved:
        lines.append(f"These counts take the analyst's values: they set {moved} {_units(unit, moved)} to another value.")
    if unchanged:
        lines.append("The label already held these values from the same definition over the same units, so nothing "
                     "ran again.")
    elif rec is not None:
        if rec.get("status") == "running":
            lines.append(f"The run goes on in the background ({rec.get('done', 0):,} of {rec.get('total') or 0:,} so "
                         "far); the chat and its card show it as it goes. Its counts reach you with the analyst's next "
                         "message after it ends. Answer now from what you have, and say that the label still runs.")
        elif rec.get("status") == "error":
            lines.append(f"The run failed: {rec.get('message') or 'no reason given'}.")
        elif rec.get("stopped"):
            lines.append(f"The run was stopped after {rec.get('done', 0):,} of {rec.get('total') or 0:,}.")
        if rec.get("failed") and rec.get("status") != "error":
            lines.append(f"{rec['failed']:,} {_units(unit, rec['failed'])} got no value: {rec.get('message') or 'no reason given'}.")
        if rec.get("limit"):
            lines.append(f"This was a trial on {rec.get('total') or 0:,} {_units(unit, rec.get('total') or 0)}: read "
                         "them, then apply the label again without `limit` to label every one.")
    if concept.get("kind") != "prompt" and unit == "record" and counts.get(concept.get("labels", [""])[0]):
        rows = [r for r in store.merged(ws, cid).values() if store.effective(r) == concept["labels"][0]][:5]
        if rows:
            lines.append(f"Some it gave {concept['labels'][0]!r}: " + "; ".join(f"[↗]({r['ref']})" for r in rows) + ".")
    for nb, cell in store.label_cards(ws, cid)[:1]:
        lines.append(f"The label's card is card:{cell['id']}.")
        if not str(cell.get("takeaway") or "").strip() and (rec is None or rec.get("status") != "running"):
            lines.append(f"Give card:{cell['id']} its takeaway with edit_card: one or two sentences answering its "
                         f"question from these counts, each count cited as [n](concept:{cid}/<value>).")
    if unit in store.FILE_UNITS:
        lines.append(f'In run_python and a card\'s code, thimble.labels("{name}") is a DataFrame (path, line, effective, '
                     f'label, source, verdict, confidence, ref) of the units that got the first value, and '
                     f'thimble.labels("{name}", negatives=True) of every labeled unit.')
    return " ".join(lines)


async def show_label(t: tools.Tools, args: dict[str, Any]) -> Result:
    on = args.get("on")
    colors = args.get("colors") if isinstance(args.get("colors"), dict) else None
    if not isinstance(on, bool) and not colors:
        return _err("`on` is required, true or false, unless the call gives `colors`")
    k = store.find(t.ws, str(args.get("name") or ""))
    was = bool(k["shown"]) if k is not None else None
    try:
        k = store.show(t.ws, str(args.get("name") or ""), on if isinstance(on, bool) else None,
                       args.get("values") if isinstance(args.get("values"), list) else None, colors)
    except (KeyError, store.LabelError) as e:
        return _err(str(e).strip("'\""))
    ref = f"[↗](concept:{k['id']})"
    if not isinstance(on, bool):
        return _ok(f"The label {k['name']} {ref} has its colors now; it is {'on' if k['shown'] else 'off'} in Files.")
    state = f"was {'on' if was else 'off'} and is now {'on' if on else 'off'}" if was != on else f"is {'on' if on else 'off'}, as it was"
    if not on:
        return _ok(f"The label {k['name']} {ref} {state} in Files.")
    lit = [c["name"] for c in k["classes"] if c["highlight"]]
    return _ok(f"The label {k['name']} {ref} {state} in Files, highlighting {', '.join(lit) or 'none of its values'}.")


async def delete(ws: str, cid: str) -> None:
    """A label with its rows, its card and any filter that uses it; a run of it stops first."""
    await run.cancel(ws, cid)
    store.clear_filters_of(ws, cid)
    await asyncio.to_thread(store.drop_label_cards, ws, cid)
    store.remove(ws, cid)
    run.RUNS.pop((ws, cid), None)
    store.notify(ws, cid, "deleted")


async def delete_label(t: tools.Tools, args: dict[str, Any]) -> Result:
    k = store.find(t.ws, str(args.get("name") or ""))
    if k is None:
        names = ", ".join(repr(x["name"]) for x in store.listing(t.ws)) or "none yet"
        return _err(f"no label {args.get('name')!r}; the labels are {names}")
    await delete(t.ws, k["id"])
    return _ok(f"The label {k['name']} is deleted, with its marks, its card and any filter that used it.")


async def set_filter(t: tools.Tools, args: dict[str, Any]) -> Result:
    scope = str(args.get("scope") or "")
    if scope not in store.SCOPES:
        return _err(f"`scope` is one of {', '.join(store.SCOPES)}")
    parts = {k: args[k] for k in (*store.CARD_LISTS, *store.CARD_FLAGS, "text") if k in args}
    if parts and scope != "canvas":
        return _err("kinds, groups, makers, starred and text filter the canvas's cards")
    label = args.get("label")
    try:
        if label:
            k = store.find(t.ws, str(label))
            if k is None:
                return _err(f"no label {label!r}; the labels are "
                            f"{', '.join(repr(x['name']) for x in store.listing(t.ws)) or 'none yet'}")
            value = str(args.get("value") or k["labels"][0])
            if value not in k["labels"]:
                return _err(f"{k['name']} has no value {value!r}; its values are {', '.join(k['labels'])}")
            filters = store.set_filter(t.ws, scope, k["id"], value)
        elif label == "" and scope in store.read_filters(t.ws):
            filters = store.clear_filter(t.ws, scope)
        else:
            filters = store.read_filters(t.ws)
        if parts:
            now = {k: v for k, v in (filters.get("canvas") or {}).items() if k not in ("concept", "value")}
            now.update(parts)
            filters = store.set_card_filter(t.ws, now)
    except (KeyError, store.LabelError) as e:
        return _err(str(e))
    entry = filters.get(scope)
    if not entry:
        return _ok(f"The {scope} filter is clear.")
    words = []
    if entry.get("concept"):
        k = store.read(t.ws, entry["concept"])
        words.append(f"{k['name'] if k else entry['concept']} = {entry['value']}")
    words += [f"{p}: {', '.join(v) if isinstance(v, list) else v}" for p, v in entry.items() if p not in ("concept", "value")]
    line = f"The {scope} filter is now {'; '.join(words)}."
    if scope == "files" and entry.get("concept"):
        line += " Files shows the label turned on with that value highlighted."
    return _ok(line)


async def clear_filter(t: tools.Tools, args: dict[str, Any]) -> Result:
    scope = str(args.get("scope") or "")
    try:
        store.clear_filter(t.ws, scope, whole=True)
    except store.LabelError as e:
        return _err(str(e))
    return _ok(f"The {scope} filter is clear.")


HANDLERS = {"apply_label": apply_label, "show_label": show_label, "delete_label": delete_label,
            "set_filter": set_filter, "clear_filter": clear_filter}
