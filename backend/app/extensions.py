"""Extensions: folders that add views, card types, agents, orientation instructions and report types to thimble.
`thimble extension add` copies one into $THIMBLE_HOME/extensions/<name>/ after the analyst said yes (cli.py). Its folder:

  extension.json    {"name", "version", "thimble": "<the thimble versions it works with, written as package.json's
                    engines writes them>", "dependencies": {"python": [<package>], "js": [<a library thimble inlines>],
                    "extensions": [<extension>]}}; `requires` is read as dependencies.python
  views/<slug>/     a view (views.py); a `card` block and card.py make it a card type too (cardtypes.py), and card.md is
                    the type's guide
  cards/<slug>/     a card type of its own: card.json (the keys of a `card` block, plus `reader`, the extension's view
                    whose reader and index it uses, or `claims`, the files its own reader.py reads), card.py, card.html,
                    card.md
  agents/<name>.md  an agent the orientation's session gets with --agents (agent_definitions)
  agents/orient.md  added to the orientation's instructions under the extension's name, or in place of thimble's with
                    `replace: true` in its frontmatter; `{{files}}` in it stands for the files its views and card types,
                    and those of the extensions it needs, claim here. An orient.md beside extension.json, and `replaces`
                    in it, are read too
  reports/<slug>/   a report type: type.md in the preset format, whose renderer may also be `video`, and export.py for
                    its own exports; report-types/ is read too

An extension loads when read_extension finds no problem: this thimble is in its range, its Python packages import, its
js names only libraries thimble inlines, and the extensions it needs are added. It is active in a workspace when it
loads, neither thimble's config (`extensions.<name>.enabled: false`) nor the workspace's switch in Settings turns it
off, and the extensions it needs are active there. An active extension's agents and orientation instructions join the orientation, its card types join main's prompt
where their claims match files, and its report types are offered in + New.

Only its views check whether they fit (_fit): one quick model call per view and workspace, from the view's description
and a few records of the files it claims (view_fit.py), kept until those files change. Until it answers, and when it
says no or fails, the view is hidden here and Settings says why; the view's switch in Settings overrides the answer.

refresh() copies an active extension into workspaces/<c>/extensions/<name>/, since a kernel sees only the workspace and
the corpus, and writes STATE_FILE in the workspace's registry folder, which a kernel cannot write
(kernel_wrap.READ_ONLY_DIRS). Its shown views are installed, outside the orientation's four, and one it installed that
nobody changed goes when it is no longer shown. When an extension first becomes active in a workspace an orientation ran
in, its orientation instructions go to the orientation as one follow-up; the workspace keeps that mark (`oriented`)
when the extension is switched off or removed, so switching it on or adding it again starts none. A view thimble
installed from a viewer it no longer ships, unchanged since, gives way to an active extension's view of its slug, and
goes when none gives one.

Two active extensions that give the same view or card type, or that both replace the orientation's instructions, lose
it both (the instructions stay thimble's), and Settings and `thimble doctor` name the conflict.

Extension code runs only in thimble's kernels: readers on the views kernel, card.py in a card's kernel. The server reads
only its JSON and markdown, from the folder in thimble's home rather than the copy a kernel can write, and its agents
run inside the orientation's session, under that session's sandbox and rules, with the settings thimble's config gives
them (agent_definitions)."""
from __future__ import annotations

import asyncio
import functools
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

from . import config, kernel_wrap, userconf
from .ledger import read_json, write_json

log = logging.getLogger("thimble.extensions")

MANIFEST = "extension.json"
ADDED = ".added.json"  # written by `thimble extension add`: {source, kind, commit?, ts}
NAME_RE = userconf.EXTENSION_NAME_RE
RESERVED = ("thimble",)
WS_DIR = "extensions"  # under the workspace: each active extension's copy
STATE_FILE = "extensions.json"  # in the workspace's registry folder (config.registry_dir)
CACHE_DIR = ".extensions"  # under the workspace's views folder: extension readers' indexes, by extension and view
CARD_JSON, CARD_HTML, GUIDE = "card.json", "card.html", "card.md"
TYPE_MD, EXPORT_PY = "type.md", "export.py"
ORIENT_FILES = ("agents/orient.md", "orient.md")  # the first found extends the orientation
REPORT_DIRS = ("reports", "report-types")  # the first found holds the report types
REPORT_RENDERERS = ("document", "page", "video")  # a report type's renderer; document when it names none of them
RECORD_GLOBS = ["*.jsonl", "*.csv"]  # what a card type with a reader of its own reads when its card.json claims nothing
SIZE_MAX = 50 * 1024 * 1024  # bytes of an extension's folder
SKIPPED = ("__pycache__", ".git", "cache", ADDED)
WEB_TOOLS = userconf.WEB_TOOLS
CONFIG_UNREAD = "thimble's config cannot be read"
CHECKING = "thimble is checking whether it fits here"
NO_FILES = "no file here matches its claims"
BOTH = "another active extension gives it too"
DECIDE_WAIT_S = 180  # what an orientation's start waits for a view's check still being made
RETRY_S = 300  # a failed check stands this long before a refresh asks again

_locks: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Lock]] = {}  # workspace -> (its loop, the lock)
_asking: dict[tuple[str, str], dict[str, Any]] = {}  # (workspace, "<extension>/<view>") -> {key, task}
_waiting: dict[str, int] = {}  # workspace -> refreshes waiting for its checks (refresh)


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


def _one(v: Any) -> str:
    return " ".join(str(v or "").split())


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


def _front(p: Path) -> tuple[dict[str, Any], str]:
    try:
        return frontmatter(p.read_text("utf-8"))
    except OSError:
        return {}, ""


# --------------------------------------------------------------------------- thimble's version and config


@functools.lru_cache(maxsize=1)
def thimble_version() -> str:
    """This thimble's version, plugin.json's (the one source a release takes it from); '' when it cannot be read."""
    return str(_json(config.REPO_ROOT / "plugin" / ".claude-plugin" / "plugin.json").get("version") or "")


_PART = re.compile(r"^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z.+-]*)?$")
_COMPARATOR = re.compile(r"^(<=|>=|<|>|=|\^|~>?)?\s*(.+)$")


def _parts(text: str) -> tuple[int, ...] | None:
    """The numbers of a version as written, up to the first wildcard or missing part; None when it is no version."""
    m = _PART.match(text.strip())
    if not m:
        return None
    out: list[int] = []
    for g in m.groups():
        if g is None or not g.isdigit():
            break
        out.append(int(g))
    return tuple(out)


def _bump(parts: tuple[int, ...]) -> tuple[int, int, int]:
    """The first version past every version that starts with `parts`."""
    if not parts:
        return (1 << 30, 0, 0)
    head = list(parts[:-1]) + [parts[-1] + 1]
    return tuple((head + [0, 0, 0])[:3])  # type: ignore[return-value]


def _full(parts: tuple[int, ...]) -> tuple[int, int, int]:
    return tuple((list(parts) + [0, 0, 0])[:3])  # type: ignore[return-value]


def _interval(comp: str) -> list[tuple[str, tuple[int, int, int]]] | None:
    """One comparator of a range ("<=1.2", "^0.4", "~1.2.3", "0.4.x", "0.4") as [(op, version)] bounds; None when it
    is not one."""
    m = _COMPARATOR.match(comp)
    if not m:
        return None
    op, parts = m.group(1) or "", _parts(m.group(2))
    if parts is None:
        return None
    lo = _full(parts)
    if op in ("", "="):
        return [(">=", lo), ("<", _bump(parts))] if len(parts) < 3 else [("=", lo)]
    if op == "^":
        nonzero = next((i for i, x in enumerate(parts) if x), len(parts) - 1)
        return [(">=", lo), ("<", _bump(parts[: max(nonzero, 0) + 1]))]
    if op in ("~", "~>"):
        return [(">=", lo), ("<", _bump(parts[:2] if len(parts) > 1 else parts))]
    if op == ">" and len(parts) < 3:
        return [(">=", _bump(parts))]
    if op == "<=" and len(parts) < 3:
        return [("<", _bump(parts))]
    return [(op, lo)]


def in_range(version: str, rng: str) -> bool | None:
    """Whether `version` is in the range `rng`, as package.json's engines reads one: comparators joined by spaces, sets
    of them joined by `||`, `a - b`, `^`, `~` and x-ranges; None when `rng` or `version` is not one it reads."""
    have = _parts(version)
    if have is None or len(have) < 1:
        return None
    v = _full(have)
    ok = False
    for alt in rng.split("||"):
        alt = re.sub(r"(<=|>=|<|>|=|\^|~>?)\s+", r"\1", alt.strip())
        hyphen = re.fullmatch(r"(\S+)\s+-\s+(\S+)", alt)
        comps = [f">={hyphen.group(1)}", f"<={hyphen.group(2)}"] if hyphen else alt.split()
        bounds: list[tuple[str, tuple[int, int, int]]] = []
        for comp in comps or ["*"]:
            got = _interval(comp)
            if got is None:
                return None
            bounds += got
        ops = {"=": v.__eq__, ">=": v.__ge__, ">": v.__gt__, "<=": v.__le__, "<": v.__lt__}
        ok = ok or all(ops[op](b) for op, b in bounds)
    return ok


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


def _own_file(root: Path, rel: Any) -> bool:
    return (isinstance(rel, str) and bool(rel) and not Path(rel).is_absolute() and ".." not in Path(rel).parts
            and (root / rel).is_file())


def _several(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def read_extension(root: Path, expect: str | None = None, have: set[str] | None = None) -> dict[str, Any]:
    """What the extension in folder `root` is and gives, with `problems`, the reasons it cannot load, of which `waits`
    are those an added extension waits out (a thimble outside its range, a Python package or an extension it needs);
    `expect` is the name its folder gives it, `have` the extensions added (added())."""
    from . import views  # noqa: PLC0415

    raw = _json(root / MANIFEST)
    name = str(raw.get("name") or "")
    problems: list[str] = []
    waits: list[str] = []
    if not (root / MANIFEST).is_file():
        problems.append(f"it has no {MANIFEST}")
    elif not raw:
        problems.append(f"its {MANIFEST} is not a JSON object")
    if raw and (not NAME_RE.match(name) or name in RESERVED):
        problems.append(f"its name {name!r} is not one thimble can use (lower-case letters, digits and hyphens)")
    elif expect and raw and name != expect:
        problems.append(f"its folder is {expect!r} and its {MANIFEST} names it {name!r}")
    rng = _one(raw.get("thimble"))
    if rng and (mine := thimble_version()):
        fits = in_range(mine, rng)
        if fits is None:
            problems.append(f"its thimble range {rng!r} is not one thimble reads")
        elif not fits:
            waits.append(f"it works with thimble {rng}, and this is thimble {mine}")
    deps = raw.get("dependencies") if isinstance(raw.get("dependencies"), dict) else {}
    python = _words(deps.get("python")) if "python" in deps else _words(raw.get("requires"))
    js = _words(deps.get("js"))
    needs = [n for n in _words(deps.get("extensions")) if n != name]
    unknown = [x for x in js if x not in views.LIBS]
    if unknown:
        problems.append(f"its dependencies.js names {', '.join(unknown)}; thimble inlines only {', '.join(views.LIBS)}")
    if bad := [n for n in needs if not NAME_RE.match(n)]:
        problems.append(f"its dependencies.extensions names {', '.join(map(repr, bad))}, which is no extension's name")
    if missing := [x for x in python if not _importable(x)]:
        waits.append(f"it needs the Python {_several(len(missing), 'package', 'packages')} {', '.join(missing)}, "
                     f"which thimble does not install")
    have = set(added()) if have is None else have
    if absent := [n for n in needs if NAME_RE.match(n) and n not in have]:
        waits.append(f"it needs the {_several(len(absent), 'extension', 'extensions')} {', '.join(absent)}, which "
                     f"{_several(len(absent), 'is', 'are')} not added")
    vs = []
    for d in _subdirs(root / "views"):
        v = _json(d / views.VIEW_JSON)
        if not v or not (d / views.READER_PY).is_file() or not (d / views.VIEW_HTML).is_file():
            problems.append(f"its view {d.name!r} lacks {views.VIEW_JSON}, {views.READER_PY} or {views.VIEW_HTML}")
            continue
        card = v.get("card") if isinstance(v.get("card"), dict) and (d / "card.py").is_file() else None
        vs.append({"slug": d.name, "name": _one(v.get("name") or d.name),
                   "description": _one(v.get("description") or v.get("why")), "claims": _words(v.get("claims")),
                   "card": card is not None, "use": _one((card or {}).get("use"))})
    slugs = {v["slug"]: v for v in vs}
    cards = []
    for d in _subdirs(root / "cards"):
        c = _json(d / CARD_JSON)
        own = (d / views.READER_PY).is_file()
        reader = None if own else str(c.get("reader") or "")
        if not all((d / f).is_file() for f in (CARD_JSON, "card.py", CARD_HTML)):
            problems.append(f"its card type {d.name!r} lacks {CARD_JSON}, card.py or {CARD_HTML}")
        elif not own and reader not in slugs:
            problems.append(f"its card type {d.name!r} has no {views.READER_PY} and reads with the view {reader!r}, "
                            f"which it does not have")
        elif (slugs.get(d.name) or {}).get("card"):
            problems.append(f"its card type {d.name!r} has the slug of one of its views that is a card type")
        else:
            claims = (_words(c.get("claims")) or list(RECORD_GLOBS)) if own else slugs[str(reader)]["claims"]
            cards.append({"slug": d.name, "reader": reader, "claims": claims, "use": _one(c.get("use"))})
    agents = sorted(p.stem for p in (root / "agents").glob("*.md")
                    if NAME_RE.match(p.stem) and p.name != "orient.md") if (root / "agents").is_dir() else []
    orient = next((f for f in ORIENT_FILES if (root / f).is_file()), "")
    replaces = orient if orient and _front(root / orient)[0].get("replace") is True else ""
    orient = "" if replaces else orient
    old = raw.get("replaces") if isinstance(raw.get("replaces"), dict) else {}
    if not replaces and _own_file(root, old.get("instructions")):
        replaces = str(old["instructions"])
    folder = next((f for f in REPORT_DIRS if (root / f).is_dir()), REPORT_DIRS[0])
    reports = []
    for d in _subdirs(root / folder):
        if (d / TYPE_MD).is_file():
            front, _ = _front(d / TYPE_MD)
            reports.append({"slug": d.name, "name": _one(front.get("name") or d.name),
                            "description": _one(front.get("description")), "export": (d / EXPORT_PY).is_file()})
    return {"name": name or expect or root.name, "version": _one(raw.get("version")), "thimble": rng,
            "python": python, "js": js, "needs": needs, "root": str(root), "problems": problems + waits,
            "waits": waits, "views": vs, "cards": cards, "agents": agents, "orient": orient, "replaces": replaces,
            "reports": reports, "reports_dir": folder, "source": str(_json(root / ADDED).get("source") or "")}


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
    return config.registry_dir(c) / STATE_FILE


def _view_key(name: str, slug: str) -> str:
    return f"{name}/{slug}"


def read_state(c: str | None) -> dict[str, Any]:
    """{off, shown, oriented, extensions} as refresh() last wrote them: the extensions switched off here, the views
    switched on or off here whatever their check says ({"<extension>/<view>": bool}), the extensions whose orientation
    instructions the orientation had or started with, whether or not they run here now, and each extension found,
    active or not."""
    got: Any = {}
    if c:
        try:
            got = read_json(_state_path(c), {})
        except (OSError, ValueError, HTTPException):
            got = {}
    got = got if isinstance(got, dict) else {}
    exts = got.get("extensions") if isinstance(got.get("extensions"), dict) else {}
    names = {k: [n for n in _words(got.get(k)) if NAME_RE.match(n)] for k in ("off", "oriented")}
    shown = got.get("shown") if isinstance(got.get("shown"), dict) else {}
    shown = {k: v for k, v in shown.items() if isinstance(v, bool) and all(NAME_RE.match(x) for x in k.split("/", 1))
             and k.count("/") == 1}
    return {**names, "shown": shown,
            "extensions": {n: e for n, e in exts.items() if NAME_RE.match(n) and isinstance(e, dict)}}


def active(c: str | None) -> list[dict[str, Any]]:
    """The workspace's active extensions, each with `dir`, its copy in the workspace, and `src`, its folder."""
    if not c:
        return []
    return [{**e, "name": n, "dir": str(workspace_path(c, n)), "src": str(source_path(n))}
            for n, e in sorted(read_state(c)["extensions"].items()) if e.get("active")]


def _list(e: dict[str, Any], key: str) -> list[dict[str, Any]]:
    return [x for x in e.get(key) or [] if isinstance(x, dict) and x.get("slug")]


def conflicts(exts: dict[str, dict[str, Any]]) -> dict[str, dict[str, list[str]]]:
    """{kind: {slug: [extension, ...]}} of what two or more of the active extensions `exts` give: `view` and `card`
    slugs, and the orientation's `instructions` they replace (block)."""
    seen: dict[str, dict[str, list[str]]] = {"view": {}, "card": {}, "block": {}}
    for n, e in sorted(exts.items()):
        if not e.get("active"):
            continue
        for v in _list(e, "views"):
            seen["view"].setdefault(v["slug"], []).append(n)
            if v.get("card"):
                seen["card"].setdefault(v["slug"], []).append(n)
        for t in _list(e, "cards"):
            seen["card"].setdefault(t["slug"], []).append(n)
        if isinstance(e.get("replaces"), str) and e["replaces"]:
            seen["block"].setdefault("instructions", []).append(n)
    return {k: {s: ns for s, ns in m.items() if len(ns) > 1} for k, m in seen.items()}


def conflict_lines(clash: dict[str, dict[str, list[str]]]) -> list[str]:
    """Each conflict (conflicts) in words."""
    out = []
    for kind, m in clash.items():
        for slug, names in m.items():
            both = ", ".join(names[:-1]) + f" and {names[-1]}"
            if kind == "block":
                out.append(f"{both} both replace the orientation's instructions, so thimble's own are used")
            else:
                out.append(f"{both} both give the {'view' if kind == 'view' else 'card type'} {slug!r}, so neither "
                           f"is used")
    return out


def views_of(c: str) -> list[dict[str, Any]]:
    """The views the active extensions show here ({extension, slug, name, description, claims, dir, note})."""
    return [{**v, "extension": e["name"], "dir": str(Path(e["dir"]) / "views" / v["slug"])}
            for e in active(c) for v in _list(e, "views") if v.get("shown")]


def _lock(c: str) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    got = _locks.get(c)
    if got is None or got[0] is not loop:
        got = _locks[c] = (loop, asyncio.Lock())
    return got[1]


def _checks(c: str) -> dict[str, dict[str, Any]]:
    """The checks asked for workspace `c` on this event loop, by "<extension>/<view>"; one of another loop, which can
    never answer here, is forgotten."""
    loop = asyncio.get_running_loop()
    out = {}
    for (w, k), e in list(_asking.items()):
        if w != c:
            continue
        if e["task"].get_loop() is loop:
            out[k] = e
        else:
            _asking.pop((w, k), None)
    return out


def _stale(decision: dict[str, Any]) -> bool:
    """Whether a failed check has stood RETRY_S, so a refresh asks again."""
    from datetime import datetime, timezone  # noqa: PLC0415

    try:
        at = datetime.fromisoformat(str(decision.get("ts") or ""))
    except ValueError:
        return True
    return (datetime.now(timezone.utc) - at).total_seconds() >= RETRY_S


def _answered(c: str, entry: dict[str, Any]) -> None:
    """A check came back while no refresh waited for it: the workspace finds its extensions again (connected)."""
    if _waiting.get(c) or entry["task"].cancelled():
        return
    asyncio.get_running_loop().create_task(connected(c), name=f"extensions-{c}")


def _start(c: str, key: str, at: str, v: dict[str, Any], files: list[tuple[Any, ...]]) -> None:
    from . import view_fit  # noqa: PLC0415

    entry: dict[str, Any] = {"key": at}
    entry["task"] = asyncio.get_running_loop().create_task(
        view_fit.decide(c, v["name"], v["description"], files, at), name=f"view-fit-{c}-{key}")
    entry["task"].add_done_callback(lambda _t: _answered(c, entry))
    _asking[(c, key)] = entry


async def _fit(c: str, name: str, v: dict[str, Any], files: list[tuple[Any, ...]], kept: dict[str, Any]) -> dict[str, Any]:
    """Whether extension `name`'s view `v` fits workspace `c`: {fits, reason, by} with `key` for a model's decision,
    {key, error, ts} when its call failed, or {key, pending} while it runs (_start), with the answer before it while
    the files changed since. `files` are the files it claims here; `kept` the decision STATE_FILE holds, which stands
    while its key does (view_fit.key)."""
    from . import view_fit  # noqa: PLC0415

    if not files:
        return {"fits": False, "reason": NO_FILES, "by": "claims"}
    key = _view_key(name, v["slug"])
    at = view_fit.key(v["description"], files)
    got = _checks(c).get(key)
    if got is not None and got["key"] == at and got["task"].done():
        _asking.pop((c, key), None)
        try:
            return got["task"].result()
        except Exception as e:  # noqa: BLE001 — a check that failed decides nothing
            log.exception("%s: whether the view %s fits is not known", c, key)
            return {"key": at, "error": f"{type(e).__name__}: {e}", "ts": _now()}
    if kept.get("key") == at and not kept.get("pending") and ("fits" in kept or (kept.get("error") and not _stale(kept))):
        return kept
    if got is None or got["key"] != at:
        _start(c, key, at, v, files)
    return {"key": at, "pending": True, **({"fits": kept["fits"], "reason": kept.get("reason")} if "fits" in kept else {})}


def _note(fit: dict[str, Any]) -> str:
    """What Settings says beside a view: its check's reason, or that it is being made or failed."""
    if fit.get("pending"):
        return CHECKING
    if fit.get("error"):
        return f"thimble could not tell whether it fits here: {fit['error']}"
    return _one(fit.get("reason"))


def _settle_views(name: str, e: dict[str, Any], shown: dict[str, bool], clash: dict[str, dict[str, list[str]]]) -> None:
    """Each view of extension `name` marked `shown` (active, its files here, no other extension giving it, and fitting
    or switched on here) with the `note` Settings shows; then `files`, the claims of the views it shows and of its card
    types whose claims match files here, which `{{files}}` in its orientation instructions stands for."""
    files: list[str] = []
    for v in _list(e, "views"):
        fit = v.get("fit") or {}
        on = shown.get(_view_key(name, v["slug"]), bool(fit.get("fits")))
        v["shown"] = bool(e.get("active") and v.get("here") and on and v["slug"] not in clash["view"])
        v["note"] = BOTH if e.get("active") and v["slug"] in clash["view"] else _note(fit)
        card = bool(e.get("active") and v.get("card") and v.get("here") and v["slug"] not in clash["card"])
        if v["shown"] or card:
            files += v["claims"]
    for t in _list(e, "cards"):
        if e.get("active") and t.get("here") and t["slug"] not in clash["card"]:
            files += t.get("claims") or []
    e["files"] = list(dict.fromkeys(files))


def _needs_running(exts: dict[str, dict[str, Any]], here: str = " here") -> None:
    """Each active extension that needs one that does not run stops running too, with why."""
    changed = True
    while changed:
        changed = False
        for e in exts.values():
            if not e.get("active"):
                continue
            off = [n for n in _words(e.get("needs")) if not (exts.get(n) or {}).get("active")]
            if off:
                e.update(active=False, why=f"it needs the {_several(len(off), 'extension', 'extensions')} "
                                           f"{', '.join(off)}, which {_several(len(off), 'does', 'do')} not run{here}")
                changed = True


def _needed_files(exts: dict[str, dict[str, Any]]) -> None:
    """`files` of each active extension followed by those of the extensions it needs, however deep."""
    def of(name: str, seen: set[str]) -> list[str]:
        e = exts.get(name) or {}
        out = list(_words(e.get("files")))
        for n in _words(e.get("needs")):
            if n not in seen and (exts.get(n) or {}).get("active"):
                out += of(n, seen | {n})
        return out

    got = {n: list(dict.fromkeys(of(n, {n}))) for n, e in exts.items() if e.get("active")}
    for n, files in got.items():
        exts[n]["files"] = files


async def refresh(c: str, wait: float = 0.0) -> dict[str, Any]:
    """The workspace's extensions found again (_refresh). A view's check still being made (_fit) is waited for up to
    `wait` seconds, and then the extensions are found again; one that answers while no refresh waits has the workspace
    find them again itself (_answered). Returns the state."""
    if wait <= 0:
        return await _refresh(c)
    _waiting[c] = _waiting.get(c, 0) + 1
    try:
        state = await _refresh(c)
        running = [e["task"] for e in _checks(c).values() if not e["task"].done()]
        if running:
            await asyncio.wait(running, timeout=wait)
        if any(e["task"].done() for e in _checks(c).values()):
            state = await _refresh(c)
        return state
    finally:
        _waiting[c] -= 1


async def settle(c: str) -> None:
    """Before an orientation starts: a view's check still being made is waited for, so the orientation's instructions
    name the files of the views shown, and main hears of the card types."""
    from . import cardtypes  # noqa: PLC0415

    if any(not e["task"].done() for e in _checks(c).values()):
        await refresh_quietly(c, wait=DECIDE_WAIT_S)
        await cardtypes.announce(c)


async def _refresh(c: str) -> dict[str, Any]:
    """The workspace's extensions found again in extensions_dir(), each active one copied in, whether each of its views
    fits checked (_fit) and which of its card types read files here found, written to STATE_FILE; then the views no
    active extension shows any more withdrawn, the shown ones installed, and the orientation told of the newly active
    extensions. Returns the state."""
    from . import views  # noqa: PLC0415

    async with _lock(c):
        state = read_state(c)
        off = await asyncio.to_thread(userconf.extensions_off)
        found = await asyncio.to_thread(added)
        exts: dict[str, Any] = {}
        checked: set[str] = set()
        for name, root in found.items():
            info = await asyncio.to_thread(read_extension, root, name, set(found))
            kept = state["extensions"].get(name) or {}
            why = info["problems"][0] if info["problems"] else ""
            why = why or config_off(name, off)
            why = why or ("off in this workspace" if name in state["off"] else "")
            if not why:
                dig, size = await asyncio.to_thread(digest, root)
                if size > SIZE_MAX:
                    why = f"its folder holds {size:,} bytes, and thimble copies {SIZE_MAX:,} at most"
                else:
                    here = workspace_path(c, name)
                    if dig != kept.get("digest") or not here.is_dir() or (await asyncio.to_thread(digest, here))[0] != dig:
                        await asyncio.to_thread(copy_tree, root, here)
                    info["digest"] = dig
                    before = {v["slug"]: v for v in _list(kept, "views")}
                    for v in info["views"]:
                        files = await asyncio.to_thread(views.claimed_files, c, {"claims": v["claims"]}) if v["claims"] else []
                        v["here"] = bool(files)
                        v["fit"] = await _fit(c, name, v, files, (before.get(v["slug"]) or {}).get("fit") or {})
                        checked.add(_view_key(name, v["slug"]))
                    for t in info["cards"]:
                        t["here"] = bool(t["claims"]) and bool(
                            await asyncio.to_thread(views.claimed_files, c, {"claims": t["claims"]}))
            exts[name] = {**{k: v for k, v in info.items() if k != "name"}, "active": not why, "why": why}
        _needs_running(exts)
        clash = conflicts(exts)
        for name, e in exts.items():
            _settle_views(name, e, state["shown"], clash)
        _needed_files(exts)
        for k, entry in _checks(c).items():
            if k not in checked and entry["task"].done():
                _asking.pop((c, k))  # an answer for a view removed or switched off meanwhile
        now = {n for n, e in exts.items() if e.get("active")}
        fresh = sorted(now - set(state["oriented"]))
        new_state = {"off": state["off"], "shown": state["shown"], "oriented": sorted({*state["oriented"], *fresh}),
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
    """Take out each view an extension installed here, unchanged since, that the extension no longer shows here."""
    from . import views  # noqa: PLC0415

    for p in views.list_proposals(c):
        name, slug = p.get("extension"), str(p.get("slug") or "")
        if not name:
            continue
        e = exts.get(name) or {}
        if not (e.get("active") and any(v["slug"] == slug and v.get("shown") for v in _list(e, "views"))):
            views.withdraw(c, slug, name)


def install_views(c: str) -> list[str]:
    """Install each view the active extensions show here, unless the workspace has a view or proposal of that slug or
    the analyst deleted it; a view installed from an older version of the extension, or thimble's install of a viewer
    it no longer ships (views.orphaned), that nobody changed is replaced. An extension's view takes its libraries from
    the extension's dependencies.js. Returns the slugs installed."""
    from . import views  # noqa: PLC0415

    made = []
    gone = {str(d.get("slug")) for d in views.deleted_proposals(c)}
    orphans = set(views.orphaned(c))
    libs = {e["name"]: e.get("js") or [] for e in active(c)}
    for v in views_of(c):
        slug, d = v["slug"], Path(v["dir"])
        if slug in gone:
            continue
        prop = views.read_proposal(c, slug)
        if (prop is not None or slug in views._view_dirs(c)) and slug not in orphans:
            if not (prop and prop.get("extension") == v["extension"] and views.stale_install(c, slug, d)):
                continue
        try:
            views.install_viewer(c, slug, d, v["claims"], why=v["note"] or v["description"], proposed_by="extension",
                                 orientation=False, extension=v["extension"], libs=libs.get(v["extension"]) or None)
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
        e = exts.get(name) or {}
        text = _orient_text(e, source_path(name), e.get("orient") or e.get("replaces"))
        if not text:
            continue
        try:
            await orient_session.message(c, text, orient_session.EXTENSION, extension=name)
        except orient_session.NoOrientation:
            pass
        except (orient_session.Gone, RuntimeError, ValueError) as e:
            log.warning("%s: the orientation was not given the extension %s: %s", c, name, e)


def set_enabled(c: str, name: str, on: bool) -> None:
    """Settings' switch of extension `name` for workspace `c`."""
    state = read_state(c)
    off = [n for n in state["off"] if n != name] + ([] if on else [name])
    write_json(_state_path(c), {**state, "off": sorted(off)})


def set_view(c: str, name: str, slug: str, on: bool) -> None:
    """Settings' switch of extension `name`'s view `slug` for workspace `c`, which overrides its check either way."""
    state = read_state(c)
    write_json(_state_path(c), {**state, "shown": {**state["shown"], _view_key(name, slug): on}})


# --------------------------------------------------------------------------- contributions


def _orient_text(e: dict[str, Any], src: Path, rel: Any) -> str:
    """The body of the extension's orientation file `rel`, `{{files}}` in it filled with the files it claims here."""
    if not _own_file(src, rel):
        return ""
    _, body = _front(src / str(rel))
    return body.replace("{{files}}", ", ".join(f"`{x}`" for x in _words(e.get("files"))) or "(none)")


def orient_blocks(c: str | None) -> dict[str, Any]:
    """What the active extensions give the orientation's prompt: `added`, [(name, text)] of each one's added
    instructions; `replaced`, {"instructions": text} when one extension replaces thimble's; and `conflicts`, the
    instructions two or more replace, which stay thimble's."""
    exts = read_state(c)["extensions"] if c else {}
    clash = conflicts(exts)["block"]
    added_: list[tuple[str, str]] = []
    replaced: dict[str, str] = {}
    for e in active(c):
        src = Path(e["src"])
        if text := _orient_text(e, src, e.get("orient")):
            added_.append((e["name"], text))
        if not clash and (text := _orient_text(e, src, e.get("replaces"))):
            replaced["instructions"] = text
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
        for name in _words(e.get("agents")):
            if not NAME_RE.match(name) or name == "orient":
                continue
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
            agent: dict[str, Any] = {"description": _one(front.get("description")), "prompt": body}
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
        for name in _words(e.get("agents")):
            if not NAME_RE.match(name) or name == "orient":
                continue
            try:
                front, _ = frontmatter((Path(e["src"]) / "agents" / f"{name}.md").read_text("utf-8"))
            except OSError:
                continue
            key = f"{e['name']}:{name}"
            mine = userconf.extension_agent(conf, key)
            model = str(mine["model"] or front.get("model") or "")
            out[key] = {"model": config.exact_model(model) if model else subagents,
                        "effort": str(mine["effort"] or front.get("effort") or ""), "fast": False,
                        "extension": e["name"]}
    return out


def card_types(c: str | None) -> list[dict[str, Any]]:
    """The card types of the active extensions that no other active extension gives too and whose claims match files
    here, for cardtypes.refresh: {slug, extension, view (the view whose reader and index it uses, None for a type with a
    reader of its own), dir (its folder in the workspace's copy), reader, page (the file its frame draws, None for
    view.html), name, block (the `card` block's keys), libs (the extension's dependencies.js), guide (card.md), claims
    (its view's, or its card.json's for a reader of its own), cache (its index's folder)}."""
    from . import views  # noqa: PLC0415

    if not c:
        return []
    clash = conflicts(read_state(c)["extensions"])["card"]
    out = []
    for e in active(c):
        here, src = Path(e["dir"]), Path(e["src"])
        found = [(v["slug"], v["slug"], "views", views.VIEW_JSON, None, v) for v in _list(e, "views") if v.get("card")]
        found += [(t["slug"], t.get("reader"), "cards", CARD_JSON, CARD_HTML, t) for t in _list(e, "cards")]
        for slug, view, kind, manifest, page, entry in found:
            claims = _words(entry.get("claims"))
            if slug in clash or not entry.get("here") or not claims:
                continue
            raw = _json(src / kind / slug / manifest)
            block = raw.get("card") if kind == "views" else raw
            of_view = _json(src / "views" / view / views.VIEW_JSON) if view is not None else {}
            reader = here / "views" / view if view is not None else here / "cards" / slug
            out.append({"slug": slug, "extension": e["name"], "view": view, "dir": str(here / kind / slug),
                        "reader": str(reader / views.READER_PY), "page": page,
                        "name": _one(raw.get("name") or of_view.get("name") or slug),
                        "block": block if isinstance(block, dict) else {},
                        "libs": _words(e.get("js")) or raw.get("libs") or of_view.get("libs"),
                        "guide": _text(src / kind / slug / GUIDE), "claims": claims,
                        "cache": str(views.views_dir(c) / CACHE_DIR / e["name"] / (view or f"cards/{slug}"))})
    return out


def report_types(c: str | None) -> list[dict[str, Any]]:
    """The report types of the active extensions, in the preset form ({id, name, description, renderer, prompt}) plus
    {extension, dir, export}. `dir` is the type's folder in the workspace's copy, where an `exports` kernel reads
    export.py."""
    if not c:
        return []
    out = []
    for e in active(c):
        folder = e.get("reports_dir") if e.get("reports_dir") in REPORT_DIRS else REPORT_DIRS[0]
        for r in _list(e, "reports"):
            if not NAME_RE.match(r["slug"]):
                continue
            try:
                front, body = frontmatter((Path(e["src"]) / folder / r["slug"] / TYPE_MD).read_text("utf-8"))
            except OSError:
                continue
            d = Path(e["dir"]) / folder / r["slug"]
            renderer = str(front.get("renderer") or "").strip().lower()
            renderer = renderer if renderer in REPORT_RENDERERS else "document"
            out.append({"id": r["slug"], "name": _one(front.get("name") or r["slug"]),
                        "description": _one(front.get("description")), "renderer": renderer, "prompt": body,
                        "extension": e["name"], "dir": str(d),
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


def _row(kind: str, name: str, about: str) -> str:
    return f"  {kind.ljust(12)}" + (f"{name}: {about}" if name and about else name or about)


def summary(info: dict[str, Any], how: dict[str, Any]) -> list[str]:
    """What `thimble extension add` shows before it asks: each contribution with its own description, what it needs,
    and where its code runs."""
    v = f" {info['version']}" if info["version"] else ""
    at = f" at {how['commit']}" if how.get("commit") else ""
    out = [f"{info['name']}{v}, from {how['source']}{at}"]
    root = Path(info["root"])
    for x in info["views"]:
        out.append(_row("view", x["slug"], x["description"]) + (" Also a card type." if x["card"] else ""))
    for x in info["cards"]:
        out.append(_row("card type", x["slug"], x["use"]))
    for a in info["agents"]:
        out.append(_row("agent", a, _one(_front(root / "agents" / f"{a}.md")[0].get("description"))))
    if info["orient"]:
        out.append(_row("orientation", "", "adds its instructions to the orientation's"))
    if info["replaces"]:
        out.append(_row("orientation", "", "replaces thimble's instructions, unless your own setting or another "
                                           "extension does"))
    for r in info["reports"]:
        out.append(_row("report type", r["slug"], r["description"]) + (" With its own exports." if r["export"] else ""))
    if info["thimble"]:
        out.append(f"  It works with thimble {info['thimble']}.")
    if info["js"]:
        out.append(f"  Its pages use {', '.join(info['js'])}, which thimble inlines.")
    if info["python"]:
        out.append(f"  It needs the Python {_several(len(info['python']), 'package', 'packages')} "
                   f"{', '.join(info['python'])}, which thimble does not install.")
    if info["views"]:
        out.append("  Its views show where a quick model check finds they fit the corpus; the rest runs in every "
                   "workspace until it is switched off.")
    if info["agents"]:
        out.append("  Its agents run in the orientation's session and its sandbox, without the web unless thimble's "
                   f"config sets agents.\"{info['name']}:<agent>\".web.")
    out.append("  Its Python (readers, card code, export hooks) runs in thimble's kernels, with the same sandbox and "
               "network as cells.")
    return out


def _plan(root: Path, how: dict[str, Any], into: Path) -> list[tuple[Path, dict[str, Any], dict[str, Any]]]:
    """[(folder, how, info)] of the extension in `root` and of each extension it needs, however deep, that is not added
    and that thimble ships, which `add` adds with it."""
    have = set(added())
    found = [(root, how)]
    names: list[str] = []
    queue = [read_extension(root, None, have)]
    while queue:
        info = queue.pop(0)
        names.append(info["name"])
        for n in info["needs"]:
            if n in have or n in names or not NAME_RE.match(n) or not (builtin_dir() / n / MANIFEST).is_file():
                continue
            d, h = fetch(n, into)
            found.append((d, h))
            queue.append(read_extension(d, None, have))
            names.append(n)
    everyone = have | set(names)
    return [(d, h, read_extension(d, None, everyone)) for d, h in found]


def add(source: str, *, yes: bool = False, ask: Any = input, say: Any = print) -> str | None:
    """`thimble extension add`: fetch the extension and the extensions it needs that thimble ships and are not added,
    show what each gives (summary), and copy them into extensions_dir() once the analyst says yes (or `yes`). Returns
    its name, None when the analyst said no. AddError for an extension that cannot load for a reason of its own
    folder."""
    import tempfile  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="thimble-ext-") as tmp:
        root, how = fetch(source, Path(tmp))
        plan = _plan(root, how, Path(tmp))
        name = plan[0][2]["name"]
        digests = []
        for d, h, info in plan:
            fatal = [x for x in info["problems"] if x not in info["waits"]]
            if fatal:
                raise AddError(f"{h['source']} cannot be added: " + "; ".join(fatal))
            dig, size = digest(d)
            if size > SIZE_MAX:
                raise AddError(f"{h['source']} holds {size:,} bytes, and an extension may hold {SIZE_MAX:,}")
            digests.append(dig)
        for i, (d, h, info) in enumerate(plan):
            if i:
                say(f"It needs {info['name']}, which is added with it:")
            for line in summary(info, h):
                say(line)
            for x in info["waits"]:
                say(f"  It stays unloaded until then: {x}.")
            dest = source_path(info["name"])
            if dest.is_dir():
                old = read_extension(dest, info["name"])
                say(f"  It replaces the {info['name']} already added"
                    f"{' (' + old['version'] + ')' if old['version'] else ''}.")
        if not yes:
            try:
                answer = ask("Add it? [y/N] " if len(plan) == 1 else f"Add these {len(plan)}? [y/N] ")
            except EOFError:
                answer = ""
            if str(answer).strip().lower() not in ("y", "yes"):
                return None
        extensions_dir().mkdir(parents=True, exist_ok=True)
        for (d, h, info), dig in zip(plan, digests):
            dest = source_path(info["name"])
            copy_tree(d, dest)
            write_json(dest / ADDED, {**h, "digest": dig, "ts": _now()})
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
    per workspace, on or off there with why it is off or that no session connected there since it was added, and under
    it a line per view, shown or hidden there with its check's reason."""
    got = added()
    if not got:
        return ["no extensions added; `thimble extension add <git URL | folder | built-in name>` adds one"]
    off = userconf.extensions_off()
    try:
        folders = sorted(d for d in workspaces_dir.iterdir() if d.is_dir() and config._valid_name(d.name))
    except OSError:
        folders = []
    states = {d.name: _json(d / kernel_wrap.REGISTRY_DIR / STATE_FILE) for d in folders}
    width = max((len(d.name) for d in folders), default=0)
    out = []
    for name, root in got.items():
        info = read_extension(root, name, set(got))
        loads = "not loaded: " + info["problems"][0] if info["problems"] else config_off(name, off) or "loads"
        v = f" {info['version']}" if info["version"] else ""
        out.append(f"{name}{v}, from {info['source'] or root}: {loads}")
        for d in folders:
            state = states[d.name]
            e = (state.get("extensions") or {}).get(name) if isinstance(state.get("extensions"), dict) else None
            if not isinstance(e, dict):
                out.append(f"  {d.name.ljust(width)}  not checked yet: no session connected here since it was added")
                continue
            out.append(f"  {d.name.ljust(width)}  " + ("on" if e.get("active") else f"off  {e.get('why') or ''}".rstrip()))
            for x in _list(e, "views") if e.get("active") else []:
                note = _one(x.get("note"))
                out.append(f"  {''.ljust(width)}    view {x['slug']} {'shown' if x.get('shown') else 'hidden'}"
                           + (f": {note}" if note else ""))
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
        info = read_extension(root, name, set(got))
        v = f" {info['version']}" if info["version"] else ""
        if info["problems"]:
            parts.append(f"{name}{v} (not loaded: {info['problems'][0]})")
        elif why := config_off(name, off):
            parts.append(f"{name}{v} ({why})")
        else:
            parts.append(f"{name}{v}")
            loadable[name] = {**info, "active": True}
    _needs_running(loadable, "")
    parts = [p if (e := loadable.get(p.split(" ", 1)[0])) is None or e["active"] else f"{p} ({e['why']})" for p in parts]
    return "; ".join(parts + [f"conflict: {x}" for x in conflict_lines(conflicts(loadable))])


# --------------------------------------------------------------------------- routes

router = APIRouter()


def public(c: str) -> dict[str, Any]:
    """Settings' extensions: each one added, whether it runs here and why not, the line Settings shows beside it (why
    not, unless its switch here turned it off), where its switch stands, whether it cannot run here whatever the switch
    says (`locked`), and its views: each shown here or not, the line Settings shows
    beside it (`note`), where its switch stands (switched here, else as its check says) and whether that switch can
    change anything (`locked`: the extension does not run here or no file here matches the view's claims). Then the
    conflicts among those that run."""
    state = read_state(c)
    off = userconf.extensions_off()
    out = []
    for name, e in sorted(state["extensions"].items()):
        vs = [{"slug": v["slug"], "name": _one(v.get("name") or v["slug"]), "shown": bool(v.get("shown")),
               "note": _one(v.get("note")),
               "on": state["shown"].get(_view_key(name, v["slug"]), bool((v.get("fit") or {}).get("fits"))),
               "locked": not e.get("active") or not v.get("here")} for v in _list(e, "views")]
        why = _one(e.get("why"))
        out.append({"name": name, "version": _one(e.get("version")), "active": bool(e.get("active")), "why": why,
                    "note": "" if name in state["off"] else why, "on": name not in state["off"],
                    "locked": bool(config_off(name, off)) or bool(e.get("problems")), "views": vs})
    return {"extensions": out, "conflicts": conflict_lines(conflicts(state["extensions"]))}


@router.get("/ws/{c}/extensions")
async def list_route(c: str) -> dict[str, Any]:
    """The extensions added, found again for this workspace (refresh)."""
    config.workspace_dir(c)
    await refresh_quietly(c)
    return await asyncio.to_thread(public, c)


class SwitchBody(BaseModel):
    on: bool


async def _switched(c: str, request: Request, name: str, turn: Any) -> dict[str, Any]:
    from . import cardtypes, hook_auth  # noqa: PLC0415

    config.workspace_dir(c)
    if not hook_auth.analyst(request):
        raise HTTPException(403, hook_auth.ANALYST_ONLY)
    if name not in read_state(c)["extensions"]:
        raise HTTPException(404, f"no extension {name!r} in this workspace")
    await asyncio.to_thread(turn)
    await refresh_quietly(c)
    await cardtypes.announce(c)
    return await asyncio.to_thread(public, c)


@router.put("/ws/{c}/extensions/{name}")
async def switch_route(c: str, name: str, body: SwitchBody, request: Request) -> dict[str, Any]:
    """Settings' switch of one extension for this workspace, which only the analyst's browser may turn."""
    return await _switched(c, request, name, lambda: set_enabled(c, name, body.on))


@router.put("/ws/{c}/extensions/{name}/views/{slug}")
async def view_switch_route(c: str, name: str, slug: str, body: SwitchBody, request: Request) -> dict[str, Any]:
    """Settings' switch of one extension's view for this workspace, which overrides its check; the analyst's browser
    alone may turn it."""
    config.workspace_dir(c)
    e = read_state(c)["extensions"].get(name) or {}
    if name in read_state(c)["extensions"] and not any(v["slug"] == slug for v in _list(e, "views")):
        raise HTTPException(404, f"the extension {name!r} has no view {slug!r}")
    return await _switched(c, request, name, lambda: set_view(c, name, slug, body.on))


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
