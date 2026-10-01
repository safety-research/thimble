"""The labels task as a vote: thimble's own labels task runs once per model (thimble.default), and each item takes the
value most models gave it, with the share of models that gave it as its confidence."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import thimble

MODELS = ("opus", "sonnet", "haiku")


def labels_of(input, model):
    try:
        return {x["i"]: x for x in thimble.default(input, model=model)["labels"]}
    except thimble.ThimbleError as e:
        thimble.log(f"{model} gave no labels: {e}")
        return {}


def run(input):
    with ThreadPoolExecutor(len(MODELS)) as pool:
        votes = [v for v in pool.map(lambda m: labels_of(input, m), MODELS) if v]
    if not votes:
        raise RuntimeError("no model gave labels")
    labels = []
    for item in input["items"]:
        picks = [v[item["i"]] for v in votes if item["i"] in v]
        if not picks:
            continue
        value, n = Counter(p["label"] for p in picks).most_common(1)[0]
        first = next(p for p in picks if p["label"] == value)
        labels.append({**first, "label": value, "confidence": n / len(MODELS)})
    return {"labels": labels}


thimble.serve(run)
