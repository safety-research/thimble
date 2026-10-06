"""The sandbox of the scripts thimble-cc-mod runs itself: a card's script run again, a verification script, a view's
checks (which run its reader), the file browser's helper and a label's run. Claude Code's sandbox covers its tools'
calls, not a plugin's $.process.run, so the mod wraps these as browser mode wraps its notebook kernels
(backend/app/kernel_wrap.py, whose boundary this keeps):

  srt    on macOS: Anthropic's sandbox runtime (npm @anthropic-ai/sandbox-runtime, Seatbelt), run by
         helper/srt_run.mjs, where Node 20.11+ and the package a thimble install has are found
  bwrap  on Linux: bubblewrap with kernel_wrap's binds. srt on Linux is bubblewrap too, but it binds the folders it
         reads after those it writes, so a corpus read-only around its own writable .thimble-cc-mod/ would hide the
         write; bubblewrap run directly binds .thimble-cc-mod/ last
  none   neither runs: the scripts run as before, with the user's access, and the mod says so once

THIMBLE_KERNEL_WRAP, browser mode's switch, is read too: none runs the scripts unsandboxed; srt or bwrap names the
sandbox, which on Linux is bubblewrap either way; one that cannot run here is an error, and the mod then runs nothing.

The boundary:
  read     the system, the Python that runs the scripts and its packages (the user's site-packages too), Node (a view's
           checks draw it), the mod's folder and the corpus folder
  write    the folder's .thimble-cc-mod/ only
  hidden   the home folder and where user data lives (kernel_wrap.SRT_HIDDEN on macOS); bubblewrap shows only what it
           binds
  network  the host's, as for the kernels
  HOME     .thimble-cc-mod/sandbox/home under srt (TMPDIR inside it), a private /tmp/home under bubblewrap

    python3 sandbox.py plan --cwd DIR      the plan, probed on this machine, as one JSON line:
        {"wrap", "prefix", "python", "env", "line", "error"}: run [*prefix, python, script, ...] with env over the
        environment; "line" says what the sandbox does, for /thimble-cc-mod and the notice

The plan is made again each session and kept in the mod's memory, never in .thimble-cc-mod/, which the scripts can
write. Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import site
import subprocess
import sys
from pathlib import Path
from typing import Sequence

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # the mod's folder
HOME = ".thimble-cc-mod"
LAUNCHER = HERE / "srt_run.mjs"
WRAPS = ("none", "bwrap", "srt")
WRAP_ENV = "THIMBLE_KERNEL_WRAP"  # browser mode's switch (backend/app/config.py KERNEL_WRAP_ENV)

# kernel_wrap's lists, kept as it has them
SANDBOX_HOME = "/tmp/home"
SYSTEM_RO = ("/usr", "/lib", "/lib64", "/bin", "/sbin")
ETC_RO = ("ld.so.cache", "ld.so.conf", "ld.so.conf.d", "passwd", "group", "nsswitch.conf", "hosts", "host.conf",
          "resolv.conf", "gai.conf", "protocols", "services", "localtime", "timezone", "ssl", "ca-certificates",
          "ca-certificates.conf", "pki", "fonts", "alternatives", "mime.types", "magic", "magic.mime", "os-release")
EXTRA_RO = ("/var/cache/fontconfig",)
UNSET_ENV = ("XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR")
SRT_PACKAGE = ("frontend", "node_modules", "@anthropic-ai", "sandbox-runtime")  # under a thimble tree
NODE_MIN = (20, 11)
# kernel_wrap's macOS entries: where user data lives, and Claude Code's sandbox's temp folder
SRT_HIDDEN = ("/Users", "/Volumes", "/private/tmp", "/private/var/tmp", "/private/var/folders")
SRT_NO_WRITE = ("/tmp/claude", "/private/tmp/claude")
PROBE_S = 30.0

BOUNDS = "it reads this folder, writes only .thimble-cc-mod/, and keeps the network"


# ------------------------------------------------------------------------------------------------ what is read


def interpreter_dirs(exe: str | Path) -> list[Path]:
    """The installation folders `exe` runs from: the prefix of each symlink on the way to the real binary and of the
    binary itself, outside `/` (kernel_wrap.interpreter_dirs)."""
    out: list[Path] = []
    p = Path(exe)
    for _ in range(40):
        if not p.is_symlink():
            break
        p = Path(os.path.normpath(p.parent / os.readlink(p)))
        out.append(p.parent.parent)
    out.append(Path(os.path.realpath(exe)).parent.parent)
    return [d for d in dict.fromkeys(out) if d != Path("/")]


def python_dirs() -> list[Path]:
    """Where this Python finds its modules (it is the python3 the mod runs): sys.path's folders outside the mod's helper
    and the folder it started in, and the user's site-packages, which a fresh HOME would hide."""
    out = [Path(p) for p in sys.path if p and os.path.isdir(p)]
    user = site.getusersitepackages() if site.ENABLE_USER_SITE is not False else ""
    if user and os.path.isdir(user):
        out.append(Path(user))
    return [p for p in dict.fromkeys(Path(os.path.realpath(x)) for x in out) if p != HERE and p != Path("/")]


def user_env() -> dict[str, str]:
    """The environment that keeps the user's site-packages found under a fresh HOME."""
    user = site.getusersitepackages() if site.ENABLE_USER_SITE is not False else ""
    return {"PYTHONUSERBASE": site.getuserbase()} if user and os.path.isdir(user) else {}


def node() -> str | None:
    return shutil.which("node")


def node_version(exe: str) -> tuple[int, ...] | None:
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        return tuple(int(x) for x in out.lstrip("v").split(".")[:2])
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def srt_package() -> Path | None:
    """srt's package in a thimble tree: the one this mod ships in, else the install `thimble` on PATH runs."""
    trees = [ROOT.parent.parent]
    cli = shutil.which("thimble")
    if cli:
        trees.append(Path(os.path.realpath(cli)).parent.parent.parent)  # <tree>/plugin/bin/thimble
    for tree in dict.fromkeys(trees):
        p = tree.joinpath(*SRT_PACKAGE)
        if (p / "dist" / "index.js").is_file():
            return p
    return None


def system_name() -> str:
    return "darwin" if sys.platform == "darwin" else "linux"


# ------------------------------------------------------------------------------------------------ the wrappers


def _under(p: Path, root: Path) -> bool:
    return p == root or root in p.parents


def srt_rules(*, cwd: Path, read: Sequence[Path], home: str) -> dict:
    """srt's filesystem rules on macOS (kernel_wrap.srt_rules, with .thimble-cc-mod/ for the workspace and nothing in
    it hidden: the mod keeps no setting there)."""
    hide = [os.environ.get("CLAUDE_CONFIG_DIR", "")]
    return {"filesystem": {
        "denyRead": list(dict.fromkeys([home, *SRT_HIDDEN, *filter(None, hide)])),
        "allowRead": list(dict.fromkeys([str(cwd), *map(str, read)])),
        "allowWrite": [str(cwd / HOME)],
        "denyWrite": list(SRT_NO_WRITE),
    }}


def srt_prefix(*, node_exe: str, srt_dir: Path, rules: dict, box_home: Path) -> list[str]:
    return [node_exe, str(LAUNCHER), str(srt_dir), json.dumps(rules, separators=(",", ":")), "--home", str(box_home),
            "--"]


def bwrap_prefix(*, cwd: Path, read: Sequence[Path], bwrap: str = "bwrap") -> list[str]:
    """bubblewrap's argv before the command (kernel_wrap.kernel_wrap_argv, for one command that ends with its caller:
    --die-with-parent, and --new-session since nothing interrupts it)."""
    ws = cwd / HOME
    out = [bwrap, "--unshare-all", "--share-net", "--unshare-user", "--disable-userns", "--die-with-parent",
           "--new-session", "--ro-bind", "/usr", "/usr"]
    for d in SYSTEM_RO[1:]:
        out += ["--ro-bind-try", d, d]
    for name in ETC_RO:
        out += ["--ro-bind-try", f"/etc/{name}", f"/etc/{name}"]
    for d in EXTRA_RO:
        out += ["--ro-bind-try", d, d]
    out += ["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", SANDBOX_HOME, "--setenv", "HOME",
            SANDBOX_HOME]
    for name in (*UNSET_ENV, "TMPDIR"):
        out += ["--unsetenv", name]
    system = [Path(d) for d in SYSTEM_RO]
    for p in read:
        if not any(_under(p, d) for d in system):
            out += ["--ro-bind-try", str(p), str(p)]
    out += ["--ro-bind", str(cwd), str(cwd), "--bind", str(ws), str(ws), "--"]
    return out


def bwrap_works(bwrap: str | None) -> bool:
    """Whether bubblewrap can make the namespaces (kernel_wrap.works)."""
    if not bwrap:
        return False
    try:
        return subprocess.run([bwrap, "--unshare-all", "--share-net", "--unshare-user", "--disable-userns", "--ro-bind",
                               "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "true"],
                              capture_output=True, timeout=PROBE_S, check=False).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def probe(prefix: list[str], python: str, cwd: Path, env: dict[str, str]) -> str:
    """'' when the wrapped Python starts in the folder and can write .thimble-cc-mod/ but not the corpus folder, else
    what went wrong."""
    code = ("import os, sys\n"
            "open(os.path.join(sys.argv[1], '.thimble-cc-mod', 'sandbox', 'probe'), 'w').close()\n"
            "try:\n    open(os.path.join(sys.argv[1], '.thimble-cc-mod-probe'), 'w').close()\n"
            "except OSError:\n    print('ok')\n")
    try:
        r = subprocess.run([*prefix, python, "-c", code, str(cwd)], cwd=cwd, env={**os.environ, **env},
                           capture_output=True, text=True, timeout=PROBE_S, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        return f"it did not start: {type(e).__name__}"
    finally:
        stray = cwd / ".thimble-cc-mod-probe"
        if stray.exists():
            stray.unlink()
    if r.returncode == 0 and r.stdout.strip() == "ok":
        return ""
    if r.returncode == 0:
        return "it let a script write outside .thimble-cc-mod/"
    last = (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1]
    return f"a script could not start in it ({last[:160]})"


# ------------------------------------------------------------------------------------------------ the plan


def plan(cwd: str | Path, wrap: str | None = None) -> dict:
    """The sandbox for this folder's scripts on this machine (module docstring). `wrap` names one, as
    THIMBLE_KERNEL_WRAP does; None picks srt on macOS and bubblewrap on Linux, else none."""
    cwd = Path(os.path.realpath(cwd))
    box_home = cwd / HOME / "sandbox" / "home"
    (box_home / "tmp").mkdir(parents=True, exist_ok=True)
    python = sys.executable
    platform = system_name()
    read = [*interpreter_dirs(python), *python_dirs(), ROOT]
    node_exe = node()
    if node_exe:
        read += interpreter_dirs(node_exe)
    # never the corpus (bound on its own) nor a folder that holds the whole home folder
    read = [p for p in dict.fromkeys(read) if not _under(p, cwd) and not _under(Path.home().resolve(), p)]
    env = user_env()
    out = {"wrap": "none", "prefix": [], "python": python, "env": env, "line": "", "error": ""}
    by = f" ({WRAP_ENV})" if wrap else ""
    whys: list[str] = []

    def srt_try() -> dict | None:
        if not node_exe:
            whys.append(f"Node {'.'.join(map(str, NODE_MIN))} or later is not installed")
            return None
        have = node_version(node_exe)
        if have is None or have < NODE_MIN:
            whys.append(f"Node {'.'.join(map(str, have or ())) or '?'} is older than the sandbox runtime needs")
            return None
        pkg = srt_package()
        if pkg is None:
            whys.append("thimble's sandbox runtime (npm @anthropic-ai/sandbox-runtime) is not installed")
            return None
        rules = srt_rules(cwd=cwd, read=read, home=str(Path.home()))
        prefix = srt_prefix(node_exe=node_exe, srt_dir=pkg, rules=rules, box_home=box_home)
        bad = probe(prefix, python, cwd, env)
        if bad:
            whys.append(f"the sandbox runtime does not run here: {bad}")
            return None
        return {**out, "wrap": "srt", "prefix": prefix, "line": f"run in Anthropic's sandbox runtime{by} (Seatbelt): {BOUNDS}"}

    def bwrap_try() -> dict | None:
        exe = shutil.which("bwrap")
        if not bwrap_works(exe):
            whys.append("bubblewrap is not installed" if not exe else "bubblewrap cannot create namespaces here")
            return None
        prefix = bwrap_prefix(cwd=cwd, read=read, bwrap=exe or "bwrap")
        bad = probe(prefix, python, cwd, env)
        if bad:
            whys.append(f"bubblewrap does not run here: {bad}")
            return None
        return {**out, "wrap": "bwrap", "prefix": prefix, "line": f"run in bubblewrap{by}: {BOUNDS}"}

    if wrap == "none":
        return {**out, "line": f"run unsandboxed, with your user's access{by}"}
    if platform == "darwin":
        got = srt_try() if wrap != "bwrap" else None
        if wrap == "bwrap":
            whys.append("bubblewrap runs on Linux only")
    else:
        got = bwrap_try()
    if got:
        return got
    why = "; ".join(whys) or "no sandbox runs on this system"
    if wrap:
        return {**out, "wrap": wrap, "error": f"{WRAP_ENV}={wrap} names a sandbox that cannot run here ({why})",
                "line": f"do not run: {WRAP_ENV}={wrap} names a sandbox that cannot run here ({why})"}
    return {**out, "line": f"run unsandboxed, with your user's access ({why})"}


def requested() -> str | None:
    raw = os.environ.get(WRAP_ENV, "").strip().lower()
    return raw if raw in WRAPS else None


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="op", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--cwd", required=True)
    args = ap.parse_args(argv)
    if args.op == "plan":
        print(json.dumps(plan(args.cwd, requested())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
