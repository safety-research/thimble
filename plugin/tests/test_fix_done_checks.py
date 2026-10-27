"""thimble fix done (engine/kernel/fixes.py), what its check tells and tests: a fix to the browser's kernel sandbox gets
the sandbox notice; the quick tests start the copy's kernel directly, since a launcher that answers --help itself would
hide a dead kernel, and their start check stops one that hangs within a limit of its own. The world is test_fixes.py's
made-up thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, release_with, world  # noqa: E402, F401  (world is the fixture)

PLUGIN = Path(__file__).resolve().parents[1]
LAUNCHER = (PLUGIN / "bin" / "thimble").read_text()
ENGINE = {str(p.relative_to(PLUGIN.parent)): p.read_text() for p in (PLUGIN / "engine").rglob("*.py")
          if "__pycache__" not in p.parts}


def test_a_fix_to_the_browsers_kernel_sandbox_gets_the_sandbox_notice(world):
    release_with(world, {"browser/backend/app/kernel_srt.mjs": "export const reads = []\n",
                         "browser/backend/app/srt.py": "READS = []\n"})
    r = FX.new("let the browser's kernels read more")
    wt = Path(r["work"])
    (wt / "browser" / "backend" / "app" / "kernel_srt.mjs").write_text("export const reads = ['/']\n")
    (wt / "browser" / "backend" / "app" / "srt.py").write_text("READS = ['/']\n")
    r = FX.done(r["id"], "Kernels read more", "")
    assert r["state"] == "ready"
    assert r["notice"] == {"the sandbox": ["browser/backend/app/kernel_srt.mjs", "browser/backend/app/srt.py"]}
    assert FX.notice_said(r) == ("This fix changes the sandbox (browser/backend/app/kernel_srt.mjs and "
                                 "browser/backend/app/srt.py).")


def test_the_quick_tests_start_the_copys_kernel_directly_so_a_launcher_that_answers_help_itself_hides_nothing(world, monkeypatch):
    release_with(world, {"plugin/bin/thimble": LAUNCHER, **ENGINE})
    monkeypatch.delenv("THIMBLE_FIX_TESTS")
    monkeypatch.setattr(FX, "_has_pytest", lambda py: False)
    monkeypatch.setenv("PATH", f"{world['bin']}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("THIMBLE_PYTHON", sys.executable)
    r = FX.new("a launcher of its own words")
    wt = Path(r["work"])
    (wt / "plugin" / "bin" / "thimble").write_text("#!/bin/sh\necho 'usage: thimble [made-up]'\n")
    cli = wt / "plugin" / "engine" / "kernel" / "cli.py"
    cli.write_text(cli.read_text().replace("def main(", "def main(:", 1))
    r = FX.done(r["id"], "Own words", "")
    assert r["state"] == "failed" and r["tests"] == "failed"
    assert r["tests_tail"].splitlines()[-1] == "plugin/engine/thimble.py --help: exit 1"


def test_the_start_check_stops_a_launcher_that_hangs_within_its_own_limit(tmp_path):
    copy = tmp_path / "copy"
    (copy / "plugin" / "bin").mkdir(parents=True)
    (copy / "plugin" / "bin" / "thimble").write_text("#!/bin/sh\nsleep 600\n")
    (copy / "plugin" / "bin" / "thimble").chmod(0o755)
    # the start check as the quick tests run it, with a limit of 2 s in place of its own, so that this test is quick
    limit = getattr(FX, "SMOKE_LIMIT", 60)
    smoke = FX.LAUNCHER_SMOKE.replace(f"' {limit} ", "' 2 ")
    p = subprocess.Popen(["/bin/bash", "-c", smoke], cwd=copy, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         env={**os.environ, "THIMBLE_PYTHON": sys.executable}, start_new_session=True)
    t = time.monotonic()
    try:
        out, _ = p.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.communicate()
        raise AssertionError("the start check waited for a launcher that hangs") from None
    assert p.returncode != 0 and out.strip().splitlines()[-1] == "plugin/bin/thimble --help: exit 124"
    assert time.monotonic() - t < 20
