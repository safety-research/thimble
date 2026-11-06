"""Every route of the local API takes the credential docs/routes.md names (scripts/dev/route_table.py,
app/hook_auth.py): the token in server.json reaches only the token routes (hook_auth.guarded), which a signed-in
browser's cookie does not reach, and every other write needs that cookie, which the token alone never stands in for.
Every read but the open ones (hook_auth.OPEN_READS) needs the cookie or the token's proof, which the CLI sends with every
request. Whatever the CLI posts to is a token route, and whatever it reads with no proof is an open read."""
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
    from conftest import UI_COOKIE_VALUE, _record_paired, browser_base

    _, rows = table
    monkeypatch.setenv("THIMBLE_PORT", "8300")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    app = main.create_app()
    by_token = TestClient(app, base_url="http://testserver")
    by_cookie = TestClient(app, base_url=browser_base())  # the page asks under its key's path (hook_auth)
    _record_paired(UI_COOKIE_VALUE)
    by_cookie.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    writes = [(m, p) for m, p, _, _ in rows if m != "GET"]
    token = [(m, p) for m, p in writes if hook_auth.guarded(m, p)]
    analyst = [(m, p) for m, p in writes if not hook_auth.guarded(m, p) and p != "/api/ui/key"]
    assert sorted(token + analyst + [("POST", "/api/ui/key")]) == sorted(writes), "the sets cover every write"
    assert len(analyst) >= 100 and len(token) >= 8
    for method, path in analyst:
        r = by_token.request(method, _concrete(path), json={}, headers=plugin_headers())
        assert r.status_code == 403 and r.json().get("detail") == hook_auth.WRITE_REFUSED, (method, path, r.status_code)
    for method, path in token:
        r = by_cookie.request(method, _concrete(path), json={})
        assert r.status_code == 401, (method, path, r.status_code)


@pytest.mark.real_read_guard
def test_every_read_needs_the_cookie_or_the_token_and_only_the_open_reads_answer_anyone(table, plugin_headers,
                                                                                       monkeypatch):
    """Walking the server's routes: every GET that is no token route and no open read refuses a request with no
    credential with 401 and {detail: SIGN_IN_NEEDED, signin: true} (a HEAD with no body); a signed-in browser's cookie
    and the token's proof each get past the guard (the event streams, which never end, are left out of that half). The
    open reads answer anyone."""
    from conftest import UI_COOKIE_VALUE, _record_paired, browser_base

    _, rows = table
    monkeypatch.setenv("THIMBLE_PORT", "8300")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    app = main.create_app()
    anyone = TestClient(app, base_url="http://testserver")
    by_cookie = TestClient(app, base_url=browser_base())  # the page asks under its key's path (hook_auth)
    _record_paired(UI_COOKIE_VALUE)
    by_cookie.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    reads = [p for m, p, _, _ in rows if m == "GET" and not hook_auth.guarded(m, p)]
    gated = [p for p in reads if p not in hook_auth.OPEN_READS]
    assert sorted(set(reads) - set(gated)) == sorted(hook_auth.OPEN_READS) and len(gated) >= 95
    refused = {"detail": hook_auth.SIGN_IN_NEEDED, "signin": True}
    for path in gated:
        url = _concrete(path)
        r = anyone.get(url)
        assert (r.status_code, r.json()) == (401, refused), (path, r.status_code)
        head = anyone.head(url)
        assert (head.status_code, head.content) == (401, b""), path
        if path.endswith("/events"):
            continue
        for name, client, headers in (("cookie", by_cookie, {}), ("token", anyone, plugin_headers())):
            r = client.get(url, headers=headers)
            assert r.status_code != 401 and "signin" not in r.text, (path, name, r.status_code, r.text[:200])
    assert anyone.get("/api/health").json()["ok"] is True
    assert anyone.get("/api/ui/paired").json() == {"paired": False, "id": "", "at": ""}
    for path in ("/docs", "/redoc", "/openapi.json"):  # FastAPI's own pages are off; a built page may answer them
        r = anyone.get(path)
        assert r.status_code == 404 or not re.search(r"swagger|redoc|\"openapi\"", r.text, re.I), path


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


OPEN_READS = hook_auth.OPEN_READS  # what the CLI or a script reads with no credential


def test_every_write_the_cli_makes_is_a_token_route():
    """Each cli._request with a write method and a written path, in the app, the CLI and the scripts, goes to a token
    route."""
    call = re.compile(r"_request\(\s*\"(POST|PUT|PATCH|DELETE)\",\s*(f?\"[^\n]*)")
    found = []
    for f in [*sorted((REPO / "backend" / "app").glob("*.py")), *sorted((REPO / "scripts").rglob("*.py"))]:
        for m in call.finditer(f.read_text("utf-8")):
            for path in _paths(m.group(2)):
                found.append((f.name, m.group(1), path))
    assert ("cli.py", "POST", "/api/corpora/register") in found and ("cli.py", "POST", "/api/dev/revert") in found
    for name, method, path in found:
        assert hook_auth.guarded(method, path), (name, method, path)


def _gets_without_proof() -> list[tuple[str, str]]:
    """(file, path) of each /api/ path that backend or scripts code reads over HTTP without going through
    cli._request (which proves the token): a urlopen, LOOPBACK.open, fetch, curl or httpx GET with a written path."""
    files = [*sorted((REPO / "backend" / "app").glob("*.py")), *sorted((REPO / "scripts").rglob("*.py")),
             *sorted((REPO / "scripts").rglob("*.sh"))]
    call = re.compile(r"(?:urlopen|LOOPBACK\.open|fetch|curl [^\n]*?|client\.get|httpx\.get)\(?\s*f?[\"']([^\"'\n]*)")
    out = []
    for f in files:
        if not f.is_file():
            continue
        for m in call.finditer(f.read_text("utf-8", errors="replace")):
            out += [(f.name, p) for p in _paths(m.group(1))]
    return out


def test_no_code_of_thimble_reads_a_gated_route_without_the_token_s_proof(table):
    """A read with no proof gets 401 (hook_auth.LocalReadGuard), so whatever the backend and the scripts read over HTTP
    by hand is an open read, and every GET the CLI and the scripts make through cli._request names a
    route the server has (a GET of no route is a 404 whatever it proves)."""
    seen = _gets_without_proof()
    assert ("cli.py", "/api/health") in seen, "the scan finds them"
    for name, path in seen:
        assert path in OPEN_READS, (name, path)
    _, rows = table
    routes = [re.compile(re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(p))) for m, p, _, _ in rows if m == "GET"]
    call = re.compile(r"_request\(\s*\"GET\",\s*(f?\"[^\n]*)")
    found = []
    for f in [*sorted((REPO / "backend" / "app").glob("*.py")), *sorted((REPO / "scripts").rglob("*.py"))]:
        for m in call.finditer(f.read_text("utf-8")):
            found += [(f.name, p) for p in _paths(m.group(1))]
    assert ("cli.py", "/api/dev/status") in found and ("cli.py", "/api/jobs") in found, "the scan finds them"
    for name, path in found:
        assert any(r.fullmatch(path) for r in routes), (name, path)


def test_docs_routes_md_is_current(table):
    mod, rows = table
    current = (REPO / "docs" / "routes.md").read_text("utf-8")
    assert current == mod.render(rows), "docs/routes.md is not current: run scripts/dev/route_table.py"
