"""thimble's own Python: a virtual environment with pandas in $THIMBLE_HOME/python (default ~/.thimble/python), which
`thimble run` needs and bin/thimble picks when THIMBLE_PYTHON is not set.

Most commands run on any python3. The first `thimble run` on a Python without pandas makes the environment, once
(uv when it is on PATH, else `python3 -m venv` and pip), and runs the query again on it. `thimble setup` (and
scripts/install.sh) makes it ahead of time. When THIMBLE_PYTHON names a Python, thimble installs nothing into it."""
from __future__ import annotations

import fcntl
import importlib.util
import os
import shutil
import subprocess
import sys
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


def ensure() -> tuple[Path | None, str]:
    """thimble's own Python with pandas, made when it is missing: (its python, "") or (None, why it could not be made)."""
    dest = venv()
    py = dest / "bin" / "python"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest.parent / "python.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # another session may be making it now: wait for that one
        ok = py.exists() and subprocess.run([str(py), "-c", "import pandas"], stdin=subprocess.DEVNULL,
                                            capture_output=True).returncode == 0
        if not ok:
            print(f"thimble: installing pandas into its own Python ({dest}), once; this takes up to a minute.",
                  file=sys.stderr, flush=True)
            why = make(dest)
            if why:
                return None, why
    return py, ""


def run_with_pandas(argv: list[str]) -> int:
    """For a command that needs pandas on a Python without it: make thimble's own Python and run the same command on
    it (this process ends there), or print one line with the fix and return 2."""
    pinned = os.environ.get("THIMBLE_PYTHON")
    if pinned:
        print(f"thimble run needs pandas, and THIMBLE_PYTHON ({pinned}) has none. Ask the person to install it there "
              f"({pinned} -m pip install pandas), or to unset THIMBLE_PYTHON so that thimble installs its own.")
        return 2
    py, why = ensure()
    if py is None:
        print(f"thimble run needs pandas, and thimble could not install it ({why}). Ask the person to run this in a "
              f"terminal, which installs it once: {SETUP}")
        return 2
    sys.stdout.flush()
    os.execv(str(py), [str(py), str(ENTRY), *argv])
    return 2  # not reached


def setup() -> int:
    """`thimble setup`: make thimble's own Python now, unless the Python this runs on has pandas already."""
    if has_pandas():
        print(f"thimble: {sys.executable} has pandas; nothing to install.")
        return 0
    if os.environ.get("THIMBLE_PYTHON"):
        print(f"thimble: THIMBLE_PYTHON ({os.environ['THIMBLE_PYTHON']}) has no pandas. Install it there, or unset "
              "THIMBLE_PYTHON so that thimble installs its own.")
        return 1
    py, why = ensure()
    if py is None:
        print(f"thimble: could not install pandas into its own Python ({why}). Fix that, then run this again.")
        return 1
    print(f"thimble: its Python is {py}, with pandas.")
    return 0
