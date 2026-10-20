"""The sandbox (cards/sandbox.py): a card's code reads the folder and nothing else, writes nothing that lasts, reaches no
network and sees none of the server's environment, on Linux (bubblewrap) and macOS (Seatbelt), through Anthropic's
sandbox runtime (srt). The end-to-end tests run where a sandbox works; the macOS rules, and the Seatbelt profile srt
makes of them, are tested on any machine with Node and srt."""
import asyncio
import functools
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from thimble_browser import home as home_mod
from thimble_browser import sandbox_check, views
from thimble_browser.cards import sandbox

ERR = "application/vnd.thimble.error+json"
LINUX = sys.platform.startswith("linux")
works = pytest.mark.skipif(sandbox.available() is None, reason="no sandbox on this machine")
on_linux = pytest.mark.skipif(not (LINUX and sandbox.available()), reason="the Linux sandbox is not here")
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


def test_on_macos_the_rules_hide_where_files_are_and_show_the_run_its_own_paths():
    r = mac_rules()
    fs = r["filesystem"]
    assert paths(fs["denyRead"]) == list(sandbox.MACOS_HIDDEN), "the home and the workspaces lie in /Users"
    assert paths(fs["allowRead"]) == [f"{H}/notes", RUN, f"{H}/code/server/.venv",
                                      f"{UV}/cpython-3.12-macos-aarch64-none",
                                      f"{UV}/cpython-3.12.13-macos-aarch64-none", f"{H}/code/server/thimble_browser/cards"]
    assert paths(fs["allowWrite"]) == [RUN]
    assert paths(fs["denyWrite"]) == ["/tmp/claude", "/private/tmp/claude"]
    assert r["network"] == {"allowedDomains": [], "deniedDomains": []} and "bwrapPath" not in r


def test_on_macos_a_folder_that_is_the_home_still_hides_the_workspaces():
    fs = mac_rules(corpus=H)["filesystem"]
    assert paths(fs["denyRead"])[-2:] == [H, f"{H}/.thimble-browser"] and H in paths(fs["allowRead"])


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
    got = subprocess.run([shutil.which("node"), "--import", macos, str(sandbox.LAUNCHER), "--print",
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


def test_bwrap_sh_adds_its_rules_just_before_the_command(tmp_path):
    fake = tmp_path / "bwrap"
    fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
    fake.chmod(0o755)
    env = {"PATH": f"{tmp_path}:/usr/bin:/bin"}
    got = subprocess.run([str(sandbox.BWRAP), "--ro-bind", "/", "/", "--args", "9", "--", "bash", "-c", "x -- y"],
                         capture_output=True, text=True, env=env)
    assert got.stdout.splitlines() == ["--ro-bind", "/", "/", "--args", "9", "--unshare-ipc", "--tmpfs", "/tmp/claude",
                                       "--", "bash", "-c", "x -- y"]
    got = subprocess.run([str(sandbox.BWRAP), "--ro-bind", "/", "/"], capture_output=True, text=True, env=env)
    assert got.returncode == 3 and got.stdout == ""


@pytest.fixture
def fresh_status():
    sandbox.status.cache_clear()
    yield
    sandbox.status.cache_clear()


def test_status_says_what_a_mac_or_a_linux_needs(fresh_status, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(shutil, "which", lambda name: None)
    st = sandbox.status()
    assert st.kind is None and "Node is not installed" in st.why and "brew install node" in st.fix
    sandbox.status.cache_clear()
    monkeypatch.setattr(shutil, "which", lambda name: f"/usr/bin/{name}" if name == "node" else None)
    monkeypatch.setattr(sandbox, "node_version", lambda exe: (20, 19))
    assert "Node 20.19 is too old" in sandbox.status().why
    sandbox.status.cache_clear()
    monkeypatch.setattr(sandbox, "node_version", lambda exe: (24, 1))
    monkeypatch.setattr(sandbox, "PACKAGE", tmp_path / "missing")
    st = sandbox.status()
    assert "not installed" in st.why and "scripts/install.sh" in st.fix
    sandbox.status.cache_clear()
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sandbox, "installed", sandbox.pinned)
    st = sandbox.status()
    assert st.why == "bubblewrap is not installed" and "apt install bubblewrap" in st.fix


async def test_without_a_sandbox_code_does_not_run_and_the_card_says_why(folder, monkeypatch):
    monkeypatch.setattr(sandbox, "status", lambda: sandbox.Status(None, "Node is not installed", "Install Node."))
    r = await sandbox.run_code("open('new.txt', 'w')", folder, timeout=30)
    assert r["status"] == "error" and r["outputs"][-1][ERR]["ename"] == "NoSandbox"
    assert "Node is not installed. Install Node." in r["outputs"][-1][ERR]["evalue"]
    assert not (folder / "new.txt").exists()


def test_a_view_s_folder_in_the_workspaces_is_copied_into_the_run_s_folder(home, tmp_path):
    view = home / "workspaces" / "w" / "views" / "runs"
    view.mkdir(parents=True)
    (view / "reader.py").write_text("x = 1\n")
    other = tmp_path / "kit"
    other.mkdir()
    run = tmp_path / "run"
    req, shown = sandbox.copy_in(run, {"view": str(view), "kernel": str(other / "k.py"), "op": "check"}, [view, other])
    assert shown == [other.resolve()] and req["kernel"] == str(other / "k.py") and req["op"] == "check"
    assert Path(req["view"]).parent == run / "read" and (Path(req["view"]) / "reader.py").read_text() == "x = 1\n"


# ---------------------------------------------------------------- end to end, where a sandbox works


@works
async def test_a_table(folder):
    r = await sandbox.run_code("import pandas as pd\npd.read_csv('results.csv').set_index('run')", folder, timeout=30)
    assert r["status"] == "ok" and r["frame"]["rows"] == [["a", "merged"], ["b", "failed"]]


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
async def test_a_run_past_its_time_is_stopped(folder):
    r = await sandbox.run_code("import time\ntime.sleep(10)", folder, timeout=1)
    assert r["status"] == "error" and r["outputs"][-1][ERR]["ename"] == "TimeoutError"


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


@works
async def test_a_folder_that_holds_the_workspaces_does_not_show_them(tmp_path, home):
    home.mkdir(parents=True, exist_ok=True)
    (home / "secret.txt").write_text("thimble browser's own\n")
    code = ("import json, os\nout = {}\n"
            "try:\n    out['list'] = os.listdir('home')\nexcept OSError as e:\n    out['list'] = []\n"
            "try:\n    out['read'] = open('home/secret.txt').read()\nexcept OSError as e:\n    out['read'] = e.strerror\n"
            "print(json.dumps(out))")
    r = await sandbox.run_code(code, tmp_path, timeout=30)
    got = json.loads(stdout(r))
    assert "secret.txt" not in got["list"] and got["read"] != "thimble browser's own\n"


@works
async def test_a_view_s_reader_runs_when_the_folder_holds_the_workspaces(tmp_path, home):
    ws = home_mod.open_folder(tmp_path)
    reader = ("def build_index(paths):\n    return [l for p in paths for l in open(p)]\n"
              "def records(index, query):\n    return {'n': len(index)}\n"
              "def resolve(index, locator):\n    return None\n")
    views.write_file(ws, "lines", "view.json", json.dumps({"name": "Lines", "scope": ["files/*.csv"]}))
    views.write_file(ws, "lines", "reader.py", reader)
    (tmp_path / "files").mkdir()
    (tmp_path / "files" / "a.csv").write_text("x\n1\n2\n")
    got = await views.run_reader(ws, "lines", tmp_path, "records", {})
    assert got == {"ok": True, "result": {"n": 3}}, got


@works
async def test_a_folder_named_like_a_pattern_is_read(tmp_path):
    folder = tmp_path / "[draft] notes?"
    folder.mkdir()
    (folder / "a.csv").write_text("x\n1\n")
    r = await sandbox.run_code("import pandas as pd\npd.read_csv('a.csv')", folder, timeout=30)
    assert r["status"] == "ok" and r["frame"]["rows"] == [[1]]


@on_linux
async def test_on_linux_a_run_has_its_own_tmp_and_ipc_and_srt_s_temp_folder_is_empty(folder):
    code = ("import json, os\nprint(json.dumps({'tmp': os.listdir('/tmp'), 'claude': os.listdir('/tmp/claude'), "
            "'ipc': os.readlink('/proc/self/ns/ipc'), 'TMPDIR': os.environ['TMPDIR'], 'etc': os.listdir('/etc')}))")
    r = await sandbox.run_code(code, folder, timeout=30)
    got = json.loads(stdout(r))
    on_the_way = {folder.relative_to("/tmp").parts[0]} if folder.is_relative_to("/tmp") else set()
    assert set(got["tmp"]) <= {"claude", Path(got["TMPDIR"]).name, *on_the_way}
    assert got["claude"] == [] and got["ipc"] != os.readlink("/proc/self/ns/ipc")
    assert set(got["etc"]) <= {"ld.so.cache", "fonts", "alternatives", "localtime"}


@on_linux
async def test_on_linux_a_process_a_run_leaves_behind_is_stopped_with_it(folder):
    marker = f"{time.time() % 1000:.3f}"
    code = f"import subprocess, time\nsubprocess.Popen(['sleep', '{marker}'], start_new_session=True)\ntime.sleep(60)"
    r = await sandbox.run_code(code, folder, timeout=2)
    assert r["outputs"][-1][ERR]["ename"] == "TimeoutError"
    left = "?"
    for _ in range(20):
        left = subprocess.run(["pgrep", "-f", f"sleep {marker}"], capture_output=True, text=True).stdout.strip()
        if not left:
            break
        await asyncio.sleep(0.25)
    assert left == ""
