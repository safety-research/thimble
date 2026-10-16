"""Opening thimble's page without a sign-in code in any argv, output or log (app/opener.py): the redirect file and the
link file each readable by the analyst's account alone, the page's URL escaped from refs a model can steer, the opener
detached so a browser that keeps running holds no pipe, the snap, flatpak and VS Code cases that need the URL itself,
the remote terminals that run no opener (SSH, Eternal Terminal, no display, THIMBLE_NO_BROWSER), tmux's environment read
at the time of the press, and the sweep."""
from __future__ import annotations

import html
import json
import os
import re
import stat
import subprocess
import sys
import textwrap
import time
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


def test_the_link_file_is_0600_in_a_0700_folder():
    path = opener.write_link("5e55a000-0000-4000-8000-0000000000b1", f"{BASE}/?ws=mini#p={CODE}",
                             tunnel="ssh -N -L 29280:127.0.0.1:29280 <your ssh host>", et=None, ttl=300, port=29280)
    assert path == opener.home() / "links" / "5e55a000-0000-4000-8000-0000000000b1.json"
    assert _mode(path) == 0o600 and _mode(path.parent) == 0o700
    body = json.loads(path.read_text())
    assert body["url"] == f"{BASE}/?ws=mini#p={CODE}" and body["tunnel"].startswith("ssh -N -L 29280:127.0.0.1:29280 ")
    assert 290 < body["expires"] - time.time() <= 300 and body["port"] == 29280
    assert opener.write_link("../..", "x", tunnel=None, et=None, ttl=1, port=1) is None, "an id with no letter names no file"


def _refreshes(text: str) -> list[str]:
    return [html.unescape(m) for m in re.findall(r'<meta http-equiv="refresh" content="0;url=([^"]*)">', text)]


@pytest.mark.parametrize("ref", ['"><script>x()</script>', "';x()//", "a#p=x&ws=y", "card:abc", "files:agents/x y",
                                 "answer:5e55a000-0000-4000-8000-0000000000b1#s3", "</script><script>alert(1)</script>"])
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


def test_home_and_no_workspace_give_the_page_without_a_ref():
    assert opener.page_url(BASE, "mini", "home") == f"{BASE}/?ws=mini"
    assert opener.page_url(BASE, None, None) == f"{BASE}/"
    assert opener.page_url(BASE, "my ws", "checks") == f"{BASE}/?ws=my%20ws&ref=checks"


@pytest.mark.parametrize("ref,ok", [("x" * 512, True), ("x" * 513, False), ("card:a\nb", False), ("a\x00", False),
                                    ("a\x1b[31m", False), ("a\x7f", False), ("a\x85", False), ("a ", False),
                                    ("card:ok-1_2", True), ("files:données/x", True)])
def test_refs_over_512_characters_or_with_control_characters_are_refused(ref, ok):
    assert (opener.check_ref(ref) is None) is ok


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


def test_browser_entries_are_split_on_the_path_separator_and_take_percent_s(spy, tmp_path):
    path = _bin(tmp_path, "mybrowser")
    env = {"PATH": path, "BROWSER": f"no-such-browser{os.pathsep}mybrowser --new-tab %s", "DISPLAY": ":0"}
    got = opener.open_url(opener.with_code(f"{BASE}/", CODE), env=env)
    [(argv, _)] = spy.calls
    assert argv == ["mybrowser", "--new-tab", str(got.file)] and CODE not in " ".join(argv)


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


def test_a_flatpak_browser_is_known_by_its_exported_desktop_file(tmp_path, monkeypatch):
    d = tmp_path / "flatpak"
    d.mkdir()
    (d / "org.mozilla.firefox.desktop").write_text("")
    monkeypatch.setattr(opener, "FLATPAK_DESKTOPS", (d,))
    monkeypatch.setattr(opener, "SNAP_DESKTOP", tmp_path / "none")
    assert opener.sandboxed_browser({}, "org.mozilla.firefox.desktop") == "flatpak"
    assert opener.sandboxed_browser({}, "firefox.desktop") == ""
    assert opener.sandboxed_browser({}, "chromium_chromium.desktop") == "snap"


def test_no_opener_at_all_opens_nothing_and_writes_no_file(spy, tmp_path):
    got = opener.open_url(f"{BASE}/#p={CODE}", env={"PATH": str(tmp_path / "empty")})
    assert not got.opened and spy.calls == []
    assert not list((opener.home() / "open").glob("*.html"))


def test_the_opener_returns_at_once_while_a_browser_holds_its_descriptors(tmp_path):
    """A $BROWSER that keeps running (here 30 s) holds none of the caller's pipes: a caller reading the press's stdout
    to its end (as the mod's $.process.run does) is done in under 3 s."""
    browser = tmp_path / "slowbrowser"
    browser.write_text("#!/bin/sh\nsleep 30\n")
    browser.chmod(0o755)
    script = textwrap.dedent(f"""
        import sys
        sys.path.insert(0, {str(Path(opener.__file__).parent.parent)!r})
        from app import opener
        got = opener.open_url("http://127.0.0.1:1/#p=x", env={{"PATH": {str(tmp_path)!r} + ":/usr/bin:/bin",
                              "BROWSER": {str(browser)!r}, "DISPLAY": ":0"}})
        print("opened" if got.opened else "not opened")
    """)
    start = time.monotonic()
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=20,
                         env={**os.environ, "THIMBLE_HOME": str(opener.home())})
    took = time.monotonic() - start
    subprocess.run(["pkill", "-f", str(browser)], check=False)
    assert out.stdout.strip() == "opened" and took < 3.0, (out.stdout, out.stderr, took)


def test_the_sweep_deletes_what_opens_left_after_two_minutes():
    d = opener.private_dir(opener.open_dir())
    old, new, claim, keep = d / "old.html", d / "new.html", d / "abcdefghijkl.claimed", d / "press.lock"
    for p in (old, new, claim, keep):
        p.write_text("x")
    past = time.time() - opener.SWEEP_S - 5
    for p in (old, claim, keep):
        os.utime(p, (past, past))
    assert opener.sweep() == 2
    assert not old.exists() and not claim.exists() and new.exists() and keep.exists()


def test_claimed_deletes_the_redirect_file_and_writes_the_mark_for_a_valid_id_only():
    oid = opener.new_id()
    page = opener.write_redirect(f"{BASE}/#p={CODE}", oid)
    assert opener.claimed(oid) and not page.exists() and opener.claim_path(oid).exists()
    assert not opener.claimed("../../etc/passwd") and not opener.claimed("") and not opener.claimed(None)


def _remote(env: dict, platform: str = "linux") -> opener.Remote:
    return opener.remote({"PATH": "/nonexistent", **env}, platform=platform)


def test_remote_detection(monkeypatch):
    monkeypatch.setattr(opener, "_ancestors", lambda pid, limit=64: [])
    ssh = _remote({"SSH_CONNECTION": "10.1.2.3 5000 10.1.2.4 22", "DISPLAY": "localhost:10.0"})
    assert ssh.remote and ssh.ssh and ssh.rows and not ssh.et, "SSH with a forwarded DISPLAY is still remote"
    assert opener.tunnels(29280, ssh, {}) == ("ssh -N -L 29280:127.0.0.1:29280 <your ssh host>", None), \
        "never the address in SSH_CONNECTION"
    assert opener.tunnels(29280, ssh, {"THIMBLE_SSH_HOST": "devbox"})[0] == "ssh -N -L 29280:127.0.0.1:29280 devbox"
    assert opener.tunnels(29280, ssh, {"THIMBLE_SSH_HOST": "a; rm -rf ~"})[0].endswith("<your ssh host>"), \
        "a host that is no host name is not put into a command"
    assert _remote({"SSH_TTY": "/dev/pts/3", "DISPLAY": ":0"}).remote
    et = _remote({"ET_VERSION": "6.2.9", "DISPLAY": ":0"})
    assert et.remote and et.et and opener.tunnels(29280, et, {"THIMBLE_SSH_HOST": "box"}) == (
        "ssh -N -L 29280:127.0.0.1:29280 box", "et -t 29280:29280 box")
    monkeypatch.setattr(opener, "_ancestors", lambda pid, limit=64: ["bash", "etterminal", "systemd"])
    assert _remote({"DISPLAY": ":0"}).et, "an etterminal ancestor"
    monkeypatch.setattr(opener, "_ancestors", lambda pid, limit=64: [])
    vs = _remote({"VSCODE_IPC_HOOK_CLI": "/run/user/1/vscode-ipc.sock", "BROWSER": "/x/helper.sh",
                  "SSH_CONNECTION": "10.1.2.3 5000 10.1.2.4 22"})
    assert not vs.remote and vs.vscode, "VS Code's helper opens the page on the analyst's computer"
    assert _remote({}).remote and _remote({}).why == "no display and no $BROWSER"
    assert not _remote({}, platform="darwin").remote
    assert not _remote({"DISPLAY": ":0"}).remote and not _remote({"WAYLAND_DISPLAY": "wayland-0"}).remote
    nob = _remote({"THIMBLE_NO_BROWSER": "1", "DISPLAY": ":0", "SSH_CONNECTION": "x"})
    assert nob.remote and not nob.rows and opener.tunnels(29280, nob, {}) == (None, None), "no SSH rows"


def test_inside_tmux_the_ssh_and_display_values_come_from_show_environment_at_the_press(tmp_path, monkeypatch):
    """tmux keeps the environment of its first attach in each pane: a session attached locally after an SSH attach
    still has SSH_CONNECTION. The press asks tmux (show-environment) what holds now."""
    monkeypatch.setattr(opener, "_ancestors", lambda pid, limit=64: [])
    d = tmp_path / "bin"
    d.mkdir()
    out = tmp_path / "tmux-out"
    (d / "tmux").write_text(f"#!/bin/sh\n/bin/cat {out}\n")
    (d / "tmux").chmod(0o755)
    env = {"PATH": str(d), "TMUX": "/tmp/tmux-1/default,1,0", "SSH_CONNECTION": "10.0.0.1 1 10.0.0.2 22",
           "SSH_TTY": "/dev/pts/1"}
    out.write_text("-SSH_CONNECTION\nDISPLAY=:0\nSSH_AUTH_SOCK=/x\n")
    got = opener.remote(env, platform="linux")
    assert not got.remote, "re-attached locally: tmux removed SSH_CONNECTION and has a DISPLAY; SSH_TTY is stale"
    out.write_text("SSH_CONNECTION=10.0.0.1 1 10.0.0.2 22\n-DISPLAY\n")
    assert opener.remote({**env, "SSH_CONNECTION": "", "DISPLAY": ":0"}, platform="linux").remote, \
        "attached over SSH now, though the pane's own environment says otherwise"
    assert opener.tmux_env({"PATH": str(d)}) == {}, "outside tmux nothing is asked"


def test_doctor_lines_name_the_opener_or_why_none_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(opener, "_ancestors", lambda pid, limit=64: [])
    monkeypatch.setattr(opener, "_default_browser", lambda env: "")
    assert opener.doctor_lines({"PATH": _bin(tmp_path, "xdg-open"), "DISPLAY": ":0"}) == [
        "browser: `thimble open` runs xdg-open on a redirect file that only you can read"]
    [line] = opener.doctor_lines({"PATH": "/x", "SSH_CONNECTION": "a b c d"})
    assert "remote (an SSH session)" in line and "tunnel command" in line
    [line] = opener.doctor_lines({"PATH": str(tmp_path / "none"), "DISPLAY": ":0"})
    assert line.startswith("browser: no opener found")
