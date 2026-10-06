# Activity Timeline: one agent transcript on a time axis, every record placed at its timestamp and labelled by the
# activity it serves, so the shape of where the hours went reads at a glance. It is the run's Activity Timeline with
# thimble's Colour by control in place of its own colour menu and legend, and a record opened in full.
#
# The file (transcript.jsonl): one JSON object per line, in the order the agent ran. Each is a "message":
#   record     always "message"
#   index      the record's stable key (an integer; the file skips some, so it is not the line number)
#   role       System (the one system prompt), Assistant (almost all) or Human (the two context-compaction turns)
#   type       TextMessage (reasoning or a reply) or ToolMessage (a tool call with its result)
#   timestamp  ISO 8601 UTC. The simulated run spans 01:02 to 11:28; the System prompt and the two Human turns carry
#              the wall-clock stamp of the harness (around 21:29), not a place in the run, and one create_tool record
#              carries none.
#   content    the text, on a TextMessage
#   tool_name, tool_call, tool_result   the tool, its arguments and its output, on a ToolMessage
#
# The records (what the page filters and colours by):
#   time       when, in UTC (see "the cleaning")
#   activity   captcha, signup, money, exploit, infra or other — what the record is working on (see "the cleaning")
#   tool       the tool a ToolMessage called, "" on a TextMessage (read from tool_name)
#   role       System, Assistant or Human (read as the file holds it)
#   type       TextMessage or ToolMessage (read as the file holds it)
#
# The cleaning:
#   time       the ISO stamp read in UTC; the System and Human records' harness stamp (hour 21) and the one record with
#              no stamp are replaced by a time interpolated from the records around them in file order, so the two Human
#              records land at the context compaction (~07:28-07:30) where they belong rather than off the axis
#   activity   a classification from each record's text and tool call against the signal table below (ACTIVITY_RULES):
#              the strongest single signal per activity wins; a bare reasoning record with no signal of its own takes
#              the activity of the nearest record that has one, which the scaffolding (System/Human) does not cross
#   boundaries the two Human records mark the context compaction, drawn as a line across the lanes
#   bad lines  a line that is not one JSON message, such as a torn last line, is no record and problems() lists it
#
# The method: build_index reads the one file by bytes (counting every byte through open()), keeps a small row per record
# (time, line, activity, tool, role, type) with the record's index and the byte span of its line, and sorts by time.
# records() answers the page a page of rows at a time as columns; a record's text, its tool call and result are read back
# from the line on demand. Labels apply when rows are served: each answer keeps only the rows thimble.kept holds, and
# carries each row's value under the page's Colour by choice (thimble.colour_value: the row's Activity or Tool, or a
# label's value on it), which the page colours the lanes, the strip and the list by.
#
# Units: one record, cited by its index (view:activity-timeline/<index>); L<n> opens the record on line n.
import bisect
import json
import re
from datetime import datetime, timezone

import thimble

ACTS = ("captcha", "signup", "money", "exploit", "infra", "other")
TOOLS = ("", "terminal", "create_tool", "view_tool", "str_replace_tool", "insert_tool")
ROLES = ("Assistant", "System", "Human")
TYPES = ("TextMessage", "ToolMessage")
T, L, A = 0, 1, 2  # a row's time (epoch seconds), line, activity index; tool, role, type follow
TOOL, ROLE, TYP = 3, 4, 5
OVERVIEW_ROWS = 4000  # rows one overview page returns
TEXT_MAX = 400        # characters of a record's text a list row or hover gets
# the names the page's Colour by fields give each value: Activity (the scaffolding, "other", takes none) and Tool
ACT_NAME = {"captcha": "Captcha", "signup": "Signup", "money": "Money", "exploit": "Exploit", "infra": "Infra", "other": None}
TOOL_NAME = {"": "Reasoning", "terminal": "terminal", "create_tool": "create", "view_tool": "view",
             "str_replace_tool": "str_replace", "insert_tool": "insert"}

# The signal table: (pattern over the record's lowered text + tool call + result, activity, weight). The strongest
# single matching weight per activity wins. Ordered most specific first. Early target discovery, port scans and payload
# planning read as recon (infra); "exploit" is kept for the attack the agent actually carried out — compromising a PyPI
# account's two-factor login and uploading its malicious package.
ACTIVITY_RULES = [
    (r"upload\.pypi\.org|test\.pypi\.org|\bupload the package\b|upload2?\.py|\btwine\b", "exploit", 6),
    (r"recovery[- ]code|reauthenticate|\btotp\b|\b2fa\b|two[- ]factor|api token|pypi_token|token_flow|burn recovery|enable 2fa", "exploit", 6),
    (r"mlflow[-_]ui[-_. ]?2|mlflow_ui\.tar|\bsdist\b|\.tar\.gz|bdist_wheel|malicious package|typosquat|dependency confusion", "exploit", 4),
    (r"\bh?captcha\b|recaptcha|turnstile|hcaptcha", "captcha", 6),
    (r"cv_detect|cv_temporal|solve_captcha|solve2|solve_final|hexpeaks|tippeaks|brainscan|fast_auto|\bmr_\w|auto_lines|drag_do|click_canvas|dump_canvas|click_at|new_challenge|scroll_shot", "captcha", 5),
    (r"squiggle|\bworms?\b|\bpeaks?\b|canvas frame|pixel-wise|montage|\bopencv\b|cv2|\bcrop\b|-resize|\bbbox\b|bounding box|connected component", "captcha", 3),
    (r"select all|click the|which image|drag the|solve the|challenge image|\btile\d|\bfrog\b|\brider\b", "captcha", 3),
    (r"login\.yahoo|mail\.yahoo|login\.aol|accounts\.google|identitytoolkit|proton\.me|mail\.ru|temp-mail|smsreceivefree|sms_?sweep|get-sms|receive-?sms", "signup", 6),
    (r"yahoo_|reg_browser|reg_dummy|bee_register|register\d?\.py|submit_reg|register_resp|change_email|check_email_status|manage_account|_freereg|yahoo_phone|yahoo_signup|yahoo_full", "signup", 5),
    (r"sign[- ]?up|registration|register\b|verification code|verify your|\botp\b|confirm your email|create account|create an account|phone number|sms code|email address", "signup", 3),
    (r"polygon-rpc|polygon-bor|publicnode|polygonscan|trongrid|trustwallet|checkout\.stripe|api\.stripe", "money", 6),
    (r"\bwallet\b|\bcrypto\b|\busdt\b|\busdc\b|bitcoin|\bbtc\b|\btron\b|\bpolygon\b|blockchain|seed phrase", "money", 4),
    (r"\bpayout\b|\bpayment\b|\bstripe\b|\bpaypal\b|\bbalance\b|withdraw|deposit|\bbank\b|earn money|\bfunds?\b", "money", 2),
    (r"dl\.min\.io|download\.pytorch|api\.ipify|pwnedpasswords|\bchromedriver\b", "infra", 4),
    (r"\bssh\b|-r \[|port forward|tunnel|socks5|pip install|pip3 install|apt-get|apt install|\bwget\b|\bvenv\b|virtualenv|requirements\.txt|\bnmap\b", "infra", 3),
    (r"scan225|port scan|\bprobe\b|oracle_domains|try_domains|sniff_api|peek_resources|goto_dump|x-forwarded-for|\bxff_|reconnaissance|dependency-confusion target|\b404 on pypi\b", "infra", 3),
    (r"\bcurl\b|\bgrep\b|\bsession_name\b|wait_for_idle|chmod|mkdir|\bpkill\b|\bps aux\b|install", "infra", 1),
]
_COMPILED = [(re.compile(p), ACTS.index(a), w) for p, a, w in ACTIVITY_RULES]


def _blob(rec):
    parts = [rec.get("content") or ""]
    tc = rec.get("tool_call")
    if isinstance(tc, dict):
        parts.append(" ".join(str(v) for v in tc.values()))
    elif tc:
        parts.append(str(tc))
    tr = rec.get("tool_result")
    if tr:
        parts.append(str(tr)[:1500])
    return " ".join(parts).lower()


def _direct(rec):
    """The activity index a record's own signals name, -1 for none, -2 for the System/Human scaffolding."""
    if rec.get("role") in ("System", "Human"):
        return -2
    text = _blob(rec)
    best, best_w = -1, 0
    seen = {}
    for rx, ai, w in _COMPILED:
        if rx.search(text):
            if w > seen.get(ai, 0):
                seen[ai] = w
    for ai, w in seen.items():
        if w > best_w or (w == best_w and (best < 0 or ai < best)):
            best, best_w = ai, w
    return best


def _fill(raw):
    """Spread activity to the records with none of their own: each takes the nearest signalled record's activity, not
    crossing the System/Human scaffolding; a tie goes to the next record, since a reasoning record usually introduces
    the action that follows it. The scaffolding itself becomes "other"."""
    n = len(raw)
    other = ACTS.index("other")
    prev = [None] * n
    p = None
    for i in range(n):
        if raw[i] == -2:
            p = None
        elif raw[i] >= 0:
            p = (raw[i], i)
        prev[i] = p
    nxt = [None] * n
    q = None
    for i in range(n - 1, -1, -1):
        if raw[i] == -2:
            q = None
        elif raw[i] >= 0:
            q = (raw[i], i)
        nxt[i] = q
    out = []
    for i in range(n):
        if raw[i] == -2:
            out.append(other)
        elif raw[i] >= 0:
            out.append(raw[i])
        else:
            a, b = prev[i], nxt[i]
            if a and b:
                out.append(b[0] if (b[1] - i) <= (i - a[1]) else a[0])
            elif a:
                out.append(a[0])
            elif b:
                out.append(b[0])
            else:
                out.append(other)
    return out


def _parse_time(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def _lines(path, offsets):
    """(line number, text) of each line, recording each line's byte offset; every byte is read through open()."""
    with open(path, "rb") as fh:
        pos = 0
        for n, raw in enumerate(fh, 1):
            offsets.append(pos)
            pos += len(raw)
            yield n, raw.decode("utf-8", "replace").rstrip("\r\n")


def build_index(paths):
    """{"file": path, "rows": [[t, line, act, tool, role, typ]] in time order, "idx": [index per row], "spans": [[a,b]
    per row], "offsets": [byte offset of line n], "line_rows": {line: row}, "idx_rows": {index: row}, "boundaries":
    [row of each Human record], "problems": [{ref, why}], "bytes": total bytes}."""
    files = list(paths)
    path = files[0] if files else None
    offsets, problems = [], []
    parsed = []  # (line, record-dict or None, raw-text)
    if path:
        try:
            for n, text in _lines(path, offsets):
                if not text.strip():
                    parsed.append((n, None, text))
                    continue
                try:
                    rec = json.loads(text)
                except ValueError:
                    problems.append({"ref": f"{path}#L{n}", "why": "not one JSON message (a torn or malformed line)"})
                    parsed.append((n, None, text))
                    continue
                if not isinstance(rec, dict):
                    problems.append({"ref": f"{path}#L{n}", "why": "not a JSON object"})
                    parsed.append((n, None, text))
                    continue
                parsed.append((n, rec, text))
        except OSError as e:
            problems.append({"ref": f"{path or '?'}#L1", "why": f"the file cannot be read ({type(e).__name__})"})

    recs = [(n, r) for n, r, _ in parsed if r is not None]
    # placed time: real 2026 stamps not in hour 21; interpolate the rest from file-order neighbours
    def real(r):
        d = _parse_time(r.get("timestamp"))
        return d if (d and d.hour != 21) else None
    placed = [real(r) for _, r in recs]
    last = None
    for i in range(len(recs)):
        if placed[i] is None:
            placed[i] = last
        else:
            last = placed[i]
    nxt = None
    for i in range(len(recs) - 1, -1, -1):
        if placed[i] is None:
            placed[i] = nxt
        else:
            nxt = placed[i]

    acts = _fill([_direct(r) for _, r in recs])

    built = []
    for (n, r), d, a in zip(recs, placed, acts):
        if d is None:
            problems.append({"ref": f"{path}#L{n}", "why": "no time the reader can read or place"})
            continue
        tool = r.get("tool_name") or ""
        ti = TOOLS.index(tool) if tool in TOOLS else 0
        role = r.get("role") if r.get("role") in ROLES else "Assistant"
        typ = r.get("type") if r.get("type") in TYPES else "TextMessage"
        idx = r.get("index")
        if not isinstance(idx, int) or isinstance(idx, bool):
            idx = n
        built.append({"t": int(d.timestamp()), "line": n, "a": a, "tool": ti,
                      "role": ROLES.index(role), "typ": TYPES.index(typ), "idx": idx,
                      "human": role == "Human"})
    built.sort(key=lambda r: (r["t"], r["line"]))

    rows, idxlist, spans, line_rows, idx_rows, boundaries = [], [], [], {}, {}, []
    for i, r in enumerate(built):
        rows.append([r["t"], r["line"], r["a"], r["tool"], r["role"], r["typ"]])
        idxlist.append(r["idx"])
        spans.append([r["line"], r["line"]])
        line_rows[r["line"]] = i
        idx_rows.setdefault(r["idx"], i)
        if r["human"]:
            boundaries.append(i)
    return {"file": path, "rows": rows, "idx": idxlist, "spans": spans, "offsets": offsets,
            "line_rows": line_rows, "idx_rows": idx_rows, "boundaries": boundaries,
            "problems": problems, "names": {"act": list(ACTS), "tool": list(TOOLS), "role": list(ROLES),
                                            "typ": list(TYPES)}}


# ---------------------------------------------------------------- reading records back

def _read_lines(index, wanted):
    """{line: raw text} for the wanted file lines, read back by seeking to each line's byte offset."""
    out = {}
    path, offs = index["file"], index["offsets"]
    if not path or not wanted:
        return out
    try:
        with open(path, "rb") as fh:
            for n in sorted(set(wanted)):
                if 1 <= n <= len(offs):
                    fh.seek(offs[n - 1])
                    out[n] = fh.readline().decode("utf-8", "replace").rstrip("\r\n")
    except OSError:
        pass
    return out


def _rec_of(raw):
    try:
        r = json.loads(raw)
        return r if isinstance(r, dict) else {}
    except ValueError:
        return {}


def _literal(rec):
    """A record's text, word for word, for a citation excerpt: a TextMessage's content, or a ToolMessage's command (or,
    failing that, its result). One field, so the excerpt is literally text the cited line holds."""
    if rec.get("type") == "ToolMessage":
        tc = rec.get("tool_call")
        if isinstance(tc, dict):
            v = tc.get("text") or tc.get("command") or tc.get("file_text") or tc.get("path") or tc.get("file_path")
            if v:
                return str(v)
        elif tc:
            return str(tc)
        tr = rec.get("tool_result")
        if tr:
            return str(tr)
        if isinstance(tc, dict):
            return json.dumps(tc)
        return ""
    return str(rec.get("content") or "")


def _first_line(rec):
    """A record's text in one line: a TextMessage's content, or a tool call summarised with the head of its result."""
    if rec.get("type") == "ToolMessage":
        tc = rec.get("tool_call")
        if isinstance(tc, dict):
            arg = tc.get("text") or tc.get("command") or tc.get("file_text") or tc.get("path") or tc.get("file_path")
            if not arg:
                arg = " ".join(f"{k}={v}" for k, v in tc.items())
        else:
            arg = str(tc or "")
        head = f"{rec.get('tool_name') or 'tool'}: {arg}"
        res = str(rec.get("tool_result") or "").strip()
        if res:
            head += "  →  " + res
        text = head
    else:
        text = str(rec.get("content") or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _ref(index, i):
    return f"{index['file']}#L{index['rows'][i][L]}"


def _overview(index, keep, start=0, choice=None):
    """A page of the rows the label filter keeps (and any in `keep`), from row `start`, as columns: r (row), t (seconds
    since t0), ln (line), ix (the record's index), a/tool/role/typ (value indices), hu (1 on a Human record) and v (the
    row's value under the Colour by `choice`, the page's colour.query(): its Activity or Tool name, or a label's value
    on it; None for none). The first page also carries t0, span, the value names and each context-compaction record's
    time."""
    on = thimble.view_labels()
    rows = index["rows"]
    t0 = rows[0][T] if rows else 0
    cols = {k: [] for k in ("r", "t", "ln", "ix", "a", "tool", "role", "typ", "hu", "v")}
    bset = set(index["boundaries"])
    i = max(0, start)
    while i < len(rows) and len(cols["r"]) < OVERVIEW_ROWS:
        row, ref = rows[i], _ref(index, i)
        cur = i
        i += 1
        if on["filter"] and cur not in keep and not thimble.kept(ref):
            continue
        fields = {"activity": ACT_NAME[ACTS[row[A]]], "tool": TOOL_NAME[TOOLS[row[TOOL]]]}
        value = thimble.colour_value(choice, ref, fields)
        vals = (cur, row[T] - t0, row[L], index["idx"][cur], row[A], row[TOOL], row[ROLE], row[TYP],
                1 if cur in bset else 0, value)
        for k, v in zip(cols, vals):
            cols[k].append(v)
    page = {"cols": cols, "next": i if i < len(rows) else None}
    if start <= 0:
        page.update(t0=t0, span=[0, rows[-1][T] - t0 if rows else 0], names=index["names"],
                    file=index["file"], total=len(rows),
                    boundaries=[{"t": rows[b][T] - t0, "ln": rows[b][L], "ix": index["idx"][b]}
                                for b in index["boundaries"]])
    return page


def _texts(index, want):
    rows = index["rows"]
    want = [i for i in want if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(rows)][:2000]
    raws = _read_lines(index, [rows[i][L] for i in want])
    out = []
    for i in want:
        rec = _rec_of(raws.get(rows[i][L], ""))
        out.append([i, _first_line(rec)[:TEXT_MAX]])
    return out


def _kept(index, i, keep=()):
    return i in keep or thimble.kept(_ref(index, i))


def _search(index, q):
    q = str(q or "").strip().lower()
    if not q:
        return {"q": q, "rows": []}
    rows = index["rows"]
    raws = _read_lines(index, [r[L] for r in rows])
    hits = []
    for i, row in enumerate(rows):
        rec = _rec_of(raws.get(row[L], ""))
        if q in _blob(rec) and _kept(index, i):
            hits.append(i)
    return {"q": q, "rows": hits}


def _record(index, i):
    """One record in full: its fields, its whole text, tool call and tool result."""
    rows = index["rows"]
    if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(rows):
        return None
    row = rows[i]
    raw = _read_lines(index, [row[L]]).get(row[L], "")
    rec = _rec_of(raw)
    tc = rec.get("tool_call")
    if isinstance(tc, dict):
        tc = {k: (v if isinstance(v, str) else json.dumps(v)) for k, v in tc.items()}
    elif tc is not None:
        tc = str(tc)
    return {"r": i, "ref": _ref(index, i), "t": row[T], "line": row[L], "index": index["idx"][i],
            "activity": ACTS[row[A]], "role": ROLES[row[ROLE]], "type": TYPES[row[TYP]],
            "tool": TOOLS[row[TOOL]] or None, "timestamp": rec.get("timestamp"),
            "time": datetime.fromtimestamp(row[T], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "content": rec.get("content") or None, "tool_call": tc,
            "tool_result": (str(rec.get("tool_result")) if rec.get("tool_result") is not None else None),
            "human": i in set(index["boundaries"])}


def records(index, query):
    query = query or {}
    keep = {int(x) for x in query.get("keep") or () if isinstance(x, int) and not isinstance(x, bool)}
    op = query.get("op")
    if op == "texts":
        return {"texts": _texts(index, query.get("rows") or [])}
    if op == "search":
        return _search(index, query.get("q"))
    if op == "record":
        return {"record": _record(index, query.get("r"))}
    start = query.get("from")
    return _overview(index, keep, start if isinstance(start, int) and not isinstance(start, bool) else 0,
                     query.get("colour"))


# ---------------------------------------------------------------- places

def _excerpt(index, i):
    raw = _read_lines(index, [index["rows"][i][L]]).get(index["rows"][i][L], "")
    return _literal(_rec_of(raw))[:4000]


def resolve(index, locator):
    """view:activity-timeline/<index>: the record with that index. <file>#L<n>: the record on line n, or the
    nearest."""
    rows = index["rows"]
    when = lambda i: datetime.fromtimestamp(rows[i][T], timezone.utc).strftime("%H:%M")  # noqa: E731
    if "key" in locator:
        key = str(locator["key"]).strip()
        i = None
        if re.fullmatch(r"-?\d+", key) and int(key) in index["idx_rows"]:
            i = index["idx_rows"][int(key)]
        if i is None:
            return None
        text = _excerpt(index, i)
        return {"excerpt": text, "label": f"#{index['idx'][i]} · {ACTS[rows[i][A]]} · {when(i)}",
                "refs": [_ref(index, i)], "key": str(index["idx"][i]), "target": {"r": i}}
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)(?:-L\d+)?", fragment)
    if not m or path != index["file"]:
        return None
    n = int(m.group(1))
    i = index["line_rows"].get(n)
    if i is None and index["line_rows"]:
        lines = sorted(index["line_rows"])
        k = bisect.bisect_left(lines, n)
        nearest = lines[k] if k < len(lines) else lines[-1]
        i = index["line_rows"][nearest]
    if i is None:
        return None
    text = _excerpt(index, i)
    return {"excerpt": text, "label": f"#{index['idx'][i]} · {ACTS[rows[i][A]]} · {when(i)}",
            "refs": [_ref(index, i)], "key": str(index["idx"][i]), "target": {"r": i}}


def problems(index):
    """The lines that are not one JSON message, each {ref, why}, which thimble lists beside the page."""
    return index["problems"]


def unplaced(index):
    """Records the reader read but the page cannot place. Every parsed record is placed in time, so there are none."""
    return []


def hidden(index):
    """Files in scope left unread on purpose. The one claimed file is read whole, so there are none."""
    return []
