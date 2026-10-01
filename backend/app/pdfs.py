"""PDFs of the corpus as themselves: the File browser shows the real file in the browser's own PDF viewer, and a
citation `<path>#p<n>` (or `#p<n>-p<m>`, pages counted from 1) opens it at that page.

GET /corpora/{c}/pdf/<path> serves the file as application/pdf with nosniff, so a browser reads it only as a PDF, in
its own viewer, and with a policy that lets only the app's pages frame it. page_texts() reads each page's text with
pypdf, kept per path while its size and mtime_ns stay the same, for the excerpt a citation of a page resolves to.
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


def page_texts(path: Path) -> dict[str, Any]:
    """{"pages": [text of page 1, ...]} or {"pages": [], "error": why} for a PDF that does not open; kept per path and
    (size, mtime_ns)."""
    st = path.stat()
    key = (st.st_size, st.st_mtime_ns)
    k = str(path)
    with _lock:
        hit = _TEXTS.get(k)
        if hit is not None and hit[0] == key:
            _TEXTS.move_to_end(k)
            return hit[1]
    try:
        from pypdf import PdfReader  # noqa: PLC0415

        reader = PdfReader(str(path))
        out: dict[str, Any] = {"pages": [(page.extract_text() or "").strip() for page in reader.pages]}
    except Exception as e:  # noqa: BLE001 — a PDF that does not open has no pages, and says why
        out = {"pages": [], "error": f"{type(e).__name__}: {e}"}
    with _lock:
        _TEXTS[k] = (key, out)
        _TEXTS.move_to_end(k)
        while len(_TEXTS) > TEXTS_CACHE_MAX:
            _TEXTS.popitem(last=False)
    return out


def excerpt(path: Path, locator: str | None) -> tuple[str, dict[str, Any]]:
    """(the excerpt, meta) of a PDF or of the pages its locator names: their text, the page count, and the pages."""
    texts = page_texts(path)
    pages = texts["pages"]
    meta: dict[str, Any] = {"pdf": True, "pages": len(pages)}
    if texts.get("error"):
        meta["error"] = texts["error"]
        return "(a PDF that does not open)", meta
    span = pages_of(locator) or (1, 1)
    first, last = span[0], min(span[1], len(pages))
    if first > len(pages):
        meta["missing"] = True
        return f"(the PDF has {len(pages)} pages)", meta
    meta["page"] = first
    if last > first:
        meta["last_page"] = last
    text = "\n\n".join(pages[first - 1:last]).strip()
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
