"""thimble fix: the person changes their own thimble from inside it, keeps the change, and can submit it.

Under $THIMBLE_HOME/fixes:

    live/            the checkout Claude Code loads thimble from once the first fix is on: branch `mine`, the release
                     commit plus one commit per fix that is on, in the order they went on. A GitHub install's live is
                     a clone of Claude Code's own clone of the marketplace, at the installed commit (no download); a
                     clone install's (scripts/install.sh --local) is a worktree of that clone, so `mine` shows there;
                     a release's zip, unpacked, has no git, so its live comes from thimble's repository, at the release
                     whose files the zip's folder has (_zip_release), and the folder stays as it is.
    release/         the release commit (base) as it is, never changed by a fix: a detached worktree of live's
                     repository, made with live, moved when base moves, made again when it is missing, and put back as
                     the release commit has it before the way back runs from it (place_release, the launcher), never
                     from live
    work/<id>/       a fix's scratch worktree, cut from mine. The fixer edits only here, and its shell runs in the
                     sandbox runtime, which may write only here and in tmp/<id>/, and reach only the package registries
                     (REGISTRIES). Removed after apply or "not now".
    tmp/<id>/        the fixer's home and temp folder in the sandbox, and the logs of the tests thimble ran (tests.log)
                     and of the process that ran them (runner.log)
    work/carry/      the copy in which the fixes an update set aside are checked on the new release, as done checks a
                     fix, before they go on again (carry); tmp/carry/ is its temp folder. Removed after the check.
    pending/         what thimble update set aside: current.json (the update, and the fixes it set aside), each fix's
                     old change (<version>/fix-<id>.patch), thimble reapply's prompt (<version>.md), and sync-owed
                     while Claude Code has not copied the fixes that carry put back
    srt/<pin>/      the release's sandbox runtime, once live's pin or lock file is not the release's (_srt)
    tests.lock       the quick tests run for one fix at a time
    tests/<id>.lock  the fix's guard: one check of the fix at a time, from before it commits the fixer's change until the
                     record says that its tests run (done)
    tests/<id>.<run>.lock  a lock file of each run of a fix's quick tests, held by the process that runs them (the
                     runner) while it lives, and gone after it
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

refs/thimble/fixes/<id> in live's repository keeps each fix's commit, on or off, so an undone fix can come back. A clone
install's home that was deleted leaves mine and these refs in the person's clone; a new home that makes live moves them
under refs/thimble-old/<UTC time>/ when mine is thimble's own (_leftovers_aside).

More words for a fix are a round of that fix, never a new fix (round_). A fix that is on, off or ready with no copy is
changed in place: a copy holds its change, the fixer adds to it, and the new version (refs/thimble/next/<id>) waits for
the person's y while the version they have (prev) stays as it was; y swaps it in, and u brings back the one before
(refs/thimble/prev/<id>). Follow-ups made as fixes of their own before this (records with `refines`) fold into their
fix by themselves when the list is read (fold_strays), with git's three-way picks; thimble fix merge is the manual
fallback.

thimble's code, not Claude, commits, moves mine and points Claude Code's marketplace at live. Claude Code copies the
plugin from live into its own cache (`claude plugin update`), and the session loads it with /reload-plugins; its cache
is never edited here. Claude Code names a copy by the plugin's version, else by its commit, and keeps a copy it already
has (_stamp): when the release's plugin.json has a version, live's carries it with the commit of mine after it
(0.10.2+fix.4e1a9c2), written in live's working tree only. A release names its version by its tag alone, so live's
copy is named by its commit; `thimble --version` names the release (version_name).

The way back from a fix runs from the release checkout, so no fix can break its own undo, not even one that changes the
launcher or the kernel's modules: the plugin runs `thimble fix` with release/'s launcher (fix/fixes.ts kernelFix); the
shell's `thimble` is a link to it (_relink_cli), and the launcher runs `thimble fix`, `thimble file`, `thimble update`,
`thimble reapply` and `thimble doctor` from release/ and the rest (label, coverage, which Claude runs) from live, so a
fix to them works; the fixer's shell and the quick tests run in release/'s sandbox (sandbox_dir); off.sh runs no
thimble code at all.

A fix may not change the way back (PROTECTED): the fix flow, which turns fixes off and undoes them, and the privacy scan
a shared fix goes through. Binary files are refused too. It may change the rest (NOTICE), such as the sandbox, the hooks
file and its command hooks, the launcher, thimble's scripts and lock files (a package added from REGISTRIES): its record
names the kinds and the files (notice), and the line that asks whether to use it says them in one sentence, as thimble
fix show does; a fix that thimble update --continue turns on again, with no key press, may change only those it changed
before (continue_), and one that an update puts back on its own (carry) is the very change the person had on. A file
moved counts as both its names. thimble checks this when the fixer ends (done); the fixer's
prompt does not list these files. A check that refuses a change (these files, a binary file, failing tests) keeps the
refusal on the record (refused: why, the files, the tests' output) until the next check, and the plugin gives it back
to a fixer in the same copy (again): the fixer puts the change elsewhere or fixes the tests, or ends saying why it
cannot be done (done with `cannot`), which is the failure the person sees. Another try at a failed fix (redo: y on its
line, or /thimble-fix N alone) goes on in its copy while the copy holds work that no check took, such as the change
Claude made there in the person's session, so that the check takes it; else it starts in a new copy cut from mine, with
the earlier change to start from. The quick tests run with no network, for one
fix at a time, start the copy's launcher first, and a suite that fails runs once more before the fix fails (run_tests).
They run in a process of their own (the runner), apart from the call that checks the fix, so that they may take longer
than Claude Code lets a call run: the record stays working, with `testing`, until the runner writes what came of them,
and done waits for that (_start_tests).

The programs it runs can be replaced for tests: THIMBLE_CLAUDE (claude), THIMBLE_GH (gh), THIMBLE_GIT (the git that
pushes), THIMBLE_FIX_TESTS (the quick tests, a shell command), THIMBLE_FIX_PUSH_URL (where a pull request's commit is
pushed, with {login} and {name}).
"""
from __future__ import annotations

import contextlib
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
STATES = ("working", "ready", "failed", "on", "off", "redo", "pending", "request", "sent", "saved", "released", "removed",
          "merged")
PLUGIN_JSON = "plugin/.claude-plugin/plugin.json"

# the files a fix may not change, by what each one is: the way back, which turns fixes off and undoes them, and the scan
# a shared fix goes through (fnmatch patterns over the repository's paths). The refusal names each file with what it is.
PROTECTED_KINDS = {
    "the fix flow": ("plugin/engine/kernel/fixes.py", "plugin/engine/kernel/share.py", "plugin/fix/*",
                     "plugin/prompts/fixer.md", "plugin/prompts/fix-draft.md", "plugin/prompts/fix-merge.md",
                     "browser/backend/app/dev.py",
                     "browser/backend/app/fixes.py", "browser/backend/app/fix_share.py", "browser/frontend/src/fixes/share*",
                     "browser/frontend/src/chat/FixStrip.tsx", "browser/frontend/src/chat/fix.ts"),
    "the privacy scan": ("plugin/engine/kernel/privacy.py",),
}
PROTECTED = tuple(pat for pats in PROTECTED_KINDS.values() for pat in pats)
# the files a fix may change that the person is told of before they use it, by what each one is: the rest of what keeps
# them safe, and the packages thimble installs. A file counts as the first kind it matches.
NOTICE_KINDS = {
    "the sandbox": ("plugin/sandbox/*", "plugin/cards/argv.mjs", "plugin/cards/ask.ts", "plugin/cards/runner.mjs",
                    "browser/backend/app/kernel_wrap.py", "browser/backend/app/kernel_srt.mjs",
                    "browser/backend/app/srt.py"),
    "the hooks file": ("plugin/hooks/hooks.json",),
    "a command hook": ("plugin/hooks/temp-allow.sh", "plugin/hooks/temp_allow.py"),
    "the launcher": ("plugin/bin/*",),
    "thimble's scripts": ("scripts/*", "browser/scripts/*"),
    "dependencies": ("*package-lock.json", "*yarn.lock", "*pnpm-lock.yaml", "*uv.lock", "*poetry.lock", "*Cargo.lock"),
}
# the sites the fixer's own shell commands may reach, so that a fix can add a package; the quick tests reach none
REGISTRIES = ("registry.npmjs.org", "pypi.org", "files.pythonhosted.org")


class FixError(Exception):
    """A step that cannot go on; its message is the one line the person reads, with what to do."""


# ------------------------------------------------------------------ places and programs


def home() -> Path:
    return thimble_home() / "fixes"


def live_dir() -> Path:
    return home() / "live"


def release_dir() -> Path:
    return home() / "release"


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
        stdin: str | None = None, timeout: float | None = 300,
        said: list[str] | None = None) -> subprocess.CompletedProcess:
    """`cmd`; a failure is a FixError that names the command (`said`, when the person reads it otherwise)."""
    said = said or cmd
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, input=stdin, timeout=timeout)
    except FileNotFoundError:
        raise FixError(f"{said[0]} is not installed")
    except subprocess.TimeoutExpired:
        raise FixError(f"{' '.join(said[:3])} took longer than {int(timeout or 0)} s")
    if check and p.returncode != 0:
        err = (p.stderr or p.stdout).strip().splitlines()
        raise FixError(f"{' '.join(said[:3])} failed: {err[-1] if err else 'no message'}")
    return p


THIMBLE_ID = ["-c", "commit.gpgsign=false"]


def as_thimble() -> dict[str, str]:
    """The environment of a commit thimble makes: its author and committer are thimble, whatever the person's git
    identity is."""
    return {**os.environ, "GIT_AUTHOR_NAME": "thimble", "GIT_AUTHOR_EMAIL": "thimble@localhost",
            "GIT_COMMITTER_NAME": "thimble", "GIT_COMMITTER_EMAIL": "thimble@localhost"}


def git(*args: str, cwd: str | Path, env: dict[str, str] | None = None, check: bool = True, hooks: bool = True) -> str:
    """git ARGS; with hooks False, with no hook of the repository's (NO_HOOKS): thimble's own calls that make or move a
    fix's copy, or move live (for a fix, or to follow the release before the first fix goes on), which a hook of the
    person's clone (git-lfs's, with no git-lfs on the PATH) would fail."""
    return run(["git", *([] if hooks else NO_HOOKS), *args], cwd=cwd, env=env, check=check,
               said=["git", *args]).stdout.strip()


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
    """Each fix's record: the last line of its id in fixes.jsonl. A record stored before thimble kept a notice (0.10.4
    and older) gets the one its files have now, as put would give it, so that the person is told before they use it."""
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
    for r in out.values():
        if "notice" not in r:
            notice = notice_of([str(f.get("path") or "") for f in r.get("files") or [] if isinstance(f, dict)])
            if notice:
                r["notice"] = notice
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
    """The record's new state, as one line appended in one write, with the kinds of files it changes that the person is
    told of (notice), from its files as they are now. Only a working fix's tests run (`testing`): a fix that went on
    without them (removed while they ran) has no such mark."""
    rec = {**rec, "updated": time.time()}
    rec.pop("notice", None)
    if rec.get("state") != "working":
        rec.pop("testing", None)
    notice = notice_of([str(f.get("path") or "") for f in rec.get("files") or []])
    if notice:
        rec["notice"] = notice
    home().mkdir(parents=True, exist_ok=True)
    line = json.dumps(rec, ensure_ascii=False) + "\n"
    fd = os.open(home() / "fixes.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)
    return rec


class Lock:
    """One change of live at a time (a key press and a session start at once); with `name` tests.lock, one run of the
    quick tests at a time."""

    def __init__(self, name: str = "fixes.lock"):
        self.name = name

    def __enter__(self):
        import fcntl  # noqa: PLC0415

        home().mkdir(parents=True, exist_ok=True)
        self.f = open(home() / self.name, "w")
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
    is a worktree of it. zip: a release with no git of its own, as a release's zip unpacks (the folder of a directory
    marketplace or of a --plugin-dir session, a folder inside another repository too, else the plugin's own folder,
    whose files are those under `prefix` plugin/): its history is in thimble's repository, where its updates come from,
    and live is made from there at the release whose files it has (_zip_release), so commit is '' until then."""
    m = _marketplace()
    src = m.get("source") if isinstance(m.get("source"), dict) else {}
    loc = m.get("installLocation")
    sha = _installed_sha()
    named = Path(src["path"]) if src.get("source") == "directory" and src.get("path") else None
    if named:
        if _own_checkout(named):
            ok = sha and run(["git", "cat-file", "-e", sha + "^{commit}"], cwd=named, check=False).returncode == 0
            top = git("rev-parse", "--show-toplevel", cwd=named)
            return {"kind": "clone", "repo": top, "commit": sha if ok else git("rev-parse", "HEAD", cwd=named),
                    "url": top, "entry": src}
    elif src and loc and Path(loc).is_dir() and git("rev-parse", "--git-dir", cwd=loc, check=False):
        ok = sha and run(["git", "cat-file", "-e", sha + "^{commit}"], cwd=loc, check=False).returncode == 0
        url = git("remote", "get-url", "origin", cwd=loc, check=False) or (
            f"https://github.com/{src['repo']}.git" if src.get("repo") else str(src.get("url") or ""))
        return {"kind": "github", "repo": str(loc), "commit": sha if ok else git("rev-parse", "HEAD", cwd=loc),
                "url": url, "entry": src}
    repo = PLUGIN.parent
    if _own_checkout(repo):
        return {"kind": "clone", "repo": str(repo), "commit": git("rev-parse", "HEAD", cwd=repo), "url": str(repo),
                "entry": None}
    zipped = {"kind": "zip", "commit": "", "url": update_url(), "entry": src or None}
    for folder in (named, repo):
        if folder is not None and (folder / PLUGIN_JSON).is_file():
            return {**zipped, "repo": str(folder), "prefix": ""}
    if (PLUGIN / ".claude-plugin" / "plugin.json").is_file():
        return {**zipped, "repo": str(PLUGIN), "prefix": "plugin/"}
    raise FixError("this thimble was not installed from a git repository, so there is no copy of its code to change. "
                   "Install it again with scripts/install.sh, then ask again")


def _own_checkout(p: Path) -> bool:
    """Whether the folder `p` is the top of a git checkout of its own; a folder inside another repository is not."""
    top = git("rev-parse", "--show-toplevel", cwd=p, check=False) if p.is_dir() else ""
    return bool(top) and Path(top).resolve() == p.resolve()


def _json_of(data: bytes) -> Any:
    try:
        return json.loads(data)
    except ValueError:
        return None


def _blob_id(data: bytes, width: int) -> str:
    """git's id of a file's content, in the hash of the repository whose ids are `width` long (sha1, or sha256)."""
    return (hashlib.sha256 if width == 64 else hashlib.sha1)(b"blob %d\0" % len(data) + data).hexdigest()


def _differs(repo: Path, commit: str, root: Path, prefix: str = "", memo: dict | None = None) -> tuple[list[str], int]:
    """The files of `commit` (those under `prefix`, with it left out of their path in `root`) that the folder `root`
    does not have as the commit has them, changed or missing, and how many files the commit has there: from git's
    trees, so the files' contents need not be in the repository. Files the folder has besides (an install's
    packages, what a session writes) do not count, nor a version that an install wrote in the plugin's manifest.
    `memo`: the folder's ids read before, by path."""
    memo = {} if memo is None else memo
    out = run(["git", "ls-tree", "-r", "-z", "--full-tree", commit, *([prefix] if prefix else [])], cwd=repo).stdout
    off: list[str] = []
    n = 0
    for entry in filter(None, out.split("\0")):
        meta, _, path = entry.partition("\t")
        mode, kind, sha = meta.split()
        if kind != "blob":
            continue
        n += 1
        if (path, mode, len(sha)) not in memo:
            p = root / path[len(prefix):]
            try:
                data = os.readlink(p).encode() if mode == "120000" else None if p.is_symlink() else p.read_bytes()
            except OSError:
                data = None
            ids = set()
            if data is not None:
                ids.add(_blob_id(data, len(sha)))
                d = _json_of(data) if path == PLUGIN_JSON else None
                if isinstance(d, dict) and "version" in d:
                    d.pop("version")
                    ids.add(_blob_id((json.dumps(d, indent=2, ensure_ascii=False) + "\n").encode(), len(sha)))
            memo[(path, mode, len(sha))] = ids
        if sha not in memo[(path, mode, len(sha))]:
            off.append(path)
    return off, n


def _zip_release(root: Path, prefix: str = "", latest: dict[str, Any] | None = None) -> tuple[str, str]:
    """(tag, commit) of the release whose files the folder `root` has (find_source's zip), among thimble's releases
    at update_url() (`latest`, when they were read already): their trees alone are fetched, with no file contents, into
    a scratch repository that goes after, and each is compared with the folder (_differs). The release the folder has
    whole wins: of several, the one with the most files (a release that only removed files), then the one the folder's
    name gives (GitHub names a release's archive thimble-0.10.6), then the newest. A folder that no release matches
    stops, with the nearest release and its files that differ."""
    latest = latest or latest_release(then="try again")
    m = re.search(r"(\d+\.\d+\.\d+)$", root.name)
    named = f"v{m.group(1)}" if m else ""
    seen: list[tuple[str, str, list[str], int]] = []
    memo: dict = {}
    with tempfile.TemporaryDirectory(prefix="thimble-zip-") as d:
        git("init", "-q", "--bare", d, cwd=d)
        git("remote", "add", "origin", latest["url"], cwd=d)
        git("config", "remote.origin.promisor", "true", cwd=d)
        run(["git", "fetch", "-q", "--depth", "1", "--filter=blob:none", "--no-tags", "origin",
             *[f"+refs/tags/{t}:refs/tags/{t}" for t in latest["tags"]]], cwd=d, timeout=600)
        for t in latest["tags"]:
            commit = git("rev-parse", f"refs/tags/{t}^{{commit}}", cwd=d)
            seen.append((t, commit, *_differs(Path(d), commit, root, prefix, memo)))
    whole = [s for s in seen if not s[2]]
    if whole:
        t, commit, _, _ = max(whole, key=lambda s: (s[3], s[0] == named, _vtuple(s[0])))
        return t, commit
    t, _, off, _ = min(seen, key=lambda s: (len(s[2]), s[0] != named, tuple(-x for x in _vtuple(s[0]))))
    more = off[:2] + ([f"{len(off) - 2} more"] if len(off) > 2 else [])
    raise FixError(f"the files in {_tilde(str(root))} are not those of a thimble release (the nearest, {t[1:]}, differs "
                   f"in {_and(more)}), so thimble cannot tell which release to keep your fixes and updates on. Put "
                   f"those files back as {t[1:]} has them, or install thimble from a git clone (INSTALL.md), then try "
                   "again")


def _zip_fetch(live: Path, tag: str) -> None:
    """The release `tag` in live, from thimble's repository (live's origin), with no more history."""
    run(["git", "fetch", "-q", "--depth", "1", "--no-tags", "origin", f"+refs/tags/{tag}:refs/tags/{tag}"], cwd=live,
        timeout=600)


OFF_SH = """#!/bin/sh
# Back to the plain thimble release, also when thimble does not load: sh {off}
# It shows the release commit in {live} and has Claude Code copy it. Your fixes stay: `thimble fix on` brings them back.
# First the release checkout, which `thimble fix` runs from, goes back to the release commit as it has it, also when a
# file in it (its launcher) was changed, with no hook of the repository's.
release=$(cd {release_q} 2>/dev/null && pwd -P)
if [ -n "$release" ] && [ "$(git -C "$release" rev-parse --show-toplevel 2>/dev/null)" = "$release" ]; then
  git -c core.hooksPath=/dev/null -C "$release" checkout -q -f --detach {base} 2>/dev/null
  git -c core.hooksPath=/dev/null -C "$release" clean -q -ffdx 2>/dev/null
fi
live={live_q}
git -c core.hooksPath=/dev/null -C "$live" checkout -q -- {plugin_json} 2>/dev/null
git -c core.hooksPath=/dev/null -C "$live" checkout -q --detach {base} || {{ echo "thimble: could not show the release in $live"; exit 1; }}
printf '{{"on": false}}\\n' > {state_q}
{claude} plugin update thimble@thimble >/dev/null 2>&1
echo "thimble is the plain release again; your fixes are kept (thimble fix on). In Claude Code, type /reload-plugins."
"""


def _off_sh(rel: dict[str, Any]) -> str:
    """off.sh as this kernel writes it for the release `rel`."""
    off = home() / "off.sh"
    return OFF_SH.format(off=off, live=live_dir(), live_q=shlex.quote(str(live_dir())), plugin_json=PLUGIN_JSON,
                         base=shlex.quote(rel["base"]), state_q=shlex.quote(str(home() / "state.json")),
                         claude=shlex.quote(claude()), release_q=shlex.quote(str(release_dir())))


def _write_off_sh(rel: dict[str, Any]) -> None:
    off = home() / "off.sh"
    off.write_text(_off_sh(rel))
    off.chmod(0o755)


def ensure_live() -> dict[str, Any]:
    """live, made at the first request, with the release checkout beside it: nothing the person runs changes until the
    first fix goes on. Until then, the release follows the code that runs (_follow), so that the release checkout is
    never older than it. A home that has live gets off.sh as this kernel writes it when its text is another: an older
    thimble's (the update that installs this one runs the older kernel)."""
    rel = release()
    live = live_dir()
    if rel and (live / ".git").exists():
        rel = _follow(rel)
        if _text_of(home() / "off.sh") != _off_sh(rel):
            _write_off_sh(rel)
        place_release(rel["base"])
        return rel
    src = find_source()
    repo, commit = Path(src["repo"]), src["commit"]
    home().mkdir(parents=True, exist_ok=True)
    if live.exists():
        shutil.rmtree(live)
    if src["kind"] == "zip":
        tag, commit = _zip_release(repo, src["prefix"])
        git("init", "-q", str(live), cwd=home())
        git("remote", "add", "origin", src["url"], cwd=live)
        _zip_fetch(live, tag)
        git("checkout", "-q", "-b", "mine", commit, cwd=live, hooks=False)
    elif src["kind"] == "github":
        git("clone", "-q", "--no-checkout", str(repo), str(live), cwd=home())
        if src.get("url"):
            git("remote", "set-url", "origin", src["url"], cwd=live)
        git("checkout", "-q", "-b", "mine", commit, cwd=live)
    else:
        _leftovers_aside(repo)
        git("worktree", "add", "-q", "-b", "mine", str(live), commit, cwd=repo, hooks=False)
    # the release's tag when the commit has one (v0.10.2), for its name in the list and in thimble update
    tag = git("describe", "--tags", "--exact-match", "--match", "v*", commit, cwd=live, check=False)
    rel = {"kind": src["kind"], "source": src["url"], "repo": str(repo), "entry": src.get("entry"), "base": commit,
           "version": _version_at(live, commit), "pointed": False, "created": time.time(), "checked": commit,
           **({"tag": tag} if RELEASE_TAG.match(tag) else {})}
    write_json(home() / "release.json", rel)
    _write_off_sh(rel)
    rel = _follow(rel)
    place_release(rel["base"])
    return rel


def _leftovers_aside(repo: Path) -> None:
    """Before a clone install's live is made in the person's clone: what a thimble home that was deleted left there
    goes aside, so that nothing of it is lost and the new fixes see none of it. git forgets the worktrees whose folders
    are gone; then, with no records in this home and no other thimble home's live in the clone (_other_live), thimble's
    own mine (_thimbles_mine) and every ref under refs/thimble/ move under refs/thimble-old/<UTC time>/ in one update
    (refs/heads/mine as heads/mine, refs/thimble/fixes/1 as thimble/fixes/1), and no other ref (a branch mine/wip stays).
    Any other mine, or a mine while this home has records, stops the request."""
    run(["git", "worktree", "prune"], cwd=repo, check=False)
    has = run(["git", "rev-parse", "--verify", "-q", "refs/heads/mine"], cwd=repo, check=False).returncode == 0
    recs = records()
    if has and (recs or not _thimbles_mine(repo)):
        raise FixError(f"your clone {repo} already has a branch named mine; rename it (git branch -m mine "
                       "mine-old), then ask again")
    old = [] if recs or _other_live(repo) else [
        x for x in git("for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/mine", "refs/thimble/",
                       cwd=repo).splitlines() if x.partition(" ")[2] == "refs/heads/mine"
        or x.partition(" ")[2].startswith("refs/thimble/")]
    if not old:
        return
    stamp = aside = "refs/thimble-old/" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    n = 1
    while git("for-each-ref", "--count=1", aside + "/", cwd=repo):
        n += 1
        aside = f"{stamp}-{n}"
    moves = []
    for line in old:
        sha, _, ref = line.partition(" ")
        moves += [f"create {aside}/{ref.removeprefix('refs/')} {sha}", f"delete {ref} {sha}"]
    run(["git", "update-ref", "--no-deref", "--stdin"], cwd=repo, stdin="\n".join(moves) + "\n")


def _thimbles_mine(repo: Path) -> bool:
    """Whether the clone's mine is one that a deleted thimble home left: no worktree has it checked out, rebases or
    bisects it (git refuses to move a branch a worktree uses), no worktree is another thimble home's live (which is
    detached while that home's fixes are off), it tracks no upstream (branch.mine.remote, which thimble never sets), and
    thimble made or recorded each commit that is only on mine (on no other branch, tag or remote branch; a detached HEAD
    on top of mine, as in a rebase onto it, does not count): thimble committed it, or it is the very commit that a ref
    under refs/thimble/fixes/ names (a fix thimble update --continue recorded, which Claude committed as the person).
    A mine with no commits of its own, such as the release commit, is one."""
    wts = git("worktree", "list", "--porcelain", cwd=repo).splitlines()
    if "branch refs/heads/mine" in wts or _other_live(repo):
        return False
    if git("config", "--get", "branch.mine.remote", cwd=repo, check=False):
        return False
    if run(["git", "branch", "-f", "--no-track", "mine", "refs/heads/mine"], cwd=repo, check=False).returncode != 0:
        return False
    me = as_thimble()
    recorded = set(git("for-each-ref", "--format=%(objectname)", "refs/thimble/fixes/", cwd=repo).split())
    own = git("log", "--format=%H %cn <%ce>", "refs/heads/mine", "--not", "--exclude=mine", "--branches", "--tags",
              "--remotes", "--", cwd=repo).splitlines()
    return all(x.partition(" ")[0] in recorded
               or x.partition(" ")[2] == f"{me['GIT_COMMITTER_NAME']} <{me['GIT_COMMITTER_EMAIL']}>" for x in own)


def _other_live(repo: Path) -> bool:
    """Whether a worktree of the clone is another thimble home's live (live, with that home's release.json beside it)."""
    wts = git("worktree", "list", "--porcelain", cwd=repo).splitlines()
    paths = [Path(x.partition(" ")[2]) for x in wts if x.startswith("worktree ")]
    return any(p.name == "live" and (p.parent / "release.json").exists() for p in paths)


def _follow(rel: dict[str, Any]) -> dict[str, Any]:
    """Before the first fix goes on (Claude Code's marketplace not on live yet), the release follows the code that runs:
    when Claude Code's installed plugin (installed_plugins.json), or this kernel's own checkout when it is the clone
    live came from, is a commit after the release commit (base), as after scripts/install.sh, `claude plugin update`
    or Claude Code's own update, base moves to it (fetched into live from that clone when live lacks it), and mine with
    it while mine holds no fix; on a zip install, when the folder of Claude Code's marketplace has a later release's
    files (_zip_moved). The release as it is then."""
    if rel.get("pointed"):
        return rel
    live, base = live_dir(), str(rel["base"])
    src = Path(rel["repo"]) if rel.get("repo") and Path(rel["repo"]).is_dir() else None
    if rel.get("kind") == "zip":
        src, codes = None, [_zip_moved(rel)]
    else:
        own = git("rev-parse", "HEAD", cwd=src, check=False) if src and PLUGIN.parent.resolve() == src.resolve() else ""
        codes = [_installed_sha(), own]
    new = base
    for c in dict.fromkeys(x for x in codes if x and x != base):
        if not _has(live, c) and src:
            # a shallow live (a clone of Claude Code's shallow clone) takes it as a shallow commit; a whole live takes it
            # only with its history (a commit whose parents it lacks is no candidate)
            shallow = git("rev-parse", "--is-shallow-repository", cwd=live, check=False) == "true"
            run(["git", "fetch", "-q", "--no-tags", *(["--update-shallow"] if shallow else []), str(src), c], cwd=live,
                check=False, timeout=600)
        if run(["git", "rev-list", "-n", "2", c], cwd=live, check=False).returncode == 0 and _later(live, new, c):
            new = c
    if new == base:
        return rel
    rel = {**rel, "base": new, "version": _version_at(live, new), "updated": time.time()}
    rel.pop("checkout", None)
    tag = next((t for t in (git("describe", "--tags", "--exact-match", "--match", "v*", new, cwd=r, check=False)
                            for r in (live, src) if r) if RELEASE_TAG.match(t)), "")
    if tag:
        rel["tag"] = tag
    else:
        rel.pop("tag", None)
    if git("rev-parse", "mine", cwd=live) == base:
        _unstamp()
        if git("symbolic-ref", "-q", "HEAD", cwd=live, check=False) == "refs/heads/mine":
            git("checkout", "-q", "-B", "mine", new, cwd=live, hooks=False)
        else:
            git("branch", "-f", "mine", new, cwd=live)
            git("checkout", "-q", "--detach", new, cwd=live, hooks=False)
        # mine holds no fix on the new release, so none waits for a check there (_unchecked_on)
        rel["checked"] = new
    write_json(home() / "release.json", rel)
    _write_off_sh(rel)
    return rel


def _zip_moved(rel: dict[str, Any]) -> str:
    """A zip install's release before its first fix goes on, when the folder that Claude Code's marketplace names no
    longer has base's files, as after the person unzipped another release and installed it from there: the release it
    has now (_zip_release), fetched into live. '' while the folder has base's files, and when the marketplace names no
    such folder."""
    m = _marketplace()
    src = m.get("source") if isinstance(m.get("source"), dict) else {}
    root = Path(src["path"]) if src.get("source") == "directory" and src.get("path") else None
    if root is None or not (root / PLUGIN_JSON).is_file() or _own_checkout(root):
        return ""
    if not _differs(live_dir(), str(rel["base"]), root)[0]:
        return ""
    tag, commit = _zip_release(root)
    _zip_fetch(live_dir(), tag)
    return commit


def _later(repo: Path, a: str, b: str) -> bool:
    """Whether commit b comes after commit a: a is in b's history, or, when neither history holds the other (a shallow
    clone, as Claude Code's is, lacks the commits between), b was committed later."""
    if a == b or _ancestor(repo, b, a):
        return False
    if _ancestor(repo, a, b):
        return True
    ta, tb = (git("log", "-1", "--format=%ct", c, cwd=repo, check=False) for c in (a, b))
    return ta.isdigit() and tb.isdigit() and int(tb) > int(ta)


def place_release(base: str) -> None:
    """The release checkout at `base`: made when it is missing (or no longer a checkout), and each time put back as
    the release commit has it, with any file changed in it restored and any file added to it (also an ignored one, such
    as a module that would shadow one of Python's) removed. A fix changes its copy and live, never this. The launcher
    (plugin/bin/thimble) does the same before it runs the way back from here. A checkout that is as the release commit
    has it already is left alone (_pristine), so that thimble's other processes that run from it at the same time (the
    plugin's list, another session, the browser) never meet it half put back."""
    d = release_dir()
    if _is_checkout(str(d)):
        if not _pristine(d, base):
            _release_git(d, "checkout", "-q", "-f", "--detach", base)
            _release_git(d, "clean", "-q", "-ffdx")
        return
    if d.exists():
        shutil.rmtree(d)
    run(["git", "worktree", "prune"], cwd=live_dir(), check=False)
    _release_git(live_dir(), "worktree", "add", "-q", "--detach", str(d), base)


def _pristine(d: Path, base: str) -> bool:
    """Whether the checkout `d` is as commit `base` has it: HEAD detached at base, and no file changed, untracked or
    ignored. One git call. It writes the checkout's index only when the files' times there are stale (a checkout made or
    put back within the same second), so that the next looks, the launcher's and the browser's too, are quick, and it
    never waits for the index's lock: when another process's git holds it, it writes nothing."""
    p = run(["git", "status", "--porcelain=v2", "--branch", "--ignored", "--untracked-files=normal"], cwd=d, check=False)
    lines = p.stdout.splitlines()
    return (p.returncode == 0 and f"# branch.oid {base}" in lines and "# branch.head (detached)" in lines
            and all(x.startswith("# ") for x in lines))


# git with no hook of the repository's: in a clone install, the person's own clone's (git-lfs's post-checkout, which
# fails when git-lfs is not on the kernel's PATH)
NO_HOOKS = ["-c", "core.hooksPath=/dev/null"]


def _release_git(d: Path, *args: str) -> None:
    """git ARGS in `d` for the release checkout, with no hook (NO_HOOKS), tried again for up to 5 s while another git
    holds the checkout's index (index.lock): the launcher and the browser put the checkout back too, with no lock of
    thimble's."""
    for n in range(50):
        p = run(["git", *NO_HOOKS, *args], cwd=d, check=False)
        if p.returncode == 0:
            return
        if "index.lock" not in p.stderr:
            break
        time.sleep(0.1)
    err = (p.stderr or p.stdout).strip().splitlines()
    raise FixError(f"{' '.join(['git', *args][:3])} failed: {err[-1] if err else 'no message'}")


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
    # a commit of the person's checkout that thimble update moved to: its plugin.json keeps the version of the last
    # release while the code changes, so the commit goes in the name too
    dev = bool(rel.get("checkout")) and not rel.get("tag")
    if not v or (now == rel.get("base") and not dev):
        return v or now[:12]
    p = live_dir() / PLUGIN_JSON
    try:
        d = json.loads(p.read_text())
    except (OSError, ValueError):
        return v
    d["version"] = f"{v}+{now[:7]}" if now == rel.get("base") else f"{v}+fix.{now[:7]}"
    p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    return d["version"]


def _repoint() -> None:
    """Point Claude Code's thimble marketplace at live, once, at the first fix. Claude Code also keeps the source in
    its user settings (extraKnownMarketplaces) and refuses another source for the name until that entry changes, so
    the entry changes first, and nothing else in the file; then Claude Code adds the marketplace from live. Removing
    the marketplace instead would uninstall thimble and lose its options. When Claude Code does not add it, the
    settings are put back as they were, so that the y that called this changes nothing (apply, _swap)."""
    rel = release()
    if rel.get("pointed"):
        # a shell link made before the release checkout was (to live's launcher) moves to the checkout's
        _relink_cli()
        return
    if not _marketplace():
        # Claude Code has no thimble marketplace (the browser workbench alone): nothing to point, and nothing to copy
        return
    entry = {"source": "directory", "path": str(live_dir())}
    p = config_dir() / "settings.json"
    try:
        text = p.read_text()
        settings = json.loads(text)
    except FileNotFoundError:
        text, settings = None, None
    except (OSError, ValueError):
        raise FixError(f"thimble cannot read Claude Code's settings ({p}) to load thimble from your fixes")

    def write(t: str) -> None:
        tmp = p.with_suffix(".json.thimble-tmp")
        tmp.write_text(t)
        os.chmod(tmp, p.stat().st_mode & 0o777)
        tmp.replace(p)

    known = (settings or {}).get("extraKnownMarketplaces")
    changed = isinstance(known, dict) and isinstance(known.get("thimble"), dict)
    if changed:
        known["thimble"]["source"] = entry
        write(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
    try:
        run([claude(), "plugin", "marketplace", "add", str(live_dir())])
    except FixError:
        if changed and text is not None:
            write(text)
        raise
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
    """The folders the Python `py` runs from, which the sandbox reads: its prefix and base prefix, and the folder of each
    link on the way to its program, by the link's own name (a uv environment's python names uv's folder of its minor
    version, cpython-3.14-…, itself a link to the folder of the patch, cpython-3.14.6-…), so that the sandbox finds the
    program by the names that lead to it."""
    p = run([py, "-c", "import sys; print(sys.prefix); print(sys.base_prefix)"], check=False)
    dirs = [x for x in p.stdout.split() if x.startswith("/")]
    at = shutil.which(py) or py
    real = os.path.realpath(at)
    for _ in range(40):
        if not os.path.islink(at):
            break
        at = os.path.join(os.path.dirname(at), os.readlink(at))
        dirs.append(str(Path(os.path.normpath(at)).parent.parent))
    return sorted({*dirs, str(Path(real).parent.parent)})


def sandbox_dir() -> Path:
    """The sandbox code the fixer's shell and the quick tests run with (run.mjs, bwrap.sh, the srt pin): the release
    checkout's, so that a fix that loosens the sandbox does not loosen the one its own fixer and tests run in; this
    kernel's own before there is a release checkout."""
    d = release_dir() / "plugin" / "sandbox"
    return d if (d / "run.mjs").is_file() else PLUGIN / "sandbox"


def _srt_dir(root: Path | None = None) -> Path:
    """Where setup.mjs installs the release's pin of srt under `root` (thimble's home, where a session's start does)."""
    try:
        pin = json.loads((sandbox_dir() / "package.json").read_text())["dependencies"]["@anthropic-ai/sandbox-runtime"]
    except (OSError, ValueError, KeyError):
        pin = ""
    return (root or thimble_home()) / "srt" / pin


def _text_of(p: Path) -> str:
    try:
        return p.read_text()
    except OSError:
        return ""


def _srt() -> Path:
    """The folder of the release's srt: its pin, installed from its lock file (setup.mjs keeps the lock file it installed
    from in node_modules/.thimble-lock.json). A session's start installs the srt of the thimble it loads, live's, in
    thimble's home: that is the release's while live's lock file is the release's. Else the release's own setup.mjs
    installs the release's in fixes/srt, so that a fix that changes the pin or the lock file does not change the srt its
    own fixer and tests run in."""
    lock = _text_of(sandbox_dir() / "package-lock.json")
    own = _srt_dir(home())
    for srt in (_srt_dir(), own):
        if (srt / "node_modules").is_dir() and _text_of(srt / "node_modules" / ".thimble-lock.json") == lock:
            return srt
    node = shutil.which("node")
    if node:
        run([node, str(sandbox_dir() / "setup.mjs"), "--home", str(home()), "--json"], check=False, timeout=600)
    if (own / "node_modules").is_dir() and _text_of(own / "node_modules" / ".thimble-lock.json") == lock:
        return own
    raise FixError("the sandbox runtime that fixes run in is not installed, and npm could not install it (it needs the npm "
                   f"registry); node {sandbox_dir() / 'setup.mjs'} --home {home()} says why")


def sandbox_argv(fid: int | str, path_extra: list[str] | None = None, net: bool = False,
                 reads: list[str] | None = None) -> list[str]:
    """The command that runs one shell command of the fixer, or its tests, in the sandbox runtime: reads the system,
    the tools it needs and the copy's repository, writes only the copy and its temp folder, and reaches no site, or with
    `net` (the fixer's own commands) only the package registries (REGISTRIES), through srt's proxies. The command itself
    follows as /bin/bash -c CMD. `fid` names the copy: a fix's id, or `carry` (_carry_check). `reads`: more folders it
    reads (the page's packages, which the copy links)."""
    wt, tmp = home() / "work" / str(fid), home() / "tmp" / str(fid)
    tmp.mkdir(parents=True, exist_ok=True)
    srt = _srt()
    box = sandbox_dir()
    node = os.path.realpath(shutil.which("node") or "/usr/bin/node")
    py = _python()
    cl = shutil.which(claude())
    tools = [str(Path(node).parent.parent), *_py_dirs(py)]
    if cl:
        tools += [str(Path(cl).parent), str(Path(os.path.realpath(cl)).parent)]
    # the copy's git folder is live's (a worktree's .git file points into it), or the person's clone's: read only. Asked
    # of live, never of the copy's .git, which the fixer writes and could point at another repository (_own_git)
    common = git("rev-parse", "--git-common-dir", cwd=live_dir(), check=False) if live_dir().is_dir() else ""
    common = str((live_dir() / common).resolve()) if common else ""
    linux = platform.system() == "Linux"
    lit = lambda p: {"path": p, "literal": True}  # noqa: E731
    system = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc"]
    seccomp = str(srt / "node_modules" / "@anthropic-ai" / "sandbox-runtime" / "vendor" / "seccomp")
    # THIMBLE_FIX_READ: more folders the tests read (the browser workbench's page packages, which its copy links)
    extra = [x for x in [*os.environ.get("THIMBLE_FIX_READ", "").split(os.pathsep), *(reads or [])] if x.startswith("/")]
    shown = [*(system + [seccomp] if linux else []), *tools, str(box), str(wt), str(tmp),
             *([common] if common else []), *extra]
    hidden = ["/"] if linux else ["/Users", "/Volumes", "/private/tmp", "/private/var/tmp", "/private/var/folders",
                                   str(Path.home()), str(thimble_home())]
    rules = {
        "network": {"allowedDomains": list(REGISTRIES) if net else [], "deniedDomains": [],
                    **({"allowAllUnixSockets": True} if linux else {})},
        "filesystem": {"denyRead": [lit(p) for p in dict.fromkeys(hidden)],
                       "allowRead": [lit(p) for p in dict.fromkeys(x for x in shown if x and x != "/")],
                       "allowWrite": [lit(str(wt)), lit(str(tmp))], "denyWrite": []},
        **({"bwrapPath": str(box / "bwrap.sh")} if linux else {}),
    }
    py_bin = str(Path(shutil.which(py) or py).parent)
    path = ":".join(dict.fromkeys([*(path_extra or []), *([str(Path(cl).parent)] if cl else []), py_bin,
                                   str(Path(node).parent), "/usr/bin", "/bin"]))
    # the outer env -i leaves srt only PATH; with `net`, the command keeps what srt adds to that (its proxies), and has
    # nothing of the person's either way
    return ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", node, str(box / "run.mjs"), "--srt", str(srt),
            json.dumps(rules), "--", "/usr/bin/env", *([] if net else ["-i"]), f"PATH={path}", f"HOME={tmp}",
            f"TMPDIR={tmp}", f"CLAUDE_CONFIG_DIR={tmp / 'claude'}", f"THIMBLE_HOME={tmp / 'thimble'}",
            f"THIMBLE_PYTHON={py}", "DISABLE_AUTOUPDATER=1", "LANG=C.UTF-8", "/bin/bash", "-c"]


def _has_pytest(py: str) -> bool:
    return run([py, "-c", "import pytest"], check=False).returncode == 0


QUICK_TESTS = "claude plugin test plugin"
PYTESTS = '"$THIMBLE_PYTHON" -m pytest plugin -q -x -p no:cacheprovider'
# the copy's own launcher and the kernel's command start (thimble --help reads cli.py and the modules it needs) and say
# no traceback: the launcher, and the kernel run directly, since a launcher that answers --help itself would hide a dead
# kernel. Each has SMOKE_LIMIT seconds, and then its processes are stopped (exit 124), so that one that hangs does not
# hold tests.lock for the whole run. On a failure the log ends with what they said and their exit code
SMOKE_LIMIT = 60
LAUNCHER_SMOKE = ("(lim() { \"$THIMBLE_PYTHON\" -c 'import os,signal,subprocess as s,sys\n"
                  "try:p=s.Popen(sys.argv[2:],start_new_session=True)\n"
                  "except OSError as e:print(e);sys.exit(127)\n"
                  "try:c=p.wait(int(sys.argv[1]))\n"
                  "except s.TimeoutExpired:c=124\n"
                  "try:os.killpg(p.pid,signal.SIGKILL)\n"
                  "except OSError:pass\n"
                  "sys.exit(c)' " + str(SMOKE_LIMIT) + " \"$@\"; }\n"
                  "chk() { n=$1; shift; o=$(lim \"$@\" --help 2>&1); s=$?; case \"$s:$o\" in [1-9]*|0:*Traceback*) "
                  "printf \"%s\\n%s --help: exit %s\\n\" \"$o\" \"$n\" \"$s\"; return 1;; esac; }\n"
                  "chk plugin/bin/thimble plugin/bin/thimble && "
                  "chk plugin/engine/thimble.py \"$THIMBLE_PYTHON\" plugin/engine/thimble.py)")
# the page's checks, in its folder: its type check and its build, as its package.json runs them (the build into the
# sandbox's temp folder), then the unit tests of what changed since the commit the change was made on ({base})
PAGE_CHECKS = ('(cd browser/frontend && node_modules/.bin/tsc -b && node_modules/.bin/vite build --logLevel warn '
               '--outDir "$TMPDIR/page" --emptyOutDir && node_modules/.bin/vitest run --changed {base} --passWithNoTests)')
# the server's checks, in its folder: its code loads (app.main imports the module of each of its routes, as the server's
# start does), and, when its Python has pytest, its prompts render and name only the hints its code has
# (scripts/check.sh's parity). Its whole suite needs what the sandbox does not give (a browser, the network, many
# minutes): CI runs it
SERVER_LOADS = '(cd browser/backend && .venv/bin/python -c "import app.main")'
SERVER_PROMPTS = ('(cd browser/backend && THIMBLE_SKIP_KEY=1 .venv/bin/python -m pytest -q -x -p no:cacheprovider '
                  'tests_public/test_prompts.py tests_public/test_american_names.py)')
# the browser workbench's packages, as its install puts them in browser/: (part, folder of packages)
WORKBENCH_PACKAGES = (("frontend", "node_modules"), ("backend", ".venv"))


def run_tests(fid: int | str) -> tuple[bool, str]:
    """The quick tests in the copy, in the sandbox, with no network, as for a change to the terminal plugin (_checks).
    They run for one fix at a time, since two runs at once make the hooks tests run out of time, and a run that fails
    runs once more before the tests count as failed. (passed, the log's last lines, which say when they passed only the
    second time)."""
    try:
        argv = _tests_argv(fid)
    except FixError as e:
        return False, str(e)
    return _run_tests(argv, fid)


def _tests_argv(fid: int | str) -> list[str]:
    """The command that runs the quick tests (run_tests) in the copy, in the sandbox, as for a change to the terminal
    plugin. done makes it before its guard, since making it may install the sandbox runtime, which takes minutes; once it
    committed the change, it runs the checks of what the change touched (_checks_argv)."""
    return _checks_argv(fid, ["plugin/"], "HEAD")


def _checks_argv(fid: int | str, paths: list[str], base: str) -> list[str]:
    """The command that runs the checks of a change to `paths`, made on commit `base`, in the copy of `fid` (a fix's
    id, or carry), in the sandbox (_checks)."""
    cmd, reads = _checks(home() / "work" / str(fid), paths, base)
    return [*(sandbox_argv(fid, reads=reads) if reads else sandbox_argv(fid)), cmd]


def _checks(wt: Path, paths: list[str], base: str) -> tuple[str, list[str]]:
    """The checks of a change to `paths`, made in the copy `wt` on commit `base`, as one shell command that runs in the
    copy, in the sandbox, and the folders that the sandbox reads for them besides: done checks a fix with them, and
    carry the fixes it puts back, so that the two check alike. By the part of thimble a path is in: outside browser/,
    the terminal plugin's (the copy's launcher and the kernel's command, LAUNCHER_SMOKE; the hooks tests when Claude
    Code is installed; the kernel's tests when this Python has pytest); browser/frontend/, the page's (PAGE_CHECKS);
    browser/backend/ and browser/prompts/, the server's (SERVER_LOADS, and SERVER_PROMPTS when its Python has pytest);
    the rest of browser/, none. The page's and the
    server's run with the browser workbench's packages, which the copy borrows (_borrow): with none (the workbench is
    not installed), they are left out. THIMBLE_FIX_TESTS, a shell command, replaces them all."""
    cmd = os.environ.get("THIMBLE_FIX_TESTS")
    if cmd:
        return cmd, []
    parts: list[str] = []
    reads: list[str] = []
    if any(not p.startswith("browser/") for p in paths):
        parts.append(LAUNCHER_SMOKE)
        if shutil.which(claude()):
            parts.append(QUICK_TESTS)
        if _has_pytest(_python()):
            parts.append(PYTESTS)
    page = any(p.startswith("browser/frontend/") for p in paths)
    server = any(p.startswith(("browser/backend/", "browser/prompts/")) for p in paths)
    lent = _borrow(wt) if page or server else {}
    if page and "frontend" in lent:
        parts.append(PAGE_CHECKS.format(base=shlex.quote(base)))
        reads += lent["frontend"]
    if server and "backend" in lent:
        parts.append(SERVER_LOADS)
        if _has_pytest(str(wt / "browser" / "backend" / ".venv" / "bin" / "python")):
            parts.append(SERVER_PROMPTS)
        reads += lent["backend"]
    return " && ".join(parts) or "true", reads


def _borrow(wt: Path) -> dict[str, list[str]]:
    """The browser workbench's packages (WORKBENCH_PACKAGES) in the copy `wt`, for the checks of its page and its
    server. Where the copy has none of a part's (the workbench lends its own to the copy of a fix made there), it
    borrows live's, else those of the checkout the workbench was installed in (_browser_seed), as the workbench lends
    them (app/fixes.py lend), where git ignores them (browser/.gitignore): the page's as a folder of links, in which its
    tools write their temp files, and the server's Python environment as one link. For each part whose packages the
    copy has then: the folders the sandbox reads for them (the packages' own, and those of the Python the environment
    runs on)."""
    if not (wt / "browser").is_dir():
        return {}
    seed = _browser_seed()
    out: dict[str, list[str]] = {}
    for part, name in WORKBENCH_PACKAGES:
        have = wt / "browser" / part / name
        if not have.exists() and not have.is_symlink() and have.parent.is_dir():
            src = next((s / part / name for s in (live_dir() / "browser", seed) if s and (s / part / name).is_dir()), None)
            if src is not None:
                real = Path(os.path.realpath(src))
                if name == ".venv":
                    have.symlink_to(real, target_is_directory=True)
                else:
                    have.mkdir()
                    for e in real.iterdir():
                        if not e.name.startswith(".vite"):
                            (have / e.name).symlink_to(os.path.realpath(e), target_is_directory=e.is_dir())
        if name == ".venv" and (have / "bin" / "python").exists():
            out[part] = [os.path.realpath(have), *_py_dirs(str(have / "bin" / "python"))]
        elif name != ".venv" and have.is_dir():
            out[part] = sorted({os.path.realpath(have), *(str(Path(os.path.realpath(e)).parent) for e in have.iterdir()
                                                         if e.is_symlink())})
    return out


def _run_tests(argv: list[str], fid: int | str) -> tuple[bool, str]:
    """run_tests, with the command made already (_tests_argv): the runner gets it from the call that checks the fix."""
    with Lock("tests.lock"):
        ok, log = _tests_once(argv, fid)
        if not ok:
            first = log
            ok, log = _tests_once(argv, fid)
            if ok:
                log = f"{PASSED_AGAIN}; the first run ended:\n{first}"
    return ok, log


PASSED_AGAIN = "The tests passed only the second time"


def _tests_once(argv: list[str], fid: int | str) -> tuple[bool, str]:
    """One run of the quick tests in the copy: (passed, the log's last lines); the whole log in tmp/<id>/tests.log."""
    try:
        p = subprocess.run(argv, cwd=home() / "work" / str(fid), capture_output=True, text=True, timeout=540)
    except subprocess.TimeoutExpired:
        return False, "the tests ran longer than 9 minutes"
    log = (p.stdout + p.stderr).strip()
    (home() / "tmp" / str(fid)).mkdir(parents=True, exist_ok=True)
    try:
        _write_new(home() / "tmp" / str(fid) / "tests.log", log + "\n")
    except OSError:
        pass  # the log's last lines go on the record either way
    return p.returncode == 0, "\n".join(log.splitlines()[-12:])


def _write_new(p: Path, text: str) -> None:
    """A file thimble writes in a folder that the fixer's sandbox, or its tests', writes too (tmp/<id>/): what is there
    under the name (a link, a pipe) goes first, and the file is made new (O_EXCL), so that the write never follows a
    link to a file elsewhere. OSError when it cannot be made (a folder under the name, or a link made again in between)."""
    p.unlink(missing_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def _no_link(p: Path) -> None:
    """A link under a name in a folder the fixer's sandbox writes (tmp/<id>/) goes, before thimble's git makes or
    removes a folder there."""
    if p.is_symlink():
        p.unlink()


TESTS_FAILED = "its tests failed in the sandbox"
# the log's last lines of a fix whose runner ended before it wrote what came of the tests
TESTS_STOPPED = "the tests stopped before they finished"
# the runner: this kernel's Python, isolated (no PYTHON* settings, no folder of the caller's on its path), with its job
# on stdin; it writes no bytecode (-B), since a kernel that runs from the release checkout would write it there
RUNNER = "import sys; sys.path.insert(0, sys.argv[1]); from kernel import fixes; fixes.tests_runner()"


def _guard(fid: int, deadline: float | None) -> int | None:
    """The fix's guard (tests/<id>.lock): one check of a fix at a time, from before it commits the fixer's change in the
    copy until the record says that the tests run, or what came of the check (done). No runner holds it. A check that
    finds it held tries until `deadline` (time.monotonic). The descriptor that holds it, which the caller closes, or None
    at the deadline."""
    import fcntl  # noqa: PLC0415

    lock = home() / "tests" / f"{fid}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if deadline is not None and time.monotonic() >= deadline:
                os.close(fd)
                return None
            time.sleep(0.1)


def _start_tests(rec: dict[str, Any], named: str | None, argv: list[str],
                 read: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """The quick tests of a fixer's change in a process of their own (the runner), in a session of its own, apart from
    the call that checks the change: the tests wait for other fixes' tests and run twice when they fail, which may take
    longer than Claude Code lets a call run. The record stays working, with `testing` (when they started, and the lock
    file of this run, which its runner holds while it lives), until the runner writes what came of them (tests_runner).
    Each run has a lock file of its own, so that the tests of a new round never wait for the runner of the round before.
    The caller holds the fix's guard (done); this starts nothing when the record says that the tests run or is no longer
    the one it read (`read`). None: it wrote nothing, and its caller waits for the tests (_wait)."""
    import fcntl  # noqa: PLC0415

    fid = rec["id"]
    lock = home() / "tests" / f"{fid}.{secrets.token_hex(8)}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    held = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        # held from before the record says that the tests run, then by the runner, so no wait takes the lock for a
        # runner that ended (_ended)
        fcntl.flock(held, fcntl.LOCK_EX)
        # under the fixes' lock, which a new round takes too (round_)
        with Lock():
            now = get(fid)
            if now.get("testing") or (read is not None and now != read):
                lock.unlink(missing_ok=True)
                return None
            rec = put({**rec, "testing": {"since": time.time(), "lock": str(lock)}})
        job = {"id": fid, "argv": argv, "title": named, "testing": rec["testing"]}
        log = _new_log(tmp_dir(fid) / "runner.log")
        try:
            p = subprocess.Popen([sys.executable or "python3", "-I", "-B", "-c", RUNNER, str(Path(__file__).resolve().parents[1])],
                                 stdin=subprocess.PIPE, stdout=log, stderr=log, cwd=home(), start_new_session=True,
                                 pass_fds=(held,))
            with p.stdin:
                p.stdin.write(json.dumps(job).encode())
        except OSError:
            lock.unlink(missing_ok=True)  # a runner that did not start is one that ended: the wait for it says so
        finally:
            os.close(log)
    finally:
        os.close(held)
    return rec


def _new_log(p: Path) -> int:
    """A new file for the runner's output, or /dev/null. The fixer writes in the same folder, so what it may have left
    under the name (a link, a pipe) goes first."""
    try:
        p.unlink(missing_ok=True)
        return os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        return os.open(os.devnull, os.O_WRONLY)


def tests_runner() -> None:
    """The runner (_start_tests), with its job on stdin: the tests as run_tests runs them, then what came of them on the
    fix's record, as done writes it, marked as not shown yet (`unshown`) until the plugin's line shows it (shown): no
    session may wait for it any more. A record that went on without them (the fix was removed, a new round took the
    copy) stays as it is: each write looks again, under the fixes' lock, which a new round and a removal take too. The
    run's own lock file (_start_tests) goes when the runner ends."""
    job = json.loads(sys.stdin.read())
    try:
        ok, tail = _run_tests(job["argv"], job["id"])
        rec = get(job["id"])
        if rec.get("state") != "working" or rec.get("testing") != job["testing"]:
            return
        rec.pop("testing")
        rec = _tested({**rec, "unshown": True}, ok, tail, job["title"])
        if rec.get("prev") and rec["state"] == "ready":
            try:
                settle(rec, job["testing"])
            except Exception as e:
                # git stopped the round's new version: the round fails with git's words, never ready with the round's
                # own change alone, and with no refusal, which no next fixer could answer
                rec.pop("refused", None)
                _put_while_waits(job["testing"], {**rec, "state": "failed", "error": str(e)})
                if not isinstance(e, FixError):
                    raise
            return
        _put_while_waits(job["testing"], rec)
    finally:
        Path(job["testing"]["lock"]).unlink(missing_ok=True)


def _waits_for(fid: int, mark: dict[str, Any]) -> bool:
    """Whether the fix's record still waits for the run of its tests that `mark` names: working, with that mark."""
    now = get(fid)
    return now.get("state") == "working" and now.get("testing") == mark


def _put_while_waits(mark: dict[str, Any], rec: dict[str, Any]) -> None:
    """The runner's write, under the fixes' lock, and only while the record still waits for the run `mark` names: a new
    round, or the fix removed, between the runner's look and its write stays as it is."""
    with Lock():
        if _waits_for(rec["id"], mark):
            put(rec)


def shown(fid: int | str) -> dict[str, Any]:
    """The plugin's line showed what came of the fix's tests (tests_runner): it is no longer one to show at a session's
    start."""
    with Lock():
        rec = get(fid)
        if "unshown" not in rec:
            return rec
        rec.pop("unshown")
        return put(rec)


def _tested(rec: dict[str, Any], ok: bool, tail: str, named: str | None) -> dict[str, Any]:
    """The record with what came of its tests: ready, named by the fixer's title, or failed, with the refusal that the
    next fixer in the copy is told (the end of the tests' output)."""
    rec.update(tests="passed" if ok else "failed", tests_tail=tail, state="ready" if ok else "failed",
               error=None if ok else TESTS_FAILED)
    if not ok:
        rec["refused"] = {"why": TESTS_FAILED, "files": [], "tests": tail}
    elif named:
        rec["title"] = named
    return rec


def _wait(fid: int, deadline: float | None) -> dict[str, Any]:
    """The fix's record once the runner of its tests wrote what came of them, or as soon as the record no longer waits
    for that runner (a new round took the copy, the fix was removed: working with no `testing`, or another state), or
    at `deadline` (time.monotonic) as it is then: still working, with `testing`. fixes.jsonl only grows (put), so the
    record is read again only once it grew."""
    size = _size(home() / "fixes.jsonl")
    rec = get(fid)
    mark = rec.get("testing")
    if not mark or rec.get("state") != "working":
        return rec
    while not _ended(fid, mark):
        if deadline is not None and time.monotonic() >= deadline:
            return get(fid)
        time.sleep(0.1)
        if _size(home() / "fixes.jsonl") == size:
            continue
        size = _size(home() / "fixes.jsonl")
        rec = get(fid)
        if rec.get("state") != "working" or rec.get("testing") != mark:
            return rec
    return get(fid)


def _size(p: Path) -> int:
    """The file's size, or -1 when it cannot be read."""
    try:
        return p.stat().st_size
    except OSError:
        return -1


def _ended(fid: int, mark: dict[str, Any]) -> bool:
    """Whether the runner of the tests `mark` names is gone (its lock file is free, or gone). When the record still waits
    for it, the runner was stopped before it wrote what came of the tests: the fix fails, with no refusal, so that no new
    round of its fixer starts from it (y on its line starts it again)."""
    import fcntl  # noqa: PLC0415

    try:
        fd = os.open(str(mark.get("lock") or ""), os.O_RDWR)
    except OSError:
        fd = -1
    try:
        if fd >= 0:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
        rec = get(fid)
        if rec.get("state") == "working" and rec.get("testing") == mark:
            rec.pop("testing")
            put({**rec, "state": "failed", "tests": "failed", "tests_tail": TESTS_STOPPED, "error": TESTS_FAILED})
        return True
    finally:
        if fd >= 0:
            os.close(fd)


# ------------------------------------------------------------------ a request


REFINABLE = ("on", "off", "ready")


def new(words: str, made_in: str = "terminal", title: str | None = None, session: str | None = None,
        asked: str | None = None) -> dict[str, Any]:
    """A request in the person's own words (`words`, as they typed them after /thimble-fix): a copy cut from mine.
    `session`: the Claude Code session whose fixer works on it; only that session checks it at the fixer's end.
    `asked`: the person's own words beside `words`, as a plugin from before 0.10.6 gave them (_asked_of)."""
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
        git("worktree", "add", "-q", "--detach", str(wt), base, cwd=live_dir(), hooks=False)
        _give_types(wt)
        tmp_dir(fid).mkdir(parents=True, exist_ok=True)
        now = time.time()
        rec = {"id": fid, "title": (title or short(words)).strip(), "words": [], "rounds": 1, "made_in": made_in,
               "created": now, "started": now, "state": "working", "work": str(wt), "base": base, "commit": None,
               "files": [], "tests": None, "summary": "", "error": None, "root": os.environ.get("THIMBLE_ROOT") or None,
               "conversation": os.environ.get("THIMBLE_CONVERSATION") or None, "session": session or None}
        return put(_with_words(rec, [words], asked))


def _asked_of(rec: dict[str, Any]) -> list[str | None]:
    """The person's own words of each round kept beside `words`, on a record from before 0.10.6, whose `words` Claude
    wrote from them for the fixer: None for a round with none kept. A request now keeps the person's words in `words`
    itself, with nothing beside them."""
    asked = list(rec.get("asked") or [])
    n = len(rec.get("words") or [])
    return (asked + [None] * n)[:n]


def _with_words(rec: dict[str, Any], words: list[str], asked: str | None = None) -> dict[str, Any]:
    """The record with more words for its fixer (a round's), and the person's own words beside the last of them."""
    out = {**rec, "words": [*(rec.get("words") or []), *words]}
    mine = [*_asked_of(rec), *[None] * len(words)]
    if words and asked and asked.strip():
        mine[-1] = asked.strip()
    if any(mine):
        out["asked"] = mine
    return out


def _asked_field(recs: list[dict[str, Any]]) -> dict[str, Any]:
    """{asked} for one record made of these records' words in turn (a merge), or {} when none has the person's own."""
    mine = [a for r in recs for a in _asked_of(r)]
    return {"asked": mine} if any(mine) else {}


def _give_types(wt: Path) -> None:
    """The copy gets the types Claude Code wrote beside the plugin it loads (plugin/.claude-plugin/types: the
    `claude-code` module that plugin/tsconfig.json reads), which git leaves out, so its code type-checks as the person's
    does. The plugin names the folder it was loaded from (THIMBLE_PLUGIN_ROOT), since this kernel runs from the release
    checkout. Nothing when Claude Code wrote none."""
    rel = Path(".claude-plugin") / "types"
    loaded = [Path(p) / rel for p in (os.environ.get("THIMBLE_PLUGIN_ROOT"),) if p and p.startswith("/")]
    for src in (*loaded, PLUGIN / rel, live_dir() / "plugin" / rel):
        if (src / "claude-code").is_dir():
            try:
                shutil.copytree(src, wt / "plugin" / rel, dirs_exist_ok=True)
            except OSError:
                continue
            return


def again(fid: int | str, session: str | None = None) -> dict[str, Any]:
    """The check refused the fixer's change: another round in the same copy, with no new words; its fixer is told the
    refusal (refused), which stays on the record until the next check."""
    rec = get(fid)
    if rec.get("state") != "failed" or not rec.get("refused"):
        raise FixError(f"fix {rec['id']} is {state_word(rec)}, with no refusal to answer")
    if not _is_checkout(rec.get("work")):
        raise FixError(f"fix {rec['id']} has no copy any more; y starts it again in a new copy")
    # the same request, tried again: its time and its name go on; what came of the check before is no outcome to show
    rec.update(state="working", error=None, rounds=int(rec.get("rounds") or 1) + 1,
               **({"session": session} if session else {}))
    rec.pop("unshown", None)
    return put(rec)


def _fresh(rec: dict[str, Any]) -> dict[str, Any]:
    """A record that starts a round of its own (new words, or the person's y on a failed fix): its time starts now, and
    the block of the round before goes."""
    out = {k: v for k, v in rec.items() if k != "blocked"}
    return {**out, "started": time.time()}


def _in_copy(rec: dict[str, Any], words: list[str], session: str | None, asked: str | None) -> dict[str, Any]:
    """The next round of a fix in the copy it has, written under the fixes' lock, which the runner of the round before
    writes under too: words for a fixer that still works go on in its time; any other round starts its own. The tests of
    the round before, should they run, are no longer this fix's: their runner writes nothing (tests_runner)."""
    rec = rec if rec.get("state") == "working" else _fresh(rec)
    rec.pop("testing", None)
    rec.pop("unshown", None)
    rec.update(rounds=int(rec.get("rounds") or 1) + 1, state="working", error=None,
               **({"session": session} if session else {}))
    return put(_named_patches(_with_words(rec, words, asked), " ".join(words)))


def _unchecked(rec: dict[str, Any]) -> bool:
    """Whether the fix's copy holds work that no check of thimble's took, such as the change Claude makes in the
    person's session for a fix that did not pass, or what a fixer that ended with `Cannot:` left: a file changed, added
    or removed there, or a commit made there. A check commits all that the copy holds, and thimble leaves the copy's
    HEAD at the commit the copy was cut from (base) or at the commit of a check (commit, or round_commit once a round of
    a fix changed in place settled); so a HEAD at another commit that has base in its history is one made in the copy
    since, such as a commit on the last check's, or that check's commit amended. git reads the copy on its own entry
    (_own_git), and not when the copy holds a repository of its own (_nested_git)."""
    g = _own_git(rec.get("work"))
    if g is None or _nested_git(rec["work"]):
        return False
    env = {**os.environ, **g}
    p = run(["git", "status", "--porcelain"], cwd=rec["work"], check=False, env=env)
    if p.returncode != 0:
        return False
    if p.stdout.strip():
        return True
    base = str(rec.get("base") or "")
    now = run(["git", "rev-parse", "-q", "--verify", "HEAD"], cwd=rec["work"], check=False, env=env).stdout.strip()
    if not base or not now or now in (base, rec.get("commit"), rec.get("round_commit")):
        return False
    return run(["git", "merge-base", "--is-ancestor", base, now], cwd=rec["work"], check=False, env=env).returncode == 0


def round_(fid: int | str, words: str, session: str | None = None, asked: str | None = None) -> dict[str, Any]:
    """More words for a fix, whose fixer works in `session`: a new round of the same fix, never a new fix. A fix whose
    copy is still there (working, ready, or refused) gets the round in that copy. A fix that is on, off or ready with
    no copy is changed in place: a new copy holds its change, and its version as it is now (prev) stays on, or off,
    until the person's y puts the new version on (apply), and u goes back to it (undo). A fix that failed, or no longer
    fits, starts again in a new copy (redo). `asked`: the person's own words, as in new."""
    words = (words or "").strip()
    with Lock():
        rec = get(fid)
        if _is_checkout(rec.get("work")):
            return _in_copy(rec, [words], session, asked)
    if rec.get("state") in ("failed", "redo"):
        return redo(rec["id"], words, session, asked)
    if rec.get("state") not in REFINABLE or not rec.get("commit"):
        raise FixError(f"fix {rec['id']} is {state_word(rec)}; only a fix that is on, off or ready can change")
    if not words:
        raise FixError("say what should work differently in this fix")
    with Lock():
        ensure_live()
        rec = get(rec["id"])
        wt, base = _copy_of(rec)
        prev = {k: rec.get(k) for k in ("state", "commit", "files", "summary", "title", "tests", "tests_tail", "on_at",
                                         "base", "note")}
        rec.pop("refused", None)
        rec.pop("unshown", None)
        rec = _fresh(rec)
        rec.update(state="working", work=str(wt), base=base, prev=prev, error=None, tests=None, note=None,
                   rounds=int(rec.get("rounds") or 1) + 1, session=session or rec.get("session"))
        return put(_named_patches(_with_words(rec, [words], asked), words))


def _named_patches(rec: dict[str, Any], words: str) -> dict[str, Any]:
    """The other fixes the words name ("fold in fix 4"): each one's own change as a patch in the fixer's temp folder
    (tmp/<id>/fix-<n>.patch), which the fixer reads (patches: id, title, path)."""
    out = list(rec.get("patches") or [])
    for m in dict.fromkeys(int(x) for x in re.findall(r"\bfix\s+#?(\d+)\b", words, re.I)):
        if m == rec["id"] or any(x.get("id") == m for x in out):
            continue
        try:
            other = get(m)
        except FixError:
            continue
        ref = f"refs/thimble/fixes/{m}"
        if not git("rev-parse", "-q", "--verify", ref, cwd=live_dir(), check=False):
            continue
        patch = run(["git", "-c", "core.quotePath=false", "show", "--format=", "--no-color", "--no-ext-diff", ref],
                    cwd=live_dir(), check=False).stdout
        if not patch.strip():
            continue
        tmp_dir(rec["id"]).mkdir(parents=True, exist_ok=True)
        path = tmp_dir(rec["id"]) / f"fix-{m}.patch"
        try:
            _write_new(path, patch)
        except OSError:
            continue  # the fixer is told of no patch it cannot read
        out.append({"id": m, "title": other.get("title") or "", "path": str(path)})
    return {**rec, "patches": out} if out else rec


def _copy_of(rec: dict[str, Any]) -> tuple[Path, str]:
    """A copy cut from mine that holds the fix's change as it is now (its ref): mine holds it when it is on, else thimble
    puts it on the copy. The copy and the commit it starts from."""
    fid = rec["id"]
    wt = work_dir(fid)
    _drop_work(rec)
    if wt.exists():
        shutil.rmtree(wt)
    base = head()
    wt.parent.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-q", "--detach", str(wt), base, cwd=live_dir(), hooks=False)
    _give_types(wt)
    if rec.get("state") != "on" or not _has_ref(fid):
        g = _own_git(wt)
        if g is None:
            _drop_work({"work": str(wt)})
            raise FixError(COPY_GONE)
        p = run(["git", *THIMBLE_ID, "cherry-pick", "--keep-redundant-commits", _fix_ref(rec)], cwd=wt, check=False,
                env={**as_thimble(), **g})
        if p.returncode != 0:
            run(["git", "cherry-pick", "--abort"], cwd=wt, check=False, env={**os.environ, **g})
            _drop_work({"work": str(wt)})
            raise FixError(f"fix {fid} does not fit your thimble as it is now; /thimble-fix new <words> makes a new fix")
        base = git("rev-parse", "HEAD", cwd=wt, env={**os.environ, **g})
    tmp_dir(fid).mkdir(parents=True, exist_ok=True)
    return wt, base


def _has_ref(fid: int) -> bool:
    return bool(git("rev-parse", "-q", "--verify", f"refs/thimble/fixes/{fid}", cwd=live_dir(), check=False))


def _fix_ref(rec: dict[str, Any]) -> str:
    return f"refs/thimble/fixes/{rec['id']}" if _has_ref(rec["id"]) else str(rec["commit"])


def _numstat(repo: Path, a: str, b: str) -> list[dict[str, Any]]:
    """The files changed from a to b, each with its lines added and removed (None for a binary file). A file moved is
    two files, the one it was and the one it is, so that the checks of what a fix changes see both names."""
    out = []
    for line in git("-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", a, b, cwd=repo).splitlines():
        add, dele, path = (line.split("\t", 2) + ["", "", ""])[:3]
        out.append({"path": path, "add": None if add == "-" else int(add), "del": None if dele == "-" else int(dele)})
    return out


def protected_of(paths: list[str]) -> list[str]:
    return [p for p in paths if any(fnmatch.fnmatch(p, pat) for pat in PROTECTED)]


def _and(words: list[str]) -> str:
    return " and ".join(words) if len(words) < 3 else ", ".join(words[:-1]) + ", and " + words[-1]


def _kinds(paths: list[str], kinds: dict[str, tuple[str, ...]]) -> dict[str, list[str]]:
    """The paths that are one of `kinds`, by the first kind each one is, in the order of `kinds`."""
    out: dict[str, list[str]] = {}
    for p in paths:
        kind = next((k for k, pats in kinds.items() if any(fnmatch.fnmatch(p, pat) for pat in pats)), None)
        if kind:
            out.setdefault(kind, []).append(p)
    return {k: out[k] for k in kinds if k in out}


def protected_why(paths: list[str]) -> str:
    """The refusal for a fix that changes protected files: each file, with what it is, and why thimble refuses."""
    named = [f"{_and(ps)} ({kind})" for kind, ps in _kinds(paths, PROTECTED_KINDS).items()]
    return (f"it changes {_and(named)}; no fix may change the code that turns fixes off and undoes them, or the scan a "
            "shared fix goes through")


def notice_of(paths: list[str]) -> dict[str, list[str]]:
    """The files of a fix that the person is told of before they use it, by what each one is (NOTICE_KINDS)."""
    return _kinds(paths, NOTICE_KINDS)


def notice_said(rec: dict[str, Any]) -> str:
    """The sentence that tells the person what such files a fix changes: `This fix changes the sandbox
    (plugin/cards/argv.mjs).`, or ''. fix/fixes.ts noticeText says the same."""
    kinds = rec.get("notice") or {}
    return f"This fix changes {_and([f'{k} ({_and(ps)})' for k, ps in kinds.items()])}." if kinds else ""


def _is_checkout(work: str | None) -> bool:
    """Whether a fix's copy is there and is still a git checkout of its own (a worktree of live, _own_git). A record
    without a copy has work None, which must never read as the kernel's own folder."""
    return _own_git(work) is not None


# a fix whose copy git may not run in (_own_git): the copy is gone, or something in it changed its git link
COPY_GONE = ("its copy of thimble was gone or no longer a git checkout, so thimble could not check it; y starts it again "
             "in a new copy")


def _own_git(work: str | Path | None) -> dict[str, str] | None:
    """What runs git in a worktree of live (a fix's copy, the release checkout, a merge's) on that worktree's own entry
    in live's repository, as live's records have it, for git's environment: GIT_DIR=<live's git folder>/worktrees/<entry>
    and GIT_WORK_TREE=<the worktree>. The fixer's sandbox writes its copy, the copy's .git too, which could point git at
    another repository (the person's clone, whose branch git would move) or at a git folder of the fixer's, whose
    settings run commands outside the sandbox; so git never reads it. None, and then no git may run in the folder, when
    it is gone or its .git is not a file that names the entry whose own record names it back."""
    if not work:
        return None
    import stat  # noqa: PLC0415

    wt = Path(work)
    try:
        # never through a link, and never waiting on a pipe left under the name
        fd = os.open(wt / ".git", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        link = os.read(fd, 4096).decode(errors="replace").strip() if stat.S_ISREG(os.fstat(fd).st_mode) else ""
    finally:
        os.close(fd)
    common = git("rev-parse", "--git-common-dir", cwd=live_dir(), check=False) if live_dir().is_dir() else ""
    if not link.startswith("gitdir:") or not common:
        return None
    entry = Path(os.path.realpath(os.path.join(wt, link[len("gitdir:"):].strip())))
    if entry.parent != (live_dir() / common).resolve() / "worktrees":
        return None
    try:
        back = (entry / "gitdir").read_text().strip()
    except OSError:
        return None
    if not back or os.path.realpath(os.path.join(entry, back)) != os.path.realpath(wt / ".git"):
        return None
    return {"GIT_DIR": str(entry), "GIT_WORK_TREE": str(wt)}


def _nested_git(work: str | Path) -> bool:
    """Whether the copy holds a git repository of its own below its top (sub/.git, a folder, a file or a link): git that
    reads the copy's files (add, status, diff) runs git in such a repository, outside the sandbox, with its settings
    (core.fsmonitor), so no git may read them (COPY_GONE). Each folder is also asked for .git as git asks, which a file
    system that ignores case answers for .GIT too. The walk follows no link, and a folder it cannot read counts."""
    top = os.fspath(work)
    stuck: list[OSError] = []
    for d, dirs, files in os.walk(top, onerror=stuck.append):
        if d == top:
            # the copy's own .git, its link to live's repository (_own_git)
            dirs[:] = [n for n in dirs if n != ".git"]
            files = [n for n in files if n != ".git"]
        if ".git" in dirs or ".git" in files:
            return True
        for n in dirs:
            sub = os.path.join(d, n)
            if not os.path.islink(sub) and os.path.lexists(os.path.join(sub, ".git")):
                return True
    return bool(stuck)


def _gitlinks(wt: Path, env: dict[str, str], base: str) -> list[str]:
    """The paths the copy's index has as a gitlink (mode 160000, a commit of another repository, which git add records
    for a repository inside the copy) that `base` does not have as it is. git reads the index and base's tree only."""
    index = run(["git", "ls-files", "-s", "-z"], cwd=wt, env=env).stdout.split("\0")
    tree = run(["git", "ls-tree", "-r", "-z", base], cwd=wt, env=env).stdout.split("\0")
    had = {(x.split()[2], x.partition("\t")[2]) for x in tree if x.startswith("160000 ")}
    now = {(x.split()[1], x.partition("\t")[2]) for x in index if x.startswith("160000 ")}
    return sorted(p for _, p in now - had)


def done(fid: int | str, title: str | None = None, summary: str = "", request: bool = False,
         tests: bool = True, session: str | None = None, cannot: str | None = None,
         within: float | None = None) -> dict[str, Any]:
    """The fixer ended: thimble commits its change in the copy, checks what it changed, and runs the checks of the parts
    of thimble it changed in the sandbox (_checks, as carry runs them for the fixes an update set aside). ready, failed
    (with the reason), or a request with no code. A round of a fix changed in place (prev):
    a ready change becomes the fix's new version, the fix's change and the round's in one commit (settle), which waits
    for the person's y while the version before stays as it was; a round that changed nothing leaves the fix as it was.
    `session`: the session that asks; a fix whose fixer works in another session is that session's to check.
    `cannot`: the fixer ended saying why the request cannot be met: the fix fails with its words, its copy kept for r.
    The tests run in a process of their own (_start_tests), and done waits for what came of them; with `within`, at
    most that many seconds, and then it gives the fix as it is: still working, with `testing`. A done of a fix whose
    tests run starts nothing: it waits for them in the same way, and one with `within` that comes after they ended gives
    what came of them; such a done may come from any session (/clear and /resume give the session a new id while it
    waits). Two checks at once take the fix's guard (_guard) in turn, before either commits in the copy: the second
    then starts nothing and waits as well."""
    deadline = None if within is None else time.monotonic() + max(within, 0.0)
    rec = get(fid)
    if (rec.get("state") == "working" and rec.get("testing")) or (within is not None and rec.get("state") != "working"):
        return _wait(rec["id"], deadline)
    if session and rec.get("session") and rec["session"] != session:
        raise FixError(f"fix {rec['id']} is being made in another Claude Code session, which checks it when its fixer ends")
    if rec.get("state") != "working":
        raise FixError(f"fix {rec['id']} was checked already ({state_word(rec)}), so there is nothing to check")
    if cannot is not None and cannot.strip():
        # a fixer that cannot do without the files no fix may change: another try cannot do it either (blocked)
        blocked = protected_of((rec.pop("refused", None) or {}).get("files") or [])
        rec.update(state="failed", tests=None, error=short(" ".join(cannot.split()), 300),
                   **({"blocked": blocked} if blocked else {}))
        return put(rec)
    # the tests' command before the guard: making it may install the sandbox runtime, which takes minutes
    try:
        argv: list[str] | FixError = _tests_argv(rec["id"]) if tests else []
    except FixError as e:
        argv = e
    guard = _guard(rec["id"], deadline)
    try:
        checked = None if guard is None else _done(fid, title, summary, request, tests, argv, rec)
    finally:
        if guard is not None:
            os.close(guard)
    # None: another check of the fix started its tests first or wrote what came of it, a new round took the copy, or the
    # guard was not free by the deadline
    if checked is None or checked.get("testing"):
        return _wait(rec["id"], deadline)
    rec = checked
    if rec.get("prev") and rec.get("state") == "request":
        return {**_restore(rec), "unchanged": True}
    if rec.get("prev") and rec.get("state") == "ready":
        return settle(rec)
    return rec


def settle(rec: dict[str, Any], mark: dict[str, Any] | None = None) -> dict[str, Any]:
    """A ready round of a fix changed in place: its new version is the fix's change as it is now (its ref) plus the
    round's change, as one commit on the commit the fix's change sits on, kept under refs/thimble/next/<id> until the
    person's y. A round's change that does not apply to the fix fails, for r, as does a copy git may not run in
    (_own_git, _nested_git), which the tests' time gave the fixer's sandbox to change. `mark`: the run of the tests
    whose runner settles it (tests_runner); a record that no longer waits for that run (a new round took the copy, the
    fix was removed) stays as it is, and its copy too."""
    wt = Path(rec["work"])
    with Lock():
        if mark is not None and not _waits_for(rec["id"], mark):
            return get(rec["id"])
        g = _own_git(wt)
        if g is None or _nested_git(wt):
            _drop_work(rec)
            return put({**rec, "state": "failed", "error": COPY_GONE})
        env, me = {**os.environ, **g}, {**as_thimble(), **g}
        old = git("rev-parse", _fix_ref(rec), cwd=wt, env=env)
        parent = git("rev-parse", f"{old}^", cwd=wt, env=env)
        mine = rec["commit"]
        git("checkout", "-q", "--detach", old, cwd=wt, env=env, hooks=False)
        p = run(["git", *THIMBLE_ID, "cherry-pick", "--no-commit", mine], cwd=wt, check=False, env=me)
        if p.returncode != 0:
            run(["git", "cherry-pick", "--abort"], cwd=wt, check=False, env=env)
            run(["git", "reset", "-q", "--hard"], cwd=wt, check=False, env=env)
            git("checkout", "-q", "--detach", mine, cwd=wt, env=env, hooks=False)
            why = f"its change does not fit fix {rec['id']} as it is now"
            return put({**rec, "state": "failed", "error": why})
        tree = git("write-tree", cwd=wt, env=env)
        run(["git", "reset", "-q", "--hard"], cwd=wt, check=False, env=env)
        git("checkout", "-q", "--detach", mine, cwd=wt, env=env, hooks=False)
        commit = git(*THIMBLE_ID, "commit-tree", tree, "-p", parent, "-m",
                     f"{rec['title']}\n\n{rec.get('summary') or ''}\n\nthimble fix {rec['id']}".strip(), cwd=wt,
                     env=me)
        git("update-ref", f"refs/thimble/next/{rec['id']}", commit, cwd=wt, env=env)
        return put({**rec, "commit": commit, "round_commit": mine, "files": _numstat(live_dir(), parent, commit)})


def _restore(rec: dict[str, Any]) -> dict[str, Any]:
    """A fix changed in place goes back to its version before the round (prev); the person's words stay with it."""
    p = rec.get("prev") or {}
    _drop_work(rec)
    run(["git", "update-ref", "-d", f"refs/thimble/next/{rec['id']}"], cwd=live_dir(), check=False)
    for k in ("refused", "prev", "round_commit"):
        rec.pop(k, None)
    rec.update({k: v for k, v in p.items() if k != "note"}, note=p.get("note"), error=None)
    return put(rec)


def _take_out(fid: int, why: str) -> dict[str, Any]:
    """mine again without fix `fid`; the fixes that no longer apply without it need a redo."""
    recs = records()
    failed = _rebuild([i for i in _on_ids(recs) if i != fid])
    for i in failed:
        x = recs[i]
        x.update(state="redo", error=why)
        put(x)
    if is_on():
        git("checkout", "-q", "mine", cwd=live_dir(), hooks=False)
    else:
        git("checkout", "-q", "--detach", release()["base"], cwd=live_dir(), hooks=False)
    return {"redo": failed}


def _done(fid: int | str, title: str | None, summary: str, request: bool, tests: bool,
          argv: list[str] | FixError, seen: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """done's check, under the fix's guard: `argv` is the tests' command (or why there is none). A record that is no
    longer the one done read (`seen`) is not checked here: None."""
    rec = get(fid)
    read = dict(rec)
    if seen is not None and rec != seen:
        return None
    g = _own_git(rec.get("work"))
    if g is None or _nested_git(rec["work"]):
        # the copy is gone, something in it removed or changed its git link, or it holds a repository of its own
        # (_nested_git): nothing of it can be checked, and no git runs in it. r makes a new copy
        return _copy_gone(rec)
    wt = Path(rec["work"])
    env = {**os.environ, **g}
    rec.pop("refused", None)
    rec.pop("blocked", None)
    # the fixer's title names the fix once thimble uses its change, so a refused try leaves the name the person saw; a
    # fix changed in place keeps its name
    named = short(title, 60) if title and title.strip() and not rec.get("prev") else None
    rec["summary"] = (summary or "").strip()[:2000]
    git("add", "-A", cwd=wt, env=env)
    if _gitlinks(wt, env, rec["base"]):
        # a repository made in the copy after the walk, which git add recorded: no gitlink goes into a fix's commit,
        # and no more git runs in the copy
        return _copy_gone(rec)
    changed = run(["git", "diff", "--cached", "--quiet", rec["base"]], cwd=wt, check=False, env=env).returncode != 0
    if request or not changed:
        git("reset", "-q", "--hard", rec["base"], cwd=wt, env=env)
        rec.update(state="request", files=[], commit=None, tests=None, **({"title": named} if named else {}))
        _drop_work(rec)
        return put(rec)
    # the fix is one commit on the commit its copy was cut from, whatever the copy's own history holds
    tree = git("write-tree", cwd=wt, env=env)
    commit = git(*THIMBLE_ID, "commit-tree", tree, "-p", rec["base"], "-m",
                 f"{named or rec['title']}\n\n{rec['summary']}\n\nthimble fix {rec['id']}".strip(), cwd=wt,
                 env={**as_thimble(), **g})
    git("reset", "-q", "--hard", commit, cwd=wt, env=env)
    # a round of a fix changed in place: its ref keeps the version the person has until their y
    git("update-ref", f"refs/thimble/{'next' if rec.get('prev') else 'fixes'}/{rec['id']}", commit, cwd=wt, env=env)
    files = _numstat(live_dir(), rec["base"], commit)
    rec.update(commit=commit, files=files)
    bad = protected_of([f["path"] for f in files])
    binary = [f["path"] for f in files if f["add"] is None]
    if bad:
        rec.update(state="failed", tests=None, error=protected_why(bad), refused={"why": protected_why(bad), "files": bad})
        return put(rec)
    if binary:
        why = f"it adds or changes a binary file ({binary[0]}); a fix changes text only"
        rec.update(state="failed", tests=None, error=why, refused={"why": why, "files": binary})
        return put(rec)
    if not tests:
        rec.update(tests="skipped", state="ready", error=None, **({"title": named} if named else {}))
        return put(rec)
    if isinstance(argv, FixError):
        return put(_tested(rec, False, str(argv), named))
    # the checks of what the change touched, as carry checks the fixes it puts back
    try:
        argv = _checks_argv(rec["id"], [f["path"] for f in files], rec["base"])
    except (FixError, OSError) as e:
        return put(_tested(rec, False, str(e), named))
    return _start_tests(rec, named, argv, read)


def _copy_gone(rec: dict[str, Any]) -> dict[str, Any]:
    """done's check of a copy git may not run in: its copy goes, and the fix fails, for r."""
    _drop_work(rec)
    rec.update(state="failed", commit=None, files=[], tests=None, error=COPY_GONE)
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


def _is_on(r: dict[str, Any]) -> bool:
    """A fix whose change is in mine: on, or on under a round that changes it in place."""
    return r.get("state") == "on" or (r.get("prev") or {}).get("state") == "on"


def _on_ids(recs: dict[int, dict[str, Any]]) -> list[int]:
    return [r["id"] for r in sorted((r for r in recs.values() if _is_on(r)), key=lambda r: r.get("on_at") or 0)]


def _rebuild(order: list[int]) -> list[int]:
    """mine again: the release commit plus each fix of `order` that still applies, in that order. The fixes that do
    not apply any more, which then need a redo."""
    rel, live = release(), live_dir()
    _unstamp()
    git("checkout", "-q", "-B", "mine", rel["base"], cwd=live, hooks=False)
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


def _move(change, copied: bool = False) -> dict[str, Any]:
    """Change live (a function of the records), then have Claude Code copy it; `copied`: the change had it copy live
    itself (a y, before its records say so). Before Claude Code loads live (not pointed yet), the release first follows
    the code that runs (ensure_live), as at a request: a y right after another way updated the plugin (claude plugin
    update, scripts/install.sh) puts the fix onto that release, not the one before."""
    with Lock():
        rel = release()
        if rel and not rel.get("pointed") and (live_dir() / ".git").exists():
            ensure_live()
        out = change()
        synced = {} if copied else _sync()
    return {**(out or {}), **synced}


def _refs_at(names: list[str]) -> dict[str, str]:
    """The commit each of the refs `names` points to, for those that exist."""
    out = git("for-each-ref", "--format=%(refname) %(objectname)", *names, cwd=live_dir())
    return {n: sha for n, _, sha in (x.partition(" ") for x in out.splitlines()) if n in names}


def _live_as_is(fid: int) -> dict[str, Any]:
    """What a y on fix `fid` changes once live moves, for _put_back: the branch or commit live shows, state.json (None
    when there is none), and the refs it moves: mine, the ref of each fix in mine (a rebuild makes their commits anew),
    and the fix's own (its version before, under prev/, and a new one, under next/)."""
    live = live_dir()
    state = home() / "state.json"
    names = ["refs/heads/mine", *(f"refs/thimble/fixes/{i}" for i in sorted({*_on_ids(records()), fid})),
             f"refs/thimble/prev/{fid}", f"refs/thimble/next/{fid}"]
    return {"branch": run(["git", "symbolic-ref", "-q", "--short", "HEAD"], cwd=live, check=False).stdout.strip(),
            "head": git("rev-parse", "HEAD", cwd=live), "names": names, "refs": _refs_at(names),
            "state": state.read_text() if state.exists() else None}


def _put_back(was: dict[str, Any]) -> None:
    """live, the refs a y moves and state.json as they were before a y that failed (_live_as_is): fixes that were all
    off stay off, mine and the fixes' refs hold what they held, and live shows what it showed, its plugin.json with the
    version it had (_stamp)."""
    live = live_dir()
    # a pick that the failure stopped half way
    run(["git", "cherry-pick", "--abort"], cwd=live, check=False)
    _unstamp()
    # off mine first, so that mine moves back without its files
    git("checkout", "-q", "--detach", cwd=live, hooks=False)
    now = _refs_at(was["names"])
    moves = [f"update {n} {was['refs'][n]}" for n in was["names"] if n in was["refs"] and now.get(n) != was["refs"][n]]
    moves += [f"delete {n}" for n in was["names"] if n not in was["refs"] and n in now]
    if moves:
        run(["git", "update-ref", "--stdin"], cwd=live, stdin="\n".join(moves) + "\n")
    git("checkout", "-q", *([was["branch"]] if was["branch"] else ["--detach", was["head"]]), cwd=live, hooks=False)
    state = home() / "state.json"
    if was["state"] is None:
        state.unlink(missing_ok=True)
    else:
        tmp = state.with_suffix(".json.tmp")
        tmp.write_text(was["state"])
        tmp.replace(state)
    _stamp()


@contextlib.contextmanager
def _or_put_back(fid: int):
    """The steps of a y on fix `fid` from the move of live on, up to Claude Code's copy of it: when any of them fails (a
    fix that does not fit, a git error, a copy that fails), live, the refs it moves and state.json go back as they were
    (_put_back), and the same error goes on. The records change after these steps, except for why a fix needs a redo or
    why its new version does not fit."""
    was = _live_as_is(fid)
    try:
        yield
    except BaseException:
        _put_back(was)
        raise


def _misfit(fid: int, commit: str) -> str:
    """What fix `fid`'s change (`commit`) does not fit, in its error. When the change was made on its files as the
    release has them, only the fixes in mine can be in its way: the one fix in mine that changes such a file, else the
    person's other fixes. Else the release (thimble 0.10.6), when it changed such a file since the release the change was
    made on, with "and your other fixes" when a fix in mine changes such a file too; else the person's other fixes.

    The release the change was made on is the newest commit under the change that the release's history holds too (git
    merge-base), so that the lines of the fixes it was made on are not the release's. It comes from the commit the
    change sits on, which a y picks: the record's base stays mine as it was when the fix was made, also after thimble
    update --continue or a dev install's update put the change on a newer release. A live whose history does not join
    the two (a shallow clone) compares that commit itself."""
    live, base = live_dir(), str(release().get("base") or "")

    def files(a: str, b: str, paths: list[str]) -> list[str]:
        out = git("--literal-pathspecs", "diff", "--no-renames", "--name-only", "-z", a, b, "--", *paths, cwd=live,
                  check=False)
        return [x for x in out.split("\0") if x]

    def same(a: str, b: str, paths: list[str]) -> bool:
        return run(["git", "--literal-pathspecs", "diff", "--quiet", a, b, "--", *paths], cwd=live,
                   check=False).returncode == 0

    paths = files(f"{commit}^", commit, [])
    if not (base and paths):
        return "your other fixes"
    hits = [i for i in _on_ids(records())
            if i != fid and files(f"refs/thimble/fixes/{i}^", f"refs/thimble/fixes/{i}", paths)]
    if same(base, f"{commit}^", paths):
        # made on these files as the release has them: only the fixes in mine can be in its way
        return f"fix {hits[0]}" if len(hits) == 1 else "your other fixes"
    made_on = git("merge-base", f"{commit}^", base, cwd=live, check=False) or f"{commit}^"
    if not same(made_on, base, paths):
        name = f"thimble {release_name()}"
        return f"{name} and your other fixes" if hits else name
    return "your other fixes"


def _aside_why(rec: dict[str, Any]) -> str:
    """Why a fix an update set aside is off, and what brings it back, in one line, as thimble fixes and thimble fix show
    say it: it does not fit the release (its error), or it waits for its check on the release (carry)."""
    if rec.get("error"):
        return f"fix {rec['id']} is off: {rec['error']}; thimble reapply, in a shell, has Claude fit it"
    return (f"fix {rec['id']} waits for its check on thimble {release_name()}: thimble fixes, in a shell, puts it back if "
            "it fits")


def apply(fid: int | str, secret: str | None) -> dict[str, Any]:
    """y: the fix goes on. thimble points the marketplace at live the first time (before anything else, so that a y
    whose pointing fails changes nothing), cherry-picks the fix's commit onto mine unless mine holds it already, and has
    Claude Code copy live; the plugin then runs /reload-plugins. A y that fails after live moved, such as one whose fix
    does not fit the others, leaves live and state.json as they were (_or_put_back), so a y while every fix is off turns
    none of them on."""
    rec = get(fid)
    check_ask(rec["id"], secret)
    if rec.get("state") not in ("ready", "off", "redo", "pending") or not rec.get("commit"):
        raise FixError(f"fix {rec['id']} is {rec.get('state')}, so there is nothing to apply")
    if rec.get("state") == "redo":
        raise FixError(f"fix {rec['id']} does not fit your thimble any more; /thimble-fix {rec['id']} tries it again")
    if rec.get("state") == "pending":
        raise FixError(_aside_why(rec))

    if rec.get("prev"):
        return _move(lambda: _swap(rec["id"]), copied=True)

    def change():
        live = live_dir()
        # Claude Code's marketplace on live first: when that fails, mine, the fix's ref and its record stay as they were
        _repoint()
        with _or_put_back(rec["id"]):
            _unstamp()
            # a fix the person turns on while all are off: the others come back with it
            git("checkout", "-q", "mine", cwd=live, hooks=False)
            write_json(home() / "state.json", {"on": True})
            ref = f"refs/thimble/fixes/{rec['id']}"
            if run(["git", "merge-base", "--is-ancestor", ref, "mine"], cwd=live, check=False).returncode == 0:
                # mine holds the fix's commit already: it goes on as it is, with no empty commit after it
                new_commit = git("rev-parse", ref, cwd=live)
            else:
                p = run(["git", *THIMBLE_ID, "cherry-pick", "--keep-redundant-commits", ref], cwd=live, check=False,
                        env=as_thimble())
                if p.returncode != 0:
                    run(["git", "cherry-pick", "--abort"], cwd=live, check=False)
                    whom = _misfit(rec["id"], ref)
                    r = get(rec["id"])
                    r.update(state="redo", error=f"it does not fit {whom}")
                    put(r)
                    raise FixError(f"fix {rec['id']} does not fit {whom}; /thimble-fix {rec['id']} tries it again")
                new_commit = git("rev-parse", "HEAD", cwd=live)
                git("update-ref", ref, new_commit, cwd=live)
            synced = _sync()
        r = get(rec["id"])
        r.update(state="on", on_at=time.time(), commit=new_commit, error=None)
        _drop_work(r)
        put(r)
        return {"id": r["id"], "title": r["title"], "commit": new_commit, **synced}

    return _move(change, copied=True)


def _swap(fid: int) -> dict[str, Any]:
    """y on a fix changed in place: its new version takes the place of the one before, which stays under
    refs/thimble/prev/<id> for u. A fix that was on is rebuilt in its place in mine; one that was off goes on last. A y
    that fails after live moved, such as one whose new version does not fit the other fixes, leaves live, mine, the
    fixes' refs and state.json as they were (_or_put_back). A new version that does not fit still waits, and its record
    says why (error), so that /thimble-fix N, as the error says, tries it again."""
    live = live_dir()
    rec = get(fid)
    p = rec.get("prev") or {}
    old = git("rev-parse", "-q", "--verify", f"refs/thimble/fixes/{fid}", cwd=live, check=False) or str(p.get("commit") or "")
    # Claude Code's marketplace on live first: when that fails, mine, the fix's refs and its record stay as they were
    _repoint()
    with _or_put_back(fid):
        _unstamp()
        git("checkout", "-q", "mine", cwd=live, hooks=False)
        write_json(home() / "state.json", {"on": True})
        git("update-ref", f"refs/thimble/fixes/{fid}", rec["commit"], cwd=live)
        order = _on_ids(records())
        if fid not in order:
            order.append(fid)
        failed = _rebuild(order)
        if fid in failed and order[-1] != fid:
            # a new version that needs fixes after it in mine underneath it (a stray folded in): last
            order = [*[i for i in order if i != fid], fid]
            failed = _rebuild(order)
        if fid in failed:
            whom = _misfit(fid, rec["commit"])
            r = get(fid)
            r.update(error=f"its new version does not fit {whom}")
            put(r)
            raise FixError(f"the new version of fix {fid} does not fit {whom}; /thimble-fix {fid} tries it again")
        if old:
            git("update-ref", f"refs/thimble/prev/{fid}", old, cwd=live)
        git("update-ref", "-d", f"refs/thimble/next/{fid}", cwd=live)
        new_commit = git("rev-parse", f"refs/thimble/fixes/{fid}", cwd=live)
        synced = _sync()
    for i in failed:
        x = get(i)
        x.update(state="redo", error=f"it did not fit once fix {fid} changed")
        put(x)
    r = get(fid)
    r.pop("round_commit", None)
    r.update(state="on", on_at=p.get("on_at") if p.get("state") == "on" else time.time(), commit=new_commit, error=None,
             note=None, prev={**p, "commit": old})
    _drop_work(r)
    put(r)
    return {"id": fid, "title": r["title"], "commit": new_commit, "changed": True, "redo": failed, **synced}


def merge(ids: list[int | str], secret: str | None) -> dict[str, Any]:
    """The person's key (thimble fix merge A B C in a shell): a manual fallback, since follow-ups are rounds of their
    fix and strays from before fold in by themselves (fold_strays). The fixes become one, under the first one's id, by
    git alone (_merge). Whatever stops it changes nothing, and the error names the /thimble-fix that has Claude do it."""
    recs = [get(i) for i in ids]
    check_ask(recs[0]["id"], secret)
    try:
        return _merge(recs)
    except FixError as e:
        others = [r["id"] for r in recs[1:]]
        ask = f"/thimble-fix {recs[0]['id']} fold in {_and([f'fix {i}' for i in others])}" if others else "/thimble-fix"
        raise FixError(f"{str(e).rstrip('.')}; nothing was merged. In Claude Code, {ask} asks Claude to do it") from e


class Conflict(FixError):
    """Two fixes change the same lines in different ways: only Claude can join them (/thimble-fix N fold in fix M)."""

    def __init__(self, into: int, other: int):
        self.into, self.other = into, other
        super().__init__(f"fix {other} and fix {into} change the same lines in different ways, so git cannot join them")


def _merged_tree(code: list[dict[str, Any]], merged_ids: set[int], first: int) -> dict[str, Any]:
    """One tree with each fix's own change, in the order they sit in mine (git's three-way pick, from each fix's own
    parent, so that what a fix was built on and the merge leaves out stays out), placed after the fixes of mine that
    are not merged: the fewest first (the place of the first merged fix that is on), later only when a merged fix needs
    one of them underneath it. Fixes on in none of them sit on the commit the first was made on, else on mine.
    {place, parent, tree, rest, code}, or Conflict."""
    live = live_dir()
    refs = {r["id"]: git("rev-parse", f"refs/thimble/fixes/{r['id']}", cwd=live) for r in code}
    mine_order = _replay_order(records())
    at = {fid: i for i, fid in enumerate(mine_order)}
    given = [x["id"] for x in code]
    code = sorted(code, key=lambda r: (at.get(r["id"], len(at)), given.index(r["id"])))
    rest = [i for i in mine_order if i not in merged_ids]
    on_named = [i for i in mine_order if i in merged_ids]
    wt = tmp_dir(first) / "merge"
    # the fixer's sandbox writes tmp/<id>/: a link left under the name goes, so that git never removes or fills the
    # folder it leads to
    _no_link(wt)
    run(["git", "worktree", "remove", "--force", str(wt)], cwd=live, check=False)
    shutil.rmtree(wt, ignore_errors=True)
    git("worktree", "add", "-q", "--detach", str(wt), release()["base"], cwd=live, hooks=False)
    try:
        # the folder is in the fixer's temp folder, which its sandbox writes: git runs on the worktree's own entry
        g = _own_git(wt)
        if g is None:
            raise FixError(COPY_GONE)
        env, me = {**os.environ, **g}, {**as_thimble(), **g}
        prefix = [release()["base"]]
        for i in rest:
            p = run(["git", *THIMBLE_ID, "cherry-pick", "--keep-redundant-commits", f"refs/thimble/fixes/{i}"],
                    cwd=wt, check=False, env=me)
            if p.returncode != 0:
                run(["git", "cherry-pick", "--abort"], cwd=wt, check=False, env=env)
                break
            prefix.append(git("rev-parse", "HEAD", cwd=wt, env=env))
        if on_named:
            start = len([i for i in mine_order[:mine_order.index(on_named[0])] if i not in merged_ids])
            tries = [(k, prefix[k]) for k in range(start, len(prefix))]
        else:
            tries = [(len(rest), git("rev-parse", f"{refs[code[0]['id']]}^", cwd=live)), (len(rest), prefix[-1])]
        stuck = code[-1]["id"]
        for place, base in tries:
            git("checkout", "-q", "--detach", base, cwd=wt, env=env, hooks=False)
            for r in code:
                p = run(["git", *THIMBLE_ID, "cherry-pick", "--no-commit", "--allow-empty", refs[r["id"]]], cwd=wt,
                        check=False, env=me)
                if p.returncode != 0:
                    stuck = r["id"]
                    run(["git", "cherry-pick", "--abort"], cwd=wt, check=False, env=env)
                    run(["git", "reset", "-q", "--hard"], cwd=wt, check=False, env=env)
                    break
            else:
                tree = git("write-tree", cwd=wt, env=env)
                run(["git", "reset", "-q", "--hard"], cwd=wt, check=False, env=env)
                return {"place": place, "parent": base, "tree": tree, "rest": rest, "code": code, "refs": refs}
        other = first if stuck != first else next(r["id"] for r in code if r["id"] != stuck)
        raise Conflict(first, stuck if stuck != first else other)
    finally:
        _no_link(wt)
        run(["git", "worktree", "remove", "--force", str(wt)], cwd=live, check=False)
        run(["git", "worktree", "prune"], cwd=live, check=False)


def _merge(recs: list[dict[str, Any]]) -> dict[str, Any]:
    """The fixes become one, under the first one's id: one commit (_merged_tree); the first fix's title, every fix's
    summary and words. A request with no code gives its words only. The others' records
    say merged; their refs stay, and each merged commit is kept under refs/thimble/merged/<id>/, for an undo by hand.
    A merged fix that was on is on in mine, after the fixes it needs underneath it."""
    first = recs[0]
    if len({r["id"] for r in recs}) != len(recs) or len(recs) < 2:
        raise FixError("name two fixes or more, each once: thimble fix merge 1 3 4")
    for r in recs:
        if r.get("state") not in (*REFINABLE, "request"):
            raise FixError(f"fix {r['id']} is {state_word(r)}; only fixes that are on, off or ready, and requests, merge")
    code = [r for r in recs if r.get("state") != "request" and r.get("commit")]
    if not code:
        raise FixError("none of these fixes changes code; a request merges into a fix that does")
    merged_ids = {r["id"] for r in recs}

    def change():
        live = live_dir()
        m = _merged_tree(code, merged_ids, first["id"])
        place, parent, tree, rest = m["place"], m["parent"], m["tree"], m["rest"]
        name = first["title"]
        text = " ".join(str(r.get("summary") or "").strip() for r in recs).strip()
        commit = git(*THIMBLE_ID, "commit-tree", tree, "-p", parent, "-m",
                     f"{name}\n\n{text}\n\nthimble fix {first['id']}".strip(), cwd=live, env=as_thimble())
        for i, old in m["refs"].items():
            git("update-ref", f"refs/thimble/merged/{first['id']}/{i}", old, cwd=live)
        git("update-ref", f"refs/thimble/fixes/{first['id']}", commit, cwd=live)
        all_recs = records()
        was_on = [i for i in _on_ids(all_recs) if i in merged_ids]
        for r in recs[1:]:
            x = get(r["id"])
            _drop_work(x)
            x.update(state="merged", merged_into=first["id"])
            put(x)
        f = get(first["id"])
        _drop_work(f)
        f.pop("asked", None)
        f.update(title=name, summary=text, commit=commit, base=parent, files=_numstat(live, parent, commit),
                 words=[w for r in recs for w in (r.get("words") or [])], error=None, note=None,
                 rounds=sum(int(r.get("rounds") or 1) for r in recs), merged=[r["id"] for r in recs[1:]],
                 tests=next((r.get("tests") for r in code), None),
                 state="on" if was_on else "ready" if first.get("state") in ("ready", "request") else first.get("state"),
                 **_asked_field(recs))
        if was_on:
            f["on_at"] = min(float(all_recs[i].get("on_at") or 0) for i in was_on)
        put(f)
        failed: list[int] = []
        if was_on:
            # mine again: the merged fix after the fixes it needs underneath it, the others gone
            failed = _rebuild([*rest[:place], first["id"], *rest[place:]])
            for i in failed:
                x = get(i)
                x.update(state="redo", error=f"it did not fit once fixes {_and([str(r['id']) for r in recs])} merged")
                put(x)
            if is_on():
                git("checkout", "-q", "mine", cwd=live, hooks=False)
            else:
                git("checkout", "-q", "--detach", release()["base"], cwd=live, hooks=False)
        return {"id": first["id"], "title": name, "merged": [r["id"] for r in recs[1:]], "redo": failed}

    return _move(change)


def fold_strays() -> list[dict[str, Any]]:
    """Follow-ups made as fixes of their own before rounds changed a fix in place (records with `refines`, on, off or
    ready) fold into the fix they refine, by themselves, with git's three-way picks (_merged_tree). A stray that is on
    with its fix on merges as it stands (mine keeps the same change). Any other stray becomes a new version of its fix
    that waits for the person's y, the version they have staying until then (prev), as after a round. One whose lines
    conflict with the fix stays, marked (fold_conflict), for /thimble-fix N fold in fix M. What happened, one entry a
    stray."""
    out: list[dict[str, Any]] = []
    for stray in sorted(records().values(), key=lambda r: r["id"]):
        if stray.get("refines") is None or stray.get("fold_conflict") or stray.get("state") not in REFINABLE \
                or not stray.get("commit"):
            continue
        try:
            tgt = get(stray["refines"])
        except FixError:
            continue
        if tgt["id"] == stray["id"] or tgt.get("state") not in REFINABLE or not tgt.get("commit") or tgt.get("prev"):
            continue
        both_on = tgt.get("state") == "on" and stray.get("state") == "on"
        if stray.get("state") == "on" and not both_on:
            continue  # its fix is off: folding would turn the fix on without the person's key
        try:
            if both_on or tgt.get("state") != "on":
                _merge([tgt, stray])
                out.append({"id": stray["id"], "into": tgt["id"], "folded": True})
            else:
                with Lock():
                    _pending_fold(tgt, stray)
                out.append({"id": stray["id"], "into": tgt["id"], "folded": True, "waits": True})
        except Conflict:
            put({**get(stray["id"]), "fold_conflict": tgt["id"]})
            out.append({"id": stray["id"], "into": tgt["id"], "conflict": True})
    return out


def _pending_fold(tgt: dict[str, Any], stray: dict[str, Any]) -> None:
    """A stray that is not on joins a fix that is on as the fix's new version, for the person's y (apply swaps it in)."""
    live = live_dir()
    m = _merged_tree([tgt, stray], {tgt["id"], stray["id"]}, tgt["id"])
    summary = " ".join(x for x in (str(tgt.get("summary") or "").strip(), str(stray.get("summary") or "").strip()) if x)
    commit = git(*THIMBLE_ID, "commit-tree", m["tree"], "-p", m["parent"], "-m",
                 f"{tgt['title']}\n\n{summary}\n\nthimble fix {tgt['id']}".strip(), cwd=live, env=as_thimble())
    git("update-ref", f"refs/thimble/next/{tgt['id']}", commit, cwd=live)
    git("update-ref", f"refs/thimble/merged/{tgt['id']}/{stray['id']}", m["refs"][stray["id"]], cwd=live)
    x = get(stray["id"])
    _drop_work(x)
    x.update(state="merged", merged_into=tgt["id"])
    put(x)
    t = get(tgt["id"])
    prev = {k: t.get(k) for k in ("state", "commit", "files", "summary", "title", "tests", "tests_tail", "on_at", "base",
                                   "note")}
    asked = _asked_field([t, stray])
    t.pop("asked", None)
    t.update(prev=prev, state="ready", commit=commit, files=_numstat(live, m["parent"], commit), summary=summary,
             words=[*(t.get("words") or []), *(stray.get("words") or [])], tests=stray.get("tests"),
             rounds=int(t.get("rounds") or 1) + int(stray.get("rounds") or 1), merged=[stray["id"]], error=None, **asked)
    put(t)


def merge_typed(ids: list[int | str]) -> dict[str, Any]:
    """thimble fix merge A B C in a shell: after the person's y in their terminal."""
    recs = [get(i) for i in ids]
    names = ", ".join(f'{r["id"]} "{r["title"]}"' for r in recs)
    secret = key_in_terminal(f"Merge fixes {names} into fix {recs[0]['id']}?")
    if secret is None:
        raise FixError("only your key merges fixes: run thimble fix merge in your own terminal")
    if not secret:
        return {"said": "Nothing merged.", "reload": False}
    write_json(home() / "asks" / f"{recs[0]['id']}.json", {"key": key_hash(secret)})
    out = merge(ids, secret)
    return {**out, "said": f"Fixes {_and([str(r['id']) for r in recs])} are now fix {recs[0]['id']}: {out['title']}."}


def not_now(fid: int | str) -> dict[str, Any]:
    """n: a ready fix stays in the list, off, its commit kept for u; its copy goes. A fix that failed stays failed,
    for r."""
    rec = get(fid)
    if rec.get("state") not in ("ready", "failed"):
        raise FixError(f"fix {rec['id']} is {rec.get('state')}")
    if rec.get("prev"):
        # a fix changed in place: a ready new version waits for thimble fix apply; a failed round leaves it as it was
        if rec["state"] == "failed":
            return _restore(rec)
        _drop_work(rec)
        return put(rec)
    if rec["state"] == "ready":
        rec.update(state="off", note="not now")
    _drop_work(rec)
    return put(rec)


def redo(fid: int | str, words: str = "", session: str | None = None, asked: str | None = None) -> dict[str, Any]:
    """y on a failed fix's line, or /thimble-fix N alone: the same fix again, whose fixer gets the person's words again.
    A failed fix whose copy holds work that no check took (_unchecked), such as the change Claude made there for it in
    the person's session, goes on in that copy, as more words do (round_), so that the next check takes that work too;
    what this gives then says so (same_copy). Any other starts in a new copy, cut from mine as it is now, with the earlier
    change to start from (tmp/<id>/earlier.patch, which `earlier` in what this gives names when there is one). A fix
    whose fixer could not do without the files no fix may change (blocked) starts again only with new words, or with such
    work in its copy."""
    words = (words or "").strip()
    with Lock():
        rec = get(fid)
        if rec.get("state") not in ("redo", "pending", "failed", "off", "ready", "request"):
            raise FixError(f"fix {rec['id']} is {rec.get('state')}")
        patch = tmp_dir(rec["id"]) / "earlier.patch"
        if rec.get("state") == "failed" and _unchecked(rec):
            # the copy and what it holds stay; a patch of an earlier try is no change of this one
            with contextlib.suppress(OSError):
                patch.unlink()
            return {**_in_copy(rec, [words] if words else [], session, asked), "same_copy": True}
        if rec.get("blocked") and not words:
            raise FixError(f"fix {rec['id']} needs a change to {_and(rec['blocked'])}, which no fix may make, so another "
                           f"try would fail the same way; thimble file issue {rec['id']}, in a shell, sends it to "
                           "thimble's maintainers")
        ensure_live()
        if rec.get("prev"):
            # a round of a fix changed in place: the copy holds the fix as the person has it, the round's change apart
            c = rec.get("round_commit") or rec.get("commit")
            earlier = run(["git", "-c", "core.quotePath=false", "show", "--format=", "--no-color", "--no-ext-diff", c],
                          cwd=live_dir(), check=False).stdout if c else ""
            wt, base = _copy_of({**rec, **{k: v for k, v in rec["prev"].items() if k in ("state", "commit")}})
        else:
            earlier = diff_of(rec) if rec.get("commit") else ""
            _drop_work(rec)
            wt = work_dir(rec["id"])
            if wt.exists():
                shutil.rmtree(wt)
            base = head()
            git("worktree", "add", "-q", "--detach", str(wt), base, cwd=live_dir(), hooks=False)
            _give_types(wt)
        tmp_dir(rec["id"]).mkdir(parents=True, exist_ok=True)
        wrote = False
        if earlier.strip():
            try:
                _write_new(patch, earlier)
                wrote = True
            except OSError:
                pass  # the new copy starts all the same, without the earlier change to start from
        if not wrote:
            # a patch of an earlier try is no change of this one
            with contextlib.suppress(OSError):
                patch.unlink()
        rec = _fresh(rec)
        rec.pop("unshown", None)
        rec.update(state="working", work=str(wt), base=base, error=None, tests=None, rounds=int(rec.get("rounds") or 1) + 1,
                   session=session or None)
        out = put(_with_words(rec, [words] if words else [], asked))
        return {**out, "earlier": str(patch)} if wrote else out


def undo(fid: int | str) -> dict[str, Any]:
    """u: the fix's commit comes out of mine and stays under its ref, so it can go on again."""
    rec = get(fid)
    if rec.get("state") != "on":
        raise FixError(f"fix {rec['id']} is not on")
    if rec.get("prev"):
        return _move(lambda: _back(rec["id"]))

    def change():
        r = get(rec["id"])
        r.update(state="off", note="undone")
        put(r)
        out = _take_out(rec["id"], f"it did not fit once fix {rec['id']} was undone")
        return {"id": rec["id"], "title": rec["title"], **out}

    return _move(change)


def _back(fid: int) -> dict[str, Any]:
    """u after y on a fix changed in place: the version before comes back, on or off as it was."""
    live = live_dir()
    r = get(fid)
    p = r.pop("prev") or {}
    old = git("rev-parse", "-q", "--verify", f"refs/thimble/prev/{fid}", cwd=live, check=False) or str(p.get("commit") or "")
    git("update-ref", f"refs/thimble/fixes/{fid}", old, cwd=live)
    r.update({k: v for k, v in p.items() if k in ("files", "summary", "title", "tests", "tests_tail", "base")},
             state=p.get("state") or "off", note="back to the version before", error=None)
    if r["state"] == "on":
        r["on_at"] = p.get("on_at") or r.get("on_at")
    put(r)
    run(["git", "update-ref", "-d", f"refs/thimble/prev/{fid}"], cwd=live, check=False)
    failed = _rebuild(_on_ids(records()))
    for i in failed:
        x = get(i)
        x.update(state="redo", error=f"it did not fit once fix {fid} went back")
        put(x)
    if is_on():
        git("checkout", "-q", "mine", cwd=live, hooks=False)
    else:
        git("checkout", "-q", "--detach", release()["base"], cwd=live, hooks=False)
    r = get(fid)
    r["commit"] = git("rev-parse", f"refs/thimble/fixes/{fid}", cwd=live)
    put(r)
    return {"id": fid, "title": r["title"], "back": True, "state": r["state"], "redo": failed}


def remove(fid: int | str) -> dict[str, Any]:
    """x: the fix leaves the list (its record stays in fixes.jsonl, as removed)."""
    rec = get(fid)
    was_on = rec.get("state") == "on"
    out: dict[str, Any] = {"id": rec["id"], "title": rec["title"], "reload": False}
    if was_on:
        out = undo(rec["id"])
    # under the fixes' lock, which the runner of the fix's tests writes under too (tests_runner)
    with Lock():
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
    """thimble fix on: the fixes that were on, on again; in a shell, first the fixes an update set aside that still fit
    (carry), which would not be on otherwise."""
    if not (live_dir() / ".git").exists():
        return {"reload": False, "said": "You have no fixes yet."}
    if not in_claude_code() and carry_due():
        carry(say=_tell)

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
    if rec.get("state") == "pending" and not in_claude_code() and carry_due():
        # the fixes an update set aside wait for their check: it puts this one back if it fits
        carried = carry(say=_tell) or {}
        rec = get(fid)
        if rec.get("state") == "on":
            return {"said": f"Fix {rec['id']} is on: {rec['title']}." + ("" if is_on() else " Your fixes are all off now: "
                                                                        "thimble fix on turns them on."),
                    "reload": bool(carried.get("reload"))}
    if rec.get("state") == "pending":
        raise FixError(_aside_why(rec))
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
    """The thimble command in a shell (scripts/install.sh links it and names the link in cli-link) runs the release
    checkout's launcher once Claude Code loads thimble from live: the way back (thimble fix, file, update, reapply) runs
    from the release, which no fix changes, and the launcher hands the other commands to live's."""
    try:
        link = Path((thimble_home() / "cli-link").read_text().strip())
    except OSError:
        return
    target = release_dir() / "plugin" / "bin" / "thimble"
    if not link.is_symlink() or not target.exists() or not os.readlink(link).endswith("/plugin/bin/thimble"):
        return
    if Path(os.readlink(link)) == target:
        return
    tmp = link.with_name(link.name + ".thimble-tmp")
    tmp.unlink(missing_ok=True)
    tmp.symlink_to(target)
    tmp.replace(link)


def _way_back() -> None:
    """The release checkout at the release commit, and the shell's link on its launcher, before the fixes an update set
    aside go on again (reapply, continue_): an update that a thimble from before the checkout ran made neither."""
    place_release(release()["base"])
    if release().get("pointed"):
        _relink_cli()


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


def latest_release(then: str = "run thimble update again") -> dict[str, Any]:
    """The newest release, {tag, version, commit, url, tags}: the highest vX.Y.Z tag of thimble's repository, and each
    release tag's commit (tags), which names a release that a clone without tags has. A tag with more after the numbers
    (v0.11.0-rc1) is not a release. `then`: what the person does after the network works again."""
    url = update_url()
    p = run(["git", "ls-remote", "--tags", url, "refs/tags/v*"], check=False, timeout=120)
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip().splitlines()
        raise FixError(f"thimble could not read its releases from {url} ({err[-1] if err else 'no message'}); "
                       f"check the network, then {then}")
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
    return {"tag": tag, "version": tag[1:], "commit": tags[tag], "url": url, "tags": tags}


def release_name(rel: dict[str, Any] | None = None) -> str:
    """The release live is on, as the person reads it: 0.10.3, else the plugin's version, else the commit. Before the
    first fix makes live (no release.json), the thimble that runs (_own_name)."""
    rel = release() if rel is None else rel
    if not rel:
        return _own_name()
    if rel.get("checkout") and not rel.get("tag"):
        return str(rel["checkout"])  # a dev install's commit, as thimble update named it: main at abc1234
    return str(rel.get("tag") or "").removeprefix("v") or str(rel.get("version") or "") or str(rel.get("base") or "")[:7]


def _own_name() -> str:
    """The thimble that runs, as the person reads it: its plugin's own version, which scripts/install.sh writes in the
    copy Claude Code installs (a release names its version by its tag alone), else the release tag of its checkout's
    commit (find_source: Claude Code's clone of the marketplace, or the person's own clone), v0.10.5 as 0.10.5; else
    nothing, since a checkout may have no tags."""
    d = read_json(PLUGIN / ".claude-plugin" / "plugin.json")
    if isinstance(d, dict) and d.get("version"):
        return str(d["version"])
    try:
        src = find_source()
    except FixError:
        return ""
    if not src["commit"]:
        return ""  # a release's zip: its release is known once live is made from it
    tag = git("describe", "--tags", "--exact-match", "--match", "v*", src["commit"], cwd=src["repo"], check=False)
    return tag[1:] if RELEASE_TAG.match(tag) else ""


def running_name(rel: dict[str, Any] | None = None) -> str:
    """The thimble that runs, as the person reads it. Claude Code loads thimble from live only once release.json says
    pointed (the first fix that went on pointed its marketplace there): then the release live is on (release_name).
    Before that, the copy Claude Code installed (_own_name), also when a request made live already: live's release
    can be older than that copy (thimble was installed again since)."""
    rel = release() if rel is None else rel
    return release_name(rel) if rel.get("pointed") else _own_name()


def version_name() -> str:
    """`thimble --version`: the thimble that runs (running_name), else the commit Claude Code installed; '' when
    nothing names it (a folder with no git whose plugin.json has no version)."""
    try:
        return running_name() or str(find_source()["commit"])[:7]
    except (FixError, OSError, subprocess.SubprocessError):
        return ""


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
    out = git("-c", "core.quotePath=false", "show", "--name-only", "--no-renames", "--format=", f"refs/thimble/fixes/{fid}",
              cwd=live_dir(), check=False)
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
            e.append(f"   Old change: {_tilde(str(p['old']))}" + (f" ({', '.join(files)})" if files else ""))
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
    prompt = d / f"{cur.get('key') or to}.md"
    prompt.write_text(text)
    write_json(d / "current.json", {**cur, "ids": ids, "tip": head(), "prompt": str(prompt)})
    return prompt


def reapply_argv(say=None) -> dict[str, Any]:
    """thimble reapply: first the set-aside fixes that still fit go on again (carry, after an update by an older
    thimble); then Claude Code (claude) in live, with the reapply prompt as its first message, for the fixes still set
    aside, once the way back runs from the release checkout (_way_back). `carried`: what carry did; argv None when it
    put back every fix. say: what tells the person that carry's checks run."""
    if not (live_dir() / ".git").exists():
        raise FixError("you have no fixes: there is nothing to bring back")
    carried = carry(browser=True, say=say)
    if carried and not carried["aside"]:
        return {"argv": None, "carried": carried}
    with Lock():
        prompt = reapply_prompt()
        _way_back()
        if not is_on():
            # every fix is off (live shows the release): Claude brings the fixes back on mine all the same, and
            # --continue keeps them off
            _unstamp()
            git("checkout", "-q", "mine", cwd=live_dir(), hooks=False)
    return {"argv": [claude(), prompt.read_text()], "cwd": str(live_dir()), "prompt": str(prompt), "carried": carried}


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


def _browser_behind(repo: Path, base: str) -> str:
    """The release tag of the folder the browser workbench runs from, when it runs from the folder its install built it
    in (no browser-ready), that folder is a release's zip, with no git of its own, and it holds another release's files
    than base's (in `repo`). '' when the workbench is not installed, runs from live or has base's files, when its folder
    is a git checkout (the person's to pull: thimble update leaves it as it is), and when the folder's files are no
    release's."""
    seed = _browser_seed()
    if seed is None or (home() / "browser-ready").exists() or not (seed.parent / PLUGIN_JSON).is_file():
        return ""
    if _own_checkout(seed.parent):
        return ""
    if not _differs(repo, base, seed.parent)[0]:
        return ""
    try:
        return _zip_release(seed.parent)[0]
    except FixError:
        return ""


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


def _set_aside(ids: list[int], recs: dict[int, dict[str, Any]], version: str, key: str, now: str) -> None:
    """Each fix of ids off, as pending, with its old change as pending/<key>/fix-<id>.patch for thimble reapply. A fix
    an earlier update set aside keeps the old change it had."""
    for fid in ids:
        r = recs[fid]
        if r.get("state") == "pending" and r.get("pending", {}).get("old") and Path(r["pending"]["old"]).exists():
            continue  # set aside before: its old change stays the one it had
        patch = home() / "pending" / key / f"fix-{fid}.patch"
        patch.parent.mkdir(parents=True, exist_ok=True)
        patch.write_text(run(["git", "-c", "core.quotePath=false", "format-patch", "--stdout", "-1", "--no-color",
                              f"refs/thimble/fixes/{fid}"], cwd=live_dir()).stdout)
        r.update(state="pending", error=None, note=f"set aside at the update to {version}",
                 pending={"version": version, "from": now, "old": str(patch), "files": _set_aside_files(fid)})
        put(r)


def _aside_before(fid: int) -> dict[str, Any]:
    """Fix `fid`'s record as it was before an update set it aside: its last line in fixes.jsonl whose state is not
    pending ({} when it has none)."""
    was: dict[str, Any] = {}
    try:
        lines = (home() / "fixes.jsonl").read_text().splitlines()
    except OSError:
        return was
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and str(r.get("id")) == str(fid) and r.get("state") != "pending":
            was = r
    return was


def _came_detached(live: Path, tip: str) -> bool:
    """Whether live showed the plain release (every fix turned off: HEAD detached) when an update moved it onto mine at
    `tip`, as live's HEAD log says ("checkout: moving from <commit> to mine"). An update by thimble 0.10.5 or before
    then wrote that the fixes are on (state.json): this is the one trace of it."""
    lead, tail = "checkout: moving from ", " to mine"
    for line in git("reflog", "--format=%H %gs", "HEAD", cwd=live, check=False).splitlines():
        sha, _, msg = line.partition(" ")
        if sha == tip and msg.startswith(lead) and msg.endswith(tail):
            return bool(re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", msg[len(lead):-len(tail)]))
    return False


# the copy in which carry checks the fixes an update set aside (work/carry, tmp/carry), as done checks a fix in its own
CARRY = "carry"


def _carry_due() -> tuple[dict[str, Any], list[int]] | None:
    """The record of the last update (pending/current.json) and the fixes it set aside that carry checks next, while
    live is as the update left it: no carry ran since, mine is at the update's tip, and no file changed (else a reapply
    session works there). None when there is nothing to carry."""
    cur = read_json(home() / "pending" / "current.json")
    live = live_dir()
    if not isinstance(cur, dict) or cur.get("carried") or not (live / ".git").exists():
        return None
    recs = records()
    ids = [int(i) for i in cur.get("ids") or [] if recs.get(int(i), {}).get("state") == "pending"]
    tip = str(cur.get("tip") or "")
    if not ids or not tip or git("rev-parse", "-q", "--verify", "mine", cwd=live, check=False) != tip:
        return None
    changed = run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=live).stdout.splitlines()
    if any(x[3:] != PLUGIN_JSON for x in changed):
        return None
    return cur, ids


def _unchecked_on() -> list[int]:
    """The fixes in mine that an update by an older thimble put back on the release live is on with none of these
    checks: 0.10.6's update put back each fix whose change applied, and a dev install's update by 0.10.5 or 0.10.6 each
    one. release.json's `checked` names the release commit whose fixes this kernel checked (by an update or a carry of
    its own, or as live was made there with no fix), and an older thimble's update moves base and leaves it. [] once
    they are checked, when mine holds no fix, and while live is not as such an update left it (a file changed, or mine
    holds a commit that is no fix's: a reapply session works there)."""
    rel, live = release(), live_dir()
    base = str(rel.get("base") or "")
    if not base or rel.get("checked") == base or not (live / ".git").exists():
        return []
    commits = git("rev-list", f"{base}..mine", cwd=live, check=False).split()
    fixes = set(git("for-each-ref", "--format=%(objectname)", "refs/thimble/fixes/", cwd=live).split())
    if not commits or not set(commits) <= fixes:
        return []
    changed = run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=live).stdout.splitlines()
    if any(x[3:] != PLUGIN_JSON for x in changed):
        return []
    return _replay_order(records())


def _aside_unchecked(ids: list[int]) -> None:
    """The fixes of `ids` (_unchecked_on), and any an update set aside before, set aside as this kernel's update sets
    aside the fixes in mine (pending, their change in pending/<release>/fix-<id>.patch), on the plain release, with the
    record of what was set aside (pending/current.json): carry then checks them as it checks the fixes an update set
    aside, and each that fits goes back on as it was, while each that does not stays off, saying why."""
    live, rel, recs = live_dir(), release(), records()
    base, version = str(rel["base"]), release_name(rel)
    ids = list(dict.fromkeys([*ids, *[i for i, r in sorted(recs.items()) if r.get("state") == "pending"]]))
    was_on = is_on()
    _set_aside(ids, recs, version, str(rel.get("tag") or "").removeprefix("v") or base[:7], "")
    _unstamp()
    git("checkout", "-q", "-B", "mine", base, cwd=live, hooks=False)
    if not was_on:
        git("checkout", "-q", "--detach", base, cwd=live, hooks=False)
    d = home() / "pending"
    d.mkdir(parents=True, exist_ok=True)
    write_json(d / "current.json", {"version": version, "from": "", "from_commit": "", "to_commit": base, "ids": ids,
                                    "tip": head(), "made": time.time(), "off": not was_on})


def _mark_checked() -> None:
    """release.json says that this kernel checked the fixes in mine on the release live is on (_unchecked_on)."""
    rel = release()
    if rel and rel.get("checked") != rel.get("base"):
        write_json(home() / "release.json", {**rel, "checked": rel["base"]})


def _sync_owed() -> Path:
    """pending/sync-owed: carry put fixes back on in live, and Claude Code has not copied live since (the copy failed, or
    the call that carried stopped first). The next carry has it copy live."""
    return home() / "pending" / "sync-owed"


def carry_due() -> dict[str, Any] | None:
    """What carry does next, for the plugin's list: {to, n}, the release and how many fixes it checks on it (those an
    update set aside, or those an update by an older thimble put back with no check, which then say on: _unchecked_on);
    n 0 when only Claude Code's copy of fixes it put back is owed (_sync_owed). None: nothing."""
    try:
        due = _carry_due()
        unchecked = [] if due else _unchecked_on()
    except FixError:
        return None
    if due:
        return {"to": release_name() or str(due[0].get("version") or ""), "n": len(due[1])}
    if unchecked:
        return {"to": release_name(), "n": len(unchecked), "on": True}
    return {"to": release_name(), "n": 0} if _sync_owed().exists() else None


def _carry_trial(tip: str, ids: list[int]) -> tuple[list[tuple[int, str]], list[int], list[int]]:
    """work/carry, made anew at `tip` (the plain release), with each fix of `ids` cherry-picked on it in that order:
    (back: each fix whose change applies, with its commit there; had: those whose change the release has already;
    missed: those whose change does not apply)."""
    wt = home() / "work" / CARRY
    _drop_work({"work": str(wt)})
    wt.parent.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-q", "--detach", str(wt), tip, cwd=live_dir(), hooks=False)
    _give_types(wt)
    back: list[tuple[int, str]] = []
    had: list[int] = []
    missed: list[int] = []
    for fid in ids:
        p = run(["git", *NO_HOOKS, *THIMBLE_ID, "cherry-pick", "--keep-redundant-commits", f"refs/thimble/fixes/{fid}"],
                cwd=wt, check=False, env=as_thimble())
        if p.returncode != 0:
            run(["git", *NO_HOOKS, "cherry-pick", "--abort"], cwd=wt, check=False)
            missed.append(fid)
        elif run(["git", "diff", "--quiet", "HEAD^", "HEAD"], cwd=wt, check=False).returncode == 0:
            # the release has this change already
            git("reset", "-q", "--hard", "HEAD^", cwd=wt, hooks=False)
            had.append(fid)
        else:
            back.append((fid, git("rev-parse", "HEAD", cwd=wt)))
    return back, had, missed


def _carry_paths(back: list[tuple[int, str]]) -> list[str]:
    """The files the fixes of `back` change."""
    return sorted({str(f["path"]) for _, c in back for f in _numstat(live_dir(), f"{c}^", c)})


def _carry_tests(back: list[tuple[int, str]], tip: str, paths: list[str] | None = None) -> tuple[bool | None, str]:
    """The checks of work/carry as `back` left it on the release (`tip`), for the files its fixes change, or for
    `paths`, as done checks a fix (_checks), after which no git runs in the copy: (True, the log's last lines) passed,
    (False, the same) failed, (None, why) could not run (the sandbox runtime is missing, say)."""
    paths = _carry_paths(back) if paths is None else paths
    try:
        argv = _checks_argv(CARRY, paths, tip)
    except (FixError, OSError) as e:
        return None, str(e)
    return _run_tests(argv, CARRY)


def _carry_check(tip: str, ids: list[int], to: str, say) -> dict[str, Any]:
    """The fixes of `ids` on the release (`tip`), checked as done checks a fix (_carry_tests) before any goes on: {back,
    had, missed, failed}, back with each fix that passed and its commit, in order; or {unchecked: why} when the checks
    could not run, or fail on the release alone too. Fixes that fail together are tried again one at a time, each on top
    of those that passed before it, so that a fix whose change applies but does not work on the release keeps none of
    the others off."""
    back, had, missed = _carry_trial(tip, ids)
    out: dict[str, Any] = {"back": back, "had": had, "missed": missed, "failed": []}
    if not back:
        return out
    k = len(back)
    if say:
        say(f"Checking {'your fix' if k == 1 else f'your {k} fixes'} on thimble {to} (a minute or two)...")
    ok, tail = _carry_tests(back, tip)
    if ok is None:
        return {"unchecked": tail}
    if ok:
        return out
    # the release alone, with the same checks: when it fails them too (a machine too busy for the tests' time limits,
    # say), they say nothing of the fixes
    paths = _carry_paths(back)
    _carry_trial(tip, [])
    ok, tail = _carry_tests([], tip, paths)
    if not ok:
        return {"unchecked": tail if ok is None else "the checks fail without them too"}
    order = [f for f, _ in back]
    if k == 1:
        return {**out, "back": [], "failed": order}
    if say:
        say("They do not pass together: checking them one at a time...")
    kept: list[tuple[int, str]] = []
    failed: list[int] = []
    for i, fid in enumerate(order):
        trial = [*(f for f, _ in kept), fid]
        if i == k - 1 and len(kept) == k - 1:
            # with every fix before it, this is the whole set again, which failed
            failed.append(fid)
            continue
        b, _, _ = _carry_trial(tip, trial)
        if [f for f, _ in b] != trial:
            # it does not apply, or has nothing to add, without a fix that was left out
            failed.append(fid)
            continue
        ok, tail = _carry_tests(b, tip)
        if ok is None:
            return {"unchecked": tail}
        if ok:
            kept = b
        else:
            failed.append(fid)
    return {**out, "back": kept, "failed": failed}


def _carry(sync: bool = True, say=None) -> dict[str, Any] | None:
    """carry(), under the lock. sync: have Claude Code copy live when a fix went on (update copies it itself). say: what
    tells the person that the checks run (a line each)."""
    owed = _sync_owed()
    due = _carry_due()
    unchecked = [] if due else _unchecked_on()
    if unchecked:
        # an update by an older thimble put them back with no check: they are set aside, then checked, as this kernel's
        # update does it
        _aside_unchecked(unchecked)
        due = _carry_due()
    if due is None:
        if not (sync and owed.exists()):
            return None
        # Claude Code's copy of the fixes an earlier carry put back
        out = {"to": release_name(), "back": [], "had": [], "aside": [], "why": {}, "off": False, "titles": {}}
        out.update(_sync())
        owed.unlink(missing_ok=True)
        return out
    cur, ids = due
    d, live = home() / "pending", live_dir()
    tip = str(cur["tip"])
    # the release as the person reads it, as what a fix does not fit names it (_misfit): a dev install's checkout at a
    # release tag is that release
    version = release_name() or str(cur.get("version") or "")
    off = not is_on() or (cur.get("off") is None and _came_detached(live, tip))
    try:
        got = _carry_check(tip, ids, version, say)
    finally:
        _drop_work({"work": str(home() / "work" / CARRY)})
    recs = records()
    if "unchecked" in got:
        # nothing moves: the fixes stay set aside, and the next carry checks them again
        return {"to": version, "back": [], "had": [], "aside": ids, "why": {}, "off": off, "unchecked": got["unchecked"],
                "titles": {i: recs[i]["title"] for i in ids}, "reload": False}
    back: list[tuple[int, str]] = got["back"]
    had: list[int] = got["had"]
    # mine: the release and each fix that passed, as the check had them
    _unstamp()
    git("checkout", "-q", "-B", "mine", back[-1][1] if back else tip, cwd=live, hooks=False)
    for fid, c in back:
        git("update-ref", f"refs/thimble/fixes/{fid}", c, cwd=live)
        r, was = records()[fid], _aside_before(fid)
        r.update(error=None, pending=None, note=was.get("note"))
        if (was.get("prev") or {}).get("state") == "on" and was.get("state") not in ("on", "sent"):
            # a fix changed in place: the version the person had is on again, and its new version waits as it did
            r.update(state=was.get("state"), prev={**(r.get("prev") or {}), **was["prev"], "commit": c})
        else:
            r.update(state="sent" if was.get("state") == "sent" else "on", commit=c, files=_numstat(live, f"{c}^", c),
                     on_at=r.get("on_at") or was.get("on_at") or time.time())
        put(r)
    for fid in had:
        r = records()[fid]
        r.update(state="released", released_in=version, note=f"already in {version}", pending=None, error=None)
        put(r)
    why: dict[int, str] = {}
    for fid in got["missed"]:
        why[fid] = f"it does not fit {_misfit(fid, f'refs/thimble/fixes/{fid}')}"
    for fid in got["failed"]:
        # its change applies, and the checks fail with it on the release
        why[fid] = f"it does not fit thimble {version}"
    aside = [i for i in ids if i in why]
    for fid in aside:
        r = records()[fid]
        r["error"] = why[fid]
        put(r)
    if aside:
        write_json(d / "current.json", {**cur, "ids": aside, "tip": head(), "carried": True})
    else:
        (d / "current.json").unlink(missing_ok=True)
    if off:
        git("checkout", "-q", "--detach", release()["base"], cwd=live, hooks=False)
        write_json(home() / "state.json", {"on": False})
    # the way back from the release checkout, which an update by a thimble from before it did not make
    _way_back()
    # every fix in mine passed the checks on this release: none waits for them there (_unchecked_on)
    _mark_checked()
    recs = records()
    out = {"to": version, "back": [f for f, _ in back], "had": had, "aside": aside, "why": why, "off": off,
           "titles": {i: recs[i]["title"] for i in [*(f for f, _ in back), *had, *aside]}, "reload": False}
    if any(str(f.get("path") or "").startswith("browser/") for fid, _ in back for f in recs[fid].get("files") or []):
        # the browser workbench's page is built again from it: at once by thimble update and thimble reapply (carry), else
        # when thimble-browser starts next
        out["browser"] = "stale"
    if sync and (back or unchecked) and not off:
        # Claude Code copies live: the fixes put back, or the fixes an older thimble put back taken off. Owed until it
        # did, so that a copy that fails, or a call stopped before it, is made later
        owed.parent.mkdir(parents=True, exist_ok=True)
        owed.write_text(f"{head()}\n")
        try:
            out.update(_sync())
            owed.unlink(missing_ok=True)
        except FixError as e:
            out["sync_error"] = str(e)
    return out


def _tell(line: str) -> None:
    """A line for the person in a shell while thimble works, on stderr, so that what a command prints (--json, the
    reapply prompt with --print) stays as it is."""
    print(line, file=sys.stderr, flush=True)


def carry(browser: bool = False, say=None) -> dict[str, Any] | None:
    """The fixes an update set aside that still fit the new release, on again, with no key press, as they were before it
    (on, sent, or the version a fix changed in place had). Each is cherry-picked onto the release in the order mine had
    them, in a copy (work/carry), and the copy is checked as done checks a fix (_checks: the checks of the parts of
    thimble their changes touch) before anything goes on: fixes that fail together are tried one at a time
    (_carry_check). One the release already has leaves the list (released); one that does not apply, or fails the
    checks, stays set aside, its record saying that it does not fit the release (error), for thimble reapply. Fixes the
    person had turned off stay off. When the checks cannot run, nothing moves, and the next carry tries again.

    thimble update carries at once. An update by thimble 0.10.5 or before set every fix aside and stopped there, and one
    by 0.10.6 put back each fix whose change applied with no check (as a dev install's update by 0.10.5 or 0.10.6 put
    back each one): this kernel checks them, once on each release, as its own update would have (_unchecked_on), at the
    next step that may take the minutes the checks need: thimble fixes, thimble reapply or thimble update in a shell,
    thimble-browser's start (its launcher runs thimble fix carry), and a Claude Code session's start (the plugin runs it
    as a step on its bar, when its list says that it is due: carry_due). A list for the plugin or the workbench never
    carries. Nothing happens once carried, or while live is not as the update left it (mine moved on from the update's
    tip, or a file changed: a reapply session works there). browser: build the browser workbench's page again (and
    install its packages when their lock files changed) when a fix that went on changes it, as thimble update and
    thimble reapply do; the others leave that to thimble-browser's next start, which builds the page. say: what tells
    the person that the checks run. What it did, or None."""
    if carry_due() is None:
        _checked_with_none()
        return None
    with Lock():
        out = _carry(say=say)
    if out and browser and out.get("browser") == "stale" and not out.get("off"):
        out.update(browser_on_live())
    return out


def _checked_with_none() -> None:
    """A release with no fix in mine has none to check: release.json says so once (_mark_checked), when an older
    thimble made live or moved it there, so that thimble-browser's launcher, which asks carry while it does not, stops
    asking."""
    rel, live = release(), live_dir()
    if not rel.get("base") or rel.get("checked") == rel["base"] or not (live / ".git").exists():
        return
    with Lock():
        rel = release()
        if not git("rev-list", f"{rel['base']}..mine", cwd=live, check=False):
            _mark_checked()


def update(check: bool = False, once: bool = False, say=None) -> dict[str, Any]:
    """thimble update: the newest release for both modes.

    The fixes that were on are set aside (state pending, their old change in pending/<version>/fix-<id>.patch), mine is
    the plain release, and then each fix that still fits it goes on again (carry: its change applies, and the release
    passes done's checks with it): the person keeps what still fits, and a fix that does not fit the release stays off,
    its record saying so. thimble reapply then opens Claude Code in live to bring back each fix that is set aside,
    fitted to the release, and `thimble update --continue` records what Claude committed. Fixes the person had turned
    off stay off. Claude Code loads the plugin from live, and thimble-browser runs from live/browser. With no newer
    release, it carries the fixes an update by an older thimble set aside. With check, only whether a newer release is
    out.

    A dev install (the person's own clone, kind clone) has no releases to wait for: the target is what the person
    checked out (_update_dev). A release's zip has no git of its own: live, from thimble's repository at the release
    the zip holds (ensure_live), is its git checkout first, and then it updates as a GitHub install does; a check only
    reads which release that is. once: the session's check, which says a new commit once. say: what tells the person
    that carry's checks run."""
    rel = release()
    has_live = bool(rel) and (live_dir() / ".git").exists()
    src = None if has_live else find_source()
    if src and src["kind"] == "zip" and not check:
        with Lock():
            rel, has_live = ensure_live(), True
    if (rel.get("kind") if has_live else src["kind"]) == "clone":
        return _update_dev(check, once, rel if has_live else None, src, say)
    latest = latest_release()
    if has_live:
        repo, base, now = live_dir(), str(rel["base"]), release_name(rel)
        if not rel.get("tag"):
            now = _described(repo, base) or now
    elif src["kind"] == "zip":
        tag, base = _zip_release(Path(src["repo"]), src["prefix"], latest)
        repo, now = Path(src["repo"]), tag[1:]
    else:
        repo, base = Path(src["repo"]), str(src["commit"])
        now = _described(repo, base) or _version_at(repo, base) or base[:7]
    if latest["commit"] == base:
        now = latest["version"]
    out: dict[str, Any] = {"from": now, "to": latest["version"], "newer": _is_newer(repo, latest, base, now),
                           "said": "", "reload": False}
    installed = "" if has_live else _installed_sha()
    if not check and not out["newer"] and base == latest["commit"] and installed and installed != base:
        # Claude Code's clone of the marketplace is at the release already (Claude Code refreshed it), while Claude Code
        # still runs the plugin it had: it copies the release from its clone
        run([claude(), "plugin", "update", "thimble@thimble"])
        # the release it had, by the tags read above: Claude Code's clone, one commit deep, has none
        had = max((t for t, c in latest["tags"].items() if c == installed), key=_vtuple, default="")
        out.update({"from": had[1:] or _described(repo, installed) or installed[:7], "newer": True, "aside": [],
                    "reload": True, "said": f"thimble {latest['version']}"})
        out["lines"] = _summary(out)
        return out
    behind = _browser_behind(repo, base) if not check and not out["newer"] and base == latest["commit"] else None
    if behind:
        # the plugin has the release, and the browser workbench runs an older one from the release's zip its install
        # built it in, with the plugin from GitHub: the workbench alone moves from that release (browser_only)
        out.update({"from": behind[1:], "newer": True, "browser_only": True})
    if check or not out["newer"]:
        same = now == latest["version"]
        line = (f"thimble {now} is the newest release." if same else
                f"thimble {now} is up to date; the newest release is {latest['version']}.")
        # the fixes an update by an older thimble set aside, which it left at that
        carried = None if check or not has_live else carry(browser=True, say=say)
        if carried:
            return {**out, "carried": carried, "reload": bool(carried.get("reload")),
                    "lines": [line, *_carried_lines(carried)]}
        return {**out, "lines": [] if check else [line]}
    with Lock():
        ensure_live()
        live, rel = live_dir(), release()
        old = str(rel["base"])
        was_on = is_on()
        ref = f"refs/thimble/releases/{latest['tag']}"
        run(["git", "fetch", "-q", "--no-tags", latest["url"], f"+refs/tags/{latest['tag']}:{ref}"], cwd=live, timeout=600)
        new = git("rev-parse", f"{ref}^{{commit}}", cwd=live)
        version = latest["version"]
        recs = records()
        # the fixes in mine (on, or sent), and any an earlier update set aside that Claude has not brought back yet
        aside = [*_replay_order(recs), *[i for i, r in sorted(recs.items()) if r.get("state") == "pending"]]
        aside = list(dict.fromkeys(aside))
        _set_aside(aside, recs, version, version, now)
        _unstamp()
        git("checkout", "-q", "-B", "mine", new, cwd=live)
        if was_on:
            write_json(home() / "state.json", {"on": True})
        else:
            git("checkout", "-q", "--detach", new, cwd=live)
        rel.update(base=new, version=_version_at(live, new), tag=latest["tag"], updated=time.time())
        if not aside:
            # no fix to check on the new release (_unchecked_on); else carry checks them, and says so
            rel["checked"] = new
        write_json(home() / "release.json", rel)
        _write_off_sh(rel)
        place_release(new)
        d = home() / "pending"
        if aside:
            d.mkdir(parents=True, exist_ok=True)
            write_json(d / "current.json", {"version": version, "from": now, "from_commit": old, "to_commit": new,
                                            "ids": aside, "tip": head(), "made": time.time(), "off": not was_on})
        else:
            (d / "current.json").unlink(missing_ok=True)
        _repoint()
        # the workbench's packages and page for the release first: the checks of a fix to the page build it with them
        browser = browser_on_live()
        carried = (_carry(sync=False, say=say) if aside else None) or {}
        synced = _sync()
    if carried.get("browser") == "stale" and not carried.get("off"):
        browser = browser_on_live()
    recs = records()
    left = carried.get("aside", aside)
    out = {**out, "aside": left, "back": carried.get("back", []), "had": carried.get("had", []), "off": not was_on,
           "unchecked": carried.get("unchecked"), "titles": {i: recs[i]["title"] for i in aside if i in recs}, **synced,
           **browser}
    out["lines"] = _summary(out)
    out["said"] = f"thimble {version}" + (f" · {len(left)} fix{'' if len(left) == 1 else 'es'} off" if left else "")
    return out


def _checkout(repo: Path) -> dict[str, Any]:
    """The person's own clone as they have it now, {commit, name, dirty}: its HEAD (as they pulled it: thimble fetches
    nothing), named `<branch> at <sha7>` (the sha alone on a detached HEAD), and the files with changes not committed."""
    commit = git("rev-parse", "HEAD", cwd=repo)
    branch = git("symbolic-ref", "--short", "-q", "HEAD", cwd=repo, check=False)
    dirty = [x[3:] for x in run(["git", "-c", "core.quotePath=false", "status", "--porcelain"], cwd=repo).stdout.splitlines()
             if x.strip()]
    return {"commit": commit, "name": f"{branch} at {commit[:7]}" if branch else commit[:7], "dirty": dirty}


def _dirty_line(dirty: list[str]) -> list[str]:
    if not dirty:
        return []
    files = _and(dirty[:2] + ([f"{len(dirty) - 2} more"] if len(dirty) > 2 else []))
    return [f"Your checkout has changes that are not committed ({files}); they are not included. Commit them, then "
            "run thimble update again."]


def _ancestor(repo: Path, a: str, b: str) -> bool:
    return run(["git", "merge-base", "--is-ancestor", a, b], cwd=repo, check=False).returncode == 0


def _update_dev(check: bool, once: bool, rel: dict[str, Any] | None, src: dict[str, Any] | None,
                say=None) -> dict[str, Any]:
    """thimble update on a dev install (scripts/install.sh --local): the target is the HEAD of the person's own clone,
    the branch they checked out as they pulled it, ahead, behind or apart from what runs. newer: that HEAD is not live's
    base.

    The fixes move as a release update moves them (carry): each is cherry-picked onto the new commit in mine's order,
    and goes on again once the new commit passes done's checks with it. A pull is often a small step, and a fix whose
    change still applies is the same change there; one the checkout already has comes up empty and leaves the list (the
    person's own merged pull request). A fix that does not apply, or fails the checks, is set aside, for thimble reapply
    and --continue."""
    repo = Path(rel["repo"]) if rel else Path(src["repo"])
    base = str(rel["base"]) if rel else str(src["commit"])
    co = _checkout(repo)
    new, to, frm = co["commit"], co["name"], base[:7]
    out: dict[str, Any] = {"dev": True, "from": frm, "to": to, "commit": new, "newer": new != base, "dirty": co["dirty"],
                           "said": "", "reload": False}
    if check:
        out["line"] = (f"Your checkout is at {to}, and thimble runs {frm} · in a shell: thimble update" if out["newer"]
                       else f"thimble is up to date with your checkout ({to}).")
        if once and out["newer"] and rel:
            # the session's line: once for each new commit of the checkout, not at every session
            out["say"] = rel.get("told") != new
            if out["say"]:
                write_json(home() / "release.json", {**rel, "told": new})
        return {**out, "lines": []}
    if not out["newer"]:
        # the fixes an update by an older thimble set aside, which it left at that
        carried = carry(browser=True, say=say) if rel else None
        lines = [f"thimble is up to date with your checkout ({to}).", *_dirty_line(co["dirty"])]
        if carried:
            return {**out, "carried": carried, "reload": bool(carried.get("reload")),
                    "lines": [*lines, *_carried_lines(carried)]}
        return {**out, "lines": lines}
    with Lock():
        ensure_live()
        live, rel = live_dir(), release()
        old = str(rel["base"])
        out["how"] = "ahead" if _ancestor(live, old, new) else "behind" if _ancestor(live, new, old) else "apart"
        recs = records()
        # the fixes in mine, in mine's order, and any an earlier update set aside that Claude has not brought back yet
        aside = list(dict.fromkeys([*_replay_order(recs), *[i for i, r in sorted(recs.items()) if r.get("state") == "pending"]]))
        was_on = is_on()
        key = new[:7]
        _set_aside(aside, recs, to, key, frm)
        _unstamp()
        git("checkout", "-q", "-B", "mine", new, cwd=live)
        rel.update(base=new, version=_version_at(live, new), checkout=to, updated=time.time(), told=new)
        if not aside:
            rel["checked"] = new
        tag = git("describe", "--tags", "--exact-match", "--match", "v*", new, cwd=live, check=False)
        if RELEASE_TAG.match(tag):
            rel["tag"] = tag
        else:
            rel.pop("tag", None)
        write_json(home() / "release.json", rel)
        _write_off_sh(rel)
        place_release(new)
        if not was_on:
            git("checkout", "-q", "--detach", new, cwd=live)
        else:
            write_json(home() / "state.json", {"on": True})
        d = home() / "pending"
        carried: dict[str, Any] = {}
        if aside:
            d.mkdir(parents=True, exist_ok=True)
            write_json(d / "current.json", {"version": to, "key": key, "from": frm, "from_commit": old, "to_commit": new,
                                            "ids": aside, "tip": head(), "made": time.time(), "off": not was_on})
        else:
            (d / "current.json").unlink(missing_ok=True)
        # the workbench's packages and page for the checkout first: the checks of a fix to the page build it with them
        browser = browser_on_live()
        if aside:
            carried = _carry(sync=False, say=say) or {}
        _repoint()
        synced = _sync()
    if carried.get("browser") == "stale" and not carried.get("off"):
        browser = browser_on_live()
    recs = records()
    left = carried.get("aside", aside)
    out = {**out, "aside": left, "back": carried.get("back", []), "had": carried.get("had", []), "off": not was_on,
           "unchecked": carried.get("unchecked"), "titles": {i: recs[i]["title"] for i in aside if i in recs}, **synced,
           **browser}
    out["lines"] = _summary(out)
    out["said"] = f"thimble {to}" + (f" · {len(left)} fix{'' if len(left) == 1 else 'es'} off" if left else "")
    return out


def _named(ids: list[int], titles: dict[int, str]) -> str:
    return "; ".join(titles.get(i) or f"fix {i}" for i in ids)


def _summary(d: dict[str, Any], paint: Paint | None = None) -> list[str]:
    """What thimble update prints: the versions, the fixes on again, those the release has, those off because they do
    not fit it and how to bring them back (or because thimble could not check them: unchecked), and how each mode loads
    the release."""
    import textwrap  # noqa: PLC0415

    c = paint or Paint(False)
    both = d.get("browser") == "ready"
    versions = f"{d['from']} → {d['to']}"
    # what moved from `from`: the terminal plugin, unless it had the release already (browser_only), and the browser
    # workbench, once it runs the release
    moved = [*([] if d.get("browser_only") else ["terminal plugin"]), *(["browser"] if both else [])]
    line = f"Updated thimble{' to your checkout' if d.get('dev') else ''} {c('bold', versions)} ({' and '.join(moved)})"
    out = [line] if moved else []
    if d.get("how") == "behind":
        out.append(f"{d['to']} is older than what thimble ran ({d['from']}); thimble moved back to it, as you checked it out.")
    elif d.get("how") == "apart":
        out.append(f"{d['to']} does not contain what thimble ran ({d['from']}); thimble moved to it, as you checked it out.")
    out += _dirty_line(d.get("dirty") or [])
    titles = d.get("titles") or {}
    if d.get("back"):
        k = len(d["back"])
        how = f"replayed onto {d['to']} and {'stays off, as you had it' if k == 1 else 'stay off, as you had them'}" \
            if d.get("off") else f"on again, replayed onto {d['to']}"
        out += ["", *textwrap.wrap(f"{'Your fix is' if k == 1 else f'Your {k} fixes are'} {how}: "
                                   f"{_named(d['back'], titles)}.", 88, break_on_hyphens=False)]
    if d.get("had"):
        out += [*([] if d.get("back") else [""]),
                *textwrap.wrap(f"Already in {d['to']}, so {'it leaves' if len(d['had']) == 1 else 'they leave'} thimble "
                               f"fixes: {_named(d['had'], titles)}.", 88, break_on_hyphens=False)]
    if d.get("browser") == "failed":
        out.append(f"The browser workbench stays on the release it had: {d.get('browser_error')}. Run thimble update "
                   "again after you correct that.")
    k = len(d.get("aside") or [])
    n = f"{k} local fix{'' if k == 1 else 'es'}"
    if k and d.get("unchecked"):
        # the checks could not run: the fixes stay set aside, and the next carry checks them
        it = "it" if k == 1 else "them"
        para = textwrap.wrap(f"{n.capitalize()} {'is' if k == 1 else 'are'} off: thimble could not check {it} on "
                             f"{d['to']} ({d['unchecked']}). thimble fixes checks {it} again.", 88,
                             break_on_hyphens=False, break_long_words=False)
        para[0] = para[0].replace(n.capitalize(), c("bold", n.capitalize()), 1)
        out += ["", *para]
    elif k:
        para = textwrap.wrap(f"{n.capitalize()} {'does' if k == 1 else 'do'} not fit {d['to']}, so "
                             f"{'it is' if k == 1 else 'they are'} off: {_named(d['aside'], titles)}.", 88)
        para[0] = para[0].replace(n.capitalize(), c("bold", n.capitalize()), 1)
        out += ["", *para, "", f"{c('title', 'Bring them back:' if k > 1 else 'Bring it back:')}  {c('cmd', 'thimble reapply')}",
                c("dim", f"  Claude opens, checks each fix against {d['to']}, keeps what is still needed, and turns it on.")]
    out += ["", f"{c('title', 'Then')}  Terminal: {c('cmd', '/reload-plugins')} in Claude Code"
            + (f" · Browser: restart {c('cmd', 'thimble-browser')}" if both else "")]
    return out


def _carried_lines(c: dict[str, Any], where: str = "update") -> list[str]:
    """What carry() did, a line each, wrapped: the fixes on again (or kept off, as the person had them), those the
    release has, those off because they do not fit it (or because thimble could not check them), and how to load them.
    where: "update" (thimble update, thimble fix carry), "list" (thimble fixes: its table names the fixes, and the
    lines under it say why one is off), "reapply" (Claude opens next for the fixes that are off) or "browser"
    (thimble-browser's start, which builds the page next)."""
    import textwrap  # noqa: PLC0415

    v, t = f"thimble {c['to']}", c.get("titles") or {}
    lines: list[str] = []
    k = len(c.get("aside") or [])
    if c.get("unchecked"):
        lines.append(f"{'Your fix stays' if k == 1 else f'Your {k} fixes stay'} off: thimble could not check "
                     f"{'it' if k == 1 else 'them'} on {v} ({c['unchecked']}).")
    if c.get("back"):
        n = len(c["back"])
        if c.get("off"):
            how = "stays off, as you had it" if n == 1 else "stay off, as you had them"
        else:
            how = "is on again" if n == 1 else "are on again"
        if where == "list":
            who = f"Fix {c['back'][0]} fits" if n == 1 else f"Fixes {_and([str(i) for i in c['back']])} fit"
            lines.append(f"{who} {v} and {how}.")
        else:
            lines.append(f"{'Your fix fits' if n == 1 else f'Your {n} fixes fit'} {v} and {how}: {_named(c['back'], t)}.")
    if c.get("had"):
        leave = "it leaves" if len(c["had"]) == 1 else "they leave"
        lines.append(f"Already in {v}, so {leave} thimble fixes: {_named(c['had'], t)}.")
    if k and not c.get("unchecked") and where != "list":
        lines.append(f"Off, as {'it does' if k == 1 else 'they do'} not fit {v}: {_named(c['aside'], t)}."
                     + ("" if where == "reapply" else f" thimble reapply has Claude fit {'it' if k == 1 else 'them'}."))
    if c.get("sync_error"):
        lines.append(f"Claude Code did not copy them yet ({c['sync_error']}); your next Claude Code session does.")
    # a path or a name with hyphens stays whole
    out = [w for line in lines for w in textwrap.wrap(line, 88, break_on_hyphens=False, break_long_words=False)]
    if c.get("reload"):
        out.append("In Claude Code, type /reload-plugins to load them" + (
            "; restart thimble-browser for the browser." if where != "browser" and c.get("browser") in ("stale", "ready")
            else "."))
    return out


def continue_() -> dict[str, Any]:
    """thimble update --continue: in the session thimble reapply opened, Claude brought back the set-aside fixes that the
    release still needs, one commit per fix with the fix's title. Each such commit becomes its fix's new version, and the
    fix is on, with no key press. A set-aside fix with no commit is left out: the release does it, or it cannot work
    there, and it leaves the list. A commit that is no set-aside fix's, that changes a file no fix may change
    (PROTECTED), or that changes a file the person is told of before they use a fix (NOTICE_KINDS) which its fix did not
    change before they used it, stops it with nothing recorded, so mine holds only recorded fixes, each with nothing
    the person was not told of."""
    cur = read_json(home() / "pending" / "current.json")
    if not cur:
        raise FixError("no fixes are set aside, so there is nothing to record; thimble update looks for a new release")
    live = live_dir()
    with Lock():
        _way_back()
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
            # of the files the person is told of (the sandbox, the hooks file, the launcher and the rest), only those the
            # fix changed when they used it, which its line named
            had = {*((recs[fid].get("pending") or {}).get("files") or []), *_set_aside_files(fid)}
            new = notice_of([f["path"] for f in files if f["path"] not in had])
            if new:
                what = _and([f"{k} ({_and(ps)})" for k, ps in new.items()])
                raise FixError(f"commit {c[:7]} (“{short(subject, 50)}”) changes {what}, which the fix did not change "
                               "before: such a change goes on only after the person reads of it and presses y. Take "
                               "that part out, or leave the fix out and tell the person that /thimble-fix makes it "
                               "again, then run thimble update --continue again")
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
        off = not is_on()
        if off:
            # every fix is off, as the person had them: the fixes Claude brought back wait in mine for thimble fix on
            _unstamp()
            git("checkout", "-q", "--detach", release()["base"], cwd=live, hooks=False)
        synced = _sync() if found and not off else {"reload": False}
    browser = browser_on_live() if found and not off else {}
    recs = records()
    lines = []
    if found:
        on = "; ".join(f"{recs[f]['title']} ({c[:7]})" for f, c, _ in found)
        lines.append(f"Recorded {len(found)} fix{'' if len(found) == 1 else 'es'} on thimble {version}, "
                     f"{'kept off, as you had your fixes; thimble fix on turns them on' if off else 'now on'}: {on}.")
    if left:
        lines.append(f"Left out: {'; '.join(recs[i]['title'] for i in left)}. {'It leaves' if len(left) == 1 else 'They leave'} "
                     f"thimble fixes ({version} does {'it' if len(left) == 1 else 'them'}, or {'it' if len(left) == 1 else 'they'} "
                     f"cannot work there); thimble fix show {left[0]} still shows {'it' if len(left) == 1 else 'each one'}.")
    if browser.get("browser") == "failed":
        lines.append(f"The browser workbench was not rebuilt: {browser.get('browser_error')}.")
    if found and not off:
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
    word = WORD.get(str(r.get("state")), str(r.get("state")))
    # a fix changed in place while its version before stays on: "on · changing", "on · change ready"
    if (r.get("prev") or {}).get("state") == "on" and r.get("state") in CHANGING:
        return f"on · {CHANGING[r['state']]}"
    return word


CHANGING = {"working": "changing", "ready": "change ready", "failed": "change failed"}


def listing(carry_now: bool = False, say=None) -> dict[str, Any]:
    """The fixes as the list shows them, after strays folded into their fixes (fold_strays). With carry_now (thimble
    fixes in a shell), first the fixes an update set aside that still fit go on again (carry, which says what it did
    here once: `carried`, or why it could not: `carry_error`); a list for the plugin or the workbench never carries, and
    says what carry would do (`due`: carry_due), which the plugin's session start runs."""
    carried, carry_error = None, None
    if carry_now:
        try:
            carried = carry(say=say)
        except (FixError, OSError, subprocess.SubprocessError) as e:
            carry_error = str(e) or type(e).__name__
    folded: list[dict[str, Any]] = []
    if any(r.get("refines") is not None and not r.get("fold_conflict") and r.get("state") in REFINABLE
           for r in records().values()):
        try:
            folded = fold_strays()
        except (FixError, OSError, subprocess.SubprocessError):
            folded = []
    recs = [r for r in records().values() if r.get("state") not in ("removed", "released", "merged")]
    recs.sort(key=lambda r: (ORDER.get(str(r.get("state")), 6), r["id"]))
    rel = release()
    on = is_on()
    # the thimble that runs; when nothing names it, live's release
    version = running_name(rel) or (release_name(rel) if rel else "")
    return {"fixes": recs, "on": on, "live": str(live_dir()), "version": version,
            "base": rel.get("base") or "", "kind": rel.get("kind") or "", "pointed": bool(rel.get("pointed")),
            "count_on": sum(r.get("state") == "on" for r in recs),
            "aside": [r["id"] for r in recs if r.get("state") == "pending"], "folded": folded, "carried": carried,
            "carry_error": carry_error, "due": None if carried else carry_due()}


def can_share() -> bool:
    """Whether this thimble has `thimble file issue` and `thimble file pr` (kernel/share.py)."""
    return (Path(__file__).resolve().parent / "share.py").is_file()


class Paint:
    """Colors for a terminal (titles in bold purple, on in green, commands in purple, the rest dim), in the terminal's
    own palette so that they read on a light theme and a dark one, and plain text for a pipe, NO_COLOR, or Claude's
    Bash tool, which reads the same words."""

    CODES = {"title": "1;35", "green": "32", "dim": "90", "cmd": "35", "bold": "1"}

    def __init__(self, on: bool | None = None):
        if on is None:
            on = sys.stdout.isatty() and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"
        self.on = on

    def __call__(self, kind: str, text: str) -> str:
        return f"\x1b[{self.CODES[kind]}m{text}\x1b[0m" if self.on and text else text


def _state_paint(c: Paint, r: dict[str, Any], on: bool, width: int = 0) -> str:
    w = state_word(r) if on or r.get("state") != "on" else "off"
    kind = "green" if w.startswith("on") else "dim" if w == "off" else "bold"
    return c(kind, f"{w:<{width}}") if width else c(kind, w)


def list_lines(width: int | None = None, paint: Paint | None = None) -> list[str]:
    """thimble fixes (thimble fix list): the person's fixes that are not in the release, one row each (number, state,
    title, date made, the start of their words), then what they can do next. In a shell, the fixes an update set aside
    that still fit go on again first (carry), and its lines come first; inside Claude Code, whose session start does
    that, a line says that they wait."""
    c = paint or Paint(False)
    d = listing(carry_now=not in_claude_code(), say=_tell)
    width = width or shutil.get_terminal_size((100, 24)).columns
    fixes = d["fixes"]
    # thimble 0.10.3, or thimble alone when nothing names the release
    name = f"thimble {d['version']}" if d["version"] else "thimble"
    # what carrying the fixes an update set aside did as the list was read, first, or why it did not
    said = _carried_lines(d["carried"], "list") if d.get("carried") else []
    if d.get("carry_error"):
        said = [f"thimble could not put back the fixes the update set aside: {d['carry_error']}"]
    elif (d.get("due") or {}).get("n") and d["due"].get("on"):
        # an update by an older thimble put them back with no check (_unchecked_on)
        k = d["due"]["n"]
        said = [f"{'Your fix is' if k == 1 else f'Your {k} fixes are'} on with no check on thimble {d['due']['to']} yet: "
                f"thimble fixes, in a shell, checks {'it' if k == 1 else 'them'}."]
    elif (d.get("due") or {}).get("n"):
        k = d["due"]["n"]
        said = [f"{'Your fix waits' if k == 1 else f'Your {k} fixes wait'} for a check on thimble {d['due']['to']}: "
                f"thimble fixes, in a shell, puts back {'it if it fits' if k == 1 else 'those that fit'}."]
    said = [*said, ""] if said else []
    if not fixes:
        return [*said, f"{c('title', 'Your thimble fixes')} · {name} with no fixes of yours"]
    words = {r["id"]: (state_word(r) if d["on"] or r.get("state") != "on" else "off") for r in fixes}
    titles = {r["id"]: r["title"] for r in fixes}
    counts: dict[str, int] = {}
    for w in words.values():
        w = w.split(" · ")[0]
        counts[w] = counts.get(w, 0) + 1
    parts = [c("green", f"{counts.pop('on')} on")] if "on" in counts else []
    parts += [f"{n} {w}" for w, n in counts.items()]
    out = [*said, f"{c('title', 'Your thimble fixes')} · {name} with {', '.join(parts)}", ""]
    iw = max(1, *(len(str(r["id"])) for r in fixes))
    sw = max(6, *(len(w) for w in words.values()))
    tw = min(40, max(3, *(len(t) for t in titles.values())))
    # a fix made in thimble's browser workbench says so after its date, in a small tag
    tag = " browser"
    mw = 5 + (len(tag) if any(r.get("made_in") == "browser" for r in fixes) else 0)
    out.append(c("dim", f"  {'#':>{iw}}  {'state':<{sw}}  {'fix':<{tw}}   {'made':<{mw}}   you asked"))
    for r in fixes:
        made = f"{_date(r.get('created')):<5}"
        where = tag if r.get("made_in") == "browser" else ""
        row = f"  {r['id']:>{iw}}  {words[r['id']]:<{sw}}  {short(titles[r['id']], tw):<{tw}}   {made + where:<{mw}}   "
        room = max(16, width - len(row) - 1)
        asked = f'"{short(_first_line(r), room - 2)}"' if _first_line(r) else ""
        out.append(f"  {r['id']:>{iw}}  {_state_paint(c, r, d['on'], sw)}  {short(titles[r['id']], tw):<{tw}}   "
                   f"{made}{c('dim', where)}{' ' * (mw - len(made) - len(where))}   {asked}".rstrip())
    prs = [r for r in fixes if r.get("pr")]
    if prs:
        out += ["", *[c("dim", f"  fix {r['id']} has a pull request: {r['pr']}") for r in prs]]
    # a fix set aside at an update, and why: one that did not fit the release
    unfit = [r for r in fixes if r.get("state") == "pending" and r.get("error")]
    if unfit:
        out += ["", *[c("dim", f"  fix {r['id']} is off: {r['error']}") for r in unfit]]
    on_ids = [r["id"] for r in fixes if words[r["id"]] == "on"]
    off_ids = [r["id"] for r in fixes if r.get("state") in ("off", "ready")]
    first = fixes[0]["id"]
    nxt: list[tuple[str, str]] = []
    if d["aside"]:
        k = len(d["aside"])
        nxt.append(("thimble reapply", f"Claude brings back the {k} fix{'' if k == 1 else 'es'} thimble update set aside"))
    nxt.append((f"thimble fix show {first}", f"what fix {first} does, in a few lines"))
    if on_ids:
        n = on_ids[0]
        nxt.append((f"thimble fix off {n}", f"turn a fix off; {c('cmd', f'thimble fix on {n}')} turns it back on"))
    elif off_ids:
        nxt.append((f"thimble fix on {off_ids[0]}", "turn a fix on (it asks for your key here)"))
    if can_share():
        nxt.append((f"thimble file issue {first}",
                    f"a link to GitHub's new-issue form with fix {first}'s text, to read and submit"))
        code = [r["id"] for r in fixes if r.get("state") in ("on", "ready") and r.get("commit") and not r.get("pr")]
        if code:
            nxt.append((f"thimble file pr {code[0]}", f"open a pull request with fix {code[0]}'s code (asks first)"))
    nxt.append((f"thimble fix remove {first}", "delete a fix"))
    if not d["aside"]:
        nxt.append(("thimble update", "get the newest thimble and keep your fixes"))
    cw = max(len(k) for k, _ in nxt) + 4
    out += ["", c("title", "What next")]
    out += [f"  {c('cmd', k)}{' ' * (cw - len(k))}{v}" for k, v in nxt]
    return out


def _wrapped(label: str, text: str, width: int) -> list[str]:
    import textwrap  # noqa: PLC0415

    # a path stays whole (package-lock.json)
    body = textwrap.wrap(text, max(30, width - 16), break_on_hyphens=False) or [""]
    return [f"  {label:<12}  {body[0]}", *[f"  {'':<12}  {x}" for x in body[1:]]]


def show_lines(fid: int | str, width: int | None = None, paint: Paint | None = None) -> list[str]:
    """thimble fix show N: one fix in a few lines: its title and state, the person's words, what Claude did, how much it
    changed, and the commands that act on it."""
    c = paint or Paint(False)
    r = get(fid)
    width = min(width or shutil.get_terminal_size((100, 24)).columns, 100)
    made = f"{_date(r.get('created'))}, {r.get('made_in') or 'terminal'}"
    out = [f"{c('title', r['title'])} · fix {r['id']} · {_state_paint(c, r, is_on())} · {made}"]
    rounds_said = [(str(w).strip(), str(a or "").strip()) for w, a in zip(r.get("words") or [], _asked_of(r))]
    for i, (w, a) in enumerate(x for x in rounds_said if x[0] or x[1]):
        # the person's own words; on a record from before 0.10.6, also the words Claude wrote from them for the fixer
        # when they differ
        out += _wrapped("You asked" if i == 0 else "Then", f'"{" ".join((a or w).split())}"', width)
        if a and w and " ".join(a.split()) != " ".join(w.split()):
            out += _wrapped("Claude wrote", f'"{" ".join(w.split())}"', width)
    if str(r.get("summary") or "").strip():
        out += _wrapped("Claude did", " ".join(str(r["summary"]).split()), width)
    if r.get("pr"):
        out += _wrapped("Pull request", str(r["pr"]), width)
    files = r.get("files") or []
    p = r.get("pending") or {}
    if r.get("state") == "pending" and r.get("error"):
        # it did not fit the release when the update put the fixes back on it
        out += _wrapped("Set aside", str(r["error"]), width)
    elif r.get("state") == "pending":
        out += _wrapped("Set aside", f"at the update to {p.get('version') or release_name()}; thimble fixes, in a shell, "
                        "checks it and puts it back if it fits", width)
    elif r.get("state") == "released" and r.get("left_out"):
        out += _wrapped("Left out", f"when Claude brought your fixes back on {r.get('released_in')}: the release does "
                        "it, or it could not work there", width)
    elif r.get("state") == "released":
        out += _wrapped(f"In {r.get('released_in') or 'the release'}", "the release has this change", width)
    elif r.get("error"):
        out += _wrapped("Why", str(r["error"]), width)
    tests = {"passed": "tests pass", "failed": "tests fail", "skipped": "tests not run"}.get(str(r.get("tests") or ""), "")
    n = len(files) or len(p.get("files") or [])
    rounds = int(r.get("rounds") or 1)
    if n:
        out += _wrapped("Changed", " · ".join(x for x in (f"{n} file{'' if n == 1 else 's'}", tests,
                                                          f"{rounds} rounds" if rounds > 1 else "") if x), width)
    if notice_said(r):
        out += _wrapped("Note", notice_said(r), width)
    acts: list[tuple[str, str]] = []
    s = r.get("state")
    if s == "pending":
        acts.append(("thimble reapply", "Claude checks it against the release and brings it back"))
    if s in ("on", "off", "ready", "sent") and can_share():
        acts.append((f"thimble file issue {r['id']}",
                     "a link to GitHub's new-issue form with its text, to read and submit"))
    if s in ("on", "ready") and r.get("commit") and not r.get("pr") and can_share():
        acts.append((f"thimble file pr {r['id']}", "open a pull request with its code on the public repo (asks first)"))
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
        rounds = int(r.get("rounds") or 1)
        return ("waits for y" + (f" · {rounds} rounds" if rounds > 1 else "")) if r.get("tests") != "failed" else ""
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
    """The start of the first words of a fix: the person's own when thimble has them, else the words of its request."""
    words = r.get("words") or [""]
    first = next(iter(_asked_of(r)), None) or words[0]
    return next((x.strip() for x in str(first).splitlines() if x.strip()), "")


def diff_of(rec: dict[str, Any]) -> str:
    """The fix's change: its commit, from live, or what its copy holds now, with git on the copy's own entry
    (_own_git); '' for a copy git may not run in (_own_git, _nested_git)."""
    c = rec.get("commit")
    if c:
        return run(["git", "-c", "core.quotePath=false", "show", "--format=", "--no-color", "--no-ext-diff", c],
                   cwd=live_dir()).stdout
    g = _own_git(rec.get("work"))
    if g and not _nested_git(rec["work"]):
        return run(["git", "-c", "core.quotePath=false", "diff", "--no-color", rec["base"]], cwd=rec["work"],
                   env={**os.environ, **g}).stdout
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


def _named_files(st: Store) -> list[str]:
    """The files under the root whose names the scan takes out, relative: those the conversation read, and every file
    under it, unless the root holds the home folder (the home folder, /), whose walk would list every file of the
    machine before a word is printed."""
    from . import sources as S  # noqa: PLC0415

    read = {r for s in st.seen() for f in [s.get("file"), *(s.get("files") or [])] if f and (r := st.rel(str(f)))}
    if Path.home().resolve().is_relative_to(st.root):
        return sorted(read)
    return sorted(read | set(S.list_files(st.root)))


def session_terms(st: Store | None) -> dict[str, list[str]]:
    """The person's details for the scan, collected here and now: their machine (user, host, git identity, home) and,
    with a store, the folder under analysis (its path, file and folder names, _named_files) and the fields and values of
    the records Claude read this session."""
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
            rels = _named_files(st)
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
        raise FixError(f"fix {rec['id']} has no draft; thimble file issue {rec['id']} posts it as an issue")
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
        elif verb == "carry":
            # the plugin's session start (--json), and thimble-browser's start, which builds the page next
            r = carry(say=None if a.json else _tell)
            if a.json:
                out_json(r)
            elif r:
                print("\n".join(_carried_lines(r, "browser")))
        elif verb == "on":
            r = one_on(a.id) if a.id else all_on()
            print(r.get("said", ""))
            if r.get("reload"):
                print(RELOAD)
        elif verb == "new":
            out_json(new(stdin_text() or a.words or "", a.made_in, a.title, a.session, a.asked))
        elif verb == "round":
            out_json(round_(a.id, stdin_text() or a.words or "", a.session, a.asked))
        elif verb == "again":
            out_json(again(a.id, a.session))
        elif verb == "done":
            if a.cannot == "-":
                out_json(done(a.id, session=a.session, cannot=stdin_text() or "it cannot be done", within=a.within))
            else:
                summary = stdin_text() if a.summary == "-" else (a.summary or "")
                out_json(done(a.id, a.title, summary, a.request, not a.no_tests, session=a.session, within=a.within))
        elif verb == "shown":
            out_json(shown(a.id))
        elif verb == "apply":
            if a.ask == "-":
                out_json(apply(a.id, stdin_text()))
            else:
                r = apply_typed(a.id)
                print(f"✓ {r['title']} is on. In Claude Code, type /reload-plugins; restart thimble-browser." if r
                      else "Not applied; thimble fix apply asks again whenever you want.")
        elif verb == "merge":
            ids = [x for x in (a.id, a.hit, *(a.more or [])) if x]
            if a.ask == "-":
                out_json(merge(ids, stdin_text()))
            else:
                r = merge_typed(ids)
                print(r.get("said", ""))
                if r.get("reload"):
                    print(RELOAD)
        elif verb == "notnow":
            out_json(not_now(a.id))
        elif verb == "redo":
            out_json(redo(a.id, stdin_text() or a.words or "", a.session))
        elif verb in ("undo", "remove"):
            r = undo(a.id) if verb == "undo" else remove(a.id)
            # the plugin's keys read JSON; a person in a terminal reads a sentence
            if a.json or not sys.stdout.isatty():
                out_json(r)
            else:
                f = get(a.id) if verb == "undo" else None
                print(f"Removed fix {r['id']}, “{r['title']}”." if verb == "remove" else
                      f"Fix {r['id']}, “{r['title']}”, is back to its version before." if f and f.get("state") == "on" else
                      f"Fix {r['id']}, “{r['title']}”, is off; thimble fix on {r['id']} turns it back on.")
                if r.get("reload"):
                    print(RELOAD)
        elif verb == "sandbox":
            # the fixer's own shell: it may reach the package registries; the tests it runs reach nothing
            out_json(sandbox_argv(int(a.id), net=True))
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
            r = update(check=True, once=getattr(a, "once", False))
            lines = [r.get("line") or (f"thimble {r['to']} is out (you have {r['from']}): thimble update in a shell"
                                       if r["newer"] else f"thimble {r['from']} is the newest release.")]
        else:
            if in_claude_code():
                raise FixError(SHELL_ONLY.format(what="thimble update"))
            r = update(say=_tell)
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
        r = reapply_argv(say=_tell)
    except FixError as e:
        print(f"thimble reapply: {e}", file=sys.stderr)
        return 1
    if r.get("carried"):
        # the prompt alone goes to stdout with --print
        print("\n".join(_carried_lines(r["carried"], "reapply" if r["argv"] else "update")),
              file=sys.stderr if getattr(a, "print", False) else sys.stdout, flush=True)
    if r["argv"] is None:
        return 0
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
