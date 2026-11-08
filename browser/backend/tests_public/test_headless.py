"""The headless Chromium the workbench draws cards in, and loads views in (app/headless.py): where it finds no system
browser, Playwright's, one build for the server's Playwright and one for the page's. Its check, which thimble's install,
thimble update and thimble doctor ask (python -m app.headless), says what goes unchecked without it and the commands that
fetch it, and with --fetch runs them; thimble-browser's start (--start) downloads what is missing and says so; the
server's warning names the command too. Playwright's browsers folder, its browsers.json and the downloads are made up
here."""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from app import headless, userconf

BACKEND = Path(__file__).resolve().parents[1]
UNCHECKED = "cards are not checked; views are checked without loading their page, and screenshots are unavailable"
# a made-up download of a build: the folder Playwright unpacks it into (argv 1), and the file it leaves there last
# (argv 2), once the build is whole
UNPACKS = "import os, sys; os.makedirs(sys.argv[1], exist_ok=True); open(os.path.join(*sys.argv[1:3]), 'w').close()"


def unpack(browsers: Path, rev: str) -> list[str]:
    """The made-up command that downloads build `rev` into Playwright's browsers folder, whole."""
    return [sys.executable, "-c", UNPACKS, str(browsers / f"chromium_headless_shell-{rev}"), headless.INSTALLED]


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
    # the server's build there but part-way, as a download stopped while it unpacked leaves it: Playwright fetches it
    # again, and so does the check
    (browsers / "chromium_headless_shell-1187").mkdir(parents=True)
    assert headless.check()["fix"] == f"Fetch it: {harness} && {pages}"
    # the server's build whole, the page's not there
    subprocess.run(unpack(browsers, "1187"), check=True)
    assert headless.check() == {"ok": False, "fix": f"Fetch it: {pages}", "why": "no headless Chromium, so views are "
                                "checked without loading their page, and screenshots are unavailable"}
    subprocess.run(unpack(browsers, "1193"), check=True)
    assert headless.check() == {"ok": True}
    # a system browser, which the workbench uses first, needs none
    shutil.rmtree(browsers)
    monkeypatch.setattr(userconf, "system_browser", lambda: "/made-up/chrome")
    assert headless.check() == {"ok": True}


def test_the_check_with_fetch_fetches_each_build_that_is_missing_and_says_why_a_download_failed(browsers, tmp_path,
                                                                                                monkeypatch):
    ran: list[str] = []

    def fetches(kind: str) -> tuple[list[str], Path]:
        ran.append(kind)
        return unpack(browsers, "1187" if kind == headless.HARNESS else "1193"), tmp_path

    monkeypatch.setattr(headless, "fetch_argv", fetches)
    assert headless.check(fetch=True) == {"ok": True} and ran == [headless.HARNESS, headless.PAGES]
    assert headless.check(fetch=True) == {"ok": True} and len(ran) == 2
    # a download that fails, as Playwright says it: the cause first, on stderr, then that the download failed
    shutil.rmtree(browsers)
    fails =("import sys; print('Error: connect ECONNREFUSED 127.0.0.1:9', file=sys.stderr); "
             "print('Failed to install browsers'); print('Error: Failed to download'); sys.exit(1)")
    monkeypatch.setattr(headless, "fetch_argv", lambda kind: ([sys.executable, "-c", fails], tmp_path))
    got = headless.check(fetch=True)
    assert not got["ok"] and got["why"] == (f"no headless Chromium, so {UNCHECKED} (its download failed: connect "
                                            "ECONNREFUSED 127.0.0.1:9)")


def test_thimble_browser_s_start_downloads_what_is_missing_once_and_names_the_command_when_it_cannot(browsers, tmp_path,
                                                                                                    monkeypatch,
                                                                                                    capsys):
    """thimble-browser's start (at_start), as for an install that thimble 0.10.12 or before made or updated, which
    fetched no Chromium: one line that says it downloads and about how big, then the fetch, and nothing at the next
    start; a build left part-way, as by Ctrl-C while it unpacked, downloads again at the next. A download that fails
    says why on stderr, with the command that fetches it on a line of its own."""
    ran: list[str] = []

    def fetches(kind: str) -> tuple[list[str], Path]:
        ran.append(kind)
        return unpack(browsers, "1187" if kind == headless.HARNESS else "1193"), tmp_path

    monkeypatch.setattr(headless, "fetch_argv", fetches)
    line = "thimble-browser: downloading the headless Chromium the workbench draws cards in, once (about {} MB)..."
    headless.at_start()
    out, err = capsys.readouterr()
    assert out.splitlines() == [line.format(200)] and err == "" and ran == [headless.HARNESS, headless.PAGES]
    headless.at_start()
    assert capsys.readouterr() == ("", "") and len(ran) == 2
    (browsers / "chromium_headless_shell-1193" / headless.INSTALLED).unlink()
    headless.at_start()
    out, err = capsys.readouterr()
    assert out.splitlines() == [line.format(100)] and err == "" and ran[2:] == [headless.PAGES]
    # the page's build gone, and its download fails as Playwright says it
    shutil.rmtree(browsers / "chromium_headless_shell-1193")
    fails =("import sys; print('Error: getaddrinfo ENOTFOUND cdn.playwright.dev', file=sys.stderr); "
             "print('Failed to install browsers'); sys.exit(1)")
    monkeypatch.setattr(headless, "fetch_argv", lambda kind: ([sys.executable, "-c", fails], tmp_path))
    headless.at_start()
    out, err = capsys.readouterr()
    assert out.splitlines() == [line.format(100)]
    assert err.splitlines() == [
        "thimble-browser: no headless Chromium, so views are checked without loading their page, and screenshots are "
        "unavailable (its download failed: getaddrinfo ENOTFOUND cdn.playwright.dev). Fetch it, then start "
        "thimble-browser again:",
        f"  {headless.fetch_command(headless.PAGES)}"]


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


def test_the_start_s_check_prints_nothing_where_it_has_nothing_to_download(tmp_path):
    """python -m app.headless --start, as thimble-browser runs it: with the browser off in thimble's config, the start
    downloads nothing and its terminal gets no line, not the install's answer in JSON."""
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "config.json").write_text(json.dumps({"browser": "off"}))
    env = {**os.environ, "THIMBLE_HOME": str(tmp_path / "home"), "PLAYWRIGHT_BROWSERS_PATH": str(tmp_path / "none")}
    p = subprocess.run([sys.executable, "-m", "app.headless", "--start"], cwd=BACKEND, env=env, capture_output=True,
                       text=True, timeout=60)
    assert (p.returncode, p.stdout, p.stderr) == (0, "", "")
