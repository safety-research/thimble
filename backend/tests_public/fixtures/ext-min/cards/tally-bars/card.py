reader = None


def card(index, who):
    return {"who": who, "records": [r["ref"] for r in index if r.get("who") == who]}


def listing(data):
    return [f"{data['who']}: {len(data['records'])} records"] + data["records"]
