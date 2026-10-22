"""The ref grammar: one string names one row of a source, or a set of rows of one file. Cut from thimble 0.9.0's
backend/app/refs.py and extended with row sets. Labels key each record by its ref.

Source rows (paths are relative to the root folder):

    <path>                        the whole file
    <path>#L<n>                   line n (1-based) of a jsonl, text or code file; one record of a jsonl file
    <path>#L<n>-L<m>              lines n to m; `L<n>-<m>` reads the same
    <path>#/<pointer>             a value of a JSON document by its JSON pointer (RFC 6901)
    <path>#row=<n>                row n (1-based, after the header) of a csv or tsv file
    <db>#<table>/<rowid>          a row of a SQLite file (.db, .sqlite, .sqlite3)
    <db>#<table>                  a whole table
    <path>#<anything else>        the file, with the part after # kept as written (a heading, a cell range, a time):
                                  any locator a file's own type uses still cites the file

A row set names many rows of one file in one string: the numbers after the last unit are a list of numbers and ranges,
such as `revisions.jsonl#L4-9,12,40-41`, `runs.csv#row=1-30`, `forge.db#prs/1-12` or `run.json#/messages/3-17`.
"""
from __future__ import annotations

import re
from typing import Any

DB_SUFFIXES = (".db", ".sqlite", ".sqlite3")
_NUMS = r"\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*"
_FP = r"[^#\s](?:[^#\n]*[^#\s])?"  # a path may hold spaces inside it, never at its ends, never a `#`
_LINES = re.compile(r"^L(\d+)(?:-L?(\d+))?$")
_LINESET = re.compile(r"^L(" + _NUMS + r")$")
_CSVROW = re.compile(r"^row=(" + _NUMS + r")$")
_DBROW = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(?:/(.+))?$")
_POINTER_SET = re.compile(r"^(/(?:[^/]*/)*)(" + _NUMS + r")$")
_FP_RE = re.compile(_FP)


class RefError(ValueError):
    """A ref that does not parse, or names nothing."""


def parse_nums(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        if "-" in part:
            a, b = part.split("-", 1)
            lo, hi = int(a), int(b)
            if hi < lo:
                lo, hi = hi, lo
            out.extend(range(lo, hi + 1))
        elif part:
            out.append(int(part))
    return out


def format_nums(nums: list[int]) -> str:
    """Sorted unique numbers as ranges: [1, 2, 3, 7, 9, 10] -> '1-3,7,9-10'."""
    xs = sorted(set(nums))
    parts: list[str] = []
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[j + 1] == xs[j] + 1:
            j += 1
        parts.append(str(xs[i]) if i == j else f"{xs[i]}-{xs[j]}")
        i = j + 1
    return ",".join(parts)


def parse(ref: str) -> dict[str, Any]:
    """A ref as a dict with `kind`: file, lines, pointer, csvrows, dbrows, table.

    `lines`, `csvrows`, `dbrows` and a pointer set hold `nums`, the 1-based numbers (rowids for a database) they name."""
    ref = ref.strip()
    if not ref:
        raise RefError("an empty ref")
    path, hash_, frag = ref.partition("#")
    if not _FP_RE.fullmatch(path):
        raise RefError(f"not a ref: {ref!r}")
    if not hash_:
        return {"kind": "file", "path": path}
    if m := _LINES.match(frag):
        a = int(m[1])
        b = int(m[2]) if m[2] else a
        return {"kind": "lines", "path": path, "nums": list(range(min(a, b), max(a, b) + 1))}
    if m := _LINESET.match(frag):
        return {"kind": "lines", "path": path, "nums": parse_nums(m[1])}
    if (m := _CSVROW.match(frag)) and path.lower().endswith((".csv", ".tsv")):
        return {"kind": "csvrows", "path": path, "nums": parse_nums(m[1])}
    if frag.startswith("/") and path.lower().endswith((".json", ".ipynb")):
        if m := _POINTER_SET.match(frag):
            return {"kind": "pointer", "path": path, "prefix": m[1], "nums": parse_nums(m[2])}
        return {"kind": "pointer", "path": path, "pointer": frag}
    if path.lower().endswith(DB_SUFFIXES) and (m := _DBROW.match(frag)):
        if m[2] is None:
            return {"kind": "table", "path": path, "table": m[1]}
        if re.fullmatch(_NUMS, m[2]):
            return {"kind": "dbrows", "path": path, "table": m[1], "nums": parse_nums(m[2])}
        return {"kind": "dbrows", "path": path, "table": m[1], "keys": [m[2]]}
    if re.match(r"^L(\d|$)", frag):
        raise RefError(f"not a line ref: {ref!r} (lines are #L<n>, #L<n>-<m> or #L<n>,<m>-<k>)")
    return {"kind": "file", "path": path, "locator": frag}
