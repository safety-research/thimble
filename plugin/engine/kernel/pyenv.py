"""thimble's own Python: a virtual environment with pandas in $THIMBLE_HOME/python (default ~/.thimble/python), which
`thimble run` needs and bin/thimble picks when THIMBLE_PYTHON is not set.

Most commands run on any python3. The installation makes thimble's own Python with `thimble setup`: scripts/install.sh
up front, and for a plugin installed without it, the plugin's session-start hook, once per machine (hooks/python.ts).
`thimble run` never installs anything: on a Python without pandas it waits for a setup that runs now, else says in one
line what the person runs. When THIMBLE_PYTHON names a Python, thimble installs nothing into it."""
from __future__ import annotations

import fcntl
import importlib.util
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ENTRY = Path(__file__).resolve().parents[1] / "thimble.py"
SETUP = str(Path(__file__).resolve().parents[2] / "bin" / "thimble") + " setup"


def home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or Path.home() / ".thimble")


def venv() -> Path:
    return home() / "python"


def has_pandas() -> bool:
    return importlib.util.find_spec("pandas") is not None


def _why(r: subprocess.CompletedProcess) -> str:
    """The last line of a failed step's output that says something, cut short."""
    lines = [x.strip() for x in (r.stderr or r.stdout or "").splitlines() if x.strip()]
    return (lines[-1] if lines else f"exit code {r.returncode}")[:240]


def make(dest: Path) -> str | None:
    """Make the environment at `dest` with pandas in it. None when it worked, else why it did not. It builds beside
    `dest` and renames it into place last, so a step that fails leaves no half-made environment for bin/thimble."""
    tmp = dest.with_name(dest.name + ".installing")
    shutil.rmtree(tmp, ignore_errors=True)
    py = tmp / "bin" / "python"
    uv = shutil.which("uv")
    if uv:
        steps = [[uv, "venv", "--quiet", "--python", sys.executable, str(tmp)],
                 [uv, "pip", "install", "--quiet", "--python", str(py), "pandas"]]
    else:
        steps = [[sys.executable, "-m", "venv", str(tmp)],
                 [str(py), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "pandas"]]
    for step in steps:
        try:
            # stdin stays with the query: `thimble run` reads its code from it after this
            r = subprocess.run(step, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=900)
        except (OSError, subprocess.TimeoutExpired) as e:
            shutil.rmtree(tmp, ignore_errors=True)
            return str(e)[:240]
        if r.returncode != 0:
            shutil.rmtree(tmp, ignore_errors=True)
            return _why(r)
    shutil.rmtree(dest, ignore_errors=True)
    os.rename(tmp, dest)
    return None


def _ready(py: Path) -> bool:
    return py.exists() and subprocess.run([str(py), "-c", "import pandas"], stdin=subprocess.DEVNULL,
                                          capture_output=True).returncode == 0


def ensure() -> tuple[Path | None, str]:
    """thimble's own Python with pandas, made when it is missing: (its python, "") or (None, why it could not be made)."""
    dest = venv()
    py = dest / "bin" / "python"
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        lock = open(dest.parent / "python.lock", "w")
    except OSError as e:
        return None, f"{e.strerror or e}: {dest.parent}"
    with lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # another session may be making it now: wait for that one
        if not _ready(py):
            print(f"thimble: installing pandas into its own Python ({dest}), once; this takes up to a minute.",
                  file=sys.stderr, flush=True)
            why = make(dest)
            if why:
                return None, why
    return py, ""


def without_pandas(argv: list[str], wait: float = 100.0) -> int:
    """`thimble run` on a Python without pandas. It installs nothing: when a setup is making thimble's own Python now
    (the session-start hook, or another session), it waits for it, up to `wait` seconds, and runs the same command on
    it (this process ends there); else it prints one line with the fix and returns 2."""
    pinned = os.environ.get("THIMBLE_PYTHON")
    if pinned:
        print(f"thimble run needs pandas, and THIMBLE_PYTHON ({pinned}) has none. Ask the person to install it there "
              f"({pinned} -m pip install pandas), or to unset THIMBLE_PYTHON so that thimble installs its own.")
        return 2
    py = venv() / "bin" / "python"
    try:
        with open(home() / "python.lock") as lock:
            end = time.monotonic() + wait
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() > end:
                        break
                    time.sleep(0.5)
    except OSError:
        pass  # no setup ever ran here
    if _ready(py):
        sys.stdout.flush()
        os.execv(str(py), [str(py), str(ENTRY), *argv])
    print(f"thimble run needs pandas, and thimble's own Python with pandas is not installed. Ask the person to run "
          f"this in a terminal, which installs it once: {SETUP}")
    return 2


def setup(check: bool = False) -> int:
    """`thimble setup`: make thimble's own Python now, unless the Python this runs on has pandas already.
    `--check` only says, by its exit code, whether it has (0) or not (1)."""
    if has_pandas():
        if not check:
            print(f"thimble: {sys.executable} has pandas; nothing to install.")
        return 0
    if check:
        return 1
    if os.environ.get("THIMBLE_PYTHON"):
        print(f"thimble: THIMBLE_PYTHON ({os.environ['THIMBLE_PYTHON']}) has no pandas. Install it there, or unset "
              "THIMBLE_PYTHON so that thimble installs its own.")
        return 1
    py, why = ensure()
    if py is None:
        print(f"thimble: could not install pandas, which its queries need, into its own Python ({why}).")
        return 1
    print(f"thimble: its Python is {py}, with pandas.")
    return 0
