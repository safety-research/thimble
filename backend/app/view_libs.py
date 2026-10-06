"""The packages a view's page loads: thimble's own builds of vega, and any npm package the view names, vendored into
the view's folder so the frame still loads nothing from the network.

view.json's `libs` lists them in load order. `vega`, `vega-lite` and `vega-embed` are thimble's own (views.LIBS). Any
other entry is an npm package, `name@version` (a range, such as `d3-force@3`, takes the newest version it allows),
optionally with a file inside the package after it, `three@0.160.0/examples/jsm/controls/OrbitControls.js` or
`leaflet@1.9.4/dist/leaflet.css`.

The view's builder installs a package it needs with its own Bash call, `npm install --ignore-scripts --cache .npm-cache
<name>@<version>` in its own folder (dev.view_work_dir), with npm's cache there too since the sandbox keeps the home
folder read-only, which Claude Code decides by main's permission mode; thimble approves no install of its own. When the view is checked, ensure bundles each entry from that folder's node_modules with esbuild into one
script, or one stylesheet for a .css entry, with its images and fonts inlined; an entry its folder does not hold, or
holds at a version its range does not allow, is a problem the check names. esbuild runs as thimble's server, outside
the sandbox, so a bundle that would hold a file from outside that folder's node_modules is a problem too (_outside). The
bundle is written to the view's `lib/` folder beside LOCK_FILE, which maps each entry to its file. views.frame_document inlines those files into
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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import config
from .ledger import atomic_write_text, write_json

log = logging.getLogger("thimble.view_libs")

LIB_DIR = "lib"  # in a view's folder
LOCK_FILE = "libs.json"  # in LIB_DIR: {entry: {name, version, path, file, kind, global, bytes}}
BUILTIN = ("vega", "vega-lite", "vega-embed")
NPM_TIMEOUT_S = 300.0
ENTRY_RE = re.compile(r"^(?P<name>(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*)"
                      r"(?:@(?P<range>[0-9A-Za-z.^~<>=*|+-]+))?(?P<path>(?:/[A-Za-z0-9._@+-]+)+)?$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$")
ASSET_LOADERS = ("png", "jpg", "jpeg", "gif", "svg", "webp", "woff", "woff2", "ttf", "otf", "eot")

NOT_INSTALLED = ("the package {name} is not installed in {where}. Install it there with `cd {where} && npm install "
                 "--ignore-scripts --cache .npm-cache {raw}`, or draw the page without it and take it out of libs")
OTHER_VERSION = ("{where} holds {name} {version}, which {raw} does not allow. Install the version libs names there, or "
                 "name the one installed")


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


ESBUILD = config.REPO_ROOT / "frontend" / "node_modules" / "esbuild" / "bin" / "esbuild"


def _esbuild() -> Path | None:
    return ESBUILD if ESBUILD.is_file() else None


def build_problem() -> str:
    """Why packages cannot be bundled here, '' when they can."""
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


def size_words(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} MB"
    if n >= 1000:
        return f"{round(n / 1000)} kB"
    return f"{n} bytes"


WRAP_HEAD = "(function(require){\n"
WRAP_TAIL = """
;var L=__thimble_lib;
if(L&&L.__esModule&&'default' in L&&Object.keys(L).every(function(k){return k==='default'||k==='__esModule'}))L=L.default;
(window.__thimbleLibs=window.__thimbleLibs||{})[%(key)s]=L;
try{if(!(%(glob)s in window))window[%(glob)s]=L}catch(e){}
})(function(n){var l=window.__thimbleLibs&&window.__thimbleLibs[n];if(l===undefined)throw new Error('the page loads '+n+' after a library that needs it: list it earlier in libs');return l});
"""


def installed(stage: Path, name: str) -> str | None:
    """The version of the package `name` that the npm install in `stage` holds (node_modules/<name>/package.json), None
    when it holds none."""
    p = stage / "node_modules" / name / "package.json"
    try:
        if not p.resolve().is_relative_to((stage / "node_modules").resolve()):
            return None
        raw = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    v = str(raw.get("version") or "") if isinstance(raw, dict) else ""
    return v if VERSION_RE.match(v) else None


def _parts(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v.split("-", 1)[0].split("+", 1)[0])[:3])


def fits(version: str, rng: str) -> bool:
    """Whether `version` is one the range `rng` allows: an exact version, a prefix such as `3` or `1.9`, a caret or
    tilde range, `latest` or `*`; any other range (several bounds) is taken as allowed, since npm's own resolver
    already chose what is installed."""
    r = str(rng or "").strip()
    if r in ("", "latest", "*", "x"):
        return True
    have = _parts(version)
    if VERSION_RE.match(r):
        return version == r
    m = re.fullmatch(r"([\^~]?)(\d+(?:\.\d+){0,2})(?:\.[x*])*", r)
    if m is None:
        return True
    want = tuple(int(x) for x in m.group(2).split("."))
    if m.group(1) == "":
        return have[:len(want)] == want
    if have < want + (0,) * (3 - len(want)):
        return False
    keep = 2 if m.group(1) == "~" else (1 if want[0] > 0 else 2)
    return have[:keep] == want[:keep] if len(want) >= keep else have[:len(want)] == want


OUTSIDE = ("{name} reads {path}, which is outside {where}: a package's files must all be in that folder's "
           "node_modules, as npm installs them, with no link out of it")


def _outside(stage: Path, work: Path, meta: Path) -> str:
    """The first file esbuild read for a bundle (its metafile's inputs, by their real paths) that is neither in
    `stage`'s node_modules nor the bundle's own entry in `work`; '' when there is none. esbuild runs as thimble's server,
    outside any sandbox, on files the builder wrote, so a require of an absolute path, or a link out of node_modules,
    would bundle a file the builder cannot read (a token file) into the view's lib, which it can."""
    nm = (stage / "node_modules").resolve()
    try:
        inputs = json.loads(meta.read_text("utf-8")).get("inputs") or {}
    except (OSError, ValueError, AttributeError):
        return str(meta)
    for name in inputs:
        if str(name).startswith("(disabled):"):  # a module the package's `browser` field maps to nothing
            continue
        real = (stage / str(name)).resolve()
        if not (real.is_relative_to(nm) or real.is_relative_to(work.resolve())):
            return str(real)
    return ""


async def bundle(stage: Path, e: Entry, others: list[str], out: Path) -> str:
    """Bundle the entry from the npm install in `stage` into `out` (a script, or a stylesheet for a .css entry); the
    kind. A script's imports of `others` (the view's other packages) are left to their globals. RuntimeError with
    esbuild's words when it fails, and when the bundle would hold a file from outside `stage`'s node_modules (_outside),
    whose output is then thrown away."""
    esbuild = _esbuild()
    if esbuild is None:
        raise RuntimeError(build_problem())
    loaders = [f"--loader:.{x}=dataurl" for x in ASSET_LOADERS]
    if stage.is_symlink() or (stage / "node_modules").is_symlink() or not (stage / "node_modules").is_dir():
        raise RuntimeError(f"{stage / 'node_modules'} is not a folder of its own")
    work = stage / f".build-{os.getpid()}-{hashlib.sha1(str(out).encode()).hexdigest()[:8]}"  # resolves from stage
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    meta = work / "meta.json"

    def confined() -> None:
        if bad := _outside(stage, work, meta):
            raise RuntimeError(OUTSIDE.format(name=e.name, path=bad, where=stage))

    try:
        src = stage / "node_modules" / e.name / e.path
        if e.path and (not src.resolve().is_relative_to((stage / "node_modules" / e.name).resolve())
                       or not src.is_file()):
            raise RuntimeError(f"{e.name} has no file {e.path}")
        if e.kind == "css":
            code, _, err = await _run([str(esbuild), str(src), "--bundle", "--minify", "--log-level=error",
                                       *loaders, f"--metafile={meta}", f"--outfile={work / 'out.css'}"], cwd=stage)
            if code != 0:
                raise RuntimeError(_last_line(err) or "esbuild failed")
            confined()
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
                                   f"--metafile={meta}", f"--outfile={work / 'out.js'}"], cwd=stage)
        if code != 0:
            raise RuntimeError(_last_line(err) or "esbuild failed")
        confined()
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

async def ensure(c: str, slug: str, folder: Path, libs: Any, *, source: Path | None = None) -> dict[str, list[str]]:
    """Every npm entry of `libs` bundled into the view's folder from the npm install the builder made in its own folder
    (`source`, by default dev.view_work_dir). {problems, notes}: a problem for an entry that could not be bundled (not
    installed there, another version, or esbuild's failure), a note for each one bundled now. Entries no longer listed
    leave the folder. Nothing is installed here and nothing is asked: the builder's own install asked, as Claude Code
    decides."""
    names = entries(libs)
    out: dict[str, list[str]] = {"problems": [], "notes": []}
    have = lock(folder)
    stage = source or config.workspace_dir(c) / "views-work" / slug
    npm = [(raw, e) for raw in names if (e := parse(raw)) is not None]
    kept = {raw: have[raw] for raw, e in npm if raw in have and vendored(folder, raw) is not None
            and installed(stage, e.name) in (None, have[raw].get("version"))}
    todo = [(raw, e) for raw, e in npm if raw not in kept]
    if todo and (why := build_problem()):
        out["problems"].append(why)
        todo = []
    roots = [e.name for _, e in npm if not e.path]
    for raw, e in todo:
        version = installed(stage, e.name)
        if version is None:
            out["problems"].append(NOT_INSTALLED.format(name=e.name, where=stage, raw=raw))
            continue
        if not fits(version, e.range):
            out["problems"].append(OTHER_VERSION.format(name=e.name, version=version, raw=raw, where=stage))
            continue
        try:
            fname = _file_name(e.name, version, e.path, e.kind)
            (folder / LIB_DIR).mkdir(parents=True, exist_ok=True)
            kind = await bundle(stage, e, [r for r in roots if r != e.name], folder / LIB_DIR / fname)
        except RuntimeError as err:
            out["problems"].append(f"the package {raw} could not be bundled: {err}")
            continue
        size = (folder / LIB_DIR / fname).stat().st_size
        kept[raw] = {"name": e.name, "version": version, "path": e.path, "file": fname, "kind": kind,
                     "global": global_name(e) if kind == "js" else None, "bytes": size}
        how = (f"the page has it as `{global_name(e)}` and as thimble.lib({json.dumps(e.key)})" if kind == "js"
               else "its styles load before the page's")
        out["notes"].append(f"bundled {e.key} {version} into {LIB_DIR}/ ({size_words(size)}): {how}")
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
