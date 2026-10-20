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
such as `revisions.jsonl#L4-9,12,40-41`, `runs.csv#row=1-30`, `forge.db#prs/1-12` or `run.json#/messages/3-17`. Blocks
of transcript records join the same way, each part lines then blocks: `a.jsonl#L44.b0-2,45-50.b0` is blocks 0 to 2 of
line 44 and block 0 of lines 45 to 50.

Query values:

    r<n>                          the query and its whole output
    r<n>#row=<i>                  row i (1-based) of its output table
    r<n>#<col>=<value>[&...]      the output row whose key columns hold these values
    ...@<col>                     one cell of that row, such as r3#day=2026-06-16@n (r3@n: the column n)

q<n>, the ids before the rename, still resolve.

A key value with a space, a bracket or other punctuation is written as its slug, so a ref stays one Markdown link:
"won (clean ep)" is `r11#run_result=won-clean-ep`. A value is found as written, percent-encoded, or by its slug.

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
QUERY_ID = r"[qr]\d+"  # a query's id: r<n>, or q<n> from before the rename
_QUERY = re.compile(r"^(" + QUERY_ID + r")(?:#(.*)|(@.*))?$")
_OBJ = re.compile(r"^obj:([A-Za-z0-9_.-]+)(?:#(/.*)?)?$")
_LINES = re.compile(r"^L(\d+)(?:-L?(\d+))?$")
_LINESET = re.compile(r"^L(" + _NUMS + r")$")
_BLOCK = re.compile(r"^L(\d+)\.b(\d+)$")
_BPART = r"\d+(?:-\d+)?\.b\d+(?:-\d+)?"
_BLOCKSET = re.compile(r"^L(" + _BPART + r"(?:," + _BPART + r")*)$")
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


_BPARTS = re.compile(r"(\d+)(?:-(\d+))?\.b(\d+)(?:-(\d+))?")


_PARTS_SEEN: dict[str, tuple[tuple[tuple[int, int, int, int], ...], int]] = {}


def _block_parts(s: str) -> tuple[tuple[tuple[int, int, int, int], ...], int]:
    """(parts, how many blocks) of a block set's text after its `L`, read once: a resolve counts, merges and picks
    from the same long set, and a set lean wrote is known before it is read."""
    got = _PARTS_SEEN.get(s)
    if got is None:
        got = _PARTS_SEEN[s] = _read_parts(s)
        if len(_PARTS_SEEN) > 512:
            _PARTS_SEEN.clear()
            _PARTS_SEEN[s] = got
    return got


def _read_parts(s: str) -> tuple[tuple[tuple[int, int, int, int], ...], int]:
    parts = []
    n = 0
    for a, b, c, d in _BPARTS.findall(s):
        lo, hi = int(a), int(b or a)
        bl, bh = int(c), int(d or c)
        if hi < lo:
            lo, hi = hi, lo
        if bh < bl:
            bl, bh = bh, bl
        parts.append((lo, hi, bl, bh))
        n += (hi - lo + 1) * (bh - bl + 1)
    return tuple(parts), n


def parse_blocks(s: str) -> list[tuple[int, int, int, int]]:
    """A block set's parts (`44.b0-2,45-50.b0`) as (first line, last line, first block, last block). A set read once
    is read again from memory: a resolve parses the same long set to count it, merge it and pick from it."""
    return list(_block_parts(s)[0])


def format_blocks(pairs) -> str:
    """(line, block) pairs as a block set's parts, without the `L`: [(44, 0), (44, 1), (45, 0), (46, 0)] ->
    '44.b0-1,45-46.b0'. Each line's blocks as runs; lines in a row with the same run join into one part."""
    if not isinstance(pairs, list) and not hasattr(pairs, "shape"):
        pairs = list(pairs)
    if len(pairs) > 2000 or hasattr(pairs, "shape"):
        try:
            return _format_blocks_np(pairs)
        except ImportError:
            pass
    by_line: dict[int, list[int]] = {}
    for line, block in pairs:
        by_line.setdefault(int(line), []).append(int(block))
    # each line's runs of blocks, then for each run the lines that have it
    lines_of: dict[tuple[int, int], list[int]] = {}
    for line in sorted(by_line):
        bs = sorted(set(by_line[line]))
        i = 0
        while i < len(bs):
            j = i
            while j + 1 < len(bs) and bs[j + 1] == bs[j] + 1:
                j += 1
            lines_of.setdefault((bs[i], bs[j]), []).append(line)
            i = j + 1
    parts: list[tuple[int, int, int, int]] = []
    for (bl, bh), ls in lines_of.items():
        i = 0
        while i < len(ls):
            j = i
            while j + 1 < len(ls) and ls[j + 1] == ls[j] + 1:
                j += 1
            parts.append((ls[i], ls[j], bl, bh))
            i = j + 1
    parts.sort()
    return ",".join((f"{a}" if a == b else f"{a}-{b}") + ".b" + (f"{c}" if c == d else f"{c}-{d}") for a, b, c, d in parts)


def _format_blocks_np(pairs: Any) -> str:
    """format_blocks for many pairs (a list, or an array of two columns), with numpy: the same parts in the same
    order."""
    import numpy as np

    a = np.unique(np.asarray(pairs, dtype=np.int64).reshape(-1, 2), axis=0)  # sorted by line, then block
    line, block = a[:, 0], a[:, 1]
    # runs of blocks within a line
    new_run = np.ones(len(a), dtype=bool)
    new_run[1:] = (line[1:] != line[:-1]) | (block[1:] != block[:-1] + 1)
    starts = np.flatnonzero(new_run)
    ends = np.r_[starts[1:] - 1, len(a) - 1]
    rl, rb0, rb1 = line[starts], block[starts], block[ends]
    # lines in a row that hold the same run join: ordered by run, then line
    o = np.lexsort((rl, rb1, rb0))
    rl, rb0, rb1 = rl[o], rb0[o], rb1[o]
    new_part = np.ones(len(rl), dtype=bool)
    new_part[1:] = (rb0[1:] != rb0[:-1]) | (rb1[1:] != rb1[:-1]) | (rl[1:] != rl[:-1] + 1)
    ps = np.flatnonzero(new_part)
    pe = np.r_[ps[1:] - 1, len(rl) - 1]
    parts = np.stack([rl[ps], rl[pe], rb0[ps], rb1[ps]], axis=1)
    parts = parts[np.lexsort((parts[:, 3], parts[:, 2], parts[:, 1], parts[:, 0]))]
    plist = parts.tolist()
    text = ",".join((f"{x}" if x == y else f"{x}-{y}") + ".b" + (f"{c}" if c == d else f"{c}-{d}") for x, y, c, d in plist)
    _PARTS_SEEN[text] = (tuple(map(tuple, plist)), int(len(a)))
    return text


def _parts_pairs(parts: list[tuple[int, int, int, int]]) -> Any:
    """The (line, block) pairs of many parts, as an array of two columns (numpy), else a list."""
    try:
        import numpy as np
    except ImportError:
        return [(line, block) for a, b, c, d in parts for line in range(a, b + 1) for block in range(c, d + 1)]
    p = np.asarray(parts, dtype=np.int64).reshape(-1, 4)
    nl, nb = p[:, 1] - p[:, 0] + 1, p[:, 3] - p[:, 2] + 1
    k = nl * nb
    part = np.repeat(np.arange(len(p)), k)
    at = np.arange(int(k.sum())) - np.repeat(np.cumsum(k) - k, k)
    lines = p[part, 0] + at // nb[part]
    blocks = p[part, 2] + at % nb[part]
    return np.stack([lines, blocks], axis=1)


def block_pairs(p: dict[str, Any]):
    """The (line, block) pairs a parsed block set names, part by part."""
    for a, b, c, d in p["parts"]:
        for line in range(a, b + 1):
            for block in range(c, d + 1):
                yield line, block


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
    if m := _BLOCKSET.match(frag):
        parts, n = _block_parts(m[1])
        return {"kind": "blocks", "path": path, "parts": list(parts), "n": n}
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
    if k == "blocks":
        return [f"{path}#L{line}.b{block}" for line, block in block_pairs(p)]
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
    if k == "blocks":
        return f"{path}#L{format_blocks(block_pairs(p))}"
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


class _RowSets:
    """One-row refs gathered into row sets: numbered rows per file and unit, blocks of records per file, the rest once
    each, every kind in first-seen order."""

    def __init__(self) -> None:
        self.groups: dict[tuple[str, str], list[int]] = {}
        self.blocks: dict[str, list[tuple[int, int]]] = {}
        # the other refs once each, in first-seen order (a dict, so a row with 100,000 refs is not a quadratic scan)
        self.other: dict[str, None] = {}
        self.is_db: dict[str, bool] = {}
        # the parts of block sets added whole, per file, written out with the file's blocks at the end
        self.parts: dict[str, list[tuple[int, int, int, int]]] = {}

    def _db(self, path: str) -> bool:
        db = self.is_db.get(path)
        if db is None:
            db = self.is_db[path] = path.lower().endswith(DB_SUFFIXES)
        return db

    def add(self, r: str) -> None:
        # a line ref (f#L12), the most common: read here as _unit reads it (isdecimal is what \d matches)
        path, _, frag = r.partition("#")
        if frag[:1] == "L" and not self._db(path):
            if frag[1:].isdecimal():
                self.groups.setdefault((path, "L"), []).append(int(frag[1:]))
                return
            # a block of a record (f#L12.b1), as parse() reads it
            line, dot, block = frag[1:].partition(".b")
            if dot and line.isdecimal() and block.isdecimal():
                self.blocks.setdefault(path, []).append((int(line), int(block)))
                return
        u = _unit(r)
        if u is None:
            self.other.setdefault(r, None)
            return
        self.groups.setdefault((u[0], u[1]), []).append(u[2])

    def add_set(self, s: str) -> None:
        """A row set as its one-row refs would add, without writing them out when it is lines or blocks."""
        p = parse(s)
        if p["kind"] == "lines" and not self._db(p["path"]):
            self.groups.setdefault((p["path"], "L"), []).extend(p["nums"])
        elif p["kind"] == "blocks" and not self._db(p["path"]):
            self.parts.setdefault(p["path"], []).extend(p["parts"])
            self.blocks.setdefault(p["path"], [])
        else:
            for r in expand([s]):
                self.add(r)

    def _pairs(self, path: str) -> Any:
        pairs = self.blocks.get(path) or []
        parts = self.parts.get(path)
        if not parts:
            return pairs
        many = _parts_pairs(parts)
        if not pairs:
            return many
        if isinstance(many, list):
            return pairs + many
        import numpy as np

        return np.concatenate([np.asarray(pairs, dtype=np.int64).reshape(-1, 2), many])

    def sets(self) -> list[str]:
        return ([f"{path}#{unit}{format_nums(nums)}" for (path, unit), nums in self.groups.items()]
                + [f"{path}#L{format_blocks(self._pairs(path))}" for path in self.blocks] + list(self.other))


def compress(refs: list[str]) -> list[str]:
    """Many one-row refs as few row-set strings, one per file and unit, in first-seen order: lines as a line set, blocks
    of transcript records as a block set (`a.jsonl#L44.b0-2,45-50.b0`); refs that name no numbered row are kept as
    they are."""
    acc = _RowSets()
    for r in refs:
        acc.add(r)
    return acc.sets()


def merge(rowsets: list[str]) -> list[str]:
    """Row sets joined as compress(expand(rowsets)) joins them, without writing out each row of a line or block set."""
    acc = _RowSets()
    for s in rowsets:
        acc.add_set(s)
    return acc.sets()


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
        n += size(p)
    return n


def size(p: dict[str, Any]) -> int:
    """How many rows a parsed source ref names."""
    if p["kind"] == "blocks":
        return p["n"]
    return len(p["nums"]) if "nums" in p else len(p.get("keys") or [1])


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
    (r3#...) may hold spaces up to its closing bracket, so `[202](r11#run_result=won (clean ep)@median)` is one link."""
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
        if target and (not re.search(r"\s", target) or re.match(r"^" + QUERY_ID + "#", target)):
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
