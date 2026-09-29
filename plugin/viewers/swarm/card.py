# Swarm as a card type (view.json `card`): card() is the chart one card draws, listing() the lines main reads and cites.
# thimble.card sets `reader` (this folder's reader.py) before each call and runs card() with the labels the call names as
# the labels that are on, so they colour the records; `within`, `accounts` and `places` choose them, and without them the
# records those labels mark are the cards, as in the view.
import thimble

reader = None


def _within(spec):
    """The refs of the records the label `spec["label"]` gave `spec["value"]`, its first value when none is given."""
    if "value" not in spec:
        return sorted(str(r) for r in thimble.labels(spec["label"])["ref"])
    rows = thimble.labels(spec["label"], negatives=True)
    return sorted(str(r) for r in rows.loc[rows["effective"] == spec["value"], "ref"])


def card(index, within=None, rows="account", accounts=None, places=None, links=None, edges=None, only=None):
    query = {"op": "chart", "accounts": accounts, "places": places, "links": links, "edges": edges, "only": only}
    if within:
        query["within"] = _within(within)
    data = reader._chart(index, query)
    data["rows_by"] = "sig" if rows == "signature" else "account"
    return data


def _n(n, one, many=None):
    return f"{n:,} {one if n == 1 else many or one + 's'}"


def listing(data):
    """The card's numbers, then one line per card shown, each ending in its record's ref."""
    shown = len(data["cards"])
    span = f"cards {data['offset'] + 1}–{data['offset'] + shown} shown" if shown else "no card shown"
    out = [f"swarm: {_n(data['total'], 'record')} by {_n(data['accounts_total'], 'account')} on "
           f"{_n(data['places_total'], 'place')}; {span}"]
    by_label = {}
    for m, n in zip(data["marks"], data["mark_counts"]):
        by_label.setdefault(m["label"], []).append(f"{m['value']} {n:,}")
    for label, parts in by_label.items():
        out.append(f"{label}: {', '.join(parts)}")
    if data["marks"] and data.get("unmarked"):
        out.append(f"no highlighted value: {data['unmarked']:,}")
    kinds = {}
    for x in data["links"]:
        kinds[x["type"]] = kinds.get(x["type"], 0) + 1
    if kinds:
        out.append("links between the cards shown: " + ", ".join(f"{k} {n}" for k, n in kinds.items()))
    by_id = {c["id"]: c for c in data["cards"]}
    pairs = {}
    for x in data["links"]:
        key = (by_id[x["from"]]["account"], by_id[x["to"]]["account"])
        pairs[key] = pairs.get(key, 0) + 1
    if pairs:
        (a, b), n = max(pairs.items(), key=lambda kv: kv[1])
        out.append(f"most links from one account to another: {a} → {b}, {_n(n, 'link')}")
    tags = {p["name"]: p["tag"] for p in data["places"]}
    for c in data["cards"]:
        value = f" [{data['marks'][c['m']]['value']}]" if c["m"] >= 0 else ""
        when = c["time"].replace("T", " ")[:16] if c["time"] else "time unknown"
        out.append(f"#{c['id']} {when} {c['account']} {tags.get(c['place'], '')} {c['place']}{value}: {c['line']} {c['ref']}")
    return out
