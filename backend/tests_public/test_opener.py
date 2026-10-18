"""Opening thimble's page without a sign-in code in any argv, output or log (app/opener.py): the redirect file and the
link file each readable by the analyst's account alone, the page's URL escaped from refs a model can steer, the opener
detached so a browser that keeps running holds no pipe, the snap, flatpak and VS Code cases that need the URL itself,
the remote terminals that run no opener (SSH, Eternal Terminal, no display, THIMBLE_NO_BROWSER), tmux's environment read
at the time of the press, and the sweep."""
from __future__ import annotations

import html
import json
import re
import stat
import subprocess
from pathlib import Path

import pytest

from app import opener

CODE = "Zx9-codeThatMustNotLeak_123"
BASE = "http://127.0.0.1:29280"


def _mode(p: Path) -> int:
    return stat.S_IMODE(p.stat().st_mode)


def test_the_redirect_file_is_0600_in_a_0700_folder_and_holds_the_code_once():
    url = opener.with_code(opener.page_url(BASE, "mini", "card:abc"), CODE)
    path = opener.write_redirect(url)
    assert path.parent == opener.home() / "open" and path.suffix == ".html"
    assert _mode(path) == 0o600 and _mode(path.parent) == 0o700 and _mode(opener.home()) == 0o700
    text = path.read_text()
    assert text.count(f"#p={CODE}") == 2, "once in the meta refresh, once in the script"
    for other in path.parent.iterdir():
        assert not other.name.startswith(".tmp-"), "no temporary file is left"
    # another account: neither the folder nor the file grants it anything (the live check G6 runs it as one)
    assert _mode(path) & 0o077 == 0 and _mode(path.parent) & 0o077 == 0


def _refreshes(text: str) -> list[str]:
    return [html.unescape(m) for m in re.findall(r'<meta http-equiv="refresh" content="0;url=([^"]*)">', text)]


@pytest.mark.parametrize("ref", ['"><script>x()</script>', "</script><script>alert(1)</script>"])
def test_a_ref_gives_exactly_one_meta_refresh_to_the_expected_url(ref):
    """Refs a model can steer: percent-encoded from a whitelist in the URL, HTML-escaped in the attribute, JSON-encoded
    (with < and > escaped) in the script; each file has one meta refresh, to the page at that ref, with the code."""
    from urllib.parse import parse_qs, urlsplit

    url = opener.with_code(opener.page_url(BASE, "mini", ref), CODE)
    text = opener.redirect_html(url)
    [target] = _refreshes(text)
    assert target == url
    u = urlsplit(target)
    assert (u.scheme, u.netloc, u.path, u.fragment) == ("http", "127.0.0.1:29280", "/", f"p={CODE}")
    assert parse_qs(u.query) == {"ws": ["mini"], "ref": [ref]}, "the ref comes back whole, in the query"
    assert text.count("<script>") == 1 and text.count("</script>") == 1, "the ref adds no script element"
    assert "<script>x()" not in text and "alert(1)" not in text.split("location.replace(")[0]
    script = text.split("location.replace(", 1)[1].split(")</script>", 1)[0]
    assert json.loads(script) == url


class Spy:
    """subprocess.Popen as the opener calls it: what ran and how, and nothing runs."""

    def __init__(self):
        self.calls: list[tuple[list[str], dict]] = []

    def __call__(self, argv, **kw):
        self.calls.append((list(argv), kw))
        return object()


@pytest.fixture()
def spy(monkeypatch):
    s = Spy()
    monkeypatch.setattr(opener.subprocess, "Popen", s)
    return s


def _bin(tmp_path: Path, *names: str) -> str:
    d = tmp_path / "bin"
    d.mkdir(exist_ok=True)
    for n in names:
        (d / n).write_text("#!/bin/sh\nexit 0\n")
        (d / n).chmod(0o755)
    return str(d)


def test_the_opener_gets_the_redirect_file_s_path_detached_and_never_the_code(spy, tmp_path):
    env = {"PATH": _bin(tmp_path, "xdg-open"), "DISPLAY": ":0"}
    got = opener.open_url(opener.with_code(f"{BASE}/?ws=mini", CODE), env=env)
    assert got.opened and not got.direct and got.file is not None
    [(argv, kw)] = spy.calls
    assert argv == ["xdg-open", str(got.file)] and CODE not in " ".join(argv)
    assert kw["stdin"] is subprocess.DEVNULL and kw["stdout"] is subprocess.DEVNULL
    assert kw["stderr"] is subprocess.DEVNULL and kw["start_new_session"] is True and kw["close_fds"] is True


def test_a_snap_browser_and_vs_code_s_helper_get_the_url_logged_without_the_code(spy, tmp_path, monkeypatch, caplog):
    """D22: a snap or flatpak browser cannot read ~/.thimble, and VS Code's helper forwards the port itself: those get
    the URL in argv, which is logged (never the code)."""
    import logging

    caplog.set_level(logging.INFO, logger="thimble.opener")
    path = _bin(tmp_path, "xdg-open")
    monkeypatch.setattr(opener, "_default_browser", lambda env: "firefox_firefox.desktop")
    url = opener.with_code(f"{BASE}/?ws=mini", CODE)
    got = opener.open_url(url, env={"PATH": path, "DISPLAY": ":0"})
    assert got.direct and spy.calls[-1][0] == ["xdg-open", url]
    path2 = _bin(tmp_path, "code-helper")
    got = opener.open_url(url, env={"PATH": path2, "BROWSER": "code-helper", "VSCODE_IPC_HOOK_CLI": "/tmp/x.sock"})
    assert got.direct and spy.calls[-1][0] == ["code-helper", url]
    lines = [r.getMessage() for r in caplog.records]
    assert any("snap" in ln for ln in lines) and any("VS Code" in ln for ln in lines)
    assert all(CODE not in ln for ln in lines)
