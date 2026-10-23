"""PDFs of the corpus as themselves: the File browser shows the real file in the browser's own PDF viewer, and a
citation `<path>#p<n>` (or `#p<n>-p<m>`, pages counted from 1) opens it at that page.

GET /corpora/{c}/pdf/<path> serves the file as application/pdf with nosniff, so a browser reads it only as a PDF, in
its own viewer, and with a policy that lets only the app's pages frame it. page_texts() reads the text of the pages a
citation names with pypdf, and no others, kept per path while its size and mtime_ns stay the same, for the excerpt a
citation of a page resolves to.
"""
from __future__ import annotations

import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from . import corpus

router = APIRouter()

PDF_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'self'",
    "Content-Disposition": "inline",
    "Cache-Control": "no-cache",
}
PAGE_RE = re.compile(r"^(?:p|page=?)(\d+)(?:-p?(\d+))?$", re.I)
TEXTS_CACHE_MAX = 16
EXCERPT_CHARS = 1500
SPAN_PAGES_READ = 5  # pages of a cited span read for its excerpt

_lock = threading.Lock()
_TEXTS: "OrderedDict[str, tuple[tuple[int, int], dict[str, Any]]]" = OrderedDict()


def is_pdf(rel: str) -> bool:
    return rel.lower().endswith(".pdf")


def pages_of(locator: str | None) -> tuple[int, int] | None:
    """The pages a locator names, (first, last), counting from 1: `p4`, `p4-p6`, `page=4`; None for any other."""
    m = PAGE_RE.match((locator or "").strip())
    if not m:
        return None
    a = int(m.group(1))
    b = int(m.group(2)) if m.group(2) else a
    return (a, b) if 1 <= a <= b else None


def _entry(path: Path) -> dict[str, Any]:
    """What is known of a PDF while its size and mtime_ns stay the same: {"count": its pages, or None before it is
    opened, "pages": {page: text}, "error"?: why it does not open}."""
    st = path.stat()
    key = (st.st_size, st.st_mtime_ns)
    k = str(path)
    with _lock:
        hit = _TEXTS.get(k)
        if hit is not None and hit[0] == key:
            _TEXTS.move_to_end(k)
            return hit[1]
        entry: dict[str, Any] = {"count": None, "pages": {}}
        _TEXTS[k] = (key, entry)
        while len(_TEXTS) > TEXTS_CACHE_MAX:
            _TEXTS.popitem(last=False)
    return entry


def page_texts(path: Path, first: int, last: int) -> dict[str, Any]:
    """{"count": the PDF's pages, "pages": [text of each page from `first` to `last` that it has]} or {"count": 0,
    "pages": [], "error": why} for a PDF that does not open. Only those pages are read, each once."""
    entry = _entry(path)
    want = range(first, last + 1)
    if "error" not in entry and (entry["count"] is None or any(n not in entry["pages"] for n in want if n <= entry["count"])):
        try:
            from pypdf import PdfReader  # noqa: PLC0415

            reader = PdfReader(str(path))
            entry["count"] = len(reader.pages)
            for n in want:
                if n <= entry["count"] and n not in entry["pages"]:
                    entry["pages"][n] = (reader.pages[n - 1].extract_text() or "").strip()
        except Exception as e:  # noqa: BLE001 — a PDF that does not open has no pages, and says why
            entry["error"] = f"{type(e).__name__}: {e}"
    if "error" in entry:
        return {"count": 0, "pages": [], "error": entry["error"]}
    return {"count": entry["count"], "pages": [entry["pages"][n] for n in want if n in entry["pages"]]}


def excerpt(path: Path, locator: str | None) -> tuple[str, dict[str, Any]]:
    """(the excerpt, meta) of a PDF or of the pages its locator names: their text (of at most SPAN_PAGES_READ pages),
    the page count, and the pages."""
    first, last = pages_of(locator) or (1, 1)
    texts = page_texts(path, first, min(last, first + SPAN_PAGES_READ - 1))
    meta: dict[str, Any] = {"pdf": True, "pages": texts["count"]}
    if texts.get("error"):
        meta["error"] = texts["error"]
        return "(a PDF that does not open)", meta
    if first > texts["count"]:
        meta["missing"] = True
        return f"(the PDF has {texts['count']} pages)", meta
    meta["page"] = first
    last = min(last, texts["count"])
    if last > first:
        meta["last_page"] = last
    text = "\n\n".join(texts["pages"]).strip()
    return (text[:EXCERPT_CHARS] if text else "(no text on this page: a scan or an image)"), meta


@router.get("/corpora/{c}/pdf/{path:path}")
def get_pdf(c: str, path: str, request: Request) -> FileResponse:
    """The PDF itself, for the browser's viewer, at a URL that ends in its name, which the viewer shows as its title: 415
    for a file not named .pdf. Ranges are answered, so a large file opens at a page without loading whole."""
    if not is_pdf(path):
        raise HTTPException(415, f"{path} is not a PDF")
    p = corpus._file(corpus._corpus(c), path)
    corpus._viewed(c, path, request)
    return FileResponse(p, media_type="application/pdf", headers=PDF_HEADERS)
