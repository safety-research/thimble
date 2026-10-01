"""The packages a view's page loads: thimble's own builds of vega, and any npm package the view names, vendored into
the view's folder so the frame still loads nothing from the network.

view.json's `libs` lists them in load order. `vega`, `vega-lite` and `vega-embed` are thimble's own (views.LIBS). Any
other entry is an npm package, `name@version` (a range, such as `d3-force@3`, takes the newest version it allows),
optionally with a file inside the package after it, `three@0.160.0/examples/jsm/controls/OrbitControls.js` or
`leaflet@1.9.4/dist/leaflet.css`.

Before a package is installed the analyst approves it, on the card of the view build's session (agent_session.ask,
forced in every permission mode), seeing its name, version and size and the packages it needs. thimble's `installs`
setting `allow` approves every one, and `deny` refuses them. An approval is kept per package and version in
APPROVALS_FILE under thimble's home, so the same version is never asked about twice.

Installing runs `npm install --ignore-scripts` (npm's own registry settings apply, and no package's install scripts
run) into a folder per package and version under thimble's home (PACKAGES_DIR), then bundles the package with esbuild
into one script, or one stylesheet for a .css entry, with its images and fonts inlined. The bundle is written to the
view's `lib/` folder beside LOCK_FILE, which maps each entry to its file. views.frame_document inlines those files into
the page in order: a script sets `window.__thimbleLibs[name]` (which thimble.lib(name) reads) and, when that name is
free, a global named after the package in camel case (`d3-force` as `d3Force`). A file entry's own imports of the
view's other packages resolve to those packages' globals, so it shares their instances.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import config
from .ledger import atomic_write_text, write_json

log = logging.getLogger("thimble.view_libs")

LIB_DIR = "lib"  # in a view's folder
LOCK_FILE = "libs.json"  # in LIB_DIR: {entry: {name, version, path, file, kind, global, bytes}}
APPROVALS_FILE = "packages.json"  # in thimble's home: {"approved": {"<name>@<version>": {at, bytes}}}
PACKAGES_DIR = "packages"  # in thimble's home: one npm install per package and version
BUILTIN = ("vega", "vega-lite", "vega-embed")
PACKAGE_TOOL = "ThimblePackage"  # the permission card's tool name (frontend chat/permissions.ts)
NPM_TIMEOUT_S = 300.0
DEPS_MAX = 200  # packages looked up for the size of what a package needs
LOOKUPS_AT_ONCE = 8
ENTRY_RE = re.compile(r"^(?P<name>(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*)"
                      r"(?:@(?P<range>[0-9A-Za-z.^~<>=*|+-]+))?(?P<path>(?:/[A-Za-z0-9._@+-]+)+)?$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$")
ASSET_LOADERS = ("png", "jpg", "jpeg", "gif", "svg", "webp", "woff", "woff2", "ttf", "otf", "eot")

PACKAGE_WHY = ("thimble installs it with npm, without running its install scripts, into the view's folder, so the page "
               "still loads nothing from the network. Each version is asked about once. Unanswered, it is refused after "
               "{wait}.")
UNANSWERED = "unanswered"  # an Ask's answer when nobody answered the card in time


@dataclass
class Entry:
    raw: str
    name: str
    range: str
    path: str  # a file inside the package, '' for the package itself

    @property
    def key(self) -> str:
        """The name thimble.lib knows it by: the package, or the package and the file."""
        return self.name + (f"/{self.path}" if self.path else "")

    @property
    def kind(self) -> str:
        return "css" if self.path.endswith(".css") else "js"


def parse(raw: Any) -> Entry | None:
    """An npm entry of `libs`, None for one of thimble's own or one that is no package name."""
    s = " ".join(str(raw or "").split())
    if not s or s in BUILTIN:
        return None
    m = ENTRY_RE.match(s)
    if m is None:
        return None
    return Entry(s, m["name"], m["range"] or "latest", (m["path"] or "").lstrip("/"))


def entries(libs: Any) -> list[str]:
    """`libs` as the list of its entries, each a string, in order, once each."""
    items = libs if isinstance(libs, list) else [libs] if isinstance(libs, str) else []
    out: list[str] = []
    for x in items:
        s = " ".join(str(x or "").split())
        if s and s not in out:
            out.append(s)
    return out


def problems(libs: Any) -> list[str]:
    """The entries that are neither thimble's own libraries nor an npm package, as lines for whoever wrote them."""
    bad = [e for e in entries(libs) if e not in BUILTIN and parse(e) is None]
    return [f"`libs` names {', '.join(map(repr, bad))}, which is neither {', '.join(BUILTIN)} nor an npm package as "
            "name@version"] if bad else []


def global_name(e: Entry) -> str:
    """The page's global for an entry: the package's name, or the file's, in camel case."""
    base = Path(e.path).stem if e.path else e.name.rsplit("/", 1)[-1]
    parts = [p for p in re.split(r"[^A-Za-z0-9]+", base) if p]
    if not parts:
        return "lib"
    name = parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])
    return f"_{name}" if name[0].isdigit() else name


def lock(folder: Path) -> dict[str, dict[str, Any]]:
    """The view's LOCK_FILE, {} when there is none."""
    try:
        raw = json.loads((folder / LIB_DIR / LOCK_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(k): v for k, v in raw.items() if isinstance(v, dict)} if isinstance(raw, dict) else {}


def vendored(folder: Path, entry: str) -> tuple[str, str] | None:
    """(kind, text) of an npm entry's bundle in the view's folder, None when it is not there."""
    item = lock(folder).get(entry)
    if not item:
        return None
    f = folder / LIB_DIR / str(item.get("file") or "")
    if f.parent != folder / LIB_DIR or f.is_symlink() or not f.is_file():
        return None
    return str(item.get("kind") or "js"), f.read_text("utf-8")


# ------------------------------------------------------------------------------------------------------ approvals

def _home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def _approvals_path() -> Path:
    return _home() / APPROVALS_FILE


def approvals() -> dict[str, dict[str, Any]]:
    try:
        raw = json.loads(_approvals_path().read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    got = raw.get("approved") if isinstance(raw, dict) else None
    return {str(k): v for k, v in got.items() if isinstance(v, dict)} if isinstance(got, dict) else {}


def approved(name: str, version: str) -> bool:
    return f"{name}@{version}" in approvals()


def approve(name: str, version: str, size: int) -> None:
    got = approvals()
    got[f"{name}@{version}"] = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "bytes": size}
    path = _approvals_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, {"approved": dict(sorted(got.items()))})


# ---------------------------------------------------------------------------------------------------------- npm

def _npm() -> str | None:
    return shutil.which("npm")


ESBUILD = config.REPO_ROOT / "frontend" / "node_modules" / "esbuild" / "bin" / "esbuild"


def _esbuild() -> Path | None:
    return ESBUILD if ESBUILD.is_file() else None


def build_problem() -> str:
    """Why packages cannot be installed here, '' when they can."""
    if _npm() is None:
        return "npm is not installed, so thimble cannot install packages for views"
    if _esbuild() is None:
        return "the frontend's esbuild is missing (run thimble's install again), so thimble cannot bundle packages"
    return ""


async def _run(argv: list[str], cwd: Path | None = None, timeout: float = NPM_TIMEOUT_S) -> tuple[int, str, str]:
    """(exit code, stdout, stderr) of a command. Tests replace it."""
    proc = await asyncio.create_subprocess_exec(*argv, cwd=str(cwd) if cwd else None, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _last_line(text: str) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("npm notice")]
    return " ".join(lines[-3:])[:400] if lines else ""


async def lookup(name: str, rng: str) -> dict[str, Any]:
    """{name, version, bytes, deps: {name: range}} of the newest version of `name` that `rng` allows, from the registry
    npm is set up with. LookupError when npm has no such package or version."""
    code, out, err = await _run([_npm() or "npm", "view", f"{name}@{rng}", "name", "version", "dist.unpackedSize",
                                 "dependencies", "--json"])
    if code != 0:
        raise LookupError(_last_line(err) or f"npm view {name}@{rng} failed")
    try:
        raw = json.loads(out) if out.strip() else None
    except ValueError:
        raw = None
    if isinstance(raw, list):
        raw = raw[-1] if raw else None
    if not isinstance(raw, dict) or not VERSION_RE.match(str(raw.get("version") or "")):
        raise LookupError(f"npm has no version of {name} that {rng} allows")
    deps = raw.get("dependencies") if isinstance(raw.get("dependencies"), dict) else {}
    size = raw.get("dist.unpackedSize")
    return {"name": str(raw.get("name") or name), "version": str(raw["version"]),
            "bytes": int(size) if isinstance(size, (int, float)) else 0, "deps": {str(k): str(v) for k, v in deps.items()}}


async def needs(deps: dict[str, str]) -> tuple[list[dict[str, Any]], bool]:
    """The packages `deps` brings in, each looked up once by name (the first range met wins), at most DEPS_MAX; and
    whether there were more."""
    seen: dict[str, dict[str, Any]] = {}
    todo = list(deps.items())
    more = False
    sem = asyncio.Semaphore(LOOKUPS_AT_ONCE)

    async def one(n: str, r: str) -> dict[str, Any] | None:
        async with sem:
            try:
                return await lookup(n, r)
            except LookupError:
                return None

    while todo:
        batch = []
        for n, r in todo:
            if n in seen or any(n == b[0] for b in batch):
                continue
            if len(seen) + len(batch) >= DEPS_MAX:
                more = True
                break
            batch.append((n, r))
        todo = []
        got = await asyncio.gather(*(one(n, r) for n, r in batch))
        for (n, _), info in zip(batch, got):
            seen[n] = info or {"name": n, "version": "?", "bytes": 0, "deps": {}}
            todo += list((info or {}).get("deps", {}).items())
    return list(seen.values()), more


def size_words(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} MB"
    if n >= 1000:
        return f"{round(n / 1000)} kB"
    return f"{n} bytes"


def _size_line(own: int, more: list[dict[str, Any]], extra: bool) -> str:
    """The card's size of a package with the packages it needs (needs): their sum when npm gave every size, else the
    package's own size alone, so the card shows no total that is not exact."""
    if not more:
        return size_words(own)
    count = f"more than {DEPS_MAX}" if extra else str(len(more))
    noun = "package" if count == "1" else "packages"
    if extra or any(x["version"] == "?" for x in more):
        return f"{size_words(own)} for the package itself, plus the {count} {noun} it needs"
    return f"{size_words(own + sum(int(x.get('bytes') or 0) for x in more))}, with {count} {noun} it needs"


def _stage(name: str, version: str) -> Path:
    return _home() / PACKAGES_DIR / f"{name.replace('/', '+')}@{version}"


_installing: dict[str, asyncio.Lock] = {}  # name@version -> held while npm installs it
_asking: dict[tuple[str, str], asyncio.Future] = {}  # (workspace, name@version) -> the question waiting


async def install(name: str, version: str) -> Path:
    """The folder npm installed `name@version` in (PACKAGES_DIR), installing it when it is not there, one install of a
    version at a time. RuntimeError with npm's words when it fails."""
    lock = _installing.setdefault(f"{name}@{version}", asyncio.Lock())
    async with lock:
        return await _install(name, version)


async def _install(name: str, version: str) -> Path:
    stage = _stage(name, version)
    done = stage / "node_modules" / name / "package.json"
    if done.is_file():
        return stage
    tmp = stage.with_name(stage.name + f".{os.getpid()}.tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    atomic_write_text(tmp / "package.json", json.dumps({"name": "thimble-view-package", "private": True}) + "\n")
    code, _, err = await _run([_npm() or "npm", "install", "--ignore-scripts", "--no-audit", "--no-fund",
                               "--no-package-lock", "--loglevel=error", f"{name}@{version}"], cwd=tmp)
    if code != 0 or not (tmp / "node_modules" / name / "package.json").is_file():
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError(_last_line(err) or f"npm install {name}@{version} failed")
    shutil.rmtree(stage, ignore_errors=True)
    os.replace(tmp, stage)
    return stage


WRAP_HEAD = "(function(require){\n"
WRAP_TAIL = """
;var L=__thimble_lib;
if(L&&L.__esModule&&'default' in L&&Object.keys(L).every(function(k){return k==='default'||k==='__esModule'}))L=L.default;
(window.__thimbleLibs=window.__thimbleLibs||{})[%(key)s]=L;
try{if(!(%(glob)s in window))window[%(glob)s]=L}catch(e){}
})(function(n){var l=window.__thimbleLibs&&window.__thimbleLibs[n];if(l===undefined)throw new Error('the page loads '+n+' after a library that needs it: list it earlier in libs');return l});
"""


async def bundle(stage: Path, e: Entry, others: list[str], out: Path) -> str:
    """Bundle the entry from its npm install into `out` (a script, or a stylesheet for a .css entry); the kind. A
    script's imports of `others` (the view's other packages) are left to their globals. RuntimeError with esbuild's
    words when it fails."""
    esbuild = _esbuild()
    if esbuild is None:
        raise RuntimeError(build_problem())
    loaders = [f"--loader:.{x}=dataurl" for x in ASSET_LOADERS]
    work = stage / f".build-{os.getpid()}-{hashlib.sha1(str(out).encode()).hexdigest()[:8]}"  # resolves from stage
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        src = stage / "node_modules" / e.name / e.path
        if e.path and (not src.resolve().is_relative_to((stage / "node_modules" / e.name).resolve())
                       or not src.is_file()):
            raise RuntimeError(f"{e.name} has no file {e.path}")
        if e.kind == "css":
            code, _, err = await _run([str(esbuild), str(src), "--bundle", "--minify", "--log-level=error",
                                       *loaders, f"--outfile={work / 'out.css'}"], cwd=stage)
            if code != 0:
                raise RuntimeError(_last_line(err) or "esbuild failed")
            atomic_write_text(out, (work / "out.css").read_text("utf-8"))
            return "css"
        entry = work / "entry.cjs"
        target = str(src.resolve()) if e.path else e.name  # a file by its path, since its package's name is external
        atomic_write_text(entry, f"module.exports = require({json.dumps(target)});\n")
        externals = [x for o in others for x in (f"--external:{o}", f"--external:{o}/*")]
        if e.path:
            externals.append(f"--external:{e.name}")
        code, _, err = await _run([str(esbuild), str(entry), "--bundle", "--format=iife", "--global-name=__thimble_lib",
                                   "--platform=browser", "--minify", "--log-level=error", "--charset=utf8",
                                   "--define:process.env.NODE_ENV=\"production\"", "--define:global=globalThis",
                                   "--resolve-extensions=.mjs,.js,.cjs,.json", *loaders, *externals,
                                   f"--outfile={work / 'out.js'}"], cwd=stage)
        if code != 0:
            raise RuntimeError(_last_line(err) or "esbuild failed")
        js = (work / "out.js").read_text("utf-8")
        text = WRAP_HEAD + js + WRAP_TAIL % {"key": json.dumps(e.key), "glob": json.dumps(global_name(e))}
        css = work / "out.css"  # a package whose script imports its own stylesheet
        if css.is_file():
            css_text = css.read_text("utf-8")
            text = (f"(function(){{var s=document.createElement('style');s.textContent={json.dumps(css_text)};"
                    f"(document.head||document.documentElement).appendChild(s)}})();\n") + text
        atomic_write_text(out, text)
        return "js"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _file_name(name: str, version: str, path: str, kind: str) -> str:
    tail = "-" + hashlib.sha1(path.encode()).hexdigest()[:8] if path else ""
    return f"{name.replace('/', '+')}@{version}{tail}.{kind}"


# ---------------------------------------------------------------------------------------------------- vendoring

Ask = Any  # async (workspace, slug, fields) -> True or False, the analyst's answer, UNANSWERED, or None when no one could be asked


async def ensure(c: str, slug: str, folder: Path, libs: Any, *, ask: "Ask | None" = None) -> dict[str, list[str]]:
    """Every npm entry of `libs` bundled into the view's folder, asking the analyst (`ask`, by default on the view
    build's card) before a package version thimble has not installed for them before. {problems, notes}: a problem for
    an entry that could not be vendored, a note for each one vendored now. Entries no longer listed leave the folder."""
    names = entries(libs)
    out: dict[str, list[str]] = {"problems": [], "notes": []}
    have = lock(folder)
    npm = [(raw, e) for raw in names if (e := parse(raw)) is not None]
    kept = {raw: have[raw] for raw, _ in npm if raw in have and vendored(folder, raw) is not None}
    todo = [(raw, e) for raw, e in npm if raw not in kept]
    if todo and (why := build_problem()):
        out["problems"].append(why)
        todo = []
    roots = [e.name for _, e in npm if not e.path]
    for raw, e in todo:
        try:
            info = await lookup(e.name, e.range)
        except LookupError as err:
            out["problems"].append(f"the package {raw} could not be found: {err}")
            continue
        version = info["version"]
        if not approved(e.name, version):
            setting = _installs(c)
            if setting == "deny":
                out["problems"].append(f"thimble's settings refuse installs, so {e.name} {version} was not installed. "
                                       "Draw the page without it and take it out of libs")
                continue
            more, extra = await needs(info["deps"])
            total = info["bytes"] + sum(int(x.get("bytes") or 0) for x in more)
            if setting != "allow":
                fields = {"description": f"Install the npm package {e.name} {version} for the view's page",
                          "size": _size_line(info["bytes"], more, extra)}
                if more:
                    fields["needs"] = ", ".join(x["name"] + (f" {x['version']}" if x["version"] != "?" else "")
                                                for x in more[:20]) + \
                        (f" and {len(more) - 20} more" if len(more) > 20 else "") + \
                        (f", and more beyond the first {DEPS_MAX}" if extra else "")
                allowed = await _ask_once(c, slug, f"{e.name}@{version}", fields, ask or _ask_on_card)
                if allowed is None:
                    out["problems"].append(f"thimble could not ask the analyst about the package {e.name} {version}, "
                                           "since no build of this view is running, so it was not installed")
                    continue
                if allowed == UNANSWERED:
                    from . import agent_session, dev  # noqa: PLC0415

                    wait = agent_session.wait_words(dev.PERMISSION_WAIT_S)
                    out["problems"].append(f"nobody answered within {wait} whether to install the package {e.name} "
                                           f"{version}, so it was not installed. Draw the page without it and take it "
                                           "out of libs")
                    continue
                if allowed is not True:
                    out["problems"].append(f"the analyst did not allow the package {e.name} {version}, so draw the page "
                                           "without it and take it out of libs")
                    continue
            approve(e.name, version, total)
        try:
            stage = await install(e.name, version)
            fname = _file_name(e.name, version, e.path, e.kind)
            (folder / LIB_DIR).mkdir(parents=True, exist_ok=True)
            kind = await bundle(stage, e, [r for r in roots if r != e.name], folder / LIB_DIR / fname)
        except RuntimeError as err:
            out["problems"].append(f"the package {raw} could not be installed: {err}")
            continue
        size = (folder / LIB_DIR / fname).stat().st_size
        kept[raw] = {"name": e.name, "version": version, "path": e.path, "file": fname, "kind": kind,
                     "global": global_name(e) if kind == "js" else None, "bytes": size}
        how = (f"the page has it as `{global_name(e)}` and as thimble.lib({json.dumps(e.key)})" if kind == "js"
               else "its styles load before the page's")
        out["notes"].append(f"installed {e.key} {version} into {LIB_DIR}/ ({size_words(size)}): {how}")
    _write_lock(folder, {raw: kept[raw] for raw in names if raw in kept})
    return out


def copy_lib(src: Path, dst: Path) -> None:
    """The vendored packages of the view in `src` copied into the view folder `dst`, replacing those it had."""
    lib = src / LIB_DIR
    if not lib.is_dir() or lib.is_symlink():
        return
    out = dst / LIB_DIR
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    for f in lib.iterdir():
        if f.is_file() and not f.is_symlink():
            shutil.copy2(f, out / f.name)


def _write_lock(folder: Path, items: dict[str, dict[str, Any]]) -> None:
    d = folder / LIB_DIR
    if not items and not d.is_dir():
        return
    d.mkdir(parents=True, exist_ok=True)
    write_json(d / LOCK_FILE, items)
    keep = {LOCK_FILE, *(str(v.get("file")) for v in items.values())}
    for f in d.iterdir():
        if f.name not in keep and f.is_file():
            with contextlib.suppress(OSError):
                f.unlink()


async def _ask_once(c: str, slug: str, package: str, fields: dict[str, str], ask: Ask) -> bool | str | None:
    """The analyst's answer about `package` (UNANSWERED when nobody answered in time, None when no one could be asked).
    The question runs in a task of its own,
    so it outlives a check that asked it and was dropped (the session's command timed out), and a question already
    waiting in the workspace (a check and the gate after the turn both asking) is answered once for all."""
    key = (c, package)
    waiting = _asking.get(key)
    if waiting is None or waiting.done():
        waiting = asyncio.ensure_future(ask(c, slug, fields))
        _asking[key] = waiting

        def forget(t: asyncio.Future, key: tuple[str, str] = key) -> None:
            if _asking.get(key) is t:
                del _asking[key]

        waiting.add_done_callback(forget)
    got = await asyncio.shield(waiting)
    return None if got is None else got if got == UNANSWERED else bool(got)


def _installs(c: str) -> str:
    from . import userconf  # noqa: PLC0415

    try:
        return str(userconf.load(c).get("installs") or "ask")
    except Exception:  # noqa: BLE001 — a config error asks, as the default does
        return "ask"


async def _ask_on_card(c: str, slug: str, fields: dict[str, str]) -> bool | str | None:
    """Ask the analyst on the card of the view build's session, in every permission mode; UNANSWERED when nobody
    answered in time, None when no build of the view runs, whose card could ask."""
    from . import agent_session, dev  # noqa: PLC0415

    if agent_session.asker(c, dev.view_key(slug)) is None:
        return None
    why = PACKAGE_WHY.format(wait=agent_session.wait_words(dev.PERMISSION_WAIT_S))
    got = await agent_session.ask(c, dev.view_key(slug), PACKAGE_TOOL, fields, force=True, why=why)
    return UNANSWERED if agent_session.timed_out(got) else got.get("behavior") == "allow"
