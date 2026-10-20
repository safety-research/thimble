"""A citation of one value of a card, `card:<id>#<column>/<row>`, opens that value in its table, from a table or a
chart, and keeps pointing at what it cited after the card is edited (canvas.resolve_card_ref, cards/cite.py)."""
from browser_client import Signed

from thimble_browser import canvas
from thimble_browser.cards import frames


def table(rows):
    return [{**frames.bundle(frames.normalize({"columns": ["outcome", "n"], "rows": rows})), "_out": 0}]


def chart(rows):
    spec = {"data": {"name": "data-1"}, "mark": "bar", "encoding": {"x": {"field": "outcome"}, "y": {"field": "n"}},
            "datasets": {"data-1": [{"outcome": o, "n": n} for o, n in rows]}}
    return [{"application/vnd.vegalite.v6.json": spec, "text/plain": "<VegaLite 6 object>", "_out": 0}]


def card(api, kind, outputs, code="df"):
    c = canvas.new_card(api.ws, {"kind": kind, "question": "Runs by outcome", "code": code})
    canvas.set_run(api.ws, c["id"], status="ok", outputs=outputs)
    return c


def resolve(api, ref, value=None):
    params = {"ref": ref, **({"value": value} if value is not None else {})}
    r = api("GET", "/corpora/{ws}/ref", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_a_cited_value_opens_in_its_table(folder):
    api = Signed(folder)
    c = card(api, "table", table([["failed", 1], ["merged", 2]]))
    got = resolve(api, f"card:{c['id']}#n/merged")
    assert got["kind"] == "value" and got["meta"]["value"] == "2"
    assert "<th>merged</th><td>2</td>" in got["meta"]["table_html"]
    assert got["meta"]["span"] == {"col": "n", "row": "merged"} and "version" not in got["meta"]


def test_a_citation_keeps_its_value_after_the_card_is_edited(folder):
    api = Signed(folder)
    c = card(api, "table", table([["failed", 1], ["merged", 2]]), code="v1")
    ref = f"card:{c['id']}#n/merged"
    # the code changes, and the row it cited is gone: the citation reads the card as it stood before that edit
    canvas.update_card(api.ws, c["id"], {"code": "v2"}, by="analyst")
    canvas.set_run(api.ws, c["id"], status="ok", outputs=table([["failed", 1], ["landed", 2]]))
    got = resolve(api, ref, "2")
    assert got["meta"]["value"] == "2" and "<th>merged</th>" in got["meta"]["table_html"]
    assert got["meta"]["version"]["entry"] == canvas.find(api.ws, c["id"])[1]["edited"][-1]["id"]
    # the row is back with another value: a citation whose words state the old value reads the old one, and a
    # citation that states the new value, or none, reads the card as it stands
    canvas.update_card(api.ws, c["id"], {"code": "v3"}, by="analyst")
    canvas.set_run(api.ws, c["id"], status="ok", outputs=table([["failed", 1], ["merged", 3]]))
    assert resolve(api, ref, "2")["meta"]["value"] == "2"
    assert resolve(api, ref, "3")["meta"]["value"] == "3" and "version" not in resolve(api, ref, "3")["meta"]
    assert resolve(api, ref)["meta"]["value"] == "3"
    # a cell no version holds stays the card itself
    assert resolve(api, f"card:{c['id']}#n/never")["kind"] == "cell"
