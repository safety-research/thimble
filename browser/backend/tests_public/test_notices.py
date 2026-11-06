"""notices.py: a failure of one of thimble's agents told in the foreground with its fix. GET /notices gives the open
ones, and the analyst's x dismisses one."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app import hook_auth, main, notices

CORPUS = "mini"


def test_get_notices_gives_the_open_ones_and_the_x_dismisses(workspaces_tmp, analyst):
    client = TestClient(main.create_app())
    assert client.get(f"/api/ws/{CORPUS}/notices").json() == []
    n = notices.post(CORPUS, kind="agent", text="The view build failed: it broke.", agent="View build: Posts",
                     key="agent:view:posts")
    got = client.get(f"/api/ws/{CORPUS}/notices").json()
    assert [(x["id"], x["text"], x["agent"]) for x in got] == [(n["id"], n["text"], "View build: Posts")]
    assert client.post(f"/api/ws/{CORPUS}/notices/{n['id']}/dismiss").status_code == 403, \
        "only the analyst's x takes a notice away"
    client.cookies.set(hook_auth.ui_cookie(), analyst.cookies[hook_auth.ui_cookie()])
    page = f"/b/{hook_auth.path_key(analyst.scope)}"  # where the analyst's page asks (hook_auth.browser_path)
    assert client.post(f"{page}/api/ws/{CORPUS}/notices/{n['id']}/dismiss").json() == {"dismissed": True}
    assert client.get(f"/api/ws/{CORPUS}/notices").json() == []
