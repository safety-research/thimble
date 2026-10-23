reader = None


def card(index, who=None):
    counts = {}
    for r in index:
        if not who or r.get("who") in who:
            counts[r.get("who")] = counts.get(r.get("who"), 0) + 1
    return {"counts": counts}


def listing(data):
    return [f"{k}: {v}" for k, v in sorted(data["counts"].items())]
