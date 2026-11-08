"""The tour's offer (app/tour.py): unseen until the person answers it, then recorded in this server's home."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import tour


def test_the_offer_is_unseen_until_answered():
    app = FastAPI()
    app.include_router(tour.router)
    c = TestClient(app)
    assert c.get("/tour").json() == {"seen": False}
    assert c.post("/tour/seen").json() == {"seen": True}
    assert c.get("/tour").json() == {"seen": True}
