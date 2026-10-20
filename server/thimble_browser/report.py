"""The report: one document per workspace, written by the writer (a Claude session, agent.Writer) and edited by the
person in the page.

It is kept as Markdown, `docs/report.md` in the workspace, and given to the page as the 0.8 report's shape (sections
of paragraphs of sentences, each sentence with its citations, and figures that show a card): `writeup()`. The page's
editor saves its blocks back (`from_blocks`), which are written as Markdown again.

Markdown form: `# ` the title, `## ` a section, a blank line between paragraphs, `- ` or `1. ` a list item, and
`![caption](card:<id>)` alone on a line a figure. A citation is a Markdown link, as everywhere in thimble browser.
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
# what feature modules add to the document the page reads (on_serve): fn(ws, doc), such as its comments
SERVE: list[Callable[[str, dict[str, Any]], None]] = []


def on_serve(fn: Callable[[str, dict[str, Any]], None]) -> None:
    """Have `fn(ws, doc)` add to each document writeup() serves, once however often it is registered."""
    if fn not in SERVE:
        SERVE.append(fn)


# what feature modules hear of each save (on_save): fn(ws, before, after, by), the Markdown before (None for none) and
# after, such as the undo history; a hook's failure never stops the save
SAVED: list[Callable[[str, str | None, str, str], None]] = []


def on_save(fn: Callable[[str, str | None, str, str], None]) -> None:
    if fn not in SAVED:
        SAVED.append(fn)


def _path(ws: str, ext: str) -> Any:
    d = home.workspace_dir(ws) / "docs"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{DOC}.{ext}"


def markdown(ws: str) -> str | None:
    try:
        return _path(ws, "md").read_text(encoding="utf-8")
    except OSError:
        return None


def _state(ws: str) -> dict[str, Any]:
    return home.read_json(_path(ws, "state.json"), {}) or {}


def set_status(ws: str, status: str, **extra: Any) -> None:
    """The writer's state, which the Report tab shows (generating, generated, failed)."""
    st = {**_state(ws), "status": status, **extra}
    home.write_json(_path(ws, "state.json"), st)
    hub.publish(ws, {"type": "report", "slug": DOC, "status": status})


def types(ws: str) -> dict[str, Any]:
    md = markdown(ws)
    st = _state(ws)
    doc = writeup(ws) if md is not None else None
    return {DOC: {"exists": md is not None, "renderer": "document", "name": "Report", "frame": False,
                  "generation": st.get("generation"), "generated_at": st.get("generated_at"),
                  "title": doc["title"] if doc else None,
                  "open_comments": sum(1 for cm in (doc or {}).get("comments") or [] if cm.get("status", "open") == "open"),
                  **({"status": "generating"} if st.get("status") == "generating" else {})}}


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
    bullets: list[tuple[str, str]] = []

    def section() -> dict[str, Any]:
        nonlocal cur
        if cur is None:
            cur = {"id": "s0", "heading": "", "paragraphs": [], "figures": []}
            sections.append(cur)
        return cur

    def flush() -> None:
        if not para and not bullets:
            return
        sec = section()
        k = len(sec["paragraphs"])
        pid = f"p{sec['id'][1:]}.{k}"
        if para:
            text = " ".join(x.strip() for x in para)
            sents = [{"id": f"t{pid[1:]}.{i}", "text": s, "refs": _refs(s), "tags": []}
                     for i, s in enumerate(_sentences(text))]
            sec["paragraphs"].append({"id": pid, "sentences": sents})
            para.clear()
        elif bullets:
            sents = [{"id": f"t{pid[1:]}.{i}", "text": t, "refs": _refs(t), "tags": [], "bullet": mark}
                     for i, (mark, t) in enumerate(bullets)]
            sec["paragraphs"].append({"id": pid, "sentences": sents})
            bullets.clear()

    for line in md.split("\n"):
        s = line.rstrip()
        if s.startswith("# ") and not title and cur is None:
            title = s[2:].strip()
            continue
        if re.match(r"^#{2,6} ", s):
            flush()
            level = len(s) - len(s.lstrip("#"))
            cur = {"id": f"s{len(sections) + 1}", "heading": s.lstrip("#").strip(), "paragraphs": [], "figures": [],
                   **({"level": level} if level > 2 else {})}
            sections.append(cur)
            continue
        fig = FIGURE.match(s.strip())
        if fig:
            flush()
            sec = section()
            last = sec["paragraphs"][-1]["id"] if sec["paragraphs"] else None
            sec["figures"].append({"id": f"f{sec['id'][1:]}.{len(sec['figures'])}", "cell": fig.group(2),
                                   "caption": fig.group(1), "after_paragraph": last, **({} if last else {"lead": True})})
            continue
        item = re.match(r"^\s*(-|\*|\d+\.)\s+(.*)$", s)
        if item:
            if para:
                flush()
            bullets.append(("1." if item.group(1)[0].isdigit() else "-", item.group(2).strip()))
            continue
        if not s.strip():
            if para or bullets:
                flush()
            continue
        if bullets:
            flush()
        para.append(s)
    if para or bullets:
        flush()
    return {"title": title, "sections": sections}


def writeup(ws: str) -> dict[str, Any] | None:
    md = markdown(ws)
    if md is None:
        return None
    st = _state(ws)
    doc = parse(md)
    out = {"id": DOC, **doc, "generation": st.get("generation"), "generated_at": st.get("generated_at"),
           "frame": False, "comments": []}
    for fn in SERVE:
        fn(ws, out)
    return out


def save(ws: str, md: str, *, by: str) -> dict[str, Any]:
    before = markdown(ws)
    _path(ws, "md").write_text(md.strip() + "\n", encoding="utf-8")
    for fn in SAVED:
        try:
            fn(ws, before, md.strip() + "\n", by)
        except Exception:  # noqa: BLE001
            log.exception("a hook on the report's save failed")
    st = _state(ws)
    gen = int(st.get("generation") or 0) + (0 if by == "analyst" else 1)
    home.write_json(_path(ws, "state.json"), {**st, "generation": gen, "generated_at": home.now(), "by": by})
    hub.publish(ws, {"type": "report", "slug": DOC, "status": "edited" if by == "analyst" else "written"})
    return writeup(ws) or {}


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
    return text


def from_blocks(ws: str, title: str, blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """The editor's blocks saved as the document's Markdown."""
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
    return save(ws, "\n".join(out), by="analyst")
