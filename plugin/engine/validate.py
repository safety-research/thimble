"""The marks' check after the checker fork answered, as the plugin's hooks run it (marks/checker.ts): JSON on stdin,
JSON on stdout. No model call. kernel/evidence.py reads the files and the calls' real outputs; the one code it runs is
the script of computed evidence, again, in thimble's sandbox (sandboxed), to see which files it reads.

    stdin   {"cwd": the working folder, "root": the folder the session started in, which the paths shown start from,
             "tmp": the session's temp folders, where Claude keeps its own code (a list: thimble's, and the one
             Claude Code's Bash sandbox gives a command; or one folder),
             "marks": [{"n", "words", "sentence"}], "answer": the checker's last message,
             "calls": [{"command", "output", "by": "checker" | "main"}],
             "cards": the session's cards' outputs (kernel/evidence.py check_card), or "cards_dir": the terminal's
             cards folder (cards/store.ts), read with terminal_cards,
             "labels_dir"?: the conversation's labels of the folder (labels.py), whose kept versions are cards too
             (terminal_label_cards),
             "at"?: when the marks' words were written, in seconds since the epoch: a label is read as it was then,
             "unread"?: the files the check could not read, by their absolute paths,
             "fresh"?: true for a check of citations whose source changed after their first check: computed evidence
             is then a call of this check's own (kernel/evidence.py check_mark),
             "srt"?: the folder srt is installed in, when it is not the one thimble's home holds for the plugin}
    stdout  {"parsed": bool, "results": [{"n", "status", "shown", "reason", "was"?, "failedBy"?, "evidence"?, "note"?,
             "sources"?, "rerun"?}], "outside"?: those of the "unread" files no evidence may cite, outside every folder
             a cited file may lie in (kernel/evidence.py uncitable)}

With "index": a path instead, it writes the cards' places and values there for the checker to grep (card_index), the
labels as they were at "at", and answers {"cards": the number of cards}. With "cited": checked citations instead, each
{"sources", "evidence"?, "rerun"?}, with "cwd", "root" and "tmp" as above, it answers {"cited": each as it stands now}
(kernel/evidence.py examine, which runs again the code of computed evidence whose files changed), in the same order.
With "run": {"script", "folder", "python", "flags", "argv", "folders"} instead, it runs that script once, as sandboxed
does, and answers {"ran": what sandboxed's run answers}: the browser workbench's way to the same sandbox.
"""
from __future__ import annotations

import json
import math
import os
import platform
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kernel import codebox  # noqa: E402
from kernel.evidence import card_index, check_all, examine, inside, terminal_cards, terminal_label_cards, uncitable  # noqa: E402
from kernel.store import thimble_home  # noqa: E402

RERUN_S = 60  # seconds a citation's script may run again: the hooks give this command two minutes in all
NOT_SET_UP = "the sandbox could not be"  # how run.mjs's own failure to set the sandbox up opens (its exit 3)
# what runs a script again in the sandbox: an audit hook notes each file the script opens to read (a database it
# connects to too; never one it writes, lists or stats), and as the script ends writes their absolute paths to its
# errors, after a line of the run's own mark ($THIMBLE_READS), one a line; the files of Python and of its packages are
# none of them. Then the script runs from stdin as the call ran it: as __main__, with the call's sys.argv (its first
# word in $THIMBLE_ARGV0, `-` or `-c`).
PRELUDE = r"""
import atexit, os, sys
def _thimble_reads(mark=os.environ.pop("THIMBLE_READS", "")):
    seen, reads = set(), []
    def note(p):
        try:
            p = os.fsdecode(p) if isinstance(p, bytes) else p
            if isinstance(p, str) and p and not p.startswith(":"):
                p = os.path.abspath(p)
                if p not in seen:
                    seen.add(p)
                    reads.append(p)
        except Exception:
            pass
    def hook(event, args):
        if event == "open" and args and not isinstance(args[0], int):
            mode = args[1] if len(args) > 1 else None
            flags = args[2] if len(args) > 2 else 0
            if isinstance(mode, str) and set(mode) & set("wax+"):
                return
            if mode is None and isinstance(flags, int) and flags & os.O_ACCMODE != os.O_RDONLY:
                return
            note(args[0])
        elif event == "sqlite3.connect" and args:
            note(args[0])
    def save():
        own = {os.path.realpath(p) for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, *sys.path) if p and os.path.isabs(p)}
        own.discard(os.path.realpath(START))
        def mine(p):
            r = os.path.realpath(p)
            return "__pycache__" in r.split(os.sep) or any(r == o or r.startswith(o + os.sep) for o in own)
        try:
            sys.__stderr__.flush()
            os.write(2, ("\n" + mark + "\n" + "".join(p + "\n" for p in reads if not mine(p))).encode("utf-8", "surrogateescape"))
        except Exception:
            pass
    atexit.register(save)
    sys.addaudithook(hook)
START = os.getcwd()
_code = sys.stdin.read()
sys.stdin = open(os.devnull)
sys.argv[0] = os.environ.pop("THIMBLE_ARGV0", "-")
_thimble_reads()
del _thimble_reads
exec(compile(_code, "<stdin>", "exec"), {"__name__": "__main__", "__builtins__": __builtins__})
"""


def py_dirs(py: str) -> list[str]:
    """The folders a Python program runs from: the folder above its own, along each link on the way to it, and the
    folder above the one a venv names as its home (pyvenv.cfg)."""
    dirs, at = [], py
    for _ in range(40):
        dirs.append(str(Path(os.path.abspath(at)).parent.parent))
        if not os.path.islink(at):
            break
        at = os.path.join(os.path.dirname(at), os.readlink(at))
    for d in list(dirs):
        try:
            cfg = (Path(d) / "pyvenv.cfg").read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        home = next((x.split("=", 1)[1].strip() for x in cfg if x.split("=", 1)[0].strip() == "home"), "")
        if home:
            dirs.append(str(Path(home).parent))
    return [d for d in dict.fromkeys(dirs) if d.startswith("/") and d != "/"]


def temp_base(shown: list[str]) -> str:
    """Where a run's temp folder goes: the first of the usual places for one that lies inside no folder the sandbox
    shows, since a folder it may write inside one it only reads would be read only too (the session's temp folders are
    shown, and the hooks' TMPDIR is one of them)."""
    for base in (tempfile.gettempdir(), "/tmp", "/var/tmp", str(thimble_home())):
        if os.path.isdir(base) and os.access(base, os.W_OK) and not inside(os.path.join(base, "x"), shown):
            return base
    return tempfile.gettempdir()


def python_of(word: str, folder: str) -> str | None:
    """The Python a call names (`python3`, `.venv/bin/python`): a path from the folder the script ran in, else the one
    on the PATH; python3 for a name the PATH lacks."""
    if "/" in word:
        at = os.path.normpath(os.path.join(folder, os.path.expanduser(word)))
        if os.path.isfile(at) and os.access(at, os.X_OK):
            return at
    return shutil.which(os.path.basename(word)) or shutil.which("python3")


def sandboxed(srt: str | None, folders: list[str]) -> Callable[..., dict[str, Any] | None] | None:
    """The runner of computed evidence's code (kernel/evidence.py Runner): run(script, folder, python, flags, argv) runs
    the script by the Python the call named, with the call's options and sys.argv, from the folder it ran in, in
    thimble's sandbox (codebox.rules, sandbox/run.mjs), and answers {output: what it printed, then its errors, as Claude
    Code's Bash tool gives them, reads: the files it opened to read inside `folders` or that folder, ok: whether it
    ended well}, or None when the sandbox could not be set up, the script ran out of time or the files it read did not
    come back. It reads the system, its Python, `folders` and that folder; it writes only a temp folder of its own
    (temp_base), removed after; it reaches no network. None when Node or srt is missing: srt is in `srt`, else in
    thimble's home at the pin of the plugin's sandbox/package.json (sandbox/setup.mjs installs it there at each session
    start)."""
    node = shutil.which("node")
    if not srt:
        try:
            pin = json.loads((codebox.SANDBOX / "package.json").read_text())["dependencies"]["@anthropic-ai/sandbox-runtime"]
        except (OSError, ValueError, KeyError):
            return None
        srt = str(thimble_home() / "srt" / pin)
    if not node or not os.path.isdir(os.path.join(srt, "node_modules")):
        return None
    linux = platform.system().lower() == "linux"
    shown = [f for f in folders if f]

    def run(script: str, folder: str, python: str = "python3", flags: Any = (), argv: Any = ("-",)) -> dict[str, Any] | None:
        py = python_of(python, folder) or sys.executable
        argv = [str(a) for a in argv] or ["-"]
        tmp = tempfile.mkdtemp(prefix="thimble-rerun-", dir=temp_base([*shown, folder]))
        mark = f"thimble-reads-{secrets.token_hex(16)}"
        try:
            rules = codebox.rules(linux=linux, srt=str(srt), shown=[*py_dirs(py), *shown, folder], writes=[tmp],
                                  home=str(Path.home()), th=str(thimble_home()))
            tz = [f"TZ={os.environ['TZ']}"] if os.environ.get("TZ") else []
            inner = ["/usr/bin/env", "-i", f"PATH={os.path.dirname(py)}:/usr/bin:/bin", f"HOME={tmp}", f"TMPDIR={tmp}",
                     "LANG=C.UTF-8", *tz, f"THIMBLE_READS={mark}", f"THIMBLE_ARGV0={argv[0]}", py, "-B", *map(str, flags),
                     "-c", PRELUDE, *argv[1:]]
            p = subprocess.run(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", str(node), str(codebox.SANDBOX / "run.mjs"),
                                "--srt", str(srt), json.dumps(rules), "--", *inner], input=script, capture_output=True,
                               text=True, errors="replace", cwd=folder, timeout=RERUN_S)
        except (OSError, subprocess.SubprocessError):
            return None
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        if p.returncode == 3 and NOT_SET_UP in p.stderr:
            return None
        # the files it read come after the run's mark, at the end of its errors; with no mark they did not come back
        errors, at, read = p.stderr.rpartition(f"\n{mark}\n")
        if not at:
            return None
        files = [r for r in dict.fromkeys(read.splitlines()) if inside(r, [*shown, folder]) and not inside(r, [tmp]) and os.path.isfile(r)]
        return {"output": p.stdout + errors, "reads": files, "ok": p.returncode == 0}

    return run


def main() -> int:
    req = json.load(sys.stdin)
    cwd, root, tmp = str(req.get("cwd") or "."), req.get("root") or None, req.get("tmp") or None
    temps = [tmp] if isinstance(tmp, str) else [str(t) for t in tmp or []]
    if isinstance(req.get("run"), dict):
        r = req["run"]
        run = sandboxed(req.get("srt") or None, [str(f) for f in r.get("folders") or [] if f])
        out = run(str(r.get("script") or ""), str(r.get("folder") or cwd), str(r.get("python") or "python3"),
                  list(r.get("flags") or []), list(r.get("argv") or ["-"])) if run else None
        json.dump({"ran": out}, sys.stdout, ensure_ascii=False)
        return 0
    # the code of computed evidence runs again where the session's folders are known
    run = sandboxed(req.get("srt") or None, [f for f in (cwd, root, *temps) if f]) if req.get("cwd") else None
    if isinstance(req.get("cited"), list):
        json.dump({"cited": examine(req["cited"], run)}, sys.stdout, ensure_ascii=False)
        return 0
    cards = req.get("cards") if isinstance(req.get("cards"), list) else terminal_cards(req.get("cards_dir"))
    cards = [*cards, *terminal_label_cards(req.get("labels_dir"))]
    at = req.get("at")
    at = float(at) if isinstance(at, (int, float)) and not isinstance(at, bool) and math.isfinite(at) else None
    if req.get("index"):
        Path(str(req["index"])).write_text(card_index(cards, at), encoding="utf-8")
        json.dump({"cards": len({str(c.get("id")) for c in cards})}, sys.stdout)
        return 0
    out = check_all(req.get("marks") or [], str(req.get("answer") or ""), req.get("calls") or [], cwd, root, tmp, cards, at=at,
                    fresh=req.get("fresh") is True, run=run)
    if isinstance(req.get("unread"), list) and req["unread"]:
        out["outside"] = uncitable([str(f) for f in req["unread"]], cwd, root, tmp)
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
