"""Extensions: folders that add views, card types, agents, report types and orientation instructions to thimble.
`thimble extension add` copies one into $THIMBLE_HOME/extensions/<name>/ after the analyst said yes (cli.py), and from
then on it runs in every workspace it applies to, until it is removed or switched off. Its folder:

  extension.json        {"api": 0, "name": "<name>", "version", "description", "applies": "<the corpora it is for, in
                         plain words>", "check": "<slug>", "requires": ["<python package>", ...],
                         "replaces": {"<orientation block>": "<file>.md"}}
  views/<slug>/         a view (views.py), with `show` ("always" or "proposed") and `reports` in view.json; a `card`
                        block and card.py make it a card type too (cardtypes.py), and card.md is the type's guide
  cards/<slug>/         a card type of its own: card.json (the keys of a `card` block, plus `reader`, the extension's
                        view whose reader and index it uses, unless the folder holds a reader.py of its own, which reads
                        the files the extension claims), card.py, card.html, card.md; its slug may be a view's that has
                        no `card` block
  agents/<name>.md      an agent the orientation's session gets with --agents (agent_definitions)
  report-types/<slug>/  type.md in the preset format plus `default`; export.py for its own exports
  orient.md             added to the orientation's instructions, `{{files}}` in it standing for the files the extension
                        claims; `replaces` names blocks thimble has a default for (orient_session.BLOCKS) that the
                        extension's own files take the place of (orient_blocks)

Added means running. An extension is active in a workspace when it loads (read_extension finds no problem), thimble's
config does not switch it off (`extensions.<name>.enabled: false`, for every workspace) and it applies here, which the
analyst's switch in Settings overrides either way. Whether it applies is decided once per workspace and made again when
the corpus's files change (_decision): with an `applies`, one quick model call decides from that description, the
corpus's files and a few of its records (ext_applies.py), and names the files it claims. `check` may name one of its
views, or a card type with a reader of its own, whose reader's applies(paths) is a fast pre-check: None settles that it
does not apply with no call, and the files it names are the first the call samples, or with no `applies` the files it
claims. With neither, it applies everywhere and claims the record files. The call runs in the background; until it
answers, and when it fails, the extension is off here and Settings says why.

refresh() copies an active extension into workspaces/<c>/extensions/<name>/, since a kernel sees only the workspace
and the corpus, and writes STATE_FILE. Its `show: always` views are installed at once, outside the orientation's four;
its `show: proposed` views are the orientation's to propose (views.propose_builtins). When it first becomes active in a
workspace an orientation ran in, its orient.md goes to the orientation as one follow-up; the workspace keeps that mark
(`oriented`) when the extension is switched off or removed, so switching it on or adding it again starts none. A view
it installed that nobody changed goes when it stops being active or no longer gives that view. A view thimble installed
from a viewer it no longer ships, unchanged since, gives way to an active extension's view of its slug, and goes when
none gives one.

Two active extensions that give the same view or card type, or replace the same orientation block, lose it both: the
view, type or block is left out (the block stays thimble's), and Settings and `thimble doctor` name the conflict.

Extension code runs only in thimble's kernels: readers on the views kernel, card.py in a card's kernel. The server reads
only its JSON and markdown, from the folder in thimble's home rather than the copy a kernel can write, and its agents
run inside the orientation's session, under that session's sandbox and rules, with the settings thimble's config gives
them (agent_definitions)."""
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

from . import config, userconf
from .ledger import read_json, write_json

log = logging.getLogger("thimble.extensions")

API = 0
MANIFEST = "extension.json"
ADDED = ".added.json"  # written by `thimble extension add`: {source, kind, commit?, ts}
NAME_RE = userconf.EXTENSION_NAME_RE
RESERVED = ("thimble",)
WS_DIR = "extensions"  # under the workspace: each active extension's copy
STATE_FILE = "extensions.json"  # in the workspace
CACHE_DIR = ".extensions"  # under the workspace's views folder: extension readers' indexes, by extension and view
SHOWS = ("always", "proposed")
CARD_JSON, CARD_HTML, GUIDE = "card.json", "card.html", "card.md"
TYPE_MD, EXPORT_PY, ORIENT_MD = "type.md", "export.py", "orient.md"
SIZE_MAX = 50 * 1024 * 1024  # bytes of an extension's folder
SKIPPED = ("__pycache__", ".git", "cache", ADDED)
WEB_TOOLS = userconf.WEB_TOOLS
CONFIG_UNREAD = "thimble's config cannot be read"
NOT_HERE = "it does not apply to this corpus"
ASKING = "thimble is deciding whether it applies here"
DECIDE_WAIT_S = 180  # what an orientation's start waits for a decision still being made
RETRY_S = 300  # a failed decision stands this long before a refresh asks again

_locks: dict[str, asyncio.Lock] = {}
_asking: dict[tuple[str, str], dict[str, Any]] = {}  # (workspace, extension) -> {key, task}
_waiting: dict[str, int] = {}  # workspace -> refreshes waiting for its decisions (refresh)


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


def config_off(name: str, off: set[str] | None) -> str:
    """Why thimble's config keeps extension `name` off in every workspace, '' when it does not; `off` is
    userconf.extensions_off()."""
    if off is None:
        return CONFIG_UNREAD
    return "off in thimble's config" if name in off else ""


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
        own = (d / views.READER_PY).is_file()
        reader = None if own else str(_json(d / CARD_JSON).get("reader") or "")
        if not all((d / f).is_file() for f in (CARD_JSON, "card.py", CARD_HTML)):
            problems.append(f"its card type {d.name!r} lacks {CARD_JSON}, card.py or {CARD_HTML}")
        elif not own and reader not in slugs:
            problems.append(f"its card type {d.name!r} has no {views.READER_PY} and reads with the view {reader!r}, "
                            f"which it does not have")
        elif any(v["slug"] == d.name and v["card"] for v in vs):
            problems.append(f"its card type {d.name!r} has the slug of one of its views that is a card type")
        else:
            cards.append({"slug": d.name, "reader": reader})
    agents = sorted(p.stem for p in (root / "agents").glob("*.md") if NAME_RE.match(p.stem)) if (root / "agents").is_dir() else []
    reports = []
    for d in _subdirs(root / "report-types"):
        if (d / TYPE_MD).is_file():
            front, _ = frontmatter((d / TYPE_MD).read_text("utf-8"))
            reports.append({"slug": d.name, "name": " ".join(str(front.get("name") or d.name).split()),
                            "default": front.get("default") is True, "export": (d / EXPORT_PY).is_file()})
    applies = " ".join(str(raw.get("applies") or "").split()) or None
    check = str(raw.get("check") or "") or None
    if check and check not in slugs and not any(t["slug"] == check and t["reader"] is None for t in cards):
        problems.append(f"its check {check!r} names neither one of its views nor a card type of its own with a "
                        f"{views.READER_PY}")
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
            "root": str(root), "applies": applies, "check": check, "requires": requires, "problems": problems, "views": vs,
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
    """{off, on, oriented, extensions} as refresh() last wrote them: the extensions switched off here, those switched on
    here whatever the decision says, those whose orientation instructions the orientation had or started with, whether
    or not they run here now, and each extension found, active or not."""
    got: Any = {}
    if c:
        try:
            got = read_json(_state_path(c), {})
        except (OSError, ValueError, HTTPException):
            got = {}
    got = got if isinstance(got, dict) else {}
    exts = got.get("extensions") if isinstance(got.get("extensions"), dict) else {}
    return {"off": _words(got.get("off")), "on": _words(got.get("on")), "oriented": _words(got.get("oriented")),
            "extensions": exts}


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


def _check_folder(info: dict[str, Any]) -> tuple[str, str] | None:
    """(kind, slug) of the reader the extension's `check` names, None when it names none."""
    target = info.get("check")
    if not target:
        return None
    return ("views" if any(v["slug"] == target for v in info.get("views") or []) else "cards"), target


async def _claims(c: str, d: Path, paths: list[str], kept: dict[str, Any], check: bool = False) -> dict[str, Any]:
    """{src, claims, found} of the reader in folder `d` for this corpus: what its applies() names when its view.json
    says `applies`, or when it is the extension's `check`, else the claims of view.json when they match files here.
    `kept` is the last answer, reused while the reader's source is the same, and for a check the record files too."""
    from . import views  # noqa: PLC0415

    raw = _json(d / views.VIEW_JSON)
    try:
        h = hashlib.sha1((d / views.READER_PY).read_bytes())
    except OSError:
        return {"src": "", "claims": [], "found": ""}
    if check:
        h.update("\0".join(paths).encode())
    src = h.hexdigest()[:12]
    if kept.get("src") == src and isinstance(kept.get("claims"), list):
        return kept
    if not raw.get("applies") and not check:
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


def _stale(decision: dict[str, Any]) -> bool:
    """Whether a failed decision has stood RETRY_S, so a refresh asks again."""
    from datetime import datetime, timezone  # noqa: PLC0415

    try:
        at = datetime.fromisoformat(str(decision.get("ts") or ""))
    except ValueError:
        return True
    return (datetime.now(timezone.utc) - at).total_seconds() >= RETRY_S


def _answered(c: str, entry: dict[str, Any]) -> None:
    """A decision came back while no refresh waited for it: the workspace finds its extensions again (connected)."""
    if _waiting.get(c) or entry["task"].cancelled():
        return
    asyncio.get_running_loop().create_task(connected(c), name=f"extensions-{c}")


def _start(c: str, name: str, at: str, info: dict[str, Any], files: list[tuple[str, int]], first: list[str]) -> None:
    from . import ext_applies  # noqa: PLC0415

    entry: dict[str, Any] = {"key": at}
    entry["task"] = asyncio.get_running_loop().create_task(
        ext_applies.decide(c, info["title"], info["applies"], files, first, at), name=f"extension-applies-{c}-{name}")
    entry["task"].add_done_callback(lambda _t: _answered(c, entry))
    _asking[(c, name)] = entry


async def _decision(c: str, name: str, info: dict[str, Any], pre: dict[str, Any] | None, paths: list[str],
                    kept: dict[str, Any]) -> dict[str, Any]:
    """Whether extension `name` applies to workspace `c`: {applies, claims, reason, by} with `key` for a model's
    decision, {key, error, ts} when its call failed, or {key, pending} while it runs (_start). `pre` is what its check
    found ({claims, found}), None without one; `paths` the corpus's record files; `kept` the decision STATE_FILE holds,
    which stands while its key does (ext_applies.key)."""
    from . import ext_applies  # noqa: PLC0415

    if pre is not None and not pre.get("claims"):
        return {"applies": False, "claims": [], "reason": str(pre.get("found") or ""), "by": "check"}
    if not info["applies"]:
        return {"applies": True, "claims": list(pre["claims"] if pre else paths), "reason": str((pre or {}).get("found") or ""),
                "by": "check" if pre else "none"}
    files = await asyncio.to_thread(ext_applies.files_of, c)
    first = list((pre or {}).get("claims") or [])
    at = ext_applies.key(info["applies"], first, files)
    got = _asking.get((c, name))
    if got is not None and got["key"] == at and got["task"].done():
        _asking.pop((c, name), None)
        try:
            return got["task"].result()
        except Exception as e:  # noqa: BLE001 — a decision that failed decides nothing
            log.exception("%s: whether %s applies is not known", c, name)
            return {"key": at, "error": f"{type(e).__name__}: {e}", "ts": _now()}
    if kept.get("key") == at and ("applies" in kept or (kept.get("error") and not _stale(kept))):
        return kept
    if got is None or got["key"] != at:
        _start(c, name, at, info, files, first)
    return {"key": at, "pending": True}


async def refresh(c: str, wait: float = 0.0) -> dict[str, Any]:
    """The workspace's extensions found again (_refresh). A decision on whether one applies that is still being made
    (_decision) is waited for up to `wait` seconds, and then the extensions are found again; one that answers while no
    refresh waits has the workspace find them again itself (_answered). Returns the state."""
    if wait <= 0:
        return await _refresh(c)
    _waiting[c] = _waiting.get(c, 0) + 1
    try:
        state = await _refresh(c)
        running = [e["task"] for (w, _), e in list(_asking.items()) if w == c and not e["task"].done()]
        if running:
            await asyncio.wait(running, timeout=wait)
        if any(w == c and e["task"].done() for (w, _), e in list(_asking.items())):
            state = await _refresh(c)
        return state
    finally:
        _waiting[c] -= 1


async def settle(c: str) -> None:
    """Before an orientation starts: a decision still being made is waited for, so the orientation starts with the
    instructions and agents of the extensions that apply, and main hears of their card types."""
    from . import cardtypes  # noqa: PLC0415

    if any(w == c and not e["task"].done() for (w, _), e in list(_asking.items())):
        await refresh_quietly(c, wait=DECIDE_WAIT_S)
        await cardtypes.announce(c)


async def _refresh(c: str) -> dict[str, Any]:
    """The workspace's extensions found again in extensions_dir(), each active one copied in, its views' claims found
    and whether it applies decided (_decision), written to STATE_FILE; then the views no active extension gives any
    more withdrawn, the always-views installed, and the orientation told of the newly active ones. Returns the state."""
    from . import corpus, views  # noqa: PLC0415

    lock = _locks.setdefault(c, asyncio.Lock())
    async with lock:
        state = read_state(c)
        off = await asyncio.to_thread(userconf.extensions_off)
        paths: list[str] | None = None
        exts: dict[str, Any] = {}
        for name, root in (await asyncio.to_thread(added)).items():
            info = await asyncio.to_thread(read_extension, root, name)
            kept = state["extensions"].get(name) or {}
            why = info["problems"][0] if info["problems"] else ""
            why = why or config_off(name, off)
            why = why or ("off in this workspace" if name in state["off"] else "")
            claims: dict[str, Any] = {}
            pre: dict[str, Any] | None = None
            decision: dict[str, Any] = dict(kept.get("decision") or {})
            files: list[str] = []
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
                    if (folder := _check_folder(info)) is not None:
                        pre = await _claims(c, here / folder[0] / folder[1], paths, kept.get("check") or {}, check=True)
                    decision = await _decision(c, name, info, pre, paths, decision)
                    forced = name in state["on"]
                    if decision.get("pending"):
                        why = "" if forced else ASKING
                    elif decision.get("error"):
                        why = "" if forced else f"thimble could not tell whether it applies here: {decision['error']}"
                    elif not decision.get("applies"):
                        why = "" if forced else NOT_HERE
                    files = list(decision.get("claims") or (paths if forced else []))
            exts[name] = {**{k: v for k, v in info.items() if k != "name"}, "claims": claims, "check": pre,
                          "decision": decision, "files": files, "active": not why, "why": why}
        now = {n for n, e in exts.items() if e.get("active")}
        fresh = sorted(now - set(state["oriented"]))
        new_state = {"off": state["off"], "on": state["on"], "oriented": sorted({*state["oriented"], *fresh}),
                     "extensions": exts}
        await asyncio.to_thread(write_json, _state_path(c), new_state)
        for name in sorted(set(state["extensions"]) - set(exts)):
            await asyncio.to_thread(shutil.rmtree, workspace_path(c, name), True)
    await asyncio.to_thread(_withdraw_given_up, c, exts)
    await asyncio.to_thread(install_views, c)
    for slug in await asyncio.to_thread(views.orphaned, c):
        await asyncio.to_thread(views.withdraw, c, slug, None)
    await _orient(c, fresh)
    return new_state


async def refresh_quietly(c: str, wait: float = 0.0) -> dict[str, Any]:
    try:
        return await refresh(c, wait)
    except Exception:  # noqa: BLE001 — the extensions stored stay as they were
        log.exception("%s: the extensions were not found", c)
        return read_state(c)


async def connected(c: str) -> None:
    """Main's session connected: the extensions found again, then the card types, which main hears of when they are
    new."""
    from . import cardtypes  # noqa: PLC0415

    await refresh_quietly(c)
    await cardtypes.announce(c)


def _withdraw_given_up(c: str, exts: dict[str, Any]) -> None:
    """Take out each view an extension installed here, unchanged since, whose extension is no longer active here or no
    longer gives that view."""
    from . import views  # noqa: PLC0415

    for p in views.list_proposals(c):
        name, slug = p.get("extension"), str(p.get("slug") or "")
        if not name:
            continue
        e = exts.get(name) or {}
        if not (e.get("active") and any(v["slug"] == slug for v in e.get("views") or [])):
            views.withdraw(c, slug, name)


def install_views(c: str) -> list[str]:
    """Install each `show: always` view of the active extensions that applies here, unless the workspace has a view or
    proposal of that slug or the analyst deleted it; a view installed from an older version of the extension, or
    thimble's install of a viewer it no longer ships (views.orphaned), that nobody changed is replaced. Returns the
    slugs installed."""
    from . import views  # noqa: PLC0415

    made = []
    gone = {str(d.get("slug")) for d in views.deleted_proposals(c)}
    orphans = set(views.orphaned(c))
    for v in views_of(c, "always"):
        slug, d = v["slug"], Path(v["dir"])
        if not v["claims"] or slug in gone:
            continue
        prop = views.read_proposal(c, slug)
        if (prop is not None or slug in views._view_dirs(c)) and slug not in orphans:
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
        text = _orient_text(exts.get(name) or {}, source_path(name))
        if not text:
            continue
        try:
            await orient_session.message(c, text, orient_session.EXTENSION, extension=exts[name].get("title") or name)
        except orient_session.NoOrientation:
            pass
        except (orient_session.Gone, RuntimeError, ValueError) as e:
            log.warning("%s: the orientation was not given the extension %s: %s", c, name, e)


def set_enabled(c: str, name: str, on: bool) -> None:
    """Settings' switch of extension `name` for workspace `c`, which overrides the decision on whether it applies either
    way."""
    state = read_state(c)
    off = [n for n in state["off"] if n != name] + ([] if on else [name])
    forced = [n for n in state["on"] if n != name] + ([name] if on else [])
    write_json(_state_path(c), {**state, "off": sorted(off), "on": sorted(forced)})


# --------------------------------------------------------------------------- contributions


def _orient_text(e: dict[str, Any], src: Path) -> str:
    """An extension's orient.md, `{{files}}` in it filled with the files it claims in the workspace."""
    text = _text(src / ORIENT_MD) if e.get("orient") else ""
    return text.replace("{{files}}", ", ".join(f"`{x}`" for x in _words(e.get("files"))) or "(none)")


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
        text = _orient_text(e, src)
        if text:
            added_.append((str(e.get("title") or e["name"]), text))
        for block, f in (e.get("replaces") or {}).items():
            if block not in clash and (got := _text(src / f)):
                replaced[block] = got
    return {"added": added_, "replaced": replaced, "conflicts": clash}


def agent_definitions(c: str | None) -> dict[str, dict[str, Any]]:
    """The active extensions' agents as `--agents` takes them, with thimble's config's settings for each,
    `agents."<ext>:<name>"` (userconf.extension_agent): its model and effort, else its own file's, else those the
    orientation's session gives its subagents; a `prompt` file in place of its text; the web tools taken away while its
    web is off; and Bash taken away while its network is off and the orientation's is on, since the session's sandbox
    gives all its agents one network. An agent two extensions name is `<ext>:<name>` for both."""
    conf = userconf.load_or_defaults(c)[0]
    session_network = conf["agents"]["orientation"].get("network") == "on"
    found: list[tuple[str, str, dict[str, Any]]] = []
    for e in active(c):
        for name in e.get("agents") or []:
            try:
                front, body = frontmatter((Path(e["src"]) / "agents" / f"{name}.md").read_text("utf-8"))
            except OSError:
                continue
            mine = userconf.extension_agent(conf, f"{e['name']}:{name}")
            if mine["prompt"]:
                try:
                    body = Path(mine["prompt"]).expanduser().read_text("utf-8").strip()
                except OSError:
                    log.warning("the prompt file %s of agents.%s:%s cannot be read", mine["prompt"], e["name"], name)
            agent: dict[str, Any] = {"description": " ".join(str(front.get("description") or "").split()), "prompt": body}
            tools = front.get("tools")
            tools = [x.strip() for x in (tools.split(",") if isinstance(tools, str) else tools or []) if str(x).strip()]
            for key in ("model", "effort"):
                if v := mine[key] or front.get(key):
                    agent[key] = str(v)
            taken = [*(WEB_TOOLS if mine["web"] == "off" else ()),
                     *(("Bash",) if mine["network"] == "off" and session_network else ())]
            if taken:
                agent["disallowedTools"] = list(taken)
                tools = [t for t in tools if t not in taken]
            if tools:
                agent["tools"] = tools
            found.append((e["name"], name, agent))
    counts: dict[str, int] = {}
    for _, name, _ in found:
        counts[name] = counts.get(name, 0) + 1
    return {(name if counts[name] == 1 else f"{ext}:{name}"): agent for ext, name, agent in found}


def agent_models(c: str | None) -> dict[str, dict[str, Any]]:
    """The Settings rows of the active extensions' agents, by config key ("<ext>:<name>"): the model and effort each
    runs at, as agent_definitions resolves them (the config's, else its file's, else the orientation's subagents'
    model and its session's effort, ''), `fast` False since it runs at its session's speed, and `extension`."""
    conf = userconf.load_or_defaults(c)[0]
    subagents = config.models_for(c)["subagents"]["model"]
    out: dict[str, dict[str, Any]] = {}
    for e in active(c):
        for name in e.get("agents") or []:
            try:
                front, _ = frontmatter((Path(e["src"]) / "agents" / f"{name}.md").read_text("utf-8"))
            except OSError:
                continue
            key = f"{e['name']}:{name}"
            mine = userconf.extension_agent(conf, key)
            model = str(mine["model"] or front.get("model") or "")
            out[key] = {"model": config.exact_model(model) if model else subagents,
                        "effort": str(mine["effort"] or front.get("effort") or ""), "fast": False, "extension": e["name"]}
    return out


def card_types(c: str | None) -> list[dict[str, Any]]:
    """The card types of the active extensions that no other active extension gives too, for cardtypes.refresh: {slug,
    extension, view (the view whose reader and index it uses, None for a type with a reader of its own), dir (its
    folder in the workspace's copy), reader, page (the file its frame draws, None for view.html), name, block (the
    `card` block's keys), libs, guide (card.md), claims (its view's, or for a reader of its own the files the extension
    claims), cache (its index's folder)}. A type whose reader reads no file here is left out."""
    from . import views  # noqa: PLC0415

    if not c:
        return []
    clash = conflicts(read_state(c)["extensions"])["card"]
    out = []
    for e in active(c):
        here, src = Path(e["dir"]), Path(e["src"])
        claims = {k: _words((v or {}).get("claims")) for k, v in (e.get("claims") or {}).items()}
        own = _words(e.get("files"))
        found = [(v["slug"], v["slug"], "views", views.VIEW_JSON, None) for v in e.get("views") or [] if v.get("card")]
        found += [(t["slug"], t["reader"], "cards", CARD_JSON, CARD_HTML) for t in e.get("cards") or []]
        for slug, view, kind, manifest, page in found:
            key = view if view is not None else f"cards/{slug}"
            read = claims.get(view) if view is not None else own
            if slug in clash or not read:
                continue
            raw = _json(src / kind / slug / manifest)
            block = raw.get("card") if kind == "views" else raw
            of_view = _json(src / "views" / view / views.VIEW_JSON) if view is not None else {}
            reader = here / "views" / view if view is not None else here / "cards" / slug
            out.append({"slug": slug, "extension": e["name"], "view": view, "dir": str(here / kind / slug),
                        "reader": str(reader / views.READER_PY), "page": page,
                        "name": " ".join(str(raw.get("name") or of_view.get("name") or slug).split()),
                        "block": block if isinstance(block, dict) else {}, "libs": raw.get("libs") or of_view.get("libs"),
                        "guide": _text(src / kind / slug / GUIDE), "claims": read,
                        "cache": str(views.views_dir(c) / CACHE_DIR / e["name"] / key)})
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
        out.append(f"  Runs in each workspace a quick model call finds it fits: {info['applies']}")
    if info["check"]:
        alone = "" if info["applies"] else ", and decides alone"
        out.append(f"  Its {info['check']} reader checks each corpus first{alone}.")
    for x in info["views"]:
        shown = "shown whenever it applies" if x["show"] == "always" else "proposed by the orientation"
        out.append(f"  view        {x['slug']} ({shown})" + (", also a card type" if x["card"] else ""))
    for x in info["cards"]:
        read = f"read by its view {x['reader']}" if x["reader"] else "with a reader of its own"
        out.append(f"  card type   {x['slug']} ({read})")
    for a in info["agents"]:
        out.append(f"  agent       {a}, in the orientation's session and its sandbox, without the web unless "
                   f"thimble's config sets agents.\"{info['name']}:{a}\".web")
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
    per workspace: on or off there, with the reason thimble's decision on whether it applies gave, or why it is off, or
    that no session connected there since it was added."""
    got = added()
    if not got:
        return ["no extensions added; `thimble extension add <git URL | folder | built-in name>` adds one"]
    off = userconf.extensions_off()
    try:
        folders = sorted(d for d in workspaces_dir.iterdir() if d.is_dir() and config._valid_name(d.name))
    except OSError:
        folders = []
    states = {d.name: _json(d / STATE_FILE) for d in folders}
    width = max((len(d.name) for d in folders), default=0)
    out = []
    for name, root in got.items():
        info = read_extension(root, name)
        loads = "not loaded: " + info["problems"][0] if info["problems"] else config_off(name, off) or "loads"
        v = f" {info['version']}" if info["version"] else ""
        out.append(f"{name}{v}, from {info['source'] or root}: {loads}")
        for d in folders:
            state = states[d.name]
            e = (state.get("extensions") or {}).get(name) if isinstance(state.get("extensions"), dict) else None
            if not isinstance(e, dict):
                line = "not checked yet: no session connected here since it was added"
            else:
                why = str(e.get("why") or "")
                reason = " ".join(str((e.get("decision") or {}).get("reason") or "").split())
                if e.get("active"):
                    switched = " (switched on here)" if name in _words(state.get("on")) else ""
                    line = f"on{switched}" + (f"   {reason}" if reason else "")
                else:
                    line = f"off  {why}" + (f": {reason}" if why == NOT_HERE and reason else "")
            out.append(f"  {d.name.ljust(width)}  {line}")
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
    off = userconf.extensions_off()
    parts, loadable = [], {}
    for name, root in got.items():
        info = read_extension(root, name)
        v = f" {info['version']}" if info["version"] else ""
        if info["problems"]:
            parts.append(f"{name}{v} (not loaded: {info['problems'][0]})")
        elif why := config_off(name, off):
            parts.append(f"{name}{v} ({why})")
        else:
            parts.append(f"{name}{v}")
            loadable[name] = {**info, "active": True}
    return "; ".join(parts + [f"conflict: {x}" for x in conflict_lines(conflicts(loadable))])


# --------------------------------------------------------------------------- routes

router = APIRouter()


def public(c: str) -> dict[str, Any]:
    """Settings' extensions: each one added, whether it runs here and why not, the reason the decision on whether it
    applies gave, where its switch stands (switched here, else as that decision says), whether it cannot run here
    whatever the switch says (`locked`), and the conflicts among those that run. `note` is the line Settings shows: the
    decision's reason, or why it does not run when that is something else."""
    state = read_state(c)
    off = userconf.extensions_off()
    out = []
    for name, e in sorted(state["extensions"].items()):
        d = e.get("decision") or {}
        why, reason = str(e.get("why") or ""), " ".join(str(d.get("reason") or "").split())
        out.append({"name": name, "title": e.get("title") or name, "version": e.get("version") or "",
                    "active": bool(e.get("active")), "why": why, "reason": reason,
                    "note": reason if not why or why == NOT_HERE else why,
                    "on": name not in state["off"] and (name in state["on"] or bool(d.get("applies"))),
                    "locked": bool(config_off(name, off)) or bool(e.get("problems"))})
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
