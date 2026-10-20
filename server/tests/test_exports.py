"""The report exported (exports.py): Markdown with footnotes, and one standalone HTML page with its figures drawn as
pictures or tables and its citations as numbered notes in plain text."""
import base64

from browser_client import Signed

from thimble_browser import canvas, report
from thimble_browser.cards import frames

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 60).decode()


def setup(api):
    frame = frames.normalize({"columns": ["run", "outcome"], "rows": [["a", "merged"], ["b", "failed"]],
                              "types": ["nominal", "nominal"], "label": "run"})
    table = canvas.new_card(api.ws, {"kind": "table", "question": "Which runs failed?", "code": "x"}, by="main")
    canvas.set_run(api.ws, table["id"], status="ok", outputs=[{frames.FRAME_MIME: frame, "text/plain": "a merged"}])
    chart = canvas.new_card(api.ws, {"kind": "plot", "question": "Runs by outcome", "code": "x"}, by="main")
    canvas.set_run(api.ws, chart["id"], status="ok", outputs=[{"application/vnd.vegalite.v6.json": {
        "datasets": {"d1": [{"outcome": "merged", "runs": 1}, {"outcome": "failed", "runs": 1}]}}}])
    report.save(api.ws, f"# Half the runs failed\n\nThe folder has [2 runs](results.csv#row=1) and one "
                        f"[failed](runs/a.jsonl#L2). See [↗](card:{table['id']}).\n\n## Figures\n\n"
                        f"![Runs by outcome](card:{chart['id']})\n\n![The runs](card:{table['id']})\n", by="chat:w1")
    return table, chart


def test_the_formats(folder):
    api = Signed(folder)
    assert api("GET", "/ws/{ws}/investigations/main/types/report/exports").json() == {"formats": []}
    setup(api)
    ids = [f["id"] for f in api("GET", "/ws/{ws}/investigations/main/types/report/exports").json()["formats"]]
    assert ids == ["markdown", "html", "pdf"]


def test_markdown_has_footnotes_and_tables(folder):
    api = Signed(folder)
    setup(api)
    r = api("GET", "/ws/{ws}/investigations/main/types/report/export/markdown")
    assert r.status_code == 200 and r.headers["x-export-name"] == "Half-the-runs-failed.md"
    md = r.text
    assert md.startswith("# Half the runs failed\n")
    assert "The folder has 2 runs[^1] and one failed[^2]." in md
    assert "[^1]: results.csv, row 1" in md and "[^2]: runs/a.jsonl, line 2" in md
    assert "| outcome | runs |" in md and "| run | outcome |" in md
    assert "card:" not in md.split("---")[0]  # the text links nowhere; the notes name what is cited


def test_html_is_one_page_with_pictures_tables_and_notes(folder):
    api = Signed(folder)
    table, chart = setup(api)
    page = api("GET", "/ws/{ws}/investigations/main/types/report/export/html").text
    assert page.startswith("<!doctype html>") and "<script" not in page
    assert '2 runs<sup class="cite"><a href="#note-1">1</a></sup>' in page
    assert '<li id="note-2"><span class="ref">runs/a.jsonl, line 2</span>' in page
    assert "<td>merged</td>" in page and "<td>failed</td>" in page
    # the page's pictures stand in for the figures; anything but a PNG is refused
    pics = {chart["id"]: PNG, table["id"]: "data:text/html;base64,PHNjcmlwdD4="}
    page = api("POST", "/ws/{ws}/investigations/main/types/report/export/html", json={"pictures": pics}).text
    assert f'src="{PNG}"' in page and "text/html" not in page
    assert api("GET", "/ws/{ws}/investigations/main/types/report/export/docx").status_code == 404
