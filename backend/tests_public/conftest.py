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

# No test asks Claude Code about its login (config.auth_status): model calls and Claude Code sessions are faked wherever
# a test reaches them.
os.environ.setdefault("THIMBLE_SKIP_KEY", "1")
# No headless Chromium per test app, no card check after every add_card, no review after every view build and no checks
# of every extension view installed.
os.environ.setdefault("THIMBLE_RENDER", "off")
os.environ.setdefault("THIMBLE_CARD_CHECK", "off")
os.environ.setdefault("THIMBLE_VIEW_REVIEW", "off")
os.environ.setdefault("THIMBLE_EXTENSION_VIEW_CHECKS", "off")
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
def claude_global_config(tmp_path, tmp_path_factory, monkeypatch) -> Path:
    """Claude Code's global config is the test's own (claude_changes.global_config), so no test reads or writes the
    user's ~/.claude.json. It trusts no folder, since nothing thimble starts needs trust. The file lives outside the
    test's tmp dir, which some tests scan."""
    import json

    from app import claude_changes

    path = tmp_path_factory.mktemp("claude-config") / ".claude.json"
    path.write_text(json.dumps({"projects": {}}))
    monkeypatch.setattr(claude_changes, "global_config", lambda: path)
    return path


@pytest.fixture(autouse=True)
def _thimble_home_off_the_user(tmp_path, monkeypatch):
    """Every test's thimble home is its own tmp dir, so what the server records there never reaches the user's. A test's
    own THIMBLE_HOME still wins."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thimble-home"))


PLUGIN_TOKEN = "t0ken-of-the-test-server"
UI_KEY = "ui-key-of-the-test-server"


def card_wait(minutes: float | None) -> float:
    """Set `cardWait` in the test's thimble config, keeping its other keys (None takes it out); the wait in seconds."""
    import json

    from app import userconf

    p = userconf.global_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(p.read_text()) if p.exists() else {}
    data.pop("cardWait", None)
    p.write_text(json.dumps({**data, **({"cardWait": minutes} if minutes is not None else {})}))
    return userconf.card_wait_s()


def _record(**values: str) -> None:
    """`values` into the test's server.json, keeping what it holds."""
    import json

    p = Path(os.environ["THIMBLE_HOME"]) / "server.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({**(json.loads(p.read_text()) if p.exists() else {}), **values}))


@pytest.fixture()
def plugin_headers():
    """A function giving the headers thimble's plugin sends to the routes only it may call (app/hook_auth.py), for a
    fresh nonce each time, proving the token this fixture records in the test's server.json."""
    from app import hook_auth

    _record(token=PLUGIN_TOKEN)
    return lambda: hook_auth.headers(PLUGIN_TOKEN, os.urandom(8).hex())


@pytest.fixture()
def analyst():
    """A request from the analyst's browser as the routes that change permission modes take it: it carries the cookie of
    the ui_key this fixture records in the test's server.json (app/hook_auth.py)."""
    from starlette.requests import Request

    from app import hook_auth

    _record(ui_key=UI_KEY)
    return Request({"type": "http", "headers": [(b"cookie", f"{hook_auth.ui_cookie()}={UI_KEY}".encode())]})


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "real_write_guard: keep hook_auth.LocalWriteGuard on for a test (the suite bypasses it by default)")


@pytest.fixture(autouse=True)
def _write_guard_off(request, monkeypatch):
    """A test's TestClient stands in for thimble's own browser and plugin, which prove themselves to
    hook_auth.LocalWriteGuard (the ui_key cookie or the token); the guard would otherwise refuse their writes as it
    refuses a notebook kernel. Off by default so a route test needs no credential; a test marked `real_write_guard`
    keeps the real guard."""
    if "real_write_guard" in request.keywords:
        return
    from app import hook_auth

    monkeypatch.setattr(hook_auth, "write_guarded", lambda method, path: False)


@pytest.fixture(autouse=True)
def _dev_dir_off_the_checkout(tmp_path, monkeypatch):
    """The dev panel's tickets and feedback live under the test's tmp dir, never the checkout's dev/. A test's own
    monkeypatch of dev.DEV_DIR still wins, since it runs after this one."""
    from app import dev

    monkeypatch.setattr(dev, "DEV_DIR", tmp_path / "dev")


@pytest.fixture(autouse=True)
def _view_tickets_held(monkeypatch):
    """A view proposal queues its build at once, and a build that starts asks main's module for a subagent. Every test
    holds them queued with an empty pool."""
    from app import dev

    monkeypatch.setattr(dev, "VIEW_POOL", 0)
    monkeypatch.setattr(dev, "_view_runs", {})
    monkeypatch.setattr(dev, "_view_queue", [])
    monkeypatch.setattr(dev, "_view_stopping", {})
    monkeypatch.setattr(dev, "_closing", False)
    monkeypatch.setattr(dev, "_retry_handle", None)
    monkeypatch.setattr(dev, "_no_module_looks", {})
    monkeypatch.setattr(dev, "_settling", set())



@pytest.fixture(autouse=True)
def _no_held_events():
    """The quiet events events.post holds for the next event and the modes main's hooks reported are module state:
    none carries over from another test."""
    from app import events, session

    for held in (events._held, session._modes):
        held.clear()
    yield
    for held in (events._held, session._modes):
        held.clear()


LISTENER_SID = "5e55a000-0000-4000-8000-0000000000aa"


class Listener:
    """A session that is main in workspace `corpus` and whose shim holds a subscription, for a test that checks what
    reaches main: the events events.post queues for its watcher (events._pending), taken like an asyncio.Queue's."""

    def __init__(self, corpus: str, sid: str = LISTENER_SID) -> None:
        from app import config, events, session

        self.corpus, self.sid = corpus, sid
        self.sub = events.Sub(sid)
        events._subs.setdefault(corpus, set()).add(self.sub)
        session.attach(corpus, sid, str(config.corpus_dir(corpus)), None)

    def _queue(self):
        from app import events

        return events._pending.get((self.corpus, self.sid))

    def empty(self) -> bool:
        return not self._queue()

    def get_nowait(self) -> dict:
        import asyncio

        q = self._queue()
        if not q:
            raise asyncio.QueueEmpty
        return q.popleft()

    async def get(self, timeout: float = 10.0) -> dict:
        import asyncio

        end = time.monotonic() + timeout
        while self.empty():
            if time.monotonic() > end:
                raise asyncio.TimeoutError
            await asyncio.sleep(0.02)
        return self.get_nowait()

    def close(self) -> None:
        from app import events, session

        events._subs.get(self.corpus, set()).discard(self.sub)
        events._pending.pop((self.corpus, self.sid), None)
        events._notices.pop((self.corpus, self.sid), None)
        lv = session._live.pop(self.corpus, None)
        if lv is not None and lv.task is not None:
            lv.task.cancel()


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
    """launch_args asks `claude plugin list` which plugin copy main loads (cli.installed_copy). Tests load plugin/."""
    from app import cli

    monkeypatch.setattr(cli, "installed_copy", lambda cwd: None)


@pytest.fixture(autouse=True)
def _launch_writes_nothing_shared(monkeypatch):
    """launch_args registers its folder (cli.register_here) and finds the workspace's extensions again through a running
    server (cli.refresh_extensions). In a test it registers nothing, so the suite's shared data folder gains no corpus,
    and reaches no server: the default port may be a live server's. A test of either replaces it again."""
    from app import cli, config

    monkeypatch.setattr(cli, "register_here", lambda cwd: config.workspace_for_cwd(str(cwd)))
    monkeypatch.setattr(cli, "refresh_extensions", lambda c: None)


@pytest.fixture(autouse=True)
def _claude_stand_in(tmp_path_factory, monkeypatch):
    """A stand-in `claude`, first on PATH and as the resolved CLI (config.CLI_PATH and the modules that hold it), for the
    test and the processes it starts, which prints the version thimble is tested with for `--version` and nothing
    otherwise. `up` warns when claude is missing or older than that version, and the tests must pass the same on a
    machine without Claude Code and never run the real one. A test's own setting still wins."""
    from app import agent_session, cli, config, dev

    bin_dir = tmp_path_factory.getbasetemp() / "claude-stand-in"
    exe = bin_dir / "claude"
    if not exe.exists():
        bin_dir.mkdir(exist_ok=True)
        exe.write_text(f'#!/bin/sh\n[ "$1" = --version ] && echo "{cli.TESTED_CLAUDE_CODE} (Claude Code)"\nexit 0\n')
        exe.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    for module, name in ((config, "CLI_PATH"), (config, "CLAUDE_BIN"), (agent_session, "CLAUDE_BIN"), (dev, "CLAUDE_BIN")):
        monkeypatch.setattr(module, name, str(exe))


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
    default port may be a live server's. `up` runs as in a session the launcher started."""
    from app import cli, config

    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    for k in ("THIMBLE_PORT", "THIMBLE_UI_PORT", "THIMBLE_DEV", "THIMBLE_DATA_DIR", "THIMBLE_WORKSPACES_DIR"):
        monkeypatch.delenv(k, raising=False)
    (tmp_path / "claude-home").mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    (tmp_path / "ui-dist").mkdir()
    (tmp_path / "ui-dist" / "index.html").write_text("<html></html>")
    monkeypatch.setenv("THIMBLE_FRONTEND_DIST", str(tmp_path / "ui-dist"))
    monkeypatch.setattr(config, "FRONTEND_DIST", tmp_path / "ui-dist")
    monkeypatch.setenv(cli.LAUNCHED_ENV, "1")
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


def fake_claude_bin(folder: Path, status: dict) -> Path:
    """A stand-in `claude` in `folder` whose `auth status --json` prints `status` (config.auth_status), and which names
    itself a recent version."""
    import json
    import shlex

    (folder / "auth-status.json").write_text(json.dumps(status))
    bin_ = folder / "fake-claude"
    bin_.write_text(f'#!/bin/sh\ncase "$1" in --version) echo "9.9.9 (Claude Code)";; '
                    f'auth) cat {shlex.quote(str(folder / "auth-status.json"))};; esac\n')
    bin_.chmod(0o755)
    return bin_


@pytest.fixture()
def fake_claude(tmp_path, monkeypatch) -> Path:
    """fake_claude_bin on a claude.ai login as config.CLI_PATH and THIMBLE_CLAUDE_BIN, with THIMBLE_SKIP_KEY off; a test
    rewrites the returned status file to report another login."""
    from app import config

    bin_ = fake_claude_bin(tmp_path, {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty"})
    monkeypatch.setattr(config, "CLI_PATH", str(bin_))
    monkeypatch.setenv("THIMBLE_CLAUDE_BIN", str(bin_))
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    return tmp_path / "auth-status.json"


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
