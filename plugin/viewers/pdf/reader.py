# PDF: a file-type viewer, written once for every corpus. A PDF is read with pypdf, one text per page, and cited as
# <path>#p<n> for a page or <path>#p<n>-p<m> for a run of pages, counting from 1 the way Claude Code's Read counts
# them. The index holds each page's extracted text, so a page opens and resolves without reading the file again. A
# scanned page has no text layer, so its excerpt is empty and a value cited on it cannot be checked.
#
# The data (sample/): the PDFs of a corpus in its own folders: reports in reports/, one summary per run in runs/<run>/,
# scans in scans/ and what a download left in uploads/. What the reader meets there:
#   - a page with a text layer, whose text pypdf extracts, a table as lines of spaced columns;
#   - a scanned page, an image with no text layer, whose text is empty;
#   - a PDF that does not open: cut off before its end, empty, or an error page a download saved as .pdf. It has no
#     pages, and problems() lists it with the error pypdf raised, for thimble to show.
#
# The method: records answers the page with the PDFs and their page counts, one PDF's pages with each one's first line,
# and the pages' texts, TEXTS_MAX a fetch. A search names the pages whose text holds its words, in every PDF.
import re

EXCERPT_CHARS = 1500  # of a page's text, cut at a line boundary
TEXTS_MAX = 50  # pages one fetch of texts returns


def build_index(paths):
    """{path: {"pages": [text of page 1, ...], "error"?}}."""
    from pypdf import PdfReader  # the kernel's environment ships pypdf for this viewer

    index = {}
    for path in sorted(paths):
        try:
            reader = PdfReader(path)
            index[path] = {"pages": [(page.extract_text() or "").strip() for page in reader.pages]}
        except Exception as e:  # noqa: BLE001 — a PDF that does not open is listed with the reason
            index[path] = {"pages": [], "error": f"{type(e).__name__}: {e}"}
    return index


def _cut(text, limit=EXCERPT_CHARS):
    if len(text) <= limit:
        return text
    kept, size = [], 0
    for ln in text.split("\n"):
        if size + len(ln) + 1 > limit and kept:
            break
        kept.append(ln)
        size += len(ln) + 1
    return "\n".join(kept)


def _hits(entry, q):
    """The numbers of the pages whose text holds `q`, ignoring case; every page for no `q`."""
    q = str(q or "").strip().lower()
    return [i + 1 for i, t in enumerate(entry["pages"]) if not q or q in t.lower()]


def records(index, query):
    """{op: files, q?} lists the PDFs with their page counts, and with q how many of each one's pages hold it;
    {op: pages, path, q?} gives each page's number, first line and length, only the pages holding q when it is given;
    {op: texts, path, from?} gives the texts of TEXTS_MAX pages from page `from` on, and `next`; {op: page, path, page}
    gives one page's text."""
    query = query or {}
    op, path, q = query.get("op"), query.get("path"), query.get("q")
    if op == "files":
        return [{"path": p, "pages": len(e["pages"]), "error": e.get("error"),
                 **({"hits": len(_hits(e, q))} if q else {})} for p, e in index.items()]
    entry = index.get(path)
    if entry is None:
        return None
    if op == "page":
        n = int(query.get("page") or 1)
        if not 1 <= n <= len(entry["pages"]):
            return None
        return {"path": path, "page": n, "pages": len(entry["pages"]), "text": entry["pages"][n - 1]}
    if op == "texts":
        start = max(1, int(query.get("from") or 1))
        stop = min(len(entry["pages"]), start + TEXTS_MAX - 1)
        return {"path": path, "pages": len(entry["pages"]),
                "texts": [[n, entry["pages"][n - 1]] for n in range(start, stop + 1)],
                "next": stop + 1 if stop < len(entry["pages"]) else None}
    pages = entry["pages"]
    return {"path": path, "error": entry.get("error"), "total": len(pages),
            "pages": [{"page": n, "first": next((ln for ln in pages[n - 1].split("\n") if ln.strip()), ""),
                       "chars": len(pages[n - 1])} for n in _hits(entry, q)]}


def resolve(index, locator):
    """p<n>: the page's text. p<n>-p<m>: the texts of those pages, in order."""
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    entry = index.get(path)
    m = re.fullmatch(r"p(\d+)(?:-p(\d+))?", fragment)
    if entry is None or "key" in locator or not m:
        return None
    first = int(m.group(1))
    last = int(m.group(2) or first)
    if not 1 <= first <= last <= len(entry["pages"]):
        return None
    text = "\n\n".join(entry["pages"][first - 1:last])
    label = f"p. {first}" if first == last else f"pp. {first}–{last}"
    return {"excerpt": _cut(text), "label": label + ("" if text.strip() else ", no text layer"),
            "refs": [f"{path}#{fragment}"], "target": {"path": path, "page": first, "to": last}}


def problems(index):
    """The PDFs that do not open, each {ref, why}, which thimble shows beside the page."""
    return [{"ref": path, "why": f"not a PDF pypdf can open ({e['error']})"}
            for path, e in index.items() if e.get("error")]
