"""Extensions: folders that add views, card types, agents, report types and orientation instructions to thimble.
`thimble extension add` copies one into $THIMBLE_HOME/extensions/<name>/ after the analyst said yes (cli.py), and from
then on it runs in every workspace it applies to, until it is removed or switched off. Its folder:

  extension.json        {"api": 0, "name": "<name>", "version", "description", "applies": "<view slug>",
                         "requires": ["<python package>", ...], "replaces": {"<orientation block>": "<file>.md"}}
  views/<slug>/         a view (views.py), with `show` ("always" or "proposed") and `reports` in view.json; a `card`
                        block and card.py make it a card type too (cardtypes.py), and card.md is the type's guide
  cards/<slug>/         a card type of its own: card.json (the keys of a `card` block plus `reader`, the extension's view
                        whose reader and index it uses), card.py, card.html, card.md
  agents/<name>.md      an agent the orientation's session gets with --agents (agent_definitions)
  report-types/<slug>/  type.md in the preset format plus `default`; export.py for its own exports
  orient.md             added to the orientation's instructions; `replaces` names blocks thimble has a default for
                        (orient_session.BLOCKS) that the extension's own files take the place of (orient_blocks)

Added means running. An extension is active in a workspace when it loads (read_extension finds no problem), neither
switch is off (`extensions.<name>.enabled: false` in thimble's config for every workspace, Settings for this one) and
the view its `applies` names finds records here, or it names none. refresh() copies an active extension into
workspaces/<c>/extensions/<name>/, since a kernel sees only the workspace and the corpus, and writes STATE_FILE. Its
`show: always` views are installed at once, outside the orientation's four; its `show: proposed` views are the
orientation's to propose (views.propose_builtins). When it becomes active in a workspace an orientation ran in, its
orient.md goes to the orientation as one follow-up. When it stops being active, its views that nobody changed go.

Two active extensions that give the same view or card type, or replace the same orientation block, lose it both: the
view, type or block is left out (the block stays thimble's), and Settings and `thimble doctor` name the conflict.

Extension code runs only in thimble's kernels: readers on the views kernel, card.py in a card's kernel. The server reads
only its JSON and markdown, from the folder in thimble's home rather than the copy a kernel can write, and its agents
run inside the orientation's session, under that session's rules and network."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import config
from .ledger import read_json, write_json

log = logging.getLogger("thimble.extensions")

API = 0
MANIFEST = "extension.json"
ADDED = ".added.json"  # written by `thimble extension add`: {source, kind, commit?, ts}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
RESERVED = ("thimble",)
WS_DIR = "extensions"  # under the workspace: each active extension's copy
STATE_FILE = "extensions.json"  # in the workspace
CACHE_DIR = ".extensions"  # under the workspace's views folder: extension readers' indexes, by extension and view
SHOWS = ("always", "proposed")
CARD_JSON, CARD_HTML, GUIDE = "card.json", "card.html", "card.md"
TYPE_MD, EXPORT_PY, ORIENT_MD = "type.md", "export.py", "orient.md"
SIZE_MAX = 50 * 1024 * 1024  # bytes of an extension's folder
SKIPPED = ("__pycache__", ".git", "cache", ADDED)
WEB_TOOLS = ("WebFetch", "WebSearch")
AGENT_WEB = ("off", "ask", "allow")
AGENT_KEYS = ("model", "effort", "web", "prompt")

_locks: dict[str, asyncio.Lock] = {}


def home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def extensions_dir() -> Path:
    """$THIMBLE_HOME/extensions, where each added extension has its folder."""
    return home() / "extensions"


def builtin_dir() -> Path:
    """The extensions thimble ships, which `thimble extension add <name>` adds by name."""
    return config.REPO_ROOT / "extensions"


def _json(p: Path) -> dict[str, Any]:
    try:
        raw = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _words(v: Any) -> list[str]:
    if isinstance(v, str):
        v = [v]
    return [s for s in (" ".join(str(x).split()) for x in v) if s] if isinstance(v, list) else []


def _text(p: Path) -> str:
    try:
        return p.read_text("utf-8").strip()
    except OSError:
        return ""


def frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """(frontmatter, body) of a markdown file that opens with frontmatter between `---` lines; ({}, text) otherwise."""
    import yaml  # noqa: PLC0415

    head, sep, body = text.removeprefix("---\n").partition("\n---\n")
    if not text.startswith("---\n") or not sep:
        return {}, text.strip()
    try:
        front = yaml.safe_load(head)
    except yaml.YAMLError:
        return {}, body.strip()
    return (front if isinstance(front, dict) else {}), body.strip()


# --------------------------------------------------------------------------- thimble's config


def user_config() -> dict[str, Any]:
    """$THIMBLE_HOME/config.json as written; {} when it is missing or does not parse."""
    return _json(home() / "config.json")


def user_off(name: str, conf: dict[str, Any] | None = None) -> bool:
    ext = ((conf if conf is not None else user_config()).get("extensions") or {}).get(name)
    return isinstance(ext, dict) and ext.get("enabled") is False


def agent_config(ext: str, name: str, conf: dict[str, Any] | None = None) -> dict[str, Any]:
    """The settings thimble's config gives the extension's agent, `agents."<ext>:<name>"`."""
    got = ((conf if conf is not None else user_config()).get("agents") or {}).get(f"{ext}:{name}")
    return got if isinstance(got, dict) else {}


def config_problems(data: dict[str, Any]) -> list[str]:
    """What is wrong with the extensions' keys of thimble's config: `extensions.<name>` takes `enabled`, and an agent
    `agents."<ext>:<name>"` takes AGENT_KEYS, `web` being one of AGENT_WEB."""
    out: list[str] = []
    exts = data.get("extensions")
    if exts is not None and not isinstance(exts, dict):
        out.append("extensions must be an object")
    for name, e in (exts or {}).items() if isinstance(exts, dict) else ():
        if not isinstance(e, dict):
            out.append(f"extensions.{name} must be an object")
            continue
        for k, v in e.items():
            if k != "enabled":
                out.append(f"extensions.{name}.{k} is not a setting; it takes enabled")
            elif not isinstance(v, bool):
                out.append(f"extensions.{name}.enabled is {json.dumps(v)}; it takes true or false")
    for key, a in (data.get("agents") or {}).items() if isinstance(data.get("agents"), dict) else ():
        if ":" not in key:
            continue
        if not isinstance(a, dict):
            out.append(f"agents.{key} must be an object")
            continue
        for k, v in a.items():
            if k not in AGENT_KEYS:
                out.append(f"agents.{key}.{k} is not a setting; an extension's agent takes {', '.join(AGENT_KEYS)}")
            elif k == "web" and v is not None and v not in AGENT_WEB:
                out.append(f"agents.{key}.web is {json.dumps(v)}; it takes {', '.join(AGENT_WEB)}")
            elif k != "web" and v is not None and (not isinstance(v, str) or not v.strip()):
                out.append(f"agents.{key}.{k} must be a string, or null")
    return out


# --------------------------------------------------------------------------- reading an extension


def _importable(name: str) -> bool:
    top = re.split(r"[\[<>=!~ ;]", name.strip(), maxsplit=1)[0].replace("-", "_").split(".")[0]
    try:
        return bool(top) and importlib.util.find_spec(top) is not None
    except (ImportError, ValueError):
        return False


def _subdirs(d: Path) -> list[Path]:
    return sorted(x for x in d.iterdir() if x.is_dir() and NAME_RE.match(x.name)) if d.is_dir() else []


def read_extension(root: Path, expect: str | None = None) -> dict[str, Any]:
    """What the extension in folder `root` is and gives, with `problems`, the reasons it cannot load; `expect` is the name
    its folder gives it."""
    from . import orient_session, views  # noqa: PLC0415

    raw = _json(root / MANIFEST)
    name = str(raw.get("name") or "")
    problems: list[str] = []
    if not (root / MANIFEST).is_file():
        problems.append(f"it has no {MANIFEST}")
    elif not raw:
        problems.append(f"its {MANIFEST} is not a JSON object")
    elif raw.get("api") != API:
        problems.append(f"it is written for extension API {raw.get('api')!r}, and thimble reads API {API}")
    if raw and (not NAME_RE.match(name) or name in RESERVED):
        problems.append(f"its name {name!r} is not one thimble can use (lower-case letters, digits and hyphens)")
    elif expect and raw and name != expect:
        problems.append(f"its folder is {expect!r} and its {MANIFEST} names it {name!r}")
    requires = _words(raw.get("requires"))
    missing = [r for r in requires if not _importable(r)]
    if missing:
        problems.append(f"it needs the Python package{'s' if len(missing) > 1 else ''} {', '.join(missing)}")
    vs = []
    for d in _subdirs(root / "views"):
        v = _json(d / views.VIEW_JSON)
        if not v or not (d / views.READER_PY).is_file() or not (d / views.VIEW_HTML).is_file():
            problems.append(f"its view {d.name!r} lacks {views.VIEW_JSON}, {views.READER_PY} or {views.VIEW_HTML}")
            continue
        vs.append({"slug": d.name, "name": " ".join(str(v.get("name") or d.name).split()),
                   "show": v.get("show") if v.get("show") in SHOWS else "always", "reports": _words(v.get("reports")),
                   "card": isinstance(v.get("card"), dict) and (d / "card.py").is_file()})
    slugs = {v["slug"] for v in vs}
    cards = []
    for d in _subdirs(root / "cards"):
        reader = str(_json(d / CARD_JSON).get("reader") or "")
        if not all((d / f).is_file() for f in (CARD_JSON, "card.py", CARD_HTML)):
            problems.append(f"its card type {d.name!r} lacks {CARD_JSON}, card.py or {CARD_HTML}")
        elif reader not in slugs:
            problems.append(f"its card type {d.name!r} reads with the view {reader!r}, which it does not have")
        elif d.name in slugs:
            problems.append(f"its card type {d.name!r} has the slug of one of its views")
        else:
            cards.append({"slug": d.name, "reader": reader})
    agents = sorted(p.stem for p in (root / "agents").glob("*.md") if NAME_RE.match(p.stem)) if (root / "agents").is_dir() else []
    reports = []
    for d in _subdirs(root / "report-types"):
        if (d / TYPE_MD).is_file():
            front, _ = frontmatter((d / TYPE_MD).read_text("utf-8"))
            reports.append({"slug": d.name, "name": " ".join(str(front.get("name") or d.name).split()),
                            "default": front.get("default") is True, "export": (d / EXPORT_PY).is_file()})
    applies = str(raw.get("applies") or "") or None
    if applies and applies not in slugs:
        problems.append(f"it applies where its view {applies!r} does, and it has no such view")
    replaces: dict[str, str] = {}
    given = raw.get("replaces") if isinstance(raw.get("replaces"), dict) else {}
    for block, f in given.items():
        if block not in orient_session.BLOCKS:
            problems.append(f"it replaces the orientation block {block!r}; thimble's blocks are "
                            f"{', '.join(orient_session.BLOCKS)}")
        elif not isinstance(f, str) or Path(f).is_absolute() or ".." in Path(f).parts or not (root / f).is_file():
            problems.append(f"it replaces the orientation block {block!r} with {f!r}, which is no file of its own")
        else:
            replaces[block] = f
    shown = name or expect or root.name
    return {"name": shown, "title": " ".join(str(raw.get("title") or shown.replace("-", " ").title()).split()),
            "version": str(raw.get("version") or ""), "description": " ".join(str(raw.get("description") or "").split()),
            "root": str(root), "applies": applies, "requires": requires, "problems": problems, "views": vs,
            "cards": cards, "agents": agents, "report_types": reports, "orient": (root / ORIENT_MD).is_file(),
            "replaces": replaces, "source": str(_json(root / ADDED).get("source") or "")}


def added() -> dict[str, Path]:
    """{name: folder} of every extension in extensions_dir()."""
    base = extensions_dir()
    try:
        dirs = sorted(d for d in base.iterdir() if d.is_dir() and NAME_RE.match(d.name))
    except OSError:
        return {}
    return {d.name: d for d in dirs if (d / MANIFEST).is_file()}


def _files(base: Path) -> list[Path]:
    """The regular files of an extension's folder, symlinks, caches and git's files left out."""
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(n for n in dirnames if n not in SKIPPED and not Path(dirpath, n).is_symlink())
        out += [Path(dirpath, n) for n in sorted(filenames) if n not in SKIPPED and not Path(dirpath, n).is_symlink()]
    return out


def digest(base: Path) -> tuple[str, int]:
    h, size = hashlib.sha1(), 0
    for f in _files(base):
        data = f.read_bytes()
        size += len(data)
        h.update(str(f.relative_to(base)).encode() + b"\0" + data + b"\0")
    return h.hexdigest()[:16], size


def copy_tree(src: Path, dst: Path) -> None:
    """The files of `src` (_files) as the folder `dst`, which is replaced whole."""
    tmp, old = dst.with_name(f".{dst.name}.tmp"), dst.with_name(f".{dst.name}.old")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    for f in _files(src):
        to = tmp / f.relative_to(src)
        to.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(f, to)
    shutil.rmtree(old, ignore_errors=True)
    if dst.exists():
        os.replace(dst, old)
    os.replace(tmp, dst)
    shutil.rmtree(old, ignore_errors=True)


def workspace_path(c: str, name: str) -> Path:
    """Where workspace `c` keeps the copy of extension `name` that its kernels read."""
    return config.workspace_dir(c) / WS_DIR / name


def source_path(name: str) -> Path:
    """The folder of extension `name` in thimble's home, whose markdown and JSON the server reads."""
    return extensions_dir() / name


# --------------------------------------------------------------------------- the workspace's state


def _state_path(c: str) -> Path:
    return config.workspace_dir(c) / STATE_FILE


def read_state(c: str | None) -> dict[str, Any]:
    """{off, oriented, extensions} as refresh() last wrote them: the extensions switched off here, those whose
    orientation instructions the orientation had, and each extension found, active or not."""
    got: Any = {}
    if c:
        try:
            got = read_json(_state_path(c), {})
        except (OSError, ValueError, HTTPException):
            got = {}
    got = got if isinstance(got, dict) else {}
    exts = got.get("extensions") if isinstance(got.get("extensions"), dict) else {}
    return {"off": _words(got.get("off")), "oriented": _words(got.get("oriented")), "extensions": exts}


def active(c: str | None) -> list[dict[str, Any]]:
    """The workspace's active extensions, each with `dir`, its copy in the workspace, and `src`, its folder."""
    if not c:
        return []
    return [{**e, "name": n, "dir": str(workspace_path(c, n)), "src": str(source_path(n))}
            for n, e in sorted(read_state(c)["extensions"].items()) if e.get("active")]


def conflicts(exts: dict[str, dict[str, Any]]) -> dict[str, dict[str, list[str]]]:
    """{kind: {slug: [extension, ...]}} of what two or more of the active extensions `exts` give: `view` and `card`
    slugs, and orientation `block`s they replace."""
    seen: dict[str, dict[str, list[str]]] = {"view": {}, "card": {}, "block": {}}
    for n, e in sorted(exts.items()):
        if not e.get("active"):
            continue
        for v in e.get("views") or []:
            seen["view"].setdefault(v["slug"], []).append(n)
            if v.get("card"):
                seen["card"].setdefault(v["slug"], []).append(n)
        for t in e.get("cards") or []:
            seen["card"].setdefault(t["slug"], []).append(n)
        for b in e.get("replaces") or {}:
            seen["block"].setdefault(b, []).append(n)
    return {k: {s: ns for s, ns in m.items() if len(ns) > 1} for k, m in seen.items()}


def conflict_lines(clash: dict[str, dict[str, list[str]]]) -> list[str]:
    """Each conflict (conflicts) in words."""
    words = {"view": "the view", "card": "the card type", "block": "the orientation block"}
    out = []
    for kind, m in clash.items():
        for slug, names in m.items():
            both = ", ".join(names[:-1]) + f" and {names[-1]}"
            left = "thimble's own is used" if kind == "block" else "neither is used"
            out.append(f"{both} both {'replace' if kind == 'block' else 'give'} {words[kind]} {slug!r}, so {left}")
    return out


def view_claims(c: str, name: str, slug: str) -> list[str]:
    """The files extension `name`'s view `slug` reads in workspace `c`, as refresh() found them."""
    e = read_state(c)["extensions"].get(name) or {}
    return _words(((e.get("claims") or {}).get(slug) or {}).get("claims"))


def views_of(c: str, show: str | None = None) -> list[dict[str, Any]]:
    """The views of the active extensions ({extension, slug, show, reports, dir, claims, found}) that no other active
    extension gives too, those shown as `show` alone when given."""
    exts = read_state(c)["extensions"]
    clash = conflicts(exts)["view"]
    out = []
    for e in active(c):
        for v in e.get("views") or []:
            if v["slug"] in clash or (show is not None and v.get("show") != show):
                continue
            got = (e.get("claims") or {}).get(v["slug"]) or {}
            out.append({**v, "extension": e["name"], "dir": str(Path(e["dir"]) / "views" / v["slug"]),
                        "claims": _words(got.get("claims")), "found": str(got.get("found") or "")})
    return out


async def _claims(c: str, d: Path, paths: list[str], kept: dict[str, Any]) -> dict[str, Any]:
    """{src, claims, found} of the view in folder `d` for this corpus: what its reader's applies() names when view.json
    says `applies`, else the claims of view.json when they match files here. `kept` is the last answer, reused while the
    reader's source is the same."""
    from . import views  # noqa: PLC0415

    raw = _json(d / views.VIEW_JSON)
    try:
        src = hashlib.sha1((d / views.READER_PY).read_bytes()).hexdigest()[:12]
    except OSError:
        return {"src": "", "claims": [], "found": ""}
    if kept.get("src") == src and isinstance(kept.get("claims"), list):
        return kept
    if not raw.get("applies"):
        claims = _words(raw.get("claims"))
        hit = await asyncio.to_thread(views.claimed_files, c, {"claims": claims}) if claims else []
        return {"src": src, "claims": claims if hit else [], "found": ""}
    if not paths:
        return {"src": src, "claims": [], "found": ""}
    req = {"slug": f"ext-{d.name}", "reader": str((d / views.READER_PY).resolve()), "fp": "applies", "paths": [],
           "cache": None, "thimble": str(views.KERNEL_THIMBLE)}
    try:
        fit = await views._call(c, req, "applies", paths)
    except views.ReaderError as e:
        log.warning("%s: whether the view %s applies is not known: %s", c, d, e)
        return {"src": "", "claims": [], "found": ""}
    fit = fit if isinstance(fit, dict) else {}
    return {"src": src, "claims": views._str_list(fit.get("claims")), "found": " ".join(str(fit.get("found") or "").split())}


async def refresh(c: str) -> dict[str, Any]:
    """The workspace's extensions found again in extensions_dir(), each active one copied in and its views' claims
    found, written to STATE_FILE; then the views of those that stopped running withdrawn, the always-views installed,
    and the orientation told of the newly active ones. Returns the state."""
    from . import corpus, views  # noqa: PLC0415

    lock = _locks.setdefault(c, asyncio.Lock())
    async with lock:
        state = read_state(c)
        before = {n for n, e in state["extensions"].items() if e.get("active")}
        conf = await asyncio.to_thread(user_config)
        paths: list[str] | None = None
        exts: dict[str, Any] = {}
        for name, root in (await asyncio.to_thread(added)).items():
            info = await asyncio.to_thread(read_extension, root, name)
            kept = state["extensions"].get(name) or {}
            why = info["problems"][0] if info["problems"] else ""
            why = why or ("off in thimble's config" if user_off(name, conf) else "")
            why = why or ("off in this workspace" if name in state["off"] else "")
            claims: dict[str, Any] = {}
            if not why:
                dig, size = await asyncio.to_thread(digest, root)
                if size > SIZE_MAX:
                    why = f"its folder holds {size:,} bytes, and thimble copies {SIZE_MAX:,} at most"
                else:
                    here = workspace_path(c, name)
                    if dig != kept.get("digest") or not here.is_dir() or (await asyncio.to_thread(digest, here))[0] != dig:
                        await asyncio.to_thread(copy_tree, root, here)
                    info["digest"] = dig
                    if paths is None:
                        sources = await asyncio.to_thread(corpus.list_sources, config.corpus_dir(c))
                        paths = [s["path"] for s in sources if str(s["path"]).endswith((".jsonl", ".csv"))]
                    for v in info["views"]:
                        claims[v["slug"]] = await _claims(c, here / "views" / v["slug"], paths,
                                                          (kept.get("claims") or {}).get(v["slug"]) or {})
                    if info["applies"] and not (claims.get(info["applies"]) or {}).get("claims"):
                        why = "it does not apply to this corpus"
            exts[name] = {**{k: v for k, v in info.items() if k != "name"}, "claims": claims, "active": not why,
                          "why": why}
        now = {n for n, e in exts.items() if e.get("active")}
        oriented = [n for n in state["oriented"] if n in now]
        fresh = sorted(now - set(oriented))
        new_state = {"off": state["off"], "oriented": sorted({*oriented, *fresh}), "extensions": exts}
        await asyncio.to_thread(write_json, _state_path(c), new_state)
        for name in sorted(set(state["extensions"]) - set(exts)):
            await asyncio.to_thread(shutil.rmtree, workspace_path(c, name), True)
    for name in sorted(before - now):
        for v in (state["extensions"].get(name) or {}).get("views") or []:
            await asyncio.to_thread(views.withdraw, c, v["slug"], name)
    await asyncio.to_thread(install_views, c)
    await _orient(c, fresh)
    return new_state


async def refresh_quietly(c: str) -> dict[str, Any]:
    try:
        return await refresh(c)
    except Exception:  # noqa: BLE001 — the extensions stored stay as they were
        log.exception("%s: the extensions were not found", c)
        return read_state(c)


async def connected(c: str) -> None:
    """Main's session connected: the extensions found again, then the card types, which main hears of when they are
    new."""
    from . import cardtypes  # noqa: PLC0415

    await refresh_quietly(c)
    await cardtypes.announce(c)


def install_views(c: str) -> list[str]:
    """Install each `show: always` view of the active extensions that applies here, unless the workspace has a view or
    proposal of that slug or the analyst deleted it; a view installed from an older version of the extension that
    nobody changed is installed again. Returns the slugs installed."""
    from . import views  # noqa: PLC0415

    made = []
    gone = {str(d.get("slug")) for d in views.deleted_proposals(c)}
    for v in views_of(c, "always"):
        slug, d = v["slug"], Path(v["dir"])
        if not v["claims"] or slug in gone:
            continue
        prop = views.read_proposal(c, slug)
        if prop is not None or slug in views._view_dirs(c):
            if not (prop and prop.get("extension") == v["extension"] and views.stale_install(c, slug, d)):
                continue
        raw = _json(d / views.VIEW_JSON)
        try:
            views.install_viewer(c, slug, d, v["claims"], why=v["found"] or str(raw.get("why") or ""),
                                 proposed_by="extension", orientation=False, extension=v["extension"])
        except HTTPException as e:
            log.warning("%s: the view %s of the extension %s was not installed: %s", c, slug, v["extension"], e.detail)
            continue
        made.append(slug)
    return made


async def _orient(c: str, names: list[str]) -> None:
    """Newly active extensions with orientation instructions: an orientation that has run gets each one's as a
    follow-up; one that has not reads them in its instructions when it starts."""
    from . import orient_session  # noqa: PLC0415

    exts = read_state(c)["extensions"]
    for name in names:
        text = _text(source_path(name) / ORIENT_MD) if (exts.get(name) or {}).get("orient") else ""
        if not text:
            continue
        try:
            await orient_session.message(c, text, orient_session.EXTENSION, extension=exts[name].get("title") or name)
        except orient_session.NoOrientation:
            pass
        except (orient_session.Gone, RuntimeError, ValueError) as e:
            log.warning("%s: the orientation was not given the extension %s: %s", c, name, e)


def set_enabled(c: str, name: str, on: bool) -> None:
    """Settings' switch of extension `name` for workspace `c`. Turned off, it leaves the oriented ones, so turning it on
    again gives the orientation its instructions again."""
    state = read_state(c)
    off = [n for n in state["off"] if n != name] + ([] if on else [name])
    oriented = state["oriented"] if on else [n for n in state["oriented"] if n != name]
    write_json(_state_path(c), {**state, "off": sorted(off), "oriented": oriented})


# --------------------------------------------------------------------------- contributions


def orient_blocks(c: str | None) -> dict[str, Any]:
    """What the active extensions give the orientation's prompt: `added`, [(title, text)] of each one's orient.md;
    `replaced`, {block: text} for each block of orient_session.BLOCKS one extension replaces; and `conflicts`, the
    blocks two or more replace, which keep thimble's text."""
    exts = read_state(c)["extensions"] if c else {}
    clash = conflicts(exts)["block"]
    added_: list[tuple[str, str]] = []
    replaced: dict[str, str] = {}
    for e in active(c):
        src = Path(e["src"])
        text = _text(src / ORIENT_MD) if e.get("orient") else ""
        if text:
            added_.append((str(e.get("title") or e["name"]), text))
        for block, f in (e.get("replaces") or {}).items():
            if block not in clash and (got := _text(src / f)):
                replaced[block] = got
    return {"added": added_, "replaced": replaced, "conflicts": clash}


def agent_definitions(c: str | None) -> dict[str, dict[str, Any]]:
    """The active extensions' agents as `--agents` takes them. Each takes its model and effort from thimble's config
    (`agents."<ext>:<name>"`), else from its own file, else those Claude Code gives the session's subagents; its web
    tools are taken away unless the config's `web` is "ask" or "allow"; a config `prompt` file replaces its text. An
    agent two extensions name is `<ext>:<name>` for both."""
    conf = user_config()
    found: list[tuple[str, str, dict[str, Any]]] = []
    for e in active(c):
        for name in e.get("agents") or []:
            try:
                front, body = frontmatter((Path(e["src"]) / "agents" / f"{name}.md").read_text("utf-8"))
            except OSError:
                continue
            mine = agent_config(e["name"], name, conf)
            if isinstance(mine.get("prompt"), str) and mine["prompt"].strip():
                try:
                    body = Path(mine["prompt"]).expanduser().read_text("utf-8").strip()
                except OSError:
                    log.warning("the prompt file %s of agents.%s:%s cannot be read", mine["prompt"], e["name"], name)
            agent: dict[str, Any] = {"description": " ".join(str(front.get("description") or "").split()), "prompt": body}
            tools = front.get("tools")
            tools = [x.strip() for x in (tools.split(",") if isinstance(tools, str) else tools or []) if str(x).strip()]
            for key in ("model", "effort"):
                if v := mine.get(key) or front.get(key):
                    agent[key] = str(v)
            if mine.get("web") not in ("ask", "allow"):
                agent["disallowedTools"] = list(WEB_TOOLS)
                tools = [t for t in tools if t not in WEB_TOOLS]
            if tools:
                agent["tools"] = tools
            found.append((e["name"], name, agent))
    counts: dict[str, int] = {}
    for _, name, _ in found:
        counts[name] = counts.get(name, 0) + 1
    return {(name if counts[name] == 1 else f"{ext}:{name}"): agent for ext, name, agent in found}


def card_types(c: str | None) -> list[dict[str, Any]]:
    """The card types of the active extensions that no other active extension gives too, for cardtypes.refresh: {slug,
    extension, view (the view whose reader and index it uses), dir (its folder in the workspace's copy), reader, page
    (the file its frame draws, None for view.html), name, block (the `card` block's keys), libs, guide (card.md),
    claims, cache (its index's folder)}. A type whose view reads no file here is left out."""
    from . import views  # noqa: PLC0415

    if not c:
        return []
    clash = conflicts(read_state(c)["extensions"])["card"]
    out = []
    for e in active(c):
        here, src = Path(e["dir"]), Path(e["src"])
        claims = {v["slug"]: _words(((e.get("claims") or {}).get(v["slug"]) or {}).get("claims")) for v in e.get("views") or []}
        found = [(v["slug"], v["slug"], "views", views.VIEW_JSON, None) for v in e.get("views") or [] if v.get("card")]
        found += [(t["slug"], t["reader"], "cards", CARD_JSON, CARD_HTML) for t in e.get("cards") or []]
        for slug, view, kind, manifest, page in found:
            if slug in clash or not claims.get(view):
                continue
            raw = _json(src / kind / slug / manifest)
            block = raw.get("card") if kind == "views" else raw
            name = raw.get("name") or _json(src / "views" / view / views.VIEW_JSON).get("name") or slug
            out.append({"slug": slug, "extension": e["name"], "view": view, "dir": str(here / kind / slug),
                        "reader": str(here / "views" / view / views.READER_PY), "page": page,
                        "name": " ".join(str(name).split()), "block": block if isinstance(block, dict) else {},
                        "libs": raw.get("libs") or _json(src / "views" / view / views.VIEW_JSON).get("libs"),
                        "guide": _text(src / kind / slug / GUIDE), "claims": claims[view],
                        "cache": str(views.views_dir(c) / CACHE_DIR / e["name"] / view)})
    return out


def report_types(c: str | None) -> list[dict[str, Any]]:
    """The report types the active extensions offer here, in the preset form ({id, name, description, renderer,
    prompt}) plus {extension, dir, export}: those marked `default`, and those a view of theirs that the workspace has
    names in its `reports`. `dir` is the type's folder in the workspace's copy, where an `exports` kernel reads
    export.py."""
    if not c:
        return []
    from . import views  # noqa: PLC0415

    here = {str(p.get("slug")): p for p in views.list_proposals(c) if p.get("extension")}
    out = []
    for e in active(c):
        named = {r for v in e.get("views") or [] for r in v.get("reports") or []
                 if (here.get(v["slug"]) or {}).get("extension") == e["name"] and views.read_built(c, v["slug"])}
        for r in e.get("report_types") or []:
            if not (r.get("default") or r["slug"] in named):
                continue
            try:
                front, body = frontmatter((Path(e["src"]) / "report-types" / r["slug"] / TYPE_MD).read_text("utf-8"))
            except OSError:
                continue
            d = Path(e["dir"]) / "report-types" / r["slug"]
            renderer = "page" if str(front.get("renderer") or "").strip().lower() == "page" else "document"
            out.append({"id": r["slug"], "name": " ".join(str(front.get("name") or r["slug"]).split()),
                        "description": " ".join(str(front.get("description") or "").split()), "renderer": renderer,
                        "prompt": body, "extension": e["name"], "dir": str(d),
                        "export": str(d / EXPORT_PY) if (d / EXPORT_PY).is_file() else None})
    return out


# --------------------------------------------------------------------------- `thimble extension`

GIT_RE = re.compile(r"^(?:https?://|ssh://|git@|file://)|\.git/?$")


class AddError(Exception):
    """Why `thimble extension add` cannot add what it was given."""


def fetch(source: str, into: Path) -> tuple[Path, dict[str, Any]]:
    """The folder of the extension `source` names, and how it was found ({source, kind, commit?}): a built-in extension's
    name, a local folder, or a git URL, cloned into `into` (no hooks, no submodules). AddError when it is none of them."""
    src = source.strip()
    if NAME_RE.match(src) and (builtin_dir() / src / MANIFEST).is_file() and not Path(src).exists():
        return builtin_dir() / src, {"source": src, "kind": "built-in"}
    local = Path(src).expanduser()
    if local.is_dir():
        return local.resolve(), {"source": str(local.resolve()), "kind": "folder"}
    if not GIT_RE.search(src):
        names = ", ".join(sorted(d.name for d in _subdirs(builtin_dir()) if (d / MANIFEST).is_file())) or "none"
        raise AddError(f"{src!r} is no folder, git URL or built-in extension (built-in: {names})")
    if shutil.which("git") is None:
        raise AddError("adding from a git URL needs git, which is not installed")
    import subprocess  # noqa: PLC0415

    dest = into / "clone"
    run = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--depth", "1",
                          "--no-recurse-submodules", "--", src, str(dest)], capture_output=True, text=True, timeout=300,
                         env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    if run.returncode != 0:
        raise AddError(f"git could not clone {src}: {(run.stderr or run.stdout).strip()[-400:]}")
    commit = subprocess.run(["git", "-C", str(dest), "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    return dest, {"source": src, "kind": "git", "commit": commit.stdout.strip()}


def summary(info: dict[str, Any], how: dict[str, Any]) -> list[str]:
    """What `thimble extension add` shows before it asks: what the extension gives, and where its code runs."""
    v = f" {info['version']}" if info["version"] else ""
    at = f" at {how['commit']}" if how.get("commit") else ""
    out = [f"{info['name']}{v}, from {how['source']}{at}"]
    if info["description"]:
        out.append(f"  {info['description']}")
    if info["applies"]:
        out.append(f"  Runs in workspaces its view {info['applies']!r} finds records in.")
    for x in info["views"]:
        shown = "shown whenever it applies" if x["show"] == "always" else "proposed by the orientation"
        out.append(f"  view        {x['slug']} ({shown})" + (", also a card type" if x["card"] else ""))
    for x in info["cards"]:
        out.append(f"  card type   {x['slug']} (read by its view {x['reader']})")
    for a in info["agents"]:
        out.append(f"  agent       {a}, in the orientation's session, without the web unless thimble's config sets "
                   f"agents.\"{info['name']}:{a}\".web")
    if info["orient"]:
        out.append("  orientation adds its orient.md to the orientation's instructions")
    for block in info["replaces"]:
        out.append(f"  orientation replaces the block {block!r}, unless your own setting or another extension does")
    for r in info["report_types"]:
        out.append(f"  report type {r['slug']}" + (" (offered in every workspace it runs in)" if r["default"] else "")
                   + (", with its own exports" if r["export"] else ""))
    out.append("  Its Python (readers, card code, export hooks) runs in thimble's kernels, with the same sandbox and "
               "network as cells. thimble installs nothing for it.")
    if info["requires"]:
        out.append(f"  It needs the Python packages {', '.join(info['requires'])}.")
    return out


def add(source: str, *, yes: bool = False, ask: Any = input, say: Any = print) -> str | None:
    """`thimble extension add`: fetch the extension, show what it gives (summary), and copy it into extensions_dir()
    once the analyst says yes (or `yes`). Returns its name, None when the analyst said no. AddError for an extension
    that cannot load for a reason of its own folder."""
    import tempfile  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="thimble-ext-") as tmp:
        root, how = fetch(source, Path(tmp))
        info = read_extension(root)
        fatal = [x for x in info["problems"] if not x.startswith("it needs the Python package")]
        if fatal:
            raise AddError(f"{source} cannot be added: " + "; ".join(fatal))
        dig, size = digest(root)
        if size > SIZE_MAX:
            raise AddError(f"{source} holds {size:,} bytes, and an extension may hold {SIZE_MAX:,}")
        name = info["name"]
        for line in summary(info, how):
            say(line)
        for x in info["problems"]:
            say(f"  It stays unloaded until then: {x}.")
        dest = source_path(name)
        if dest.is_dir():
            old = read_extension(dest, name)
            say(f"  It replaces the {name} already added{' (' + old['version'] + ')' if old['version'] else ''}.")
        if not yes:
            try:
                answer = ask("Add it? [y/N] ")
            except EOFError:
                answer = ""
            if str(answer).strip().lower() not in ("y", "yes"):
                return None
        extensions_dir().mkdir(parents=True, exist_ok=True)
        copy_tree(root, dest)
        write_json(dest / ADDED, {**how, "digest": dig, "ts": _now()})
    return name


def remove(name: str) -> bool:
    """`thimble extension remove`: delete the added extension's folder. False when there is none of that name."""
    dest = source_path(name)
    if not NAME_RE.match(name) or not (dest / MANIFEST).is_file():
        return False
    shutil.rmtree(dest)
    return True


def list_lines(workspaces_dir: Path) -> list[str]:
    """`thimble extension list`: a line per added extension (name, version, source, and whether it loads), then a line
    per workspace that found it, saying whether it runs there and why not."""
    got = added()
    if not got:
        return ["no extensions added; `thimble extension add <git URL | folder | built-in name>` adds one"]
    conf = user_config()
    seen: dict[str, list[str]] = {}
    try:
        folders = sorted(d for d in workspaces_dir.iterdir() if (d / STATE_FILE).is_file())
    except OSError:
        folders = []
    for d in folders:
        exts = _json(d / STATE_FILE).get("extensions") or {}
        for n, e in exts.items() if isinstance(exts, dict) else ():
            if isinstance(e, dict):
                seen.setdefault(n, []).append(f"{d.name}: {'on' if e.get('active') else 'off (' + str(e.get('why') or '') + ')'}")
    out = []
    for name, root in got.items():
        info = read_extension(root, name)
        state = ("not loaded: " + info["problems"][0] if info["problems"]
                 else "off in thimble's config" if user_off(name, conf) else "on")
        out.append(f"{name}  {info['version'] or '-'}  {info['source'] or '-'}  {state}")
        out += [f"    {x}" for x in seen.get(name, [])]
    return out


def _now() -> str:
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- thimble doctor


def doctor_line() -> str:
    """The extensions added, why any cannot load or is off, and the conflicts among those that load."""
    got = added()
    if not got:
        return "none added"
    conf = user_config()
    parts, loadable = [], {}
    for name, root in got.items():
        info = read_extension(root, name)
        v = f" {info['version']}" if info["version"] else ""
        if info["problems"]:
            parts.append(f"{name}{v} (not loaded: {info['problems'][0]})")
        elif user_off(name, conf):
            parts.append(f"{name}{v} (off in thimble's config)")
        else:
            parts.append(f"{name}{v}")
            loadable[name] = {**info, "active": True}
    return "; ".join(parts + [f"conflict: {x}" for x in conflict_lines(conflicts(loadable))])


# --------------------------------------------------------------------------- routes

router = APIRouter()


def public(c: str) -> dict[str, Any]:
    """Settings' extensions: each one added, whether it runs here and why not, whether this workspace's switch is on
    and whether it cannot run here whatever that switch says (`locked`), and the conflicts among those that run."""
    state = read_state(c)
    conf = user_config()
    out = []
    for name, e in sorted(state["extensions"].items()):
        out.append({"name": name, "title": e.get("title") or name, "version": e.get("version") or "",
                    "active": bool(e.get("active")), "why": e.get("why") or "", "on": name not in state["off"],
                    "locked": user_off(name, conf) or bool(e.get("problems"))})
    return {"extensions": out, "conflicts": conflict_lines(conflicts(state["extensions"]))}


@router.get("/ws/{c}/extensions")
async def list_route(c: str) -> dict[str, Any]:
    """The extensions added, found again for this workspace (refresh)."""
    config.workspace_dir(c)
    await refresh_quietly(c)
    return await asyncio.to_thread(public, c)


class SwitchBody(BaseModel):
    on: bool


@router.put("/ws/{c}/extensions/{name}")
async def switch_route(c: str, name: str, body: SwitchBody, request: Request) -> dict[str, Any]:
    """Settings' switch of one extension for this workspace, which only the analyst's browser may turn."""
    from . import cardtypes, hook_auth  # noqa: PLC0415

    config.workspace_dir(c)
    if not hook_auth.analyst(request):
        raise HTTPException(403, hook_auth.ANALYST_ONLY)
    if name not in read_state(c)["extensions"]:
        raise HTTPException(404, f"no extension {name!r} in this workspace")
    await asyncio.to_thread(set_enabled, c, name, body.on)
    await refresh_quietly(c)
    await cardtypes.announce(c)
    return await asyncio.to_thread(public, c)


@router.post("/extensions/refresh")
async def refresh_route() -> dict[str, Any]:
    """`thimble extension add` and `remove`: every workspace a session is connected to finds its extensions again at
    once. {workspaces: {c: [the extensions active there]}}."""
    from . import channel  # noqa: PLC0415

    out = {}
    for c in channel.connected_workspaces():
        await connected(c)
        out[c] = [e["name"] for e in active(c)]
    return {"workspaces": out}
