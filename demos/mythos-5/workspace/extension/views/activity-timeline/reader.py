# Activity Timeline: one agent transcript on a single time axis.
#
# The file (transcript.jsonl): one record per line, each a JSON object with
#   record     always "message"
#   index      the record's place in the run
#   role       System (the one system prompt), Assistant (the agent) or Human (a prompt from the operator)
#   type       TextMessage (it has `content`) or ToolMessage (it has `tool_name`, `tool_call`, `tool_result`)
#   timestamp  when, ISO 8601 in UTC; the system prompt and the two context-compaction (Human) turns carry the
#              export time instead of their own, and a few records have none or sit out of order
#   content    on a TextMessage: the agent's reasoning (wrapped in <thinking> tags) or its prose, a human prompt, or
#              the system prompt
#   tool_name  on a ToolMessage: terminal, view_tool, create_tool or str_replace_tool
#   tool_call  on a ToolMessage: the call's arguments (a terminal command's `text`, a file tool's `path`, ...)
#   tool_result on a ToolMessage: what the call returned, as text
#
# The records: every line becomes one record with the same fields, which the page lanes, filters and colors by.
#   time   in UTC (below), role, kind and tool.
#   kind   computed from role, type and content: a ToolMessage is `tool`; an Assistant TextMessage whose content
#          opens with a thinking tag is `thinking`, else `text`; a Human turn is `prompt`; the system prompt is
#          `system`.
#   tool   the tool a ToolMessage calls, read from tool_name.
#
# Time: most records carry their own timestamp. The system prompt, the context-compaction turns and a record with no
# timestamp or one out of sequence take a time interpolated from the records around it, so the whole run stays in
# order on the axis. The compaction is drawn on the axis as a flag at the Human turns' time.
#
# Labels (such as the tactic label the lanes group by) apply when records are served, never in the index: every
# answer keeps only the records thimble.kept(ref) holds for, and while a label is the page's Color by, Filter by or
# Rows, thimble.color_value gives each record the label's value on it. A record is keyed by its line,
# transcript.jsonl#L<n>, as the labels key it.
#
# Places: a record on a line (L<n>). Units: a window of time (<from>..<to>).
import bisect
import json
import re
from datetime import datetime, timezone

import thimble

TEXT_MAX = 400  # characters of a record's text a list row gets
EXCERPT_RECORDS = 10  # records whose text a unit's excerpt quotes
VERBS = {"view_tool": "view", "create_tool": "create", "str_replace_tool": "edit"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _epoch(s):
    """Whole seconds since 1970 from an ISO 8601 time, a time without an offset read as UTC, or None."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp())


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M")


def _when(epoch):
    d = datetime.fromtimestamp(epoch, timezone.utc)
    return f"{MONTHS[d.month - 1]} {d.day} {d:%H:%M}"


def _clean(s):
    return " ".join(str(s or "").replace("<thinking>", " ").replace("</thinking>", " ").split())


def _reasoning(content):
    return re.sub(r"</?thinking>\n?", "", content or "").strip()


def _lines(path, offs):
    """(line number, text) of every line of the file, recording each line's byte offset in `offs`."""
    with open(path, "rb") as fh:
        pos = 0
        for n, raw in enumerate(fh, 1):
            offs.append(pos)
            pos += len(raw)
            yield n, raw.decode("utf-8", "replace").rstrip("\r\n")


def _kind(role, typ, content):
    if role == "System":
        return "system"
    if role == "Human":
        return "prompt"
    if typ == "ToolMessage":
        return "tool"
    return "thinking" if (content or "").lstrip().startswith("<thinking>") else "text"


def _effective(raws):
    """A time for every record: its own where it has one and keeps the run in order, else interpolated from the
    records around it. The anchors are the longest run of records whose times do not decrease; the rest (no time, or
    out of order, such as the system prompt and the compaction turns) fall between the anchors around them."""
    n = len(raws)
    present = [i for i in range(n) if raws[i] is not None]
    tails, prev = [], [-1] * n
    for i in present:
        pos = bisect.bisect_right([raws[j] for j in tails], raws[i])
        prev[i] = tails[pos - 1] if pos else -1
        if pos == len(tails):
            tails.append(i)
        else:
            tails[pos] = i
    anchors = set()
    k = tails[-1] if tails else -1
    while k != -1:
        anchors.add(k)
        k = prev[k]
    anc = sorted(anchors)
    if not anc:
        return [0] * n
    eff = [None] * n
    for i in range(n):
        if i in anchors:
            eff[i] = raws[i]
            continue
        pos = bisect.bisect_left(anc, i)
        lo = anc[pos - 1] if pos else None
        hi = anc[pos] if pos < len(anc) else None
        if lo is None:
            eff[i] = raws[hi]
        elif hi is None:
            eff[i] = raws[lo]
        else:
            eff[i] = int(raws[lo] + (i - lo) / (hi - lo) * (raws[hi] - raws[lo]))
    return eff


def build_index(paths):
    """{"files": [path], "offsets": [[byte offset of line n] per file], "rows": [{f, line, t, role, kind, tool}] in
    file order (which is time order), "by_line": {line: row}, "mark": the context-compaction flag or None, "span":
    [first, last], "problems": [{ref, why}] of the lines that do not parse}."""
    files = list(paths)
    problems, rows, raws = [], [], []
    for fi, path in enumerate([files[0]] if files else []):
        offs = []
        try:
            for n, line in _lines(path, offs):
                if not line.strip():
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    problems.append({"ref": f"{path}#L{n}", "why": "not a JSON object"})
                    continue
                if not isinstance(d, dict):
                    problems.append({"ref": f"{path}#L{n}", "why": "not a transcript record (not a JSON object)"})
                    continue
                role, typ = str(d.get("role") or ""), str(d.get("type") or "")
                content = d.get("content") if isinstance(d.get("content"), str) else ""
                rows.append({"f": fi, "line": n, "role": role, "kind": _kind(role, typ, content),
                             "tool": str(d.get("tool_name") or "")})
                raws.append(_epoch(d.get("timestamp")))
        except OSError as e:
            problems.append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
        offsets = [offs]
    if not files:
        offsets = []
    eff = _effective(raws)
    for r, t in zip(rows, eff):
        r["t"] = t
    human = [r["t"] for r in rows if r["role"] == "Human"]
    mark = {"t": sum(human) // len(human), "label": "context compaction"} if human else None
    span = [rows[0]["t"], rows[-1]["t"]] if rows else [0, 0]
    return {"files": files, "offsets": offsets, "rows": rows,
            "by_line": {r["line"]: i for i, r in enumerate(rows)},
            "mark": mark, "span": span, "problems": problems}


def _ref(index, i):
    r = index["rows"][i]
    return f"{index['files'][r['f']]}#L{r['line']}"


def _read_rows(index, idxs):
    """{row: {content, tool_call, tool_result}} for the wanted rows, read back from their lines."""
    out, by_file = {}, {}
    for i in idxs:
        by_file.setdefault(index["rows"][i]["f"], []).append(i)
    for fi, wanted in by_file.items():
        with open(index["files"][fi], "rb") as fh:
            for i in wanted:
                fh.seek(index["offsets"][fi][index["rows"][i]["line"] - 1])
                try:
                    d = json.loads(fh.readline().decode("utf-8", "replace"))
                except ValueError:
                    d = {}
                out[i] = {"content": d.get("content") if isinstance(d.get("content"), str) else "",
                          "tool_call": d.get("tool_call") if isinstance(d.get("tool_call"), dict) else None,
                          "tool_result": d.get("tool_result") if isinstance(d.get("tool_result"), str) else None}
    return out


def _snippet(row, p):
    """One line naming what the record is: a command, a file touched, or the start of the reasoning."""
    if row["kind"] == "tool":
        tc = p.get("tool_call") or {}
        if row["tool"] == "terminal":
            cmd = tc.get("text")
            return _clean(cmd) if isinstance(cmd, str) and cmd.strip() else "(read terminal output)"
        if row["tool"] in VERBS:
            return f"{VERBS[row['tool']]} {tc.get('path') or ''}".strip()
        return row["tool"] or "(tool)"
    return _clean(p.get("content"))


def _search_text(row, p):
    parts = [row["role"], row["kind"], row["tool"], p.get("content") or ""]
    tc = p.get("tool_call") or {}
    parts += [v for k in ("text", "path", "old_str", "new_str", "file_text") if isinstance((v := tc.get(k)), str)]
    if isinstance(p.get("tool_result"), str):
        parts.append(p["tool_result"])
    return " ".join(parts)


def _overview(index, query, keep):
    """The records the page shows, as columns: `r` the row, `t` its time, `ref`, `role`, `kind`, `tool`, `text` cut to
    TEXT_MAX, `value` its Color by value and `group` its Rows group. The rows the label filter keeps whose text holds
    the words `q`, and those in `keep` (a citation) whatever the filters. `counts` is Color by's values over the rows
    Filter by keeps; `fcounts` Filter by's over every row. `span` and `mark` carry the axis's whole span and the
    context-compaction flag."""
    rows = index["rows"]
    choice, only, group_by = query.get("color"), query.get("filter"), query.get("rows")
    q = str(query.get("q") or "").strip().lower()
    parsed = _read_rows(index, range(len(rows)))
    cols = {k: [] for k in ("r", "t", "ref", "role", "kind", "tool", "text", "value", "group")}
    counts, fcounts = {}, {}
    for i, row in enumerate(rows):
        ref, p = _ref(index, i), parsed.get(i, {})
        asked = i in keep
        if not asked and q and q not in _search_text(row, p).lower():
            continue
        if not asked and not thimble.kept(ref):
            continue
        rec = {"ref": ref, "role": row["role"], "kind": row["kind"], "tool": row["tool"]}
        value = thimble.color_value(choice, ref, rec)
        shown = thimble.color_value(only, ref, rec)
        shows = thimble.color_on(only, shown)
        fcounts[shown or ""] = fcounts.get(shown or "", 0) + 1
        if shows:
            counts[value or ""] = counts.get(value or "", 0) + 1
        if not shows and not asked:
            continue
        for k, v in zip(cols, (i, row["t"], ref, row["role"], row["kind"], row["tool"],
                               _snippet(row, p)[:TEXT_MAX], value, thimble.color_value(group_by, ref, rec))):
            cols[k].append(v)
    return {"cols": cols, "counts": counts, "fcounts": fcounts, "next": None,
            "span": index["span"], "mark": index["mark"]}


def _record(index, i):
    """One record in full: its reasoning or its tool call and result, and its line as the file holds it."""
    rows = index["rows"]
    if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(rows):
        return None
    row, p = rows[i], _read_rows(index, [i]).get(i, {})
    with open(index["files"][row["f"]], "rb") as fh:
        fh.seek(index["offsets"][row["f"]][row["line"] - 1])
        raw = fh.readline().decode("utf-8", "replace").rstrip("\r\n")
    return {"r": i, "ref": _ref(index, i), "t": row["t"], "role": row["role"], "kind": row["kind"],
            "tool": row["tool"], "reasoning": _reasoning(p.get("content")), "call": p.get("tool_call"),
            "result": p.get("tool_result"), "raw": raw}


def records(index, query):
    """{op: overview, color?, filter?, rows?, q?, keep?}: the records the page shows (_overview).
    {op: record, r}: one record in full (_record). `keep` rows are kept whatever the label filter."""
    query = query or {}
    keep = {x for x in query.get("keep") or () if isinstance(x, int) and not isinstance(x, bool)}
    if query.get("op") == "record":
        return _record(index, query.get("r"))
    return _overview(index, query, keep)


def _row_at(index, n):
    """The row on line n, or the nearest row (the next, else the last before it)."""
    rows = index["rows"]
    if not rows:
        return None
    if n in index["by_line"]:
        return index["by_line"][n]
    lines = [r["line"] for r in rows]
    k = bisect.bisect_left(lines, n)
    return min(k, len(rows) - 1)


def _excerpt(index, i):
    p = _read_rows(index, [i]).get(i, {})
    row = index["rows"][i]
    if row["kind"] == "tool":
        tc = p.get("tool_call") or {}
        bits = [str(tc.get("text") or ""), str(tc.get("path") or ""), str(p.get("tool_result") or "")]
        return "\n".join(b for b in bits if b.strip()) or _snippet(row, p)
    return _reasoning(p.get("content")) or _snippet(row, p)


def resolve(index, locator):
    """<file>#L<n>: the record on that line, or the nearest one. view:<slug>/<from>..<to>: the records between two
    UTC times, zoomed to them."""
    rows = index["rows"]
    if "key" in locator:
        key = str(locator["key"])
        m = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d)\.\.(\d{4}-\d\d-\d\dT\d\d:\d\d)", key)
        if not m or (a := _epoch(m.group(1))) is None or (b := _epoch(m.group(2))) is None or b <= a:
            return None
        found = [i for i, r in enumerate(rows) if a <= r["t"] < b]
        if not found:
            return None
        span = f"{_when(a)} to {_when(b)[-5:]}" if _when(a)[:-5] == _when(b)[:-5] else f"{_when(a)} to {_when(b)}"
        lines = [_excerpt(index, i) for i in found[:EXCERPT_RECORDS]]
        return {"excerpt": "\n".join(x for x in lines if x), "label": f"{span} · {len(found)} records",
                "refs": [_ref(index, i) for i in found], "key": key, "target": {"from": _iso(a), "to": _iso(b)}}
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    if path not in index["files"]:
        return None
    m = re.fullmatch(r"L(\d+)", fragment)
    if not m:
        return None
    i = _row_at(index, int(m.group(1)))
    if i is None:
        return None
    row = index["rows"][i]
    label = f"{row['role']} · {row['kind']}" + (f" · {row['tool']}" if row["tool"] else "")
    return {"excerpt": _excerpt(index, i), "label": f"{label} · {_when(row['t'])[-5:]}",
            "refs": [_ref(index, i)], "key": None, "target": {"r": i}}


def derived(index):
    return [{"record": "message", "field": "time", "from": "the record's timestamp", "kind": "computed",
             "how": "read in UTC; a record with no timestamp or one out of sequence (the system prompt and the "
                    "context-compaction turns carry the export time) takes a time interpolated from the records around it"}]


def problems(index):
    return index["problems"]
