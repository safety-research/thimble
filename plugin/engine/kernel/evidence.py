"""The deterministic check of a checker's answer: no model call, no code run. Standard library only, so the browser can
import it too.

A reply marks its claims as `[words](#)`. After the reply, the checker (a fork of the session, prompts/checker.md) gives
one answer per mark: a status (`verified`, `corrected`, `narrowed`, `wrong`, `unconfirmed`), the evidence, and for a correction
the new words, and the new sentence when words around them change too. check_mark() decides what the person sees of that
mark; its result wins over the checker's status.

What it guarantees. The checker judges what a claim means; this module makes sure the evidence it gave is real and
shows the words, so a mark is never verified on evidence the checker made up:

  computed  the evidence is a real call of the session: one of the checker's or main's Bash calls, as the transcript
            stored it. The checker names the call by the lines of its output it copies; the call's real output holds
            each of them (white space read loosely, "…" for left-out text, in any order), and the lines that hold
            them show the marked words (or the corrected words): the words whole, or each part of them that compares
            without reading meaning: each quoted part, each day, each number as a whole number of those lines (a 3
            never matches inside 2,301 or sweep3; number words read as digits; a number in a name, such as agent-11,
            Opus 4.8 or 127.0.0.1, is no value), and for words with no number each
            record name, in either case. Words with none of these ("passed when run
            alone") are the checker's reading of the output it cites, as a paraphrase of a quote is. A correction is
            no such reading: each run of words it puts in place of the marked ones stands in those lines as words, or
            by its parts that compare (a changed count), so a free description of what the output means ("looking
            only at the file summary") is not confirmed. The check reads
            the output the call really printed, never the output the checker wrote down, and it runs nothing.
            The call's code does not type in a number of the words as the printed value: given to print as is,
            assigned alone to a name, or returned; a number inside a text the code prints counts as typed only when
            the output shows it nowhere else. A number the code computes with may also stand in the printed words
            (`age < 12` and "children under 12"): a bound of a comparison, an index or a slice, an operand of
            arithmetic, an argument of another call (`head(5)`, `round(x, 2)`), a value in a list or a dict (the keys
            the code looks up), the digits of a text the code tests the records with (`"2026-06-16" <= day` and "16
            June"; `startswith("Wrapping up")` and the quoted words), the words of a line printed only when a
            condition holds, and a bound the words count under ("under 2%", "within 2 minutes", "5,000 or more"),
            which code tests in its own unit (`< 0.02`). Not caught: a value
            computed from typed numbers alone (`print(350 + 2)`), a typed list printed back, and code the call ran
            from a file.
  quote     one place or several: the file is inside the folder the session started in or the shell's folder (a
  code      relative path is read from either, since main may have run `cd`; for what code does, also the temp
            folder, where Claude keeps its own code), compared by real paths, a regular file, the line (or a range of
            at most 50 lines) exists, and the place's substring is in it: in the raw line or in the line's JSON strings
            decoded, runs of white space as one space (or as none: JSON written with no space after its colons), `**`
            and backticks as formatting, and every quote mark as the same mark (a quote inside a quote may be written
            with the other kind). The quoted words of a direct quote (the case of their first letter aside), and the
            days and numbers of the words, are in the cited lines too; a quote of what code prints may fill the
            fields of the code's template (in_code). A correction of a quote also puts in only words the cited lines
            show, as for computed evidence.
            Not checked: that a substring means what a paraphrase of it says ("agent-3 deleted the page" on a line that
            holds "page"). That is the checker's judgment; the person sees the line next to the claim.
  card      a value a card of the session shows: a cell of one of its tables (a chart's data rows are a table) or a
            line of its printed output, named by the place a card's citation names it with, `card:<id>#<col>/<row>` or
            `card:<id>@out<i>#L<n>` (labels percent-encoded as encode_label writes them). The host gives the cards'
            outputs (`cards`: [{id, title, outputs: [{out, corner?, cells: [[col, row, value]]} | {out, lines: [[n,
            text]]}]}]); the place must exist there and show the words as shows() reads them: the cell's value (with
            its row's label, which names what the value is of), or the line. The person sees the card's title and the
            table around the cell, the cell tinted.

Printed output that is a table (a printed DataFrame, aligned columns) is also read as one (text_table): computed
evidence and a card's printed line carry `table`, the header and the rows around the one that holds the words, so
the browser draws it as a small table and the terminal as its header and that row, the cited cell tinted.

A number with a scale (8k) matches the values it rounds from, a percent matches the share it is too (59.7% is 0.59718),
and after "about" a whole number matches the values that round to its zeros (about 250 is 248). A calendar day or a
range of days ("8–12 June 2026") matches the same days however they are written (2026-06-08 … 2026-06-12); another
number inside a date matches only a number of the words' own dates, and a time to the second matches its fractions.
Cited lines a few lines off from the ones that hold the words, or a few lines short of them, are moved to them. A
correction is the words that replace the mark: words of the sentence the checker repeated around them go.

A mark the checker verified whose evidence does not hold here fails as not confirmed, with one plain sentence that
says why: what the records show in place of the words, or what is missing (nearest, unshown). A mark the
checker found wrong stays failed, with its reason: the checker finds a mark wrong also for the words around it (a wrong
condition), which evidence that prints the marked words does not answer; one it found wrong and gave the right words for
is a correction. A correction whose evidence does not show its
new words is not confirmed: its evidence confirms neither the new words nor the marked ones. A narrowing (`narrowed`)
cites only a part of the marked words, which the evidence shows, and leaves the rest as the reply's own words (a
translation, a gloss): it holds only when its words are a part of the marked ones, the evidence shows them, and the
words it leaves out state no number or day, which would be a claim of the data. A rewrite (`correction.sentence`)
changes the words around the citation too, such as a paraphrase no record shows or a wrong line number: it holds only
when it stays within the sentence (one line, no sentence added, every other citation of it as it was), the evidence
shows its cited words, and each number, day or record name it puts outside the citation is one the evidence shows (a
cited place's file and line count) and none the citation cited before. The check's evidence is the citation's
evidence in every case, whatever call or place the reply pointed at. A mark the checker could
not confirm is not confirmed, never wrong. A mark with no answer, or one this
module cannot judge, fails as a check that did not run (`failedBy` `none`), which x in the tray starts again. A checker's note on the rest of the sentence stays beside the mark.

  check_all(marks, answer, calls, cwd, root, tmp, cards)  -> {parsed, results}: every mark of a reply
  check_mark(mark, item, calls, cwd, root, tmp, cards)    -> {n, status, shown, reason, failedBy?, evidence?, note?,
                                                              was?, narrowed?, rewrite?}
  card_index(cards)                                       -> the cards' places and values, one per line, for the checker
  terminal_cards(folder)                                  -> the terminal's cards (cards/<id>/meta.json, rows.json) as `cards`
  parse_answer(text)                               -> the last ```json array of the checker's answer, or None
"""
from __future__ import annotations

import ast
import difflib
import io
import json
import keyword
import math
import os
import re
import shlex
import tokenize
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import unquote

MONTHS = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
DATE_PARTS = [re.compile(p) for p in (
    r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?\b",
    rf"\b\d{{1,2}}\s*[–-]\s*\d{{1,2}}\s+{MONTHS}\b(?:,?\s+\d{{4}})?",
    rf"\b{MONTHS}\.?\s+\d{{1,2}}\s*[–-]\s*\d{{1,2}}\b(?:,?\s+\d{{4}})?",
    rf"\b\d{{1,2}}\s+{MONTHS}\b(?:,?\s+\d{{4}})?",
    rf"\b{MONTHS}\.?\s+\d{{1,2}}\b(?:,?\s+\d{{4}})?",
    rf"\b{MONTHS}\s+\d{{4}}\b",
    r"\b\d{4}-\d{2}\b(?!-\d)",
    r"\b\d{1,2}:\d{2}(?::\d{2})?\b",
)]
# A calendar day as people write it, one day or a range of days of one month: 2026-06-08, 8 June 2026, June 8, 2026,
# 8–12 June 2026, June 8–12. Each reads as the days it names (a range as its first and last day), so "8–12 June 2026"
# and an output that lists 2026-06-08 … 2026-06-12 name the same days.
MONTH_NO = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
DAYS = [re.compile(p) for p in (
    r"\b(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})(?!\d)",
    rf"\b(?P<d>\d{{1,2}})(?:\s*[–-]\s*(?P<d2>\d{{1,2}}))?(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<mn>{MONTHS})\b\.?(?:,?\s+(?P<y>\d{{4}})\b)?",
    rf"\b(?P<mn>{MONTHS})\.?\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?(?:\s*[–-]\s*(?P<d2>\d{{1,2}})(?:st|nd|rd|th)?)?\b(?:,?\s+(?P<y>\d{{4}})\b)?",
)]


def calendar_days(text: str) -> list[tuple[tuple[int, int], list[tuple[int | None, int, int]]]]:
    """Each calendar day or range of days the text names: its span, and its days as (year or None, month, day), a range
    as its first and last day. Spans of the forms overlap at most once: the first form that reads a place wins."""
    out: list[tuple[tuple[int, int], list[tuple[int | None, int, int]]]] = []
    taken: list[tuple[int, int]] = []
    for rx in DAYS:
        for m in rx.finditer(text):
            if any(a < m.end() and m.start() < b for a, b in taken):
                continue
            g = m.groupdict()
            month = int(g["m"]) if g.get("m") else MONTH_NO.get(str(g.get("mn") or "")[:3].lower(), 0)
            year = int(g["y"]) if g.get("y") else None
            days = [int(g["d"])] + ([int(g["d2"])] if g.get("d2") else [])
            if not (1 <= month <= 12 and all(1 <= d <= 31 for d in days)):
                continue
            taken.append(m.span())
            out.append((m.span(), [(year, month, d) for d in days]))
    return out


def days_shown(words: str, text: str) -> bool:
    """Each day the words name is a day the text names: the same month and day, and the same year when both give one."""
    have = [day for _, ds in calendar_days(text) for day in ds]
    return all(any(m == hm and d == hd and (y is None or hy is None or y == hy) for hy, hm, hd in have)
               for _, ds in calendar_days(words) for y, m, d in ds)


# A number as written: its digits, with `,` between groups of three (1,714) or `_` between groups (4_000), then a scale
# (8k, 1.2M, 3bn, 6.5 billion), or an ordinal ending (3rd), which names a place in an order, not a value. A comma with
# other than three digits after it separates two numbers, as in a CSV row (`2,1,2,113781`) or a list (`3,4`). A number
# right after a letter, a `_` or a `.` is part of a name (sweep3, run_2) or of another number; in an output or a file's
# line a time may follow the `T` of a date (`2026-08-30T14:29`), and a count the `x` of a multiple (`x3`).
DIGITS = r"((?:\d{1,3}(?:,\d{3})+(?!\d)|\d+(?:_\d+)*)(?:\.\d+)?)"
NUM = re.compile(r"(?<![\w.])[-−]?\$?" + DIGITS + r"(?:(st|nd|rd|th)\b|([kKMB]|bn|\sthousand|\smillion|\sbillion)\b)?")
NUM_IN_TEXT = re.compile(r"(?<![\d.])(?:(?<![A-Za-z_])|(?<=\dT)|(?<=\bx))[-−]?\$?" + DIGITS + r"(?:(st|nd|rd|th)\b|([kKMB]|bn|\sthousand|\smillion|\sbillion)\b)?")
SCALE = {"k": 1e3, "m": 1e6, "b": 1e9}
SCALE_OF = {"k": "k", "K": "k", "M": "m", "B": "b", "bn": "b", "thousand": "k", "million": "m", "billion": "b"}
NAME = re.compile(r"#\d+\b|\b[A-Za-z][\w]*[-_]\d+\b")
QUOTE_CHARS = "\"“”'‘’"
WORDNUM = {w: str(i) for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen "
    "eighteen nineteen twenty".split())}
PRINTERS = {"print", "str", "format", "repr", "f"}
MAX_RANGE = 50
# the words the person reads first on a mark whose check did not run or gave no answer (marks/store.ts NOT_RUN)
NOT_RUN = "The check did not run."
BLOCK = 1 << 20  # bytes read at a time while counting the lines before a cited one
LINE_BYTES = 1 << 20  # bytes of a cited line the check reads; a longer line is cut there
SHIFT_MAX = 5  # lines a cited line may be off by and still name the line that holds the words
OUTPUT_MAX = 20000  # characters of a call's output the evidence keeps, around its first highlight
LINE_MAX = 600  # characters of a cited line the evidence keeps, around its highlight
CONTEXT_MAX = 160  # characters of a line around the cited ones


# ------------------------------------------------------------------------------------------------ words and numbers

def norm_ws(s: Any) -> str:
    return " ".join(str(s).split())


def short(s: str, n: int) -> str:
    """At most about n characters of the text for a reason, cut at the end of a word, with "…" where it is cut."""
    s = norm_ws(s)
    return s if len(s) <= n else s[:n].rsplit(" ", 1)[0] + "…"


# ------------------------------------------------------------------------------------------------ why, for the person
#
# A failed citation says why in one plain sentence (its `reason`): the check's own when the check found the claim wrong
# or could not confirm it, else this module's, which says what the records show in place of the words, or what is
# missing, never the whole cited words again.

def sentence(clause: str) -> str:
    """A clause of a reason as the sentence the person reads: its first letter capital, a stop at its end."""
    s = norm_ws(clause)
    if not s:
        return s
    s = s[0].upper() + s[1:]
    return s if s[-1] in ".!?" else s + "."


def check_reason(reason: str, words: str) -> str:
    """The check's own reason as the sentence the person reads: a stop at its end, and a capital first letter unless
    its first word is a name (one the cited words hold, or one with a digit, a dash or a capital in it)."""
    s = norm_ws(reason)
    if not s:
        return s
    first = re.match(r"[^\s,;:]+", s)
    w = first.group(0) if first else ""
    if re.fullmatch(r"[a-z]+", w) and not re.search(rf"(?<!\w){re.escape(w)}(?!\w)", unmark(words)):
        s = s[0].upper() + s[1:]
    return s if s[-1] in ".!?\"”)" else s + "."


SENTENCE_STOP = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"“(])")


def nearest(words: str, texts: list[str], n: int = 70) -> str:
    """What the records hold nearest the words: of the lines (and the sentences in them) of `texts`, the one that
    shares the most characters with the words, at most about n characters of it around where it matches best, cut at
    words with "…". Never more than one sentence of the records, so the reason stays one sentence."""
    want = one_quote(unmark(words)).lower()
    best: tuple[int, int, str] = (-1, 0, "")
    # a JSON record reads as its string values, each alone, as the pane shows it
    lines = [x for text in texts for raw in str(text or "").splitlines() for t in ([v for v, d in shown_forms(raw) if d] or [raw]) for x in t.splitlines()]
    for part in (p for line in lines for p in SENTENCE_STOP.split(norm_ws(line)) if p):
        sm = difflib.SequenceMatcher(None, want, one_quote(part).lower(), autojunk=False)
        best = max(best, (sum(b.size for b in sm.get_matching_blocks()), -len(part), part))
    part = best[2]
    if len(part) <= n:
        return part
    m = difflib.SequenceMatcher(None, want, one_quote(part).lower(), autojunk=False).find_longest_match(0, len(want), 0, len(part))
    b = min(len(part), max(0, m.b + m.size // 2 - n // 2) + n)
    a = max(0, b - n)
    if a > 0 and part.find(" ", a, b) > 0:
        a = part.find(" ", a, b) + 1
    if b < len(part) and part.rfind(" ", a, b) > a:
        b = part.rfind(" ", a, b)
    return ("…" if a > 0 else "") + part[a:b].strip(" ,;:") + ("…" if b < len(part) else "")


def unshown(words: str, text: str, approx: bool = False) -> str:
    """What of the words the text does not show, as the reason names it: the quoted words, a day, the numbers, the
    record names; "these words" when none of these stands out."""
    w = unmark(words)
    gone = [f for f in quote_fragments(w) if not any(bounded_in(one_quote(g), one_quote(text)) for g in (f, f[:1].swapcase() + f[1:]))]
    if gone:
        # a short quoted part by its words; a long one, or one that is all the cited words, as what it is
        named = " or ".join(f"“{f}”" for f in gone)
        whole = len(" ".join(gone)) >= len(w.strip(QUOTE_CHARS + " .")) - 3
        return named if len(named) <= 44 and not whole else "the quoted words"
    if calendar_days(w) and not days_shown(w, text):
        day = next((m.group(0) for p in DATE_PARTS for m in [p.search(w)] if m), "")
        return f"the day {day}" if day else "the day the words name"
    said = wordnums(text, counts=True)
    nums = [v for v, d in marked_numbers(wordnums(w, counts=True)) if not has_number(v, said, dates=d, approx=approx)]
    if nums:
        return " or ".join(dict.fromkeys(nums))
    names = [x for x in NAME.findall(w) if not has_name(x, text)]
    if names:
        return " or ".join(dict.fromkeys(names))
    return "these words"


def instead(where: str, words: str, texts: list[str], approx: bool = False) -> str:
    """The clause that says what a place holds in place of the words, as a reason ends it: `line 3 of board.md reads
    “bye”, not the quoted words`."""
    near = nearest(words, texts)
    missing = unshown(words, "\n".join(texts), approx)
    return f"{where} reads “{near}”, not {missing}" if near else f"{where} is empty"


QUOTES = str.maketrans({c: '"' for c in "“”‘’'"})


def one_quote(s: str) -> str:
    """Every quote mark as `"`: a quote inside a quote is written with either kind ("'personal'" for '"personal"'), and
    an apostrophe with either form (’ or ')."""
    return s.translate(QUOTES)


MD_ESCAPE = re.compile(r"\\([!-/:-@\[-`{-~])")


def md_unescaped(s: str) -> str:
    """A reply's words with markdown's backslash escapes read as the marks they stand for (`GH\\#65915` is GH#65915,
    `\\*` is *), as the person reads them; inside a code span a backslash is written as is."""
    return "".join(p if p.startswith("`") else MD_ESCAPE.sub(r"\1", p) for p in re.split(r"(`[^`]*`)", s))


def unmark(s: Any) -> str:
    """Markdown emphasis and code marks are formatting, not words."""
    return norm_ws(str(s).replace("**", "").replace("`", ""))


def num_value(tok: str, scale: str | None = None) -> str:
    """A number token as one form: 1,714 and 4_000 are 1714 and 4000, 09 is 9, $40 is 40; a decimal keeps the places
    it is written with, since they say how exact it is (3.0 is 3.0: 3.1 is not 3.0); with a scale, the digits and the
    scale's letter (`8k`; `1.2M` and `1.2 million` are `1.2m`)."""
    t = tok.replace(",", "").replace("_", "").replace("$", "").replace("−", "-")
    try:
        d = Decimal(t)
    except InvalidOperation:
        return t
    if not d.is_finite():
        return t
    one = str(d) if "." in t else str(int(d))
    return one + SCALE_OF[scale.strip()] if scale else one


def number_at(m: re.Match) -> str | None:
    """A match of NUM as its value, or None for an ordinal (`3rd`)."""
    return None if m.group(2) else num_value(m.group(1), m.group(3))


def rounds_to(x: float, places: int) -> float:
    """x rounded half up to `places` decimals, as a person rounds (24.5 is 25)."""
    q = 10 ** places
    return math.floor(abs(x) * q + 0.5 + 1e-9) / q * (1 if x >= 0 else -1)


def same_number(v: str, w: str, approx: bool = False) -> bool:
    """`v`, a number of the marked words, and `w`, one of an output, in one form, are the same value: `w` rounded to the
    places `v` is written with is `v` (24 is 24.2, 48.4% is 48.43%, never 48.5%). A number with a scale is the value
    rounded to it: `8k` is any number from 7,500 to 8,499, `1.2m` any from 1,150,000 to 1,249,999. With `approx` (the
    words say "about"), a whole number that ends in zeros is the value rounded to them: "about 250" is 248, "about 700"
    is 650 to 749."""
    if v == w:
        return True
    zeros = len(v) - len(v.rstrip("0")) if approx and v.isdigit() else 0
    if 0 < zeros < len(v):
        try:
            return int(rounds_to(float(w) / 10 ** zeros, 0)) * 10 ** zeros == int(v)
        except ValueError:
            return False
    scale = next((k for k in SCALE if v.endswith(k) and v[:-1][-1:].isdigit()), None)
    digits = v[:-len(scale)] if scale else v
    try:
        want = float(digits)
        x = float(w[:-len(scale)]) * SCALE[scale] if scale and w.endswith(scale) else float(w)
    except ValueError:
        return False
    places = len(digits.split(".")[1]) if "." in digits else 0
    if not scale and len(w.split(".")[1] if "." in w else "") <= places:
        # an output as exact as the words, or less, shows them only when it is the same value (1 is 1.0)
        return x == want
    return rounds_to(x / (SCALE[scale] if scale else 1), places) == want


def names_record(text: str, m: re.Match) -> bool:
    """The number is part of a name, not a value: after `#` (`#118`), after a letter and a hyphen (`agent-11`), a part
    of a dotted name (`127.0.0.1`, `2.1.307`), or a version right after a name inside the words (`on Opus 4.8`, `Claude
    Sonnet 4.6`). A capitalized word that opens the words is no sign of a name ("Median 2.5 hours")."""
    before, after = text[:m.start()], text[m.end(1):]
    if text[max(0, m.start() - 1):m.start()] == "#" or re.search(r"[A-Za-z][-_]$", before) or re.match(r"\.\d", after):
        return True
    return "." in m.group(1) and bool(re.search(r"\S\s+[A-Z][A-Za-z]*\s$", before)) and not re.match(r"\s*%", after)


def numbers(text: str) -> list[str]:
    """The numbers of a text, each in one form; a number that is part of a name (`#118`, `agent-11`) and an ordinal
    (`3rd`) are left out."""
    return [v for m in NUM.finditer(text) if not names_record(text, m) for v in [number_at(m)] if v is not None]


def marked_numbers(words: str) -> list[tuple[str, bool]]:
    """The numbers of marked words, each with whether it stands in a date or a time of the words. The numbers of a
    calendar day are left out: days_shown() compares the days themselves."""
    spans = date_spans(words)
    days = [span for span, _ in calendar_days(words)]
    return [(v, any(a <= m.start(1) < b for a, b in spans)) for m in NUM.finditer(words)
            if not names_record(words, m) and not any(a <= m.start(1) < b for a, b in days) for v in [number_at(m)] if v is not None]


def wordnums(s: str, counts: bool = False) -> str:
    """Number words as digits: "five of the twelve" is "5 of the 12", and "half" is 50 (a share in percent). With
    `counts`, "one" stays a word: it is more often an article ("one page every 9 seconds") than a count. A number word
    after "these" or "those" points back to things already named ("these two removed …"): it counts nothing."""
    words = [w for w in WORDNUM if not (counts and w == "one")]
    return re.sub(r"(?<!these )(?<!those )\b(" + "|".join(words) + r"|half)\b", lambda m: WORDNUM.get(m.group(1).lower(), "50"), s, flags=re.I)


def date_spans(text: str) -> list[tuple[int, int]]:
    out = []
    for rx in DATE_PARTS:
        out += [m.span() for m in rx.finditer(text)]
    return out


# a bound the words count under: "under 2%", "within 2 minutes", "5,000 or more"
BOUND_BEFORE = re.compile(r"(?:\b(?:under|below|over|above|within|at least|at most|more than|less than|fewer than|up to)|[<>≤≥])\s*$", re.I)
BOUND_AFTER = re.compile(r"\s*(?:%|percent)?\s*(?:or (?:more|fewer|less|longer|shorter)\b|\+)", re.I)


def cited_numbers(words: str) -> set[str]:
    """The numbers of the marked words that the evidence must not type in: each number outside a date or a time, and
    outside a direct quote. A date in code names the period the code counts (`n['2025-04']`, `f"April 2025: {n}"`), so
    a date is never a typed value. A number in a quote is part of the record's words, which must come from the record
    (typed_quote). A number that is part of a name (`#118`, `agent-11`) is no value either, and neither is a bound the
    words count under ("under 2%", "within 2 minutes", "5,000 or more"): code tests it in its own unit (`< 0.02`,
    `< 120` seconds) and may write it in the words it prints."""
    words = re.sub(r"[\"“][^\"“”]+[\"”]", " ", wordnums(words))
    dates = date_spans(words)
    return {v for m in NUM.finditer(words) if not names_record(words, m) and not any(a <= m.start(1) < b for a, b in dates)
            and not BOUND_BEFORE.search(words[:m.start()]) and not BOUND_AFTER.match(words[m.end():]) for v in [number_at(m)] if v is not None}


TIME_END = re.compile(r"\d{1,2}:\d{2}:\d{2}$")


def bounded_find(needle: str, hay: str) -> int:
    """Where `needle` stands in `hay` and not as a part of a longer number, or -1. A time to the second matches the
    same time with fractions of a second (21:29:27 in 21:29:27.806Z), as a person reads the time."""
    if not needle:
        return -1
    start = 0
    seconds = TIME_END.search(needle) is not None
    while True:
        i = hay.find(needle, start)
        if i < 0:
            return -1
        j = i + len(needle)
        before, after = hay[i - 1:i], hay[j:j + 2]
        ok_b = not (needle[0].isdigit() and (before.isdigit() or (before != "" and before in ".," and i >= 2 and hay[i - 2].isdigit())))
        fraction = seconds and after[:1] == "." and after[1:2].isdigit()
        ok_a = fraction or not (needle[-1].isdigit() and (after[:1].isdigit() or (after[:1] != "" and after[:1] in ".," and after[1:2].isdigit())))
        if ok_b and ok_a:
            return i
        start = i + 1


def bounded_in(needle: str, hay: str) -> bool:
    return bounded_find(norm_ws(needle), norm_ws(hay)) >= 0


def has_number(v: str, text: str, dates: bool = True, approx: bool = False) -> bool:
    """`v` (a number in one form) is one of the numbers of `text`, compared as values: 6 matches 6.0, 9 matches 09, 8k
    matches 8,225. With `dates` False, a number inside a date or a time of the text does not count (a count of 12 is
    not the 12 of 2026-10-12)."""
    t = norm_ws(text)
    spans = [] if dates else date_spans(t)
    for m in NUM_IN_TEXT.finditer(t):
        w = number_at(m)
        if w is not None and not any(a <= m.start(1) < b for a, b in spans) and same_number(v, w, approx):
            return True
    return False


# a value a template fills in, as a quote of what code prints writes it: `{why}`, `${key}`, `<name>`, a word in capitals
# (N, NAME), a number, or "…"
FIELD = re.compile(r"\$?\{[^{}]*\}|<[^<>]*>|\b[A-Z][A-Z_]*\b|(?<![\w.])\d[\d,.]*|…|\.\.\.")


def in_code(frag: str, hay: list[str]) -> bool:
    """A quote of what code prints stands in the cited code: each run of its words between the values a template fills
    in (FIELD) is made of pieces of the code's text, each piece two words or more, or the whole run (a word of
    punctuation alone, such as "·", is no word here). So "120 of 412
    records · 3 calls failed" holds in `${n(done)} of ${n(of)} records · ${n(failed)} calls failed`, and "the sign-in
    failed. Sign in again with /login" in a line that joins `the sign-in failed. ${SIGN_IN_AGAIN}` and the line that sets
    that constant."""
    texts = [one_quote(unmark(h)) for h in hay]
    for run in FIELD.split(one_quote(unmark(frag))):
        words = [w for w in run.split() if any(c.isalnum() for c in w)]
        i = 0
        while i < len(words):
            k = next((k for k in range(len(words), i, -1) if any(" ".join(words[i:k]) in t for t in texts)), i)
            if k == i or (k - i < 2 and (i, k) != (0, len(words))):
                return False
            i = k
    return True


def in_text(frag: str, hay: str) -> bool:
    """A quoted fragment stands in a text, the case of its first letter aside: a quote worked into a sentence starts
    with a small letter where the record starts its sentence with a capital ("the only finalist" for "The only
    finalist")."""
    f, h = one_quote(unmark(frag)), one_quote(hay)
    return bool(f) and (f in h or f[:1].swapcase() + f[1:] in h)


def has_name(name: str, text: str) -> bool:
    """A record's name (`#118`, `agent-11`) stands in the text as a whole word, in either case (Opus-5 and opus-5); a
    number name (`#118`) also as its number (118), as a table or a list prints it."""
    if re.search(r"(?<![\w#-])" + re.escape(name) + r"(?![\w-])", text, re.I):
        return True
    return name.startswith("#") and has_number(name[1:], text, dates=False)


LABEL = re.compile(r"^([ \t]*)\d{1,3}:[ \t]+", re.M)


def unlabeled(out: str) -> str:
    """The output without the labels that open its lines (`9: 2 of 21` is `2 of 21`): a number of up to three digits,
    as code numbers the rows it prints. A longer number, such as a year (`2026: 3–12%`), is the line's subject."""
    return LABEL.sub(r"\1", out)


def shows(target: str, out: str, approx: bool = False) -> bool:
    """The output holds the marked words: whole, or with number words as digits, or each part of the words that can
    be compared without reading meaning: each quoted part (`"added", "context" or "removed"`), each day as a day of
    the output, each number as a whole number of it, and, for words with no number, each record name (`#102, #125 and
    #130`). Words with none of these ("passed when run alone") are the check's reading of the output it cites, as a
    paraphrase of a quote is: the person sees that output next to the claim. A label that opens a line (`9: `) is no
    part of the output, `**` and backticks in it are formatting, and a line break that repr() printed as `\\n`, in the
    output or in the words, is a line break."""
    target, out = unescaped(target), unlabeled(unescaped(out))
    plain = unmark(out)
    if bounded_in(target, out) or bounded_in(target, plain):
        return True
    bare = target.strip(QUOTE_CHARS + " ")
    if bounded_in(bare, out) or bounded_in(bare, plain) or bounded_in(wordnums(target), wordnums(out)):
        return True
    frags = quote_fragments(target)
    if not all(any(bounded_in(one_quote(g), one_quote(o)) for g in (f, f[:1].swapcase() + f[1:]) for o in (out, plain)) for f in frags):
        return False
    if calendar_days(target) and not days_shown(target, out):
        return False
    nums = marked_numbers(wordnums(target, counts=True))
    if nums:
        pct = percents(target)
        rough = approx_numbers(wordnums(target, counts=True))
        out = wordnums(out, counts=True)
        return all(has_number(v, out, dates=d, approx=approx or v in rough) or (v in pct and has_number(fraction(v), out, approx=approx or v in rough)) for v, d in nums)
    return bool(frags or calendar_days(target)) or all(has_name(x, out) for x in NAME.findall(target))


def unescaped(out: str) -> str:
    """The text with the escapes that repr() prints for white space and quote marks (`\\n`, `\\t`, `\\'`) read as what
    they stand for: a white space escape as a space (white space compares loosely), a quote mark as the mark; code
    prints a record's text with repr() to show its line breaks, and a reply may quote it so. Both the words and the
    output are read so, so a real backslash (`C:\\new`) changes in both alike."""
    return re.sub(r"\\([nrt'\"])", lambda m: m.group(1) if m.group(1) in "'\"" else " ", out)


def says(words: str, text: str) -> bool:
    """The words stand in the text as words, the case aside: `diff` in "git diff", never in "diffs"; formatting, quote
    marks, white space and the punctuation at their ends compared as shows() compares them."""
    w = norm_ws(one_quote(unmark(unescaped(words)))).strip(' "().,;:!?').lower()
    if not w:
        return True
    t = norm_ws(one_quote(unmark(unescaped(text)))).lower()
    rx = (r"(?<!\w)" if w[0].isalnum() else "") + re.escape(w) + (r"(?!\w)" if w[-1].isalnum() else "")
    return bool(re.search(rx, t) or re.search(rx, wordnums(t)))


def comparable(words: str) -> bool:
    """The words hold a part that compares without reading meaning: a quoted part, a day, a number or a record name."""
    w = wordnums(words, counts=True)
    return bool(quote_fragments(words) or calendar_days(words) or marked_numbers(w) or NAME.search(words))


def put_in(was: str, new: str) -> list[str]:
    """The runs of a correction's words that it puts in place of the marked words ("254" for 256, "looking only at the
    file summary" for "reading the diff"): the words the marked ones do not hold at that place, compared as words, the
    case, formatting, quote marks and the punctuation at their ends aside. Words it only leaves out put nothing in."""
    a, b = unmark(was).split(), unmark(new).split()
    key = lambda x: one_quote(x).strip(' "().,;:!?').lower()  # noqa: E731
    sm = difflib.SequenceMatcher(None, [key(x) for x in a], [key(x) for x in b], autojunk=False)
    return [" ".join(b[j1:j2]) for op, _, _, j1, j2 in sm.get_opcodes() if op in ("replace", "insert")]


def unshown_change(was: str, new: str, text: str, approx: bool = False) -> list[str]:
    """The runs a correction puts in that the evidence does not show. A correction says the data show other words than
    the marked ones, so each run it puts in must stand in the evidence: as words of it, or by its parts that compare
    without reading meaning (a changed count, a day, a name), as shows() reads them. A run with none of these and not
    in the evidence as words ("looking only at the file summary" for a call that printed `--stat` output) is the
    checker's own description, which the evidence does not confirm."""
    return [r for r in put_in(was, new) if not says(r, text) and not (comparable(r) and shows(r, text, approx))]


def approx_numbers(words: str) -> set[str]:
    """The numbers of the words that "about" (or ~, roughly …) comes right before: "about 4,000 times and about 100"."""
    return {v for m in NUM.finditer(words) if APPROX.search(words[:m.start()]) for v in [number_at(m)] if v is not None}


def percents(words: str) -> set[str]:
    """The numbers of the words that are percents (`48.4%`, `48 percent`), each in one form."""
    return {num_value(m.group(1)) for m in re.finditer(r"(?<![\w.])(\d+(?:\.\d+)?)\s*(?:%|percent\b)", words)}


def fraction(v: str) -> str:
    """A percent as the share it is (59.7 is 0.597), the digits kept: an output may print the share."""
    return num_value(str(Decimal(v) / 100))


def spans_of(target: str, out: str) -> list[list[int]]:
    """Where the output shows the words, for the pane: the words whole (white space as written in the output), else
    each of their numbers (a percent also as its share)."""
    words = [w for w in norm_ws(target.strip(QUOTE_CHARS + " ")).split(" ") if w]
    if words:
        rx = re.compile(r"\s+".join(re.escape(w) for w in words))
        for m in rx.finditer(out):
            a, b = m.span()
            if not (out[a:a + 1].isdigit() and out[a - 1:a].isdigit()) and not (out[b - 1:b].isdigit() and out[b:b + 1].isdigit()):
                return [[a, b]]
    hits = []
    pct = percents(target)
    for v in numbers(wordnums(target)):
        for m in NUM_IN_TEXT.finditer(out):
            w = number_at(m)
            if w is not None and (same_number(v, w) or (v in pct and same_number(fraction(v), w))):
                hits.append([m.start(1), m.end(1)])
                break
    for x in NAME.findall(target):
        m = re.search(r"(?<![\w#-])" + re.escape(x) + r"(?![\w-])", out)
        if m:
            hits.append([m.start(), m.end()])
    return sorted(hits)


# ------------------------------------------------------------------------------------------------ typed-in values

ARITH = {"+", "-", "*", "/", "//", "%", "**", "@"}


def tokens(code: str) -> list[tokenize.TokenInfo]:
    """The code's tokens, each f-string as one STRING token whatever the Python version (from 3.12 the tokenizer splits
    an f-string into parts; before, it is one token). Raises what tokenize raises."""
    raw = list(tokenize.generate_tokens(io.StringIO(code).readline))
    start_t = getattr(tokenize, "FSTRING_START", None)
    if start_t is None:
        return raw
    offsets = [0]
    for line in code.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    at = lambda pos: offsets[pos[0] - 1] + pos[1]  # noqa: E731
    out: list[tokenize.TokenInfo] = []
    depth, first = 0, None
    for t in raw:
        if t.type == start_t:
            if depth == 0:
                first = t
            depth += 1
        elif t.type == tokenize.FSTRING_END and depth:
            depth -= 1
            if depth == 0 and first is not None:
                out.append(tokenize.TokenInfo(tokenize.STRING, code[at(first.start):at(t.end)], first.start, t.end, first.line))
        elif depth == 0:
            out.append(t)
    return out


def fstring_parts(s: str) -> tuple[list[str], list[str]] | None:
    """An f-string's literal text, in the parts between its fields, and each field's expression (its format spec and
    conversion left out); None for a string that is no f-string."""
    m = re.match(r"([A-Za-z]*)('''|\"\"\"|'|\")", s)
    if not m or "f" not in m.group(1).lower():
        return None
    q = m.group(2)
    body = s[m.end():len(s) - len(q)] if s.endswith(q) else s[m.end():]
    parts, fields, buf, i, n = [], [], "", 0, len(body)
    while i < n:
        c = body[i]
        if c in "{}" and body[i + 1:i + 2] == c:
            buf += c
            i += 2
            continue
        if c != "{":
            buf += c
            i += 1
            continue
        parts.append(buf)
        buf = ""
        j, depth, quote, stop = i + 1, 0, "", None
        while j < n:
            ch = body[j]
            if quote:
                quote = "" if ch == quote else quote
            elif ch in "'\"":
                quote = ch
            elif ch in "([{":
                depth += 1
            elif ch in ")]":
                depth -= 1
            elif ch == "}":
                if depth == 0:
                    break
                depth -= 1
            elif depth == 0 and stop is None and (ch == ":" or (ch == "!" and body[j + 1:j + 2] != "=")):
                stop = j
            j += 1
        fields.append(body[i + 1:j if stop is None else stop].strip().rstrip("=").strip())
        i = j + 1
    parts.append(buf)
    return parts, fields


# a path or a file's name in a string (`runs/a.jsonl`, `cv_detect.py`): its digits name the file, they are no value
PATHLIKE = re.compile(r"[^\s\"'(),;]*/[^\s\"'(),;]*|[\w.-]*\w\.[A-Za-z][A-Za-z0-9]{0,5}\b(?!\.\d)")


def literals(code: str) -> list[tuple[str, str, str]]:
    """(kind, value, text) of each number the code types where it is the printed value: a NUMBER token (kind `number`)
    given to print() or a format as a whole argument, assigned alone to a name (`n = 15`), or returned; and each number
    inside the text of a string the code prints or assigns (kind `text`, with that text). A bound in a comparison, a key,
    an index, an operand of arithmetic (`len(rates) // 2`), an argument of another call (`round(x, 2)`, `hours=2`) and a
    value in a list or a dict is a condition, not a printed value; so are the words of a string printed only when a
    condition holds (`"no gap exceeds 5 minutes" if worst <= 300 else …`). A number inside a string is left out in a
    format spec, in a path or a file's name, as a part of a name (agent-02), as a bound of a range ("teen 13-17") and as
    a label that opens a string (`"9: "`). The fields of an f-string are read as code of their own."""
    out: list[tuple[str, str, str]] = []
    try:
        toks = tokens(code)
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return [("number", v, "") for v in numbers(code)]
    prev = None
    stack: list[str] = []
    for i, t in enumerate(toks):
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if t.type == tokenize.OP and t.string in "([{":
            stack.append(opener_of(t, prev))
        elif t.type == tokenize.OP and t.string in ")]}" and stack:
            stack.pop()
        # the place a value here takes: the innermost call, index or compared list around it, through plain brackets
        call = next((x for x in reversed(stack) if x not in ("(", "[", "{")), None)
        printed = call in PRINTERS
        if t.type == tokenize.NUMBER:
            v = num_value(t.string.replace("_", ""))
            ends = nxt is None or nxt.type in (tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER, tokenize.COMMENT) or (nxt.type == tokenize.OP and nxt.string == ";")
            # `n = 15` alone on its line; `hours=2` inside a call is an argument
            assigned = prev is not None and prev.type == tokenize.OP and prev.string in ("=", "+=") and ends and not stack
            # (a `[` or `:` is an index or a slice's bound inside an index; in a list or a dict it opens a value)
            bound = prev is not None and prev.type == tokenize.OP and (prev.string in ("<", ">", "<=", ">=", "==", "!=")
                                                                       or (prev.string in ("[", ":") and stack[-1:] == ["sub"]))
            # a dict's key looks a value up (`{10: "ten"}[n]`); it is not the value
            key = nxt is not None and nxt.type == tokenize.OP and nxt.string == ":" and stack[-1:] != ["sub"]
            returned = prev is not None and prev.type == tokenize.NAME and prev.string in ("return", "yield")
            if (assigned or (printed and not bound and not key) or returned) and not operand(toks, i):
                out.append(("number", v, ""))
        elif t.type == tokenize.STRING:
            s = t.string
            assigned = prev is not None and prev.type == tokenize.OP and prev.string in ("=", "+=") and not stack
            returned = prev is not None and prev.type == tokenize.NAME and prev.string in ("return", "yield")
            chosen = (nxt is not None and nxt.type == tokenize.NAME and nxt.string == "if") or (prev is not None and prev.type == tokenize.NAME and prev.string == "else")
            if (printed or assigned or returned) and not chosen and not is_comparison(prev):
                fs = fstring_parts(s)
                texts = fs[0] if fs else [string_value(s)]
                for k, raw in enumerate(texts):
                    text = PATHLIKE.sub(lambda m: " " * len(m.group(0)), raw)
                    out += [("text", v, raw) for m in NUM.finditer(text) if not re.search(r"[A-Za-z][-_]$", text[:m.start()]) and not in_range(text, m) and not (k == 0 and opens_label(text, m))
                            for v in [number_at(m)] if v is not None]
                for expr in fs[1] if fs else []:
                    out += literals(f"print({expr})")
        prev = t
    return out


def string_value(s: str) -> str:
    """A plain string token's text (`"a\\tb"` is a, a tab, b); "" for any other token (`b"…"`)."""
    try:
        v = ast.literal_eval(s)
    except (ValueError, SyntaxError):
        return ""
    return v if isinstance(v, str) else ""


def opener_of(t: tokenize.TokenInfo, prev: Any) -> str:
    """What an opening bracket opens, for the stack literals() keeps: `cond` for a tuple or list a value is compared with
    (`r["c"] in ("1", "2")`), `sub` for an index or a key (`rows[2]`, `n["01"]`), a call's name, or the bracket."""
    if is_comparison(prev):
        return "cond"
    if prev is not None and t.string == "[" and (prev.type == tokenize.STRING or (prev.type == tokenize.OP and prev.string in ")]") or (prev.type == tokenize.NAME and not keyword.iskeyword(prev.string))):
        return "sub"
    if prev is not None and prev.type == tokenize.NAME and t.string == "(":
        return prev.string
    return t.string


def operand(toks: list[tokenize.TokenInfo], i: int) -> bool:
    """The number at toks[i] is an operand of arithmetic (`n // 2`, `2 * x`), not a value by itself. A minus sign right
    after an opening bracket, a comma, `=` or a keyword makes a negative number, which is a value."""
    op = lambda k: 0 <= k < len(toks) and toks[k].type == tokenize.OP and toks[k].string in ARITH  # noqa: E731
    if op(i + 1):
        return True
    if not op(i - 1):
        return False
    before = toks[i - 2] if i >= 2 else None
    unary = toks[i - 1].string in ("-", "+") and (before is None or (before.type == tokenize.OP and before.string in "([{,=:") or (before.type == tokenize.NAME and keyword.iskeyword(before.string)))
    return not unary


def is_comparison(tok: Any) -> bool:
    """A token after which a value is a condition: a comparison operator, or `in`."""
    return tok is not None and (tok.type == tokenize.OP and tok.string in ("==", "!=", "<", ">", "<=", ">=") or tok.type == tokenize.NAME and tok.string == "in")


def opens_label(s: str, m: re.Match) -> bool:
    """The number opens the string as a label, `"9: "`, as code numbers what it prints (unlabeled() takes such labels
    off the output, so a label never shows a value)."""
    return bool(re.match(r"^[\s\"'f]*$", s[:m.start()]) and re.match(r":\s", s[m.end():]))


def in_range(s: str, m: re.Match) -> bool:
    """The number is one end of a range written in a label: `13-17`, `0–12`."""
    return bool(re.match(r"\s*[-–]\s*\d", s[m.end():]) or re.search(r"\d\s*[-–]\s*$", s[:m.start()]))


def all_numbers(code: str) -> set[str]:
    """Every number token of the code, the fields of its f-strings included."""
    toks = tokens(code)
    out = {num_value(t.string.replace("_", "")) for t in toks if t.type == tokenize.NUMBER}
    for t in toks:
        fs = fstring_parts(t.string) if t.type == tokenize.STRING else None
        for expr in fs[1] if fs else []:
            try:
                out |= all_numbers(f"({expr})")
            except (tokenize.TokenError, SyntaxError, IndentationError):
                pass
    return out


def conditions(code: str) -> set[str]:
    """The numbers the code uses as conditions: number tokens in a comparison or an argument (`age < 12`, `head(5)`),
    and the digits of each text it tests the records with (`r["Ticket"] == "239853"`, `"2026-06-16" <= day`,
    `glob("runs/sweep[23]*")`), since printed words often name such a condition in their own form ("16 June")."""
    try:
        every = all_numbers(code)
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return set()
    tested = {num_value(d) for text in string_values(code)[1] for d in re.findall(r"\d+", text)}
    return (every - {v for kind, v, _ in literals(code) if kind == "number"}) | tested


def string_values(code: str) -> tuple[list[str], list[str]]:
    """The text of each string the code prints or assigns (a plain string's value, an f-string's text between its
    fields), as literals() reads a number's place, and of each string it tests the records with: compared with
    something (`r["v"] == "yes"`, `"words" in body`) or given to a call that is no print (`s.startswith("Wrapping
    up")`, `re.search("fail", s)`, `open("runs/a.jsonl")`). A key (`r["v"]`) is neither."""
    out: list[str] = []
    tested: list[str] = []
    try:
        toks = tokens(code)
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return out, tested
    stack: list[str] = []
    prev = None
    for i, t in enumerate(toks):
        if t.type == tokenize.OP and t.string in "([{":
            stack.append(opener_of(t, prev))
        elif t.type == tokenize.OP and t.string in ")]}" and stack:
            stack.pop()
        if t.type == tokenize.STRING:
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            call = next((x for x in reversed(stack) if x not in ("(", "[", "{", "cond")), None)
            assigned = prev is not None and prev.type == tokenize.OP and prev.string in ("=", "+=") and not stack
            compared = is_comparison(prev) or is_comparison(nxt)
            fs = fstring_parts(t.string)
            texts: list[Any] = list(fs[0]) if fs else []
            if not fs:
                texts = [string_value(t.string)]
            for text in texts:
                if isinstance(text, str) and (compared or (call is not None and call not in PRINTERS and call != "sub")):
                    tested.append(text)
                elif isinstance(text, str) and (call in PRINTERS or assigned):
                    out.append(text)
        prev = t
    return out, tested


def typed_quote(words: str, code: str) -> list[str]:
    """The quoted words of a direct quote that the code writes itself, in a string it prints, so that its output shows
    them whatever the records say. Code that prints them only after it found them in a record (`if "…" in body:`)
    reads them from the record. A quoted single word ("yes") names a value, as a label's, and is no quote."""
    printed, tested = string_values(code)
    has = lambda f, xs: any(norm_ws(f) in norm_ws(x) for x in xs)  # noqa: E731
    return [f for f in quote_fragments(words) if len(f.split()) > 1 and has(f, printed) and not has(f, tested)]


def typed_values(words: str, code: str) -> tuple[list[str], dict[str, list[str]]]:
    """The numbers of the words that the code types in as a printed value (0 and 1 are never a typed value), and those
    it types inside the text of a string it prints, with those texts: such a number is typed only when the output shows
    it nowhere but in that text (`print("n hits:", len(hits))` and `print("all 15 had a timeout")` print 15 twice when
    15 calls hit). A number the code uses as a condition may stand in its printed words too: `print(f"{n} children
    under 12")` after `age < 12`."""
    nums = cited_numbers(words) - conditions(code)
    hard: set[str] = set()
    texts: dict[str, list[str]] = {}
    for kind, v, text in literals(code):
        if v not in nums or (kind == "number" and v in ("0", "1")):
            continue
        if kind == "text":
            texts.setdefault(v, []).append(text)
        else:
            hard.add(v)
    return sorted(hard), {v: t for v, t in texts.items() if v not in hard}


def without_texts(out: str, texts: list[str]) -> str:
    """The output with each of the code's printed texts taken out where it stands whole, white space read loosely."""
    out = norm_ws(out)
    for t in sorted({norm_ws(x.replace("\\n", "\n").replace("\\t", "\t")) for x in texts} - {""}, key=len, reverse=True):
        out = out.replace(t, " | ")
    return out


# ------------------------------------------------------------------------------------------------ computed evidence

HEREDOC = re.compile(r"<<-?[ \t]*(['\"]?)(\w+)\1[^\n]*\n(.*?)\n[ \t]*\2[ \t]*(?=\n|$)", re.S)
RUNS_SCRIPT = re.compile(r"(?:cd\s+\S+\s*(?:&&|;|\n)\s*)?\S*python[\d.]*\s+(?:-\S+\s+)*-\s*<<-?[ \t]*(['\"]?)(\w+)\1[ \t]*")


def scripts(command: str) -> list[str]:
    """The code a shell command runs, where a value it types in can stand: each here-document's body (`python3 - <<'PY'
    … PY`) and each `python3 -c` argument, else the command itself."""
    out = [m.group(3) for m in HEREDOC.finditer(command)]
    if re.search(r"python[\d.]*\s", command):
        try:
            words = shlex.split(HEREDOC.sub("", command))
        except ValueError:
            words = []
        out += [words[i + 1] for i, w in enumerate(words[:-1]) if w == "-c"]
    return out or [command]


ABS_PATH = re.compile(r"(?<![\w./~$-])/[^\s'\"`;&|()<>,]*")


def from_folder(command: str, folder: str | None) -> str:
    """The command as it ran from the session's folder: a leading `cd` to that folder left out, one to a folder inside
    it written relative to it, and each other path inside it written relative to where the command ran. The person
    sees what the command did, never where the session's folder is."""
    f = os.path.normpath(os.path.abspath(folder)) if folder else ""
    if not f or f == "/":
        return command

    def within(p: str) -> bool:
        return p == f or p.startswith(f + "/")

    base = f
    m = LEADING_CD.match(command)
    d = os.path.normpath(m.group(1).strip("'\"")) if m else ""
    if m and os.path.isabs(d) and within(d):
        base = d
        r = os.path.relpath(d, f)
        command = command[m.end():].lstrip(" \t") if r == "." else command[:m.start(1)] + r + command[m.end(1):]
        head = "" if r == "." else command[:m.start(1) + len(r)]
    else:
        head = ""

    def rel(x: re.Match[str]) -> str:
        p = os.path.normpath(x.group(0))
        if not within(p):
            return x.group(0)
        r = os.path.relpath(p, base)
        return r + "/" if x.group(0).endswith("/") and r != "." else r

    return head + ABS_PATH.sub(rel, command[len(head):])


def shown_code(command: str, folder: str | None = None) -> str:
    """The code the pane shows for a call: the script alone when the call only runs one (`python3 - <<'PY'`, the
    script, `PY`, after a `cd` at most), else the whole command, since its other parts printed into the same output.
    Paths inside the session's folder are relative to it (from_folder)."""
    command = from_folder(command, folder)
    m = HEREDOC.search(command)
    if not m or command[m.end():].strip():
        return command
    head = (command[:m.start()] + m.group(0).split("\n", 1)[0]).strip()
    return m.group(3) if RUNS_SCRIPT.fullmatch(head) else command


def output_parts(given: Any) -> list[str]:
    """The output the check gave, as its lines, each cut where it put "…" for left-out text: its parts, runs of white
    space as one space. The check may copy a few lines of an output and leave out the lines between them, and may give
    the lines as one text or as a list."""
    text = "\n".join(map(str, given)) if isinstance(given, list) else str(given or "")
    return [p for p in (norm_ws(x) for x in re.split(r"…|\.\.\.|\n", text)) if p]


def printed(given: Any, output: str) -> list[int] | None:
    """Where a call's output holds the output the check gave (each of its parts, white space read loosely, in any
    order: the check may copy lines in the order the claim names them): the span of the whole lines that hold its
    parts, from the first to the last, or None."""
    parts = output_parts(given)
    if not parts or any(p not in norm_ws(output) for p in parts):
        return None
    found = [m.span() for p in parts for m in [re.search(r"\s+".join(re.escape(w) for w in p.split(" ")), output)] if m]
    if not found:
        return [0, len(output)]
    a, b = min(x for x, _ in found), max(y for _, y in found)
    end = output.find("\n", b)
    return [output.rfind("\n", 0, a) + 1, len(output) if end < 0 else end]


def window(text: str, spans: list[list[int]], size: int) -> tuple[str, list[list[int]]]:
    """At most `size` characters of the text around its first span, the spans moved to match."""
    if len(text) <= size:
        return text, spans
    a = max(0, (spans[0][0] if spans else 0) - size // 4)
    b = min(len(text), a + size)
    lead = "…" if a > 0 else ""
    return lead + text[a:b] + ("…" if b < len(text) else ""), [[x - a + len(lead), y - a + len(lead)] for x, y in spans if x >= a and y <= b]


def check_computed(target: str, given: Any, calls: list[dict[str, Any]], approx: bool = False, was: str = "", folder: str | None = None) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of computed evidence, and the evidence to show. The check names a call by the output it printed;
    the calls of the session whose real output holds that text are the candidates, and the first whose output shows
    the words, and whose code types none of them in, is the evidence: its code and its whole output, the words
    highlighted from the cited place on. When no call printed that output, the check's own last call is shown. For a
    correction, `was` is the marked words: the output also shows each run of words the correction puts in."""
    if not output_parts(given):
        return ["the check showed no printed result for it"], None
    runs = [(c, at) for c in calls for at in [printed(given, str(c.get("output") or ""))] if at is not None]

    def shown(c: dict[str, Any], spans: list[list[int]]) -> dict[str, Any]:
        text, hl = window(str(c.get("output") or ""), spans, OUTPUT_MAX)
        out = {"kind": "computed", "code": shown_code(str(c.get("command") or ""), folder).strip("\n"), "output": text, "highlight": hl, "by": c.get("by") or "checker"}
        table = text_table(text, hl)
        return {**out, "table": table} if table else out

    if not runs:
        # what the check itself ran, so the person sees what it found
        own = [c for c in calls if c.get("by") == "checker"]
        return ["no command of this session printed the result the check gave"], shown(own[-1], []) if own else None
    problem = ""
    for c, at in runs:
        # the words must stand in the lines the check copied, not anywhere in a long output, where another value
        # (an `n=3` of another row) could match them
        whole = str(c.get("output") or "")
        out = whole[at[0]:at[1]]
        typed, texts, quoted = [], {}, []
        for code in scripts(str(c.get("command") or "")):
            t, f = typed_values(target, code)
            typed += t
            texts.update(f)
            quoted += typed_quote(target, code)
        if texts and shows(target, out, approx):
            # a number of the words the code also types in a text it prints: the output must show it outside that
            # text, where a computed value printed it
            typed += [v for v in texts if not has_number(v, without_texts(out, texts[v]), dates=False, approx=approx)]
        if typed:
            vals = sorted(set(typed))
            problem = problem or f"the code typed {' and '.join(vals)} in by hand instead of computing {'them' if len(vals) > 1 else 'it'} from the records"
        elif quoted:
            problem = problem or "the code typed the quoted words in itself instead of reading them from the records"
        elif shows(target, out, approx):
            missing = unshown_change(was, target, out, approx) if was else []
            if missing:
                problem = problem or f"the result does not show “{short(' … '.join(missing), 60)}”"
                continue
            # the words in the cited lines, else the cited lines themselves
            spans = [[a + at[0], b + at[0]] for a, b in spans_of(target, out)] or [at]
            return [], shown(c, spans)
        else:
            problem = problem or instead("the result", target, [out], approx)
    return [problem], shown(runs[0][0], [runs[0][1]])


# ------------------------------------------------------------------------------------------------ quote evidence

def json_strings(v: Any) -> list[str]:
    if isinstance(v, str):
        return [v]
    if isinstance(v, list):
        return [s for x in v for s in json_strings(x)]
    if isinstance(v, dict):
        return [s for k, x in v.items() for s in [str(k)] + json_strings(x)]
    return [str(v)] if v is not None else []


def line_span(line: Any) -> tuple[int, int] | None:
    """A line number or a range (`12`, `"8-11"`, `"L8-L11"`, `[8, 11]`), as (first, last); None when it is neither or
    spans more than MAX_RANGE lines."""
    if isinstance(line, (list, tuple)) and line:
        try:
            a, b = int(line[0]), int(line[-1])
        except (TypeError, ValueError):
            return None
    else:
        m = re.fullmatch(r"\s*[Ll]?(\d+)(?:\s*[-–]\s*[Ll]?(\d+))?\s*", str(line))
        if not m:
            return None
        a, b = int(m.group(1)), int(m.group(2) or m.group(1))
    return (a, b) if 1 <= a <= b and b - a <= MAX_RANGE else None


def read_lines(path: str, a: int, b: int, partial: bool = False) -> tuple[int, list[str]] | None:
    """Lines a to b of a regular file, as (a, lines), each cut at LINE_BYTES; None when the file cannot be read, is no
    regular file (a pipe would never end), or, unless `partial`, has no line b. The lines before line a are counted in
    blocks, not read one by one, so a line deep in a big file is found quickly."""
    if not os.path.isfile(path):
        return None
    out: list[str] = []
    try:
        with open(path, "rb") as f:
            line = 1
            while line < a:
                block = f.read(BLOCK)
                if not block:
                    return None
                n = block.count(b"\n")
                if line + n < a:
                    line += n
                    continue
                at = -1
                for _ in range(a - line):
                    at = block.index(b"\n", at + 1)
                f.seek(f.tell() - (len(block) - at - 1))
                line = a
            for _ in range(a, b + 1):
                raw = f.readline(LINE_BYTES)
                if not raw:
                    break
                more = raw
                while not more.endswith(b"\n"):
                    more = f.readline(LINE_BYTES)
                    if not more:
                        break
                out.append(raw.decode("utf-8", errors="replace").rstrip("\n").removesuffix("\r"))
    except OSError:
        return None
    return (a, out) if out and (partial or len(out) == b - a + 1) else None


def quote_fragments(words: str) -> list[str]:
    """The quoted words of a direct quote, split at an ellipsis: `"Confirmed sequence: GA -> ... G5"` gives
    ["Confirmed sequence: GA ->", "G5"]; [] for words that are no direct quote."""
    w = unmark(words)
    spans = re.findall(r"[\"“]([^\"“”]+)[\"”]", w)
    if not spans and w[:1] in QUOTE_CHARS and w[-1:] in QUOTE_CHARS:
        spans = [w[1:-1]]
    frags = []
    for s in spans:
        frags += [f.strip(" .,;:" + QUOTE_CHARS) for f in re.split(r"…|\.\.\.", s)]
    return [f for f in frags if len(f) >= 3]


def forms(raw: str) -> list[tuple[str, bool]]:
    """The texts a line can hold words in: the line as written, and its JSON strings decoded (`decoded` True)."""
    out = [(raw, False)]
    try:
        out.append(("\n".join(json_strings(json.loads(raw))), True))
    except ValueError:
        pass
    return out


def shown_forms(raw: str) -> list[tuple[str, bool]]:
    """The texts a cited line is shown in, best first: each string value of its JSON alone, decoded (a record's message
    reads as written, its line breaks real), then the line as written."""
    try:
        v = json.loads(raw)
    except ValueError:
        return [(raw, False)]
    vals: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, str):
            vals.append(x)
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            for y in x.values():
                walk(y)
    walk(v)
    return [(t, True) for t in vals] + [(raw, False)]


def find_loose(sub: str, text: str) -> list[int] | None:
    """Where `sub` stands in `text`, runs of white space as one, `**` and backticks as formatting, any quote mark (as
    a JSON line escapes it, too) as any other: [start, end] in `text`, or None."""
    words = [w for w in unmark(sub).split(" ") if w]
    if not words:
        return None
    gap = r"(?:[\s*`]|\\n)*"
    char = lambda c: r"\\?[\"“”‘’']" if c in "\"“”‘’'" else re.escape(c)  # noqa: E731
    rx = re.compile(r"[*`]*" + gap.join(r"[*`]*".join(map(char, w)) for w in words), re.S)
    m = rx.search(text)
    return [m.start(), m.end()] if m else None


def inside(path: str, folders: list[str]) -> bool:
    """The absolute path lies inside one of the folders, compared by real paths: a link inside a folder to a file
    outside it is outside."""
    real = os.path.realpath(path)
    return any(real == r or real.startswith(r + os.sep) for r in map(os.path.realpath, folders))


LEADING_CD = re.compile(r"\s*cd\s+(\S+)\s*(?:&&|;|\n)")


def paths_of(file: str, cwd: str, root: str | None, tmp: str | None, calls: list[dict[str, Any]] = ()) -> list[str]:
    """The paths a cited file may name inside the session's folders (absolute, links not followed): an absolute path
    as it is; a relative one from the folder the session started in, from the shell's folder (where main's `cd` left
    it), and from each folder a call of the session moved to with a leading `cd`, since the check may have named the
    file from there. A file in `tmp` counts when `tmp` is given."""
    folders = [f for f in (root, cwd, tmp) if f]
    if os.path.isabs(file):
        bases = [""]
    else:
        bases = [f for f in (root, cwd) if f]
        for c in calls:
            m = LEADING_CD.match(str(c.get("command") or ""))
            d = m.group(1).strip("'\"") if m else ""
            bases += [d] if os.path.isabs(d) else [os.path.join(b, d) for b in (root, cwd) if b and d]
    return [p for p in dict.fromkeys(os.path.abspath(os.path.join(b, file)) for b in bases) if inside(p, folders)]


ADJACENT = re.compile(r"([\"'])\s+\1")


def hay_of(cited: list[str]) -> list[str]:
    """The texts cited lines hold words in: each line raw and decoded, and for a range the lines joined, also with
    string literals that stand next to each other joined, as Python joins `"final report " "with …"` into one."""
    texts = [norm_ws(t) for raw in cited for t, _ in forms(raw)]
    if len(cited) > 1:
        texts += [" ".join(norm_ws(t) for raw in cited for t, d in forms(raw) if d == dec) for dec in (False, True)]
    texts += [j for t in texts for j in [ADJACENT.sub("", t)] if j != t]
    return [h for t in texts for h in (t, unmark(t)) if h]


def holds(sub: str, hay: list[str]) -> bool:
    """The cited lines' texts hold the substring: white space as one space or as none, quote marks as one mark."""
    loose, plain = one_quote(norm_ws(sub)), one_quote(unmark(sub))
    tight = re.sub(r"\s+", "", plain)
    return any(loose in h or plain in h or tight in re.sub(r"\s+", "", h) for h in map(one_quote, hay))


def place(ev: dict[str, Any], cwd: str, root: str | None, tmp: str | None = None, calls: list[dict[str, Any]] = ()) -> tuple[list[str], dict[str, Any] | None, list[str]]:
    """One cited place: its problems, the place to show (`file`, `line`, the cited lines with a line around them, the
    substring highlighted) and the texts the cited lines hold. A relative path names a file of one of the folders
    paths_of() reads it from: the one whose lines hold the substring. A file in `tmp` counts too (Claude's
    own code, such as a label's rule); its path shows whole."""
    file, line, sub = ev.get("file"), ev.get("line", ev.get("lines")), ev.get("substring")
    if not file or line is None or not sub:
        return ["the check named no line of a file to look at"], None, []
    paths = paths_of(str(file), cwd, root, tmp, calls)
    if not paths:
        return [f"{file} is outside the folder this session works in"], None, []
    files = [p for p in paths if os.path.isfile(p)]
    if not files:
        return [f"there is no file {file} in this session's folder"], None, []
    looks = [look(p, str(file), line, str(sub), cwd, root) for p in files]
    return next((x for x in looks if not x[0]), looks[0])


def look(path: str, file: str, line: Any, sub: str, cwd: str, root: str | None) -> tuple[list[str], dict[str, Any] | None, list[str]]:
    """The cited lines of one file, as place() gives them. A line number is where to look: when the cited lines do not
    hold the substring and lines up to SHIFT_MAX away do, the nearest such lines are cited in their place: the same
    number of lines moved, or more lines around them (a quote that runs over three lines cited as two)."""
    span = line_span(line)
    if not span:
        return [f"the check cited lines {line}, which are not one line or a range of at most {MAX_RANGE} lines"], None, []
    a, b = span
    near = read_lines(path, max(1, a - SHIFT_MAX), b + SHIFT_MAX, partial=True)
    if near is None or near[0] + len(near[1]) - 1 < b:
        return [f"{file} has no line {line}"], None, []
    top, texts = near
    at = lambda x, y: texts[x - top:y - top + 1]  # noqa: E731
    last = top + len(texts) - 1
    spans = [(x, y) for x in range(max(top, a - SHIFT_MAX), a + SHIFT_MAX + 1) for y in range(x + b - a, min(last, b + SHIFT_MAX) + 1)]
    # the fewest lines first, then the nearest
    for x, y in sorted(spans, key=lambda s: (s[1] - s[0], abs(s[0] - a) + abs(s[1] - b))):
        if holds(str(sub), hay_of(at(x, y))):
            a, b = x, y
            break
    line = f"{a}" if a == b else f"{a}-{b}"
    first, last = max(top, a - 1), min(top + len(texts) - 1, b + 1)
    rows = [{"n": n, "text": t} for n, t in zip(range(first, last + 1), at(first, last))]
    hay = hay_of(at(a, b))
    problems = [] if holds(str(sub), hay) else [instead(f"line {line} of {file}", str(sub), [t for x in at(a, b) for t, _ in shown_forms(x)])]
    # for the pane: each cited line in the form that holds the substring, cut around it; the lines around cut short
    for r in rows:
        if not (a <= r["n"] <= b):
            r["text"] = window(r["text"], [], CONTEXT_MAX)[0]
            continue
        for text, decoded in shown_forms(r["text"]):
            hit = find_loose(str(sub), text)
            if hit:
                r["text"], hl = window(text, [hit], LINE_MAX)
                r["highlight"] = hl[0]
                if decoded:
                    r["decoded"] = True
                break
        else:
            r["text"] = window(r["text"], [], LINE_MAX)[0]
    rel = path if not inside(path, [root or cwd, cwd]) else os.path.relpath(path, os.path.abspath(root or cwd))
    return problems, {"file": rel, "line": line, "lines": rows}, hay


def check_quote(target: str, kind: str, evs: list[dict[str, Any]], cwd: str, root: str | None = None, tmp: str | None = None, calls: list[dict[str, Any]] = (), was: str = "") -> tuple[list[str], dict[str, Any] | None]:
    """The problems of quote or code evidence, and the cited places to show. The evidence is one place, or several when
    the claim joins places (a value set on one line and used on another): each place holds the words the check gave
    for it, and the places together hold the quoted words of a direct quote and the numbers of the words. A claim about
    what code does may cite Claude's own code in `tmp`; a quote of a record may not, since a file there holds what
    Claude derived, not the records. For a correction of a quote of a record, `was` is the marked words: the cited lines
    also show each run of words the correction puts in."""
    problems: list[str] = []
    shown: list[dict[str, Any]] = []
    hay: list[str] = []
    for ev in evs:
        p, s, h = place(ev, cwd, root, tmp if kind == "code" else None, calls)
        problems += p
        hay += h
        if s:
            shown.append(s)
    if not shown:
        return problems, None
    where = " or ".join(f"line {s['line']} of {s['file']}" for s in shown)
    for frag in quote_fragments(target):
        if not any(in_text(frag, h) for h in hay) and not (kind == "code" and in_code(frag, hay)):
            problems.append(instead(where, f"“{frag}”", hay))
    # a quote of a record shows its days and numbers; a claim about what code does may compute them from it (`2 ** k`)
    if kind != "code" and calendar_days(unmark(target)) and not days_shown(unmark(target), " ".join(hay)):
        problems.append(instead(where, unmark(target), hay))
    pct = percents(target)
    for v, in_date in (marked_numbers(unmark(target)) if kind != "code" else []):
        if not any(has_number(v, h, dates=in_date) or (v in pct and has_number(fraction(v), h)) for h in hay):
            problems.append(f"{where} reads “{nearest(target, hay)}”, not {v}")
    if was and kind != "code" and not problems:
        missing = unshown_change(was, target, "\n".join(hay))
        if missing:
            problems.append(f"{where} does not show “{short(' … '.join(missing), 60)}”")
    return problems, {"kind": kind, **shown[0], **({"more": shown[1:]} if len(shown) > 1 else {})}


# ------------------------------------------------------------------------------------------------ tables and cards

TABLE_AROUND = 2  # rows of a table shown on each side of the cited one
TABLE_LINES_MAX = 400  # lines of a printed block read as a table
CARD_PLACES_MAX = 20000  # places of the session's cards the checker's index lists


def _window(rows: list[dict[str, Any]], r: int) -> tuple[list[dict[str, Any]], int, int, int]:
    """The rows around row r: (those rows, r among them, rows left out above, rows left out below)."""
    lo = max(0, min(r - TABLE_AROUND, len(rows) - (2 * TABLE_AROUND + 1)))
    hi = min(len(rows), lo + 2 * TABLE_AROUND + 1)
    return rows[lo:hi], r - lo, lo, len(rows) - hi


def table_of(corner: str, cols: list[str], rows: list[dict[str, Any]], r: int, c: int, also: list[tuple[int, int]] = ()) -> dict[str, Any]:
    """A table as the evidence shows it: its corner (the row names' header), columns, the rows around row r, and the cited
    cell `at` among them (c = -1: the row's name). `above`/`below` count the rows left out. `also`: the other cells a
    citation of several values cites (a range, a pair), (row, column) each; the rows shown then run from the first
    cited row to the last, with one row around them, and each is in `also` among them."""
    also = [(x, y) for x, y in also if (x, y) != (r, c)]
    if not also:
        shown, at, above, below = _window(rows, r)
        return {"corner": corner, "cols": cols, "rows": shown, "at": {"r": at, "c": c}, "above": above, "below": below}
    cited = [r] + [x for x, _ in also]
    lo, hi = max(0, min(cited) - 1), min(len(rows), max(cited) + 2)
    return {"corner": corner, "cols": cols, "rows": rows[lo:hi], "at": {"r": r - lo, "c": c}, "above": lo, "below": len(rows) - hi,
            "also": [{"r": x - lo, "c": y} for x, y in also]}


def _segments(block: list[str], gap: int) -> list[tuple[int, int]]:
    """The columns of aligned lines: the runs of positions between gutters, a gutter being `gap` or more positions that
    are white space on every line."""
    width = max(len(x) for x in block)
    blank = [all(j >= len(x) or x[j] == " " for x in block) for j in range(width)]
    segs: list[tuple[int, int]] = []
    j = 0
    while j < width:
        if blank[j]:
            j += 1
            continue
        a = j
        while j < width:
            if blank[j]:
                k = j
                while k < width and blank[k]:
                    k += 1
                if k - j >= gap or k == width:
                    break
                j = k
            else:
                j += 1
        segs.append((a, j))
    return segs


def text_table(output: str, spans: list[list[int]]) -> dict[str, Any] | None:
    """Printed output that is a table, read as one (table_of) around the line that holds the first highlight: the block
    of non-blank lines that holds it, aligned in two or more columns (a printed DataFrame, f-string columns), its first
    line the header; a pandas index name on a line of its own is the corner. None when that block is no table, or the
    highlight is in its header."""
    if not spans or "\t" in output:
        return None
    lines = output.split("\n")
    a, at = spans[0][0], 0
    i = 0
    for k, x in enumerate(lines):
        if at <= a <= at + len(x):
            i = k
            break
        at += len(x) + 1
    if not lines[i].strip():
        return None
    lo = i
    while lo > 0 and lines[lo - 1].strip() and i - lo < TABLE_LINES_MAX:
        lo -= 1
    hi = i
    while hi + 1 < len(lines) and lines[hi + 1].strip() and hi - lo < TABLE_LINES_MAX:
        hi += 1
    block = [x.rstrip() for x in lines[lo:hi + 1]]
    if len(block) < 2 or i == lo:
        return None
    segs = _segments(block, 2)
    if len(segs) < 2 or any("  " in x[s:e].strip() for x in block for s, e in segs):
        # columns one space apart (numbers right-aligned under left-aligned headers)
        segs = _segments(block, 1)
    if len(segs) < 2 or len(segs) > 40:
        return None
    cells = [[x[s:e].strip() for s, e in segs] for x in block]
    head, body, first = cells[0], cells[1:], lo + 1
    if not any(head[1:]) or any(re.fullmatch(r"[-−]?[\d,.]+%?", h) for h in head[1:] if h) or head[0].endswith(":"):
        # a header names its columns: lines of a name and a number (`merged: 12`) are no table
        return None
    corner = head[0]
    if body and body[0][0] and not any(body[0][1:]):
        # pandas prints a named index on a line of its own under the header
        corner, body, first = body[0][0], body[1:], first + 1
    if i < first or not body:
        return None
    rows = [{"label": x[0], "values": x[1:]} for x in body]

    def cell(x: int) -> tuple[int, int] | None:
        """The row (among `rows`) and column of the table that offset x of the output stands in."""
        if x < 0:
            return None
        k = output.count("\n", 0, x)
        if not (first <= k <= hi):
            return None
        col = x - (output.rfind("\n", 0, x) + 1)
        return k - first, next((j for j, (s, e) in enumerate(segs) if s <= col < e + 1), len(segs) - 1) - 1

    # the other highlights in the table's body: the other values of words that hold several (a range, a pair)
    also = [rc for sp in spans[1:] for rc in [cell(sp[0])] if rc is not None]
    r, c = cell(a)
    return table_of(corner, head[1:], rows, r, c, list(dict.fromkeys(also)))


LABEL_ESCAPE = frozenset('%/|#[]*_~`\\<>&')
CARD_TD = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)#([^/]+)/(.+)$")
CARD_LINE = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)@out(\d+)#L(\d+)$")
# lines of a card's printed output cited as a range: `card:<id>@out<i>#L<a>-L<b>` (or `-<b>`)
CARD_LINES = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)@out(\d+)#L(\d+)-L?(\d+)$")


def encode_label(label: str) -> str:
    """A table's column or row label as a card's citation writes it in `card:<id>#<col>/<row>`: the characters of
    LABEL_ESCAPE, white space and controls as %XX per UTF-8 byte (the browser's cite.encode_label)."""
    return "".join("".join(f"%{b:02X}" for b in ch.encode("utf-8")) if ch in LABEL_ESCAPE or ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F else ch for ch in label)


def decode_label(label: str) -> str:
    return unquote(label) if "%" in label else label


def _grid(o: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]], dict[tuple[str, str], tuple[int, int]]]:
    """A card output's cells as a grid: its columns and rows in order, and where each (col, row) stands."""
    cols: list[str] = []
    rows: list[dict[str, Any]] = []
    by_row: dict[str, int] = {}
    where: dict[tuple[str, str], tuple[int, int]] = {}
    for col, row, _ in o.get("cells") or []:
        if str(col) not in cols:
            cols.append(str(col))
    for col, row, value in o.get("cells") or []:
        r = by_row.get(str(row))
        if r is None:
            r = by_row[str(row)] = len(rows)
            rows.append({"label": str(row), "values": [""] * len(cols)})
        c = cols.index(str(col))
        rows[r]["values"][c] = str(value)
        where.setdefault((str(col), str(row)), (r, c))
    return cols, rows, where


def card_places(cards: list[dict[str, Any]] | None) -> list[tuple[str, str]]:
    """Every place of the cards a citation can name, with what it shows: (`card:<id>#<col>/<row>`, the value) for each
    table cell, (`card:<id>@out<i>#L<n>`, the line) for each line of printed output."""
    out: list[tuple[str, str]] = []
    for card in cards or []:
        cid = str(card.get("id") or "")
        for o in card.get("outputs") or []:
            for col, row, value in o.get("cells") or []:
                if str(col).strip() and str(row).strip():
                    out.append((f"card:{cid}#{encode_label(str(col))}/{encode_label(str(row))}", str(value)))
            for n, text in o.get("lines") or []:
                if str(text).strip():
                    out.append((f"card:{cid}@out{int(o.get('out') or 0)}#L{int(n)}", str(text)))
    return out


def card_index(cards: list[dict[str, Any]] | None) -> str:
    """What the checker greps for a value a card shows: a heading line for each card (`# card:<id> <title>`), then one
    line for each place, its citation, a tab, and what it shows."""
    lines: list[str] = []
    n = 0
    for card in cards or []:
        lines.append(f"# card:{card.get('id')} {norm_ws(card.get('title') or '')}".rstrip())
        for ref, value in card_places([card]):
            if n >= CARD_PLACES_MAX:
                break
            lines.append(f"{ref}\t{norm_ws(value)}")
            n += 1
    return "\n".join(lines) + ("\n" if lines else "")


def _card_text(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if v is None:
        return ""
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def _records_table(recs: list[Any]) -> dict[str, Any] | None:
    """Rows of records as a card output's cells: the columns their keys, each row named by the first column of distinct
    text, else by its position from 0 (as a chart's rows are named)."""
    recs = [r for r in recs if isinstance(r, dict)][:5000]
    if not recs:
        return None
    cols: list[str] = []
    for r in recs:
        cols.extend(str(k) for k in r if str(k) not in cols)
    key = next((k for k in cols if all(isinstance(r.get(k), str) and r[k].strip() for r in recs) and len({r[k] for r in recs}) == len(recs)), None)
    names = [str(r[key]) for r in recs] if key else [str(i) for i in range(len(recs))]
    return {"corner": key or "", "cells": [[k, nm, _card_text(r.get(k))] for r, nm in zip(recs, names) for k in cols if k != key]}


def terminal_cards(folder: str | None) -> list[dict[str, Any]]:
    """The terminal's cards (cards/store.ts): each card's meta.json and the rows of the version on screen
    (v<version>/rows.json), as the cards check_mark reads. Rows that are a list of records are one table; an object's
    lists of records are a table each, in its order."""
    out: list[dict[str, Any]] = []
    if not folder or not os.path.isdir(folder):
        return out
    for name in sorted(os.listdir(folder)):
        try:
            with open(os.path.join(folder, name, "meta.json"), encoding="utf-8") as f:
                meta = json.load(f)
            version = int(meta.get("version") or 0)
            if version < 1:
                continue
            with open(os.path.join(folder, name, f"v{version}", "rows.json"), encoding="utf-8") as f:
                rows = json.load(f)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
        parts = [rows] if isinstance(rows, list) else [v for v in rows.values() if isinstance(v, list)] if isinstance(rows, dict) else []
        outputs = [{"out": i, **t} for i, t in enumerate(_records_table(p) for p in parts) if t]
        if outputs:
            out.append({"id": str(meta.get("id") or name), "title": str(meta.get("title") or ""), "outputs": outputs})
    return out


def card_refs(ev: Any) -> list[str]:
    """The places card evidence names: one `ref`, or several when the cited words hold several values (a range such as
    "2.5 to 3.7 hours", a pair such as "243 against 104"): a list of refs, as `ref` or as a list of evidence objects,
    and a range of lines (`#L7-L8`) as each of its lines."""
    out: list[str] = []
    for e in ev if isinstance(ev, list) else [ev]:
        got = e.get("ref", e.get("refs")) if isinstance(e, dict) else e
        for x in got if isinstance(got, list) else [got]:
            ref = str(x or "").strip().strip("[]") if isinstance(x, str) else ""
            m = CARD_LINES.match(ref)
            if m and int(m.group(3)) <= int(m.group(4)) <= int(m.group(3)) + MAX_RANGE:
                out += [f"card:{m.group(1)}@out{m.group(2)}#L{n}" for n in range(int(m.group(3)), int(m.group(4)) + 1)]
            elif ref and ref not in out:
                out.append(ref)
    return out


def _card_place(ref: str, cards: list[dict[str, Any]] | None) -> tuple[str, dict[str, Any] | None]:
    """One place of a card: why it is no place of the session's cards, or what it is: {cid, title, ref, value, text,
    where, out}, with the cell's grid (`cols`, `rows`, `r`, `c`, `corner`) or the output's numbered `lines` and `at`."""
    td, ln = CARD_TD.match(ref), CARD_LINE.match(ref)
    if not td and not ln:
        return "the check named no value or line of a card", None
    cid = (td or ln).group(1)
    card = next((c for c in cards or [] if str(c.get("id")) == cid), None)
    if card is None:
        return f"there is no card {cid} in this session", None
    title = str(card.get("title") or "")
    if td:
        col, row = decode_label(td.group(2)), decode_label(td.group(3))
        for i, o in enumerate(card.get("outputs") or []):
            cols, rows, where = _grid(o)
            if (col, row) not in where:
                continue
            r, c = where[(col, row)]
            value = rows[r]["values"][c]
            return "", {"cid": cid, "title": title, "ref": f"card:{cid}#{encode_label(col)}/{encode_label(row)}", "value": value,
                        "text": f"{row} {value}", "where": f"the card's {col} for {row}", "out": ("cells", i), "col": col, "row": row,
                        "cols": cols, "rows": rows, "r": r, "c": c, "corner": str(o.get("corner") or "")}
        return f"the card has no {col} for {row}", None
    out_i, n = int(ln.group(2)), int(ln.group(3))
    o = next((x for x in card.get("outputs") or [] if int(x.get("out") or 0) == out_i and x.get("lines")), None)
    lines = [(int(k), str(t)) for k, t in (o or {}).get("lines") or []]
    at = next((j for j, (k, _) in enumerate(lines) if k == n), None)
    if at is None:
        return f"the card's output has no line {n}", None
    line = lines[at][1]
    return "", {"cid": cid, "title": title, "ref": f"card:{cid}@out{out_i}#L{n}", "value": line, "text": line,
                "where": f"line {n} of the card's output", "out": ("lines", out_i), "n": n, "lines": lines, "at": at}


def _card_shown(target: str, ps: list[dict[str, Any]]) -> dict[str, Any]:
    """The evidence to show of the places of one card output: a cell's table with each cited cell marked, or the
    output's lines with what shows the words highlighted on each cited line (as a table when the output is one)."""
    p = ps[0]
    shown: dict[str, Any] = {"kind": "card", "card": p["cid"], "title": p["title"], "ref": p["ref"], "value": p["value"]}
    if len(ps) > 1:
        shown["refs"] = [x["ref"] for x in ps]
    if p["out"][0] == "cells":
        shown["table"] = table_of(p["corner"], p["cols"], p["rows"], p["r"], p["c"], [(x["r"], x["c"]) for x in ps[1:]])
        return shown
    lines = p["lines"]
    text = "\n".join(t for _, t in lines)
    spans: list[list[int]] = []
    for x in ps:
        start = sum(len(t) + 1 for _, t in lines[:x["at"]])
        line = lines[x["at"]][1]
        # each cited line highlights what of the words it shows (one value of a range on its own line)
        spans += [[start + a, start + b] for a, b in spans_of(target, line)] or ([[start, start + len(line)]] if x is p else [])
    shown["output"], shown["highlight"] = window(text, spans, OUTPUT_MAX)
    if table := text_table(text, spans):
        shown["table"] = table
    return shown


def check_card(target: str, ev: Any, cards: list[dict[str, Any]] | None, approx: bool = False, was: str = "") -> tuple[list[str], dict[str, Any] | None]:
    """The problems of card evidence, and the evidence to show: each cited place must be one of the session's cards,
    and together they show the words (a cell's value, with its row's name; a line of printed output). Words that hold
    several values (a range, a pair) may cite a place for each: each value must stand in one of them."""
    refs = card_refs(ev)
    if not refs:
        return ["the check named no value or line of a card"], None
    places: list[dict[str, Any]] = []
    for ref in refs:
        why, p = _card_place(ref, cards)
        if p is None:
            return [why], None
        places.append(p)
    groups: dict[tuple[str, Any], list[dict[str, Any]]] = {}
    for p in places:
        groups.setdefault((p["cid"], p["out"]), []).append(p)
    shown_all = [_card_shown(target, g) for g in groups.values()]
    shown = {**shown_all[0], **({"more": shown_all[1:]} if len(shown_all) > 1 else {})}
    values, texts = [p["value"] for p in places], [p["text"] for p in places]
    one = places[0]
    if not (shows(target, "\n".join(values), approx) or shows(target, "\n".join(texts), approx)):
        if len(places) > 1:
            return [instead(" and ".join(p["where"] for p in places), target, texts, approx)], shown
        if one["out"][0] == "cells":
            return [f"{one['where']} shows {short(one['value'], 40) or 'nothing'}, not {unshown(target, one['text'], approx)}"], shown
        return [instead(one["where"], target, texts, approx)], shown
    missing = unshown_change(was, target, "\n".join(texts), approx) if was else []
    if missing:
        where = " and ".join(p["where"] for p in places)
        return [f"{where} does not show “{short(' … '.join(missing), 60)}”" if len(places) > 1 or one["out"][0] == "lines"
                else f"the card's {one['col']} for {one['row']} does not show “{short(' … '.join(missing), 60)}”"], shown
    return [], shown


# ------------------------------------------------------------------------------------------------ one mark

def parse_answer(text: str) -> list[dict[str, Any]] | None:
    """The checker's answer: the last ```json block that holds an array, else a bare array at the answer's end. The
    array is read as JSON from the block's start, so a quote in it that holds ``` does not end it."""
    text = text or ""
    dec = json.JSONDecoder()
    found = None
    for m in re.finditer(r"```json[ \t]*\n?", text):
        try:
            v, _ = dec.raw_decode(text, m.end() + (len(text[m.end():]) - len(text[m.end():].lstrip())))
        except ValueError:
            continue
        if isinstance(v, list):
            found = v
    if found is None:
        i = text.rfind("\n[")
        if i >= 0:
            try:
                found, _ = dec.raw_decode(text, i + 1)
            except ValueError:
                return None
    return [x for x in found if isinstance(x, dict)] if isinstance(found, list) else None


def check_evidence(target: str, kind: Any, ev: Any, calls: list[dict[str, Any]], cwd: str, root: str | None, approx: bool = False, tmp: str | None = None, was: str = "", cards: list[dict[str, Any]] | None = None) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of one mark's evidence for `target`, and the evidence to show. For a correction, `target` is its
    new words and `was` the marked words."""
    if kind == "card":
        return check_card(target, ev, cards, approx, was)
    if kind == "computed":
        return check_computed(target, ev.get("output") if isinstance(ev, dict) else None, calls, approx, was, root or cwd)
    if kind in ("quote", "code"):
        evs = [e for e in (ev if isinstance(ev, list) else [ev]) if isinstance(e, dict)]
        return check_quote(target, kind, evs, cwd, root, tmp, calls, was) if evs else (["the check named no place in a file"], None)
    return ["the check gave evidence of a kind thimble does not know"], None


APPROX = re.compile(r"(?:\babout|\baround|\broughly|\bapproximately|\bnearly|\balmost|~|≈)\s*$", re.I)


def around(mark: dict[str, Any]) -> tuple[str, str]:
    """The words of the mark's sentence before and after the mark, as the sentence holds them (each mark `[words]`)."""
    s, w = str(mark.get("sentence") or ""), f"[{mark['words']}]"
    i = s.find(w)
    return (s[:i], s[i + len(w):]) if i >= 0 else ("", "")


def approximate(mark: dict[str, Any]) -> bool:
    """The words give a round value: "about 250", "~40%", "[about 2] days"."""
    before, _ = around(mark)
    return bool(APPROX.search(before) or re.match(r"\s*(?:about|around|roughly|approximately|nearly|almost|~|≈)", str(mark["words"]), re.I))


def plain_map(s: str) -> tuple[str, list[int]]:
    """The text as words alone (no brackets, backticks or `**`, runs of white space as one space), and for each of its
    characters the place it came from."""
    chars: list[str] = []
    at: list[int] = []
    for i, ch in enumerate(s):
        if ch in "[]`*":
            continue
        if ch.isspace():
            if not chars or chars[-1] == " ":
                continue
            ch = " "
        chars.append(ch)
        at.append(i)
    return "".join(chars), at


def own_words(new: str, mark: dict[str, Any]) -> str:
    """A correction as the words that replace the mark alone: words of the sentence around the mark that the check
    repeated at the end or the start of its correction are taken off (`936` corrected to "1405 records contain a
    marker" in "[936] records contain a marker" is "1405")."""
    before, after = around(mark)
    if not before and not after:
        return new
    text, at = plain_map(new)
    tail = plain_map(after)[0].strip()
    head = plain_map(before)[0].strip()
    word = lambda c: c.isalnum()  # noqa: E731
    end = len(text)
    for k in range(min(len(text), len(tail)), 3, -1):
        if text.endswith(tail[:k]) and (k == len(tail) or not word(tail[k])) and text[-k - 1:-k] == " ":
            end = len(text) - k
            break
    start = 0
    for k in range(min(end, len(head)), 3, -1):
        if text.startswith(head[-k:]) and (k == len(head) or not word(head[-k - 1])) and text[k:k + 1] == " ":
            start = k
            break
    if (start, end) == (0, len(text)) or start >= end:
        return new
    return norm_ws(new[at[start]:at[end - 1] + 1])


def narrowed_part(new: str, words: str) -> tuple[str, str, str] | None:
    """A narrowing's words as a part of the marked words: that part as the words write it (formatting aside), and the
    words before and after it that it leaves out; None when the new words are no part of the marked ones that starts
    and ends at a word's edge. Quote marks compare as one mark, white space loosely."""
    plain = plain_map(words)[0]
    part = plain_map(new)[0].strip()
    if not part:
        return None
    hay, needle = one_quote(plain), one_quote(part)
    i = hay.find(needle)
    while i >= 0:
        j = i + len(needle)
        # a word's edge, and no part of a longer number (217 of 5,217)
        inner_a = needle[0].isalnum() and i > 0 and (hay[i - 1].isalnum() or (needle[0].isdigit() and hay[i - 1] in ".," and hay[i - 2:i - 1].isdigit()))
        inner_b = needle[-1].isalnum() and j < len(hay) and (hay[j].isalnum() or (needle[-1].isdigit() and hay[j] in ".," and hay[j + 1:j + 2].isdigit()))
        if not inner_a and not inner_b:
            return plain[i:j], norm_ws(plain[:i]), norm_ws(plain[j:])
        i = hay.find(needle, i + 1)
    return None


# a block's marker that opens a sentence of sentenceOf: a heading's, a quote's, a list item's, a table row's
LEAD = re.compile(r"^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d{1,9}[.)]\s+|\|\s*)+")
SENTENCE_END = re.compile(r"[.!?][\"'”’)*_]*\s+(?=\S)")
QUOTED = re.compile(r"\"[^\"]*\"|“[^”]*”")
CITED = "⟨cited⟩"


def citations_of(s: str) -> list[tuple[int, int]]:
    """The citations of a sentence as sentenceOf writes it (each `[words]`): each `[` and the `]` that balances it, the
    brackets included; brackets inside the words stay the words'."""
    out: list[tuple[int, int]] = []
    i = 0
    while i < len(s):
        if s[i] != "[":
            i += 2 if s[i] == "\\" else 1
            continue
        depth, j = 0, i
        while j < len(s):
            if s[j] == "\\":
                j += 2
                continue
            depth += {"[": 1, "]": -1}.get(s[j], 0)
            if depth == 0:
                break
            j += 1
        if j >= len(s):
            break
        out.append((i, j + 1))
        i = j + 1
    return out


def loose(s: str) -> str:
    """Words compared loosely: formatting, quote marks, white space, case and the punctuation at the words' ends aside."""
    return " ".join(k for x in unmark(s).split() for k in [one_quote(x).strip(' "().,;:!?').lower()] if k)


def rest_of(s: str, groups: list[tuple[int, int]], k: int) -> str:
    """A sentence's words outside its citation k (CITED in its place), the other citations' words as plain words."""
    out, at = "", 0
    for i, (a, b) in enumerate(groups):
        out += s[at:a] + (f" {CITED} " if i == k else s[a + 1:b - 1])
        at = b
    return norm_ws(out + s[at:])


def sentence_rewrite(given: str, sentence: str, words: str) -> dict[str, Any] | str:
    """The check's new sentence for a citation (`correction.sentence`), in the form of the mark's own (each citation
    `[words]`): {sentence, cited, rest, was_rest}, the new sentence, its cited words, and the words outside the citation
    in the new sentence and in the old one; or why it cannot stand in place of the old one. It stays within the old
    sentence: one line, no sentence added, the block's marker kept, and every other citation of the sentence with its
    words as they were (a sentence that writes them with no brackets has them bracketed where they stand)."""
    if re.search(r"\n\s*\S", given.strip()):
        return "its sentence runs over more than one line"
    old = citations_of(sentence)
    k = next((i for i, (a, b) in enumerate(old) if loose(sentence[a + 1:b - 1]) == loose(words)), None)
    if k is None:
        return "thimble could not find the citation in the sentence"
    # a citation written as the reply writes one (`[words](#)`) is one too
    new = norm_ws(given).replace("](#)", "]")
    lead = LEAD.match(sentence)
    if lead and not new.startswith(lead.group(0).strip()):
        new = lead.group(0) + new
    others = [sentence[a + 1:b - 1] for i, (a, b) in enumerate(old) if i != k]
    groups = citations_of(new)
    if len(groups) == 1 and others:
        # the other citations written as plain words: bracketed where they stand, in order
        a0, b0 = groups[0]
        spans, at = [], 0
        for w in others:
            j = new.find(w, at)
            if j >= 0 and a0 <= j < b0:
                j = new.find(w, b0)
            if j < 0:
                return "it leaves out another citation of the sentence"
            spans.append((j, j + len(w)))
            at = j + len(w)
        for a, b in sorted(spans, reverse=True):
            new = f"{new[:a]}[{new[a:b]}]{new[b:]}"
        groups = citations_of(new)
    if len(groups) != len(old):
        return "it changes the other citations of the sentence"
    inner = [new[a + 1:b - 1] for a, b in groups]
    fits = [j for j in range(len(groups)) if [loose(w) for i, w in enumerate(inner) if i != j] == [loose(w) for w in others]]
    if not fits:
        return "it changes the other citations of the sentence"
    j = k if k in fits else fits[0]
    # the sentences a quote holds are the quote's
    ends = lambda x: len(SENTENCE_END.findall(QUOTED.sub("q", x)))  # noqa: E731
    if ends(rest_of(new, groups, j)) > ends(rest_of(sentence, old, k)):
        return "it adds a sentence"
    if not inner[j].strip():
        return "it cites no words"
    return {"sentence": new, "cited": norm_ws(inner[j]), "rest": rest_of(new, groups, j), "was_rest": rest_of(sentence, old, k)}


def evidence_text(evidence: dict[str, Any] | None) -> str:
    """What the evidence shows the person, as text: a call's output, a file's cited lines and its place (the file and
    the line), a card's title, place and value. Not the code: a number typed in code is no value of the data."""
    if not evidence:
        return ""
    parts: list[str] = []
    for p in [evidence, *(evidence.get("more") or [])]:
        parts += [str(p[k]) for k in ("file", "title", "ref", "value", "output") if p.get(k)]
        span = line_span(p.get("line")) if p.get("line") else None
        if span:
            # the cited lines, not the lines around them
            parts.append(f"line {p['line']}")
            parts += [str(r.get("text") or "") for r in p.get("lines") or [] if span[0] <= int(r.get("n") or 0) <= span[1]]
        t = p.get("table") or {}
        parts += [str(t.get("corner") or ""), *map(str, t.get("cols") or [])]
        parts += [str(x) for r in t.get("rows") or [] for x in [r.get("label"), *(r.get("values") or [])]]
    return "\n".join(parts)


def uncited_values(runs: list[str], words: str, cited: str, shown: str, approx: bool = False) -> tuple[str, str] | None:
    """The first run of words outside the citation that the check put in (a narrowing's words it left out, a rewrite's
    new words around the citation) and that states a value of the data: a number, a day or a record's name. It holds
    only when it is no value the marked words cited and the citation now leaves out (`left`), and the evidence shows
    each of its values (`unshown`: `shown` is what the evidence shows). Its other words are the reply's own wording (a
    translation, an explanation), as a narrowing's are."""
    for run in runs:
        nums = [v for v, _ in marked_numbers(wordnums(run, counts=True))]
        days = calendar_days(run)
        names = NAME.findall(run)
        if not (nums or days or names):
            continue
        left = any(has_number(v, wordnums(words, counts=True)) and not has_number(v, wordnums(cited, counts=True)) for v in nums)
        left = left or bool(days and calendar_days(words) and days_shown(run, words) and not days_shown(run, cited))
        left = left or any(has_name(x, words) and not has_name(x, cited) for x in names)
        if left:
            return "left", run
        # its values, not its words: a quoted translation is the reply's own wording too
        said = wordnums(shown, counts=True)
        if not (all(has_number(v, said, approx=approx) for v in nums) and (not days or days_shown(run, shown)) and all(has_name(x, shown) for x in names)):
            return "unshown", run
    return None


def check_mark(mark: dict[str, Any], item: dict[str, Any] | None, calls: list[dict[str, Any]], cwd: str, root: str | None = None, tmp: str | None = None, cards: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """What the person sees of one mark: {n, status, shown, reason, failedBy?, evidence?, note?, was?, narrowed?,
    rewrite?}. `mark` is {n, words, sentence?}; `item` the checker's object for it (or None); `calls` the real Bash
    calls of the session ({command, output, by}).

    The checker's status is `verified`, `corrected`, `narrowed` (only a part of the words is cited: a correction whose
    `narrowed` result keeps the rest as the reply's own words), `wrong` (the data show the claim false) or
    `unconfirmed` (the check could not see what shows it true or false). This module checks the evidence of the words it shows: it never
    turns the checker's verdict that a claim is wrong into verified, so a correction whose evidence does not show the
    new words is not confirmed. A mark the checker judged wrong or unconfirmed keeps the evidence it gave, when that
    evidence is real, so the person sees what the check found. `failedBy` is `check` when the checker found the claim
    wrong, `evidence` when the claim is only not confirmed: the checker could not see it, or its evidence did not hold,
    `none` when the check gave no answer this module can judge (the plugin's marks/store.ts notRun).
    A `note` is what the checker found wrong in the sentence outside the mark's own claim.

    One path makes a citation correct: the check gives the cited words as they end (`correction.words`), and when other
    words of the sentence change too, the whole sentence as it ends (`correction.sentence`, the cited words in
    brackets). Its evidence is the citation's evidence, whatever the reply pointed at. A sentence that changes only the
    cited words is a correction; one that keeps every word and cites fewer of them, a narrowing; any other, a rewrite
    (`rewrite`: the new sentence, in the form of `sentence`). For each, the evidence shows the cited words, and the words
    it puts outside the citation state no value the evidence does not show (uncited_values)."""
    # the words are checked as they read (markdown's `\#` is `#`) and shown as the reply wrote them
    n, written = mark["n"], str(mark["words"])
    words = md_unescaped(written)
    out: dict[str, Any] = {"n": n, "status": "failed", "failedBy": "none", "shown": written, "reason": f"{NOT_RUN} Its answer left this citation out."}
    if not item:
        return out
    status, kind = item.get("status"), item.get("kind")
    ev = item.get("evidence") if isinstance(item.get("evidence"), (dict, list)) else {}
    # the check's own reason says why when the check found the claim wrong or could not confirm it; when its evidence
    # does not hold, the reason is this module's (its reason then says why the claim held, which it did not)
    reason = check_reason(item.get("reason") or "", words)
    note = norm_ws(item.get("note") or "")
    extra = {"note": note} if note else {}
    approx = approximate(mark)
    corr = item.get("correction") if isinstance(item.get("correction"), dict) else None

    def judged(by: str, why: str) -> dict[str, Any]:
        """The checker's verdict that the claim is wrong (`check`) or not confirmed (`evidence`), with the evidence it
        gave when that evidence is real."""
        res = {**out, "status": "failed", "reason": why, "failedBy": by, **extra}
        if ev:
            _, evidence = check_evidence(unmark(words), kind, ev, calls, cwd, root, approx, tmp, cards=cards)
            if evidence and (evidence.get("kind") != "computed" or evidence.get("output")):
                res["evidence"] = evidence
        return res

    # the sentence as the check ends it: a correction, a narrowing or a rewrite
    rewrite: dict[str, Any] | None = None
    given = str(corr.get("sentence") or "") if corr else ""
    if given.strip() and status in ("verified", "corrected", "narrowed", "wrong"):
        got = sentence_rewrite(given, norm_ws(mark.get("sentence") or f"[{words}]"), words)
        if isinstance(got, str):
            return judged("evidence", f"The check reworded the sentence, but {got}.")
        corr = {**corr, "words": got["cited"]}
        if loose(got["rest"]) == loose(got["was_rest"]):
            # only the cited words change: a correction of them, or no change
            if loose(got["cited"]) != loose(words) and status in ("verified", "narrowed"):
                status = "corrected"
        elif loose(got["rest"].replace(CITED, got["cited"])) == loose(got["was_rest"].replace(CITED, words)):
            # every word stays, fewer are cited
            status = "narrowed"
        else:
            status, rewrite = "corrected", got
    new = own_words(norm_ws(corr.get("words") or ""), mark) if status == "corrected" and corr and not rewrite else ""
    if new and unmark(new) != unmark(words) and one_quote(unmark(new)) == one_quote(unmark(words)):
        # a change of quote marks alone is no correction: the words hold as written
        status, new = "verified", ""
    if status == "wrong" and corr:
        # a claim found wrong whose right words the check gave is a correction: the person sees the right words
        found = own_words(norm_ws(corr.get("words") or ""), mark)
        if found and one_quote(unmark(found)) != one_quote(unmark(words)):
            status, new = "corrected", found
    if status == "corrected" and not rewrite and (not new or unmark(new) == unmark(words)):
        # a correction that leaves the words as they were found an error around them (a wrong place, a wrong
        # condition), which the words cannot show: the mark is wrong, with the checker's reason
        status = "wrong"
        reason = reason or "The check found an error around these words but gave no corrected sentence."

    # the words the check puts outside the citation: a narrowing's left-out words, a rewrite's new words
    runs: list[str] = []
    narrow = status == "narrowed"
    if narrow:
        part = narrowed_part(norm_ws(corr.get("words") or ""), words) if corr else None
        if not part:
            return judged("evidence", "The check cut the citation down to words that are not part of it.")
        new, *runs = part
        runs = [r for r in runs if re.search(r"\w", r)]
        status, narrow = ("corrected", True) if runs else ("verified", False)
        new = new if narrow else ""
    if rewrite:
        new = rewrite["cited"]
        runs = put_in(rewrite["was_rest"], rewrite["rest"])
    if status == "wrong":
        return judged("check", reason or "The records do not show this claim.")
    if status == "unconfirmed":
        return judged("evidence", reason or "The check found no records that show this claim true or false.")
    if status not in ("verified", "corrected"):
        return {**out, "reason": f"{NOT_RUN} It gave the status {status!r}."}
    # a narrowing puts no words in: the evidence shows the part it keeps
    changed = bool(new) and not narrow and loose(new) != loose(words)
    problems, evidence = check_evidence(unmark(new or words), kind, ev, calls, cwd, root, approx, tmp, unmark(words) if changed else "", cards)
    res: dict[str, Any] = {"n": n, "status": status, "shown": new or written, "reason": reason, **extra}
    if evidence:
        res["evidence"] = evidence
    did = "cited only a part of these words" if narrow else "reworded the sentence" if rewrite else "offered other words"
    if problems and new:
        # the check's verdict that the words are wrong rests on evidence that does not show its new words: neither the
        # old words nor the new ones are confirmed (a match of the old words there, such as the 250 of a test that
        # printed False, is no sign that they hold)
        res.update(status="failed", shown=words, failedBy="evidence", reason=f"The check {did}, but {problems[0]}.")
        return res
    if problems:
        res.update(status="failed", failedBy="evidence", reason=sentence(problems[0]))
        return res
    bad = uncited_values(runs, words, new or words, evidence_text(evidence), approx)
    if bad:
        why, run = bad
        if why == "left" and narrow:
            return judged("evidence", f"The records show only “{short(new, 50)}”; the words left out, “{short(norm_ws(' '.join(runs)), 40)}”, state a value of the data.")
        if why == "left":
            return judged("evidence", f"The check reworded the sentence, but it leaves “{short(run, 40)}” out of the citation, a value of the data.")
        return judged("evidence", f"The records do not show “{short(run, 40)}”, which the check's rewording states.")
    if new:
        res["was"] = words
        if narrow:
            res["narrowed"] = True
        if rewrite:
            res["rewrite"] = rewrite["sentence"]
    return res


def cited_calls(items: list[dict[str, Any]], calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The checker's own calls, and the calls of main's whose output holds an output the answer cites: only such a call
    can be a mark's evidence, so the others are not read again for each mark."""
    cited = [p for it in items for ev in [it.get("evidence")] if isinstance(ev, dict) for p in [output_parts(ev.get("output"))] if p]
    out = []
    for c in calls:
        if c.get("by") == "checker":
            out.append(c)
            continue
        text = norm_ws(c.get("output") or "")
        if any(all(p in text for p in parts) for parts in cited):
            out.append(c)
    return out


def check_all(marks: list[dict[str, Any]], answer: str, calls: list[dict[str, Any]], cwd: str, root: str | None = None, tmp: str | None = None, cards: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Every mark of a reply: {parsed, results}. `answer` is the checker's last message; `tmp` the session's temp
    folder; `cards` the session's cards' outputs (check_card). A mark the validator fails on fails as a check that did
    not run, with why; the other marks are judged."""
    items = parse_answer(answer)
    calls = cited_calls(items or [], calls)
    by_n: dict[int, dict[str, Any]] = {}
    for it in items or []:
        try:
            by_n.setdefault(int(it.get("mark")), it)
        except (TypeError, ValueError):
            continue
    results = []
    for m in marks:
        try:
            results.append(check_mark(m, by_n.get(int(m["n"])), calls, cwd, root, tmp, cards))
        except Exception as e:  # noqa: BLE001 — one mark's failure never takes the others' results with it
            results.append({"n": m.get("n"), "status": "failed", "failedBy": "none", "shown": str(m.get("words", "")),
                            "reason": f"{NOT_RUN} thimble could not validate this citation ({type(e).__name__}: {str(e)[:120]})."})
    # a sentence is rewritten once: the rewrite of a second citation of it would undo the first one's. The same new
    # sentence for a second citation undoes nothing: a rewrite keeps the other citations' words, so the second
    # citation's words stand in it as written, and the first rewrite places them
    rewritten: dict[str, str] = {}
    for m, r in zip(marks, results):
        if not r.get("rewrite"):
            continue
        key = norm_ws(m.get("sentence") or "")
        if key in rewritten:
            words = str(m.get("words", ""))
            same = norm_ws(str(r["rewrite"])) == rewritten[key]
            if same:
                r.update(status="verified", shown=words)
            else:
                r.update(status="failed", failedBy="evidence", shown=words, reason="The check reworded this sentence for another of its citations too, so this change was left out.")
            for k in ("rewrite", "was", "narrowed"):
                r.pop(k, None)
            continue
        rewritten[key] = norm_ws(str(r["rewrite"]))
    return {"parsed": items is not None, "results": results}
