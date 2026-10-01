import json
from collections import Counter

KIND_KEYS = ("type", "kind", "action")


def build_index(paths):
    """{path: {"records", "bad", "kinds": [[kind, n], ...]}} for every claimed file."""
    index = {}
    for path in sorted(paths):
        records, bad, kinds = 0, 0, Counter()
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    bad += 1
                    continue
                records += 1
                if isinstance(r, dict):
                    kind = next((r[k] for k in KIND_KEYS if isinstance(r.get(k), str)), None)
                    if kind:
                        kinds[kind] += 1
        index[path] = {"records": records, "bad": bad, "kinds": kinds.most_common(5)}
    return index


def records(index, query):
    """One row per file: {ref, path, records, bad, kinds}."""
    return [{"ref": p, "path": p, **e} for p, e in index.items()]


def resolve(index, locator):
    path = locator.get("path")
    e = index.get(path)
    if e is None or "key" in locator:
        return None
    kinds = ", ".join(f"{k} {n}" for k, n in e["kinds"]) or "no kinds"
    return {"excerpt": f"{e['records']} records, {e['bad']} lines not JSON; {kinds}", "label": path, "refs": [path],
            "target": {"path": path}}


def problems(index):
    return [{"ref": p, "why": f"{e['bad']} lines are not JSON"} for p, e in index.items() if e["bad"]]
