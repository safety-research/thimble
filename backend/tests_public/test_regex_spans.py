"""A regex label keeps each match whole on a record's row as `spans`, which the reader finds in the record to highlight,
so a match longer than the rationale's 200 characters and one holding non-ASCII letters mark all their words.

The corpus is invented: calls/call-01.md, a markdown transcript whose speaker's name has non-ASCII letters and whose
one long turn mentions submitting past its 300th character."""
from __future__ import annotations

import json
import re
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import concept_scan, concepts, config

CORPUS = "spans"
PATH = "calls/call-01.md"
PATTERN = r"^\*\*Renée Østergård[^*]*\*\*.*\b[Ss]ubmit"
LONG_TURN = ("**Renée Østergård:** so what I would suggest is that you gather the receipts from the trip on your own "
             "first, scan whichever ones are still readable, write down the amount and the date of each of them, and "
             "take as long as you need on each one, since there is no right order and nothing you enter here is final "
             "yet; once you are done with your own list, please submit the claim with the button in the "
             "upper right, which starts the review.")
LINES = ["# Call 1", "", "**Renée Østergård:** Thanks for calling.", "", LONG_TURN, "", "**Caller:** Sounds good."]
MATCH = re.search(PATTERN, LONG_TURN).group(0)


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    data = tmp_path / "data"
    root = data / CORPUS
    (root / "calls").mkdir(parents=True)
    (root / PATH).write_text("\n".join(LINES) + "\n", encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
                  concepts._building_answers):
        table.clear()
    return root


@pytest.fixture()
async def api(corpus):
    app = FastAPI()
    app.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


def test_matched_texts_are_whole_however_long():
    text = "Zoë said " + "a" * 500 + " end"
    assert concept_scan.matched_texts(re.compile(r"Zoë said a+ end"), text) == [text]


async def test_a_record_label_s_row_holds_the_whole_match_and_its_example_the_match_s_start(api):
    assert len(MATCH) > concept_scan.RATIONALE_MAX and MATCH.endswith("please submit")
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "agent asks to submit", "kind": "regex", "spec": PATTERN,
                                                         "labels": ["asks to submit", "other"], "unit": "record", "marks": "record"})
    assert r.status_code == 200, r.text
    k = r.json()
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["calls/*.md"]})
    assert r.status_code == 200, r.text
    rows = {x["ref"]: x for x in concepts.read_labels(config.workspace_dir(CORPUS), k["id"])}
    hit = rows[f"{PATH}#L5"]
    assert hit["label"] == "asks to submit" and hit["spans"] == [MATCH]
    assert hit["rationale"] == MATCH[:concept_scan.RATIONALE_MAX]
    page = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}/rows", params={"value": "asks to submit", "text": 1})).json()["rows"]
    assert page[0]["match"] == MATCH[:concepts.MATCH_WINDOW] and page[0]["text"].startswith(page[0]["match"])
