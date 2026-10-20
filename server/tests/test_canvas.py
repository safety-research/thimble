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


def test_the_report_reads_as_sections_of_cited_sentences(folder):
    from thimble_browser import report

    ws = home.open_folder(folder)
    doc = report.save(ws, "# Most runs merged\n\nThe folder has [2](results.csv#row=1) runs. One failed.\n\n"
                          "## Why\n\n- it edited [the wrong file](runs/a.jsonl#L1)\n\n![Runs by outcome](card:ab12cd34)\n",
                      by="chat:w1")
    assert doc["title"] == "Most runs merged"
    first = doc["sections"][0]["paragraphs"][0]["sentences"]
    assert [s["text"] for s in first] == ["The folder has [[2|results.csv#row=1]] runs.", "One failed."]
    assert first[0]["refs"] == ["results.csv#row=1"]
    why = doc["sections"][1]
    assert why["paragraphs"][0]["sentences"][0]["bullet"] == "-"
    assert why["figures"][0]["cell"] == "ab12cd34"
    blocks = [{"id": "a", "type": "heading", "text": "Why", "level": 2},
              {"id": "b", "type": "paragraph", "text": "Edited by hand [[runs/a.jsonl#L2]]."}]
    again = report.from_blocks(ws, "Most runs merged", blocks)
    assert again["sections"][0]["paragraphs"][0]["sentences"][0]["refs"] == ["runs/a.jsonl#L2"]
