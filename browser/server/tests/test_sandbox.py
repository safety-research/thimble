"""The sandbox (cards/sandbox.py): a card's code reads the folder and nothing else, writes nothing that lasts, reaches no
network and sees none of the server's environment, on Linux (bubblewrap) and macOS (Seatbelt), through Anthropic's
sandbox runtime (srt). The end-to-end tests run where a sandbox works; the macOS rules, and the Seatbelt profile srt
makes of them, are tested on any machine with Node and srt."""
import functools
import json
import os
import shutil
import subprocess
import sys

import pytest

from thimble_browser import sandbox_check
from thimble_browser.cards import sandbox

ERR = "application/vnd.thimble.error+json"
LINUX = sys.platform.startswith("linux")
works = pytest.mark.skipif(sandbox.status().kind is None, reason="no sandbox on this machine")
srt_installed = pytest.mark.skipif(shutil.which("node") is None or sandbox.installed() != sandbox.pinned(),
                                   reason="needs Node and srt in server/sandbox (npm ci there)")
H = "/Users/t"
UV = f"{H}/.local/share/uv/python"
RUN = "/private/var/folders/xy/T/thimble-run-1"


def stdout(r: dict) -> str:
    return "".join(o.get("text/plain", "") for o in r["outputs"] if o.get("_stream") == "stdout")


def paths(entries: list[dict]) -> list[str]:
    assert all(e["literal"] for e in entries), "every path is a literal, never a pattern"
    return [e["path"] for e in entries]


def mac_rules(corpus: str = f"{H}/notes") -> dict:
    return sandbox.rules(platform="darwin", corpus=corpus, run_dir=RUN,
                         python=[f"{H}/code/server/.venv", f"{UV}/cpython-3.12-macos-aarch64-none",
                                 f"{UV}/cpython-3.12.13-macos-aarch64-none"],
                         read=[f"{H}/code/server/thimble_browser/cards"], home_dir=H,
                         workspaces=f"{H}/.thimble-browser")


# ---------------------------------------------------------------- the rules, on any machine


def test_on_linux_the_rules_hide_everything_but_the_system_the_python_and_the_folder():
    r = sandbox.rules(platform="linux", corpus="/data/notes", run_dir="/tmp/thimble-run-1",
                      python=["/srv/app/.venv", "/home/t/.local/share/uv/python/cpython-3.12.13-linux-x86_64-gnu"],
                      home_dir="/home/t", workspaces="/home/t/.thimble-browser", seccomp="/srv/app/seccomp",
                      bwrap="/srv/app/bwrap.sh")
    fs = r["filesystem"]
    assert paths(fs["denyRead"]) == ["/"]
    shown = paths(fs["allowRead"])
    assert "/usr" in shown and "/srv/app/seccomp" in shown and shown[-4:] == [
        "/data/notes", "/tmp/thimble-run-1", "/srv/app/.venv",
        "/home/t/.local/share/uv/python/cpython-3.12.13-linux-x86_64-gnu"]
    assert paths(fs["allowWrite"]) == ["/tmp/thimble-run-1"] and r["bwrapPath"] == "/srv/app/bwrap.sh"
    assert r["network"]["allowedDomains"] == []
    home_folder = sandbox.rules(platform="linux", corpus="/home/t", run_dir="/tmp/r", python=[], home_dir="/home/t",
                                workspaces="/home/t/.thimble-browser")["filesystem"]
    assert "/home/t/.thimble-browser" in paths(home_folder["denyRead"])


@srt_installed
def test_srt_makes_a_seatbelt_profile_of_the_macos_rules_with_no_network_and_the_workspaces_hidden():
    """With the platform mocked as macOS, the profile srt makes (run.mjs --print) denies everything by default, allows
    no network at all (not 127.0.0.1, not a Unix socket), denies reads under /Users before it allows the folder,
    denies the workspaces after that, and writes only the run's folder (srt's own temp folder denied last)."""
    macos = "data:text/javascript,Object.defineProperty(process,'platform',{value:'darwin'})"
    got = subprocess.run([shutil.which("node"), "--import", macos, str(sandbox.LAUNCHER), "--srt", str(sandbox.SRT_DIR), "--print",
                          json.dumps(mac_rules(corpus=H)), "--", "/usr/bin/env", "-i", "python3", "-I", "runner.py"],
                         capture_output=True, text=True, timeout=60, cwd="/",
                         env={"PATH": os.environ["PATH"], "HOME": RUN, "CLAUDE_CODE_TMPDIR": RUN})
    assert got.returncode == 0, got.stderr
    profile = got.stdout
    assert "/usr/bin/sandbox-exec -p" in profile and "(deny default" in profile
    assert "(allow network" not in profile and "AF_UNIX" not in profile

    def at(clause: str, sub: str, start: int = 0) -> int:
        i = profile.index(clause, start)
        return profile.index(f'(subpath "{sub}")', i)

    users_denied = at("(deny file-read*", "/Users")
    home_shown = at("(allow file-read*\n", H, users_denied)
    workspaces_denied = at("(deny file-read*", f"{H}/.thimble-browser", home_shown)
    assert users_denied < home_shown < workspaces_denied
    writes = profile[profile.index("; File write"):]
    start = writes.index("(allow file-write*")
    allowed = writes[start:writes.index("(with message", start)]
    assert f'(subpath "{RUN}")' in allowed and f'(subpath "{H}")' not in allowed
    assert writes.index('(deny file-write*\n  (subpath "/tmp/claude")') > start


async def test_without_a_sandbox_code_does_not_run_and_the_card_says_why(folder, monkeypatch):
    monkeypatch.setattr(sandbox, "status", lambda: sandbox.Status(None, "Node is not installed", "Install Node."))
    r = await sandbox.run_code("open('new.txt', 'w')", folder, timeout=30)
    assert r["status"] == "error" and r["outputs"][-1][ERR]["ename"] == "NoSandbox"
    assert "Node is not installed. Install Node." in r["outputs"][-1][ERR]["evalue"]
    assert not (folder / "new.txt").exists()


# ---------------------------------------------------------------- end to end, where a sandbox works


@works
async def test_no_home_no_environment_no_writes_no_network(folder, monkeypatch):
    monkeypatch.setenv("SOME_TOKEN", "x")
    r = await sandbox.run_code("import os\nprint(sorted(os.environ))", folder, timeout=30)
    assert r["status"] == "ok" and "SOME_TOKEN" not in stdout(r)
    r = await sandbox.run_code("open('new.txt', 'w')", folder, timeout=30)
    assert r["status"] == "error" and not (folder / "new.txt").exists()
    r = await sandbox.run_code("import socket\nsocket.create_connection(('1.1.1.1', 80), timeout=3)", folder, timeout=30)
    assert r["status"] == "error"
    r = await sandbox.run_code("import os\nos.listdir(os.path.expanduser('~'))", folder, timeout=30)
    assert "files" not in str(r["outputs"])


@works
async def test_the_self_test_passes(home):
    results = await sandbox_check.run_checks()
    assert [name for ok, name, _ in results if not ok] == [], results
    assert len(results) == len(sandbox_check.CHECKS)


@works
async def test_the_self_test_fails_each_check_a_run_without_the_sandbox_breaks(home, tmp_path, monkeypatch):
    """Run unsandboxed, the checks that guard the folder, the home folder, the workspaces, the network and the next
    run fail: they do not pass whatever happens. (The internet is a closed port on 127.0.0.1 here.)"""
    fake_home = tmp_path / "ada"
    fake_home.mkdir()
    (fake_home / ".profile").write_text("# made up\n")
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(sandbox_check, "INTERNET", ("127.0.0.1", 9))
    monkeypatch.setattr(sandbox, "status", lambda: sandbox.Status(None, "off for this test"))
    monkeypatch.setattr(sandbox, "run_code", functools.partial(sandbox.run_code, unsandboxed=True))
    failed = {name for ok, name, _ in await sandbox_check.run_checks() if not ok}
    assert failed == {"cannot write into the folder", "cannot read the home folder",
                      "cannot read thimble browser's workspaces", "cannot reach the network",
                      "keeps nothing between runs"}
