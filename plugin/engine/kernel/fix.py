"""Fix it yourself: a person changes or reports thimble from inside thimble (`thimble fix`).

    $THIMBLE_HOME/fixes/<slug>/fix.json      the fix: slug, title, kind (fix|feature|report), base commit, branch,
                                             status, worktree, created, and after a send its links
    $THIMBLE_HOME/fixes/<slug>/worktree/     a git checkout of thimble at `base` on branch fix/<slug> (not for reports)
    $THIMBLE_HOME/fixes/<slug>/draft.json    the draft's parts before the scan, kept here so that Keep can put a term
                                             back; never shared
    $THIMBLE_HOME/fixes/<slug>/share/        issue.md, pr.md, diff.patch: the exact text a send uses; scan.json, the
                                             scan's hits; ask.json while a send waits for the person
    $THIMBLE_HOME/fixes/active               the slug whose plugin Claude Code loads, when one does
    $THIMBLE_HOME/fixes/release.json         the marketplace source to go back to on undo

Nothing leaves the machine without the person's yes: `send` and `keep` need the ask id, which only the person's key
or button passes (as `thimble label --answer`). The programs it runs can be replaced for tests: THIMBLE_GH (gh),
THIMBLE_CLAUDE (claude), and THIMBLE_GIT, the git that runs the one push.
"""
from __future__ import annotations

import getpass
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from . import privacy as P
from .store import Store, thimble_home

PLUGIN = Path(__file__).resolve().parents[2]
KINDS = ("fix", "feature", "report")


class FixError(Exception):
    """A step that cannot go on; its message is the one line the person or Claude reads, with the fix."""


# ------------------------------------------------------------------ places and programs


def fixes_home() -> Path:
    return thimble_home() / "fixes"


def fix_dir(slug: str) -> Path:
    return fixes_home() / slug


def gh() -> str:
    return os.environ.get("THIMBLE_GH") or "gh"


def claude() -> str:
    return os.environ.get("THIMBLE_CLAUDE") or "claude"


def push_git() -> str:
    return os.environ.get("THIMBLE_GIT") or "git"


def run(cmd: list[str], cwd: str | Path | None = None, env: dict[str, str] | None = None,
        check: bool = True) -> subprocess.CompletedProcess:
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    except FileNotFoundError:
        raise FixError(f"{cmd[0]} is not installed")
    if check and p.returncode != 0:
        err = (p.stderr or p.stdout).strip().splitlines()
        raise FixError(f"{' '.join(cmd[:3])} failed: {err[-1] if err else 'no message'}")
    return p


def git(*args: str, cwd: str | Path, env: dict[str, str] | None = None, check: bool = True) -> str:
    return run(["git", *args], cwd=cwd, env=env, check=check).stdout.strip()


def manifest() -> dict[str, Any]:
    try:
        return json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
    except (OSError, ValueError):
        return {}


def upstream() -> str:
    """owner/name of thimble's repository on GitHub, from the plugin's manifest."""
    m = re.search(r"github\.com[/:]([^/]+/[^/.]+)", str(manifest().get("repository") or ""))
    return m.group(1) if m else "safety-research/thimble"


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def plugins_dir() -> Path:
    return config_dir() / "plugins"


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


def load(slug: str) -> dict[str, Any]:
    fx = read_json(fix_dir(slug) / "fix.json")
    if not fx:
        names = ", ".join(all_slugs()) or "none yet"
        raise FixError(f"no fix {slug} (the fixes: {names})")
    return fx


def save(fx: dict[str, Any]) -> None:
    write_json(fix_dir(fx["slug"]) / "fix.json", fx)


def all_slugs() -> list[str]:
    d = fixes_home()
    return sorted(p.parent.name for p in d.glob("*/fix.json")) if d.is_dir() else []


def slugify(title: str, n: int = 40) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return (s[:n].rstrip("-") or "fix")


# ------------------------------------------------------------------ the source to copy


def find_source() -> tuple[Path, str, bool]:
    """(checkout, commit, managed): the git checkout this plugin came from and the commit it runs. managed is True
    when the checkout is Claude Code's own clone of the marketplace, which a fix copies rather than adds a worktree to.

    A Dev install, `--plugin-dir`, or a marketplace added from a folder (scripts/install.sh --local) runs the plugin in
    place from a clone: the plugin's parent folder is the checkout. A marketplace added from GitHub runs a copy of the
    plugin; Claude Code keeps the marketplace's clone and the installed commit in its plugins folder."""
    repo = PLUGIN.parent
    top = git("rev-parse", "--show-toplevel", cwd=repo, check=False)
    if top and Path(top).resolve() == repo.resolve():
        return repo, git("rev-parse", "HEAD", cwd=repo), False
    pd = plugins_dir()
    installed = (read_json(pd / "installed_plugins.json") or {}).get("plugins", {})
    entry = next((e for e in installed.get("thimble@thimble") or []
                  if Path(e.get("installPath") or "/nonexistent").resolve() == PLUGIN.resolve()),
                 (installed.get("thimble@thimble") or [{}])[0])
    loc = ((read_json(pd / "known_marketplaces.json") or {}).get("thimble") or {}).get("installLocation")
    if loc and git("rev-parse", "--git-dir", cwd=loc, check=False):
        sha = entry.get("gitCommitSha") or ""
        if not (sha and run(["git", "cat-file", "-e", sha + "^{commit}"], cwd=loc, check=False).returncode == 0):
            sha = git("rev-parse", "HEAD", cwd=loc)
        return Path(loc), sha, True
    raise FixError(f"this thimble ({PLUGIN}) was not installed from a git checkout, so there is no copy of its code to "
                   "change. A report needs none: thimble fix new \"...\" --kind report. To change thimble, install it "
                   "from a clone: git clone https://github.com/" + upstream() + ", then scripts/install.sh --local in it.")


# ------------------------------------------------------------------ new, status


def new(title: str, kind: str = "fix") -> dict[str, Any]:
    if kind not in KINDS:
        raise FixError(f"--kind is fix, feature or report, not {kind}")
    if not title.strip():
        raise FixError('give the fix a title in a few words: thimble fix new "Rows opens CSV files with ; between fields"')
    src = find_source() if kind != "report" else None
    base_slug = slugify(title)
    slug, i = base_slug, 2
    while fix_dir(slug).exists():
        slug, i = f"{base_slug}-{i}", i + 1
    d = fix_dir(slug)
    d.mkdir(parents=True)
    fx: dict[str, Any] = {"slug": slug, "title": title.strip(), "kind": kind, "base": None, "branch": None,
                          "status": "working", "created": time.time(), "worktree": None,
                          "version": manifest().get("version"), "repo": upstream(), "login": None}
    if src:
        checkout, base, managed = src
        wt = d / "worktree"
        branch = f"fix/{slug}"
        try:
            if managed:
                git("clone", "-q", "--local", "--no-checkout", str(checkout), str(wt), cwd=d)
                git("checkout", "-q", "-b", branch, base, cwd=wt)
            else:
                git("worktree", "add", "-q", "-b", branch, str(wt), base, cwd=checkout)
        except FixError as e:
            shutil.rmtree(d, ignore_errors=True)
            raise FixError(f"could not make the copy of thimble: {e}")
        fx.update(base=base, branch=branch, worktree=str(wt), source=str(checkout))
    save(fx)
    return fx


def status_lines(slug: str | None = None) -> list[str]:
    slugs = [slug] if slug else all_slugs()
    if not slugs:
        return ['No fixes yet. thimble fix new "what to change" starts one.']
    active = active_slug()
    out = []
    for s in slugs:
        fx = load(s)
        on = " · loaded in thimble" if s == active else ""
        out.append(f"{s}  {fx['kind']}  {fx['status']}{on}  {fx['title']}")
        if slug:
            if fx.get("worktree"):
                out.append(f"  copy: {fx['worktree']} (branch {fx['branch']}, from {str(fx['base'])[:9]})")
            share = fix_dir(s) / "share"
            hits = read_json(share / "scan.json")
            if hits is not None:
                out.append(f"  draft: {share} · the scan removed {sum(not h['kept'] for h in hits)} details")
            for k in ("pr_url", "issue_url", "file"):
                if fx.get(k):
                    out.append(f"  {k.replace('_url', '').replace('pr', 'pull request')}: {fx[k]}")
            if fx.get("error"):
                out.append(f"  last error: {fx['error']}")
    return out


# ------------------------------------------------------------------ use, undo


def active_slug() -> str | None:
    try:
        return (fixes_home() / "active").read_text().strip() or None
    except OSError:
        return None


def _marketplace_entry() -> dict[str, Any] | None:
    """The thimble marketplace's source as Claude Code records it ({source: github, repo} or {source: directory, path})."""
    src = ((read_json(plugins_dir() / "known_marketplaces.json") or {}).get("thimble") or {}).get("source")
    return src if isinstance(src, dict) else None


def _entry_of(source: str) -> dict[str, Any]:
    if re.match(r"^[\w.-]+/[\w.-]+$", source) and not Path(source).exists():
        return {"source": "github", "repo": source}
    if re.match(r"^[a-z]+://", source):
        return {"source": "git" if source.endswith(".git") else "url", "url": source}
    return {"source": "directory", "path": str(Path(source).expanduser().resolve())}


def _repoint(source: str, entry: dict[str, Any] | None = None) -> None:
    """Point the thimble marketplace at `source`. Claude Code also keeps the marketplace's source in its user settings
    (extraKnownMarketplaces) and refuses to add it again from another source until that entry changes, as its own
    message says. Removing the marketplace instead would uninstall thimble and delete its options. So the entry changes
    first, and nothing else in the file; then Claude Code adds the marketplace from the new source."""
    p = config_dir() / "settings.json"
    try:
        settings = json.loads(p.read_text())
    except FileNotFoundError:
        settings = None
    except (OSError, ValueError):
        raise FixError(f"thimble cannot read Claude Code's settings ({p}) to change where its marketplace reads from. "
                       f"Run: claude plugin marketplace add {source}")
    known = (settings or {}).get("extraKnownMarketplaces")
    if isinstance(known, dict) and isinstance(known.get("thimble"), dict):
        known["thimble"]["source"] = entry or _entry_of(source)
        tmp = p.with_suffix(".json.thimble-tmp")
        tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
        os.chmod(tmp, p.stat().st_mode & 0o777)
        tmp.replace(p)
    run([claude(), "plugin", "marketplace", "add", source])


def _marketplace_source() -> str | None:
    src = ((read_json(plugins_dir() / "known_marketplaces.json") or {}).get("thimble") or {}).get("source") or {}
    return src.get("repo") or src.get("url") or src.get("path")


def _installed() -> bool:
    return bool((read_json(plugins_dir() / "installed_plugins.json") or {}).get("plugins", {}).get("thimble@thimble"))


RELOAD = "It takes effect after /reload-plugins in the running session, or in a new session."


def _is_thimble(folder: str) -> bool:
    return (read_json(Path(folder).expanduser() / ".claude-plugin" / "plugin.json") or {}).get("name") == "thimble"


def _claude_argv() -> list[str] | None:
    """The command line of the Claude Code session that runs this command: the nearest `claude` among this process's
    parents (read with ps), or None when there is none (a test, the browser's server) or it cannot be read."""
    pid = os.getppid()
    for _ in range(12):
        if pid <= 1:
            return None
        try:
            out = subprocess.run(["ps", "-o", "ppid=", "-o", "args=", "-p", str(pid)], capture_output=True, text=True,
                                 timeout=5).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
        ppid, _, args = out.partition(" ")
        argv = args.split()
        if argv and Path(argv[0]).name == "claude" and argv[1:2] != ["plugin"]:
            return argv
        try:
            pid = int(ppid)
        except ValueError:
            return None
    return None


def plugin_dir_in(argv: list[str] | None, env_dirs: str = "") -> bool | None:
    """Whether a session with this command line (and CLAUDE_CODE_PLUGIN_DIRS) loads thimble from a folder; None when
    there is no session to read."""
    if any(_is_thimble(x) for x in env_dirs.split(os.pathsep) if x):
        return True
    if argv is None:
        return None
    dirs = [argv[i + 1] for i, x in enumerate(argv[:-1]) if x == "--plugin-dir"]
    dirs += [x.split("=", 1)[1] for x in argv if x.startswith("--plugin-dir=")]
    return any(_is_thimble(d) for d in dirs)


def _session_plugin_dir() -> bool | None:
    """Whether the Claude Code session that runs this command loads thimble with --plugin-dir: read from the
    session's own command line, since a --plugin-dir folder and a folder marketplace can be the same clone."""
    return plugin_dir_in(_claude_argv(), os.environ.get("CLAUDE_CODE_PLUGIN_DIRS") or "")


def from_plugin_dir() -> bool:
    """Whether this thimble runs from a folder given to Claude Code with --plugin-dir, not from an install. Claude Code
    loads such a folder before an installed plugin of the same name, for the whole session. An install runs either
    Claude Code's own copy in its plugins folder (a GitHub marketplace) or the plugin folder of a folder marketplace in
    place (scripts/install.sh --local, or a fix's copy that `use` turned on)."""
    seen = _session_plugin_dir()
    if seen is not None:
        return seen
    here = PLUGIN.resolve()
    try:
        here.relative_to(plugins_dir().resolve())
        return False
    except ValueError:
        pass
    # a fix's copy that `use` turned on through the marketplace: the session still runs it after an undo, until it reloads
    own = fix_of_plugin()
    if own and (read_json(fix_dir(own) / "fix.json") or {}).get("via") == "marketplace":
        return False
    src = _marketplace_source()
    if src and not re.match(r"^[a-z]+://|^[\w.-]+/[\w.-]+$", str(src)):
        try:
            if (Path(src).expanduser().resolve() / "plugin") == here and _installed():
                return False
        except OSError:
            pass
    return True


def fix_of_plugin() -> str | None:
    """The fix whose copy this thimble runs from, or None when it runs the release."""
    try:
        rel = PLUGIN.resolve().relative_to(fixes_home().resolve())
    except ValueError:
        return None
    parts = rel.parts
    return parts[0] if len(parts) >= 3 and parts[1] == "worktree" else None


def _restart(folder: str | Path) -> str:
    return f"claude --continue --plugin-dir {folder}"


def use(slug: str, plugin_dir: bool | None = None) -> str:
    """Turn the fix's copy on. An install (from GitHub, or a folder marketplace such as scripts/install.sh --local):
    point Claude Code's thimble marketplace at the copy, as install.sh --local does with a checkout. Claude Code reads a
    plugin from a folder marketplace in place, so later edits in the copy load on the next /reload-plugins too.
    A session started with --plugin-dir keeps that folder until it quits, whatever is installed: then nothing is
    installed, and the one line says the command that starts the session again with the copy."""
    fx = load(slug)
    if not fx.get("worktree"):
        raise FixError(f"{slug} is a request with no change: there is nothing to turn on")
    # plugin_dir: whether the caller is a Claude Code session started with --plugin-dir; None asks this plugin's own
    # place. A caller that is no Claude Code session (the browser's server, which runs from a checkout) passes False.
    if from_plugin_dir() if plugin_dir is None else plugin_dir:
        fx["status"] = "applied" if fix_of_plugin() == slug else "ready"
        fx["via"] = "plugin-dir"
        save(fx)
        if fix_of_plugin() == slug:
            return f"This session already runs the fix {slug}."
        return (f"This session loads thimble with --plugin-dir, which Claude Code keeps until it quits. To try the fix, "
                f"quit and run: {_restart(Path(fx['worktree']) / 'plugin')}")
    prev = _marketplace_source()
    rel = fixes_home() / "release.json"
    if prev and not str(prev).startswith(str(fixes_home())):
        write_json(rel, {"source": prev, "entry": _marketplace_entry()})
    _repoint(fx["worktree"])
    if not _installed():
        run([claude(), "plugin", "install", "thimble@thimble"])
    (fixes_home() / "active").write_text(slug + "\n")
    fx["status"] = "applied" if fx["status"] in ("working", "ready", "applied") else fx["status"]
    fx["via"] = "marketplace"
    save(fx)
    return f"thimble now runs the fix {slug} from {fx['worktree']}/plugin. {RELOAD} `thimble fix undo` goes back to the release."


def undo(plugin_dir: bool | None = None) -> str:
    if from_plugin_dir() if plugin_dir is None else plugin_dir:
        slug = fix_of_plugin()
        if not slug:
            return "This session runs no fix: thimble is the one --plugin-dir names."
        fx = load(slug)
        if fx["status"] == "applied":
            fx["status"] = "ready"
            save(fx)
        back = Path(fx.get("source") or "") / "plugin"
        return (f"This session loads the fix with --plugin-dir, which Claude Code keeps until it quits. To go back to "
                f"the release, quit and run: {_restart(back)}")
    slug = active_slug()
    rel = read_json(fixes_home() / "release.json") or {}
    prev = rel.get("source") or upstream()
    _repoint(prev, rel.get("entry") if rel.get("source") else None)
    run([claude(), "plugin", "marketplace", "update", "thimble"], check=False)
    run([claude(), "plugin", "update", "thimble@thimble"], check=False)
    try:
        (fixes_home() / "active").unlink()
    except OSError:
        pass
    if slug and fix_dir(slug).is_dir():
        fx = load(slug)
        if fx["status"] == "applied":
            fx["status"] = "ready"
            save(fx)
    return f"thimble is back to the release from {prev}. {RELOAD}"


# ------------------------------------------------------------------ a fix follows releases

FOLLOW_EVERY_S = 24 * 3600


def on_slug() -> str | None:
    """The fix that is on: the one the marketplace points at, or the one this session runs with --plugin-dir."""
    s = active_slug() or fix_of_plugin()
    return s if s and fix_dir(s).is_dir() else None


def _release_url(fx: dict[str, Any]) -> str:
    """Where the release comes from: the marketplace's source before the fix was turned on (GitHub, a URL, or a
    folder: a dev install's clone), else the checkout the copy came from."""
    src = (read_json(fixes_home() / "release.json") or {}).get("source") or fx.get("source") or upstream()
    if re.match(r"^[\w.-]+/[\w.-]+$", src) and not Path(src).exists():
        return f"https://github.com/{src}.git"
    return src


def _fetch_release(fx: dict[str, Any]) -> tuple[str, str]:
    """(commit, version) of the newest release, fetched into the copy (a read, never a write elsewhere)."""
    wt = fx["worktree"]
    git("fetch", "-q", "--no-tags", _release_url(fx), "HEAD", cwd=wt)
    commit = git("rev-parse", "FETCH_HEAD", cwd=wt)
    try:
        version = json.loads(git("show", f"{commit}:plugin/.claude-plugin/plugin.json", cwd=wt)).get("version") or "?"
    except (FixError, ValueError):
        version = "?"
    return commit, version


def _newer_known(fx: dict[str, Any]) -> bool:
    """Whether a newer release is known without the network: a dev install's clone has moved past the fix's base."""
    url = _release_url(fx)
    if not Path(url).is_dir():
        return False
    head = git("rev-parse", "HEAD", cwd=url, check=False)
    return bool(head) and head != fx["base"] and run(["git", "merge-base", "--is-ancestor", head, fx["base"]],
                                                       cwd=fx["worktree"], check=False).returncode != 0


def _quick_tests(wt: Path) -> bool:
    """The plugin's quick tests in the copy: the kernel's tests where this Python has pytest, else the copy's `thimble`
    command must start (THIMBLE_FIX_TESTS, a shell command, replaces them)."""
    import importlib.util  # noqa: PLC0415
    import sys  # noqa: PLC0415

    cmd = os.environ.get("THIMBLE_FIX_TESTS")
    py = sys.executable or "python3"
    if cmd:
        argv = ["sh", "-c", cmd]
    elif importlib.util.find_spec("pytest"):
        argv = [py, "-m", "pytest", "plugin/tests", "-q", "-x", "-p", "no:cacheprovider"]
    else:
        argv = [py, "plugin/engine/thimble.py", "--help"]
    try:
        return subprocess.run(argv, cwd=wt, capture_output=True, text=True, timeout=900).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _commit_local(wt: Path, slug: str) -> None:
    """The copy's change, committed on its own branch so that it can be replayed (a local commit; a send makes its own)."""
    git("add", "-A", cwd=wt)
    if run(["git", "diff", "--cached", "--quiet"], cwd=wt, check=False).returncode != 0:
        git("-c", "user.name=thimble", "-c", "user.email=thimble@localhost", "commit", "-q", "-m", f"thimble fix {slug}", cwd=wt)


def _back_to_release(fx: dict[str, Any], plugin_dir: bool | None = None) -> str:
    """Turn the fix off. An install goes back to the release at once; a --plugin-dir session needs the one command."""
    if fix_of_plugin() == fx["slug"] and (from_plugin_dir() if plugin_dir is None else plugin_dir):
        return f"; quit and run: {_restart(Path(fx.get('source') or '') / 'plugin')}"
    undo(plugin_dir)
    return ""


def follow(force: bool = False, plugin_dir: bool | None = None) -> str | None:
    """Keep the fix that is on with the newest release, in one line for the person, or None when no fix is on.

    At most once a day (or at once with force), thimble fetches the newest release and replays the fix's change on it
    in the copy. In the release already (the replay is empty): back to the plain release. Replays and the quick tests
    pass: the newest release plus the fix. Does not replay, or the tests fail: back to the plain release, the copy kept
    as it was for /thimble:fix to redo it."""
    slug = active_slug() if plugin_dir is False else on_slug()
    if not slug or not fix_dir(slug).is_dir():
        return None
    fx = load(slug)
    title, wt = fx["title"], Path(fx.get("worktree") or "")
    on_line = lambda v: f"thimble {v} + your fix '{title}' · u undo"  # noqa: E731
    if not fx.get("worktree"):
        return None
    stamps = read_json(fixes_home() / "follow.json") or {}
    if not force and time.time() - float(stamps.get(slug) or 0) < FOLLOW_EVERY_S and not _newer_known(fx):
        return on_line(fx.get("version") or "?")
    stamps[slug] = time.time()
    write_json(fixes_home() / "follow.json", stamps)
    try:
        commit, version = _fetch_release(fx)
    except FixError as e:
        return f"{on_line(fx.get('version') or '?')} (the newest release could not be fetched: {e})"
    base = fx["base"]
    if commit == base or run(["git", "merge-base", "--is-ancestor", commit, base], cwd=wt, check=False).returncode == 0:
        return on_line(fx.get("version") or version)
    _commit_local(wt, slug)
    before = git("rev-parse", "HEAD", cwd=wt)
    replayed = run(["git", "-c", "user.name=thimble", "-c", "user.email=thimble@localhost", "rebase", "-q", "--onto",
                    commit, base, fx["branch"]], cwd=wt, check=False).returncode == 0
    if not replayed:
        run(["git", "rebase", "--abort"], cwd=wt, check=False)
    elif run(["git", "diff", "--quiet", commit, "HEAD"], cwd=wt, check=False).returncode == 0:
        git("reset", "-q", "--hard", before, cwd=wt)
        how = _back_to_release(fx, plugin_dir)
        fx = load(slug)
        fx.update(status="merged", merged_in=version)
        save(fx)
        return f"Your fix '{title}' is in thimble {version}; you are on the release again{how}."
    elif _quick_tests(wt):
        fx.update(base=commit, version=version)
        save(fx)
        return on_line(version)
    else:
        git("reset", "-q", "--hard", before, cwd=wt)
    how = _back_to_release(fx, plugin_dir)
    fx = load(slug)
    fx.update(status="stale", stale_on=version)
    save(fx)
    return f"Your fix '{title}' no longer fits thimble {version}; you are on the release{how} · /thimble:fix to redo it"


def latest() -> str | None:
    """The fix that `/thimble:fix submit` means: the one turned on, else the newest that was neither sent nor dropped."""
    a = active_slug() or fix_of_plugin()
    if a and fix_dir(a).is_dir():
        return a
    open_ = [(load(s).get("created") or 0, s) for s in all_slugs() if load(s).get("status") not in ("sent", "dropped", "merged")]
    return max(open_)[1] if open_ else None


# ------------------------------------------------------------------ the draft and its scan


def _diff(wt: Path, base: str) -> str:
    """The copy's whole change from base, committed or not, new files too, without touching its index."""
    with tempfile.TemporaryDirectory() as d:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(d) / "index")}
        git("read-tree", "HEAD", cwd=wt, env=env)
        git("add", "-A", cwd=wt, env=env)
        diff = run(["git", "-c", "core.quotePath=false", "diff", "--cached", "--no-color", "--no-ext-diff", base],
                   cwd=wt, env=env).stdout
    # the blob ids name the files before the scan, so they go: git apply needs only the text
    return re.sub(r"^index [0-9a-f]+\.\.[0-9a-f]+.*\n", "", diff, flags=re.M)


def _known(fx: dict[str, Any]):
    """known(terms) for the scan: the terms that appear as whole words in thimble's source at the fix's base (never in
    the copy's new files, so a term Claude wrote into a fixture is still a hit)."""
    repo = fx.get("worktree") or fx.get("source")
    base = fx.get("base")
    if not repo:
        try:
            repo, base, _ = find_source()
        except FixError:
            repo = None

    def known(terms: list[str]) -> set[str]:
        terms = [t for t in terms if t and "\n" not in t]
        if not terms:
            return set()
        if repo and base:
            with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
                f.write("\n".join(terms) + "\n")
            try:
                p = run(["git", "grep", "-F", "-I", "-o", "-h", "-w", "--no-color", "-f", f.name, base, "--"],
                        cwd=repo, check=False)
            finally:
                os.unlink(f.name)
            return set(p.stdout.splitlines()) & set(terms)
        text = []
        for dp, dirs, files in os.walk(PLUGIN):
            dirs[:] = [x for x in dirs if x not in ("node_modules", ".venv", "__pycache__", ".git")]
            for fn in files:
                try:
                    text.append((Path(dp) / fn).read_text(errors="ignore"))
                except OSError:
                    pass
        big = "\n".join(text)
        return {t for t in terms if re.search(r"(?<![\w])" + re.escape(t) + r"(?![\w])", big)}
    return known


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


def session_terms(st: Store) -> dict[str, list[str]]:
    """The person's details for the scan, collected here and now and never stored outside the fix folder."""
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
    t["path"] |= {str(Path.home()), str(st.root)}
    t["folder"].add(st.root.name)
    def named(x: str) -> bool:  # a name of one or two letters, or a number, would match all over the text
        return len(x) >= 3 and not x.isdigit()

    for rel in S.list_files(st.root):
        parts = rel.split(os.sep)
        name = parts[-1]
        stem = name.rsplit(".", 1)[0]
        t["file"] |= {x for x in (name, stem) if named(x) and (x == name or len(x) >= 4)}
        t["folder"] |= {x for x in parts[:-1] if named(x)}
    fields: set[str] = set()
    values: set[str] = set()
    qdir = st.dir / "queries"
    for q in sorted(qdir.glob("r*.json")) if qdir.is_dir() else []:
        rec = read_json(q) or {}
        if rec.get("session") not in (st.session, None):
            continue
        for k in ("table", "samples", "keys"):
            _walk_strings(rec.get(k), fields, values)
    refs = [r for row in st.ledger() for r in row.get("shown") or []]
    for ref in refs[:2000]:
        try:
            for row in S.fetch(st.root, ref, 1):
                _walk_strings(row.value, fields, values)
        except Exception:  # noqa: BLE001 - a file that changed or went away since: its other rows still count
            continue
    t["field"] |= fields
    t["value"] |= values
    return {k: sorted(x for x in v if x) for k, v in t.items()}


def _split_draft(text: str, title: str) -> tuple[str, str, str]:
    lines = text.strip().splitlines()
    if lines and lines[0].startswith("# "):
        title, lines = lines[0][2:].strip(), lines[1:]
    body = "\n".join(lines)
    m = re.search(r"^##\s+Change\b.*$", body, re.M | re.I)
    if not m:
        return title, body.strip(), ""
    return title, body[:m.start()].strip(), body[m.start():].strip()


def _share_slug(title_after_scan: str) -> str:
    return slugify(re.sub(r"‹[^›]*›", " ", title_after_scan))


def _write_share(fx: dict[str, Any], parts: dict[str, str], hits: list[dict]) -> dict[str, str]:
    """Writes share/ from the draft's parts and hits; returns the parts after the scan."""
    d = fix_dir(fx["slug"]) / "share"
    d.mkdir(parents=True, exist_ok=True)
    out = P.apply(parts, hits)
    removed = sum(not h["kept"] for h in hits)
    foot = (f"\n\n---\nthimble {fx.get('version') or '?'} · {platform.system() or 'unknown OS'} · "
            f"{'a change' if 'pr' in out else 'a request'} from a tester\n"
            f"The privacy scan removed {removed} detail{'' if removed == 1 else 's'}, and the tester read this text "
            f"before it was sent.\n")
    (d / "issue.md").write_text(out["issue"].rstrip() + foot)
    if "pr" in out:
        (d / "pr.md").write_text(out["pr"].rstrip() + "\n")
        (d / "diff.patch").write_text(out.get("diff", ""))
    else:
        for name in ("pr.md", "diff.patch"):
            (d / name).unlink(missing_ok=True)
    write_json(d / "scan.json", hits)
    fx["share_branch"] = "fix/" + _share_slug(out["issue"].splitlines()[0].lstrip("# "))
    return out


def draft(slug: str, src: str | None, st: Store | None, *, text: str | None = None,
          terms: dict[str, list[str]] | None = None) -> dict[str, Any]:
    """Build the share from Claude's draft (the file `src`, or `text`): the issue, and when the copy has a change, the
    pull request and its diff. A fix whose copy has no change goes out as an issue alone: a request. The scan's
    session terms come from the kernel's records of the session (`st`), or from the caller (`terms`, the browser's)."""
    fx = load(slug)
    if text is None:
        try:
            text = Path(src or "").read_text()
        except OSError as e:
            raise FixError(f"cannot read the draft {src}: {e.strerror}")
    title, body, change = _split_draft(text, fx["title"])
    if not body:
        raise FixError("the draft has no issue text: write what happened, what was expected, and a reproduction on made-up data")
    parts = {"issue": f"# {title}\n\n{body}\n"}
    diff = ""
    if fx["kind"] != "report" and fx.get("worktree"):
        wt = Path(fx["worktree"])
        diff = _diff(wt, fx["base"])
    if diff.strip():
        if not change:
            raise FixError("the draft has no '## Change' section: add one that says what the change does and how it was tested")
        binary = re.findall(r"^Binary files (?:a/)?(\S+)", diff, re.M)
        if binary:
            raise FixError(f"the change has a binary file ({binary[0]}); a fix shares text changes only, so remove it or make it text")
        parts.update(pr=change + "\n", diff=diff, branch=fx["branch"],
                     commit=git("log", "--format=%B", f"{fx['base']}..HEAD", cwd=wt))
    elif change:
        # a request with no change: the "## Change" words, if any, belong to the issue
        parts["issue"] = f"# {title}\n\n{body}\n\n{change}\n"
    repo_paths = [(str(PLUGIN) + os.sep, "plugin/")]
    if fx.get("worktree"):
        repo_paths.append((fx["worktree"] + os.sep, ""))
    hits, notes = P.scan(parts, terms if terms is not None else session_terms(st), _known(fx), repo_paths,
                         allow=[fx.get("base") or ""])
    old = {(h["where"], h["found"]): h["kept"] for h in read_json(fix_dir(slug) / "share" / "scan.json") or []}
    for h in hits:
        h["kept"] = bool(old.get((h["where"], h["found"]))) and h["kind"] not in P.NEVER_KEPT
    write_json(fix_dir(slug) / "draft.json", {"parts": parts, "notes": notes})
    _write_share(fx, parts, hits)
    ask = {"id": "f" + secrets.token_hex(6), "created": time.time()}
    write_json(fix_dir(slug) / "share" / "ask.json", ask)
    fx["status"] = "drafted"
    fx.pop("error", None)
    save(fx)
    removed = sum(not h["kept"] for h in hits)
    if st is not None:
        st.emit({"kind": "fix_ask", "slug": slug, "ask": ask["id"], "fix_kind": fx["kind"], "title": fx["title"],
                 "removed": removed, "share": str(fix_dir(slug) / "share")})
    return {"removed": removed, "notes": notes, "hits": hits, "change": bool(diff.strip())}


def _check_ask(slug: str, ask_id: str | None) -> dict[str, Any]:
    ask = read_json(fix_dir(slug) / "share" / "ask.json")
    if not ask or not ask_id or ask.get("id") != ask_id:
        raise FixError(f"no draft of {slug} waits for the person with that id; only the person's choice in the preview sends it")
    return ask


def keep(slug: str, hit_id: str, ask_id: str | None, st: Store) -> str:
    _check_ask(slug, ask_id)
    fx = load(slug)
    d = fix_dir(slug)
    hits = read_json(d / "share" / "scan.json") or []
    h = next((h for h in hits if h["id"] == hit_id), None)
    if not h:
        raise FixError(f"no hit {hit_id} in the scan of {slug}")
    if h["kind"] in P.NEVER_KEPT:
        raise FixError("keys and tokens are never kept")
    h["kept"] = True
    _write_share(fx, (read_json(d / "draft.json") or {}).get("parts") or {}, hits)
    save(fx)
    st.emit({"kind": "fix_ask", "slug": slug, "ask": ask_id, "fix_kind": fx["kind"], "title": fx["title"],
             "removed": sum(not x["kept"] for x in hits), "share": str(d / "share"), "change": "keep"})
    return f"kept {h['found']!r} in the {h['where']}"


# ------------------------------------------------------------------ send, save as a file


def _file(fx: dict[str, Any]) -> Path:
    share = fix_dir(fx["slug"]) / "share"
    text = (share / "issue.md").read_text()
    if (share / "pr.md").exists():
        text += "\n\n# Pull request\n\n" + (share / "pr.md").read_text()
        text += "\n\n```diff\n" + (share / "diff.patch").read_text().rstrip("\n") + "\n```\n"
    dl = Path.home() / "Downloads"
    folder = dl if dl.is_dir() else share
    p = folder / f"thimble-{(fx.get('share_branch') or 'fix/fix').split('/', 1)[1]}.md"
    p.write_text(text)
    return p


def _gh_json(*args: str) -> Any:
    out = run([gh(), *args]).stdout
    try:
        return json.loads(out)
    except ValueError:
        raise FixError(f"gh {' '.join(args[:2])} gave no JSON: {out.strip()[:120]}")


def _send(fx: dict[str, Any]) -> list[str]:
    share = fix_dir(fx["slug"]) / "share"
    repo = fx.get("repo") or upstream()
    title = (share / "issue.md").read_text().splitlines()[0].lstrip("# ").strip()
    try:
        user = _gh_json("api", "user")
    except FixError as e:
        raise FixError(f"{e}. Sign in to GitHub with `gh auth login`, or save the draft as a file instead")
    login, uid = user.get("login"), user.get("id")
    if not login or not uid:
        raise FixError("gh api user gave no login; sign in with `gh auth login`")
    fx["login"] = login
    lines = []
    issue_body = (share / "issue.md").read_text().split("\n", 1)[1].lstrip("\n")
    if (share / "pr.md").exists():
        wt = Path(fx["worktree"])
        noreply = f"{uid}+{login}@users.noreply.github.com"
        run([gh(), "repo", "fork", repo, "--clone=false"])
        with tempfile.TemporaryDirectory() as d:
            env = {**os.environ, "GIT_INDEX_FILE": str(Path(d) / "index"), "GIT_AUTHOR_NAME": login,
                   "GIT_AUTHOR_EMAIL": noreply, "GIT_COMMITTER_NAME": login, "GIT_COMMITTER_EMAIL": noreply}
            git("read-tree", fx["base"], cwd=wt, env=env)
            p = run(["git", "apply", "--cached", str(share / "diff.patch")], cwd=wt, env=env, check=False)
            if p.returncode != 0:
                raise FixError("the previewed diff no longer applies to the release; run thimble fix draft again")
            tree = git("write-tree", cwd=wt, env=env)
            sha = run(["git", "commit-tree", tree, "-p", fx["base"], "-m", title], cwd=wt, env=env).stdout.strip()
        branch = fx.get("share_branch") or f"fix/{fx['slug']}"
        name = repo.split("/", 1)[1]
        run([push_git(), "-c", "credential.helper=", "-c", f"credential.https://github.com.helper=!{gh()} auth git-credential",
             "push", f"https://github.com/{login}/{name}.git", f"{sha}:refs/heads/{branch}"], cwd=wt)
        pr = run([gh(), "pr", "create", "--repo", repo, "--draft", "--head", f"{login}:{branch}", "--title", title,
                  "--body-file", str(share / "pr.md")]).stdout.strip().splitlines()
        fx["pr_url"] = pr[-1] if pr else ""
        lines.append(f"draft pull request: {fx['pr_url']}")
        issue_body += f"\nDraft pull request: {fx['pr_url']}\n"
    body = share / "issue-sent.md"
    body.write_text(issue_body)
    issue = run([gh(), "issue", "create", "--repo", repo, "--title", title, "--body-file", str(body)]).stdout.strip().splitlines()
    fx["issue_url"] = issue[-1] if issue else ""
    lines.append(f"issue: {fx['issue_url']}")
    return lines


def send(slug: str, answer: str, ask_id: str | None) -> list[str]:
    _check_ask(slug, ask_id)
    fx = load(slug)
    ask_file = fix_dir(slug) / "share" / "ask.json"
    if answer == "cancel":
        ask_file.unlink()
        fx["status"] = "applied" if active_slug() == slug else "ready"
        save(fx)
        return [f"The person chose not to send the draft now; it stays in {fix_dir(slug) / 'share'}."]
    if answer == "file":
        p = _file(fx)
        fx["status"], fx["file"] = "saved", str(p)
        save(fx)
        return [f"The person saved the draft as one file and sent nothing: {p}"]
    try:
        lines = _send(fx)
    except FixError as e:
        fx["error"] = str(e)
        save(fx)
        raise
    ask_file.unlink()
    fx["status"] = "sent"
    fx.pop("error", None)
    save(fx)
    if fx.get("pr_url"):
        return [f"The person sent the draft under their GitHub login: draft pull request {fx['pr_url']}, issue {fx['issue_url']}."]
    return [f"The person sent the report under their GitHub login: issue {fx['issue_url']}."]
