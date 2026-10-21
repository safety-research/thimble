"""Runs model-written code in a sandbox: a card's code (runner.py), a view's reader (views/reader_runner.py), and the
program that draws a card on the terminal plugin's toolkit (run_program: plugin/draw/sandbox-node.mjs in Node).

Each run is a new process. It sees:
- the folder of files, read-only;
- the Python it runs on and the system's libraries, read-only;
- a new, empty folder of its own (its TMPDIR and HOME), deleted when the run ends.
It does not see the person's home folder, thimble browser's own folder (the workspaces), the network (127.0.0.1
included) or the server's environment: its environment is child_env's few variables. It is stopped when its time is up.

The sandbox is Anthropic's sandbox runtime (srt, npm @anthropic-ai/sandbox-runtime), pinned in server/sandbox and
installed there by scripts/install.sh and by the thimble-browser launcher. srt confines a process with Seatbelt
(sandbox-exec) on macOS and with bubblewrap on Linux. server/sandbox/run.mjs runs one command in it, with the rules
rules() makes:

- Linux: everything is hidden (each top folder is an empty, writable folder that is gone when the run ends, /tmp among
  them), then the system's libraries, the Python, the folder and the run's folder are shown again. bwrap.sh adds a
  System V IPC namespace of the run's own and hides srt's temp folder.
- macOS: the system is shown, and the places where people's files are (MACOS_HIDDEN: /Users, /Volumes, the temp
  folders), the home folder and the workspaces are hidden; then the Python, the folder and the run's folder are shown
  again.
- Both: the run writes only its own folder, and no domain is allowed, so it has no network. A view's folder, which
  lies in thimble browser's own folder, is copied into the run's folder for the run to read (copy_in).

Where no sandbox works, code does not run and the card says why (status()), unless the person started the server with
--no-sandbox, which the page then says on every card. `thimble-browser --check-sandbox` tests it (sandbox_check.py).
"""
from __future__ import annotations

import asyncio
import functools
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from .. import home

RUNNER = Path(__file__).resolve().with_name("runner.py")
# the terminal plugin's drawing toolkit: kit.js and the Node script that runs a program on it (one copy, both products)
DRAW = Path(__file__).resolve().parents[4] / "plugin" / "draw"
DRAW_SCRIPT = DRAW / "sandbox-node.mjs"
PROGRAM_S = 15.0  # a program's whole run, Node's start included; the toolkit's own limit is far shorter
GRACE_S = 10.0  # past the run's own timeout, before the server stops it
STOP_S = 2.0  # between SIGTERM and SIGKILL

SRT_DIR = Path(__file__).resolve().parents[2] / "sandbox"  # server/sandbox: srt's package.json, run.mjs, bwrap.sh
LAUNCHER = SRT_DIR / "run.mjs"
BWRAP = SRT_DIR / "bwrap.sh"
PACKAGE = SRT_DIR / "node_modules" / "@anthropic-ai" / "sandbox-runtime"
SECCOMP = PACKAGE / "vendor" / "seccomp"  # srt's apply-seccomp, which runs inside the sandbox on Linux
NODE_MIN = (22, 12)  # srt's `engines`
PROBE_S = 30.0

# Linux: what is shown of the system, besides the Python
LINUX_SYSTEM = ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc/ld.so.cache", "/etc/localtime",
                "/etc/fonts", "/etc/alternatives")
# macOS: where people's files are, hidden besides the home folder and the workspaces
MACOS_HIDDEN = ("/Users", "/Volumes", "/private/tmp", "/private/var/tmp", "/private/var/folders")
# srt lets every command it runs write its own temp folder; a run may not (on Linux bwrap.sh also hides it)
NO_WRITE = ("/tmp/claude", "/private/tmp/claude")


@dataclass(frozen=True)
class Status:
    kind: str | None  # what the sandbox is, such as "srt 0.0.79 with bubblewrap"; None when there is none
    why: str = ""  # why there is none
    fix: str = ""  # what to do about it, as sentences
    node: str = ""  # the Node that runs srt


def pinned() -> str:
    """The version of srt that server/sandbox/package.json pins."""
    meta = json.loads((SRT_DIR / "package.json").read_text())
    return str(meta["dependencies"]["@anthropic-ai/sandbox-runtime"])


def installed() -> str | None:
    """The version of srt installed in server/sandbox/node_modules, or None."""
    try:
        return str(json.loads((PACKAGE / "package.json").read_text())["version"])
    except (OSError, ValueError, KeyError):
        return None


def node_version(exe: str) -> tuple[int, ...] | None:
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        return tuple(int(x) for x in out.lstrip("v").split(".")[:2])
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _install_node(macos: bool) -> str:
    want = ".".join(map(str, NODE_MIN))
    how = "brew install node" if macos else "from your system's packages or nodejs.org"
    return f"Install Node {want} or later ({how}), then run thimble-browser again."


INSTALL_SRT = ("Run thimble-browser again, which installs it, or run scripts/install.sh again in thimble's "
               "repository.")


@functools.cache
def status() -> Status:
    """The sandbox this machine has, found once per process: Node and the pinned srt, sandbox-exec on macOS or
    bubblewrap on Linux, and the Python running in it."""
    macos, linux = sys.platform == "darwin", sys.platform.startswith("linux")
    if not (macos or linux):
        return Status(None, f"thimble browser has no sandbox for {sys.platform}", "Use macOS or Linux.")
    node = shutil.which("node")
    if not node:
        return Status(None, "Node is not installed, and the sandbox runs on it", _install_node(macos))
    have = node_version(node)
    if have is None or have < NODE_MIN:
        got = ".".join(map(str, have or ())) or "of an unknown version"
        return Status(None, f"Node {got} is too old for the sandbox", _install_node(macos))
    want, got = pinned(), installed()
    if got is None:
        return Status(None, "the sandbox runtime (npm @anthropic-ai/sandbox-runtime) is not installed", INSTALL_SRT)
    if got != want:
        return Status(None, f"the sandbox runtime is version {got}, and thimble browser needs {want}", INSTALL_SRT)
    if macos and not os.access("/usr/bin/sandbox-exec", os.X_OK):
        return Status(None, "macOS's /usr/bin/sandbox-exec is missing", "Use a macOS that has sandbox-exec.")
    if linux and not shutil.which("bwrap"):
        return Status(None, "bubblewrap is not installed",
                      "Install bubblewrap (sudo apt install bubblewrap, or your system's package), then start "
                      "thimble browser again.")
    failed = _probe(node)
    if failed:
        fix = "The message says what failed; browser/README.md's Sandbox section says what the sandbox needs."
        if linux and _read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") == "1":
            fix = ("This Linux keeps bubblewrap from making its namespaces (AppArmor). Allow it with `sudo sysctl -w "
                   "kernel.apparmor_restrict_unprivileged_userns=0`, or give bwrap an AppArmor profile that allows "
                   "user namespaces.")
        return Status(None, f"the sandbox could not run Python: {failed}", fix, node)
    return Status(f"srt {got} with {'Seatbelt' if macos else 'bubblewrap'}", node=node)


def available() -> str | None:
    """The sandbox this machine has, or None."""
    return status().kind


def _read(path: str) -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def _probe(node: str) -> str:
    """'' when this Python runs in the sandbox with a run's rules, else what went wrong."""
    run_dir = Path(tempfile.mkdtemp(prefix="thimble-run-")).resolve()
    try:
        argv = launcher_argv(node, rules_for(run_dir, run_dir), [sys.executable, "-I", "-c", "pass"],
                             child_env(run_dir))
        r = subprocess.run(argv, capture_output=True, text=True, timeout=PROBE_S, cwd=run_dir,
                           env=launcher_env(run_dir), stdin=subprocess.DEVNULL)
        return "" if r.returncode == 0 else (r.stderr.strip()[-400:] or f"it exited with {r.returncode}")
    except (OSError, subprocess.SubprocessError) as e:
        return str(e)
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


# ---------------------------------------------------------------- the rules


def interpreter_dirs(python: str | Path) -> list[str]:
    """The installation folders `python` runs from: the prefix (<prefix>/bin/python3.x) of each symlink on the way to
    the real binary and of the binary itself. A venv's bin/python links to its base interpreter, and a uv-managed one
    through a folder link per minor version (cpython-3.12-… → cpython-3.12.13-…), so each hop must resolve inside the
    sandbox as it does outside."""
    out = []
    p = Path(python)
    for _ in range(40):
        if not p.is_symlink():
            break
        p = Path(os.path.normpath(p.parent / os.readlink(p)))
        out.append(str(p.parent.parent))
    out.append(str(Path(os.path.realpath(python)).parent.parent))
    return [d for d in dict.fromkeys(out) if d != "/"]


def python_dirs() -> list[str]:
    """The folders this server's Python reads: its venv, the install the venv points at, and each link between."""
    roots = [sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix, *interpreter_dirs(sys.executable)]
    return [r for r in dict.fromkeys(roots) if r and r != "/" and Path(r).exists()]


def rules(*, platform: str, corpus: str | Path, run_dir: str | Path, python: Sequence[str | Path],
          read: Sequence[str | Path] = (), home_dir: str | Path, workspaces: str | Path,
          seccomp: str | Path = SECCOMP, bwrap: str | Path = BWRAP) -> dict[str, Any]:
    """srt's configuration for one run (module docstring). `platform` is sys.platform; `python` the folders the Python
    runs from (python_dirs); `read` more folders it reads (the runner's, a view's); `home_dir` the person's home
    folder; `workspaces` thimble browser's own folder."""
    linux = platform.startswith("linux")
    shown = [str(corpus), str(run_dir), *map(str, python), *map(str, read)]
    if linux:
        shown = [*(p for p in LINUX_SYSTEM if os.path.lexists(p)), str(seccomp), *shown]
        hidden = ["/", str(home_dir), str(workspaces)]
    else:
        hidden = [*MACOS_HIDDEN, str(home_dir), str(workspaces)]
    shown = list(dict.fromkeys(shown))
    out: dict[str, Any] = {
        "network": {"allowedDomains": [], "deniedDomains": []},
        "filesystem": {
            "denyRead": [_literal(p) for p in _outermost(hidden, shown)],
            "allowRead": [_literal(p) for p in shown],
            "allowWrite": [_literal(str(run_dir))],
            "denyWrite": [_literal(p) for p in NO_WRITE],
        },
    }
    if linux:
        out["bwrapPath"] = str(bwrap)
    return out


def rules_for(corpus: Path, run_dir: Path, read: Sequence[Path] = ()) -> dict[str, Any]:
    """rules() for a run on this machine: the runner's folder is always read."""
    return rules(platform=sys.platform, corpus=corpus, run_dir=run_dir, python=python_dirs(),
                 read=[RUNNER.parent, *read], home_dir=Path.home(), workspaces=home.root())


def _literal(p: str) -> dict[str, Any]:
    """A path srt takes as the name it is, never as a pattern (a folder may be called `[draft] notes`)."""
    return {"path": p, "literal": True}


def _outermost(deny: Sequence[str], allow: Sequence[str]) -> list[str]:
    """`deny` without the entries another one already hides: each inside a denied folder with nothing in `allow` at or
    above it inside that folder (the home folder inside /Users). On Linux srt shows a folder link on the interpreter's
    path (uv's minor-version folder) only when no denied entry but the one the link lies in surrounds the link's
    target."""
    real = [Path(os.path.realpath(p)) for p in deny]
    shown = [Path(os.path.realpath(p)) for p in allow]

    def hidden(p: Path) -> bool:
        return any(d != p and _under(p, d) and not any(_under(p, a) and _under(a, d) for a in shown) for d in real)

    return list(dict.fromkeys(s for s, p in zip(deny, real) if not hidden(p)))


def _under(p: Path, root: Path) -> bool:
    return p == root or root in p.parents


# ---------------------------------------------------------------- a run


def child_env(run_dir: str | Path) -> dict[str, str]:
    """The run's whole environment: nothing of the server's but its time zone."""
    d = str(run_dir)
    env = {"PATH": "/usr/bin:/bin", "HOME": d, "TMPDIR": d, "LANG": "C.UTF-8", "MPLCONFIGDIR": f"{d}/mpl",
           "XDG_CACHE_HOME": f"{d}/cache", "IPYTHONDIR": f"{d}/ipython", "PYTHONDONTWRITEBYTECODE": "1",
           "MPLBACKEND": "Agg"}
    zone = os.environ.get("TZ") or _zone_file()
    if zone:
        env["TZ"] = zone
    return env


def _zone_file() -> str:
    """On Linux, the time zone file /etc/localtime links to, which the run sees in /usr though not the link."""
    real = os.path.realpath("/etc/localtime")
    return f":{real}" if sys.platform.startswith("linux") and real.startswith("/usr/") else ""


def launcher_env(run_dir: Path) -> dict[str, str]:
    """run.mjs's environment: what Node and srt need (a PATH that finds bash and bwrap) and nothing else of the
    server's. The run itself starts with child_env alone (launcher_argv)."""
    d = str(run_dir)
    return {"PATH": os.environ.get("PATH") or "/usr/bin:/bin", "HOME": d, "TMPDIR": d, "CLAUDE_CODE_TMPDIR": d,
            "LANG": "C.UTF-8"}


def launcher_argv(node: str, rule: dict[str, Any], command: Sequence[str], env: dict[str, str]) -> list[str]:
    """`command` run by run.mjs in the sandbox with `rule`, and with `env` as its whole environment."""
    pairs = [f"{k}={v}" for k, v in env.items()]
    return [node, str(LAUNCHER), json.dumps(rule, separators=(",", ":")), "--", "/usr/bin/env", "-i", *pairs, *command]


def copy_in(run_dir: Path, req: dict[str, Any], folders: Sequence[Path]) -> tuple[dict[str, Any], list[Path]]:
    """`req` and `folders` for a run whose own folder is `run_dir`. A folder that lies in thimble browser's own folder
    (a view's), which the run never sees, is copied into the run's folder, and each value of `req` that names it names
    the copy instead. The other folders stay as they are, read-only."""
    root = home.root().resolve()
    out = []
    for i, p in enumerate(folders):
        real = p.resolve()
        if not _under(real, root):
            out.append(real)
            continue
        copy = run_dir / "read" / f"{i}-{real.name}"
        shutil.copytree(real, copy, symlinks=True)
        req = {k: str(copy) if v in (str(p), str(real)) else v for k, v in req.items()}
    return req, out


async def run_script(script: Path, req: dict[str, Any], corpus: Path, *, extra_ro: list[Path] | None = None,
                     timeout: float = 60.0, unsandboxed: bool = False) -> dict[str, Any]:
    """Run `script` (a runner of this package) in the sandbox with `req` as JSON on stdin; its JSON answer, or
    {status: error, ...} with an error bundle when it could not run. `extra_ro` are more folders the run reads
    (copy_in)."""
    corpus = corpus.resolve()
    py = sys.executable
    st = status()
    if not st.kind and not unsandboxed:
        return _failed("NoSandbox", f"thimble browser runs code only in a sandbox, and found none: {st.why}. {st.fix}")
    run_dir = Path(tempfile.mkdtemp(prefix="thimble-run-")).resolve()
    try:
        env = child_env(run_dir)
        if st.kind:
            req, ro = copy_in(run_dir, req, extra_ro or [])
            argv = launcher_argv(st.node, rules_for(corpus, run_dir, [script.resolve().parent, *ro]),
                                 [py, "-I", str(script)], env)
            env = launcher_env(run_dir)
        else:
            argv = [py, "-I", str(script)]
        proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    env=env, cwd=str(corpus), start_new_session=True)
        try:
            out, err = await asyncio.wait_for(proc.communicate(json.dumps(req).encode()), timeout + GRACE_S)
        except asyncio.TimeoutError:
            await _stop(proc)
            return _failed("TimeoutError", f"the code did not stop after {timeout:g} s")
        try:
            return json.loads(out.decode() or "null") or {}
        except ValueError:
            return _failed("RunnerFailed", "the code could not run", [err.decode(errors="replace")[-1500:]])
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


TEST_S = 300.0
TEST_OUT = 12_000


def test_python() -> str | None:
    """The Python that runs a fix's tests: this server's own when it has pytest, else THIMBLE_PYTHON's (the terminal
    plugin's) when that has it, else None."""
    import importlib.util  # noqa: PLC0415

    if importlib.util.find_spec("pytest") is not None:
        return sys.executable
    other = os.environ.get("THIMBLE_PYTHON")
    if other and shutil.which(other):
        try:
            ok = subprocess.run([other, "-c", "import pytest"], capture_output=True, timeout=30).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
        if ok:
            return shutil.which(other)
    return None


async def run_tests(copy: Path, args: Sequence[str], *, timeout: float = TEST_S, unsandboxed: bool = False) -> dict[str, Any]:
    """{ok, text}: pytest over `args` (paths of the copy, and pytest's own -flags) in a fix's copy of thimble
    (fixcopy.py), in the sandbox as a card's code runs: the copy is shown read-only and is the run's working folder,
    the run writes only its own folder, and it has no network and none of the server's environment. Only this
    server's Python runs, so the tests that need what it lacks (pytest, pandas) say so in their output."""
    copy = copy.resolve()
    st = status()
    if not st.kind and not unsandboxed:
        return {"ok": False, "text": f"The tests did not run: thimble browser runs code only in a sandbox, and found "
                                     f"none: {st.why}. {st.fix}"}
    py = test_python()
    if not py:
        return {"ok": False, "text": "The tests did not run: pytest is not installed for thimble browser's Python. "
                                     "Install it with `uv sync --project browser/server --extra dev` in the thimble "
                                     "checkout, or set THIMBLE_PYTHON to a Python that has pytest."}
    run_dir = Path(tempfile.mkdtemp(prefix="thimble-test-")).resolve()
    # the copy's own browser server comes first on the path, so its tests import the copy's code, not the release's
    command = [py, "-I", "-m", "pytest", "-q", "-p", "no:cacheprovider", "-o", f"pythonpath={copy / 'browser' / 'server'}",
               *args]
    try:
        env = child_env(run_dir)
        # the sandbox hides the system's user list, and thimble's tests read a user name (the privacy scan's)
        env.update(PYTHONDONTWRITEBYTECODE="1", USER="thimble-test", LOGNAME="thimble-test")
        if st.kind:
            more = [Path(d) for d in interpreter_dirs(py)] if py != sys.executable else []
            argv = launcher_argv(st.node, rules_for(copy, run_dir, more), command, env)
            env = launcher_env(run_dir)
        else:
            argv = command
        proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.DEVNULL,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                    env=env, cwd=str(copy), start_new_session=True)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            await _stop(proc)
            return {"ok": False, "text": f"The tests did not finish in {timeout:g} s and were stopped."}
        text = out.decode(errors="replace")
        if len(text) > TEST_OUT:
            text = "[...]\n" + text[-TEST_OUT:]
        return {"ok": proc.returncode == 0, "text": text.strip() or f"pytest exited with {proc.returncode}"}
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


async def _stop(proc: asyncio.subprocess.Process) -> None:
    """Stop a run's process group: SIGTERM, which run.mjs passes on and cleans up after, then SIGKILL if it is still
    there after STOP_S."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except OSError:
            return
        try:
            await asyncio.wait_for(proc.wait(), STOP_S)
            return
        except asyncio.TimeoutError:
            continue


def _failed(ename: str, evalue: str, tb: list[str] | None = None) -> dict[str, Any]:
    return {"status": "error", "ok": False, "error": f"{ename}: {evalue}", "traceback": "\n".join(tb or []),
            "frame": None, "outputs": [{"application/vnd.thimble.error+json": {"ename": ename, "evalue": evalue,
                                                                                "traceback": tb or []}}]}


async def run_code(code: str, corpus: Path, *, timeout: float = 60.0, unsandboxed: bool = False) -> dict[str, Any]:
    """{status, outputs, frame} for a card's `code` run over `corpus`."""
    req = {"code": code, "corpus": str(corpus.resolve()), "timeout": timeout}
    return await run_script(RUNNER, req, corpus, timeout=timeout, unsandboxed=unsandboxed)


async def run_program(program: str, data: Any, *, w: int, h: int = 30, title: str = "", card_id: str = "",
                      mode: str = "inline", unsandboxed: bool = False) -> dict[str, Any]:
    """The drawing of `program` on `data` (the toolkit's JSON: root, regions, cites, examples, warnings, error), run in
    Node inside the sandbox, which reads only the toolkit's folder and Node itself, writes only its own folder and has
    no network. Inside, the program runs in a vm context of its own with the toolkit and its data alone
    (sandbox-node.mjs, started with Node's --permission to read only that folder). A run that cannot start or does not
    end comes back as a drawing whose `error` says why."""
    req = {"program": program, "data": data, "w": w, "h": h, "mode": mode, "surface": "browser", "title": title,
           "id": card_id}
    st = status()
    if not st.kind and not unsandboxed:
        return _no_drawing("NoSandbox", f"thimble browser runs a card's program only in a sandbox, and found none: "
                           f"{st.why}. {st.fix}", title, w)
    node = st.node or shutil.which("node") or "node"
    command = [node, "--permission", f"--allow-fs-read={DRAW}", str(DRAW_SCRIPT)]
    run_dir = Path(tempfile.mkdtemp(prefix="thimble-draw-")).resolve()
    try:
        env = child_env(run_dir)
        if st.kind:
            prefix = Path(os.path.realpath(node)).parent.parent
            rule = rules(platform=sys.platform, corpus=run_dir, run_dir=run_dir, python=[prefix], read=[DRAW],
                         home_dir=Path.home(), workspaces=home.root())
            argv = launcher_argv(node, rule, command, env)
            env = launcher_env(run_dir)
        else:
            argv = command
        proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    env=env, cwd=str(run_dir), start_new_session=True)
        try:
            out, err = await asyncio.wait_for(proc.communicate(json.dumps(req, default=str).encode()), PROGRAM_S)
        except asyncio.TimeoutError:
            await _stop(proc)
            return _no_drawing("TimeLimit", f"the program did not end in {PROGRAM_S:g} s", title, w)
        try:
            got = json.loads(out.decode() or "null")
        except ValueError:
            got = None
        if not isinstance(got, dict):
            return _no_drawing("SandboxError", (err.decode(errors="replace").strip()[-300:] or
                                                "the program's run printed no drawing"), title, w)
        return got
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


def _no_drawing(name: str, message: str, title: str, w: int) -> dict[str, Any]:
    """A drawing that says the program could not run, as the toolkit draws any other error."""
    return {"kit": 1, "w": w, "h": 1, "mode": "inline", "title": title, "regions": [], "cites": {}, "examples": {},
            "warnings": [], "error": {"name": name, "message": message, "line": None, "fix": message},
            "root": {"t": "text", "runs": [{"s": "× ", "tone": "bad"}, {"s": "could not draw: ", "tone": "dim"},
                                            {"s": f"{name}: {message}", "tone": "ink"}]}}
