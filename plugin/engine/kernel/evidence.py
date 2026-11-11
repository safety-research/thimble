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
            folders, where Claude keeps its own code (`tmp`: thimble's, the one Claude Code's Bash sandbox gives a
            command, the workbench's); and a folder of labels' rules when the host gives one, `rules`,
            as the browser keeps each label's definition, its rule in it), compared by real paths, a regular file, the
            line (or a range of at most 50 lines) exists, and the place's substring is in it: in the raw line or in
            the line's JSON strings decoded (a JSONL record's, or those of one member of a JSON document written over
            many lines, such as a label's rule), runs of white space as one space (or as none: JSON written with no
            space after its colons), `**` and backticks as formatting, and every quote mark as the same mark (a quote
            inside a quote may be written with the other kind). The quoted words of a direct quote (the case of their
            first letter aside), and the days and numbers of the words, are in the cited lines too; a quote of what
            code prints may fill the fields of the code's template (in_code). A correction of a quote also puts in
            only words the cited lines show, as for computed evidence.
            Not checked: that a substring means what a paraphrase of it says ("agent-3 deleted the page" on a line that
            holds "page"). That is the checker's judgment; the person sees the line next to the claim.
  card      a value a card of the session shows: a cell of one of its tables (a chart's data rows are a table) or a
            line of its printed output, named by the place a card's citation names it with, `card:<id>#<col>/<row>` or
            `card:<id>@out<i>#L<n>` (labels percent-encoded as encode_label writes them). The host gives the cards'
            outputs (`cards`: [{id, title, outputs: [{out, corner?, cells: [[col, row, value]]} | {out, lines: [[n,
            text]]}]}]); the place must exist there and show the words as shows() reads them: the cell's value (with
            its row's label, which names what the value is of), or the line. Places never count themselves: words
            that say "N of the M" take N and M from one row (one line, or the cells of one row), or from a value's
            row and the row that totals the values of a label card (`totals`, one_count). The person sees the card's
            title and the table around the cell, the cell tinted.
            A card that keeps its versions, as a label's card does (the browser's label versions, the terminal's
            labels), is given as each of its versions, with when that version was made (`version`, `from`, `made`,
            `after`; `to` when the host saw the card stop showing it before a next version was made). It is read as it
            was when the cited words were written (`at`): its places name the version made
            last by then, and `card:<id>@v<n>#…` an earlier one; a version made after the words is no evidence of them,
            since they could not have read it. The places of one citation must have shown their values at one time:
            one version, or versions shown together, and beside a card given as it is now only a version still shown
            now (_apart). The host keeps the versions where no card's code, agent or kernel writes them, so a change of
            the label's files after a version was made leaves that version as it was.
  count     a count of a card's rows that no one place shows ("3 of the 9 services failed on all 5 nights"): card
            evidence that names a table the card holds as data and the condition each counted row meets (`count`,
            and `of` for the rows the M counts). This module counts the rows itself, from the records the host gives
            with the card's outputs (`tables`: a table card's DataFrame, a chart's rows, a diagram's edges, a table the
            card's code printed, the terminal's rows.json, a label version's values), never from printed text: the
            words state that count, the table's number of rows where they say "of the M", and the sentence states each
            value of the condition (check_count). A label's table is the version its places name, read at the same
            time (`card:<id>@v<n>@out0` an earlier one), so one count reads one version; its row that totals the
            values (`totals`) is no row of the count.

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
says why: what the records show in place of the words, or what is missing (nearest, unshown). It names a cited file by
its path from the folder it lies in, and one outside every folder a cited file may lie in not at all (file_named,
OUTSIDE), never by where it lies on this machine; an error it quotes names its paths alike (error_words). A mark the
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
Its method, how the code of computed evidence got the value, stays on that evidence, over the code the person reads:
the checker's own words, which this module shows and does not check.

  check_all(marks, answer, calls, cwd, root, tmp, cards, rules, at)  -> {parsed, results}: every mark of a reply
  check_mark(mark, item, calls, cwd, root, tmp, cards, rules, at)    -> {n, status, shown, reason, failedBy?,
                                                                         evidence?, note?, was?, narrowed?, rewrite?,
                                                                         sources?}
  examine(items)                                                 -> checked marks' sources as they stand now, one read
                                                                     of each file: `changed` or `gone` when what a mark
                                                                     rests on differs from what the check read, and
                                                                     cited lines that moved at their new numbers
  card_index(cards, at)                                          -> the cards' tables, places and values, one per
                                                                     line, for the checker
  terminal_cards(folder)                                         -> the terminal's cards (cards/<id>/meta.json,
                                                                     rows.json) as `cards`
  terminal_label_cards(folder)                                   -> the terminal's labels' kept versions as `cards`
  uncitable(files, cwd, root, tmp, rules)                        -> those of the files no evidence may cite: outside
                                                                     every folder a cited file may lie in
  error_words(text, cwd, root, also)                             -> an error's text, each path of this machine in it
                                                                     named as a reason names a cited file
  parse_answer(text)                               -> the last ```json array of the checker's answer, or None
"""
from __future__ import annotations

import ast
import difflib
import glob
import hashlib
import io
import json
import keyword
import math
import operator
import os
import re
import shlex
import tokenize
from collections import Counter, deque
from decimal import Decimal, InvalidOperation
from stat import S_ISREG
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
LINE_BYTES = 1 << 24  # bytes of a cited line the check reads; a longer line is cut there
HAY_MAX = 20000  # characters of a long cited line read around its substring: the passage the words stand in
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

class Named(str):
    """A clause of a reason that opens with a name, whose case is its own: the cited file as a reason names it
    (`peer/run.log has no line 9`, `todo has no line 9`). look() writes such clauses, so it marks them."""


def sentence(clause: str) -> str:
    """A clause of a reason as the sentence the person reads: a stop at its end, and a capital first letter unless the
    clause opens with a name (Named)."""
    s = norm_ws(clause)
    if not s:
        return s
    if not isinstance(clause, Named):
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
    ww = wordnums(w, counts=True)
    nums = [number_named(ww, v, d) for v, d in marked_numbers(ww) if not has_number(v, said, dates=d, approx=approx)]
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


def same_number(v: str, w: str, approx: bool = False, exact: bool = False) -> bool:
    """`v`, a number of the marked words, and `w`, one of an output, in one form, are the same value: `w` rounded to the
    places `v` is written with is `v` (24 is 24.2, 48.4% is 48.43%, never 48.5%). A number with a scale is the value
    rounded to it: `8k` is any number from 7,500 to 8,499, `1.2m` any from 1,150,000 to 1,249,999. With `approx` (the
    words say "about"), a whole number that ends in zeros is the value rounded to them: "about 250" is 248, "about 700"
    is 650 to 749. With `exact` (a count the words state, "all 5", "3 of the 9": count_numbers), only the same value
    (5 is 5.0, never 4.6)."""
    if v == w:
        return True
    if exact:
        try:
            return Decimal(v) == Decimal(w)
        except InvalidOperation:
            return False
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


def number_named(words: str, v: str, in_date: bool) -> str:
    """A number of the words as a reason names it: one that stands in a time or a date by the whole time or date
    ("14:08", never its "8"), any other by its value."""
    if in_date:
        for a, b in date_spans(words):
            if any(number_at(m) == v for m in NUM.finditer(words[a:b])):
                return words[a:b]
    return v


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


def has_number(v: str, text: str, dates: bool = True, approx: bool = False, exact: bool = False) -> bool:
    """`v` (a number in one form) is one of the numbers of `text`, compared as values: 6 matches 6.0, 9 matches 09, 8k
    matches 8,225. With `dates` False, a number inside a date or a time of the text does not count (a count of 12 is
    not the 12 of 2026-10-12); with `exact`, no rounding (same_number)."""
    t = norm_ws(text)
    spans = [] if dates else date_spans(t)
    for m in NUM_IN_TEXT.finditer(t):
        w = number_at(m)
        if w is not None and not any(a <= m.start(1) < b for a, b in spans) and same_number(v, w, approx, exact):
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
        whole = count_numbers(target) - pct
        out = wordnums(out, counts=True)
        return all(has_number(v, out, dates=d, approx=approx or v in rough, exact=v in whole and not (approx or v in rough))
                   or (v in pct and has_number(fraction(v), out, approx=approx or v in rough)) for v, d in nums)
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
    """A percent as the share it is, as exact as the percent (59.7 is 0.597, 100 is 1.00, 50 is 0.50, never 0.5, which
    0.46 rounds to): an output may print the share."""
    return num_value(str(Decimal(v).scaleb(-2)))


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


def check_computed(target: str, given: Any, calls: list[dict[str, Any]], approx: bool = False, was: str = "", folder: str | None = None, cwd: str | None = None) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of computed evidence, and the evidence to show. The check names a call by the output it printed;
    the calls of the session whose real output holds that text are the candidates, and the first whose output shows
    the words, and whose code types none of them in, is the evidence: its code and its whole output, the words
    highlighted from the cited place on. When no call printed that output, the check's own last call is shown. For a
    correction, `was` is the marked words: the output also shows each run of words the correction puts in. Evidence
    that holds keeps the files its code names (code_files) as what it rests on; `cwd` is the shell's folder, `folder`
    the one the session started in."""
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
            folders = [f for f in (folder, cwd) if f]
            files = code_files(str(c.get("command") or ""), cwd or folder or ".", folder)
            return [], {**shown(c, spans), SOURCES: [x for p in files for x in [source(p, file_named(p, folders) or os.path.basename(p))] if x]}
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


def read_lines(path: str, a: int, b: int, partial: bool = False, folders: list[str] | None = None) -> tuple[int, list[str]] | None:
    """Lines a to b of a regular file, as (a, lines), each cut at LINE_BYTES; None when the file cannot be read, is no
    regular file (a pipe would never end), or, unless `partial`, has no line b. With `folders`, only a file that lies
    inside one of them is read, through the descriptor open_inside() opened it with. The lines before line a are counted
    in blocks, not read one by one, so a line deep in a big file is found quickly."""
    fd = open_inside(path, folders) if folders is not None else None
    if fd is None and (folders is not None or not os.path.isfile(path)):
        return None
    out: list[str] = []
    try:
        with os.fdopen(fd, "rb") if fd is not None else open(path, "rb") as f:
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
    ["Confirmed sequence: GA ->", "G5"]; [] for words that are no direct quote. Square brackets hold the quoter's own
    words: inside a word they complete or change it (`environ[ment]`, `[T]he`) and are read as part of it; standing
    alone they replace words of the record (`[the agents] could not`), and the quote is split there, as at an
    ellipsis."""
    w = unmark(words)
    spans = re.findall(r"[\"“]([^\"“”]+)[\"”]", w)
    if not spans and w[:1] in QUOTE_CHARS and w[-1:] in QUOTE_CHARS:
        spans = [w[1:-1]]
    frags = []
    for s in spans:
        s = re.sub(r"(?<=\w)\[([^\[\]]*)\]|\[([^\[\]]*)\](?=\w)", lambda m: m.group(1) or m.group(2) or "", s)
        frags += [f.strip(" .,;:" + QUOTE_CHARS) for f in re.split(r"…|\.\.\.|\[[^\[\]]*\]", s)]
    return [f for f in frags if len(f) >= 3]


def quoted_around(sentence: str, words: str) -> bool:
    """Whether the sentence quotes the cited words with its quote marks around the citation's brackets, a stop or a
    comma inside them: `u2 wrote "[I've been locked out]."`. Words that hold their own quote marks are left alone."""
    w = norm_ws(words)
    if not w or w[:1] in QUOTE_CHARS or w[-1:] in QUOTE_CHARS:
        return False
    return bool(re.search(r'"\[' + re.escape(one_quote(w)) + r'\][.,;:!?]?"', one_quote(norm_ws(sentence))))


JSON_ESCAPE = re.compile(r'\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\(["\\/bfnrt])')
JSON_SIMPLE = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


def json_unescaped(raw: str) -> str:
    """A line's JSON string escapes read as the characters they stand for (`\\u2014` is —, `\\"` is "), for a JSON
    line that does not parse whole: one longer than LINE_BYTES, cut there. "" when it holds no escape."""
    def one(m: re.Match) -> str:
        if m.group(1):
            return chr(0x10000 + ((int(m.group(1), 16) - 0xD800) << 10) + (int(m.group(2), 16) - 0xDC00))
        if m.group(3):
            return chr(int(m.group(3), 16))
        return JSON_SIMPLE.get(m.group(4), m.group(4))
    text = JSON_ESCAPE.sub(one, raw)
    return text if text != raw else ""


NO_JSON = object()  # line_json's answer for a line that holds no JSON value whole


def line_json(raw: str) -> Any:
    """The JSON value a line holds whole: the line itself (a JSONL record), else one member (`"spec": "…",`) or one
    element (`"…",`) of a JSON document written over many lines, the comma that ends it left out, as the browser writes
    a label's definition, its rule in it; NO_JSON when it holds none."""
    try:
        return json.loads(raw)
    except ValueError:
        pass
    part = raw.strip().removesuffix(",")
    if part.startswith('"'):
        for text in ("{" + part + "}", part):
            try:
                return json.loads(text)
            except ValueError:
                continue
    return NO_JSON


def forms(raw: str) -> list[tuple[str, bool]]:
    """The texts a line can hold words in: the line as written, and the strings of the JSON it holds decoded (`decoded`
    True, line_json); a JSON line cut at LINE_BYTES, with its escapes read."""
    out = [(raw, False)]
    v = line_json(raw)
    if v is not NO_JSON:
        out.append(("\n".join(json_strings(v)), True))
    elif raw.lstrip()[:1] in "{[" and json_unescaped(raw):
        out.append((json_unescaped(raw), True))
    return out


def shown_forms(raw: str) -> list[tuple[str, bool]]:
    """The texts a cited line is shown in, best first: each string value of the JSON it holds alone, decoded (a record's
    message, or a label's rule, reads as written, its line breaks real), then the line as written. A JSON line cut at
    LINE_BYTES shows with its escapes read."""
    v = line_json(raw)
    if v is NO_JSON:
        cut = json_unescaped(raw) if raw.lstrip()[:1] in "{[" else ""
        return [(cut, True), (raw, False)] if cut else [(raw, False)]
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


def _real(path: str) -> str | None:
    """The real path of `path`, or None when a link on its way went away while it was read: Python 3.12's realpath
    raises then, and code a card runs may swap links in the temp folder while a check runs."""
    try:
        return os.path.realpath(path)
    except OSError:
        return None


def inside(path: str, folders: list[str]) -> bool:
    """The absolute path lies inside one of the folders, compared by real paths: a link inside a folder to a file
    outside it is outside, and so is a path whose real path cannot be read now (_real)."""
    real = _real(path)
    return real is not None and any(real == r or real.startswith(r + os.sep) for r in map(_real, folders) if r)


def open_inside(path: str, folders: list[str]) -> int | None:
    """A descriptor of the regular file at `path` as it lies inside one of the folders now: the folder that holds its
    real path (inside()) opened by its own real path, then each part below it by its name in the folder above it,
    never through a link. A link put in place of the file, or of a folder on its way, after its real path was compared
    (code a card runs may write the temp folder) opens nothing, so the check never reads a file outside the folders.
    None when there is no such file."""
    from stat import S_ISREG  # noqa: PLC0415

    # a folder on the way is opened only to go through it (O_PATH where there is one), as an open by path needs
    passing = getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY | os.O_CLOEXEC
    real = _real(path)
    for top in map(_real, folders):
        if real is None or top is None or not real.startswith(top + os.sep):
            continue
        *parts, name = real[len(top) + 1:].split(os.sep)
        at = got = -1
        try:
            at = os.open(top, passing)
            for part in parts:
                below = os.open(part, passing | os.O_NOFOLLOW, dir_fd=at)
                os.close(at)
                at = below
            got = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=at)
            if not S_ISREG(os.fstat(got).st_mode):
                raise IsADirectoryError(name)  # or a pipe, which would never end
        except OSError:
            if got >= 0:
                os.close(got)
            continue
        finally:
            if at >= 0:
                os.close(at)
        return got
    return None


LEADING_CD = re.compile(r"\s*cd\s+(\S+)\s*(?:&&|;|\n)")


def named_paths(file: str, cwd: str, root: str | None, calls: list[dict[str, Any]] = ()) -> list[str]:
    """The paths a cited file may name (absolute, links not followed): an absolute path as it is; a relative one from
    the folder the session started in, from the shell's folder (where main's `cd` left it), and from each folder a call
    of the session moved to with a leading `cd`, since the check may have named the file from there."""
    if os.path.isabs(file):
        bases = [""]
    else:
        bases = [f for f in (root, cwd) if f]
        for c in calls:
            m = LEADING_CD.match(str(c.get("command") or ""))
            d = m.group(1).strip("'\"") if m else ""
            bases += [d] if os.path.isabs(d) else [os.path.join(b, d) for b in (root, cwd) if b and d]
    return list(dict.fromkeys(os.path.abspath(os.path.join(b, file)) for b in bases))


def paths_of(file: str, cwd: str, root: str | None, also: list[str], calls: list[dict[str, Any]] = ()) -> list[str]:
    """The paths a cited file may name (named_paths) that lie inside the session's folders, or inside one of the folders
    `also` names (the temp folder, a folder of labels' rules)."""
    folders = [f for f in (root, cwd, *also) if f]
    return [p for p in named_paths(file, cwd, root, calls) if inside(p, folders)]


def outside(file: str, cwd: str, root: str | None, also: list[str], calls: list[dict[str, Any]] = ()) -> bool:
    """Whether a cited file lies outside the session's folders and the folders `also` names, so place() takes no
    evidence from it: no path it may name lies inside them, or it names a file only through a link out of them, which
    names a file outside them, not none."""
    paths = paths_of(file, cwd, root, also, calls)
    return not paths or (not any(os.path.isfile(p) for p in paths) and any(os.path.isfile(p) for p in named_paths(file, cwd, root, calls)))


def also_of(kind: str, tmp: str | list[str] | None, rules: str | None) -> list[str]:
    """The folders a cited file of evidence of `kind` may lie in besides the session's: for what code does, the temp
    folders `tmp` (one, or a list), where Claude keeps its own code; for both kinds, a folder of labels' rules."""
    temps = [tmp] if isinstance(tmp, str) else list(tmp or [])
    return [f for f in (*(temps if kind == "code" else []), rules) if f]


def uncitable(files: list[str], cwd: str, root: str | None = None, tmp: str | list[str] | None = None, rules: str | None = None) -> list[str]:
    """The files no evidence may cite: those outside every folder a cited file may lie in (outside()), the session's
    folders and those of code, which hold those of a quote. A check that could not read such a file lost no evidence by
    it, since no read of it would count."""
    return [f for f in files if outside(str(f), cwd, root, also_of("code", tmp, rules))]


# ------------------------------------------------------------------------------------------------ a file, as a reason names it
#
# A reason names a cited file by its path from the folder it lies in (file_named), never by where that folder lies on
# this machine, which tells the person nothing of the claim and, long, is all the line that shows the reason holds. A
# file outside every folder a cited file may lie in is named not at all (OUTSIDE). Each form a path may take is read
# where it leads (written_path), so where a file is decides how the reason names it, never how its path is written.
# These only name a file: which files evidence is read from stays as outside() and paths_of() decide.

OUTSIDE = "the check cited a file outside the folder this session works in"
UNREAD = "the check named {} in a form thimble does not read"
# the forms of a path that only a shell or a URL reads: from a home folder (`~/`, `~user/`), from a variable (`$HOME/`,
# `${HOME}/`), or a `file:` URL in any case
SHELL_FORM = re.compile(r"(?i)file:|~(?:[\w.-]*/|$)|\$\{?[A-Za-z_]\w*\}?/")


def written_path(file: str, base: str) -> str | None:
    """The absolute path a path leads to, in each form it may be written: an absolute one, `//` read as `/`; a `file:`
    URL in any case (`file:/x`, `file:///x`, `file://localhost/x`, its %XX escapes read); one from a home folder (`~/`,
    `~user/`) or from $HOME (`$HOME/`, `${HOME}/`); else one from `base`, which `../` leaves. None for one that leads
    to no folder this machine names (the home of a user it does not have, another variable), or that no path can be."""
    s = str(file).strip()
    if s[:5].lower() == "file:":
        s = unquote(s[5:])
        if s.startswith("//"):
            host, _, rest = s[2:].partition("/")
            s = "/" + (rest if host.lower() in ("", "localhost") else s[2:])
    if s.startswith("~"):
        s = os.path.expanduser(s)
        if s.startswith("~"):
            return None
    elif s.startswith("$"):
        m = re.match(r"\$(?:HOME|\{HOME\})(?=/|$)", s)
        if not m:
            return None
        s = os.path.expanduser("~") + s[m.end():]
    if "\0" in s:
        return None
    full = os.path.normpath(os.path.join(base or os.sep, s))
    return "/" + full.lstrip("/") if full.startswith("//") else full


def file_named(path: str, folders: list[str]) -> str | None:
    """A file by its path from the first of the folders that holds it, compared as written, then by real paths (a
    folder named through a link holds its files too); a folder itself by its own name. None when none holds it. The
    root of the file system holds every file, so it names none."""
    if "\0" in str(path):
        return None
    full = os.path.abspath(path)
    for real in (False, True):
        p = _real(full) if real else full
        for f in folders:
            d = _real(f) if real else os.path.abspath(f)
            if p is None or d is None or d == os.sep:
                continue
            if p == d:
                return os.path.basename(d)
            if p.startswith(d + os.sep):
                return os.path.relpath(p, d)
    return None


# what a check may write around a path it cites, which is no part of it: white space, quotes, backticks, angle brackets
WRAPPERS = " \t\r\n`'\"‘’“”«»„<>"


def cited_file(file: Any) -> str:
    """The path a cited file names, as the check meant it: without the white space, quotes, backticks or angle brackets
    it stood in, JSON's `\\/` read as `/`, and an editor's link to a file (`vscode://file/x`) read as its path."""
    s = str(file or "").replace("\\/", "/").strip(WRAPPERS)
    link = EDITOR_LINK.match(s)
    return s[link.end():] if link else s


def missing(file: str, cwd: str, root: str | None, also: list[str], calls: list[dict[str, Any]] = ()) -> str:
    """Why a cited file that names no file thimble reads gives no evidence. A path written in a form thimble does not read
    (in quotes, backticks or angle brackets, with JSON's escapes, as an editor's link, or as only a shell or a URL reads
    it: `~/`, `$HOME/`, `file:`) is read where it leads (cited_file, written_path), to name the file: a file there is
    not read, as such a path never was, and is named from its folder; one outside every folder a cited file may lie in
    is named not at all, and a URL of a server not at all. Any other path names a file that is not there."""
    folders = [f for f in (root, cwd, *also) if f]
    plain = cited_file(file)
    if URL_START.match(plain) and plain[:5].lower() != "file:":
        return UNREAD.format("a file")
    if plain != str(file) or SHELL_FORM.match(plain):
        full = written_path(plain, root or cwd)
        if full is None:
            return UNREAD.format("a file")
        if not inside(full, folders):
            return OUTSIDE
        name = file_named(full, folders) or os.path.basename(full)
        return UNREAD.format(name) if os.path.isfile(full) else f"there is no file {name} in this session's folder"
    p = (paths_of(file, cwd, root, also, calls) or named_paths(file, cwd, root, calls))[0]
    return f"there is no file {file_named(p, folders) or os.path.basename(p)} in this session's folder"


# ------------------------------------------------------------------------------------------------ an error, as thimble quotes it
#
# An error thimble quotes in a reason, a notice or a repair request (an exception's text, a fork's error) is thimble's
# own words, never the records' nor the check's: each path of this machine in it is read where it leads, as a cited
# file is (written_path), and named as a reason names one (error_words). The terminal's notices name them alike
# (core/text.js errorWords).

# a path in an error's text: one quoted whole (in straight or typographic quotes, backticks), which may hold spaces and
# colons, else one in a run of the characters a path holds, not a URL, starting where the run does, right after a flag
# that names a folder (`-I/x`), or right after a colon, `=`, `|`, `&`, a brace or an escaped line break in it
# (`failed:/x`, `--settings=/x`, `{/x}`, `error\n/x`), and ending at the next of those (`/x/run.py:12:5`, `/a/b:/c/d`), a
# `file:` URL's own colon aside. A link an editor opens (`vscode://file/x`) names a path too; `\/`, JSON's escape of
# `/`, reads as `/`
PATH_QUOTES = "'\"`‘’“”«»„"
QUOTED_PATH = re.compile(rf"""([{PATH_QUOTES}])((?:file:|~[A-Za-z0-9_.-]*/|\$\{{?[A-Za-z_][A-Za-z0-9_]*\}}?/|\.\.?/|/)[^{PATH_QUOTES}\n]*?)[{PATH_QUOTES}]""", re.I)
INVISIBLE = "\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff"  # zero-width and direction marks
PATH_RUN = re.compile(rf"""[^\s{PATH_QUOTES}()\[\]<>,;{INVISIBLE}]+""")
PATH_START = re.compile(r"file:|~[A-Za-z0-9_.-]*/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/|\.\.?/|/", re.I)
PATH_STOP = re.compile(r"[:=|&]|(?<!\$)\{|\\[ntr]")  # where a path in a run ends, and the next may start
FOLDER_FLAG = re.compile(r"-[IL](?=[/~$.]|file:)")  # a compiler's folder flag right before its path (`-I/x`)
URL_START = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
URL_SCHEME = re.compile(r"(?:^|:)(?!file:$)[A-Za-z][A-Za-z0-9+.-]*:$", re.I)  # a URL's scheme just before its `//`
EDITOR_LINK = re.compile(r"(?i)[A-Za-z][A-Za-z0-9+.-]*://file(?=/)")  # vscode://file/x, cursor://file/x


def error_words(text: str, cwd: str, root: str | None = None, also: list[str] = ()) -> str:
    """An error's text as thimble quotes it: each path of this machine in it named as a reason names a file, by its path
    from the folder of the session's that holds it (file_named), else by its name alone. A path is read from the shell's
    folder, as the process that wrote the error read it. A URL, a path relative to no folder named, and other words stay
    as they are."""
    folders = [f for f in (root, cwd, *also) if f]

    def named(path: str) -> str:
        try:
            full = written_path(path, cwd or root or os.sep)
            name = file_named(full, folders) if full else None
        except (OSError, ValueError):
            full, name = None, None
        if full and not name and full.rstrip("/") == os.path.expanduser("~").rstrip("/"):
            return "~"  # the home folder itself, whose own name is the person's
        return name or os.path.basename((full or path).rstrip("/")) or path

    def run(m: re.Match[str]) -> str:
        t = m.group(0)
        if (link := EDITOR_LINK.match(t)):
            return named(t[link.end():])
        if URL_START.match(t) and t[:5].lower() != "file:":
            return t
        out, done = [], 0
        flag = FOLDER_FLAG.match(t)
        for at in [flag.end() if flag else 0] + [x.end() for x in PATH_STOP.finditer(t)]:
            if at < done or not PATH_START.match(t, at) or (t.startswith("//", at) and URL_SCHEME.search(t, 0, at)):
                continue
            stop = PATH_STOP.search(t, at + (5 if t[at:at + 5].lower() == "file:" else 0))
            path = t[at:stop.start() if stop else len(t)].rstrip(".!?")
            if re.search(r"/[^/]", path):
                out += [t[done:at], named(path)]
                done = at + len(path)
        return "".join(out) + t[done:]

    text = QUOTED_PATH.sub(lambda m: m.group(0)[0] + named(m.group(2)) + m.group(0)[-1], str(text).replace("\\/", "/"))
    return PATH_RUN.sub(run, text)


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


def place(ev: dict[str, Any], cwd: str, root: str | None, also: list[str] = (), calls: list[dict[str, Any]] = ()) -> tuple[list[str], dict[str, Any] | None, list[str], str]:
    """One cited place: its problems, the place to show (`file`, `line`, the cited lines with a line around them, the
    substring highlighted), the texts the cited lines hold, and the file as a reason names it (file_named). A relative
    path names a file of one of the folders paths_of() reads it from: the one whose lines hold the substring. A file in
    one of the folders `also` names counts too (the temp folder, where Claude keeps its own code, or a folder of labels'
    rules); its path shows whole."""
    file, line, sub = ev.get("file"), ev.get("line", ev.get("lines")), ev.get("substring")
    if not file or line is None or not sub:
        return ["the check named no line of a file to look at"], None, [], ""
    if outside(str(file), cwd, root, also, calls):
        return [OUTSIDE], None, [], ""
    files = [p for p in paths_of(str(file), cwd, root, also, calls) if os.path.isfile(p)]
    if not files:
        return [missing(str(file), cwd, root, also, calls)], None, [], ""
    folders = [f for f in (root, cwd, *also) if f]
    names = [file_named(p, folders) or os.path.basename(p) for p in files]
    looks = [(*look(p, name, line, str(sub), cwd, root, folders), name) for p, name in zip(files, names)]
    return next((x for x in looks if not x[0]), looks[0])


def look(path: str, file: str, line: Any, sub: str, cwd: str, root: str | None, folders: list[str] | None = None) -> tuple[list[str], dict[str, Any] | None, list[str]]:
    """The cited lines of one file, as place() gives them, `file` the file as a reason names it, read only as it lies
    inside one of `folders` (read_lines). A line number is where to look: when the cited lines do not hold the
    substring and lines up to SHIFT_MAX away do, the nearest such lines are cited in their place: the same number of
    lines moved, or more lines around them (a quote that runs over three lines cited as two)."""
    span = line_span(line)
    if not span:
        # its words only when they are numbers: a check may write a path where the line goes
        said = str(line).strip() if re.fullmatch(r"[\sLl\d,–-]+", str(line)) else ""
        return [f"the check cited lines {said}, which are not one line or a range of at most {MAX_RANGE} lines" if said
                else "the check named no line number of the file"], None, []
    a, b = span
    near = read_lines(path, max(1, a - SHIFT_MAX), b + SHIFT_MAX, partial=True, folders=folders)
    if near is None or near[0] + len(near[1]) - 1 < b:
        return [Named(f"{file} has no line {line}")], None, []
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
    if not problems and any(len(h) > HAY_MAX for h in hay):
        # a long line, such as a transcript kept as one line of JSON: the cited words stand where the substring does,
        # so only the passage around it is read, and a number elsewhere in the line does not show them
        near = [window(h, [hit], HAY_MAX)[0] if hit else "" for h in hay for hit in [find_loose(str(sub), h) if len(h) > HAY_MAX else [0, 0]]]
        hay = [h for h in near if h] or hay
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
    # a file inside the folders shows by the path it was cited by, from the start folder; one cited by a path that
    # reaches the folder from outside, through a link to it (a session folder ~/traces that links to another disk),
    # shows by where it lies in the folder, as the folder's own files do
    top = os.path.abspath(root or cwd)
    rel = path if not inside(path, [top, cwd]) else os.path.relpath(path, top)
    if rel.startswith("../"):
        rel = os.path.relpath(_real(path) or path, _real(top) or top)
    # the path read, which check_quote keeps as the place's source and takes out of the place it shows
    return problems, {"file": rel, "line": line, "lines": rows, READ_PATH: path}, hay


def check_quote(target: str, kind: str, evs: list[dict[str, Any]], cwd: str, root: str | None = None, tmp: str | list[str] | None = None, calls: list[dict[str, Any]] = (), was: str = "", rules: str | None = None) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of quote or code evidence, and the cited places to show. The evidence is one place, or several when
    the claim joins places (a value set on one line and used on another): each place holds the words the check gave
    for it, and the places together hold the quoted words of a direct quote and the numbers of the words. A claim about
    what code does may cite Claude's own code in a temp folder `tmp` names (one, or a list); a quote of a record may
    not, since a file there holds what Claude derived, not the records. A label's rule in `rules` is evidence of what
    the label counts and how, as code or as a quote; a quote of it, as any quote, holds the days and numbers of the
    words in its lines, so a rule shows no count it does not state. For a correction of a quote of a record, `was` is
    the marked words: the cited lines also show each run of words the correction puts in."""
    problems: list[str] = []
    shown: list[dict[str, Any]] = []
    names: list[str] = []
    hay: list[str] = []
    # the folders a cited file may lie in besides the session's: Claude's own code for code, labels' rules for both
    also = also_of(kind, tmp, rules)
    for ev in evs:
        p, s, h, name = place(ev, cwd, root, also, calls)
        problems += p
        hay += h
        if s:
            shown.append(s)
            names.append(name)
    if not shown:
        return problems, None
    where = " or ".join(f"line {s['line']} of {name}" for s, name in zip(shown, names))
    for frag in quote_fragments(target):
        if not any(in_text(frag, h) for h in hay) and not (kind == "code" and in_code(frag, hay)):
            problems.append(instead(where, f"“{frag}”", hay))
    # a quote of a record shows its days and numbers; a claim about what code does may compute them from it (`2 ** k`)
    if kind != "code" and calendar_days(unmark(target)) and not days_shown(unmark(target), " ".join(hay)):
        problems.append(instead(where, unmark(target), hay))
    pct = percents(target)
    for v, in_date in (marked_numbers(unmark(target)) if kind != "code" else []):
        if not any(has_number(v, h, dates=in_date) or (v in pct and has_number(fraction(v), h)) for h in hay):
            problems.append(f"{where} reads “{nearest(target, hay)}”, not {number_named(unmark(target), v, in_date)}")
    if was and kind != "code" and not problems:
        missing = unshown_change(was, target, "\n".join(hay))
        if missing:
            problems.append(f"{where} does not show “{short(' … '.join(missing), 60)}”")
    read = [s.pop(READ_PATH, None) for s in shown]
    out = {"kind": kind, **shown[0], **({"more": shown[1:]} if len(shown) > 1 else {})}
    if not problems:
        # each cited place, as the check read it: what the citation rests on
        out[SOURCES] = [x for p, s in zip(read, shown) if p for x in [source(p, s["file"], s["line"])] if x]
    return problems, out


# ------------------------------------------------------------------------------------------------ what a citation rests on
#
# A citation the check confirmed rests on files: the lines that quote and code evidence cite, and the files that the
# code of computed evidence names. For each, check_mark keeps what identifies the version the check read (`sources`):
# the file's size and mtime then, and the sha256 of the cited lines (with that of their first line, `head`, which finds
# them where they moved), or of the whole file for code that reads it. examine() says how each reads now. The plugin
# and the workbench keep one index of the cited files, stat each file once at the moments they show citations, and call
# examine() only for a file whose stat changed since they last looked (the plugin's marks/stale.ts, the workbench's
# marks.refresh_sources), so a citation whose source changed after its check shows that it is stale.
#
# examine() reads each file once at most, for all the sources that rest on it:
#   cited lines   the lines at their numbers, reached by counting line breaks in blocks: as the check read them, the
#                 source stands. Else the file once more, for the nearest lines that hash the same (an edit above them
#                 moved them): the citation takes their numbers, and nothing else changes. None, and the source
#                 changed. A source already found changed is read at its numbers only (an edit undone), never searched.
#   a whole file  its size first: another size than the check read is another file, changed with no read; the same
#                 size, its hash.
# So a log that grows at each pass costs a stat, and for a citation of its lines a read up to those lines: never a hash
# of the whole log.

SOURCES = "sources"  # the key a place's or a call's evidence carries its sources under, until check_mark takes them
READ_PATH = "_path"  # the key a place carries the path read under, until check_quote takes it
WILDCARD = re.compile(r"[*?[]")


def _mtime_ms(st: os.stat_result) -> float:
    """A stat's mtime in milliseconds, as the plugin's hooks read a file's (`mtimeMs`)."""
    return st.st_mtime_ns / 1e6


def _open_file(path: str) -> Any:
    """The regular file at `path`, open to read as bytes, or None: not there, not readable, or no regular file (a pipe
    would never end)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    except (OSError, ValueError):
        return None
    f = os.fdopen(fd, "rb")
    try:
        if S_ISREG(os.fstat(f.fileno()).st_mode):
            return f
    except OSError:
        pass
    f.close()
    return None


def _hashed(raw: bytes) -> bytes:
    """A line as the hash of cited lines takes it: without its line break, then one line break."""
    return raw.rstrip(b"\r\n") + b"\n"


def _file_hash(f: Any) -> str:
    """The sha256 of the whole of open file f."""
    f.seek(0)
    h = hashlib.sha256()
    for block in iter(lambda: f.read(BLOCK), b""):
        h.update(block)
    return h.hexdigest()


def _skip_to(f: Any, line: int, a: int) -> int:
    """From the start of line `line` of open file f to the start of line `a`, the line breaks counted in blocks as
    read_lines counts them; answers the line it reached, short of `a` when the file ends first."""
    while line < a:
        block = f.read(BLOCK)
        if not block:
            return line
        n = block.count(b"\n")
        if line + n < a:
            line += n
            continue
        at = -1
        for _ in range(a - line):
            at = block.index(b"\n", at + 1)
        f.seek(f.tell() - (len(block) - at - 1))
        line = a
    return line


def _lines_hash(f: Any, k: int, starts: dict[int, int] | None = None, first: int = 0) -> tuple[str, str] | None:
    """The sha256 of the next k lines of open file f, and that of the first of them alone; None when it has fewer.
    `starts` takes where each line read starts, the first numbered `first`."""
    h = hashlib.sha256()
    head = ""
    for i in range(k):
        if starts is not None:
            starts[first + i] = f.tell()
        raw = f.readline()
        if not raw:
            return None
        line = _hashed(raw)
        h.update(line)
        if not i:
            head = hashlib.sha256(line).hexdigest()
    return h.hexdigest(), head


def source(path: str, file: str, line: Any = None) -> dict[str, Any] | None:
    """A source as the check read it: the file by the name a reason gives it (`file`), its real path, the cited lines
    (`line`) when it rests on them alone, its size and mtime, and the sha256 of what it rests on, for several cited
    lines with that of the first of them (`head`); None when it cannot be read or has no such lines."""
    span = line_span(line) if line else None
    if line and not span:
        return None
    f = _open_file(path)
    if f is None:
        return None
    with f:
        try:
            st = os.fstat(f.fileno())
            if not span:
                got: tuple[str, str] | None = (_file_hash(f), "")
            else:
                got = _lines_hash(f, span[1] - span[0] + 1) if _skip_to(f, 1, span[0]) == span[0] else None
        except OSError:
            return None
    if got is None:
        return None
    out = {"file": file, "path": _real(path) or path, **({"line": str(line)} if line else {}), "size": st.st_size,
           "mtime": _mtime_ms(st), "sha256": got[0]}
    # a run of lines is found again by its first line; one line, by its own hash
    return {**out, "head": got[1]} if span and span[1] > span[0] else out


def code_files(command: str, cwd: str, root: str | None = None) -> list[str]:
    """The files that the code of a call names, which computed evidence rests on: each string of its code (scripts())
    that names a regular file inside the session's folders, read from the folder the call ran in (its leading `cd`,
    else the shell's folder or the one the session started in), and each file that a string with a wildcard matches
    there (`*/runs.jsonl`, `**` too) when the string names a folder or a kind of file, with a `/` or a `.` (a `"*"`
    the code prints names none). A path the code builds from parts names none."""
    m = LEADING_CD.match(command)
    d = m.group(1).strip("'\"") if m else ""
    bases = [f for f in (cwd, root) if f]
    if d:
        bases = [d] if os.path.isabs(d) else [os.path.join(b, d) for b in bases]
    folders = [f for f in (root, cwd) if f]
    out: dict[str, None] = {}
    for code in scripts(command):
        try:
            toks = tokens(code)
        except (tokenize.TokenError, SyntaxError, IndentationError):
            continue
        for t in toks:
            s = string_value(t.string) if t.type == tokenize.STRING else ""
            if not s.strip() or "\n" in s or "\0" in s:
                continue
            for b in bases:
                full = os.path.normpath(os.path.join(b, s))
                wild = WILDCARD.search(s)
                if wild and not re.search(r"[/.]", s):
                    continue
                for p in sorted(glob.glob(full, recursive=True)) if wild else [full]:
                    if os.path.isfile(p) and inside(p, folders):
                        out.setdefault(_real(p) or p)
    return list(out)


def _spans_read(f: Any, spans: list[tuple[int, int]]) -> dict[tuple[int, int], str | None]:
    """The sha256 of each span of lines of open file f (as _lines_hash), in one pass from its start: the lines before a
    span counted in blocks, a line read again only where two spans share it; None for a span the file is too short
    for."""
    out: dict[tuple[int, int], str | None] = {}
    starts: dict[int, int] = {}
    f.seek(0)
    line = 1
    for a, b in sorted(set(spans)):
        if a in starts:
            f.seek(starts[a])
            line = a
        else:
            line = _skip_to(f, line, a)
        got = _lines_hash(f, b - a + 1, starts, a) if line == a else None
        out[(a, b)] = got[0] if got else None
        line = b + 1
    return out


def _find_lines(f: Any, srcs: list[dict[str, Any]]) -> dict[int, int]:
    """Where cited lines that are not at their numbers stand now: for each source, by its place in `srcs`, the first
    line of the run of lines nearest its numbers that hashes as its cited lines did (the run's first line found by
    `head`), the upper one of two as near. Reads open file f from its start, and stops once no later run can be
    nearer."""
    want = []
    for i, s in enumerate(srcs):
        span = line_span(s.get("line"))
        if span:
            want.append((i, span[0], span[1] - span[0] + 1, str(s.get("head") or ""), str(s.get("sha256") or "")))
    best: dict[int, int] = {}
    if not want:
        return best
    size = max(k for _, _, k, _, _ in want)
    lines: deque[bytes] = deque(maxlen=size)
    heads: deque[str] = deque(maxlen=size)
    f.seek(0)
    for n, raw in enumerate(f, 1):
        line = _hashed(raw)
        lines.append(line)
        heads.append(hashlib.sha256(line).hexdigest())
        for i, a, k, head, sha in want:
            start = n - k + 1
            if start < 1 or (i in best and abs(start - a) >= abs(best[i] - a)):
                continue
            first = heads[-k]
            if (head and first != head) or (k == 1 and first != sha):
                continue
            if k == 1 or hashlib.sha256(b"".join(list(lines)[-k:])).hexdigest() == sha:
                best[i] = start
        if len(best) == len(want) and all(n - k + 2 - a >= abs(best[i] - a) for i, a, k, _, _ in want):
            break
    return best


def examine_file(path: str, srcs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The sources of one file as it stands now, in order (examine), from one read of it, and one more for cited lines
    that are not at their numbers: `gone` when the file is not there or is no regular file, `changed` when what a source
    rests on no longer reads as the check read it, and cited lines that moved with their numbers now (`line`). A source
    that reads as the check read it has neither."""
    clear = [{k: v for k, v in s.items() if k not in ("changed", "gone")} for s in srcs]
    f = _open_file(path)
    if f is None:
        return [{**c, "gone": True} for c in clear]
    out: list[dict[str, Any] | None] = [None] * len(srcs)
    with f:
        try:
            size = os.fstat(f.fileno()).st_size
            whole = ""
            spans = _spans_read(f, [sp for s in srcs if s.get("line") for sp in [line_span(s["line"])] if sp])
            for i, s in enumerate(srcs):
                if not s.get("line"):
                    # another size is another file; the same size, its hash
                    if size == s.get("size"):
                        whole = whole or _file_hash(f)
                    out[i] = clear[i] if size == s.get("size") and whole == s.get("sha256") else {**clear[i], "changed": True}
                elif spans.get(line_span(s["line"]) or (0, 0)) == s.get("sha256"):
                    out[i] = clear[i]
            # cited lines not at their numbers, but those found changed before: a log that keeps changing would be
            # searched whole at each pass
            lost = [i for i, x in enumerate(out) if x is None and not srcs[i].get("changed") and line_span(srcs[i].get("line"))]
            found = _find_lines(f, [srcs[i] for i in lost]) if lost else {}
        except OSError:
            return [{**c, "changed": True} for c in clear]
    for j, i in enumerate(lost):
        span = line_span(srcs[i]["line"])
        if j in found and span:
            start = found[j]
            out[i] = {**clear[i], "line": str(start) if span[0] == span[1] else f"{start}-{start + span[1] - span[0]}"}
    return [x if x is not None else {**clear[i], "changed": True} for i, x in enumerate(out)]


def moved_place(evidence: Any, was: dict[str, Any], now: dict[str, Any]) -> Any:
    """The evidence with the place that source `was` rests on (its file and cited lines) at the lines source `now`
    names: the cited lines numbered anew, and each line around them kept where the file still reads the same there, so
    no words come into it that the check did not show."""
    span, to = line_span(was.get("line")), line_span(now.get("line"))
    if not span or not to:
        return evidence
    d = to[0] - span[0]

    def place(p: Any) -> Any:
        if not isinstance(p, dict) or p.get("file") != was.get("file") or str(p.get("line")) != str(was.get("line")):
            return p
        near = read_lines(str(now.get("path") or ""), max(1, to[0] - 1), to[1] + 1, partial=True)
        reads = {near[0] + k: window(t, [], CONTEXT_MAX)[0] for k, t in enumerate(near[1])} if near else {}
        rows = [{**r, "n": r["n"] + d} for r in p.get("lines") or [] if isinstance(r, dict) and isinstance(r.get("n"), int)
                and (span[0] <= r["n"] <= span[1] or reads.get(r["n"] + d) == r.get("text"))]
        return {**p, "line": now["line"], "lines": rows}

    if isinstance(evidence, list):
        return [moved_place(e, was, now) for e in evidence]
    if not isinstance(evidence, dict):
        return evidence
    out = place(evidence)
    return {**out, "more": [place(p) for p in out["more"]]} if isinstance(out.get("more"), list) else out


def examine(items: list[Any]) -> list[Any]:
    """Checked marks' sources as they stand now: for each item {sources, evidence?}, in order, {sources} as
    examine_file answers each, with `evidence` too when cited lines moved (moved_place). The sources of every item that
    rest on one file are read together, once. A value that is no such item comes back as it is."""
    marks = [(i, it["sources"]) for i, it in enumerate(items) if isinstance(it, dict) and isinstance(it.get("sources"), list)]
    by_path: dict[str, list[tuple[int, int]]] = {}
    for i, srcs in marks:
        for k, s in enumerate(srcs):
            if isinstance(s, dict):
                by_path.setdefault(str(s.get("path") or ""), []).append((i, k))
    now: dict[tuple[int, int], dict[str, Any]] = {}
    for path, places in by_path.items():
        now.update(zip(places, examine_file(path, [items[i]["sources"][k] for i, k in places])))
    out = list(items)
    for i, srcs in marks:
        ev, moved, kept = items[i].get("evidence"), False, []
        for k, s in enumerate(srcs):
            x = now.get((i, k), s)
            if isinstance(s, dict) and s.get("line") and x.get("line") != s.get("line"):
                ev, moved = moved_place(ev, s, x), True
            kept.append(x)
        out[i] = {"sources": kept, **({"evidence": ev} if moved else {})}
    return out


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
# a place of a card: a cell, `card:<id>#<col>/<row>`, or a line of its printed output, `card:<id>@out<i>#L<n>`; a place
# of one version of a card that keeps its versions (a label's card) has `@v<n>` after the id (group 2)
CARD_TD = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)(?:@v(\d{1,9}))?#([^/]+)/(.+)$")
CARD_LINE = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)(?:@v(\d{1,9}))?@out(\d+)#L(\d+)$")
# lines of a card's printed output cited as a range: `card:<id>@out<i>#L<a>-L<b>` (or `-<b>`)
CARD_LINES = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)(?:@v(\d{1,9}))?@out(\d+)#L(\d+)-L?(\d+)$")


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


def _when(card: dict[str, Any]) -> float | None:
    """When the version a card's entry shows was made (seconds since the epoch, `from`): a card that keeps its versions,
    as a label's card does, gives each of them so (the browser's label versions, the terminal's labels); None for a card
    given only as it is now."""
    v = card.get("from")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not isinstance(card.get("version"), int):
        return None
    return float(v)


def _version_of(card: dict[str, Any]) -> int | None:
    v = card.get("version")
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _timeline(cid: str, cards: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """The versions of card `cid` that keeps its versions, oldest first, one per version number."""
    seen: set[int] = set()
    out = []
    for c in sorted((c for c in cards or [] if isinstance(c, dict) and str(c.get("id")) == cid and _when(c) is not None),
                    key=lambda c: (_when(c), _version_of(c))):
        if _version_of(c) not in seen:
            seen.add(_version_of(c))
            out.append(c)
    return out


def _card_entry(cid: str, version: int | None, cards: list[dict[str, Any]] | None, at: float | None) -> tuple[str, dict[str, Any] | None]:
    """The entry of card `cid` a citation names, or why there is none. A card that keeps its versions (each entry with
    its `version` and when it was made, `from`) is cited as it was when the cited words were written (`at`, seconds
    since the epoch; None: now): its plain place names the version made last by then, and `@v<n>` names version n,
    which must have been made by then too. A version made later is no evidence of words written before it: they could
    not have read it. The entry carries `span`, from when to when it was shown (the next version's making; None while it
    is the newest). A card given only as it is now is its one entry, and `@v<n>` names it only when that is the version
    it gives."""
    same = [c for c in cards or [] if isinstance(c, dict) and str(c.get("id")) == cid]
    if not same:
        return f"there is no card {cid} in this session", None
    timed = _timeline(cid, cards)
    if not timed:
        card = same[0]
        if version is None or _version_of(card) == version:
            return "", card
        return f"the card has no version {version}", None
    if version is None:
        then = [c for c in timed if at is None or _when(c) <= at]
        if not then:
            return "the card has no version from before these words were written", None
        hit = then[-1]
    else:
        hit = next((c for c in timed if _version_of(c) == version), None)
        if hit is None:
            return f"the card has no version {version}", None
        if at is not None and _when(hit) > at:
            return f"the card's version {version} was made after these words were written", None
    i = timed.index(hit)
    # shown until the next version was made, or until the host says the card stopped showing it (`to`), whichever came
    # first
    ends = [_when(timed[i + 1]) if i + 1 < len(timed) else None, _when({**hit, "from": hit.get("to")})]
    ends = [x for x in ends if x is not None]
    return "", {**hit, "span": (_when(hit), min(ends) if ends else None)}


def _listed(cards: list[dict[str, Any]] | None, at: float | None) -> list[tuple[dict[str, Any], str, str]]:
    """The cards as the checker's index lists them, each (entry, the id its places are cited by, its heading's note): a
    card given as it is now by its id; one that keeps its versions as it was when the cited words were written (`at`)
    by its id, then each version before that one, the newest first, by `<id>@v<n>`, each with what made it and what
    changed after it. A card whose versions were all made later is left out."""
    out: list[tuple[dict[str, Any], str, str]] = []
    done: set[str] = set()
    for card in cards or []:
        cid = str(card.get("id") or "") if isinstance(card, dict) else ""
        if not cid or cid in done:
            continue
        done.add(cid)
        timed = _timeline(cid, cards)
        if not timed:
            out.append((card, cid, ""))
            continue
        then = [c for c in timed if at is None or _when(c) <= at]
        if not then:
            continue

        def note(c: dict[str, Any], what: str) -> str:
            made, after = norm_ws(c.get("made") or ""), norm_ws(c.get("after") or "")
            return "; ".join(x for x in (what, f"made by: {made}" if made else "", f"it changed after: {after}" if after else "") if x)

        now = then[-1]
        # the label as it was then: a plain heading while it is the label's one version and nothing changed after it
        out.append((now, cid, note(now, "as it was when the cited words were written") if len(then) > 1 or now.get("after") else ""))
        for c in reversed(then[:-1]):
            out.append((c, f"{cid}@v{_version_of(c)}", note(c, "an earlier version")))
    return out


def card_places(cards: list[dict[str, Any]] | None, at: float | None = None) -> list[tuple[str, str]]:
    """Every place of the cards a citation can name, with what it shows: (`card:<id>#<col>/<row>`, the value) for each
    table cell, (`card:<id>@out<i>#L<n>`, the line) for each line of printed output; of a card that keeps its versions,
    the places of each version made by `at` (_listed)."""
    out: list[tuple[str, str]] = []
    for card, ref_id, _ in _listed(cards, at):
        for o in card.get("outputs") or []:
            for col, row, value in o.get("cells") or []:
                if str(col).strip() and str(row).strip():
                    out.append((f"card:{ref_id}#{encode_label(str(col))}/{encode_label(str(row))}", str(value)))
            for n, text in o.get("lines") or []:
                if str(text).strip():
                    out.append((f"card:{ref_id}@out{int(o.get('out') or 0)}#L{int(n)}", str(text)))
    return out


def table_place(cid: str, o: dict[str, Any], t: dict[str, Any]) -> str:
    """The place a count names a table of a card by (check_count): its output, `card:<id>@out<i>`, and for a table the
    card's code printed, the output's lines it stands on, `card:<id>@out<i>#L<a>-L<b>`."""
    at = f"card:{cid}@out{int(o.get('out') or 0)}"
    span = t.get("lines")
    return f"{at}#L{int(span[0])}-L{int(span[1])}" if isinstance(span, list) and len(span) == 2 else at


def table_note(t: dict[str, Any]) -> str:
    """What the checker's index says of a table a card holds as data: its rows and its columns."""
    rows, total = len(t.get("rows") or []), int(t.get("total") or 0)
    held = f"a table of {total:,} rows" + (f", of which the card keeps {rows:,}" if total > rows else "")
    return f"{held}: {', '.join(norm_ws(c) for c in t.get('columns') or [])}"


def card_index(cards: list[dict[str, Any]] | None, at: float | None = None) -> str:
    """What the checker greps for a value a card shows: a heading line for each card (`# card:<id> <title>`), a line
    for each table the card holds as data, which a count of its rows names (its place, a tab, its rows and columns:
    table_note), then one line for each place, its citation, a tab, and what it shows. A card that keeps its versions is
    listed as it was when the cited words were written (`at`), and its earlier versions after it (_listed), each heading
    saying so, with the tables and places of that version (`card:<id>@v<n>@out<i>`)."""
    lines: list[str] = []
    n = 0
    for card, ref_id, note in _listed(cards, at):
        lines.append(f"# card:{ref_id} {norm_ws(card.get('title') or '')}".rstrip() + (f" ({note})" if note else ""))
        tables = [(table_place(ref_id, o, t), table_note(t)) for o in card.get("outputs") or [] for t in o.get("tables") or []]
        for ref, value in tables + card_places([{**card, "id": ref_id, "from": None}]):
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


RECORDS_MAX = 5000  # records of a terminal card's rows.json read as its table


def _records_table(recs: list[Any]) -> dict[str, Any] | None:
    """Rows of records as a card output's cells: the columns their keys, each row named by the first column of distinct
    text, else by its position from 0 (as a chart's rows are named). The records themselves are the output's table
    (`tables`), which a count of the card's rows counts (check_count); past RECORDS_MAX the card keeps only part of it."""
    every = [r for r in recs if isinstance(r, dict)]
    recs = every[:RECORDS_MAX]
    if not recs:
        return None
    cols: list[str] = []
    for r in recs:
        cols.extend(str(k) for k in r if str(k) not in cols)
    key = next((k for k in cols if all(isinstance(r.get(k), str) and r[k].strip() for r in recs) and len({r[k] for r in recs}) == len(recs)), None)
    names = [str(r[key]) for r in recs] if key else [str(i) for i in range(len(recs))]
    table = {"columns": cols, "rows": [[r.get(k) for k in cols] for r in recs], "names": names, "label": key, "total": len(every)}
    return {"corner": key or "", "cells": [[k, nm, _card_text(r.get(k))] for r, nm in zip(recs, names) for k in cols if k != key],
            "tables": [table]}


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


LABEL_CARD = "label-"  # the id of a terminal label's card: this, then the name of its file (labels.py slug)
LABEL_ALL = "all"  # the row of a terminal label's version with every record it labeled (labels.py version_table)


def terminal_label_cards(folder: str | None) -> list[dict[str, Any]]:
    """The terminal's labels (labels.py: <labels>/<name>.json) as cards that keep their versions, `card:label-<name>`:
    each version of its counts the label kept (`versions`: the table of what `thimble label NAME` counts, with when it
    was made and what made it), so a citation of a label's counts is checked against the label as it was when the cited
    words were written (check_card). A version's table is also its rows as data (`tables`), which a count of the label's
    values counts (check_count), and its row LABEL_ALL totals the values (`totals`). A label that kept no versions, as
    one made before thimble kept them, gives none."""
    out: list[dict[str, Any]] = []
    if not folder or not os.path.isdir(folder):
        return out
    for name in sorted(os.listdir(folder)):
        stem = name[:-5] if name.endswith(".json") else ""
        if not re.fullmatch(r"[A-Za-z0-9_-]+", stem):
            continue
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                lab = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(lab, dict) or not lab.get("name") or not isinstance(lab.get("versions"), list):
            continue
        kept = []
        for v in lab["versions"]:
            try:
                cells = [[str(col), str(row[0]), str(row[1][j])] for row in v["rows"] for j, col in enumerate(v["cols"])]
                # the same rows as data, the counts as the version writes them
                names = [str(row[0]) for row in v["rows"]]
                rows = [[str(row[0]), *(str(row[1][j]) for j in range(len(v["cols"])))] for row in v["rows"]]
                table = {"columns": ["value", *(str(c) for c in v["cols"])], "rows": rows, "names": names, "label": "value",
                         "total": len(rows)}
                kept.append({"version": int(v["v"]), "from": float(v["at"]), "made": str(v.get("made") or ""), "cells": cells,
                             "table": table, "totals": names[-1:] == [LABEL_ALL] and names.count(LABEL_ALL) == 1})
            except (KeyError, TypeError, ValueError, IndexError):
                continue
        for i, v in enumerate(kept):
            out.append({"id": f"{LABEL_CARD}{stem}", "title": f"label {lab['name']}", "version": v["version"],
                        "from": v["from"], "made": v["made"], "after": kept[-1]["made"] if i + 1 < len(kept) else "",
                        "outputs": [{"out": 0, "corner": "value", "cells": v["cells"], "tables": [v["table"]],
                                     **({"totals": LABEL_ALL} if v["totals"] else {})}]})
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
            if m and int(m.group(4)) <= int(m.group(5)) <= int(m.group(4)) + MAX_RANGE:
                head = f"card:{m.group(1)}" + (f"@v{m.group(2)}" if m.group(2) else "")
                lines = [f"{head}@out{m.group(3)}#L{n}" for n in range(int(m.group(4)), int(m.group(5)) + 1)]
                out += [line for line in lines if line not in out]
            elif ref and ref not in out:
                out.append(ref)
    return out


def _card_place(ref: str, cards: list[dict[str, Any]] | None, at: float | None = None) -> tuple[str, dict[str, Any] | None]:
    """One place of a card: why it is no place of the session's cards, or what it is: {cid, title, ref, value, text,
    where, out}, with the cell's grid (`cols`, `rows`, `r`, `c`, `corner`) or the output's numbered `lines` and `i`. A
    card that keeps its versions is read as it was when the cited words were written, `at` (_card_entry): the place
    carries the version it names (`version`), when that version was shown (`span`), what made it and what changed
    after it (`made`, `after`)."""
    td, ln = CARD_TD.match(ref), CARD_LINE.match(ref)
    if not td and not ln:
        return "the check named no value or line of a card", None
    cid, v = (td or ln).group(1), (td or ln).group(2)
    why, card = _card_entry(cid, int(v) if v else None, cards, at)
    if card is None:
        return why, None
    title = str(card.get("title") or "")
    head = f"card:{cid}" + (f"@v{int(v)}" if v else "")
    kept: dict[str, Any] = {}
    if card.get("span"):
        kept = {"version": _version_of(card), "span": card["span"], "made": norm_ws(card.get("made") or ""),
                "after": norm_ws(card.get("after") or "")}
    if td:
        col, row = decode_label(td.group(3)), decode_label(td.group(4))
        for i, o in enumerate(card.get("outputs") or []):
            cols, rows, where = _grid(o)
            if (col, row) not in where:
                continue
            r, c = where[(col, row)]
            value = rows[r]["values"][c]
            return "", {"cid": cid, "title": title, "ref": f"{head}#{encode_label(col)}/{encode_label(row)}", "value": value,
                        "text": f"{row} {value}", "where": f"the card's {col} for {row}", "out": ("cells", i), "col": col, "row": row,
                        "cols": cols, "rows": rows, "r": r, "c": c, "corner": str(o.get("corner") or ""), "totals": o.get("totals"),
                        **kept}
        return f"the card has no {col} for {row}", None
    out_i, n = int(ln.group(3)), int(ln.group(4))
    o = next((x for x in card.get("outputs") or [] if int(x.get("out") or 0) == out_i and x.get("lines")), None)
    lines = [(int(k), str(t)) for k, t in (o or {}).get("lines") or []]
    i = next((j for j, (k, _) in enumerate(lines) if k == n), None)
    if i is None:
        return f"the card's output has no line {n}", None
    line = lines[i][1]
    return "", {"cid": cid, "title": title, "ref": f"{head}@out{out_i}#L{n}", "value": line, "text": line,
                "where": f"line {n} of the card's output", "out": ("lines", out_i), "n": n, "lines": lines, "i": i, **kept}


def _apart(places: list[dict[str, Any]]) -> str:
    """Why the places one citation cites never showed their values at one time, or '': each version of a card that
    keeps its versions showed its values from its making until the next version's (`span`), and a card given only as it
    is now shows them now. So the places of one version stand together; those of several versions stand together only
    when the versions were shown at one time, and beside a card as it is now only when they are still shown now. Words
    that join a trial's count and a later run's total, true of no version, are no claim of the data."""
    spans = {(p["cid"], p.get("version")): p["span"] for p in places if p.get("span")}
    if not spans:
        return ""
    ends = [b for _, b in spans.values() if b is not None]
    lo, hi = max(a for a, _ in spans.values()), min(ends) if ends else None
    if len(spans) > 1 and hi is not None and lo >= hi:
        if len({cid for cid, _ in spans}) == 1:
            return f"the check cited places of {len(spans)} versions of the card, and no version shows them together"
        return "the cited cards never showed these values at one time"
    if hi is not None and any(not p.get("span") for p in places):
        return "the check cited a version of a card that changed after it, beside a card as it is now"
    return ""


def _card_shown(target: str, ps: list[dict[str, Any]]) -> dict[str, Any]:
    """The evidence to show of the places of one card output: a cell's table with each cited cell marked, or the
    output's lines with what shows the words highlighted on each cited line, else the whole line (as a table when the
    output is one). A version of a card that keeps its versions says which one it is, when it was made and what changed
    after it (`version`, `at`, `made`, `after`)."""
    p = ps[0]
    shown: dict[str, Any] = {"kind": "card", "card": p["cid"], "title": p["title"], "ref": p["ref"], "value": p["value"]}
    if p.get("span"):
        shown.update(version=p["version"], at=p["span"][0], **{k: p[k] for k in ("made", "after") if p.get(k)})
    if len(ps) > 1:
        shown["refs"] = [x["ref"] for x in ps]
    if p["out"][0] == "cells":
        shown["table"] = table_of(p["corner"], p["cols"], p["rows"], p["r"], p["c"], [(x["r"], x["c"]) for x in ps[1:]])
        return shown
    lines = p["lines"]
    text = "\n".join(t for _, t in lines)
    spans: list[list[int]] = []
    for x in ps:
        start = sum(len(t) + 1 for _, t in lines[:x["i"]])
        line = lines[x["i"]][1]
        # each cited line highlights what of the words it shows (one value of a range on its own line), else all of it
        spans += [[start + a, start + b] for a, b in spans_of(target, line)] or [[start, start + len(line)]]
    shown["output"], shown["highlight"] = window(text, spans, OUTPUT_MAX)
    if table := text_table(text, spans):
        shown["table"] = table
    return shown


def several(places: list[dict[str, Any]]) -> str:
    """Several cited places of cards as a reason names them together, since what one of them reads is no reading of the
    others: `the 7 cited lines of the card's output`, `the 2 cited cells of the card`, `the 3 cited places of the cards`."""
    kinds = {p["out"][0] for p in places}
    noun = "lines" if kinds == {"lines"} else "cells" if kinds == {"cells"} else "places"
    whose = ("the card's output" if noun == "lines" and len({(p["cid"], p["out"]) for p in places}) == 1
             else "the card" if len({p["cid"] for p in places}) == 1 else "the cards")
    return f"the {len(places)} cited {noun} of {whose}"


def framed(target: str, places: list[dict[str, Any]], approx: bool = False) -> bool:
    """Cells show words that also name a number their column's name gives: "139 of the 176 PRs" cites the cell 139 of
    the column `of_176_still_open`. A cell's value must show a number of the words itself; its row's and its column's
    names, read as words, may show the rest, as a total or a unit."""
    cells = [p for p in places if p["out"][0] == "cells"]
    if not cells or len(cells) != len(places):
        return False
    values = wordnums("\n".join(p["value"] for p in cells), counts=True)
    nums = marked_numbers(wordnums(target, counts=True))
    if not any(has_number(v, values, dates=d, approx=approx) for v, d in nums):
        return False
    names = "\n".join(f"{p['text']} {re.sub(r'[_.]+', ' ', str(p['col']))}" for p in cells)
    return shows(target, names, approx)


# "N of the M" and "N out of M" in words whose number words are digits (wordnums); a sign or a range's dash before N
# makes it no count
COUNT_OF = re.compile(r"(?<![\w.,\-−])(\d+(?:,\d{3})*)(?![.,]?\d)\s+(?:out\s+)?of\s+(?:all\s+)?(?:the\s+|these\s+|those\s+)?(\d+(?:,\d{3})*)(?![.,]?\d)", re.I)


def count_pair(words: str) -> tuple[str, str] | None:
    """The N and M of words that say "N of the M" or "N out of M" ("three of the nine" too), each in one form."""
    m = COUNT_OF.search(wordnums(unmark(words)))
    return (num_value(m.group(1)), num_value(m.group(2))) if m else None


def count_numbers(words: str) -> set[str]:
    """The numbers of the words that count things whole: the N and M of "N of the M", and "all 5", "each of the 3",
    "none of the 9". A count is a whole number of things, so a value with places never shows it by rounding: an average
    of 4.6 nights is no "all 5 nights" (same_number `exact`)."""
    w = wordnums(unmark(words))
    out = {num_value(x) for m in COUNT_OF.finditer(w) for x in m.groups()}
    return out | {num_value(m.group(1)) for rx in (ALL_OF, NONE_OF) for m in rx.finditer(w)}


def one_count(target: str, places: list[dict[str, Any]], approx: bool = False) -> str:
    """Why places that show the numbers of words saying "N of the M" do not show them as one count, or "". N and M
    stand in one row of a card (one line of its output, or the cells of one row, whose column names may give the M:
    `of_40_still_open`), or N in a value's row of a label card's counts and M in the row that totals them, of one
    version of it. Places never count themselves, and two rows' values are no count: the 4 of one service's nights and
    the 9 of a title line, or red's 3 negatives and the 12 runs of all teams."""
    pair = count_pair(target)
    if not pair or len(places) < 2:
        return ""
    big, total = pair
    rows: dict[tuple[str, Any, Any, Any], list[dict[str, Any]]] = {}
    for p in places:
        rows.setdefault((p["cid"], p.get("version"), p["out"], p.get("row") if p["out"][0] == "cells" else p.get("n")), []).append(p)
    if len(rows) < 2:
        return ""
    for ps in rows.values():
        text = wordnums("\n".join(f"{p['text']} {re.sub(r'[_.]+', ' ', str(p.get('col') or ''))}" for p in ps), counts=True)
        if has_number(big, text, approx=approx) and has_number(total, text, approx=approx):
            return ""
    for p in places:
        totals = p.get("totals")
        if p["out"][0] != "cells" or not totals or p.get("row") == totals or not has_number(big, p["value"], approx=approx):
            continue
        if any(q["cid"] == p["cid"] and q.get("version") == p.get("version") and q["out"] == p["out"] and q.get("row") == totals
               and q.get("col") == p.get("col")
               and has_number(total, q["value"], approx=approx) for q in places):
            return ""
    return f"the cited places show {big} and {total} in different rows, not {big} out of {total}"


def check_card(target: str, ev: Any, cards: list[dict[str, Any]] | None, approx: bool = False, was: str = "", sentence: str = "",
               at: float | None = None) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of card evidence, and the evidence to show: each cited place must be one of the session's cards,
    and together they show the words (a cell's value, with its row's name; a line of printed output). Words that hold
    several values (a range, a pair) may cite a place for each: each value must stand in one of them. Places never count
    themselves (one_count): a count of a card's rows names the table and its condition, and is counted from the card's
    rows (check_count). A card that keeps its versions is read as it was when the words were written (`at`,
    _card_entry), and the cited places must have shown their values at one time (_apart)."""
    own = [e for e in (ev if isinstance(ev, list) else [ev]) if isinstance(e, dict) and "count" in e]
    if own:
        if len(own) > 1 or (isinstance(ev, list) and len(ev) > 1):
            return ["the check named more than one table for one count"], None
        return check_count(target, own[0], cards, sentence, approx, was, at)
    refs = card_refs(ev)
    if not refs:
        return ["the check named no value or line of a card"], None
    places: list[dict[str, Any]] = []
    for ref in refs:
        why, p = _card_place(ref, cards, at)
        if p is None:
            return [why], None
        places.append(p)
    groups: dict[tuple[str, Any, Any], list[dict[str, Any]]] = {}
    for p in places:
        groups.setdefault((p["cid"], p.get("version"), p["out"]), []).append(p)
    shown_all = [_card_shown(target, g) for g in groups.values()]
    shown = {**shown_all[0], **({"more": shown_all[1:]} if len(shown_all) > 1 else {})}
    if apart := _apart(places):
        return [apart], shown
    values, texts = [p["value"] for p in places], [p["text"] for p in places]
    said = "\n".join(texts)
    one = places[0]
    if not (shows(target, "\n".join(values), approx) or shows(target, said, approx) or framed(target, places, approx)):
        if len(places) > 1:
            # several places: what none of them shows, never one place's words under another's name
            return [f"none of {several(places)} shows {unshown(target, said, approx)}"], shown
        if one["out"][0] == "cells":
            return [f"{one['where']} shows {short(one['value'], 40) or 'nothing'}, not {unshown(target, one['text'], approx)}"], shown
        return [instead(one["where"], target, texts, approx)], shown
    apart = one_count(target, places, approx)
    if apart:
        return [apart], shown
    missing = unshown_change(was, target, said, approx) if was else []
    if missing:
        gone = f"“{short(' … '.join(missing), 60)}”"
        return [f"none of {several(places)} shows {gone}" if len(places) > 1 else f"{one['where']} does not show {gone}"], shown
    return [], shown


# ------------------------------------------------------------------------------------------------ a count of a card's rows
#
# "3 of the 9 services failed on all 5 nights", where no one place of the card shows the 3: the check names the table
# and the condition each counted row meets, `{"ref": "card:<id>@out<i>", "count": {"nights_failed": 5}}` (and `of`
# for the rows "of the M" counts, when not all), and this module counts the rows. It reads the card's own rows, the
# records the host gives with an output (`tables`: [{columns, rows, names, label, total, lines?}]), never printed
# text: a value compares as the value it is (4.6 is no 5, 0.6 no 100%). The words must state the count (or a bound it
# meets: "at least 3 of the 9"), and "of the M" the rows of the table (or of `of`), and every other number of the
# words is a value of the condition. The sentence states each value of the condition apart from the count's own
# numbers, a bound by its words ("at least 1" for `>=`), a yes of a column by the column's words, so the check cannot
# count by a condition the claim does not make; a condition every row meets picks no row out, so the sentence names
# its column too. A table the card keeps only part of, or one where one thing may stand in two rows (two rows of one
# name, or the same in every column), gives no count; a row that sums up the others is left out of it.

COUNT_OPS = {"=": operator.eq, "<": operator.lt, "<=": operator.le, ">": operator.gt, ">=": operator.ge}
OP_WORDS = {"=": "", "<": "under ", "<=": "at most ", ">": "over ", ">=": "at least "}
# the words before a number that state a bound (each `>=` and `<=` before the `>` and `<` it holds), and after it, a
# unit between them ("4 nights or more")
BOUND_WORDS = ((re.compile(r"(?:\bat\s+least|≥|>=)\s*$", re.I), ">="), (re.compile(r"(?:\bat\s+most|\bup\s+to|\bwithin|≤|<=)\s*$", re.I), "<="),
               (re.compile(r"(?:\bmore\s+than|\bover|\babove|>)\s*$", re.I), ">"), (re.compile(r"(?:\bless\s+than|\bfewer\s+than|\bunder|\bbelow|<)\s*$", re.I), "<"))
BOUND_AFTER_WORDS = ((re.compile(r"\s*(?:%|percent\b)?\s*(?:[A-Za-z]+\s+)?(?:or\s+more\b|\+)", re.I), ">="),
                     (re.compile(r"\s*(?:%|percent\b)?\s*(?:[A-Za-z]+\s+)?or\s+(?:less|fewer)\b", re.I), "<="))
ALL_OF = re.compile(r"\b(?:all|each|every\s+one)\s+(?:of\s+)?(?:the\s+|these\s+|those\s+)?(\d+(?:,\d{3})*)(?![.,]?\d)", re.I)
NONE_OF = re.compile(r"\bnone\s+of\s+(?:the\s+|these\s+|those\s+)?(\d+(?:,\d{3})*)(?![.,]?\d)", re.I)
# a card's output, the table a count names: `card:<id>@out<i>`, and of one version of a card that keeps its versions
# `card:<id>@v<n>@out<i>` (group 2), as CARD_TD writes a version
CARD_OUT = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)(?:@v(\d{1,9}))?@out(\d+)$")
FLOAT_NOISE = Decimal("1e-9")  # the share of a value a float sum or mean may be off by (_sums_up)
SUMMARY_NAMES = frozenset({"all", "total", "totals", "sum", "mean", "average", "avg", "overall"})  # rows that sum up (_sums_up)
YES, NO = frozenset({"yes", "true"}), frozenset({"no", "false"})
# words of a column's name that name no thing a sentence must say (_says_column)
NAME_WORDS = frozenset({"num", "count", "counts", "number", "total", "value", "values", "per", "the", "and"})


def _decimal(v: Any) -> Decimal | None:
    """A value as the number it is, or None: a number, or text that is only a number (`1,234`, `−3.5`); a boolean is
    no number."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return Decimal(str(v)) if not (isinstance(v, float) and not math.isfinite(v)) else None
    s = str(v).strip().replace("−", "-")
    if not re.fullmatch(r"[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?", s):
        return None
    return Decimal(s.replace(",", ""))


def _truth(v: Any) -> bool | None:
    """A value as yes or no: a boolean, or the words yes, no, true, false; None for anything else."""
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower() if isinstance(v, str) else ""
    return True if s in YES else False if s in NO else None


def _meets(have: Any, op: str, want: Any) -> bool:
    """A row's value meets one part of a condition: equal as numbers (5 and 5.0; 4.6 is no 5), as yes or no, else as
    text, the case aside; a bound compares numbers only."""
    a, b = _decimal(have), _decimal(want)
    if op != "=":
        return a is not None and b is not None and COUNT_OPS[op](a, b)
    if a is not None and b is not None:
        return a == b
    ta, tb = _truth(have), _truth(want)
    if ta is not None or tb is not None:
        return ta is not None and ta == tb
    return have is not None and norm_ws(str(have)).casefold() == norm_ws(str(want)).casefold()


def _conditions(spec: Any) -> tuple[str, list[tuple[str, str, Any]] | None]:
    """A count's condition as (column, operator, value) parts, all of which a counted row meets: `{"nights_failed": 5}`,
    `{"share": {">=": 0.5}}`; `{}` for every row. (why it cannot be read, None) for any other form."""
    if not isinstance(spec, dict):
        return "the check gave the count's condition in a form thimble cannot read", None
    out: list[tuple[str, str, Any]] = []
    for col, want in spec.items():
        op = "="
        if isinstance(want, dict):
            if len(want) != 1 or next(iter(want)) not in COUNT_OPS:
                return "the check gave the count's condition in a form thimble cannot read", None
            op, want = next(iter(want.items()))
        if want is None or isinstance(want, (list, dict)) or (op != "=" and _decimal(want) is None):
            return "the check gave the count's condition in a form thimble cannot read", None
        out.append((str(col), op, want))
    return "", out


def _condition_words(parts: list[tuple[str, str, Any]]) -> str:
    """A condition as a reason names it: `nights_failed 5`, `negative at least 1 and team platform`."""
    return " and ".join(f"{col} {OP_WORDS[op]}{_card_text(v)}" for col, op, v in parts)


def _rows(n: int) -> str:
    return f"{n:,} row" + ("" if n == 1 else "s")


def _same_word(a: str, b: str) -> bool:
    """Two words are one word of a name: the same, one the other with a plural s, or one the other's start of four
    letters or more, a few letters short of it (fail and failed, night and nightly)."""
    if a == b or b in (a + "s", a + "es") or a in (b + "s", b + "es"):
        return True
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 4 and long_.startswith(short) and len(long_) - len(short) <= 3


def _says_column(col: str, text: str) -> bool:
    """The text names a column of a card's table: each word of the column's name of three letters or more (`nights`
    and `run` of `nights_run`; words such as `count` or `num` that name no thing aside) stands in it as a word."""
    words = [w for w in re.split(r"[^a-z0-9]+", col.lower()) if len(w) > 2 and w not in NAME_WORDS]
    said = re.findall(r"[a-z0-9]+", text.lower())
    return bool(words) and all(any(_same_word(w, t) for t in said) for w in words)


def _stated(col: str, op: str, want: Any, text: str) -> bool:
    """The text states one part of a count's condition: its number with the words of its bound before or after it
    (none for `=`; a percent may state a share, 100% the 1 of a share column), a day as the same day, text as the same
    words, the case aside, and a yes as every word of the column's name. A no states nothing: a count of the rows a
    condition leaves out needs its own words."""
    num = _decimal(want)
    if num is not None:
        for m in NUM.finditer(text):
            v = number_at(m)
            if v is None or names_record(text, m) or any(a <= m.start(1) < b for a, b in date_spans(text)):
                continue
            try:
                got = Decimal(v)
            except InvalidOperation:
                continue
            after = text[m.end():]
            pct = re.match(r"\s*(?:%|percent\b)", after) is not None
            if got != num and not (pct and got / 100 == num):
                continue
            bound = next((o for rx, o in BOUND_WORDS if rx.search(text[:m.start()])), None) or next((o for rx, o in BOUND_AFTER_WORDS if rx.match(after)), "=")
            if bound == op:
                return True
        return False
    truth = _truth(want)
    if truth is not None:
        return truth and _says_column(col, text)
    s = norm_ws(str(want))
    if calendar_days(s):
        return days_shown(s, text)
    return bool(s) and re.search(r"(?<!\w)" + re.escape(one_quote(s)) + r"(?!\w)", one_quote(text), re.I) is not None


def _count_table(ref: str, cards: list[dict[str, Any]] | None, at: float | None = None) -> tuple[str, tuple[dict[str, Any], dict[str, Any], dict[str, Any], int | None, str] | None]:
    """The table a count's place names: (why none, None), or (the card, its output, the table, the line the place names
    or None, the card as the place writes it: `card:<id>`, or `card:<id>@v<n>` for a version). An output
    (`card:<id>@out<i>`) names its one table; a cell names its output's; a line or a range of lines names the printed
    table it stands in. A card that keeps its versions is read as its places are (_card_entry): as it was when the
    words were written (`at`), or the version `@v<n>` names, made by then; a version made later is no table of them."""
    ref = str(ref or "").strip().strip("[]")
    td, ln, lns, whole = CARD_TD.match(ref), CARD_LINE.match(ref), CARD_LINES.match(ref), CARD_OUT.match(ref)
    m = td or ln or lns or whole
    if not m:
        return "the check named no table of a card", None
    cid, v = m.group(1), m.group(2)
    why, card = _card_entry(cid, int(v) if v else None, cards, at)
    if card is None:
        return why, None
    head = f"card:{cid}" + (f"@v{int(v)}" if v else "")
    outs = [o for o in card.get("outputs") or [] if isinstance(o, dict)]
    if td:
        col, row = decode_label(td.group(3)), decode_label(td.group(4))
        o = next((x for x in outs if (col, row) in _grid(x)[2]), None)
        if o is None:
            return f"the card has no {col} for {row}", None
        line = last = None
    else:
        out_i = int(m.group(3))
        o = next((x for x in outs if int(x.get("out") or 0) == out_i), None)
        if o is None:
            return f"the card has no output {out_i}", None
        line = int(m.group(4)) if not whole else None
        last = int(m.group(5)) if lns else line
    tables = [t for t in o.get("tables") or [] if isinstance(t, dict)]
    if line is not None:
        tables = [t for t in tables if isinstance(t.get("lines"), list) and len(t["lines"]) == 2
                  and int(t["lines"][0]) <= line and (last or line) <= int(t["lines"][1])]
    if not tables:
        if o.get("cells"):
            return "the card keeps that table only as the text it shows, so its rows cannot be counted", None
        where = f"line {line} of the card's output" if line is not None else "the card's output"
        return f"{where} is printed text, not rows the card keeps as data, so its rows cannot be counted", None
    if len(tables) > 1:
        return f"the card's output holds {len(tables)} tables, and the check did not name the lines of one", None
    return "", (card, o, tables[0], line, head)


def _twice(t: dict[str, Any]) -> str:
    """Why one thing may stand in two rows of the table, or "": two rows share a name, when a column names the rows, or
    when nothing names them but their places, the first column of text in every row repeats in a tenth of its rows at
    most (a service twice among 9: a column of names with one written twice); or two rows have the same value in every
    column."""
    names = [str(x) for x in t.get("names") or []]
    if t.get("label"):
        seen_at = Counter(names)
        twice = next((x for x in names if seen_at[x] > 1), None)
        return f"two rows of the card's table are named {twice}" if twice is not None else ""
    rows = t.get("rows") or []
    # rows the host names by their place alone (a diagram's edges are named by both their ends, a timeline's events by
    # their times)
    unnamed = names == [str(i) for i in range(len(rows))]
    for j in range(len(t.get("columns") or []) if unnamed else 0):
        col = [r[j] if j < len(r) else None for r in rows]
        if col and all(isinstance(x, str) and x.strip() for x in col):
            seen_at = Counter(col)
            twice = next((x for x in col if seen_at[x] > 1), None)
            if twice is not None and len(col) - len(seen_at) <= max(1, len(col) // 10):
                return f"two rows of the card's table are named {twice}"
            break
    keys = Counter(json.dumps(r, sort_keys=True, default=str) for r in rows)
    return "two rows of the card's table have the same value in every column" if any(n > 1 for n in keys.values()) else ""


def _sums_up(t: dict[str, Any], cols: list[str]) -> int | None:
    """The row that sums up the others, or None, in a table of three rows or more with a column of numbers:
    in every such column its value is the others' sum or their mean (as pandas' margins, `All`, and a `mean` row are),
    as the row rounds it (2.8 for 2.78) and a float's error left aside (FLOAT_NOISE). One column's value matches a sum
    or a mean by chance (3 of 1, 2, 3), so it takes two columns whose other values differ, or a row whose name says it
    sums up (SUMMARY_NAMES). Such a row is no record of the things the table counts: a count leaves it out."""
    rows = t.get("rows") or []
    if len(rows) < 3:
        return None
    label = t.get("label")
    values: dict[int, list[Decimal]] = {}
    for j in range(len(cols)):
        col = [_decimal(r[j] if j < len(r) else None) for r in rows] if cols[j] != label else []
        if col and all(v is not None for v in col):
            values[j] = col  # type: ignore[assignment]
    if not values:
        return None
    # each column's sum and how often each value stands in it, so a row's "others" are the column less the row
    sums = {j: sum(col, Decimal(0)) for j, col in values.items()}
    seen = {j: Counter(col) for j, col in values.items()}
    names = t.get("names") or [str(i) for i in range(len(rows))]
    near = lambda a, b: abs(a - b) <= FLOAT_NOISE * max(Decimal(1), abs(b))  # noqa: E731
    for i in range(len(rows)):
        name = str(names[i]) if i < len(names) else str(i)
        ok, differ = True, 0
        for j, col in values.items():
            v = col[i]
            total = sums[j] - v
            mean = total / (len(rows) - 1)
            places = -v.as_tuple().exponent if isinstance(v.as_tuple().exponent, int) and v != v.to_integral_value() else 0
            ok = v == total or v == mean or near(v, total) or near(v, mean) or (places > 0 and mean.quantize(Decimal(1).scaleb(-places)) == v)
            differ += len(seen[j]) - (1 if seen[j][v] == 1 else 0) > 1
            if not ok:
                break
        if ok and (differ > 1 or (differ and name.strip().casefold() in SUMMARY_NAMES)):
            return i
    return None


def _count_shown(card: dict[str, Any], o: dict[str, Any], t: dict[str, Any], counted: list[int], col: str | None, line: int | None,
                 head: str = "") -> dict[str, Any]:
    """The evidence a count shows: the card's table with each counted row's cell of the condition's column cited (the
    first column for a count of every row), its places written from `head` as the count's place wrote the card
    (`card:<id>`, `card:<id>@v<n>`). A table the card's code printed shows from its records, with the cited line of the
    printed output beside it, which the browser checks the card against; a table of cells shows as the card shows its
    cells. A version of a card that keeps its versions says which one it is, when it was made and what changed after it,
    as _card_shown does."""
    cid, title = str(card.get("id") or ""), str(card.get("title") or "")
    head = head or f"card:{cid}"
    names = [str(x) for x in t.get("names") or []]
    shown: dict[str, Any] = {"kind": "card", "card": cid, "title": title}
    if card.get("span"):
        said = {k: norm_ws(card.get(k) or "") for k in ("made", "after")}
        shown.update(version=_version_of(card), at=card["span"][0], **{k: x for k, x in said.items() if x})
    if o.get("cells"):
        cols, rows, _ = _grid(o)
        at = {row["label"]: i for i, row in enumerate(rows)}
        rs = [at[names[i]] for i in counted if i < len(names) and names[i] in at]
        c = cols.index(col) if col in cols else 0
        if rs and cols:
            shown.update(ref=f"{head}#{encode_label(cols[c])}/{encode_label(rows[rs[0]]['label'])}", value=rows[rs[0]]["values"][c],
                         table=table_of(str(o.get("corner") or ""), cols, rows, rs[0], c, [(r, c) for r in rs[1:]]))
        return shown
    label = t.get("label")
    columns = [str(x) for x in t.get("columns") or []]
    keep = [j for j, x in enumerate(columns) if x != label]
    cols = [columns[j] for j in keep]
    rows = [{"label": names[i] if i < len(names) else str(i), "values": [_card_text(r[j] if j < len(r) else None) for j in keep]} for i, r in enumerate(t.get("rows") or [])]
    c = cols.index(col) if col in cols else 0
    lines = [(int(k), str(x)) for k, x in o.get("lines") or []]
    a, b = (int(t["lines"][0]), int(t["lines"][1])) if isinstance(t.get("lines"), list) else (lines[0][0] if lines else 1, lines[-1][0] if lines else 1)
    pick = next((k for k, (n, _) in enumerate(lines) if n == line and a <= n <= b), None)
    pick = pick if pick is not None else next((k for k, (n, _) in enumerate(lines) if a <= n <= b), None)
    if pick is not None:
        text = "\n".join(x for _, x in lines)
        start = sum(len(x) + 1 for _, x in lines[:pick])
        shown["ref"] = f"{head}@out{int(o.get('out') or 0)}#L{lines[pick][0]}"
        shown["value"] = lines[pick][1]
        shown["output"], shown["highlight"] = window(text, [[start, start + len(lines[pick][1])]], OUTPUT_MAX)
    if counted and cols:
        shown["table"] = table_of(str(label or ""), cols, rows, counted[0], c, [(r, c) for r in counted[1:]])
    return shown


def check_count(target: str, ev: dict[str, Any], cards: list[dict[str, Any]] | None, sentence: str = "", approx: bool = False, was: str = "",
                at: float | None = None) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of a count of a card's rows (the module note above), and the evidence to show: the table with the
    counted rows cited. `ev` is {ref, count, of?}; `sentence` the mark's sentence, its citations in brackets; `at` when
    the words were written, the time a card that keeps its versions is read at (_count_table), so one count reads the
    rows of one version: places of two versions name two tables."""
    got = ev.get("ref", ev.get("refs"))
    refs = [str(x).strip() for x in (got if isinstance(got, list) else [got]) if isinstance(x, str) and x.strip()]
    if not refs:
        return ["the check named no table of a card"], None
    found = []
    for ref in refs:
        why, place = _count_table(ref, cards, at)
        if place is None:
            return [why], None
        found.append(place)
    if len({id(p[2]) for p in found}) > 1:
        return ["the check named more than one table for one count"], None
    card, o, t, line, head = found[0]
    why, conds = _conditions(ev.get("count"))
    if conds is None:
        return [why], None
    why, of = _conditions(ev.get("of")) if ev.get("of") is not None else ("", [])
    if of is None:
        return [why], None
    cols = [str(x) for x in t.get("columns") or []]
    rows = [r if isinstance(r, list) else [] for r in t.get("rows") or []]
    total = int(t.get("total") or len(rows))
    for col, _, _ in of + conds:
        if col not in cols:
            return [f"the card's table has no column {col}"], None
    if total > len(rows):
        return [f"the card keeps {len(rows):,} of the table's {total:,} rows, so they cannot be counted"], None
    twice = _twice(t)
    if twice:
        return [f"{twice}, so its rows cannot be counted"], None
    # a row that sums up the others (pandas' margins, a mean row, the row a label card names as the total of its values,
    # `totals`) is no record of the things counted
    names = [str(x) for x in t.get("names") or []]
    totals = o.get("totals")
    summed = names.index(str(totals)) if totals and names.count(str(totals)) == 1 else _sums_up(t, cols)
    besides = "" if summed is None else f" besides the row {names[summed] if summed < len(names) else summed} that sums them up"
    j = {c: k for k, c in enumerate(cols)}
    value = lambda r, c: r[j[c]] if j[c] < len(r) else None  # noqa: E731
    pool = [i for i, r in enumerate(rows) if i != summed and all(_meets(value(r, c), op, v) for c, op, v in of)]
    counted = [i for i in pool if all(_meets(value(rows[i], c), op, v) for c, op, v in conds)]
    n, m = len(counted), len(pool)
    shown = _count_shown(card, o, t, counted, conds[0][0] if conds else None, line, head)
    has, among = (f" with {_condition_words(conds)}" if conds else ""), (f" with {_condition_words(of)}" if of else "")

    # the words: the count, "of the M", and every other number a value of the condition
    w = wordnums(unmark(target))
    nums = [(mt, v) for mt in NUM.finditer(w) if not names_record(w, mt) for v in [number_at(mt)] if v is not None]
    own: list[tuple[int, int]] = []

    def bound_of(span: tuple[int, int]) -> str | None:
        """The bound the words put the count under ("more than 3 of the 9": `>`), "~" for words that make it no count
        ("almost 3", "all but 3"), None for an exact count."""
        before, after = w[:span[0]], w[span[1]:]
        if re.search(r"\b(?:all\s+but|nearly|almost|close\s+to)\s*$", before, re.I):
            return "~"
        return next((op for rx, op in BOUND_WORDS if rx.search(before)), None) or next((op for rx, op in BOUND_AFTER_WORDS if rx.match(after)), None)

    def meets(v: str, span: tuple[int, int]) -> bool:
        if w[max(0, span[0] - 1):span[0]] in ("-", "−"):
            return False  # a count has no sign
        op = bound_of(span)
        if op is None:
            return same_number(v, str(n), approx)
        try:
            return op != "~" and COUNT_OPS[op](Decimal(n), Decimal(v))
        except InvalidOperation:
            return False

    pair = COUNT_OF.search(w)
    none = NONE_OF.search(w)
    if pair or none:
        big, whole_m = (pair.group(1), pair.group(2)) if pair else ("0", none.group(1))
        span = pair.span(1) if pair else none.span(0)
        if not meets(num_value(big), span):
            op = bound_of(span)
            if op == "~":
                return [f"the card's table has {_rows(n)}{has}{among}, and the words give no exact number of them"], shown
            return [f"the card's table has {_rows(n)}{has}{among}, not {OP_WORDS.get(op or '=', '')}{num_value(big)}"], shown
        if not same_number(num_value(whole_m), str(m), approx):
            return [f"the card's table has {_rows(m)}{among}{besides}, not {num_value(whole_m)}"], shown
        own += [pair.span(1), pair.span(2)] if pair else [none.span(1)]
    else:
        first = next((mt for mt, v in nums if meets(v, mt.span(1)) and not any(a <= mt.start(1) < b for a, b in date_spans(w))), None)
        if first is None:
            return [f"the card's table has {_rows(n)}{has}{among}, which the words do not state"], shown
        own.append(first.span(1))
    for mt in ALL_OF.finditer(w):
        if mt.span(1) in own and n != m:
            return [f"the card's table has {_rows(m)}{among}{besides}, not {num_value(mt.group(1))}"], shown
    if of and n == m:
        # rows picked by `of` that are all the counted rows count the rows against themselves: "3 of the 3 services
        # failed every night" with `of` the services that failed every night
        return [f"the check counts {n:,} of the {m:,} rows{among}, which are the same rows"], shown
    if n == 0:
        return [f"no row of the card's table has {_condition_words(conds) or 'a value'}{among}, so the count shows no row"], None
    # the condition's values: stated by the sentence apart from the count's own numbers. The sentence holds the cited
    # words in brackets (a rewrite's its new words; a correction's sentence the marked ones, which the new words replace)
    masked = "".join("#" if any(a <= k < b for a, b in own) else ch for k, ch in enumerate(w))
    said = wordnums(unmark(sentence or ""))
    text = masked
    for cited in [f"[{w}]"] + ([f"[{wordnums(unmark(was))}]"] if was else []):
        i = said.find(cited)
        if i >= 0:
            text = f"{said[:i]}[{masked}]{said[i + len(cited):]}"
            break
    for col, op, v in of + conds:
        if not _stated(col, op, v, text):
            return [f"the check counts the rows with {_condition_words([(col, op, v)])}, which the sentence does not say"], shown
    if conds and n == m:
        # a condition every row meets picks no row out, so only what its column means makes the count: "all 9 services
        # failed on all 5 nights" by nights_run 5, which every service has. The sentence names that column
        for col, op, v in conds:
            if not _says_column(col, text):
                return [f"every row of the card's table has {_condition_words([(col, op, v)])}, and the sentence does not name {col}"], shown
    values = [_decimal(v) for _, op, v in of + conds if _decimal(v) is not None]
    texts = [str(v) for _, _, v in of + conds if isinstance(v, str)]
    for mt, v in nums:
        if mt.span(1) in own:
            continue
        try:
            d = Decimal(v)
        except InvalidOperation:
            d = None
        pct = re.match(r"\s*(?:%|percent\b)", w[mt.end():]) is not None
        in_date = any(a <= mt.start(1) < b for a, b in date_spans(w))
        if (d is not None and any(d == x or (pct and d / 100 == x) for x in values)) or (in_date and any(has_number(v, x) for x in texts)):
            continue
        return [f"the words' {number_named(w, v, in_date)} is neither the count nor a value of its condition"], shown
    if calendar_days(w) and not any(days_shown(w, x) for x in texts):
        return [f"the check counts the rows with {_condition_words(of + conds) or 'no condition'}, which does not give the day the words name"], shown
    if was:
        missing = unshown_change(was, target, f"{n} of {m}\n" + "\n".join(_card_text(v) for _, _, v in of + conds), approx)
        if missing:
            return [f"the count does not show “{short(' … '.join(missing), 60)}”"], shown
    shown["count"] = f"{n:,} of {_rows(m)}{has}{among}{besides}"
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


def check_evidence(target: str, kind: Any, ev: Any, calls: list[dict[str, Any]], cwd: str, root: str | None, approx: bool = False, tmp: str | list[str] | None = None, was: str = "", cards: list[dict[str, Any]] | None = None, rules: str | None = None, at: float | None = None, sentence: str = "") -> tuple[list[str], dict[str, Any] | None]:
    """The problems of one mark's evidence for `target`, and the evidence to show. For a correction, `target` is its
    new words and `was` the marked words; `at` is when the words were written (check_card); `sentence` is the mark's
    sentence, which a count's condition stands in."""
    if kind == "card":
        return check_card(target, ev, cards, approx, was, sentence, at)
    if kind == "computed":
        return check_computed(target, ev.get("output") if isinstance(ev, dict) else None, calls, approx, was, root or cwd, cwd)
    if kind in ("quote", "code"):
        evs = [e for e in (ev if isinstance(ev, list) else [ev]) if isinstance(e, dict)]
        return check_quote(target, kind, evs, cwd, root, tmp, calls, was, rules) if evs else (["the check named no place in a file"], None)
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


def with_method(evidence: dict[str, Any], method: str) -> dict[str, Any]:
    """Computed evidence with the check's `method`: how its code got the value (what it counted or computed, in which
    records, by what rule), in the check's own words, which the person reads over the code. Other evidence shows no
    code, so it takes none. No value of it is evidence (evidence_text leaves it out)."""
    return {**evidence, "method": method} if method and evidence.get("kind") == "computed" else evidence


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


def check_mark(mark: dict[str, Any], item: dict[str, Any] | None, calls: list[dict[str, Any]], cwd: str, root: str | None = None, tmp: str | list[str] | None = None, cards: list[dict[str, Any]] | None = None, rules: str | None = None, at: float | None = None, fresh: bool = False) -> dict[str, Any]:
    """What the person sees of one mark: {n, status, shown, reason, failedBy?, evidence?, note?, was?, narrowed?,
    rewrite?, sources?}. `mark` is {n, words, sentence?}; `item` the checker's object for it (or None); `calls` the real
    Bash calls of the session ({command, output, by}); `tmp` and `rules` the folders a cited file may lie in besides the
    session's (check_quote). A mark verified or corrected keeps what its evidence rests on (`sources`, each a source()).
    `fresh`: a check of a citation whose source changed after its first check, whose computed evidence is only a call
    this check ran, since output printed before the change shows the files as they were.

    The checker's status is `verified`, `corrected`, `narrowed` (only a part of the words is cited: a correction whose
    `narrowed` result keeps the rest as the reply's own words), `wrong` (the data show the claim false) or
    `unconfirmed` (the check could not see what shows it true or false). This module checks the evidence of the words it shows: it never
    turns the checker's verdict that a claim is wrong into verified, so a correction whose evidence does not show the
    new words is not confirmed. A mark the checker judged wrong or unconfirmed keeps the evidence it gave, when that
    evidence is real, so the person sees what the check found. `failedBy` is `check` when the checker found the claim
    wrong, `evidence` when the claim is only not confirmed: the checker could not see it, or its evidence did not hold,
    `none` when the check gave no answer this module can judge (the plugin's marks/store.ts notRun).
    A `note` is what the checker found wrong in the sentence outside the mark's own claim. Computed evidence carries
    the checker's `method`, how its code got the value (with_method).

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
    if fresh and kind == "computed":
        calls = [c for c in calls if c.get("by") == "checker"]
    # the check's own reason says why when the check found the claim wrong or could not confirm it; when its evidence
    # does not hold, the reason is this module's (its reason then says why the claim held, which it did not)
    reason = check_reason(item.get("reason") or "", words)
    note = norm_ws(item.get("note") or "")
    extra = {"note": note} if note else {}
    method = norm_ws(item["method"]) if isinstance(item.get("method"), str) else ""
    approx = approximate(mark)
    corr = item.get("correction") if isinstance(item.get("correction"), dict) else None

    def judged(by: str, why: str) -> dict[str, Any]:
        """The checker's verdict that the claim is wrong (`check`) or not confirmed (`evidence`), with the evidence it
        gave when that evidence is real."""
        res = {**out, "status": "failed", "reason": why, "failedBy": by, **extra}
        if ev:
            _, evidence = check_evidence(unmark(words), kind, ev, calls, cwd, root, approx, tmp, cards=cards,
                                         rules=rules, at=at, sentence=str(mark.get("sentence") or ""))
            if evidence:
                evidence.pop(SOURCES, None)
            if evidence and (evidence.get("kind") != "computed" or evidence.get("output")):
                res["evidence"] = with_method(evidence, method)
        return res

    # the sentence as the check ends it: a correction, a narrowing or a rewrite
    rewrite: dict[str, Any] | None = None
    given = str(corr.get("sentence") or "") if corr else ""
    if given.strip() and status in ("verified", "corrected", "narrowed", "wrong"):
        got = sentence_rewrite(given, norm_ws(mark.get("sentence") or f"[{words}]"), words)
        if isinstance(got, str):
            # a rewording that cannot stand still leaves what the check found wrong, which the person reads in its
            # own reason (the records show it false); with no such reason, why the rewording could not stand
            found = reason if status in ("corrected", "wrong") else ""
            return judged("evidence", found or f"The check reworded the sentence, but {got}.")
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
    target = unmark(new or words)
    if not new and quoted_around(str(mark.get("sentence") or ""), words):
        # a quote whose marks stand around the citation (`"[I've been locked out]."`) is a direct quote too
        target = f'"{target}"'
    sentence_now = str(rewrite["sentence"] if rewrite else mark.get("sentence") or "")
    problems, evidence = check_evidence(target, kind, ev, calls, cwd, root, approx, tmp, unmark(words) if changed else "", cards, rules,
                                        at, sentence_now)
    rests = evidence.pop(SOURCES, None) if evidence else None
    res: dict[str, Any] = {"n": n, "status": status, "shown": new or written, "reason": reason, **extra}
    if evidence:
        res["evidence"] = with_method(evidence, method)
    did = "cited only a part of these words" if narrow else "reworded the sentence" if rewrite else "offered other words"
    if problems and new:
        # the check's verdict that the words are wrong rests on evidence that does not show its new words: neither the
        # old words nor the new ones are confirmed (a match of the old words there, such as the 250 of a test that
        # printed False, is no sign that they hold); a problem that opens with the check is said of it once
        why = re.sub(r"^the check ", "it ", problems[0])
        res.update(status="failed", shown=words, failedBy="evidence", reason=f"The check {did}, but {why}.")
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
    if rests:
        res["sources"] = rests
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


def check_all(marks: list[dict[str, Any]], answer: str, calls: list[dict[str, Any]], cwd: str, root: str | None = None, tmp: str | list[str] | None = None, cards: list[dict[str, Any]] | None = None, rules: str | None = None, at: float | None = None, fresh: bool = False) -> dict[str, Any]:
    """Every mark of a reply: {parsed, results}. `answer` is the checker's last message; `tmp` the session's temp
    folders (one, or a list); `cards` the session's cards' outputs (check_card); `rules` the folder where the host keeps
    its labels' rules, when it keeps them apart from the temp folders (the browser's labels' definitions); `at` when the
    marks' words were written (seconds since the epoch), the time a card that keeps its versions is read at (None: now);
    `fresh`, a check of citations whose source changed after their first check (check_mark).
    A mark the validator fails on fails as a check that did not run, with why; the other marks are judged."""
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
            results.append(check_mark(m, by_n.get(int(m["n"])), calls, cwd, root, tmp, cards, rules, at, fresh))
        except Exception as e:  # noqa: BLE001 — one mark's failure never takes the others' results with it
            said = error_words(str(e), cwd, root, also_of("code", tmp, rules))
            results.append({"n": m.get("n"), "status": "failed", "failedBy": "none", "shown": str(m.get("words", "")),
                            "reason": f"{NOT_RUN} thimble could not validate this citation ({type(e).__name__}: {said[:120]})."})
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
                r.pop("sources", None)
            for k in ("rewrite", "was", "narrowed"):
                r.pop(k, None)
            continue
        rewritten[key] = norm_ws(str(r["rewrite"]))
    return {"parsed": items is not None, "results": results}
