"""A label run in the chat: the analyst's go-ahead before a model reads many records, and a row that shows the run.

The label editor's Run asks the same way (api.py, POST /concepts/{id}/apply): an ask with no chat, whose line and
choices the editor shows, answered through the same route.

A prompt label over many units costs time and money, so apply_label (chat.py) does not start it on its own: it writes a
`label_run` record into the chat with the size of the run (estimate()) and three choices, Run all, Run on a sample (of
SAMPLE units chosen at random) and Cancel, and answers Claude at once. The analyst's choice (POST
/label-runs/{id}) starts the run, or not. A run that apply_label started and that goes on after its short wait gets a
`label_run` row too. Either way the row shows the run while it goes (GET /label-runs/{id}: how many units are done) and
how it ended, and the chat's agent hears both with the analyst's next message (agent.tell).

The records of one run share its id; each later one is the row's new state: `asked`, `running`, `done`, `failed`,
`stopped` or `cancelled`. Each carries `text`, the one line the row shows.
"""
from __future__ import annotations

import asyncio
import math
import random
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Body, HTTPException

from .. import chats, home, settings
from . import classify, run, store
from . import estimate as E

SAMPLE = E.SAMPLE  # the units "Run on a sample" reads, chosen at random; a prompt label over more asks first
# what a call costs, per million tokens: (input, output). A model not named here gets no price in the estimate.
PRICES = {"claude-opus-5-5": (4.0, 20.0), "claude-opus-5": (5.0, 25.0), "claude-opus-4-8": (5.0, 25.0),
          "claude-sonnet-5-5": (2.0, 10.0), "claude-sonnet-5": (2.0, 10.0), "claude-haiku-5-5": (0.1, 0.5),
          "claude-haiku-4-5": (1.0, 5.0), "claude-fable-5-1": (10.0, 50.0), "claude-fable-5": (10.0, 50.0)}
# before a label has run, the estimate assumes these (measured on JSON lines records): characters per input token,
# output tokens per unit (and more with a reason), and a call's seconds, fixed plus per output token
CHARS_PER_TOKEN = 3.2
OUT_PER_UNIT = 18
OUT_PER_REASON = 30
CALL_FIXED_S = 2.5
CALL_PER_OUT_S = 1 / 110
_lock = threading.Lock()


# ---- the size of a run

def estimate(concept: dict[str, Any], found: list[Any]) -> dict[str, Any]:
    """What reading `found` with the label's model takes: {units, calls, input_tokens, output_tokens, seconds,
    dollars (None for a model with no known price)}. It starts from the real batches (classify.batches) and, once the
    label has run, from what its last run read and how long it took."""
    calls = len(classify.batches(found))
    chars = sum(min(len(u.text or ""), classify.RECORD_CHARS) for u in found)
    system = len(classify.system_prompt(concept))
    per_char, out_unit = 1 / CHARS_PER_TOKEN, OUT_PER_UNIT + (OUT_PER_REASON if concept.get("comment") else 0)
    call_s = None
    last = next((a for a in reversed(concept.get("applications") or [])
                 if a.get("usage") and a.get("version") == concept.get("version") and a.get("chars")), None)
    if last:
        u = last["usage"]
        read = u["input_tokens"] + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
        per_char = max(read - u["calls"] * system / CHARS_PER_TOKEN, 1) / last["chars"]
        out_unit = u["output_tokens"] / max(last.get("labeled") or last.get("total") or 1, 1)
        if last.get("seconds") and last.get("concurrency"):
            waves = math.ceil(u["calls"] / last["concurrency"])
            call_s = last["seconds"] / max(waves, 1)
    input_tokens = int(chars * per_char + calls * system / CHARS_PER_TOKEN)
    output_tokens = int(len(found) * out_unit)
    if call_s is None:
        call_s = CALL_FIXED_S + output_tokens / max(calls, 1) * CALL_PER_OUT_S
    seconds = math.ceil(calls / run.CONCURRENCY) * call_s
    model = concept.get("model") or settings.read()["model"]
    price = PRICES.get(model)
    dollars = None if price is None else (input_tokens * price[0] + output_tokens * price[1]) / 1e6
    return {"units": len(found), "calls": calls, "input_tokens": input_tokens, "output_tokens": output_tokens,
            "seconds": round(seconds, 1), "dollars": None if dollars is None else round(dollars, 2)}


def needs_asking(est: dict[str, Any]) -> bool:
    """Whether a prompt label's run asks first: more units than a sample (estimate.py, the plugin's rule too)."""
    return E.needs_asking(est["units"])


def _words(unit: str, n: int) -> str:
    from .chat import _units  # noqa: PLC0415 — chat imports this module

    return f"{n:,} {_units(unit, n)}"


def size_line(concept: dict[str, Any], est: dict[str, Any], where: str) -> str:
    """What the run reads, which is certain: "Read 14,591 records of revisions.jsonl with Claude". The line under the
    choices is calls_line(): its model calls, the one exact number (time and cost are rough, so the ask leaves them
    out)."""
    return f"Read {_words(concept['unit'], est['units'])}{where} with Claude"


def calls_line(est: dict[str, Any]) -> str:
    """"292 model calls": the run's real batches."""
    return E.calls_line(est["calls"])


# ---- the chat's records

def _asks_dir(ws: str) -> Path:
    d = store.root(ws) / "asks"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read(ws: str, rid: str) -> dict[str, Any] | None:
    if not home.NAME_RE.match(rid):
        return None
    got = home.read_json(_asks_dir(ws) / f"{rid}.json")
    return got if isinstance(got, dict) else None


def _save(ws: str, ask: dict[str, Any]) -> None:
    home.write_json(_asks_dir(ws) / f"{ask['id']}.json", ask)


def _record(ws: str, ask: dict[str, Any], state: str, text: str, **extra: Any) -> None:
    """The row's new state, in the chat the run belongs to."""
    ask.update(state=state, text=text, **extra)
    _save(ws, ask)
    store.notify(ws, ask["concept"], "ask", rows=False)  # the page reads the label again: its editor shows the ask
    rec = {"type": "label_run", "id": ask["id"], "concept": ask["concept"], "name": ask["name"], "state": state,
           "text": text, **extra}
    if state == "asked":
        rec.update(units=ask["units"], sample=min(SAMPLE, ask["units"]), meta=calls_line(ask["estimate"]))
    if not ask.get("chat"):  # the label editor's ask: the editor shows it, and no chat has a row of it
        return
    try:
        chats.append(ws, ask["chat"], rec)
    except (KeyError, OSError):
        pass


def pending(ws: str, cid: str) -> dict[str, Any] | None:
    """The ask about label `cid`'s current definition that waits for the analyst's choice, if any."""
    concept = store.read(ws, cid)
    if concept is None:
        return None
    for p in sorted(_asks_dir(ws).glob("r*.json")):
        a = home.read_json(p)
        if isinstance(a, dict) and a.get("concept") == cid and a.get("state") == "asked" \
                and a.get("version") == concept["version"]:
            return a
    return None


def ask(ws: str, chat: str | None, concept: dict[str, Any], *, paths: list[str], est: dict[str, Any],
        where: str) -> dict[str, Any]:
    """Ask the analyst before a big run: the `asked` row, with the run's size and its three choices; with no `chat`, the
    label editor's ask, which only the editor shows."""
    a = {"id": "r" + secrets.token_hex(4), "chat": chat, "concept": concept["id"], "name": concept["name"],
         "version": concept["version"], "paths": list(paths), "units": est["units"], "estimate": est, "where": where,
         "asked": home.now()}
    _record(ws, a, "asked", size_line(concept, est, where) + ".")
    return a


def follow(ws: str, chat: str, concept: dict[str, Any], rec: dict[str, Any], where: str) -> dict[str, Any]:
    """A run apply_label started goes on after its wait: a `running` row, and the chat hears how it ends."""
    a = {"id": "r" + secrets.token_hex(4), "chat": chat, "concept": concept["id"], "name": concept["name"],
         "version": concept["version"], "paths": list(rec.get("paths") or []), "units": rec.get("total") or 0,
         "where": where, "asked": None}
    rec["follow"] = {"id": a["id"], "chat": chat}
    _record(ws, a, "running", running_line(concept, rec, where), total=rec.get("total") or 0)
    return a


def running_line(concept: dict[str, Any], rec: dict[str, Any], where: str) -> str:
    return f"Reading {_words(concept['unit'], rec.get('total') or 0)}{where} with Claude"


def _ended(ws: str, cid: str, rec: dict[str, Any]) -> None:
    """run.ON_END: the row of a run a chat follows says how it ended, and the chat's agent hears it next turn."""
    f = rec.get("follow")
    if not f:
        return
    a = _read(ws, f["id"])
    concept = store.read(ws, cid)
    if a is None or concept is None:
        return
    from . import chat  # noqa: PLC0415 — chat imports this module

    counts, _ = store.effective_counts(ws, cid)
    shown = " · ".join(f"{v} {counts.get(v, 0):,}" for v in concept["labels"])
    n = rec.get("done") or 0
    if rec.get("status") == "error":
        state, text = "failed", f"The label {concept['name']} failed: {rec.get('message') or 'no reason given'}. " \
                                f"Ask Claude to run it again, or run it from its card."
    elif rec.get("stopped"):
        state, text = "stopped", f"Stopped after {_words(concept['unit'], n)}: {shown}."
    else:
        state = "done"
        text = f"Read {_words(concept['unit'], rec.get('total') or 0)}{a.get('where') or ''}: {shown}."
        if rec.get("failed"):
            text += f" {rec['failed']:,} got no value: {rec.get('message') or 'no reason given'}."
    _record(ws, a, state, text, done=n, total=rec.get("total") or 0, failed=rec.get("failed") or 0)
    if rec.get("told"):
        return
    words = chat.summary(ws, cid, rec, paths=a.get("paths") or [], unchanged=False)
    _tell(ws, a["chat"], f"The run of the label {concept['name']} ended. {words}")


def _tell(ws: str, chat: str | None, text: str) -> None:
    if not chat:  # the analyst ran it from the label editor: no chat's agent waits to hear of it
        return
    from .. import agent  # noqa: PLC0415 — agent imports the features

    agent.tell(ws, chat, text)


def where_of(unit: str, paths: list[str]) -> str:
    """The files a run reads, as its line names them: " of runs/*.jsonl", or nothing for every file."""
    return f" of {', '.join(paths)}" if unit in store.FILE_UNITS and paths and paths not in (["**/*"], ["*"]) else ""


def shown(a: dict[str, Any]) -> dict[str, Any]:
    """An ask as the label editor shows it (the same fields as the chat's `asked` row)."""
    return {"id": a["id"], "concept": a["concept"], "name": a["name"], "state": a.get("state"), "text": a.get("text"),
            "units": a["units"], "sample": min(SAMPLE, a["units"]),
            "meta": calls_line(a["estimate"]) if a.get("estimate") else None}


run.ON_END.append(_ended)


# ---- the analyst's choice

async def answer(ws: str, folder: Path, rid: str, choice: str) -> dict[str, Any]:
    """Run all, Run on a sample, or Cancel, for the ask `rid`; the ask as it is now. LabelError for an ask that was
    answered already, or a label that changed since."""
    with _lock:
        a = _read(ws, rid)
        if a is None:
            raise KeyError(f"no label run {rid!r}")
        if a.get("state") != "asked":
            raise store.LabelError(f"this run was answered already ({a.get('state')})")
        a["state"] = "answering"
        _save(ws, a)
    concept = store.read(ws, a["concept"])
    if concept is None or concept["version"] != a["version"]:
        _record(ws, a, "cancelled", f"Not run: the label {a['name']} changed or was deleted since.")
        raise store.LabelError("the label changed or was deleted since Claude asked")
    if choice == "cancel":
        _record(ws, a, "cancelled", f"Not run: it would read {_words(concept['unit'], a['units'])}{a.get('where') or ''}.")
        _tell(ws, a["chat"], f"The analyst chose not to run the label {concept['name']} [↗](concept:{concept['id']}) "
                             f"over its {a['units']:,} units.")
        return a
    found = await asyncio.to_thread(run.scope_units, ws, folder, concept, a["paths"], None)
    limit = None
    if choice == "sample" and len(found) > SAMPLE:
        found = random.sample(found, SAMPLE)
        limit = SAMPLE
    try:
        rec = await run.start(ws, folder, concept, paths=a["paths"], limit=limit,
                              created_by=f"chat:{a['chat']}" if a.get("chat") else "user", found=found,
                              follow={"id": rid, "chat": a.get("chat")})
    except store.LabelError as e:
        _record(ws, a, "failed", f"The label {concept['name']} did not start: {e}.")
        raise
    what = "all of them" if limit is None else f"a random sample of {limit:,}"
    _record(ws, a, "running", running_line(concept, rec, a.get("where") or ""), total=rec["total"], choice=choice)
    _tell(ws, a["chat"], f"The analyst chose to run the label {concept['name']} [↗](concept:{concept['id']}) on {what}"
                         f" ({rec['total']:,} units). Its counts reach you when it ends.")
    return a


def progress(ws: str, rid: str) -> dict[str, Any]:
    """The row's live state: how many units of the run are done, and how many calls go at once."""
    a = _read(ws, rid)
    if a is None:
        raise KeyError(f"no label run {rid!r}")
    rec = run.record(ws, a["concept"]) or {}
    out = {"id": rid, "state": a.get("state"), "text": a.get("text")}
    if (rec.get("follow") or {}).get("id") == rid:
        elapsed = rec.get("seconds") if rec.get("status") != "running" else time.monotonic() - rec.get("t0", 0.0)
        out.update(status=rec.get("status"), done=rec.get("done") or 0, total=rec.get("total") or 0,
                   failed=rec.get("failed") or 0, pace=rec.get("pace"), seconds=round(elapsed or 0.0, 1))
    return out


def register_routes(ctx: Any) -> None:
    app, ws_of, folder_of = ctx.app, ctx.ws_of, ctx.folder_of

    @app.post("/api/ws/{c}/label-runs/{rid}")
    async def label_run_answer(c: str, rid: str, body: dict = Body(...)) -> dict[str, Any]:
        choice = str(body.get("choice") or "")
        if choice not in ("all", "sample", "cancel"):
            raise HTTPException(400, "choice: all, sample or cancel")
        try:
            a = await answer(ws_of(c), folder_of(c), rid, choice)
        except KeyError as e:
            raise HTTPException(404, str(e).strip("'\"")) from None
        except store.LabelError as e:
            raise HTTPException(409, str(e)) from None
        return {"id": a["id"], "state": a.get("state")}

    @app.get("/api/ws/{c}/label-runs/{rid}")
    def label_run_progress(c: str, rid: str) -> dict[str, Any]:
        try:
            return progress(ws_of(c), rid)
        except KeyError as e:
            raise HTTPException(404, str(e).strip("'\"")) from None

