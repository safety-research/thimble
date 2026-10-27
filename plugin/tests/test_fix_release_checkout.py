"""thimble fix (engine/kernel/fixes.py) and the release checkout, which the way back runs from: a checkout as the
release commit has it is left alone, so that the processes that run from it at once never meet it half put back, and
one that is not waits for another git's lock on its index; the release's kernel writes no bytecode into it; no hook of
the person's clone runs when it is put back or made; off.sh puts it back too. The world is test_fixes.py's made-up
thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, press, release_with, sh, world  # noqa: E402, F401  (world is the fixture)

PLUGIN = Path(__file__).resolve().parents[1]
LAUNCHER = (PLUGIN / "bin" / "thimble").read_text()
ENGINE = {str(p.relative_to(PLUGIN.parent)): p.read_text() for p in (PLUGIN / "engine").rglob("*.py")
          if "__pycache__" not in p.parts}
BAR = "const words = `coverage ${n}`\n"


def index_lock(checkout: Path) -> Path:
    """The lock file another git holds while it writes the checkout's index."""
    return Path(sh("git", "rev-parse", "--absolute-git-dir", cwd=checkout)) / "index.lock"


def let_go_soon(lock: Path) -> threading.Timer:
    t = threading.Timer(0.5, lambda: lock.unlink(missing_ok=True))
    t.start()
    return t


def recording_hook(w, tmp_path: Path, code: int) -> Path:
    """A post-checkout hook in the person's clone, which every worktree of it runs: it writes where it ran."""
    hooks = tmp_path / "made-up-hooks"
    hooks.mkdir(exist_ok=True)
    ran = tmp_path / "hook-ran"
    (hooks / "post-checkout").write_text(f"#!/bin/sh\npwd -P >> '{ran}'\nexit {code}\n")
    (hooks / "post-checkout").chmod(0o755)
    sh("git", "config", "core.hooksPath", str(hooks), cwd=w["rel"])
    return ran


def launch(launcher: Path, *args: str, cwd: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "THIMBLE_PYTHON": sys.executable}
    env.pop("PYTHONDONTWRITEBYTECODE", None)
    return subprocess.run([str(launcher), *args], capture_output=True, text=True, cwd=cwd, env=env, timeout=60)


def test_a_release_checkout_as_the_release_has_it_is_left_alone_and_one_that_is_not_waits_for_anothers_lock(world):
    made(world)
    rel = FX.release_dir()
    lock = index_lock(rel)
    # another process's git holds the checkout's index: a checkout as the release commit has it is left alone, also by
    # the next request, whose ensure_live puts the checkout back
    lock.write_text("")
    FX.place_release(world["base"])
    assert FX.new("one more change")["state"] == "working"
    assert lock.exists()
    # a checkout changed by hand waits for the lock, then is put back
    (rel / "plugin" / "bar" / "bar.tsx").write_text("const words = 'changed by hand'\n")
    t = let_go_soon(lock)
    FX.place_release(world["base"])
    t.join()
    assert (rel / "plugin" / "bar" / "bar.tsx").read_text() == BAR
    assert sh("git", "status", "--porcelain", "--ignored", cwd=rel) == ""


def test_the_releases_kernel_writes_no_bytecode_and_its_launcher_waits_for_anothers_lock(world, tmp_path):
    release_with(world, {"plugin/bin/thimble": LAUNCHER, **ENGINE})
    made(world)
    rel = FX.release_dir()
    launcher = rel / "plugin" / "bin" / "thimble"
    p = launch(launcher, "fix", "list", "--json", cwd=tmp_path)
    assert p.returncode == 0 and [f["id"] for f in json.loads(p.stdout)["fixes"]] == [1], p.stderr
    # the kernel ran from the checkout, and left nothing in it (no __pycache__)
    assert sh("git", "status", "--porcelain", "--ignored", cwd=rel) == ""
    # a launcher that finds the checkout changed while another git holds its index waits for it, then puts it back
    (rel / "plugin" / "bar" / "bar.tsx").write_text("const words = 'changed by hand'\n")
    lock = index_lock(rel)
    lock.write_text("")
    t = let_go_soon(lock)
    p = launch(launcher, "fix", "list", "--json", cwd=tmp_path)
    t.join()
    assert p.returncode == 0, p.stderr
    assert (rel / "plugin" / "bar" / "bar.tsx").read_text() == BAR
    assert sh("git", "status", "--porcelain", "--ignored", cwd=rel) == ""


def test_no_hook_of_the_persons_clone_runs_when_the_release_checkout_is_put_back_or_made(world, tmp_path):
    release_with(world, {"plugin/bin/thimble": LAUNCHER,
                         "plugin/engine/thimble.py": "import sys\nprint('made-up kernel', *sys.argv[1:])\n"})
    made(world)
    rel = FX.release_dir()
    # a hook that fails, as git-lfs's does when git-lfs is not on the kernel's PATH
    ran = recording_hook(world, tmp_path, 2)
    (rel / "plugin" / "bar" / "bar.tsx").write_text("const words = 'changed by hand'\n")
    FX.place_release(world["base"])
    assert (rel / "plugin" / "bar" / "bar.tsx").read_text() == BAR
    shutil.rmtree(rel)
    FX.place_release(world["base"])
    assert sh("git", "rev-parse", "HEAD", cwd=rel) == world["base"]
    # the launcher of the checkout puts it back before the way back runs, with no hook either
    (rel / "plugin" / "bar" / "bar.tsx").write_text("const words = 'changed by hand'\n")
    assert launch(rel / "plugin" / "bin" / "thimble", "fix", "list", cwd=tmp_path).stdout.strip() == "made-up kernel fix list"
    assert (rel / "plugin" / "bar" / "bar.tsx").read_text() == BAR
    assert not ran.exists()


def test_off_sh_puts_the_release_checkout_back_also_a_launcher_that_stops_before_its_own_reset(world, tmp_path):
    release_with(world, {"plugin/bin/thimble": LAUNCHER})
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.apply(r["id"], press(r["id"]))
    rel = FX.release_dir()
    launcher = rel / "plugin" / "bin" / "thimble"
    launcher.write_text("#!/bin/sh\nexit 9\n")
    (rel / "plugin" / "engine" / "__pycache__").mkdir(parents=True)
    (rel / "plugin" / "engine" / "getpass.py").write_text("WHO = 'planted'\n")
    ran = recording_hook(world, tmp_path, 0)
    out = subprocess.run(["sh", str(FX.home() / "off.sh")], capture_output=True, text=True, check=True).stdout
    assert "plain release" in out and not FX.is_on()
    assert launcher.read_text() == LAUNCHER and not (rel / "plugin" / "engine").exists()
    assert sh("git", "rev-parse", "HEAD", cwd=rel) == world["base"]
    assert sh("git", "status", "--porcelain", "--ignored", cwd=rel) == ""
    # live's own checkout may run the clone's hooks; the release checkout's reset runs none
    assert str(rel.resolve()) not in (ran.read_text().splitlines() if ran.exists() else [])
