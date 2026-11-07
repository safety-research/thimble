"""The headless Chromium the workbench draws cards in, and loads views in (app/headless.py): where it finds no system
browser, Playwright's, one build for the server's Playwright and one for the page's. Its check, which thimble's install,
thimble update and thimble doctor ask (python -m app.headless), says what goes unchecked without it and the commands that
fetch it, and with --fetch runs them; the server's warning names the command too. Playwright's browsers folder, its
browsers.json and the downloads are made up here."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import headless, userconf

BACKEND = Path(__file__).resolve().parents[1]
UNCHECKED = "cards are not checked; views are checked without loading their page, and screenshots are unavailable"


@pytest.fixture
def browsers(tmp_path, monkeypatch) -> Path:
    """No system browser, an empty browsers folder, and the made-up builds each Playwright names: 1187 for the server's,
    1193 for the page's."""
    monkeypatch.setattr(userconf, "system_browser", lambda: "")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "browsers"))
    named = {}
    for kind, rev in ((headless.HARNESS, "1187"), (headless.PAGES, "1193")):
        named[kind] = tmp_path / f"browsers-{rev}.json"
        named[kind].write_text(json.dumps({"browsers": [{"name": headless.CHROMIUM, "revision": rev}]}))
    monkeypatch.setattr(headless, "browsers_json", named.get)
    return tmp_path / "browsers"


def test_without_its_chromium_the_check_says_what_goes_unchecked_and_the_commands_that_fetch_it(browsers, monkeypatch):
    harness, pages = headless.fetch_command(headless.HARNESS), headless.fetch_command(headless.PAGES)
    assert harness == f"{sys.executable} -m playwright install chromium-headless-shell".replace(
        str(Path.home()) + os.sep, "~" + os.sep, 1)
    assert pages.endswith("/frontend && npx playwright install chromium-headless-shell") and pages.startswith("cd ")
    assert headless.check() == {"ok": False, "why": f"no headless Chromium, so {UNCHECKED}",
                                "fix": f"Fetch it: {harness} && {pages}"}
    # the server's build there, the page's not
    (browsers / "chromium_headless_shell-1187").mkdir(parents=True)
    assert headless.check() == {"ok": False, "fix": f"Fetch it: {pages}", "why": "no headless Chromium, so views are "
                                "checked without loading their page, and screenshots are unavailable"}
    (browsers / "chromium_headless_shell-1193").mkdir()
    assert headless.check() == {"ok": True}
    # a system browser, which the workbench uses first, needs none
    for p in browsers.iterdir():
        p.rmdir()
    monkeypatch.setattr(userconf, "system_browser", lambda: "/made-up/chrome")
    assert headless.check() == {"ok": True}


def test_the_check_with_fetch_fetches_each_build_that_is_missing_and_says_why_a_download_failed(browsers, tmp_path,
                                                                                                monkeypatch):
    ran: list[str] = []

    def fetches(kind: str) -> tuple[list[str], Path]:
        ran.append(kind)
        rev = "1187" if kind == headless.HARNESS else "1193"
        return [sys.executable, "-c", "import os, sys; os.makedirs(sys.argv[1])",
                str(browsers / f"chromium_headless_shell-{rev}")], tmp_path

    monkeypatch.setattr(headless, "fetch_argv", fetches)
    assert headless.check(fetch=True) == {"ok": True} and ran == [headless.HARNESS, headless.PAGES]
    assert headless.check(fetch=True) == {"ok": True} and len(ran) == 2
    # a download that fails, as Playwright says it: the cause first, on stderr, then that the download failed
    for p in browsers.iterdir():
        p.rmdir()
    fails = ("import sys; print('Error: connect ECONNREFUSED 127.0.0.1:9', file=sys.stderr); "
             "print('Failed to install browsers'); print('Error: Failed to download'); sys.exit(1)")
    monkeypatch.setattr(headless, "fetch_argv", lambda kind: ([sys.executable, "-c", fails], tmp_path))
    got = headless.check(fetch=True)
    assert not got["ok"] and got["why"] == (f"no headless Chromium, so {UNCHECKED} (its download failed: connect "
                                            "ECONNREFUSED 127.0.0.1:9)")


def test_the_server_s_warning_of_a_chromium_that_is_not_installed_names_the_command_that_fetches_it(caplog,
                                                                                                     monkeypatch):
    monkeypatch.setattr(headless, "_missing", {})
    with caplog.at_level(logging.WARNING, logger="thimble.headless"):
        headless.mark_missing(headless.HARNESS, headless.NOT_INSTALLED)
        headless.mark_missing(headless.HARNESS, headless.NOT_INSTALLED)
    assert caplog.messages == [
        "card harness: the headless Chromium is not installed, so cards are not checked until the server restarts. "
        f"Fetch it: {headless.fetch_command(headless.HARNESS)}"]
    # the words a launch leaves, which models read, name no command
    assert headless.missing(headless.HARNESS) == headless.NOT_INSTALLED


def test_the_check_answers_thimble_s_install_in_one_line_of_json(tmp_path):
    """python -m app.headless, as the kernel runs it (plugin/engine/kernel/fixes.py browser_chromium): the config picks
    Playwright's own Chromium, and its browsers folder is empty."""
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "config.json").write_text(json.dumps({"browser": "bundled"}))
    env = {**os.environ, "THIMBLE_HOME": str(tmp_path / "home"), "PLAYWRIGHT_BROWSERS_PATH": str(tmp_path / "none")}
    p = subprocess.run([sys.executable, "-m", "app.headless"], cwd=BACKEND, env=env, capture_output=True, text=True,
                       timeout=60)
    got = json.loads(p.stdout.strip().splitlines()[-1])
    assert got["ok"] is False and got["why"].startswith("no headless Chromium, so cards are not checked"), p.stderr
    assert got["fix"].startswith(f"Fetch it: {headless.fetch_command(headless.HARNESS)}")
