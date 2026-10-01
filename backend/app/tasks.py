"""Extensions' changes to thimble's seven tasks by the prompt way: tasks/<task>/task.json with `prompt`, and `replace`,
in an active extension (extensions._tasks). Each task's prompt is one part of a prompt file under prompts/
(TASK_PROMPTS): the whole file, its head (the text above its first `## ` section) or one `## ` section. files(c,
name) writes the prompt file `name` as the active extensions change it, into the workspace's registry folder, which
a kernel cannot write: a replacement in place of its task's part, then each addition after that part under its
extension's name. The call sites read it through prompts.custom. In an extension's text `{{default}}` is thimble's own
part, `{{default#<section>}}` a `## ` section of the same file, `{{dir}}` the extension's folder and `{{files}}` the
files its views and card types cover here; any other double brace is kept as text. Two extensions that replace one task leave it thimble's. A task's SDK program or command is
read but not run (extensions.NOT_RUN)."""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import config, roles

log = logging.getLogger("thimble.tasks")

WHOLE, HEAD = "", "^"  # a task's part of its prompt file: the whole file, or the text above its first `## ` section
TASK_PROMPTS = {
    "labels": ("labels", HEAD),
    "label-draft": ("labels", "draft"),
    "card-check": ("card-check", "check"),
    "view-review": ("view-review", "review"),
    "view-fit": ("view-fit", WHOLE),
    "file-viewer": ("file-viewer", "suggest"),
    "checks": ("check", WHOLE),
}
TASK_JSON = "task.json"
PROMPTS_DIR = "prompts"  # in the workspace's registry folder
SECTION_RE = re.compile(r"^## (.+?)[ \t]*$", re.M)
PLACEHOLDER_RE = re.compile(r"\{\{default(?:#([^}\n]+))?\}\}|\{\{dir\}\}|\{\{files\}\}")


@dataclass
class TaskPart:
    """One active extension's prompt for one task."""

    extension: str
    task: str
    root: Path
    text: str
    replace: bool
    files: list[str]


def parts(c: str | None, task: str) -> list[TaskPart]:
    """The prompt-way task.json of `task` of each active extension in workspace `c` whose prompt file is in its folder."""
    if not c:
        return []
    from . import extensions  # noqa: PLC0415 — extensions imports the views module

    out = []
    for e in extensions.active(c):
        root = Path(str(e["src"]))
        folder = root / "tasks" / task
        try:
            spec = json.loads((folder / TASK_JSON).read_text("utf-8"))
        except (OSError, ValueError):
            continue
        rel = spec.get("prompt") if isinstance(spec, dict) else None
        if not isinstance(rel, str) or not rel.strip():
            continue
        p = (folder / rel.strip()).resolve()
        if not p.is_relative_to(root.resolve()) or not p.is_file():
            log.warning("%s: %s's %s task names a prompt that is not in its folder", c, e["name"], task)
            continue
        try:
            text = p.read_text("utf-8").strip()
        except OSError:
            continue
        out.append(TaskPart(str(e["name"]), task, root, text, spec.get("replace") is True,
                            [str(x) for x in e.get("files") or [] if isinstance(x, str)]))
    return out


def _span(text: str, part: str) -> tuple[int, int] | None:
    """Where a task's part stands in its prompt file's text: the whole text, the head, or a `## ` section's body."""
    marks = list(SECTION_RE.finditer(text))
    if part == WHOLE:
        front = roles.FRONT_RE.match(text)
        return front.end() if front else 0, len(text)
    if part == HEAD:
        return 0, marks[0].start() if marks else len(text)
    for i, m in enumerate(marks):
        if m.group(1).strip() == part:
            return m.end(), marks[i + 1].start() if i + 1 < len(marks) else len(text)
    return None


def _fill(text: str, part: TaskPart, default: str, whole: str, slots: set[str]) -> str:
    """An extension's prompt text with its placeholders filled, thimble's slots kept for prompts.render and every other
    double brace of the extension's text kept as text."""
    def value(m: re.Match[str]) -> str:
        if m.group(0) == "{{dir}}":
            return roles._literal(str(part.root))
        if m.group(0) == "{{files}}":
            return roles._literal(", ".join(f"`{x}`" for x in part.files) or "(none)")
        heading = (m.group(1) or "").strip()
        if not heading:
            return default
        got = _span(whole, heading)
        return whole[got[0]:got[1]].strip() if got and heading not in (WHOLE, HEAD) else ""

    out, at = [], 0
    for m in PLACEHOLDER_RE.finditer(text):
        out += [roles._keep_slots(text[at:m.start()], slots), value(m)]
        at = m.end()
    return "".join([*out, roles._keep_slots(text[at:], slots)])


def text_of(c: str | None, name: str) -> str | None:
    """The prompt file `name` as the active extensions change its tasks' parts; None when none changes them."""
    from . import prompts  # noqa: PLC0415

    tasks = [t for t, (f, _) in TASK_PROMPTS.items() if f == name]
    changes = {t: parts(c, t) for t in tasks}
    if not any(changes.values()):
        return None
    whole = prompts.load(name)
    text = whole
    slots = set(roles.SLOT_RE.findall(whole))
    # the later parts first, so the earlier ones' offsets stay
    order = sorted(tasks, key=lambda t: (_span(whole, TASK_PROMPTS[t][1]) or (-1, -1))[0], reverse=True)
    for t in order:
        span = _span(text, TASK_PROMPTS[t][1])
        found = changes[t]
        if span is None or not found:
            continue
        a, b = span
        default = text[a:b].strip()
        replacing = [p for p in found if p.replace]
        body = default
        if len(replacing) == 1:
            body = _fill(replacing[0].text, replacing[0], default, whole, slots) or default
        elif len(replacing) > 1:
            log.warning("%s: %s all replace the %s task's prompt, so thimble's own is used", c,
                        " and ".join(p.extension for p in replacing), t)
        added = [f"{roles.ADDED_HEADING.format(name=p.extension).replace('## ', '#### ')}\n\n{_fill(p.text, p, default, whole, slots)}"
                 for p in found if not p.replace]
        if added:
            body = "\n\n".join([body, *added])
        lead = "\n\n" if TASK_PROMPTS[t][1] not in (WHOLE, HEAD) else ""
        text = f"{text[:a]}{lead}{body}\n\n{text[b:].lstrip()}" if text[b:].strip() else f"{text[:a]}{lead}{body}\n"
    return text


def files(c: str | None, name: str) -> dict[str, Path]:
    """{name: the file that replaces it} for prompts.custom, when the active extensions change the tasks of the prompt
    file `name`; {} otherwise, or when the change cannot be made."""
    if not c:
        return {}
    try:
        text = text_of(c, name)
    except Exception:  # noqa: BLE001 — an extension's broken prompt leaves the task on thimble's own
        log.exception("%s: the %s prompt of the active extensions could not be made", c, name)
        return {}
    if text is None:
        return {}
    folder = config.registry_dir(c) / PROMPTS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / f"{name}.md"
    if not p.is_file() or p.read_text("utf-8") != text:
        p.write_text(text, "utf-8")
    return {name: p}


def public(c: str | None) -> list[dict[str, Any]]:
    """Per task an extension changes here: {task, additions, replacing, conflict}, for Settings."""
    out = []
    for t in TASK_PROMPTS:
        found = parts(c, t)
        if not found:
            continue
        rep = [p.extension for p in found if p.replace]
        out.append({"task": t, "additions": [p.extension for p in found if not p.replace],
                    "replacing": rep[0] if len(rep) == 1 else "", "conflict": rep if len(rep) > 1 else []})
    return out
