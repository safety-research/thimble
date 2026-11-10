"""Nothing in the workbench starts a code ticket. A change to thimble's own code is a fix of the person's thimble
(app/fixes.py), which /thimble-fix asks for. So `file_dev_ticket` without a view files nothing and says why, filing in
the browser makes a fix or answers with why it cannot, and neither a click nor the server starts the record of an
earlier ticket. The suite runs with fixes off (conftest), so each entry answers with its refusal here. No model call."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import dev, fixes, hook_auth, main, tools

CORPUS = "mini"


@pytest.fixture()
def page(workspaces_tmp):
    """The client of a signed-in browser, which asks as the page does (conftest browser_base)."""
    from conftest import UI_COOKIE_VALUE, _record_paired, browser_base

    client = TestClient(main.create_app(), base_url=browser_base())
    _record_paired(UI_COOKIE_VALUE)
    client.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    return client


async def test_file_dev_ticket_without_a_view_files_nothing_and_says_why(workspaces_tmp, monkeypatch):
    args = {"title": "the canvas should scroll to the new card", "body": "it stays where it was"}
    r = await tools.call(CORPUS, "file_dev_ticket", args, actor="analyst")
    assert not r.is_error, r.text
    said = r.text.partition("\n")[2]  # under the line that repeats the call
    assert said == f"Nothing was filed: {fixes.OFF_LINE}. Tell the analyst, because only they can change this."
    # where fixes work, the answer names /thimble-fix, and the call still files nothing
    monkeypatch.setattr(fixes, "problem", lambda: "")
    r = await tools.call(CORPUS, "file_dev_ticket", args, actor="analyst")
    assert not r.is_error and "/thimble-fix <what should work differently>" in r.text, r.text
    assert dev._read() == [], "no ticket's record"


def test_filing_in_the_browser_with_fixes_off_answers_with_why(page):
    r = page.post("/api/dev/tickets", json={"workspace": CORPUS, "title": "the canvas should scroll", "body": ""})
    assert (r.status_code, r.json()["detail"]) == (409, fixes.OFF_LINE)
    r = page.post("/api/dev/tickets", json={"title": "the canvas should scroll", "body": ""})
    assert (r.status_code, r.json()["detail"]) == (400, "workspace is required")
    assert dev._read() == [], "no ticket's record"


def test_an_earlier_ticket_is_started_by_no_click_and_not_by_the_server(page):
    """A record that an earlier version left queued: Retry and Start answer 409 with how to ask for the change now, the
    server's status request starts nothing, and the record stays as it was."""
    rec = dev.file_ticket(CORPUS, "the canvas should scroll", "it stays where it was", "analyst", start=False)
    before = dev._read()
    assert [t["status"] for t in before] == ["queued"]
    for click in ("retry", "start"):
        r = page.post(f"/api/dev/tickets/{rec['id']}/{click}")
        assert (r.status_code, r.json()["detail"]) == (409, fixes.EMPTY), click
    assert page.post("/api/dev/tickets/none/retry").status_code == 404
    assert page.get("/api/dev/status").status_code == 200
    assert dev._read() == before
