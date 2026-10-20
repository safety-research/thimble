"""thimble's own Python: the first query on a Python without pandas makes it and runs again on it, or says in one line
why it could not and what the person runs. Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest plugin/tests"""
import os
import subprocess
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN / "engine"))
from kernel import pyenv  # noqa: E402


def test_first_query_without_pandas(tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    monkeypatch.delenv("THIMBLE_PYTHON", raising=False)

    # the install fails (no network here): one line, with why and the command the person runs, and no half-made Python
    monkeypatch.setattr(pyenv, "make", lambda dest: "No matching distribution found for pandas")
    assert pyenv.run_with_pandas(["run", "per team"]) == 2
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1 and "No matching distribution found for pandas" in out[0]
    assert out[0].endswith(f"{PLUGIN}/bin/thimble setup")
    assert not (home / "python").exists()

    # it works: the same command runs again on thimble's own Python
    def make(dest):
        (dest / "bin").mkdir(parents=True)
        py = dest / "bin" / "python"
        py.write_text('#!/bin/sh\necho "own python: $*"\n')
        py.chmod(0o755)

    ran = []
    monkeypatch.setattr(pyenv, "make", make)
    monkeypatch.setattr(os, "execv", lambda path, args: ran.append(args))
    pyenv.run_with_pandas(["run", "per team"])
    assert ran == [[str(home / "python/bin/python"), str(PLUGIN / "engine/thimble.py"), "run", "per team"]]

    # and bin/thimble picks it from then on
    if not (PLUGIN / ".venv").exists():
        env = {k: v for k, v in os.environ.items() if k != "THIMBLE_PYTHON"}
        r = subprocess.run([str(PLUGIN / "bin/thimble"), "rows"], env=env, capture_output=True, text=True)
        assert r.stdout.startswith("own python: ") and r.stdout.strip().endswith("thimble.py rows")

    # a Python the person named stays as it is
    monkeypatch.setenv("THIMBLE_PYTHON", "/opt/data/bin/python")
    assert pyenv.run_with_pandas(["run", "per team"]) == 2
    assert "THIMBLE_PYTHON (/opt/data/bin/python) has none" in capsys.readouterr().out
