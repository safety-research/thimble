"""Where a query shows the values a citation's words state: the dates and numbers of the words, found in the query's
output table and in the text it printed.

A citation of a whole query (`[2 April 2025 to 18 September 2026](r4)`) may state values that only its printed text
holds (`print(df.created_at.min(), df.created_at.max())`). The card then shows the lines that hold them, and the check
reads them too: words whose dates the query shows nowhere are wrong, as a wrong number is.

A date in the words is read in the forms people write (`2 April 2025`, `April 2, 2025`, `Apr 2025`, `2025-04-02`). The
query shows it where its output holds the same day, or the same month when the words name only a month: `2025-04`
shows `April 2025`, but not `2 April 2025`.

  dates(text)            -> [(start, end, (year, month, day or None))], each date the text writes
  without_dates(label)   -> the words with their dates cut out, so a date's digits are not read as numbers
  find(q, label)         -> {dates, missing, rows, cols, lines, printed}: where the query `q` (its record) shows them
"""
from __future__ import annotations

import re
from typing import Any

from . import objects as O

_MONTHS = {"january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7, "august": 8,
           "september": 9, "october": 10, "november": 11, "december": 12, "jan": 1, "feb": 2, "mar": 3, "apr": 4,
           "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12}
_MON = r"(?P<{}>" + "|".join(sorted(_MONTHS, key=len, reverse=True)) + r")\.?"
_DAY = r"(?P<{}>\d{{1,2}})(?:st|nd|rd|th)?"
_YEAR = r"(?P<{}>(?:19|20)\d\d)"
_DATE_RE = re.compile(
    r"(?<![\w-])(?:"
    + _DAY.format("d1") + r"\s+" + _MON.format("m1") + r",?\s+" + _YEAR.format("y1")
    + r"|" + _MON.format("m2") + r"\s+" + _DAY.format("d2") + r",?\s+" + _YEAR.format("y2")
    + r"|" + _MON.format("m3") + r",?\s+" + _YEAR.format("y3")
    + r"|" + _YEAR.format("y4") + r"(?P<s>[-/])(?P<m4>\d{1,2})(?:(?P=s)(?P<d4>\d{1,2}))?"
    + r")(?![\d])", re.I)


def dates(text: str) -> list[tuple[int, int, tuple[int, int, int | None]]]:
    """Each date the text writes, with where it stands: (start, end, (year, month, day or None))."""
    out = []
    for m in _DATE_RE.finditer(str(text or "")):
        g = m.groupdict()
        n = next(i for i in "1234" if g.get(f"y{i}"))
        y = int(g[f"y{n}"])
        mo = _MONTHS[g[f"m{n}"].lower().rstrip(".")] if n != "4" else int(g["m4"])
        d = g.get(f"d{n}")
        d = int(d) if d else None
        if not 1 <= mo <= 12 or (d is not None and not 1 <= d <= 31):
            continue
        out.append((m.start(), m.end(), (y, mo, d)))
    return out


def without_dates(label: str) -> str:
    """The words with each date they write cut out, so `2 April 2025` states no number 2 or 2025."""
    s = str(label or "")
    for a, b, _ in reversed(dates(s)):
        s = s[:a] + " " + s[b:]
    return s


def _shows_date(want: tuple[int, int, int | None], got: tuple[int, int, int | None]) -> bool:
    return want[0] == got[0] and want[1] == got[1] and (want[2] is None or want[2] == got[2])


def _num_spans(text: str, words: str) -> list[tuple[int, int]]:
    """Where a line holds a number the words state (as written or rounded), its dates left out."""
    if not O.NUM_RE.search(O._tight(words)):
        return []
    taken = [(a, b) for a, b, _ in dates(text)]
    out = []
    for m in re.finditer(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?(?![\w])", text):
        if any(a < m.end() and m.start() < b for a, b in taken):
            continue
        try:
            v = float(m[0].replace(",", ""))
        except ValueError:
            continue
        if O.number_matches(words, int(v) if v.is_integer() else v):
            out.append((m.start(), m.end()))
    return out


def _spans(text: str, want: list[tuple[int, int, int | None]], words: str) -> list[tuple[int, int]]:
    """Where a text holds a cited date or number."""
    out = [(a, b) for a, b, d in dates(text) if any(_shows_date(w, d) for w in want)]
    out += _num_spans(text, words)
    return sorted(set(out))


def find(q: dict[str, Any], label: str, value: Any = None, key: list[str] | None = None) -> dict[str, Any]:
    """Where the query shows the values the words state. `dates`: the dates the words write, as written; `missing`:
    those the query shows nowhere; `rows` and `cols`: the output rows that hold a cited value and the column of the
    first; `lines`: the printed lines that hold one, each {n, text, at: [[start, end]]}; `printed`: the number of lines
    it printed. Numbers are looked for only when the words state some besides their dates. `value` and `key`: the cited
    cell and its row's key values, when the citation names one: its value is marked in the lines that show its row,
    whatever the words write."""
    words = " ".join(str(label or "").replace("**", "").split())
    want = dates(words)
    rest = without_dates(words)
    has_num = bool(O.NUM_RE.search(O._tight(rest)))
    table = [r for r in (q.get("table") or []) if isinstance(r, dict)]
    keys = set(q.get("keys") or [])
    rows: list[int] = []
    cols: list[str] = []
    seen: set[int] = set()

    def date_hits(text: str) -> set[int]:
        got = [d for _, _, d in dates(text)]
        return {j for j, (_, _, w) in enumerate(want) if any(_shows_date(w, d) for d in got)}

    for i, r in enumerate(table):
        for c, v in r.items():
            if str(c).startswith("_") or v is None or isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                hit = has_num and c not in keys and O.number_matches(rest, v)
            else:
                found = date_hits(str(v)) if want else set()
                seen |= found
                hit = bool(found)
            if hit and i not in rows:
                rows.append(i)
                cols.append(str(c))
    # the cited cell's value, in the lines that show its row (its key's values), else in any line
    cell = ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        cell = f"{value:g}" if isinstance(value, float) else str(value)
    lines = []
    text = str(q.get("stdout") or "")
    all_lines = text.split("\n")
    marks_cell = []
    for n, line in enumerate(all_lines, 1):
        seen |= date_hits(line) if want else set()
        at = _spans(line, [w for _, _, w in want], rest if has_num else "")
        if cell and (not key or all(str(k) in line for k in key)):
            marks_cell.append((n, line, _num_spans(line, cell)))
        if at:
            lines.append({"n": n, "text": line, "at": [list(x) for x in at]})
    if cell and not has_num:
        for n, line, at in marks_cell:
            if at and not any(x["n"] == n for x in lines):
                lines.append({"n": n, "text": line, "at": [list(x) for x in at]})
        lines.sort(key=lambda x: x["n"])
    return {"dates": [words[a:b] for a, b, _ in want], "missing": [words[a:b] for j, (a, b, _) in enumerate(want) if j not in seen],
            "rows": rows, "cols": cols, "lines": lines, "printed": len(all_lines) - (1 if text.endswith("\n") else 0)}
