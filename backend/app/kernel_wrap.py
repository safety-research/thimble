"""The notebook kernel's bubblewrap wrapper. The kernel runs model-authored code outside Claude Code's permission
checks, and `kernel_wrap_argv` narrows the files it sees: in bubblewrap it has no view of the Claude login, thimble's
settings, another workspace or another process's environment. It is not a security boundary: the kernel shares the
host's network, so a cell can reach thimble's API on 127.0.0.1 and any other local service. `config.resolve_kernel_wrap`
says when it is used. Stdlib only.

What the kernel gets:
  read     the system, a short list of /etc entries (ETC_RO), the backend venv and its interpreter, and the corpus
  write    the workspace directory except settings.json (an empty file in its place) and telemetry.jsonl (read-only);
           the connection file's directory; a private /tmp and HOME
  network  the host's: the server connects to the kernel's ZMQ ports on 127.0.0.1
Everything else is absent; `--unshare-all` gives a private pid namespace and /proc, and `--unshare-user
--disable-userns` keeps a cell from creating user namespaces.

`--die-with-parent` is left out because kernels outlive a server restart. `--new-session` is left out because it would
leave the process group the server signals; instead the argv starts with `sh -c 'trap "" INT; exec "$@"'` so bwrap
ignores SIGINT and the namespace's init passes it to the kernel. The in-kernel watchdog cannot see the server's pid, so
a wrapped kernel gets a lease file the server holds an flock on (notebook._WATCHDOG_SRC).
"""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

SANDBOX_HOME = "/tmp/home"  # HOME inside: a directory on the private /tmp tmpfs
SYSTEM_RO = ("/usr", "/lib", "/lib64", "/bin", "/sbin")  # /usr must exist; the rest are bound when present
ETC_RO = ("ld.so.cache", "ld.so.conf", "ld.so.conf.d", "passwd", "group", "nsswitch.conf", "hosts", "host.conf",
          "resolv.conf", "gai.conf", "protocols", "services", "localtime", "timezone", "ssl", "ca-certificates",
          "ca-certificates.conf", "pki", "fonts", "alternatives", "mime.types", "magic", "magic.mime", "os-release")
EXTRA_RO = ("/var/cache/fontconfig",)  # fontconfig's cache, so matplotlib's first import does not rescan the fonts
UNSET_ENV = ("XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR")
CONFIG_SUBDIR = ".claude-config"  # agents.config_dir: the per-workspace CLAUDE_CONFIG_DIR, with the login linked in
SETTINGS_FILE = "settings.json"  # cli.settings_path: the workspace's settings, the `kernel_wrap` switch among them
EMPTY_FILE = "/dev/null"  # bound over the workspace's settings.json
# bound read-only over the writable workspace when they exist
LOG_FILES = ("telemetry.jsonl",)
SIGINT_PREFIX = ("/bin/sh", "-c", 'trap "" INT; exec "$@"', "thimble-kernel-wrap")  # shell prefix that ignores SIGINT in bwrap (module docstring)


def _under(p: Path, root: Path) -> bool:
    return p == root or root in p.parents


def kernel_wrap_argv(argv: Sequence[str], *, corpus_dir: str | Path, workspace_dir: str | Path,
                     connection_dir: str | Path, venv: str | Path | None, python: str | Path,
                     bwrap: str = "bwrap", settings_file: bool | None = None) -> list[str]:
    """The kernel's argv wrapped in bubblewrap. `python` is the interpreter's real path; its installation is bound
    read-only when it lies outside /usr; `venv` None binds no venv. `--ro-bind-try` skips what does not exist. The
    /dev/null bind over settings.json is emitted only when the file exists, since bwrap would otherwise create an empty
    settings.json in the real workspace, which json.loads cannot read. `settings_file` None stats the file."""
    corpus, ws, conn = Path(corpus_dir), Path(workspace_dir), Path(connection_dir)
    if settings_file is None:
        settings_file = (ws / SETTINGS_FILE).is_file()
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
    prefix = Path(python).parent.parent  # <prefix>/bin/python3.x
    system = [Path(d) for d in SYSTEM_RO]
    if not any(_under(prefix, d) for d in system) and prefix != Path("/"):
        out += ["--ro-bind", str(prefix), str(prefix)]
    if venv is not None:
        out += ["--ro-bind", str(venv), str(venv)]
    out += ["--ro-bind", str(corpus), str(corpus), "--bind", str(ws), str(ws), "--bind", str(conn), str(conn)]
    if settings_file:
        # over the workspace bind: an empty file where settings.json is
        out += ["--ro-bind", EMPTY_FILE, str(ws / SETTINGS_FILE)]
    for name in LOG_FILES:  # read-only over the workspace bind when the file exists (the server appends from outside)
        out += ["--ro-bind-try", str(ws / name), str(ws / name)]
    out += ["--tmpfs", str(ws / CONFIG_SUBDIR), "--", *argv]
    return out

