"""The tour's offer (app/tour.py): unseen until the person answers it, then recorded in this server's home, and an answer
given in a page of any of thimble's homes on this machine counts here too. Each test's homes are its own (conftest)."""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import tour


def client() -> TestClient:
    app = FastAPI()
    app.include_router(tour.router)
    return TestClient(app)


def test_the_offer_is_unseen_until_answered_then_recorded_in_this_home():
    c = client()
    assert c.get("/tour").json() == {"seen": False}
    assert c.post("/tour/seen").json() == {"seen": True}
    assert c.get("/tour").json() == {"seen": True}
    assert json.loads(tour.state_file().read_text())["seen"]
    # written whole: no temporary file is left beside it
    assert [p.name for p in tour.state_file().parent.iterdir()] == ["tour.json"]


def test_an_answer_in_another_home_counts_here():
    other = Path(os.environ["THIMBLE_BROWSER_HOME"])
    other.mkdir(parents=True)
    (other / "tour.json").write_text(json.dumps({"seen": "2026-11-08T00:00:00Z"}))
    assert client().get("/tour").json() == {"seen": True}
    assert not tour.state_file().exists()


def test_a_state_that_does_not_parse_reads_as_unseen():
    tour.state_file().parent.mkdir(parents=True)
    tour.state_file().write_text("[not json")
    assert tour.read() == {}
    assert client().get("/tour").json() == {"seen": False}
