"""The citation healing pass: a deterministic repair of the citations `[words](ref)` in a text whose cited place does
not show the value their words state. It makes no model call.

For each citation whose words state a number and whose place does not show it:
  (a) the cited query or card is searched for the number, and the citation is re-pointed only when one place is
      singled out: the only place that holds it, else the only one in the cited row or the cited column. A guessed
      place shown as a link would be false provenance;
  (b) else the other queries and cards the text cites, then (only for a specific number, and only when the cited
      place holds no other number) the session's queries, newest first;
  (c) else it is contradicted when the cited place holds a different number (the same row and column, the same card
      part), or when a cited query or row shows the number nowhere (a column of several rows shows its total too); it
      keeps its words and ref, and `why` says what the place shows;
  (d) else (the place is gone, or holds no number) it is unwrapped to its words.

A citation of a source file's place is checked for its place only. When the place is gone, it is re-pointed only to
a place in a file (the file a mistyped path means, `_sibling`), never to a query or a card, else it is unwrapped.

A citation whose words state no number is only checked for its place: one that does not resolve is unwrapped. The
words of the text are never changed, only a citation's ref or its link. `analyst=True` keeps every link (re-pointed
or as written): the analyst's own citations are never unwrapped.

`version(st, text)` hashes the text and the cited queries' runs and cards' versions. A caller keeps the version of the
text it healed and of the text the pass gave back, and skips a text at either, so the pass's own edits never start it
again; a re-run of a cited query makes a new version.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable

from . import objects as O
from . import query as Q
from . import refs as R
from . import shown as SW
from . import sources as S
from .objects import NUM_RE, number_matches
from .store import Store

LINKED, QUIET, CONTRADICTED = "linked", "quiet", "contradicted"
# how a citation ended: kept as written; re-pointed inside the cited query or card, at another one the text cites, or
# at a query of the session; no place holds it; several places hold it
KEPT, CELL, CITED, SESSION = "kept", "cell", "cited", "session"
# a source path re-pointed at the file it means: mistyped (the one file beside it whose name starts the same way and
# holds the cited place)
PATH = "path"
# a source path written from the subfolder a session ran `cd` into (the one file under the root whose path ends with
# it): the same place, its ref written with the path under the root. It is not a repair
FOLDER = "folder"
NO_HOME, SEVERAL, GONE = "no_home", "several", "gone"
# a quote re-pointed at the one row of the cited file that holds its words, when the cited row does not
QUOTE = "quote"

WHY_CONTRADICTED = "the cited place shows {source}"
WHY_NOWHERE = "{where} shows no {value}"
WHY_GONE = "the cited place is gone ({problem})"
WHY_SEVERAL = "several places show {value}"
WHY_NO_HOME = "no place shows {value}"
WHY_NO_QUOTE = "the cited {unit} does not hold these words"
WHY_QUOTE_ELSEWHERE = "the cited {unit} does not hold these words; {where} of {path} hold them"
WHY_NOT_SHOWN = "{owner} does not show {dates}"
QUOTE_SCAN = 200000  # rows of the cited file searched for a quote its cited row does not hold

SESSION_MAX = 200  # queries of the session searched, newest first
_QUOTES = "\"“'‘"


@dataclass
class Change:
    """What the pass did to one citation: `label` and `ref` as written; `state` linked, quiet or contradicted; `how`;
    `to` the ref it points at now (None when unwrapped); `source` what the cited place shows when it contradicts the
    words, or when the pass re-pointed the citation away from it; `why` the words a quiet or contradicted citation
    shows."""
    label: str
    ref: str
    state: str
    how: str
    to: str | None = None
    source: str | None = None
    why: str | None = None

    def record(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class Result:
    text: str
    changes: list[Change] = field(default_factory=list)
    of: str = ""
    version: str = ""

    def record(self) -> dict[str, Any]:
        return {"text": self.text, "changed": any(c.how not in (KEPT, FOLDER) for c in self.changes), "of": self.of,
                "version": self.version, "changes": [c.record() for c in self.changes]}


@dataclass(frozen=True)
class Place:
    """One value a query's output or a card's data shows, and the ref that names it."""
    ref: str
    value: Any
    owner: str  # r3, or card:<id>
    row: int | None = None
    col: str | None = None


# ------------------------------------------------------------------ numbers


def _numbers(label: str) -> list[str]:
    """The numbers the words state: a quote, or words with no number, state none."""
    s = (label or "").replace("**", "").strip()
    if not s or s[0] in _QUOTES:
        return []
    return [O.num_text(n) for n in NUM_RE.findall(O._tight(s))]


def _shows(label: str, v: Any) -> bool:
    """Whether a value shows a number the words state: a number equal as written or as rounded (objects.number_matches),
    or a string that holds the number as one of its own."""
    if isinstance(v, bool) or v is None:
        return False
    if isinstance(v, (int, float)):
        return number_matches(label, v)
    s = str(v).replace(",", "")
    for n in _numbers(label):
        tok = n.replace("−", "-").replace(",", "").lstrip("-")
        if re.search(r"(?<![\d.])" + re.escape(tok) + r"(?![\d]|\.\d)", s):
            return True
    return False


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _specific(n: str) -> bool:
    """A number specific enough to find by itself among the session's outputs: three digits or more, or a decimal, and
    no year."""
    t = n.replace(",", "").replace("−", "").lstrip("-")
    if re.fullmatch(r"(19|20)\d\d", t):
        return False
    return "." in t or len(t.replace(".", "")) >= 3


def _position_col(c: Any) -> bool:
    """A column pandas names for a row's position when it resets an unnamed index: `index`, `level_0`."""
    return bool(re.fullmatch(r"index|level_\d+", str(c)))


def _show(v: Any) -> str:
    if isinstance(v, float):
        return f"{v:,.4g}" if abs(v) < 1e6 else f"{v:,.0f}"
    if isinstance(v, int) and not isinstance(v, bool):
        return f"{v:,}"
    s = " ".join(str(v).split())
    return s if len(s) <= 40 else s[:39] + "…"


# ------------------------------------------------------------------ places


class _Reader:
    """The queries and cards one pass reads, each read once."""

    def __init__(self, st: Store):
        self.st = st
        self._q: dict[str, dict | None] = {}
        self._o: dict[str, dict | None] = {}
        self._places: dict[str, list[Place]] = {}

    def query(self, qid: str) -> dict | None:
        if qid not in self._q:
            # the table and keys are enough: the row lineage stays packed
            raw = self.st.read_json(self.st.dir / "queries" / f"{qid}.json")
            self._q[qid] = None if not raw or raw.get("running") else raw
        return self._q[qid]

    def card(self, name: str) -> dict | None:
        if name not in self._o:
            i = O.find_id(self.st, name)
            self._o[name] = self.st.read_json(self.st.dir / "objects" / f"{i}.json") if i else None
        return self._o[name]

    def places(self, owner: str) -> list[Place]:
        if owner in self._places:
            return self._places[owner]
        out: list[Place] = []
        if owner.startswith("card:"):
            o = self.card(owner[5:])
            if o:
                cid = o.get("id") or owner[5:]

                def walk(v: Any, ptr: str, depth: int = 0) -> None:
                    if depth > 8 or len(out) > 5000:
                        return
                    if isinstance(v, dict):
                        for k, x in v.items():
                            if not str(k).startswith("_"):
                                walk(x, f"{ptr}/{str(k).replace('~', '~0').replace('/', '~1')}", depth + 1)
                    elif isinstance(v, list):
                        for i, x in enumerate(v[:2000]):
                            walk(x, f"{ptr}/{i}", depth + 1)
                    elif _is_number(v):
                        out.append(Place(f"card:{cid}#{ptr}", v, owner))

                walk(o.get("data"), "")
        else:
            q = self.query(owner)
            if q:
                table = q.get("table") or []
                keys = set(q.get("keys") or [])
                refs = Q.row_refs({**q, "id": owner}) if table else []
                for i, r in enumerate(table):
                    if not isinstance(r, dict):
                        continue
                    for c, v in r.items():
                        # an `index` or `level_0` column is where a row sat in a frame, not a value of the output
                        if str(c).startswith("_") or c in keys or _position_col(c) or not _is_number(v):
                            continue
                        out.append(Place(f"{refs[i]}@{R.ref_value(c)}", v, owner, row=i, col=c))
        self._places[owner] = out
        return out

    def session_queries(self) -> list[str]:
        """The ids of the session's queries, newest first (every query when the store has no session)."""
        d = self.st.dir / "queries"
        if not d.is_dir():
            return []
        ids = sorted((p.stem for p in d.glob("*.json") if re.fullmatch(R.QUERY_ID, p.stem)), key=lambda x: -int(x[1:]))
        out = []
        for qid in ids:
            q = self.query(qid)
            if q and (not self.st.session or not q.get("session") or q.get("session") == self.st.session):
                out.append(qid)
            if len(out) >= SESSION_MAX:
                break
        return out


def _owner(p: dict[str, Any]) -> str | None:
    if p["kind"] == "query":
        return p["query"]
    if p["kind"] == "object":
        return f"card:{p['object']}"
    return None


def _parse(ref: str) -> dict[str, Any] | None:
    try:
        return R.parse(ref)
    except R.RefError:
        return None


def cited(text: str) -> list[str]:
    """The queries and cards a text's citations name (r3, card:<id>), in order of first mention."""
    out: list[str] = []
    for _, target, _, _ in R.link_spans(text):
        p = _parse(target)
        o = _owner(p) if p else None
        if o and o not in out:
            out.append(o)
    return out


# ------------------------------------------------------------------ the version guard


def version(st: Store, text: str) -> str:
    """The version of a text against what it cites: a sha over the text and, per cited query, its run (time and output
    hash), per cited card, its version. The same text over the same outputs heals once."""
    rd = _Reader(st)
    h = hashlib.sha1((text or "").encode("utf-8", "surrogatepass"))
    for owner in sorted(cited(text or "")):
        if owner.startswith("card:"):
            o = rd.card(owner[5:])
            h.update(f"|{owner}:{(o or {}).get('version')}".encode())
        else:
            q = rd.query(owner)
            h.update(f"|{owner}:{(q or {}).get('t')}:{(q or {}).get('out_hash')}".encode())
    return h.hexdigest()[:12]


# ------------------------------------------------------------------ the pass


@dataclass
class _At:
    """What the cited place holds: whether it exists (`problem` when not), its value when it names one, and whether it
    shows the number (`holds`)."""
    exists: bool = True
    problem: str | None = None
    holds: bool = False
    source: Any = None  # a different number the place shows
    nowhere: bool = False  # a query, a row or a card part that shows the number nowhere
    row: int | None = None
    col: str | None = None
    keys: dict[str, str] | None = None
    moved: str | None = None  # the ref with the file's path under the root, when the ref names it from a subfolder


def _at_query(rd: _Reader, p: dict[str, Any], label: str, ref: str) -> _At:
    q = rd.query(p["query"])
    if not q:
        return _At(False, f"no query {p['query']}")
    table = q.get("table") or []
    frag = {k: p[k] for k in ("row", "keys") if k in p}
    idx = Q.find_rows(q, frag) if frag else list(range(len(table)))
    if frag and not idx:
        return _At(False, f"{q.get('id', p['query'])} has no output row {ref.partition('#')[2].partition('@')[0]}")
    at = _At(keys=p.get("keys"))
    if frag and len(idx) == 1:
        at.row = idx[0]
    if "col" in p:
        cols = [Q.column(table[i], p["col"]) for i in idx if isinstance(table[i], dict)]
        if table and not any(cols):
            return _At(False, f"{q.get('id', p['query'])}'s output has no column {p['col']!r}")
        at.col = next((c for c in cols if c), None)
        vals = [table[i][c] for i, c in zip(idx, cols) if c]
    else:
        vals = [v for i in idx if isinstance(table[i], dict) for c, v in table[i].items() if not str(c).startswith("_")]
    if any(_shows(label, v) for v in vals):
        at.holds = True
        return at
    if "col" in p and at.row is None:
        # a column of several rows: the citation opens them all, and its total is the value it shows
        nums = [v for v in vals if _is_number(v)]
        if nums and number_matches(label, sum(nums)):
            at.holds = True
            return at
    if not frag and not table:
        # a query whose output is text: the number anywhere in it
        at.holds = _shows(label, q.get("stdout") or "")
        at.nowhere = not at.holds
        return at
    if not frag and "col" not in p and _shows(label, q.get("stdout") or ""):
        # a whole query: a number it printed is a value it shows too
        at.holds = True
        return at
    if not frag and "col" not in p:
        # a whole query: its row count, or a column's total, is a value it shows too
        nums = [r for r in table if isinstance(r, dict)]
        if number_matches(label, len(nums)) or any(number_matches(label, sum(r[c] for r in nums if _is_number(r.get(c))))
                                                   for c in (nums[0] if nums else {}) if any(_is_number(r.get(c)) for r in nums)):
            at.holds = True
            return at
    if len(vals) == 1 and "col" in p:
        v = vals[0]
        if _is_number(v) or NUM_RE.search(str(v)):
            at.source = v
        return at
    at.nowhere = True
    return at


def _at_card(rd: _Reader, p: dict[str, Any], label: str) -> _At:
    o = rd.card(p["object"])
    if not o:
        return _At(False, f"no card {p['object']}")
    ptr = p.get("pointer") or ""
    try:
        v, _, _ = O.walk(o.get("data"), ptr)
    except R.RefError as e:
        return _At(False, str(e))
    if _shows(label, v):
        return _At(holds=True)
    if _is_number(v):
        return _At(source=v)
    if isinstance(v, (dict, list)):
        # a part of the card: the number among its values
        leaves: list[Any] = []

        def walk(x: Any, d: int = 0) -> None:
            if d > 6 or len(leaves) > 2000:
                return
            if isinstance(x, dict):
                for k, y in x.items():
                    if not str(k).startswith("_"):
                        walk(y, d + 1)
            elif isinstance(x, list):
                for y in x:
                    walk(y, d + 1)
            else:
                leaves.append(x)

        walk(v)
        if any(_shows(label, x) for x in leaves):
            return _At(holds=True)
        return _At(nowhere=bool(ptr) and any(_is_number(x) for x in leaves))
    return _At()


def _at_source(st: Store, p: dict[str, Any], ref: str) -> _At:
    try:
        rel = S.locate(st.root, p.get("path", ""))
        got = S.fetch(st.root, ref, limit=1 if p["kind"] in ("file", "table") else 50)
    except (R.RefError, OSError, ValueError) as e:
        return _At(False, str(e))
    if p["kind"] not in ("file", "table") and not got:
        return _At(False, f"{ref} names no rows")
    # a source row is checked for its place only: its words may count or describe it
    return _At(holds=True, moved=R.format_source({**p, "path": rel}) if rel != p.get("path") else None)


def _sibling(st: Store, p: dict[str, Any], label: str) -> str | None:
    """The ref of the same place in the file that a mistyped path means, such as a session id with a wrong tail: the
    file in the same folder, of the same type, whose name is as long as the name written and starts the same way (at
    least half of it, and 8 characters), where the cited place exists and, when the words state a number, shows it.
    Only one file may fit. A citation of a file is never moved to a query or a card: those hold other things that may
    show the same number by chance."""
    path = p.get("path") or ""
    folder, _, name = path.rpartition("/")
    d = st.root / folder if folder else st.root
    if not name or not d.is_dir():
        return None
    stem, dot, ext = name.rpartition(".")
    stem = stem if dot else name

    def shared(other: str) -> int:
        n = 0
        for a, b in zip(stem, other):
            if a != b:
                break
            n += 1
        return n

    need = max(8, len(stem) // 2)
    fits: list[str] = []
    try:
        names = sorted(x.name for x in d.iterdir() if x.is_file() and x.name != name)
    except OSError:
        return None
    for other in names:
        o_stem, o_dot, o_ext = other.rpartition(".")
        o_stem = o_stem if o_dot else other
        if (o_ext if o_dot else "") != (ext if dot else "") or len(o_stem) != len(stem) or shared(o_stem) < need:
            continue
        ref = R.format_source({**p, "path": f"{folder}/{other}" if folder else other})
        try:
            rows = S.fetch(st.root, ref, limit=50)
        except (R.RefError, OSError, ValueError):
            continue
        if p["kind"] not in ("file", "table") and not rows:
            continue
        if _numbers(label) and not any(_shows(label, S.text_of(r)) for r in rows):
            continue
        fits.append(ref)
    return fits[0] if len(fits) == 1 else None


_QUOTE_SPAN = re.compile(r'"([^"“”]+)"|“([^“”]+)”')


def quotes_of(label: str) -> list[str]:
    """The words a citation quotes: each passage of its words in quotation marks, of two words or more (`agent-07
    wrote "yes, that was me"` quotes `yes, that was me`). [] for words that describe or count, which a row may state in
    other words."""
    s = " ".join(str(label or "").replace("**", "").split())
    out = [(m.group(1) or m.group(2) or "").strip() for m in _QUOTE_SPAN.finditer(s)]
    return [x for x in out if len(re.findall(r"[^\W\d_]{2,}", x)) >= 2]


def _unit_words(p: dict[str, Any]) -> str:
    return {"lines": "line", "csvrows": "row", "dbrows": "row"}.get(p.get("kind", ""), "record")


def _place_list(refs: list[str], cited: int | None, unit: str) -> str:
    """Where rows of one file are, the nearest to the cited one first, in words: `line 23`, `lines 5283, 5284 and 5285`,
    `lines 12, 40, 41 and 9 more`."""
    def num(r: str) -> int | None:
        m = re.search(r"(\d+)$", r)
        return int(m[1]) if m else None
    if cited is not None:
        refs = sorted(refs, key=lambda r: abs((num(r) or 0) - cited))
    shown = sorted(refs[:3], key=lambda r: num(r) or 0)
    names = [str(num(r)) if num(r) is not None else r.partition("#")[2] for r in shown]
    rest = len(refs) - len(shown)
    if rest:
        words = f"{', '.join(names)} and {rest} more"
    else:
        words = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
    return f"{unit}{'s' if len(refs) > 1 else ''} {words}"


def _quote_change(st: Store, p: dict[str, Any], label: str, ref: str, at_ref: str) -> Change | None:
    """A citation of a file's rows whose words quote: None when the cited rows hold the quoted words. Else, when one row
    of the same file holds them, the citation is re-pointed there, a correction as a misplaced number's is; when several
    rows hold them, or none, the words are contradicted, with where they are when they are in the file."""
    quotes = quotes_of(label)
    if not quotes or p.get("kind") in ("file", "table"):
        return None

    def holds(row: S.Row) -> bool:
        text = S.text_of(row)
        return all(S.find_quote(text, q) for q in quotes)

    try:
        got = S.fetch(st.root, at_ref, limit=50)
    except (R.RefError, OSError, ValueError):
        return None
    if not got or any(holds(r) for r in got):
        return None
    rel = (_parse(at_ref) or {}).get("path") or p.get("path", "")
    hits: list[str] = []
    try:
        for n, row in enumerate(S.iter_rows(st.root, rel, p.get("table"))):
            if n >= QUOTE_SCAN:
                break
            if holds(row):
                hits.append(row.ref)
    except (OSError, ValueError):
        hits = []
    unit = _unit_words(p)
    if len(hits) == 1:
        return Change(label, ref, LINKED, QUOTE, to=hits[0])
    if hits:
        nums = p.get("nums") or []
        why = WHY_QUOTE_ELSEWHERE.format(unit=unit, where=_place_list(hits, nums[0] if nums else None, unit), path=rel)
    else:
        why = WHY_NO_QUOTE.format(unit=unit)
    return Change(label, ref, CONTRADICTED, CONTRADICTED, to=ref, why=why)


def _pick(hits: list[Place], at: _At) -> Place | None:
    """The one place to re-point at inside the cited query or card: the only place that holds the number; else the only
    one in the cited row, else the only one in the cited column."""
    if len(hits) == 1:
        return hits[0]
    if at.row is not None:
        same = [h for h in hits if h.row == at.row]
        if len(same) == 1:
            return same[0]
    if at.col is not None:
        same = [h for h in hits if h.col == at.col]
        if len(same) == 1:
            return same[0]
    return None


def _sentence(text: str, start: int, end: int) -> str:
    a = max(text.rfind(". ", 0, start), text.rfind("\n", 0, start))
    b = min([x for x in (text.find(". ", end), text.find("\n", end)) if x >= 0] or [len(text)])
    return text[a + 1:b]


def _names_row(text: str, start: int, end: int, keys: dict[str, str] | None) -> bool:
    """Whether the words around a citation name the row it cites (`Kestrel made [41](r3#user=Kestrel@n) edits`): the
    number is wrong there, not misplaced, so it is never moved to another row."""
    if not keys:
        return False
    words = R.value_slug(_sentence(text, start, end).replace(text[start:end], " "))
    for v in keys.values():
        s = R.value_slug(v)
        if len(s) >= 3 and not re.fullmatch(r"[\d-]+", s) and re.search(r"(?:^|-)" + re.escape(s) + r"(?:-|$)", words):
            return True
    return False


class _Pass:
    def __init__(self, st: Store, text: str, analyst: bool):
        self.st = st
        self.text = text
        self.analyst = analyst
        self.rd = _Reader(st)
        self.cited = cited(text)

    def _find(self, owner: str, label: str) -> list[Place]:
        return [x for x in self.rd.places(owner) if _shows(label, x.value)]

    def _search(self, label: str, own: str | None, at: _At, session_ok: bool) -> tuple[Place | None, str | None, bool]:
        """(a place, how it was found, several places hold it)."""
        if own:
            hits = self._find(own, label)
            if hits:
                pick = _pick(hits, at)
                return (pick, CELL, False) if pick else (None, None, True)
        # a number moved to another place must be specific enough to find there by itself, as in the session search
        specific = any(_specific(n) for n in _numbers(label))
        for owner in self.cited if specific else []:
            if owner == own:
                continue
            hits = self._find(owner, label)
            if hits:
                return (hits[0], CITED, False) if len(hits) == 1 else (None, None, True)
        if session_ok and specific:
            for qid in self.rd.session_queries():
                if qid in self.cited:
                    continue
                hits = self._find(qid, label)
                if hits:
                    return (hits[0], SESSION, False) if len(hits) == 1 else (None, None, True)
        return None, None, False

    def one(self, label: str, ref: str, start: int, end: int) -> Change:
        p = _parse(ref)
        if p is None:
            return Change(label, ref, LINKED, KEPT, to=ref)  # not a ref the kernel reads: left as it is
        words = O.unkeyed(label, p)  # a number the ref names (a key, a column) is not the value the place holds
        own = _owner(p)
        if p["kind"] == "query" and SW.dates(words):
            # dates in the words: the query shows each of them in its output or its printed text, or the citation is
            # wrong; their digits are no numbers of their own
            q = self.rd.query(p["query"])
            if q:
                missing = SW.find(q, words)["missing"]
                if missing:
                    return Change(label, ref, CONTRADICTED, CONTRADICTED, to=ref,
                                  why=WHY_NOT_SHOWN.format(owner=p["query"], dates=" or ".join(missing)))
                words = SW.without_dates(words)
                if not _numbers(words):
                    return Change(label, ref, LINKED, KEPT, to=ref)
        num = bool(_numbers(words))
        if p["kind"] == "query":
            at = _at_query(self.rd, p, words, ref) if num else (_At() if self.rd.query(p["query"]) else _At(False, f"no query {p['query']}"))
        elif p["kind"] == "object":
            at = _at_card(self.rd, p, words) if num else (_At() if self.rd.card(p["object"]) else _At(False, f"no card {p['object']}"))
        else:
            # a citation of a file's place is re-pointed only to a place in a file, never to a query or a card
            at = _at_source(self.st, p, ref)
            if at.exists:
                quoted = _quote_change(self.st, p, label, ref, at.moved or ref)
                if quoted:
                    return quoted
                return Change(label, ref, LINKED, FOLDER, to=at.moved) if at.moved else Change(label, ref, LINKED, KEPT, to=ref)
            fixed = _sibling(self.st, p, words)
            if fixed:
                return Change(label, ref, LINKED, PATH, to=fixed)
            return self._quiet(label, ref, GONE, WHY_GONE.format(problem=str(at.problem).replace(f" under {self.st.root}", "")))
        if at.exists and at.moved:
            return Change(label, ref, LINKED, FOLDER, to=at.moved)
        if at.exists and (at.holds or not num):
            return Change(label, ref, LINKED, KEPT, to=ref)
        if not num:
            # words that name a place, not a number: nothing to look for
            return self._quiet(label, ref, GONE, WHY_GONE.format(problem=at.problem))
        found, how, several = self._search(words, own if at.exists else None, at, session_ok=at.source is None)
        if found and how == CELL and found.row != at.row and _names_row(self.text, start, end, at.keys):
            found = None
        if found:
            # what the place as written shows, for the note that says the citation was corrected
            shown = _show(at.source) if at.exists and at.source is not None else None
            return Change(label, ref, LINKED, how or CELL, to=found.ref, source=shown)
        if at.exists and at.source is not None and not several:
            return Change(label, ref, CONTRADICTED, CONTRADICTED, to=ref, source=_show(at.source),
                          why=WHY_CONTRADICTED.format(source=_show(at.source)))
        if at.exists and at.nowhere and not several:
            where = own if own and not own.startswith("card:") and at.row is None else "the cited row" if at.row is not None else "the cited place"
            return Change(label, ref, CONTRADICTED, CONTRADICTED, to=ref, why=WHY_NOWHERE.format(where=where, value=label.strip()))
        if several:
            return self._quiet(label, ref, SEVERAL, WHY_SEVERAL.format(value=label.strip()))
        if not at.exists:
            return self._quiet(label, ref, GONE, WHY_GONE.format(problem=at.problem))
        return self._quiet(label, ref, NO_HOME, WHY_NO_HOME.format(value=label.strip()))

    def _quiet(self, label: str, ref: str, how: str, why: str) -> Change:
        # the analyst's citation keeps its link, quiet; Claude's is unwrapped to its words
        return Change(label, ref, QUIET, how, to=ref if self.analyst else None, why=why)

    def run(self) -> Result:
        text = self.text
        out: list[str] = []
        changes: list[Change] = []
        pos = 0
        for label, target, start, end in R.link_spans(text):
            if target.startswith(("http://", "https://", "mailto:")) or not label.strip():
                continue
            try:
                c = self.one(label, target, start, end)
            except Exception:  # noqa: BLE001 — a place the pass cannot read leaves the citation as written
                c = Change(label, target, LINKED, KEPT, to=target)
            changes.append(c)
            out.append(text[pos:start])
            out.append(label if c.to is None else text[start:end] if c.to == target else f"[{label}]({c.to})")
            pos = end
        out.append(text[pos:])
        return Result("".join(out), changes)


def heal(st: Store, text: str, *, analyst: bool = False) -> Result:
    """The pass over one text: the healed text, what it did to each citation, the version of the text it read (`of`)
    and of the text it gave back (`version`)."""
    text = text or ""
    r = _Pass(st, text, analyst).run()
    r.of = version(st, text)
    r.version = r.of if r.text == text else version(st, r.text)
    return r


def heal_all(st: Store, texts: Iterable[str], *, analyst: bool = False, since: Iterable[str] = ()) -> list[dict[str, Any]]:
    """The pass over several texts in one process; a text whose version is in `since` is skipped (`{"skip": true}`)."""
    skip = set(since)
    out = []
    for t in texts:
        v = version(st, t or "")
        if v in skip:
            out.append({"skip": True, "of": v, "version": v})
            continue
        out.append(heal(st, t or "", analyst=analyst).record())
    return out
