"""Extensions: folders that add views, card types and report types to thimble, and change its agents.
`thimble extension add <folder>` checks one and, once the analyst says yes, links it from
$THIMBLE_HOME/extensions/<name> and uses it in place; one from a git URL or that thimble ships is copied there (cli.py).
Adding it switches it on.
extension.json and each part's JSON file follow extension.schema.json, and extension_manifest.check names each problem
with its file and line. The folder:

  extension.json      {"name", "version", "description", "scope", "thimble", "python", "needs"}: `scope` is the files
                      it is about, which its views and card types without a scope of their own use; `thimble` the
                      versions it works with, as package.json's engines writes them; `python` the packages its code
                      needs; `needs` the extensions it needs. `dependencies` ({python, js, extensions}) and `requires`
                      are read too
  views/<slug>/       a view (views.py), view.json with `scope` (or `claims`); a `card` block and card.py make it a card
                      type too (cardtypes.py), and card.md is the type's guide
  cards/<slug>/       a card type of its own: card.json (`description` or `use`, `example`, `args`, and `reader`, the
                      extension's view whose reader and index it uses, or `claims`, the files its own reader.py reads),
                      card.py, card.html, card.md
  agents/<role>/      agent.json for one of the five roles (extension_manifest.ROLES), by a prompt, an Agent SDK program
                      or a command (_roles). The orientation's prompt adds to its instructions, or takes their place
                      with `replace`, and its `subagents` join the orientation's session with --agents (agent_definitions).
                      `{{files}}` in it stands for the files its scope, views and card types, and those of the
                      extensions it needs, claim here, and `{{dir}}` for its copy in the workspace. agents/<name>.md is read as a
                      subagent of the orientation, and agents/orient.md, or orient.md beside extension.json, as an
                      addition to its instructions, or in their place with `replace: true` in its frontmatter
  tasks/<task>/       task.json for one of the seven tasks (extension_manifest.TASKS), defined the same three ways
                      (_tasks)
  reports/<slug>/     a report type: report.json, report.md (the form) and writer.md (added to the writer's prompt), or
                      type.md in the preset format; export.py for its own exports. report-types/ is read too
  checks/<slug>/      a report check: check.json and check.md

An extension loads when read_extension finds no problem: its files check, this thimble is in its range, its Python
packages import, its js names thimble's own libraries or npm packages its views hold in their lib folders (view_libs),
and the extensions it needs are added. It is active in a
workspace when it loads, neither thimble's config (`extensions.<name>.enabled: false`, which `thimble extension off`
writes) nor the workspace's switch in Settings turns it off, and the extensions it needs are active there. An active
extension's agents and orientation instructions join the orientation, its card types join main's prompt where their
claims match files, and its report types are offered in + New. Its roles (roles.py, harness.py), its tasks (tasks.py,
harness.py) and its report checks (checks.py) are read here (`roles`, `tasks`, `checks`) for the code that uses them.

Only its views check whether they fit (_fit): one quick model call per view and workspace, from the view's description
and a few records of the files it claims (view_fit.py), kept until those files change. Until it answers, and when it
says no or fails, the view is hidden here and Settings says why; the view's switch in Settings overrides the answer.
Once installed, a view runs the checks a built view passes (views.check) on the workspace's files, once per version of
the extension (_gate); one that fails them is hidden here, and Settings names the first failure, which the view's
switch overrides too.

refresh() copies an active extension into workspaces/<c>/extensions/<name>/, since a kernel sees only the workspace and
the corpus, and writes STATE_FILE in the workspace's registry folder, which a kernel cannot write
(kernel_wrap.READ_ONLY_DIRS). Its shown views are installed, outside the orientation's four, and one it installed that
nobody changed goes when it is no longer shown. An orientation that starts reads the active extensions' instructions in
its prompt. Where one already ran, an extension with orientation instructions that comes on is never sent to it on its
own: Settings offers to run them now (offered), and Run now sends them as one follow-up (run_orientation). An extension
whose program runs the orientation is offered the same way, and Run now runs its program again as a follow-up with the
earlier request and the cards as they stand. The offer returns each time the extension is switched on again. A view
thimble installed from a viewer it no longer ships, unchanged since, gives way to an active extension's view of its
slug, and goes when none gives one.

Two active extensions that give the same view or card type, or that both replace the orientation's instructions, one
role or one task, lose it both (the instructions, the role and the task stay thimble's), and `add`, Settings and
`thimble doctor` name the conflict. Settings also says when another extension's program runs a role, so an addition to
it is not used.

thimble ships some extensions (builtin_dir()); `add` adds one by name, and those of SHIPPED_ON are added on thimble's
first run (ship()). A built-in thimble added, or the analyst added by name, follows the version this thimble ships while
its copy is unchanged. One thimble renamed (RENAMED) is carried over to its new name, with its settings in thimble's
config and in each workspace (_rename_shipped, userconf.rename_extensions, _renamed_state).

Extension code runs in thimble's kernels (readers on the views kernel, card.py in a card's kernel) and, for a program
that runs one of the roles or tasks, in that role's or task's box (harness.py, roles.py, tasks.py). The server reads
only its JSON and markdown, from its folder rather than the copy a kernel can write, and its agents run inside the
orientation's session, under that session's sandbox and rules, with the settings thimble's config gives them
(agent_definitions)."""
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

from . import config, extension_manifest, kernel_wrap, userconf
from .ledger import read_json, unlinked, write_json

log = logging.getLogger("thimble.extensions")

MANIFEST = "extension.json"
ADDED = ".added.json"  # written by `thimble extension add`, or by ship(): {source, kind, commit?, digest, ts, shipped?}
SHIPPED = ".shipped.json"  # in extensions_dir(): {"added": [each built-in ship() added once]}
SHIPPED_ON = ("video",)  # the built-in extensions thimble ships added
RENAMED = userconf.RENAMED_EXTENSIONS  # {old name: new name} of the built-ins thimble renamed
NAME_RE = userconf.EXTENSION_NAME_RE
RESERVED = ("thimble",)
WS_DIR = "extensions"  # under the workspace: each active extension's copy
STATE_FILE = "extensions.json"  # in the workspace's registry folder (config.registry_dir)
# under the workspace's indexes folder (views.indexes_dir): extension readers' indexes, by extension and view
CACHE_DIR = ".extensions"
CARD_JSON, CARD_HTML, GUIDE = "card.json", "card.html", "card.md"
TYPE_MD, EXPORT_PY = "type.md", "export.py"
REPORT_JSON, REPORT_MD, WRITER_MD = "report.json", "report.md", "writer.md"
AGENT_JSON, TASK_JSON = "agent.json", "task.json"
ORIENT_FILES = ("agents/orient.md", "orient.md")  # the first found extends the orientation
REPORT_DIRS = ("reports", "report-types")  # the first found holds the report types
REPORT_RENDERERS = ("document", "page", "video")  # a report type's renderer; document when it names none of them
RECORD_GLOBS = ["*.jsonl", "*.csv"]  # what a card type with a reader of its own reads when its card.json claims nothing
SIZE_MAX = 50 * 1024 * 1024  # bytes of an extension's folder
SKIPPED = ("__pycache__", ".git", "cache", ADDED)
WEB_TOOLS = userconf.WEB_TOOLS
# the fields of a subagent in agent.json that go to Claude Code's --agents as they are
SUBAGENT_PASSED = ("mcpServers", "maxTurns", "skills", "color")
CONFIG_UNREAD = "thimble's config cannot be read"
NOT_ADDED = "not added"
CHECKING = "thimble is checking whether it fits here"
NO_FILES = "no file here is in its scope"
BOTH = "another active extension gives it too"
DECIDE_WAIT_S = 180  # what an orientation's start waits for a view's check still being made
CHECKS_FILE = "extension-checks.json"  # in the workspace's registry folder: the view checks of installed views (_gate)
CHECKS_FAILED = "its checks failed here: {why}"
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
    """Whether the Python package `name` names, a requirement as pip reads one ("pyyaml>=6") or a module's name
    ("yaml"), is installed where thimble's kernels run, at a version its specifier allows."""
    from importlib import metadata  # noqa: PLC0415

    from packaging.requirements import InvalidRequirement, Requirement  # noqa: PLC0415

    try:
        req = Requirement(name.strip())
    except InvalidRequirement:
        return False
    if req.marker is not None and not req.marker.evaluate():
        return True
    try:
        return req.specifier.contains(metadata.version(req.name), prereleases=True)
    except metadata.PackageNotFoundError:
        pass
    try:
        return importlib.util.find_spec(req.name.replace("-", "_").split(".")[0]) is not None
    except (ImportError, ValueError):
        return False


def _subdirs(d: Path) -> list[Path]:
    return sorted(x for x in d.iterdir() if x.is_dir() and NAME_RE.match(x.name)) if d.is_dir() else []


def _own_file(root: Path, rel: Any) -> bool:
    """Whether `rel` names a file inside the folder `root`, links included only while they stay inside it."""
    return (isinstance(rel, str) and bool(rel) and not Path(rel).is_absolute() and ".." not in Path(rel).parts
            and (root / rel).is_file() and (root / rel).resolve().is_relative_to(root.resolve()))


def _several(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def _agent_json(root: Path, role: str) -> dict[str, Any]:
    """agents/<role>/agent.json of the extension in `root`, {} when it has none."""
    return _json(root / "agents" / role / AGENT_JSON)


def _roles(root: Path) -> list[dict[str, Any]]:
    """Each role the extension changes (agents/<role>/agent.json): {role, kind, description, file, command, replace,
    subagents, model, effort, tools, disallowedTools}, `file` being the prompt or SDK program by its path in the
    extension, and `subagents` {name: its fields, `prompt` by its path in the extension}."""
    out = []
    for role in extension_manifest.ROLES:
        raw = _agent_json(root, role)
        way = extension_manifest.kind(raw)
        if not raw or not way:
            continue
        base = f"agents/{role}"
        subs = raw.get("subagents") if way == "prompt" and isinstance(raw.get("subagents"), dict) else {}
        out.append({"role": role, "kind": way, "description": _one(raw.get("description")),
                    "file": f"{base}/{raw[way]}" if way in ("prompt", "sdk") else "",
                    "command": [str(x) for x in raw["command"]] if way == "command" else [],
                    "replace": way == "prompt" and raw.get("replace") is True,
                    "subagents": {n: {**{k: v for k, v in a.items() if k != "prompt"}, "prompt": f"{base}/{a['prompt']}"}
                                  for n, a in subs.items() if NAME_RE.match(n) and isinstance(a, dict)
                                  and isinstance(a.get("prompt"), str)},
                    **{k: raw[k] for k in ("model", "effort", "tools", "disallowedTools") if k in raw}})
    return out


def _tasks(root: Path) -> list[dict[str, Any]]:
    """Each task the extension changes (tasks/<task>/task.json): {task, kind, description, file, command, replace}."""
    out = []
    for task in extension_manifest.TASKS:
        raw = _json(root / "tasks" / task / TASK_JSON)
        way = extension_manifest.kind(raw)
        if raw and way:
            out.append({"task": task, "kind": way, "description": _one(raw.get("description")),
                        "file": f"tasks/{task}/{raw[way]}" if way in ("prompt", "sdk") else "",
                        "command": [str(x) for x in raw["command"]] if way == "command" else [],
                        "replace": way == "prompt" and raw.get("replace") is True})
    return out


def read_extension(root: Path, expect: str | None = None, have: set[str] | None = None) -> dict[str, Any]:
    """What the extension in folder `root` is and gives, with `problems`, the reasons it cannot load, of which `waits`
    are those an added extension waits out (a thimble outside its range, a Python package or an extension it needs);
    `expect` is the name its folder gives it, `have` the extensions added (added()). The problems of its files come
    first, each with the file and line it is on (extension_manifest.check)."""
    from . import view_libs, views  # noqa: PLC0415

    raw = _json(root / MANIFEST)
    name = str(raw.get("name") or "")
    problems: list[str] = [str(p) for p in extension_manifest.check(root, expect)]
    waits: list[str] = []
    if name in RESERVED:
        problems.append(f"its name {name!r} is thimble's own")
    rng = _one(raw.get("thimble"))
    if rng and (mine := thimble_version()):
        fits = in_range(mine, rng)
        if fits is None:
            problems.append(f"its thimble range {rng!r} is not one thimble reads")
        elif not fits:
            waits.append(f"it works with thimble {rng}, and this is thimble {mine}")
    deps = raw.get("dependencies") if isinstance(raw.get("dependencies"), dict) else {}
    if "python" in raw:
        python = _words(raw.get("python"))
    else:
        python = _words(deps.get("python")) if "python" in deps else _words(raw.get("requires"))
    js = _words(deps.get("js"))
    needs = [n for n in _words(raw["needs"] if "needs" in raw else deps.get("extensions")) if n != name]
    scope = _words(raw.get("scope"))
    unknown = [x for x in js if x not in views.LIBS and view_libs.parse(x) is None]
    if unknown:
        problems.append(f"its dependencies.js names {', '.join(unknown)}, which is neither one of "
                        f"{', '.join(views.LIBS)} nor an npm package as name@version")
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
        if not v or not (d / views.VIEW_HTML).is_file():
            continue
        if not (d / views.READER_PY).is_file():
            problems.append(f"its view {d.name!r} has no {views.READER_PY}, which thimble needs to read its files")
            continue
        missing = [x for x in (*js, *view_libs.entries(v.get("libs")))
                   if view_libs.parse(x) is not None and view_libs.vendored(d, x) is None]
        if missing:
            problems.append(f"its view {d.name!r} loads {', '.join(dict.fromkeys(missing))}, which its "
                            f"{view_libs.LIB_DIR} folder does not hold. Build the view in a workspace, where thimble "
                            "installs packages once the analyst allows them, and copy its folder")
        card = v.get("card") if isinstance(v.get("card"), dict) and (d / "card.py").is_file() else None
        vs.append({"slug": d.name, "name": _one(v.get("name") or d.name),
                   "description": _one(v.get("description") or v.get("why")),
                   "claims": _words(v.get("scope") or v.get("claims")) or scope,
                   "card": card is not None, "use": _one((card or {}).get("use"))})
    slugs = {v["slug"]: v for v in vs}
    cards = []
    for d in _subdirs(root / "cards"):
        c = _json(d / CARD_JSON)
        own = (d / views.READER_PY).is_file()
        reader = None if own else str(c.get("reader") or "")
        if not c or not (d / CARD_HTML).is_file():
            continue
        missing = [x for x in (*js, *view_libs.entries(c.get("libs")))
                   if view_libs.parse(x) is not None and view_libs.vendored(d, x) is None]
        if missing:
            problems.append(f"its card type {d.name!r} loads {', '.join(dict.fromkeys(missing))}, which its "
                            f"{view_libs.LIB_DIR} folder does not hold. Build it in a workspace, where thimble "
                            "installs packages once the analyst allows them, and copy its folder")
        if not (d / "card.py").is_file():
            problems.append(f"its card type {d.name!r} has no card.py, which thimble needs to draw it")
        elif not own and not reader:
            problems.append(f"its card type {d.name!r} has no {views.READER_PY}, which thimble needs to read its files")
        elif not own and reader not in slugs:
            problems.append(f"its card type {d.name!r} has no {views.READER_PY} and reads with the view {reader!r}, "
                            f"which it does not have")
        elif (slugs.get(d.name) or {}).get("card"):
            problems.append(f"its card type {d.name!r} has the name of one of its views that is a card type")
        else:
            claims = (_words(c.get("claims")) or scope or list(RECORD_GLOBS)) if own else slugs[str(reader)]["claims"]
            cards.append({"slug": d.name, "name": _one(c.get("name") or d.name), "reader": reader, "claims": claims,
                          "use": _one(c.get("description") or c.get("use"))})
    roles = _roles(root)
    orientation = next((r for r in roles if r["role"] == "orientation"), None)
    subagents = (orientation or {}).get("subagents") or {}
    agents = sorted({*subagents, *(p.stem for p in (root / "agents").glob("*.md")
                                    if NAME_RE.match(p.stem) and p.name != "orient.md")}) if (root / "agents").is_dir() else []
    if orientation and orientation["kind"] == "prompt":
        orient, replaces = ("", orientation["file"]) if orientation["replace"] else (orientation["file"], "")
    else:
        orient = next((f for f in ORIENT_FILES if (root / f).is_file()), "")
        replaces = orient if orient and _front(root / orient)[0].get("replace") is True else ""
        orient = "" if replaces else orient
        old = raw.get("replaces") if isinstance(raw.get("replaces"), dict) else {}
        if not replaces and _own_file(root, old.get("instructions")):
            replaces = str(old["instructions"])
    folder = next((f for f in REPORT_DIRS if (root / f).is_dir()), REPORT_DIRS[0])
    reports = []
    for d in _subdirs(root / folder):
        if (d / REPORT_JSON).is_file() and (d / REPORT_MD).is_file():
            r = _json(d / REPORT_JSON)
            reports.append({"slug": d.name, "name": _one(r.get("name") or d.name), "description": _one(r.get("description")),
                            "viewer": _one(r.get("viewer")) or "document",
                            "export": (d / EXPORT_PY).is_file()})
        elif (d / TYPE_MD).is_file():
            front, _ = _front(d / TYPE_MD)
            reports.append({"slug": d.name, "name": _one(front.get("name") or d.name),
                            "description": _one(front.get("description")),
                            "viewer": _one(front.get("renderer")) or "document", "export": (d / EXPORT_PY).is_file()})
    checks = [{"slug": d.name, "name": _one(_json(d / "check.json").get("name") or d.name)}
              for d in _subdirs(root / "checks") if (d / "check.json").is_file()]
    return {"name": name or expect or root.name, "version": _one(raw.get("version")),
            "description": _one(raw.get("description")), "scope": scope, "thimble": rng,
            "python": python, "js": js, "needs": needs, "root": str(root), "problems": problems + waits,
            "waits": waits, "views": vs, "cards": cards, "agents": agents, "subagents": subagents,
            "orient": orient, "replaces": replaces, "roles": roles, "tasks": _tasks(root), "checks": checks,
            "reports": reports, "reports_dir": folder, "source": str(_added_record(root, name or expect).get("source") or ""),
            "builtin": _added_record(root, name or expect).get("kind") == "built-in"}


def added() -> dict[str, Path]:
    """{name: folder} of every extension in extensions_dir(): a folder thimble copied, or a link to a folder used in
    place, listed even when the folder it links to is gone."""
    base = extensions_dir()
    try:
        dirs = sorted(d for d in base.iterdir() if NAME_RE.match(d.name) and (d.is_dir() or d.is_symlink()))
    except OSError:
        return {}
    return {d.name: d for d in dirs if d.is_symlink() or (d / MANIFEST).is_file()}


def linked(name: str) -> bool:
    """Whether extension `name` is a folder used in place, which thimble links to rather than copies."""
    return source_path(name).is_symlink()


def _record_file(name: str) -> Path:
    """Where `thimble extension add` keeps how extension `name` was added (ADDED): in its copy, or beside the link to a
    folder used in place, which thimble never writes."""
    return extensions_dir() / f".{name}{ADDED}" if linked(name) else source_path(name) / ADDED


def _added_record(root: Path, name: str | None) -> dict[str, Any]:
    if name and NAME_RE.match(name) and Path(root) == source_path(name):
        return _json(_record_file(name))
    return _json(Path(root) / ADDED)


def _files(base: Path) -> list[Path]:
    """The regular files of an extension's folder, symlinks, caches and git's files left out."""
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(n for n in dirnames if n not in SKIPPED and not Path(dirpath, n).is_symlink())
        out += [Path(dirpath, n) for n in sorted(filenames) if n not in SKIPPED and not Path(dirpath, n).is_symlink()]
    return out


def digest(base: Path) -> tuple[str, int]:
    """(a hash of the files of `base`, how many bytes they hold); the hash is '' for a folder of more than SIZE_MAX
    bytes, whose files are not read."""
    files = _files(base)
    size = sum(f.stat().st_size for f in files)
    if size > SIZE_MAX:
        return "", size
    h = hashlib.sha1()
    for f in files:
        h.update(str(f.relative_to(base)).encode() + b"\0" + f.read_bytes() + b"\0")
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
    """{off, shown, oriented, declined, extensions} as refresh() last wrote them: the extensions switched off here, the
    views switched on or off here whatever their check says ({"<extension>/<view>": bool}), the active extensions whose
    orientation instructions the orientation started with or was sent since each was last switched on, those whose
    offer to run them the analyst answered with Not now, and each extension found, active or not."""
    got: Any = {}
    if c:
        try:
            got = read_json(_state_path(c), {})
        except (OSError, ValueError, HTTPException):
            got = {}
    got = _renamed_state(got) if isinstance(got, dict) else {}
    exts = got.get("extensions") if isinstance(got.get("extensions"), dict) else {}
    names = {k: [n for n in _words(got.get(k)) if NAME_RE.match(n)] for k in ("off", "oriented", "declined")}
    shown = got.get("shown") if isinstance(got.get("shown"), dict) else {}
    shown = {k: v for k, v in shown.items() if isinstance(v, bool) and all(NAME_RE.match(x) for x in k.split("/", 1))
             and k.count("/") == 1}
    return {**names, "shown": shown,
            "extensions": {n: e for n, e in exts.items() if NAME_RE.match(n) and isinstance(e, dict)}}


def _renamed_state(got: dict[str, Any]) -> dict[str, Any]:
    """A workspace's STATE_FILE object with each extension thimble renamed (userconf.renamed_extensions) under its new
    name: in `off`, `oriented` and `declined`, its views' switches in `shown`, and its entry in `extensions`, where the
    new name has none of its own."""
    exts, shown = got.get("extensions"), got.get("shown")
    named = [*_words(got.get("off")), *_words(got.get("oriented")), *_words(got.get("declined")),
             *(exts if isinstance(exts, dict) else ()), *(str(k).split("/", 1)[0] for k in
                                                          (shown if isinstance(shown, dict) else ()))]
    if not any(n in RENAMED for n in named) or not (names := userconf.renamed_extensions()):
        return got
    out = dict(got)
    for k in ("off", "oriented", "declined"):
        if k in got:
            out[k] = list(dict.fromkeys(names.get(n, n) for n in _words(got.get(k))))
    if isinstance(exts, dict):
        out["extensions"] = {names.get(n, n): e for n, e in exts.items() if n not in names or names[n] not in exts}
    if isinstance(shown, dict):
        def key(k: str) -> str:
            ext, sep, slug = str(k).partition("/")
            return f"{names[ext]}/{slug}" if sep and ext in names else k
        out["shown"] = {key(k): v for k, v in shown.items() if key(k) == k or key(k) not in shown}
    return out


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
    slugs, the orientation's `instructions` they replace (block), and the roles and tasks they replace with a prompt
    or a program (`role`, `task`), each of which then runs thimble's own."""
    seen: dict[str, dict[str, list[str]]] = {"view": {}, "card": {}, "block": {}, "role": {}, "task": {}}
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
        for r in e.get("roles") or []:
            if isinstance(r, dict) and r.get("role") and (r.get("kind") != "prompt" or r.get("replace")):
                seen["role"].setdefault(str(r["role"]), []).append(n)
        for r in e.get("tasks") or []:
            if isinstance(r, dict) and r.get("task") and (r.get("kind") != "prompt" or r.get("replace")):
                seen["task"].setdefault(str(r["task"]), []).append(n)
    return {k: {s: ns for s, ns in m.items() if len(ns) > 1} for k, m in seen.items()}


def conflict_lines(clash: dict[str, dict[str, list[str]]]) -> list[str]:
    """Each conflict (conflicts) in words."""
    out = []
    for kind, m in clash.items():
        for slug, names in m.items():
            both = ", ".join(names[:-1]) + f" and {names[-1]}"
            if kind == "block":
                out.append(f"{both} both replace the orientation's instructions, so thimble's own are used")
            elif kind == "role":
                out.append(f"{both} both replace {ROLE_NAMES.get(slug, 'the ' + slug)}, so thimble's own runs")
            elif kind == "task":
                out.append(f"{both} both replace the {slug} task, so thimble's own runs")
            else:
                out.append(f"{both} both give the {'view' if kind == 'view' else 'card type'} {slug!r}, so neither "
                           f"is used")
    return out


def views_of(c: str) -> list[dict[str, Any]]:
    """The views the active extensions show here ({extension, slug, name, description, claims, dir, note})."""
    return [{**v, "extension": e["name"], "dir": str(Path(e["dir"]) / "views" / v["slug"])}
            for e in active(c) for v in _list(e, "views") if v.get("shown")]


_gating: dict[tuple[str, str], asyncio.Task] = {}  # the checks of installed extension views running (_gate)


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
    entry: dict[str, Any] = {"key": at}
    entry["task"] = asyncio.get_running_loop().create_task(_decide(c, v, files, at), name=f"view-fit-{c}-{key}")
    entry["task"].add_done_callback(lambda _t: _answered(c, entry))
    _asking[(c, key)] = entry


async def _decide(c: str, v: dict[str, Any], files: list[tuple[Any, ...]], at: str) -> dict[str, Any]:
    """The view-fit task on view `v` once the refresh that started it has written the state, so that an extension
    switched on in that refresh which runs the task with its program runs it (tasks.call)."""
    from . import view_fit  # noqa: PLC0415

    async with _lock(c):
        pass
    return await view_fit.decide(c, v["name"], v["description"], files, at)


async def _fit(c: str, name: str, v: dict[str, Any], files: list[tuple[Any, ...]], kept: dict[str, Any]) -> dict[str, Any]:
    """Whether extension `name`'s view `v` fits workspace `c`: {fits, reason, by} with `key` for a model's decision,
    {key, error, ts} when its call failed, or {key, pending} while it runs (_start), with the answer before it while
    the files changed since. `files` are the files it claims here; `kept` the decision STATE_FILE holds, which stands
    while its key does (view_fit.key). One check runs per view at a time. An answer to files that changed while it was
    asked still stands, marked `stale`, and the next check waits RETRY_S after it."""
    from . import view_fit  # noqa: PLC0415

    if not files:
        return {"fits": False, "reason": NO_FILES, "by": "claims"}
    key = _view_key(name, v["slug"])
    at = view_fit.key(v["description"], files)
    got = _checks(c).get(key)
    if got is not None and got["task"].done():
        _asking.pop((c, key), None)
        try:
            ans = got["task"].result()
        except Exception as e:  # noqa: BLE001 — a check that failed decides nothing
            log.exception("%s: whether the view %s fits is not known", c, key)
            ans = {"key": got["key"], "error": f"{type(e).__name__}: {e}", "ts": _now()}
        if ans.get("key") == at:
            return ans
        kept = {**(ans if "fits" in ans or "fits" not in kept else kept), "stale": True, "ts": ans.get("ts") or _now()}
        kept.pop("pending", None)
        got = None
    if kept.get("key") == at and not kept.get("pending") and ("fits" in kept or (kept.get("error") and not _stale(kept))):
        return kept
    if got is None and kept.get("stale") and not _stale(kept):
        return kept
    if got is None:
        _start(c, key, at, v, files)
    return {"key": at, "pending": True, **({"fits": kept["fits"], "reason": kept.get("reason")} if "fits" in kept else {})}


def _note(fit: dict[str, Any]) -> str:
    """What Settings says beside a view: its check's reason, or that it is being made or failed."""
    if fit.get("pending"):
        return CHECKING
    if fit.get("error"):
        return f"thimble could not tell whether it fits here: {fit['error']}"
    return _one(fit.get("reason"))


def _settle_views(name: str, e: dict[str, Any], shown: dict[str, bool], clash: dict[str, dict[str, list[str]]],
                  gates: dict[str, Any] | None = None) -> None:
    """Each view of extension `name` marked `shown` (active, its files here, no other extension giving it, fitting or
    switched on here, and not failing its checks here, `gates`, unless switched on) with the `note` Settings shows;
    then `files`, the claims of the views it shows, of its card types whose claims match files here and its own scope
    where it matches files here, which `{{files}}` in its orientation instructions stands for."""
    files: list[str] = []
    for v in _list(e, "views"):
        fit = v.get("fit") or {}
        key = _view_key(name, v["slug"])
        g = (gates or {}).get(key) or {}
        failed = g.get("digest") == e.get("digest") and g.get("ok") is False
        on = shown.get(key, bool(fit.get("fits")) and not failed)
        v["shown"] = bool(e.get("active") and v.get("here") and on and v["slug"] not in clash["view"])
        v["note"] = (BOTH if e.get("active") and v["slug"] in clash["view"]
                     else CHECKS_FAILED.format(why=g.get("why") or "") if failed else _note(fit))
        card = bool(e.get("active") and v.get("card") and v.get("here") and v["slug"] not in clash["card"])
        if v["shown"] or card:
            files += v["claims"]
    for t in _list(e, "cards"):
        if e.get("active") and t.get("here") and t["slug"] not in clash["card"]:
            files += t.get("claims") or []
    if e.get("active") and e.get("scope_here"):
        files += _words(e.get("scope"))
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
    """Before an orientation starts: a refresh under way is waited for, the extensions are found when the workspace
    never found them, and a view's check still being made is waited for, so the orientation's instructions and agents
    are those of the active extensions and name the files of the views shown, and main hears of the card types."""
    from . import cardtypes  # noqa: PLC0415

    if _lock(c).locked():
        async with _lock(c):
            pass
    if not _state_path(c).is_file() or any(not e["task"].done() for e in _checks(c).values()):
        await refresh_quietly(c, wait=DECIDE_WAIT_S)
        await cardtypes.announce(c)


async def _refresh(c: str) -> dict[str, Any]:
    """The workspace's extensions found again in extensions_dir(), each active one copied in, whether each of its views
    fits checked (_fit) and which of its card types read files here found, written to STATE_FILE; then the views no
    active extension shows any more withdrawn and the shown ones installed, all under the workspace's lock, so that two
    refreshes never write a view's files at once; then the orientation told of the newly active extensions. Returns
    the state."""
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
            before = {v["slug"]: v for v in _list(kept, "views")}
            if not why:
                dig, size = await asyncio.to_thread(digest, root)
                here = workspace_path(c, name)
                try:
                    unlinked(config.workspace_dir(c), here / MANIFEST)
                except ValueError as e:
                    why = f"its copy in this workspace cannot be written: {e}"
                if size > SIZE_MAX:
                    why = f"its folder holds {size:,} bytes, and thimble copies {SIZE_MAX:,} at most"
                elif not why:
                    if dig != kept.get("digest") or not here.is_dir() or (await asyncio.to_thread(digest, here))[0] != dig:
                        await asyncio.to_thread(copy_tree, root, here)
                    info["digest"] = dig
                    for v in info["views"]:
                        files = await asyncio.to_thread(views.claimed_files, c, {"claims": v["claims"]}) if v["claims"] else []
                        v["here"] = bool(files)
                        v["fit"] = await _fit(c, name, v, files, (before.get(v["slug"]) or {}).get("fit") or {})
                        checked.add(_view_key(name, v["slug"]))
                    for t in info["cards"]:
                        t["here"] = bool(t["claims"]) and bool(
                            await asyncio.to_thread(views.claimed_files, c, {"claims": t["claims"]}))
                    info["scope_here"] = bool(info["scope"]) and bool(
                        await asyncio.to_thread(views.claimed_files, c, {"claims": info["scope"]}))
            if why:
                for v in info["views"]:
                    fit = (before.get(v["slug"]) or {}).get("fit") or {}
                    if "fits" in fit or fit.get("error"):
                        v["fit"] = {k: x for k, x in fit.items() if k != "pending"}
            exts[name] = {**{k: v for k, v in info.items() if k != "name"}, "active": not why, "why": why}
        _needs_running(exts)
        clash = conflicts(exts)
        gates = await asyncio.to_thread(read_gates, c)
        for name, e in exts.items():
            _settle_views(name, e, state["shown"], clash, gates)
        _needed_files(exts)
        for k, entry in _checks(c).items():
            if k not in checked and entry["task"].done():
                _asking.pop((c, k))  # an answer for a view removed or switched off meanwhile
        # what was sent or declined stands until the extension is switched off or removed, not through a problem
        on = {n for n in exts if n not in state["off"] and n not in (off or set())}
        new_state = {"off": state["off"], "shown": state["shown"],
                     "oriented": [n for n in state["oriented"] if n in on],
                     "declined": [n for n in state["declined"] if n in on], "extensions": exts}
        await asyncio.to_thread(write_json, _state_path(c), new_state)
        old = {n for n in RENAMED if os.path.lexists(workspace_path(c, n))}
        for name in sorted((set(state["extensions"]) | old) - set(exts)):
            try:
                gone = unlinked(config.workspace_dir(c), workspace_path(c, name))
            except ValueError as e:
                log.warning("%s: the copy of the removed extension %s was left: %s", c, name, e)
                continue
            await asyncio.to_thread(shutil.rmtree, gone, True)
        await asyncio.to_thread(_withdraw_given_up, c, exts)
        await asyncio.to_thread(install_views, c)
        for slug in await asyncio.to_thread(views.orphaned, c):
            await asyncio.to_thread(views.withdraw, c, slug, None)
    _gate_installed(c, exts, gates)
    return new_state


def gates_on() -> bool:
    """THIMBLE_EXTENSION_VIEW_CHECKS unset or on (the test suite turns it off in conftest.py)."""
    return os.environ.get("THIMBLE_EXTENSION_VIEW_CHECKS", "on").strip().lower() not in ("0", "off", "false", "no")


def read_gates(c: str) -> dict[str, Any]:
    """{"<extension>/<view>": {digest, ok, why, ts}}: the checks of each view an extension installed here, by the
    version of the extension (its digest) they ran on."""
    try:
        got = read_json(config.registry_dir(c) / CHECKS_FILE, {})
    except (OSError, ValueError, HTTPException):
        got = {}
    return {k: v for k, v in got.items() if isinstance(v, dict)} if isinstance(got, dict) else {}


def _gate_installed(c: str, exts: dict[str, Any], gates: dict[str, Any]) -> None:
    """Start the checks (_gate) of each view an active extension shows and installed here that has none for this version
    of the extension."""
    from . import views  # noqa: PLC0415

    if not gates_on():
        return
    for name, e in exts.items():
        if not e.get("active"):
            continue
        for v in _list(e, "views"):
            key = _view_key(name, v["slug"])
            prop = views.read_proposal(c, v["slug"]) or {}
            if (not v.get("shown") or prop.get("extension") != name or (gates.get(key) or {}).get("digest") == e.get("digest")
                    or ((c, key) in _gating and not _gating[(c, key)].done())):
                continue
            _gating[(c, key)] = asyncio.get_running_loop().create_task(_gate(c, key, v["slug"], str(e.get("digest") or "")),
                                                                      name=f"extension-check-{c}-{key}")


async def _gate(c: str, key: str, slug: str, dig: str) -> None:
    """The checks of an installed extension view (views.check), kept in CHECKS_FILE; a failure has the workspace find
    its extensions again, which hides the view."""
    from . import views  # noqa: PLC0415

    try:
        rep = await views.check(c, slug, need_locators=False)
        why = "" if rep.get("ok") else (views.first_failure(rep) or "the checks did not pass")[:400]
        got = {"digest": dig, "ok": bool(rep.get("ok")), "why": why, "ts": _now()}
    except Exception:  # noqa: BLE001 — a check that could not run decides nothing
        log.exception("%s: the checks of the extension view %s did not run", c, key)
        return
    async with _lock(c):
        gates = await asyncio.to_thread(read_gates, c)
        gates[key] = got
        await asyncio.to_thread(write_json, config.registry_dir(c) / CHECKS_FILE, gates)
    if not got["ok"]:
        log.warning("%s: the extension view %s failed its checks: %s", c, key, got["why"])
        await refresh_quietly(c)


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


def orientation_ran(c: str) -> bool:
    """Whether an orientation has a session, a thread and a transcript in workspace `c`, which a follow-up can resume
    (orient_session._chat_of and resume)."""
    from . import agents, orientation, session  # noqa: PLC0415

    rec = orientation.read_run(c) or {}
    chat = str((rec.get("chats") or {}).get(orientation.ROLE) or "")
    sid = str(rec.get("session") or "")
    return bool(sid and chat and agents.meta_or_none(c, chat) is not None and session.find_transcript(sid))


def oriented_here(c: str) -> bool:
    """Whether an orientation ran in workspace `c` with a thread, thimble's own or a program's, which an orientation
    program runs again after (orient_session.run_program_now)."""
    from . import agents, orientation  # noqa: PLC0415

    rec = orientation.read_run(c) or {}
    chat = str((rec.get("chats") or {}).get(orientation.ROLE) or "")
    return bool(chat and rec.get("status") != "requested" and agents.meta_or_none(c, chat) is not None)


def orient_program(e: dict[str, Any]) -> bool:
    """Whether the extension `e` (read_extension, or a workspace's entry) runs the orientation with a program (sdk or
    command) of its own."""
    return any(isinstance(r, dict) and r.get("role") == "orientation" and r.get("kind") in ("sdk", "command")
               for r in e.get("roles") or [])


def _replaces_orientation(e: dict[str, Any]) -> bool:
    return any(isinstance(r, dict) and r.get("role") == "orientation"
               and (r.get("kind") != "prompt" or r.get("replace")) for r in e.get("roles") or [])


def _program_runs(name: str, exts: dict[str, Any]) -> bool:
    """Whether extension `name`'s orientation program runs the orientation once it is on: no other active extension
    replaces the orientation role (roles.agent_for)."""
    e = exts.get(name) or {}
    return orient_program(e) and not any(n != name and x.get("active") and _replaces_orientation(x)
                                         for n, x in exts.items())


def _can_run(c: str, name: str, exts: dict[str, Any], replacing: bool, ran: tuple[bool, bool, bool]) -> bool:
    """Whether Run now can run extension `name`'s orientation here (`ran`, as _ran gives it): its program runs again
    with the earlier cards wherever an orientation ran, and its instructions go to an orientation a follow-up reaches,
    thimble's own session that can be resumed or the program that ran it, which runs again with them
    (orient_session.message)."""
    e = exts.get(name) or {}
    if orient_program(e):
        return _program_runs(name, exts) and ran[0]
    if not runs_orientation(e, replacing):
        return False
    from . import roles  # noqa: PLC0415

    return ran[1] or (ran[2] and roles.agent_for(c, "orientation").code)


def _ran(c: str) -> tuple[bool, bool, bool]:
    """(whether an orientation ran here with a thread, whether thimble's own session of it can be resumed, whether
    an extension's program ran it)."""
    from . import orientation  # noqa: PLC0415

    resumable = orientation_ran(c)
    anyhow = resumable or oriented_here(c)
    return anyhow, resumable, anyhow and bool((orientation.read_run(c) or {}).get("program"))


def offered(c: str, state: dict[str, Any] | None = None) -> list[str]:
    """The active extensions whose orientation Settings offers to run now: Run now can run it here (_can_run), and the
    orientation has not had it since the extension was last switched on, nor did the analyst answer Not now."""
    state = read_state(c) if state is None else state
    ran = _ran(c)
    if not ran[0]:
        return []
    replacing = _replacing(c, state["extensions"])
    return [n for n, e in sorted(state["extensions"].items()) if e.get("active")
            and _can_run(c, n, state["extensions"], replacing, ran)
            and n not in state["oriented"] and n not in state["declined"]]


def _replacing(c: str, exts: dict[str, Any]) -> bool:
    """Whether an extension's replacement of thimble's orientation instructions stands in the prompt here: the analyst
    has no instructions of their own and no two extensions replace them (orient_session.instructions_of)."""
    from . import ledger, orient_session  # noqa: PLC0415

    try:
        own = ledger.stored_settings(c).get(orient_session.SETTING)
    except (OSError, ValueError):
        own = None
    return not (isinstance(own, str) and own.strip()) and not conflicts(exts)["block"]


def runs_orientation(e: dict[str, Any], replacing: bool) -> bool:
    """Whether Run now would send the extension `e`'s orientation instructions: it adds to them, or its replacement
    stands here (`replacing`, _replacing)."""
    return bool(e.get("orient")) or (bool(e.get("replaces")) and replacing)


async def mark_oriented(c: str, names: list[str] | None = None) -> None:
    """thimble's own orientation starts with the active extensions' instructions in its prompt, or the orientation had
    those of `names`, or ran their program."""
    async with _lock(c):
        state = read_state(c)
        names = [n for n, e in state["extensions"].items()
                 if e.get("active") and (e.get("orient") or e.get("replaces"))] if names is None else names
        got = sorted({*state["oriented"], *names})
        if got != state["oriented"]:
            await asyncio.to_thread(write_json, _state_path(c), {**state, "oriented": got})


async def decline(c: str, name: str) -> None:
    """Not now: Settings stops offering to run the extension's orientation instructions until it is switched on again."""
    async with _lock(c):
        state = read_state(c)
        await asyncio.to_thread(write_json, _state_path(c),
                                {**state, "declined": sorted({*state["declined"], name})})


def _instructions(c: str, name: str, exts: dict[str, Any]) -> str:
    """The orientation instructions of active extension `name` as a follow-up sends them. A replacement of thimble's
    instructions is sent only where it stands in the prompt (_replacing)."""
    e = next((x for x in active(c) if x["name"] == name), None)
    if e is None:
        return ""
    replacing = _replacing(c, exts)
    return _orient_text(e, source_path(name), e.get("orient") or (e.get("replaces") if replacing else ""))


async def run_orientation(c: str, name: str) -> dict[str, Any]:
    """Run now: an extension whose program runs the orientation runs it again as a follow-up, with the earlier request
    and the cards as they stand, so it adds to them (orient_session.run_program_now); any other extension's
    instructions are sent to the orientation as a follow-up, resumed or queued behind the run going
    (orient_session.message). {status: rerun | resumed | queued | nothing}, rerun for a program; NoOrientation, Gone
    or RuntimeError when it cannot run."""
    from . import orient_session  # noqa: PLC0415

    exts = read_state(c)["extensions"]
    if orient_program(exts.get(name) or {}):
        await orient_session.run_program_now(c, name)
        await mark_oriented(c, [name])
        return {"status": "rerun"}
    text = _instructions(c, name, exts)
    if not text:
        return {"status": "nothing"}
    got = await orient_session.message(c, text, orient_session.EXTENSION, extension=name)
    await mark_oriented(c, [name])
    return {"status": str(got.get("status") or "resumed")}


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
    """The body of the extension's orientation file `rel`, `{{files}}` in it filled with the files it claims here and
    `{{dir}}` with its copy in the workspace."""
    if not _own_file(src, rel):
        return ""
    _, body = _front(src / str(rel))
    body = body.replace("{{dir}}", str(e.get("dir") or ""))
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


def _subagent(e: dict[str, Any], name: str) -> tuple[dict[str, Any], str] | None:
    """(its fields, its prompt) of the active extension `e`'s subagent `name`: from agents/orientation/agent.json and the
    prompt file it names, else agents/<name>.md and its frontmatter; None when its prompt cannot be read."""
    src = Path(e["src"])
    sub = (e.get("subagents") or {}).get(name)
    if isinstance(sub, dict):
        if not _own_file(src, sub.get("prompt")):
            return None
        _, body = _front(src / str(sub["prompt"]))
        return {k: v for k, v in sub.items() if k != "prompt"}, body
    try:
        return frontmatter((src / "agents" / f"{name}.md").read_text("utf-8"))
    except OSError:
        return None


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
            got = _subagent(e, name)
            if got is None:
                continue
            front, body = got
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
            for key in SUBAGENT_PASSED:
                if key in front:
                    agent[key] = front[key]
            taken = [*(WEB_TOOLS if mine["web"] == "off" else ()),
                     *(("Bash",) if mine["network"] == "off" and session_network else ())]
            own_denied = front.get("disallowedTools") if isinstance(front.get("disallowedTools"), list) else []
            if taken or own_denied:
                agent["disallowedTools"] = list(dict.fromkeys([*taken, *map(str, own_denied)]))
                tools = [t for t in tools if t not in agent["disallowedTools"]]
            if tools:
                agent["tools"] = tools
            found.append((e["name"], name, agent))
    counts: dict[str, int] = {}
    for _, name, _ in found:
        counts[name] = counts.get(name, 0) + 1
    return {(name if counts[name] == 1 else f"{ext}:{name}"): agent for ext, name, agent in found}


def agent_models(c: str | None) -> dict[str, dict[str, Any]]:
    """The Settings rows of the active extensions' agents, by config key ("<ext>:<name>"): the model and effort each
    runs at (the config's, else its file's, else thimble:helper's row, `subagents`, so that each names an explicit
    effort), `fast` False since a subagent has no fast mode of its own, and `extension`."""
    conf = userconf.load_or_defaults(c)[0]
    helper = config.models_for(c)["subagents"]
    subagents = helper["model"]
    out: dict[str, dict[str, Any]] = {}
    for e in active(c):
        for name in _words(e.get("agents")):
            if not NAME_RE.match(name) or name == "orient":
                continue
            got = _subagent(e, name)
            if got is None:
                continue
            front = got[0]
            key = f"{e['name']}:{name}"
            mine = userconf.extension_agent(conf, key)
            model = str(mine["model"] or front.get("model") or "")
            out[key] = {"model": config.exact_model(model) if model else subagents,
                        "effort": config.effort_level(mine["effort"] or front.get("effort")) or helper["effort"],
                        "fast": False,
                        "extension": e["name"]}
    return out


def _card_block(slug: str, raw: dict[str, Any]) -> dict[str, Any]:
    """A card.json as the keys of a view's `card` block (cardtypes.card_block): `description` read as `use`, and an
    `example` of arguments written as the call main's prompt shows."""
    block = dict(raw)
    if not block.get("use") and block.get("description"):
        block["use"] = block["description"]
    ex = block.get("example")
    if isinstance(ex, dict):
        args = ", ".join(f"{k}={json.dumps(v, ensure_ascii=False)}" for k, v in ex.items() if str(k).isidentifier())
        block["example"] = f'thimble.card("{slug}"' + (f", {args}" if args else "") + ")"
    return block


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
            block = raw.get("card") if kind == "views" else _card_block(slug, raw)
            of_view = _json(src / "views" / view / views.VIEW_JSON) if view is not None else {}
            reader = here / "views" / view if view is not None else here / "cards" / slug
            out.append({"slug": slug, "extension": e["name"], "view": view, "dir": str(here / kind / slug),
                        "reader": str(reader / views.READER_PY), "page": page,
                        "name": _one(raw.get("name") or of_view.get("name") or slug),
                        "block": block if isinstance(block, dict) else {},
                        "libs": _words(e.get("js")) or raw.get("libs") or of_view.get("libs"),
                        "guide": _text(src / kind / slug / GUIDE), "claims": claims,
                        "cache": str(views.indexes_dir(c) / CACHE_DIR / e["name"] / (view or f"cards/{slug}"))})
    return out


def _report_form(src: Path) -> tuple[dict[str, Any], str] | None:
    """({name, description, renderer}, the writer's text) of the report type in folder `src`: report.json with
    writer.md and report.md, the form, after it; else type.md's frontmatter and body. None when neither reads."""
    if (src / REPORT_JSON).is_file():
        raw = _json(src / REPORT_JSON)
        form = _text(src / REPORT_MD)
        if not raw or not form:
            return None
        writer = _front(src / WRITER_MD)[1] if (src / WRITER_MD).is_file() else ""
        return ({"name": raw.get("name"), "description": raw.get("description"), "renderer": raw.get("viewer")},
                "\n\n".join(x for x in (writer, form) if x))
    try:
        return frontmatter((src / TYPE_MD).read_text("utf-8"))
    except OSError:
        return None


def report_types(c: str | None) -> list[dict[str, Any]]:
    """The report types of the active extensions, in the preset form ({id, name, description, renderer, prompt}) plus
    {extension, dir, export, export_src}, leaving out a name thimble's own types take (report_types.RESERVED). `dir` is
    the type's folder in the workspace's copy, where an `exports` kernel runs export.py (`export`); `export_src` is that
    file in the extension's folder, whose FORMATS the server reads."""
    from . import report_types as thimble_types  # noqa: PLC0415

    if not c:
        return []
    out = []
    for e in active(c):
        folder = e.get("reports_dir") if e.get("reports_dir") in REPORT_DIRS else REPORT_DIRS[0]
        for r in _list(e, "reports"):
            if not NAME_RE.match(r["slug"]) or r["slug"] in thimble_types.RESERVED:
                continue
            d, src = Path(e["dir"]) / folder / r["slug"], Path(e["src"]) / folder / r["slug"]
            got = _report_form(src)
            if got is None:
                continue
            front, body = got
            renderer = str(front.get("renderer") or "").strip().lower()
            renderer = renderer if renderer in REPORT_RENDERERS else "document"
            out.append({"id": r["slug"], "name": _one(front.get("name") or r["slug"]),
                        "description": _one(front.get("description")), "renderer": renderer, "prompt": body,
                        "extension": e["name"], "dir": str(d),
                        "export": str(d / EXPORT_PY) if (src / EXPORT_PY).is_file() else None,
                        "export_src": str(src / EXPORT_PY)})
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
        if _thimbles_folder(local.resolve()):
            raise AddError(f"{local.resolve()} is in thimble's own folders, which its agents and kernels write. Copy "
                           f"the extension's folder to one of your own and add that, or add the extension's name if "
                           f"thimble ships it")
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


def _thimbles_folder(d: Path) -> bool:
    """Whether folder `d` is in thimble's home (its extensions folder included) or inside a workspace, which a folder
    used in place must not be: thimble replaces its own copies there, and its agents and kernels write the rest."""
    if d.is_relative_to(home().resolve()):
        return True
    ws = config.WORKSPACES_DIR.resolve()
    return d.is_relative_to(ws) and len(d.relative_to(ws).parts) >= 2


def _row(kind: str, name: str, about: str) -> str:
    return f"  {kind.ljust(12) if len(kind) < 12 else kind + ' '}" + (f"{name}: {about}" if name and about else name or about)


WAYS = {"prompt": "adds to {who}'s prompt", "replace": "replaces {who}'s prompt",
        "sdk": "runs {who} as an Agent SDK program", "command": "runs {who} as a program of its own"}
ROLE_NAMES = {"main": "main", "orientation": "the orientation", "critic": "the critic", "writer": "the writer",
              "dev": "the dev agent"}  # each role as a sentence names it


def _way(r: dict[str, Any]) -> str:
    """How an extension changes a role or task (_roles, _tasks), in words."""
    who = ROLE_NAMES.get(str(r.get("role")), f"the {r.get('role')}") if r.get("role") else f"the {r.get('task')} task"
    if r["kind"] == "prompt":
        return WAYS["replace" if r.get("replace") else "prompt"].format(who=who)
    if r["kind"] == "command":
        return f"{WAYS['command'].format(who=who)} ({' '.join(r.get('command') or [])})"
    return f"{WAYS['sdk'].format(who=who)} ({Path(r.get('file') or '').name})"


def has_code(e: dict[str, Any]) -> bool:
    """Whether the extension `e` (read_extension, or a workspace's entry) has Python that thimble's kernels run: a
    view's reader, a card type's code or a report type's export.py."""
    return bool(_list(e, "views") or _list(e, "cards") or any(r.get("export") for r in _list(e, "reports")))


def _subagent_fields(root: Path, e: dict[str, Any], name: str) -> dict[str, Any]:
    """The fields of subagent `name` of the extension `e` in folder `root`: agent.json's, else its file's frontmatter."""
    sub = (e.get("subagents") or {}).get(name)
    if isinstance(sub, dict):
        return sub
    return _front(root / "agents" / f"{name}.md")[0]


def _subagent_about(info: dict[str, Any], name: str) -> str:
    return _one(_subagent_fields(Path(info["root"]), info, name).get("description"))


def mcp_servers(fields: dict[str, Any]) -> list[str]:
    """The MCP servers a subagent's fields (`mcpServers`) start, each by its name and the command or address it runs.
    Claude Code starts them outside the sandbox."""
    raw = fields.get("mcpServers")
    items: list[tuple[Any, Any]] = list(raw.items()) if isinstance(raw, dict) else []
    for x in raw if isinstance(raw, list) else []:
        items += [(x, None)] if isinstance(x, str) else list(x.items()) if isinstance(x, dict) else []
    out = []
    for name, conf in items:
        conf = conf if isinstance(conf, dict) else {}
        run = " ".join(_words([conf.get("command") or "", *(_words(conf.get("args")))])) or _one(conf.get("url"))
        out.append(f"{_one(name)} ({run})" if run else _one(name))
    return [x for x in out if x]


def summary(info: dict[str, Any], how: dict[str, Any]) -> list[str]:
    """What `thimble extension add` shows before it asks: what the extension is, each contribution with its own
    description, what it needs, and where its code runs."""
    v = f" {info['version']}" if info["version"] else ""
    at = f" at {how['commit']}" if how.get("commit") else ""
    where = ("built in" if how.get("kind") == "built-in" else f"used in place from {how['source']}"
             if how.get("kind") == "folder" else f"from {how['source']}{at}")
    out = [f"{info['name']}{v}, {where}"]
    root = Path(info["root"])
    if info.get("description"):
        out.append(f"  {info['description']}")
    for x in info["views"]:
        out.append(_row("view", x["slug"], x["description"]) + (" Also a card type." if x["card"] else ""))
    for x in info["cards"]:
        out.append(_row("card type", x["slug"], x["use"]))
    roles = {r["role"]: r for r in info.get("roles") or []}
    for r in roles.values():
        about = f"{r['description']} It {_way(r)}." if r["description"] else f"It {_way(r)}."
        out.append(_row(r["role"], "", about))
    for a in info["agents"]:
        out.append(_row("agent", a, _subagent_about(info, a)))
        if servers := mcp_servers(_subagent_fields(root, info, a)):
            out.append(_row("", "", f"It starts MCP servers outside the sandbox: {', '.join(servers)}."))
    if "orientation" not in roles:
        for rel, what in ((info["orient"], "adds to the orientation's instructions"),
                          (info["replaces"], "replaces thimble's instructions, unless your own setting or another "
                                             "extension does")):
            if rel:
                about = _one(_front(root / rel)[0].get("description")) if rel.endswith(".md") else ""
                out.append(_row("orientation", "", f"{about} It {what}." if about else f"It {what}."))
    for t in info.get("tasks") or []:
        about = f"{t['description']} It {_way(t)}." if t["description"] else f"It {_way(t)}."
        out.append(_row("task", t["task"], about))
    for r in info["reports"]:
        out.append(_row("report type", r["slug"], r["description"]) + (" With its own exports." if r["export"] else ""))
    for k in info.get("checks") or []:
        out.append(_row("report check", k["slug"], f"{k['name']}. It is offered in the report's Checks."))
    if info["thimble"]:
        out.append(f"  It works with thimble {info['thimble']}.")
    if info["js"]:
        out.append(f"  Its pages use {', '.join(info['js'])}, which thimble inlines.")
    if info["python"]:
        out.append(f"  It needs the Python {_several(len(info['python']), 'package', 'packages')} "
                   f"{', '.join(info['python'])}, which thimble does not install.")
    if info["views"]:
        out.append("  Its views show where a quick model check finds they fit the corpus and they pass thimble's view "
                   "checks on its files. The rest runs in every workspace until it is switched off.")
    if info["agents"]:
        out.append("  Its agents run in the orientation's session and its sandbox, without the web unless thimble's "
                   f"config sets agents.\"{info['name']}:<agent>\".web.")
    coded = [w for w, rs in (("roles", roles.values()), ("tasks", info.get("tasks") or []))
             if any(r["kind"] != "prompt" for r in rs)]
    if coded:
        out.append(f"  Its programs run in place of thimble's own for the {' and '.join(coded)} above, with the same "
                   "consent rules.")
    if has_code(info):
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


def add(source: str, *, yes: bool = False, ask: Any = input, say: Any = print) -> list[str] | None:
    """`thimble extension add`: fetch the extension and the extensions it needs that thimble ships and are not added,
    show what each gives (summary) and the conflicts adding them brings (conflicts_of), and copy them into
    extensions_dir() once the analyst says yes (or `yes`). Returns their names, its own first, None when the analyst
    said no. AddError for an extension that cannot load for a reason of its own folder."""
    import tempfile  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="thimble-ext-") as tmp:
        root, how = fetch(source, Path(tmp))
        plan = _plan(root, how, Path(tmp))
        digests = []
        for d, h, info in plan:
            fatal = [x for x in info["problems"] if x not in info["waits"]]
            if fatal:
                raise AddError(f"{h['source']} cannot be added, with {len(fatal)} "
                               f"{_several(len(fatal), 'problem', 'problems')}:\n" + "\n".join(f"  {x}" for x in fatal))
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
        for line in conflicts_of([info for _d, _h, info in plan]):
            say(f"Conflict: {line}.")
        if not yes:
            try:
                answer = ask("Add it? [y/N] " if len(plan) == 1 else f"Add these {len(plan)}? [y/N] ")
            except EOFError:
                answer = ""
            if str(answer).strip().lower() not in ("y", "yes"):
                return None
        extensions_dir().mkdir(parents=True, exist_ok=True)
        for (d, h, info), dig in zip(plan, digests):
            _put_in_place(d, h, info["name"], dig)
    return [info["name"] for _d, _h, info in plan]


def _put_in_place(d: Path, how: dict[str, Any], name: str, dig: str) -> None:
    """Extension `name` from folder `d` into extensions_dir(): a local folder linked and used in place, anything else
    copied; then switched on in thimble's config, since adding it turns it on."""
    dest = source_path(name)
    _clear(name)
    if how.get("kind") == "folder":
        dest.symlink_to(d.resolve(), target_is_directory=True)
    else:
        copy_tree(d, dest)
    write_json(_record_file(name), {**how, "digest": dig, "ts": _now()})
    try:
        userconf.set_extension_enabled(name, True)
    except userconf.ConfigError as e:
        log.warning("the extension %s was added and thimble's config could not switch it on: %s", name, e)


def _clear(name: str) -> None:
    """Take extension `name` out of extensions_dir(): its copy, or the link to its folder and the record beside it, never
    the folder linked to."""
    dest = source_path(name)
    side = extensions_dir() / f".{name}{ADDED}"
    if dest.is_symlink():
        dest.unlink()
    elif dest.is_dir():
        shutil.rmtree(dest)
    side.unlink(missing_ok=True)


def builtins() -> dict[str, Path]:
    """{name: folder} of each extension thimble ships."""
    return {d.name: d for d in _subdirs(builtin_dir()) if (d / MANIFEST).is_file()}


def not_added() -> list[tuple[str, str]]:
    """[(name, version)] of each extension thimble ships that is not added."""
    have = added()
    return [(n, _one(_json(d / MANIFEST).get("version"))) for n, d in builtins().items() if n not in have]


def foreign(old: str) -> bool:
    """Whether an added extension has the old name `old` of a built-in thimble renamed (RENAMED) and is not thimble's
    copy of that built-in, nor a link to the folder thimble shipped it in, so its name and settings stay its own."""
    dest = source_path(old)
    if dest.is_symlink():
        return os.path.realpath(dest) != os.path.realpath(builtin_dir() / old)
    return dest.is_dir() and _json(dest / ADDED).get("kind") != "built-in"


def renamed(name: str) -> str:
    """The new name of the built-in that thimble renamed from `name` (RENAMED), unless an extension of the analyst's own
    has that name (foreign); `name` otherwise."""
    return userconf.renamed_extensions().get(name, name)


def _rename_shipped() -> list[str]:
    """Carry each built-in thimble renamed (RENAMED) over to its new name where it was added under the old one: a copy
    unchanged since becomes the new version thimble ships, a changed copy keeps the analyst's changes under the new
    name, and a link to the folder thimble shipped it in links to its new folder; then thimble's config takes the new
    name (userconf.rename_extensions). An extension of the analyst's own with the old name stays (foreign). Where the
    new name is added already, an unchanged copy or a link under the old name goes, and a changed copy stays. One that
    cannot be carried over stays as it is until the next run. Returns the new names carried over."""
    ships = builtins()
    out = []
    for old, new in RENAMED.items():
        try:
            if _carry_over(old, new, ships):
                out.append(new)
        except OSError as e:
            log.warning("the extension %s could not be carried over to %s: %s", old, new, e)
    userconf.rename_extensions(userconf.global_file())
    return out


def _carry_over(old: str, new: str, ships: dict[str, Path]) -> bool:
    """_rename_shipped for the built-in `old`, now `new`; True when it is carried over."""
    dest, target = source_path(old), source_path(new)
    if not (dest.is_symlink() or dest.is_dir()) or foreign(old) or new not in ships:
        return False
    rec = _json(_record_file(old))
    unchanged = dest.is_symlink() or digest(dest)[0] == rec.get("digest")
    if target.is_symlink() or target.exists():
        if unchanged:
            _clear(old)
        return False
    now = digest(ships[new])[0]
    if dest.is_symlink():
        _clear(old)
        target.symlink_to(ships[new].resolve(), target_is_directory=True)
        write_json(_record_file(new), {**rec, "source": str(ships[new].resolve()), "digest": now, "ts": _now()})
    elif unchanged:
        copy_tree(ships[new], target)
        write_json(target / ADDED, {**rec, "source": new, "digest": now, "ts": _now()})
        _clear(old)
    else:
        os.replace(dest, target)
        manifest = _json(target / MANIFEST)
        write_json(target / MANIFEST, {**manifest, "name": new})
        write_json(target / ADDED, {**rec, "source": new})
    log.info("the extension %s is now %s", old, new)
    return True


def ship() -> list[str]:
    """Carry the built-ins thimble renamed over to their new names (_rename_shipped). Add each built-in of SHIPPED_ON
    that thimble has not added before, unless the analyst already added it: one the analyst removes stays removed. Then
    bring each built-in added by name whose copy is unchanged since to the version this thimble ships; one that needs an
    extension that is not added stays unloaded until it is added. Returns the names carried over, added or brought up to
    date."""
    out = _rename_shipped()
    base = extensions_dir()
    mark = _json(base / SHIPPED)
    done = [n for n in _words(mark.get("added")) if NAME_RE.match(n)]
    ships = builtins()
    for name in SHIPPED_ON:
        if name in done or name not in ships:
            continue
        dest = source_path(name)
        if not dest.is_symlink() and not (dest / MANIFEST).is_file():
            copy_tree(ships[name], dest)
            write_json(dest / ADDED, {"source": name, "kind": "built-in", "shipped": True,
                                      "digest": digest(ships[name])[0], "ts": _now()})
            out.append(name)
        done.append(name)
    for name, dest in added().items():
        rec = _json(_record_file(name))
        if rec.get("kind") != "built-in" or name not in ships or name in out or dest.is_symlink():
            continue
        now = digest(ships[name])[0]
        if now != rec.get("digest") and digest(dest)[0] == rec.get("digest"):
            copy_tree(ships[name], dest)
            write_json(dest / ADDED, {**rec, "digest": now, "ts": _now()})
            out.append(name)
    if done != _words(mark.get("added")):
        base.mkdir(parents=True, exist_ok=True)
        write_json(base / SHIPPED, {"added": done})
    return out


def remove(name: str) -> bool:
    """`thimble extension remove`: delete the added extension's copy, or the link to a folder used in place, leaving that
    folder as it is. False when there is none of that name."""
    if not NAME_RE.match(name) or name not in added():
        return False
    _clear(name)
    return True


class SwitchError(Exception):
    """Why `thimble extension on | off` cannot switch what it was given."""


def switch(name: str, on: bool, workspaces_dir: Path | None = None) -> dict[str, Any]:
    """`thimble extension on | off <name>`: switch an added extension on or off in every workspace, in thimble's config.
    Returns {orients, orient_program, off_in, problem}: whether it changes the orientation (orients) and whether its own
    program runs it, the workspaces under `workspaces_dir` whose own switch in Settings keeps it off (off_in), and why
    it does not load ('' when it does)."""
    got = added()
    if name not in got:
        raise SwitchError(f"no extension {name!r} is added. `thimble extension list` lists them.")
    try:
        userconf.set_extension_enabled(name, on)
    except userconf.ConfigError as e:
        raise SwitchError(str(e)) from e
    info = read_extension(got[name], name, set(got))
    return {"orients": orients(info), "orient_program": orient_program(info), "off_in": off_in(name, workspaces_dir),
            "problem": info["problems"][0] if info["problems"] else ""}


def off_in(name: str, workspaces_dir: Path | None = None) -> list[str]:
    """The workspaces under `workspaces_dir` whose own switch in Settings keeps extension `name` off."""
    try:
        base = workspaces_dir or config.WORKSPACES_DIR
        folders = sorted(d for d in base.iterdir() if d.is_dir() and config._valid_name(d.name))
    except OSError:
        return []
    return [d.name for d in folders
            if name in _words(_renamed_state(_json(d / kernel_wrap.REGISTRY_DIR / STATE_FILE)).get("off"))]


def orients(e: dict[str, Any]) -> bool:
    """Whether the extension `e` (read_extension, or a workspace's entry) gives the orientation instructions, which
    bring its agents with them, or runs the orientation with a program of its own."""
    return bool(e.get("orient") or e.get("replaces")) or orient_program(e)


def list_lines(workspaces_dir: Path) -> list[str]:
    """`thimble extension list`: a line per added extension (name, version, source, and whether it loads), then a line
    per workspace, on or off there with why it is off or that no session connected there since it was added, and under
    it a line per view, shown or hidden there with its check's reason. Then a line per extension thimble ships that is
    not added."""
    got = added()
    idle = [f"{n}{' ' + v if v else ''}, built in, not added. `thimble extension add {n}` adds it."
            for n, v in not_added()]
    if not got:
        return ["No extensions added. `thimble extension add <folder | git URL | built-in name>` adds one.", *idle]
    off = userconf.extensions_off()
    try:
        folders = sorted(d for d in workspaces_dir.iterdir() if d.is_dir() and config._valid_name(d.name))
    except OSError:
        folders = []
    states = {d.name: _renamed_state(_json(d / kernel_wrap.REGISTRY_DIR / STATE_FILE)) for d in folders}
    width = max((len(d.name) for d in folders), default=0)
    out = []
    for name, root in got.items():
        info = read_extension(root, name, set(got))
        loads = "not loaded: " + info["problems"][0] if info["problems"] else config_off(name, off) or "on"
        v = f" {info['version']}" if info["version"] else ""
        where = ("built in" if info["builtin"] else f"used in place from {os.readlink(root)}" if root.is_symlink()
                 else "from " + (info["source"] or str(root)))
        out.append(f"{name}{v}, {where}: {loads}")
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
    return out + idle


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
    parts = [p if (e := loadable.get(p.split(" ", 1)[0])) is None or e["active"] else f"{p} ({e['why']})"
             for p in parts]
    return "; ".join(parts + [f"conflict: {x}" for x in conflict_lines(conflicts(loadable))])


# --------------------------------------------------------------------------- routes

router = APIRouter()


# the agent of thimble's config whose settings a role of an extension runs under
CONFIG_AGENT = {"orientation": "orientation", "critic": "critic", "writer": "writer", "dev": "dev"}


def parts(e: dict[str, Any], unused: dict[str, str] | None = None) -> list[str]:
    """What the extension `e` gives, each in a few words, for Settings. `unused` {role, or `task:<task>`: why} says why
    its change to a role or task is not used here: another extension replaces the same one, or another's program runs
    it."""
    unused = unused or {}

    def but(role: str, words: str) -> str:
        return f"{words}, not used, since {unused[role]}" if role in unused else words

    out = [f"{v.get('name') or v['slug']} view" for v in _list(e, "views")]
    out += [f"{t.get('name') or t['slug']} card type" for t in _list(e, "cards")]
    out += [f"{r.get('name') or r['slug']} report type" for r in _list(e, "reports")]
    roles = {r["role"]: r for r in e.get("roles") or [] if isinstance(r, dict) and r.get("role")}
    for role, r in roles.items():
        out.append(but(role, _changes(ROLE_NAMES.get(role, f"the {role}"), r)))
    if "orientation" not in roles:
        if e.get("orient"):
            out.append(but("orientation", "adds to the orientation"))
        elif e.get("replaces"):
            out.append(but("orientation", "replaces the orientation's instructions"))
    out += [but("orientation", f"{a} agent") for a in _words(e.get("agents"))]
    same: dict[tuple[str, bool, str], list[str]] = {}  # the tasks it changes the same way, named together
    for t in e.get("tasks") or []:
        if isinstance(t, dict) and t.get("task"):
            key = (str(t.get("kind")), bool(t.get("replace")), unused.get(f"task:{t['task']}", ""))
            same.setdefault(key, []).append(str(t["task"]))
    for (kind, replace, why), names in same.items():
        words = _changes(f"the {names[0]} task", {"kind": kind, "replace": replace}) if len(names) == 1 else \
            _changes_all(names, kind, replace)
        out.append(f"{words}, not used, since {why}" if why else words)
    out += [f"{k.get('name') or k['slug']} report check" for k in _list(e, "checks")]
    return out


def _changes_all(tasks: list[str], kind: str, replace: bool) -> str:
    """How an extension changes several tasks the same way, in a few words: "its own labels and checks tasks, programs"."""
    names = f"{', '.join(tasks[:-1])} and {tasks[-1]}"
    if kind == "prompt":
        return f"replaces the {names} tasks' prompts" if replace else f"adds to the {names} tasks"
    return f"its own {names} tasks, " + ("Agent SDK programs" if kind == "sdk" else "programs")


def _changes(what: str, r: dict[str, Any]) -> str:
    """How an extension changes a role or task, in a few words: "adds to the critic", "its own critic, a program"."""
    if r.get("kind") == "prompt":
        return f"replaces {what}'s prompt" if r.get("replace") else f"adds to {what}" + ("'s prompt" if what == "main" else "")
    own = what.removeprefix("the ")
    return f"its own {own}, " + ("an Agent SDK program" if r.get("kind") == "sdk" else "a program")


def _settings_words(a: dict[str, Any], data: bool = True) -> str:
    network = "network" if a.get("network") == "on" else "no network"
    web = {"allow": "web", "ask": "web asks first", "off": "no web"}.get(str(a.get("web")), "")
    edits = ({"allow": "corpus edits allowed", "ask": "corpus edits ask first", "off": "no corpus edits"}.get(
        str(a.get("data")), "corpus read-only") if data else "")
    return ", ".join(x for x in (network, web, edits) if x)


def consent(e: dict[str, Any], conf: dict[str, Any]) -> str:
    """The settings what the extension `e` runs runs under, in words: those of thimble's config for each role it changes
    or adds to, each task its program runs (its config agent's, tasks.Task) and each agent it adds, and the MCP servers
    its agents start. '' for an extension that runs neither."""
    agents_conf = conf.get("agents") if isinstance(conf.get("agents"), dict) else {}
    used: dict[str, str] = {}
    roles = [r["role"] for r in e.get("roles") or [] if isinstance(r, dict) and r.get("role")]
    if (e.get("orient") or e.get("replaces")) and "orientation" not in roles:
        roles.append("orientation")
    for role in roles:
        if role == "main":
            used["main"] = "your own settings"
        elif (a := agents_conf.get(CONFIG_AGENT.get(role, ""))) and isinstance(a, dict):
            # what its sessions run under: main's fence's keys for a role thimble runs as main's subagent
            used[role] = _settings_words(userconf.agent_conf(conf, CONFIG_AGENT[role]) if "agents" in conf else a)
    from . import tasks  # noqa: PLC0415 — tasks reads this module

    for r in e.get("tasks") or []:
        if isinstance(r, dict) and r.get("kind") in ("sdk", "command") and r.get("task") in tasks.TASKS:
            spec = tasks.TASKS[r["task"]]
            a = agents_conf.get(spec.agent)
            words = {"network": "on", "data": "ask", **(a if isinstance(a, dict) else {})}
            if not spec.session:  # no thread, so nobody answers what it would ask (harness.claude_argv)
                words.update(web="off" if words.get("web") in (None, "ask") else words["web"],
                             data=None if words.get("data") == "ask" else words["data"])
            used[f"{r['task']} task"] = _settings_words(words)
    root = Path(e["root"]) if e.get("root") else source_path(str(e.get("name") or ""))
    for name in _words(e.get("agents")):
        words = _settings_words(userconf.extension_agent(conf, f"{e.get('name')}:{name}"), data=False)
        if mcp_servers(_subagent_fields(root, e, name)):
            words += ", MCP servers outside the sandbox"
        used[name] = words
    groups: dict[str, list[str]] = {}
    for who, words in used.items():
        groups.setdefault(words, []).append(who)
    return " ".join(f"{' and '.join(who)}: {words}." for words, who in groups.items())


def kernels_wrapped(c: str) -> bool:
    """Whether workspace `c`'s kernels, where an extension's code runs, run inside a sandbox (config.kernel_wrap)."""
    from . import notebook  # noqa: PLC0415

    return config.kernel_wrap(notebook._ws_settings(c)) in config.KERNEL_WRAPPED


def public(c: str) -> dict[str, Any]:
    """Settings' extensions: each one added, whether thimble ships it (`builtin`), whether it runs here and why not, the
    line Settings shows beside it (why not, unless its switch here turned it off), where its switch stands, whether it
    cannot run here whatever the switch says (`locked`), what it gives (`parts`), the settings its agents run under
    (`consent`), whether its code runs in a sandbox (`sandboxed`, None for one with no code), whether Run now can run
    its orientation here once it is on (`orients`, _can_run) and whether Settings offers to run it now (`offer`), and
    its views: each shown here or not, the line Settings shows beside it (`note`), where its switch stands (switched
    here, else as its check says) and whether that switch can change anything (`locked`: the extension does not run
    here or no file here matches the view's claims). Then each extension thimble ships that is not added, off with no
    line, its switch adding it (`addable`), with the settings its agents would run under, whether its code would run in
    a sandbox and the extensions thimble ships that adding it adds with it (`needs`). Then the conflicts among those
    that run, and whether an orientation ran here (`orientation_ran`)."""
    state = read_state(c)
    off = userconf.extensions_off()
    conf = userconf.load_or_defaults(c)[0]
    offers = set(offered(c, state))
    replacing = _replacing(c, state["extensions"])
    ran = _ran(c)
    wrapped = kernels_wrapped(c)
    out = []
    clash = conflicts(state["extensions"])
    for name, e in sorted(state["extensions"].items()):
        vs = [{"slug": v["slug"], "name": _one(v.get("name") or v["slug"]), "shown": bool(v.get("shown")),
               "note": _one(v.get("note")),
               "on": state["shown"].get(_view_key(name, v["slug"]), bool((v.get("fit") or {}).get("fits"))),
               "locked": not e.get("active") or not v.get("here")} for v in _list(e, "views")]
        why = _one(e.get("why"))
        out.append({"name": name, "version": _one(e.get("version")), "description": _one(e.get("description")),
                    "builtin": bool(e.get("builtin")), "active": bool(e.get("active")), "why": why,
                    "note": "" if name in state["off"] else why, "on": name not in state["off"],
                    "locked": bool(config_off(name, off)) or bool(e.get("problems")), "views": vs,
                    "parts": parts(e, _unused(c, name, clash) if e.get("active") else None),
                    "consent": consent({**e, "name": name}, conf), "sandboxed": wrapped if has_code(e) else None,
                    "orients": _can_run(c, name, state["extensions"], replacing, ran), "offer": name in offers})
    absent = dict(not_added())
    for n, v in absent.items():
        if n in state["extensions"]:
            continue
        info = read_extension(builtins()[n], n, set())
        out.append({"name": n, "version": v, "description": info["description"], "builtin": True, "active": False,
                    "why": NOT_ADDED, "note": "", "on": False, "locked": False, "addable": True, "views": [],
                    "parts": parts(info), "consent": consent({**info, "name": n}, conf),
                    "sandboxed": wrapped if has_code(info) else None, "needs": _added_with(n, set(absent)),
                    "orients": orients(info), "offer": False})
    return {"extensions": out, "conflicts": conflict_lines(clash), "orientation_ran": ran[0]}


def _added_with(name: str, absent: set[str]) -> list[str]:
    """The extensions in `absent` (thimble ships them, none added) that adding the shipped extension `name` adds with
    it, however deep its needs go, as `add` adds them."""
    ships = builtins()
    out: list[str] = []
    todo = [name]
    while todo:
        for n in read_extension(ships[todo.pop()], None, set())["needs"]:
            if n in absent and n in ships and n != name and n not in out:
                out.append(n)
                todo.append(n)
    return out


def _unused(c: str, name: str, clash: dict[str, dict[str, list[str]]]) -> dict[str, str]:
    """{role: why} for each role whose change by extension `name` is not used in workspace `c`: another active
    extension replaces the same role, so thimble's own runs, or another's program runs the role, which gets no
    prompt additions or subagents. A task another extension replaces too is `task:<task>`."""
    from . import roles  # noqa: PLC0415

    out: dict[str, str] = {}
    for kind in ("role", "task"):
        for slug, names in clash.get(kind, {}).items():
            if name in names:
                others = [n for n in names if n != name]
                out[slug if kind == "role" else f"task:{slug}"] = \
                    f"{' and '.join(others)} {'replace' if len(others) > 1 else 'replaces'} it too"
    for role in extension_manifest.ROLES:
        if role in out:
            continue
        ag = roles.agent_for(c, role)
        if ag.code and ag.extension != name:
            out[role] = f"{ag.extension}'s program runs {ROLE_NAMES.get(role, 'the ' + role)}"
    return out


def dependents(name: str) -> list[str]:
    """The added extensions that need extension `name`."""
    got = added()
    return sorted(n for n, root in got.items() if n != name and name in read_extension(root, n, set(got)).get("needs", []))


def conflicts_of(infos: list[dict[str, Any]]) -> list[str]:
    """The conflicts (conflict_lines) that the extensions `infos` (read_extension) would have with the other added
    extensions that load, each added one of the same name replaced, as `thimble extension add` names them before it
    asks."""
    names = {i["name"] for i in infos}
    got = added()
    loadable = {}
    for n, root in got.items():
        if n in names:
            continue
        info = read_extension(root, n, set(got) | names)
        if not info["problems"]:
            loadable[n] = {**info, "active": True}
    for info in infos:
        if not info["problems"]:
            loadable[info["name"]] = {**info, "active": True}
    clash = conflicts(loadable)
    return conflict_lines({k: {s: ns for s, ns in m.items() if names & set(ns)} for k, m in clash.items()})


@router.get("/ws/{c}/extensions")
async def list_route(c: str) -> dict[str, Any]:
    """The extensions added, found again for this workspace (refresh), and the workspace's local extension (`local`,
    views.local_extension)."""
    from . import views  # noqa: PLC0415

    config.workspace_dir(c)
    await refresh_quietly(c)
    try:
        local = await asyncio.to_thread(views.local_extension, c)
    except (OSError, ValueError, HTTPException):
        log.exception("%s: the workspace's own views were not listed", c)
        local = None
    return {**await asyncio.to_thread(public, c), "local": local}


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


class OrientBody(BaseModel):
    run: bool


@router.post("/ws/{c}/extensions/{name}/orientation")
async def orientation_route(c: str, name: str, body: OrientBody, request: Request) -> dict[str, Any]:
    """Settings' answer to its offer to run an extension's orientation now: Run now sends its instructions to the
    orientation, or runs its orientation program again with the earlier cards (run_orientation), Not now stops the
    offer until the extension is switched on again. The analyst's browser alone may answer. {status, extensions,
    conflicts, orientation_ran}."""
    from . import hook_auth, orient_session  # noqa: PLC0415

    config.workspace_dir(c)
    if not hook_auth.analyst(request):
        raise HTTPException(403, hook_auth.ANALYST_ONLY)
    e = read_state(c)["extensions"].get(name)
    if e is None:
        raise HTTPException(404, f"no extension {name!r} in this workspace")
    if not e.get("active"):
        raise HTTPException(409, f"{name} does not run here")
    status = "declined"
    if body.run:
        try:
            status = (await run_orientation(c, name))["status"]
        except orient_session.NoOrientation:
            raise HTTPException(409, "No orientation has run here yet. It reads the extension when it starts.") from None
        except (orient_session.Gone, RuntimeError, ValueError) as err:
            raise HTTPException(409, f"{name}'s orientation could not run now: {err}") from None
    else:
        await decline(c, name)
    return {"status": status, **await asyncio.to_thread(public, c)}


@router.post("/ws/{c}/extensions/{name}/add")
async def add_route(c: str, name: str, request: Request) -> dict[str, Any]:
    """Settings' switch turned on for an extension thimble ships that is not added: it is added, as `thimble extension
    add <name>` adds it, with the extensions it needs, and every connected workspace finds its extensions again. The
    analyst's browser alone may add one, and only one thimble ships. {extensions, conflicts, orientation_ran}."""
    from . import cardtypes, hook_auth  # noqa: PLC0415

    config.workspace_dir(c)
    if not hook_auth.analyst(request):
        raise HTTPException(403, hook_auth.ANALYST_ONLY)
    if name not in builtins():
        raise HTTPException(404, f"thimble ships no extension {name!r}")
    if name not in added():
        try:
            await asyncio.to_thread(add, name, yes=True, say=lambda _line: None)
        except AddError as e:
            raise HTTPException(409, str(e)) from None
    await refresh_route()
    await refresh_quietly(c)
    await cardtypes.announce(c)
    return await asyncio.to_thread(public, c)


@router.post("/extensions/refresh")
async def refresh_route() -> dict[str, Any]:
    """`thimble extension add` and `remove`: every workspace a session is connected to finds its extensions again at
    once. {workspaces: {c: [the extensions active there]}}."""
    from . import events  # noqa: PLC0415

    out = {}
    for c in events.connected_workspaces():
        await connected(c)
        out[c] = [e["name"] for e in active(c)]
    return {"workspaces": out}
