import json
import time
from collections import Counter

KIND_KEYS = ("type", "kind", "action")


def build_index(paths):
    """{path: {"lines", "bad", "kinds": [[kind, n], ...]}} for every claimed file: the numbers of its lines that parse
    as JSON and of those that do not."""
    index = {}
    for path in sorted(paths):
        lines, bad, kinds = [], [], Counter()
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    bad.append(n)
                    continue
                lines.append(n)
                if isinstance(r, dict):
                    kind = next((r[k] for k in KIND_KEYS if isinstance(r.get(k), str)), None)
                    if kind:
                        kinds[kind] += 1
        index[path] = {"lines": lines, "bad": bad, "kinds": kinds.most_common(5)}
    return index


def records(index, query):
    """One row per file: {key, path, records, bad, kinds}; {"sleep": seconds} first waits that long, as a heavy call
    would."""
    if isinstance(query, dict) and isinstance(query.get("sleep"), (int, float)):
        time.sleep(query["sleep"])
    return [{"key": p, "path": p, "records": len(e["lines"]), "bad": len(e["bad"]), "kinds": e["kinds"]}
            for p, e in index.items()]


def _words(path, n):
    """The longest string of the record on line `n`, word for word."""
    with open(path, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f, 1):
            if i == n:
                r = json.loads(line)
                found = [v for v in (r.values() if isinstance(r, dict) else [r]) if isinstance(v, str)]
                return max(found, key=len) if found else str(r)
    return ""


def resolve(index, locator):
    """A file's row: for its unit (the file's path as its key) every record of the file, with the first as the excerpt;
    for a line, that record."""
    path = locator.get("key") or locator.get("path")
    e = index.get(path)
    if e is None or not e["lines"]:
        return None
    if "key" in locator:
        lines = e["lines"]
    else:
        frag = str(locator.get("fragment") or "")
        n = int(frag[1:]) if frag[:1] == "L" and frag[1:].isdigit() else 0
        if n not in e["lines"]:
            return None
        lines = [n]
    return {"excerpt": _words(path, lines[0]), "label": path, "refs": [f"{path}#L{n}" for n in lines], "key": path,
            "target": {"path": path}}


def problems(index):
    return [{"ref": f"{p}#L{n}", "why": "not JSON"} for p, e in index.items() for n in e["bad"]]
