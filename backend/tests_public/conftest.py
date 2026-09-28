"""Suite-wide isolation. Every test runs against a synthetic corpus written to a temporary folder, with its workspaces,
dev files and thimble home under its own tmp dir, no model or Claude Code call, and no process it did not start."""
import atexit
import os
import shutil
import signal
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from mini_corpus import write_mini  # noqa: E402

# Nothing reads a credential: model calls and Claude Code sessions are faked wherever a test reaches them.
os.environ.setdefault("THIMBLE_SKIP_KEY", "1")
# No headless Chromium per test app, no card check after every add_card and no review after every view build; the
# tests of the renderer, the check and the review turn them on.
os.environ.setdefault("THIMBLE_RENDER", "off")
os.environ.setdefault("THIMBLE_CARD_CHECK", "off")
os.environ.setdefault("THIMBLE_VIEW_REVIEW", "off")
# The suite's corpora are the synthetic ones, always: an inherited THIMBLE_DATA_DIR would point config.DATA_DIR at
# real corpora. conftest is imported before any app module, so config reads this value.
DATA = Path(tempfile.mkdtemp(prefix="thimble-tests-data-")).resolve()
MINI = write_mini(DATA / "mini")
atexit.register(shutil.rmtree, DATA, True)
os.environ["THIMBLE_DATA_DIR"] = str(DATA)
# The suite tests the default model speed; a test that wants another value sets it with monkeypatch.
os.environ.pop("THIMBLE_MODEL_SPEED", None)
# The Host names httpx.ASGITransport and TestClient send (main.ALLOWED_HOSTS is read at import).
os.environ.setdefault("THIMBLE_ALLOWED_HOSTS", "127.0.0.1,localhost,testserver,test,t")

import pytest  # noqa: E402


@pytest.fixture()
def mini_dir() -> Path:
    """The generated `mini` corpus. Tests that write into a corpus copy it first."""
    return MINI


@pytest.fixture()
def workspaces_tmp(tmp_path, monkeypatch):
    """Point WORKSPACES_DIR at a temp dir for a test."""
    from app import config

    monkeypatch.setattr(config, "WORKSPACES_DIR", tmp_path)
    return tmp_path


@pytest.fixture(autouse=True)
def _workspaces_off_the_checkout(tmp_path, monkeypatch):
    """Every test's workspaces live under its own tmp dir. config.WORKSPACES_DIR defaults to the checkout's
    workspaces/, which a running server may be using."""
    from app import config

    monkeypatch.setattr(config, "WORKSPACES_DIR", tmp_path / "workspaces")


@pytest.fixture(autouse=True)
def _thimble_home_off_the_user(tmp_path, monkeypatch):
    """Every test's thimble home is its own tmp dir, so what the server records there (terminal-first's consent and the
    changes it made, claude_changes) never reaches the user's. A test's own THIMBLE_HOME still wins."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thimble-home"))


PLUGIN_TOKEN = "t0ken-of-the-test-server"


@pytest.fixture()
def plugin_headers():
    """A function giving the headers thimble's plugin sends to the routes only it may call (app/hook_auth.py), for a
    fresh nonce each time, proving the token this fixture records in the test's server.json."""
    import json

    from app import hook_auth

    home = Path(os.environ["THIMBLE_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "server.json").write_text(json.dumps({"token": PLUGIN_TOKEN}))
    return lambda: hook_auth.headers(PLUGIN_TOKEN, os.urandom(8).hex())


@pytest.fixture()
def consented():
    """The analyst agreed to terminal-first's changes to Claude Code's files (claude_changes.consent)."""
    from app import claude_changes

    claude_changes.consent()


@pytest.fixture(autouse=True)
def _dev_dir_off_the_checkout(tmp_path, monkeypatch):
    """The dev panel's tickets and feedback live under the test's tmp dir, never the checkout's dev/. A test's own
    monkeypatch of dev.DEV_DIR still wins, since it runs after this one."""
    from app import dev

    monkeypatch.setattr(dev, "DEV_DIR", tmp_path / "dev")


@pytest.fixture(autouse=True)
def _statusline_left_alone(monkeypatch):
    """Terminal-first mode writes the corpus folder's statusline (bg_session.sync_statusline), and the suite's corpora are
    shared by every test, so the tests that turn the mode on leave the folder alone. test_bg_sessions.py tests the
    statusline on a copy."""
    from app import bg_session

    monkeypatch.setattr(bg_session, "sync_statusline", lambda c: None)


@pytest.fixture(autouse=True)
def _view_tickets_held(monkeypatch):
    """A view proposal queues a ticket at once, and a ticket that starts runs a real `claude --bg`. Every test holds
    them queued with an empty pool."""
    from app import dev

    monkeypatch.setattr(dev, "VIEW_POOL", 0)
    monkeypatch.setattr(dev, "_view_runs", {})
    monkeypatch.setattr(dev, "_view_queue", [])
    monkeypatch.setattr(dev, "_view_stopping", {})
    monkeypatch.setattr(dev, "_closing", False)


@pytest.fixture(autouse=True)
def _no_held_events():
    """The quiet events channel.post holds for the next event, and the messages session.relay waits to see main pass
    on, are module state: none carries over from another test."""
    from app import channel, session

    channel._held.clear()
    session._relays.clear()
    yield
    channel._held.clear()
    session._relays.clear()


@pytest.fixture(autouse=True)
def _no_keychain(monkeypatch):
    """No test asks the machine's macOS Keychain for a Claude Code login; test_keychain_login.py tests the probe with
    stubbed commands through config.keychain_login as the module defines it."""
    from app import config

    monkeypatch.setattr(config, "keychain_login", lambda: "")


@pytest.fixture(autouse=True)
def _no_rate_limit_retry_wait(monkeypatch):
    """model.structured waits before its one 429 retry; tests wait 0 s."""
    from app import model

    monkeypatch.setattr(model, "RATE_LIMIT_RETRY_S", 0.0)


@pytest.fixture(autouse=True)
def _no_backoff_wait(monkeypatch):
    """retry.with_retries waits between retries of a transient failure; tests wait 0 s and the retries still run."""
    from app import retry

    async def no_wait(s: float) -> None:
        return None

    monkeypatch.setattr(retry, "_sleep", no_wait)


@pytest.fixture(autouse=True)
def _no_plugin_list(monkeypatch):
    """launch_args asks `claude plugin list` which plugin copy main loads (cli.installed_copy). Tests load plugin/; the
    tests of that lookup put the real function back with a stand-in `claude`."""
    from app import cli

    monkeypatch.setattr(cli, "installed_copy", lambda cwd: None)


@pytest.fixture(autouse=True)
def _claude_stand_in(tmp_path_factory, monkeypatch):
    """A stand-in `claude` first on PATH, for the test and the processes it starts, which prints the version thimble is
    tested with for `--version` and nothing otherwise. `up` warns when claude is missing or older than that version, and
    the tests must pass the same on a machine without Claude Code. A test that sets PATH itself still wins."""
    from app import cli

    bin_dir = tmp_path_factory.getbasetemp() / "claude-stand-in"
    exe = bin_dir / "claude"
    if not exe.exists():
        bin_dir.mkdir(exist_ok=True)
        exe.write_text(f'#!/bin/sh\n[ "$1" = --version ] && echo "{cli.TESTED_CLAUDE_CODE} (Claude Code)"\nexit 0\n')
        exe.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")


@pytest.fixture()
def nested_data(tmp_path, monkeypatch):
    """A DATA_DIR holding the flat `mini` corpus plus `nested`, whose runs `run-a/` and `run-b/` are copies of mini.
    Returns the data dir."""
    import json

    from app import config

    data = tmp_path / "data"
    shutil.copytree(MINI, data / "mini")
    nested = data / "nested"
    for run in ("run-a", "run-b"):
        shutil.copytree(MINI, nested / run)
    (nested / "manifest.json").write_text(json.dumps({"name": "nested", "runs": ["run-a", "run-b"]}))
    (nested / "README.md").write_text("# nested\n\nTwo runs.\n")
    (nested / "run-a" / "forge.db-wal").write_bytes(b"")  # a sqlite side file, which is never listed
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return data


@pytest.fixture()
def data_tmp(tmp_path, monkeypatch):
    """A DATA_DIR of the test's own holding a copy of mini, for routes that write into the data folder."""
    from app import config

    data = tmp_path / "data"
    shutil.copytree(MINI, data / "mini")
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return data.resolve()


# ----------------------------------------------------------------------------- the CLI's scratch home and data dir


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A scratch THIMBLE_HOME and Claude Code config dir, a stand-in UI build, and no adoption of a real server: the
    default port may be a live server's. `up` runs as in a session the launcher started, on a claude.ai login."""
    from app import cc_channel, cli, config

    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    for k in ("THIMBLE_PORT", "THIMBLE_UI_PORT", "THIMBLE_DEV", "THIMBLE_DATA_DIR", "THIMBLE_WORKSPACES_DIR"):
        monkeypatch.delenv(k, raising=False)
    (tmp_path / "claude-home").mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    (tmp_path / "ui-dist").mkdir()
    (tmp_path / "ui-dist" / "index.html").write_text("<html></html>")
    monkeypatch.setenv("THIMBLE_FRONTEND_DIST", str(tmp_path / "ui-dist"))
    monkeypatch.setattr(config, "FRONTEND_DIST", tmp_path / "ui-dist")
    monkeypatch.setenv(cli.CHANNEL_ENV, "plugin:thimble@inline")
    monkeypatch.setattr(cc_channel, "claude_ai_login", lambda cwd, environ=None, argv=None: True)
    monkeypatch.setattr(cli, "health_leader", lambda url=None: None)
    monkeypatch.setattr(cli, "foreign_home", lambda url=None: None)  # nor refuses one: another test covers that
    monkeypatch.delenv(cli.SANDBOX_ENV, raising=False)
    return tmp_path / "home"


@pytest.fixture()
def data(tmp_path, monkeypatch):
    """A data dir with an empty `mini` folder, and the workspaces beside it, for the CLI's subprocesses."""
    d = tmp_path / "data"
    (d / "mini").mkdir(parents=True)
    (d / "mini" / "manifest.json").write_text('{"name": "mini"}')
    (d / "mini" / "agents").mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(d))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    return d


@pytest.fixture()
def named_sessions(monkeypatch) -> list[tuple]:
    """`up` from a session names it to the server after the URL. This records the naming (workspace, session, cwd) in
    place of the request, so a test that fakes the CLI's requests sees only the ones it is about."""
    from app import cli

    named: list[tuple] = []
    monkeypatch.setattr(cli, "name_session", lambda url, name, session, cwd: named.append((name, session, str(cwd))))
    return named


# ----------------------------------------------------------------------------- kernels a test started
#
# Two backstops behind the per-file kernel teardowns: after each test, whatever notebook's tables still hold is
# terminated through its pid, and at the end of the session every ipykernel_launcher of this user whose working
# directory lies under this run's pytest base temp dir is killed. A kernel anywhere else (a live server's, another
# concurrent run's) is never touched.


def _kill_kernel_pid(pid: int, wait_s: float = 3.0) -> None:
    """SIGTERM the process group `pid` leads (a kernel is its own session), SIGKILL after `wait_s`."""
    from app import procs

    def signal_it(sig: int) -> None:
        try:
            os.killpg(pid, sig)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(pid, sig)
            except (ProcessLookupError, PermissionError):
                pass

    signal_it(signal.SIGTERM)
    deadline = time.monotonic() + wait_s
    while procs.alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    if procs.alive(pid):
        signal_it(signal.SIGKILL)


@pytest.fixture(autouse=True)
def _kernels_left_by_the_test():
    """After every test, a kernel still in notebook's tables is terminated through its recorded pid and its files
    dropped."""
    yield
    nb = sys.modules.get("app.notebook")
    if nb is None or not hasattr(nb, "_kernels"):
        return  # never imported, or a test's stand-in module is still in place
    left = [*nb._kernels.values(), *nb._exec_kernels.values()]
    nb._kernels.clear()
    nb._exec_kernels.clear()
    for k in left:
        pid, pgid = k.pid, k.pgid
        if pid is None:
            rec = nb._read_record(k.record) or {}
            pid, pgid = nb._record_pid(rec), nb._record_pid(rec, "pgid")
        if pid is not None:
            nb._terminate(pid, pgid or pid, k.conn)
        nb._release_lease(k, drop=True)
        nb._drop_files(k.record, k.conn)


@pytest.fixture(scope="session", autouse=True)
def _reap_test_kernels(tmp_path_factory):
    """At session end, kill every ipykernel_launcher of this user whose cwd lies under this run's base temp dir."""
    yield
    from app import procs

    root = Path(tmp_path_factory.getbasetemp()).resolve()
    killed = []
    for pid, argv in procs.commands().items():
        if not any("ipykernel_launcher" in a for a in argv):
            continue
        wd = procs.cwd(pid)
        if wd is not None and procs.under(wd, root):
            _kill_kernel_pid(pid)
            killed.append((pid, str(wd)))
    if killed:
        sys.stderr.write("\nconftest: killed %d kernel(s) left under %s: %s\n" % (
            len(killed), root, ", ".join(f"pid {pid} in {wd}" for pid, wd in killed)))
