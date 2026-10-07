"""Citation resolver: turns the numbers in a card's takeaway into provenance links to the output that shows them, and
reports the ones it cannot link.

A number that appears once, verbatim, in a captured output (a table <td>, a chart's inline row, or a line of shell
text) links to that span (tier 2); a number with no unique source stays plain and is returned so the caller can mark
it (tier 3). Existing [[...]] markup is masked. A value-ref that cites the card itself is re-pointed at the one td or
output line holding its value, or unwrapped when that place is not unique. Pure and stateless. The spans it emits:
  card:<id>#<col>/<row>     the td at column header <col> and row label <row> of a table output, or of a chart's
                            inline rows (chart_table)
  card:<id>@out<i>#L<n>     line <n> (1-based) of the text/plain of the output bundle with index <i>
The index is the bundle's stored `_out` when it has one, else its position. A value in a table is written by column and
row label, since the labels survive a re-render and line numbers may not. Labels go through encode_label, which
percent-encodes the characters that would break the ref grammar, the [[value|ref]] markup or markdown; decode_label is
urllib's unquote, so a raw label reads back unchanged.
"""
from __future__ import annotations

import html as _html
import json
import re
from dataclasses import dataclass, field
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Iterator
from urllib.parse import unquote

from . import frames

# A number token: optional sign, digits with optional thousands commas, optional decimals, optional trailing %. Not
# preceded by a word char or ref punctuation (digits inside cell:ab12, L44, out3), and not followed by a word char, "%"
# or ":", since the hour of a clock time ("16:51") is not a quantity. The sign may be the typographic minus (U+2212) the
# models write in prose; _norm maps it to `-`.
_NUM_RE = re.compile(r"(?<![\w:./#\-\u2212])[-\u2212]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\w%:])")
# existing [[ref]] / [[display|ref]] markup (same shape as refs._BRACKETS and the frontend's splitValueRef)
_SPAN_RE = re.compile(r"\[\[([^\[\]]+?)\]\]")
# the unit word right after a number ("16 runs", "3 agents"): one alphabetic word, so the pair can be looked up as one
# token when the bare number is too small or too common to link alone
_UNIT_RE = re.compile(r"[ \t]+([A-Za-z][A-Za-z_-]{1,30})\b")

# A card's ref is `card:<id>`, with a span after it. `cell:` is accepted as an alias, so every reader takes both prefixes
# and every writer writes `card:`. CARD_RE is the prefix inside a pattern.
CARD = "card:"
CARD_PREFIXES = ("card:", "cell:")
CARD_RE = r"(?:card|cell):"


def is_card_ref(ref: object) -> bool:
    """Whether `ref` is a card's ref, by either prefix."""
    return isinstance(ref, str) and ref.startswith(CARD_PREFIXES)


def canon(ref: str) -> str:
    """`ref` with a leading `cell:` written as `card:`; any other string unchanged."""
    return CARD + ref[len("cell:"):] if isinstance(ref, str) and ref.startswith("cell:") else ref


_OLD_CARD_IN_TEXT = re.compile(r"(?<![\w:/.-])cell:(?=[A-Za-z0-9_-])")


def canon_text(text: str) -> str:
    """Stored text (a takeaway, a document's passage, a thread's anchor) with every card ref written `card:`, for what a
    model or the analyst reads now; the stored text keeps what was written, and both forms open."""
    return _OLD_CARD_IN_TEXT.sub(CARD, text) if isinstance(text, str) and "cell:" in text else text


def strip_card(ref: object) -> str:
    """`ref` without its `card:` or `cell:` prefix, stripped; '' for anything that is not a string."""
    s = str(ref or "").strip()
    return s[len(CARD):] if s.startswith(CARD_PREFIXES) else s


# a td span of ANY cell, read loosely (col: up to the first '/', spaces allowed; row: the rest) so a raw-labelled span the
# model typed can be put in the grammar's encoded form; refs._CELL_TD is the strict grammar
_ANY_TD = re.compile(r"^" + CARD_RE + r"([A-Za-z0-9_-]+)#([^/]+)/(.+)$")
_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL_RE = re.compile(r"<(t[dh])[^>]*>(.*?)</\1>", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")
# Characters a td label cannot carry raw: the grammar's own separators and `%`, the [[…|…]] markup's, and the CommonMark /
# GFM inline syntax the takeaway is rendered through (emphasis, strikethrough, code, links, escapes, raw html, entities).
# Whitespace and control characters go with them. Everything else — letters of any script, digits, `.,:;-+=()!?'@$^` —
# stays readable in the ref.
_LABEL_ESCAPE = frozenset('%/|#[]*_~`\\<>&')


# what _norm reads as one number once commas and a percent sign are off: ASCII digits, an optional sign and decimal point,
# no leading zero (`007` is an id, not 7), no exponent, no `+`, no `_` — the forms _NUM_RE finds in prose and a table's
# `29.0` / `-12.0` / `.5`; anything else (`1e3`, `+12`, `1_000`, Arabic-Indic digits) compares as the text it is
_PLAIN_NUM_RE = re.compile(r"[-\u2212]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)")


def _norm(tok: str) -> str:
    """A number's comparison key: its value, so `29`, `29.0` and `29.00` are one key (`29`), `1,234` and `1234` are
    one (`1234`), `0.50` and `.5` are `0.5`, `-12.0` is `-12`, `-0` is `0`; thousands commas and a trailing percent are
    dropped. A string that is not one plain number (a display like `16 runs`; `1e3`, `+12`, `007` — _PLAIN_NUM_RE) is
    returned with its commas and percent dropped."""
    s = tok.replace(",", "").replace("\u2212", "-").rstrip("%").strip()
    if not _PLAIN_NUM_RE.fullmatch(s):
        return s
    try:
        d = Decimal(s)
    except (InvalidOperation, ValueError):
        return s
    return format(d.normalize() if d != 0 else Decimal(0), "f")


def _num_parts(s: str) -> tuple[Decimal, int] | None:
    """(the value, its decimals as written) of one plain number, commas, a sign and a trailing percent read as _norm
    reads them; None for anything else."""
    t = s.strip().replace(",", "").replace("\u2212", "-").rstrip("%").strip()
    if not _PLAIN_NUM_RE.fullmatch(t):
        return None
    try:
        return Decimal(t), (len(t.split(".", 1)[1]) if "." in t else 0)
    except (InvalidOperation, ValueError):
        return None


def shown_matches(token: str, shown: str, *, negative_ok: bool = False) -> bool:
    """Whether a number as prose states it cites a value as the card shows it: the same value, or the shown value with
    only shown decimals dropped by rounding, so "91%" cites a value shown as 91.2% and "0.91" one shown as 0.912, while
    "6,500" does not cite 6,543 and "0.9123" does not cite 0.912. A tie rounds either way (JS rounds half away from
    zero, Python to even). Commas and a percent sign are formatting, as in _norm; `negative_ok` (the prose says it is a
    decrease, says_decrease) lets an unsigned number cite the value with a minus. Anything that is not a plain number
    compares by _norm."""
    a, b = _num_parts(token), _num_parts(shown)
    if a is None or b is None:
        return bool(_norm(token)) and _norm(token) == _norm(shown)
    (va, da), (vb, db) = a, b
    wants = [va, -va] if negative_ok and va > 0 else [va]
    for want in wants:
        if want == vb:
            return True
        if da < db:
            q = Decimal(1).scaleb(-da)
            if want in (vb.quantize(q, rounding=ROUND_HALF_UP), vb.quantize(q, rounding=ROUND_HALF_EVEN)):
                return True
    return False


# A clock time as prose and outputs write it: `9:38`, `09:38`, `09:38:00`, `09:38:00.5` (the seconds' fraction is
# not compared). _NUM_RE leaves clock times alone, so a display such as `09:38` or `00:56–01:00` holds no number.
_CLOCK_RE = re.compile(r"(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?![\d:])")


def clocks_in(display: str, text: str) -> bool:
    """Whether every clock time the display writes is a clock time of `text`: the same hour and minute, and the same
    second when the display gives one, so `09:38` cites a cell showing `09:38:00` or `9:38`, and `00:56–01:00` a range
    of lines showing both. True for a display that writes no clock time."""
    have = {(int(h), m, s) for h, m, s in _CLOCK_RE.findall(text or "")}
    for h, m, s in _CLOCK_RE.findall(display or ""):
        if not any(int(h) == hh and m == mm and (not s or s == ss) for hh, mm, ss in have):
            return False
    return True


QUOTE_MARKS = "\"'“”‘’"


_MONTHS = {m: i for i, names in enumerate((("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"),
                                            ("may",), ("jun", "june"), ("jul", "july"), ("aug", "august"),
                                            ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"),
                                            ("dec", "december")), 1) for m in names}
# a day and a month in words, as prose writes a date: `23 June`, `June 23`, `23rd June`, `Jun. 23`, with or without a
# year (`23 June 2026`, `June 23, 2026`), and with or without a time after it (`4 June 2026 at 10:53:40 UTC`,
# `June 4, 10:53`)
_DAY_MONTH_RE = re.compile(r"^(?:(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?|([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?)"
                           r"(?:,?\s+(\d{4}))?"
                           r"(?:,?\s+(?:at\s+)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*(?:UTC|GMT|Z))?)?$", re.I)
# a date as an output writes it: ISO (`2026-06-23`, also at the head of a time stamp) or a month and day (`06-23`)
_ISO_DATE_RE = re.compile(r"(?<![\d-])(?:(\d{4})-)?(\d{2})-(\d{2})(?![\d-])")
# a date as an output writes it with the time after it, if any (`2026-06-04T10:53:40Z`, `06-23`): what a place shows
# where a date in words is cited (dates_shown)
_STAMP_RE = re.compile(r"(?<![\d-])(?:\d{4}-)?\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?(?![\d-])")
# the time a time stamp writes right after its date (`2026-06-04T10:53:40Z`, `2026-06-04 10:53`)
_STAMP_CLOCK_RE = re.compile(r"[T ](\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])")


def _date_words(display: str) -> tuple[int, int, int | None, str | None] | None:
    """(month, day, year or None, the clock time written after it or None) of a display that is a day and a month in
    words, with or without a year and a time (`23 June`, `4 June 2026 at 10:53:40 UTC`); None for any other display."""
    m = _DAY_MONTH_RE.match(display.strip())
    if not m:
        return None
    day, word = (m[1], m[2]) if m[1] else (m[4], m[3])
    month = _MONTHS.get(word.lower())
    if month is None or not 1 <= int(day) <= 31:
        return None
    return month, int(day), int(m[5]) if m[5] else None, m[6]


def day_month(display: str) -> tuple[int, int, int | None] | None:
    """(month, day, year or None) of a display that is a day and a month in words (`23 June`, `June 23, 2026`, also
    with a time after it); None for any other display."""
    parts = _date_words(display)
    if parts is None:
        return None
    month, day, year, _ = parts
    return month, day, year


# a day and a month in words inside prose, as _DAY_MONTH_RE reads one whole (`23 June`, `June 23, 2026`, `4 June 2026 at
# 10:53:40 UTC`): what _annotate links whole or leaves plain, never splitting its day off as a number
_MONTH_WORD = r"(?:" + "|".join(sorted(_MONTHS, key=len, reverse=True)) + r")"
_DATE_IN_TEXT_RE = re.compile(r"(?<![\w.])(?:\d{1,2}(?:st|nd|rd|th)?\s+" + _MONTH_WORD + r"\b\.?|" + _MONTH_WORD
                              + r"\.?\s+\d{1,2}(?:st|nd|rd|th)?(?![\d:]))"
                              r"(?:,?\s+\d{4}(?!\d))?"
                              r"(?:,?\s+(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:UTC|GMT|Z)\b)?)?", re.I)


def dates_in_text(text: str) -> list[tuple[int, int, str]]:
    """(start, end, words) of each day and month in words a text writes (day_month), with its year and its time when it
    has them."""
    out: list[tuple[int, int, str]] = []
    for m in _DATE_IN_TEXT_RE.finditer(text):
        # a period that ends it ends the sentence (`on 23 June.`), never the month's (`Jun. 5` keeps its own)
        words = m.group().rstrip(", ").removesuffix(".")
        # `may` in lower case is the verb (`3 may fail`), never the month
        if day_month(words) and not re.search(r"\bmay\b", words):
            out.append((m.start(), m.start() + len(words), words))
    return out


def date_in(display: str, excerpt: str) -> bool:
    """Whether a display that is a day and a month in words (`23 June`) names a date the excerpt writes as ISO
    (`2026-06-23`) or as month and day (`06-23`): the same month and day, and the same year when both give one (live
    check term-fix6, new quirk 7: `23 June` citing a cell `06-23` was marked red). A time after the date
    (`4 June 2026 at 10:53:40 UTC`) is the time the time stamp writes after that date, or with no time there, a clock
    time of the excerpt (clocks_in); live check term-fix7, new quirk 1: the citation check tagged it unverified against a
    line holding 2026-06-04T10:53:40Z. A date the excerpt writes in words holds it too (`23 June`, `June 23, 2026`, a
    row named `last delete on 30 June`): the same day and month, the same year when both give one, and the clock time
    among the excerpt's (live check term-fix9, quirk 11: edit_card reported `23 June` missing from a table whose row is
    named `23 June`)."""
    want = _date_words(display)
    if want is None:
        return False
    month, day, year, clock = want
    for m in _ISO_DATE_RE.finditer(excerpt):
        if (int(m[2]), int(m[3])) != (month, day) or (year is not None and m[1] is not None and int(m[1]) != year):
            continue
        if clock is None:
            return True
        stamp = _STAMP_CLOCK_RE.match(excerpt, m.end())
        if clocks_in(clock, stamp[1] if stamp else excerpt):
            return True
    for _, _, words in dates_in_text(excerpt):
        got = _date_words(words)
        if got is None or (got[0], got[1]) != (month, day) or (year is not None and got[2] is not None and got[2] != year):
            continue
        if clock is None or clocks_in(clock, got[3] or excerpt):
            return True
    return False


def dates_shown(text: str) -> str | None:
    """The dates a place writes in digits, each with its time (up to three, joined), for the note of a date in words
    cited there; None when it writes none."""
    found = list(dict.fromkeys(_STAMP_RE.findall(text or "")))
    return ", ".join(found[:3]) if found else None


def value_in(display: str, excerpt: str, *, decrease: bool = False) -> bool:
    """Whether a value-ref's display is at the place it cites (verify._value_matches, report._value_matches): a number
    must cite a whole number token of the excerpt by shown_matches (a substring hit is not a receipt); a day and a
    month in words a date the excerpt writes as digits (date_in); anything else is a comma-insensitive substring of it,
    the quotation marks around a quoted phrase left out."""
    if any(shown_matches(display, t, negative_ok=decrease) for t in _NUM_RE.findall(excerpt)):
        return True
    if date_in(display, excerpt):
        return True
    if _NUM_RE.fullmatch(display.strip()):
        return False
    words = display.strip()
    if len(words) > 2 and words[0] in QUOTE_MARKS and words[-1] in QUOTE_MARKS:
        words = words[1:-1]
    return _norm(words) in excerpt.replace(",", "")


# Prose that says a number is a decrease: an unsigned number may cite a value of the same size with a minus sign ("12
# fewer" against a td `-12.0`) when one of these words stands right before or right after it, or one word away with only
# `by`, `of`, `a` or `an` between ("fewer by 12", "a drop of 12"). Adjacency, not a window: a wider window misreads
# thresholds and starting values ("Scores below 3.5", "Down from 290 to 41"), so relation words are out. A signed `-12` in
# the prose against a td `12` is never accepted.
DECREASE_WORDS = frozenset((
    "fewer", "less", "down", "drop", "drops", "dropped", "decrease", "decreased", "decreases", "decline", "declined",
    "declines", "fell", "fall", "falls", "fallen", "shrank", "shrunk", "shrinks", "reduction", "reduced", "reduces",
    "loss", "lost", "losing", "negative", "short", "shortfall", "deficit",
    "gap", "difference", "differences", "differ", "differs", "differed", "apart",
))
# the word before the number (with an optional bridge word after it) and the word after it (with an optional bridge
# before it); a bracket around the number is stepped over, any other punctuation ends the reading
_DECREASE_BEFORE_RE = re.compile(r"([A-Za-z]+)(?:\s+(?:by|of|a|an))?[\s(]*$")
_DECREASE_AFTER_RE = re.compile(r"^[\s)]*(?:(?:by|of|a|an)\s+)?([A-Za-z]+)")


def _prose(s: str) -> str:
    """`s` with its [[…]] markup read as prose: a value-ref as its display, a bare ref as nothing."""
    return _SPAN_RE.sub(lambda m: m.group(1).partition("|")[0].strip() if "|" in m.group(1) else "", s)


def says_decrease(text: str, start: int, end: int) -> bool:
    """Whether the words next to the number (or the value-ref token) at text[start:end] say it is a decrease: a
    DECREASE_WORDS word right before or right after it, or one bridge word (`by`, `of`, `a`, `an`) away. Markup
    around it is read as prose (_prose); a `.`, `,`, `;` or `:` between the word and the number ends the reading, so
    "drop. 12" and "12, a decrease" say nothing about 12."""
    b = _DECREASE_BEFORE_RE.search(_prose(text[:start]))
    a = _DECREASE_AFTER_RE.match(_prose(text[end:]))
    return (b is not None and b.group(1).lower() in DECREASE_WORDS) or (a is not None and a.group(1).lower() in DECREASE_WORDS)


def names_label(text: str, label: str) -> bool:
    """Whether the words of `text` (its citations read as their words, _prose) write a row's name as a whole word, as
    "a last 89 in the 22:00 hour" names the row 22:00. A one-character name is too common to tell."""
    name = label.strip()
    if len(name) < 2:
        return False
    return re.search(r"(?<![\w:.-])" + re.escape(name) + r"(?![\w:-])", _prose(text), re.I) is not None


def off_named_row(ref: str, to: str, text: str) -> bool:
    """Whether moving a td span `ref` to the td `to` takes it off the row the words of `text` name: a value cited at the
    row its sentence names (`[[89|…#deletions/22:00]]` "in the 22:00 hour") is wrong there, not misplaced, so it stays
    at that row for the check to mark (live check term-fix7, new quirk 1: the writer's `#deletions/22:00` was stored as
    `#deletions/23:00`, the one td showing 89, and the sentence's hour turned wrong under a blue link)."""
    a, b = _ANY_TD.match(ref or ""), _ANY_TD.match(to or "")
    if not a or not b:
        return False
    row = decode_label(a[3])
    return decode_label(b[3]) != row and names_label(text, row)


def _keys(key: str, negative_ok: bool) -> list[str]:
    """The comparison keys a number may match: its own, and — when the prose says it is a decrease and it carries no
    sign — the same size with a minus."""
    return [key, "-" + key] if negative_ok and key and key[0] != "-" else [key]


def _unit_after(text: str, pos: int) -> str | None:
    """The unit word that follows a number ending at `pos` in `text` ("16 runs" -> "runs"), else None."""
    m = _UNIT_RE.match(text, pos)
    return m.group(1) if m else None


def _norm_unit(unit: str) -> str:
    """Units compare case-folded and singular/plural alike ("runs" = "run", "Files" = "file")."""
    u = unit.lower()
    return u[:-1] if len(u) > 3 and u.endswith("s") else u


def _strip_tags(s: str) -> str:
    return _html.unescape(_TAG_RE.sub("", s)).strip()


def encode_label(label: str) -> str:
    """A td column / row label as it is written inside `cell:<id>#<col>/<row>`: the characters in _LABEL_ESCAPE,
    whitespace and controls become %XX per UTF-8 byte; the rest is kept. Idempotent through decode_label."""
    out: list[str] = []
    for ch in label:
        if ch in _LABEL_ESCAPE or ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append("".join(f"%{b:02X}" for b in ch.encode("utf-8")))
        else:
            out.append(ch)
    return "".join(out)


def decode_label(label: str) -> str:
    """The label a ref's column / row part stands for. A part without a valid %XX sequence (a raw label, or one with no
    special character) is returned as is."""
    return unquote(label) if "%" in label else label


@dataclass
class Link:
    """A resolved number in the answer: the text token, the ref it links to, and which tier resolved it."""
    token: str
    ref: str
    tier: int


@dataclass
class Resolved:
    annotated: str  # the answer with resolved numbers rewritten as [[token|ref]]
    links: list[Link] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)  # number tokens we could not source
    # value-refs into this cell whose target is gone and whose value has no other unique home, kept as written when
    # resolve() ran with keep_stale: tier 0
    stale: list[Link] = field(default_factory=list)
    # value-refs into this cell re-pointed at the one place that holds their value, (display, the ref now) → the ref as
    # written: the record keeps where the text cited the number, so the chip can say it moved
    moved: dict[tuple[str, str], str] = field(default_factory=dict)
    # numbers with no value of their own to link to that state a total or count of the card's data (data_totals): left
    # plain and supported, so they are not in `unresolved`
    totals: list[str] = field(default_factory=list)
    # value-refs into this cell whose value another row shows while the words name the row cited (off_named_row): kept
    # at that row as written, tier 0
    misplaced: list[Link] = field(default_factory=list)


# --------------------------------------------------------------------------- output addressing (`@out<i>`)

OUT_KEY = "_out"  # a stored bundle's index, when it differs from its position (notebook.number_outputs); frontend types.ts
RANGE_LINES_MAX = 200  # the lines of an output a range span (`@out<i>#L<n>-L<m>`) may name and be read through


def output_index(bundle: Any, position: int) -> int:
    """The `@out<i>` index a stored bundle answers to: its `_out` when it carries one (a non-negative int), else its
    position."""
    if isinstance(bundle, dict):
        v = bundle.get(OUT_KEY)
        if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
            return v
    return position


def iter_outputs(outputs: list | None) -> Iterator[tuple[int, dict]]:
    """(index, bundle) for every dict bundle of a cell's outputs, in stored order — the addressing every reader
    numbers by (`[out<i>]` in a result, `@out<i>` in a ref)."""
    for pos, b in enumerate(outputs or []):
        if isinstance(b, dict):
            yield output_index(b, pos), b


def output_at(outputs: list | None, out: int) -> dict | None:
    """The bundle with index `out`, or None when the cell has no such output."""
    for i, b in iter_outputs(outputs):
        if i == out:
            return b
    return None


# --------------------------------------------------------------------------- output parsing (shared with refs.py)


def _bundle_text(bundle: dict) -> str:
    tp = bundle.get("text/plain")
    if isinstance(tp, list):
        return "".join(map(str, tp))
    return str(tp or "")


def _bundle_html(bundle: dict) -> str:
    th = bundle.get("text/html")
    if isinstance(th, list):
        return "".join(map(str, th))
    return str(th or "")


# --------------------------------------------------------------------------- a chart's data rows
#
# An Altair or Vega-Lite chart carries the rows it draws as inline data in its spec, so those rows are read here as the
# chart's table: a value in them is cited by column and row like a td (`card:<id>#<column>/<row>`), and every reader of
# td spans finds them through table_html. A chart without inline data (a matplotlib image, a spec that loads a URL) has
# no rows.

CHART_ROWS_MAX = 2000  # rows of a chart's inline data read as its table; a chart drawing more is cited by its card
CHART_TEXT_WIDTH = 30  # the widest a column is padded to in chart_text; a longer value is kept whole, unaligned


@dataclass
class ChartTable:
    """A chart's inline rows as a table: the value columns, one label per row (the label column's value, or the
    row's position when no column can label the rows), each row's values as text, the label column's name (None for
    positions) and how many rows the chart has in all (more than the rows kept past CHART_ROWS_MAX)."""
    columns: list[str]
    labels: list[str]
    cells: list[list[str]]
    label: str | None
    total: int
    by_axis: bool = False  # the label column is the axis a chart draws its rows along, as numbers or dates

    def html(self) -> str:
        """The rows as the pandas-shaped html table table_cells reads: a header row (the corner, then the columns),
        then each row's label in a th before its values."""
        esc = _html.escape
        head = f"<tr><th>{esc(self.label or '')}</th>" + "".join(f"<th>{esc(c)}</th>" for c in self.columns) + "</tr>"
        body = "".join(f"<tr><th>{esc(lab)}</th>" + "".join(f"<td>{esc(v)}</td>" for v in row) + "</tr>"
                       for lab, row in zip(self.labels, self.cells))
        return f"<table><thead>{head}</thead><tbody>{body}</tbody></table>"

    def text(self) -> str:
        """The rows as the model reads them, aligned like a printed DataFrame: the label first (under the label
        column's name, or under nothing when it is the row's position), then the values."""
        grid = [[self.label or "", *self.columns], *([lab, *row] for lab, row in zip(self.labels, self.cells))]
        widths = [min(CHART_TEXT_WIDTH, max(len(r[j]) for r in grid)) for j in range(len(grid[0]))]
        return "\n".join("  ".join(v.ljust(w) for v, w in zip(r, widths)).rstrip() for r in grid)


def chart_spec(bundle: Any) -> dict | None:
    """The Vega or Vega-Lite spec a chart bundle carries, or None for any other bundle."""
    if not isinstance(bundle, dict):
        return None
    for k, v in bundle.items():
        if "vega" not in str(k):
            continue
        if isinstance(v, str):
            try:
                v = json.loads(v)
            except ValueError:
                continue
        if isinstance(v, dict):
            return v
    return None


def _inline_rows(spec: dict, datasets: dict | None = None) -> list | None:
    """The rows a spec draws when they are inline: its `data.values`, or the `datasets` entry its `data.name` names
    (Altair's form). A layered, concatenated or faceted spec with no data of its own reads its first part's; a Vega
    spec's `data` list gives its first entry with values; a spec whose only inline data is one dataset reads that.
    None when the rows are not in the spec (a URL, a generator, no data at all)."""
    own = spec.get("datasets")
    datasets = {**(datasets or {}), **(own if isinstance(own, dict) else {})}
    data = spec.get("data")
    if isinstance(data, list):
        return next((d["values"] for d in data if isinstance(d, dict) and isinstance(d.get("values"), list)), None)
    if isinstance(data, dict):
        if isinstance(data.get("values"), list):
            return data["values"]
        rows = datasets.get(data.get("name")) if isinstance(data.get("name"), str) else None
        return rows if isinstance(rows, list) else None
    for key in ("layer", "hconcat", "vconcat", "concat"):
        for part in spec.get(key) if isinstance(spec.get(key), list) else []:
            rows = _inline_rows(part, datasets) if isinstance(part, dict) else None
            if rows is not None:
                return rows
    if isinstance(spec.get("spec"), dict):
        return _inline_rows(spec["spec"], datasets)
    if len(datasets) == 1:
        rows = next(iter(datasets.values()))
        return rows if isinstance(rows, list) else None
    return None


def _value_text(v: Any) -> str:
    """One value of a chart's row as its table shows it: text as it is, a number as Python prints it, a boolean as
    JSON writes it, a missing value as nothing and anything nested as compact JSON."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return str(v)


def _encoding_def(spec: dict, channel: str) -> dict | None:
    """The field definition of a chart's `channel` (x or y), in its own encoding or in its first layer's or inner
    spec's."""
    enc = spec.get("encoding")
    if isinstance(enc, dict) and isinstance(enc.get(channel), dict) and isinstance(enc[channel].get("field"), str):
        return enc[channel]
    for key in ("layer", "hconcat", "vconcat", "concat"):
        for part in spec.get(key) if isinstance(spec.get(key), list) else []:
            d = _encoding_def(part, channel) if isinstance(part, dict) else None
            if d:
                return d
    return _encoding_def(spec["spec"], channel) if isinstance(spec.get("spec"), dict) else None


def _encoding_field(spec: dict, channel: str) -> str | None:
    """The field a chart's `channel` (x or y) encodes (_encoding_def)."""
    d = _encoding_def(spec, channel)
    return d["field"] if d else None


def _label_text(v: Any) -> str:
    """A row label as a ref writes it: a whole float without its `.0`, since a model cites step 5500, not 5500.0."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return _value_text(v)


def chart_table(bundle: Any) -> ChartTable | None:
    """The table of a chart bundle's inline rows (ChartTable), the first CHART_ROWS_MAX of them; None when the bundle is no
    chart or draws no inline rows. The row label is the first column whose values are all distinct, non-empty text, else
    the x (then y) axis field when its values are distinct and not a numeric y measure, else the row's position from 0."""
    spec = chart_spec(bundle)
    raw = _inline_rows(spec) if spec is not None else None
    if not isinstance(raw, list):
        return None
    rows = [r for r in raw[:CHART_ROWS_MAX] if isinstance(r, dict)]
    if not rows:
        return None
    cols: list[str] = []
    for r in rows:
        cols.extend(str(k) for k in r if str(k) not in cols)
    label = next((k for k in cols if all(isinstance(r.get(k), str) and r[k].strip() for r in rows)
                  and len({r[k] for r in rows}) == len(rows)), None)
    by_axis = False
    if label is None:
        for channel in ("x", "y"):
            d = _encoding_def(spec, channel) if spec is not None else None
            if d is None or (channel == "y" and d.get("type") == "quantitative"):
                continue
            f = d["field"]
            vals = [r.get(f) for r in rows] if f in cols else []
            if vals and all(isinstance(v, (int, float, str)) and not isinstance(v, bool) and str(v).strip() for v in vals) \
                    and len({_label_text(v) for v in vals}) == len(rows):
                label, by_axis = f, True
                break
    values = [k for k in cols if k != label]
    labels = [_label_text(r[label]) for r in rows] if label else [str(i) for i in range(len(rows))]
    return ChartTable(values, labels, [[_value_text(r.get(k)) for k in values] for r in rows], label, len(raw), by_axis)


def table_html(bundle: Any) -> str:
    """The html a bundle's citable values are read from: the values a card shows of a frame (frames.frame_html, as
    the card formats them), the table of a chart's inline rows, else the bundle's own text/html table; '' for any other
    bundle. A chart's own text/html, when a renderer adds one, is its script and holds no values."""
    if not isinstance(bundle, dict):
        return ""
    if frames.FRAME_MIME in bundle:
        return frames.frame_html(bundle)
    if chart_spec(bundle) is not None:
        table = chart_table(bundle)
        return table.html() if table is not None else ""
    return _bundle_html(bundle) if "text/html" in bundle else ""


def bundle_cells(bundle: Any) -> list[tuple[str, str, str]]:
    """(col, row, value) for every citable value of a bundle: a frame's shown values read directly (frames.frame_cells,
    no html in between), else the cells of its table_html."""
    cells = frames.frame_cells(bundle) if isinstance(bundle, dict) and frames.FRAME_MIME in bundle else None
    if cells is not None:
        return cells
    html = table_html(bundle)
    return table_cells(html) if html else []


VALUE_COUNTS_MAX = 12  # the distinct values of a column whose counts of rows are totals of the data (_column_totals)
TOTAL_DECIMALS = 6  # a float column's sum is rounded this far before it is compared, so 0.1 + 0.2 reads as 0.3


def _total_text(value: Decimal | float | int) -> str:
    """A total as a plain number shown_matches reads: no exponent, no float noise past TOTAL_DECIMALS."""
    d = value if isinstance(value, Decimal) else Decimal(str(round(float(value), TOTAL_DECIMALS)))
    return format(d.normalize(), "f")


def _column_totals(columns: dict[str, list[Any]]) -> list[str]:
    """For each column: the sum when every value it holds is a number, else how many distinct values it holds and, for
    a column whose values repeat and number at most VALUE_COUNTS_MAX, how many rows hold each ("8 of the 9 runs
    finished" over a column of True and False): a count the card shows only as rows, which no one value of it holds."""
    out: list[str] = []
    for vals in columns.values():
        held = [v for v in vals if v is not None and v != ""]
        if not held:
            continue
        nums = [v for v in held if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool)]
        if len(nums) == len(held):
            out.append(_total_text(sum(Decimal(str(round(float(v), TOTAL_DECIMALS))) for v in nums)))
            continue
        counts: dict[str, int] = {}
        for v in held:
            counts[_value_text(v)] = counts.get(_value_text(v), 0) + 1
        out.append(str(len(counts)))
        if len(counts) < len(held) and len(counts) <= VALUE_COUNTS_MAX:
            out.extend(str(n) for n in counts.values())
    return out


def data_totals(outputs: list[dict] | None) -> list[str]:
    """The totals and counts a card's data holds though no output shows them as a value: for each frame, chart and html table,
    its row count, the sum of each numeric column and the distinct-value count of each other column. A frame the card keeps
    only part of gives its row count alone."""
    out: list[str] = []
    for _, b in iter_outputs(outputs):
        cols: dict[str, list[Any]] = {}
        frame = frames.frame_of(b)
        if frame is not None:
            out.append(str(frame.get("total") or len(frame["rows"])))
            if int(frame.get("total") or 0) > len(frame["rows"]):
                continue
            for j, c in enumerate(frame["columns"]):
                cols[c] = [r[j] if j < len(r) else None for r in frame["rows"]]
        elif (spec := chart_spec(b)) is not None:
            raw = _inline_rows(spec)
            rows = [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []
            if not rows:
                continue
            out.append(str(len(rows)))
            for r in rows:
                for k, v in r.items():
                    cols.setdefault(str(k), [])
            for k in cols:
                cols[k] = [r.get(k) for r in rows]
        elif html := table_html(b):
            cells = table_cells(html)
            if not cells:
                continue
            labels = list(dict.fromkeys(row for _, row, _ in cells))
            out.append(str(len(labels)))
            for col, _, val in cells:
                parts = _num_parts(val)
                cols.setdefault(col, []).append(parts[0] if parts is not None else val)
        out.extend(_column_totals(cols))
    return list(dict.fromkeys(out))


def table_cells(html: str) -> list[tuple[str, str, str]]:
    """(col, row, value) for every <td> of a pandas-rendered table, in document order.

    Layout: the first <tr> is the header (a blank corner <th>, then column <th>s); each data <tr> starts with the
    row-label <th>, then the value <td>s aligned to the columns. Rows without a <td> (the extra header row pandas
    emits for a named index) are skipped.
    """
    rows = _ROW_RE.findall(html)
    if not rows:
        return []
    header = [_strip_tags(m.group(2)) for m in _CELL_RE.finditer(rows[0])]
    cols = header[1:]
    out: list[tuple[str, str, str]] = []
    for tr in rows[1:]:
        cells = [(m.group(1).lower(), _strip_tags(m.group(2))) for m in _CELL_RE.finditer(tr)]
        if not any(tag == "td" for tag, _ in cells):
            continue
        row_label = cells[0][1]
        for j, (_, val) in enumerate(cells[1:]):
            out.append((cols[j] if j < len(cols) else str(j), row_label, val))
    return out


def td_ref(cell_id: str, col: str, row: str) -> str | None:
    """The `cell:<id>#<col>/<row>` ref for a td, its labels encoded (encode_label); None only for a blank label (the
    corner / an unnamed column), which no ref can name."""
    if not col.strip() or not row.strip():
        return None
    return f"card:{cell_id}#{encode_label(col)}/{encode_label(row)}"


def canonical_td_ref(ref: str) -> str:
    """`ref` with its labels in the encoded form when it is a `cell:<id>#<col>/<row>` ref written raw; any other string is
    returned unchanged."""
    m = _ANY_TD.match(ref.strip())
    if not m:
        return ref
    return td_ref(m[1], decode_label(m[2]), decode_label(m[3])) or ref


# a span written without its cell id, bare or as a value-ref: `[[5|@out0#L3]]`, `[[@out0#L3]]`, `[[12|#count/total]]`,
# `[[#count/total]]` (the tokens refs._BARE_LEAD refuses); group 1 the display (None for a bare ref), group 2 the span
_BARE_SPAN_RE = re.compile(r"\[\[(?:([^\[\]|]+)\|)?\s*((?:#|@out\d)[^\[\]|]*?)\s*\]\]")
# The prompts' own placeholder for a card's id, `card:<id>` (shared.md's citation table and examples), which a model may
# copy into the takeaway it gives add_card before the card has an id.
_ID_PLACEHOLDER_RE = re.compile(r"(\[\[(?:[^\[\]|]*\|)?\s*)(?:card|cell):<id>(?=[#@\]\s|])")


def qualify_bare_spans(cell_id: str, text: str) -> str:
    """`text` with every span that names no cell (`[[5|@out0#L3]]`, `[[@out0#L3]]`, `[[12|#count/total]]`) or the prompts'
    placeholder `card:<id>` rewritten as a span of `cell_id`; stored bare, the span would reach the browser as a file named
    `@out0`. Idempotent; a token with a cell id, a file line or a db row is untouched."""

    def fix(m: "re.Match[str]") -> str:
        display, span = m.group(1), m.group(2)
        return f"[[{display.strip()}|card:{cell_id}{span}]]" if display else f"[[card:{cell_id}{span}]]"

    text = _ID_PLACEHOLDER_RE.sub(lambda m: f"{m.group(1)}card:{cell_id}", text)
    return _BARE_SPAN_RE.sub(fix, text)


# A value-ref written as a markdown link, `[[48]](cell:<id>#never_passed/<row>)` instead of `[[48|cell:<id>#…]]`. Group
# 1 the display, group 2 the ref, which has to look like one (_REF_SHAPE), so a bare ref followed by a parenthesised word
# (`[[cell:x]](above)`) is left alone. The ref runs to the closing paren for a td span (which may carry spaces and one
# level of parentheses), else to the first space or paren.
_HYBRID_RE = re.compile(r"\[\[([^\[\]|]+?)\]\]\(\s*((?:card|cell):[A-Za-z0-9_-]+#(?:[^()\[\]|\n]|\([^()\n]*\))+?|[^()\s]+?)\s*\)")
_REF_SHAPE = re.compile(r"^(?:call:[A-Za-z0-9_-]+/\d+(?:#L\d+(?:-L\d+)?)?|(?:card|cell|concept|chat):[A-Za-z0-9_-]+(?:[@#/].*)?|[^\s:#]+#\S+|[^\s:#()]+\.[A-Za-z][A-Za-z0-9]{0,7}|(?:#|@out\d)\S*)$")
# a number alone in double brackets, `[[48]]`: the model meant the value, not a file named 48 — unless a `(` follows: that
# is a hybrid _HYBRID_RE did not convert, left whole for the checker to report rather than glued to its ref as prose
_BARE_NUMBER_RE = re.compile(r"\[\[\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?)\s*\]\](?!\()")
# a value-ref in single brackets, `[4 failing|runs/x/board.jsonl#L85]`, which models sometimes write and markdown draws
# as literal text. Only when the part after the bar looks like a ref (_REF_SHAPE) and the part before it does not; never
# inside a double-bracketed ref or before a `(`.
_SINGLE_RE = re.compile(r"(?<!\[)\[([^\[\]|\n]+)\|([^\[\]|\n]+)\](?![\](])")
# A file's line cited through the card that shows it, `[[refused|card:<id>#runs/a.jsonl#L103.b0:c12-109]]`, which a model
# writes for an example card's excerpt: the grammar has no such form, a td reader would take `runs` for a column, and
# the line is what the citation means. Group 1 is the token up to the card part, which normalise_markup drops; the
# file part is a path (refs._FP, without brackets or a bar) and a line form after its `#`.
_CARD_FILE_LINE_RE = re.compile(r"(\[\[(?:[^\[\]|]*\|)?\s*)" + CARD_RE
                                + r"[A-Za-z0-9_-]+(?:@\d+)?#(?=[^#\s\[\]|](?:[^#\n\[\]|]*[^#\s\[\]|])?#L\d)")


def quote_refs(cell: dict | None, text: str) -> str:
    """`text` with each citation of an example card's quote written as the card and a file it quotes,
    `[[unverifiable|card:<id>#runs/u3.json]]`, written as the ref of that quote (the first of the card's `refs` into
    the file), since the grammar reads `card:<id>#<a>/<b>` as a table's cell and an example has no table. Any other
    token, and a card that is no example, is left as it is."""
    payload = (cell or {}).get("payload") if isinstance(cell, dict) else None
    refs_ = payload.get("refs") if isinstance(payload, dict) and cell.get("kind") == "example" else None
    cid = str((cell or {}).get("id") or "")
    if not refs_ or not cid or "#" not in text:
        return text
    from . import refs as refs_mod  # noqa: PLC0415 — refs imports cite

    quoted: dict[str, str] = {}
    for r in refs_:
        try:
            path = refs_mod.parse_ref(str(r)).get("path")
        except ValueError:
            continue
        if path:
            quoted.setdefault(str(path), str(r))
    pattern = re.compile(r"(\[\[(?:[^\[\]|]*\|)?\s*)" + CARD_RE + re.escape(cid) + r"#([^\[\]|#]+?)(\s*\]\])")
    return pattern.sub(lambda m: f"{m[1]}{quoted[m[2]]}{m[3]}" if m[2] in quoted else m[0], text)


# A Markdown link, `[text](target)`, which the terminal shows as its text: a citation written for the terminal
# (from_links). The target may hold one level of balanced parentheses, or be wrapped in <…>; a link inside [[…]] or an
# image is not one.
_LINK_RE = re.compile(r"(?<![\[!])\[([^\[\]\n]*)\]\(\s*(?:<([^<>\n]+)>|((?:[^()\s<>]|\([^()\s]*\))+))\s*\)")
_WEB_SCHEME_RE = re.compile(r"^(?:[a-z][a-z0-9+.-]*://|mailto:|tel:)", re.I)
BARE_LINK_TEXTS = ("", "↗")  # the link texts of a citation without a value, `[↗](card:<id>)`


def from_links(text: str) -> str:
    """`text` with each Markdown link whose target is a ref of the grammar written as the citation it stands for:
    `[31](card:<id>#a/b)` becomes `[[31|card:<id>#a/b]]` and `[↗](card:<id>)` becomes `[[card:<id>]]`. Web links and
    targets that are no ref are left as written. Idempotent."""
    if "](" not in text:
        return text
    from . import refs  # noqa: PLC0415 — refs imports this module

    def one(m: "re.Match[str]") -> str:
        shown, target = m.group(1).strip(), (m.group(2) or m.group(3) or "").strip()
        if not target or _WEB_SCHEME_RE.match(target) or "|" in shown:
            return m.group()
        try:
            refs.parse_ref(target)
        except ValueError:
            return m.group()
        return f"[[{target}]]" if shown in BARE_LINK_TEXTS else f"[[{shown}|{target}]]"

    return _LINK_RE.sub(one, text)


def to_links(text: str) -> str:
    """`text` with each citation written as the Markdown link the terminal shows as its text, the inverse of
    from_links: `[[31|card:<id>#a/b]]` becomes `[31](card:<id>#a/b)` and `[[card:<id>]]` becomes `[↗](card:<id>)`, with
    each space in the ref written %20."""
    def one(m: "re.Match[str]") -> str:
        shown, bar, ref = m.group(1).rpartition("|") if "|" in m.group(1) else ("", "", m.group(1))
        target = ref.strip().replace(" ", "%20")
        return f"[{shown.strip() if bar else BARE_LINK_TEXTS[1]}]({target})"

    return _SPAN_RE.sub(one, text)


def prose(text: str) -> str:
    """`text` with its citations read as prose: a value-ref as its display, a bare ref as nothing."""
    return _prose(text)


def normalise_markup(text: str) -> str:
    """`text` with the value-ref forms the grammar does not know put right: `[[v]](ref)` and `[v|ref]` become `[[v|ref]]`, a
    Markdown link to a ref becomes its citation (from_links), `[[↗|ref]]` becomes `[[ref]]`, a number alone in brackets
    becomes the plain number, and a file's line cited through a card becomes the file's line. Idempotent; every other
    token is untouched."""

    def hybrid(m: "re.Match[str]") -> str:
        display, ref = m.group(1).strip(), m.group(2)
        if not display or _REF_SHAPE.match(display) or not _REF_SHAPE.match(ref):
            return m.group()
        return f"[[{display}|{ref}]]"

    def single(m: "re.Match[str]") -> str:
        display, ref = m.group(1).strip(), m.group(2).strip()
        if not display or _REF_SHAPE.match(display) or not _REF_SHAPE.match(ref):
            return m.group()
        return f"[[{display}|{ref}]]"

    def bare(m: "re.Match[str]") -> str:
        shown, bar, ref = m.group(1).rpartition("|")
        return f"[[{ref.strip()}]]" if bar and shown.strip() in BARE_LINK_TEXTS and ref.strip() else m.group()

    text = _CARD_FILE_LINE_RE.sub(lambda m: m.group(1), text)
    text = _HYBRID_RE.sub(hybrid, text)
    text = from_links(text)
    # a citation without a value written with the link text as its value (`[[↗|ref]]`) is the bare ref, never a value
    # the check looks for at its place (live check term-fix7: a takeaway's `[[↗|events.jsonl#L1063]]` was red)
    text = _SPAN_RE.sub(bare, text)
    text = _SINGLE_RE.sub(single, text)
    return _BARE_NUMBER_RE.sub(lambda m: m.group(1), text)


def find_td(outputs: list[dict] | None, col: str, row: str) -> tuple[str, str] | None:
    """(value, table_html) of the <td> at column `col` / row label `row`, searching the cell's tables in order, a chart's
    inline rows among them; None when no table has it. The labels may be given raw or encoded (encode_label)."""
    want = {(col, row), (decode_label(col), decode_label(row))}
    for b in outputs or []:
        if isinstance(b, dict) and frames.FRAME_MIME in b:
            # a table card's frame: its values as the card shows them, and for the preview only the rows around the
            # cited one (a frame keeps up to 500 rows, and the preview shows the value in its neighbourhood)
            for c, r, v in frames.frame_cells(b) or []:
                if (c, r) in want:
                    return v, frames.frame_html(b, around=r)
            # a row's name cited by its label column (`#day/06-23`): the name is the value (live check term-fix7: `[23
            # June](card:…#day/06-23)` was missing)
            f = frames.frame_of(b)
            head = frames.corner(f) if f is not None else ""
            if head and any((head, r) in want for r in frames.row_labels(f)):
                name = next(r for r in frames.row_labels(f) if (head, r) in want)
                return name, frames.frame_html(b, around=name)
            continue
        html = table_html(b)
        if not html:
            continue
        cells = table_cells(html)
        for c, r, v in cells:
            if (c, r) in want:
                return v, html
        name = _row_name(html, want)
        if name is not None:
            return name, html
        # a chart whose rows are labelled by its axis still answers a ref that names a row by its position
        table = chart_table(b) if chart_spec(b) is not None else None
        pos = decode_label(row)
        if table is not None and table.by_axis and pos.isdigit() and int(pos) < len(table.labels):
            want_pos = {(col, table.labels[int(pos)]), (decode_label(col), table.labels[int(pos)])}
            for c, r, v in cells:
                if (c, r) in want_pos:
                    return v, html
        hit = _by_key_column(cells, col, row)
        if hit is not None:
            return hit, html
    return None


def _row_names(bundle: dict) -> tuple[str, list[str]]:
    """(the header over a table's row names, the names) of a frame or a pandas-rendered table; ('', []) when it has no
    such header."""
    if frames.FRAME_MIME in bundle:
        f = frames.frame_of(bundle)
        return (frames.corner(f) or "", list(frames.row_labels(f))) if f is not None else ("", [])
    html = table_html(bundle)
    rows = _ROW_RE.findall(html) if html else []
    if not rows:
        return "", []
    header = [_strip_tags(m.group(2)) for m in _CELL_RE.finditer(rows[0])]
    head = header[0].strip() if header else ""
    names: list[str] = []
    for tr in rows[1:]:
        cells = [(m.group(1).lower(), _strip_tags(m.group(2))) for m in _CELL_RE.finditer(tr)]
        if cells and cells[0][0] == "th" and any(tag == "td" for tag, _ in cells):
            names.append(cells[0][1])
    return (head, names) if head else ("", [])


def _row_name(html: str, want: set[tuple[str, str]]) -> str | None:
    """A row's name in a pandas-rendered table cited by the header over the row names (its index's name, `#day/06-23`):
    the name itself; None when the header is blank or no row has that name."""
    rows = _ROW_RE.findall(html)
    if not rows:
        return None
    header = [_strip_tags(m.group(2)) for m in _CELL_RE.finditer(rows[0])]
    head = header[0].strip() if header else ""
    if not head:
        return None
    for tr in rows[1:]:
        cells = [(m.group(1).lower(), _strip_tags(m.group(2))) for m in _CELL_RE.finditer(tr)]
        if cells and cells[0][0] == "th" and any(tag == "td" for tag, _ in cells) and (head, cells[0][1]) in want:
            return cells[0][1]
    return None


def _by_key_column(cells: list[tuple[str, str, str]], col: str, row: str) -> str | None:
    """The value at `col` in the row a key column names, for a table whose rows pandas numbered 0, 1, 2 (a frame with
    its default index): the key column is the first whose values are all distinct, non-empty text, such as each row's
    run, the column a reader names a row by. None when the table has its own row labels or no such column."""
    order: list[str] = []
    by_row: dict[str, dict[str, str]] = {}
    for c, r, v in cells:
        if r not in by_row:
            order.append(r)
        by_row.setdefault(r, {})[c] = v
    if not order or order != [str(i) for i in range(len(order))]:
        return None
    columns: list[str] = []
    for c, _, _ in cells:
        if c not in columns:
            columns.append(c)
    for key in columns:
        vals = [by_row[r].get(key, "").strip() for r in order]
        if all(vals) and len(set(vals)) == len(vals) and not all(_PLAIN_NUM_RE.fullmatch(_norm(v)) for v in vals):
            names = {row.strip(), decode_label(row).strip()}
            at = next((i for i, v in enumerate(vals) if v in names), None)
            if at is None:
                return None
            got = by_row[order[at]]
            return got.get(col, got.get(decode_label(col)))
    return None


def numbered_lines(bundle: dict) -> list[tuple[int, str]]:
    """(line number, text) for every text/plain line a bundle holds, numbered as in the complete output. A bounded stream
    bundle (`truncated: {total_lines, kept_head, kept_tail}`) numbers its head 1..H and its tail total-T+1..total and
    skips the marker line."""
    lines = _bundle_text(bundle).splitlines()
    tr = bundle.get("truncated")
    if isinstance(tr, dict):
        try:
            head, tail, total = int(tr.get("kept_head", 0)), int(tr.get("kept_tail", 0)), int(tr.get("total_lines", 0))
        except (TypeError, ValueError):
            head = tail = total = -1
        if head >= 0 and tail >= 0 and len(lines) == head + tail + 1 and total >= head + tail + 1:
            return [(n, ln) for n, ln in enumerate(lines[:head], start=1)] + \
                   [(total - tail + 1 + k, ln) for k, ln in enumerate(lines[head + 1:])]
    return list(enumerate(lines, start=1))


def output_line(outputs: list[dict] | None, out: int, n: int) -> str | None:
    """Line `n` (1-based, numbered as in the complete output) of the bundle with index `out`, or None when the bundle,
    the text or the line is missing (an omitted line of a bounded bundle is missing here; hydrate for it)."""
    b = output_at(outputs, out)
    if b is None:
        return None
    for k, line in numbered_lines(b):
        if k == n:
            return line
    return None


def line_td(cell_id: str, bundle: dict | None, line: str, display: str) -> str | None:
    """The td span a text/plain `line` of a table bundle and the `display` value on it name: the one <td> of the row whose
    label starts the line that holds the value. None when that is ambiguous or the span would not read back as the value."""
    if not isinstance(bundle, dict) or "text/html" not in bundle:
        return None
    t = line.strip()
    want = _norm(display.strip())
    if not t or not want:
        return None
    hits = [(c, r) for c, r, v in table_cells(_bundle_html(bundle))
            if r and (t == r or t.startswith(r + " ")) and _norm(v) == want]
    if len(hits) != 1:
        return None
    col, row = hits[0]
    back = find_td([bundle], col, row)  # the span must round-trip: what a reader following it sees is the value
    if back is None or _norm(back[0]) != want:
        return None
    return td_ref(cell_id, col, row)


def _output_sources(cell_id: str, outputs: list[dict]) -> tuple[dict[str, list[str | None]], dict[str, list[str]], dict[tuple[str, str], list[str]]]:
    """Three value -> [ref] maps over a cell's outputs: table-cell refs, text-line refs by bare number, and text-line refs by
    (number, unit word). A value with more than one entry is ambiguous and will not auto-link."""
    table: dict[str, list[str | None]] = {}
    text: dict[str, list[str]] = {}
    units: dict[tuple[str, str], list[str]] = {}
    for i, b in iter_outputs(outputs):
        if frames.FRAME_MIME in b:  # the values a card shows of a frame, as it formats them
            for col, row, val in frames.frame_cells(b) or []:
                table.setdefault(_norm(val), []).append(td_ref(cell_id, col, row))
            continue
        html = table_html(b)  # a table, or the inline rows a chart draws
        if html:
            for col, row, val in table_cells(html):
                table.setdefault(_norm(val), []).append(td_ref(cell_id, col, row))
            continue
        if any(k.startswith("image/") or "vega" in k for k in b):
            continue  # a chart's text/plain is its repr ("<Figure size 640x480 with 1 Axes>"), never a source
        for ln, line in numbered_lines(b):
            for m in _NUM_RE.finditer(line):
                ref = f"card:{cell_id}@out{i}#L{ln}"
                text.setdefault(_norm(m.group()), []).append(ref)
                unit = _unit_after(line, m.end())
                if unit:
                    units.setdefault((_norm(m.group()), _norm_unit(unit)), []).append(ref)
    return table, text, units


# --------------------------------------------------------------------------- resolve


def _shown_values(cell_id: str, outputs: list[dict]) -> list[tuple[str, str]]:
    """(value as shown, its td ref) for every numeric value of a cell's tables, frames and charts' rows."""
    out: list[tuple[str, str]] = []
    for _, b in iter_outputs(outputs):
        for col, row, val in bundle_cells(b):
            ref = td_ref(cell_id, col, row)
            if ref and _num_parts(val) is not None:
                out.append((val, ref))
    return out


class _Sources:
    """What one cell can vouch for: the unique tds and text lines of its outputs (tier 2)."""

    def __init__(self, cell_id: str, outputs: list[dict] | None):
        self.cell_id = cell_id
        self.outputs = outputs or []
        self.table, self.text, self.units = _output_sources(cell_id, self.outputs)
        self.shown = _shown_values(cell_id, self.outputs)  # (value as shown, td ref), for a rounded number (lookup)
        self.totals = data_totals(self.outputs)  # the totals and counts the data holds, which need no link (is_total)
        # The printed count: when the text outputs hold exactly one number token and no table holds a number
        # (`print(len(files))`), a small integer citing it has nothing to be confused with, so the `_specific` guard does not
        # apply. `only` is that token's normalised form, else None.
        counts = {k: len(v) for k, v in self.text.items()}
        table_numbers = any(_NUM_RE.fullmatch(k) for k in self.table)
        self.only: str | None = (next(iter(counts)) if len(counts) == 1 and sum(counts.values()) == 1 and not table_numbers
                                 else None)
        esc = re.escape(cell_id)
        self.self_ref = re.compile(r"^" + CARD_RE + esc + r"(?:[@#].*)?$")
        self.td_span = re.compile(r"^" + CARD_RE + esc + r"#([^/]+)/(.+)$")  # loose: a model-typed col may hold spaces
        self.line_span = re.compile(r"^" + CARD_RE + esc + r"@out(\d+)#L(\d+)$")
        self.range_span = re.compile(r"^" + CARD_RE + esc + r"@out(\d+)#L(\d+)-L(\d+)$")

    def lookup(self, tok: str, *, negative_ok: bool = False) -> tuple[str, int] | None:
        """(ref, tier) for a number token, or None when it has no unique source. A value in exactly one td links there; a value
        in several tds is ambiguous. Text lines are consulted only when no table holds the value. With `negative_ok` an unsigned
        token may link to the same value with a minus sign."""
        for key in _keys(_norm(tok), negative_ok):
            hit = self._lookup_key(key)
            if hit:
                return hit
        return self._lookup_rounded(tok, negative_ok=negative_ok)

    def _lookup_rounded(self, tok: str, *, negative_ok: bool = False) -> tuple[str, int] | None:
        """(ref, tier 2) for a number that cites exactly one table value with shown decimals dropped ("91%" for 91.2%), when no
        value equals it; small integers never link this way."""
        if not (tok.endswith("%") or "." in tok):
            return None
        refs = {ref for val, ref in self.shown if _norm(val) != _norm(tok) and shown_matches(tok, val, negative_ok=negative_ok)}
        return (next(iter(refs)), 2) if len(refs) == 1 else None

    def _lookup_key(self, key: str) -> tuple[str, int] | None:
        refs = self.table.get(key)
        if refs:
            return (refs[0], 2) if len(refs) == 1 and refs[0] else None
        lines = self.text.get(key, [])
        if len(lines) == 1:
            return lines[0], 2
        return None

    def is_total(self, tok: str) -> bool:
        """Whether `tok` states a total or count of the card's data (data_totals) that no value of the card shows: it is supported
        though there is nothing to link it to."""
        key = _norm(tok)
        if _num_parts(tok) is None or key in self.table or key in self.text:
            return False
        return any(shown_matches(tok, t) for t in self.totals)

    def supports(self, display: str) -> bool:
        """Whether the card shows each number of a display somewhere, or its data holds it as a total or count: what a number
        cited to the whole card needs."""
        nums = _NUM_RE.findall(display or "")
        if not nums:
            return False
        for tok in nums:
            key = _norm(tok)
            shown = key in self.table or key in self.text or any(shown_matches(tok, v) for v, _ in self.shown)
            if not shown and not any(shown_matches(tok, t) for t in self.totals):
                return False
        return True

    def is_printed_count(self, tok: str) -> bool:
        """Whether `tok` is the one number the outputs hold (the printed count): a small integer links on it."""
        return self.only is not None and _norm(tok) == self.only

    def date_places(self, display: str) -> list[str]:
        """The table cells, row names and text lines of the outputs that write a day and a month in words (`23 June`),
        in digits or in words (date_in), each once."""
        refs: list[str] = []
        for i, b in iter_outputs(self.outputs):
            cells = bundle_cells(b)
            if cells:
                refs += [r for col, row, val in cells if date_in(display, str(val)) and (r := td_ref(self.cell_id, col, row))]
                # a row's name under the header over the row names (`#day/06-23`), as find_td reads one
                head, names = _row_names(b)
                refs += [r for name in names if head and date_in(display, name) and (r := td_ref(self.cell_id, head, name))]
                continue
            if any(k.startswith("image/") or "vega" in k for k in b):
                continue  # a chart's text/plain is its repr, never a source
            refs += [f"card:{self.cell_id}@out{i}#L{ln}" for ln, line in numbered_lines(b) if date_in(display, line)]
        return list(dict.fromkeys(refs))

    def lookup_unit(self, tok: str, unit: str | None) -> tuple[str, int] | None:
        """(ref, tier 2) for a number with its unit word when exactly one text line holds that pair ("16 runs"), else None."""
        if not unit:
            return None
        refs = self.units.get((_norm(tok), _norm_unit(unit)), [])
        return (refs[0], 2) if len(refs) == 1 else None

    def lookup_display(self, display: str, *, negative_ok: bool = False) -> tuple[str, int] | None:
        """A value-ref's display text: the whole text as a value, else its single number ('250 assignments'), else
        that number with the word after it ('16 runs' against a line holding "16 runs")."""
        hit = self.lookup(display, negative_ok=negative_ok)
        if hit is None:
            nums = list(_NUM_RE.finditer(display))
            if len(nums) == 1:
                hit = self.lookup(nums[0].group(), negative_ok=negative_ok) or self.lookup_unit(nums[0].group(), _unit_after(display, nums[0].end()))
        return hit

    def verify(self, ref: str, display: str, *, negative_ok: bool = False) -> str | None:
        """The canonical form of `ref` when it is a span into this cell whose target holds the display's value, else None. Values
        compare by _norm; with `negative_ok` the target may hold the value with a minus sign. A range of lines holds the value
        when one of its lines does. A display with no number (a count word, a clock time) is kept at a place that exists when
        every clock time it writes is there (clocks_in)."""
        wants = set(_keys(_norm(display.strip()), negative_ok))
        word = is_label_display(display)
        if m := self.td_span.match(ref):
            hit = find_td(self.outputs, m[1], m[2])
            if hit is None:
                return None
            if word and not clocks_in(display, hit[0]):
                return None
            if not word and not (_norm(hit[0]) in wants or shown_matches(display, hit[0], negative_ok=negative_ok)
                                 or date_in(display, hit[0])):
                return None
            return td_ref(self.cell_id, decode_label(m[1]), decode_label(m[2]))
        if m := self.line_span.match(ref):
            out_i = int(m[1])
            line = output_line(self.outputs, out_i, int(m[2]))
            if line is None:
                return None
            if word:
                return ref if clocks_in(display, line) else None
            if not self._line_holds(line, display, wants, negative_ok):
                return None
            # a line of a table's text: the td the line and the value name is the form that survives a re-render
            return line_td(self.cell_id, output_at(self.outputs, out_i), line, display) or ref
        if m := self.range_span.match(ref):
            out_i, first, last = int(m[1]), int(m[2]), int(m[3])
            if last < first or last - first >= RANGE_LINES_MAX:
                return None
            lines = [output_line(self.outputs, out_i, n) for n in range(first, last + 1)]
            if any(line is None for line in lines):
                return None
            if word:
                return ref if clocks_in(display, "\n".join(lines)) else None  # type: ignore[arg-type]
            return ref if any(self._line_holds(str(line), display, wants, negative_ok) for line in lines) else None
        return None

    @staticmethod
    def _line_holds(line: str, display: str, wants: set[str], negative_ok: bool) -> bool:
        """Whether a line of text output shows a value-ref's display: a number as a whole token (value_in), a day and a
        month in words as a date the line writes in digits (date_in; live check term-fix7, new quirk 4: edit_card
        unlinked `[[23 June|…#L2]]` from a line holding 2026-06-23), anything else as written or by one of its numbers."""
        if _num_parts(display) is not None:
            return value_in(display, line, decrease=negative_ok)
        if date_in(display, line):
            return True
        return display.strip() in line or bool(wants & {_norm(x) for x in _NUM_RE.findall(line)})


def _specific(tok: str) -> bool:
    """Whether a bare number is specific enough to auto-link on uniqueness alone (tier 2). A one- or two-digit integer is
    ambiguous by nature and stays plain (reported in `unresolved`) unless it is the printed count
    (`_Sources.is_printed_count`); 3+ digits, a thousands separator, a decimal or a percent sign are candidates."""
    digits = re.sub(r"[^\d]", "", tok)
    return len(digits) >= 3 or "," in tok or "." in tok or tok.endswith("%")


def _annotate(seg: str, src: _Sources, res: Resolved, seen: set[str]) -> str:
    """Wrap every number in a plain-text segment (no [[...]] inside) that has a unique source. A day and a month in words
    (`On 23 June`) is one value: linked whole to the one line or cell that writes that date in digits (date_in), else
    left plain, never its day linked as a number with the month as its unit (live check term-fix8, quirk 4: `23` was
    linked to an answer at 23:41 while the sentence was about another line)."""
    parts: list[str] = []
    pos = 0
    dates = dates_in_text(seg)
    for m in _NUM_RE.finditer(seg):
        if m.start() < pos:
            continue  # a number of a date written whole already
        date = next((d for d in dates if d[0] <= m.start() < d[1]), None)
        if date is not None:
            start, end, words = date
            parts.append(seg[pos:start])
            pos = end
            places = src.date_places(words)
            if len(places) == 1:
                parts.append(f"[[{words}|{places[0]}]]")
                res.links.append(Link(words, places[0], 2))
                continue
            parts.append(words)
            if not places and words not in seen:  # no output writes the date; several leave it plain, as an ambiguous number
                seen.add(words)
                res.unresolved.append(words)
            continue
        parts.append(seg[pos : m.start()])
        pos = m.end()
        tok = m.group()
        neg = says_decrease(seg, m.start(), m.end())  # "12 fewer": the td may hold -12
        hit = src.lookup(tok, negative_ok=neg) if _specific(tok) or src.is_printed_count(tok) else None
        if hit is None:
            hit = src.lookup_unit(tok, _unit_after(seg, m.end()))  # "16 runs" against the one line that reads "16 runs"
        if hit:
            parts.append(f"[[{tok}|{hit[0]}]]")
            res.links.append(Link(tok, hit[0], hit[1]))
        else:
            parts.append(tok)
            if tok in seen:  # one entry per token as written: `29` and `29.0` are each listed (each is wrapped by itself)
                continue
            seen.add(tok)
            (res.totals if src.is_total(tok) else res.unresolved).append(tok)
    parts.append(seg[pos:])
    return "".join(parts)


_WHOLE_OUTPUT_RE = re.compile(r"^" + CARD_RE + r"([A-Za-z0-9_-]+)@out\d+$")


def whole_output_cell(ref: str) -> str | None:
    """`cell:<id>` for a ref that names a whole output, `cell:<id>@out<i>` with no line — a form the grammar does not
    have (a chart or a table as a whole is cited by its cell) but a writer reaches for; None for any other ref."""
    m = _WHOLE_OUTPUT_RE.match((ref or "").strip())
    return f"card:{m[1]}" if m else None


def is_label_display(display: str) -> bool:
    """Whether a value-ref's display names the link rather than a value — no number in it (`chart`, `per-run table`)."""
    return not _NUM_RE.search(display or "")


def _canonical_token(token: str) -> str:
    """A `[[ref]]` / `[[display|ref]]` token with a raw-labelled td span rewritten in the encoded form; any other token
    is returned byte-for-byte (the markup around a file line, a db row or a whole cell is never touched)."""
    inner = token[2:-2]
    display, sep, ref = inner.partition("|")
    if sep:
        canon = canonical_td_ref(ref)
        return token if canon == ref.strip() else f"[[{display.strip()}|{canon}]]"
    canon = canonical_td_ref(inner)
    return token if canon == inner.strip() else f"[[{canon}]]"


def resolve(cell_id: str, answer: str, outputs: list[dict] | None, *, keep_stale: bool = False) -> Resolved:
    """Annotate the answer's numbers with provenance links; `outputs` are the cell's mime bundles.

    A value-ref citing this cell is re-pointed at the unique td / line holding its value (a verified model span is kept), a
    number cited to the whole card stays on the card (tier 1), else it is unwrapped to its display, or with `keep_stale`
    kept as written and listed in `stale`. Value-refs to anything else pass through, with td labels encoded. Bare spans and
    non-grammar forms are first normalised (qualify_bare_spans, normalise_markup)."""
    answer = qualify_bare_spans(cell_id, normalise_markup(answer))
    src = _Sources(cell_id, outputs)
    res = Resolved(annotated="")
    seen: set[str] = set()
    out: list[str] = []
    pos = 0
    for m in _SPAN_RE.finditer(answer):
        out.append(_annotate(answer[pos : m.start()], src, res, seen))
        pos = m.end()
        display, _, ref = m.group(1).partition("|")
        display, ref = display.strip(), ref.strip()
        if not ref or not display or not src.self_ref.match(ref):
            out.append(_canonical_token(m.group()))  # a bare [[ref]], or a value-ref to a file / db row / other cell
            continue
        whole = whole_output_cell(ref) or (ref if ref in (f"card:{cell_id}", f"cell:{cell_id}") else None)
        if whole and is_label_display(display):
            # a label over this cell or one of its outputs (`[[chart|cell:X@out1]]`, `[[the table|cell:X]]`): it names
            # the link, so there is no value to find and nothing to unwrap — kept, pointed at the cell (heal.is_label)
            out.append(f"[[{display}|{whole}]]")
            continue
        neg = says_decrease(answer, m.start(), m.end())  # "[[12|…]] fewer": the td may hold -12
        canon = src.verify(ref, display, negative_ok=neg)
        hit = (canon, 2) if canon else src.lookup_display(display, negative_ok=neg)
        if hit and not canon and off_named_row(ref, hit[0], answer):
            # the value is at another row than the one the words name: kept where it was cited, named in `misplaced`
            out.append(_canonical_token(m.group()))
            res.misplaced.append(Link(display, ref, 0))
            continue
        if hit:
            out.append(f"[[{display}|{hit[0]}]]")
            res.links.append(Link(display, hit[0], hit[1]))
            if not canon and hit[0] != ref:
                res.moved[(display, hit[0])] = ref
        elif whole:
            # a number cited to the whole card that no one place holds (a count of its rows, a value shown in several
            # places) stays on the card, as a word over the card does (`[[5|card:X]]` as `[[five|card:X]]`); one the
            # card shows nowhere and its data holds as no total is named in `unresolved` as well
            out.append(f"[[{display}|{whole}]]")
            res.links.append(Link(display, whole, 1))
            if not src.supports(display):
                res.unresolved.append(display)
        elif keep_stale:
            out.append(m.group())  # the target is gone: kept for the caller to mark, not silently unlinked
            res.stale.append(Link(display, ref, 0))
        else:
            out.append(_annotate(display, src, res, seen))  # not unique: plain text (its numbers may still link)
    out.append(_annotate(answer[pos:], src, res, seen))
    res.annotated = "".join(out)
    return res

