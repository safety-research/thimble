"""The citation healing pass of the browser workbench: the terminal plugin's pass (plugin/engine/kernel/heal.py) over
the citations of a card's values, `[31](card:<id>#<column>/<row>)`. Deterministic, with no model call.

For each citation whose words state a value its cited cell does not show:
  (a) the cited card's tables and charts are searched for the value, and the citation is re-pointed only when one place
      is singled out: the only cell that shows it, else the only one in the cited row, else in the cited column;
  (b) else the other cards the text cites, when one cell of one of them shows it;
  (c) else it is contradicted when the cited cell shows another number (`why` says which);
  (d) else (the card, the row or the column is gone) it is quiet: the page draws it grey.
A citation of a part a program draws, `card:<id>#<part id>`, is checked against the part: its numbers are read from
the part's label and the text it draws (a plot series' from its points, not its name), and the citation is
contradicted when the part shows numbers and none is the one its words state. A date is one value, compared as a date
(`22 June` states 2026-06-22); a date is never read as its year, so words whose only number is in a date are checked
only against a part that shows a date. A part id the kit renamed (one written with a slash) is found by its slug, as
kit.js writes it.
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

CARD_REF = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)(?:#(.+))?$")
COL = re.compile(r"[^/\s]+")
DIGIT = re.compile(r"\d")
# a number as words show it, with the sign they write for it (cite.sign_at), not the digits inside a name such as
# LinkHelper771 or a date's parts
NUMBER = re.compile(r"(?:(?<![A-Za-z_\d.,:])[-−+]|(?<![\w.\-]))\d[\d,]*(?:\.\d+)?(?![\w])")
KIT_MIME = cite.KIT_MIME
# a date as words write it: 2026-06-22 (one value, never its year), 22 June [2026], June 22[, 2026]; and 06-22 when the
# part it is checked against shows dates (alone, 10-14 is as often a range)
_MONTH = (r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|"
          r"Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?(?![A-Za-z])")
MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
ISO_DATE = re.compile(r"(?<![\d.\-])(\d{4})-(\d{2})-(\d{2})(?!\d)")
DAY_MONTH = re.compile(rf"(?<![\w.,\-])(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?{_MONTH}(?:,?\s+(\d{{4}})(?!\d))?")
MONTH_DAY = re.compile(rf"(?<![A-Za-z]){_MONTH}\s+(\d{{1,2}})(?:st|nd|rd|th)?(?![\d,.]\d|\d)(?:,?\s+(\d{{4}})(?!\d))?")
MONTH_DASH_DAY = re.compile(r"(?<![\w.,\-])(\d{2})-(\d{2})(?![\w\-]|\.\d)")
Date = tuple  # (year or None, month, day)

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


def _draws(cell: dict | None) -> bool:
    """Whether a program draws the card (its parts are cited as `card:<id>#<part id>`, never as a column and a row)."""
    return bool(cell) and (cell.get("kind") == "program" or any(isinstance(o, dict) and KIT_MIME in o for o in cell.get("outputs") or []))


def _rounds_to(shown: str, stated: str) -> bool:
    """Whether a number a part shows is the one the words state, at the words' precision: 98.39 is "98.4". A stated
    number with no sign of its own states the shown one's size, either sign; one with a sign states the sign too."""
    a, b = (x.replace(",", "").replace(frames.MINUS, "-") for x in (shown, stated))
    try:
        places = len(b.partition(".")[2])
        v = float(a) if b[:1] in ("-", "+") else abs(float(a))
        return round(v, places) == float(b)
    except ValueError:
        return a == b


def _values(words: str, month_day: bool = False) -> tuple[list[str], list[tuple[Date, str]]]:
    """(numbers, dates) that words state or a part shows. Each date is ((year or None, month, day), as written), and
    its digits are no number: 2026-06-22 is one date, not 2026. `month_day` reads 06-22 as a date too."""
    dates: list[tuple[Date, str]] = []
    spans: list[tuple[int, int]] = []

    def take(m: re.Match, y: str | None, mo: int, d: str) -> None:
        a, b = m.span()
        if 1 <= mo <= 12 and 1 <= int(d) <= 31 and not any(a < e and s < b for s, e in spans):
            dates.append(((int(y) if y else None, mo, int(d)), m.group(0).strip()))
            spans.append((a, b))

    for m in ISO_DATE.finditer(words):
        take(m, m[1], int(m[2]), m[3])
    for m in DAY_MONTH.finditer(words):
        take(m, m[3], MONTHS[m[2][:3].lower()], m[1])
    for m in MONTH_DAY.finditer(words):
        take(m, m[3], MONTHS[m[1][:3].lower()], m[2])
    if month_day:
        for m in MONTH_DASH_DAY.finditer(words):
            take(m, None, int(m[1]), m[2])
    rest = list(words)
    for a, b in spans:
        rest[a:b] = " " * (b - a)
    return NUMBER.findall("".join(rest)), dates


def _same_day(stated: Date, shown: Date) -> bool:
    """Whether a stated date is the shown one: the same month and day, and the same year when both name one."""
    return stated[1:] == shown[1:] and (stated[0] is None or shown[0] is None or stated[0] == shown[0])


def _num(v: float) -> str:
    return f"{int(v):,}" if float(v).is_integer() else repr(float(v))


def _part(own: dict | None, anchor: str, label: str) -> dict[str, Any] | None:
    """What the pass says of a citation of a drawn part: None when the card draws no such part, else the fields of its
    change. The citation holds when a number or a date the part shows is one its words state; it is contradicted when
    the part shows values of the kind the words state (numbers, or dates) but not one of them."""
    outputs = (own or {}).get("outputs")
    r = cite.region(outputs, anchor)
    if r is None:
        return None
    meta = r.get("meta") if isinstance(r.get("meta"), dict) else {}
    series = cite.series_values(outputs, anchor)
    if series is not None:
        shown, days, named = [_num(v) for v in series], [], ([], [])
    else:
        shown, days = _values(cite.region_words(outputs, anchor))
        named = _values(str(meta.get("label") or ""))
    stated, said = _values(label, month_day=bool(days))
    by_number, by_date = bool(stated and shown), bool(said and days)
    if not (by_number or by_date):
        return {}
    if (by_number and any(_rounds_to(n, s) for s in stated for n in shown)) or \
            (by_date and any(_same_day(a, b) for a, _ in said for b, _ in days)):
        return {}
    at = ([w for _, w in (named[1] or days)] if by_date else []) + ((named[0] or shown) if by_number else [])
    at = list(dict.fromkeys(at))
    if series is not None and len(at) > 3:
        lo, hi = min(series), max(series)
        source = f"{_num(lo)} to {_num(hi)}"
    else:
        source = ", ".join(at)
    return {"state": CONTRADICTED, "how": CONTRADICTED, "source": source, "why": f"the cited part shows {source}"}


def cited_cards(text: str) -> list[str]:
    out: list[str] = []
    for _words, target, _a, _b in cite.link_spans(text or ""):
        p = CARD_REF.match(target.strip())
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
    for label, target, start, end in cite.link_spans(text):
        ref = target.strip()
        p = CARD_REF.match(ref)
        if not p:
            continue
        cid, frag = p[1], p[2]
        c: dict[str, Any] = {"label": label, "ref": ref, "state": LINKED, "how": KEPT, "to": ref}
        own = card(cid)
        part = _part(own, frag, label) if frag and _draws(own) else None
        col, _, row = (frag or "").partition("/")
        if part is not None:
            c.update(part)
        elif frag and not (row and COL.fullmatch(col)):
            # an anchor that names no column and row: a part, or nothing this pass reads
            if own is None:
                c.update(state=QUIET, how=GONE, why=f"the card {cid} is gone")
            elif not _draws(own):
                continue
            else:
                c.update(state=QUIET, how=GONE, why=f"the card draws no part {frag}")
        elif not frag or not DIGIT.search(label):
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
                           f"the card draws no part {col}/{row}" if at is None and _draws(own) else
                           f"the card {cid} has no {col} for {row}" if at is None else f"no place shows {label.strip()}")
                    c.update(state=QUIET, how=how, why=why)
        changes.append(c)
        out.append(text[pos:start])
        out.append(text[start:end] if c["to"] == ref or c["state"] != LINKED else f"[{label}]({c['to']})")
        pos = end
    out.append(text[pos:])
    healed = "".join(out)
    of = version(text, card)
    return {"text": healed, "changes": changes, "of": of, "version": of if healed == text else version(healed, card)}
