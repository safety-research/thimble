"""thimble install: what scripts/install.sh does to thimble's home and to Claude Code, one verb per step, in the order
the script runs them. The script checks what thimble needs, downloads the release with git and asks the person; these
verbs do the rest with the code thimble update uses, so that an install leaves the layout an update leaves: the
release in ~/.thimble/fixes/live (a git copy of it, where a fix is a commit), the plain release beside it in
~/.thimble/fixes/release, Claude Code's marketplace thimble on live, the workbench built in live/browser, and the
commands thimble and thimble-browser in ~/.local/bin.

    thimble install release --from DIR   DIR, the release the script downloaded, becomes live (ensure_live, as a fix
                                         makes it); an install that is there stays, with its fixes, and says what it is
                                         and whether a newer release is out; with --ref it first moves to that branch or
                                         tag, as thimble update moves to a release. Exit 3: every part is in place.
    thimble install name                 the release live is on, as the script's last lines name it
    thimble install plugin               Claude Code loads the plugin from live, with its settings as they were
    thimble install sandbox              the sandbox that cards run in, which draws a test card (setup.mjs)
    thimble install browser              the workbench's packages and page, in live/browser
    thimble install commands             thimble and thimble-browser in ~/.local/bin (--bin-dir), and the folders of an
                                         earlier install that nothing uses now
    --folder DIR                         plugin, sandbox, browser and commands from the clone DIR in place of live: the
                                         dev install (scripts/install.sh --local), as before 0.10.8
    thimble install switch --folder DIR  before the dev install's steps: the release installed in thimble's home goes
                                         aside, with its fixes, and this clone's fixes that were set aside come back
    thimble install launcher             not the script's: thimble-browser, run from live, points the launcher on PATH
                                         (--bin-dir) at live, when an install before 0.10.8 wrote it for its own folder

The dev install and the release install take turns in thimble's home: the one there goes aside, with its fixes, into a
dated folder beside them (fixes-release-<date> or fixes-dev-<date>), and the newest one of the other kind that was set
aside comes back (switch; release with --from).

Each verb prints its lines as the script lays them out, and adds what does not work yet to the file --notes names, one
line each, which the script prints last. --state names a file where a verb leaves what a later one says: where Claude
Code loaded thimble from before, and the folders of the earlier install. Both are files in the folder the script makes
for one install ($TMPDIR/thimble-install.XXXXXX), and no other. The verbs never run for a command in Claude Code's
sandbox, which the plugin runs outside it (handoff.py): there they would run code and write files where the command
chose.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import fixes as FX
from .store import thimble_home

# the line that marks a launcher the install wrote, which it may write again (an older install's has it too)
MARKER = "written by thimble scripts/install.sh"
PROBE_TIMEOUT_S = 600  # setup.mjs installs the sandbox runtime with npm, then draws a test card
IN_PLACE = 3  # release's exit code when every part is in place, and the script has nothing more to do
# the folder scripts/install.sh makes for one install in $TMPDIR (mktemp -d), which holds its --notes and --state
WORK = "thimble-install."
HANDED = ("thimble install does not run for a command in Claude Code's sandbox; run scripts/install.sh outside the "
          "sandbox.")


class Run:
    """What the verbs of one install share: the notes the script prints last, and the state one verb leaves for a later
    one ({before, old})."""

    def __init__(self, notes: str | None, state: str | None):
        self.notes, self.state = notes, state

    def note(self, text: str) -> None:
        line = f"Note: {text}"
        if not self.notes:
            print(line, flush=True)
            return
        with open(self.notes, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def get(self) -> dict[str, Any]:
        return (FX.read_json(Path(self.state)) or {}) if self.state else {}

    def put(self, **kw: Any) -> None:
        if self.state:
            FX.write_json(Path(self.state), {**self.get(), **kw})

    def old(self, folder: Path | str | None, clone: bool = False) -> None:
        """A folder of the earlier install, which the person may delete once nothing uses it (commands says which).
        clone: the clone of a dev install (scripts/install.sh --local), where the person works on thimble's code."""
        if folder:
            old, clones = self.get().get("old") or [], self.get().get("clones") or []
            if str(folder) not in old:
                self.put(old=[*old, str(folder)])
            if clone and str(folder) not in clones:
                self.put(clones=[*clones, str(folder)])


def say(line: str = "", end: str = "\n") -> None:
    print(line, end=end, flush=True)


def tilde(p: Path | str) -> str:
    return FX._tilde(str(p))


def same(a: Path | str | None, b: Path | str | None) -> bool:
    """Whether two paths name one folder (links followed), also when one is gone."""
    return bool(a) and bool(b) and os.path.realpath(str(a)) == os.path.realpath(str(b))


def listed(words: list[str]) -> str:
    """Words in a list: a, b and c."""
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def size(folder: Path) -> str:
    """How much disk `folder` takes, as `du` counts it (a file with two names once): 1.1 GB, or 640 MB."""
    p = subprocess.run(["du", "-sk", str(folder)], capture_output=True, text=True, check=False)
    kb = int(p.stdout.split()[0]) if p.stdout.split() and p.stdout.split()[0].isdigit() else 0
    return f"{kb / 1024 / 1024:.1f} GB" if kb >= 1000 * 1024 else f"{round(kb / 1024)} MB"


def defaults(manifest: dict[str, Any]) -> list[str]:
    """--config KEY=VALUE for each setting of the plugin (its userConfig) with its default, as `claude plugin install`
    takes them: a string bare (quotes would be kept as part of it), a boolean as true or false. An empty default stays
    unset: Claude Code refuses an empty value, and one refused value drops them all. A fresh install gets them, so that
    no setting is left unset (settings/features.mjs, DEFAULTS)."""
    out: list[str] = []
    for key, field in (manifest.get("userConfig") or {}).items():
        d = field.get("default") if isinstance(field, dict) else None
        if isinstance(d, bool):
            out += ["--config", f"{key}={json.dumps(d)}"]
        elif d not in (None, ""):
            out += ["--config", f"{key}={d}"]
    return out


# ------------------------------------------------------------------ the release in ~/.thimble


def target(ref: str) -> dict[str, Any]:
    """The branch or tag `ref` of thimble's repository, as fixes.update takes it (`to`): {tag, name, ref, commit, url,
    version}, where tag is the release tag, or '' for a branch (or a tag that is no release, v0.11.0-rc1)."""
    url, name = FX.update_url(), ref.removeprefix("refs/heads/").removeprefix("refs/tags/")
    p = FX.remote_git("ls-remote", "--tags", "--heads", url, check=False, timeout=120)
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip().splitlines()
        raise FX.FixError(f"thimble could not read {url} ({err[-1] if err else 'no message'}); check the network, then "
                          "run the install again")
    refs: dict[str, str] = {}
    for line in p.stdout.splitlines():
        sha, _, at = line.partition("\t")
        if at.endswith("^{}"):
            refs[at[:-3]] = sha  # an annotated tag's commit wins over the tag object
        else:
            refs.setdefault(at, sha)
    for full in (f"refs/tags/{name}", f"refs/heads/{name}"):
        if full in refs:
            tag = name if full.startswith("refs/tags/") and FX.RELEASE_TAG.match(name) else ""
            sha = refs[full]
            return {"tag": tag, "name": name, "ref": full, "commit": sha, "url": url,
                    "version": tag[1:] if tag else f"{name} at {sha[:7]}", "tags": {}}
    raise FX.FixError(f"{url} has no branch or tag named {name}")


def reach_release(full_ref: str) -> None:
    """A branch's history in live back to the newest release, when the branch holds it, so that thimble update and a
    session's check can tell whether a release is newer than the branch (fixes._is_newer reads the history), where a
    copy one commit deep takes every release for newer. Done as well as the network lets it: nothing else changes."""
    live, url = FX.live_dir(), FX.update_url()
    try:
        tag = FX.latest_release(then="run the install again")["tag"]
    except FX.FixError:
        return
    FX.remote_git("fetch", "-q", "--depth", "1", "--no-tags", url, f"+refs/tags/{tag}:refs/tags/{tag}", cwd=live,
                  check=False, timeout=300)
    when = FX.git("log", "-1", "--format=%ct", f"refs/tags/{tag}", cwd=live, check=False)
    if when.isdigit():
        name = full_ref.removeprefix("refs/heads/").removeprefix("refs/tags/")
        FX.remote_git("fetch", "-q", "--no-tags", f"--shallow-since={int(when) - 1}", url,
                      f"+{full_ref}:refs/thimble/branches/{name}", cwd=live, check=False, timeout=600)


def release(a: Any, r: Run) -> int:
    """The release the script downloaded (--from) becomes live, with the release checkout beside it, as thimble's first
    fix makes them from Claude Code's copy (ensure_live). An install that is there stays (installed). A dev install's
    fixes (scripts/install.sh --local) go aside first, and a release install that --local set aside comes back in place
    of the download, with its fixes (the script then says that it downloaded the release for its install steps)."""
    rel, live = FX.release(), FX.live_dir()
    if rel and (live / ".git").exists() and rel.get("kind") != "clone":
        return installed(a, r, rel)
    if not a.from_:
        raise FX.FixError("thimble is not installed in this home, and no release was given to install (--from)")
    if rel and (live / ".git").exists():
        clone = tilde(rel.get("repo") or "")
        to = aside("dev")
        # the clone holds those fixes too (live is a worktree of it): it stays in use (unused)
        r.put(dev=rel.get("repo"))
        say(f"The fixes of your dev install are set aside in {tilde(to)}. scripts/install.sh --local in {clone} "
            "brings them back.")
    back = newest("release")
    if back:
        come_back(back, "dev")
        say(f"The release that scripts/install.sh --local set aside is back in {tilde(thimble_home())}, with its fixes.")
        got = installed(a, r, FX.release())
        # the script goes on to the plugin's step, which points Claude Code at it again
        return 0 if got == IN_PLACE else got
    src = Path(a.from_).resolve()
    commit = FX.git("rev-parse", "HEAD", cwd=src)
    with FX.Lock():
        if os.path.lexists(live):
            # a live thimble cannot use (no release.json it can read beside it, or no git copy) may hold the person's
            # fixes as commits: it goes aside, never away
            why = "had no release.json beside it that thimble could read" if not rel else "was no git copy"
            r.note(f"{tilde(live)} {why}, so the install moved it to {tilde(FX.live_aside())}, with any fixes in it.")
        rel = FX.ensure_live({"kind": "github", "repo": str(src), "commit": commit, "url": FX.update_url(),
                              "entry": None})
        # live's origin is thimble's repository; the download it came from goes after the install
        rel["repo"] = str(live)
        branch = ""
        if a.ref and not rel.get("tag"):
            branch = target(a.ref)["ref"]
            rel["ref"] = branch.removeprefix("refs/heads/").removeprefix("refs/tags/")
        FX.write_json(FX.home() / "release.json", rel)
    if branch:
        reach_release(branch)
    return 0


def installed(a: Any, r: Run, rel: dict[str, Any]) -> int:
    """An install in thimble's home: it stays, with its fixes. With --ref, it moves to that branch or tag first, as
    thimble update moves to a release. Then the line that says what it is, with the parts in place when they all are
    (exit IN_PLACE), and the newer release when one is out."""
    home = tilde(thimble_home())
    if a.ref:
        to = target(a.ref)
        if to["commit"] != rel["base"]:
            say(f"thimble {FX.release_name(rel)} is installed in {home}. It moves to {to['version']} now, and keeps "
                "your fixes (a few minutes)...")
            got = FX.update(to=to, say=FX._tell)
            lines = list(got.get("lines") or [])
            while lines and (not lines[-1].strip() or lines[-1].startswith("Then")):
                lines.pop()
            for line in lines:
                say(line)
            rel = FX.release()
            if rel.get("ref"):
                reach_release(to["ref"])
    whole = in_place(a.browser, bin_dir(a))
    parts = ("The plugin, the workbench and the commands are in place." if browser_ready() else
             "The plugin and the commands are in place.")
    say(f"thimble {FX.release_name(FX.release())} is installed in {home}." + (f" {parts}" if whole else ""))
    try:
        check = FX.update(check=True)
    except FX.FixError:
        check = {}
    if check.get("newer"):
        say(f"thimble {check['to']} is out: thimble update moves to it and keeps your fixes.")
    return IN_PLACE if whole else 0


def name(a: Any, r: Run) -> int:
    say(FX.release_name())
    return 0


# ------------------------------------------------------------------ what is in place


def bin_dir(a: Any) -> Path:
    return Path(a.bin_dir).expanduser() if a.bin_dir else Path.home() / ".local" / "bin"


def installed_in_claude_code() -> bool:
    got = FX.read_json(FX.plugins_dir() / "installed_plugins.json") or {}
    return bool((got.get("plugins") or {}).get("thimble@thimble"))


def from_folder(src: Any, folder: Path) -> bool:
    """Whether Claude Code's marketplace source `src` is the folder `folder`."""
    return isinstance(src, dict) and src.get("source") == "directory" and same(src.get("path"), folder)


def head_of(folder: Path) -> str:
    """The commit a checkout is on, as Claude Code records the copy it made of it (gitCommitSha)."""
    return FX.git("rev-parse", "HEAD", cwd=folder, check=False)


def browser_ready() -> bool:
    """Whether the workbench in live is built and runs from there (fixes.browser_on_live wrote browser-ready), with its
    server's packages compiled to bytecode (fixes.browser_compiled)."""
    b = FX.live_dir() / "browser"
    try:
        ready = (FX.home() / "browser-ready").read_text().strip()
    except OSError:
        return False
    return same(ready, b) and FX.browser_compiled(b) and (b / "frontend" / "dist" / "index.html").is_file()


def launcher_target(p: Path) -> str:
    """The thimble-browser that a launcher the install wrote starts ('' for another program, or none): its comment line
    has MARKER, and its exec line names the script in the shell's quotes (as the installs of 0.10.2 to 0.10.7 and
    launcher_text write it)."""
    try:
        lines = p.read_text().splitlines()
    except (OSError, UnicodeDecodeError):
        return ""
    if not any(x.startswith("#") and MARKER in x for x in lines):
        return ""
    for line in lines:
        if line.startswith("exec "):
            try:
                words = shlex.split(line[len("exec "):])
            except ValueError:
                return ""
            return words[0] if words else ""
    return ""


def launcher_text(to: Path) -> str:
    """The launcher thimble-browser as the install writes it: it starts the workbench's script `to`."""
    return (f"#!/bin/sh\n# thimble-browser, {MARKER}: starts the browser workbench in {tilde(to.parent.parent)}.\n"
            f"exec {shlex.quote(str(to))} \"$@\"\n")


def write_launcher(p: Path, to: Path) -> None:
    """The launcher `p` (launcher_text), written beside it first, so that a write that fails leaves it as it was."""
    tmp = p.with_name(f".{p.name}.install-tmp")
    tmp.write_text(launcher_text(to))
    tmp.chmod(0o755)
    tmp.replace(p)


def in_place(browser: bool, bin_: Path) -> bool:
    """Whether every part of the release install is in place: Claude Code loads the plugin from live, the workbench is
    built there when it is asked for (or there all the same), and the commands start them."""
    live = FX.live_dir()
    plugin = (FX.release().get("pointed") and from_folder(FX._marketplace().get("source"), live)
              and installed_in_claude_code())
    link = bin_ / "thimble"
    cli = link.is_symlink() and same(link, FX.release_dir() / "plugin" / "bin" / "thimble")
    ready = browser_ready()
    web = not ready or same(launcher_target(bin_ / "thimble-browser"), live / "browser" / "scripts" / "thimble-browser")
    return bool(plugin and cli and web and (ready or not browser))


# ------------------------------------------------------------------ the plugin


def source_words(src: dict[str, Any]) -> str:
    """Where Claude Code's marketplace came from, as the person reads it: GitHub, a folder, or a git URL."""
    if src.get("source") == "github":
        return "GitHub"
    if src.get("source") == "directory":
        return tilde(src.get("path") or "")
    return str(src.get("url") or src.get("repo") or "")


def plugin(a: Any, r: Run) -> int:
    """Claude Code loads the plugin from live (or the clone --folder names), with its own commands: the marketplace
    from that folder (add_marketplace, as thimble's first fix points it there), then the plugin updated from it, or,
    the first time, installed with each setting's default. The settings Claude Code keeps for it (pluginConfigs) stay
    as they are."""
    folder = Path(a.folder).resolve() if a.folder else None
    live, rel = FX.live_dir(), FX.release()
    to = folder or live
    where = tilde(folder) if folder else tilde(thimble_home())
    if folder and rel and (live / ".git").exists() and rel.get("pointed"):
        if rel.get("kind") != "clone" or not same(rel.get("repo"), folder):
            # switch sets that install aside before this step
            raise FX.FixError(f"Claude Code loads thimble from {tilde(live)}, another install, so this clone was not "
                              "installed. Run scripts/install.sh --local again: it sets that one aside first")
        # this clone's fixes, back from aside (switch): Claude Code loads them from live again, and copies them
        if not from_folder(FX._marketplace().get("source"), live):
            FX.add_marketplace(live, "to load thimble from your fixes")
            FX.run([FX.claude(), "plugin", "update", "thimble@thimble"])
        elif FX._installed_sha() != head_of(live):
            FX.run([FX.claude(), "plugin", "update", "thimble@thimble"])
        say(f"  Claude Code loads it from your fixes, in {tilde(live)}: thimble update moves them to this clone's "
            "commit.")
        return 0
    m = FX._marketplace()
    src = m.get("source") if isinstance(m.get("source"), dict) else {}
    had = installed_in_claude_code()
    if from_folder(src, to) and had:
        # Claude Code copies the folder again when it holds more than Claude Code's copy has: the clone, as the person
        # pulls and edits it, or live with another install in it now (a dev install's fixes went aside, release)
        if folder or FX._installed_sha() != head_of(to):
            FX.run([FX.claude(), "plugin", "update", "thimble@thimble"])
        say(f"  Claude Code loads it from {where}.")
    else:
        FX.add_marketplace(to, "to add thimble's plugin to it")
        if had:
            FX.run([FX.claude(), "plugin", "update", "thimble@thimble"])
        else:
            manifest = FX.read_json(to / FX.PLUGIN_JSON) or {}
            FX.run([FX.claude(), "plugin", "install", "thimble@thimble", *defaults(manifest)])
        say(f"  Added to Claude Code from {where}.")
        if had and src and not from_folder(src, to):
            r.put(before=source_words(src), now=where)
        if src.get("source") == "directory" and not same(src.get("path"), to):
            # a folder Claude Code loaded thimble from: a dev install's clone (scripts/install.sh --local)
            r.old(src.get("path"), clone=True)
    if not folder:
        rel = FX.release()
        if not rel.get("pointed"):
            FX.write_json(FX.home() / "release.json", {**rel, "pointed": True})
    settings = FX.read_json(FX.config_dir() / "settings.json") or {}
    if (settings.get("enabledPlugins") or {}).get("thimble@thimble") is False:
        r.note("thimble is turned off in Claude Code. Turn it on: claude plugin enable thimble@thimble")
    return 0


def sandbox(a: Any, r: Run) -> int:
    """The sandbox that cards run in: setup.mjs installs Anthropic's sandbox runtime at the plugin's pin and draws a
    test card in it, on this shell's node, and installs it again when its own files are broken (--repair)."""
    setup = (Path(a.folder) if a.folder else FX.live_dir()) / "plugin" / "sandbox" / "setup.mjs"
    node = shutil.which("node")
    d: dict[str, Any] = {}
    if node and setup.is_file():
        try:
            p = subprocess.run([node, str(setup), "--json", "--probe", "--repair"], capture_output=True, text=True,
                               timeout=PROBE_TIMEOUT_S, stdin=subprocess.DEVNULL)
            d = json.loads((p.stdout or "").strip().splitlines()[-1])
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            d = {}
    if d.get("ok"):
        say("  Cards run in Anthropic's sandbox runtime: it works here.")
        return 0
    missing = [str(x) for x in d.get("missing") or []]
    why = (f"{listed(missing)} {'is' if len(missing) == 1 else 'are'} missing" if missing else
           str(d.get("why") or "the check of the sandbox gave no answer").rstrip("."))
    fix = str(d.get("fix") or (f"See why: node {tilde(setup)} --probe" if setup.is_file() else ""))
    say("  Cards cannot draw here yet: the note at the end says why.")
    r.note(f"cards cannot draw yet: {why}." + (f" {fix}" if fix else ""))
    return 0


# ------------------------------------------------------------------ the workbench


def browser(a: Any, r: Run) -> int:
    """The workbench's packages and page: in live/browser by fixes.browser_on_live, which thimble update runs too (it
    links the packages of an earlier install's folder when their lock files are the same), or in the clone --folder
    names. Its home (~/.thimble-browser) is made first, readable by the person alone."""
    folder = Path(a.folder).resolve() if a.folder else None
    home = FX.browser_home()
    home.mkdir(parents=True, exist_ok=True)
    home.chmod(0o700)
    b = (folder or FX.live_dir()) / "browser"
    seed = FX._browser_seed()
    if not folder and browser_ready():
        say(f"  Its packages and page are in place, {size(b)}.")
    else:
        say("  Installing its packages and building its page (a few minutes)...", end="")
        try:
            if folder:
                env = {**os.environ, "NPM_CONFIG_UPDATE_NOTIFIER": "false"}
                for part, _, _ in FX.BROWSER_LOCKS:
                    FX.browser_packages(b, part, env)
                FX.browser_build(b, env)
            else:
                got = FX.browser_on_live()
                if got.get("browser") != "ready":
                    raise FX.FixError(got.get("browser_error") or f"{tilde(b)} holds no workbench")
        except FX.FixError as e:
            say(f" failed: {str(e).rstrip('.')}.")
            r.note(f"the workbench is not installed: {str(e).rstrip('.')}. After you fix that, run the install again.")
            return 1
        say(f" done, {size(b)}.")
    if folder:
        # thimble update links this clone's packages into live while their lock files are the same
        (home / "checkout").write_text(f"{b}\n")
    else:
        # the workbench runs from live now: an earlier install's folder is no longer its source
        if seed and not same(seed, b):
            r.old(seed.parent)
        (home / "checkout").unlink(missing_ok=True)
    return 0


# ------------------------------------------------------------------ the commands


def ours(p: Path) -> bool:
    """Whether the install may write `p`: nothing there, a link to a thimble launcher (plugin/bin/thimble), or a
    launcher it wrote (MARKER). Another program of that name stays as it is."""
    if p.is_symlink():
        return os.readlink(p).endswith("/plugin/bin/thimble")
    if not p.exists():
        return True
    return bool(launcher_target(p))


def folder_of(path: str, tail: str) -> str:
    """The thimble folder `path` is in, when it ends in `tail` (plugin/bin/thimble), else ''."""
    return path[: -len(tail) - 1] if path.endswith("/" + tail) else ""


def commands(a: Any, r: Run) -> int:
    """thimble and thimble-browser in bin_dir: thimble a link to the release checkout's launcher, which runs the way
    back from your fixes from the release and hands the other commands to live's (fixes._relink_cli keeps it there),
    and thimble-browser a launcher that starts live's workbench; cli-link names the link for thimble update. Then
    whether a new terminal finds them, and where Claude Code loaded thimble from before, with the folders that nothing
    uses now."""
    folder = Path(a.folder).resolve() if a.folder else None
    to_dir = bin_dir(a)
    to_dir.mkdir(parents=True, exist_ok=True)
    cli_to = (folder / "plugin" / "bin" / "thimble") if folder else FX.release_dir() / "plugin" / "bin" / "thimble"
    browser_to = (folder or FX.live_dir()) / "browser" / "scripts" / "thimble-browser"
    put: list[str] = []
    link = to_dir / "thimble"
    if ours(link):
        was = os.path.normpath(os.path.join(str(to_dir), os.readlink(link))) if link.is_symlink() else ""
        tmp = to_dir / ".thimble.install-tmp"
        tmp.unlink(missing_ok=True)
        tmp.symlink_to(cli_to)
        tmp.replace(link)
        (thimble_home()).mkdir(parents=True, exist_ok=True)
        (thimble_home() / "cli-link").write_text(f"{link}\n")
        put.append("thimble")
        r.old(folder_of(was, "plugin/bin/thimble"))
    else:
        r.note(f"{tilde(link)} is another program, so thimble's command was not put there. To put it in another "
               "folder, run the install again with --bin-dir FOLDER.")
    launcher = to_dir / "thimble-browser"
    if a.browser and ours(launcher):
        r.old(folder_of(launcher_target(launcher), "browser/scripts/thimble-browser"))
        write_launcher(launcher, browser_to)
        put.append("thimble-browser")
    elif a.browser:
        r.note(f"{tilde(launcher)} is another program, so the workbench's command was not put there. To put it in "
               "another folder, run the install again with --bin-dir FOLDER.")
    if put:
        say(f"The command{'s' if len(put) > 1 else ''} {listed(put)} {'are' if len(put) > 1 else 'is'} in "
            f"{tilde(to_dir)}.")
    if put and str(to_dir) not in os.environ.get("PATH", "").split(os.pathsep):
        r.note(f"{tilde(to_dir)} is not on your PATH, so a new terminal does not find {put[0]}. {path_line(to_dir)}")
    unused(a, r, folder)
    return 0


def path_line(to_dir: Path) -> str:
    """The step that puts `to_dir` on the PATH of a new terminal, for the person's shell ($SHELL)."""
    shell = os.path.basename(os.environ.get("SHELL") or "")
    home = str(Path.home())
    at = "$HOME" + str(to_dir)[len(home):] if str(to_dir).startswith(home + os.sep) else str(to_dir)
    if shell == "fish":
        return f"Run this once: fish_add_path {at}"
    rc = {"zsh": "~/.zshrc", "bash": "~/.bash_profile" if os.uname().sysname == "Darwin" else "~/.bashrc"}.get(shell)
    return f"Add this line to {rc or 'the startup file of your shell'}: export PATH=\"{at}:$PATH\""


def unused(a: Any, r: Run, folder: Path | None) -> None:
    """Where Claude Code loaded thimble from before this install moved it (plugin), and each folder of the earlier
    install that nothing uses now: not the plugin's marketplace, not a command's target, not the workbench's packages'
    source, not the clone whose dev install's fixes went aside (release), not in thimble's or Claude Code's own folders,
    and not a clone that holds work of the person's (holds_work)."""
    st = r.get()
    to_dir = bin_dir(a)
    m = FX._marketplace().get("source") or {}
    used: list[Any] = [folder, m.get("path") if isinstance(m, dict) else None, st.get("dev")]
    link = to_dir / "thimble"
    if link.is_symlink():
        used.append(folder_of(os.path.normpath(os.path.join(str(to_dir), os.readlink(link))), "plugin/bin/thimble"))
    used.append(folder_of(launcher_target(to_dir / "thimble-browser"), "browser/scripts/thimble-browser"))
    seed = FX._browser_seed()
    if seed:
        used.append(seed.parent)
    keep = [thimble_home(), FX.config_dir(), FX.browser_home()]
    gone: list[str] = []
    for p in st.get("old") or []:
        real = os.path.realpath(p)
        if not os.path.isdir(real) or any(same(p, u) for u in used if u):
            continue
        if any(real == os.path.realpath(k) or real.startswith(os.path.realpath(k) + os.sep) for k in keep):
            continue
        if real not in [os.path.realpath(g) for g in gone] and not holds_work(Path(real)):
            gone.append(p)
    before = st.get("before")
    if not before and not gone:
        return
    say()
    if before:
        say(f"Claude Code loaded thimble from {before}. It now loads it from {st.get('now') or tilde(thimble_home())}.")
    clones = st.get("clones") or []
    for p in gone:
        tail = ", so you can delete it" if not any(same(p, c) for c in clones) and nothing_to_lose(p) else ""
        say(f"{'  ' if before else ''}{tilde(p)} is no longer used{tail}.")


def nothing_to_lose(folder: str) -> bool:
    """Whether deleting `folder`, which nothing uses now, loses nothing that is not on its remote: a folder that is no
    git checkout (a release's archive), or the top of one with no change (an ignored file, such as the workbench's
    packages, aside), no stash, no commit that its remote's branches and tags do not hold, and no other worktree. A
    folder inside another repository, or one git cannot read, is not such a folder."""
    p = Path(os.path.realpath(folder))
    if not any((d / ".git").exists() for d in (p, *p.parents)):
        return True
    if not FX._own_checkout(p):
        return False
    for args in (["status", "--porcelain", "--untracked-files=normal"], ["stash", "list"],
                 ["rev-list", "-n", "1", "HEAD", "--branches", "--not", "--remotes", "--tags"]):
        got = FX.run(["git", "--no-optional-locks", *args], cwd=p, check=False)
        if got.returncode != 0 or got.stdout.strip():
            return False
    trees = FX.run(["git", "worktree", "list", "--porcelain"], cwd=p, check=False)
    return trees.returncode == 0 and trees.stdout.count("\nworktree ") == 0


def holds_work(folder: Path) -> bool:
    """Whether `folder` is a git checkout of its own with work of the person's in it that its remote does not hold
    (nothing_to_lose: changes, new files, a stash, commits of its own, another worktree), such as a dev install's clone
    (scripts/install.sh --local). The install does not name such a folder among those no longer used."""
    return FX._own_checkout(folder) and not nothing_to_lose(str(folder))


# ------------------------------------------------------------------ the dev install and the release take turns


def install_in(fixes: Path) -> dict[str, Any] | None:
    """The install a fixes folder holds, as its release.json says it: one that has live, else None."""
    rel = FX.read_json(fixes / "release.json")
    return rel if isinstance(rel, dict) and (fixes / "live" / ".git").exists() else None


def move(src: Path, dest: Path) -> None:
    """The fixes folder `src` moves to `dest`, and git's links between its checkouts follow it (git worktree repair):
    live, the release checkout and the copies of fixes are checkouts of one repository, live's own or, for a dev install,
    the person's clone, and each checkout and that repository name each other by path. The other files in it that name
    a path in it (release.json, off.sh, the records) are right again once it is back where it was."""
    old = os.path.realpath(src)
    new = os.path.join(os.path.realpath(dest.parent), dest.name)
    listed = FX.git("worktree", "list", "--porcelain", cwd=src / "live", check=False) if (src / "live").is_dir() else ""
    trees = [x[len("worktree "):] for x in listed.splitlines() if x.startswith("worktree ")]
    # each checkout where it is after the move; the first is the repository's own (live, or the clone)
    moved = [new + t[len(old):] if t == old or t.startswith(old + os.sep) else t for t in trees]
    os.rename(src, dest)
    linked = [m for t, m in zip(trees[1:], moved[1:]) if m != t and os.path.isdir(m)]
    if not linked:
        return
    p = FX.run(["git", *FX.NO_HOOKS, "worktree", "repair", *linked], cwd=moved[0], check=False)
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip().splitlines()
        raise FX.FixError(f"{tilde(src)} moved to {tilde(dest)}, and git could not repair the links of its checkouts "
                          f"({err[-1] if err else 'no message'}): git worktree repair does it, run in {tilde(moved[0])} "
                          "with the path of each checkout")


def aside(kind: str) -> Path:
    """The install in thimble's fixes folder goes aside, with its fixes, into a dated folder beside it,
    fixes-<kind>-<date>-<time> (kind release, or dev for a dev install's), while no change of live runs (FX.Lock)."""
    src = FX.home()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest, n = src.with_name(f"fixes-{kind}-{stamp}"), 1
    while dest.exists():
        n += 1
        dest = src.with_name(f"fixes-{kind}-{stamp}-{n}")
    with FX.Lock():
        move(src, dest)
    return dest


def newest(kind: str, clone: Path | None = None) -> Path | None:
    """The newest folder that aside made for `kind` and that still holds that install: the release's, or a dev
    install's (with `clone`, the dev install of that clone)."""
    found = None
    for p in sorted(thimble_home().glob(f"fixes-{kind}-*")):
        rel = install_in(p)
        if rel and (rel.get("kind") == "clone") == (kind == "dev") and (clone is None or same(rel.get("repo"), clone)):
            found = p
    return found


def come_back(src: Path, other: str) -> None:
    """The install `src`, which aside set aside, comes back as thimble's fixes folder. A fixes folder there with no
    install (what a first fix that failed leaves) goes aside first as `other`, or goes when it holds lock files alone."""
    home = FX.home()
    if home.exists():
        if all(f.suffix == ".lock" for f in home.rglob("*") if not f.is_dir()):
            shutil.rmtree(home)
        else:
            aside(other)
    move(src, home)


def switch(a: Any, r: Run) -> int:
    """scripts/install.sh --local, before the dev install's steps: the release installed in thimble's home goes aside,
    with its fixes, and so does a dev install of another clone; then this clone's dev install's fixes, set aside
    before, come back. A dev install of this clone stays as it is. Each move says where it went, in one line."""
    folder = Path(a.folder).resolve()
    rel = install_in(FX.home())
    first = True

    def tell(line: str) -> None:
        nonlocal first
        if first:
            say()
            first = False
        say(line)

    if rel and not (rel.get("kind") == "clone" and same(rel.get("repo"), folder)):
        if rel.get("kind") == "clone":
            clone = tilde(rel.get("repo") or "")
            tell(f"The dev install of {clone} is set aside, with its fixes, in {tilde(aside('dev'))}. "
                 f"scripts/install.sh --local in {clone} brings it back.")
        else:
            tell(f"The release installed in {tilde(thimble_home())} is set aside, with its fixes, in "
                 f"{tilde(aside('release'))}. The install without --local brings it back.")
        rel = None
    back = None if rel else newest("dev", folder)
    if back:
        come_back(back, "release")
        tell(f"The fixes of this clone's dev install, set aside before, are back in {tilde(thimble_home())}.")
    return 0


# ------------------------------------------------------------------ thimble-browser's launcher, after thimble update


def launcher(a: Any, r: Run) -> int:
    """thimble-browser's start from live runs this (the install script does not): the thimble-browser in --bin-dir, when
    an install wrote it (launcher_target) to start the workbench of another folder, starts live's from now on, as the
    install writes it, so that the folder can go. An install before 0.10.8 wrote it for the folder it installed from,
    whose script hands the workbench to live once thimble update has put it there. A dev install's (--local) starts its
    clone on purpose, and stays. Nothing is said unless the launcher cannot be written."""
    p = bin_dir(a) / "thimble-browser"
    to = FX.live_dir() / "browser" / "scripts" / "thimble-browser"
    was = launcher_target(p)
    rel = install_in(FX.home())
    if not was or p.is_symlink() or not rel or rel.get("kind") == "clone" or not browser_ready() or same(was, to):
        return 0
    try:
        write_launcher(p, to)
    except OSError as e:
        through = folder_of(was, "browser/scripts/thimble-browser") or was
        print(f"thimble-browser: {tilde(p)} could not be pointed at {tilde(FX.live_dir())} ({e.strerror or e}), so it "
              f"still starts the workbench through {tilde(through)}: keep that folder until it can.", file=sys.stderr)
        return 1
    return 0


VERBS = {"release": release, "name": name, "plugin": plugin, "sandbox": sandbox, "browser": browser,
         "commands": commands, "switch": switch, "launcher": launcher}


def in_work(path: str) -> bool:
    """Whether `path` is a file in a folder scripts/install.sh made for one install (WORK, in $TMPDIR or /tmp), links
    followed."""
    folder = Path(os.path.realpath(path)).parent
    return folder.name.startswith(WORK) and same(folder.parent, os.environ.get("TMPDIR") or "/tmp")


def cmd(a: Any) -> int:
    """thimble install VERB: see this file's text. A step that cannot go on says why, in its section's place (the
    script's sections indent their lines; thimble-browser's launcher, on stderr), and ends with 1. It never runs for a command in Claude Code's sandbox
    (THIMBLE_HANDED_OFF: the plugin's run of one, hooks/handoff.ts), and it writes --notes and --state only in the
    install's own folder (in_work)."""
    if os.environ.get("THIMBLE_HANDED_OFF"):
        say(HANDED)
        return 1
    for f in (a.notes, a.state):
        if f and not in_work(f):
            say(f"thimble install writes --notes and --state only in the folder scripts/install.sh makes for them "
                f"({tilde(os.path.join(os.environ.get('TMPDIR') or '/tmp', WORK + 'XXXXXX'))}), and {tilde(f)} is "
                "not in one.")
            return 1
    r = Run(a.notes, a.state)
    try:
        return VERBS[a.verb](a, r)
    except FX.FixError as e:
        why = str(e).rstrip(".")
        if a.verb == "launcher":
            print(f"thimble-browser: {why}.", file=sys.stderr)
        else:
            say(f"  {why}." if a.verb in ("plugin", "sandbox", "browser", "commands") else f"{why[:1].upper()}{why[1:]}.")
        return 1
