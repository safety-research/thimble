# Variant Families: every spelling the agents used for one government page, gathered into one family, in time
# order with the status each spelling got. The transluce-gov-1 orientation's reader, with the view kit's Colour by:
# every strip and mix colours each member by the value of the chosen field (the answer class by default, the status
# code, the shared body, got through, the source, a saved response or the content type) or of a label
# (thimble.colour_value), each member carries its value, and a family whose members all take a value turned off
# (thimble.colour_on) leaves the list.
#
# The data: each top folder is one section, a burst of requests that AI agents sent to one government site.
# <section>/arquivo-captures.csv, the pages the web archive Arquivo.pt saved, a header row and one row per saved page:
#   record_number, captured_at_utc (ISO 8601 in UTC), archive_url (the archive's copy), target_url (the URL the agent
#   asked for), indexed_http_status (what the site answered), reviewed_origin_status, mime, archive_digest_sha1_base32
#   (the body's digest), warc_filename, warc_offset, warc_record_length, collection and source_url_redacted. The rows
#   are not in time order. Up to 296,000 rows a file.
# <section>/urlquery-reports.csv, the scans the service urlquery.net made, one row per scan: report_id, report_url,
#   report_at_utc, submitted_url (the URL the agent had scanned), http_entries, browser_user_agent, source_json_sha256
#   and json_url. A scan states no status of its own.
# Not claimed, read for the joins below: <section>/urlquery-http.csv, the requests the scanner's browser made for each
#   scan (report_id, http_entry_index, url, http_status, response_mime, ...), and <section>/sources.csv, which names
#   the saved response files in <section>/responses/ by their source_url (an archive or report URL).
#
# The records: a member is one row of an arquivo-captures.csv or of a urlquery-reports.csv, at captured_at_utc or
#   report_at_utc, for target_url or submitted_url. A family is one government page: every member of one section whose
#   URL normalises to the same host, path and sorted query.
#
# The normalising, applied to each URL in this order:
#   wrappers    a converter or proxy (markdown.new, pure.md, r.jina.ai, md.succ.ai, allorigins, corsfix, cors.lol,
#               corsmirror, cors.io, noroffcors, a cors worker, proxymule, lemino, thedrive, jqp, httpbin redirect-to,
#               the Google docs viewer and the Wayback Machine) is unwrapped to the URL in its path or url= parameter,
#               decoded once when it is written encoded, again while the inner URL is itself wrapped
#   host        lower case, without user@, without :443 or :80, without a trailing dot; a raw IPv4 address takes the
#               name of the section's host that shares the most paths with it, when one shares any
#   path        the fragment dropped, percent escapes decoded once (an encoded ? starts the query), whatever follows
#               a script such as .aspx, .php or .prg after a / or ; dropped (detail.aspx/foo.pdf is detail.aspx),
#               // collapsed, . and .. resolved, and compared in lower case
#   query       split at & and at %26, each part decoded once, keys trimmed and compared in lower case; a key that
#               is a throwaway tag (zz, zzbulk, zzsave, prepnonce, prep*, nonce, cb, _cb, cache, uniq*, x, foo, bar,
#               harvest, bulk, arq*, retry, __apncb, tag, z, _, rand, random, fresh, try, dummy, ztest, xcache, utm_*)
#               and a key with no value are dropped, and the rest sorted
#   The family's key is the section, the host, the path and the sorted query, and the URL it shows is the spelling of
#   that key its members write most often, with their case and key order.
#
# The parts of a spelling: each piece of a member's URL as written is marked by how it differs from the family's URL,
#   the strongest kind first: wrapper service (the converter's prefix), tag (a dropped key, a key with no value),
#   encoding (an escape of a character always written plainly, such as %2F, %26, %3D, %3F or a letter, and an escape or
#   plain character most of the family's members write the other way), host form (user@, :443, :80, a trailing dot,
#   capitals in host or scheme, a raw IP), path form (// collapsed, . or .., a fake suffix, the fragment, capitals) and
#   query form (keys in another order or case than the family's URL, a key padded with spaces).
#
# The joins: a scan takes the http_status, response_mime, response_size and response_sha256 of the scanner's first
#   request whose url is the submitted URL, or is it without scheme and trailing slash, none when no request is; its
#   size and sha256 stand for a capture's warc_record_length and digest, so members that got the same body share a mark. A sources.csv row whose source_url is a member's archive_url (an id_ after the
#   archive's timestamp ignored), or starts with a scan's report_url, names its saved response file.
#
# The method: the index holds every member as numpy columns sorted by family, then time, then file and line (time,
#   status, file, line, byte offset, spelling, family), each family's section, members, spellings, got-through flag and
#   statuses present, the families' keys and shown URLs as blobs, and every URL in lower case, as written and decoded,
#   for the search. `records` answers the families the filters keep, a section at a time, with each one's statuses in
#   time order run-length coded; one family's members, read back from the files by seeking to their lines, with the
#   parts of each spelling that differ from the family's URL; and one member in full with its saved response.
#
# Units: a family, cited view:variant-families/<section>/<host><path>?<sorted query>, its key quoted as a URL.
#
# Labels: they apply when records are served, never in the index. Only the members thimble.kept(ref) holds for are
#   listed and counted, a family stays when any of its members does, and coloured by a label each member carries the
#   label's value on it (thimble.colour_value), which the strips draw.
import base64
import calendar
import csv
import re
import zlib
from datetime import datetime, timezone
from urllib.parse import quote, unquote

import numpy as np
import thimble

SLUG = "variant-families"
ARQ, REP, HTTP, SOURCES = "arquivo-captures.csv", "urlquery-reports.csv", "urlquery-http.csv", "sources.csv"
SECTION_PAGE = 30  # families a section shows before the analyst asks for more
MORE_PAGE = 200  # families one "more" adds
MEMBERS_PAGE = 600  # members one family call answers
STRIP_MAX = 240  # cells of a family's status strip; longer families are binned
SIBLINGS_MAX = 300  # other families of the same path a family lists
RESPONSE_MAX = 60_000  # characters of a saved response file the details show
UNIT_REFS = 200  # refs a family's citation carries
EXCERPT_SPELLINGS = 12  # spellings a family's excerpt quotes
SEARCHES_KEPT = 24
MARKS_MAX = 24

URL = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*)://([^/?#]*)(.*)$", re.S)
SCHEMED = re.compile(r"^\s*(https?):/*", re.I)
ENCODED_URL = re.compile(r"(?:https?|ftp)%3a", re.I)
HOSTISH = re.compile(r"^[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+\.?(?::\d+)?(?:[/?#]|$)")
IPV4 = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
SCRIPT = re.compile(r"^(.*?\.(?:aspx|asp|ashx|asmx|axd|php|jsp|jspx|cfm|prg|cgi|pl|do|action|exe|dll))(?=[/;])", re.I)
ISO = re.compile(r"^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.\d+)?Z?$")
WAYBACK_ID = re.compile(r"(/wayback/\d{8,14})id_/")
ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")
SPLIT_AMP = re.compile(r"&|%26", re.I)

TAGS = {"zz", "zzbulk", "zzsave", "prepnonce", "nonce", "cb", "_cb", "cache", "x", "foo", "bar", "harvest", "bulk",
        "retry", "__apncb", "tag", "z", "_", "rand", "random", "fresh", "try", "dummy", "ztest", "xcache"}
TAG_PREFIX = ("prep", "uniq", "arq", "utm_")
# wrapper services by host: name shown, and how the inner URL is written beside a url= parameter
WRAPPERS = {
    "markdown.new": ("markdown.new", "path"), "pure.md": ("pure.md", "path"), "r.jina.ai": ("r.jina.ai", "path"),
    "md.succ.ai": ("md.succ.ai", "path"), "allorigins.win": ("allorigins", ""), "allorigins.hexlet.app": ("allorigins", ""),
    "proxy.corsfix.com": ("corsfix", "path"), "api.cors.lol": ("cors.lol", "path"), "corsmirror.com": ("corsmirror", "path"),
    "cors.io": ("cors.io", "path"), "noroffcors.onrender.com": ("noroffcors", "path"),
    "cors.workers.dev": ("cors worker", "query"), "proxymule.com": ("proxymule", "proxymule"),
    "platform.lemino.ai": ("lemino", "lemino"), "dev.thedrive.ai": ("thedrive", "thedrive"),
    "jqp.vercel.app": ("jqp", ""), "httpbin.org": ("httpbin", ""), "docs.google.com": ("Google viewer", ""),
    "web.archive.org": ("Wayback Machine", "wayback"),
}
SPECIAL = {"proxymule": re.compile(r"^/__PROXY__/(https?)/"), "lemino": re.compile(r"^/api/url2md/"),
           "thedrive": re.compile(r"^/md/"), "wayback": re.compile(r"^/web/\d+[a-z_]*/")}
SAFE_PATH = "/:@!$&*+,;=-._~"
# characters whose escape is always a way of writing a URL differently, by part of the URL; the escape of any other
# character, or its plain form, is a difference only where most of the family's members write it the other way
TRICKS = {"path": set("/?#%.;&=-_~"), "query": set("&=%.-_~")}
SAFE_QUERY = ":@!$*+,;/-._~"
KINDS = ("wrapper", "tag", "encoding", "host", "path", "query")  # the parts of a spelling, strongest first
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------- normalising a URL


def _wrapper(host):
    """(name, form) of the wrapper service at a lower-case host, or None."""
    h = host.rsplit("@", 1)[-1].split(":", 1)[0].rstrip(".")
    for k, v in WRAPPERS.items():
        if h == k or h.endswith("." + k):
            return v
    return None


def _inner(form, rest):
    """(start, end, decode, scheme) of the URL a wrapper writes in `rest` (what follows its host), or None: the
    inner URL is rest[start:end], decoded once when `decode`, after `scheme` + '://' when a scheme is given."""
    q = rest.find("?")
    if form == "path":
        a = len(rest) - len(rest.lstrip("/"))
        tail = rest[a:]
        if tail and ENCODED_URL.match(tail):
            return a, len(rest), True, None
        if tail and (SCHEMED.match(tail) or HOSTISH.match(tail)):
            return a, len(rest), False, None
    if q >= 0:
        m = re.search(r"(?:^|&)url=", rest[q + 1:], re.I)
        if m:
            a = q + 1 + m.end()
            if ENCODED_URL.match(rest, a):
                b = rest.find("&", a)
                return a, (b if b >= 0 else len(rest)), True, None
            return (a, len(rest), False, None) if a < len(rest) else None
    if form in SPECIAL:
        m = SPECIAL[form].match(rest)
        if not m or m.end() >= len(rest):
            return None
        return m.end(), len(rest), False, (m.group(1).lower() if form == "proxymule" else None)
    if form == "query":
        if q >= 0 and not rest[:q].strip("/") and q + 1 < len(rest):
            tail = rest[q + 1:]
            if ENCODED_URL.match(tail):
                return q + 1, len(rest), True, None
            if SCHEMED.match(tail) or HOSTISH.match(tail):
                return q + 1, len(rest), False, None
        return None
    return None


def _scheme_fix(u):
    """An inner URL with its scheme written as scheme://, https:// put in front when it names none."""
    m = SCHEMED.match(u)
    if m:
        return m.group(1).lower() + "://" + u[m.end():]
    return "https://" + u.lstrip("/")


def _unwrap(u):
    """(the URL inside every wrapper service around u, [wrapper names])."""
    wraps = []
    for _ in range(6):
        m = URL.match(u)
        if not m:
            break
        w = _wrapper(m.group(2).lower())
        if w is None:
            break
        rest = m.group(3)
        got = _inner(w[1], rest)
        if got is None:
            break
        a, b, decode, scheme = got
        inner = rest[a:b]
        if decode:
            inner = unquote(inner, errors="replace")
        inner = f"{scheme}://{inner}" if scheme else _scheme_fix(inner)
        wraps.append(w[0])
        u = inner
    return u, wraps


def _dots(segs):
    """(segments kept, indices removed) of a path's segments after the first with . and .. resolved, and whether the
    path now ends in a slash."""
    out, gone, trail = [], [], False
    for i, s in enumerate(segs):
        if s == "." or s == "..":
            gone.append(i)
            if s == ".." and out:
                gone.append(out.pop()[0])
            trail = True
        else:
            out.append((i, s))
            trail = False
    return out, gone, trail


def _host_of(authority):
    """(host as the key writes it, port kept) of a URL's authority."""
    h = authority.rsplit("@", 1)[-1].lower()
    m = re.match(r"^(.*?)(?::(\d*))?$", h, re.S)
    name, port = m.group(1).rstrip("."), m.group(2)
    return (f"{name}:{port}" if port and port not in ("443", "80") else name), name


def _path_parts(raw_path):
    """(path as shown, extra query text) of a URL's path: decoded once, the script's suffix dropped, // collapsed and
    . and .. resolved."""
    p = unquote(raw_path, errors="replace")
    extra = None
    if "?" in p:
        p, extra = p.split("?", 1)
    m = SCRIPT.match(p)
    if m:
        p = m.group(1)
    p = re.sub(r"/{2,}", "/", p)
    if not p.startswith("/"):
        p = "/" + p
    segs = p.split("/")[1:]
    if "." in segs or ".." in segs:
        kept, _gone, trail = _dots(segs)
        p = "/" + "/".join(s for _, s in kept) + ("/" if trail and kept else "")
    return p, extra


def _params(query):
    """[(key in lower case, key as written, value)] of the parts of a query the family keeps, in the URL's order."""
    out = []
    for part in SPLIT_AMP.split(query):
        if not part:
            continue
        d = unquote(part, errors="replace")
        k, _eq, v = d.partition("=")
        k = k.strip()
        kl = k.lower()
        if not k or not v.strip() or kl in TAGS or kl.startswith(TAG_PREFIX):
            continue
        out.append((kl, k, v))
    return out


def normalise(url):
    """(host, key path and query in lower case with the query sorted, shown path and query with their case and order,
    [wrappers]) of a URL as the files write it; a text that is no URL is its own path with no host."""
    u, wraps = _unwrap(url.strip())
    m = URL.match(u)
    if not m:
        return "", quote(u.strip(), safe=SAFE_PATH), u.strip(), wraps
    host, _name = _host_of(m.group(2))
    rest = m.group(3).split("#", 1)[0]
    raw_path, _q, raw_query = rest.partition("?")
    path, extra = _path_parts(raw_path)
    if extra is not None:
        raw_query = extra + ("&" + raw_query if raw_query else "")
    ps = _params(raw_query)
    shown_q = "&".join(f"{k}={v}" for _kl, k, v in ps)
    ps.sort(key=lambda x: (x[0], x[2]))
    key_q = "&".join(f"{quote(kl, safe=SAFE_QUERY)}={quote(v, safe=SAFE_QUERY)}" for kl, _k, v in ps)
    key = quote(path.lower(), safe=SAFE_PATH) + ("?" + key_q if ps else "")
    shown = path + ("?" + shown_q if ps else "")
    return host, key, shown, wraps


# ---------------------------------------------------------------- the parts of one spelling


class _Spelling:
    """One URL as tokens, each a decoded character and the characters of the written URL it stands for, and the kind
    of difference each written character is part of."""

    def __init__(self, raw):
        self.raw = raw
        self.kind = [None] * len(raw)

    def mark(self, toks, kind):
        rank = KINDS.index(kind)
        for _c, idx in toks:
            for j in idx:
                k = self.kind[j]
                if k is None or KINDS.index(k) > rank:
                    self.kind[j] = kind

    def segments(self):
        out = []
        for ch, k in zip(self.raw, self.kind):
            if out and out[-1][1] == k:
                out[-1][0] += ch
            else:
                out.append([ch, k])
        return out


def _text(toks):
    return "".join(c for c, _ in toks)


def _decode(toks, sp=None, part=None, uses=None):
    """The tokens with each run of percent escapes decoded once into the characters it stands for; with `sp`, an escape
    of a character the URL's `part` always writes plainly is marked as an encoding, and `uses` collects how the URL
    writes every other character, {(part, char, escaped): [written positions]}."""
    out, i, n = [], 0, len(toks)
    tricks = TRICKS.get(part, set())
    while i < n:
        if toks[i][0] == "%" and i + 2 < n and all(t[0] in "0123456789abcdefABCDEF" for t in toks[i + 1:i + 3]):
            run, idx = bytearray(), []
            while i + 2 < n and toks[i][0] == "%" and all(t[0] in "0123456789abcdefABCDEF" for t in toks[i + 1:i + 3]):
                run.append(int(toks[i + 1][0] + toks[i + 2][0], 16))
                idx.append(toks[i][1] + toks[i + 1][1] + toks[i + 2][1])
                i += 3
            chars = run.decode("utf-8", errors="replace")
            if len(chars) == len(idx):
                pieces = [(c, ix) for c, ix in zip(chars, idx)]
            else:
                flat = [j for ix in idx for j in ix]
                pieces = [(c, flat) for c in chars]
            for c, ix in pieces:
                if sp is not None and (c.isascii() and c.isalnum() or c in tricks):
                    sp.mark([(c, ix)], "encoding")
                elif uses is not None and "!" <= c <= "~":
                    uses.setdefault((part, c, True), []).extend(ix)
                out.append((c, ix))
        else:
            c = toks[i][0]
            if uses is not None and "!" <= c <= "~" and not c.isalnum() and c not in tricks and toks[i][1]:
                uses.setdefault((part, c, False), []).extend(toks[i][1])
            out.append(toks[i])
            i += 1
    return out


def spelling_parts(raw, shown_host, shown_rest, ipmap=None):
    """[[text, kind]] of a URL as written, each kind (KINDS) the way that text differs from the family's URL
    (shown_host + shown_rest), None where it does not; with the key the URL normalises to, which is the family's."""
    sp, key, _uses = _spell(raw, shown_host, shown_rest, ipmap)
    return sp.segments(), key


def _spell(raw, shown_host, shown_rest, ipmap=None):
    """(_Spelling with its differences marked, key, how it writes the characters an escape may or may not stand
    for) of a URL as written (spelling_parts)."""
    uses = {}
    sp = _Spelling(raw)
    toks = [(c, [i]) for i, c in enumerate(raw)]
    lead = len(raw) - len(raw.lstrip())
    toks = toks[lead:len(toks) - (len(raw) - len(raw.rstrip()))]
    for _ in range(6):
        s = _text(toks)
        m = URL.match(s)
        if not m:
            break
        w = _wrapper(m.group(2).lower())
        if w is None:
            break
        got = _inner(w[1], m.group(3))
        if got is None:
            break
        a, b, decode, scheme = got
        r0 = m.start(3)
        sp.mark(toks[:r0 + a], "wrapper")
        sp.mark(toks[r0 + b:], "wrapper")
        inner = toks[r0 + a:r0 + b]
        if decode:
            inner = _decode(inner)
        if scheme:
            inner = [(c, []) for c in scheme + "://"] + inner
        else:
            mm = SCHEMED.match(_text(inner))
            if mm:
                span = [j for _c, ix in inner[:mm.end()] for j in ix]
                inner = [(c, span) for c in mm.group(1).lower() + "://"] + inner[mm.end():]
            else:
                k = len(inner) - len(_text(inner).lstrip("/"))
                sp.mark(inner[:k], "wrapper")
                inner = [(c, []) for c in "https://"] + inner[k:]
        toks = inner
    s = _text(toks)
    m = URL.match(s)
    if not m:
        return sp, quote(s.strip(), safe=SAFE_PATH), uses
    # the host, and a scheme written in capitals
    if m.group(1) != m.group(1).lower():
        sp.mark(toks[m.start(1):m.end(1)], "host")
    auth = toks[m.start(2):m.end(2)]
    at = max((i for i, (c, _) in enumerate(auth) if c == "@"), default=-1)
    if at >= 0:
        sp.mark(auth[:at + 1], "host")
    hp = auth[at + 1:]
    hs = _text(hp)
    pm = re.match(r"^(.*?)(?::(\d*))?$", hs, re.S)
    name_toks = hp[:len(pm.group(1))]
    port = pm.group(2)
    if port is not None and port in ("443", "80", ""):
        sp.mark(hp[len(pm.group(1)):], "host")
    k = len(name_toks)
    while k and name_toks[k - 1][0] == ".":
        k -= 1
    sp.mark(name_toks[k:], "host")
    name = _text(name_toks[:k]).lower()
    host = f"{name}:{port}" if port and port not in ("443", "80") else name
    if ipmap and IPV4.match(name) and name in ipmap:
        host = ipmap[name] + (f":{port}" if port and port not in ("443", "80") else "")
        sp.mark(name_toks[:k], "host")
    elif _text(name_toks[:k]) != _text(name_toks[:k]).lower() or host != shown_host:
        sp.mark(name_toks[:k], "host")
    # the path
    rest = toks[m.start(3):]
    frag = next((i for i, (c, _) in enumerate(rest) if c == "#"), None)
    if frag is not None:
        sp.mark(rest[frag:], "path")
        rest = rest[:frag]
    qi = next((i for i, (c, _) in enumerate(rest) if c == "?"), None)
    path_t = rest if qi is None else rest[:qi]
    query_t = [] if qi is None else rest[qi + 1:]
    qmark = None if qi is None else rest[qi]
    path_t = _decode(path_t, sp, "path", uses)
    pq = next((i for i, (c, _) in enumerate(path_t) if c == "?"), None)
    extra = None
    if pq is not None:
        path_t, extra = path_t[:pq], path_t[pq + 1:]
        qmark = qmark or None
    sm = SCRIPT.match(_text(path_t))
    if sm:
        sp.mark(path_t[sm.end(1):], "path")
        path_t = path_t[:sm.end(1)]
    collapsed = []
    for t in path_t:
        if t[0] == "/" and collapsed and collapsed[-1][0] == "/":
            sp.mark([t], "path")
            continue
        collapsed.append(t)
    path_t = collapsed
    if not path_t or path_t[0][0] != "/":
        path_t = [("/", [])] + path_t
    segs, cur = [], []
    for t in path_t[1:]:
        if t[0] == "/":
            segs.append(cur)
            cur = [t]
        else:
            cur.append(t)
    segs.append(cur)
    texts = [_text(sg).lstrip("/") if j else _text(sg) for j, sg in enumerate(segs)]
    if "." in texts or ".." in texts:
        kept, gone, trail = _dots(texts)
        for j in gone:
            sp.mark(segs[j], "path")
        nseg = [segs[j] for j, _s in kept]
        path_s = "/" + "/".join(s for _j, s in kept) + ("/" if trail and kept else "")
    else:
        nseg = segs
        path_s = "/" + "/".join(texts)
    shown_path = shown_rest.split("?", 1)[0]
    if path_s != shown_path:
        a_parts, b_parts = path_s.split("/"), shown_path.split("/")
        for j, sg in enumerate(nseg):
            if j + 1 < len(a_parts) and (j + 1 >= len(b_parts) or a_parts[j + 1] != b_parts[j + 1]):
                sp.mark([t for t in sg if t[0] != "/"], "path")
    # the query
    if extra is not None:
        query_t = extra + ([("&", [])] + query_t if query_t else [])
    query_t = _decode(query_t, sp, "query", uses)
    parts, cur, seps = [], [], []
    for t in query_t:
        if t[0] == "&":
            parts.append(cur)
            seps.append(t)
            cur = []
        else:
            cur.append(t)
    parts.append(cur)
    seps = [None] + seps
    kept = []
    for j, pt in enumerate(parts):
        if not pt:
            if seps[j] is not None:
                sp.mark([seps[j]], "tag")
            continue
        eq = next((i for i, (c, _) in enumerate(pt) if c == "="), None)
        kt = pt if eq is None else pt[:eq]
        v = "" if eq is None else _text(pt[eq + 1:])
        kraw = _text(kt)
        kk = kraw.strip()
        kl = kk.lower()
        if not kk or not v.strip() or kl in TAGS or kl.startswith(TAG_PREFIX):
            sp.mark(pt + ([seps[j]] if seps[j] is not None else []), "tag")
            continue
        if kk != kraw:
            sp.mark([t for t in kt if t[0].isspace()], "query")
        kept.append((kl, kk, v, kt))
    if qmark is not None and not kept:
        sp.mark([qmark], "tag")
    order = sorted(range(len(kept)), key=lambda j: (kept[j][0], kept[j][2]))
    shown_keys = [x.split("=", 1)[0] for x in shown_rest.split("?", 1)[1].split("&")] if "?" in shown_rest else []
    shown_low = [x.lower() for x in shown_keys]
    for j, (kl, kk, v, kt) in enumerate(kept):
        if j >= len(shown_low) or shown_low[j] != kl:
            sp.mark(kt, "query")
        elif shown_keys[j] != kk:
            sp.mark(kt, "query")
    ps = [(kept[j][0], kept[j][1], kept[j][2]) for j in order]
    key_q = "&".join(f"{quote(kl, safe=SAFE_QUERY)}={quote(v, safe=SAFE_QUERY)}" for kl, _k, v in ps)
    key = host + quote(path_s.lower(), safe=SAFE_PATH) + ("?" + key_q if ps else "")
    return sp, key, uses


def _minority_marks(spelled, weight):
    """Mark, in each spelling of a family, the way of writing a character (as an escape or plainly) that fewer of the
    family's members use than the other way. `spelled` is {url: (_Spelling, key, uses)}, `weight` {url: members}."""
    count = {}
    for url, (_sp, _k, uses) in spelled.items():
        for (part, c, esc) in uses:
            count[(part, c, esc)] = count.get((part, c, esc), 0) + weight.get(url, 1)
    for url, (sp, _k, uses) in spelled.items():
        for (part, c, esc), idx in uses.items():
            if count.get((part, c, esc), 0) < count.get((part, c, not esc), 0):
                sp.mark([(c, idx)], "encoding")


# ---------------------------------------------------------------- reading the files


def _epoch(s, memo):
    """Whole seconds since 1970 of an ISO 8601 UTC time as the files write it, or None."""
    got = memo.get(s)
    if got is not None or s in memo:
        return got
    m = ISO.match(s.strip())
    if m:
        try:
            got = calendar.timegm(tuple(int(x) for x in m.groups()))
        except (ValueError, OverflowError):
            got = None
    else:
        try:
            dt = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
            got = int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp())
        except ValueError:
            got = None
    memo[s] = got
    return got


def _lines(data):
    """(first line, last line, byte offset, text, quotes closed) of each row of a CSV file's bytes, a quoted cell that
    runs over several lines included."""
    parts = data.split(b"\n")
    if parts and parts[-1] == b"":
        parts.pop()
    pos, i, n = 0, 0, len(parts)
    while i < n:
        raw, off, first = parts[i], pos, i + 1
        pos += len(raw) + 1
        i += 1
        text = raw.decode("utf-8", "replace").rstrip("\r")
        quotes = text.count('"')
        if quotes % 2:
            chunk = [text]
            while i < n and quotes % 2:
                more = parts[i].decode("utf-8", "replace").rstrip("\r")
                pos += len(parts[i]) + 1
                i += 1
                quotes += more.count('"')
                chunk.append(more)
            text = "\n".join(chunk)
        yield first, i, off, text, quotes % 2 == 0


def _cells(text):
    if '"' not in text:
        return text.split(",")
    try:
        return next(csv.reader([text], strict=True))
    except (csv.Error, StopIteration):
        return None


def _rows(data, path, problems):
    """(header, [(first line, last line, offset, cells)]) of a CSV file; a row that does not parse whole, such as a
    line cut short, is a problem."""
    header, out = None, []
    torn = data.count(b"\n") + 1 if data and not data.endswith(b"\n") else 0  # the line the file ends inside
    for first, last, off, text, closed in _lines(data):
        if not text.strip():
            continue
        if last == torn and header is not None:
            problems.append({"ref": f"{path}#L{first}", "why": "the file ends inside this line, cut short"})
            continue
        cells = _cells(text) if closed else None
        if cells is None:
            problems.append({"ref": f"{path}#L{first}", "why": "a quoted cell runs to the end of the file" if not closed
                             else "not a CSV row"})
            continue
        if header is None:
            header = [c.strip() for c in cells]
            continue
        if len(cells) != len(header):
            problems.append({"ref": f"{path}#L{first}",
                             "why": f"a row of {len(cells)} cells where the header names {len(header)}, cut short"
                             if len(cells) < len(header) else
                             f"a row of {len(cells)} cells where the header names {len(header)}"})
            continue
        out.append((first, last, off, cells))
    return header or [], out


def _side_file(path):
    """The rows of a file beside the claimed ones (sources.csv, urlquery-http.csv) as dicts, [] when it is missing."""
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        return []
    header, rows = _rows(data, path, [])
    return [(first, dict(zip(header, cells))) for first, _l, _o, cells in rows]


def _loose(url):
    """A URL without its scheme and a trailing slash, as a scan's request may write the submitted URL."""
    return re.sub(r"^[A-Za-z]+://", "", url).rstrip("/")


def _scan_status(folder):
    """{(report_id, url): (status, mime, response size, response sha256)} of a section's scans, the scanner's first
    request for each url, and the same by (report_id, url without scheme and trailing slash) under the key
    (report_id, None, loose url)."""
    out = {}
    for _first, r in sorted(_side_file(f"{folder}/{HTTP}"),
                            key=lambda x: (_int(x[1].get("http_entry_index")), x[0])):
        rid, url = (r.get("report_id") or "").strip(), (r.get("url") or "").strip()
        got = ((r.get("http_status") or "").strip(), (r.get("response_mime") or "").strip(),
               (r.get("response_size") or "").strip(), (r.get("response_sha256") or "").strip())
        out.setdefault((rid, url), got)
        out.setdefault((rid, None, _loose(url)), got)
    return out


def _int(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


def _sources(folder):
    """{archive or report URL: [sources.csv row]} of a section's saved responses."""
    out = {}
    for first, r in _side_file(f"{folder}/{SOURCES}"):
        url = (r.get("source_url") or "").strip()
        if url:
            out.setdefault(WAYBACK_ID.sub(r"\1/", url), []).append(
                {"file": (r.get("file") or "").strip(), "source_url": url, "line": first,
                 "captured_at_utc": (r.get("captured_at_utc") or "").strip(),
                 "http_status": (r.get("http_status") or "").strip()})
    return out


class _Names:
    """Small integer codes for the distinct values of one column, code 0 the empty value."""

    def __init__(self):
        self.names, self.at = [""], {"": 0}

    def code(self, v):
        c = self.at.get(v)
        if c is None:
            c = self.at[v] = len(self.names)
            self.names.append(v)
        return c


def _blob(texts):
    enc = [s.replace("\n", " ").encode("utf-8", "replace") for s in texts]
    lens = np.fromiter((len(b) + 1 for b in enc), np.int64, count=len(enc))
    return b"\n".join(enc) + b"\n", np.cumsum(lens) - lens


def _blob_at(blob, starts, i):
    a = int(starts[i])
    b = blob.index(b"\n", a)
    return blob[a:b].decode("utf-8", "replace")


def _cls(code):
    c = code[:1]
    return int(c) if c in ("1", "2", "3", "4", "5") and len(code) == 3 and code.isdigit() else 0


# ---------------------------------------------------------------- the index


def build_index(paths):
    """Every member of every claimed file, sorted by family and time, with each family's counts (module note)."""
    files = sorted(p for p in paths if p.rsplit("/", 1)[-1] in (ARQ, REP))
    folders = sorted({p.split("/")[0] for p in files if "/" in p})
    sec_of = {f: k for k, f in enumerate(folders)}
    problems, unplaced, memo = [], [], {}
    codes, mimes, hosts = _Names(), _Names(), _Names()
    norm = {}  # written URL -> (host code, key code, shown code)
    keys, shown = _Names(), _Names()
    spell = _Names()
    cols = {k: [] for k in ("t", "sec", "st", "mime", "fi", "ln", "last", "off", "host", "key", "shown", "sp", "wr",
                            "dg")}
    digests = _Names()  # each member's body digest: a capture's archive_digest_sha1_base32, a scan's response_sha256
    resp = {}
    body = {}  # order found -> (response size, response sha256) of a scan's request for the submitted URL
    headers = {}
    wrap_names = _Names()
    for fno, path in enumerate(files):
        name = path.rsplit("/", 1)[-1]
        folder = path.split("/")[0]
        thimble.progress(fno, len(files) + 2, f"reading {path}")
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError as e:
            problems.append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
            continue
        header, rows = _rows(data, path, problems)
        del data
        headers[fno] = header
        at = {h: i for i, h in enumerate(header)}
        arq = name == ARQ
        ti = at.get("captured_at_utc" if arq else "report_at_utc")
        ui = at.get("target_url" if arq else "submitted_url")
        si, mi, ai = at.get("indexed_http_status"), at.get("mime"), at.get("archive_url")
        di = at.get("archive_digest_sha1_base32")
        ri, rui = at.get("report_id"), at.get("report_url")
        if ui is None:
            problems.append({"ref": f"{path}#L1", "why": "no target_url or submitted_url column"})
            continue
        scans = {} if arq else _scan_status(folder)
        wanted = _sources(folder)
        sec = sec_of[folder]
        for first, last, off, cells in rows:
            url = cells[ui].strip()
            if not url:
                unplaced.append({"ref": f"{path}#L{first}", "why": "no URL the reader can group"})
                continue
            t = _epoch(cells[ti], memo) if ti is not None else None
            got = norm.get(url)
            if got is None:
                h, k, s, w = normalise(url)
                got = norm[url] = (hosts.code(h), keys.code(k), shown.code(s), wrap_names.code(" › ".join(w)))
            o = len(cols["t"])
            cols["t"].append(-1 if t is None else t)
            cols["sec"].append(sec)
            cols["fi"].append(fno)
            cols["ln"].append(first)
            cols["last"].append(last)
            cols["off"].append(off)
            cols["host"].append(got[0])
            cols["key"].append(got[1])
            cols["shown"].append(got[2])
            cols["wr"].append(got[3])
            cols["sp"].append(spell.code(url))
            if arq:
                cols["st"].append(codes.code(cells[si].strip() if si is not None else ""))
                cols["mime"].append(mimes.code(cells[mi].strip() if mi is not None else ""))
                cols["dg"].append(digests.code(cells[di].strip() if di is not None else ""))
                hit = wanted.get(WAYBACK_ID.sub(r"\1/", cells[ai].strip())) if ai is not None else None
                if hit:
                    resp[o] = hit
            else:
                rid = cells[ri].strip() if ri is not None else ""
                st, mm, size, sha = scans.get((rid, url)) or scans.get((rid, None, _loose(url))) or ("", "", "", "")
                cols["st"].append(codes.code(st))
                cols["mime"].append(mimes.code(mm))
                cols["dg"].append(digests.code(sha))
                if size or sha:
                    body[o] = (_int(size) if size.isdigit() else None, sha)
                rurl = cells[rui].strip() if rui is not None else ""
                if rurl:
                    hit = [x for k2, xs in wanted.items() for x in xs if k2 == rurl or k2.startswith(rurl + "/")]
                    if hit:
                        resp[o] = hit
            if t is None:
                unplaced.append({"ref": f"{path}#L{first}",
                                 "why": "no time the reader can read, listed last in its family"})
        del rows
    thimble.progress(len(files), len(files) + 2, "grouping the spellings")
    norm = None
    n = len(cols["t"])
    host = np.array(cols["host"], np.int32)
    sec = np.array(cols["sec"], np.int32)
    keyc = np.array(cols["key"], np.int32)
    # a raw IPv4 host takes the name of the section's host sharing the most paths with it
    ipmap = {}
    paths_of = {}
    key_paths = [k.split("?", 1)[0] for k in keys.names]
    for s_, h_, k_ in set(zip(sec.tolist(), host.tolist(), keyc.tolist())):
        paths_of.setdefault((s_, h_), set()).add(key_paths[k_])
    for (s_, h_), ps in paths_of.items():
        hn = hosts.names[h_]
        if not IPV4.match(hn.split(":", 1)[0]):
            continue
        best = None
        for (s2, h2), ps2 in paths_of.items():
            if s2 != s_ or h2 == h_ or IPV4.match(hosts.names[h2].split(":", 1)[0]) or not hosts.names[h2]:
                continue
            score = len((ps & ps2) - {"/"})
            if score and (best is None or score > best[0]):
                best = (score, h2)
        if best:
            ipmap[(s_, h_)] = best[1]
    host_m = host.copy()
    for (s_, h_), h2 in ipmap.items():
        host_m[(sec == s_) & (host == h_)] = h2
    # families: one per (section, host, key)
    trip = sec.astype(np.int64) * (len(hosts.names) + 1) * (len(keys.names) + 1) + \
        host_m.astype(np.int64) * (len(keys.names) + 1) + keyc
    _u, fam = np.unique(trip, return_inverse=True)
    fam = fam.astype(np.int32)
    t = np.array(cols["t"], np.int64)
    tsort = np.where(t < 0, np.iinfo(np.int64).max, t)
    fi = np.array(cols["fi"], np.int32)
    ln = np.array(cols["ln"], np.int64)
    order = np.lexsort((ln, fi, tsort, fam)) if n else np.zeros(0, np.int64)
    idx = {"files": files, "folders": folders, "headers": headers, "codes": codes.names, "mimes": mimes.names,
           "problems": problems, "unplaced": unplaced, "n": n}
    for k, dt in (("t", np.int64), ("st", np.uint16), ("mime", np.uint16), ("fi", np.int16), ("ln", np.int64),
                  ("last", np.int64), ("off", np.int64), ("sp", np.int32), ("wr", np.int16), ("dg", np.int32)):
        idx[k] = np.array(cols[k], dt)[order]
    shown_c = np.array(cols["shown"], np.int32)[order]
    cols = None
    fam = fam[order]
    rank = np.empty(n, np.int64)
    rank[order] = np.arange(n)
    idx["responses"] = {int(rank[o]): xs for o, xs in resp.items()}
    idx["scan_body"] = {int(rank[o]): x for o, x in body.items()}
    saved_rows = np.array(sorted(idx["responses"]), np.int64)
    idx["saved_mask"] = np.zeros(n, bool)
    if len(saved_rows):
        idx["saved_mask"][saved_rows] = True
    # each digest's place among the digests in text order, which orders the bodies a family shares (_digest_groups)
    by_text = sorted(range(len(digests.names)), key=lambda i: digests.names[i])
    idx["dg_rank"] = np.empty(len(digests.names), np.int64)
    idx["dg_rank"][by_text] = np.arange(len(digests.names))
    idx["wraps"] = wrap_names.names
    cls_names = np.array([_cls(c) for c in codes.names], np.uint8)
    idx["cls"] = cls_names[idx["st"]]
    F = int(fam.max()) + 1 if n else 0
    starts = np.flatnonzero(np.concatenate(([True], fam[1:] != fam[:-1]))) if n else np.zeros(0, np.int64)
    idx["f_start"] = np.append(starts, n).astype(np.int64)
    idx["fam"] = fam
    f_first = starts
    idx["f_sec"] = sec[order][f_first].astype(np.uint8)
    hm = host_m[order]
    kc = keyc[order]
    # each family's shown URL: the spelling of its key its members write most often
    pair = fam.astype(np.int64) * (len(shown.names) + 1) + shown_c
    up, cnt = np.unique(pair, return_counts=True)
    pf = (up // (len(shown.names) + 1)).astype(np.int64)
    ps = (up % (len(shown.names) + 1)).astype(np.int64)
    best = np.lexsort((-cnt, pf))
    firsts = np.flatnonzero(np.concatenate(([True], pf[best][1:] != pf[best][:-1])))
    f_shown = np.zeros(F, np.int64)
    f_shown[pf[best][firsts]] = ps[best][firsts]
    thimble.progress(len(files) + 1, len(files) + 2, "counting each family")
    f_host = [hosts.names[h] for h in hm[f_first].tolist()]
    f_keys = [f"{folders[s]}/{h}{keys.names[k]}" for s, h, k in
              zip(idx["f_sec"].tolist(), f_host, kc[f_first].tolist())]
    f_disp = [f"{h}{shown.names[s]}" for h, s in zip(f_host, f_shown.tolist())]
    idx["key_blob"], idx["key_starts"] = _blob(f_keys)
    idx["disp_blob"], idx["disp_starts"] = _blob(f_disp)
    idx["host_len"] = np.array([len(h) for h in f_host], np.int32)
    hs = np.array([zlib.crc32(k.encode("utf-8")) for k in f_keys], np.int64)
    ho = np.argsort(hs, kind="stable")
    idx["key_hash"], idx["key_hash_fam"] = hs[ho], ho.astype(np.int32)
    # a family's siblings: the other families of its section, host and path
    fp = [f"{k.split('?', 1)[0]}" for k in f_keys]
    pc = _Names()
    idx["f_path"] = np.array([pc.code(p) for p in fp], np.int32)
    idx["ipmap"] = {f"{folders[s_]}\n{hosts.names[h_]}": hosts.names[h2] for (s_, h_), h2 in ipmap.items()}
    f_keys = f_disp = fp = None
    st = _family_stats(idx, np.ones(n, bool))
    idx.update({"f_" + k: v for k, v in st.items()})
    idx["f_saved"] = np.zeros(F, bool)
    if len(saved_rows):
        idx["f_saved"][fam[saved_rows]] = True
    # at each claimed file's lines: (first lines ascending, last lines, member)
    at_line = {}
    sel = np.lexsort((idx["ln"], idx["fi"]))
    fs = idx["fi"][sel]
    for f in np.unique(fs):
        m = sel[fs == f]
        at_line[int(f)] = (idx["ln"][m].astype(np.int64), idx["last"][m].astype(np.int64), m.astype(np.int64))
    idx["at_line"] = at_line
    # the URLs for the search, in lower case as written and decoded, one per member
    thimble.progress(len(files) + 2, len(files) + 2, "indexing the URLs")
    spellings = spell.names
    raw = [spellings[s].lower() for s in idx["sp"].tolist()]
    dec = []
    for u in raw:
        if "%" in u:
            d = unquote(u, errors="replace").lower()
            dec.append(d if d != u else "")
        else:
            dec.append("")
    idx["blob_raw"], idx["starts_raw"] = _blob(raw)
    idx["blob_dec"], idx["starts_dec"] = _blob(dec)
    return idx


def _family_stats(index, keep):
    """Each family's rows, spellings, got-through flag, statuses present and first time, counting the members `keep`
    holds for."""
    fam, n = index["fam"], index["n"]
    F = len(index["f_start"]) - 1
    out = {}
    w = keep.astype(np.int64)
    out["rows"] = np.bincount(fam, weights=w, minlength=F).astype(np.int32) if n else np.zeros(F, np.int32)
    # spellings: distinct written URLs among the kept members
    if n:
        kidx = np.flatnonzero(keep)
        pair = fam[kidx].astype(np.int64) * (int(index["sp"].max()) + 1) + index["sp"][kidx]
        up = np.unique(pair)
        out["spell"] = np.bincount((up // (int(index["sp"].max()) + 1)).astype(np.int64), minlength=F).astype(np.int32)
    else:
        out["spell"] = np.zeros(F, np.int32)
    cls = index["cls"]
    mask = np.zeros(F, np.uint8)
    if n:
        for c in range(6):
            m = keep & (cls == c)
            if m.any():
                mask[np.unique(fam[m])] |= np.uint8(1 << c)
    out["mask"] = mask
    # got through: a kept 2xx after a kept 4xx or 5xx, in time order
    through = np.zeros(F, bool)
    if n:
        pos = np.arange(n, dtype=np.int64)
        bad = keep & ((cls == 4) | (cls == 5))
        big = np.int64(n + 1)
        first_bad = np.full(F, big, np.int64)
        np.minimum.at(first_bad, fam[bad], pos[bad])
        good = keep & (cls == 2)
        gi = np.flatnonzero(good)
        hit = gi[pos[gi] > first_bad[fam[gi]]]
        through[np.unique(fam[hit])] = True
    out["through"] = through
    t = index["t"]
    t0 = np.full(F, np.iinfo(np.int64).max, np.int64)
    if n:
        ok = keep & (t >= 0)
        np.minimum.at(t0, fam[ok], t[ok])
    out["t0"] = t0
    return out


# ---------------------------------------------------------------- reading members back


def _ref(index, i):
    return f"{index['files'][int(index['fi'][i])]}#L{int(index['ln'][i])}"


_REFS = {}
_SEARCHES = {}


def _refs(index):
    """Every member's ref, in index order, built once per index in this kernel."""
    got = _REFS.get(id(index))
    if got is None or got[0] is not index:
        files = index["files"]
        got = (index, [f"{files[f]}#L{n}" for f, n in zip(index["fi"].tolist(), index["ln"].tolist())])
        _REFS.clear()
        _REFS[id(index)] = got
    return got[1]


def _read_many(index, rows):
    """{member: ({column: cell}, text)} for the wanted members, each file opened once."""
    out, by_file = {}, {}
    for i in rows:
        by_file.setdefault(int(index["fi"][i]), []).append(int(i))
    for fi, wanted in by_file.items():
        header = index["headers"].get(fi) or []
        with open(index["files"][fi], "rb") as fh:
            for i in sorted(wanted, key=lambda j: int(index["off"][j])):
                fh.seek(int(index["off"][i]))
                raw = b"".join(fh.readline() for _ in range(int(index["last"][i]) - int(index["ln"][i]) + 1))
                text = raw.decode("utf-8", "replace").rstrip("\r\n")
                out[i] = (dict(zip(header, _cells(text.replace("\r\n", "\n")) or [])), text)
    return out


def _key(index, f):
    return _blob_at(index["key_blob"], index["key_starts"], f)


def _disp(index, f):
    return _blob_at(index["disp_blob"], index["disp_starts"], f)


def _family_of_key(index, key):
    h = zlib.crc32(key.encode("utf-8"))
    hs = index["key_hash"]
    a, b = int(np.searchsorted(hs, h, "left")), int(np.searchsorted(hs, h, "right"))
    for j in range(a, b):
        f = int(index["key_hash_fam"][j])
        if _key(index, f) == key:
            return f
    return None


def _when(t):
    if t < 0:
        return ""
    d = datetime.fromtimestamp(int(t), timezone.utc)
    return f"{d.day} {MONTHS[d.month - 1]} {d:%H:%M:%S}"


class _Labels:
    """The labels that are on, as the reader applies them: the filter through thimble.kept, the marks of the label the
    page colours by through thimble.marked."""

    def __init__(self, colour_by=None):
        on = thimble.view_labels()
        self.filter = on.get("filter")
        self.labels = on.get("labels") or []
        lab = next((x for x in self.labels if colour_by and (x.get("id") == colour_by or x.get("name") == colour_by)), None)
        self.label = lab
        self.values = [{"label": lab["name"], "id": lab.get("id"), "value": v["name"], "colour": v["colour"]}
                       for v in (lab.get("values") or [])][:MARKS_MAX] if lab else []
        self._at = {v["value"]: k + 1 for k, v in enumerate(self.values)}

    def kept_rows(self, index, rows):
        """The members of `rows` the filter keeps."""
        if not self.filter:
            return rows
        refs = _refs(index)
        return rows[np.fromiter((thimble.kept(refs[i]) for i in rows.tolist()), bool, count=len(rows))]

    def mark_of(self, ref):
        """1 + the index of the value of the coloured label on the member, 0 when it takes none."""
        if not self.label:
            return 0
        for x in thimble.marked(ref):
            if x.get("label") == self.label["name"]:
                k = self._at.get(x.get("value"))
                if k:
                    return k
        return 0


# ---------------------------------------------------------------- Colour by

VF_FIELDS = ("answer", "status", "body", "through", "source", "saved", "mime")
CLS_NAME = {1: "1xx", 2: "2xx", 3: "3xx", 4: "4xx", 5: "5xx"}
MIME_SHORT = {"vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "vnd.ms-excel": "xls",
              "x-zip-compressed": "zip", "javascript": "js", "x-javascript": "js", "plain": "text",
              "octet-stream": "binary", "problem+json": "json", "x-font-woff": "woff"}


def _mime_short(m):
    """A mime type as the page names it: its subtype, a few long ones shortened (xlsx, xls, zip, js, text)."""
    t = (m or "").split(";")[0].strip().lower()
    if not t:
        return None
    sub = t.split("/", 1)[1] if "/" in t else t
    return MIME_SHORT.get(sub, sub)


def _values(index, choice, rows):
    """(codes, names, kind): for each of `rows`, members in index order (by family, then time), the id in names of its
    value under the page's Colour by choice (colour.query()), -1 for none; kind is the field's name, or "label". A
    field's value is the answer class (2xx to 5xx, none without a status), the status code, the shared body (A for the
    body most of the family's members of `rows` got, B for the next, as the member list's letters; none for a body no
    other member got), "Got through" (a 2xx whose latest earlier member with 2xx, 4xx or 5xx got 4xx or 5xx), the source
    (an Arquivo capture or a urlquery scan), "Saved response" or the short content type; a label's is its highlighted
    value on the member (thimble.colour_value)."""
    rows = np.asarray(rows, np.int64)
    ch = choice if isinstance(choice, dict) else {}
    names, at = [], {}

    def vid(v):
        if v is None or v == "":
            return -1
        i = at.get(v)
        if i is None:
            i = at[v] = len(names)
            names.append(v)
        return i
    if ch.get("label") is not None:
        refs = _refs(index)
        codes = np.fromiter((vid(thimble.colour_value(ch, refs[i])) for i in rows.tolist()), np.int32, count=len(rows))
        return codes, names, "label"
    field = ch.get("field") if ch.get("field") in VF_FIELDS else "answer"
    if field == "answer":
        lut = np.array([vid(CLS_NAME.get(c)) for c in range(6)], np.int32)
        return lut[index["cls"][rows]], names, field
    if field == "status":
        lut = np.array([vid(c) for c in index["codes"]], np.int32)
        return lut[index["st"][rows].astype(np.int64)], names, field
    if field == "mime":
        lut = np.array([vid(_mime_short(m)) for m in index["mimes"]], np.int32)
        return lut[index["mime"][rows].astype(np.int64)], names, field
    if field == "source":
        lut = np.array([vid("Arquivo capture" if f.endswith(ARQ) else "urlquery scan") for f in index["files"]], np.int32)
        return lut[index["fi"][rows].astype(np.int64)], names, field
    if field == "saved":
        sv = vid("Saved response")
        return np.where(index["saved_mask"][rows], sv, -1).astype(np.int32), names, field
    if field == "through":
        g = vid("Got through")
        codes = np.full(len(rows), -1, np.int32)
        last_f, last = -1, 0
        for k, (f, c) in enumerate(zip(index["fam"][rows].tolist(), index["cls"][rows].tolist())):
            if f != last_f:
                last_f, last = f, 0
            if c == 2 and last in (4, 5):
                codes[k] = g
            if c in (2, 4, 5):
                last = c
        return codes, names, field
    # body: within each family the digests two or more of its members share, the commonest first, then in text order
    letters = np.array([vid(chr(65 + k)) for k in range(26)], np.int32)
    codes = np.full(len(rows), -1, np.int32)
    dg = index["dg"][rows].astype(np.int64)
    ok = np.flatnonzero(dg > 0)
    if len(ok):
        fam = index["fam"][rows][ok].astype(np.int64)
        base = int(dg.max()) + 1
        uk, inv, cnt = np.unique(fam * base + dg[ok], return_inverse=True, return_counts=True)
        uf, ud = uk // base, uk % base
        sel = np.flatnonzero(cnt > 1)
        group = np.full(len(uk), -1, np.int64)
        if len(sel):
            order = sel[np.lexsort((index["dg_rank"][ud[sel]], -cnt[sel], uf[sel]))]
            sf = uf[order]
            starts = np.flatnonzero(np.concatenate(([True], sf[1:] != sf[:-1])))
            pos = np.arange(len(order)) - np.repeat(starts, np.diff(np.append(starts, len(order))))
            group[order] = pos
        g = group[inv]
        codes[ok] = np.where(g >= 0, letters[np.maximum(g, 0) % 26], -1)
    return codes, names, "body"


def _on_mask(choice, codes, names):
    """Whether each code's chip is on, and whether any is off."""
    off = choice.get("off") if isinstance(choice, dict) else None
    off = off if isinstance(off, list) else []
    if not off:
        return np.ones(len(codes), bool), False
    on_of = np.array([str(v) not in {str(x) for x in off if x is not None} for v in names] + [None not in off], bool)
    return on_of[np.where(codes < 0, len(names), codes)], True


def _counts(codes, names):
    """{value: members} of the codes, '' for none."""
    out = {}
    if len(codes):
        b = np.bincount(codes.astype(np.int64) + 1, minlength=len(names) + 1)
        for i, n in enumerate(b.tolist()):
            if n:
                out["" if i == 0 else names[i - 1]] = n
    return out


# ---------------------------------------------------------------- the answers


def _strip(classes):
    """A family's values in time order as runs 'value:length,...', binned into STRIP_MAX cells when longer, each bin
    taking the value most of its members take (an unmarked bin only when none is marked)."""
    v = np.asarray(classes, np.int64)
    if len(v) > STRIP_MAX:
        edges = np.linspace(0, len(v), STRIP_MAX + 1).astype(np.int64)
        binned = []
        for a, b in zip(edges[:-1], edges[1:]):
            seg = v[a:b]
            if not len(seg):
                continue
            c = np.bincount(seg)
            if len(c) > 1 and c[1:].any() and c[0] >= c[1:].max():
                c[0] = 0
            binned.append(int(np.argmax(c)))
        v = np.array(binned, np.int64)
    if not len(v):
        return ""
    s = np.concatenate(([0], np.flatnonzero(np.diff(v)) + 1))
    runs = np.diff(np.append(s, len(v)))
    return ",".join(f"{int(v[a])}:{int(r)}" for a, r in zip(s, runs))


def _search_hits(index, q):
    """The families with a member whose URL, as written or decoded, holds q in any case, as a boolean array."""
    q = " ".join(str(q or "").split()).lower()
    F = len(index["f_start"]) - 1
    got = _SEARCHES.get((id(index), q))
    if got is not None:
        return got
    n = index["n"]
    hit = np.zeros(n, bool)
    needle = q.encode("utf-8")
    for name in ("raw", "dec"):
        blob, starts = index["blob_" + name], index["starts_" + name]
        found, pos = [], blob.find(needle)
        while pos >= 0:
            found.append(pos)
            k = int(np.searchsorted(starts, pos, "right")) - 1
            nxt = int(starts[k + 1]) if k + 1 < n else len(blob)
            pos = blob.find(needle, nxt)
        if found:
            hit[np.searchsorted(starts, np.array(found, np.int64), "right") - 1] = True
    fams = np.zeros(F, bool)
    fams[np.unique(index["fam"][hit])] = True
    blob = index["disp_blob"]
    low = _DISP_LOWER.get(id(index))
    if low is None or low[0] is not index:
        low = (index, blob.lower())
        _DISP_LOWER.clear()
        _DISP_LOWER[id(index)] = low
    pos = low[1].find(needle)
    st = index["disp_starts"]
    while pos >= 0:
        k = int(np.searchsorted(st, pos, "right")) - 1
        fams[k] = True
        pos = low[1].find(needle, int(st[k + 1]) if k + 1 < F else len(blob))
    if len(_SEARCHES) >= SEARCHES_KEPT:
        _SEARCHES.pop(next(iter(_SEARCHES)))
    _SEARCHES[(id(index), q)] = fams
    return fams


_DISP_LOWER = {}


def _family_rows(index, f):
    return np.arange(int(index["f_start"][f]), int(index["f_start"][f + 1]), dtype=np.int64)


def _family_brief(index, f, stats, V, kept_rows=None):
    """One family as a list shows it, its strip the Colour by value of each of its members in time order (V, the value
    code of each member, -1 for none; in the strip 0 for none and code + 1 for a value)."""
    rows = _family_rows(index, f) if kept_rows is None else kept_rows
    out = {"key": _key(index, f), "url": _disp(index, f), "section": index["folders"][int(index["f_sec"][f])],
           "spellings": int(stats["spell"][f]), "rows": int(stats["rows"][f]),
           "spellings_all": int(index["f_spell"][f]), "rows_all": int(index["f_rows"][f]),
           "through": bool(stats["through"][f]), "strip": _strip(V[rows] + 1),
           "first": _when(int(stats["t0"][f])) if stats["t0"][f] < np.iinfo(np.int64).max else "",
           "saved": bool(index["f_saved"][f])}
    return out


def _selected(index, query, labels):
    """(families in list order, stats, kept members per family or None) for the overview's filters."""
    F = len(index["f_start"]) - 1
    base = {k: index["f_" + k] for k in ("rows", "spell", "mask", "through", "t0")}
    lo = max(1, _int(query.get("min") or 3))
    cand = base["spell"] >= lo
    secs = query.get("sections")
    if secs:
        want = np.array([s in set(secs) for s in index["folders"]] + [False], bool)
        cand &= want[index["f_sec"].astype(np.int64)]
    q = str(query.get("q") or "").strip()
    if q:
        cand &= _search_hits(index, q)
    kept = None
    stats = base
    if labels.filter:
        fams = np.flatnonzero(cand)
        rows = np.concatenate([_family_rows(index, f) for f in fams.tolist()]) if len(fams) else np.zeros(0, np.int64)
        thimble.progress(0, 1, "applying the label filter")
        keep = np.zeros(index["n"], bool)
        keep[labels.kept_rows(index, rows)] = True
        stats = _family_stats(index, keep)
        kept = keep
        cand &= stats["rows"] > 0
    cls = [int(c) for c in query.get("cls") or [] if str(c).isdigit()]
    if cls:
        m = np.uint8(sum(1 << c for c in cls))
        cand &= (stats["mask"] & m) > 0
    if query.get("through"):
        cand &= stats["through"]
    fams = np.flatnonzero(cand)
    order = np.lexsort((stats["t0"][fams], -stats["rows"][fams].astype(np.int64),
                        -stats["spell"][fams].astype(np.int64), index["f_sec"][fams]))
    return fams[order], stats, kept


def _overview(index, query):
    """The families the filters keep, by section: each section's counts and the mix of its members' values under the
    Colour by choice, and its first families (or, with `section` and `offset`, the next page of one section's); the
    counts of every value for the chips; and a family whose members all take a value turned off left out."""
    labels = _Labels()
    fams, stats, kept = _selected(index, query, labels)
    choice = query.get("colour")
    # every member of the families the other filters keep, with its value
    rows_all = np.concatenate([_family_rows(index, f) for f in fams.tolist()]) if len(fams) else np.zeros(0, np.int64)
    if kept is not None:
        rows_all = rows_all[kept[rows_all]]
    thimble.progress(0, 1, "colouring the members")
    codes, names, kind = _values(index, choice, rows_all)
    counts = _counts(codes, names)
    on, some_off = _on_mask(choice, codes, names)
    V = np.full(index["n"], -1, np.int32)
    V[rows_all] = codes
    if some_off:
        lit = np.zeros(len(index["f_start"]) - 1, bool)
        lit[index["fam"][rows_all[on]]] = True
        fams = fams[lit[fams]]
    secs = index["f_sec"][fams]
    out_secs = []
    one = query.get("section")
    offset = max(0, _int(query.get("offset")))
    sel = _family_of_key(index, str(query.get("sel"))) if query.get("sel") else None
    for k, folder in enumerate(index["folders"]):
        if one and folder != one:
            continue
        mine = fams[secs == k]
        if not len(mine):
            out_secs.append({"section": folder, "families": 0, "rows": 0, "through": 0, "mix": [], "list": []})
            continue
        rows = np.concatenate([_family_rows(index, f) for f in mine.tolist()])
        if kept is not None:
            rows = rows[kept[rows]]
        b = np.bincount(V[rows].astype(np.int64) + 1, minlength=len(names) + 1).tolist()
        mix = [[i - 1, n] for i, n in enumerate(b) if n]
        page = mine[offset:offset + MORE_PAGE] if one else mine[:SECTION_PAGE]
        lst = []
        for f in page.tolist():
            kr = None
            if kept is not None:
                fr = _family_rows(index, f)
                kr = fr[kept[fr]]
            lst.append(_family_brief(index, f, stats, V, kr))
        pinned = None
        if sel is not None and not one and int(index["f_sec"][sel]) == k:
            at = np.flatnonzero(mine == sel)
            if len(at) and at[0] >= len(page):
                kr = None
                if kept is not None:
                    fr = _family_rows(index, sel)
                    kr = fr[kept[fr]]
                pinned = {**_family_brief(index, sel, stats, V, kr), "rank": int(at[0]) + 1}
        out_secs.append({"section": folder, "families": int(len(mine)), "rows": int(len(rows)),
                         "through": int(stats["through"][mine].sum()), "mix": mix, "list": lst,
                         "offset": offset if one else 0, **({"pinned": pinned} if pinned else {})})
    out = {"sections": out_secs, "families": int(len(fams)), "rows": int(sum(s["rows"] for s in out_secs)),
           "all_families": int(len(index["f_start"]) - 1), "all_rows": int(index["n"]),
           "min": max(1, _int(query.get("min") or 3))}
    if len(fams) and not one:
        # the family to open first: the one with the most spellings among those that got through, else the first
        th = stats["through"][fams].astype(np.int64)
        best = np.lexsort((-stats["rows"][fams].astype(np.int64), -stats["spell"][fams].astype(np.int64), -th))[0]
        out["pick"] = _key(index, int(fams[best]))
        out["pick_section"] = index["folders"][int(index["f_sec"][fams[best]])]
    out["vals"], out["kind"], out["counts"] = names, kind, counts
    return out


def _digest_groups(digests):
    """{digest: group} for the digests two or more members share, the commonest first."""
    cnt = {}
    for d in digests:
        if d:
            cnt[d] = cnt.get(d, 0) + 1
    shared = sorted((d for d, c in cnt.items() if c > 1), key=lambda d: (-cnt[d], d))
    return {d: g for g, d in enumerate(shared)}


def _family(index, query):
    """One family: its URL and counts, its members in time order (a page of MEMBERS_PAGE from `offset`), each with the
    parts of its spelling that differ from the family's URL, and the other families of its path."""
    key = str(query.get("key") or "")
    f = _family_of_key(index, key)
    if f is None:
        return None
    labels = _Labels()
    rows = _family_rows(index, f)
    rows = labels.kept_rows(index, rows)
    choice = query.get("colour")
    codes, vnames, kind = _values(index, choice, rows)
    code_of = dict(zip(rows.tolist(), codes.tolist()))
    folder = index["folders"][int(index["f_sec"][f])]
    disp = _disp(index, f)
    hl = int(index["host_len"][f])
    shown_host, shown_rest = disp[:hl], disp[hl:]
    ipmap = {k.split("\n", 1)[1]: v for k, v in index["ipmap"].items() if k.split("\n", 1)[0] == folder}
    keep = np.zeros(index["n"], bool)
    keep[rows] = True
    stats = _family_stats(index, keep) if labels.filter else {k: index["f_" + k] for k in
                                                              ("rows", "spell", "mask", "through", "t0")}
    want = rows.tolist()
    offset = max(0, _int(query.get("offset")))
    focus = query.get("ref")
    refs = _refs(index)
    if focus and offset == 0:
        try:
            pos = [refs[i] for i in want].index(focus)
            offset = (pos // MEMBERS_PAGE) * MEMBERS_PAGE
        except ValueError:
            pass
    got = _read_many(index, want)

    def body_of(i):
        """(length, digest) of a member: warc_record_length and archive_digest_sha1_base32 of a capture, the size and
        sha256 of a scan's request for the submitted URL."""
        cells = got.get(i, ({}, ""))[0]
        if "target_url" in cells:
            n = (cells.get("warc_record_length") or "").strip()
            return (_int(n) if n.isdigit() else None), (cells.get("archive_digest_sha1_base32") or "").strip()
        return index["scan_body"].get(int(i), (None, ""))

    bodies = {i: body_of(i) for i in want}
    groups = _digest_groups([bodies[i][1] for i in want])
    weight = {}
    for i in want:
        cells = got.get(i, ({}, ""))[0]
        u = ((cells.get("target_url") or cells.get("submitted_url")) or "").strip()
        weight[u] = weight.get(u, 0) + 1
    spelled = {u: _spell(u, shown_host, shown_rest, ipmap) for u in weight}
    _minority_marks(spelled, weight)
    spell_at = {}
    spell_list = []
    members = []
    last = 0  # the class of the latest member that got 2xx, 4xx or 5xx
    for j, i in enumerate(want):
        cells, _text = got.get(i, ({}, ""))
        c = int(index["cls"][i])
        passed = c == 2 and last in (4, 5)
        if c in (2, 4, 5):
            last = c
        if not offset <= j < offset + MEMBERS_PAGE:
            continue
        arq = "target_url" in cells
        url = (cells.get("target_url") if arq else cells.get("submitted_url")) or ""
        url = url.strip()
        length, dig = bodies[i]
        if url not in spell_at:
            spell_at[url] = len(spell_list)
            spell_list.append({"url": url, "parts": spelled[url][0].segments() if url in spelled else [[url, None]],
                               "members": weight.get(url, 0)})
        m = {"ref": refs[i], "time": ((cells.get("captured_at_utc") if arq else cells.get("report_at_utc")) or "").strip(),
             "spelling_idx": spell_at[url], "status": index["codes"][int(index["st"][i])],
             "status_class": c, "mime": index["mimes"][int(index["mime"][i])], "passed": passed,
             "source": "arquivo" if arq else "urlquery"}
        if arq:
            m["record_number"] = (cells.get("record_number") or "").strip()
        else:
            m["report_id"] = (cells.get("report_id") or "").strip()
        m["length"] = length
        if dig:
            m["digest"] = dig
            m["digest_idx"] = groups.get(dig, -1)
        if i in index["responses"]:
            m["saved"] = True
        v = code_of.get(i, -1)
        m["v"] = vnames[v] if v >= 0 else None
        members.append(m)
    # the other families of this path
    sib = np.flatnonzero((index["f_path"] == index["f_path"][f]) & (index["f_sec"] == index["f_sec"][f]))
    sib = sib[sib != f]
    if labels.filter and len(sib):
        srows = np.concatenate([_family_rows(index, s) for s in sib.tolist()])
        keep2 = np.zeros(index["n"], bool)
        keep2[labels.kept_rows(index, srows)] = True
        sstats = _family_stats(index, keep2)
        sib = sib[sstats["rows"][sib] > 0]
    else:
        sstats = {k: index["f_" + k] for k in ("rows", "spell", "mask", "through", "t0")}
        keep2 = None
    sib = sib[np.lexsort((-sstats["rows"][sib].astype(np.int64), -sstats["spell"][sib].astype(np.int64)))]
    siblings = []
    shown_sib = sib[:SIBLINGS_MAX].tolist()
    srows = [(_family_rows(index, s) if keep2 is None else _family_rows(index, s)[keep2[_family_rows(index, s)]])
             for s in shown_sib]
    # the siblings' strips in the values of the same choice, which name their values in the same list
    SV = np.full(index["n"], -1, np.int32)
    if shown_sib:
        allr = np.concatenate(srows)
        scodes, snames, _k = _values(index, choice, allr)
        vnames += [x for x in snames if x not in vnames]
        remap = np.array([vnames.index(x) for x in snames] or [0], np.int32)
        SV[allr] = np.where(scodes >= 0, remap[np.maximum(scodes, 0)], -1)
    for s, kr in zip(shown_sib, srows):
        siblings.append(_family_brief(index, s, sstats, SV, kr))
    kinds = {}
    for sp_ in spell_list:
        for k in {k for _t, k in sp_["parts"] if k}:
            kinds[k] = kinds.get(k, 0) + sp_["members"]
    kinds = [[k, kinds[k]] for k in KINDS if k in kinds]
    wr = sorted({index["wraps"][int(index["wr"][i])] for i in want} - {""})
    out = {"key": key, "url": disp, "section": folder, "rows": int(len(want)), "spellings": int(stats["spell"][f]),
           "through": bool(stats["through"][f]), "strip": _strip(codes + 1), "offset": offset, "vals": vnames,
           "kind": kind,
           "members": members, "spelling_list": spell_list, "more": offset + MEMBERS_PAGE < len(want),
           "kinds": kinds, "wrappers": wr, "spellings_all": int(index["f_spell"][f]), "rows_all": int(index["f_rows"][f]),
           "digests": len(groups), "siblings": siblings, "sibling_count": int(len(sib)),
           "span": [_when(int(index["t"][rows[0]])) if len(rows) else "", _when(int(index["t"][rows[-1]])) if len(rows) else ""]}
    return out


def _member(index, query):
    """One member in full: every column of its row as the file holds it, its archive or report link, and the saved
    responses sources.csv names for it with their text."""
    hit = _at_ref(index, str(query.get("ref") or ""))
    if hit is None:
        return None
    i = hit
    if thimble.view_labels().get("filter") and not thimble.kept(_ref(index, i)):
        return None
    cells, text = _read_many(index, [i])[i]
    arq = "target_url" in cells
    out = {"ref": _ref(index, i), "columns": [[k, v] for k, v in cells.items()], "line": text,
           "link": ((cells.get("archive_url") if arq else cells.get("report_url")) or "").strip(),
           "status": index["codes"][int(index["st"][i])], "source": "arquivo" if arq else "urlquery"}
    if not arq:
        out["status_from"] = f"{index['files'][int(index['fi'][i])].split('/')[0]}/{HTTP}"
    folder = index["files"][int(index["fi"][i])].split("/")[0]
    saved = []
    for s in index["responses"].get(int(i), []):
        r = {"file": s["file"], "source_url": s["source_url"], "captured_at_utc": s["captured_at_utc"],
             "http_status": s["http_status"], "sources": f"{folder}/{SOURCES}#L{s['line']}"}
        if s["file"]:
            path = f"{folder}/{s['file']}"
            r["path"] = path
            if path.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
                r["image"] = True
            else:
                try:
                    with open(path, "rb") as fh:
                        data = fh.read(RESPONSE_MAX * 4 + 1)
                    t = data.decode("utf-8", "replace")
                    r["text"], r["cut"] = t[:RESPONSE_MAX], len(t) > RESPONSE_MAX or len(data) > RESPONSE_MAX * 4
                except OSError:
                    r["missing"] = True
        saved.append(r)
    out["saved_responses"] = saved
    return out


def records(index, query):
    """{op: overview, min, sections?, cls?, through?, q?, colour?, section?, offset?, sel?}: the families the filters
    keep, by section (_overview), the family `sel` names added to its section's list when it is further down. {op: family, key, offset?, ref?, colour?}: one family's members (_family).
    {op: member, ref}: one member in full (_member)."""
    query = query or {}
    op = query.get("op")
    if op == "family":
        return _family(index, query)
    if op == "member":
        return _member(index, query)
    return _overview(index, query)


# ---------------------------------------------------------------- citations


def _at_line(index, path, n):
    """The member whose lines hold line n of the file, or None."""
    if path not in index["files"]:
        return None
    got = index["at_line"].get(index["files"].index(path))
    if got is None:
        return None
    firsts, lasts, rows = got
    k = int(np.searchsorted(firsts, n, "right")) - 1
    if k >= 0 and lasts[k] >= n:
        return int(rows[k])
    return None


def _at_ref(index, ref):
    path, _h, frag = ref.partition("#")
    m = re.fullmatch(r"L(\d+)(?:-L?\d+)?", frag)
    if m:
        return _at_line(index, path, int(m.group(1)))
    m = re.fullmatch(r"row=(\d+)", frag)
    if m:
        n = _line_of_row(index, path, int(m.group(1)))
        return None if n is None else _at_line(index, path, n)
    return None


def _line_of_row(index, path, row):
    """The first line of the n-th row after the header of a claimed file, as thimble numbers CSV rows."""
    if path not in index["files"]:
        return None
    got = index["at_line"].get(index["files"].index(path))
    if got is None:
        return None
    firsts = got[0]
    if not 1 <= row <= len(firsts):
        return None
    return int(firsts[row - 1])


def _line_text(path, n):
    """The text of line n of a file, or None."""
    try:
        with open(path, "rb") as fh:
            for k, raw in enumerate(fh, 1):
                if k == n:
                    return raw.decode("utf-8", "replace").rstrip("\r\n")
    except OSError:
        return None
    return None


def _short(url, n=40):
    return url if len(url) <= n else url[:n - 1] + "…"


def resolve(index, locator):
    """<file>#L<n> or <file>#row=<n>: the member on that line, opened in its family. view:<slug>/<section>/<url>: one
    family, opened."""
    if "key" in locator:
        key = str(locator.get("key") or "").strip()
        f = _family_of_key(index, key)
        if f is None:
            return None
        rows = _family_rows(index, f).tolist()
        got = _read_many(index, rows[:400])
        spellings, firsts, seen = [], [], set()
        for i in rows[:400]:
            cells, text = got.get(i, ({}, ""))
            u = ((cells.get("target_url") or cells.get("submitted_url")) or "").strip()
            if u and u not in seen and u in text:
                seen.add(u)
                spellings.append(u)
                firsts.append(i)
            if len(spellings) >= EXCERPT_SPELLINGS:
                break
        refs = _refs(index)
        disp = _disp(index, f)
        # the members whose spellings the excerpt quotes come first, then the rest in time order
        quoted = set(firsts)
        order = firsts + [i for i in rows if i not in quoted]
        return {"excerpt": "\n".join(spellings), "label": _short(disp), "refs": [refs[i] for i in order[:UNIT_REFS]],
                "key": key, "target": {"key": key}}
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    if path not in index["files"]:
        return None
    i = _at_ref(index, f"{path}#{fragment}")
    if i is None:
        m = re.fullmatch(r"L(\d+)(?:-L?\d+)?", fragment)
        n = int(m.group(1)) if m else None
        text = _line_text(path, n) if n else None
        if not text or not text.strip():
            return None
        folder = path.split("/")[0]
        what = "columns" if n == 1 else "a line no member holds"
        return {"excerpt": text, "label": _short(f"{folder} · {what}"), "refs": [f"{path}#L{n}"], "key": None,
                "target": {"section": folder}}
    cells, text = _read_many(index, [i])[i]
    url = ((cells.get("target_url") or cells.get("submitted_url")) or "").strip()
    f = int(index["fam"][i])
    key = _key(index, f)
    status = index["codes"][int(index["st"][i])]
    ref = _ref(index, i)
    a, b = int(index["ln"][i]), int(index["last"][i])
    return {"excerpt": url if url and url in text else text,
            "label": _short(f"{status or 'scan'} · {_disp(index, f)}"),
            "refs": [ref if a == b else f"{path}#L{a}-L{b}"], "key": key, "target": {"key": key, "ref": ref}}


def problems(index):
    """The rows that do not parse, each {ref, why}."""
    return index["problems"]


def unplaced(index):
    """The members with no URL, and those with no time the reader can read, each {ref, why}."""
    return index["unplaced"]


def hidden(index):
    """No claimed file is left out: the reader reads every one whole."""
    return []
