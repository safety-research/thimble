"""The ref grammar: one string names one row of a source, a set of rows, a value a query computed, or a value an object
holds. Cut from thimble 0.9.0's backend/app/refs.py (the file forms) and extended with row sets, query refs and object
refs.

Source rows (paths are relative to the root folder):

    <path>                        the whole file
    <path>#L<n>                   line n (1-based) of a jsonl, text or code file; one record of a jsonl file
    <path>#L<n>-L<m>              lines n to m; `L<n>-<m>` reads the same
    <path>#L<n>.b<k>              content block k (0-based) of a transcript record: its words, a tool call, a result
    <path>#/<pointer>             a value of a JSON document by its JSON pointer (RFC 6901)
    <path>#row=<n>                row n (1-based, after the header) of a csv or tsv file
    <db>#<table>/<rowid>          a row of a SQLite file (.db, .sqlite, .sqlite3)
    <db>#<table>                  a whole table
    <path>#<anything else>        the file, with the part after # kept as written (a heading, a cell range, a time):
                                  any locator a file's own type uses still cites the file

A row set names many rows of one file in one string: the numbers after the last unit are a list of numbers and ranges,
such as `revisions.jsonl#L4-9,12,40-41`, `runs.csv#row=1-30`, `forge.db#prs/1-12` or `run.json#/messages/3-17`.

Query values:

    q<n>                          the query and its whole output
    q<n>#row=<i>                  row i (1-based) of its output table
    q<n>#<col>=<value>[&...]      the output row whose key columns hold these values
    ...@<col>                     one cell of that row, such as q3#day=2026-06-16@n (q3@n: the column n)

A key value with a space, a bracket or other punctuation is written as its slug, so a ref stays one Markdown link:
"won (clean ep)" is `q11#run_result=won-clean-ep`. A value is found as written, percent-encoded, or by its slug.

Object values:

    obj:<id>                      an object (thimble/objects/<id>.json); the id may leave out its number prefix
    obj:<id>#/<pointer>           a value of the object's data, such as obj:03-saves-by-day#/days/4/n
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote, unquote

DB_SUFFIXES = (".db", ".sqlite", ".sqlite3")
_NUMS = r"\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*"
_FP = r"[^#\s](?:[^#\n]*[^#\s])?"  # a path may hold spaces inside it, never at its ends, never a `#`
_QUERY = re.compile(r"^(q\d+)(?:#(.*)|(@.*))?$")
_OBJ = re.compile(r"^obj:([A-Za-z0-9_.-]+)(?:#(/.*)?)?$")
_LINES = re.compile(r"^L(\d+)(?:-L?(\d+))?$")
_LINESET = re.compile(r"^L(" + _NUMS + r")$")
_BLOCK = re.compile(r"^L(\d+)\.b(\d+)$")
_CSVROW = re.compile(r"^row=(" + _NUMS + r")$")
_DBROW = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(?:/(.+))?$")
_POINTER_SET = re.compile(r"^(/(?:[^/]*/)*)(" + _NUMS + r")$")
_FP_RE = re.compile(_FP)
# compiled once: compress, expand and parse run over every row a query's output rests on, millions at a time
_U_LINE = re.compile(r"L(\d+)")
_U_ROW = re.compile(r"row=(\d+)")
_U_POINTER = re.compile(r"(/(?:[^/]*/)*)(\d+)")
_U_DBROW = re.compile(r"([A-Za-z_][A-Za-z0-9_]*/)(\d+)")
_BLOCK_REF = re.compile(r"(" + _FP + r")#L(\d+)\.b(\d+)")


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
    """A ref as a dict with `kind`: file, lines, block, pointer, csvrows, dbrows, table, query, object.

    `lines`, `csvrows`, `dbrows` and a pointer set hold `nums`, the 1-based numbers (rowids for a database) they name."""
    ref = ref.strip()
    if not ref:
        raise RefError("an empty ref")
    if m := _QUERY.match(ref):
        return {"kind": "query", "query": m[1], **_query_fragment(m[2] or m[3] or "")}
    if m := _OBJ.match(ref):
        return {"kind": "object", "object": m[1], "pointer": m[2] or ""}
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
    if m := _BLOCK.match(frag):
        return {"kind": "block", "path": path, "line": int(m[1]), "block": int(m[2])}
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


def _query_fragment(frag: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not frag:
        return out
    frag, at, col = frag.partition("@")
    if at:
        out["col"] = unquote(col)
    if not frag:
        return out
    if m := re.fullmatch(r"row=(\d+)", frag):
        out["row"] = int(m[1])
        return out
    keys: dict[str, str] = {}
    for part in frag.split("&"):
        k, eq, v = part.partition("=")
        if not eq or not k:
            raise RefError(f"a query row is row=<i> or <column>=<value>, not {part!r}")
        keys[unquote(k)] = unquote(v)
    out["keys"] = keys
    return out


def single_refs(p: dict[str, Any]) -> list[str]:
    """Each row a parsed source ref names, as its own ref."""
    k, path = p["kind"], p.get("path", "")
    if k == "lines":
        return [f"{path}#L{n}" for n in p["nums"]]
    if k == "csvrows":
        return [f"{path}#row={n}" for n in p["nums"]]
    if k == "dbrows":
        if "keys" in p:
            return [f"{path}#{p['table']}/{x}" for x in p["keys"]]
        return [f"{path}#{p['table']}/{n}" for n in p["nums"]]
    if k == "pointer":
        if "nums" in p:
            return [f"{path}#{p['prefix']}{n}" for n in p["nums"]]
        return [f"{path}#{p['pointer']}"]
    if k == "block":
        return [f"{path}#L{p['line']}.b{p['block']}"]
    if k in ("file", "table"):
        return [format_source(p)]
    raise RefError(f"{k} is not a source ref")


def format_source(p: dict[str, Any]) -> str:
    k, path = p["kind"], p.get("path", "")
    if k == "file":
        return path + (f"#{p['locator']}" if p.get("locator") else "")
    if k == "table":
        return f"{path}#{p['table']}"
    if k == "block":
        return f"{path}#L{p['line']}.b{p['block']}"
    if k == "lines":
        return f"{path}#L{format_nums(p['nums'])}"
    if k == "csvrows":
        return f"{path}#row={format_nums(p['nums'])}"
    if k == "dbrows":
        if "keys" in p:
            return f"{path}#{p['table']}/{p['keys'][0]}"
        return f"{path}#{p['table']}/{format_nums(p['nums'])}"
    if k == "pointer":
        if "nums" in p:
            return f"{path}#{p['prefix']}{format_nums(p['nums'])}"
        return f"{path}#{p['pointer']}"
    raise RefError(f"{k} is not a source ref")


def _unit(ref: str) -> tuple[str, str, int] | None:
    """(path, unit, number) of a one-row ref whose row is a number, so many can share one row-set string."""
    path, _, frag = ref.partition("#")
    if frag[:1] == "L" and not path.lower().endswith(DB_SUFFIXES):
        # a line (L12) or a block (L12.b1, which names no numbered row): only the line pattern can match
        m = _U_LINE.fullmatch(frag)
        return (path, "L", int(m[1])) if m else None
    if m := _U_LINE.fullmatch(frag):
        return path, "L", int(m[1])
    if m := _U_ROW.fullmatch(frag):
        return path, "row=", int(m[1])
    if m := _U_POINTER.fullmatch(frag):
        return path, m[1], int(m[2])
    if path.lower().endswith(DB_SUFFIXES) and (m := _U_DBROW.fullmatch(frag)):
        return path, m[1], int(m[2])
    return None


def compress(refs: list[str]) -> list[str]:
    """Many one-row refs as few row-set strings, one per file and unit, in first-seen order; refs that name no numbered
    row are kept as they are."""
    groups: dict[tuple[str, str], list[int]] = {}
    # the other refs once each, in first-seen order (a dict, so a row with 100,000 block refs is not a quadratic scan)
    other: dict[str, None] = {}
    for r in refs:
        u = _unit(r)
        if u is None:
            other.setdefault(r, None)
            continue
        groups.setdefault((u[0], u[1]), []).append(u[2])
    return [f"{path}#{unit}{format_nums(nums)}" for (path, unit), nums in groups.items()] + list(other)


def expand(rowsets: list[str]) -> list[str]:
    """Row-set strings back to one-row refs."""
    out: list[str] = []
    for s in rowsets:
        # a block ref (one record's block, `f#L12.b1`), the common one-row ref that names no numbered row: read as
        # parse() reads it, without its chain of patterns
        t = s.strip()
        if (m := _BLOCK_REF.fullmatch(t)) and not _QUERY.match(t):
            line, block = m[2], m[3]
            canonical = (line[0] != "0" or line == "0") and (block[0] != "0" or block == "0")
            out.append(t if canonical else f"{m[1]}#L{int(line)}.b{int(block)}")
            continue
        out.extend(single_refs(parse(s)))
    return out


def count(rowsets: list[str]) -> int:
    n = 0
    for s in rowsets:
        p = parse(s)
        n += len(p["nums"]) if "nums" in p else len(p.get("keys") or [1])
    return n


LINK_RE = re.compile(r"\[([^\]\n]*)\]\(([^)\s]+)\)")
_SAFE_VALUE = re.compile(r"^[A-Za-z0-9_.:~,/+-]+$")


def ref_value(v: Any) -> str:
    """A key value as a ref writes it: as it is when it holds only safe characters, else its slug ("won (clean ep)" ->
    "won-clean-ep"), so the ref stays one Markdown link and Claude never has to quote it."""
    if isinstance(v, bool):
        s = "true" if v else "false"
    elif isinstance(v, float) and v.is_integer():
        s = str(int(v))
    else:
        s = "" if v is None else str(v)
    if _SAFE_VALUE.match(s):
        return s
    t = re.sub(r"[^A-Za-z0-9_.:~,/+-]+", "-", s).strip("-")
    return t or quote(s, safe="")


def value_slug(s: Any) -> str:
    """The form two key values are compared in when neither matches as written: lower case, words joined by -."""
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def link_spans(text: str):
    """(label, target, start, end) of each `[label](target)`. A target may hold balanced brackets, and a query ref
    (q3#...) may hold spaces up to its closing bracket, so `[202](q11#run_result=won (clean ep)@median)` is one link."""
    s = text or ""
    i = 0
    while True:
        a = s.find("[", i)
        if a < 0:
            return
        b = s.find("]", a + 1)
        if b < 0:
            return
        label = s[a + 1:b]
        if "\n" in label or b + 1 >= len(s) or s[b + 1] != "(":
            i = a + 1
            continue
        depth, j = 0, b + 2
        while j < len(s) and s[j] != "\n":
            if s[j] == "(":
                depth += 1
            elif s[j] == ")":
                if depth == 0:
                    break
                depth -= 1
            j += 1
        if j >= len(s) or s[j] != ")":
            i = a + 1
            continue
        target = s[b + 2:j].strip()
        if target and (not re.search(r"\s", target) or re.match(r"^q\d+#", target)):
            yield label, target, a, j + 1
        i = j + 1


def links(text: str) -> list[tuple[str, str]]:
    """(label, target) of each markdown link of a text whose target parses as a ref."""
    out = []
    for label, target, _, _ in link_spans(text):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        try:
            parse(target)
        except RefError:
            continue
        out.append((label, target))
    return out
