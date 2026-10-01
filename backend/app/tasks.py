"""thimble's seven tasks, each a fixed job with one input and one output (TASKS), and how an active extension's
tasks/<task>/task.json changes one: by a prompt, an Agent SDK program (`sdk`) or a command (`command`), as a role's
agent.json does (roles.py). docs/agents.md documents each task's input and output.

Each task is a function from its input to its output: thimble's own implementation (Task.implementation), which
call() runs unless an extension's program replaces the task here (program()). A program runs through harness.py in
the box of the config agent its task names (Task.agent), with the same consent rules and the same deny of server.json
as every agent, and returns the object thimble's own implementation returns. thimble's own is lent to it as
`thimble.default(input)` (default()). call() answers with a model.CallResult either way, so the callers' handling of a
failed or refused call stays one path. The checks task is a session with tools rather than one call, so checks.py
starts its program in an agent chat of its own (harness.start).

The prompt way: each task's prompt is one part of a prompt file under prompts/ (TASK_PROMPTS): the whole file, its
head (the text above its first `## ` section) or one `## ` section. files(c, name) writes the prompt file `name` as the
active extensions change it, into the workspace's registry folder, which a kernel cannot write: a replacement in
place of its task's part, then each addition after that part under its extension's name. The call sites read it
through prompts.custom. In an extension's text `{{default}}` is thimble's own part, `{{default#<section>}}` a `## `
section of the same file, `{{dir}}` the extension's folder and `{{files}}` the files its views and card types cover
here; any other double brace is kept as text.

A replacing prompt and a program each replace the task. Two extensions that replace one task leave it thimble's, and
Settings names both."""
from __future__ import annotations

import importlib
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import config, roles

log = logging.getLogger("thimble.tasks")


@dataclass(frozen=True)
class Task:
    """One of thimble's tasks: its own implementation, `module:function` under app/, an async function (c, input, *,
    model=None, ...) that returns a model.CallResult whose output is the task's output; the agent of thimble's config
    whose sandbox, network, data and env settings a program of the task runs under; and the thimble tools a program
    may call."""

    implementation: str
    agent: str
    tools: tuple[str, ...] = ("read_ref",)
    session: bool = False  # a session with tools rather than one model call


TASKS: dict[str, Task] = {
    "labels": Task("concepts:labels_task", "labels"),
    "label-draft": Task("concepts:draft_task", "labels"),
    "card-check": Task("card_check:check_task", "cardCheck"),
    "view-review": Task("view_review:review_task", "cardCheck"),
    "view-fit": Task("view_fit:fit_task", "labels"),
    "file-viewer": Task("views:file_viewer_task", "dev"),
    "checks": Task("checks:check_task", "checks", ("read_ref", "list_cards", "add_comment"), session=True),
}
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
TASK_FIELDS = ("description", "prompt", "replace", "sdk", "command", "model", "effort")


# --------------------------------------------------------------------------- programs


def _spec(root: Path, task: str) -> dict[str, Any] | None:
    try:
        spec = json.loads((root / "tasks" / task / TASK_JSON).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return spec if isinstance(spec, dict) else None


def code_parts(c: str | None, task: str) -> list[roles.Part]:
    """The task.json of `task` of each active extension in workspace `c` that runs the task with a program (sdk or
    command) whose file is in its folder, as a roles.Part harness.py runs."""
    if not c:
        return []
    from . import extension_manifest, extensions  # noqa: PLC0415 — extensions imports the views module

    out = []
    for e in extensions.active(c):
        root = Path(str(e["src"]))
        spec = _spec(root, task)
        if spec is None or extension_manifest.kind(spec) not in roles.CODE_WAYS:
            continue
        part = roles.Part(str(e["name"]), task, root / "tasks" / task, root, spec,
                          [str(x) for x in e.get("files") or [] if isinstance(x, str)])
        if part.way == "sdk" and (part.path(spec["sdk"]) is None or not part.path(spec["sdk"]).is_file()):
            log.warning("%s: %s's %s task names an SDK program that is not in its folder", c, part.extension, task)
            continue
        if part.way == "command" and not (isinstance(spec["command"], list) and spec["command"]
                                          and all(isinstance(a, str) and a for a in spec["command"])):
            log.warning("%s: %s's %s task's command is not a list of words", c, part.extension, task)
            continue
        out.append(part)
    return out


def replacing(c: str | None, task: str) -> list[str]:
    """The active extensions in workspace `c` that replace `task`: by a program, or by a prompt with `replace`."""
    return [p.extension for p in code_parts(c, task)] + [p.extension for p in parts(c, task) if p.replace]


def program(c: str | None, task: str) -> roles.Part | None:
    """The program that runs `task` in workspace `c` in place of thimble's own: the one extension that replaces the
    task does so with a program. None when thimble's own runs it, or when two extensions replace it."""
    code = code_parts(c, task)
    if not code:
        return None
    if len(replacing(c, task)) > 1:
        log.warning("%s: %s all replace the %s task, so thimble's own runs it", c, " and ".join(replacing(c, task)),
                    task)
        return None
    return code[0]


def _implementation(task: str) -> Any:
    module, _, name = TASKS[task].implementation.partition(":")
    return getattr(importlib.import_module(f"app.{module}"), name)


async def default(c: str, task: str, input: dict[str, Any], *, model: str | None = None,  # noqa: A002
                  **kw: Any) -> Any:
    """thimble's own implementation of `task` on `input`: a model.CallResult (never raises for a failed model call)."""
    return await _implementation(task)(c, input, model=model, **kw)


def output_problem(output: Any, schema: dict[str, Any] | None) -> str:
    """Why a program's output does not fit `schema` (the output thimble's own implementation gives), '' when it does."""
    if schema is None:
        return ""
    import jsonschema  # noqa: PLC0415

    if not isinstance(output, dict):
        return f"{type(output).__name__} where an object is expected"
    err = next(iter(sorted(jsonschema.Draft202012Validator(schema).iter_errors(output), key=lambda e: e.path)), None)
    if err is None:
        return ""
    at = "/".join(str(x) for x in err.absolute_path)
    return f"{err.message}" + (f" at {at}" if at else "")


async def call(c: str, task: str, input: dict[str, Any], *, schema: dict[str, Any] | None = None,  # noqa: A002
               **kw: Any) -> Any:
    """Run `task` on `input` in workspace `c`: the program that replaces it here (program()), else thimble's own with
    `kw`. A model.CallResult: a program's output that fits `schema` is `ok`, and a program that fails, or whose output
    does not fit, is `error` with why in its detail."""
    from . import harness, model  # noqa: PLC0415 — harness imports agent_session's helpers lazily

    part = program(c, task)
    if part is None:
        return await default(c, task, input, **kw)
    who = f"{part.extension}'s {task} program"
    try:
        out = await harness.run_task(c, task, part, input)
    except (harness.HarnessError, RuntimeError, OSError) as e:
        log.warning("%s: %s failed: %s", c, who, e)
        return model.CallResult(status="error", detail=str(e)[:1200], model_requested=who)
    if why := output_problem(out, schema):
        log.warning("%s: %s returned an output thimble cannot use: %s", c, who, why)
        return model.CallResult(status="error", detail=f"{who} returned an output thimble cannot use: {why}",
                                model_requested=who)
    return model.CallResult(status="ok", output=out, model_requested=who, model_used=who)


# --------------------------------------------------------------------------- the prompt way


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
        prompts_replacing = [p for p in found if p.replace]
        others = [p.extension for p in code_parts(c, t)]
        body = default
        if len(prompts_replacing) == 1 and not others:
            body = _fill(prompts_replacing[0].text, prompts_replacing[0], default, whole, slots) or default
        elif prompts_replacing:
            log.warning("%s: %s all replace the %s task, so thimble's own prompt is used", c,
                        " and ".join([*(p.extension for p in prompts_replacing), *others]), t)
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
    """Each task's row in Settings: who runs it here (`way`: thimble, prompt for an extension's prompt in place of
    thimble's, sdk or command), that extension, the extensions that add to its prompt, and the extensions that all
    replace it, in which case thimble's own runs."""
    out = []
    for t in TASKS:
        found = parts(c, t)
        code = code_parts(c, t)
        rep = [*code, *(p for p in found if p.replace)]
        row = {"task": t, "way": "thimble", "extension": "", "additions": [p.extension for p in found if not p.replace],
               "conflict": [p.extension for p in rep] if len(rep) > 1 else []}
        if len(rep) == 1:
            row.update(way=getattr(rep[0], "way", "prompt"), extension=rep[0].extension)
        out.append(row)
    return out
