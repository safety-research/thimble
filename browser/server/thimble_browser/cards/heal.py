"""The citation healing pass of the browser workbench: the terminal plugin's pass (plugin/engine/kernel/heal.py) over
the citations of a card's values, `[31](card:<id>#<column>/<row>)`. Deterministic, with no model call.

For each citation whose words state a value its cited cell does not show:
  (a) the cited card's tables and charts are searched for the value, and the citation is re-pointed only when one place
      is singled out: the only cell that shows it, else the only one in the cited row, else in the cited column;
  (b) else the other cards the text cites, when one cell of one of them shows it;
  (c) else it is contradicted when the cited cell shows another number (`why` says which);
  (d) else (the card, the row or the column is gone) it is quiet: the page draws it grey.
A citation of a whole card is checked for the card alone; a citation of a file is left as it is. The words of the text
are never changed. `version` hashes the text and the cited cards' outputs, so a caller heals a text once per version.

Only the standard library.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Callable

from . import cite, frames

LINK = re.compile(r"\[([^\]\n]+)\]\(([^)\n]+)\)")
CARD_REF = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)(?:#([^/\s]+)/(.+))?$")
DIGIT = re.compile(r"\d")

LINKED, QUIET, CONTRADICTED = "linked", "quiet", "contradicted"
KEPT, CELL, CITED, GONE, NO_HOME, SEVERAL = "kept", "cell", "cited", "gone", "no_home", "several"

Loader = Callable[[str], "dict | None"]


def _places(cell: dict | None) -> list[tuple[str, str, str]]:
    """(column, row, value as shown) of every value with a digit that the card's tables and charts show."""
    out: list[tuple[str, str, str]] = []
    for f in cite.frames_of((cell or {}).get("outputs")):
        for c, r, v in frames.frame_cells({frames.FRAME_MIME: f}) or []:
            if DIGIT.search(str(v)):
                out.append((str(c), str(r), str(v)))
    return out


def cited_cards(text: str) -> list[str]:
    out: list[str] = []
    for m in LINK.finditer(text or ""):
        p = CARD_REF.match(m[2].strip())
        if p and p[1] not in out:
            out.append(p[1])
    return out


def version(text: str, load: Loader) -> str:
    h = hashlib.sha1((text or "").encode("utf-8", "surrogatepass"))
    for cid in sorted(cited_cards(text)):
        cell = load(cid)
        outs = json.dumps((cell or {}).get("outputs"), sort_keys=True, default=str)[:200000]
        h.update(f"|{cid}:{hashlib.sha1(outs.encode()).hexdigest()[:12]}".encode())
    return h.hexdigest()[:12]


def _pick(hits: list[tuple[str, str, str]], col: str | None, row: str | None) -> tuple[str, str, str] | None:
    if len(hits) == 1:
        return hits[0]
    for same in ([h for h in hits if h[1] == row], [h for h in hits if h[0] == col]):
        if len(same) == 1:
            return same[0]
    return None


def heal(text: str, load: Loader) -> dict[str, Any]:
    """The pass over one text: {text, changes, of, version}, each change {label, ref, state, how, to?, source?, why?}.
    `load(card_id)` gives the card with its outputs, or None when it is gone."""
    text = text or ""
    cache: dict[str, dict | None] = {}

    def card(cid: str) -> dict | None:
        if cid not in cache:
            try:
                cache[cid] = load(cid)
            except Exception:  # noqa: BLE001 — a card that cannot be read is one that is gone
                cache[cid] = None
        return cache[cid]

    cited = cited_cards(text)
    changes: list[dict[str, Any]] = []
    out: list[str] = []
    pos = 0
    for m in LINK.finditer(text):
        label, ref = m[1], m[2].strip()
        p = CARD_REF.match(ref)
        if not p:
            continue
        cid, col, row = p[1], p[2], p[3]
        c: dict[str, Any] = {"label": label, "ref": ref, "state": LINKED, "how": KEPT, "to": ref}
        own = card(cid)
        if col is None or not DIGIT.search(label):
            if own is None:
                c.update(state=QUIET, how=GONE, why=f"the card {cid} is gone")
        else:
            shown = cite.find((own or {}).get("outputs"), col, row) if own else None
            at = shown[0] if shown else None
            if at is None or not cite.same_value(at, label):
                hits = [h for h in _places(own) if cite.same_value(h[2], label)] if own else []
                found = _pick(hits, col, row) if hits else None
                how = CELL if found else None
                several = bool(hits) and not found
                if not found and not several:
                    for other in cited:
                        if other == cid:
                            continue
                        more = [h for h in _places(card(other)) if cite.same_value(h[2], label)]
                        if len(more) == 1:
                            found, how, other_id = more[0], CITED, other
                            break
                        if more:
                            several = True
                            break
                if found:
                    target = cid if how == CELL else other_id
                    c.update(how=how, to=f"card:{target}#{found[0]}/{found[1]}")
                elif at is not None and DIGIT.search(at) and not several:
                    c.update(state=CONTRADICTED, how=CONTRADICTED, source=at, why=f"the cited place shows {at}")
                else:
                    how = SEVERAL if several else GONE if at is None else NO_HOME
                    why = (f"several places show {label.strip()}" if several else
                           f"the card {cid} has no {col} for {row}" if at is None else f"no place shows {label.strip()}")
                    c.update(state=QUIET, how=how, why=why)
        changes.append(c)
        out.append(text[pos:m.start()])
        out.append(m[0] if c["to"] == ref or c["state"] != LINKED else f"[{label}]({c['to']})")
        pos = m.end()
    out.append(text[pos:])
    healed = "".join(out)
    of = version(text, card)
    return {"text": healed, "changes": changes, "of": of, "version": of if healed == text else version(healed, card)}
