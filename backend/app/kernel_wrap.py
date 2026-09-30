"""The notebook kernel's sandbox. The kernel runs model-authored code outside Claude Code's permission checks, so it
runs inside one of two wrappers, and `config.resolve_kernel_wrap` says which:

  srt    Anthropic's sandbox runtime (app/srt.py), on macOS (Seatbelt) and on Linux (bubblewrap): kernel_srt.mjs
         wraps the kernel with the rules `srt_rules` returns and stays its parent. The default wherever `srt_works`.
  bwrap  bubblewrap run directly (`kernel_wrap_argv`): the fallback on Linux where srt is missing or does not work.

Both draw the same boundary:
  read     the system, the backend venv and its interpreter, the corpus and the page's fonts and matplotlibrc
  write    the workspace directory, except settings.json and config.json (thimble's config for the workspace), which
           the kernel can neither read nor write, and telemetry.jsonl and the views folder, which it can read only.
           HOME and TMPDIR are fresh at each start: a private /tmp under bwrap, the kernel's kernels/<key>.home folder
           under srt
  hidden   the home folder, thimble's own folders (THIMBLE_HOME, the workspaces, the install tree), Claude Code's config
           and every other workspace
  network  the host's: the server connects to the kernel's ZMQ ports on 127.0.0.1
It is not a boundary against the network: a cell can reach thimble's API on 127.0.0.1 and any other local service.

srt reads everything it is not told to hide, so srt_rules hides where user data lives on each system (SRT_HIDDEN) and
shows the kernel's paths inside it again; bwrap shows only what kernel_wrap_argv binds. On Linux srt's bubblewrap also
blocks the creation of Unix sockets (seccomp), and each hidden directory is an empty tmpfs inside, so /tmp is private.

The direct bwrap wrapper: `--unshare-all` gives a private pid namespace and /proc, and `--unshare-user
--disable-userns` keeps a cell from creating user namespaces. `--die-with-parent` is left out because kernels outlive a
server restart. `--new-session` is left out because it would leave the process group the server signals; instead the
argv starts with `sh -c 'trap "" INT; exec "$@"'` so bwrap ignores SIGINT and the namespace's init passes it to the
kernel. Under srt the kernel is in a session of its own (srt's bubblewrap runs with --new-session), so the server
interrupts it with an interrupt_request instead of SIGINT. The in-kernel watchdog cannot see the server's pid in either,
so a wrapped kernel gets a lease file the server holds an flock on (notebook._WATCHDOG_SRC).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Sequence

from . import srt

SANDBOX_HOME = "/tmp/home"  # HOME inside bwrap: a directory on the private /tmp tmpfs
SYSTEM_RO = ("/usr", "/lib", "/lib64", "/bin", "/sbin")  # /usr must exist; the rest are bound when present
ETC_RO = ("ld.so.cache", "ld.so.conf", "ld.so.conf.d", "passwd", "group", "nsswitch.conf", "hosts", "host.conf",
          "resolv.conf", "gai.conf", "protocols", "services", "localtime", "timezone", "ssl", "ca-certificates",
          "ca-certificates.conf", "pki", "fonts", "alternatives", "mime.types", "magic", "magic.mime", "os-release")
EXTRA_RO = ("/var/cache/fontconfig",)  # fontconfig's cache, so matplotlib's first import does not rescan the fonts
UNSET_ENV = ("XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR")
# the workspace's settings (the `kernel_wrap` switch among them) and thimble's config for it: the server creates each
# before the kernel starts, and bwrap binds EMPTY_FILE over it (srt: read and write denied), so a cell can neither read
# nor write it
HIDDEN_FILES = ("settings.json", "config.json")
EMPTY_FILE = "/dev/null"
READ_ONLY_FILES = ("telemetry.jsonl",)  # read-only over the writable workspace (the server writes from outside)
# the workspace's views (views.py), which the server and the dev agent's view builds write and main's and the
# orientation's prompts are made from: read-only, as a folder so that what they write later shows inside. The server
# creates it before the kernel starts.
READ_ONLY_DIRS = ("views",)
SIGINT_PREFIX = ("/bin/sh", "-c", 'trap "" INT; exec "$@"', "thimble-kernel-wrap")  # shell prefix that ignores SIGINT in bwrap (module docstring)

SRT_LAUNCHER = Path(__file__).with_name("kernel_srt.mjs")
SRT_HELPERS = ("vendor", "seccomp")  # srt's apply-seccomp, which runs inside the sandbox on Linux
# Where user data lives on each system, hidden from the kernel under srt besides srt_rules' `hide`.
SRT_HIDDEN = {
    "linux": ("/home", "/root", "/mnt", "/media", "/srv", "/tmp", "/var/tmp", "/run/user"),
    "darwin": ("/Users", "/Volumes", "/private/tmp", "/private/var/tmp", "/private/var/folders"),
}
# srt lets every sandboxed process write /tmp/claude, the temp folder of Claude Code's own sandbox. On macOS the kernel
# could create it there, so it is denied; on Linux /tmp is a private tmpfs, and srt binds it only where it exists.
SRT_NO_WRITE = {"linux": (), "darwin": ("/tmp/claude", "/private/tmp/claude")}


PROBE_S = 10.0
SRT_PROBE_S = 30.0
_works: dict[str, bool] = {}  # works' answer, probed once per process
_srt_works: dict[tuple[str, str], bool] = {}  # srt_works' answers, probed once per process


def works() -> bool:
    """Whether bubblewrap can make the kernel's namespaces on this machine, probed once: bwrap is on PATH and may create
    user namespaces (Ubuntu 24.04 lets it only with an AppArmor profile for bwrap)."""
    if "ok" not in _works:
        bwrap, ok = shutil.which("bwrap"), False
        if bwrap:
            try:
                ok = subprocess.run([bwrap, "--unshare-all", "--share-net", "--unshare-user", "--disable-userns",
                                     "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "true"],
                                    capture_output=True, timeout=PROBE_S, check=False).returncode == 0
            except (OSError, subprocess.SubprocessError):
                ok = False
        _works["ok"] = ok
    return _works["ok"]


def srt_argv(argv: Sequence[str], *, node: str, srt_dir: Path, rules: dict) -> list[str]:
    """The kernel's argv run by kernel_srt.mjs inside srt with `rules` (srt_rules)."""
    return [node, str(SRT_LAUNCHER), str(srt_dir), json.dumps(rules, separators=(",", ":")), "--", *argv]


def srt_works(node: str | None, srt_dir: Path | None) -> bool:
    """Whether srt can sandbox a process on this machine, probed once per (node, package): `node` is recent enough
    (srt.NODE_MIN) and kernel_srt.mjs runs `true` in it (on Linux that needs bubblewrap and user namespaces; on macOS
    /usr/bin/sandbox-exec)."""
    if not node or srt_dir is None:
        return False
    key = (node, str(srt_dir))
    if key not in _srt_works:
        ok = False
        if (srt.node_version(node) or ()) >= srt.NODE_MIN:
            rules = {"filesystem": {"denyRead": [], "allowWrite": [], "denyWrite": []}}
            try:
                ok = subprocess.run(srt_argv(["true"], node=node, srt_dir=srt_dir, rules=rules), capture_output=True,
                                    stdin=subprocess.DEVNULL, timeout=SRT_PROBE_S, check=False).returncode == 0
            except (OSError, subprocess.SubprocessError):
                ok = False
        _srt_works[key] = ok
    return _srt_works[key]


def interpreter_dirs(python: str | Path) -> list[Path]:
    """The installation folders `python` runs from: the prefix (<prefix>/bin/python3.x) of each symlink on the way to
    the real binary and of the binary itself, outside `/`. A venv's bin/python usually links to its base interpreter,
    and a uv-managed one through a folder link per minor version (cpython-3.12-… → cpython-3.12.13-…), so each hop
    must resolve inside the sandbox as it does outside."""
    out: list[Path] = []
    p = Path(python)
    for _ in range(40):
        if not p.is_symlink():
            break
        p = Path(os.path.normpath(p.parent / os.readlink(p)))
        out.append(p.parent.parent)
    out.append(Path(os.path.realpath(python)).parent.parent)
    return [d for d in dict.fromkeys(out) if d != Path("/")]


def srt_rules(*, corpus_dir: str | Path, workspace_dir: str | Path, venv: str | Path | None, python: str | Path,
              srt_dir: str | Path, read: Sequence[str | Path] = (), hide: Sequence[str | Path] = (), home: str | Path,
              platform: str) -> dict:
    """srt's filesystem rules for the kernel (module docstring). `python` is the interpreter the kernel runs (a venv's
    bin/python); `read` more paths it reads (the fonts and matplotlibrc); `hide` thimble's folders and Claude Code's
    config, hidden besides `home` and SRT_HIDDEN[platform] (sys.platform: linux or darwin)."""
    ws = Path(workspace_dir)
    system = "darwin" if platform == "darwin" else "linux"
    hidden = [str(ws / name) for name in HIDDEN_FILES]
    deny_read = [str(home), *SRT_HIDDEN[system], *map(str, hide), *hidden]
    allow_read = [str(corpus_dir), str(ws), *map(str, interpreter_dirs(python)), *map(str, read)]
    if venv is not None:
        allow_read += [str(venv), os.path.realpath(venv)]  # a venv install.sh --python linked: also where it lies
    if system == "linux":
        allow_read.append(str(Path(srt_dir).joinpath(*SRT_HELPERS)))
        deny_read = _outermost(deny_read, allow_read)
    read_only = [str(ws / name) for name in (*READ_ONLY_FILES, *READ_ONLY_DIRS)]
    return {"filesystem": {
        "denyRead": list(dict.fromkeys(deny_read)),
        "allowRead": list(dict.fromkeys(allow_read)),
        "allowWrite": [str(ws)],
        "denyWrite": [*hidden, *read_only, *SRT_NO_WRITE[system]],
    }}


def _outermost(deny: Sequence[str], allow: Sequence[str]) -> list[str]:
    """`deny` without the entries another one already hides: each inside a denied folder with nothing in `allow` at or
    above it inside that folder (the home inside /home). On Linux srt shows a folder link on the interpreter's path
    (uv's minor-version folder) only when no denied entry but the one the link lies in surrounds the link's target."""
    real = [Path(os.path.realpath(p)) for p in deny]
    shown = [Path(os.path.realpath(p)) for p in allow]

    def hidden(p: Path) -> bool:
        return any(d != p and _under(p, d) and not any(_under(p, a) and _under(a, d) for a in shown) for d in real)

    return [s for s, p in zip(deny, real) if not hidden(p)]


def srt_env(env: dict[str, str], *, home: str | Path) -> dict[str, str]:
    """`env` for a kernel under srt: HOME `home` (a folder of the workspace, since the kernel may write nowhere else)
    with TMPDIR inside it, and no XDG_* folders."""
    out = {k: v for k, v in env.items() if k not in UNSET_ENV}
    out["HOME"] = str(home)
    out["TMPDIR"] = str(Path(home) / "tmp")
    return out


def _under(p: Path, root: Path) -> bool:
    return p == root or root in p.parents


def kernel_wrap_argv(argv: Sequence[str], *, corpus_dir: str | Path, workspace_dir: str | Path,
                     connection_dir: str | Path, venv: str | Path | None, python: str | Path,
                     read: Sequence[str | Path] = (), bwrap: str = "bwrap") -> list[str]:
    """The kernel's argv wrapped in bubblewrap. `python` is the interpreter the kernel runs; each of its installation
    folders (interpreter_dirs) is bound read-only when it lies outside the system folders; `venv` None binds no venv;
    `read` names more paths bound read-only. `--ro-bind-try` skips what does not exist. Each of HIDDEN_FILES must exist,
    or bwrap creates it empty in the real workspace, and each of READ_ONLY_DIRS, or bwrap fails."""
    corpus, ws, conn = Path(corpus_dir), Path(workspace_dir), Path(connection_dir)
    out: list[str] = [*SIGINT_PREFIX, bwrap, "--unshare-all", "--share-net", "--unshare-user", "--disable-userns",  # --unshare-user spelled out: --disable-userns checks for it by name (bwrap 0.9.0)
                      "--ro-bind", "/usr", "/usr"]
    for d in SYSTEM_RO[1:]:
        out += ["--ro-bind-try", d, d]
    for name in ETC_RO:
        out += ["--ro-bind-try", f"/etc/{name}", f"/etc/{name}"]
    for d in EXTRA_RO:
        out += ["--ro-bind-try", d, d]
    out += ["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", SANDBOX_HOME, "--setenv", "HOME", SANDBOX_HOME]
    for name in UNSET_ENV:
        out += ["--unsetenv", name]
    system = [Path(d) for d in SYSTEM_RO]
    for prefix in interpreter_dirs(python):
        if not any(_under(prefix, d) for d in system):
            out += ["--ro-bind", str(prefix), str(prefix)]
    if venv is not None:
        out += ["--ro-bind", str(venv), str(venv)]
    for p in read:
        out += ["--ro-bind-try", str(p), str(p)]
    out += ["--ro-bind", str(corpus), str(corpus), "--bind", str(ws), str(ws), "--bind", str(conn), str(conn)]
    for name in HIDDEN_FILES:
        out += ["--ro-bind", EMPTY_FILE, str(ws / name)]
    for name in READ_ONLY_FILES:  # read-only over the workspace bind (the server writes from outside)
        out += ["--ro-bind-try", str(ws / name), str(ws / name)]
    for name in READ_ONLY_DIRS:
        out += ["--ro-bind", str(ws / name), str(ws / name)]
    out += ["--", *argv]
    return out
