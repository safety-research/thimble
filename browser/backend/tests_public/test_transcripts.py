"""PDFs as themselves: the PDF route serves a corpus's PDF to the browser's viewer, and a citation of a PDF's page
resolves to that page's text."""
import shutil

import pytest
from fastapi.testclient import TestClient

from app.main import app
from mini_corpus import tiny_pdf

client = TestClient(app)
DOCS = "/api/corpora/docs"


@pytest.fixture()
def docs(tmp_path, monkeypatch, mini_dir):
    """A DATA_DIR whose corpus `docs` (a copy of mini) holds a PDF of three pages and one that does not open."""
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "docs")
    root = data / "docs"
    (root / "postmortem.pdf").write_bytes(tiny_pdf(["Timeline of the failures", "Root cause in reindex", "The fix"]))
    (root / "broken.pdf").write_bytes(b"%PDF-1.4\n1 0 obj\n")
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return root


def test_a_pdf_opens_in_the_browser_s_viewer_and_a_citation_of_its_page_resolves_to_the_page_s_text(docs):
    r = client.get(f"{DOCS}/pdf/postmortem.pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content == (docs / "postmortem.pdf").read_bytes()
    assert client.get(f"{DOCS}/pdf/..%2F..%2Fetc%2Fx.pdf").status_code == 400

    def ref(r):
        got = client.get(f"{DOCS}/ref", params={"ref": r})
        assert got.status_code == 200, got.text
        return got.json()

    page = ref("postmortem.pdf#p2")
    assert page["excerpt"] == "Root cause in reindex" and page["meta"]["page"] == 2 and page["meta"]["pages"] == 3
    assert ref("postmortem.pdf#p2-p3")["excerpt"] == "Root cause in reindex\n\nThe fix"
    gone = client.get(f"{DOCS}/ref", params={"ref": "postmortem.pdf#p9"})
    assert gone.status_code == 404, "a page past the last is a broken citation"
    assert ref("broken.pdf#p1")["meta"]["error"]
