# Swarm as a card type (view.json `card`): card() is the chart one card draws, listing() the lines main reads and cites.
# thimble.card sets `reader` (this folder's reader.py) before each call and runs card() with the labels the call names as
# the labels that are on, so they colour the records; `within`, `accounts` and `places` choose them, and without them the
# records those labels mark are the cards, as in the view. A value `only` names marks its records even when it is the
# label's negative one. A card shows the records most linked to each other (reader._most_linked), with the links among
# all the records it chose counted in its listing.
import thimble

reader = None


def _lit(only):
    """Every value `only` names marks its records in this call's labels."""
    named = {(x.get("label"), x.get("value")) for x in only or () if isinstance(x, dict)}
    for k in (thimble._view_ctx or {}).get("labels") or ():
        for v in k.get("values") or ():
            if (k.get("name"), v.get("name")) in named:
                v["highlight"] = True


def card(index, within=None, rows="account", accounts=None, places=None, links=None, edges=None, only=None):
    _lit(only)
    query = {"op": "chart", "within": within, "accounts": accounts, "places": places, "links": links, "edges": edges,
             "only": only, "pick": "linked"}
    data = reader._chart(index, query)
    data["rows_by"] = "sig" if rows == "signature" else "account"
    return data


def _n(n, one, many=None):
    return f"{n:,} {one if n == 1 else many or one + 's'}"


def listing(data):
    """The card's numbers, then one line per card shown, each ending in its record's ref."""
    shown = len(data["cards"])
    span = ("no card shown" if not shown else f"all {shown} shown" if data.get("shown") != "linked"
            else f"the {shown} most linked to each other shown")
    out = [f"swarm: {_n(data['total'], 'record')} by {_n(data['accounts_total'], 'account')} on "
           f"{_n(data['places_total'], 'place')}; {span}"]
    only = {(x["label"], x["value"]) for x in data.get("only") or ()}
    by_label = {}
    for m, n in zip(data["marks"], data["mark_counts"]):
        if not only or (m["label"], m["value"]) in only:
            by_label.setdefault(m["label"], []).append(f"{m['value']} {n:,}")
    for label, parts in by_label.items():
        out.append(f"{label}: {', '.join(parts)}")
    if data["marks"] and data.get("unmarked"):
        out.append(f"no highlighted value: {data['unmarked']:,}")
    reach = data.get("reach") or {}
    if reach.get("counts"):
        out.append(f"links among all {_n(data['total'], 'record')}: " + ", ".join(f"{k} {n:,}" for k, n in reach["counts"].items()))
    for p in reach.get("pairs") or ():
        out.append(f"links from {p['from']} to {p['to']}: {p['n']:,}")
    kinds = {}
    for x in data["links"]:
        kinds[x["type"]] = kinds.get(x["type"], 0) + 1
    if kinds:
        out.append("links between the cards shown: " + ", ".join(f"{k} {n}" for k, n in kinds.items()))
    tags = {p["name"]: p["tag"] for p in data["places"]}
    for c in data["cards"]:
        value = f" [{data['marks'][c['m']]['value']}]" if c["m"] >= 0 else ""
        when = c["time"].replace("T", " ")[:16] if c["time"] else "time unknown"
        out.append(f"#{c['id']} {when} {c['account']} {tags.get(c['place'], '')} {c['place']}{value}: {c['line']} {c['ref']}")
    return out
