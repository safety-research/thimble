"""Every route of the local API takes the credential docs/routes.md names (scripts/dev/route_table.py,
app/hook_auth.py): the token in server.json reaches only the token routes (hook_auth.guarded), which a signed-in
browser's cookie does not reach, and every other write needs that cookie, which the token alone never stands in for.
Whatever the plugin, its hooks module, the stand-in session and the CLI post to is a token route."""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config, hook_auth, main

REPO = Path(config.REPO_ROOT)
SCRIPT = REPO / "scripts" / "dev" / "route_table.py"


def _table_module():
    spec = importlib.util.spec_from_file_location("route_table_for_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def table():
    mod = _table_module()
    return mod, mod.rows(main.app)


def _concrete(path: str) -> str:
    """A path the route answers, its parameters filled in (a workspace is `mini`)."""
    return re.sub(r"\{[^}]+\}", lambda m: "mini" if m.group(0) == "{c}" else "x", path)


@pytest.mark.real_write_guard
def test_the_token_alone_is_refused_on_every_analyst_route_and_the_cookie_alone_on_every_token_route(
        table, plugin_headers, monkeypatch):
    """Walking the server's routes: every write that is no token route and not the claim of a code refuses the token
    alone with 403 and today's words (WRITE_REFUSED), and every token route refuses a signed-in browser's cookie alone
    with 401. The two sets and the claim cover every write."""
    from conftest import UI_COOKIE_VALUE, _record_paired

    _, rows = table
    monkeypatch.setenv("THIMBLE_PORT", "8300")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    app = main.create_app()
    by_token = TestClient(app, base_url="http://testserver")
    by_cookie = TestClient(app, base_url="http://testserver")
    _record_paired(UI_COOKIE_VALUE)
    by_cookie.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    writes = [(m, p) for m, p, _, _ in rows if m not in ("GET", "WS")]
    token = [(m, p) for m, p in writes if hook_auth.guarded(m, p)]
    analyst = [(m, p) for m, p in writes if not hook_auth.guarded(m, p) and p != "/api/ui/key"]
    assert sorted(token + analyst + [("POST", "/api/ui/key")]) == sorted(writes), "the sets cover every write"
    assert len(analyst) >= 100 and len(token) >= 25
    for method, path in analyst:
        r = by_token.request(method, _concrete(path), json={}, headers=plugin_headers())
        assert r.status_code == 403 and r.json().get("detail") == hook_auth.WRITE_REFUSED, (method, path, r.status_code)
    for method, path in token:
        r = by_cookie.request(method, _concrete(path), json={})
        assert r.status_code == 401, (method, path, r.status_code)


def test_the_routes_of_the_cli_and_of_pairing_are_token_routes_and_the_proposals_routes_are_the_analyst_s(table):
    _, rows = table
    cred = {(m, p): c for m, p, _, c in rows}
    for route in [("POST", "/api/corpora/register"), ("POST", "/api/ws/{c}/session"),
                  ("POST", "/api/ws/{c}/precached/context"), ("POST", "/api/ws/{c}/archive"),
                  ("POST", "/api/ws/{c}/restore"), ("POST", "/api/ws/{c}/rename"), ("DELETE", "/api/ws/{c}"),
                  ("POST", "/api/dev/announce"), ("POST", "/api/dev/revert"), ("POST", "/api/extensions/refresh"),
                  ("POST", "/api/subagents/caller"), ("POST", "/api/ui/pair"), ("POST", "/api/ui/unpair")]:
        assert cred[route] == "token", route
    assert cred[("POST", "/api/ui/key")] == "code" and cred[("GET", "/api/ui/paired")] == "none"
    assert cred[("WS", "/api/agent/claude")] == "agent token"
    for route in [("POST", "/api/ui/signout"), ("POST", "/api/ws/{c}/events"), ("PUT", "/api/ws/{c}/settings"),
                  ("POST", "/api/ws/{c}/notices/{notice_id}/dismiss"), ("POST", "/api/ws/{c}/views/propose-now"),
                  ("POST", "/api/ws/{c}/views/proposals/{slug}/accept"), ("DELETE", "/api/ws/{c}/chats/{chat_id}")]:
        assert cred.get(route) == "cookie", route
    assert not hook_auth.guarded("POST", "/api/ws/mini/cells/x/versions/y/restore"), "a workspace's own restore only"
    assert not hook_auth.guarded("DELETE", "/api/ws/mini/chats/x")


def test_the_browser_sends_only_main_thread_and_card_events(plugin_headers):
    """The events route takes only the kinds the browser posts; a start of an agent, which main's tool call makes, is
    400 there, as is every other kind the server posts itself."""
    client = TestClient(main.create_app())
    for kind in ("start_agent", "orient", "written", "anything"):
        r = client.post("/api/ws/mini/events", json={"kind": kind, "payload": {"role": "orientation"}})
        assert r.status_code == 400 and r.json()["detail"] == "the browser sends only main, thread and card events", kind


def _paths(text: str) -> set[str]:
    """Every /api/ path written in `text`, its placeholders ({…}, ${…}, <…>) made `x` and its query left out; a brace
    may hold quotes ({urllib.parse.quote(ws, safe='')})."""
    out: set[str] = set()
    for m in re.finditer(r"/api/", text):
        i, depth, buf = m.start(), 0, []
        while i < len(text):
            ch = text[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            elif depth == 0 and (ch in "\"'`?#),;:\\" or ch.isspace()):
                break
            buf.append(ch)
            i += 1
        path = re.sub(r"\$?\{[^{}]*(\{[^{}]*\}[^{}]*)*\}|<[^<>]*>", "x", "".join(buf)).rstrip(".")
        out.add(path)
    return out


OPEN_READS = {"/api/health"}  # what a plugin's script or the CLI reads with no credential


def test_every_path_the_plugin_its_hooks_module_and_the_stand_in_session_name_is_a_token_route():
    files = [REPO / "plugin" / "bin" / ".thimble-watch", REPO / "plugin" / "bin" / "thimble-mcp",
             REPO / "plugin" / "hooks" / "thimble.ts", REPO / "plugin" / "bin" / "thimble-agents",
             REPO / "backend" / "app" / "permission_hook.py", REPO / "scripts" / "e2e" / "standin_session.py"]
    seen = {}
    for f in files:
        for path in _paths(f.read_text("utf-8")):
            seen[path] = f.name
    assert {"/api/events/pull", "/api/module/hello", "/api/tools/x", "/api/ws/x/sessions/permission",
            "/api/ws/x/session", "/api/agents"} <= set(seen), "the scan finds them"
    for path, name in sorted(seen.items()):
        if path in OPEN_READS or path in ("/api/module/", "/api/module/x"):
            continue
        assert any(hook_auth.guarded(m, path) for m in ("GET", "POST")), (name, path)


def test_every_write_the_cli_makes_is_a_token_route():
    """Each cli._request with a write method and a written path, in the app, the CLI and the scripts, goes to a token
    route, except a call that sends a browser's cookie (cookie=)."""
    call = re.compile(r"_request\(\s*\"(POST|PUT|PATCH|DELETE)\",\s*(f?\"[^\n]*)")
    found = []
    for f in [*sorted((REPO / "backend" / "app").glob("*.py")), *sorted((REPO / "scripts").rglob("*.py"))]:
        for m in call.finditer(f.read_text("utf-8")):
            if "cookie=" in m.group(2):
                continue
            for path in _paths(m.group(2)):
                found.append((f.name, m.group(1), path))
    assert ("cli.py", "POST", "/api/corpora/register") in found and ("cli.py", "POST", "/api/dev/revert") in found
    for name, method, path in found:
        assert hook_auth.guarded(method, path), (name, method, path)


def test_docs_routes_md_is_current(table):
    mod, rows = table
    current = (REPO / "docs" / "routes.md").read_text("utf-8")
    assert current == mod.render(rows), "docs/routes.md is not current: run scripts/dev/route_table.py"
