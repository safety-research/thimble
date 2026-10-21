"""The browser's citation healing pass (cards/heal.py): re-point, unwrap to quiet, contradicted, and the version."""
from thimble_browser.cards import frames, heal as H


def table(rows):
    return [{**frames.bundle(frames.normalize({"columns": ["outcome", "n"], "rows": rows})), "_out": 0}]


CARDS = {
    "aaaaaa": {"id": "aaaaaa", "outputs": table([["merged", 31], ["closed", 9], ["open", 4]])},
    "bbbbbb": {"id": "bbbbbb", "outputs": table([["wren", 77], ["kestrel", 12]])},
}


def load(cid):
    return CARDS.get(cid)


def one(text):
    r = H.heal(text, load)
    return r, r["changes"][0]


def test_kept_repointed_contradicted_and_quiet():
    rows = frames.row_labels(frames.frame_in(CARDS["aaaaaa"]["outputs"]))
    merged = f"card:aaaaaa#n/{rows[0]}"
    _, c = one(f"[31]({merged}) merged")
    assert c["how"] == H.KEPT
    # 31 cited at the closed row: the only cell that shows 31 is merged's
    r, c = one(f"[31](card:aaaaaa#n/{rows[1]}) merged")
    assert c["how"] == H.CELL and c["to"] == merged and merged in r["text"]
    # 77 cited in the first card: another card the text cites shows it
    _, c = one(f"[77](card:aaaaaa#n/{rows[0]}) edits, see [the table](card:bbbbbb)")
    assert c["how"] == H.CITED and c["to"].startswith("card:bbbbbb#n/")
    # 30 shown nowhere, the cited cell shows 31: contradicted, the words and the link stay
    r, c = one(f"[30]({merged}) merged")
    assert c["state"] == H.CONTRADICTED and c["why"] == "the cited place shows 31" and r["text"] == f"[30]({merged}) merged"
    # a card that is gone: quiet
    _, c = one("[5](card:zzzzzz#n/0) runs")
    assert c["state"] == H.QUIET and c["how"] == H.GONE


def test_a_ref_with_brackets_reads_whole():
    """A row named "(no name)" is cited whole: the canvas writes one token for it, and the pass finds its value there."""
    from thimble_browser.canvas import to_canvas_links
    from thimble_browser.features.citations import bare_ref
    CARDS["cccccc"] = {"id": "cccccc", "outputs": table([["wren", 77], ["(no name)", 899]])}
    try:
        ref = "card:cccccc#n/(no name)"
        text = f"[899]({ref}) edits had no name"
        assert to_canvas_links(text) == f"[[899|{ref}]] edits had no name"
        r, c = one(text)
        assert c["ref"] == ref and c["how"] == H.KEPT and r["text"] == text
        assert bare_ref(f"[{ref}]") == bare_ref(ref) == ref
    finally:
        del CARDS["cccccc"]

def test_version_is_stable_and_follows_the_outputs():
    rows = frames.row_labels(frames.frame_in(CARDS["aaaaaa"]["outputs"]))
    text = f"[31](card:aaaaaa#n/{rows[1]}) merged"
    r = H.heal(text, load)
    assert r["of"] == H.version(text, load) and r["version"] == H.version(r["text"], load)
    again = H.heal(r["text"], load)
    assert again["text"] == r["text"] and all(c["how"] == H.KEPT for c in again["changes"])
    was = H.version(text, load)
    CARDS["aaaaaa"]["outputs"] = table([["merged", 32], ["closed", 9], ["open", 4]])
    try:
        assert H.version(text, load) != was
    finally:
        CARDS["aaaaaa"]["outputs"] = table([["merged", 31], ["closed", 9], ["open", 4]])


def test_the_page_asks_the_server_to_heal_an_answer(folder):
    from browser_client import Signed
    from thimble_browser import canvas

    api = Signed(folder)
    c = canvas.new_card(api.ws, {"kind": "table", "question": "Runs by outcome", "code": "df"})
    canvas.set_run(api.ws, c["id"], status="ok", outputs=table([["failed", 1], ["merged", 2]]))
    r = api("POST", "/corpora/{ws}/heal", json={"text": f"[2](card:{c['id']}#n/failed) merged, [5](card:zzzzzz#n/0) runs"})
    assert r.status_code == 200, r.text
    got = r.json()
    assert [(x["state"], x["how"]) for x in got["changes"]] == [("linked", "cell"), ("quiet", "gone")]
    assert f"[2](card:{c['id']}#n/merged)" in got["text"]


def test_a_missing_part_of_a_drawn_card_is_quiet_with_a_plain_reason():
    """A program card's parts are cited by id; a citation written as a column and a row names a part it never drew."""
    CARDS["dddddd"] = {"id": "dddddd", "kind": "program",
                       "outputs": [{"application/vnd.thimble.kit+json": {"drawing": {"regions": [{"id": "page-a"}]}}}]}
    try:
        _, c = one("[456](card:dddddd#page/dse/StartSeite) edits")
        assert c["state"] == H.QUIET and c["why"] == "the card draws no part page/dse/StartSeite"
    finally:
        del CARDS["dddddd"]
