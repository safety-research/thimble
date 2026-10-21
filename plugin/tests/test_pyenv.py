"""thimble's own Python: `thimble run` on a Python without pandas installs nothing and says in one line what the
person runs; `thimble setup` makes it, or says in one line why it could not.
Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest plugin/tests"""
import os
import subprocess
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN / "engine"))
from kernel import pyenv  # noqa: E402


def test_run_without_pandas_installs_nothing(tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    monkeypatch.delenv("THIMBLE_PYTHON", raising=False)

    def make(dest):
        raise AssertionError("thimble run installed something")

    monkeypatch.setattr(pyenv, "make", make)
    assert pyenv.without_pandas(["run", "per team"], wait=0) == 2
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1 and out[0].endswith(f"{PLUGIN}/bin/thimble setup")
    assert not home.exists()

    # setup in a folder it cannot write: one line with why
    monkeypatch.setattr(pyenv, "has_pandas", lambda: False)
    ro = tmp_path / "ro"
    ro.mkdir(mode=0o500)
    monkeypatch.setenv("THIMBLE_HOME", str(ro / "home"))
    assert pyenv.setup() == 1
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1 and "could not install pandas" in out[0] and str(ro / "home") in out[0]

    # once setup made it, the same command runs on it, and bin/thimble picks it from then on
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    py = home / "python" / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text('#!/bin/sh\necho "own python: $*"\n')
    py.chmod(0o755)
    ran = []
    monkeypatch.setattr(os, "execv", lambda path, args: ran.append(args))
    pyenv.without_pandas(["run", "per team"], wait=0)
    assert ran == [[str(py), str(PLUGIN / "engine/thimble.py"), "run", "per team"]]
    if not (PLUGIN / ".venv").exists():
        env = {k: v for k, v in os.environ.items() if k != "THIMBLE_PYTHON"}
        r = subprocess.run([str(PLUGIN / "bin/thimble"), "rows"], env=env, capture_output=True, text=True)
        assert r.stdout.startswith("own python: ") and r.stdout.strip().endswith("thimble.py rows")

    # a Python the person named stays as it is
    monkeypatch.setenv("THIMBLE_PYTHON", "/opt/data/bin/python")
    assert pyenv.without_pandas(["run", "per team"], wait=0) == 2
    assert "THIMBLE_PYTHON (/opt/data/bin/python) has none" in capsys.readouterr().out
