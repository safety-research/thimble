"""The ref grammar: parse/format, record_blocks, resolve.

    <path>#L<n>                   record/line n (1-based) of a jsonl or text file; a path may hold spaces inside it
                                  (`run 1/agent one.jsonl#L3`), and one with no line fragment counts when it looks
                                  like a file (a `/` or an extension)
    <path>#L<n>-L<m>              inclusive range of records/lines
    <path>#L<n>.b<k>              block k (0-based) of record n
    <path>#L<n>.b<k>:c<a>-<b>     char range [a,b) within block k (UTF-16 code units: what the browser counts)
    <db>#<table>/<pk>             a row by primary key (rowid for tables without a single-column pk) of a database file:
                                  <db> is any path ending in .db, .sqlite or .sqlite3, forge.db included,
                                  e.g. `forge.db#prs/12`, `<run>/forge.db#prs/12`, `runs/x/ehr.db#patients/12`
    <db>#<table>                  a whole table of such a database file
    <pdf>#p<n>                    page n (1-based) of a file ending in .pdf; `#page=<n>` reads the same (records.canon)
    <json>#/<pointer>             a value of a JSON document (a file ending in .json) by its JSON pointer (RFC 6901), such
                                  as one record of it (records.py), e.g. `runs.json#/runs/3`
    <csv>#row=<n>                 row n (1-based, after the header line) of a file ending in .csv or .tsv
    card:<cell_id>[@<exec>]       a card (searched across every group of the workspace); `cell:` is read the same
                                  way (cite.CARD_PREFIXES), and format_ref writes `card:`
    card:<cell_id>#<col>/<row>    the <td> at column header <col> / row label <row> of a text/html table output of the card;
                                  the labels are written through cite.encode_label (whitespace, `/`, `|`, `[`, `]`, `*`,
                                  `_`, `~`, backtick, `%`, `#`, `<`, `>`, `&` as %XX) and parse_ref returns them decoded
    card:<cell_id>@out<i>#L<n>    line <n> (1-based) of the text/plain of the card's output bundle with index <i>: the
                                  bundle's stored `_out`, else its position (cite.output_at; notebook.number_outputs keeps
                                  an output's index across a re-run)
    card:<cell_id>@out<i>#L<n>-L<m>  lines <n> to <m> (inclusive) of that output, the range form files have
    concept:<concept_id>          a label (resolved by app.concepts)
    concept:<concept_id>/<value>  one value of a label: its count, as the label's card shows it; the value is written as
                                  the card shows it, raw or through cite.encode_label, and parse_ref returns it decoded
    report:<slug>[#<unit>]        a document, one of its paragraphs (p<id>), a sentence or a heading
    <path>#<locator>              any other part of a file, the locator written in the notation of the file's own type
                                  (`budget.xlsx#Q3!B2:B40`, `paper.pdf#p4`, `poster.psd#layer/Title`): a locator no rule
                                  above reads parses as kind `path` with the locator kept as text, so it resolves to the file
                                  itself and every reader of a whole-file ref opens it; the file type defines what a
                                  subsection is. A locator shaped like the line grammar (`L` alone or `L<digit>…`) that
                                  the line rules refused stays an error, so a mistyped line ref is caught and repaired
                                  rather than read as the file.
    call:<chat>/<n>               a tool call of the orientation whose agent chat is <chat>, with its input and its whole
                                  output (calls.py)
    call:<chat>/<n>#L<a>[-L<b>]   lines <a> to <b> (1-based, inclusive) of that call's output, the range form files have
    chat:<orientation>[#L<a>-L<b>]  the orientation's transcript digest (critique_session.digest), a page of its lines
    view:<slug>                   a view (views.py): its name and what it is for
    view:<slug>/<key>             a unit only that view defines, such as one wiki page's whole thread spread over many
                                  lines of a file; the key is the view's own text and may hold any character but
                                  whitespace

A file ref with a fragment that a view claims and accepts (`posts.jsonl#L60` under a message-board view) keeps its
grammar and resolves as the file's own, then the view's reader supplies the excerpt: the post the line holds, where the
file's own excerpt is the whole record with every field (views.enrich_file_ref). resolve_base is the resolution without
that step, for the check that compares a view's excerpt with the records it cites.

`chat:<id>[#<n>]` is parsed, and `#<n>` is a message anchor, not resolvable. Only an orientation's chat resolves, to its
transcript's digest, and `chat:<id>#L<a>-L<b>` to lines of the digest.

A span written without its card id (`@out0#L15`, `#count/total`) is not a ref: parse_ref raises (bare_span_cause) and
resolve answers 400; cite.qualify_bare_spans adds the id before storage. A file's line cited through the card that shows
it (`card:<id>#runs/a.jsonl#L103.b0:c12-109`) is read as the file's line, and cite.normalise_markup rewrites it that way
before storage.
"""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from . import cite, config

EXCERPT_MAX = 2000
SPAN_CONTEXT_LINES = 2  # lines of context on each side of a card:<id>@out<i>#L<n>[-L<m>] span
CONTEXT_RECORDS = 3
RANGE_MAX_RECORDS = 100

_CELL = re.compile(r"^" + cite.CARD_RE + r"([A-Za-z0-9_-]+)(?:@(\d+))?$")
# span refs into a cell's output: a table td by column/row label, or a line of the i-th output. The column part allows
# whitespace, since a model writes a pandas header raw as often as encoded; it stops at the first `/`.
_CELL_TD = re.compile(r"^" + cite.CARD_RE + r"([A-Za-z0-9_-]+)#([^/]+)/(.+)$")
_CELL_LINE = re.compile(r"^" + cite.CARD_RE + r"([A-Za-z0-9_-]+)@out(\d+)#L(\d+)(?:-L(\d+))?$")  # group 4: the range end, when a range
_CHAT = re.compile(r"^chat:([A-Za-z0-9_-]+)(?:#(\d+))?$")
_CHAT_LINES = re.compile(r"^chat:([A-Za-z0-9_-]+)#L(\d+)(?:-L(\d+))?$")  # lines of an orientation's digest
_CONCEPT = re.compile(r"^concept:([A-Za-z0-9_-]+)(?:/(.+))?$")
_REPORT = re.compile(r"^report:([A-Za-z0-9_-]+)(?:#(p?[A-Za-z0-9_-]+))?$")  # a document, one of its paragraphs (p<pid>) or a sentence or heading
# a view (views.SLUG_RE), or one unit it defines; frontend lib/refs.ts parses the same form
_VIEW = re.compile(r"^view:([a-z0-9][a-z0-9-]{0,39})(?:/(\S+))?$")
# A file's path may hold spaces, never at its ends and never a newline or `#`. A path with a space and no line fragment
# counts only when it looks like a file (_FILE_LIKE), so bracketed prose is not read as a path.
_FP = r"[^#\s](?:[^#\n]*[^#\s])?"
_FP_NO_COLON = r"[^#\s:](?:[^#\n:]*[^#\s:])?"
_FILE_LIKE = re.compile(r"/|\.[A-Za-z0-9]{1,8}$")
# a database file is any path ending in .db/.sqlite/.sqlite3 (corpus.DB_SUFFIXES); frontend lib/refs.ts must accept the same
_DATABASE = re.compile(r"^(" + _FP + r"\.(?:db|sqlite|sqlite3))#([A-Za-z_][A-Za-z0-9_]*)(?:/(.+))?$")
# the records of the other built-in readers (records.py); frontend lib/refs.ts reads the same forms
_PAGE = re.compile(r"^(" + _FP + r"\.[Pp][Dd][Ff])#(?:page=|p)(\d+)$")
_POINTER = re.compile(r"^(" + _FP + r"\.[Jj][Ss][Oo][Nn])#(/[^\n]*)$")
_CSV_ROW = re.compile(r"^(" + _FP + r"\.(?:[Cc][Ss][Vv]|[Tt][Ss][Vv]))#row=(\d+)$")
_SPAN = re.compile(r"^(" + _FP + r")#L(\d+)\.b(\d+):c(\d+)-(\d+)$")
_BLOCK = re.compile(r"^(" + _FP + r")#L(\d+)\.b(\d+)$")
_RANGE = re.compile(r"^(" + _FP + r")#L(\d+)-L(\d+)$")
_RECORD = re.compile(r"^(" + _FP + r")#L(\d+)$")
_PATH = re.compile(r"^(" + _FP_NO_COLON + r")$")
# <path>#<locator>: any part of a file the rules above do not read, kept as text on a whole-file ref (module note)
_LOCATOR = re.compile(r"^(" + _FP_NO_COLON + r")#(\S+)$")
# a file's line cited through the card that shows it: parse_ref reads it as the file's line
_CARD_FILE_LINE = re.compile(r"^" + cite.CARD_RE + r"[A-Za-z0-9_-]+(?:@\d+)?#(" + _FP + r"#L\d.*)$")
_LINE_SHAPED = re.compile(r"^L(?:\d|$)")  # a locator the line rules own: `L`, `L3-5`, `L3.b` are malformed line refs
# A span written without its card id (`@out0#L15`, `#count/total`): a token starting with one of these is never a file,
# and parse_ref refuses it with bare_span_cause.
_BARE_LEAD = ("@", "#")
_BRACKETS = re.compile(r"\[\[([^\[\]]+?)\]\]")


class RefError(Exception):
    """A ref that cannot be resolved. `status` is the HTTP status for the route: 400 malformed, 404 missing."""

    def __init__(self, detail: str, status: int = 404):
        super().__init__(detail)
        self.detail = detail
        self.status = status


# --------------------------------------------------------------------------- grammar


def parse_ref(ref: str) -> dict[str, Any]:
    """Parse a ref string into a dict with a `kind` key. Raises ValueError if it does not match the grammar."""
    ref = ref.strip()
    if m := _CELL.match(ref):
        return {"kind": "cell", "cell_id": m[1], "exec": int(m[2]) if m[2] else None}
    if (m := _CARD_FILE_LINE.match(ref)) and (line := _file_line(m[1])):
        return line
    if m := _CELL_TD.match(ref):
        return {"kind": "cell", "cell_id": m[1], "exec": None, "col": cite.decode_label(m[2]), "row": cite.decode_label(m[3])}
    if m := _CELL_LINE.match(ref):
        out = {"kind": "cell", "cell_id": m[1], "exec": None, "out": int(m[2]), "line": int(m[3])}
        if m[4]:
            out["end_line"] = int(m[4])
        return out
    if m := _CHAT.match(ref):
        return {"kind": "chat", "chat_id": m[1], "event_index": int(m[2]) if m[2] else None}
    if m := _CHAT_LINES.match(ref):
        out = {"kind": "chat", "chat_id": m[1], "event_index": None, "line": int(m[2])}
        if m[3]:
            out["end_line"] = int(m[3])
        return out
    if ref.startswith("call:"):
        from . import calls  # noqa: PLC0415 — calls imports refs lazily too

        hit = calls.parse_ref(ref)
        if hit is None:
            raise ValueError(f"not a ref: {ref!r} (a call is call:<chat>/<n>, and its lines call:<chat>/<n>#L<a>-L<b>)")
        return hit
    if m := _CONCEPT.match(ref):
        value = cite.decode_label(m[2].strip()) if m[2] and m[2].strip() else None
        return {"kind": "concept", "concept_id": m[1], **({"value": value} if value else {})}
    if ref.startswith("label:"):
        # a form a model may write for a label's value: the error names the grammar instead
        raise ValueError(f"not a ref: {ref!r} (a label is concept:<id>, and one of its values concept:<id>/<value>)")
    if m := _REPORT.match(ref):
        return {"kind": "report", "slug": m[1], "unit": m[2]}
    if m := _VIEW.match(ref):
        return {"kind": "view", "slug": m[1], "key": m[2]}
    if ref[:1] in _BARE_LEAD:
        raise ValueError(bare_span_cause(ref))
    if m := _DATABASE.match(ref):
        if m[3]:
            return {"kind": "row", "path": m[1], "table": m[2], "pk": m[3]}
        return {"kind": "table", "path": m[1], "table": m[2]}
    if (m := _PAGE.match(ref)) and int(m[2]) >= 1:
        return {"kind": "page", "path": m[1], "page": int(m[2])}
    if m := _POINTER.match(ref):
        return {"kind": "pointer", "path": m[1], "pointer": m[2]}
    if (m := _CSV_ROW.match(ref)) and int(m[2]) >= 1:
        return {"kind": "csvrow", "path": m[1], "row": int(m[2])}
    if line := _file_line(ref):
        return line
    if (m := _PATH.match(ref)) and (" " not in m[1] or _FILE_LIKE.search(m[1])):
        return {"kind": "path", "path": m[1]}
    if (m := _LOCATOR.match(ref)) and (" " not in m[1] or _FILE_LIKE.search(m[1])):
        if _LINE_SHAPED.match(m[2]):
            raise ValueError(f"not a ref: {ref!r} (a line is <path>#L<n> and a range <path>#L<n>-L<m>)")
        return {"kind": "path", "path": m[1], "locator": m[2]}
    raise ValueError(f"not a ref: {ref!r}")


def _file_line(ref: str) -> dict[str, Any] | None:
    """A file's line, block, span or range of lines (the line forms of parse_ref), or None for any other ref."""
    if m := _SPAN.match(ref):
        return {"kind": "span", "path": m[1], "line": int(m[2]), "block": int(m[3]), "start": int(m[4]), "end": int(m[5])}
    if m := _BLOCK.match(ref):
        return {"kind": "block", "path": m[1], "line": int(m[2]), "block": int(m[3])}
    if m := _RANGE.match(ref):
        return {"kind": "range", "path": m[1], "line": int(m[2]), "end_line": int(m[3])}
    if m := _RECORD.match(ref):
        return {"kind": "record", "path": m[1], "line": int(m[2])}
    return None


def _unwrap_card_line(ref: str) -> str:
    """`ref` itself, or the file's line when it is one cited through a card (module note), so it resolves and reads as
    that line."""
    m = _CARD_FILE_LINE.match(ref.strip())
    return m[1] if m and _file_line(m[1]) else ref


def bare_span_cause(ref: str) -> str:
    """Why a span with no card id in front does not resolve, in plain words: the `detail` of the route's 400 and the
    `why` verify.py carries to the chip's hover."""
    return f"no card named: {ref!r} has no card id in front of it; the form is card:<id>{ref}"


def format_ref(p: dict[str, Any]) -> str:
    """Inverse of parse_ref."""
    k = p["kind"]
    if k == "cell":
        if p.get("col") is not None and p.get("row") is not None:
            return f"card:{p['cell_id']}#{cite.encode_label(p['col'])}/{cite.encode_label(p['row'])}"
        if p.get("out") is not None and p.get("line") is not None:
            return f"card:{p['cell_id']}@out{p['out']}#L{p['line']}" + (f"-L{p['end_line']}" if p.get("end_line") is not None else "")
        return f"card:{p['cell_id']}" + (f"@{p['exec']}" if p.get("exec") is not None else "")
    if k == "chat":
        if p.get("line") is not None:
            return f"chat:{p['chat_id']}#L{p['line']}" + (f"-L{p['end_line']}" if p.get("end_line") is not None else "")
        return f"chat:{p['chat_id']}" + (f"#{p['event_index']}" if p.get("event_index") is not None else "")
    if k == "call":
        from . import calls  # noqa: PLC0415

        return calls.ref(p["chat_id"], p["n"], p.get("line"), p.get("end_line"))
    if k == "concept":
        return f"concept:{p['concept_id']}" + (f"/{p['value']}" if p.get("value") else "")
    if k == "view":
        return f"view:{p['slug']}" + (f"/{p['key']}" if p.get("key") else "")
    if k == "table":  # 'forge.db' only as the default when no path is stored
        return f"{p.get('path') or 'forge.db'}#{p['table']}"
    if k == "row":
        return f"{p.get('path') or 'forge.db'}#{p['table']}/{p['pk']}"
    if k == "page":
        return f"{p['path']}#p{p['page']}"
    if k == "pointer":
        return f"{p['path']}#{p['pointer']}"
    if k == "csvrow":
        return f"{p['path']}#row={p['row']}"
    if k == "record":
        return f"{p['path']}#L{p['line']}"
    if k == "range":
        return f"{p['path']}#L{p['line']}-L{p['end_line']}"
    if k == "block":
        return f"{p['path']}#L{p['line']}.b{p['block']}"
    if k == "span":
        return f"{p['path']}#L{p['line']}.b{p['block']}:c{p['start']}-{p['end']}"
    if k == "path":
        return p["path"] + (f"#{p['locator']}" if p.get("locator") else "")
    raise ValueError(f"unknown ref kind: {k!r}")


def extract_refs(text: str) -> list[str]:
    """All `[[ref]]` occurrences in order, deduplicated (same as frontend refs.ts)."""
    out: list[str] = []
    for m in _BRACKETS.finditer(text):
        r = m[1].strip()
        if "|" in r:  # value-ref [[<display>|<ref>]]: keep only the ref part
            r = r.split("|", 1)[1].strip()
        if r and r not in out:
            out.append(r)
    return out


# --------------------------------------------------------------------------- blocks


def _dumps(obj: Any, indent: int | None = None) -> str:
    return json.dumps(obj, indent=indent, ensure_ascii=False)


def _text(x: Any) -> str:
    if x is None:
        return ""
    return x if isinstance(x, str) else _dumps(x)


def _raw(record: Any) -> dict[str, str]:
    return {"kind": "raw", "text": _dumps(record, indent=2)}


def _content_block(b: Any) -> dict[str, str] | None:
    if not isinstance(b, dict):
        return _raw(b)
    t = b.get("type")
    if t == "text":
        return {"kind": "text", "text": _text(b.get("text"))}
    if t == "tool_use":
        return {"kind": "tool_use", "text": _text(b.get("name")) + "\n" + _dumps(b.get("input"), indent=2)}
    if t == "tool_result":
        c = b.get("content")
        if isinstance(c, list):
            text = "\n".join(_text(x.get("text")) for x in c if isinstance(x, dict) and x.get("type") == "text")
        else:
            text = _text(c)
        return {"kind": "tool_result", "text": text}
    if t == "thinking":
        th = b.get("thinking")
        if not th:
            return None  # redacted/empty thinking: no block at all
        return {"kind": "thinking", "text": _text(th)}
    return _raw(b)


_TEXT_KEYS = ("text", "content", "body", "message", "output", "stdout", "result")


def _shape_text(record: dict) -> str:
    """The longest string under a text-like key at the top level or one dict down (a record shape we do not know)."""
    best = ""
    for k, v in record.items():
        if k in _TEXT_KEYS and isinstance(v, str) and len(v) > len(best):
            best = v
        if isinstance(v, dict):
            for k2, v2 in v.items():
                if k2 in _TEXT_KEYS and isinstance(v2, str) and len(v2) > len(best):
                    best = v2
    return best


def record_blocks(record: Any, kind: str | None = None) -> list[dict[str, str]]:
    """Canonical decomposition of a record into displayable {kind, text} blocks.

    `kind` is the source kind (agent|board|events|prompt|text) when known; otherwise it is inferred from the
    record's shape. The Reader renders exactly these blocks in order, so char offsets in refs are stable.
    """
    if not isinstance(record, dict):
        return [_raw(record)]
    if kind in ("text", "prompt") or (kind is None and set(record) == {"text"}):
        if "text" in record or kind is None:
            return [{"kind": "text", "text": _text(record.get("text"))}]
        # a .jsonl typed as plain text whose records are structured: never an empty block, so the record's own
        # text-like field when it has one, else the record itself
        found = _shape_text(record)
        return [{"kind": "text", "text": found}] if found else [_raw(record)]
    if kind == "board" or (kind is None and "body" in record and "thread_id" in record):
        return [{"kind": "text", "text": _text(record.get("body"))}]
    if kind == "events" or (kind is None and "action" in record and "params" in record):
        if "params" in record:
            return [{"kind": "event", "text": _dumps(record.get("params"))}]
        # an events.jsonl of another shape, with no `params`: the record's text-like field or the record itself
        found = _shape_text(record)
        return [{"kind": "event", "text": found}] if found else [_raw(record)]
    if record.get("type") in ("assistant", "user"):
        msg = record.get("message")
        if isinstance(msg, dict) and "content" in msg:
            content = msg["content"]
            if isinstance(content, str):
                return [{"kind": "text", "text": content}]
            if isinstance(content, list):
                return [blk for blk in map(_content_block, content) if blk is not None]
    return [_raw(record)]


def utf16_slice(text: str, start: int, end: int) -> str:
    """Slice by UTF-16 code units (the offsets a browser Selection reports). Out-of-range bounds are clamped."""
    b = text.encode("utf-16-le", "surrogatepass")
    n = len(b) // 2
    start = max(0, min(start, n))
    end = max(start, min(end, n))
    return b[2 * start : 2 * end].decode("utf-16-le", "replace")


# --------------------------------------------------------------------------- resolve


def _resolve_report(corpus_dir: Path | str, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """A document, a paragraph or a sentence of it as an excerpt: `report:<slug>` is the title, `#p<pid>` the paragraph's
    sentences joined, `#<id>` one sentence or a heading. 404 when the document or the unit is missing."""
    from . import report_types  # lazy: report_types imports refs

    name = config.workspace_for_corpus_dir(corpus_dir) if isinstance(corpus_dir, Path) else str(corpus_dir)
    doc = report_types.read_doc(name, "main", p["slug"])
    if doc is None:  # a frame not yet written
        try:
            frame = report_types.frame_or_doc(name, "main", p["slug"])
            doc = frame[0] if isinstance(frame, tuple) else frame
        except Exception:  # noqa: BLE001
            doc = None
    if not isinstance(doc, dict):
        raise RefError(f"no document {p['slug']!r}", 404)
    unit = p.get("unit")
    meta: dict[str, Any] = {"slug": p["slug"], "title": doc.get("title") or ""}
    if not unit:
        return {"kind": "report", "ref": ref, "excerpt": str(doc.get("title") or ""), "meta": meta}
    if unit.startswith("p"):
        hit = report_types.find_paragraph(doc, unit[1:])
        if hit is not None:
            u, para = hit
            meta.update(section=str(u.get("heading") or ""), paragraph=unit[1:])
            text = " ".join(str(x.get("text") or "") for x in para.get("sentences") or [] if isinstance(x, dict))
            return {"kind": "report", "ref": ref, "excerpt": text, "meta": meta}
    try:
        target = report_types.find_target(doc, unit)
    except Exception as e:  # noqa: BLE001 (an HTTPException from find_target)
        raise RefError(f"no unit {unit!r} in {p['slug']!r}", 404) from e
    u = target.get("unit") or {}
    meta.update(section=str(u.get("heading") or ""), id=unit)
    if target["kind"] == "sentence":
        sent = target["sentence"]
        meta["refs"] = list(sent.get("refs") or [])
        return {"kind": "report", "ref": ref, "excerpt": str(sent.get("text") or ""), "meta": meta}
    return {"kind": "report", "ref": ref, "excerpt": str(u.get("heading") or ""), "meta": meta}


FILE_KINDS = ("record", "range", "block", "span", "path", "table", "row", "page", "pointer", "csvrow")
RECORD_KINDS = ("record", "row", "page", "pointer", "csvrow")  # the kinds that name one record of a file (records.py)


def resolve(corpus_dir: Path, ref: str) -> dict[str, Any]:
    """Resolve a ref against a corpus. Raises RefError (400 malformed, 404 unresolvable).
    A file ref with a fragment that a view accepts carries that view's excerpt and names the view (module note)."""
    ref = _unwrap_card_line(ref)
    out = resolve_base(corpus_dir, ref)
    if out.get("kind") in FILE_KINDS and "#" in ref:
        from . import views  # lazy: views imports this module

        views.enrich_file_ref(corpus_dir, ref.strip(), out)
    return out


def resolve_base(corpus_dir: Path, ref: str) -> dict[str, Any]:
    """resolve without the view step: a file ref as the file itself reads."""
    ref = _unwrap_card_line(ref)
    try:
        p = parse_ref(ref)
    except ValueError as e:
        raise RefError(str(e), 400)
    kind = p["kind"]
    if kind == "view":
        from . import views  # lazy: views imports this module

        return views.resolve_view_ref(corpus_dir, p, ref.strip())
    if kind == "cell":
        return _resolve_cell(corpus_dir, p, ref)
    if kind == "concept":
        from . import concepts  # lazy: concepts imports refs

        return concepts.resolve_concept_ref(corpus_dir, ref)
    if kind == "report":
        return _resolve_report(corpus_dir, p, ref)
    if kind == "call":
        from . import calls  # noqa: PLC0415

        return calls.resolve(_workspace_of(corpus_dir), p, ref.strip())
    if kind == "chat" and p.get("event_index") is None:
        from . import critique_session  # noqa: PLC0415 — the digest's renderer

        return critique_session.resolve_chat(_workspace_of(corpus_dir), p, ref.strip())
    if kind in ("table", "row"):
        return _resolve_database(corpus_dir, p, ref)
    if kind == "page":
        return _resolve_page(corpus_dir, p, ref)
    if kind in ("pointer", "csvrow"):
        return _resolve_record(corpus_dir, p, ref)
    if kind in ("record", "range", "block", "span"):
        return _resolve_lines(corpus_dir, p, ref)
    if kind == "path":
        return _resolve_path(corpus_dir, p, ref)
    raise RefError(f"ref has no resolvable location: {ref!r}", 404)


def _workspace_of(corpus_dir: Path | str) -> str:
    """The workspace a resolve is for: its corpus folder's registered name, or the name itself when a caller passes
    one."""
    return config.workspace_for_corpus_dir(corpus_dir) if isinstance(corpus_dir, Path) else str(corpus_dir)


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _find_quote(text: str, quote: str) -> tuple[int, int] | None:
    """Where `quote` sits in `text`, as Python string offsets [a, b): the words as written; else as JSON writes them, for a
    record whose block is its raw JSON (a newline in the quote is `\\n` there); else with every run of whitespace read
    as one space and case ignored, since a model quoting a passage folds its line breaks. None when it is not there."""
    q = quote.strip()
    if not q:
        return None
    at = text.find(q)
    if at >= 0:
        return at, at + len(q)
    escaped = json.dumps(q, ensure_ascii=False)[1:-1]
    at = text.find(escaped)
    if at >= 0:
        return at, at + len(escaped)
    # the loose match: a map from each kept character of the folded text back to its offset in `text`
    kept: list[int] = []
    folded: list[str] = []
    for i, ch in enumerate(text):
        if ch.isspace():
            if folded and folded[-1] != " ":
                folded.append(" ")
                kept.append(i)
            continue
        folded.append(ch.lower()[:1] or ch)
        kept.append(i)
    needle = " ".join(q.split()).lower()
    at = "".join(folded).find(needle)
    if at < 0:
        return None
    return kept[at], kept[at + len(needle) - 1] + 1


QUOTE_SCAN_MAX_BYTES = 64 * 1024 * 1024  # of a whole file searched line by line for a quote (span_of_quote)
QUOTE_LOOSE_MAX_BYTES = 4 * 1024 * 1024  # of a whole file searched with the loose match too, which reads every char


def span_of_quote(corpus_dir: Path, ref: str, quote: str) -> str:
    """The span ref (`<path>#L<n>.b<k>:c<a>-<b>`, UTF-16 offsets) of the passage `quote` in the record or lines `ref`
    names, so an example card can show a passage deep inside a long record. A whole file is searched line by line. A ref
    a view reads is kept as it is when the view's excerpt holds the quote (_quote_in_view). Raises RefError: 400 for a
    ref naming no text, 404 when the quote is not there."""
    try:
        p = parse_ref(ref)
    except ValueError as e:
        raise RefError(str(e), 400)
    if p["kind"] == "span":
        return ref.strip()
    if p["kind"] == "view" and p.get("key"):
        return _quote_in_view(corpus_dir, ref.strip(), quote)
    if p["kind"] == "path" and p.get("locator"):
        return _quote_in_view(corpus_dir, ref.strip(), quote)
    if p["kind"] == "path":
        return _quote_in_file(corpus_dir, p["path"], ref.strip(), quote)
    if p["kind"] in ("row", "page", "pointer", "csvrow"):
        return _quote_in_record(corpus_dir, p, ref.strip(), quote)
    if p["kind"] not in ("record", "block", "range"):
        raise RefError(f"a quote is looked up in a record or lines of a file, or a unit of a view, not in {ref!r}", 400)
    out = resolve_base(corpus_dir, ref)
    records = out.get("records") or [{"blocks": out.get("blocks") or []}]
    for i, rec in enumerate(records):
        line = p["line"] + i
        for k, block in enumerate(rec.get("blocks") or []):
            if p["kind"] == "block" and k != p["block"]:
                continue
            text = str(block.get("text") or "")
            found = _find_quote(text, quote)
            if found:
                a, b = found
                start = _utf16_len(text[:a])
                return f"{out['path']}#L{line}.b{k}:c{start}-{start + _utf16_len(text[a:b])}"
    raise RefError(f"the quote is not in {ref}", 404)


QUOTE_UNIT_REFS = 50  # of the file refs a view's unit stands for, searched for a quote its excerpt does not show


def _quote_in_view(corpus_dir: Path, ref: str, quote: str) -> str:
    """`ref` itself when the unit a view reads for it holds `quote`. The view's excerpt is searched first, then (since
    an excerpt is cut at EXCERPT_MAX) the file lines the unit stands for. RefError 400 when no view reads the ref, 404
    when the quote is in neither."""
    out = resolve(corpus_dir, ref)
    if out.get("kind") != "view" and not out.get("view"):
        raise RefError(f"a quote is looked up in a record or lines of a file, or a unit of a view, not in {ref!r}", 400)
    if _find_quote(str(out.get("excerpt") or ""), quote):
        return ref
    # a `<file>#<locator>` a view read stands for its file, whose lines _quote_in_file searches
    unit = list(out.get("refs") or []) if out.get("kind") == "view" else [str(out.get("path") or "")]
    for r in [u for u in unit if u][:QUOTE_UNIT_REFS]:
        try:
            span_of_quote(corpus_dir, r, quote)
        except RefError:
            continue
        return ref
    raise RefError(f"the quote is not in {ref}", 404)


def _quote_in_file(corpus_dir: Path, rel: str, ref: str, quote: str) -> str:
    """The span of `quote` in a whole file: the first line holding it as written or as JSON writes it, then with the
    loose match for a file small enough; the span is taken in that line's record. RefError 400 for a database or binary
    file, 404 when no line holds it."""
    from . import corpus  # lazy (import cycle)

    from . import records  # lazy (import cycle)

    path, rel = _locate(corpus_dir, rel)
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    size = path.stat().st_size
    q = quote.strip()
    if records.reader_of(path, rel) in ("sqlite", "pdf") and size <= QUOTE_SCAN_MAX_BYTES:
        # a file with no lines: the first of its records whose text holds the quote
        for rec in records.iter_records(path, rel) if q else ():
            if q in rec["text"] or (size <= QUOTE_LOOSE_MAX_BYTES and _find_quote(rec["text"], q)):
                return rec["ref"]
        raise RefError(f"the quote is not in {ref}", 404)
    if corpus.source_kind(rel) == "forge" or _is_binary(path) or size > QUOTE_SCAN_MAX_BYTES:
        raise RefError(f"a quote is looked up in a record or lines of a file, not in {ref!r}", 400)
    if not q:
        raise RefError(f"the quote is not in {ref}", 404)
    needles = [n.encode("utf-8") for n in (q, json.dumps(q, ensure_ascii=False)[1:-1])]
    loose = size <= QUOTE_LOOSE_MAX_BYTES
    with path.open("rb") as f:
        for n, raw in enumerate(f, 1):
            if any(x in raw for x in needles) or (loose and _find_quote(corpus.decode_line(raw), q)):
                try:
                    return span_of_quote(corpus_dir, f"{rel}#L{n}", quote)
                except RefError:
                    continue  # the line holds the words, but in no block its record shows (a field left out)
    raise RefError(f"the quote is not in {ref}", 404)


def _quote_in_record(corpus_dir: Path, p: dict[str, Any], ref: str, quote: str) -> str:
    """`ref` itself when the record it names (a database row, a PDF page, a JSON value, a CSV row) holds `quote`, in its
    text or its JSON. RefError 404 when the record or the quote is not there."""
    from . import records  # lazy (import cycle)

    path, rel = _locate(corpus_dir, p["path"])
    rec = records.read(path, rel, format_ref(p).partition("#")[2]) if path.is_file() else None
    if rec is None:
        raise RefError(f"no such record: {ref!r}", 404)
    if any(_find_quote(t, quote) for t in (rec["text"], _dumps(rec["record"]))):
        return ref
    raise RefError(f"the quote is not in {ref}", 404)


PATH_EXCERPT_LINES = 8  # of a whole-file ref's excerpt


def _locate(corpus_dir: Path, rel: str) -> tuple[Path, str]:
    """The file a corpus-relative path names, and the path as the resolved ref reports it: corpus_dir/rel, else (for a
    working directory narrowed under a registered root) root/rel when that file lies inside the working directory.
    RefError 400 for a path that escapes the corpus."""
    try:
        path = config.safe_corpus_path(corpus_dir, rel)
    except ValueError as e:
        raise RefError(str(e), 400)
    if path.exists():
        return path, rel
    root_for = getattr(config, "corpus_root_for_dir", None)
    root = root_for(corpus_dir) if callable(root_for) else None
    if root is None:
        return path, rel
    try:
        alt = (root / rel).resolve()
        here = corpus_dir.resolve()
    except (OSError, RuntimeError):
        return path, rel
    if alt.is_file() and here in alt.parents:
        return alt, alt.relative_to(here).as_posix()
    return path, rel


def _resolve_path(corpus_dir: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """A whole file (`<path>`, no line): {ref, kind: path, path, excerpt: its first PATH_EXCERPT_LINES lines, meta}. A
    database is named by its tables; a missing file is 404. A `<path>#<locator>` ref is this file with the locator as
    text; the excerpt stays the file's own, but for a PDF, whose excerpt is the text of the page the locator names
    (pdfs.excerpt), and a page past its last is 404. A binary file's excerpt says what it is and meta.binary is true.
    meta.lines is the line count, an estimate (meta.lines_estimated) while a big file's line index is being built."""
    from . import corpus  # lazy (import cycle)

    path, rel = _locate(corpus_dir, p["path"])
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    src_kind = corpus.source_kind(rel)
    meta: dict[str, Any] = {"kind": src_kind, "size_bytes": path.stat().st_size}
    if src_kind == "forge":
        try:
            con = corpus.connect_ro(path)
            try:
                tables = corpus.table_names(con)
            finally:
                con.close()
        except Exception:  # noqa: BLE001
            tables = []
        meta["tables"] = tables
        excerpt = "database: " + (", ".join(tables) if tables else "(no tables read)")
    elif media := _media(rel, p.get("locator")):
        meta["media"] = media
        excerpt = _media_excerpt(media)
    elif rel.lower().endswith(".pdf"):
        from . import pdfs  # noqa: PLC0415 — pdfs imports corpus, which imports this module

        excerpt, more = pdfs.excerpt(path, p.get("locator"))
        if more.get("missing"):
            raise RefError(f"{p.get('locator')} is past the last page ({rel} has {more['pages']} pages)", 404)
        meta.update(more)
    elif _is_binary(path):
        meta["binary"] = True
        excerpt = "(a binary file, open it in Files)"
    else:
        lines, meta["lines"], estimated = corpus.page_lines(path, 1, PATH_EXCERPT_LINES)
        if estimated:  # a big file whose line index is still being built
            meta["lines_estimated"] = True
        recs = corpus.records_from_lines(lines, rel, src_kind, 1)
        excerpt = "\n".join(_join_blocks(r["blocks"]) for r in recs)
    out = {"ref": ref, "kind": "path", "path": rel, "record": None, "excerpt": excerpt[:EXCERPT_MAX], "meta": meta}
    if p.get("locator"):
        out["locator"] = meta["locator"] = p["locator"]
    return out


_MOMENT = re.compile(r"^t=([0-9:.]+)(?:,([0-9:.]+))?$")  # a video's or a recording's moment, the media fragment's form


def _seconds(text: str) -> float | None:
    """`1855`, `30:55` or `1:02:03.5` as seconds; None for anything else."""
    parts = text.split(":")
    if not 1 <= len(parts) <= 3:
        return None
    try:
        nums = [float(x) for x in parts]
    except ValueError:
        return None
    total = 0.0
    for n in nums:
        total = total * 60 + n
    return total


def _media(rel: str, locator: str | None) -> dict[str, Any] | None:
    """What a media file of the corpus is, for an example card that shows it (frontend lib/media.ts): {kind: image,
    audio or video, type}, and for a recording the moment `#t=<start>[,<end>]` names, in seconds. None for a file of
    another type (views.MEDIA_TYPES, which the card's media route serves)."""
    from . import views  # lazy: views imports this module

    media_type = views.MEDIA_TYPES.get(Path(rel).suffix.lower())
    if media_type is None:
        return None
    out: dict[str, Any] = {"kind": media_type.split("/")[0], "type": media_type}
    m = _MOMENT.match(locator or "")
    if m and out["kind"] in ("video", "audio"):
        start = _seconds(m[1])
        end = _seconds(m[2]) if m[2] else None
        if start is not None:
            out["start"] = start
        if end is not None and start is not None and end > start:
            out["end"] = end
    return out


def _clock(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def _media_excerpt(media: dict[str, Any]) -> str:
    """The excerpt of a media file, for a reader that shows text (a chip's preview, read_ref)."""
    if media["kind"] == "image":
        return "(an image)"
    what = "a video" if media["kind"] == "video" else "a recording"
    if "start" in media:
        return f"({what} from {_clock(media['start'])}" + (f" to {_clock(media['end'])})" if "end" in media else ")")
    return f"({what})"


BINARY_SNIFF = 8192  # bytes read to tell a binary file from a text one


def _is_binary(path: Path) -> bool:
    """True when the file's first BINARY_SNIFF bytes hold a NUL, which no text file of the corpus does and a PDF, a zip
    container (xlsx, docx), an image or a PSD does."""
    try:
        with path.open("rb") as f:
            return b"\x00" in f.read(BINARY_SNIFF)
    except OSError:
        return False


def _join_blocks(blocks: list[dict[str, str]]) -> str:
    return "\n\n".join(b["text"] for b in blocks)


def _resolve_lines(corpus_dir: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    from . import corpus  # data access lives in corpus.py; imported lazily to avoid an import cycle

    path, rel = _locate(corpus_dir, p["path"])
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    src_kind = corpus.source_kind(rel)
    if src_kind == "forge":
        raise RefError(f"{rel!r} is a database file: rows are addressed as <path>#<table>[/<pk>], not by line", 400)

    total = len(corpus.line_offsets(path))
    line = p["line"]
    end_line = p.get("end_line", line)
    if line < 1 or line > total:
        raise RefError(f"line {line} out of range ({rel} has {total} lines)", 404)
    if end_line < line:
        raise RefError(f"range end L{end_line} is before start L{line}", 400)
    end_line = min(end_line, total)

    recs = corpus.load_records(path, rel, src_kind, line, min(end_line, line + RANGE_MAX_RECORDS - 1))
    first = recs[0]
    out: dict[str, Any] = {
        "ref": ref,
        "kind": p["kind"],
        "path": rel,
        "line": line,
        "record": first["record"],
        "blocks": first["blocks"],
        "meta": first["meta"],
        "context": {
            "before": corpus.load_records(path, rel, src_kind, max(1, line - CONTEXT_RECORDS), line - 1),
            "after": corpus.load_records(path, rel, src_kind, end_line + 1, min(total, end_line + CONTEXT_RECORDS)),
        },
    }
    if p["kind"] == "record":
        excerpt = _join_blocks(first["blocks"])
    elif p["kind"] == "range":
        out["end_line"] = end_line
        out["records"] = recs
        excerpt = "\n\n".join(_join_blocks(r["blocks"]) for r in recs)
    else:
        k = p["block"]
        blocks = first["blocks"]
        if k >= len(blocks):
            raise RefError(f"{rel}#L{line} has {len(blocks)} block(s); b{k} does not exist", 404)
        out["block"] = k
        excerpt = blocks[k]["text"]
        if p["kind"] == "span":
            out["start"], out["end"] = p["start"], p["end"]
            excerpt = utf16_slice(excerpt, p["start"], p["end"])
    out["excerpt"] = excerpt[:EXCERPT_MAX]
    return out


def _resolve_page(corpus_dir: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """A PDF's page: {ref, kind: page, path, record: {page, text}, blocks, excerpt, meta}, the excerpt and meta as a
    `<pdf>#p<n>` locator gets them (pdfs.excerpt), with the page's place `n`. A page past the last is 404; a PDF that
    does not open says so in its excerpt and meta.error."""
    from . import pdfs  # noqa: PLC0415 — pdfs imports corpus, which imports this module

    path, rel = _locate(corpus_dir, p["path"])
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    n = int(p["page"])
    excerpt, meta = pdfs.excerpt(path, f"p{n}")
    if meta.get("missing"):
        raise RefError(f"p{n} is past the last page ({rel} has {meta['pages']} pages)", 404)
    got = [] if meta.get("error") else pdfs.page_texts(path, n, n)["pages"]
    text = got[0] if got else ""
    meta["n"] = n
    return {"ref": ref, "kind": "page", "path": rel, "record": {"page": n, "text": text},
            "blocks": [{"kind": "text", "text": text or excerpt}], "excerpt": excerpt[:EXCERPT_MAX], "meta": meta}


def _resolve_record(corpus_dir: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """A JSON document's value or a CSV's row (records.read): {ref, kind, path, record, blocks, excerpt, meta}. meta
    holds the record's place `n` and the lines it spans (`line`..`end_line`), where the File browser opens it. A row
    reads as its fields, so it has no blocks."""
    from . import records  # lazy (import cycle)

    path, rel = _locate(corpus_dir, p["path"])
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    if p["kind"] == "pointer" and (records.reader_of(path, rel) != "json" or records.json_index(path) is None):
        raise RefError(f"{rel!r} does not hold one JSON document, so its records are its lines: <path>#L<n>", 400)
    fragment = format_ref(p).partition("#")[2]
    try:
        rec = records.read(path, rel, fragment)
    except (OSError, ValueError, sqlite3.Error) as e:
        raise RefError(f"{rel!r} could not be read: {e}", 400)
    if rec is None:
        raise RefError(f"{rel} has no record #{fragment}", 404)
    kind = p["kind"]
    blocks: list[dict[str, str]] = [] if kind == "csvrow" else record_blocks(rec["record"])
    meta: dict[str, Any] = {k: rec[k] for k in ("n", "line", "end_line") if rec.get(k) is not None}
    excerpt = rec["text"] or _dumps(rec["record"])
    return {"ref": ref, "kind": kind, "path": rel, "record": rec["record"], "blocks": blocks, "excerpt": excerpt[:EXCERPT_MAX],
            "meta": meta}


def _resolve_database(corpus_dir: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """`<db>#<table>` / `<db>#<table>/<pk>` against any database file under the corpus (corpus.open_database)."""
    from . import corpus

    db, rel = _locate(corpus_dir, p.get("path") or "forge.db")
    if not db.is_file():
        raise RefError(f"corpus has no {rel}", 404)
    try:
        con = corpus.open_database(db)
    except sqlite3.Error as e:
        raise RefError(f"{rel!r} is not a readable SQLite database: {e}", 400)
    table = p["table"]
    with closing(con):
        if table not in corpus.table_names(con):
            raise RefError(f"no such table: {table!r}", 404)
        columns, pk = corpus.table_info(con, table)
        if p["kind"] == "table":
            n = con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            record = {"name": table, "row_count": n, "columns": columns, "pk": pk or "rowid"}
            return {"ref": ref, "kind": "table", "path": rel, "table": table, "record": record,
                    "excerpt": f"{table}: {n} rows", "meta": {"table": table}}
        from .records import row_by_key  # noqa: PLC0415 — records imports this module

        if pk is None:
            select, columns = "rowid, *", ["rowid", *columns]
        else:
            select = "*"
        try:
            row = row_by_key(con, table, pk or "rowid", p["pk"], select)
            key = row[columns.index(pk or "rowid")] if row is not None else None
            n = _row_place(con, table, pk, key) if row is not None else None
        except sqlite3.Error as e:
            raise RefError(f"sqlite: {e}", 400)
    if row is None:
        raise RefError(f"no row {table}/{p['pk']}", 404)
    record = dict(zip(columns, (corpus.jsonable(v) for v in row)))
    meta: dict[str, Any] = {"table": table, "pk_column": pk or "rowid"}
    if n is not None:
        meta["n"] = n
    return {"ref": ref, "kind": "row", "path": rel, "table": table, "pk": p["pk"], "record": record,
            "excerpt": json.dumps(record, ensure_ascii=False, separators=(",", ":"))[:EXCERPT_MAX], "meta": meta}


def _row_place(con: sqlite3.Connection, table: str, pk: str | None, key: Any) -> int | None:
    """Where a row stands (from 1) in its table read in storage order, as the Database view pages it: by rowid, else
    by its primary key in a table without one."""
    from .records import quote_id  # noqa: PLC0415 — records imports this module

    t, col = quote_id(table), "rowid" if pk is None else quote_id(pk)
    try:
        got = con.execute(f"SELECT COUNT(*) FROM {t} WHERE rowid < (SELECT rowid FROM {t} WHERE {col} = ?)", (key,)).fetchone()
    except sqlite3.Error:
        if pk is None:
            return None
        got = con.execute(f"SELECT COUNT(*) FROM {t} WHERE {col} < ?", (key,)).fetchone()
    return int(got[0]) + 1 if got else None


_BARE_REPR_RE = re.compile(r"^\s*<[^<>]*>\s*$")  # e.g. '<Figure size 600x400 with 1 Axes>' next to an image/png
_VEGA_FALLBACK_RE = re.compile(r"<(?:VegaLite|Vega|Chart)\b|altair-viz\.github\.io")  # Altair repr when no mimebundle


def _cell_excerpt(cell: dict[str, Any]) -> str:
    from . import notebook  # lazy

    if not notebook.runnable(cell):  # a data card: its payload is the excerpt
        payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
        kind = cell.get("kind")
        if kind == "note":
            return _text(payload.get("text") or cell.get("text"))
        if kind == "example":
            return "\n".join(str(r) for r in payload.get("refs") or [])
        if kind == "label":
            return _text(payload.get("concept"))
        if kind == "custom":
            return _text(payload.get("html"))
        return json.dumps(payload.get("dataset"), ensure_ascii=False) if payload.get("dataset") is not None else _text(cell.get("title"))
    parts: list[str] = []
    for bundle in cell.get("outputs") or []:
        if not isinstance(bundle, dict):
            continue
        err = bundle.get("application/vnd.thimble.error+json")
        if isinstance(err, dict):
            parts.append(f"{err.get('ename', 'Error')}: {err.get('evalue', '')}")
        # A chart/image wins over text/plain: Altair's mimebundle also carries a multi-line "<VegaLite N object> /
        # renderer not enabled" fallback that must never leak into a card or ref popover.
        elif any("vegalite" in k or "vega" in k for k in bundle):
            parts.append("[chart]")
        elif any(k.startswith("image/") for k in bundle):
            parts.append("[image]")
        elif "text/plain" in bundle and not (
            any(k != "text/plain" and "/" in k for k in bundle) and _BARE_REPR_RE.match(_text(bundle["text/plain"]))
        ):
            tp = _text(bundle["text/plain"])
            parts.append("[chart]" if _VEGA_FALLBACK_RE.search(tp) else tp)  # outputs with no vega mime
        elif "text/html" in bundle:
            parts.append("[html]")
    return "\n".join(parts) if parts else _text(cell.get("code"))


def _resolve_cell(corpus_dir: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """Cell ids are random, hence unique across a workspace's notebooks: search them all."""
    from . import notebook  # storage helpers; lazy: no kernel deps at import

    # the workspace is the corpus's registered name, not the directory's basename
    ws = config.WORKSPACES_DIR / config.workspace_for_corpus_dir(corpus_dir)
    # every notebook, the orientation's working one included, since the orientation cites the cards it made there
    hit = notebook.find_cell(ws, p["cell_id"]) if ws.is_dir() else None
    if hit is None:
        raise RefError(f"no card {p['cell_id']!r}", 404)
    nb_id, cell = hit
    # the notebook's role rides along: the browser opens no notebook for a cell of a document's figures notebook
    nb_rec = notebook.read_notebook(ws, nb_id) or {}
    role = notebook.FIGURES_ROLE if notebook.is_figures(nb_rec) else str(nb_rec.get("role") or notebook.DEFAULT_ROLE)
    meta = {"exec_count": cell.get("exec_count"), "status": cell.get("status"), "created_by": cell.get("created_by"),
            "notebook": nb_id, "notebook_role": role, "title": cell.get("title") or ""}
    if p.get("exec") is not None and cell.get("exec_count") != p["exec"]:
        # only the latest execution is stored; say which one this is
        meta["requested_exec"] = p["exec"]
    excerpt = _cell_excerpt(cell)
    # Span refs into the cell's output (cite.py): a td by column/row label, or a line of the i-th output. When the
    # target is gone (the cell was re-run and its output changed) fall back to the whole-cell excerpt and say so.
    if p.get("col") is not None and p.get("row") is not None:
        hit = cite.find_td(cell.get("outputs"), p["col"], p["row"])
        if hit is None:
            meta["span_missing"] = True
        else:
            value, table_html = hit
            excerpt = f"{p['col']} × {p['row']} = {value}"
            meta["span"] = {"col": p["col"], "row": p["row"], "value": value}
            meta["table_html"] = table_html
    elif p.get("out") is not None and p.get("line") is not None:
        # Line numbers count the complete output: a bounded stream bundle keeps head + marker + tail in the notebook and
        # the whole text in a side file, which this reads, so a ref into the omitted region resolves. A range follows
        # _resolve_lines' rules: the start must exist, the end is clamped, an end before the start is 400.
        text = notebook.output_full_text(ws, cell, p["out"])
        lines = text.splitlines() if text else None
        n = p["line"]
        m_end = p.get("end_line")
        if m_end is not None and m_end < n:
            raise RefError(f"range end L{m_end} is before start L{n}", 400)
        if lines is None or not 1 <= n <= len(lines):
            meta["span_missing"] = True
        else:
            last = min(m_end, len(lines)) if m_end is not None else n
            excerpt = "\n".join(lines[max(0, n - 1 - SPAN_CONTEXT_LINES) : last + SPAN_CONTEXT_LINES])
            meta["span"] = {"out": p["out"], "line": n, "text": "\n".join(lines[n - 1 : last])}
            if m_end is not None:
                meta["span"]["end_line"] = last
    return {"ref": ref, "kind": "cell", "cell_id": p["cell_id"], "notebook": nb_id, "record": cell,
            "excerpt": excerpt[:EXCERPT_MAX], "meta": meta}
