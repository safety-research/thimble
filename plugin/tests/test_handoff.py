"""A `thimble` command in Claude Code's Bash sandbox, which may not write thimble's home, run by the plugin outside it
(engine/kernel/handoff.py; the plugin's side is hooks/handoff.ts, tested in handoff.test.ts). The plugin is made up
here: a thread that takes each command whose heartbeat goes on as the plugin's shell does (the rename), runs it with
this kernel and leaves its output and exit code beside it. The sandbox's read-only home is a home this user may not
write. All data is made up."""
from __future__ import annotations

import io
import json
import os
import signal
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
def test_r2_a_labels_code_handed_to_the_plugin_reaches_no_network_and_writes_only_the_label(tmp_path: Path) -> None:
    # in srt, as a session runs it: the code on stdin gets each record, writes nowhere outside thimble's records and the
    # temp folders, reads no file beside the folder, and reaches no network
    srt = os.environ.get("THIMBLE_TEST_SRT")  # a folder with srt installed (sandbox/setup.mjs); skipped without it
    if not srt:
        pytest.skip("THIMBLE_TEST_SRT is not set")
    data, home, box, env = session(tmp_path)
    pin = json.loads((ENGINE.parent / "sandbox" / "package.json").read_text())["dependencies"]["@anthropic-ai/sandbox-runtime"]
    (home / "srt").mkdir()
    (home / "srt" / pin).symlink_to(srt)
    outside, beside = tmp_path / "outside.txt", tmp_path / "beside" / "notes.txt"
    beside.parent.mkdir()
    beside.write_text("made-up\n")
    # (a write outside lands, if anywhere, in the sandbox's own empty folders, which go with it)
    code = ("import socket\n"
            "def label(u):\n"
            "    try:\n"
            f"        open({str(outside)!r}, 'w').write('x')\n"
            "    except OSError:\n"
            "        pass\n"
            "    try:\n"
            "        socket.create_connection(('1.1.1.1', 80), timeout=2).close(); net = 'net'\n"
            "    except OSError:\n"
            "        net = 'nonet'\n"
            "    try:\n"
            f"        open({str(beside)!r}).read(); read = 'read'\n"
            "    except OSError:\n"
            "        read = 'noread'\n"
            "    return '-'.join((u['status'], net, read))\n")
    home.chmod(0o500)
    stop = threading.Event()
    plugin(box, home, stop)
    try:
        r = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), "label", "run_status", "--in", "runs.csv", "--code"],
                           cwd=data, env=env, input=code, capture_output=True, text=True, timeout=120)
    finally:
        stop.set()
        home.chmod(0o700)
    assert r.returncode == 0, r.stderr
    assert "run_status: failed-nonet-noread 2 · passed-nonet-noread 1 of 3 rows" in r.stdout, r.stdout
    assert not outside.exists()
    assert len(list((home / "conversations" / "c-1").glob("folders/*/labels/run_status.json"))) == 1


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


def test_r3_the_install_refuses_a_run_the_plugin_makes_for_a_command_in_the_sandbox(tmp_path: Path) -> None:
    # a request, which any command in the sandbox can write, still has the plugin run `thimble install` outside the
    # sandbox (THIMBLE_HANDED_OFF), in a folder and with paths the command chose. Before, its setup.mjs ran there,
    # ~/.local/bin/thimble became a link to its launcher, and --state wrote over any file; now each step refuses such a
    # run with one line, and does nothing
    data, home, _, env = session(tmp_path)
    caller = data / "made-up" / "plugin"
    ran = tmp_path / "setup-ran"
    (caller / "sandbox").mkdir(parents=True)
    (caller / "sandbox" / "setup.mjs").write_text(
        f"import fs from 'node:fs'\nfs.writeFileSync({json.dumps(str(ran))}, 'ran')\n"
        "console.log(JSON.stringify({ok: true}))\n")
    (caller / "bin").mkdir()
    (caller / "bin" / "thimble").write_text("#!/bin/sh\necho the caller's thimble\n")
    (caller / "bin" / "thimble").chmod(0o755)
    notes, bin_ = tmp_path / "notes.txt", tmp_path / "bin"
    notes.write_text("the person's notes\n")
    env.update(HOME=str(tmp_path / "home"), CLAUDE_CONFIG_DIR=str(tmp_path / "cc-config"), THIMBLE_HANDOFF="",
               CLAUDECODE="1", THIMBLE_HANDED_OFF="1", THIMBLE_BROWSER_HOME=str(tmp_path / "browser-home"))
    for argv in (["install", "sandbox", "--folder", "made-up"],
                 ["install", "commands", "--folder", "made-up", "--bin-dir", str(bin_), "--browser"],
                 ["install", "commands", "--bin-dir", str(bin_), "--state", str(notes)],
                 ["install", "release", "--from", str(caller.parent)], ["install", "name"]):
        r = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), *argv], cwd=data, env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        refused = ("thimble install does not run for a command in Claude Code's sandbox; run scripts/install.sh "
                   "outside the sandbox.\n")
        assert (r.returncode, r.stdout, r.stderr) == (1, refused, ""), (argv, r.stdout, r.stderr)
    assert not ran.exists() and not bin_.exists() and notes.read_text() == "the person's notes\n"
    assert list(home.iterdir()) == []


def wait_for(test, limit: float = 10.0) -> bool:
    t = time.monotonic() + limit
    while not test():
        if time.monotonic() > t:
            return False
        time.sleep(0.02)
    return True


@ROOT_SKIP
def test_r2_a_command_stopped_while_it_waits_for_the_plugin_takes_its_request_with_it(tmp_path: Path) -> None:
    # Esc, or the Bash call's time limit, stops a command that waits for the plugin. Before, its request stayed, and the
    # next Bash call that named thimble ran it outside the sandbox with nobody to read its output, and its files stayed.
    # Now the command touches its heartbeat while it waits, by which the plugin knows it waits, and its files go as it ends
    _, home, box, env = session(tmp_path)
    home.chmod(0o500)
    try:
        p = subprocess.Popen([sys.executable, str(ENGINE / "thimble.py"), "coverage"], cwd=tmp_path, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            assert wait_for(lambda: list(box.glob("*.ask")) and list(box.glob("*.live")))
            live = next(box.glob("*.live"))
            was = live.stat().st_mtime_ns
            assert wait_for(lambda: live.stat().st_mtime_ns != was, 2.0), "its heartbeat goes on while it waits"
            p.send_signal(signal.SIGTERM)
            p.wait(10)
        finally:
            p.kill()
            p.wait(10)
    finally:
        home.chmod(0o700)
    assert p.returncode == 128 + signal.SIGTERM
    assert list(box.iterdir()) == []


@ROOT_SKIP
def test_r2_a_command_whose_run_gives_no_result_ends_with_one_plain_line(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                                       capsys: pytest.CaptureFixture[str]) -> None:
    # the plugin took it, and no exit code came (its run died with a reload of the plugin): before, the command waited
    # until its Bash call's time limit, or forever in the background. Now it ends after RUN_S and says so, and when the
    # run's files go with no result (the plugin took the command for gone), at once
    _, home, box, env = session(tmp_path)
    for k in ("THIMBLE_HOME", "THIMBLE_HANDOFF"):
        monkeypatch.setenv(k, env[k])
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    monkeypatch.setattr(H, "RUN_S", 0.5)

    def taker(also_remove: bool) -> threading.Thread:
        def take() -> None:
            assert wait_for(lambda: list(box.glob("*.ask")))
            ask = next(box.glob("*.ask"))
            took = ask.with_suffix(".took")
            os.rename(ask, took)
            if also_remove:
                time.sleep(0.1)
                took.unlink()
        t = threading.Thread(target=take, daemon=True)
        t.start()
        return t

    home.chmod(0o500)
    try:
        taker(False)
        assert H.handed_off(["coverage"]) == 1
        assert capsys.readouterr().err == ("thimble: no result came back from the plugin within 10 minutes, the most it may "
                                           "take, and it was stopped\n")
        assert list(box.iterdir()) == []
        monkeypatch.setattr(H, "RUN_S", 30.0)
        taker(True)
        t = time.monotonic()
        assert H.handed_off(["coverage"]) == 1
        assert time.monotonic() - t < 5
        assert capsys.readouterr().err == "thimble: no result came back from the plugin, and it was stopped\n"
    finally:
        home.chmod(0o700)
    assert list(box.iterdir()) == []


@ROOT_SKIP
def test_r2_stdin_from_a_slow_pipe_reaches_the_command_the_plugin_runs(tmp_path: Path) -> None:
    # `(sleep 0.3; printf …) | thimble label NAME --set`: before, the command waited 0.1 s for stdin and handed the
    # plugin none, so the plugin's run had nothing to set (exit 2); now it waits as long as the command itself does
    data, home, box, env = session(tmp_path)
    values = json.dumps({"runs.csv#row=2": "failed", "runs.csv#row=3": "failed"})
    home.chmod(0o500)
    stop = threading.Event()
    plugin(box, home, stop)
    try:
        r = subprocess.run(["sh", "-c", f"(sleep 0.3; printf '%s' '{values}') | \"$0\" \"$1\" label run_status --set",
                            sys.executable, str(ENGINE / "thimble.py")], cwd=data, env=env, capture_output=True, text=True,
                           timeout=60)
    finally:
        stop.set()
        home.chmod(0o700)
    assert r.returncode == 0, r.stdout + r.stderr
    lab = json.loads(next((home / "conversations" / "c-1").glob("folders/*/labels/run_status.json")).read_text())
    assert {ref: u["v"] for ref, u in lab["units"].items()} == {"runs.csv#row=2": "failed", "runs.csv#row=3": "failed"}


def test_r2_a_command_handed_to_the_plugin_reads_stdin_as_long_as_it_would_itself(capsys: pytest.CaptureFixture[str]) -> None:
    from kernel.cli import stdin_wait

    # input it cannot go on without: 5 s, as the command waits; argparse's short forms too
    for argv in (["label", "x", "--in", "a.csv", "--code"], ["label", "x", "--in", "a.csv", "--cod"],
                 ["label", "x", "--answers", "-"], ["file", "issue", "3", "--draft", "-"]):
        assert stdin_wait(argv) == 5.0, argv
    # what it reads when it is there: stdin_text's 1 s
    for argv in (["label", "x", "--set"], ["fix", "done", "3", "--cannot", "-"], ["fix", "new"]):
        assert stdin_wait(argv) == 1.0, argv
    # no stdin: no wait, and stdin is left alone; nor for what does not parse, which says nothing here
    for argv in (["label", "x", "--in", "a.csv", "--code", "rule.py"], ["label", "x", "--set", "a.csv#row=1=yes"],
                 ["label", "x", "--csv"], ["coverage"], ["fixes"], ["label", "--help"], ["no-such-command"],
                 ["label", "x", "--limit", "many"]):
        assert stdin_wait(argv) == 0, argv
    assert capsys.readouterr() == ("", "")


@ROOT_SKIP
def test_r2_a_command_the_plugin_does_not_take_runs_here_with_its_stdin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # nothing served it (a script whose Bash call names no thimble, a `!` command): before, it ran here with its stdin
    # already read, and a label's code on stdin was "no code"
    _, home, box, env = session(tmp_path)
    for k in ("THIMBLE_HOME", "THIMBLE_HANDOFF"):
        monkeypatch.setenv(k, env[k])
    monkeypatch.setattr(sys, "stdin", io.StringIO(CODE))
    monkeypatch.setattr(H, "TAKE_S", 0.2)
    home.chmod(0o500)
    try:
        assert H.handed_off(["label", "run_status", "--in", "runs.csv", "--code"]) is None
    finally:
        home.chmod(0o700)
    assert sys.stdin.read() == CODE
    assert list(box.iterdir()) == []


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
        assert list(box.iterdir()) == []
        # the plugin removed its request (it took the command for gone): it runs here all the same
        def drop() -> None:
            assert wait_for(lambda: list(box.glob("*.ask")))
            next(box.glob("*.ask")).unlink()
        threading.Thread(target=drop, daemon=True).start()
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
