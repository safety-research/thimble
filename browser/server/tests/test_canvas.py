"""Cards: citations written as Markdown links, as in the terminal, are kept in the canvas's own form (canvas.py)."""
import pytest

from thimble_browser import canvas, home


def test_citation_links_become_canvas_links():
    t = canvas.to_canvas_links(
        "[5](card:ab12cd34#failed runs/wrong-file) of 11, [↗](runs/a.jsonl#L4), [docs](https://example.org/a)")
    assert t == "[[5|card:ab12cd34#failed runs/wrong-file]] of 11, [[runs/a.jsonl#L4]], [docs](https://example.org/a)"


def test_a_card_is_stored_and_found(folder):
    ws = home.open_folder(folder)
    cell = canvas.new_card(ws, {"kind": "note", "question": "What is here?", "text": "Two runs [↗](runs/a.jsonl#L1)",
                                "takeaway": "[2](results.csv#row=1) runs"})
    assert canvas.find(ws, f"card:{cell['id']}")[1]["text"] == "Two runs [[runs/a.jsonl#L1]]"
    assert canvas.canvas(ws)["cells"][0]["takeaway"] == "[[2|results.csv#row=1]] runs"
    with pytest.raises(ValueError):
        canvas.new_card(ws, {"kind": "table", "question": "No code?"})
