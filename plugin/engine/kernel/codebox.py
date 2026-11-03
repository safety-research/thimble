"""Code a caller gave thimble, run in thimble's own sandbox when the plugin runs the command for one in Claude Code's.

A command in Claude Code's Bash sandbox that may not write thimble's home is run by the plugin outside that sandbox
(handoff.py, hooks/handoff.ts), marked THIMBLE_HANDED_OFF. Such a command that runs code its caller gave (a label's
--code rule or --where expression, or a code label's rule again for --records) runs again in Anthropic's sandbox
runtime (srt), as the card runner and a fix's tests do (plugin/sandbox/run.mjs), with an environment of its own and
without the mark. It reads the system, its Python, the kernel, the folder under analysis, its working folder, thimble's
records of that folder and the session's temp folders. It writes only the records the command writes (the
conversation's records of the folder, the folder's cache, the session's change feed) and the temp folders. It reaches
no network. When the sandbox cannot start, the command does not run and says why. labels.py runs no such code in a
command that has the mark (code_here), so the code runs in the sandbox or not at all.

    needed(a)   whether the parsed command `a` runs only in the sandbox
    run(args)   the command `args` in the sandbox: no return once it starts there, else 1 and why
"""
from __future__ import annotations

import glob
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .store import Store, folder_name, legacy_dir, safe_name, temp_folders, thimble_home

HANDED = "THIMBLE_HANDED_OFF"  # set by the plugin for its run of a command from Claude Code's sandbox (handoff.ts)
ENGINE = Path(__file__).resolve().parents[1]
SANDBOX = ENGINE.parent / "sandbox"
# Linux: what is shown of the system, where everything else is hidden (fixes.py sandbox_argv)
LINUX_SYSTEM = ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc")
# macOS: the folders of people's files, hidden besides the home folder and thimble's home (cards/argv.mjs)
MACOS_HIDDEN = ("/Users", "/Volumes", "/private/tmp", "/private/var/tmp", "/private/var/folders")
# srt lets every command it runs write its own temp folder; this one may not (cards/argv.mjs NO_WRITE)
NO_WRITE = ("/tmp/claude", "/private/tmp/claude")
SETUP_S = 600  # setup.mjs installs srt the first time: minutes, on a slow network
CANNOT = "the plugin runs a label's code only in thimble's sandbox, which cannot start here: {why}"
OUTSIDE = "the plugin runs a label's code only in thimble's sandbox, and this run is not in it"


def handed() -> bool:
    """Whether the plugin runs this command for one in Claude Code's sandbox."""
    return bool(os.environ.get(HANDED))


def needed(a: Any) -> bool:
    """Whether the parsed command `a` runs code its caller gave in a run the plugin made for a command in Claude Code's
    sandbox: a label with --code or --where, or --records, which runs a code label's rule again."""
    if not handed() or getattr(a, "cmd", None) != "label":
        return False
    return a.code is not None or bool(a.where) or a.records is not None


def _py_dirs(py: str) -> list[str]:
    """The folders this Python runs from: its prefix and base prefix, and the folder of each link on the way to its
    program by the link's own name (fixes.py _py_dirs, for this process)."""
    dirs = [sys.prefix, sys.base_prefix, str(Path(os.path.realpath(py)).parent.parent)]
    at = py
    for _ in range(40):
        if not os.path.islink(at):
            break
        at = os.path.join(os.path.dirname(at), os.readlink(at))
        dirs.append(str(Path(os.path.normpath(at)).parent.parent))
    return [d for d in dict.fromkeys(dirs) if d.startswith("/")]


def _sandbox() -> dict[str, Any]:
    """sandbox/setup.mjs's answer, as the card runner has it (cards/ask.ts sandbox): {ok, node, srt, platform, why,
    fix}; it installs srt in thimble's home when it is missing."""
    node = shutil.which("node")
    if not node:
        return {"ok": False, "why": "Node is not on the PATH, and the sandbox runs on it", "fix": "Install Node 22.18 or later"}
    try:
        p = subprocess.run([node, str(SANDBOX / "setup.mjs"), "--home", str(thimble_home()), "--json"],
                           capture_output=True, text=True, timeout=SETUP_S, stdin=subprocess.DEVNULL)
        got = json.loads((p.stdout.strip().splitlines() or ["{}"])[-1])
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "why": f"its setup gave no answer ({e})", "fix": ""}
    return got if isinstance(got, dict) else {"ok": False, "why": "its setup gave no answer", "fix": ""}


def rules(*, linux: bool, srt: str, shown: list[str], writes: list[str], home: str, th: str) -> dict[str, Any]:
    """srt's rules for the command: no network; it writes only `writes`; on Linux it reads only the system, srt's
    seccomp helper, `shown` and `writes`, and on macOS everything but the folders of people's files, the home folder and
    thimble's home, besides `shown` and `writes`."""
    lit = lambda p: {"path": p, "literal": True}  # noqa: E731
    seccomp = f"{srt.rstrip('/')}/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp"
    show = [*([*LINUX_SYSTEM, seccomp] if linux else []), *shown, *writes]
    hidden = ["/"] if linux else [*MACOS_HIDDEN, home, th]
    return {
        "network": {"allowedDomains": [], "deniedDomains": []},
        "filesystem": {"denyRead": [lit(p) for p in dict.fromkeys(hidden)],
                       "allowRead": [lit(p) for p in dict.fromkeys(show) if p and p != "/"],
                       "allowWrite": [lit(p) for p in dict.fromkeys(writes)],
                       "denyWrite": [lit(p) for p in NO_WRITE]},
        **({"bwrapPath": str(SANDBOX / "bwrap.sh")} if linux else {}),
    }


def _places(st: Store) -> tuple[list[str], list[str], list[str]]:
    """What the command reads and writes, made where missing, as real paths: (what it reads, what it writes, the temp
    folders). It writes the conversation's records of the folder, the folder's cache, the session's change feed and
    the session's temp folders (thimble's home's tmp/ when the session has none); it reads besides them its Python, the
    kernel, the folder under analysis, its working folder, thimble's earlier records of the folder (store.py
    legacy_dir) and the other conversations' labels of it, whose model reads a --prompt label takes up again."""
    th = thimble_home()
    feed = th / "events" / f"{safe_name(st.session)}.jsonl"
    for d in (st.dir / "labels", st.cache, feed.parent):
        d.mkdir(parents=True, exist_ok=True)
    os.close(os.open(feed, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644))
    temps = [str(p) for p in temp_folders()]
    if not temps:
        (th / "tmp").mkdir(mode=0o700, parents=True, exist_ok=True)
        temps = [str((th / "tmp").resolve())]
    writes = [str(st.dir.resolve()), str(st.cache.resolve()), str(feed.resolve()), *temps]
    others = glob.glob(str(th.resolve() / "conversations" / "*" / "folders" / folder_name(str(st.root))))
    reads = [*_py_dirs(sys.executable), str(ENGINE), str(st.root), os.getcwd(),
             *[str(p.resolve()) for p in (legacy_dir(st.root),) if p.is_dir()], *sorted(others)]
    return reads, writes, temps


def command(args: list[str], st: Store, sb: dict[str, Any], reads: list[str], writes: list[str],
            temps: list[str]) -> list[str]:
    """The command that runs `args` in srt (run.mjs), for the store `st` and the sandbox `sb` (setup.mjs's answer): an
    empty environment but for this Python's folder on PATH, the folders and names the command would have found itself
    (thimble's home, the folder under analysis, the conversation and the session), and a temp folder of the session's
    as its HOME and TMPDIR; no THIMBLE_HANDED_OFF, so it runs the code there."""
    linux = (sb.get("platform") or platform.system().lower()) == "linux"
    th = str(thimble_home().resolve())
    r = rules(linux=linux, srt=str(sb["srt"]), shown=reads, writes=writes, home=str(Path.home()), th=th)
    py = sys.executable
    claude = os.environ.get("CLAUDE_CODE_TMPDIR")
    inner = ["/usr/bin/env", "-i", f"PATH={Path(py).parent}:/usr/bin:/bin", f"HOME={temps[0]}", f"TMPDIR={temps[0]}",
             "LANG=C.UTF-8", f"THIMBLE_HOME={th}", f"THIMBLE_ROOT={st.root}", f"THIMBLE_CONVERSATION={st.conversation}",
             f"THIMBLE_SESSION={st.session}", *([f"CLAUDE_CODE_TMPDIR={claude}"] if claude else []),
             py, "-B", str(ENGINE / "thimble.py"), *args]
    return ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", str(sb.get("node") or shutil.which("node") or "node"),
            str(SANDBOX / "run.mjs"), "--srt", str(sb["srt"]), json.dumps(r), "--", *inner]


def _exec(argv: list[str]) -> int:
    sys.stdout.flush()
    sys.stderr.flush()
    os.execv(argv[0], argv)
    return 1  # not reached


def run(args: list[str]) -> int:
    """The command `args` (a label that runs its caller's code, needed) run again in srt, in place of this process:
    stdin, stdout and stderr are its own, and so is the exit code (run.mjs's 3 when srt could not set the sandbox up).
    1, with why, when the sandbox cannot start; the code never runs here."""
    try:
        st = Store()
        reads, writes, temps = _places(st)
    except OSError as e:
        print(f"thimble label: {CANNOT.format(why=e)}", file=sys.stderr)
        return 1
    sb = _sandbox()
    if not sb.get("ok") or not sb.get("srt"):
        why = str(sb.get("why") or "its setup gave no answer").rstrip(".")
        fix = str(sb.get("fix") or "").rstrip(".")
        print(f"thimble label: {CANNOT.format(why=why)}{f'. {fix}' if fix else ''}", file=sys.stderr)
        return 1
    return _exec(command(args, st, sb, reads, writes, temps))
