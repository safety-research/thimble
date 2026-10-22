"""The report, and the other documents the person makes with New: each one a document the person writes in the page and
Claude writes or revises when they ask (features/report.py). The report (`report`) is always there; the others are
listed in `docs/documents.json` ({slug, name, ts}), and each document is its own files under `docs/`, named by its slug.

It is kept as Markdown, `docs/report.md` in the workspace, and given to the page as the 0.8 report's shape (sections
of paragraphs of sentences, each sentence with its citations, and figures that show a card): `writeup()`. Before
anything is written it is an empty document the person can type into. The page's editor saves its blocks back
(`from_blocks`), which are written as Markdown again.

Versions. When Claude changes a document, the person's draft before the change and Claude's draft after its turn are
kept, numbered in order, in `docs/<slug>.versions.json` ({n, ts, by, instructions, md}): the person's own draft is never
lost to a rewrite, and History opens or restores any of them.

Markdown form: `# ` the title, `## ` a section, a blank line between paragraphs, `- ` or `1. ` a list item, `> ` a
quote, and `![caption](card:<id>)` alone on a line a figure. A citation is a Markdown link, as everywhere in thimble
browser.

Who wrote each block. The report is one list of blocks (a heading, a paragraph, a list item, a quote, a figure), and each
block written or changed by Claude carries the line `<!-- by: claude -->` above it, until the person edits it. A save
works this out itself (attribute): a block whose words are the same as a block of the report before keeps that block's
author, and any other block is the saver's. So Claude's blocks are marked quietly in the page, the person's own stay
unmarked, and a Write that keeps the person's notes word for word keeps them theirs.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Callable

from . import home
from .canvas import to_canvas_links
from .hub import hub

DOC = "report"
log = logging.getLogger("thimble_browser.report")
SENTENCE_END = re.compile(r"(?<=[.!?])[\"”’)]?\s+(?=[A-Z0-9\"“(\[])")
FIGURE = re.compile(r"^!\[([^\]]*)\]\((?:card|cell):([A-Za-z0-9_-]+)\)\s*$")
TOKEN = re.compile(r"\[\[((?:[^\[\]\n]|\[[^\[\]\n]*\])+?)\]\]")
BY_MARK = re.compile(r"^<!--\s*by:\s*([a-z]+)\s*-->$")
ITEM = re.compile(r"^\s*(-|\*|\d+\.)\s+(.*)$")
CLAUDE = "claude"
# what feature modules hear of each save (on_save): fn(ws, before, after, by, slug), the Markdown before (None for none)
# and after, such as the undo history; a hook's failure never stops the save
SAVED: list[Callable[..., None]] = []


def on_save(fn: Callable[..., None]) -> None:
    if fn not in SAVED:
        SAVED.append(fn)

def _docs_dir(ws: str) -> Any:
    d = home.workspace_dir(ws) / "docs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _path(ws: str, ext: str, slug: str = DOC) -> Any:
    return _docs_dir(ws) / f"{slug}.{ext}"


# ---- the documents

def documents(ws: str) -> list[dict[str, Any]]:
    """The report, then the person's other documents in the order they were made: {slug, name}."""
    got = home.read_json(_docs_dir(ws) / "documents.json", []) or []
    own = [d for d in got if isinstance(d, dict) and d.get("slug") and d["slug"] != DOC]
    return [{"slug": DOC, "name": "Report"}, *own]


def exists(ws: str, slug: str) -> bool:
    return any(d["slug"] == slug for d in documents(ws))


def name_of(ws: str, slug: str) -> str:
    return next((str(d.get("name") or slug) for d in documents(ws) if d["slug"] == slug), slug)


def create(ws: str, name: str) -> dict[str, Any]:
    """A new document, empty, named `name`; its row."""
    name = " ".join(name.split())[:80] or "Untitled"
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "document"
    taken = {d["slug"] for d in documents(ws)} | {"documents", "report"}
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    row = {"slug": slug, "name": name, "ts": home.now()}
    own = documents(ws)[1:] + [row]
    home.write_json(_docs_dir(ws) / "documents.json", own)
    hub.publish(ws, {"type": "report", "slug": slug, "status": "created"})
    return row


def rename(ws: str, slug: str, name: str) -> dict[str, Any]:
    if slug == DOC or not exists(ws, slug):
        raise KeyError(slug)
    name = " ".join(name.split())[:80]
    if not name:
        raise ValueError("a document needs a name")
    own = [{**d, "name": name} if d["slug"] == slug else d for d in documents(ws)[1:]]
    home.write_json(_docs_dir(ws) / "documents.json", own)
    hub.publish(ws, {"type": "report", "slug": slug, "status": "renamed"})
    return next(d for d in own if d["slug"] == slug)


def delete(ws: str, slug: str) -> None:
    if slug == DOC or not exists(ws, slug):
        raise KeyError(slug)
    home.write_json(_docs_dir(ws) / "documents.json", [d for d in documents(ws)[1:] if d["slug"] != slug])
    for ext in ("md", "state.json", "versions.json"):
        try:
            _path(ws, ext, slug).unlink()
        except OSError:
            pass
    hub.publish(ws, {"type": "report", "slug": slug, "status": "deleted"})


# Claude's write as it streams in, before its tool saves it (features/report.py): what the page shows meanwhile, kept
# in memory only, by (workspace, slug)
_DRAFTS: dict[tuple[str, str], str] = {}


def draft(ws: str, slug: str, md: str | None) -> None:
    """Show `md` as the document while Claude writes it, or (None) show the saved document again."""
    if md is None:
        if _DRAFTS.pop((ws, slug), None) is None:
            return
    elif _DRAFTS.get((ws, slug)) == md:
        return
    else:
        _DRAFTS[(ws, slug)] = md
    hub.publish(ws, {"type": "report", "slug": slug, "status": "drafting"})


def markdown(ws: str, slug: str = DOC) -> str | None:
    try:
        return _path(ws, "md", slug).read_text(encoding="utf-8")
    except OSError:
        return None


def _state(ws: str, slug: str = DOC) -> dict[str, Any]:
    return home.read_json(_path(ws, "state.json", slug), {}) or {}


def state(ws: str, slug: str = DOC) -> dict[str, Any]:
    return _state(ws, slug)


def set_status(ws: str, status: str, slug: str = DOC, **extra: Any) -> None:
    """Whether Claude is writing the document, which the Report tab shows (generating, generated, failed, idle)."""
    st = {**_state(ws, slug), "status": status, **extra}
    home.write_json(_path(ws, "state.json", slug), st)
    hub.publish(ws, {"type": "report", "slug": slug, "status": status})


def types(ws: str) -> dict[str, Any]:
    """Each document as the Report tab's bar lists it: whether anything is written yet, its name, and whether Claude is
    writing it."""
    out: dict[str, Any] = {}
    for d in documents(ws):
        slug = d["slug"]
        md = markdown(ws, slug)
        st = _state(ws, slug)
        out[slug] = {"exists": md is not None, "renderer": "document", "name": d["name"], "frame": False,
                     "generation": st.get("generation"), "generated_at": st.get("generated_at"),
                     "title": parse(md)["title"] if md else None, "builtin": slug == DOC,
                     **({"status": st["status"]} if st.get("status") in ("generating", "failed") else {})}
    return out


def _refs(text: str) -> list[str]:
    out = []
    for m in TOKEN.finditer(text):
        inner = m.group(1)
        ref = inner.split("|", 1)[1] if "|" in inner else inner
        out.append(ref.strip())
    return out


def _sentences(text: str) -> list[str]:
    # a citation's words never end a sentence: cut only outside [[...]]
    hidden = TOKEN.sub(lambda m: "\0" * len(m.group(0)), text)
    cuts, start = [], 0
    for m in SENTENCE_END.finditer(hidden):
        cuts.append(text[start:m.start()].strip())
        start = m.end()
    cuts.append(text[start:].strip())
    return [c for c in cuts if c]


def parse(md: str) -> dict[str, Any]:
    """Markdown -> {title, sections}, ids by position (s<k>, p<k>.<j>, t<k>.<j>.<i>, f<k>.<j>)."""
    md = to_canvas_links(md)
    title = ""
    sections: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    para: list[str] = []
    quote: list[str] = []
    bullets: list[tuple[str, str, str | None]] = []
    by: dict[str, str | None] = {"next": None, "block": None}  # the author line above the next block, and the open one's

    def take_by() -> dict[str, str]:
        got, by["next"] = by["next"], None
        return {"by": got} if got else {}

    def section() -> dict[str, Any]:
        nonlocal cur
        if cur is None:
            cur = {"id": "s0", "heading": "", "paragraphs": [], "figures": []}
            sections.append(cur)
        return cur

    def flush() -> None:
        if not para and not bullets and not quote:
            return
        sec = section()
        k = len(sec["paragraphs"])
        pid = f"p{sec['id'][1:]}.{k}"
        own = {"by": by["block"]} if by["block"] else {}
        by["block"] = None
        if para or quote:
            text = " ".join(x.strip() for x in (para or quote))
            sents = [{"id": f"t{pid[1:]}.{i}", "text": s, "refs": _refs(s), "tags": []}
                     for i, s in enumerate(_sentences(text))]
            sec["paragraphs"].append({"id": pid, "sentences": sents, **own, **({"quote": True} if quote else {})})
            para.clear()
            quote.clear()
        elif bullets:
            sents = [{"id": f"t{pid[1:]}.{i}", "text": t, "refs": _refs(t), "tags": [], "bullet": mark,
                      **({"by": who} if who else {})}
                     for i, (mark, t, who) in enumerate(bullets)]
            sec["paragraphs"].append({"id": pid, "sentences": sents})
            bullets.clear()

    for line in md.split("\n"):
        s = line.rstrip()
        mark = BY_MARK.match(s.strip())
        if mark:
            if para or quote:
                flush()
            by["next"] = mark.group(1)
            continue
        if (s == "#" or s.startswith("# ")) and not title and cur is None and not sections:
            title = s[2:].strip()
            by["next"] = None
            continue
        if re.match(r"^#{2,6} ", s):
            flush()
            level = len(s) - len(s.lstrip("#"))
            cur = {"id": f"s{len(sections) + 1}", "heading": s.lstrip("#").strip(), "paragraphs": [], "figures": [],
                   **({"level": level} if level > 2 else {}), **take_by()}
            sections.append(cur)
            continue
        fig = FIGURE.match(s.strip())
        if fig:
            flush()
            sec = section()
            last = sec["paragraphs"][-1]["id"] if sec["paragraphs"] else None
            sec["figures"].append({"id": f"f{sec['id'][1:]}.{len(sec['figures'])}", "cell": fig.group(2),
                                   "caption": fig.group(1), "after_paragraph": last, **({} if last else {"lead": True}),
                                   **take_by()})
            continue
        item = ITEM.match(s)
        if item:
            if para or quote:
                flush()
            bullets.append(("1." if item.group(1)[0].isdigit() else "-", item.group(2).strip(), take_by().get("by")))
            continue
        if not s.strip():
            if para or bullets or quote:
                flush()
            continue
        if s.startswith(">"):
            if para or bullets:
                flush()
            if not quote:
                by["block"] = take_by().get("by")
            quote.append(s[1:].strip())
            continue
        if bullets or quote:
            flush()
        if not para:
            by["block"] = take_by().get("by")
        para.append(s)
    if para or bullets or quote:
        flush()
    return {"title": title, "sections": sections}


def writeup(ws: str, slug: str = DOC) -> dict[str, Any]:
    """A document as the page reads it; an empty one before anything is written, and while Claude writes it, its draft
    so far (`drafting`)."""
    drafting = _DRAFTS.get((ws, slug))
    md = drafting if drafting is not None else markdown(ws, slug) or ""
    st = _state(ws, slug)
    doc = parse(md)
    out = {"id": slug, **doc, "generation": st.get("generation"), "generated_at": st.get("generated_at"),
           "frame": False, "comments": [], **({"drafting": True} if drafting is not None else {})}
    return out


# ---- versions

def versions(ws: str, slug: str = DOC) -> list[dict[str, Any]]:
    got = home.read_json(_path(ws, "versions.json", slug), [])
    return got if isinstance(got, list) else []


def keep_version(ws: str, md: str | None, *, by: str, slug: str = DOC, instructions: str | None = None) -> None:
    """Keep `md` as the next version, unless it is empty or the same as the last one kept."""
    if md is None or not md.strip():
        return
    rows = versions(ws, slug)
    if rows and rows[-1].get("md") == md:
        return
    rows.append({"n": len(rows) + 1, "ts": home.now(), "by": by, "instructions": instructions, "md": md})
    home.write_json(_path(ws, "versions.json", slug), rows)


# ---- who wrote each block

def blocks_of(md: str) -> list[dict[str, Any]]:
    """The report's Markdown as its list of blocks, in order: {kind, lines, by}. `kind` is title, heading, figure,
    item, quote or para; `by` the author line above it (None for the person's own). Pure."""
    out: list[dict[str, Any]] = []
    pending: str | None = None
    open_block: dict[str, Any] | None = None
    for line in md.split("\n"):
        s = line.rstrip()
        mark = BY_MARK.match(s.strip())
        if mark:
            pending, open_block = mark.group(1), None
            continue
        if not s.strip():
            open_block = None
            continue
        if not out and (s == "#" or s.startswith("# ")):
            kind = "title"
        elif re.match(r"^#{2,6} ", s):
            kind = "heading"
        elif FIGURE.match(s.strip()):
            kind = "figure"
        elif ITEM.match(s):
            kind = "item"
        elif s.startswith(">"):
            kind = "quote"
        else:
            kind = "para"
        if open_block is not None and kind == open_block["kind"] and kind in ("para", "quote"):
            open_block["lines"].append(s)
            continue
        open_block = {"kind": kind, "lines": [s], "by": pending}
        pending = None
        out.append(open_block)
        if kind in ("title", "heading", "figure", "item"):
            open_block = None
    return out


def _key(block: dict[str, Any]) -> str:
    """What makes two blocks the same block: their kind and words, with citations in one form and spaces collapsed."""
    return block["kind"] + "|" + " ".join(to_canvas_links(" ".join(block["lines"])).split())


def attribute(before: str | None, after: str, by: str) -> str:
    """`after` with each block's author line: a block the same as one in `before` keeps that block's author, any other is
    `by`'s (Claude's carries the line, the person's carries none). Pure."""
    pool: dict[str, list[str | None]] = {}
    for b in blocks_of(before or ""):
        pool.setdefault(_key(b), []).append(b["by"])
    saver = None if by == "analyst" else CLAUDE
    lines: list[str] = []
    prev: dict[str, Any] | None = None
    for b in blocks_of(after):
        k = _key(b)
        who = pool[k].pop(0) if pool.get(k) else saver
        if b["kind"] == "title":
            who = None
        if prev is not None and not (prev["kind"] == "item" and b["kind"] == "item"):
            lines.append("")
        if who:
            lines.append(f"<!-- by: {who} -->")
        lines.extend(b["lines"])
        prev = b
    return "\n".join(lines)


def save(ws: str, md: str, *, by: str, slug: str = DOC) -> dict[str, Any]:
    if not exists(ws, slug):
        raise KeyError(slug)
    before = markdown(ws, slug)
    if by != "analyst" and _state(ws, slug).get("by") in (None, "analyst"):
        # the person's draft before Claude's first change is kept, so History can bring it back; Claude's result is
        # kept when its turn ends (features/report.py), so a turn of many edits is one version
        keep_version(ws, before, by="analyst", slug=slug)
    md = attribute(before, md.strip(), by)
    _path(ws, "md", slug).write_text(md.strip() + "\n", encoding="utf-8")
    _DRAFTS.pop((ws, slug), None)
    for fn in SAVED:
        try:
            fn(ws, before, md.strip() + "\n", by, slug=slug)
        except Exception:  # noqa: BLE001
            log.exception("a hook on the document's save failed")
    st = _state(ws, slug)
    gen = int(st.get("generation") or 0) + (0 if by == "analyst" else 1)
    home.write_json(_path(ws, "state.json", slug), {**st, "generation": gen, "generated_at": home.now(), "by": by})
    hub.publish(ws, {"type": "report", "slug": slug, "status": "edited" if by == "analyst" else "written"})
    return writeup(ws, slug)


def _block_md(b: dict[str, Any]) -> str:
    t = b.get("type")
    text = str(b.get("text") or "")
    if t == "heading":
        return "#" * max(2, int(b.get("level") or 2)) + " " + text
    if t == "bullet":
        return f"{b.get('marker') or '-'} {text}"
    if t == "figure":
        cell = str(b.get("cell") or "").removeprefix("card:").removeprefix("cell:")
        return f"![{b.get('caption') or ''}](card:{cell})" if cell else ""
    if t == "quote":
        return f"> {text}" if text else ""
    return text


def from_blocks(ws: str, title: str, blocks: list[dict[str, Any]], slug: str = DOC) -> dict[str, Any]:
    """The editor's blocks saved as the document's Markdown (`#` alone for a title not typed yet)."""
    out = [f"# {title}".rstrip(), ""]
    prev = None
    for b in blocks:
        line = _block_md(b)
        if not line:
            continue
        if not (prev == "bullet" and b.get("type") == "bullet"):
            out.append("")
        out.append(line)
        prev = b.get("type")
    return save(ws, "\n".join(out), by="analyst", slug=slug)
