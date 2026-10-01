"""The files of an extension's folder checked against extension.schema.json, and against the rules a schema cannot
state: which folders are roles and tasks, the one way an agent or task is defined, the files a part names, and the
placeholders its prompts use. check() returns each problem with the file and line it is on; `thimble extension add`
adds nothing while there is one, and Settings names the first.

The folder:

  extension.json            the manifest ($defs/extension)
  views/<name>/             view.json and view.html, with view.py or reader.py
  cards/<name>/             card.json and card.html, with card.py and card.md
  reports/<name>/           report.json and report.md, with report.py, report.html and writer.md; or type.md
  agents/<role>/            agent.json and the files it names, for a role of ROLES
  agents/<name>.md          a subagent of the orientation; agents/orient.md adds to the orientation's instructions
  tasks/<task>/             task.json and the files it names, for a task of TASKS; fixtures/*.json are its test inputs
  checks/<name>/            check.json and check.md
  lib/, sample/             code on every part's path, and a small corpus to try the parts on
"""
from __future__ import annotations

import difflib
import functools
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_FILE = Path(__file__).with_name("extension.schema.json")
MANIFEST = "extension.json"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
ROLES = ("main", "orientation", "critic", "writer", "dev")
TASKS = ("labels", "label-draft", "card-check", "view-review", "view-fit", "file-viewer", "checks")
KINDS = ("prompt", "sdk", "command")
PROMPT_ONLY = {"main": "main takes a prompt addition only"}
PARTS = {"views": ("view", "view.json"), "cards": ("card", "card.json"), "reports": ("report", "report.json"),
         "agents": ("agent", "agent.json"), "tasks": ("task", "task.json"), "checks": ("check", "check.json")}
SET_BY_ANALYST = {"permissionMode": "the permission mode is the analyst's, and an extension cannot set it",
                  "hooks": "hooks are the analyst's, and an extension cannot set them"}
PLACEHOLDER_RE = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")
PLACEHOLDERS = ("default", "dir", "files")  # and default#<heading>
PROMPT_DIRS = ("agents", "tasks")  # whose Markdown files are prompts, as is reports/<name>/writer.md
WALK_SKIPPED = (".git", "__pycache__", "node_modules")


@dataclass(frozen=True)
class Problem:
    file: str  # relative to the extension's folder
    line: int  # 0 when the problem is the file as a whole
    text: str

    def __str__(self) -> str:
        return f"{self.file}:{self.line}  {self.text}" if self.line else f"{self.file}  {self.text}"


@functools.lru_cache(maxsize=1)
def schema() -> dict[str, Any]:
    return json.loads(SCHEMA_FILE.read_text("utf-8"))


def kind(raw: dict[str, Any]) -> str:
    """How an agent.json or task.json defines its role or task: "prompt", "sdk" or "command"; '' for none or several."""
    got = [k for k in KINDS if k in raw]
    return got[0] if len(got) == 1 else ""


def _line(text: str, path: list[Any]) -> int:
    """The line of the key `path` ends at in the JSON `text`, found key by key; 1 for the document itself."""
    pos = 0
    for part in path:
        if isinstance(part, int):
            continue
        m = re.compile(r'"%s"\s*:' % re.escape(str(part))).search(text, pos)
        if not m:
            break
        pos = m.start()
    return text.count("\n", 0, pos) + 1


def _where(path: list[Any]) -> str:
    out = ""
    for p in path:
        out += f"[{p}]" if isinstance(p, int) else (f".{p}" if out else str(p))
    return out


def _known(defn: dict[str, Any]) -> list[str]:
    props = defn.get("properties") or {}
    return [k for k, v in props.items() if not (isinstance(v, dict) and v.get("deprecated"))]


def _unknown(key: str, defn: dict[str, Any]) -> str:
    if key in SET_BY_ANALYST:
        return SET_BY_ANALYST[key]
    near = difflib.get_close_matches(key, _known(defn), n=1, cutoff=0.6)
    return f'unknown key "{key}".' + (f' Did you mean "{near[0]}"?' if near else "")


def _say(err: Any) -> list[tuple[list[Any], str]]:
    """A jsonschema error in words: [(the path it is at, the words)]."""
    path = list(err.absolute_path)
    key = next((p for p in reversed(path) if isinstance(p, str)), "")
    what = f'"{_where(path)}"' if path else "it"
    v = err.validator
    if v == "additionalProperties" and isinstance(err.instance, dict):
        props = err.schema.get("properties") or {}
        return [(path + [k], _unknown(k, err.schema)) for k in err.instance if k not in props]
    if v == "required" and isinstance(err.instance, dict):
        return [(path, f'needs "{k}"') for k in err.validator_value if k not in err.instance]
    if v == "oneOf" and key == "unit":
        return [(path, '"unit" is "file", {"name", "path"} or {"name", "field", "bin"}')]
    if v == "oneOf" and not path:
        return []  # the way an agent or task is defined, said by _kind_problems
    if v == "pattern" and (key == "name" or err.schema.get("pattern") == schema()["$defs"]["name"]["pattern"]):
        return [(path, f"{what} is {err.instance!r}, which is no name thimble can use (lower-case letters, digits "
                       f"and hyphens)")]
    if v == "type":
        want = err.validator_value if isinstance(err.validator_value, str) else " or ".join(err.validator_value)
        word = {"array": "a list", "object": "an object", "string": "text", "boolean": "true or false",
                "integer": "a whole number", "number": "a number"}.get(want, want)
        return [(path, f"{what} must be {word}")]
    if v in ("enum", "const"):
        allowed = err.validator_value if v == "enum" else [err.validator_value]
        return [(path, f"{what} is {json.dumps(err.instance)}. It takes {', '.join(json.dumps(x) for x in allowed)}")]
    if v in ("minLength", "minItems"):
        return [(path, f"{what} is empty")]
    return [(path, f"{what}: {err.message}")]


def _validate(raw: Any, text: str, rel: str, defn: str) -> list[Problem]:
    """`raw`, the JSON of file `rel`, checked against $defs/<defn>."""
    try:
        from jsonschema import Draft202012Validator  # noqa: PLC0415
    except ImportError:
        return _validate_plainly(raw, text, rel, defn)
    full = schema()
    validator = Draft202012Validator({"$defs": full["$defs"], "$ref": f"#/$defs/{defn}"})
    out: list[Problem] = []
    for err in sorted(validator.iter_errors(raw), key=lambda e: [str(p) for p in e.absolute_path]):
        for path, words in _say(err):
            out.append(Problem(rel, _line(text, path), words))
    return list(dict.fromkeys(out))


def _validate_plainly(raw: Any, text: str, rel: str, defn: str) -> list[Problem]:
    """Without jsonschema: the keys of the top object, known and required."""
    d = schema()["$defs"][defn]
    if not isinstance(raw, dict):
        return [Problem(rel, 1, "must be a JSON object")]
    out = [Problem(rel, _line(text, [k]), _unknown(k, d)) for k in raw if k not in (d.get("properties") or {})]
    return out + [Problem(rel, 1, f'needs "{k}"') for k in d.get("required") or [] if k not in raw]


def _load(root: Path, rel: str) -> tuple[Any, str, list[Problem]]:
    """(the JSON, its text, the problems reading it) of file `rel` of the folder."""
    try:
        text = (root / rel).read_text("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        return None, "", [Problem(rel, 0, f"cannot be read: {type(e).__name__}")]
    try:
        raw = json.loads(text)
    except ValueError as e:
        return None, text, [Problem(rel, getattr(e, "lineno", 0), f"is not JSON: {getattr(e, 'msg', e)}")]
    if not isinstance(raw, dict):
        return None, text, [Problem(rel, 1, "must be a JSON object")]
    return raw, text, []


def _own(root: Path, part: Path, name: Any) -> bool:
    """Whether `name` is a file inside the part's folder `part`, by a relative path that stays in the extension."""
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        return False
    try:
        (part / name).resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return (part / name).is_file()


def _subdirs(d: Path) -> list[Path]:
    try:
        return sorted(x for x in d.iterdir() if x.is_dir() and not x.name.startswith((".", "_")))
    except OSError:
        return []


def _kind_problems(root: Path, part: Path, rel: str, raw: dict[str, Any], text: str, role: str = "") -> list[Problem]:
    """The one way an agent.json or task.json defines its role or task, and the files it names."""
    out: list[Problem] = []
    got = [k for k in KINDS if k in raw]
    if not got:
        return [Problem(rel, 1, "needs one of prompt, sdk or command")]
    if len(got) > 1:
        return [Problem(rel, _line(text, [got[1]]), f"takes one of prompt, sdk or command, and it has {' and '.join(got)}")]
    way = got[0]
    if way != "prompt":
        for k in ("replace", "subagents"):
            if k in raw:
                out.append(Problem(rel, _line(text, [k]), f'"{k}" goes with prompt, and this has {way}'))
    if role in PROMPT_ONLY and way != "prompt":
        out.append(Problem(rel, _line(text, [way]), PROMPT_ONLY[role]))
    if role == "main" and raw.get("replace") is True:
        out.append(Problem(rel, _line(text, ["replace"]), PROMPT_ONLY["main"] + ", so it cannot set replace"))
    if role == "main" and raw.get("subagents"):
        out.append(Problem(rel, _line(text, ["subagents"]), PROMPT_ONLY["main"] + ", so it cannot add subagents"))
    if way in ("prompt", "sdk") and isinstance(raw.get(way), str) and not _own(root, part, raw[way]):
        out.append(Problem(rel, _line(text, [way]), f'names {raw[way]!r}, which is not a file of {part.relative_to(root)}'))
    if way == "prompt" and isinstance(raw.get("prompt"), str) and not raw["prompt"].endswith(".md"):
        out.append(Problem(rel, _line(text, ["prompt"]), "names a prompt that is not a Markdown (.md) file"))
    if way == "sdk" and isinstance(raw.get("sdk"), str) and not raw["sdk"].endswith(".py"):
        out.append(Problem(rel, _line(text, ["sdk"]), "names an SDK program that is not a Python (.py) file"))
    subs = raw.get("subagents") if isinstance(raw.get("subagents"), dict) else {}
    for name, sub in subs.items():
        p = sub.get("prompt") if isinstance(sub, dict) else None
        if isinstance(p, str) and not _own(root, part, p):
            out.append(Problem(rel, _line(text, ["subagents", name, "prompt"]),
                               f'the subagent "{name}" names {p!r}, which is not a file of {part.relative_to(root)}'))
    return out


def _of_program(root: Path, f: Path) -> bool:
    """Whether `f` lies in the folder of a role or task whose agent.json or task.json runs a program, whose Markdown
    is the program's own text rather than a prompt thimble fills."""
    rel = f.relative_to(root).parts
    if len(rel) < 3:
        return False
    spec = root / rel[0] / rel[1] / ("agent.json" if rel[0] == "agents" else "task.json")
    try:
        raw = json.loads(spec.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(raw, dict) and kind(raw) in ("sdk", "command")


def _placeholders(root: Path, f: Path) -> list[Problem]:
    try:
        text = f.read_text("utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    out = []
    for m in PLACEHOLDER_RE.finditer(text):
        word = m.group(1)
        if word in PLACEHOLDERS or (word.startswith("default#") and word[len("default#"):].strip()):
            continue
        out.append(Problem(str(f.relative_to(root)), text.count("\n", 0, m.start()) + 1,
                           f"{{{{{word}}}}} is no placeholder. They are {{{{default}}}}, {{{{default#<heading>}}}}, "
                           f"{{{{dir}}}} and {{{{files}}}}"))
    return out


def _name_problem(rel: str, name: str, what: str) -> list[Problem]:
    if NAME_RE.match(name):
        return []
    return [Problem(rel, 0, f"{what} {name!r} is no name thimble can use (lower-case letters, digits and hyphens)")]


def _links_out(root: Path) -> list[Problem]:
    """Each link in the folder that leads outside it."""
    top = root.resolve()
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(n for n in dirnames if n not in WALK_SKIPPED)
        for n in sorted([*dirnames, *filenames]):
            p = Path(dirpath, n)
            if p.is_symlink() and not p.resolve().is_relative_to(top):
                out.append(Problem(str(p.relative_to(root)), 0, "is a link to a file outside the extension's folder"))
    return out


def check(root: Path, expect: str | None = None) -> list[Problem]:
    """Every problem of the extension in folder `root`: links that lead outside it, its JSON files against the schema,
    the folders of its parts, the files they name and the placeholders of its prompts. `expect` is the name its folder
    gives it."""
    root = Path(root)
    if not (root / MANIFEST).is_file():
        return [Problem(MANIFEST, 0, "is missing")]
    links = _links_out(root)
    if links:
        return links
    raw, text, out = _load(root, MANIFEST)
    scope = None
    if raw is not None:
        out += _validate(raw, text, MANIFEST, "extension")
        if expect and isinstance(raw.get("name"), str) and raw["name"] != expect:
            out.append(Problem(MANIFEST, _line(text, ["name"]), f'names it "{raw["name"]}", and its folder is "{expect}"'))
        if "needs" in raw and "dependencies" in raw:
            out.append(Problem(MANIFEST, _line(text, ["dependencies"]), 'has both "needs" and "dependencies". Keep needs'))
        scope = raw.get("scope") or None
    for folder, (defn, file) in PARTS.items():
        base = root / folder
        if not base.is_dir():
            continue
        for d in _subdirs(base):
            rel_dir = f"{folder}/{d.name}"
            if folder == "agents" and d.name not in ROLES:
                out.append(Problem(rel_dir, 0, f"is no role. The roles are {', '.join(ROLES)}"))
                continue
            if folder == "tasks" and d.name not in TASKS:
                out.append(Problem(rel_dir, 0, f"is no task. The tasks are {', '.join(TASKS)}"))
                continue
            out += _name_problem(rel_dir, d.name, "the folder")
            out += _part(root, d, folder, defn, file, scope)
    if (root / "agents").is_dir():
        for f in sorted((root / "agents").glob("*.md")):
            out += _name_problem(f"agents/{f.name}", f.stem, "the subagent")
    for folder in PROMPT_DIRS:
        for f in sorted((root / folder).rglob("*.md")) if (root / folder).is_dir() else []:
            if not _of_program(root, f):
                out += _placeholders(root, f)
    for f in sorted((root / "reports").glob("*/writer.md")) if (root / "reports").is_dir() else []:
        out += _placeholders(root, f)
    return out


def _part(root: Path, d: Path, folder: str, defn: str, file: str, scope: Any) -> list[Problem]:
    rel = f"{folder}/{d.name}/{file}"
    if folder == "reports" and not (d / file).is_file():
        if (d / "type.md").is_file():
            return []
        return [Problem(f"{folder}/{d.name}", 0, f"needs {file} and report.md")]
    if not (d / file).is_file():
        return [Problem(f"{folder}/{d.name}", 0, f"needs {file}")]
    raw, text, out = _load(root, rel)
    if raw is None:
        return out
    out += _validate(raw, text, rel, defn)
    page = {"views": "view.html", "cards": "card.html", "reports": "report.md", "checks": "check.md"}.get(folder)
    if page and not (d / page).is_file():
        out.append(Problem(f"{folder}/{d.name}", 0, f"needs {page}"))
    if folder == "views":
        if not (raw.get("description") or raw.get("why")):
            out.append(Problem(rel, 1, 'needs "description"'))
        if not (raw.get("scope") or raw.get("claims") or scope):
            out.append(Problem(rel, 1, 'needs "scope", since extension.json sets none'))
    elif folder == "cards":
        if not (raw.get("description") or raw.get("use")):
            out.append(Problem(rel, 1, 'needs "description"'))
        if "example" not in raw and "use" not in raw:
            out.append(Problem(rel, 1, 'needs "example"'))
    elif folder in ("agents", "tasks"):
        out += _kind_problems(root, d, rel, raw, text, d.name if folder == "agents" else "")
        if folder == "tasks" and (d / "fixtures").is_dir():
            for f in sorted((d / "fixtures").glob("*.json")):
                out += _load(root, str(f.relative_to(root)))[2]
    return out
