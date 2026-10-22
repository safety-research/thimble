"""The citation healing pass: deterministic repair of value refs `[[v|ref]]` whose cited place does not show `v`.

It runs over every text that carries citations after the text is stored. For each value ref whose place does not show
its value: (a) the caller has already normalised the token's shape; (b) the cited cell's outputs are searched by numeric
equality, and the token re-points only when one place is singled out (_pick), since a guessed place shown as a link is
false provenance; (c) else the other cited cells, then the notebook newest first (only for a specific number); (d) else
the token unwraps to its plain value, drawn as a quiet grey mark.

A token is red (`contradicted`) when the cited place holds a different number for the same label, row or line and no
cited place holds the stated value, or when a whole-cell ref's cell shows the value nowhere. The analyst's own words are
never altered. A value a re-run made vanish (`gone`) is quiet, never red.

`version` hashes the text and the cited cells' output indices, and the caller skips a text already healed at that
version, so the pass's own edits never restart it. A `Cache` shares each cell's places across one call's tokens.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

from . import cite, refs

# the hover text of a quiet or contradicted mark
WHY_CONTRADICTED = "the cited place shows {source}"
WHY_NOT_IN_CELL = "the cited card shows no {value}"
WHY_GONE = "was {value} in an earlier run"
WHY_NO_HOME = "no output shows this value"
WHY_NO_CELL = "the cited card is gone"
WHY_SEVERAL = "the cited cards show this value in several places"
# a takeaway's value ref whose place does not show its value, between the hook and the job's pass (verify._link_now)
WHY_MOVED = "not at the cited place; the check is looking for it"

LINKED, QUIET, CONTRADICTED = "linked", "quiet", "contradicted"
# how a token ended: kept; re-pointed inside the cited cell, another cited cell or the notebook; unwrapped or kept with
# no home; ambiguous among several places; a re-run's vanished value
KEPT, CELL, CITED, NOTEBOOK = "kept", "cell", "cited", "notebook"
NO_HOME, SEVERAL, GONE = "no_home", "several", "gone"

# the AI authors of a takeaway (tools.TAKEAWAY_AUTHOR, and `thimble`); anything else is treated as the analyst's words
# and never corrected
AI_AUTHORS = frozenset(("model", "thimble"))

Loader = Callable[[str], "dict | None"]
Notebook = Callable[[], Iterable[dict]]


@dataclass(frozen=True)
class Place:
    """One value a cell shows and the span that names it."""
    ref: str
    value: str  # as shown
    key: str  # cite._norm(value)
    cell_id: str
    out: int | None = None
    line: int | None = None
    col: str | None = None
    row: str | None = None


@dataclass
class Change:
    """What the pass decided about one value-ref token. `value` and `ref` as written; `to` where the token points now
    (None when it was unwrapped); `was` the display before an in-place correction; `source` the value at the cited place
    when it contradicts the text; `why` the words a quiet or contradicted mark shows on hover."""
    value: str
    ref: str
    state: str
    how: str
    to: str | None = None
    tier: int = 0
    source: str | None = None
    was: str | None = None
    corrected: bool = False
    why: str | None = None

    def record(self) -> dict[str, Any]:
        """The change as the record stores it: only the fields that carry something."""
        d = asdict(self)
        return {k: v for k, v in d.items() if v not in (None, False, 0) or k in ("value", "ref", "state", "how")}


@dataclass
class Result:
    text: str
    changes: list[Change] = field(default_factory=list)

    def records(self) -> list[dict[str, Any]]:
        return [c.record() for c in self.changes]


# --------------------------------------------------------------------------- places


def places(cell: dict) -> list[Place]:
    """Every value a cell's outputs show, with the span that names it: a td by column and row, a number on a text line
    by output index and line. A table bundle's text/plain is skipped, a chart's inline rows are places like tds, and a
    chart's text is never a value."""
    cid = str(cell.get("id") or "")
    out: list[Place] = []
    for i, b in cite.iter_outputs(cell.get("outputs")):
        html = cite.table_html(b)
        if html:
            for col, row, val in cite.table_cells(html):
                ref = cite.td_ref(cid, col, row)
                if ref and val.strip():
                    out.append(Place(ref, val.strip(), cite._norm(val), cid, out=i, col=col, row=row))
            continue
        if any(k.startswith("image/") or "vega" in k for k in b):
            continue
        for ln, line in cite.numbered_lines(b):
            for m in cite._NUM_RE.finditer(line):
                out.append(Place(f"card:{cid}@out{i}#L{ln}", m.group(), cite._norm(m.group()), cid, out=i, line=ln))
    return out


def _keys_for(display: str, negative_ok: bool) -> set[str]:
    """The comparison keys a display may match: the whole display as a number, else its one number ('250 assignments');
    with a stated decrease the same size with a minus sign."""
    keys = set(cite._keys(cite._norm(display.strip()), negative_ok))
    if not cite._PLAIN_NUM_RE.fullmatch(cite._norm(display.strip())):
        nums = list(cite._NUM_RE.finditer(display))
        if len(nums) == 1:
            keys |= set(cite._keys(cite._norm(nums[0].group()), negative_ok))
    return {k for k in keys if k}


def find_places(cell: dict, display: str, *, negative_ok: bool = False, cache: "Cache | None" = None) -> list[Place]:
    """The places in one cell whose value equals the display's number (cite._norm; a stated decrease may match the
    negative), in output order."""
    keys = _keys_for(display, negative_ok)
    if not keys:
        return []
    return [p for p in (cache.places(cell) if cache else places(cell)) if p.key in keys]


class Cache:
    """The places of the cells one caller's passes read, memoised by cell id, run and output indices, and the notebook's
    value index, built once on first use. Share one across the tokens and texts of one call."""

    def __init__(self) -> None:
        self._places: dict[tuple, list[Place]] = {}
        self._index: dict[str, list[tuple[int, Place]]] | None = None

    @staticmethod
    def _key(cell: dict) -> tuple:
        outputs = cell.get("outputs") or []
        cut = any(isinstance(b, dict) and "truncated" in b for b in outputs)
        return (str(cell.get("id") or ""), cell.get("exec_count"), tuple(i for i, _ in cite.iter_outputs(outputs)), cut)

    def places(self, cell: dict) -> list[Place]:
        k = self._key(cell)
        hit = self._places.get(k)
        if hit is None:
            hit = self._places[k] = places(cell)
        return hit

    def index(self, notebook: Notebook) -> dict[str, list[tuple[int, Place]]]:
        """value key → [(the cell's rank newest first, place)] over every cell `notebook()` yields; built once."""
        if self._index is None:
            index: dict[str, list[tuple[int, Place]]] = {}
            rank = 0
            seen: set[str] = set()
            for cell in notebook():
                cid = str(cell.get("id") or "")
                if not cid or cid in seen or not _runnable(cell):
                    continue
                seen.add(cid)
                for p in self.places(cell):
                    index.setdefault(p.key, []).append((rank, p))
                rank += 1
            self._index = index
        return self._index


def _runnable(cell: dict) -> bool:
    """Whether a card runs code, and so has outputs whose values a ref can name (notebook.runnable)."""
    from . import notebook  # noqa: PLC0415

    return notebook.runnable(cell)


def _parse(ref: str) -> dict[str, Any] | None:
    try:
        p = refs.parse_ref(ref)
    except ValueError:
        return None
    return p if p.get("kind") == "cell" else None


def _pick(hits: Sequence[Place], p: dict[str, Any] | None) -> Place | None:
    """The one place to re-point at when the cited cell shows the value (step b): the only place that holds it; else,
    for a td ref, the only one of the places that share the cited row or the cited column; for a line ref, the only one
    in the cited output. None when several hold it and none of these singles one out."""
    if len(hits) == 1:
        return hits[0]
    if not p:
        return None
    if p.get("col") is not None and p.get("row") is not None:
        col, row = cite.decode_label(str(p["col"])), cite.decode_label(str(p["row"]))
        agree = [h for h in hits if h.col is not None and (h.row == row or h.col == col)]
        return agree[0] if len(agree) == 1 else None
    if p.get("out") is not None and p.get("line") is not None:
        same = [h for h in hits if h.out == p["out"] and h.line is not None]
        return same[0] if len(same) == 1 else None
    return None


def _at_place(cell: dict, p: dict[str, Any]) -> tuple[bool, str | None]:
    """(the span exists, the numbers it shows as one string or None when it shows none) for a span into `cell`: a td's
    value when it is a number, a line's number tokens (up to three, joined). A whole-cell ref has no one place."""
    outputs = cell.get("outputs") or []
    if p.get("col") is not None and p.get("row") is not None:
        hit = cite.find_td(outputs, str(p["col"]), str(p["row"]))
        if hit is None:
            return False, None
        v = hit[0].strip()
        return True, v if cite._PLAIN_NUM_RE.fullmatch(cite._norm(v)) else None
    if p.get("out") is not None and p.get("line") is not None:
        line = cite.output_line(outputs, int(p["out"]), int(p["line"]))
        if line is None:
            return False, None
        nums = cite._NUM_RE.findall(line)
        return True, ", ".join(nums[:3]) if nums else None
    return True, None


def _dates_at(cell: dict, p: dict[str, Any]) -> str | None:
    """The dates a span into `cell` writes in digits (cite.dates_shown), for a date in words cited there."""
    outputs = cell.get("outputs") or []
    if p.get("col") is not None and p.get("row") is not None:
        hit = cite.find_td(outputs, str(p["col"]), str(p["row"]))
        return cite.dates_shown(hit[0]) if hit else None
    if p.get("out") is not None and p.get("line") is not None:
        return cite.dates_shown(cite.output_line(outputs, int(p["out"]), int(p["line"])) or "")
    return None


def _is_whole_cell(p: dict[str, Any] | None) -> bool:
    return p is not None and p.get("col") is None and p.get("out") is None


def is_label(display: str, ref: str) -> bool:
    """A value-ref whose display carries no number over a ref with no span (`[[chart|cell:X]]`, `[[the
    README|README.md]]`, a whole output) names the link rather than a value, so the reference alone decides it and it is
    never red."""
    if not cite.is_label_display(display):
        return False
    return bool(ref) and "#" not in ref and ("@" not in ref or cite.whole_output_cell(ref) is not None)


def _verified(cell: dict, ref: str, p: dict[str, Any], display: str, negative_ok: bool, cache: Cache | None = None) -> str | None:
    """The canonical form of `ref` when the span shows the display's value (a td span by its labels, a line span by its
    line, written as the td when the line is a table's); for a whole-cell ref, the ref itself when any place of the cell
    shows the value or its data holds it as a total or count; else None."""
    src = cite._Sources(str(p["cell_id"]), cell.get("outputs"))
    if p.get("col") is not None or p.get("out") is not None:
        return src.verify(ref, display, negative_ok=negative_ok)
    if (src.lookup_display(display, negative_ok=negative_ok) or src.supports(display)
            or find_places(cell, display, negative_ok=negative_ok, cache=cache)):
        return ref
    return None


def _canonical(ref: str, p: dict[str, Any] | None) -> str:
    """A td span in the grammar's encoded form (a raw label the model typed); any other ref as written."""
    return cite.canonical_td_ref(ref) if p and p.get("col") is not None else ref


# --------------------------------------------------------------------------- the version guard


def version(text: str, cells: Iterable[dict]) -> str:
    """The version of a text against the outputs it cites: a sha over the text and, per cited cell, its id, run and
    output indices. The same text over the same outputs heals once."""
    h = hashlib.sha1(text.encode("utf-8", "surrogatepass"))
    for cell in sorted((c for c in cells if isinstance(c, dict)), key=lambda c: str(c.get("id") or "")):
        idx = ",".join(str(i) for i, _ in cite.iter_outputs(cell.get("outputs")))
        h.update(f"|{cell.get('id')}:{cell.get('exec_count')}:{idx}".encode("utf-8"))
    return h.hexdigest()[:12]


def cited_cell_ids(text: str) -> list[str]:
    """The cell ids the text's tokens name, in order of first mention."""
    out: list[str] = []
    for r in refs.extract_refs(text):
        p = _parse(r)
        if p and p["cell_id"] not in out:
            out.append(str(p["cell_id"]))
    return out


# --------------------------------------------------------------------------- the pass


def _value_tokens(text: str) -> list[tuple[str, str, int, int]]:
    """[(display, ref, start, end)] for every `[[display|ref]]` in the text."""
    out: list[tuple[str, str, int, int]] = []
    for m in cite._SPAN_RE.finditer(text):
        inner = m.group(1)
        if "|" in inner:
            display, ref = inner.split("|", 1)
            if display.strip() and ref.strip():
                out.append((display.strip(), ref.strip(), m.start(), m.end()))
    return out


def _corrected_display(display: str, source: str) -> str | None:
    """The display with its number replaced by the source's — the whole display when it is one number, its one number
    inside a phrase ('250 assignments' → '31 assignments'); None when the source is not one plain number, the display
    holds several, or one of the two is a percentage and the other is not (a share is not a count)."""
    src = source.strip()
    if not cite._NUM_RE.fullmatch(src):
        return None
    if cite._NUM_RE.fullmatch(display.strip()):
        if display.strip().endswith("%") != src.endswith("%"):
            return None
        return src
    nums = list(cite._NUM_RE.finditer(display))
    if len(nums) != 1 or nums[0].group().endswith("%") != src.endswith("%"):
        return None
    m = nums[0]
    return display[: m.start()] + src + display[m.end():]


@dataclass(frozen=True)
class _Found:
    """What steps (b) and (c) came back with: a place and how; or `ambiguous` — the cited cells hold the value in
    several places and none is singled out; or neither."""
    place: Place | None = None
    how: str | None = None
    ambiguous: bool = False


class _Pass:
    def __init__(self, text: str, load: Loader, notebook: Notebook | None, analyst: bool, external: Mapping[Any, Any] | None, gone: Iterable[tuple[str, str]], unwrap: bool,
                 prior: Iterable[Mapping[str, Any]], cache: Cache | None):
        self.text = text
        self.unwrap = unwrap and not analyst  # the analyst's token stays where it is (quiet), never unwrapped
        self._load = load
        self._notebook = notebook
        self.analyst = analyst
        self.external = dict(external or {})
        self.gone = set(gone)
        self.prior = [dict(r) for r in prior if isinstance(r, Mapping)]
        self.cache = cache or Cache()
        self.changes: list[Change] = []
        self._cells: dict[str, dict | None] = {}
        self.cited = cited_cell_ids(text)

    def cell(self, cid: str) -> dict | None:
        if cid not in self._cells:
            try:
                self._cells[cid] = self._load(cid)
            except Exception:  # noqa: BLE001 — a loader failure reads as a cell that is gone
                self._cells[cid] = None
        return self._cells[cid]

    def _find(self, cell: dict, display: str, negative_ok: bool) -> list[Place]:
        return find_places(cell, display, negative_ok=negative_ok, cache=self.cache)

    def _external(self, display: str, ref: str) -> Any:
        """The caller's verdict by execution on a ref that is not a cell: keyed by (display, ref), since two values cited
        at one line are two checks, or by ref alone."""
        if (display, ref) in self.external:
            return self.external[(display, ref)]
        return self.external.get(ref, WHY_NO_HOME)

    async def _search(self, display: str, negative_ok: bool, p: dict[str, Any] | None, own: str | None, *,
                      notebook_ok: bool = True) -> _Found:
        """Steps (b) and (c): the cited cell, the other cited cells in order, then — with `notebook_ok` — the notebook.
        The notebook is not searched for a value whose cited place holds another number: a coincidental match in an
        unrelated cell would link the number the place contradicts."""
        if own:
            cell = self.cell(own)
            if cell:
                hits = self._find(cell, display, negative_ok)
                if hits:
                    pick = _pick(hits, p)
                    return _Found(pick, CELL) if pick else _Found(ambiguous=True)
        for cid in self.cited:
            if cid == own:
                continue
            cell = self.cell(cid)
            if cell:
                hits = self._find(cell, display, negative_ok)
                if hits:
                    return _Found(hits[0], CITED) if len(hits) == 1 else _Found(ambiguous=True)
        if notebook_ok and self._notebook is not None and cite._specific(display.strip()):
            index = await asyncio.to_thread(self.cache.index, self._notebook)
            by_cell: dict[str, tuple[int, list[Place]]] = {}
            for key in _keys_for(display, negative_ok):
                for rank, place in index.get(key, ()):
                    if place.cell_id in self.cited:
                        continue
                    by_cell.setdefault(place.cell_id, (rank, []))[1].append(place)
            if by_cell:
                _, hits = min(by_cell.values(), key=lambda t: t[0])  # the newest cell that holds it
                if len(hits) == 1:
                    return _Found(hits[0], NOTEBOOK)
        return _Found()

    def _prior_correction(self, display: str, canon: str) -> Change | None:
        """A stored record of an earlier pass that corrected this very token, reported again so the red mark and its
        "was" note outlive the pass that made them; not for the analyst's text."""
        if self.analyst:
            return None
        for r in self.prior:
            if r.get("state") != CONTRADICTED or not r.get("corrected") or r.get("to") != canon:
                continue
            was, source = str(r.get("was") or ""), str(r.get("source") or "")
            if was and source and _corrected_display(was, source) == display:
                return Change(was, str(r.get("ref") or canon), CONTRADICTED, CONTRADICTED, to=canon, source=source, was=was,
                              corrected=True, why=r.get("why") or WHY_CONTRADICTED.format(source=source))
        return None

    async def one(self, display: str, ref: str, negative_ok: bool) -> tuple[str, Change]:
        """The token's fate: (the token as it stands now, the change)."""
        # a whole output (`cell:X@out1`) has no ref of its own: it is read, and written back, as its cell
        ref_c = cite.whole_output_cell(ref) or ref
        p = _parse(ref_c)
        own = str(p["cell_id"]) if p else None
        cell = self.cell(own) if own else None
        source: str | None = None
        if p and cell and is_label(display, ref):
            # a label over a whole cell (or one of its outputs) that exists: linked as written, never checked
            canon = _canonical(ref_c, p)
            return f"[[{display}|{canon}]]", Change(display, ref, LINKED, KEPT, to=canon)
        if p and cell:
            canon = _verified(cell, ref_c, p, display, negative_ok, self.cache)
            if canon:
                earlier = self._prior_correction(display, canon)
                return f"[[{display}|{canon}]]", earlier or Change(display, ref, LINKED, KEPT, to=canon)
            exists, at = _at_place(cell, p)
            if exists and cite.day_month(display) is not None:
                at = _dates_at(cell, p) or at  # a date in words: the dates the place shows, not its numbers
            if exists and at is not None:
                source = at
        elif not p:
            verdict = self._external(display, ref)
            if verdict is None:  # the caller checked it by execution and it holds
                return f"[[{display}|{ref}]]", self._prior_correction(display, ref) or Change(display, ref, LINKED, KEPT, to=ref)
            if isinstance(verdict, dict):  # the place resolves but holds another value: contradicted when nothing else holds it
                source = str(verdict.get("source") or "") or None
        # a cell that is gone (p and not cell) goes on to steps (c)–(e) with the other cited cells
        found = await self._search(display, negative_ok, p, own, notebook_ok=source is None)
        if found.place and cite.off_named_row(ref_c, found.place.ref, self.text):
            found = _Found()  # the words name the row cited: the value is wrong there, not misplaced
        if found.place:
            return f"[[{display}|{found.place.ref}]]", Change(display, ref, LINKED, found.how or CELL, to=found.place.ref, tier=2)
        canon = _canonical(ref_c, p) if p else ref
        if source is not None and not found.ambiguous:
            why = WHY_CONTRADICTED.format(source=source)
            return f"[[{display}|{canon}]]", Change(display, ref, CONTRADICTED, CONTRADICTED, to=canon, source=source, why=why)
        gone = (display, ref) in self.gone
        if cell and _is_whole_cell(p) and not found.ambiguous and not gone:
            # the cell is there and shows the value nowhere, nor does any other cited cell: no row or line to have
            # misread, so the number itself is in doubt
            why = WHY_NOT_IN_CELL.format(value=display)
            return f"[[{display}|{canon}]]", Change(display, ref, CONTRADICTED, CONTRADICTED, to=canon, why=why)
        how = GONE if gone else SEVERAL if found.ambiguous else NO_HOME
        why = (WHY_GONE.format(value=display) if how == GONE else WHY_SEVERAL if how == SEVERAL
               else WHY_NO_CELL if (p and not cell) else None)
        if not self.unwrap:  # the caller keeps a token that found no home where it stands, or the text is the analyst's
            return f"[[{display}|{canon}]]", Change(display, ref, QUIET, how, to=canon, why=why)
        return display, Change(display, ref, QUIET, how, why=why)

    async def run(self) -> Result:
        text = self.text
        out: list[str] = []
        pos = 0
        for display, ref, start, end in _value_tokens(text):
            out.append(text[pos:start])
            pos = end
            negative_ok = cite.says_decrease(text, start, end)
            token, change = await self.one(display, ref, negative_ok)
            out.append(token)
            self.changes.append(change)
        out.append(text[pos:])
        return Result("".join(out), self.changes)


async def heal(text: str, *, load: Loader, notebook: Notebook | None = None, analyst: bool = False, external: Mapping[Any, Any] | None = None,
               gone: Iterable[tuple[str, str]] = (), unwrap: bool = True, prior: Iterable[Mapping[str, Any]] = (),
               cache: Cache | None = None) -> Result:
    """The pass over one text. `load(cell_id)` returns a cell with outputs (None when gone); `notebook()` the notebook's
    cells newest first, or None to search cited cells only; `analyst` True for the analyst's words; `external` the
    caller's verdicts on non-cell refs keyed by (display, ref): None holds, a string why it does not resolve, or
    `{"why", "source"}` for a place showing another value; `gone` the (display, ref) pairs a re-run orphaned; `unwrap`
    False keeps a homeless token where it stands; `prior` the change records of the last pass over this text; `cache` a
    shared Cache."""
    return await _Pass(text or "", load, notebook, analyst, external, gone, unwrap, prior, cache).run()


# --------------------------------------------------------------------------- helpers for the callers


def newest_first(cells: Iterable[dict]) -> list[dict]:
    """Code cells with output, newest run first (exec_count, then stored order reversed): the order step (c) searches
    the notebook in."""
    rows = [c for c in cells if isinstance(c, dict) and c.get("kind", "code") == "code" and c.get("outputs")]
    indexed = list(enumerate(rows))
    indexed.sort(key=lambda t: (-(t[1]["exec_count"] if isinstance(t[1].get("exec_count"), int) else 0), -t[0]))
    return [c for _, c in indexed]


def is_ai_author(author: Any) -> bool:
    """Whether a takeaway's recorded author is an AI author (its text may be corrected in place)."""
    return isinstance(author, str) and author in AI_AUTHORS


_TOKEN_WITH_REF = re.compile(r"\[\[([^\[\]|]+)\|([^\[\]]+)\]\]")


def unwrap(text: str, ref: str) -> str:
    """`text` with every value-ref pointing at `ref` unwrapped to its display (a caller that decided a ref is dead)."""
    return _TOKEN_WITH_REF.sub(lambda m: m.group(1).strip() if m.group(2).strip() == ref else m.group(0), text)
