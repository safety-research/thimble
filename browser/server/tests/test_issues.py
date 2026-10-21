"""Report a problem: the agent drafts, the server scans, the page previews, and only the person's click sends. Sending
runs the program THIMBLE_GH names; here a stub that records its arguments and prints a made-up URL."""
import asyncio
import json
import stat

import pytest
from fastapi.testclient import TestClient

from thimble_browser import agent, home
from thimble_browser.app import build
from thimble_browser.tools import Tools

PORT = 21099
OWN = f"http://127.0.0.1:{PORT}"


@pytest.fixture
def gh_stub(tmp_path, monkeypatch):
    log = tmp_path / "gh-calls.jsonl"
    stub = tmp_path / "gh"
    stub.write_text(
        "#!/usr/bin/env python3\nimport json, sys\n"
        f"open({str(log)!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "a = sys.argv[1:]\n"
        "if a[:2] == ['api', 'user']: print('made-up-tester')\n"
        "elif a[:2] == ['issue', 'create']:\n"
        "    body = open(a[a.index('--body-file') + 1]).read()\n"
        f"    open({str(log)!r}, 'a').write(json.dumps({{'body': body}}) + '\\n')\n"
        "    print('https://github.com/example/thimble/issues/999')\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("THIMBLE_GH", str(stub))
    return log


@pytest.fixture
def api(folder):
    ws = home.open_folder(folder)
    app, auth, _ = build(PORT)
    with TestClient(app, base_url=OWN) as c:
        r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
        key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]

        def call(method, path, **kw):
            return c.request(method, f"/b/{key}/api/ws/{ws}{path}", headers={"cookie": cookie, "origin": OWN}, **kw)
        call.ws = ws
        call.folder = folder
        (folder / "northwind-tickets.csv").write_text("queue_owner,status\nmade-up-owner,open\n")
        yield call


FAKE_TOKEN = "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123456789"  # made up, built here so secret scanners pass
BODY = ("## What happened\nRows could not open northwind-tickets.csv in {folder}: ValueError at plugin/claims/rows.js:52. "
        "The cited value was made-up-owner, from the field queue_owner. Token {token}.\n\n"
        "## Expected\nRows opens the file.\n\n## Reproduction (made-up data)\n4 rows, 3 fields, ; between fields.")


def test_the_agent_drafts_the_scan_removes_and_only_the_persons_click_sends(api, gh_stub):
    # the chat agent has a tool that drafts and none that sends, keeps or edits
    names = agent.AGENTS["main"].tool_names()
    assert "draft_report" in names
    assert not [n for n in names if any(w in n for w in ("send", "keep", "issue_", "gh"))]

    t = Tools(api.ws, "main", api.folder)
    got = asyncio.run(t.call("draft_report", {"title": "Rows fails on northwind-tickets.csv",
                                               "body": BODY.format(folder=api.folder, token=FAKE_TOKEN)}))
    assert not got.is_error and "reviewing the draft" in got.text

    d = api("GET", "/issues/current").json()
    assert d["ask"] and d["ask"] not in got.text  # the ask id reaches the page, never the agent
    assert d["login"] == "made-up-tester"
    found = {h["found"]: h for h in d["hits"]}
    assert "northwind-tickets.csv" in found and str(api.folder) in found and FAKE_TOKEN in found
    assert found["queue_owner"]["replacement"] == "‹field›" and found["made-up-owner"]["replacement"] == "‹value›"
    for gone in ("northwind-tickets.csv", str(api.folder), "ghp_", "queue_owner", "made-up-owner"):
        assert gone not in d["text"]
    assert d["text"].startswith("# Rows fails on ‹data file›")
    assert "## thimble\nthimble browser" in d["text"] and "a privacy scan removed" in d["text"]

    # without the ask id nothing is kept or sent
    slug = d["slug"]
    assert api("POST", f"/issues/{slug}/send", json={"answer": "send"}).status_code == 403
    assert api("POST", f"/issues/{slug}/send", json={"answer": "send", "ask": "guess"}).status_code == 403
    assert not gh_stub.exists() or "issue" not in gh_stub.read_text()

    # Keep restores a hit, never a token
    token = found[FAKE_TOKEN]
    assert api("POST", f"/issues/{slug}/keep", json={"hit": token["id"], "ask": d["ask"]}).status_code == 400
    kept = api("POST", f"/issues/{slug}/keep", json={"hit": found["northwind-tickets.csv"]["id"], "ask": d["ask"]}).json()
    assert "northwind-tickets.csv" in kept["text"]

    # an edit runs the scan again
    edited = kept["text"].replace("Rows opens the file.", "Rows opens the file at /home/someone/data.")
    e = api("PUT", f"/issues/{slug}", json={"text": edited, "ask": d["ask"]}).json()
    assert "/home/someone" not in e["text"] and "‹path›" in e["text"]

    # the person's Send runs gh once, with the exact previewed text
    r = api("POST", f"/issues/{slug}/send", json={"answer": "send", "ask": d["ask"]}).json()
    assert r == {"status": "sent", "url": "https://github.com/example/thimble/issues/999"}
    calls = [json.loads(x) for x in gh_stub.read_text().splitlines()]
    create = next(c for c in calls if isinstance(c, list) and c[:2] == ["issue", "create"])
    assert create[create.index("--repo") + 1] == "safety-research/thimble"
    sent_body = next(c["body"] for c in calls if isinstance(c, dict))
    assert sent_body.strip() == e["text"].partition("\n")[2].strip()
    # answered: the ask is gone, so a second send is refused
    assert api("POST", f"/issues/{slug}/send", json={"answer": "send", "ask": d["ask"]}).status_code == 403
    assert api("GET", "/issues/current").json() is None


def test_save_as_file_gives_one_markdown_file_and_sends_nothing(api, gh_stub):
    t = Tools(api.ws, "main", api.folder)
    asyncio.run(t.call("draft_report", {"title": "A made-up problem", "body": "## What happened\nNothing real."}))
    d = api("GET", "/issues/current").json()
    r = api("POST", f"/issues/{d['slug']}/send", json={"answer": "file", "ask": d["ask"]}).json()
    assert r["status"] == "saved" and r["filename"].endswith(".md") and r["markdown"] == d["text"]
    assert "issue" not in gh_stub.read_text()
