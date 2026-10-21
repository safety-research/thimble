"""Try it and Undo act on thimble browser itself (restart.py): the server restarts from the fix's copy, or from the
release, and never runs `claude` or changes the terminal plugin. A normal install has pytest, so a fix's tests run.
All names and data are made up."""
import asyncio
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from thimble_browser import home, restart
from thimble_browser.app import build
from thimble_browser.cards import sandbox
from thimble_browser.kernel_fix import fix

PORT = 21098
OWN = f"http://127.0.0.1:{PORT}"
REPO = Path(__file__).resolve().parents[3]


def sh(*args, cwd):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def made(tmp_path, monkeypatch, folder):
    """A made-up release checkout with a built page, a fix of it, and a `claude` stub that records any call."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thome"))
    claude_log = tmp_path / "claude.log"
    stub = tmp_path / "claude-stub"
    stub.write_text(f'#!/bin/sh\necho "$*" >> "{claude_log}"\n')
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("THIMBLE_CLAUDE", str(stub))
    src = tmp_path / "src"
    (src / "plugin").mkdir(parents=True)
    (src / "plugin" / "order.py").write_text("ORDER = 'oldest'\n")
    (src / "browser" / "server" / "thimble_browser").mkdir(parents=True)
    (src / "browser" / "server" / "thimble_browser" / "__init__.py").write_text("")
    (src / "browser" / "frontend" / "src").mkdir(parents=True)
    (src / "browser" / "frontend" / "src" / "Bar.tsx").write_text("export const label = 'Fix…'\n")
    for args in (("init", "-q", "-b", "main"), ("add", "plugin", "browser"),
                 ("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "release")):
        sh("git", *args, cwd=src)
    (src / "browser" / "frontend" / "dist").mkdir()
    (src / "browser" / "frontend" / "dist" / "index.html").write_text("<p>release page</p>")
    monkeypatch.setattr(fix, "find_source", lambda: (src, sh("git", "rev-parse", "HEAD", cwd=src), False))
    monkeypatch.setattr(restart, "release_server", lambda: src / "browser" / "server")
    ws = home.open_folder(folder)
    fx = fix.new("Rename the fix button", "fix")
    fx["workspace"] = ws
    fix.save(fx)
    scheduled = []
    monkeypatch.setattr(restart, "schedule", lambda server, changes: scheduled.append((server, changes)))
    app, auth, _ = build(PORT)
    with TestClient(app, base_url=OWN) as c:
        r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
        key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]

        def call(method, path, **kw):
            return c.request(method, f"/b/{key}/api/ws/{ws}{path}", headers={"cookie": cookie, "origin": OWN}, **kw)

        yield {"call": call, "fx": fx, "src": src, "scheduled": scheduled, "claude_log": claude_log}


def test_try_it_restarts_the_browser_from_the_copy_and_leaves_the_terminal_plugin_alone(made):
    call, fx, src = made["call"], made["fx"], made["src"]
    r = call("POST", f"/fixes/{fx['slug']}/use")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["restarting"] is True
    assert "Rename the fix button" in body["said"] and "reload-plugins" not in body["said"]
    [(server, changes)] = made["scheduled"]
    assert server == Path(fx["worktree"]) / "browser" / "server"
    # the copy's page is the release's, so the copy's server serves the release's built page
    assert changes == {restart.RELEASE_ENV: str(src / "browser" / "server"),
                       restart.DIST_ENV: str(src / "browser" / "frontend" / "dist")}
    assert not made["claude_log"].exists()
    assert fix.active_slug() is None  # the terminal's marketplace pointer is untouched


def test_a_fix_that_changes_the_page_builds_it_first_and_says_so_when_it_cannot(made):
    call, fx = made["call"], made["fx"]
    (Path(fx["worktree"]) / "browser" / "frontend" / "src" / "Bar.tsx").write_text("export const label = 'Change…'\n")
    r = call("POST", f"/fixes/{fx['slug']}/use")
    # the made-up release has no node_modules: one line with the fix, and no restart
    assert r.status_code == 409
    assert "page's packages are not installed" in r.json()["detail"] and "scripts/install.sh" in r.json()["detail"]
    assert made["scheduled"] == [] and not made["claude_log"].exists()


def test_undo_restarts_the_browser_from_the_release(made, monkeypatch):
    call, fx, src = made["call"], made["fx"], made["src"]
    r = call("POST", "/fixes/undo").json()
    assert r["restarting"] is False and r["said"] == "thimble browser already runs the release."
    monkeypatch.setattr(restart, "running_slug", lambda server=None: fx["slug"])
    assert call("GET", "/fixes").json()["active"] == fx["slug"]
    r = call("POST", "/fixes/undo").json()
    assert r["restarting"] is True and "without your fix" in r["said"] and "reload-plugins" not in r["said"]
    assert made["scheduled"] == [(src / "browser" / "server", {restart.RELEASE_ENV: None, restart.DIST_ENV: None})]
    assert not made["claude_log"].exists()


def test_the_server_knows_which_fix_copy_it_runs_from(tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thome"))
    copy_server = fix.fixes_home() / "made-up-fix" / "worktree" / "browser" / "server"
    copy_server.mkdir(parents=True)
    assert restart.running_slug(copy_server) == "made-up-fix"
    assert restart.running_slug(tmp_path / "release" / "browser" / "server") is None


def test_page_changed_ignores_built_and_installed_folders(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    for d in (a, b):
        (d / "src").mkdir(parents=True)
        (d / "src" / "x.ts").write_text("1\n")
    (a / "node_modules").mkdir()
    (a / "node_modules" / "y.js").write_text("y")
    (b / "dist").mkdir()
    (b / "dist" / "index.html").write_text("z")
    assert not restart.page_changed(a, b)
    (a / "src" / "x.ts").write_text("2\n")
    assert restart.page_changed(a, b)
    (a / "src" / "x.ts").write_text("1\n")
    (a / "src" / "new.ts").write_text("3\n")
    assert restart.page_changed(a, b)


def test_the_restart_command_runs_the_named_server_on_the_same_port(tmp_path, monkeypatch):
    server = tmp_path / "copy-server"
    (server / "thimble_browser").mkdir(parents=True)
    (server / "thimble_browser" / "__init__.py").write_text("")
    (server / "thimble_browser" / "__main__.py").write_text(
        "import json\ndef main(argv):\n    print(json.dumps(argv))\n    return 0\n")
    files = tmp_path / "files"
    files.mkdir()
    (files / "thimble_browser.py").write_text("print('a file of the folder ran')\n")  # made up: must never run
    monkeypatch.setattr(restart, "RUN", {"argv": [".", "--wif", "made-up.toml"], "port": 9555})
    argv = restart.argv_for(server)
    out = subprocess.run(argv, cwd=files, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == [".", "--wif", "made-up.toml", "--port", "9555", "--no-open"]
    assert restart.env_for({restart.DIST_ENV: "/made/up", "THIMBLE_NOT_SET": None})[restart.DIST_ENV] == "/made/up"


def test_a_normal_install_has_pytest_for_a_fixs_tests():
    line = next(x for x in (REPO / "scripts" / "install.sh").read_text().splitlines()
                if re.match(r"\s*quietly uv sync --project \"\$browser/server\"", x))
    assert "--extra dev" in line
    dev = (REPO / "browser" / "server" / "pyproject.toml").read_text().split("dev = [", 1)[1].split("]", 1)[0]
    assert '"pytest' in dev
    # this test runs in the server's Python, set up as install.sh sets it up: the fix's tests use it
    assert sandbox.test_python() == sys.executable


def test_a_fixs_browser_tests_import_the_copys_server_code(tmp_path):
    copy = tmp_path / "copy"
    (copy / "browser" / "server" / "thimble_browser").mkdir(parents=True)
    (copy / "browser" / "server" / "thimble_browser" / "__init__.py").write_text("MADE_UP = 'from the copy'\n")
    (copy / "browser" / "server" / "tests").mkdir()
    (copy / "browser" / "server" / "tests" / "test_made_up.py").write_text(
        "import thimble_browser\n\ndef test_the_copy():\n    assert thimble_browser.MADE_UP == 'from the copy'\n")
    res = asyncio.run(sandbox.run_tests(copy, ["browser/server/tests/test_made_up.py"], unsandboxed=True))
    assert res["ok"], res["text"]
    assert "1 passed" in res["text"]
