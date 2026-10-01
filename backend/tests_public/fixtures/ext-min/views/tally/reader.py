import glob
import json


def build_index(paths):
    rows = []
    for p in sorted(paths or glob.glob("tally/*.jsonl")):
        with open(p, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                if line.strip():
                    rows.append({**json.loads(line), "ref": f"{p}#L{n}"})
    return rows


def records(index, query):
    return {"rows": index}


def resolve(index, locator):
    for r in index:
        if r["ref"].endswith(f"#{locator}"):
            return {"excerpt": r.get("what", ""), "label": r.get("who", ""), "refs": [r["ref"]]}
    return None
