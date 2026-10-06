# Capture Timeline: every Arquivo.pt "save a web page" capture of each government site, a lane per section.
# The transluce-gov-2 orientation's reader, with the view kit's Colour by: each lane minute counts its captures by the
# value of the chosen field (the answer class by default, the status code, the content type, the host, a saved response
# or a withheld address) or of a label (thimble.colour_value), the values turned off (thimble.colour_on) leave the bars,
# the log and every count but the chips' own, and a log run never mixes two values of the chosen field.
#
# The data: one arquivo-captures.csv per section folder (01-education, 03-kansas, ...), a header row and then one row
# per capture: record_number, captured_at_utc (UTC, YYYY-MM-DDTHH:MM:SSZ, to the second), archive_url (the capture's
# replay on arquivo.pt), target_url (the page asked for), indexed_http_status (what the site answered), reviewed_origin_
# status (set in one section only), mime, archive_digest_sha1_base32, warc_filename, warc_offset, warc_record_length,
# collection and source_url_redacted (True or False). The rows are not in time order. A section's sources.csv, which
# the view does not claim, names for some archive URLs a responses/*.txt file holding the body the site sent; the
# reader joins it on the archive URL (or on the SHA256 a withheld URL gives) to show that body in a capture's details.
#
# The records: a capture is one row, cited <file>#L<n>. Its section is its folder; its site is the folder's name with
# the section's most common host; its status class is 2xx, 3xx, 4xx, 5xx or other; its host is the part of target_url
# between // and the path, as written (user@host, a port, a trailing dot and a raw IP stay as they are).
#
# The cleaning:
#   times       captured_at_utc becomes seconds since 1970; a row whose time does not read is a problem
#   order       each section's captures are sorted by time, and the captures of one second by target_url with its
#               numbers compared as numbers, since the files give no order within a second
#   bad rows    a row that is not valid CSV, has fewer cells than the header, or has no record_number or time is no
#               capture, and problems() lists it
#
# The method: the index keeps every capture as a row of small integers in arrays (time, line, status, mime, host, ...),
# section by section in time order, with every target_url in one byte string, and for each URL two checksums: of the
# URL with its cache-busting values blanked, and of that with its numbers blanked. `records` answers the page:
#   lanes   per section and minute, the captures by status class and by the first label value marking them, after
#           every filter; the lanes' axes are the section's active periods, which a gap of over an hour splits
#   log     one section's captures in a time range, in time order, as runs: captures in a row that answer in the same
#           status class and whose URLs differ only in cache-busting values, or only in one number that goes up by 1
#           to 3 at each step, are one run; each run's URL is percent-decoded and the part that changed since the
#           previous distinct URL is marked
#   run     the captures of one run
#   record  one capture in full, its row as the file holds it and the response body sources.csv names for it
#
# Units: a section (03-kansas) and a section's captures between two UTC times (03-kansas/2026-05-07T12:20:00..
# 2026-05-07T12:30:00).
#
# Labels: they apply when records are served, never in the index. Every answer keeps only the captures thimble.kept
# holds for, and each lane minute and log run carries the label values thimble.marked gives its captures.
import bisect
import calendar
import os
import csv
import difflib
import re
import zlib
from array import array
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import PurePosixPath

import thimble

CLASSES = ("2xx", "3xx", "4xx", "5xx", "other")
GAP = 3600  # seconds without a capture that split a lane's axis
PAGE = 200  # log runs a fetch returns
MEMBERS = 200  # run members a fetch returns
UNIT_REFS = 200  # refs a unit's citation carries
EXCERPT_ROWS = 12  # rows a unit's excerpt quotes
CACHE_MAX = 8  # filtered sequences and their runs kept between calls
WAYBACK = "https://arquivo.pt/wayback/"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
# query parameters whose value is there to defeat a cache, whatever it holds
CB_NAMES = frozenset({"zz", "zzbulk", "uniq", "cb", "_cb", "_", "nonce", "prepnonce", "bulk", "n", "harvest", "prep",
                      "__apncb", "retry", "u", "rand", "rnd", "random", "r", "cachebust", "nocache", "cache", "bust",
                      "dummy", "z", "ck", "x"})
# a value that reads as a nonce: a run of 13 or more digits (epoch milliseconds or nanoseconds), epoch seconds with a
# fraction, a long random fraction, or a 20-character token of letters and digits
NONCE = re.compile(r".*?(?:\d{13}|\d{9,10}\.\d{3}|^0?\.\d{8}).*|(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-]{20,}")
NAMED_SHORT = re.compile(r"[A-Za-z]{1,6}\d{0,3}")  # a short word value, kept even under a cache-busting name
TOK = re.compile(r"%[0-9A-Fa-f]{2}|-?\d+")  # a percent escape (kept whole) or a number
ESC = re.compile(r"(?:%[0-9A-Fa-f]{2})+")
PATH_SPLIT = re.compile(r"([/.;:@#]+|[\x00\x01])")
MARK_SPLIT = re.compile(r"([\x00\x01])")
SEP = re.compile(r"[/.;:@#?&=]+")
SEPS = frozenset("?&=")
ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
STAMP = re.compile(r"(\d{14})(?:[a-z]{2}_)?/(.*)", re.S)
WITHHELD = re.compile(r"SHA256 ([0-9a-f]{64})")
UNIT_SPAN = re.compile(r"([^/]+)/(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?)\.\.(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?)")
SHORT = {"new", "the", "of", "and", "for"}

_cache = OrderedDict()  # (index token, what) -> a URL search's rows, or a filtered sequence and its runs


# ---------------------------------------------------------------- small parts


def _epoch(s, days={}):  # noqa: B006 — a cache of each day's midnight
    """Seconds since 1970 of a YYYY-MM-DDTHH:MM:SSZ time, or None."""
    if len(s) != 20 or not ISO.fullmatch(s):
        return None
    d = s[:10]
    base = days.get(d)
    if base is None:
        try:
            base = days[d] = calendar.timegm(datetime.strptime(d, "%Y-%m-%d").timetuple())
        except ValueError:
            return None
    h, m, sec = int(s[11:13]), int(s[14:16]), int(s[17:19])
    if h > 23 or m > 59 or sec > 60:
        return None
    return base + h * 3600 + m * 60 + sec


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _when(t):
    d = datetime.fromtimestamp(t, timezone.utc)
    return f"{d.day} {MONTHS[d.month - 1]} {d:%H:%M:%S}"


def _host(u):
    """The part of a URL between // and the path, as written."""
    i = u.find("//")
    if i < 0 or i > 8:
        return ""
    j = i + 2
    k = len(u)
    for c in "/?#":
        x = u.find(c, j)
        if 0 <= x < k:
            k = x
    return u[j:k]


def _site_host(h):
    """A host as a site's name: lower case, without user@, port, trailing dot or www."""
    h = h.lower().rsplit("@", 1)[-1]
    h = re.sub(r":\d+$", "", h).rstrip(".")
    return h[4:] if h.startswith("www.") else h


def _site_name(folder):
    """A section folder's name as words: 03-kansas is Kansas, 06-new-york New York, 12-bea BEA."""
    words = [w for w in re.sub(r"^\d+[-_ ]*", "", folder).replace("_", "-").split("-") if w]
    out = []
    for w in words:
        if w == "gov" and out:
            out[-1] += ".gov"
        elif len(w) <= 3 and w not in SHORT:
            out.append(w.upper())
        else:
            out.append(w.capitalize())
    return " ".join(out) or folder


def _cls(status):
    return int(status[0]) - 2 if len(status) == 3 and status.isdigit() and status[0] in "2345" else 4


def _norm(u):
    """The URL with each cache-busting query value blanked to \\x00."""
    q = u.find("?")
    if q < 0:
        return u
    parts = u[q + 1:].split("&")
    changed = False
    for i, p in enumerate(parts):
        e = p.find("=")
        if e < 0:
            if len(p) > 8 and NONCE.match(p):
                parts[i] = "\x00"
                changed = True
            continue
        v = p[e + 1:]
        if not v:
            continue
        name = p[:e].lower()
        if (name in CB_NAMES and not (name == "x" and (len(v) < 9 or NAMED_SHORT.fullmatch(v)))) or \
                (len(v) >= 9 and NONCE.match(v)):
            parts[i] = p[:e + 1] + "\x00"
            changed = True
    return u[:q + 1] + "&".join(parts) if changed else u


def _tpl_tok(m):
    s = m.group()
    return s if s[0] == "%" else "#"


def _template(s):
    return TOK.sub(_tpl_tok, s)


def _numbers(s):
    """The numbers of a URL, outside its percent escapes, as (start, end, text)."""
    return [(m.start(), m.end(), m.group()) for m in TOK.finditer(s) if m.group()[0] != "%"]


def _crc(s):
    return zlib.crc32(s.encode("utf-8", "surrogatepass"))


def _esc_rep(m):
    s = m.group()
    try:
        t = bytes.fromhex(s.replace("%", "")).decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        return s
    return s if any(ord(c) < 32 or ord(c) == 127 for c in t) else t


def _decode(s):
    """Percent escapes decoded where they make UTF-8 text without control characters; the rest as written."""
    return ESC.sub(_esc_rep, s) if "%" in s else s


def _natural(u):
    return re.sub(r"\d+", lambda m: f"{len(m.group()):03d}{m.group()}", u)


MIME_SHORT = {"vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "vnd.ms-excel": "xls",
              "x-zip-compressed": "zip", "javascript": "js", "x-javascript": "js", "plain": "text",
              "octet-stream": "binary", "problem+json": "json", "x-font-woff": "woff"}


def _mime_short(m):
    """A mime type as the page names it: its subtype, a few long ones shortened (xlsx, xls, zip, js, text)."""
    s = (m or "").split(";")[0].strip().lower()
    if not s:
        return None
    sub = s.split("/", 1)[1] if "/" in s else s
    return MIME_SHORT.get(sub, sub)


# ---------------------------------------------------------------- Colour by


FIELDS = ("answer", "status", "mime", "host", "saved", "withheld")


def _valuer(index, choice):
    """(value, names, kind) under the page's Colour by choice (its colour.query()): value(g) is the id in names of row
    g's value, -1 for none; kind is the field's name, or "label". A field's value is the answer class (2xx to 5xx, none
    for any other status), the status code, the short content type, the host as written, "Saved response" or "Withheld";
    a label's is its highlighted value on the capture (thimble.colour_value)."""
    names, at = [], {}

    def vid(v):
        if v is None or v == "":
            return -1
        i = at.get(v)
        if i is None:
            i = at[v] = len(names)
            names.append(v)
        return i
    ch = choice if isinstance(choice, dict) else {}
    if ch.get("label") is not None:
        files, line, fcol = index["files"], index["line"], index["file"]
        memo = {}

        def by_label(g):
            v = memo.get(g)
            if v is None:
                v = memo[g] = vid(thimble.colour_value(ch, f"{files[fcol[g]]}#L{line[g]}"))
            return v
        return by_label, names, "label"
    field = ch.get("field") if ch.get("field") in FIELDS else "answer"
    nm = index["names"]
    if field == "saved":
        has, sv = index["cited"], vid("Saved response")
        return (lambda g: sv if g in has else -1), names, field
    if field == "answer":
        lut, col = [vid(c) if c != "other" else -1 for c in CLASSES], index["cls"]
    elif field == "status":
        lut, col = [vid(s) for s in nm["st"]], index["st"]
    elif field == "mime":
        lut, col = [vid(_mime_short(m)) for m in nm["mime"]], index["mime"]
    elif field == "host":
        lut, col = [vid(h) for h in nm["host"]], index["host"]
    else:
        lut, col = [vid("Withheld" if r == "True" else None) for r in nm["red"]], index["red"]
    return (lambda g: lut[col[g]]), names, field


def _on_test(choice, names):
    """is_on(id): whether the chip of a value (an id in names, -1 for none) is on, and whether any is off."""
    off = (choice or {}).get("off") if isinstance(choice, dict) else None
    off = off if isinstance(off, list) else []
    if not off:
        return (lambda i: True), False
    none_off = any(x is None for x in off)
    names_off = {str(x) for x in off if x is not None}
    return (lambda i: not none_off if i < 0 else names[i] not in names_off), True


def _name(names, i):
    return None if i < 0 else names[i]


# ---------------------------------------------------------------- the index


def _sources(folder):
    """{match key: {file, http_status, captured_at_utc}} of a section's sources.csv rows that name a responses/ file:
    keyed by (14-digit stamp, target URL) of an archive URL, and by the URL itself (a withheld one names its SHA256)."""
    out = {}
    path = f"{folder}/sources.csv" if folder else "sources.csv"
    try:
        with open(path, encoding="utf-8", newline="") as fh:
            for r in csv.DictReader(fh):
                f, u = (r.get("file") or "").strip(), (r.get("source_url") or "").strip()
                if not f or not u or not f.startswith("responses/"):
                    continue
                info = {"file": f"{folder}/{f}" if folder else f, "http_status": (r.get("http_status") or "").strip(),
                        "captured_at_utc": (r.get("captured_at_utc") or "").strip()}
                out[u] = info
                if u.startswith(WAYBACK) and (m := STAMP.match(u, len(WAYBACK))):
                    out[(m.group(1), m.group(2))] = info
    except (OSError, ValueError, csv.Error):
        pass
    return out


def _cited_info(src, archive):
    if not src:
        return None
    hit = src.get(archive)
    if hit is None and archive.startswith(WAYBACK) and (m := STAMP.match(archive, len(WAYBACK))):
        hit = src.get((m.group(1), m.group(2)))
    return hit


def _read_file(path, fi, ctx):
    """The captures of one file, each (t, line, status, mime, host, red, coll, rev, url, cited info), the byte offset
    of every line, and the first line of each data row as thimble numbers rows (#row=<n>: from 1 after the header,
    blank rows and rows that are not CSV skipped); a row that does not read is a problem."""
    offs = array("q")
    row_line = array("l", [0])
    out = []
    numbers = []

    def lines(fh):
        pos = 0
        for raw in fh:
            offs.append(pos)
            pos += len(raw)
            numbers.append(len(offs))
            yield raw.decode("utf-8", "replace")

    folder = str(PurePosixPath(path).parent)
    folder = "" if folder == "." else folder
    src = _sources(folder)
    with open(path, "rb") as fh:
        rows = csv.reader(lines(fh), strict=True)
        header, done = None, 0
        while True:
            try:
                cells = next(rows)
            except StopIteration:
                break
            except csv.Error as e:
                ctx["problems"].append({"ref": f"{path}#L{numbers[done] if done < len(numbers) else len(numbers)}",
                                        "why": f"not a CSV row ({e})"})
                done = rows.line_num
                continue
            n = numbers[done]
            done = rows.line_num
            if header is None:
                header = {c.strip(): i for i, c in enumerate(cells)}
                ctx["headers"][fi] = [c.strip() for c in cells]
                missing = [c for c in ("captured_at_utc", "target_url") if c not in header]
                if missing:
                    ctx["problems"].append({"ref": f"{path}#L{n}", "why": "no " + " or ".join(missing) + " column"})
                    return out, offs, row_line
                continue
            if not any(c.strip() for c in cells):
                continue
            row_line.append(n)
            if len(cells) < len(header):
                ctx["problems"].append({"ref": f"{path}#L{n}",
                                        "why": f"a row of {len(cells)} cells where the header has {len(header)}"})
                continue
            get = lambda k: cells[header[k]] if k in header else ""  # noqa: E731
            t = _epoch(get("captured_at_utc").strip())
            if t is None:
                ctx["problems"].append({"ref": f"{path}#L{n}", "why": "captured_at_utc is not a UTC time"})
                continue
            if "record_number" in header and not get("record_number").strip().isdigit():
                ctx["problems"].append({"ref": f"{path}#L{n}", "why": "record_number is not a number"})
                continue
            red = get("source_url_redacted").strip()
            if red not in ("True", "False", ""):
                ctx["problems"].append({"ref": f"{path}#L{n}", "why": "source_url_redacted is neither True nor False"})
                continue
            url = get("target_url")
            out.append((t, n, get("indexed_http_status").strip(), get("mime").strip(), _host(url), red,
                        get("collection").strip(), get("reviewed_origin_status").strip(), url,
                        _cited_info(src, get("archive_url").strip())))
    return out, offs, row_line


def _ider(names):
    at = {v: i for i, v in enumerate(names)}

    def get(v):
        i = at.get(v)
        if i is None:
            i = at[v] = len(names)
            names.append(v)
        return i
    return get


def build_index(paths):
    """{"files": [path per section], "secs": [{id, name, host, file, a, b, segs, minutes}], one array per field of
    every capture in section and time order ("t", "line", "st", "cls", "mime", "host", "red", "coll", "rev", "hn",
    "ht"), "names": {field: [value]}, "urls" (every target_url joined by newlines) with "uoff", "dec" ({row: decoded
    URL} of those with percent escapes), "cited" ({row: sources info}), "offsets" ([[byte offset of each line] per
    file]), "row_at" ([array line -> row, -1 for none, per file]), "row_lines" ([array data row -> line per file]),
    "join" and "place" (how each row joins the run before it in its section's whole time order: 0 for none, SAME or NUM,
    and the place of a run's number), "headers", "problems" and "token" (which keys the caches of later calls)}."""
    files = sorted(str(p) for p in paths)
    ctx = {"problems": [], "headers": {}}
    names = {k: [] for k in ("st", "mime", "host", "red", "coll", "rev")}
    ids = {k: _ider(v) for k, v in names.items()}
    cols = {k: array("l") for k in ("t", "line")}
    cols.update({k: array("H") for k in ("st", "mime", "host", "rev")})
    cols.update({k: array("B") for k in ("cls", "red", "coll", "file")})
    cols.update({k: array("L") for k in ("hn", "ht")})
    urls, uoff, dec, cited, secs, offsets, row_at, row_lines = [], array("q"), {}, {}, [], [], [], []
    pos = 0
    for fi, path in enumerate(files):
        thimble.progress(fi, len(files), f"reading {path}")
        try:
            rows, offs, row_line = _read_file(path, fi, ctx)
        except OSError as e:
            ctx["problems"].append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
            rows, offs, row_line = [], array("q"), array("l", [0])
        offsets.append(offs)
        row_lines.append(row_line)
        at = array("l", [-1]) * (len(offs) + 2)
        row_at.append(at)
        # time order, and the captures of one second by URL with numbers as numbers
        order = sorted(range(len(rows)), key=lambda i: rows[i][0])
        k = 0
        while k < len(order):
            j = k + 1
            while j < len(order) and rows[order[j]][0] == rows[order[k]][0]:
                j += 1
            if j - k > 1:
                order[k:j] = sorted(order[k:j], key=lambda i: _natural(rows[i][8]))
            k = j
        a = len(cols["t"])
        hosts = Counter()
        for i in order:
            t, n, st, mime, host, red, coll, rev, url, info = rows[i]
            g = len(cols["t"])
            at[n] = g
            cols["t"].append(t)
            cols["line"].append(n)
            cols["file"].append(fi)
            cols["st"].append(ids["st"](st))
            cols["cls"].append(_cls(st))
            cols["mime"].append(ids["mime"](mime))
            cols["host"].append(ids["host"](host))
            cols["red"].append(ids["red"](red))
            cols["coll"].append(ids["coll"](coll))
            cols["rev"].append(ids["rev"](rev))
            u = url.replace("\n", " ").replace("\r", " ")
            nu = _norm(u)
            cols["hn"].append(_crc(nu))
            cols["ht"].append(_crc(_template(nu)))
            urls.append(u)
            uoff.append(pos)
            pos += len(u.encode("utf-8", "surrogatepass")) + 1
            if "%" in u:
                d = _decode(u)
                if d != u:
                    dec[g] = d
            if info:
                cited[g] = info
            hosts[_site_host(host)] += 1
        b = len(cols["t"])
        if b == a:
            continue
        folder = str(PurePosixPath(path).parent)
        ts = cols["t"]
        segs, s0 = [], ts[a]
        for g in range(a + 1, b):
            if ts[g] - ts[g - 1] > GAP:
                segs.append([s0 - s0 % 60, ts[g - 1] - ts[g - 1] % 60 + 60])
                s0 = ts[g]
        segs.append([s0 - s0 % 60, ts[b - 1] - ts[b - 1] % 60 + 60])
        top = next((h for h, _ in hosts.most_common() if h), "")
        secs.append({"id": folder if folder != "." else PurePosixPath(path).stem, "name": _site_name(folder),
                     "host": top, "file": fi, "a": a, "b": b, "segs": segs})
    uoff.append(pos)
    thimble.progress(len(files), len(files), "counting minutes")
    index = {"token": os.urandom(8).hex(), "files": files, "secs": secs, "names": names,
             "urls": "\n".join(urls).encode("utf-8", "surrogatepass"), "uoff": uoff, "dec": dec, "cited": cited, "offsets": offsets, "row_at": row_at, "row_lines": row_lines,
             "headers": ctx["headers"], "problems": ctx["problems"], **cols}
    join, place = array("b", bytes(len(cols["t"]))), array("h", [-1]) * len(cols["t"])
    answer, _names, _kind = _valuer(index, None)
    for k, s in enumerate(secs):
        thimble.progress(k, len(secs), f"finding runs in {s['name']}")
        s["minutes"] = _minutes(index, s, range(s["a"], s["b"]), answer, lambda i: True)
        rows = range(s["a"], s["b"])
        starts, modes, poses = _runs(index, rows)
        for r in range(len(starts)):
            a = starts[r]
            b = starts[r + 1] if r + 1 < len(starts) else len(rows)
            for i in range(a + 1, b):
                join[rows[i]] = modes[r]
                place[rows[i]] = poses[r]
    index["join"], index["place"] = join, place
    return index


# ---------------------------------------------------------------- filters and labels


def _url(index, g):
    u = index["uoff"]
    return index["urls"][u[g]:u[g + 1] - 1].decode("utf-8", "surrogatepass")


def _ref(index, g):
    return f"{index['files'][index['file'][g]]}#L{index['line'][g]}"


def _ints(v):
    return [x for x in v if isinstance(x, int) and not isinstance(x, bool)] if isinstance(v, list) else []


def _url_mask(index, q, rx):
    """A bytearray, 1 for each row whose target_url, as written or percent-decoded, holds q (ignoring case); with rx,
    matches the regular expression q. Raises ValueError for a pattern that does not compile."""
    key = (index.get("token"), "url", q, bool(rx))
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    try:
        pat = re.compile(q if rx else re.escape(q), re.I | re.M)
        bpat = re.compile((q if rx else re.escape(q)).encode("utf-8"), re.I | re.M)
    except re.error as e:
        raise ValueError(str(e)) from None
    except (UnicodeEncodeError, TypeError):
        bpat = None
    n = len(index["t"])
    mask = bytearray(n)
    blob, uoff = index["urls"], index["uoff"]
    if bpat is not None:
        p, end = 0, len(blob)
        while p <= end:
            m = bpat.search(blob, p)
            if not m:
                break
            g = bisect.bisect_right(uoff, m.start()) - 1
            if g >= n:
                break
            if m.end() <= uoff[g + 1] - 1 or m.start() == m.end():
                mask[g] = 1
                p = uoff[g + 1]
            else:  # a match across two URLs: look again from inside this one
                p = m.start() + 1
    for g, d in index["dec"].items():
        if not mask[g] and pat.search(d):
            mask[g] = 1
    _remember(key, mask)
    return mask


def _remember(key, value):
    _cache[key] = value
    _cache.move_to_end(key)
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)


def _filter(index, f):
    """A function row -> bool for every filter but the label filter, or None when no filter is set."""
    f = f if isinstance(f, dict) else {}
    tests = []
    for k in ("cls", "mime", "host", "red", "coll"):
        v = _ints(f.get(k))
        if f.get(k) is not None and isinstance(f.get(k), list):
            allow = bytearray(max(len(index["names"].get(k, [])), len(CLASSES)) + 1)
            for x in v:
                if 0 <= x < len(allow):
                    allow[x] = 1
            tests.append((index[k], allow))
    cited = f.get("cited")
    q = f.get("q")
    mask = _url_mask(index, q, f.get("rx")) if isinstance(q, str) and q else None
    if not tests and mask is None and cited not in (True, False):
        return None
    has = index["cited"]

    def keep(g):
        for col, allow in tests:
            if not allow[col[g]]:
                return False
        if mask is not None and not mask[g]:
            return False
        if cited is True and g not in has:
            return False
        if cited is False and g in has:
            return False
        return True
    return keep


def _filtered():
    """Whether the analyst filters by a label's value (thimble.view_labels)."""
    return bool((thimble.view_labels() or {}).get("filter"))


# ---------------------------------------------------------------- lanes


def _minutes(index, sec, rows, value, is_on):
    """{m: [minute since the section's first minute], c: [[value id, captures, value id, captures, ...] per minute]
    (id -1 for no value), total, peak (the most captures in a minute) and peak_t (the start of the first such minute),
    by: [[value id, captures]] of the lane, first and last (the times of its first and last capture)} of the rows whose
    value's chip is on, and allc: [[value id, captures]] of all the rows, those of a value turned off too (the chips'
    counts)."""
    t0 = sec["segs"][0][0]
    ts = index["t"]
    per, allc, by = {}, {}, {}
    first = last = None
    for g in rows:
        v = value(g)
        allc[v] = allc.get(v, 0) + 1
        if not is_on(v):
            continue
        by[v] = by.get(v, 0) + 1
        t = ts[g]
        m = (t - t0) // 60
        d = per.get(m)
        if d is None:
            d = per[m] = {}
        d[v] = d.get(v, 0) + 1
        if first is None or t < first:
            first = t
        if last is None or t > last:
            last = t
    ms = sorted(per)
    sums = [sum(per[m].values()) for m in ms]
    peak = max(sums, default=0)
    flat = []
    for m in ms:
        row = []
        for v, n in sorted(per[m].items()):
            row += (v, n)
        flat.append(row)
    return {"m": ms, "c": flat, "total": sum(sums), "peak": peak,
            "peak_t": t0 + ms[sums.index(peak)] * 60 if sums else None,
            "by": sorted([v, n] for v, n in by.items()), "allc": sorted([v, n] for v, n in allc.items()),
            "first": first, "last": last}


def _lanes(index, query):
    f = query.get("f") if isinstance(query.get("f"), dict) else {}
    want = query.get("secs")
    want = set(want) if isinstance(want, list) else None
    filtered = _filtered()
    keep = _filter(index, f)
    choice = query.get("colour")
    value, names, kind = _valuer(index, choice)
    is_on, some_off = _on_test(choice, names)
    out = []
    secs = [s for s in index["secs"] if want is None or s["id"] in want]
    for k, s in enumerate(secs):
        thimble.progress(k, len(secs), f"counting {s['name']}")
        base = {"id": s["id"], "name": s["name"], "host": s["host"], "segs": s["segs"], "all": s["b"] - s["a"],
                "file": index["files"][s["file"]]}
        if keep is None and not filtered and kind == "answer" and not some_off:
            out.append({**base, **s["minutes"]})
            continue
        fname = index["files"][s["file"]]
        line = index["line"]
        rows = range(s["a"], s["b"])
        if keep is not None:
            rows = [g for g in rows if keep(g)]
        if filtered:
            rows = [g for g in rows if thimble.kept(f"{fname}#L{line[g]}")]
        out.append({**base, **_minutes(index, s, rows, value, is_on)})
    return {"lanes": out, "vals": names, "kind": kind}


def _facets(index):
    """Every value of each filter field with its count, each host's sections, and each section's hosts with their
    counts."""
    out = {}
    for k in ("mime", "host", "red", "coll", "st"):
        n = Counter(index[k])
        out[k] = [[i, v, n.get(i, 0)] for i, v in enumerate(index["names"][k])]
    host_secs = {}
    for s in index["secs"]:
        for h in set(index["host"][s["a"]:s["b"]]):
            host_secs.setdefault(h, []).append(s["id"])
    out["host_secs"] = {str(h): v for h, v in host_secs.items()}
    out["sec_hosts"] = {s["id"]: Counter(index["host"][s["a"]:s["b"]]).most_common() for s in index["secs"]}
    cls = Counter(index["cls"])
    out["cls"] = [[i, c, cls.get(i, 0)] for i, c in enumerate(CLASSES)]
    out["cited"] = len(index["cited"])
    out["total"] = len(index["t"])
    return out


# ---------------------------------------------------------------- the log


def _sec(index, sid):
    return next((s for s in index["secs"] if s["id"] == sid), None)


def _span(index, s, a, b):
    """The rows of section s with a <= t <= b (either may be None)."""
    ts = index["t"]
    lo = s["a"] if a is None else bisect.bisect_left(ts, a, s["a"], s["b"])
    hi = s["b"] if b is None else bisect.bisect_right(ts, b, s["a"], s["b"])
    return lo, hi


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _sequence(index, query):
    """(rows, starts, modes, poses): the rows of one section in a time range that pass every filter, in time order,
    and the runs they fall in (each run's first position in rows, its kind, and for a run of numbers the number's
    place), cached for the filters that do not depend on the labels."""
    s = _sec(index, query.get("sec"))
    if s is None:
        return None, None
    a, b = _num(query.get("a")), _num(query.get("b"))
    f = query.get("f") if isinstance(query.get("f"), dict) else {}
    on = thimble.view_labels() or {}
    filt = on.get("filter")
    choice = query.get("colour")
    value, names, kind = _valuer(index, choice)
    is_on, some_off = _on_test(choice, names)
    # runs of a field other than the answer class break where its value changes; a label's values change with the
    # labels, so its sequences are not kept
    split = value if kind not in ("answer", "label") else None
    key = (index.get("token"), "seq", s["id"], a, b, repr(sorted((k, repr(v)) for k, v in f.items())),
           repr(sorted((choice or {}).items())) if isinstance(choice, dict) else None)
    if not filt and kind != "label" and key in _cache:
        _cache.move_to_end(key)
        return s, _cache[key]
    lo, hi = _span(index, s, a, b)
    keep = _filter(index, f)
    if keep is None and not filt and not some_off:
        seq = (array("l", range(lo, hi)), *_clipped(index, lo, hi, split))
    else:
        rows = range(lo, hi) if keep is None else [g for g in range(lo, hi) if keep(g)]
        if filt:
            fname, line = index["files"][s["file"]], index["line"]
            rows = [g for g in rows if thimble.kept(f"{fname}#L{line[g]}")]
        if some_off:
            rows = [g for g in rows if is_on(value(g))]
        seq = (array("l", rows), *_runs(index, rows, split))
    if not filt and kind != "label":
        _remember(key, seq)
    return s, seq


SAME, NUM, ONE = 1, 2, 0


def _clipped(index, lo, hi, split=None):
    """The runs of the unfiltered rows lo..hi-1, from the runs build_index found in the whole section, a run cut at
    either end kept as far as it reaches, and with `split` (row -> value) cut where the value changes."""
    join, place = index["join"], index["place"]
    starts, modes, poses = array("l"), array("b"), array("l")
    for k in range(hi - lo):
        g = lo + k
        if k == 0 or not join[g] or (split is not None and split(g) != split(g - 1)):
            starts.append(k)
            modes.append(ONE)
            poses.append(-1)
        elif modes[-1] == ONE:
            modes[-1] = join[g]
            poses[-1] = place[g]
    return starts, modes, poses


def _runs(index, rows, split=None):
    """Each run's first position in rows, its kind (ONE, SAME or NUM) and its number's place (-1 for none). Captures
    in a row join a run when they answer in the same status class (and with `split`, row -> value, take the same
    value) and their URLs, cache-busting values blanked, are the same (SAME), or differ only in one number, at the same
    place, that goes up by 1 to 3 at each step (NUM)."""
    cls, hn, ht = index["cls"], index["hn"], index["ht"]
    starts, modes, poses = array("l"), array("b"), array("l")
    mode = ONE
    prev = -1
    prev_norm = None  # (normalized URL, its numbers) of the last capture, computed when needed
    for k, g in enumerate(rows):
        if prev >= 0 and cls[g] == cls[prev] and (split is None or split(g) == split(prev)):
            if mode != NUM and hn[g] == hn[prev]:
                a = prev_norm[0] if prev_norm else _norm(_url(index, prev))
                b = _norm(_url(index, g))
                if a == b:
                    mode = modes[-1] = SAME
                    prev, prev_norm = g, (b, None)
                    continue
            elif mode != SAME and ht[g] == ht[prev] and hn[g] != hn[prev]:
                a = prev_norm[0] if prev_norm else _norm(_url(index, prev))
                b = _norm(_url(index, g))
                na = prev_norm[1] if prev_norm and prev_norm[1] is not None else _numbers(a)
                nb = _numbers(b)
                if len(na) == len(nb):
                    diff = [i for i, (x, y) in enumerate(zip(na, nb)) if x[2] != y[2]]
                    if len(diff) == 1 and (mode == ONE or diff[0] == poses[-1]):
                        try:
                            d = int(nb[diff[0]][2]) - int(na[diff[0]][2])
                        except ValueError:
                            d = 0
                        if 0 < d <= 3:
                            mode = modes[-1] = NUM
                            poses[-1] = diff[0]
                            prev, prev_norm = g, (b, nb)
                            continue
                prev_norm = (b, nb)
                starts.append(k)
                modes.append(ONE)
                poses.append(-1)
                mode, prev = ONE, g
                continue
        starts.append(k)
        modes.append(ONE)
        poses.append(-1)
        mode, prev, prev_norm = ONE, g, None
    return starts, modes, poses


def _shown(index, first, last, mode, pos):
    """The tokens of a run's URL as the log shows it: percent-decoded, a cache-busting value as \\x00, and for a run
    of numbers the number as \\x01 with (low, high) beside."""
    s = _norm(_url(index, first))
    span = None
    if mode == NUM and pos >= 0:
        na = _numbers(s)
        nb = _numbers(_norm(_url(index, last)))
        if pos < len(na) and pos < len(nb):
            a, b, lo = na[pos]
            s = s[:a] + "\x01" + s[b:]
            span = (lo, nb[pos][2])
    return _tokens(s), span


def _tokens(s):
    """A normalized URL's tokens, each percent-decoded: the path split at / . ; : @ #, and each query parameter as
    its name, = and its whole value, with the markers \\x00 and \\x01 as tokens of their own."""
    q = s.find("?")
    path, query = (s, None) if q < 0 else (s[:q], s[q + 1:])
    out = [t for t in PATH_SPLIT.split(path) if t]
    if query is not None:
        out.append("?")
        for i, p in enumerate(query.split("&")):
            if i:
                out.append("&")
            e = p.find("=")
            parts = [p] if e < 0 else [p[:e], "=", p[e + 1:]]
            for x in parts:
                out.extend(t for t in MARK_SPLIT.split(x) if t)
    return [t if t in SEPS or t in ("\x00", "\x01") else _decode(t) for t in out]


def _segments(toks, span, prev):
    """[[text, kind]] of a run's URL: kind 1 for the tokens that changed since `prev` (the previous distinct URL's
    tokens), 2 for a cache-busting value, 4 for the range of a run's number; kinds add."""
    def key(t):
        return f"\x01{span[0]}–{span[1]}" if t == "\x01" and span else t
    cur = [key(t) for t in toks]
    changed = [False] * len(toks)
    if prev is not None:
        sm = difflib.SequenceMatcher(None, prev, cur, autojunk=False)
        for op, _i1, _i2, j1, j2 in sm.get_opcodes():
            if op in ("replace", "insert"):
                for j in range(j1, j2):
                    changed[j] = not SEP.fullmatch(toks[j])
    out = []
    for t, c in zip(toks, changed):
        if t == "\x00":
            text, kind = "…", 2
        elif t == "\x01":
            text, kind = (f"{span[0]}–{span[1]}" if span else "#"), 4 | (1 if c else 0)
        else:
            text, kind = t, 1 if c else 0
        if out and out[-1][1] == kind:
            out[-1][0] += text
        else:
            out.append([text, kind])
    return out, cur


def _run_rows(index, rows, starts, i):
    """The positions in rows of run i's first capture and of the one after its last."""
    a = starts[i]
    b = starts[i + 1] if i + 1 < len(starts) else len(rows)
    return a, b


def _log(index, query):
    s, seq = _sequence(index, query)
    if s is None:
        return {"error": "no such section", "rows": [], "runs": 0, "captures": 0}
    rows, starts, modes, poses = seq
    nruns = len(starts)
    off = query.get("off")
    at = query.get("at")
    at_run = None
    if isinstance(at, str):  # a capture's ref: the page that holds its run
        g = _g_of_ref(index, at)
        if g is not None:
            k = _position(rows, g)
            if k is not None:
                at_run = bisect.bisect_right(starts, k) - 1
                off = max(0, at_run - PAGE // 4)
    off = off if isinstance(off, int) and not isinstance(off, bool) and 0 <= off else 0
    lim = query.get("lim")
    lim = lim if isinstance(lim, int) and not isinstance(lim, bool) and 0 < lim <= 1000 else PAGE
    value, vnames, kind = _valuer(index, query.get("colour"))
    fname = index["files"][s["file"]]
    line, names, st_col, mime_col, ts = index["line"], index["names"], index["st"], index["mime"], index["t"]
    # the URL of the run before the page, which the page's first run is compared with
    prev = None
    if off > 0 and off - 1 < nruns:
        a, b = _run_rows(index, rows, starts, off - 1)
        toks, span = _shown(index, rows[a], rows[b - 1], modes[off - 1], poses[off - 1])
        prev = _segments(toks, span, None)[1]
    out = []
    prev_seen = prev
    for r in range(off, min(nruns, off + lim)):
        a, b = _run_rows(index, rows, starts, r)
        first, last_g = rows[a], rows[b - 1]
        toks, span = _shown(index, first, last_g, modes[r], poses[r])
        segs, cur = _segments(toks, span, prev_seen)
        if cur != prev_seen:
            prev_seen = cur
        # a run stands at its first capture; coloured by a label, at its first capture the label marks, so the run
        # shows that label's value
        anchor, nmk = first, 0
        if kind == "label":
            for g in rows[a:b]:
                if value(g) >= 0:
                    if not nmk:
                        anchor = g
                    nmk += 1
        row = {"ref": f"{fname}#L{line[anchor]}", "row_idx": anchor, "run_idx": r,
               "time": _iso(ts[first]) + "Z", "status": names["st"][st_col[first]],
               "mime": names["mime"][mime_col[first]], "n": b - a, "segs": segs, "url": _url(index, first),
               "v": _name(vnames, value(anchor))}
        if anchor != first:
            row["first_time"] = row["time"]
            row["time"] = _iso(ts[anchor]) + "Z"
            row["status"] = names["st"][st_col[anchor]]
            row["mime"] = names["mime"][mime_col[anchor]]
            row["url"] = _url(index, anchor)
        if b - a > 1:
            row["last_time"] = _iso(ts[last_g]) + "Z"
            row["kind"] = "number" if modes[r] == NUM else "same"
            if row["url"] != _url(index, last_g):
                row["last_url"] = _url(index, last_g)
            codes = sorted({names["st"][st_col[g]] for g in rows[a:b]})
            if len(codes) > 1:
                row["codes"] = codes
            if span:
                row["range"] = [span[0], span[1]]
        if any(g in index["cited"] for g in rows[a:b]):
            row["cited"] = True
        if nmk:
            row["marked_n"] = nmk
        out.append(row)
    page = {"rows": out, "off": off, "runs": nruns, "captures": len(rows),
            "span": [ts[rows[0]], ts[rows[-1]]] if len(rows) else None}
    if at_run is not None and off <= at_run < off + len(out):
        page["at_idx"] = at_run - off
    return page


def _position(rows, g):
    """The position of row g in the sorted array rows, or None."""
    k = bisect.bisect_left(rows, g)
    return k if k < len(rows) and rows[k] == g else None


def _members(index, query):
    s, seq = _sequence(index, query)
    if s is None:
        return {"rows": [], "n": 0}
    rows, starts, modes, poses = seq
    r = query.get("run_idx")
    if not isinstance(r, int) or not 0 <= r < len(starts):
        return {"rows": [], "n": 0}
    a, b = _run_rows(index, rows, starts, r)
    off = query.get("off") if isinstance(query.get("off"), int) else 0
    off = max(0, off)
    value, vnames, _kind = _valuer(index, query.get("colour"))
    fname = index["files"][s["file"]]
    names = index["names"]
    out = []
    for g in rows[a + off:min(b, a + off + MEMBERS)]:
        ref = f"{fname}#L{index['line'][g]}"
        row = {"ref": ref, "row_idx": g, "time": _iso(index["t"][g]) + "Z", "status": names["st"][index["st"][g]],
               "mime": names["mime"][index["mime"][g]], "url": _url(index, g), "v": _name(vnames, value(g))}
        if g in index["cited"]:
            row["cited"] = True
        out.append(row)
    return {"rows": out, "n": b - a, "off": off, "run_idx": r}


# ---------------------------------------------------------------- one capture


def _line_text(index, g):
    fi = index["file"][g]
    n = index["line"][g]
    offs = index["offsets"][fi]
    with open(index["files"][fi], "rb") as fh:
        fh.seek(offs[n - 1])
        return fh.readline().decode("utf-8", "replace").rstrip("\r\n")


def _g_of_ref(index, ref):
    path, _, frag = str(ref).partition("#")
    m = re.fullmatch(r"L(\d+)", frag)
    if not m or path not in index["files"]:
        return None
    fi = index["files"].index(path)
    n = int(m.group(1))
    at = index["row_at"][fi]
    return at[n] if 0 <= n < len(at) and at[n] >= 0 else None


def _sec_of(index, g):
    return next((s for s in index["secs"] if s["a"] <= g < s["b"]), None)


def _record(index, query):
    g = query.get("row_idx")
    if not isinstance(g, int) or isinstance(g, bool):
        g = _g_of_ref(index, query.get("ref")) if query.get("ref") else None
    if g is None or not 0 <= g < len(index["t"]):
        return None
    s = _sec_of(index, g)
    text = _line_text(index, g)
    header = index["headers"].get(index["file"][g]) or []
    try:
        cells = next(csv.reader([text]))
    except (csv.Error, StopIteration):
        cells = []
    columns = [[h, cells[i] if i < len(cells) else ""] for i, h in enumerate(header)]
    url = _url(index, g)
    out = {"ref": _ref(index, g), "row_idx": g, "line_text": text, "columns": columns,
           "section": s["id"] if s else "", "site": f"{s['name']} – {s['host']}" if s else "",
           "status_class": CLASSES[index["cls"][g]], "host": index["names"]["host"][index["host"][g]]}
    d = _decode(url)
    if d != url:
        out["decoded_url"] = d
    info = index["cited"].get(g)
    if info:
        body = None
        try:
            with open(info["file"], "rb") as fh:
                raw = fh.read(200_000)
            body = raw.decode("utf-8", "replace")
        except OSError:
            body = None
        out["response"] = {"file": info["file"], "text": body, "http_status": info["http_status"],
                           "captured_at_utc": info["captured_at_utc"]}
    value, vnames, _kind = _valuer(index, query.get("colour"))
    out["v"] = _name(vnames, value(g))
    return out


def records(index, query):
    """{op: lanes, f?, secs?}: per section, its axis and its captures per minute by status class and label (_lanes).
    {op: facets}: every filter value with its count. {op: log, sec, a?, b?, f?, off?, at?}: a page of a section's runs
    (_log). {op: run, sec, a?, b?, f?, run_idx, off?}: one run's captures. {op: record, row_idx | ref}: one capture in
    full. f is {cls, mime, host, red, coll: [value indices], cited: bool, q: text, rx: bool}."""
    query = query if isinstance(query, dict) else {}
    op = query.get("op")
    try:
        if op == "facets":
            return _facets(index)
        if op == "log":
            return _log(index, query)
        if op == "run":
            return _members(index, query)
        if op == "record":
            return _record(index, query)
        out = _lanes(index, query)
        if query.get("facets"):
            out["facets"] = _facets(index)
        return out
    except ValueError as e:  # a search pattern that does not compile
        return {"error": f"{e}", "bad_query": True}


# ---------------------------------------------------------------- citations


def _unit(index, s, lo, hi, label, key, target):
    rows = list(range(lo, min(hi, lo + UNIT_REFS)))
    lines = []
    for g in rows[:EXCERPT_ROWS]:
        lines.append(_line_text(index, g))
    return {"excerpt": "\n".join(lines), "label": label, "refs": [_ref(index, g) for g in rows], "key": key,
            "target": target}


def resolve(index, locator):
    """<file>#L<n>: the capture on that line, opened in its lane's log with its details (the header line: the file's
    first capture). view:capture-timeline/<section>: the section's lane and its whole log.
    view:capture-timeline/<section>/<from>..<to>: the section's captures between two UTC times, brushed."""
    locator = locator if isinstance(locator, dict) else {}
    if "key" in locator and locator.get("key") is not None:
        key = str(locator["key"]).strip()
        s = _sec(index, key)
        if s is not None:
            if s["b"] <= s["a"]:
                return None
            n = s["b"] - s["a"]
            return _unit(index, s, s["a"], s["b"], f"{s['name']} · {n:,} captures", key, {"sec": key})
        m = UNIT_SPAN.fullmatch(key)
        if not m or (s := _sec(index, m.group(1))) is None:
            return None
        a = _epoch(m.group(2) + ("Z" if len(m.group(2)) == 19 else ":00Z"))
        b = _epoch(m.group(3) + ("Z" if len(m.group(3)) == 19 else ":00Z"))
        if a is None or b is None or b < a:
            return None
        lo, hi = _span(index, s, a, b)
        if hi <= lo:
            return None
        return _unit(index, s, lo, hi, f"{s['name']} · {_when(a)} to {_when(b)} · {hi - lo:,} captures", key,
                     {"sec": s["id"], "a": a, "b": b})
    path, frag = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)(?:-L?(\d+))?", frag)
    r = re.fullmatch(r"row=(\d+)", frag)
    if not (m or r) or path not in index["files"]:
        return None
    fi = index["files"].index(path)
    if r:  # thimble's row number: the row's first line
        rl = index["row_lines"][fi]
        k = int(r.group(1))
        if not 0 < k < len(rl):
            return None
        n = rl[k]
    else:
        n = int(m.group(1))
    if not 0 < n <= len(index["offsets"][fi]):  # no such line
        return None
    at = index["row_at"][fi]
    g = at[n] if 0 <= n < len(at) else -1
    first = n
    if g < 0:  # the header or a line that holds no capture: the next capture in the file, else the one before
        k = next((j for j in range(n + 1, len(at)) if at[j] >= 0), None)
        if k is None:
            k = next((j for j in range(min(n, len(at) - 1), 0, -1) if at[j] >= 0), None)
        if k is None:
            return None
        g = at[k]
        first, n = min(n, k), max(n, k)
    s = _sec_of(index, g)
    text = _line_text(index, g)
    st = index["names"]["st"][index["st"][g]]
    return {"excerpt": text, "label": f"{s['name'] if s else path} · {_when(index['t'][g])} · {st or 'no status'}",
            "refs": [f"{path}#L{first}" if first == n else f"{path}#L{first}-L{n}"],
            "key": s["id"] if s else None,
            "target": {"sec": s["id"] if s else None, "row_idx": g, "ref": _ref(index, g), "t": index["t"][g]}}


def problems(index):
    """The rows that do not read, each {ref, why}."""
    return index["problems"]


def hidden(index):
    return []


def unplaced(index):
    return []
