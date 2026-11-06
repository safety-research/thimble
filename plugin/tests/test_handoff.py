"""A `thimble` command in Claude Code's Bash sandbox, which may not write thimble's home, run by the plugin outside it
(engine/kernel/handoff.py; the plugin's side is hooks/handoff.ts, tested in handoff.test.ts). The plugin is made up
here: a thread that takes each command whose heartbeat goes on as the plugin's shell does (the rename), runs it with
this kernel and leaves its output and exit code beside it. The sandbox's read-only home is a home this user may not
write. All data is made up."""
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
                    if time.time() - os.stat(f"{at}.live").st_mtime > 2:  # (handoff.ts waits)
                        continue
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
    # Claude's `thimble label …` in the sandbox: before, the kernel failed to write the label ("Read-only file system");
    # now the plugin runs it, the label is in thimble's home, and its output is the command's. (A label's code runs in
    # thimble's sandbox then: test_r2_a_labels_code_…)
    data, home, box, env = session(tmp_path)
    home.chmod(0o500)
    stop = threading.Event()
    plugin(box, home, stop)
    try:
        r = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), "label", "run_failed", "--in", "runs.csv", "--regex",
                            "failed", "--says", "A run that failed."], cwd=data, env=env, capture_output=True, text=True, timeout=60)
    finally:
        stop.set()
        home.chmod(0o700)
    assert r.returncode == 0, r.stderr
    assert "run_failed: yes 2 · no 1 of 3 rows" in r.stdout
    assert len(list((home / "conversations" / "c-1").glob("folders/*/labels/run_failed.json"))) == 1
    # what the command left is gone with it
    assert list(box.iterdir()) == []


def test_r2_a_labels_code_in_the_plugins_run_for_claude_code_runs_only_in_thimbles_sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # --code, --where and --records in the plugin's run of a command from Claude Code's sandbox (THIMBLE_HANDED_OFF):
    # before, the caller's code ran in the plugin's own process, outside every sandbox, with the person's rights; now the
    # command runs again in srt, which writes only the label's records and the temp folders and reaches no network
    from kernel import cli
    from kernel import codebox as CB
    from kernel import fixes as FX
    from kernel import labels as LB
    from kernel.store import Store

    data, home, _, env = session(tmp_path)
    temp = tmp_path / "t" / "thimble"
    temp.mkdir(parents=True)
    for k in ("THIMBLE_HOME", "THIMBLE_START", "THIMBLE_SESSION", "THIMBLE_CONVERSATION"):
        monkeypatch.setenv(k, env[k])
    for k in ("THIMBLE_ROOT", "CLAUDE_CODE_TMPDIR", "THIMBLE_HANDOFF"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("TMPDIR", str(temp.parent))
    monkeypatch.setenv("THIMBLE_HANDED_OFF", "1")
    monkeypatch.chdir(data)
    ran = tmp_path / "ran.txt"
    rule = data / "rule.py"
    rule.write_text(f"open({str(ran)!r}, 'w').write('ran')\n{CODE}")
    started: list[list[str]] = []
    monkeypatch.setattr(CB, "_sandbox", lambda: {"ok": True, "node": "/made-up/bin/node", "srt": "/made-up/srt/0.0.79",
                                                 "platform": "linux"})
    monkeypatch.setattr(CB, "_exec", lambda argv: started.append(argv) or 0)
    asked = [["label", "run_status", "--in", "runs.csv", "--code", str(rule)],
             ["label", "run_failed", "--in", "runs.csv", "--regex", "failed", "--where", f"open({str(ran)!r}, 'w')"],
             ["label", "run_status", "--records"]]
    for args in asked:
        assert cli.main(args) == 0
    assert not ran.exists(), "no code ran in this process"
    assert len(started) == 3
    st = Store()
    feed = home / "events" / "c-1.jsonl"
    for argv, args in zip(started, asked):
        rules = json.loads(argv[argv.index("--srt") + 2])
        assert argv[argv.index("--srt") - 1] == str(ENGINE.parent / "sandbox" / "run.mjs")
        assert rules["network"] == {"allowedDomains": [], "deniedDomains": []}
        assert [p["path"] for p in rules["filesystem"]["allowWrite"]] == [str(st.dir.resolve()), str(st.cache.resolve()),
                                                                         str(feed.resolve()), str(temp.resolve())]
        assert [p["path"] for p in rules["filesystem"]["denyRead"]] == ["/"]
        shown = [p["path"] for p in rules["filesystem"]["allowRead"]]
        assert str(data.resolve()) in shown and str(ENGINE) in shown and str(home.resolve()) not in shown
        assert rules["bwrapPath"] == str(ENGINE.parent / "sandbox" / "bwrap.sh")
        # the command again, with an environment of its own: the session and folder it found, and no mark
        inner = argv[argv.index("--") + 1:]
        assert inner[:2] == ["/usr/bin/env", "-i"]
        assert inner[-len(args) - 3:] == [sys.executable, "-B", str(ENGINE / "thimble.py"), *args]
        assert {f"THIMBLE_ROOT={data.resolve()}", "THIMBLE_CONVERSATION=c-1", "THIMBLE_SESSION=c-1",
                f"THIMBLE_HOME={home.resolve()}", f"TMPDIR={temp.resolve()}"} <= set(inner)
        assert not any(x.startswith(("THIMBLE_HANDED_OFF", "THIMBLE_HANDOFF", "CLAUDECODE")) for x in inner)
    # the folders it writes are there before it starts, so the sandbox can name them
    assert (st.dir / "labels").is_dir() and st.cache.is_dir() and feed.is_file()
    # nowhere else in such a run does a caller's code run
    with pytest.raises(LB.LabelError):
        LB.define(st, "run_status", "code", rule.read_text(), "runs.csv")
    with pytest.raises(LB.LabelError):
        LB.records(st, "runs.csv", where="True")
    assert not ran.exists()
    # when the sandbox cannot start, the command does not run, and says why
    monkeypatch.setattr(CB, "_sandbox", lambda: {"ok": False, "why": "bubblewrap is missing.", "fix": "Install it."})
    assert cli.main(asked[0]) == 1 and len(started) == 3 and not ran.exists()
    # the person's own command runs its code here, as before
    monkeypatch.delenv("THIMBLE_HANDED_OFF")
    assert cli.main(asked[0]) == 0 and ran.exists() and len(started) == 3
    # a fix that changes what runs outside Claude Code's sandbox, or how, is a fix to the sandbox
    paths = ["plugin/hooks/handoff.ts", "plugin/engine/kernel/handoff.py", "plugin/engine/kernel/codebox.py"]
    assert FX.notice_of(paths) == {"the sandbox": paths}


@ROOT_SKIP
def test_r3_thimble_install_in_the_sandbox_is_never_handed_to_the_plugin(tmp_path: Path,
                                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    # `thimble install` is scripts/install.sh's steps, which run code and write files where their arguments say. Before,
    # one in Claude Code's sandbox was handed to the plugin like any other command, and ran outside the sandbox; now it
    # runs here, in the sandbox, at once
    _, home, box, env = session(tmp_path)
    for k in ("THIMBLE_HOME", "THIMBLE_HANDOFF"):
        monkeypatch.setenv(k, env[k])
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    seen: list[dict] = []
    home.chmod(0o500)
    stop = threading.Event()
    plugin(box, home, stop, seen)
    try:
        t = time.monotonic()
        assert H.handed_off(["install", "name"]) is None
        assert time.monotonic() - t < 1
    finally:
        stop.set()
        home.chmod(0o700)
    assert seen == [] and list(box.iterdir()) == []
