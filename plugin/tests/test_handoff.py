"""A `thimble` command in Claude Code's Bash sandbox, which may not write thimble's home, run by the plugin outside it
(engine/kernel/handoff.py; the plugin's side is hooks/handoff.ts, tested in handoff.test.ts). The plugin is made up
here: a thread that takes each command as the plugin's shell does (the rename), runs it with this kernel and leaves its
output and exit code beside it. The sandbox's read-only home is a home this user may not write. All data is made up."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import handoff as H  # noqa: E402

ROOT_SKIP = pytest.mark.skipif(os.geteuid() == 0, reason="root may write in any folder")
RUNS = "run,status,minutes\nnightly-001,passed,18.1\nnightly-002,failed,25.8\nnightly-003,failed,21.4\n"
CODE = 'def label(u):\n    return u["status"]\n'
# the variables the plugin takes from a request (hooks/handoff.ts CARRIED)
CARRIED = ("THIMBLE_SESSION", "THIMBLE_CONVERSATION", "THIMBLE_START", "THIMBLE_ROOT")


def plugin(box: Path, home: Path, stop: threading.Event, seen: list[dict] | None = None) -> threading.Thread:
    """The plugin's side, made up: each <id>.ask in `box` taken by its rename and run with this kernel outside the
    sandbox (where thimble's home, `home`, may be written), in the command's folder, with the plugin's environment and
    the variables hooks/handoff.ts runEnv gives (the request's CARRIED ones, THIMBLE_HANDOFF empty, the marks of a
    command in Claude Code), and its stdin; its output and its exit code left beside it. `seen` gets each request it
    took."""

    def serve() -> None:
        while not stop.is_set():
            for ask in box.glob("*.ask"):
                at = str(ask)[: -len(".ask")]
                try:
                    os.rename(ask, f"{at}.took")
                except FileNotFoundError:
                    continue
                req = json.loads(Path(f"{at}.took").read_text())
                if seen is not None:
                    seen.append(req)
                home.chmod(0o700)
                env = {**os.environ, "THIMBLE_HOME": str(home), **{k: str(req["env"].get(k) or "") for k in CARRIED},
                       "THIMBLE_HANDOFF": "", "CLAUDECODE": "1", "THIMBLE_HANDED_OFF": "1"}
                with open(f"{at}.out", "wb") as out, open(f"{at}.err", "wb") as err:
                    done = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), *req["argv"]], cwd=req["cwd"],
                                          env=env, input=req["stdin"].encode(), stdout=out, stderr=err, timeout=60)
                home.chmod(0o500)
                Path(f"{at}.code").write_text(f"{done.returncode}\n")
                os.replace(f"{at}.code", f"{at}.done")
            time.sleep(0.02)

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    return t


def session(tmp_path: Path) -> tuple[Path, Path, Path, dict[str, str]]:
    """A folder of records, thimble's home (which a command in the sandbox may not write), the plugin's folder in Claude
    Code's temp folder, and a command's environment in the sandbox."""
    data, home, box = tmp_path / "data", tmp_path / "th", tmp_path / "cc" / "claude-1000" / "thimble-s-1"
    for d in (data, home, box):
        d.mkdir(parents=True)
    (data / "runs.csv").write_text(RUNS)
    env = {**os.environ, "THIMBLE_HOME": str(home), "THIMBLE_HANDOFF": str(box), "THIMBLE_START": str(data),
           "THIMBLE_SESSION": "c-1", "THIMBLE_CONVERSATION": "c-1"}
    env.pop("THIMBLE_ROOT", None)
    return data, home, box, env


@ROOT_SKIP
def test_r2_a_label_in_claude_codes_sandbox_is_made_by_the_plugin_outside_it(tmp_path: Path) -> None:
    # Claude's `thimble label … --code` in the sandbox, its code on stdin: before, the kernel failed to write the label
    # ("Read-only file system"); now the plugin runs it, the label is in thimble's home, and its output is the command's
    data, home, box, env = session(tmp_path)
    home.chmod(0o500)
    stop = threading.Event()
    plugin(box, home, stop)
    try:
        r = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), "label", "run_status", "--in", "runs.csv", "--code",
                            "--says", "A run's status."], cwd=data, env=env, input=CODE, capture_output=True, text=True, timeout=60)
    finally:
        stop.set()
        home.chmod(0o700)
    assert r.returncode == 0, r.stderr
    assert "run_status: failed 2 · passed 1 of 3 rows" in r.stdout
    assert len(list((home / "conversations" / "c-1").glob("folders/*/labels/run_status.json"))) == 1
    # what the command left is gone with it
    assert list(box.iterdir()) == []


@ROOT_SKIP
def test_r2_a_request_carries_only_the_variables_that_say_which_session_and_folder_it_is_for(tmp_path: Path) -> None:
    # before, it carried every THIMBLE_ variable, and the plugin took them all: THIMBLE_PYTHON named the program it ran,
    # THIMBLE_HOME the launcher, THIMBLE_FIX_TESTS a shell command. Now only the session and the folder go
    data, home, box, env = session(tmp_path)
    env.update(THIMBLE_ROOT=str(data), THIMBLE_PYTHON=str(box.parent / "py.sh"), THIMBLE_CLAUDE=str(box.parent / "claude"),
               THIMBLE_FIX_TESTS="true", THIMBLE_UPDATE_URL=str(box.parent), PYTHONPATH=str(box.parent))
    home.chmod(0o500)
    seen: list[dict] = []
    stop = threading.Event()
    plugin(box, home, stop, seen)
    try:
        r = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), "coverage"], cwd=data, env=env,
                           capture_output=True, text=True, timeout=60)
    finally:
        stop.set()
        home.chmod(0o700)
    assert r.returncode == 0, r.stderr
    assert [s["env"] for s in seen] == [{"THIMBLE_SESSION": "c-1", "THIMBLE_CONVERSATION": "c-1", "THIMBLE_START": str(data),
                                         "THIMBLE_ROOT": str(data)}]
    assert list(box.iterdir()) == []


def test_r2_update_and_reapply_refuse_a_command_the_plugin_runs_for_claude_code_as_they_refuse_one_in_it(tmp_path: Path) -> None:
    # the plugin's run of a command handed to it is marked THIMBLE_HANDED_OFF (hooks/handoff.ts runEnv), whether or not
    # the plugin's own process has CLAUDECODE: thimble update and reapply, which change the thimble the session runs,
    # and file pr, which posts code publicly, still say to run them in a shell. Before, they went on
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "THIMBLE_ROOT")}
    env.update(THIMBLE_HOME=str(tmp_path / "th"), THIMBLE_HANDED_OFF="1", THIMBLE_UPDATE_URL=str(tmp_path / "no-release"))
    for argv, what in ((["update"], "thimble update"), (["reapply"], "thimble reapply"), (["file", "pr", "1"], "thimble file pr 1")):
        r = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), *argv], cwd=tmp_path, env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        assert r.returncode == 1 and f"{what} runs in a shell, not inside Claude Code" in r.stderr, (argv, r.stdout, r.stderr)


@ROOT_SKIP
def test_a_command_the_plugin_does_not_take_takes_itself_back_and_runs_here(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, home, box, env = session(tmp_path)
    home.chmod(0o500)
    for k in ("THIMBLE_HOME", "THIMBLE_HANDOFF"):
        monkeypatch.setenv(k, env[k])
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    monkeypatch.setattr(H, "TAKE_S", 0.2)
    try:
        assert H.handed_off(["coverage"]) is None
    finally:
        home.chmod(0o700)
    assert list(box.iterdir()) == []


def test_a_command_runs_here_when_it_may_write_thimbles_home_or_no_plugin_serves_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, home, box, env = session(tmp_path)
    for k in ("THIMBLE_HOME", "THIMBLE_HANDOFF"):
        monkeypatch.setenv(k, env[k])
    assert H.handed_off(["coverage"]) is None
    # no THIMBLE_HANDOFF: a shell no plugin serves
    monkeypatch.delenv("THIMBLE_HANDOFF")
    home.chmod(0o500)
    try:
        assert H.handed_off(["coverage"]) is None
    finally:
        home.chmod(0o700)
    assert list(box.iterdir()) == []
