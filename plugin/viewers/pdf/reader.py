# PDF: a file-type viewer, written once for every corpus. A PDF is read with pypdf, one text per page, and cited as
# <path>#p<n> for a page or <path>#p<n>-p<m> for a run of pages, counting from 1 the way Claude Code's Read counts
# them. The index holds each page's extracted text, so a page opens and resolves without reading the file again. A
# scanned page has no text layer, so its excerpt is empty and a value cited on it cannot be checked.
import re

EXCERPT_CHARS = 1500  # of a page's text, cut at a line boundary


def build_index(paths):
    """{path: {"pages": [text of page 1, ...], "error"?}}."""
    from pypdf import PdfReader  # the kernel's environment ships pypdf for this viewer

    index = {}
    for path in paths:
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


def records(index, query):
    """{op: files} lists the PDFs with their page counts; {op: pages, path} gives each page's number, first line and
    length; {op: page, path, page} gives one page's text."""
    query = query or {}
    op, path = query.get("op"), query.get("path")
    if op == "files":
        return [{"path": p, "pages": len(e["pages"]), "error": e.get("error")} for p, e in index.items()]
    entry = index.get(path)
    if entry is None:
        return None
    if op == "page":
        n = int(query.get("page") or 1)
        if not 1 <= n <= len(entry["pages"]):
            return None
        return {"path": path, "page": n, "pages": len(entry["pages"]), "text": entry["pages"][n - 1]}
    return {"path": path, "error": entry.get("error"),
            "pages": [{"page": i + 1, "first": next((ln for ln in t.split("\n") if ln.strip()), ""), "chars": len(t)}
                      for i, t in enumerate(entry["pages"])]}


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
