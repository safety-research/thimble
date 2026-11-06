"""The analyst's own Claude Code settings, as far as thimble reads them: effort, ultracode and the sandbox. thimble
writes none of their files.

Nothing here overrides a setting the analyst has. The server runs the browser's main itself (runtime.py), at the
effort Claude Code in a terminal runs main's model at: the analyst's own for that model, else Claude Code's default for
it (session_effort).

Claude Code reads, lowest first, the user's `settings.json` in its config dir, the project's `.claude/settings.json`
and `.claude/settings.local.json`, and the managed settings file. `ultracode`, CLAUDE_CODE_EFFORT_LEVEL (in an `env`
block or the environment), or an effort for main's model (`modelSettings.<model id>.effortLevel`, else a top-level
`effortLevel` in the project, local or managed file) is the analyst's choice. Claude Code reads a top-level
`effortLevel` in the user's own file only for LEGACY_EFFORT_MODELS.

The composer's effort and fast-mode choices for main are kept in the workspace's settings, never written into the
folder's Claude Code settings.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any, Mapping

from . import cc_plugin, config

log = logging.getLogger("thimble.cc_settings")

EFFORTS = ("low", "medium", "high", "xhigh", "max")  # the levels Claude Code takes (`claude --effort`)
ULTRACODE = "ultracode"  # the composer's choice beyond the levels: xhigh and a workflow for each message (main.md)
ULTRACODE_EFFORT = "xhigh"  # the effort Claude Code runs ultracode at
# Claude Code's default effort for a model, where it is not DEFAULT_EFFORT: its table of models' `default_effort`, as
# Claude Code 2.1.312 has it. A session runs at it when no settings file, variable or flag names an effort.
DEFAULT_EFFORTS = {"claude-opus-5-5": "medium", "claude-sonnet-5-5": "medium", "claude-haiku-5-5": "medium",
                   "claude-opus-4-7": "xhigh"}
DEFAULT_EFFORT = "high"  # Claude Code's default effort for every other model
# The models for which Claude Code still reads a top-level `effortLevel` in the user's own settings file; every later
# model reads only its `modelSettings` entry there.
LEGACY_EFFORT_MODELS = frozenset({
    "claude-3-5-haiku", "claude-3-5-sonnet", "claude-3-7-sonnet", "claude-haiku-4-5", "claude-sonnet-4-0",
    "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5",
    "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-fable-5", "claude-fable-5-1"})
MODEL_ENV = "ANTHROPIC_MODEL"  # the model a session runs when set, over every settings file's `model`
EFFORT_ENV = "CLAUDE_CODE_EFFORT_LEVEL"
LOCAL_SETTINGS = Path(".claude") / "settings.local.json"
PROJECT_SETTINGS = Path(".claude") / "settings.json"
MANAGED = {platform: d / cc_plugin.MANAGED_FILE for platform, d in cc_plugin.MANAGED_DIRS.items()}


def config_dir() -> Path:
    """The analyst's Claude Code config dir: the one main's `claude` process runs with (config.claude_config_dir)."""
    return config.claude_config_dir()


def _read(path: Path) -> dict[str, Any]:
    try:
        d = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def sources(cwd: Path) -> list[Path]:
    """The settings files Claude Code reads for a session in `cwd`, lowest precedence first."""
    managed = MANAGED.get(sys.platform)
    return [config_dir() / "settings.json", cwd / PROJECT_SETTINGS, cwd / LOCAL_SETTINGS, *([managed] if managed else [])]


def analyst_tiers() -> list[dict[str, Any]]:
    """The settings that are the analyst's own wherever a session runs, lowest precedence first: the user's settings.json
    and the org's managed tier (cc_plugin.managed: server-managed settings, else the managed file with its drop-ins). A
    corpus folder's .claude/ is left out, since a file planted there must not choose a permission mode or a command
    thimble runs."""
    return [_read(config_dir() / "settings.json"), cc_plugin.managed({config.CONFIG_DIR_ENV: str(config_dir())}) or {}]


def model_key(model: str | None) -> str:
    """The id Claude Code keeps a model's settings under (`modelSettings`): an alias written as its id
    (config.exact_model), without a `[1m]` tag or a date suffix, in lowercase; '' for none."""
    core = config.exact_model(str(model or "")).partition("[")[0].strip().lower()
    return re.sub(r"-\d{8}$", "", core)


def main_model(cwd: Path, environ: Mapping[str, str] | None = None) -> str:
    """The model a session in `cwd` starts on by the analyst's settings: ANTHROPIC_MODEL, else the highest settings
    file's `model`; '' when neither names one (Claude Code's own default, whose id is not known here)."""
    env = os.environ if environ is None else environ
    found = env.get(MODEL_ENV, "").strip()
    if found:
        return found
    for path in sources(cwd):
        m = _read(path).get("model")
        if isinstance(m, str) and m.strip():
            found = m.strip()
    return found


def _efforts(cwd: Path, environ: Mapping[str, str] | None = None,
             model: str | None = None) -> tuple[bool, str | None, bool | None, str | None, str | None]:
    """What the analyst's settings files say about the effort of a session in `cwd` on `model` (main_model's when None):
    (env names CLAUDE_CODE_EFFORT_LEVEL, its level, `ultracode`, the effort for that model, the user file's unread
    top-level `effortLevel`)."""
    key = model_key(main_model(cwd, environ) if model is None else model)
    user = sources(cwd)[0]
    named = False
    by_env = ultracode = level = unread = None
    for path in sources(cwd):  # lowest first, so a later file overwrites what an earlier one said
        d = _read(path)
        block = d.get("env") if isinstance(d.get("env"), dict) else {}
        raw = block.get(EFFORT_ENV)
        if raw not in (None, ""):
            named = True
            v = str(raw).strip().lower()
            by_env = v if v in EFFORTS else by_env
        if isinstance(d.get("ultracode"), bool):
            ultracode = d["ultracode"]
        per_model = d.get("modelSettings") if isinstance(d.get("modelSettings"), dict) else {}
        mine = [v.get("effortLevel") for k, v in per_model.items() if key and isinstance(v, dict) and model_key(k) == key]
        mine = [str(v).strip().lower() for v in mine if str(v or "").strip().lower() in EFFORTS]
        top = str(d.get("effortLevel") or "").strip().lower()
        top = top if top in EFFORTS else None
        if mine:
            level = mine[-1]
        elif top and (path != user or key in LEGACY_EFFORT_MODELS):
            level = top
        elif top:
            unread = top
    return named, by_env, ultracode, level, unread


def level_of(choice: str) -> str:
    """The effort level a composer choice runs at: the level itself, or xhigh for ultracode. ValueError for anything
    else."""
    c = str(choice or "").strip().lower()
    if c == ULTRACODE:
        return ULTRACODE_EFFORT
    if c not in EFFORTS:
        raise ValueError(f"effort must be one of {', '.join(EFFORTS + (ULTRACODE,))}")
    return c


def analyst_effort(cwd: Path, environ: dict[str, str] | None = None, model: str | None = None) -> str | None:
    """The effort the analyst's own settings or environment choose for a session in `cwd` on `model` (main_model's when
    None), as the effort menus name it: CLAUDE_CODE_EFFORT_LEVEL, else `ultracode`, else the effort for that model,
    else the user file's top-level `effortLevel`; None when they choose none."""
    env = os.environ if environ is None else environ
    value = env.get(EFFORT_ENV, "").strip().lower()
    if value in EFFORTS:
        return value
    _, by_env, ultracode, level, unread = _efforts(cwd, env, model)
    return by_env or (ULTRACODE if ultracode else level or unread)


def default_effort(model: str | None) -> str:
    """The effort Claude Code runs `model` at when nothing names one (DEFAULT_EFFORTS, by model_key)."""
    return DEFAULT_EFFORTS.get(model_key(model), DEFAULT_EFFORT)


def session_effort(cwd: Path, model: str) -> str:
    """The effort Claude Code runs a session in `cwd` on `model` at by the analyst's settings, as the effort menus name
    it: their own for that model (analyst_effort), else Claude Code's default for it (default_effort). The browser's
    main runs at it when the composer chose none (runtime.Space.spec_of), and the composer's chip shows it."""
    return analyst_effort(cwd, model=model) or default_effort(model)


# --------------------------------------------------------------------------- the sandbox
# Claude Code's Bash sandbox. On Linux it needs bubblewrap, socat and unprivileged user namespaces (which Ubuntu 24.04
# restricts unless an AppArmor profile allows bwrap), so sandbox_ok probes it once. A session where it cannot run gets
# no sandbox block and runs Bash under the analyst's permission mode instead. Inside bubblewrap the sandbox's seccomp
# helper makes a user namespace of its own, which a host can refuse while it lets bubblewrap make its own (AppArmor's
# profile for bwrap can confine what runs in it); every command then fails as its sandbox starts. srt runs the same
# helper, so on Linux sandbox_ok also takes srt's probe (kernel_wrap.srt_works, which the Messages API's Bash takes),
# wherever thimble's sandbox runtime can run.
SANDBOX_PROBE_S = 10.0
_sandbox: dict[str, Any] = {}  # sandbox_ok's probe: `ok`, _box_probe's answer, and `srt`, what srt's probe runs with


def sandbox_ok(refresh: bool = False) -> bool:
    """Whether Claude Code's Bash sandbox can run on this machine (the note above): bubblewrap probed once per process,
    and srt's probe as it stands, which a later probe that works makes True (the sysctl fixed, without a restart);
    `refresh` probes both again. The THIMBLE_SANDBOX environment variable set to 0 or 1 decides instead, for tests and
    for an analyst who wants it off."""
    forced = os.environ.get("THIMBLE_SANDBOX", "").strip()
    if forced in ("0", "1"):
        return forced == "1"
    if "ok" not in _sandbox or refresh:
        ok = _box_probe()
        _sandbox.update(ok=ok, srt=_srt_probe_with() if ok else None)
    if not _sandbox["ok"] or _sandbox["srt"] is None:
        return _sandbox["ok"]
    from . import kernel_wrap  # noqa: PLC0415

    node, package = _sandbox["srt"]
    if refresh and not kernel_wrap.srt_works(node, package):
        kernel_wrap.srt_problem(node, package)  # one that works now makes srt_works True
    return kernel_wrap.srt_works(node, package)


def _srt_probe_with() -> tuple[str, Path] | None:
    """The Node and the package srt's probe runs with on Linux (the note above); None elsewhere, and where thimble's
    sandbox runtime can't run (not installed, or a Node too old for it), where bubblewrap's probe answers alone."""
    if not sys.platform.startswith("linux"):
        return None
    from . import srt  # noqa: PLC0415

    node, package = srt.node(), srt.package(config.REPO_ROOT)
    return None if not node or package is None or srt.missing(config.REPO_ROOT, node) else (node, package)


def _box_probe() -> bool:
    """Whether bubblewrap makes its namespaces here with socat on PATH (on macOS: whether sandbox-exec is there)."""
    ok = False
    if sys.platform == "darwin":
        ok = Path("/usr/bin/sandbox-exec").exists()
    elif sys.platform.startswith("linux"):
        import shutil  # noqa: PLC0415
        import subprocess  # noqa: PLC0415

        bwrap, socat = shutil.which("bwrap"), shutil.which("socat")
        if bwrap and socat:
            try:
                done = subprocess.run([bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-all", "--die-with-parent",
                                       "true"], capture_output=True, timeout=SANDBOX_PROBE_S, check=False)
                ok = done.returncode == 0
            except (OSError, subprocess.SubprocessError):
                ok = False
    return ok


# A `claude` thimble starts gets the ANTHROPIC_* variables of this process (config.launch_environ), so that Claude Code
# signs in with them as in the analyst's terminal, and Claude Code passes its environment on to the commands it runs.
# So the sandbox unsets those variables for its commands (`credentials.envVars`, mode deny), as the card kernels go
# without them (notebook.kernel_env_of). CLAUDE_CODE_SUBPROCESS_ENV_SCRUB would unset them outside a sandbox too, but
# in Claude Code 2.1.307 it is a CI hardening mode: it writes empty files in place of a missing .bash_profile, .profile,
# .gitconfig, .netrc and others in the home folder, and of package.json, .env and lock files in the folder the session
# starts in (the corpus), and it forces the default permission mode.
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")  # a name Claude Code takes in credentials.envVars


def env_denies(environ: Mapping[str, str] | None = None) -> list[dict[str, str]]:
    """The `credentials.envVars` entries that unset each ANTHROPIC_* variable of `environ` (default this process's) for
    a command in the sandbox."""
    env = os.environ if environ is None else environ
    return [{"name": k, "mode": "deny"} for k in sorted(env) if k.startswith("ANTHROPIC_") and ENV_NAME.fullmatch(k)]


def offline_sandbox(auto_allow: bool = False, network: bool = False, required: bool = False) -> dict[str, Any]:
    """The `sandbox` settings of a session thimble fences (dev.ticket_fence, runtime_cc, marks): on, with no network unless
    `network` (then the analyst's own sandbox settings say where it reaches), no command run outside it, and none of
    this process's ANTHROPIC_* variables in its commands' environment (env_denies); `auto_allow` lets a command that
    runs in it skip its permission request; `required` (sandbox.enforce) has Claude Code refuse to start the session
    when its sandbox can't run, rather than run its commands unsandboxed."""
    out: dict[str, Any] = {"enabled": True, "failIfUnavailable": required, "autoAllowBashIfSandboxed": auto_allow,
                           "allowUnsandboxedCommands": False}
    denies = env_denies()
    if denies:
        out["credentials"] = {"envVars": denies}
    return out if network else {**out, "network": {"deniedDomains": ["*"]}}


def sandbox_missing() -> list[str]:
    """What the sandbox lacks on this machine, for `thimble doctor`: the programs not on PATH, or that bwrap cannot
    create a sandbox (user namespaces restricted); [] when it runs."""
    if sandbox_ok(refresh=True) or not sys.platform.startswith("linux"):
        return []
    import shutil  # noqa: PLC0415

    missing = [p for p in ("bwrap", "socat") if not shutil.which(p)]
    return missing or ["user namespaces for bwrap"]


# The root commands that make the sandbox run (sandbox_setup), which `thimble doctor` prints and never runs, since
# they need root (install.sh runs the same ones on a yes to its sandbox question). The packages are bubblewrap and socat
# on every distribution with one of these managers.
PACKAGE_INSTALL = (("apt-get", "apt-get install -y bubblewrap socat"), ("dnf", "dnf install -y bubblewrap socat"),
                   ("zypper", "zypper install -y bubblewrap socat"), ("pacman", "pacman -S --needed bubblewrap socat"),
                   ("apk", "apk add bubblewrap socat"))
# Ubuntu 23.10 and later set this to 1, so a program may create a user namespace only when an AppArmor profile lets
# it; bwrap needs one, and the profile below gives it.
APPARMOR_USERNS = Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
APPARMOR_DIR = Path("/etc/apparmor.d")
APPARMOR_PROFILE = ("abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap {bwrap} flags=(unconfined) {{\n  userns,\n"
                    "  include if exists <local/bwrap>\n}}\n")


def _apparmor_needed(bwrap: str) -> bool:
    """Whether bwrap needs an AppArmor profile to create user namespaces here and none in APPARMOR_DIR gives it one."""
    try:
        if APPARMOR_USERNS.read_text().strip() != "1":
            return False
    except OSError:
        return False
    try:
        return not any(bwrap in text and "userns" in text for text in
                       (p.read_text("utf-8", errors="replace") for p in APPARMOR_DIR.iterdir() if p.is_file()))
    except OSError:
        return True


# kernel_setup's packages: bubblewrap alone, which the card kernel's and terminal views' sandbox needs (no socat)
KERNEL_PACKAGE_INSTALL = (("apt-get", "apt-get install -y bubblewrap"), ("dnf", "dnf install -y bubblewrap"),
                          ("zypper", "zypper install -y bubblewrap"), ("pacman", "pacman -S --needed bubblewrap"),
                          ("apk", "apk add bubblewrap"))


def kernel_setup() -> tuple[list[str], str]:
    """(the root commands that would let bubblewrap make a sandbox on this machine, what they do or why there are none),
    for the doctor's card code and terminal views lines: sandbox_setup for bubblewrap alone, with the AppArmor profile
    when bwrap needs one, and no socat. [] off Linux, where bubblewrap runs (kernel_wrap.works), or when no root command
    is at hand. The commands are printed, never run."""
    if sys.platform != "linux":
        return [], ""
    import shutil  # noqa: PLC0415

    from . import kernel_wrap  # noqa: PLC0415

    if kernel_wrap.works():
        return [], ""
    found = shutil.which("bwrap")
    bwrap = found or "/usr/bin/bwrap"
    profile = _apparmor_needed(bwrap)
    what = " and ".join(filter(None, ["bubblewrap" if not found else "",
                                      "an AppArmor profile that lets bwrap create user namespaces" if profile else ""]))
    if not what:
        return [], "bwrap is installed but cannot create a sandbox here (user namespaces may be off, as in some containers)"
    root = os.geteuid() == 0
    if not root and not shutil.which("sudo"):
        return [], f"setting up {what} needs root: ask an administrator"
    sudo = "" if root else "sudo "
    cmds: list[str] = []
    if not found:
        install = next((cmd for tool, cmd in KERNEL_PACKAGE_INSTALL if shutil.which(tool)), None)
        if install is None:
            return [], "install bubblewrap with this system's package manager"
        cmds.append(sudo + install)
    if profile:
        path = APPARMOR_DIR / "bwrap"
        text = APPARMOR_PROFILE.format(bwrap=bwrap).replace("\n", "\\n")
        cmds.append(f"printf '{text}' | {sudo}tee {path} >/dev/null")
        cmds.append(f"{sudo}apparmor_parser -r {path}")
    return cmds, f"set up {what}"


def sandbox_setup() -> tuple[list[str], str]:
    """(the root commands that would make the sandbox run on this machine, what they do or why there are none), for
    `thimble doctor`: [] when it runs, off Linux, or when no root command is at hand (not root and no
    sudo), the second item then saying what an administrator installs. The commands are printed, never run."""
    if sys.platform != "linux" or sandbox_ok():
        return [], ""
    import shutil  # noqa: PLC0415

    wanted = [p for p in ("bwrap", "socat") if not shutil.which(p)]
    bwrap = shutil.which("bwrap") or "/usr/bin/bwrap"
    profile = _apparmor_needed(bwrap)
    what = " and ".join(filter(None, ["bubblewrap and socat" if wanted else "",
                                      "an AppArmor profile that lets bwrap create user namespaces" if profile else ""]))
    if not what:
        return [], "bwrap is installed but cannot create a sandbox here (user namespaces may be off, as in some containers)"
    root = os.geteuid() == 0
    if not root and not shutil.which("sudo"):
        return [], f"setting up {what} needs root: ask an administrator"
    sudo = "" if root else "sudo "
    cmds: list[str] = []
    if wanted:
        install = next((cmd for tool, cmd in PACKAGE_INSTALL if shutil.which(tool)), None)
        if install is None:
            return [], "install bubblewrap and socat with this system's package manager"
        cmds.append(sudo + install)
    if profile:
        path = APPARMOR_DIR / "bwrap"
        text = APPARMOR_PROFILE.format(bwrap=bwrap).replace("\n", "\\n")
        cmds.append(f"printf '{text}' | {sudo}tee {path} >/dev/null")
        cmds.append(f"{sudo}apparmor_parser -r {path}")
    return cmds, f"set up {what}"
