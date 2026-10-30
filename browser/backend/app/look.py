"""The terminal's look at Claude's answers, run by the workbench: Heads up and Explainers decide their marks on an answer
as the terminal's observer does (plugin/observer/observer.ts), so the two modes mark an answer the same way.

One fork of main's conversation after the answer (marks.run_fork, as the citation check forks it), whose prompt is the
terminal's own frame, turn and lens texts (plugin/prompts/observer.md, observer-turn.md, lens-explain.md,
lens-heads.md), composed by the terminal's own code (look_of.mjs) with the lenses of the checks that are on, so a
heads-up and the explainers are decided together, in one reply. What the reply gives is placed on the answer's words
as the terminal places it (plugin/explain/place.mjs: a heads-up first, and no explainer on its words), each a comment
of its check (checks._looked). The digests say what the chat's comments of those checks already gave.

The turn's values are the workbench's: the answers named as the terminal names them (plugin/observer/messages.mjs),
the cards their turns made as the brief lists them (context.py), and a line each for the keys above the analyst's
prompt and what the session read, which the workbench does not have (prompts/tools.md `look-*`).

    LENS_OF            the checks that are the terminal's lenses, each with its lens
    run(c, lenses, cover) -> {items: [{lens, passage, words, text, details}]} or {error}
"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from . import answer_comments, tools

HERE = Path(__file__).resolve().parent
LOOK_OF = HERE / "look_of.mjs"
LENS_OF = {"heads-up": "heads", "explainers": "explain"}  # the order a look's lenses take
GLOSSED_KEEP, HEADS_KEEP = 100, 20  # as the terminal's lens digests keep (plugin/explain/lens.mjs)
# a link of the terminal's form, `[words](path#L12-20)`, in an explainer's or a heads-up's words
_LINK_RE = re.compile(r"\[([^\[\]\n]+)\]\(([^()\s]+)\)")


async def _node(req: dict[str, Any]) -> dict[str, Any]:
    """look_of.mjs on `req`. Node runs in a worker thread, as marks.marks_of runs it (its note says why)."""
    done = await asyncio.to_thread(subprocess.run, ["node", str(LOOK_OF)], input=json.dumps(req).encode(),
                                   capture_output=True)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode(errors="replace").strip()[-300:] or "look_of.mjs failed")
    return json.loads(done.stdout.decode())


def _cite(text: str) -> str:
    """The terminal's links as the workbench's citations: `[words](path#L12-20)` is `words [[path#L12-L20]]`."""
    def one(m: re.Match[str]) -> str:
        ref = m.group(2)
        if re.match(r"(?i)https?:|mailto:|#", ref):
            return m.group(0)
        return f"{m.group(1)} [[{re.sub(r'#L(\d+)-(\d+)$', r'#L\1-L\2', ref)}]]"
    return _LINK_RE.sub(one, str(text or ""))


def _msgs(c: str, answers: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    """The answers as the terminal's look names them ({kind, text, turnNo, prompt}), and the cards their turns made."""
    from . import context  # noqa: PLC0415

    turns = context._main_turns(c)
    cards = context._cards_by_id(c) if turns else {}
    msgs, objects = [], []
    for a in answers:
        found = sorted(context._of_answers(turns, [a]))
        i = found[0] if found else None
        said = turns[i].said if i is not None else []
        first = next((e for e in said if e.head == "[analyst]"), said[0] if said else None)
        by = ("composer" if first is not None and first.head == "[analyst]"
              else "notification" if first is not None and first.head.startswith("[notification") else "event")
        msgs.append({"kind": "answer", "text": "\n\n".join(str(r.get("text") or "") for r in a.get("rows") or []),
                     "turnNo": (i + 1) if i is not None else len(turns), "prompt": {"text": first.body if first else "",
                                                                                      "by": by}})
        if i is not None:
            objects += [context._card_line(cards.get(r.split(":", 1)[1]), r, None) for r in context._turn_cards(turns[i])]
    return msgs, "\n".join(dict.fromkeys(objects)) or tools.hint("look-no-cards")


def _state(c: str, covered: set[str]) -> dict[str, list[str]]:
    """What the chat's explainers and heads-ups already gave, oldest first, as the terminal's digests read it: an
    explainer's words, a heads-up's statement. The comments on the passages a look covers are left out, since its run
    replaces them."""
    glossed, heads = [], []
    for cm in sorted(answer_comments._read(c), key=lambda x: str(x.get("ts") or "")):
        if cm.get("resolution") == answer_comments.RESOLUTION_SUPERSEDED or cm.get("ref") in covered:
            continue
        if cm.get("check") == "explainers":
            glossed.append(str(cm.get("words") or str(cm.get("text") or "").split(":", 1)[0]).strip())
        elif cm.get("check") == "heads-up":
            heads.append(" ".join(str(cm.get("text") or "").split()))
    return {"glossed": [g for g in glossed if g][-GLOSSED_KEEP:], "headsGiven": [h for h in heads if h][-HEADS_KEEP:]}


async def run(c: str, lenses: list[str], cover: list[dict[str, Any]]) -> dict[str, Any]:
    """The look at the answers of `cover` (answer_comments' passages) with `lenses`: each mark it gives, on the passage
    and words of the answer it stands on, with the comment's statement and details, or {error} saying why there is
    none."""
    from . import marks  # noqa: PLC0415 — the fork of main the citation check also takes

    turns = {p["turn"] for p in cover}
    answers = [a for a in answer_comments.answers(c) if a["turn"] in turns]
    if not answers:
        return {"error": "the answer is no longer kept"}
    msgs, objects = _msgs(c, answers)
    state = _state(c, {p["ref"] for p in cover})
    prompt = (await _node({"prompt": {"lenses": lenses, "msgs": msgs, "row": tools.hint("look-keys"),
                                      "objects": objects, "coverage": tools.hint("look-read"), "state": state}}))["prompt"]
    main = marks._main_now(c)
    if isinstance(main, str):
        return {"error": main}
    got = await marks.run_fork(c, main[0], main[1], prompt)
    if got.get("error") and not got.get("answer"):
        return {"error": str(got["error"])}
    rows = [{"row": f"{a['turn']}|{r['uuid']}", "text": str(r.get("text") or "")} for a in answers for r in a["rows"]]
    placed = (await _node({"place": {"lenses": lenses, "rows": rows, "reply": str(got.get("answer") or ""),
                                     "state": state}}))["items"]
    if placed is None:
        return {"error": "its reply could not be read"}
    texts = {r["row"]: r["text"] for r in rows}
    items = []
    for it in placed:
        turn, _, row = str(it["row"]).partition("|")
        p = next((q for q in cover if q["turn"] == turn and q["row"] == row and q["start"] <= it["start"] < q["end"]), None)
        words = answer_comments.words_in(p, texts[it["row"]][it["start"]:it["end"]]) if p is not None else None
        if p is None or words is None:
            continue
        if it["kind"] == "heads":
            text, details = it["title"] or it["term"], " ".join(_cite(b) for b in it["bullets"])
        else:
            text, details = f"{it['term']}: {it['body']}", _cite(it["here"])
        items.append({"lens": it["kind"], "passage": p, "words": words, "text": _cite(text), "details": details})
    return {"items": items}
