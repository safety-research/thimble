"""Lineage read back: resolve any ref (a source row, a query's value, an object's value) to the rows it came from, and
coverage, what was read and what was not.

Coverage comes from four records: the queries' inputs and output and the rows `thimble rows` showed
(thimble/ledger.jsonl), the labels the session made (thimble/labels), and the Read, Grep and Bash calls the hooks module
kept (store.seen). It keeps apart what entered a model's context and what was only computed over. A file's status is the
strongest of:

    seen       some of its lines or rows entered Claude's context: Read, cat, head, tail or sed printing them
               (shellcmd.py), `thimble rows`, a search that showed them with their line numbers (Grep, `thimble rows
               --search`), or a query printing them as rows of its output
    model      only a label's model read some of its records (`thimble label --prompt`)
    searched   a search went over it and which lines it showed is not known (grep or rg in the shell)
    computed   a query or a rule label (regex, code) went over its rows, and none of them entered a context
    named      it was only named, listed or counted (wc, ls, find, git ls-files, grep -c), or named by a program whose
               output is not known (python, jq); the text says "counted"
    not read   nothing touched it (the text says "untouched")

Only seen counts as read: the bar's share (the rows in Claude's context), a card's snapshot and the observer's "not
seen" follow the same rule. What a label's model read and what was computed over are counted apart.
"""
from __future__ import annotations

import fnmatch
import json
import random
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from . import objects as O
from . import query as Q
from . import refs as R
from . import shellcmd as SH
from . import sources as S
from .store import Store

# ------------------------------------------------------------------ resolve


def excerpt(row: S.Row, width: int = 240) -> str:
    v = row.value
    if isinstance(v, dict) and v.get("type") in ("assistant", "user") and isinstance(v.get("message"), dict):
        bl = S.blocks_of(v)
        parts = []
        for b in bl[:3]:
            t = " ".join(str(b["text"]).split())
            parts.append(f"[{b['kind']}] {t[:160]}")
        s = f"{v['type']}: " + " · ".join(parts)
    elif isinstance(v, dict) and "text" in v and len(v) <= 6 and isinstance(v["text"], str):
        s = " ".join(v["text"].split())
    elif isinstance(v, dict):
        def short(x: Any) -> Any:
            if isinstance(x, str):
                x = " ".join(x.split())
                return x if len(x) <= 60 else x[:59] + "…"
            if isinstance(x, (dict, list)):
                t = json.dumps(x, ensure_ascii=False, default=str)
                return t if len(t) <= 60 else t[:59] + "…"
            return x
        s = ", ".join(f"{k}: {short(x)}" for k, x in v.items() if x not in (None, "", [], {}))
    else:
        s = " ".join(str(v).split())
    return s if len(s) <= width else s[: width - 1] + "…"


# the fields that hold a record's words, best first; then the fields that say whose and where it is (the shell's detail
# view shows `words` and `meta`; `text` stays the excerpt the CLI prints)
WORD_KEYS = ("text", "quote", "summary", "title", "message", "msg", "body", "content", "comment", "description", "subject",
             "note", "change_summary", "reason", "answer", "question", "prompt")
META_KEYS = ("user", "author", "agent", "sender", "name", "label", "page", "run", "step", "epoch", "rev", "kind", "type",
             "event_type", "activity", "day", "date", "time")


def words_of(row: S.Row) -> tuple[str, str]:
    """A row as a person reads it: its meaningful words (its text, title, summary, message, body and the like; a
    transcript row's first words or tool call) and a short line of whose and where it is. ('', '') when nothing in it
    reads as words."""
    v = row.value
    one = lambda x: " ".join(str(x).split())  # noqa: E731
    if isinstance(v, str):
        return one(v)[:240], ""
    if not isinstance(v, dict):
        return "", ""
    words, key = "", None
    if v.get("type") in ("assistant", "user") and isinstance(v.get("message"), dict):
        content = v["message"].get("content")
        for b in (content if isinstance(content, list) else [{"type": "text", "text": content}]):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and str(b.get("text") or "").strip():
                words = one(b["text"])
            elif b.get("type") == "tool_use":
                i = b.get("input") if isinstance(b.get("input"), dict) else {}
                arg = next((i[k] for k in ("command", "file_path", "pattern", "path", "description", "query") if i.get(k)), "")
                words = one(f"{b.get('name')}: {arg}" if arg else f"{b.get('name')}: {json.dumps(i, ensure_ascii=False)}")
            elif b.get("type") == "tool_result":
                c = b.get("content")
                words = one(c if isinstance(c, str) else " ".join(str(x.get("text") or "") for x in c or [] if isinstance(x, dict)))
            if words:
                break
        if words:
            t = str(v.get("timestamp") or "")
            return (words if len(words) <= 240 else words[:239] + "…"), " · ".join(x for x in (v["type"], t[11:16]) if x)
        return "", ""
    if not words:
        key = next((k for k in WORD_KEYS if isinstance(v.get(k), str) and v[k].strip()), None)
        if key:
            words = one(v[key])
    if not words:
        long = [(k, x) for k, x in v.items() if isinstance(x, str) and len(x.strip()) >= 16 and " " in x.strip()
                and not re.search(r"(id|uuid|ref|hash|key|url|path)$", k, re.I)]
        if long:
            key, x = max(long, key=lambda kv: len(kv[1]))
            words = one(x)
    used: set[str] = {key} if key else set()
    if not words:
        # an event row with no sentence in it (a request, a state change): what happened, from its short words, as
        # "request · browse-bare · wiki dse", never its ids or its time
        kinds, rest = [], []
        for k, x in v.items():
            if not isinstance(x, str) or not x.strip() or len(x) > 60 or re.search(r"(^|_)(id|uuid|ref|hash|key|url|path|sha)$", k, re.I):
                continue
            if re.match(r"^\d{4}-\d\d-\d\d([T ]\d\d:\d\d)?", x) or k in ("time", "date", "timestamp", "ts"):
                continue
            (kinds if re.search(r"(^|_)(type|kind|action|activity|status|outcome|result|event)$", k, re.I) else rest).append((k, x))
        # only a row that says what kind of thing happened reads as words; a row of plain values reads as a table
        if kinds:
            picked = (kinds + rest)[:4]
            used.update(k for k, _ in picked)
            words = " · ".join(one(x) if (k, x) in kinds else f"{k} {one(x)}" for k, x in picked)
    if not words:
        return "", ""
    meta = []
    for k in META_KEYS:
        x = v.get(k)
        if len(meta) >= 3:
            break
        if k in used or x in (None, "") or isinstance(x, (dict, list)) or len(one(x)) > 40:
            continue
        meta.append(f"{k} {x}" if isinstance(x, (int, float)) and not isinstance(x, bool) else one(x))
    return (words if len(words) <= 240 else words[:239] + "…"), " · ".join(meta)


def _record(row: S.Row) -> dict[str, Any]:
    out: dict[str, Any] = {"ref": row.ref, "hash": S.row_hash(row.raw), "text": excerpt(row)}
    words, meta = words_of(row)
    if words:
        out["words"] = words
        if meta:
            out["meta"] = meta
    return out


def spread_refs(rowsets: list[str], n: int) -> list[str]:
    """n one-row refs spread evenly across the row sets, in their order: the first, the last and the ones between, so
    examples stand for the whole group rather than its first rows."""
    sizes = []
    for rs in rowsets:
        try:
            p = R.parse(rs)
        except R.RefError:
            sizes.append((rs, None, 1))
            continue
        sizes.append((rs, p, R.size(p)))
    total = sum(k for _, _, k in sizes)
    if total <= 0:
        return []
    if total <= n:
        picks = list(range(total))
    else:
        picks = sorted({int(i * (total - 1) / (n - 1) + 0.5) for i in range(n)}) if n > 1 else [0]
    out, base, j = [], 0, 0
    for rs, p, k in sizes:
        while j < len(picks) and picks[j] < base + k:
            at = picks[j] - base
            if p is None or p["kind"] in ("file", "table", "block"):
                out.append(rs)
            elif p["kind"] == "blocks":
                out.append(_block_at(p, at))
            else:
                one = dict(p)
                if "nums" in p:
                    one["nums"] = [p["nums"][at]]
                elif "keys" in p:
                    one["keys"] = [p["keys"][at]]
                out.append(R.single_refs(one)[0])
            j += 1
        base += k
    return list(dict.fromkeys(out))


def _block_at(p: dict[str, Any], at: int) -> str:
    """The ref of the at-th block (0-based) of a block set, in its parts' order."""
    for a, b, c, d in p["parts"]:
        k = (b - a + 1) * (d - c + 1)
        if at < k:
            return f"{p['path']}#L{a + at // (d - c + 1)}.b{c + at % (d - c + 1)}"
        at -= k
    raise R.RefError(f"{R.format_source(p)} has no block {at}")


def records(st: Store, rowsets: list[str], n: int = 5, pick: str = "spread", seed: int = 0) -> list[dict[str, Any]]:
    """Up to n rows of the row sets, each {ref, hash, text, words?, meta?}: spread evenly across them (the default),
    the first ones in file order, or a random sample."""
    if pick == "spread":
        out = []
        for ref in spread_refs(rowsets, n):
            for row in S.fetch(st.root, ref, limit=1):
                out.append(_record(row))
        return out
    singles = R.expand(rowsets) if pick == "random" else None
    out = []
    if singles is not None:
        chosen = sorted(random.Random(seed).sample(singles, min(n, len(singles))), key=lambda r: (r.split("#")[0], _num(r)))
        for ref in chosen:
            for row in S.fetch(st.root, ref, limit=1):
                out.append(_record(row))
        return out
    for rs in rowsets:
        if len(out) >= n:
            break
        for row in S.fetch(st.root, rs, limit=n - len(out)):
            out.append(_record(row))
    return out


def _num(ref: str) -> int:
    m = re.search(r"(\d+)(?:-\d+)?$", ref)
    return int(m[1]) if m else 0


def narrow(st: Store, ref: str, label: str | None) -> tuple[str, str] | None:
    """(the ref of the one value a citation's words show, how it was found), when the citation names a whole query, a
    column or several rows and its words show one value that only one cell of them holds: `[6,543](r1@n)` is
    `r1#day=2026-06-18@n`. None when the ref already names one value, or the words fit no cell or several."""
    from .objects import NUM_RE, number_matches

    if not label:
        return None
    try:
        p = R.parse(ref)
    except R.RefError:
        return None
    if p["kind"] != "query":
        return None
    q = Q.get(st, p["query"])
    if not q:
        return None
    table = q.get("table") or []
    frag = {k: p[k] for k in ("row", "keys") if k in p}
    idx = Q.find_rows(q, frag) if frag else list(range(len(table)))
    if frag and len(idx) == 1 and "col" in p:
        return None
    words = " ".join(str(label).replace("**", "").split()).strip("\"“”'")
    hits: list[tuple[int, str]] = []
    has_num = bool(NUM_RE.search(words.replace(" ", "")))
    keys = set(q.get("keys") or [])
    for i in idx:
        r = table[i]
        cols = [Q.column(r, p["col"])] if "col" in p else [c for c in r if not str(c).startswith("_")]
        for c in cols:
            if c is None:
                continue
            v = r.get(c)
            if has_num:
                if isinstance(v, (int, float)) and not isinstance(v, bool) and c not in keys and number_matches(words, v):
                    hits.append((i, c))
            elif isinstance(v, str) and v.strip() and v.strip().lower() == words.lower():
                hits.append((i, c))
    if len({i for i, _ in hits}) != 1:
        return None
    i, c = hits[0]
    cols = {c for _, c in hits}
    own = Q.row_refs(q)[i]
    shown = f"{own}@{R.ref_value(c)}" if len(cols) == 1 else own
    return shown, f"the words show {words!r}, which only row {i + 1} of {q['id']} holds"


# the cited span of a file as a person reads it (resolve's `span`): the cited rows, a few rows around them, and the
# words a citation quotes marked in place
SPAN_AROUND = 2
SPAN_MAX = 6
_FOLD = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "—": "-", "–": "-"})


def _quoted(label: str | None) -> list[str]:
    """The parts of the words a citation quotes (an ellipsis splits them), or [] when its words quote nothing: a
    number, or fewer than three letters."""
    if not label:
        return []
    q = " ".join(str(label).replace("**", "").split()).strip().strip("\"'“”‘’").strip()
    if len(re.findall(r"[^\W\d_]", q)) < 3:
        return []
    return [x.strip(" ,;:") for x in re.split(r"\s*(?:\.\.\.|…|\[\.\.\.\]|\[…\])\s*", q) if x.strip(" ,;:")]


def quote_at(text: str, label: str | None) -> tuple[int, int] | None:
    """Where the words a citation quotes stand in `text` (whitespace folded in the quote, case and typographic quotes
    ignored): the start of their first part and the end of their last, or None."""
    parts = _quoted(label)
    if not parts:
        return None
    hay = text.translate(_FOLD).lower()
    at, first, end = 0, None, 0
    for part in parts:
        want = " ".join(part.translate(_FOLD).split()).lower()
        i = hay.find(want, at)
        if i < 0:
            return None
        first = i if first is None else first
        end = at = i + len(want)
    return (first, end) if first is not None else None


def _strings(v: Any, key: str = "", depth: int = 0) -> list[tuple[str, str]]:
    """Every string of a value with the field that holds it (`message.content.0.text`), in order."""
    if depth > 6:
        return []
    if isinstance(v, str):
        return [(key, v)]
    if isinstance(v, dict):
        return [x for k, y in v.items() for x in _strings(y, f"{key}.{k}" if key else str(k), depth + 1)]
    if isinstance(v, list):
        return [x for i, y in enumerate(v[:200]) for x in _strings(y, f"{key}.{i}" if key else str(i), depth + 1)]
    return []


def _window(text: str, at: tuple[int, int], width: int) -> tuple[str, tuple[int, int]]:
    """A window of `text` around the span `at`, about `width` characters, with … where it was cut."""
    a, b = at
    if len(text) <= width:
        return text, at
    lo = max(0, min(a - width // 4, len(text) - width))
    hi = min(len(text), max(lo + width, b))
    pre = "…" if lo > 0 else ""
    return pre + text[lo:hi] + ("…" if hi < len(text) else ""), (a - lo + len(pre), b - lo + len(pre))


def _span_row(row: S.Row, n: int | None, hot: bool, label: str | None, width: int) -> dict[str, Any]:
    """One row of a span: a line of text as written, or a record as its words (with whose and where). A cited row
    whose words a citation quotes reads as the field that holds them, with the quote's place (`at`)."""
    out: dict[str, Any] = {"ref": row.ref, "hot": hot}
    if n is not None:
        out["n"] = n
    if isinstance(row.value, str):
        text = row.value.replace("\t", "    ")
        at = quote_at(text, label) if hot else None
        if at:
            text, at = _window(text, at, width)
            out["at"] = list(at)
        out["text"] = text if len(text) <= width + 2 else text[: width - 1] + "…"
        return out
    words, meta = words_of(row)
    at = quote_at(words, label) if hot and words else None
    if at:
        out.update({"text": words, "at": list(at)})
    elif hot:
        # the quote is not in the row's words: the field that holds it, named
        for key, s in _strings(row.value):
            flat = " ".join(s.split())
            at = quote_at(flat, label)
            if at:
                text, at = _window(flat, at, width)
                out.update({"text": text, "at": list(at), "field": key})
                break
    if "text" not in out:
        out["text"] = words or excerpt(row, width)
    if meta:
        out["meta"] = meta
    return out


def span(st: Store, ref: str, label: str | None = None, around: int = SPAN_AROUND, width: int = 480) -> dict[str, Any] | None:
    """The span of a file a source ref cites, as a person reads it: the cited rows (at most SPAN_MAX) with `around`
    rows on each side, each a line as written or a record as its words, and where the words a citation quotes stand in
    the cited row. With the file's path and its absolute path, for a link that opens it, and the first cited row as the
    file holds it (`raw`, a record's JSON). None for a ref that names no rows (a whole file, a table, a query or an
    object's value)."""
    try:
        p = R.parse(ref)
    except R.RefError:
        return None
    k = p["kind"]
    if k not in ("lines", "block", "blocks", "csvrows", "dbrows", "pointer"):
        return None
    rel = p["path"]
    path = st.root / rel
    if not path.is_file():
        return None
    kind = S.kind_of_file(st.root, rel)
    out: dict[str, Any] = {"path": rel, "file": str(path.resolve()), "kind": kind}
    nums = p.get("nums") or []
    # one run of rows by number has the rows around it as its context; any other set shows its rows alone
    run = bool(nums) and nums == list(range(nums[0], nums[0] + len(nums))) and k in ("lines", "csvrows", "dbrows")
    rows: list[dict[str, Any]] = []
    try:
        if k == "lines" and kind in ("markdown", "diff", "text", None):
            shown = nums[:SPAN_MAX]
            lo, hi = (max(1, shown[0] - around), shown[-1] + around) if run else (shown[0], shown[-1])
            want = set(range(lo, hi + 1)) if run else set(shown)
            with open(path, "r", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    if i in want:
                        text = line.rstrip("\n")
                        rows.append(_span_row(S.Row(f"{rel}#L{i}", text, text), i, i in shown, label, width))
                    if i >= hi:
                        break
            if not any(r["hot"] for r in rows):
                return None
            out["unit"] = "line"
        else:
            unit = {"lines": "L", "csvrows": "row=", "dbrows": f"{p.get('table')}/"}.get(k)
            cited = S.fetch(st.root, ref, limit=SPAN_MAX)

            def num(r: S.Row) -> int | None:
                m = re.search(r"(\d+)$", r.ref)
                return int(m[1]) if m and unit else None

            before: list[S.Row] = []
            after: list[S.Row] = []
            if run and unit and len(nums) <= SPAN_MAX and around > 0:
                a, b = nums[0], nums[-1]
                if a > 1:
                    try:
                        before = S.fetch(st.root, f"{rel}#{unit}{max(1, a - around)}-{a - 1}")
                    except R.RefError:
                        before = []
                for i in range(b + 1, b + around + 1):
                    try:
                        after.extend(S.fetch(st.root, f"{rel}#{unit}{i}"))
                    except R.RefError:
                        break
            rows = [_span_row(r, num(r), False, label, width) for r in before]
            rows += [_span_row(r, num(r), True, label, width) for r in cited]
            rows += [_span_row(r, num(r), False, label, width) for r in after]
            out["unit"] = {"lines": "line", "csvrows": "row", "dbrows": "row"}.get(k, "value")
            # the cited row as the file holds it, for the person who wants it whole
            v = cited[0].value if cited else None
            raw = json.dumps(v, ensure_ascii=False, indent=1, default=str) if isinstance(v, (dict, list)) else (cited[0].raw if cited else "")
            lines = raw.split("\n")
            out["raw"] = "\n".join(x if len(x) <= 400 else x[:399] + "…" for x in lines[:80])
            if len(lines) > 80:
                out["raw_more"] = len(lines) - 80
    except (R.RefError, OSError, ValueError):
        return None
    out["rows"] = rows
    out["cited"] = len(nums) if nums else sum(1 for r in rows if r["hot"])
    return out


def about_rows(chain: list[dict[str, Any]]) -> str:
    """What a resolve's rows are, in words: the query's question and the key of the row they stand behind."""
    for step in chain:
        if step.get("step") == "query":
            bits = [str(step.get("about") or step.get("id"))]
            rows = step.get("rows") or []
            if len(rows) == 1:
                keys = [k for k in rows[0] if k != "i" and isinstance(rows[0][k], str)][:2]
                bits += [f"{k} {rows[0][k]}" for k in keys]
            return " · ".join(bits)
        if step.get("step") == "object" and step.get("title"):
            return str(step["title"])
    return ""


def resolve(st: Store, ref: str, n: int = 5, pick: str = "spread", label: str | None = None) -> dict[str, Any]:
    """Where a ref's value came from: a chain of steps from the ref down to source rows, the rows as row sets, how many,
    and up to n of them read back (spread across the rows). With `label`, the words a citation shows: a citation of a
    whole query is narrowed to the one row that holds the value it shows."""
    wrote = None
    got = narrow(st, ref, label) if label else None
    if got:
        wrote, ref = ref, got[0]
    p = R.parse(ref)
    chain: list[dict[str, Any]] = []
    notes: list[str] = []
    rowsets: list[str] = []
    if p["kind"] == "object":
        rowsets = _resolve_object(st, p, chain, notes)
    elif p["kind"] == "query":
        rowsets = _resolve_query(st, p, chain, notes)
    else:
        rowsets = [R.format_source(p)] if p["kind"] not in ("file", "table") else [ref]
        chain.append({"step": "source", "ref": ref, "kind": S.kind_of_file(st.root, p["path"])})
        if p["kind"] in ("file", "table") and documents(st, rowsets) == rowsets:
            chain[-1]["why"] = f"{ref} names a whole {'table' if p['kind'] == 'table' else 'file'}, not rows of it"
    rowsets = documents(st, rowsets)
    if got:
        notes.insert(0, f"{wrote} names more than one value; {got[1]}, so its rows are {ref}'s")
    out: dict[str, Any] = {"ref": ref, "chain": chain, "rows": rowsets, "notes": notes}
    if wrote:
        out["wrote"] = wrote
        out["narrowed"] = ref
    about = about_rows(chain)
    if about:
        out["about"] = about
    # a citation of rows of a file: the span as a person reads it, with the words its citation quotes marked
    sp = span(st, ref, label) if p["kind"] not in ("object", "query", "file", "table") else None
    if sp:
        out["span"] = sp
    try:
        files_only = all(R.parse(x)["kind"] in ("file", "table") for x in rowsets)
        out["count"] = None if files_only else R.count(rowsets)
        out["records"] = records(st, rowsets, n, pick) if rowsets and not files_only and n else []
    except R.RefError as e:
        out["error"] = str(e)
        out["records"] = []
    # what the files call their entries (records, rows, lines), as coverage counts them
    out.update(entries_of(st, rowsets))
    # why the value has no rows of its own, or why its rows are all the query read: one plain line for the person
    why = next((c["why"] for c in reversed(chain) if c.get("why")), None)
    if why:
        out["why"] = why
    elif not out.get("count") and not out.get("error"):
        out["why"] = "no rows stand behind this value"
    st.log({"kind": "resolve", "ref": ref, "shown": [r["ref"] for r in out.get("records") or []]})
    return out


def resolve_many(st: Store, refs: list[str], n: int = 5, pick: str = "spread") -> dict[str, Any]:
    """The rows behind several refs at once (a selection a card made: a brushed range, the runs of a group), as one
    set: their row sets merged, how many, and up to n rows read back, spread across all of them."""
    if len(refs) == 1:
        return resolve(st, refs[0], n=n, pick=pick)
    rowsets: list[str] = []
    notes: list[str] = []
    queries: list[str] = []
    whys: list[str] = []
    bad = 0
    for ref in refs[:2000]:
        try:
            r = resolve(st, ref, n=0, pick=pick)
        except R.RefError as e:
            bad += 1
            if len(notes) < 3:
                notes.append(f"{ref}: {e}")
            continue
        if r.get("why") and r["why"] not in whys:
            whys.append(r["why"])
        rowsets.extend(r.get("rows") or [])
        for c in r.get("chain") or []:
            if c.get("step") == "query" and c.get("id") not in queries:
                queries.append(c["id"])
    rowsets = documents(st, _merge(rowsets))
    if bad:
        notes.insert(0, f"{bad} of the {len(refs)} refs name nothing")
    out: dict[str, Any] = {"ref": " ".join(refs[:3]) + (f" … ({len(refs)} refs)" if len(refs) > 3 else ""), "refs": len(refs),
                           "chain": [{"step": "selection", "refs": len(refs), "queries": queries}], "rows": rowsets, "notes": notes,
                           "about": f"{len(refs)} rows of {', '.join(queries) or 'the card'}"}
    try:
        files_only = all(R.parse(x)["kind"] in ("file", "table") for x in rowsets)
        out["count"] = None if files_only else R.count(rowsets)
        out["records"] = records(st, rowsets, n, pick) if rowsets and not files_only and n else []
    except R.RefError as e:
        out["error"] = str(e)
        out["records"] = []
    # what the files call their entries (records, rows, lines), as coverage counts them
    out.update(entries_of(st, rowsets))
    if whys:
        out["why"] = whys[0] if len(whys) == 1 else f"{whys[0]} (and {len(whys) - 1} more reasons)"
    return out


def _resolve_query(st: Store, p: dict[str, Any], chain: list, notes: list) -> list[str]:
    q = Q.get(st, p["query"])
    if not q:
        raise R.RefError(f"no query {p['query']}")
    stale = Q.stale_inputs(st, q)
    step: dict[str, Any] = {"step": "query", "id": q["id"], "about": q.get("about"), "lineage": q.get("lineage"),
                            "frame": q.get("frame"), "code": q.get("code"),
                            "inputs": [{"path": x["path"], "rows_read": x.get("rows_read")} for x in q.get("inputs") or []]}
    if stale:
        step["stale"] = stale
        notes.append(f"{', '.join(stale)} changed since {q['id']} ran; `thimble run --rerun {q['id']}` runs it again")
    if q.get("uses"):
        step["uses"] = q["uses"]
    chain.append(step)
    frag = {k: p[k] for k in ("row", "keys") if k in p}
    idx = Q.find_rows(q, frag) if frag else []
    if frag and not idx:
        raise R.RefError(f"{q['id']} has no output row {_frag_text(p)}")
    vcol = None
    if frag:
        rows_tbl = q.get("table") or []
        step["rows"] = [{"i": i + 1, **rows_tbl[i]} for i in idx[:20]]
        if "col" in p:
            if len(idx) == 1:
                col = Q.column(rows_tbl[idx[0]], p["col"])
                if col is None:
                    raise R.RefError(f"{q['id']}'s output has no column {p['col']!r}; it has {', '.join(rows_tbl[idx[0]])}")
                step["value"] = rows_tbl[idx[0]][col]
                vcol = col
    if not q.get("rows"):
        notes.append(f"{q['id']} keeps no rows per output row (lineage: query), so each of its values rests on every "
                     "row it read; tally() or a `_refs` column keeps them")
        step["why"] = Q.why_of(st, q, whole=not frag)
        # the query as a whole opens every row it read; one of its output rows has none of its own
        if not frag and q.get("read"):
            return list(q["read"])
        return [x["path"] for x in Q.all_inputs(st, q)]
    why = Q.why_of(st, q, i=idx[0] if frag and len(idx) == 1 else None, col=vcol)
    if why:
        step["why"] = why
    pick = idx if frag else range(len(q["rows"]))
    rowsets: list[str] = []
    for i in pick:
        if i < len(q["rows"]):
            rowsets.extend(Q.value_rows(q, i, vcol) or [])
    rowsets = _merge(rowsets)
    mode = q.get("lineage")
    n = R.count(rowsets)
    v = step.get("value")
    cells = q.get("cells") or []
    if vcol and len(idx) == 1 and idx[0] < len(cells) and isinstance(cells[idx[0]], dict) and cells[idx[0]].get(vcol):
        # a value that keeps rows of its own (a count named by a value, or one its loop kept): what was found by key
        # for its row says nothing about them
        mode = "cell"
    if mode == "superset":
        notes.append(f"these {n:,} rows share the output row's key, but a count column of {q['id']} disagrees: they hold "
                     "more rows than the value counts")
    elif mode == "key":
        notes.append(f"these {n:,} rows share the output row's key in frame `{q.get('frame')}`; no column counts rows, "
                     "so the match could not be checked")
    if isinstance(v, int) and not isinstance(v, bool) and frag and len(idx) == 1:
        step["check"] = "the value equals the number of rows" if v == n else f"the value is {v:,}, the rows are {n:,}"
    return rowsets


def documents(st: Store, rowsets: list[str]) -> list[str]:
    """The row sets with each whole JSON document as its root row (`x.json` as `x.json#/`), so a value that rests on
    a document opens it: a file that is one JSON document is one row. Beside other whole files (a query that loaded
    jsonl files and opened a manifest), the files stay whole files, as before: a count of rows and whole files
    together would count each file as one row."""
    out = [S.document_ref(st.root, x) for x in rowsets]
    if out == rowsets or any("#" not in x for x in out):
        return rowsets
    return list(dict.fromkeys(out))


def _frag_text(p: dict[str, Any]) -> str:
    if "row" in p:
        return f"row={p['row']}"
    return "&".join(f"{k}={v}" for k, v in (p.get("keys") or {}).items())


def _merge(rowsets: list[str]) -> list[str]:
    try:
        return R.merge(rowsets) if len(rowsets) > 1 else rowsets
    except R.RefError:
        return rowsets


def _resolve_object(st: Store, p: dict[str, Any], chain: list, notes: list) -> list[str]:
    obj = O.load(st, p["object"])
    if not obj:
        raise R.RefError(f"no card {p['object']}")
    ptr = p.get("pointer") or ""
    step: dict[str, Any] = {"step": "object", "id": obj["id"], "version": obj.get("version"), "title": obj.get("title")}
    chain.append(step)
    lin = obj.get("lineage") or {}
    if not ptr:
        step["values"] = len(lin.get("bindings") or [])
        rs = []
        for f, x in (lin.get("rows") or {}).items():
            rs.extend(x.get("rowsets") or [])
        return rs
    value, holder, holder_ptr = O.walk(obj.get("data"), ptr)
    step["at"] = ptr
    step["value"] = value
    # the refs a part of the card drawn from this value carries (its row's own ref, or the row's place in the data),
    # so a surface can mark that part
    marks = [f"obj:{obj['id']}#{ptr}"]
    if isinstance(holder, dict):
        marks.append(f"obj:{obj['id']}#{holder_ptr or '/'}")
        if isinstance(holder.get("_ref"), str):
            marks.append(holder["_ref"])
    step["marks"] = list(dict.fromkeys(marks))
    b = O.binding_for(lin, ptr)
    if b:
        chain.append({"step": "binding", "at": b["at"], "from": b["ref"]})
    if isinstance(holder, dict) and holder.get("_rows"):
        rowsets = list(holder["_rows"])
        if b and R.parse(b["ref"])["kind"] == "query":
            q = Q.get(st, R.parse(b["ref"])["query"]) or (lin.get("queries") or {}).get(R.parse(b["ref"])["query"])
            if q:
                chain.append({"step": "query", "id": q["id"], "about": q.get("about"), "lineage": q.get("lineage"),
                              "code": q.get("code")})
                stale = Q.stale_inputs(st, q)
                if stale:
                    notes.append(f"{', '.join(stale)} changed since {q['id']} ran")
                if q.get("lineage") in ("superset", "key"):
                    notes.append(f"{q['id']}'s rows were found by key ({q['lineage']}), not kept exactly")
                if (q.get("lineage") == "loop" or q.get("cells")) and isinstance(holder.get("_ref"), str):
                    # a value of a row a loop made: its own rows when the query kept them (a count of one frame), else
                    # the row's, which says why
                    col = ptr.rsplit("/", 1)[-1].replace("~1", "/").replace("~0", "~")
                    rp = R.parse(holder["_ref"]) if holder["_ref"].startswith(q["id"] + "#") else {}
                    frag = {k: rp[k] for k in ("row", "keys") if k in rp}
                    idx = Q.find_rows(q, frag) if frag else []
                    if len(idx) == 1 and col in holder:
                        rowsets = list(Q.value_rows(q, idx[0], col) or rowsets)
                        why = Q.why_of(st, q, i=idx[0], col=col)
                        if why:
                            chain[-1]["why"] = why
                if q.get("why_rows"):
                    # a value of a summary: the card's value rests on all the rows the query read
                    bp = R.parse(b["ref"])
                    frag = {k: bp[k] for k in ("row", "keys") if k in bp}
                    idx = Q.find_rows(q, frag) if frag else []
                    why = Q.why_of(st, q, i=idx[0] if len(idx) == 1 else None)
                    if why:
                        chain[-1]["why"] = why
        n = R.count(rowsets)
        if isinstance(value, int) and not isinstance(value, bool):
            chain[-1]["check"] = "the value equals the number of rows" if value == n else f"the value is {value:,}, the rows are {n:,}"
        return rowsets
    if isinstance(holder, dict) and isinstance(holder.get("ref"), str):
        cp = R.parse(holder["ref"])
        if cp["kind"] in ("query", "object"):
            return _resolve_query(st, cp, chain, notes) if cp["kind"] == "query" else _resolve_object(st, cp, chain, notes)
        cite = next((c for c in lin.get("cites") or [] if c.get("ref") == holder["ref"]), None)
        if cite and cite.get("hash"):
            try:
                now = S.fetch(st.root, holder["ref"], limit=1)
                if now and S.row_hash(now[0].raw) != cite["hash"]:
                    moved = S.relocate(st.root, holder["ref"], cite["hash"])
                    notes.append(f"{holder['ref']} changed since the card was saved" + (f"; its row is now at {moved}" if moved else ""))
                    if moved:
                        return [moved]
            except R.RefError as e:
                notes.append(str(e))
        return [holder["ref"]]
    if b and R.parse(b["ref"])["kind"] == "query":
        return _resolve_query(st, R.parse(b["ref"]), chain, notes)
    notes.append("Claude wrote this value into the card; no query or row stands behind it")
    step["why"] = "Claude wrote this value into the card, and no query or row stands behind it"
    return []


# ------------------------------------------------------------------ coverage


# A file's status, strongest first, and how the text says each:
#   seen       some of its lines entered Claude's context (read, printed, shown by thimble rows or a search, or printed
#              as rows of a query's output)
#   model      only a label's model read some of its records (`thimble label --prompt`)
#   searched   a search went over it, and which matching lines it showed is not known (grep in the shell)
#   computed   a query or a rule label (regex, code) went over its rows; none of them entered a context
#   named      it was only named, listed or counted (wc, ls, find, git ls-files, grep -c)
#   not read   nothing touched it (the text and the pane say `none`)
# Only seen counts as in Claude's context: the bar's share, a card's snapshot and the observer's "not seen" follow it.
SEEN = ("seen",)
ORDER = ["seen", "model", "searched", "computed", "named", "not read"]
SAID = {"seen": "read", "model": "read by a label's model", "searched": "searched", "computed": "computed over",
        "named": "counted", "not read": "not touched"}
# Each file is counted in its own unit: records of a JSONL or JSON file, rows of a table, lines of text, pages of a
# PDF, and an image, a sound or any other file as one whole file (seen or not). The coverage pane says them the same.
UNITS = ["records", "rows", "lines", "pages", "file"]
UNIT_OF_KIND = {"jsonl": "records", "transcript": "records", "json": "records", "csv": "rows", "sqlite": "rows",
                "markdown": "lines", "diff": "lines", "text": "lines", "pdf": "pages"}
ONE = {"records": "record", "rows": "row", "lines": "line", "pages": "page", "file": "file"}
# what a query or a label goes over of a file whose rows are not its unit: a Markdown file's sections, a diff's hunks
ROW_WORD = {"markdown": "sections", "diff": "hunks"}
ONE.update(sections="section", hunks="hunk", entries="entry")
# programs that only list files by name: a file they named and nothing else touched is not touched
LISTS = {"ls", "find", "tree", "du", "stat", "file", "git", "fd"}


def entry_word(kind: str | None) -> str | None:
    """What one file kind's entries are called, the word coverage counts it in: records of JSON and JSONL, rows of a
    table, lines of text (a Markdown file's sections, a diff's hunks); None for a file with no entries (an image, a
    PDF)."""
    unit = ROW_WORD.get(kind or "") or UNIT_OF_KIND.get(kind or "")
    return unit if unit in ("records", "rows", "lines", "sections", "hunks") else None


def entries_of(st: Store, rowsets: list[str]) -> dict[str, Any]:
    """The word for the entries behind a value: the word of the kind most of them come from, `entries` when no kind
    holds most of them, and None when they are whole files with no entries. {"unit": plural, "unit_one": singular}."""
    by: dict[str | None, int] = defaultdict(int)
    for x in rowsets:
        try:
            n = R.count([x]) or 1
        except Exception:  # noqa: BLE001 — a row set it cannot count still names its file
            n = 1
        by[entry_word(S.kind_of_file(st.root, x.split("#")[0]))] += n
    if not by:
        return {"unit": None, "unit_one": None}
    word, most = max(by.items(), key=lambda kv: kv[1])
    if most * 2 <= sum(by.values()):
        word = "entries"
    return {"unit": word, "unit_one": ONE.get(word) if word else None}
# the line ranges and search hits kept per file for the coverage pane
RANGES_MAX = 300
HITS_MAX = 400
# a query's output rows printed whole: pandas shows a table of up to this many rows, else its first and last five
PRINTED_ALL = 60
PRINTED_ENDS = 5


def _ranges_len(ranges: list[tuple[int, int]]) -> int:
    n, end = 0, 0
    for a, b in sorted(ranges):
        if b <= end:
            continue
        n += b - max(a, end + 1) + 1
        end = b
    return n


def _merged(ranges: list[tuple[int, int]], cap: int = RANGES_MAX) -> list[list[int]]:
    """Line ranges joined where they touch or overlap, in order, at most `cap` of them."""
    out: list[list[int]] = []
    for a, b in sorted((min(a, b), max(a, b)) for a, b in ranges):
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out[:cap]


def _line_of(ref: str) -> int | None:
    m = re.search(r"(?:^|#)L(\d+)", ref)
    return int(m.group(1)) if m else None


def type_of(path: str) -> str:
    """A file's type as the coverage pane groups it: its extension (`jsonl`, `py`), else `no extension`."""
    return Path(path).suffix.lower().lstrip(".") or "no extension"


# a source row's ref as a tool's output names it: a path, `#`, and the row's place in its file (revisions.jsonl#L4111,
# runs.csv#row=3, forge.db#prs/12, run.json#/messages/3)
REF_IN_TEXT = re.compile(r"[^\s'\"`()\[\]<>{}|#=:,]+#[^\s'\"`()\[\]<>{}|#]+")
PRINTED_REFS_MAX = 2000


def printed_refs(text: str, cap: int = PRINTED_REFS_MAX) -> list[str]:
    """The row refs a tool's output names, once each, in order (hooks/kernel.ts keeps the same of a Bash output). A ref
    cut short by its printer (`…`, `...`) names no row."""
    out: dict[str, None] = {}
    for m in REF_IN_TEXT.finditer(text or ""):
        t = m.group(0)
        if t.endswith(("…", "...")):
            continue
        out.setdefault(t.rstrip(".,;:"), None)
        if len(out) >= cap:
            break
    return list(out)


def _query_printed(st: Store, qid: str) -> dict[str, Any] | None:
    try:
        q = Q.get(st, qid)
    except Exception:  # noqa: BLE001 — a query that does not read shows no rows
        return None
    if not q or q.get("error") or not str(q.get("stdout") or "").strip():
        return None
    return q


def _printed_rows(q: dict[str, Any] | None) -> list[str]:
    """The source rows a query printed whole: its output rows that each stand for one source row (a listing of rows, not
    a count), as many as pandas prints of its table. An aggregate's rows stand for many rows, whose text never showed."""
    if not q:
        return []
    rows = q.get("rows") or []
    idx = range(len(rows)) if len(rows) <= PRINTED_ALL else [*range(PRINTED_ENDS), *range(len(rows) - PRINTED_ENDS, len(rows))]
    out = []
    for i in idx:
        sets = rows[i] if isinstance(rows[i], list) else [rows[i]]
        try:
            if R.count(sets) == 1:
                out.extend(R.expand(sets))
        except Exception:  # noqa: BLE001 — a row set that does not read is no printed row
            continue
    return out


def _page_ranges(pages: Any, total: int) -> list[tuple[int, int]]:
    """The pages a Read of a PDF names (`"3"`, `"1-5"`, `"1-3, 8"`), else all of them; each within the PDF."""
    if not pages:
        return [(1, total)]
    out = []
    for part in str(pages).split(","):
        m = re.match(r"\s*(\d+)\s*(?:-\s*(\d+))?\s*$", part)
        if m:
            a = int(m.group(1))
            b = int(m.group(2) or a)
            a, b = max(1, min(a, b)), min(total, max(a, b))
            if a <= b:
                out.append((a, b))
    return out or [(1, total)]


def _add_units(into: dict[str, dict[str, int]], o: dict[str, Any]) -> None:
    """A file's units added to a group's, by unit: all, read, read by a label's model, computed over; and files."""
    u = into.setdefault(o["unit"], {"units": 0, "seen": 0, "model": 0, "computed": 0, "files": 0, "seen_files": 0})
    u["units"] += o["units"]
    u["seen"] += o["seen_units"]
    u["model"] += o["model_units"]
    u["computed"] += o["computed_units"]
    u["files"] += 1
    u["seen_files"] += int(o["seen"])


def _units_list(by: dict[str, dict[str, int]]) -> list[dict[str, Any]]:
    return [{"unit": k, **by[k]} for k in UNITS if k in by]


def amount(unit: str, part: float, total: int, other: bool = False) -> str:
    """Part of a total in a unit, as the coverage pane says it: `3 of 14,591 records (0.02%)`; whole files have no
    share (`1 of 2 files`, or `other files` beside other units)."""
    if unit == "file":
        return f"{_n(part)} of {total:,} {'other ' if other else ''}{'file' if total == 1 else 'files'}"
    return f"{_n(part)} of {total:,} {ONE[unit] if total == 1 else unit} ({percent(part / total if total else 0)})"


def amounts(units: list[dict[str, Any]], key: str = "seen") -> str:
    """Each unit's part, joined: `7 of 42,205 records (0.01%), 2 of 12 pages (16%) and 1 of 2 other files`."""
    mixed = len(units) > 1
    bits = [amount(u["unit"], u[key], u["units"], mixed) for u in units if key == "seen" or u[key]]
    return bits[0] if len(bits) == 1 else ", ".join(bits[:-1]) + " and " + bits[-1] if bits else ""


def coverage(st: Store, session: str | None = "") -> dict[str, Any]:
    """What this session (or `session`, or all sessions for None) did with every source file, file by file, by group of
    like files (S.group_of, as the text says them; S.pattern_of, as the coverage pane does) and by file type. It keeps
    apart what entered Claude's context (seen), what a label's model read, and what a query or a rule only computed
    over; only seen counts as read. Each file also says which of its lines were seen (`ranges`) and which lines a search
    showed (`hit_lines`), for the coverage pane."""
    from . import labels as LB

    files = S.list_files(st.root)
    cnt = S.counts(st.root, files, st.cache / "counts.json")
    unit_of = {f: UNIT_OF_KIND.get(cnt.get(f, {}).get("kind") or "", "file") for f in files}
    per: dict[str, dict[str, Any]] = {f: {"computed": 0, "queries": [], "shown": set(), "lines": [], "searched": False,
                                          "matched": 0, "named": False, "hits": set(), "by": set(), "searched_by": set(),
                                          "model": 0, "labels": set(), "pages": [], "whole": False}
           for f in files}

    def seen_ref(ref: str) -> None:
        f = ref.split("#")[0]
        if f in per:
            # a row's line, or the lines a row spans (a section of a Markdown file: `#L12-40`)
            m = re.search(r"#L(\d+)(?:-L?(\d+))?", ref)
            if m:
                a = int(m.group(1))
                per[f]["lines"].append((a, max(a, int(m.group(2) or a))))
            else:
                per[f]["shown"].add(ref)

    def seen_named(refs: list[str], cwd: str | None = None) -> None:
        """Rows a tool's output named by their refs: each ref of one row of a source file reached Claude's context with
        the output (a section of a Markdown file is one row, though it spans lines). Paths are the root's, or the
        command's folder's."""
        for t in refs:
            path, _, frag = str(t).partition("#")
            if not frag:
                continue
            f = path if path in per else st.rel(str(Path(cwd) / path) if cwd and not Path(path).is_absolute() else path)
            if f not in per:
                continue
            ref = f"{f}#{frag}"
            try:
                p = R.parse(ref)
                n = R.size(p)
            except Exception:  # noqa: BLE001 — words after a `#` that name no row
                continue
            nums = p.get("nums") or []
            section = (p.get("kind") == "lines" and bool(nums) and cnt.get(f, {}).get("kind") in ("markdown", "diff")
                       and nums == list(range(nums[0], nums[-1] + 1)))
            if p.get("kind") != "file" and (n == 1 or section):
                seen_ref(ref)

    label_names: set[str] = set()
    for r in st.ledger(session):
        k = r.get("kind")
        if k == "query" and not r.get("error"):
            for f, n in (r.get("loaded") or {}).items():
                if f in per:
                    per[f]["computed"] = max(per[f]["computed"], int(n or 0)) or per[f]["computed"]
                    per[f]["queries"].append(r.get("id"))
                    if not n:
                        per[f]["named"] = True
                        per[f]["by"].add("thimble")
            # rows of its output printed whole entered Claude's context, and so did each row its printed output names
            # by its ref (a script that prints `r._ref` beside a row's fields), as far as the output Claude read goes
            q = _query_printed(st, str(r.get("id") or ""))
            for ref in _printed_rows(q):
                seen_ref(ref)
            if q:
                seen_named(printed_refs(str(q.get("stdout") or "")[: Q.CUT]))
        elif k in ("rows", "resolve"):
            for ref in r.get("shown") or []:
                f = ref.split("#")[0]
                if f in per:
                    # rows a search found are its matches, as grep's lines are: shown, so seen
                    if r.get("search"):
                        per[f]["hits"].add(ref)
                    seen_ref(ref)
            for f in r.get("scanned") or []:
                if f in per:
                    per[f]["searched"] = True
        elif k == "label" and r.get("name"):
            label_names.add(str(r["name"]))
    # the labels this session made: a model's reads of a --prompt label's records, a rule's pass over the others
    for name in sorted(label_names):
        lab = LB.load(st, name)
        if not lab:
            continue
        model: dict[str, int] = defaultdict(int)
        ruled: dict[str, int] = defaultdict(int)
        for ref, u in (lab.get("units") or {}).items():
            f = ref.split("#")[0]
            if f not in per:
                continue
            if u.get("by") == "model":
                model[f] += 1
            elif u.get("by") in ("regex", "code"):
                ruled[f] += 1
        for f, n in model.items():
            per[f]["model"] += n
            per[f]["labels"].add(name)
        for f, n in ruled.items():
            per[f]["computed"] = max(per[f]["computed"], n)
            per[f]["labels"].add(name)
    root = str(st.root)
    for s in st.seen(session):
        tool = s.get("tool")
        if tool == "Read":
            f = st.rel(s.get("file") or "")
            if f in per and unit_of[f] == "pages":
                # the pages it read (`pages: "1-5"`), else all of them
                per[f]["pages"].extend(_page_ranges(s.get("pages"), cnt.get(f, {}).get("rows") or 1))
            elif f in per and unit_of[f] == "file":
                # an image (or any other file) viewed with Read is seen whole
                per[f]["whole"] = True
            elif f in per:
                a, b = s.get("from"), s.get("to")
                if a is None or b is None:
                    a, b = 1, max(1, cnt.get(f, {}).get("lines") or 1)
                per[f]["lines"].append((int(a), int(b)))
        elif tool == "Grep":
            scope = st.rel(s.get("path") or s.get("cwd") or root)
            if scope is None:
                continue
            glob = s.get("glob") or ""
            # a search that showed lines leaves its files searched (the lines it showed are seen); one that showed only
            # names or counts, named
            lines = s.get("mode") == "content" or (s.get("mode") is None and bool(s.get("lines")))
            for f in files:
                if unit_of[f] in ("pages", "file"):
                    continue  # a search skips a binary file
                inside = scope in (".", "") or f == scope or f.startswith(scope.rstrip("/") + "/")
                if inside and (not glob or fnmatch.fnmatch(Path(f).name, glob) or fnmatch.fnmatch(f, glob)):
                    per[f]["searched" if lines else "named"] = True
                    if not lines:
                        per[f]["by"].add("Grep")
            for fp in s.get("files") or []:
                f = st.rel(fp)
                if f in per:
                    per[f]["matched"] += 1
            for fp, ns in (s.get("lines") or {}).items():
                f = st.rel(fp)
                if f in per:
                    per[f]["hits"].update(f"L{n}" for n in ns)
                    per[f]["lines"].extend((int(n), int(n)) for n in ns)
        elif tool == "Bash":
            cmd = str(s.get("command") or "")
            if re.match(r"^\s*thimble(\s|$)", cmd):
                continue
            # rows its output named by their refs (a script that printed rows with their refs)
            seen_named(s.get("refs") or [], s.get("cwd"))
            # what reached Claude is at most the lines the command printed (a long output is cut)
            left = s.get("out_lines")
            for f, how, span, prog in SH.shows(cmd, files, root, s.get("cwd"), lambda f: cnt.get(f, {}).get("lines") or 0):
                x = per.get(f)
                if x is None:
                    continue
                if how == "read" and unit_of[f] in ("pages", "file"):
                    # a file with no lines printed whole (cat of an image or a PDF)
                    x["whole"] = True
                    continue
                if how == "read" and span:
                    a, b = span
                    if left is not None:
                        b = min(b, a + int(left) - 1)
                        left = max(0, int(left) - max(0, b - a + 1))
                    if a <= b:
                        x["lines"].append((a, b))
                        continue
                    how = "named"
                x["searched" if how == "searched" else "named"] = True
                x["searched_by" if how == "searched" else "by"].add(prog)
    out_files = []
    group = S.group_of(files)
    pattern = S.pattern_of(files)
    for f in files:
        c, x = cnt.get(f, {}), per[f]
        rows, lines = c.get("rows", 0), c.get("lines", 0)
        unit = unit_of[f]
        seen_lines = min(_ranges_len(x["lines"]), lines or _ranges_len(x["lines"]))
        pages = _merged(x["pages"]) if unit == "pages" and not x["whole"] else ([[1, max(1, rows)]] if unit == "pages" else [])
        units = 1 if unit == "file" else lines if unit == "lines" else rows
        if unit == "pages":
            seen_units = min(rows, _ranges_len([tuple(r) for r in pages]))
        elif unit == "file":
            seen_units = int(x["whole"])
        else:
            seen_units = 0
        seen = bool(seen_lines or x["shown"] or seen_units)
        status = ("seen" if seen else "model" if x["model"] else "searched" if x["searched"] else
                  "computed" if x["computed"] else "named" if x["named"] else "not read")
        # touched: some of it seen, or a query, a rule, a model, a search, a count or a program went over it; a file
        # only listed by name (ls, find) is not touched
        listed = status == "named" and bool(x["by"]) and x["by"] <= LISTS
        computed = min(x["computed"], rows) if rows else x["computed"]
        model = min(x["model"], rows) if rows else x["model"]
        if unit in ("pages", "file"):
            share = seen_units / max(1, units)
        else:
            share = min(1.0, seen_lines / max(1, lines or rows) + len(x["shown"]) / max(1, rows)) if seen and rows else 0.0
            if unit == "lines":
                seen_units = seen_lines
            elif c.get("kind") == "csv" and lines == rows + 1:
                # a table's rows are its lines after the header
                body = [(max(2, a), b) for a, b in x["lines"] if b >= 2]
                seen_units = min(rows, _ranges_len(body) + len(x["shown"]))
            else:
                seen_units = max(1, round(share * units)) if seen and units else 0
        seen_rows = share * rows
        # the parts of its rows, apart, as the pane draws them: seen, then read by a label's model, then only computed
        # over (each part what the one before it leaves, at most)
        model_part = max(0.0, min(rows - seen_rows, model - seen_rows)) if rows else 0.0
        computed_part = max(0.0, min(rows - seen_rows - model_part, computed - seen_rows - model_part)) if rows else 0.0
        # the same parts in the file's unit (a Markdown file's rows are its sections, its unit its lines)
        per_unit = units / rows if rows else 0.0
        out_files.append({"path": f, "kind": c.get("kind"), "unit": unit, "units": units, "seen_units": seen_units,
                          "model_units": round(model_part * per_unit), "computed_units": round(computed_part * per_unit),
                          "pages": pages, "rows": rows, "lines": lines, "status": status,
                          "seen": seen, "read": seen, "touched": status != "not read" and not listed, "listed": listed, "share": share,
                          "seen_lines": seen_lines, "read_lines": seen_lines, "seen_rows": round(seen_rows),
                          "model": model, "model_rows": round(model_part), "computed": computed,
                          "computed_rows": round(computed_part), "labels": sorted(x["labels"]),
                          "queries": sorted(set(q for q in x["queries"] if q)),
                          "shown": len(x["shown"]), "searched": x["searched"], "matched": x["matched"],
                          "hits": len(x["hits"]), "named": x["named"], "by": sorted(x["by"]),
                          "searched_by": sorted(x["searched_by"]), "type": type_of(f), "group": group.get(f, f),
                          "pattern": pattern.get(f, f),
                          # which lines entered Claude's context, and which of them a search showed
                          "ranges": _merged(x["lines"]),
                          "hit_lines": sorted({n for n in map(_line_of, x["hits"]) if n})[:HITS_MAX]})
        out_files[-1]["said"] = file_line(out_files[-1])
    groups: dict[str, dict[str, Any]] = {}
    patterns: dict[str, dict[str, Any]] = {}
    types: dict[str, dict[str, Any]] = {}
    for e in out_files:
        for key, name, into in ((e["group"], "group", groups), (e["pattern"], "pattern", patterns), (e["type"], "type", types)):
            G = into.setdefault(key, {name: key, "files": 0, "rows": 0, "seen_rows": 0.0, "model_rows": 0, "computed_rows": 0,
                                      "touched": 0, "seen_files": 0, "by_status": defaultdict(int), "computed": 0, "units": {}})
            _add_units(G["units"], e)
            G["files"] += 1
            G["rows"] += e["rows"]
            G["seen_rows"] += e["share"] * e["rows"]
            G["model_rows"] += e["model_rows"]
            G["computed_rows"] += e["computed_rows"]
            G["touched"] += int(e["touched"])
            G["seen_files"] += int(e["seen"])
            G["by_status"][e["status"]] += 1
            G["computed"] += e["computed"]
    for G in [*groups.values(), *patterns.values(), *types.values()]:
        G["units"] = _units_list(G["units"])
        G["by_status"] = dict(G["by_status"])
        G["seen_rows"] = round(G["seen_rows"])
        G["read_rows"] = G["seen_rows"]
    rows_all = sum(o["rows"] for o in out_files)
    seen_rows = sum(o["share"] * o["rows"] for o in out_files)
    model_rows = sum(o["model_rows"] for o in out_files)
    computed_rows = sum(o["computed_rows"] for o in out_files)
    not_seen = [o for o in out_files if not o["seen"]]
    seen_files = len(out_files) - len(not_seen)
    touched_files = sum(1 for o in out_files if o["touched"])
    # the bar's share is of files touched: each file counts once, whatever its unit, and a file a query counted over
    # counts as much as one Claude read; 0 means Claude looked at no file at all
    total = {"files": len(files), "rows": rows_all, "touched_files": touched_files,
             "touched_share": touched_files / len(files) if files else 0.0, "seen_files": seen_files,
             "seen_rows": round(seen_rows), "seen_share": seen_files / len(files) if files else 0.0,
             "model_files": sum(1 for o in out_files if o["model"]), "model_rows": model_rows,
             "model_share": model_rows / rows_all if rows_all else 0.0,
             "computed_files": sum(1 for o in out_files if o["computed_rows"]), "computed_rows": computed_rows,
             "computed_share": computed_rows / rows_all if rows_all else 0.0,
             "not_seen_files": len(not_seen), "not_seen_rows": sum(o["rows"] for o in not_seen),
             "untouched_files": sum(1 for o in out_files if not o["touched"])}
    every: dict[str, dict[str, int]] = {}
    unread: dict[str, dict[str, int]] = {}
    for o in out_files:
        _add_units(every, o)
        if not o["seen"]:
            _add_units(unread, o)
    total["units"] = _units_list(every)
    total["not_seen_units"] = _units_list(unread)
    # the names earlier readers know: read is seen
    total.update(read_files=total["seen_files"], read_rows=total["seen_rows"], read_share=total["seen_share"],
                 not_read_files=total["not_seen_files"], not_read_rows=total["not_seen_rows"])
    return {"root": str(st.root), "session": st.session if session == "" else session, "files": out_files,
            "groups": sorted(groups.values(), key=lambda g: -g["rows"]),
            "patterns": sorted(patterns.values(), key=lambda g: (-g["rows"], g["pattern"])),
            "types": sorted(types.values(), key=lambda g: (-g["rows"], g["type"])),
            "total": total}


def _by(o: dict[str, Any]) -> str:
    by = o.get("by") or []
    return f" ({', '.join(by[:4])})" if by else ""


def _n(x: float) -> str:
    return format(int(round(x)), ",")


def file_line(o: dict[str, Any]) -> str:
    """What happened to one file, in its own unit, as the coverage pane says it: how much of it Claude read (an image
    or another whole file: seen), what a label's model read, what a query or a rule computed over, or why none of it
    entered a context; `none` when nothing touched it. It never lists which rows were read."""
    s = o["status"]
    rows, unit = o["rows"], o.get("unit") or "lines"
    rw = ROW_WORD.get(o.get("kind") or "", unit)
    bits = []
    if s == "seen":
        bits.append("seen" if unit == "file" else "read " + amount(unit, o.get("seen_units", 0), o.get("units", 0)))
    if o.get("model"):
        bits.append(f"a label's model read {o['model']:,} of {rows:,} {rw}" + (f" ({', '.join(o['labels'][:3])})" if o.get("labels") else ""))
    if o["computed"]:
        whole = o["computed"] >= rows > 0
        what = [*o["queries"][:4], *(lb for lb in o.get("labels") or [] if not o.get("model"))][:4]
        bits.append(f"computed over {'all ' + format(rows, ',') if whole else format(o['computed'], ',') + ' of ' + format(rows, ',')} {rw}"
                    + (f" ({', '.join(what)})" if what else ""))
    if s == "searched":
        by = o.get("searched_by") or []
        bits.append("searched" + (f" by {', '.join(by[:4])}" if by else "") + "; which lines it showed is not known")
    if s == "named":
        bits.append(f"only listed by name{_by(o)}" if o.get("listed") else f"only named or counted{_by(o)}")
    if s in ("model", "computed", "named"):
        bits[-1] += "; Claude read none of it"
    if not bits:
        bits.append("none")
    return "; ".join(bits)


def _few(paths: list[str], n: int = 4) -> str:
    return ", ".join(paths[:n]) + (f" and {len(paths) - n:,} more" if len(paths) > n else "")


def coverage_text(cov: dict[str, Any], max_lines: int = 40) -> str:
    t = cov["total"]
    head = f"Coverage of {'every session' if cov['session'] is None else 'this session'} · {t['files']:,} file{'s' if t['files'] != 1 else ''}"
    sizes = _sizes(t.get("units") or [])
    lines = [head + (f": {sizes}" if sizes else "")]
    ranked = sorted(cov["files"], key=lambda o: (ORDER.index(o["status"]), o["path"]))
    if len(cov["files"]) <= max_lines:
        for o in ranked:
            lines.append(f"  {o['path']}  {o.get('said') or file_line(o)}")
    else:
        shown = [g for g in cov["groups"] if g["files"] > 1 or set(g["by_status"]) != {"not read"}][:12]
        for g in shown:
            parts = [f"{n} {SAID[k]}" for k, n in sorted(g["by_status"].items(), key=lambda kv: ORDER.index(kv[0]))]
            lines.append(f"  {g['group']}  {g['files']:,} file{'s' if g['files'] != 1 else ''}, {_sizes(g.get('units') or [])}: {', '.join(parts)}")
        others = [g for g in cov["groups"] if g not in shown]
        if others:
            lines.append(f"  {sum(g['files'] for g in others):,} other files: "
                         + ", ".join(f"{sum(g['by_status'].get(k, 0) for g in others)} {SAID[k]}" for k in ORDER if any(g['by_status'].get(k) for g in others)))
        some = [o for o in ranked if o["status"] in ("seen", "model", "searched", "computed")]
        if some:
            lines.append("  read, read by a label's model, searched or computed over:")
            for o in some[:15]:
                lines.append(f"    {o['path']}  {o.get('said') or file_line(o)}")
            if len(some) > 15:
                lines.append(f"    … and {len(some) - 15} more")
    lines.append(coverage_sentence(cov))
    return "\n".join(lines)


def _sizes(units: list[dict[str, Any]]) -> str:
    """A set of files' sizes, each in its unit: `42,205 records, 12 pages and 2 other files`."""
    mixed = len(units) > 1
    bits = [f"{u['units']:,} {'other ' if mixed else ''}{'file' if u['units'] == 1 else 'files'}" if u["unit"] == "file"
            else f"{u['units']:,} {ONE[u['unit']] if u['units'] == 1 else u['unit']}" for u in units]
    return bits[0] if len(bits) == 1 else ", ".join(bits[:-1]) + " and " + bits[-1] if bits else ""


def percent(part: float) -> str:
    """A share as the thimble line says it (shell.tsx percent): 34%, a decimal under 1%, and 100% only when all."""
    if not part > 0:
        return "0%"
    if part >= 1:
        return "100%"
    p = 100 * part
    if p < 0.01:
        return "<0.01%"
    if p < 1:
        d = 2 if p < 0.1 else 1
        return f"{int(p * 10 ** d) / 10 ** d:.{d}f}%"
    return f"{min(99, int(p + 0.5))}%"


def coverage_sentence(cov: dict[str, Any]) -> str:
    """What the session did, in words that claim no more than happened: first the files touched (the bar's number: a
    file is touched when some of it entered Claude's context, or a query, a rule, a search, a count or a program went
    over it), then what was read, each unit apart; what a label's model read and what a query or a rule computed over
    are said apart. A file only listed by name is not touched."""
    t = cov["total"]
    if not t["files"]:
        return "There are no files."
    units = t.get("units") or []
    share = amounts(units)
    touched, files = t.get("touched_files", 0), t["files"]
    if not touched:
        out = [f"Touched 0 of {files:,} files: Claude has not looked at any of them."]
    else:
        out = [f"Touched {touched:,} of {files:,} files (read, searched, counted or computed over)."]
    if not t["not_seen_files"]:
        out.append(f"Read all {files:,} files, at least in part: {share} entered Claude's context.")
    elif t["seen_files"]:
        out.append(f"Read {t['seen_files']:,} of the files, at least in part: {share} entered Claude's context.")
    elif touched:
        out.append("Read: no part of any file entered Claude's context.")
    model, computed = amounts(units, "model"), amounts(units, "computed")
    if model:
        out.append(f"Read by a label's model: {model}.")
    if computed:
        out.append(f"Computed over by a query or a rule label, none of it read: {computed}.")
    if t["not_seen_files"]:
        by = {k: [o["path"] for o in cov["files"] if (o["status"] == k and o["touched"]) or (k == "not read" and not o["touched"])]
              for k in ("model", "searched", "computed", "named", "not read")}
        words = {"model": "read only by a label's model", "searched": "searched, which lines a search showed is not known",
                 "computed": "only computed over", "named": "only named or counted", "not read": "not touched"}
        parts = [f"{len(by[k]):,} {words[k]} ({_few(by[k])})" for k in ("not read", "computed", "model", "named", "searched") if by[k]]
        n = t["not_seen_files"]
        sizes = _sizes(t.get("not_seen_units") or [])
        out.append(f"Not read: {n:,} file{'s' if n != 1 else ''}{f' ({sizes})' if sizes else ''}: " + "; ".join(parts) + ".")
    return " ".join(out)


def object_coverage(st: Store, obj: dict[str, Any]) -> dict[str, Any]:
    """Which source files feed an object's values, and which do not."""
    files = S.list_sources(st.root)
    cnt = S.counts(st.root, files, st.cache / "counts.json")
    rows = (obj.get("lineage") or {}).get("rows") or {}
    feeding = []
    for f in files:
        if f in rows:
            feeding.append({"path": f, "rows": rows[f]["count"], "of": cnt.get(f, {}).get("rows", 0)})
    used = {x["path"] for x in feeding}
    for q in ((obj.get("lineage") or {}).get("queries") or {}).values():
        for x in q.get("inputs") or []:
            if x["path"] not in used and x["path"] in cnt:
                feeding.append({"path": x["path"], "rows": None, "of": cnt[x["path"]].get("rows", 0), "how": "read by a query; no rows per value"})
                used.add(x["path"])
    others = [f for f in files if f not in used]
    return {"object": obj["id"], "feeding": feeding, "not_feeding": others,
            "session": (obj.get("lineage") or {}).get("coverage")}
