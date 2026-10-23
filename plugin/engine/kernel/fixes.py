"""thimble fix: the person changes their own thimble from inside it, keeps the change, and can submit it.

Under $THIMBLE_HOME/fixes:

    live/            the checkout Claude Code loads thimble from once the first fix is on: branch `mine`, the release
                     commit plus one commit per fix that is on, in the order they went on. A GitHub install's live is
                     a clone of Claude Code's own clone of the marketplace, at the installed commit (no download); a
                     clone install's (scripts/install.sh --local) is a worktree of that clone, so `mine` shows there.
    work/<id>/       a fix's scratch worktree, cut from mine. The fixer edits only here, and its shell runs in the
                     sandbox runtime, which may write only here and in tmp/<id>/. Removed after apply or "not now".
    tmp/<id>/        the fixer's home and temp folder in the sandbox, and the log of the tests thimble ran
    fixes.jsonl      every request: one line per change of a fix's record; the last line of an id is its record
    release.json     where the release came from: the install's kind, its source, Claude Code's marketplace entry
                     before the first fix, the release commit (base) and its version
    state.json       {"on": false} while the person turned their fixes off (live then shows the release commit)
    off.sh           back to the plain release, also when thimble does not load: sh ~/.thimble/fixes/off.sh
    asks/<id>.json   the sha256 of the secret of the person's key press for apply, send and keep, which the plugin
                     writes at the press and gives the kernel on stdin; used once
    drafts/<id>/     a submit's draft: draft.json (before the scan, never sent), scan.json, pr.md and fix.patch (the
                     exact text that leaves), title
    sent/<id>/       what left the machine, or what the person saved as files

refs/thimble/fixes/<id> in live's repository keeps each fix's commit, on or off, so an undone fix can come back.

thimble's code, not Claude, commits, moves mine and points Claude Code's marketplace at live. Claude Code copies the
plugin from live into its own cache (`claude plugin update`), and the session loads it with /reload-plugins; its cache
is never edited here. Because Claude Code names a copy by the plugin's version, live's plugin.json carries the
release's version with the commit of mine after it (0.10.2+fix.4e1a9c2), written in live's working tree only.

A fix may not change the files that keep the person safe (PROTECTED): the fix flow, the privacy scan, the sandbox and
its settings, the hooks file and its command hooks, the launcher, thimble's scripts, and lock files. Binary files are
refused too. thimble checks this when the fixer ends (done); the fixer's prompt does not list these files.

The programs it runs can be replaced for tests: THIMBLE_CLAUDE (claude), THIMBLE_GH (gh), THIMBLE_GIT (the git that
pushes), THIMBLE_FIX_TESTS (the quick tests, a shell command), THIMBLE_FIX_PUSH_URL (where a pull request's commit is
pushed, with {login} and {name}).
"""
from __future__ import annotations

import fnmatch
import getpass
import hashlib
import json
import os
import platform
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from . import privacy as P
from .store import Store, thimble_home

PLUGIN = Path(__file__).resolve().parents[2]
STATES = ("working", "ready", "failed", "on", "off", "redo", "pending", "request", "sent", "saved", "released", "removed")
PLUGIN_JSON = "plugin/.claude-plugin/plugin.json"

# the files a fix may not change, by what each one is: what keeps undo, off, the sandbox and the scan working (fnmatch
# patterns over the repository's paths). The refusal names each file with what it is.
PROTECTED_KINDS = {
    "the fix flow": ("plugin/engine/kernel/fixes.py", "plugin/engine/kernel/share.py", "plugin/fix/*",
                     "plugin/prompts/fixer.md", "plugin/prompts/fix-draft.md", "browser/backend/app/dev.py",
                     "browser/backend/app/fix_share.py", "browser/frontend/src/fixes/share*"),
    "the privacy scan": ("plugin/engine/kernel/privacy.py",),
    "the sandbox": ("plugin/sandbox/*", "plugin/cards/argv.mjs", "browser/backend/app/kernel_wrap.py"),
    "the hooks file": ("plugin/hooks/hooks.json",),
    "a command hook": ("plugin/hooks/temp-allow.sh", "plugin/hooks/temp_allow.py"),
    "the launcher": ("plugin/bin/*",),
    "thimble's scripts": ("scripts/*", "browser/scripts/*"),
    "a lock file": ("*package-lock.json", "*yarn.lock", "*pnpm-lock.yaml", "*uv.lock", "*poetry.lock", "*Cargo.lock"),
}
PROTECTED = tuple(pat for pats in PROTECTED_KINDS.values() for pat in pats)


class FixError(Exception):
    """A step that cannot go on; its message is the one line the person reads, with what to do."""


# ------------------------------------------------------------------ places and programs


def home() -> Path:
    return thimble_home() / "fixes"


def live_dir() -> Path:
    return home() / "live"


def work_dir(fid: int) -> Path:
    return home() / "work" / str(fid)


def tmp_dir(fid: int) -> Path:
    return home() / "tmp" / str(fid)


def claude() -> str:
    return os.environ.get("THIMBLE_CLAUDE") or "claude"


def gh() -> str:
    return os.environ.get("THIMBLE_GH") or "gh"


def push_git() -> str:
    return os.environ.get("THIMBLE_GIT") or "git"


def run(cmd: list[str], cwd: str | Path | None = None, env: dict[str, str] | None = None, check: bool = True,
        stdin: str | None = None, timeout: float | None = 300) -> subprocess.CompletedProcess:
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, input=stdin, timeout=timeout)
    except FileNotFoundError:
        raise FixError(f"{cmd[0]} is not installed")
    except subprocess.TimeoutExpired:
        raise FixError(f"{' '.join(cmd[:3])} took longer than {int(timeout or 0)} s")
    if check and p.returncode != 0:
        err = (p.stderr or p.stdout).strip().splitlines()
        raise FixError(f"{' '.join(cmd[:3])} failed: {err[-1] if err else 'no message'}")
    return p


THIMBLE_ID = ["-c", "commit.gpgsign=false"]


def as_thimble() -> dict[str, str]:
    """The environment of a commit thimble makes: its author and committer are thimble, whatever the person's git
    identity is."""
    return {**os.environ, "GIT_AUTHOR_NAME": "thimble", "GIT_AUTHOR_EMAIL": "thimble@localhost",
            "GIT_COMMITTER_NAME": "thimble", "GIT_COMMITTER_EMAIL": "thimble@localhost"}


def git(*args: str, cwd: str | Path, env: dict[str, str] | None = None, check: bool = True) -> str:
    return run(["git", *args], cwd=cwd, env=env, check=check).stdout.strip()


def read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def write_json(p: Path, v: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(v, indent=1, ensure_ascii=False) + "\n")
    tmp.replace(p)


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def plugins_dir() -> Path:
    return config_dir() / "plugins"


def short(words: str, n: int = 48) -> str:
    w = re.sub(r"\s+", " ", words).strip()
    return w if len(w) <= n else w[: n - 1].rstrip() + "…"


# ------------------------------------------------------------------ the records


def records() -> dict[int, dict[str, Any]]:
    """Each fix's record: the last line of its id in fixes.jsonl."""
    out: dict[int, dict[str, Any]] = {}
    try:
        lines = (home() / "fixes.jsonl").read_text().splitlines()
    except OSError:
        return out
    for line in lines:
        try:
            r = json.loads(line)
            out[int(r["id"])] = r
        except (ValueError, KeyError, TypeError):
            continue
    return out


def get(fid: int | str) -> dict[str, Any]:
    try:
        n = int(str(fid).lstrip("#"))
    except ValueError:
        raise FixError(f"{fid} is not the number of a fix; thimble fix list shows them")
    r = records().get(n)
    if not r:
        raise FixError(f"there is no fix {n}; thimble fix list shows them")
    return r


def put(rec: dict[str, Any]) -> dict[str, Any]:
    """The record's new state, as one line appended in one write."""
    rec = {**rec, "updated": time.time()}
    home().mkdir(parents=True, exist_ok=True)
    line = json.dumps(rec, ensure_ascii=False) + "\n"
    fd = os.open(home() / "fixes.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)
    return rec


class Lock:
    """One change of live at a time (a key press and a session start at once)."""

    def __enter__(self):
        import fcntl  # noqa: PLC0415

        home().mkdir(parents=True, exist_ok=True)
        self.f = open(home() / "fixes.lock", "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        self.f.close()


# ------------------------------------------------------------------ where thimble came from, and live


def release() -> dict[str, Any]:
    return read_json(home() / "release.json") or {}


def _marketplace() -> dict[str, Any]:
    return (read_json(plugins_dir() / "known_marketplaces.json") or {}).get("thimble") or {}


def _installed_sha() -> str:
    entries = (read_json(plugins_dir() / "installed_plugins.json") or {}).get("plugins", {}).get("thimble@thimble") or []
    return str((entries[0] if entries else {}).get("gitCommitSha") or "")


def _version_at(repo: Path, commit: str) -> str:
    try:
        return str(json.loads(git("show", f"{commit}:{PLUGIN_JSON}", cwd=repo)).get("version") or "")
    except (FixError, ValueError):
        return ""


def find_source() -> dict[str, Any]:
    """Where the thimble that runs now came from: {kind, repo, commit, url, entry}.

    github: Claude Code's marketplace clone (a GitHub or git marketplace); live is cloned from it. clone: the person's
    own clone, a directory marketplace (scripts/install.sh --local) or the checkout a --plugin-dir session loads; live
    is a worktree of it."""
    m = _marketplace()
    src = m.get("source") if isinstance(m.get("source"), dict) else {}
    loc = m.get("installLocation")
    sha = _installed_sha()
    if src.get("source") == "directory" and src.get("path"):
        repo = Path(src["path"])
        top = git("rev-parse", "--show-toplevel", cwd=repo, check=False) if repo.is_dir() else ""
        if top:
            ok = sha and run(["git", "cat-file", "-e", sha + "^{commit}"], cwd=repo, check=False).returncode == 0
            return {"kind": "clone", "repo": top, "commit": sha if ok else git("rev-parse", "HEAD", cwd=repo),
                    "url": top, "entry": src}
    if src and loc and Path(loc).is_dir() and git("rev-parse", "--git-dir", cwd=loc, check=False):
        ok = sha and run(["git", "cat-file", "-e", sha + "^{commit}"], cwd=loc, check=False).returncode == 0
        url = git("remote", "get-url", "origin", cwd=loc, check=False) or (
            f"https://github.com/{src['repo']}.git" if src.get("repo") else str(src.get("url") or ""))
        return {"kind": "github", "repo": str(loc), "commit": sha if ok else git("rev-parse", "HEAD", cwd=loc),
                "url": url, "entry": src}
    repo = PLUGIN.parent
    top = git("rev-parse", "--show-toplevel", cwd=repo, check=False)
    if top and Path(top).resolve() == repo.resolve():
        return {"kind": "clone", "repo": str(repo), "commit": git("rev-parse", "HEAD", cwd=repo), "url": str(repo),
                "entry": None}
    raise FixError("this thimble was not installed from a git repository, so there is no copy of its code to change. "
                   "Install it again with scripts/install.sh, then ask again")


OFF_SH = """#!/bin/sh
# Back to the plain thimble release, also when thimble does not load: sh {off}
# It shows the release commit in {live} and has Claude Code copy it. Your fixes stay: `thimble fix on` brings them back.
live={live_q}
git -C "$live" checkout -q -- {plugin_json} 2>/dev/null
git -C "$live" checkout -q --detach {base} || {{ echo "thimble: could not show the release in $live"; exit 1; }}
printf '{{"on": false}}\\n' > {state_q}
{claude} plugin update thimble@thimble >/dev/null 2>&1
echo "thimble is the plain release again; your fixes are kept (thimble fix on). In Claude Code, type /reload-plugins."
"""


def _write_off_sh(rel: dict[str, Any]) -> None:
    off = home() / "off.sh"
    off.write_text(OFF_SH.format(off=off, live=live_dir(), live_q=shlex.quote(str(live_dir())), plugin_json=PLUGIN_JSON,
                                 base=shlex.quote(rel["base"]), state_q=shlex.quote(str(home() / "state.json")),
                                 claude=shlex.quote(claude())))
    off.chmod(0o755)


def ensure_live() -> dict[str, Any]:
    """live, made at the first request: nothing the person runs changes until the first fix goes on."""
    rel = release()
    live = live_dir()
    if rel and (live / ".git").exists():
        return rel
    src = find_source()
    repo, commit = Path(src["repo"]), src["commit"]
    home().mkdir(parents=True, exist_ok=True)
    if live.exists():
        shutil.rmtree(live)
    if src["kind"] == "github":
        git("clone", "-q", "--no-checkout", str(repo), str(live), cwd=home())
        if src.get("url"):
            git("remote", "set-url", "origin", src["url"], cwd=live)
        git("checkout", "-q", "-b", "mine", commit, cwd=live)
    else:
        has = run(["git", "rev-parse", "--verify", "-q", "refs/heads/mine"], cwd=repo, check=False).returncode == 0
        if has:
            raise FixError(f"your clone {repo} already has a branch named mine; rename it (git branch -m mine "
                           "mine-old), then ask again")
        git("worktree", "add", "-q", "-b", "mine", str(live), commit, cwd=repo)
    # the release's tag when the commit has one (v0.10.2), for its name in the list and in thimble update
    tag = git("describe", "--tags", "--exact-match", "--match", "v*", commit, cwd=live, check=False)
    rel = {"kind": src["kind"], "source": src["url"], "repo": str(repo), "entry": src.get("entry"), "base": commit,
           "version": _version_at(live, commit), "pointed": False, "created": time.time(),
           **({"tag": tag} if RELEASE_TAG.match(tag) else {})}
    write_json(home() / "release.json", rel)
    _write_off_sh(rel)
    return rel


def is_on() -> bool:
    return (read_json(home() / "state.json") or {}).get("on", True) is not False


def head() -> str:
    return git("rev-parse", "mine", cwd=live_dir())


# ------------------------------------------------------------------ Claude Code's copy of live


def _unstamp() -> None:
    run(["git", "checkout", "-q", "--", PLUGIN_JSON], cwd=live_dir(), check=False)


def _stamp() -> str:
    """live's plugin.json with a version of its own for what live shows now, so Claude Code makes a new copy: the
    release's version alone for the release commit, else that version + the commit (Claude Code names a copy by the
    version and keeps a copy it already has). A release with no version needs none: Claude Code names it by commit."""
    _unstamp()
    rel = release()
    now = git("rev-parse", "HEAD", cwd=live_dir())
    v = rel.get("version") or ""
    if not v or now == rel.get("base"):
        return v or now[:12]
    p = live_dir() / PLUGIN_JSON
    try:
        d = json.loads(p.read_text())
    except (OSError, ValueError):
        return v
    d["version"] = f"{v}+fix.{now[:7]}"
    p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    return d["version"]


def _repoint() -> None:
    """Point Claude Code's thimble marketplace at live, once, at the first fix. Claude Code also keeps the source in
    its user settings (extraKnownMarketplaces) and refuses another source for the name until that entry changes, so
    the entry changes first, and nothing else in the file; then Claude Code adds the marketplace from live. Removing
    the marketplace instead would uninstall thimble and lose its options."""
    rel = release()
    if rel.get("pointed"):
        return
    entry = {"source": "directory", "path": str(live_dir())}
    p = config_dir() / "settings.json"
    try:
        settings = json.loads(p.read_text())
    except FileNotFoundError:
        settings = None
    except (OSError, ValueError):
        raise FixError(f"thimble cannot read Claude Code's settings ({p}) to load thimble from your fixes")
    known = (settings or {}).get("extraKnownMarketplaces")
    if isinstance(known, dict) and isinstance(known.get("thimble"), dict):
        known["thimble"]["source"] = entry
        tmp = p.with_suffix(".json.thimble-tmp")
        tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
        os.chmod(tmp, p.stat().st_mode & 0o777)
        tmp.replace(p)
    run([claude(), "plugin", "marketplace", "add", str(live_dir())])
    _relink_cli()
    rel["pointed"] = True
    write_json(home() / "release.json", rel)


def _sync() -> dict[str, Any]:
    """Claude Code copies what live shows now into its cache. {reload, version}: whether the session should run
    /reload-plugins (false before the first fix pointed the marketplace at live)."""
    version = _stamp()
    if not release().get("pointed"):
        return {"reload": False, "version": version}
    run([claude(), "plugin", "update", "thimble@thimble"])
    return {"reload": True, "version": version}


# ------------------------------------------------------------------ the sandbox the fixer and its tests run in


def _python() -> str:
    return os.environ.get("THIMBLE_PYTHON") or sys.executable or "python3"


def _py_dirs(py: str) -> list[str]:
    p = run([py, "-c", "import sys; print(sys.prefix); print(sys.base_prefix)"], check=False)
    dirs = [x for x in p.stdout.split() if x.startswith("/")]
    real = os.path.realpath(shutil.which(py) or py)
    return sorted({*dirs, str(Path(real).parent.parent)})


def _srt_dir() -> Path:
    try:
        pin = json.loads((PLUGIN / "sandbox" / "package.json").read_text())["dependencies"]["@anthropic-ai/sandbox-runtime"]
    except (OSError, ValueError, KeyError):
        pin = ""
    return thimble_home() / "srt" / pin


def sandbox_argv(fid: int | str, path_extra: list[str] | None = None) -> list[str]:
    """The command that runs one shell command of the fixer, or its tests, in the sandbox runtime: no network, reads
    the system, the tools it needs and the copy's repository, writes only the copy and its temp folder. The command
    itself follows as /bin/bash -c CMD. `fid` names the copy: a fix's id, or `update`."""
    wt, tmp = home() / "work" / str(fid), home() / "tmp" / str(fid)
    tmp.mkdir(parents=True, exist_ok=True)
    srt = _srt_dir()
    if not (srt / "node_modules").is_dir():
        raise FixError("the sandbox runtime is not installed (thimble installs it at session start); start a new "
                       "session, then ask again")
    node = os.path.realpath(shutil.which("node") or "/usr/bin/node")
    py = _python()
    cl = shutil.which(claude())
    tools = [str(Path(node).parent.parent), *_py_dirs(py)]
    if cl:
        tools += [str(Path(cl).parent), str(Path(os.path.realpath(cl)).parent)]
    # the copy's git folder is live's (a worktree's .git file points into it), or the person's clone's: read only
    common = git("rev-parse", "--git-common-dir", cwd=wt, check=False)
    common = str((wt / common).resolve()) if common else ""
    linux = platform.system() == "Linux"
    lit = lambda p: {"path": p, "literal": True}  # noqa: E731
    system = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc"]
    seccomp = str(srt / "node_modules" / "@anthropic-ai" / "sandbox-runtime" / "vendor" / "seccomp")
    shown = [*(system + [seccomp] if linux else []), *tools, str(PLUGIN / "sandbox"), str(wt), str(tmp),
             *([common] if common else [])]
    hidden = ["/"] if linux else ["/Users", "/Volumes", "/private/tmp", "/private/var/tmp", "/private/var/folders",
                                   str(Path.home()), str(thimble_home())]
    rules = {
        "network": {"allowedDomains": [], "deniedDomains": [], **({"allowAllUnixSockets": True} if linux else {})},
        "filesystem": {"denyRead": [lit(p) for p in dict.fromkeys(hidden)],
                       "allowRead": [lit(p) for p in dict.fromkeys(x for x in shown if x and x != "/")],
                       "allowWrite": [lit(str(wt)), lit(str(tmp))], "denyWrite": []},
        **({"bwrapPath": str(PLUGIN / "sandbox" / "bwrap.sh")} if linux else {}),
    }
    py_bin = str(Path(shutil.which(py) or py).parent)
    path = ":".join(dict.fromkeys([*(path_extra or []), *([str(Path(cl).parent)] if cl else []), py_bin,
                                   str(Path(node).parent), "/usr/bin", "/bin"]))
    return ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", node, str(PLUGIN / "sandbox" / "run.mjs"), "--srt", str(srt),
            json.dumps(rules), "--", "/usr/bin/env", "-i", f"PATH={path}", f"HOME={tmp}", f"TMPDIR={tmp}",
            f"CLAUDE_CONFIG_DIR={tmp / 'claude'}", f"THIMBLE_HOME={tmp / 'thimble'}", f"THIMBLE_PYTHON={py}",
            "DISABLE_AUTOUPDATER=1", "LANG=C.UTF-8", "/bin/bash", "-c"]


def _has_pytest(py: str) -> bool:
    return run([py, "-c", "import pytest"], check=False).returncode == 0


QUICK_TESTS = "claude plugin test plugin"


def run_tests(fid: int | str) -> tuple[bool, str]:
    """The quick tests in the copy, in the sandbox: the hooks tests, and the kernel's when this Python has pytest
    (THIMBLE_FIX_TESTS, a shell command, replaces them). (passed, the log's last lines)."""
    cmd = os.environ.get("THIMBLE_FIX_TESTS")
    if not cmd:
        parts = [QUICK_TESTS]
        if _has_pytest(_python()):
            parts.append('"$THIMBLE_PYTHON" -m pytest plugin -q -x -p no:cacheprovider')
        cmd = " && ".join(parts)
    try:
        argv = sandbox_argv(fid) + [cmd]
    except FixError as e:
        return False, str(e)
    try:
        p = subprocess.run(argv, cwd=home() / "work" / str(fid), capture_output=True, text=True, timeout=540)
    except subprocess.TimeoutExpired:
        return False, "the tests ran longer than 9 minutes"
    log = (p.stdout + p.stderr).strip()
    (home() / "tmp" / str(fid)).mkdir(parents=True, exist_ok=True)
    (home() / "tmp" / str(fid) / "tests.log").write_text(log + "\n")
    return p.returncode == 0, "\n".join(log.splitlines()[-12:])


# ------------------------------------------------------------------ a request


def new(words: str, made_in: str = "terminal", title: str | None = None) -> dict[str, Any]:
    words = (words or "").strip()
    if not words:
        raise FixError("say what should work differently: /thimble-fix make the bar say how many citations failed")
    with Lock():
        ensure_live()
        recs = records()
        fid = max(recs, default=0) + 1
        wt = work_dir(fid)
        if wt.exists():
            shutil.rmtree(wt)
        base = head()
        wt.parent.mkdir(parents=True, exist_ok=True)
        git("worktree", "add", "-q", "--detach", str(wt), base, cwd=live_dir())
        tmp_dir(fid).mkdir(parents=True, exist_ok=True)
        rec = {"id": fid, "title": (title or short(words)).strip(), "words": [words], "rounds": 1, "made_in": made_in,
               "created": time.time(), "state": "working", "work": str(wt), "base": base, "commit": None, "files": [],
               "tests": None, "summary": "", "error": None, "root": os.environ.get("THIMBLE_ROOT") or None}
        return put(rec)


def round_(fid: int | str, words: str) -> dict[str, Any]:
    """More words for a fix whose copy is still there: a new round of the same fix."""
    rec = get(fid)
    if not rec.get("work") or not Path(rec["work"]).is_dir():
        raise FixError(f"fix {rec['id']} has no copy any more; ask for a new fix")
    rec.update(words=[*rec.get("words", []), words.strip()], rounds=int(rec.get("rounds") or 1) + 1, state="working",
               error=None)
    return put(rec)


def _numstat(repo: Path, a: str, b: str) -> list[dict[str, Any]]:
    out = []
    for line in git("-c", "core.quotePath=false", "diff", "--numstat", a, b, cwd=repo).splitlines():
        add, dele, path = (line.split("\t", 2) + ["", "", ""])[:3]
        out.append({"path": path, "add": None if add == "-" else int(add), "del": None if dele == "-" else int(dele)})
    return out


def protected_of(paths: list[str]) -> list[str]:
    return [p for p in paths if any(fnmatch.fnmatch(p, pat) for pat in PROTECTED)]


def _and(words: list[str]) -> str:
    return " and ".join(words) if len(words) < 3 else ", ".join(words[:-1]) + ", and " + words[-1]


def protected_why(paths: list[str]) -> str:
    """The refusal for a fix that changes protected files: each file, with what it is, and why thimble refuses."""
    kinds: dict[str, list[str]] = {}
    for p in paths:
        kind = next(k for k, pats in PROTECTED_KINDS.items() if any(fnmatch.fnmatch(p, pat) for pat in pats))
        kinds.setdefault(kind, []).append(p)
    named = [f"{_and(ps)} ({kind})" for kind, ps in kinds.items()]
    return f"it changes {_and(named)}; thimble does not apply changes to its safety files"


def done(fid: int | str, title: str | None = None, summary: str = "", request: bool = False,
         tests: bool = True) -> dict[str, Any]:
    """The fixer ended: thimble commits its change in the copy, checks what it changed, and runs the quick tests in
    the sandbox. ready, failed (with the reason), or a request with no code."""
    rec = get(fid)
    wt = Path(rec.get("work") or "")
    if not wt.is_dir():
        raise FixError(f"fix {rec['id']} has no copy")
    if title and title.strip():
        rec["title"] = short(title, 60)
    rec["summary"] = (summary or "").strip()[:2000]
    git("add", "-A", cwd=wt)
    changed = run(["git", "diff", "--cached", "--quiet", rec["base"]], cwd=wt, check=False).returncode != 0
    if request or not changed:
        git("reset", "-q", "--hard", rec["base"], cwd=wt)
        rec.update(state="request", files=[], commit=None, tests=None)
        _drop_work(rec)
        return put(rec)
    # the fix is one commit on the commit its copy was cut from, whatever the copy's own history holds
    tree = git("write-tree", cwd=wt)
    commit = git(*THIMBLE_ID, "commit-tree", tree, "-p", rec["base"], "-m",
                 f"{rec['title']}\n\n{rec['summary']}\n\nthimble fix {rec['id']}".strip(), cwd=wt, env=as_thimble())
    git("reset", "-q", "--hard", commit, cwd=wt)
    git("update-ref", f"refs/thimble/fixes/{rec['id']}", commit, cwd=wt)
    files = _numstat(wt, rec["base"], commit)
    rec.update(commit=commit, files=files)
    bad = protected_of([f["path"] for f in files])
    binary = [f["path"] for f in files if f["add"] is None]
    if bad:
        rec.update(state="failed", tests=None, error=protected_why(bad))
        return put(rec)
    if binary:
        rec.update(state="failed", tests=None, error=f"it adds or changes a binary file ({binary[0]}); a fix changes text only")
        return put(rec)
    if tests:
        ok, tail = run_tests(rec["id"])
        rec.update(tests="passed" if ok else "failed", tests_tail=tail)
        rec.update(state="ready" if ok else "failed", error=None if ok else "its tests failed in the sandbox")
    else:
        rec.update(tests="skipped", state="ready", error=None)
    return put(rec)


def _drop_work(rec: dict[str, Any]) -> None:
    wt = rec.get("work")
    if wt and Path(wt).exists():
        run(["git", "worktree", "remove", "--force", wt], cwd=live_dir(), check=False)
        shutil.rmtree(wt, ignore_errors=True)
    run(["git", "worktree", "prune"], cwd=live_dir(), check=False)
    rec["work"] = None


# ------------------------------------------------------------------ the person's key


def key_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def check_ask(fid: int, secret: str | None) -> None:
    """The person pressed the key: the plugin wrote the sha256 of the press's secret into asks/<id>.json and gives the
    secret here on stdin. Used once."""
    p = home() / "asks" / f"{fid}.json"
    ask = read_json(p) or {}
    key, s = str(ask.get("key") or ""), str(secret or "").strip()
    try:
        p.unlink()
    except OSError:
        pass
    if not (key and s and secrets.compare_digest(key, key_hash(s))):
        raise FixError("only the person's key press in thimble does that")


def at_person_terminal() -> bool:
    """A person typing in a terminal: a terminal on stdin and stdout, outside a command Claude Code runs (its Bash
    tool sets CLAUDECODE and gives a command no terminal)."""
    return sys.stdin.isatty() and sys.stdout.isatty() and not os.environ.get("CLAUDECODE")


def apply_typed(fid: int | str, answer=input) -> dict[str, Any] | None:
    """`thimble fix apply ID` typed by the person in their own terminal: thimble asks, and their y is the key press.
    None when they say no."""
    rec = get(fid)
    if not at_person_terminal():
        raise FixError("only the person applies a fix: type thimble fix apply in your own terminal, or press y in thimble")
    if str(answer(f'Use fix {rec["id"]} "{rec["title"]}" now? [y/N] ')).strip().lower() not in ("y", "yes"):
        return None
    secret = secrets.token_hex(16)
    write_json(home() / "asks" / f"{rec['id']}.json", {"key": key_hash(secret)})
    return apply(rec["id"], secret)


# ------------------------------------------------------------------ on, off, undo


def _on_ids(recs: dict[int, dict[str, Any]]) -> list[int]:
    return [r["id"] for r in sorted((r for r in recs.values() if r.get("state") == "on"), key=lambda r: r.get("on_at") or 0)]


def _rebuild(order: list[int]) -> list[int]:
    """mine again: the release commit plus each fix of `order` that still applies, in that order. The fixes that do
    not apply any more, which then need a redo."""
    rel, live = release(), live_dir()
    _unstamp()
    git("checkout", "-q", "-B", "mine", rel["base"], cwd=live)
    failed = []
    for fid in order:
        ref = f"refs/thimble/fixes/{fid}"
        p = run(["git", *THIMBLE_ID, "cherry-pick", "--keep-redundant-commits", ref], cwd=live, check=False, env=as_thimble())
        if p.returncode != 0:
            run(["git", "cherry-pick", "--abort"], cwd=live, check=False)
            failed.append(fid)
            continue
        git("update-ref", ref, "HEAD", cwd=live)
    return failed


def _move(change) -> dict[str, Any]:
    """Change live (a function of the records), then have Claude Code copy it."""
    with Lock():
        out = change()
        synced = _sync()
    return {**(out or {}), **synced}


def apply(fid: int | str, secret: str | None) -> dict[str, Any]:
    """y: the fix goes on. thimble cherry-picks its commit onto mine, points the marketplace at live the first time,
    and has Claude Code copy live; the plugin then runs /reload-plugins."""
    rec = get(fid)
    check_ask(rec["id"], secret)
    if rec.get("state") not in ("ready", "off", "redo", "pending") or not rec.get("commit"):
        raise FixError(f"fix {rec['id']} is {rec.get('state')}, so there is nothing to apply")
    if rec.get("state") == "redo":
        raise FixError(f"fix {rec['id']} does not fit your thimble any more; r asks Claude to redo it")
    if rec.get("state") == "pending":
        raise FixError(f"thimble update set fix {rec['id']} aside at {release_name()}, so that nothing is fixed twice: "
                       "thimble reapply in a shell has Claude check it against the release and bring it back")

    def change():
        live = live_dir()
        _unstamp()
        # a fix the person turns on while all are off: the others come back with it
        git("checkout", "-q", "mine", cwd=live)
        write_json(home() / "state.json", {"on": True})
        p = run(["git", *THIMBLE_ID, "cherry-pick", "--keep-redundant-commits", f"refs/thimble/fixes/{rec['id']}"], cwd=live,
                check=False, env=as_thimble())
        if p.returncode != 0:
            run(["git", "cherry-pick", "--abort"], cwd=live, check=False)
            r = get(rec["id"])
            r.update(state="redo", error="it does not fit the fixes you have on")
            put(r)
            raise FixError(f"fix {rec['id']} does not fit the fixes you have on; r asks Claude to redo it")
        new_commit = git("rev-parse", "HEAD", cwd=live)
        git("update-ref", f"refs/thimble/fixes/{rec['id']}", new_commit, cwd=live)
        _repoint()
        r = get(rec["id"])
        r.update(state="on", on_at=time.time(), commit=new_commit, error=None)
        _drop_work(r)
        put(r)
        return {"id": r["id"], "title": r["title"], "commit": new_commit}

    return _move(change)


def not_now(fid: int | str) -> dict[str, Any]:
    """n: a ready fix stays in the list, off, its commit kept for u; its copy goes. A fix that failed stays failed,
    for r."""
    rec = get(fid)
    if rec.get("state") not in ("ready", "failed"):
        raise FixError(f"fix {rec['id']} is {rec.get('state')}")
    if rec["state"] == "ready":
        rec.update(state="off", note="not now")
    _drop_work(rec)
    return put(rec)


def redo(fid: int | str, words: str = "") -> dict[str, Any]:
    """r: a new copy, cut from mine as it is now, for the same fix: the fixer gets the person's words again, and the
    earlier change (tmp/<id>/earlier.patch) to start from."""
    rec = get(fid)
    if rec.get("state") not in ("redo", "pending", "failed", "off", "ready", "request"):
        raise FixError(f"fix {rec['id']} is {rec.get('state')}")
    with Lock():
        ensure_live()
        earlier = diff_of(rec) if rec.get("commit") else ""
        _drop_work(rec)
        wt = work_dir(rec["id"])
        if wt.exists():
            shutil.rmtree(wt)
        base = head()
        git("worktree", "add", "-q", "--detach", str(wt), base, cwd=live_dir())
        tmp_dir(rec["id"]).mkdir(parents=True, exist_ok=True)
        if earlier.strip():
            (tmp_dir(rec["id"]) / "earlier.patch").write_text(earlier)
        rec.update(state="working", work=str(wt), base=base, error=None, tests=None, rounds=int(rec.get("rounds") or 1) + 1,
                   words=[*rec.get("words", []), *([words.strip()] if words.strip() else [])])
        return put(rec)


def undo(fid: int | str) -> dict[str, Any]:
    """u: the fix's commit comes out of mine and stays under its ref, so it can go on again."""
    rec = get(fid)
    if rec.get("state") != "on":
        raise FixError(f"fix {rec['id']} is not on")

    def change():
        recs = records()
        order = [i for i in _on_ids(recs) if i != rec["id"]]
        failed = _rebuild(order)
        r = get(rec["id"])
        r.update(state="off", note="undone")
        put(r)
        for i in failed:
            x = recs[i]
            x.update(state="redo", error=f"it did not fit once fix {rec['id']} was undone")
            put(x)
        if is_on():
            git("checkout", "-q", "mine", cwd=live_dir())
        else:
            git("checkout", "-q", "--detach", release()["base"], cwd=live_dir())
        return {"id": rec["id"], "title": rec["title"], "redo": failed}

    return _move(change)


def remove(fid: int | str) -> dict[str, Any]:
    """x: the fix leaves the list (its record stays in fixes.jsonl, as removed)."""
    rec = get(fid)
    was_on = rec.get("state") == "on"
    out: dict[str, Any] = {"id": rec["id"], "title": rec["title"], "reload": False}
    if was_on:
        out = undo(rec["id"])
    r = get(rec["id"])
    _drop_work(r)
    r.update(state="removed")
    put(r)
    return out


def all_off() -> dict[str, Any]:
    """thimble fix off: live shows the plain release; every fix keeps its state for `on`."""
    if not (live_dir() / ".git").exists():
        return {"reload": False, "said": "You have no fixes on: thimble is the plain release."}

    def change():
        _unstamp()
        git("checkout", "-q", "--detach", release()["base"], cwd=live_dir())
        write_json(home() / "state.json", {"on": False})
        return {"said": "thimble is the plain release again; your fixes are kept (thimble fix on)."}

    return _move(change)


def all_on() -> dict[str, Any]:
    """thimble fix on: the fixes that were on, on again."""
    if not (live_dir() / ".git").exists():
        return {"reload": False, "said": "You have no fixes yet."}

    def change():
        _unstamp()
        git("checkout", "-q", "mine", cwd=live_dir())
        write_json(home() / "state.json", {"on": True})
        n = len(_on_ids(records()))
        return {"said": f"Your fixes are on again: {n} fix{'' if n == 1 else 'es'}."}

    return _move(change)


def in_claude_code() -> bool:
    """Whether a Claude Code session runs this command (its Bash tool, or the person's ! in it): Claude Code sets
    CLAUDECODE for the commands it runs."""
    return bool(os.environ.get("CLAUDECODE"))


def key_in_terminal(question: str) -> str | None:
    """The person's key in their own terminal: y to a question asked there. The secret of the press, in asks/ as the
    plugin's keys write it, or None. Claude's Bash tool has no terminal, so it cannot answer."""
    if in_claude_code() or not (sys.stdin and sys.stdin.isatty() and sys.stdout.isatty()):
        return None
    try:
        answer = input(f"{question} [y/N] ").strip().lower()
    except EOFError:
        return None
    return secrets.token_hex(16) if answer in ("y", "yes") else ""


def one_on(fid: int | str) -> dict[str, Any]:
    """thimble fix on N in a shell: a fix that is off or ready goes on, after the person's y in their terminal."""
    rec = get(fid)
    if rec.get("state") == "on":
        return {"said": f"Fix {rec['id']} is on." + ("" if is_on() else " Your fixes are all off now: thimble fix on turns them on."),
                "reload": False}
    if rec.get("state") == "pending":
        raise FixError(f"thimble update set fix {rec['id']} aside at {release_name()}, so that nothing is fixed twice: "
                       "thimble reapply has Claude check it against the release and bring it back")
    if rec.get("state") not in ("off", "ready"):
        raise FixError(f"fix {rec['id']} is {state_word(rec)}, so there is nothing to turn on")
    secret = key_in_terminal(f"Turn on fix {rec['id']}, {rec['title']}?")
    if secret is None:
        raise FixError(f"only your key turns a fix on: run thimble fix on {rec['id']} in a terminal, or press y on the "
                       "fix in thimble")
    if not secret:
        return {"said": f"Fix {rec['id']} stays off.", "reload": False}
    write_json(home() / "asks" / f"{rec['id']}.json", {"key": key_hash(secret)})
    out = apply(rec["id"], secret)
    return {**out, "said": f"Fix {rec['id']} is on: {rec['title']}."}


def one_off(fid: int | str) -> dict[str, Any]:
    """thimble fix off N: the fix comes out of mine and stays in the list, off, for thimble fix on N."""
    rec = get(fid)
    if rec.get("state") != "on":
        return {"said": f"Fix {rec['id']} is not on ({state_word(rec)}).", "reload": False}
    out = undo(rec["id"])
    said = f"Fix {rec['id']} is off: {rec['title']}. thimble fix on {rec['id']} turns it back on."
    if out.get("redo"):
        said += f" It also took off {_and([str(i) for i in out['redo']])}, which did not fit without it."
    return {**out, "said": said}


def _relink_cli() -> None:
    """The thimble command in a shell (scripts/install.sh links it and names the link in cli-link) runs live's thimble
    once Claude Code loads thimble from live."""
    try:
        link = Path((thimble_home() / "cli-link").read_text().strip())
    except OSError:
        return
    target = live_dir() / "plugin" / "bin" / "thimble"
    if not link.is_symlink() or not target.exists() or not os.readlink(link).endswith("/plugin/bin/thimble"):
        return
    if Path(os.readlink(link)) == target:
        return
    tmp = link.with_name(link.name + ".thimble-tmp")
    tmp.unlink(missing_ok=True)
    tmp.symlink_to(target)
    tmp.replace(link)


# ------------------------------------------------------------------ a new release: thimble update


RELEASE_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
# the browser workbench's packages: (folder, its lock file, the packages it installs)
BROWSER_LOCKS = (("backend", "uv.lock", ".venv"), ("frontend", "package-lock.json", "node_modules"))
PROMPT_REAPPLY = PLUGIN / "prompts" / "reapply.md"


def update_url() -> str:
    """Where thimble's releases come from: its repository on GitHub. THIMBLE_UPDATE_URL (any git URL or folder) points
    elsewhere, for tests."""
    return os.environ.get("THIMBLE_UPDATE_URL") or f"https://github.com/{upstream()}.git"


def _vtuple(tag: str) -> tuple[int, ...]:
    m = RELEASE_TAG.match(tag if tag.startswith("v") else "v" + tag)
    return tuple(int(x) for x in m.groups()) if m else ()


def latest_release() -> dict[str, str]:
    """The newest release, {tag, version, commit, url}: the highest vX.Y.Z tag of thimble's repository. A tag with more
    after the numbers (v0.11.0-rc1) is not a release."""
    url = update_url()
    p = run(["git", "ls-remote", "--tags", url, "refs/tags/v*"], check=False, timeout=120)
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip().splitlines()
        raise FixError(f"thimble could not read its releases from {url} ({err[-1] if err else 'no message'}); "
                       "check the network, then run thimble update again")
    tags: dict[str, str] = {}
    for line in p.stdout.splitlines():
        sha, _, ref = line.partition("\t")
        name = ref.removeprefix("refs/tags/")
        peeled = name.endswith("^{}")
        name = name.removesuffix("^{}")
        if RELEASE_TAG.match(name) and (peeled or name not in tags):
            tags[name] = sha  # an annotated tag's commit (its ^{} line) wins over the tag object
    if not tags:
        raise FixError(f"{url} has no release (no tag such as v0.10.3)")
    tag = max(tags, key=_vtuple)
    return {"tag": tag, "version": tag[1:], "commit": tags[tag], "url": url}


def release_name(rel: dict[str, Any] | None = None) -> str:
    """The release live is on, as the person reads it: 0.10.3, else the plugin's version, else the commit."""
    rel = release() if rel is None else rel
    return str(rel.get("tag") or "").removeprefix("v") or str(rel.get("version") or "") or str(rel.get("base") or "")[:7]


def _has(repo: Path, commit: str) -> bool:
    return run(["git", "cat-file", "-e", commit + "^{commit}"], cwd=repo, check=False).returncode == 0


def _described(repo: Path, commit: str) -> str:
    """The release tag nearest before `commit`, when the repository has thimble's tags: v0.10.2 → 0.10.2."""
    t = git("describe", "--tags", "--abbrev=0", "--match", "v*", commit, cwd=repo, check=False)
    return t[1:] if RELEASE_TAG.match(t) else ""


def _is_newer(repo: Path, latest: dict[str, str], base: str, now: str) -> bool:
    """Whether the release is newer than the thimble that runs (base): not base, not in base's history, and not an
    older version (no step back from a branch ahead of the release)."""
    new = latest["commit"]
    if new == base or (_has(repo, new) and run(["git", "merge-base", "--is-ancestor", new, base], cwd=repo,
                                                  check=False).returncode == 0):
        return False
    have = _vtuple(now)
    return not (have and have >= _vtuple(latest["tag"]))


def _replay_order(recs: dict[int, dict[str, Any]]) -> list[int]:
    """The fixes in mine, in mine's order (each commit after the release that is a fix's own), then any fix that says
    on and was not found there. A sent fix is in mine too, so it moves with the rest."""
    live = live_dir()
    by_commit: dict[str, int] = {}
    for line in git("for-each-ref", "--format=%(objectname) %(refname)", "refs/thimble/fixes/", cwd=live).splitlines():
        sha, _, ref = line.partition(" ")
        try:
            by_commit[sha] = int(ref.rsplit("/", 1)[1])
        except ValueError:
            continue
    order: list[int] = []
    for c in git("rev-list", "--reverse", f"{release()['base']}..mine", cwd=live, check=False).splitlines():
        fid = by_commit.get(c)
        if fid is not None and fid in recs and recs[fid].get("state") != "removed" and fid not in order:
            order.append(fid)
    return order + [i for i in _on_ids(recs) if i not in order]


def _q(p: Path | str) -> str:
    """A path for a command the person pastes: ~ for their home when the rest needs no quotes."""
    t = _tilde(str(p))
    return t if t.startswith("~/") and re.fullmatch(r"~/[\w./+-]*", t) else shlex.quote(str(p))


def _fill(text: str, vals: dict[str, str]) -> str:
    return re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: vals.get(m.group(1), m.group(0)), text)


def _ref_for(version: str, commit: str) -> str:
    """A name for a release commit in live that `git log A..B` takes: its tag (v0.10.3), made from the commit when live
    has no such tag yet, else the commit itself."""
    live, tag = live_dir(), f"v{version}"
    if RELEASE_TAG.match(tag) and commit:
        have = git("rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}", cwd=live, check=False)
        if not have:
            run(["git", "tag", tag, commit], cwd=live, check=False)
            have = git("rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}", cwd=live, check=False)
        if have == commit:
            return tag
    return commit[:9]


def _quoted(words: list[str]) -> str:
    """The person's words for the reapply prompt: each round in quotes, on one line."""
    said = [f'"{" ".join(str(w).split())}"' for w in words if str(w).strip()]
    return "; then: ".join(said) or "(no words)"


def _set_aside_files(fid: int) -> list[str]:
    out = git("-c", "core.quotePath=false", "show", "--name-only", "--format=", f"refs/thimble/fixes/{fid}", cwd=live_dir(),
              check=False)
    return [x for x in out.splitlines() if x.strip()]


def reapply_prompt() -> Path:
    """pending/<version>.md: the first message of the Claude Code session that thimble reapply opens in live
    (prompts/reapply.md, with one entry per fix that thimble update set aside), written again from the records at each
    reapply, and pending/current.json for --continue."""
    cur = read_json(home() / "pending" / "current.json")
    if not cur:
        raise FixError("no fixes are set aside. thimble update sets your fixes aside when it moves to a new release")
    recs = records()
    ids = [i for i in cur.get("ids") or [] if recs.get(i, {}).get("state") == "pending"]
    if not ids:
        raise FixError("no fixes are set aside any more: thimble fixes lists them")
    to, frm = str(cur["version"]), str(cur.get("from") or "")
    entries = []
    for n, fid in enumerate(ids, 1):
        r = recs[fid]
        p = r.get("pending") or {}
        made = f"fix {fid}, {_date(r.get('created'))}, {r.get('made_in') or 'terminal'}"
        e = [f"{n}. {r['title']} ({made})", f"   They asked: {_quoted(r.get('words') or [])}"]
        if str(r.get("summary") or "").strip():
            e.append(f"   It did: {' '.join(str(r['summary']).split())}")
        if p.get("old"):
            files = p.get("files") or []
            e.append(f"   Old change: {p['old']}" + (f" ({', '.join(files)})" if files else ""))
        entries.append("\n".join(e))
    try:
        frame = PROMPT_REAPPLY.read_text()
    except OSError:
        raise FixError(f"thimble's prompt {PROMPT_REAPPLY} is missing; install thimble again")
    one = len(ids) == 1
    text = _fill(frame, {
        "LIVE": _tilde(str(live_dir())), "FROM": frm or "the release before", "TO": to,
        "FROM_REF": _ref_for(frm, str(cur.get("from_commit") or "")), "TO_REF": _ref_for(to, str(cur.get("to_commit") or "")),
        "N_FIXES": f"{len(ids)} fix" + ("" if one else "es"), "THEY_ARE": "it is" if one else "they are",
        "THEM": "it" if one else "them", "FIXES": "\n\n".join(entries)}).rstrip() + "\n"
    d = home() / "pending"
    prompt = d / f"{to}.md"
    prompt.write_text(text)
    write_json(d / "current.json", {**cur, "ids": ids, "tip": head(), "prompt": str(prompt)})
    return prompt


def reapply_argv() -> dict[str, Any]:
    """thimble reapply: Claude Code (claude) in live, with the reapply prompt as its first message."""
    if not (live_dir() / ".git").exists():
        raise FixError("you have no fixes: there is nothing to bring back")
    with Lock():
        prompt = reapply_prompt()
    return {"argv": [claude(), prompt.read_text()], "cwd": str(live_dir()), "prompt": str(prompt)}


def browser_home() -> Path:
    return Path(os.environ.get("THIMBLE_BROWSER_HOME") or Path.home() / ".thimble-browser")


def _sha_of(p: Path) -> str:
    try:
        return hashlib.sha256(p.read_bytes()).hexdigest()
    except OSError:
        return ""


def _browser_seed() -> Path | None:
    """The checkout scripts/install.sh installed the workbench in (it writes its path to the workbench's home): its
    packages are linked into live, with no download, while their lock files are the same."""
    try:
        p = Path((browser_home() / "checkout").read_text().strip())
    except OSError:
        return None
    return p if (p / "backend").is_dir() else None


def _link_copy(src: Path, dest: Path) -> None:
    """A copy made of hard links: no disk, no download. The installers replace files rather than write into them."""
    if platform.system() == "Linux":
        run(["cp", "-al", str(src), str(dest)], timeout=900)
    else:
        shutil.copytree(src, dest, symlinks=True, copy_function=os.link)


def browser_on_live() -> dict[str, Any]:
    """The browser workbench on live, when it is installed (its home exists): its Python and JS packages again only when
    their lock files changed, then the page. thimble-browser runs from live while fixes/browser-ready is there."""
    b = live_dir() / "browser"
    if not b.is_dir() or not browser_home().is_dir():
        return {"browser": "none"}
    ready = home() / "browser-ready"
    ready.unlink(missing_ok=True)
    stamps = read_json(home() / "browser.json") or {}
    seed = _browser_seed()
    env = {**os.environ, "NPM_CONFIG_UPDATE_NOTIFIER": "false"}
    did: list[str] = []
    try:
        for part, lock, pkgs in BROWSER_LOCKS:
            want, dest = _sha_of(b / part / lock), b / part / pkgs
            if dest.exists() and stamps.get(lock) == want:
                continue
            src = seed / part / pkgs if seed else None
            if not dest.exists() and src and src.is_dir() and _sha_of(seed / part / lock) == want:
                _link_copy(src, dest)
                did.append(f"{part} packages linked")
            elif part == "backend":
                run(["uv", "sync", "--project", str(b / part), "--frozen", "--no-dev", "--no-install-project", "--extra",
                     "dev"], env=env, timeout=1800)
                did.append("backend packages installed")
            else:
                run(["npm", "--prefix", str(b / part), "ci", "--no-audit", "--no-fund"], env=env, timeout=1800)
                did.append("frontend packages installed")
            stamps[lock] = want
            write_json(home() / "browser.json", stamps)
        run(["npm", "--prefix", str(b / "frontend"), "run", "build"], env=env, timeout=900)
    except FixError as e:
        return {"browser": "failed", "browser_error": str(e)}
    ready.write_text(str(b) + "\n")
    return {"browser": "ready", "browser_dir": str(b), "browser_did": did}


def update(check: bool = False) -> dict[str, Any]:
    """thimble update: the newest release for both modes.

    The fixes that were on are not replayed: the release may already fix some of the same things, so they are set aside
    (state pending, their old change in pending/<version>/fix-<id>.patch), and mine is the plain release. thimble
    reapply then opens Claude Code in live to bring back each fix the release still needs, and `thimble update
    --continue` records what Claude committed. Claude Code loads the plugin from live, and thimble-browser runs from
    live/browser. With check, only whether a newer release is out."""
    latest = latest_release()
    rel = release()
    has_live = bool(rel) and (live_dir() / ".git").exists()
    if has_live:
        repo, base, now = live_dir(), str(rel["base"]), release_name(rel)
        if not rel.get("tag"):
            now = _described(repo, base) or now
    else:
        src = find_source()
        repo, base = Path(src["repo"]), str(src["commit"])
        now = _described(repo, base) or _version_at(repo, base) or base[:7]
    if latest["commit"] == base:
        now = latest["version"]
    out: dict[str, Any] = {"from": now, "to": latest["version"], "newer": _is_newer(repo, latest, base, now),
                           "said": "", "reload": False}
    if check or not out["newer"]:
        same = now == latest["version"]
        return {**out, "lines": [] if check else [f"thimble {now} is the newest release." if same else
                                                  f"thimble {now} is up to date; the newest release is {latest['version']}."]}
    with Lock():
        ensure_live()
        live, rel = live_dir(), release()
        old = str(rel["base"])
        ref = f"refs/thimble/releases/{latest['tag']}"
        run(["git", "fetch", "-q", "--no-tags", latest["url"], f"+refs/tags/{latest['tag']}:{ref}"], cwd=live, timeout=600)
        new = git("rev-parse", f"{ref}^{{commit}}", cwd=live)
        version = latest["version"]
        recs = records()
        # the fixes in mine (on, or sent), and any an earlier update set aside that Claude has not brought back yet
        aside = [*_replay_order(recs), *[i for i, r in sorted(recs.items()) if r.get("state") == "pending"]]
        aside = list(dict.fromkeys(aside))
        for fid in aside:
            r = recs[fid]
            if r.get("state") == "pending" and r.get("pending", {}).get("old") and Path(r["pending"]["old"]).exists():
                continue  # set aside before: its old change stays the one it had
            patch = home() / "pending" / version / f"fix-{fid}.patch"
            patch.parent.mkdir(parents=True, exist_ok=True)
            patch.write_text(run(["git", "-c", "core.quotePath=false", "format-patch", "--stdout", "-1", "--no-color",
                                  f"refs/thimble/fixes/{fid}"], cwd=live).stdout)
            r.update(state="pending", error=None, note=f"set aside at the update to {version}",
                     pending={"version": version, "from": now, "old": str(patch), "files": _set_aside_files(fid)})
            put(r)
        _unstamp()
        git("checkout", "-q", "-B", "mine", new, cwd=live)
        write_json(home() / "state.json", {"on": True})
        rel.update(base=new, version=_version_at(live, new), tag=latest["tag"], updated=time.time())
        write_json(home() / "release.json", rel)
        _write_off_sh(rel)
        d = home() / "pending"
        if aside:
            d.mkdir(parents=True, exist_ok=True)
            write_json(d / "current.json", {"version": version, "from": now, "from_commit": old, "to_commit": new,
                                            "ids": aside, "tip": head(), "made": time.time()})
        else:
            (d / "current.json").unlink(missing_ok=True)
        _repoint()
        synced = _sync()
    browser = browser_on_live()
    out = {**out, "aside": aside, **synced, **browser}
    out["lines"] = _summary(out)
    out["said"] = f"thimble {version}" + (f" · {len(aside)} fix{'' if len(aside) == 1 else 'es'} set aside" if aside else "")
    return out


def _summary(d: dict[str, Any], paint: Paint | None = None) -> list[str]:
    """What thimble update prints: the versions, the fixes it set aside and how to bring them back, and how each mode
    loads the release."""
    import textwrap  # noqa: PLC0415

    c = paint or Paint(False)
    both = d.get("browser") == "ready"
    versions = f"{d['from']} → {d['to']}"
    out = [f"Updated thimble {c('bold', versions)} "
           f"(terminal plugin{' and browser' if both else ''})"]
    if d.get("browser") == "failed":
        out.append(f"The browser workbench stays on the release it had: {d.get('browser_error')}. Run thimble update "
                   "again after you correct that.")
    k = len(d.get("aside") or [])
    if k:
        n = f"{k} local fix{'' if k == 1 else 'es'}"
        para = textwrap.wrap(f"You have {n}. {'It is' if k == 1 else 'They are'} off for now: {d['to']} may already fix "
                             "some of the same things, and Claude checks each one so nothing is fixed twice.", 88)
        para[0] = para[0].replace(n, c("bold", n), 1)
        out += ["", *para, "", f"{c('title', 'Bring them back:' if k > 1 else 'Bring it back:')}  {c('cmd', 'thimble reapply')}",
                c("dim", f"  Claude opens, checks each fix against {d['to']}, keeps what is still needed, and turns it on.")]
    out += ["", f"{c('title', 'Then')}  Terminal: {c('cmd', '/reload-plugins')} in Claude Code"
            + (f" · Browser: restart {c('cmd', 'thimble-browser')}" if both else "")]
    return out


def continue_() -> dict[str, Any]:
    """thimble update --continue: in the session thimble reapply opened, Claude brought back the set-aside fixes that the
    release still needs, one commit per fix with the fix's title. Each such commit becomes its fix's new version, and the
    fix is on. A set-aside fix with no commit is left out: the release does it, or it cannot work there, and it leaves
    the list. A commit that is no set-aside fix's, or that changes a safety file, stops it with nothing recorded, so mine
    holds only recorded fixes."""
    cur = read_json(home() / "pending" / "current.json")
    if not cur:
        raise FixError("no fixes are set aside, so there is nothing to record; thimble update looks for a new release")
    live = live_dir()
    with Lock():
        dirty = [x[3:] for x in run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=live).stdout.splitlines()
                 if x[3:] != PLUGIN_JSON]
        if dirty:
            raise FixError(f"{_tilde(str(live))} has changes that are not committed ({_and(dirty[:3])}): commit each "
                           "fix with its title, or undo the rest, then run thimble update --continue again")
        if git("rev-parse", "--abbrev-ref", "HEAD", cwd=live, check=False) != "mine":
            raise FixError(f"{_tilde(str(live))} is not on its branch mine: git -C {_q(live)} checkout mine, then run "
                           "thimble update --continue again")
        tip = str(cur["tip"])
        if run(["git", "merge-base", "--is-ancestor", tip, "mine"], cwd=live, check=False).returncode != 0:
            raise FixError("mine no longer starts where thimble update left it; bring the fixes back on top of it again")
        commits = [x.split("\t", 1) for x in git("log", "--reverse", "--format=%H%x09%s", f"{tip}..mine",
                                                  cwd=live).splitlines() if x]
        recs = records()
        waiting = {recs[i]["title"].strip(): i for i in cur.get("ids") or [] if recs.get(i, {}).get("state") == "pending"}
        found: list[tuple[int, str, list[dict[str, Any]]]] = []
        for c, subject in commits:
            fid = waiting.get(subject.strip())
            if fid is None or any(f == fid for f, _, _ in found):
                raise FixError(f"commit {c[:7]} (“{short(subject, 50)}”) is not one set-aside fix: give each fix one "
                               f"commit with its title ({_and([f'“{t}”' for t in waiting])}), then run thimble update "
                               "--continue again")
            files = _numstat(live, f"{c}^", c)
            bad = protected_of([f["path"] for f in files])
            if bad:
                raise FixError(f"commit {c[:7]} (“{short(subject, 50)}”) {protected_why(bad)}; take that part out, then "
                               "run thimble update --continue again")
            if any(f["add"] is None for f in files):
                raise FixError(f"commit {c[:7]} adds or changes a binary file; a fix changes text only")
            found.append((fid, c, files))
        for fid, c, files in found:
            git("update-ref", f"refs/thimble/fixes/{fid}", c, cwd=live)
            r = records()[fid]
            r.update(state="on", on_at=time.time(), commit=c, files=files, error=None, pending=None, note=None)
            put(r)
        version = str(cur["version"])
        left = [i for i in cur.get("ids") or [] if records().get(i, {}).get("state") == "pending"]
        for fid in left:
            r = records()[fid]
            r.update(state="released", released_in=version, note=f"left out at {version}", left_out=True, pending=None)
            put(r)
        (home() / "pending" / "current.json").unlink(missing_ok=True)
        synced = _sync() if found else {"reload": False}
    browser = browser_on_live() if found else {}
    recs = records()
    lines = []
    if found:
        on = "; ".join(f"{recs[f]['title']} ({c[:7]})" for f, c, _ in found)
        lines.append(f"Recorded {len(found)} fix{'' if len(found) == 1 else 'es'} on thimble {version}, now on: {on}.")
    if left:
        lines.append(f"Left out: {'; '.join(recs[i]['title'] for i in left)}. {'It leaves' if len(left) == 1 else 'They leave'} "
                     f"thimble fixes ({version} does {'it' if len(left) == 1 else 'them'}, or {'it' if len(left) == 1 else 'they'} "
                     f"cannot work there); thimble fix show {left[0]} still shows {'it' if len(left) == 1 else 'each one'}.")
    if browser.get("browser") == "failed":
        lines.append(f"The browser workbench was not rebuilt: {browser.get('browser_error')}.")
    if found:
        lines.append("In Claude Code, type /reload-plugins to load them" + (
            "; restart thimble-browser for the browser." if browser.get("browser") == "ready" else "."))
    return {"said": " ".join(lines), "lines": lines, "recorded": [f for f, _, _ in found], "left_out": left, **synced, **browser}


# ------------------------------------------------------------------ list, show, export


WORD = {"working": "working", "ready": "ready", "failed": "failed", "on": "on", "off": "off", "redo": "redo",
        "pending": "off", "request": "request", "sent": "sent", "saved": "saved", "released": "released"}
# the order of the list: what runs first, then what waits for the person, then the rest
ORDER = {"on": 0, "sent": 0, "ready": 1, "working": 2, "failed": 2, "redo": 2, "request": 3, "off": 4, "pending": 4, "saved": 5}


def state_word(r: dict[str, Any]) -> str:
    """A fix's state in one word, as the list shows it: a fix thimble update set aside is "off" (thimble reapply
    brings it back), and one the release took is "in 0.10.3"."""
    if r.get("state") == "released" and (r.get("released_in") or str(r.get("note") or "").startswith("in ")):
        return f"in {r.get('released_in') or str(r['note'])[3:]}"
    return WORD.get(str(r.get("state")), str(r.get("state")))


def listing() -> dict[str, Any]:
    recs = [r for r in records().values() if r.get("state") not in ("removed", "released")]
    recs.sort(key=lambda r: (ORDER.get(str(r.get("state")), 6), r["id"]))
    rel = release()
    on = is_on()
    return {"fixes": recs, "on": on, "live": str(live_dir()), "version": release_name(rel),
            "base": rel.get("base") or "", "kind": rel.get("kind") or "", "pointed": bool(rel.get("pointed")),
            "count_on": sum(r.get("state") == "on" for r in recs),
            "aside": [r["id"] for r in recs if r.get("state") == "pending"]}


def can_share() -> bool:
    """Whether this thimble has `thimble fix share` (kernel/share.py)."""
    return (Path(__file__).resolve().parent / "share.py").is_file()


class Paint:
    """Colors for a terminal (the approved look: titles in bold lilac, on in green, commands in purple, the rest dim),
    and plain text for a pipe, NO_COLOR, or Claude's Bash tool, which reads the same words."""

    CODES = {"title": "1;38;5;183", "green": "38;5;79", "dim": "38;5;246", "cmd": "38;5;141", "bold": "1"}

    def __init__(self, on: bool | None = None):
        if on is None:
            on = sys.stdout.isatty() and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"
        self.on = on

    def __call__(self, kind: str, text: str) -> str:
        return f"\x1b[{self.CODES[kind]}m{text}\x1b[0m" if self.on and text else text


def _state_paint(c: Paint, r: dict[str, Any], on: bool, width: int = 0) -> str:
    w = state_word(r) if on or r.get("state") != "on" else "off"
    kind = "green" if w == "on" else "dim" if w == "off" else "bold"
    return c(kind, f"{w:<{width}}") if width else c(kind, w)


def list_lines(width: int | None = None, paint: Paint | None = None) -> list[str]:
    """thimble fixes (thimble fix list): the person's fixes that are not in the release, one row each (number, state,
    title, date made, the start of their words), then what they can do next."""
    c = paint or Paint(False)
    d = listing()
    width = width or shutil.get_terminal_size((100, 24)).columns
    fixes = d["fixes"]
    new_fix = c("dim", "New fix: in Claude Code or the browser, /thimble-fix <what should work differently>")
    if not fixes:
        return [f"{c('title', 'Your thimble fixes')} · thimble {d['version']} with no fixes of yours", "", f"  {new_fix}"]
    words = {r["id"]: (state_word(r) if d["on"] or r.get("state") != "on" else "off") for r in fixes}
    counts: dict[str, int] = {}
    for w in words.values():
        counts[w] = counts.get(w, 0) + 1
    parts = [c("green", f"{counts.pop('on')} on")] if "on" in counts else []
    parts += [f"{n} {w}" for w, n in counts.items()]
    out = [f"{c('title', 'Your thimble fixes')} · thimble {d['version']} with {', '.join(parts)}", ""]
    iw = max(1, *(len(str(r["id"])) for r in fixes))
    sw = max(6, *(len(w) for w in words.values()))
    tw = min(40, max(3, *(len(r["title"]) for r in fixes)))
    out.append(c("dim", f"  {'#':>{iw}}  {'state':<{sw}}  {'fix':<{tw}}   made    you asked"))
    for r in fixes:
        row = f"  {r['id']:>{iw}}  {words[r['id']]:<{sw}}  {short(r['title'], tw):<{tw}}   {_date(r.get('created')):<5}   "
        room = max(16, width - len(row) - 1)
        asked = f'"{short(_first_line(r), room - 2)}"' if _first_line(r) else ""
        out.append(f"  {r['id']:>{iw}}  {_state_paint(c, r, d['on'], sw)}  {short(r['title'], tw):<{tw}}   "
                   f"{_date(r.get('created')):<5}   {asked}".rstrip())
    on_ids = [r["id"] for r in fixes if words[r["id"]] == "on"]
    off_ids = [r["id"] for r in fixes if r.get("state") in ("off", "ready")]
    first = fixes[0]["id"]
    nxt: list[tuple[str, str]] = []
    if d["aside"]:
        k = len(d["aside"])
        nxt.append(("thimble reapply", f"Claude brings back the {k} fix{'' if k == 1 else 'es'} thimble update set aside"))
    nxt.append((f"thimble fix show {first}", f"what fix {first} does, in a few lines"))
    if can_share():
        nxt.append((f"thimble fix share {first}", f"post fix {first} as a GitHub issue (you check it before it goes)"))
    if on_ids:
        n = on_ids[0]
        nxt.append((f"thimble fix off {n}", f"turn a fix off; {c('cmd', f'thimble fix on {n}')} turns it back on"))
    elif off_ids:
        nxt.append((f"thimble fix on {off_ids[0]}", "turn a fix on (it asks for your key here)"))
    if not d["aside"]:
        nxt.append(("thimble update", "get the newest thimble and keep your fixes"))
    cw = max(len(k) for k, _ in nxt) + 4
    out += ["", c("title", "What next")]
    out += [f"  {c('cmd', k)}{' ' * (cw - len(k))}{v}" for k, v in nxt]
    out.append(f"  {new_fix}")
    return out


def _wrapped(label: str, text: str, width: int) -> list[str]:
    import textwrap  # noqa: PLC0415

    body = textwrap.wrap(text, max(30, width - 16)) or [""]
    return [f"  {label:<12}  {body[0]}", *[f"  {'':<12}  {x}" for x in body[1:]]]


def show_lines(fid: int | str, width: int | None = None, paint: Paint | None = None) -> list[str]:
    """thimble fix show N: one fix in a few lines: its title and state, the person's words, what Claude did, how much it
    changed, and the commands that act on it."""
    c = paint or Paint(False)
    r = get(fid)
    width = min(width or shutil.get_terminal_size((100, 24)).columns, 100)
    made = f"{_date(r.get('created'))}, {r.get('made_in') or 'terminal'}"
    out = [f"{c('title', r['title'])} · fix {r['id']} · {_state_paint(c, r, is_on())} · {made}"]
    words = [str(w).strip() for w in r.get("words") or [] if str(w).strip()]
    for i, w in enumerate(words):
        out += _wrapped("You asked" if i == 0 else "Then", f'"{" ".join(w.split())}"', width)
    if str(r.get("summary") or "").strip():
        out += _wrapped("Claude did", " ".join(str(r["summary"]).split()), width)
    files = r.get("files") or []
    p = r.get("pending") or {}
    if r.get("state") == "pending":
        out += _wrapped("Set aside", f"at the update to {p.get('version') or release_name()}, so that nothing is fixed "
                        "twice", width)
    elif r.get("state") == "released" and r.get("left_out"):
        out += _wrapped("Left out", f"when Claude brought your fixes back on {r.get('released_in')}: the release does "
                        "it, or it could not work there", width)
    elif r.get("state") == "released":
        out += _wrapped(f"In {r.get('released_in') or 'the release'}", "the release has this change", width)
    elif r.get("error"):
        out += _wrapped("Why", str(r["error"]), width)
    tests = {"passed": "tests pass", "failed": "tests fail", "skipped": "tests not run"}.get(str(r.get("tests") or ""), "")
    n = len(files) or len(p.get("files") or [])
    if n:
        out += _wrapped("Changed", " · ".join(x for x in (f"{n} file{'' if n == 1 else 's'}", tests) if x), width)
    acts: list[tuple[str, str]] = []
    s = r.get("state")
    if s == "pending":
        acts.append(("thimble reapply", "Claude checks it against the release and brings it back"))
    if s in ("on", "off", "ready", "sent") and can_share():
        acts.append((f"thimble fix share {r['id']}", "post it as a GitHub issue"))
    if s == "on" and is_on():
        acts.append((f"thimble fix off {r['id']}", "turn it off"))
    elif s in ("off", "ready"):
        acts.append((f"thimble fix on {r['id']}", "turn it on (it asks for your key here)"))
    if acts:
        cw = max(len(k) for k, _ in acts) + 4
        out += ["", *[f"  {c('cmd', k)}{' ' * (cw - len(k))}{v}" for k, v in acts]]
    return out


def _date(t: Any) -> str:
    try:
        return time.strftime("%m-%d", time.localtime(float(t)))
    except (TypeError, ValueError):
        return ""


def note_of(r: dict[str, Any]) -> str:
    s = r.get("state")
    if s == "working":
        return "Claude works on it"
    if s == "ready":
        return "waits for y" if r.get("tests") != "failed" else ""
    if s == "failed":
        return str(r.get("error") or "")
    if s in ("redo", "pending"):
        return str(r.get("error") or "did not fit")
    if s == "request":
        return "no code"
    if s == "sent":
        return str(r.get("pr") or "sent")
    if s == "saved":
        return "saved as files"
    if s == "off":
        return str(r.get("note") or "")
    if s == "on" and int(r.get("rounds") or 1) > 1:
        return f"{r['rounds']} rounds"
    return ""


def _tilde(p: str) -> str:
    h = str(Path.home())
    return "~" + p[len(h):] if p.startswith(h + os.sep) else p


def _first_line(r: dict[str, Any]) -> str:
    words = r.get("words") or [""]
    return next((x.strip() for x in str(words[0]).splitlines() if x.strip()), "")


def diff_of(rec: dict[str, Any]) -> str:
    repo = Path(rec["work"]) if rec.get("work") and Path(rec["work"]).is_dir() else live_dir()
    c = rec.get("commit")
    if c:
        return run(["git", "-c", "core.quotePath=false", "show", "--format=", "--no-color", "--no-ext-diff", c], cwd=repo).stdout
    if rec.get("work") and Path(rec["work"]).is_dir():
        return run(["git", "-c", "core.quotePath=false", "diff", "--no-color", rec["base"]], cwd=repo).stdout
    return ""


def export(fid: int | str, to: str | None = None) -> list[str]:
    """Save a fix as files, with nothing sent: the patch (git am applies it) and its record. Not scanned: these are the
    person's own files on their own machine; submitting scans."""
    r = get(fid)
    d = Path(to or os.getcwd())
    d.mkdir(parents=True, exist_ok=True)
    out = []
    diff = diff_of(r)
    if diff.strip():
        repo = live_dir()
        patch = run(["git", "format-patch", "--stdout", "-1", r["commit"]], cwd=repo).stdout if r.get("commit") else diff
        p = d / f"thimble-fix-{r['id']}.patch"
        p.write_text(patch)
        out.append(str(p))
    m = d / f"thimble-fix-{r['id']}.md"
    m.write_text("\n".join(show_lines(r["id"])) + "\n")
    out.append(str(m))
    return out


# ------------------------------------------------------------------ submit: the draft and its scan


def _walk_strings(v: Any, fields: set[str], values: set[str], depth: int = 0) -> None:
    if depth > 6:
        return
    if isinstance(v, dict):
        for k, x in v.items():
            if isinstance(k, str) and not k.startswith("_") and 3 <= len(k) <= 60:
                fields.add(k)
            _walk_strings(x, fields, values, depth + 1)
    elif isinstance(v, list):
        for x in v[:500]:
            _walk_strings(x, fields, values, depth + 1)
    elif isinstance(v, str):
        s = v.strip()
        if 4 <= len(s) <= 200 and "\n" not in s and (not s.replace(".", "").replace(",", "").isdigit() or len(s) >= 6):
            values.add(s)


def session_terms(st: Store | None) -> dict[str, list[str]]:
    """The person's details for the scan, collected here and now: their machine (user, host, git identity, home) and,
    with a store, the folder under analysis (its path, file and folder names) and the fields and values of the records
    Claude read this session."""
    from . import sources as S  # noqa: PLC0415

    t: dict[str, set[str]] = {k: set() for k in ("name", "host", "git", "path", "folder", "file", "field", "value")}
    for u in (getpass.getuser(), os.environ.get("USER"), os.environ.get("LOGNAME")):
        if u:
            t["name"].add(u)
    try:
        import pwd  # noqa: PLC0415

        full = pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
        if full:
            t["name"].add(full)
    except (ImportError, KeyError):
        pass
    host = socket.gethostname()
    t["host"] |= {host, host.split(".")[0]}
    for k in ("user.name", "user.email"):
        v = git("config", "--global", "--get", k, cwd=Path.home(), check=False)
        if v:
            t["git"].add(v)
    t["path"].add(str(Path.home()))
    if st is not None:
        t["path"].add(str(st.root))
        t["folder"].add(st.root.name)

        def named(x: str) -> bool:
            return len(x) >= 3 and not x.isdigit()

        try:
            rels = S.list_files(st.root)
        except Exception:  # noqa: BLE001 - a folder that cannot be listed: the machine's terms still count
            rels = []
        for rel in rels:
            parts = rel.split(os.sep)
            name = parts[-1]
            stem = name.rsplit(".", 1)[0]
            t["file"] |= {x for x in (name, stem) if named(x) and (x == name or len(x) >= 4)}
            t["folder"] |= {x for x in parts[:-1] if named(x)}
        fields: set[str] = set()
        values: set[str] = set()
        left = 2000
        for s in st.seen():
            rel = st.rel(str(s.get("file") or "")) if s.get("tool") == "Read" else None
            if not rel or left <= 0:
                continue
            a, b = int(s.get("from") or 1), int(s.get("to") or 10**9)
            try:
                for row in S.iter_rows(st.root, rel):
                    m = re.search(r"#(?:L(\d+)|row=(\d+))", row.ref)
                    line = int(m.group(1)) if m and m.group(1) else int(m.group(2)) + 1 if m else 0
                    if line > b or left <= 0:
                        break
                    if line >= a:
                        _walk_strings(row.value, fields, values)
                        left -= 1
            except Exception:  # noqa: BLE001 - a file that changed or went away since: the other files still count
                continue
        t["field"] |= fields
        t["value"] |= values
    return {k: sorted(x for x in v if x) for k, v in t.items()}


def _known(base: str):
    """known(terms): the terms that appear as whole words in thimble's source at the release commit (never in the
    fix's new lines, so a term Claude wrote into a test is still a hit)."""
    repo = live_dir()

    def known(terms: list[str]) -> set[str]:
        terms = [t for t in terms if t and "\n" not in t]
        if not terms:
            return set()
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write("\n".join(terms) + "\n")
        try:
            p = run(["git", "grep", "-F", "-I", "-o", "-h", "-w", "--no-color", "-f", f.name, base, "--"], cwd=repo, check=False)
        finally:
            os.unlink(f.name)
        return set(p.stdout.splitlines()) & set(terms)
    return known


def _base_files(base: str) -> set[str]:
    return set(git("-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", base, cwd=live_dir(), check=False).splitlines())


def _repo_paths(base: str, diff: str) -> set[str]:
    files = set(re.findall(r"^diff --git a/(\S+) b/(?:\S+)$", diff, re.M)) | set(re.findall(r"^\+\+\+ b/(\S+)$", diff, re.M))
    files |= _base_files(base)
    out = set(files)
    for f in files:
        parts = f.split("/")
        out |= {"/".join(parts[:i]) for i in range(1, len(parts))}
    return out


_PATHISH = re.compile(r"(?<![\w./~-])[\w.-]+(?:/[\w.-]+)+/?")
_HELD = re.compile("[\U000F0000-\U000FFFFD]")


def _protect(parts: dict[str, str], paths: set[str]) -> tuple[dict[str, str], list[str]]:
    """The parts with thimble's own text held out of the scan: in the diff each line that is not an added line (file
    names, hunk headers, thimble's code at the release), and in every part a path of thimble's repository. Each held
    span becomes one private-use character, which no term matches, until _unprotect puts it back."""
    held: list[str] = []

    def hold(x: str) -> str:
        held.append(x)
        return chr(0xF0000 + len(held) - 1)

    def paths_in(text: str) -> str:
        def one(m: re.Match) -> str:
            x = m.group(0)
            core = x.rstrip(".,:;")
            return hold(core) + x[len(core):] if core.rstrip("/") in paths else x
        return _PATHISH.sub(one, text)

    out = {}
    for where, text in parts.items():
        if where == "diff":
            lines = []
            for ln in text.splitlines(keepends=True):
                body = ln.rstrip("\n")
                if body.startswith("+") and not body.startswith("+++ "):
                    lines.append("+" + paths_in(body[1:]) + ln[len(body):])
                else:
                    lines.append((hold(body) if body else "") + ln[len(body):])
            out[where] = "".join(lines)
        else:
            out[where] = paths_in(text)
    return out, held


def _unprotect(parts: dict[str, str], held: list[str]) -> dict[str, str]:
    return {w: _HELD.sub(lambda m: held[ord(m.group(0)) - 0xF0000], t) for w, t in parts.items()}


_WORDRX = re.compile(r"[^\W\d_][\w'’-]*")


def _widen(terms: dict[str, list[str]], text: str, known, base: set[str]) -> dict[str, list[str]]:
    """The terms as this draft needs them: each in every letter case the draft writes it; each distinctive word of a
    name or value of several words (3 letters or more, and not in thimble's source); never a file or folder name that
    thimble's repository has."""
    names = {x for p in base for x in p.split("/")}
    out = {k: {x for x in v if not (k in ("file", "folder") and x in names)} for k, v in terms.items()}
    words: dict[str, str] = {}
    for kind in ("name", "git", "value"):
        for t in out.get(kind, ()):
            ws = [w.strip("'’-") for w in _WORDRX.findall(t)]
            if len(ws) < 2:
                continue
            for w in ws:
                if len(w) >= 3 and w not in words:
                    words[w] = kind
    if words:
        variants = sorted({v for w in words for v in (w, w.lower(), w.capitalize(), w.upper())})
        public = known(variants) if known else set()
        for w, kind in words.items():
            if not {w, w.lower(), w.capitalize(), w.upper()} & public:
                out.setdefault(kind, set()).add(w)
    low = text.lower()
    for kind, xs in out.items():
        if kind == "path":
            continue
        for x in list(xs):
            if x.lower() in low:
                xs |= {m.group(0) for m in re.finditer(re.escape(x), text, re.I)}
    return {k: sorted(v) for k, v in out.items()}


def _parts(rec: dict[str, Any], title: str, summary: str) -> dict[str, str]:
    files = rec.get("files") or []
    tests = rec.get("tests")
    said = "; ".join(f"{f['path']} +{f.get('add') or 0} −{f.get('del') or 0}" for f in files)
    asked = "\n".join(f"> {line}" for w in rec.get("words") or [] for line in str(w).splitlines())
    body = f"{title}\n\nRequested in thimble:\n{asked}\n\n{summary.strip()}\n"
    if files:
        body += f"\nTests: {'passed in the sandbox' if tests == 'passed' else tests or 'not run'}.\nFiles: {said}\n"
    parts = {"pr": body}
    if rec.get("commit"):
        parts["diff"] = re.sub(r"^index [0-9a-f]+\.\.[0-9a-f]+.*\n", "", diff_of(rec), flags=re.M)
    return parts


def draft(fid: int | str, title: str, summary: str, st: Store | None) -> dict[str, Any]:
    """Claude's title and summary for a fix, with the person's words and the diff, through the privacy scan: the exact
    text that would leave, in drafts/<id>/. Nothing is sent."""
    rec = get(fid)
    if rec.get("state") not in ("on", "off", "ready", "request", "saved", "sent"):
        raise FixError(f"fix {rec['id']} is {rec.get('state')}: there is nothing to submit yet")
    title = short(title or rec["title"], 72)
    parts = _parts(rec, title, summary or rec.get("summary") or "")
    base = release().get("base") or rec.get("base") or "HEAD"
    diff = parts.get("diff", "")
    if diff and re.search(r"^Binary files ", diff, re.M):
        raise FixError("the change has a binary file; a fix shares text changes only")
    paths = _repo_paths(base, diff)
    held_parts, _held = _protect(parts, paths)
    base_files = _base_files(base)
    known = _known(base)
    found = session_terms(st)
    text = "\n".join(held_parts.values())
    # the diff keeps a file name that thimble's repository has (a test's made-up fixture), so that it still applies;
    # the words the person and Claude wrote lose every name from the person's folder
    terms = _widen(found, text, known, base_files)
    words_terms = _widen(found, text, known, set())
    added = sorted(set(re.findall(r"^\+\+\+ b/(\S+)$", diff, re.M)) - base_files)
    if added:
        named, _ = P.scan({"diff": "\n".join(added)}, {k: v for k, v in terms.items() if k != "path"}, known,
                          use_gitleaks=False)
        if named:
            raise FixError("a new file of the fix is named after your data; ask Claude to give it a made-up name (r)")
    repo_paths = [(str(live_dir()) + os.sep, ""), (str(PLUGIN) + os.sep, "plugin/")]
    hits, notes = P.scan({k: v for k, v in held_parts.items() if k != "diff"}, words_terms, known, repo_paths, allow=[base])
    if "diff" in held_parts:
        more, notes2 = P.scan({"diff": held_parts["diff"]}, terms, known, repo_paths, allow=[base])
        hits += more
        notes += [n for n in notes2 if n not in notes]
    for i, h in enumerate(hits, 1):
        h["id"] = f"h{i}"
    d = home() / "drafts" / str(rec["id"])
    old = {(h["where"], h["found"]): h["kept"] for h in read_json(d / "scan.json") or []}
    for h in hits:
        h["kept"] = bool(old.get((h["where"], h["found"]))) and h["kind"] not in P.NEVER_KEPT
    write_json(d / "draft.json", {"parts": parts, "notes": notes, "title": title})
    _write_share(rec, d, parts, hits)
    return {"id": rec["id"], "removed": sum(not h["kept"] for h in hits), "hits": hits, "notes": notes}


def _write_share(rec: dict[str, Any], d: Path, parts: dict[str, str], hits: list[dict]) -> dict[str, str]:
    held_parts, held = _protect(parts, _repo_paths(release().get("base") or "HEAD", parts.get("diff", "")))
    out = _unprotect(P.apply(held_parts, hits), held)
    removed = sum(not h["kept"] for h in hits)
    rel = release()
    foot = (f"\n---\nthimble {rel.get('version') or str(rel.get('base') or '?')[:7]} · {platform.system() or 'unknown OS'} · a "
            f"{'change' if 'diff' in out else 'request'} from a person who uses thimble. The privacy scan removed "
            f"{removed} detail{'' if removed == 1 else 's'}, and they read this text before it was sent.\n")
    (d / "pr.md").write_text(out["pr"].rstrip() + "\n" + foot)
    if "diff" in out:
        (d / "fix.patch").write_text(out["diff"])
    else:
        (d / "fix.patch").unlink(missing_ok=True)
    (d / "title").write_text(out["pr"].splitlines()[0].strip() + "\n")
    write_json(d / "scan.json", hits)
    return out


def keep(fid: int | str, hit_id: str, secret: str | None) -> str:
    """k: one detail the scan removed goes back in (never a key or a token)."""
    rec = get(fid)
    check_ask(rec["id"], secret)
    d = home() / "drafts" / str(rec["id"])
    hits = read_json(d / "scan.json") or []
    h = next((h for h in hits if h["id"] == hit_id), None)
    if not h:
        raise FixError(f"no detail {hit_id} in the draft of fix {rec['id']}")
    if h["kind"] in P.NEVER_KEPT:
        raise FixError("keys and tokens are always removed")
    h["kept"] = True
    _write_share(rec, d, (read_json(d / "draft.json") or {}).get("parts") or {}, hits)
    return f"kept {h['found']!r}"


def upstream() -> str:
    try:
        repo = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text()).get("repository") or ""
    except (OSError, ValueError):
        repo = ""
    m = re.search(r"github\.com[/:]([^/]+/[^/.]+)", str(repo))
    return m.group(1) if m else "safety-research/thimble"


def _gh_json(*args: str) -> Any:
    out = run([gh(), *args]).stdout
    try:
        return json.loads(out)
    except ValueError:
        raise FixError(f"gh {' '.join(args[:2])} gave no JSON")


def _pull_request(rec: dict[str, Any], d: Path) -> str:
    """One new commit on top of the release commit, with the scanned diff, authored by the person's GitHub noreply
    address; pushed to their fork, and a draft pull request opened with gh."""
    repo = upstream()
    title = (d / "title").read_text().strip()
    try:
        user = _gh_json("api", "user")
    except FixError as e:
        raise FixError(f"{e}. Sign in to GitHub with `gh auth login`, or press w to save it as files")
    login, uid = user.get("login"), user.get("id")
    if not login or not uid:
        raise FixError("gh gave no GitHub login; sign in with `gh auth login`")
    if not (d / "fix.patch").exists():
        # a request with no code: an issue, with the same text
        out = run([gh(), "issue", "create", "--repo", repo, "--title", title, "--body-file", str(d / "pr.md")]).stdout.strip().splitlines()
        return out[-1] if out else ""
    base = release().get("base") or rec["base"]
    noreply = f"{uid}+{login}@users.noreply.github.com"
    run([gh(), "repo", "fork", repo, "--clone=false"])
    live = live_dir()
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index"), "GIT_AUTHOR_NAME": login,
               "GIT_AUTHOR_EMAIL": noreply, "GIT_COMMITTER_NAME": login, "GIT_COMMITTER_EMAIL": noreply}
        git("read-tree", base, cwd=live, env=env)
        p = run(["git", "apply", "--cached", str(d / "fix.patch")], cwd=live, env=env, check=False)
        if p.returncode != 0:
            raise FixError("the scanned diff does not apply to the release; press esc and submit again")
        tree = git("write-tree", cwd=live, env=env)
        sha = run(["git", "commit-tree", tree, "-p", base, "-m", title], cwd=live, env=env).stdout.strip()
    branch = f"thimble-fix-{rec['id']}-{secrets.token_hex(3)}"
    name = repo.split("/", 1)[1]
    url = (os.environ.get("THIMBLE_FIX_PUSH_URL") or "https://github.com/{login}/{name}.git").format(login=login, name=name)
    run([push_git(), "-c", "credential.helper=", "-c", f"credential.https://github.com.helper=!{gh()} auth git-credential",
         "push", url, f"{sha}:refs/heads/{branch}"], cwd=live)
    out = run([gh(), "pr", "create", "--repo", repo, "--draft", "--head", f"{login}:{branch}", "--title", title,
               "--body-file", str(d / "pr.md")]).stdout.strip().splitlines()
    return out[-1] if out else ""


def send(fid: int | str, answer: str, secret: str | None) -> dict[str, Any]:
    """The person's y (a pull request) or w (files): what the draft holds, exactly as previewed."""
    rec = get(fid)
    check_ask(rec["id"], secret)
    d = home() / "drafts" / str(rec["id"])
    if not (d / "pr.md").exists():
        raise FixError(f"fix {rec['id']} has no draft; press s on it in Your fixes")
    out_dir = home() / "sent" / str(rec["id"])
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ("pr.md", "fix.patch", "title"):
        if (d / name).exists():
            shutil.copyfile(d / name, out_dir / name)
    if answer == "file":
        rec.update(state="saved" if rec.get("state") in ("request",) else rec["state"], saved=str(out_dir), saved_at=time.time())
        put(rec)
        return {"id": rec["id"], "saved": str(out_dir), "files": sorted(p.name for p in out_dir.iterdir())}
    url = _pull_request(rec, d)
    (out_dir / "pr-url").write_text(url + "\n")
    rec.update(state="sent", pr=url, sent_at=time.time())
    put(rec)
    return {"id": rec["id"], "pr": url}


# ------------------------------------------------------------------ the kernel's command


def cmd(a) -> int:
    """thimble fix VERB: see cli.py FIX_HELP."""
    from .cli import out_json, stdin_text  # noqa: PLC0415

    verb = a.verb
    try:
        if verb == "list":
            if a.json:
                out_json(listing())
            else:
                print("\n".join(list_lines(paint=Paint())))
        elif verb == "show":
            if a.json:
                out_json(get(a.id))
            else:
                print("\n".join(show_lines(a.id, paint=Paint())))
        elif verb == "diff":
            print(diff_of(get(a.id)), end="")
        elif verb == "export":
            for p in export(a.id, a.to):
                print(p)
        elif verb == "off":
            r = one_off(a.id) if a.id else all_off()
            print(r.get("said", ""))
            if r.get("reload"):
                print(RELOAD)
        elif verb == "update":
            return cmd_update(a)
        elif verb == "on":
            r = one_on(a.id) if a.id else all_on()
            print(r.get("said", ""))
            if r.get("reload"):
                print(RELOAD)
        elif verb == "new":
            out_json(new(stdin_text() or a.words or "", a.made_in, a.title))
        elif verb == "round":
            out_json(round_(a.id, stdin_text() or a.words or ""))
        elif verb == "done":
            summary = stdin_text() if a.summary == "-" else (a.summary or "")
            out_json(done(a.id, a.title, summary, a.request, not a.no_tests))
        elif verb == "apply":
            if a.ask == "-":
                out_json(apply(a.id, stdin_text()))
            else:
                r = apply_typed(a.id)
                print(f"✓ {r['title']} is on. In Claude Code, type /reload-plugins; restart thimble-browser." if r
                      else "Not applied; thimble fix apply asks again whenever you want.")
        elif verb == "notnow":
            out_json(not_now(a.id))
        elif verb == "redo":
            out_json(redo(a.id, stdin_text() or a.words or ""))
        elif verb == "undo":
            out_json(undo(a.id))
        elif verb == "remove":
            out_json(remove(a.id))
        elif verb == "sandbox":
            out_json(sandbox_argv(int(a.id)))
        elif verb == "draft":
            d = json.loads(stdin_text() or "{}")
            root = os.environ.get("THIMBLE_ROOT")
            st = Store(root, session=os.environ.get("THIMBLE_CONVERSATION")) if root else None
            out_json(draft(a.id, str(d.get("title") or ""), str(d.get("summary") or ""), st))
        elif verb == "keep":
            print(keep(a.id, a.hit, stdin_text() if a.ask == "-" else None))
        elif verb == "send":
            out_json(send(a.id, a.answer, stdin_text() if a.ask == "-" else None))
        else:
            raise FixError(f"no verb {verb}")
    except FixError as e:
        print(f"thimble fix {verb}: {e}", file=sys.stderr)
        return 1
    return 0


RELOAD = "In Claude Code, type /reload-plugins to load it."
SHELL_ONLY = ("{what} runs in a shell, not inside Claude Code: it changes the thimble this session runs. Open a terminal "
              "(or quit Claude Code), then run {what}")


def cmd_update(a) -> int:
    """thimble update [--continue] [--check]: see cli.py."""
    from .cli import out_json  # noqa: PLC0415

    try:
        if getattr(a, "cont", False):
            r = continue_()
            lines = r["lines"] or ["No commit to record, and no fix is set aside."]
        elif getattr(a, "check", False):
            r = update(check=True)
            lines = [f"thimble {r['to']} is out (you have {r['from']}): thimble update in a shell" if r["newer"]
                     else f"thimble {r['from']} is the newest release."]
        else:
            if in_claude_code():
                raise FixError(SHELL_ONLY.format(what="thimble update"))
            r = update()
            lines = _summary(r, Paint()) if r.get("newer") else r.get("lines") or []
    except FixError as e:
        print(f"thimble update: {e}", file=sys.stderr)
        return 1
    if a.json:
        out_json(r)
        return 0
    print("\n".join(lines))
    return 0


def cmd_reapply(a) -> int:
    """thimble reapply: Claude Code opens in live with the fixes thimble update set aside (see cli.py)."""
    try:
        if in_claude_code():
            raise FixError(SHELL_ONLY.format(what="thimble reapply"))
        r = reapply_argv()
    except FixError as e:
        print(f"thimble reapply: {e}", file=sys.stderr)
        return 1
    if getattr(a, "print", False):
        print(r["argv"][1], end="")
        return 0
    print(f"Claude Code opens in {_tilde(r['cwd'])} with the fixes thimble update set aside "
          f"(its first message: {_tilde(r['prompt'])}).", flush=True)
    try:
        os.chdir(r["cwd"])
        os.execvp(r["argv"][0], r["argv"])
    except OSError as e:
        print(f"thimble reapply: could not start {r['argv'][0]} ({e.strerror}); install Claude Code, or run "
              f"cd {_q(r['cwd'])} && claude \"$(cat {_q(r['prompt'])})\"", file=sys.stderr)
        return 1
    return 0
