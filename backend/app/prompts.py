"""Prompt assembly: read a file under prompts/, paste in the files its {{include:...}} directives name, and fill its
{{slot}}s. Every model-facing sentence lives under prompts/ or plugin/; this module adds no prose of its own.

Files are read fresh from disk on every call, so a hand edit takes effect at once. An unknown directive, an unfilled
slot, or a stray '{{' or '}}' raises PromptError naming the file, so nothing malformed reaches a model.

Flags. A prompt can hold text that only some renderings keep:
- `{{if:<flag>}}…{{end}}` keeps its text only while the flag is on. A block stays inside one file and holds no other
  block. A marker alone on its line takes the line with it, so a block of whole lines leaves no blank line.
- A section `## <name>@<flag>` replaces the body of `## <name>` while the flag is on, in place, and is left out
  otherwise. With no `## <name>` in the file, it is `## <name>` while the flag is on, and absent otherwise.
The flags (FLAGS) are of two kinds. The feature flags, `labels` and `checks` (features.flags), keep the guidance of a
feature the analyst has on, so the guide leaves out the guidance of one they turned off. The build targets, `term-page`
and `html-page`, say which page a view build makes (view.term.js or view.html), so the view prompts and the view tools
tell the builder; at most one of them holds.
The flags are the call's `flags`, else the ones a `rendering` block sets, else DEFAULT_FLAGS (every feature on). A set of
flags is exact: a feature flag it leaves out is off. A target that none of them names is the session's (current_target:
`term-page` while the session's transport is local, `html-page` after the press and where no session is found, as in
the server), looked up only for a file that has a target block or section.
0.8.0's modes are gone. A `{{if:browser}}` or `{{if:terminal}}` block, or a `@browser` or `@terminal` section, is a load
error, except in LEGACY_TARGET_FILES, the view prompts, where those names stand for `html-page` and `term-page` until
their blocks are renamed. A caller that still passes a mode name ("browser", "terminal") as its flags gets every
feature on and that mode's target (LEGACY_MODES).
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import os
import re
from collections.abc import Iterable, Iterator
from pathlib import Path

from . import capture

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Where the prompt files live. THIMBLE_PROMPTS_DIR overrides it (tests point it at fixtures) and is read again on every
# call, so a monkeypatched environment works without reloading this module.
PROMPTS_DIR = Path(os.environ.get("THIMBLE_PROMPTS_DIR") or REPO_ROOT / "prompts").resolve()

# The files a model call sends as they are rendered: main (the analyst session's system-prompt append), shared (rules
# main's and the orientation's prompts include), tools, dev, labels (the label classifier's system prompt), context
# (what the context engine renders for writers, checks and critiques), card-check (card_check.py's calls), view-review
# (the view reviewer's registered prompt, its `review` section), dev-view-review (a review run's prompt), dev-view-task
# (a view build's prompt), dev-view-repair (what a repair's builder gets besides it), dev-view-change (a change to a
# view, sent to its builder), dev-ticket-task (a code ticket's agent's prompt), file-viewer (the proposal of a viewer for
# a file type, views.suggest) and view-fit (whether an extension's view fits a corpus, view_fit.py).
PROMPT_NAMES = ("main", "shared", "tools", "dev", "labels", "context", "card-check", "view-review", "dev-view-review",
                "dev-view-task", "dev-view-repair", "dev-view-change", "dev-ticket-task", "file-viewer", "view-fit")
# Agent definitions, in a plugin agent's form, that Claude Code gets with --agents instead of from plugin/agents/, where
# main would also see them: the writer, the orientation, the critic and the report check. orient.md's body is a template
# the server renders before Claude Code gets it (orient_session.system_prompt).
AGENT_FILES = ("writer", "orient", "critic", "check")
# A report check's built-ins, prompts/checks/<id>.md, each its name and colour as frontmatter and its prompt as the
# body, which a run of the check sends as the check's instructions (checks.builtin).
CHECKS_DIR = "checks"
# The document presets the Report tab's + New and start_writing offer, prompts/types/<id>.md: name and description as
# frontmatter, the type's text as the body (report_types.presets, type_form).
TYPES_DIR = "types"
# Each document form's text, what read_ref("type:<name>") returns to the writer agent (report_types.type_form).
TYPE_FILES = {"document": "report-markdown", "slides": "report-slides", "story": "report-story", "custom": "report-custom",
              "video": "report-video"}
# The dev calls: dev.md is the preamble every dev call reads, ending in `{{task}}`, filled with the call's own body
# file: a code ticket's agent's registered prompt (dev-ticket), the server-down fix (dev-fix) or the view builder's
# registered prompt (dev-view).
DEV_PROMPT = "dev"
DEV_FILES = ("dev-ticket", "dev-fix", "dev-view")

# The whole directive grammar: {{include:<relpath>}} or {{<slot>}} with slot = [a-z_][a-z0-9_]*. Anything else inside
# {{...}}, such as a mistyped slot or stray spaces, fails loudly instead of reaching a model half-filled.
_DIRECTIVE_RE = re.compile(r"\{\{(.*?)\}\}", re.DOTALL)
_SLOT_RE = re.compile(r"[a-z_][a-z0-9_]*\Z")
_INCLUDE_PREFIX = "include:"
_PART_RE = re.compile(r"^## (.+?)[ \t]*$", re.M)

# The flags a prompt renders with (module note): the feature flags, then the view build targets.
FEATURE_FLAGS = ("labels", "checks")
TERM_PAGE, HTML_PAGE = TARGETS = ("term-page", "html-page")
FLAGS = (*FEATURE_FLAGS, *TARGETS)
DEFAULT_FLAGS = frozenset(FEATURE_FLAGS)  # the flags of a call that names none, outside a `rendering` block
# 0.8.0's mode names, as the target each stands for: in LEGACY_TARGET_FILES' blocks, and as a caller's flags
LEGACY_MODES = {"browser": HTML_PAGE, "terminal": TERM_PAGE}
MODES = tuple(LEGACY_MODES)  # the names 0.8.0's callers passed as a mode, still taken as flags (module note)
# the view prompts, whose 0.8.0 mode blocks still name their targets until the features lane renames them (module note)
LEGACY_TARGET_FILES = frozenset({"dev-view.md", "view-review.md", "dev-view-task.md", "view-propose.md"})
# A block's markers, {{if:<flag>}} and {{end}}. They are read before includes and slots, so `end` is never a slot.
_BLOCK_RE = re.compile(r"\{\{(?:if:([^{}]*)|(end))\}\}")
# A section heading that holds a flag's text: `<name>@<flag>` (a legacy mode name among them, refused outside
# LEGACY_TARGET_FILES), and a test for one anywhere in a text.
_FLAG_NAMES = (*FLAGS, *LEGACY_MODES)
_FLAG_PART_RE = re.compile(rf"(.+?)@({'|'.join(map(re.escape, _FLAG_NAMES))})")
_HAS_FLAG_PART_RE = re.compile(rf"^## .+@(?:{'|'.join(map(re.escape, _FLAG_NAMES))})[ \t]*$", re.M)
# Sections that a merge of 0.8.0's mode branches renamed, by the name code still knows them by, as (file, old name) ->
# new name: section() finds them under either name. events.EVENTS_SECTION names main.md's events section by its 0.8.0
# browser-mode heading.
_RENAMED = {("main.md", "Events from the browser"): "Events from thimble"}


class PromptError(ValueError):
    """A prompt file is missing, its includes form a cycle, or it holds an unknown {{...}} directive, an unknown flag,
    an unfilled slot or one of 0.8.0's mode blocks. The message names the file and the slot, include or flag."""


# The flags of the calls made inside `rendering` that name none.
_rendering: contextvars.ContextVar[frozenset[str] | None] = contextvars.ContextVar("prompt_flags", default=None)

Flags = "str | Iterable[str] | None"


def _check_flags(flags: "str | Iterable[str]", where: str) -> frozenset[str]:
    """`flags` as a set of FLAGS; a legacy mode name (LEGACY_MODES) as every feature on and its target. PromptError for
    a flag it does not know, a plain string that is no mode name, or both targets."""
    if isinstance(flags, str):
        if flags not in LEGACY_MODES:
            raise PromptError(f"{where}: flags are a set of {', '.join(FLAGS)}, not the string {flags!r}")
        return DEFAULT_FLAGS | {LEGACY_MODES[flags]}
    got = frozenset(flags)
    if bad := sorted(got - set(FLAGS)):
        raise PromptError(f"{where}: unknown flag {', '.join(map(repr, bad))} (one of {', '.join(FLAGS)})")
    if len(got & set(TARGETS)) > 1:
        raise PromptError(f"{where}: a rendering builds one page, so it names at most one of {', '.join(TARGETS)}")
    return got


@contextlib.contextmanager
def rendering(flags: "str | Iterable[str]") -> Iterator[None]:
    """Within the block, prompts render with `flags` unless a call names its own (module note): the guide with the
    feature flags of the analyst's switches (features.flags), a view build with its target among them."""
    token = _rendering.set(_check_flags(flags, "prompts.rendering"))
    try:
        yield
    finally:
        _rendering.reset(token)


def current_flags(flags: Flags = None) -> frozenset[str]:
    """The flags a prompt renders with, its target left out unless named: `flags` when given, else the `rendering`
    block's, else DEFAULT_FLAGS."""
    if flags is not None:
        return _check_flags(flags, "prompts")
    block = _rendering.get()
    return DEFAULT_FLAGS if block is None else block


def session_target(cwd: str | None = None) -> str:
    """The build target of the session this process belongs to (module note): `term-page` when the workspace of `cwd`
    (default: this process's folder), else of THIMBLE_WS, has a launch.json whose transport is local (a legacy
    `mode: terminal` counts as local), else `html-page`. The server's folder is no corpus, so the server is always on
    `html-page`."""
    try:
        from . import config  # noqa: PLC0415 — read only for a file that has a target block

        here = cwd if cwd is not None else os.getcwd()
        c = config.workspace_for_cwd(here) or config.workspace_for_folder(here)
        ws = config.workspace_path(c) if c else None
    except (OSError, ValueError, RuntimeError, KeyError):
        ws = None
    found: list[Path] = [ws] if ws is not None else []
    named = os.environ.get("THIMBLE_WS", "").strip()
    if named and os.path.isabs(named):
        found.append(Path(named))
    for folder in found:
        try:
            rec = json.loads((folder / "trusted" / "launch.json").read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(rec, dict):
            continue
        transport = rec.get("transport") or {"terminal": "local", "browser": "server"}.get(str(rec.get("mode")))
        return TERM_PAGE if transport == "local" else HTML_PAGE
    return HTML_PAGE


def current_target(flags: Flags = None) -> str:
    """The build target a prompt renders for: the one current_flags names, else the session's (session_target)."""
    named = current_flags(flags) & set(TARGETS)
    return next(iter(named)) if named else session_target()


class _Flags:
    """The flags of one load, its target found on first use, so a file with no target block never looks it up."""

    def __init__(self, given: Flags) -> None:
        self.flags = current_flags(given)
        self.target: str | None = next(iter(self.flags & set(TARGETS)), None)

    def has(self, flag: str) -> bool:
        if flag in TARGETS:
            if self.target is None:
                self.target = session_target()
            return self.target == flag
        return flag in self.flags


def _flag(name: str, rel: str) -> str:
    """The flag a block or a section names in the file `rel`: one of FLAGS, or in LEGACY_TARGET_FILES a legacy mode
    name as its target. PromptError otherwise."""
    if name in FLAGS:
        return name
    if name in LEGACY_MODES:
        if rel in LEGACY_TARGET_FILES:
            return LEGACY_MODES[name]
        raise PromptError(f"{rel}: {name!r} is one of 0.8.0's modes, which are gone; a block names one of "
                          f"{', '.join(FLAGS)} (module note)")
    raise PromptError(f"{rel}: unknown flag {name!r} (one of {', '.join(FLAGS)})")


def _blocks_out(text: str, rel: str, flags: _Flags) -> str:
    """`text` with each flag block's text kept while its flag is on and left out otherwise, and its markers taken out.
    A marker alone on its line takes the line with it. PromptError for an unknown flag, a block inside a block, an
    `{{end}}` with no block open, or a block left open."""
    marks = [*_BLOCK_RE.finditer(text)]
    if not marks:
        return text
    spans: list[tuple[int, int, str | None]] = []  # (start, end, the flag a marker opens, None for an {{end}})
    opened: str | None = None
    for m in marks:
        if m.group(2):
            if opened is None:
                raise PromptError(f"{rel}: {{{{end}}}} with no {{{{if:<flag>}}}} block open")
            opened, opens = None, None
        else:
            if opened is not None:
                raise PromptError(f"{rel}: {{{{if:{m.group(1)}}}}} inside the {{{{if:{opened}}}}} block; close each "
                                  "block with {{end}} before the next one opens")
            opens = _flag(m.group(1), rel)
            opened = m.group(1)
        start, end = m.start(), m.end()
        line_start = text.rfind("\n", 0, start) + 1
        line_end = text.find("\n", end)
        line_end = len(text) if line_end == -1 else line_end
        if not text[line_start:start].strip() and not text[end:line_end].strip():
            start, end = line_start, min(line_end + 1, len(text))
        spans.append((start, end, opens))
    if opened is not None:
        raise PromptError(f"{rel}: the {{{{if:{opened}}}}} block is not closed with {{{{end}}}}")
    out: list[str] = []
    last, keep = 0, True
    for start, end, opens in spans:
        if keep:
            out.append(text[last:start])
        keep = opens is None or flags.has(opens)
        last = end
    out.append(text[last:])
    return "".join(out)


def _parts(text: str) -> tuple[str, list[tuple[str, str, str]]]:
    """(the text above the first `## ` heading, and each section as (its name, its heading line, its body))."""
    marks = [*_PART_RE.finditer(text)]
    parts = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body_at = min(m.end() + 1, end)  # past the heading line's newline
        parts.append((m.group(1).strip(), text[m.start():body_at], text[body_at:end]))
    return (text[:marks[0].start()] if marks else text), parts


def _flag_sections(text: str, rel: str, flags: _Flags) -> str:
    """`text` with each `## <name>@<flag>` section's body in place of the body of `## <name>` while the flag is on, and
    the section left out otherwise (module note). PromptError for two sections of one name that are both on, or a
    section of a legacy mode name outside LEGACY_TARGET_FILES."""
    if not _HAS_FLAG_PART_RE.search(text):
        return text
    head, parts = _parts(text)
    names = {name for name, _, _ in parts}
    own: dict[str, str] = {}  # a section's name -> the body the flags give it
    for name, _, body in parts:
        if (hit := _FLAG_PART_RE.fullmatch(name)) and flags.has(_flag(hit.group(2), rel)):
            if hit.group(1) in own:
                raise PromptError(f"{rel}: two sections of '## {hit.group(1)}' hold for these flags")
            own[hit.group(1)] = body
    out = [head]
    for name, line, body in parts:
        hit = _FLAG_PART_RE.fullmatch(name)
        if hit is None:
            # the flag's body, with the blank lines the section's own body ended in, so the next heading keeps its gap
            out.append(line + (own[name].rstrip("\n") + body[len(body.rstrip("\n")):] if name in own else body))
        elif flags.has(_flag(hit.group(2), rel)) and hit.group(1) not in names:
            out.append(f"## {hit.group(1)}\n{body}")
    return "".join(out)


def _dir() -> Path:
    env = os.environ.get("THIMBLE_PROMPTS_DIR")
    return Path(env).resolve() if env else PROMPTS_DIR


def _norm(name: str) -> str:
    """A prompt name or include path as a file path relative to the prompts directory, with '.md' added when absent."""
    rel = name if name.endswith(".md") else name + ".md"
    parts = Path(rel).parts
    if Path(rel).is_absolute() or ".." in parts or not parts:
        raise PromptError(f"prompt path {name!r} must be relative to the prompts directory and stay inside it")
    return rel


# The files that replace prompt files in the calls made inside `custom`, by the prompt file's path.
_custom: contextvars.ContextVar[dict[str, Path]] = contextvars.ContextVar("custom_prompts", default={})


@contextlib.contextmanager
def custom(files: dict[str, Path]) -> Iterator[None]:
    """Within the block, each prompt file named in `files` ({name: path}) is read from its path instead, whenever it is
    loaded itself rather than included: an agent's `prompt` in thimble's config (userconf.prompt_files). The file is
    filled in as the one it replaces, its includes still relative to the prompts directory."""
    token = _custom.set({**_custom.get(), **{_norm(k): Path(v) for k, v in files.items()}})
    try:
        yield
    finally:
        _custom.reset(token)


def _path(rel: str, stack: tuple[str, ...]) -> Path:
    if not stack and rel in _custom.get():
        found = _custom.get()[rel]
        if not found.is_file():
            raise PromptError(f"{rel}: the prompt file that replaces it, {found}, is missing")
        return found
    if rel in stack:
        raise PromptError(f"{stack[-1]}: include cycle {' -> '.join((*stack, rel))}")
    path = _dir() / rel
    if not path.is_file():
        if stack:
            raise PromptError(f"{stack[-1]}: include {rel!r} not found under {_dir()}")
        raise PromptError(f"no prompt file {rel!r} under {_dir()}")
    return path


def _check_literal(seg: str, rel: str) -> None:
    """A '{{' or '}}' outside a complete directive is a hand-edit typo ('{{brief}', '{brief}}'). Only prompt file text
    is checked, since render() inserts slot values as they are."""
    for mark in ("{{", "}}"):
        i = seg.find(mark)
        if i != -1:
            snippet = seg[max(0, i - 20) : i + 22].replace("\n", " ").strip()
            raise PromptError(
                f"{rel}: stray {mark!r} outside a complete directive (near {snippet!r}); a slot is "
                f"{{{{[a-z_][a-z0-9_]*}}}} and an include is {{{{include:<relpath>}}}}, both braces doubled and closed"
            )


def _directive(body: str, rel: str) -> str | None:
    """The include path a directive names, None for a slot, PromptError for anything else."""
    if body.startswith(_INCLUDE_PREFIX):
        return _norm(body[len(_INCLUDE_PREFIX) :].strip())  # always relative to the prompts directory
    if _SLOT_RE.fullmatch(body):
        return None
    raise PromptError(f"{rel}: unknown directive {{{{{body}}}}} (a slot is {{{{[a-z_][a-z0-9_]*}}}}; "
                      f"an include is {{{{include:<relpath>}}}})")


def _read(rel: str, stack: tuple[str, ...], flags: _Flags) -> str:
    """One file with its flag blocks resolved, its includes pasted in and its slots left in place. `stack` is the chain
    being expanded."""
    text = _blocks_out(_path(rel, stack).read_text("utf-8"), rel, flags)
    stack = (*stack, rel)
    out: list[str] = []
    last = 0
    for m in _DIRECTIVE_RE.finditer(text):
        seg = text[last : m.start()]
        _check_literal(seg, rel)
        out.append(seg)
        last = m.end()
        inc = _directive(m.group(1), rel)
        # An included file's closing newline is left off, so an include on its own line between blank lines leaves one
        # blank line.
        out.append(m.group(0) if inc is None else _read(inc, stack, flags).rstrip("\n"))
    _check_literal(text[last:], rel)
    out.append(text[last:])
    return "".join(out)


def _assemble(name: str, flags: Flags) -> str:
    """The file `name` with its includes pasted in, with the flags `flags` names or the current ones (module note)."""
    rel = _norm(name)
    of = _Flags(flags)
    return _flag_sections(_read(rel, (), of), rel, of)


def load(name: str, flags: Flags = None) -> str:
    """The prompt file with every include pasted in, read fresh from disk, slots left in place, with `flags` (the
    current flags when None, module note). `name` is relative to the prompts directory, with or without '.md'. Under
    THIMBLE_PROMPT_CAPTURE the files read are noted for the next capture (capture.prompt_used)."""
    text = _assemble(name, flags)
    if capture.enabled():
        capture.prompt_used(_norm(name), files(name, flags))
    return text


def names_in(folder: str) -> list[str]:
    """The prompt files directly inside `folder` of the prompts directory, each by its name without '.md', sorted; empty
    when there is no such folder."""
    d = _dir() / _norm(folder).removesuffix(".md")
    return sorted(p.stem for p in d.glob("*.md") if p.is_file()) if d.is_dir() else []


def frontmatter(name: str, flags: Flags = None) -> tuple[dict, str]:
    """(frontmatter, body) of a prompt file that opens with its frontmatter between two `---` lines, read as load()
    reads it; ({}, the whole text) for one that does not. PromptError when the frontmatter does not parse."""
    import yaml  # noqa: PLC0415 — only the files with frontmatter need it

    text = load(name, flags)
    head, sep, body = text.removeprefix("---\n").partition("\n---\n")
    if not text.startswith("---\n") or not sep:
        return {}, text.strip()
    try:
        front = yaml.safe_load(head)
    except yaml.YAMLError as e:
        raise PromptError(f"{_norm(name)}: its frontmatter does not parse ({e})") from e
    return (front if isinstance(front, dict) else {}), body.strip()


def slots(name: str, flags: Flags = None) -> frozenset[str]:
    """The slot names left in `name` once its includes are pasted in, with `flags`."""
    return frozenset(m.group(1) for m in _DIRECTIVE_RE.finditer(load(name, flags)))


def files(name: str, flags: Flags = None) -> list[str]:
    """Every file load(name, flags) reads, the file itself and its includes, in read order, each once. It raises
    PromptError where load(name, flags) would, so a name it lists is a name that loads."""
    out: list[str] = []
    of = _Flags(flags)

    def walk(rel: str, stack: tuple[str, ...]) -> None:
        text = _blocks_out(_path(rel, stack).read_text("utf-8"), rel, of)
        if rel not in out:
            out.append(rel)
        for m in _DIRECTIVE_RE.finditer(text):
            inc = _directive(m.group(1), rel)
            if inc is not None:
                walk(inc, (*stack, rel))

    walk(_norm(name), ())
    return out


def _fill(text: str, values: dict[str, str], rel: str) -> str:
    """Every {{slot}} in `text` replaced by its value, as it is. An unfilled slot raises PromptError naming it."""

    def fill(m: re.Match[str]) -> str:
        slot = m.group(1)
        if slot not in values:
            raise PromptError(f"{rel}: slot {{{{{slot}}}}} is unfilled (given: {sorted(values)})")
        value = values[slot]
        if not isinstance(value, str):
            raise PromptError(f"{rel}: slot {{{{{slot}}}}} must be filled with a str, not {type(value).__name__}")
        return value

    # One pass: re.sub with a function inserts values literally and never scans them again.
    return _DIRECTIVE_RE.sub(fill, text)


def render(name: str, values: dict[str, str], flags: Flags = None) -> str:
    """load(name, flags) with every slot filled from `values`. A slot the file uses but `values` lacks raises
    PromptError, and keys the file does not use are ignored."""
    return _fill(load(name, flags), values, _norm(name))


def render_dev(body: str, values: dict[str, str], flags: Flags = None) -> str:
    """A dev call's text: prompts/dev.md with `{{task}}` filled by `body` (one of DEV_FILES) rendered with `values`. The
    body is rendered first, so a `{{` inside a ticket's own text is never read as a slot of the preamble."""
    if body not in DEV_FILES:
        raise PromptError(f"{body!r} is not a dev body ({', '.join(DEV_FILES)})")
    return render(DEV_PROMPT, {"task": render(body, values, flags).strip()}, flags)


def agent_file(name: str, flags: Flags = None) -> tuple[dict, str]:
    """(frontmatter, body) of an agent definition among AGENT_FILES, read fresh from disk with its includes pasted in
    (each includes preamble.md) and its slots left in place, with `flags`. The body is the agent's system prompt, which
    Claude Code sends whole. PromptError when the file is missing or its frontmatter does not parse."""
    import yaml  # noqa: PLC0415 — only the agent definitions need it

    if name not in AGENT_FILES:
        raise PromptError(f"{name!r} is not an agent definition ({', '.join(AGENT_FILES)})")
    text = _assemble(name, flags)
    head, sep, body = text.removeprefix("---\n").partition("\n---\n")
    try:
        front = yaml.safe_load(head) if sep else None
    except yaml.YAMLError as e:
        raise PromptError(f"{_norm(name)}: its frontmatter does not parse ({e})") from e
    if not isinstance(front, dict):
        raise PromptError(f"{_norm(name)}: an agent definition opens with its frontmatter between two `---` lines")
    return front, body.strip()


def section(name: str, heading: str, flags: Flags = None) -> str:
    """The body of the `## <heading>` section of `name` with `flags`, includes pasted in and slots left in place, up to
    the next `## ` heading: the body of `## <heading>@<flag>` while that flag is on, where the file has one (module
    note). A section a merge renamed is also found by its old name (_RENAMED). PromptError when the file has no such
    section."""
    _, parts = _parts(load(name, flags))
    wanted = (heading, _RENAMED.get((_norm(name), heading)))
    for want in wanted:
        for part, _, body in parts:
            if want is not None and part == want:
                return body.strip() + "\n"
    raise PromptError(f"{_norm(name)}: no section '## {heading}' (has {[part for part, _, _ in parts]})")


def render_head(name: str, values: dict[str, str], flags: Flags = None) -> str:
    """render(name, values, flags) of the part of `name` above its first `## ` heading, for a file whose `## ` sections
    are sent apart (wiring.json's `mixed`), such as labels.md, whose sections fill its own slots."""
    head, _ = _parts(load(name, flags))
    return _fill(head, values, _norm(name))


def render_section(name: str, heading: str, values: dict[str, str], flags: Flags = None) -> str:
    """section(name, heading, flags) with its slots filled from `values`, as render fills a whole file."""
    return _fill(section(name, heading, flags), values, f"{_norm(name)} ## {heading}")


def agent_prompt(name: str, values: dict[str, str], flags: Flags = None) -> str:
    """The body of an agent definition among AGENT_FILES with its includes pasted in and its slots filled from `values`,
    with `flags`, for an agent whose body is a template (orient.md). PromptError where render raises it, or when the
    file does not open with its frontmatter."""
    if name not in AGENT_FILES:
        raise PromptError(f"{name!r} is not an agent definition ({', '.join(AGENT_FILES)})")
    text = render(name, values, flags)
    _, sep, body = text.removeprefix("---\n").partition("\n---\n")
    if not text.startswith("---\n") or not sep:
        raise PromptError(f"{_norm(name)}: an agent definition opens with its frontmatter between two `---` lines")
    return body.strip()


_HEADING_RE = re.compile(r"^(#{1,4}) (.+?)[ \t]*$")


def without(text: str, headings: Iterable[str], lines: Iterable[str] = (), strict: bool = True) -> str:
    """`text` without each `### ` or `#### <heading>` part (up to the next heading of its level or higher, outside code
    fences) and without the one line holding each of `lines`, for template parts a caller's switches turn off. A missing
    heading, or a line not found exactly once, raises PromptError, so a renamed part cannot slip through; with `strict`
    False, for a text that replaces thimble's, what is not there is left as it is."""
    drop = set(headings)
    held = list(lines)
    out: list[str] = []
    seen: set[str] = set()
    hits = {s: 0 for s in held}
    level = 0  # the level of the part being left out, 0 when none is
    fenced = False
    for line in text.splitlines(keepends=True):
        if line.startswith("```"):
            fenced = not fenced
        elif not fenced and (m := _HEADING_RE.match(line.rstrip("\n"))):
            n = len(m.group(1))
            if level and n <= level:
                level = 0
            if not level and n >= 3 and m.group(2) in drop:
                level = n
                seen.add(m.group(2))
        found = [s for s in held if s in line] if not fenced else []
        for s in found:
            hits[s] += 1
        if not level and not found:
            out.append(line)
    if not strict:
        return "".join(out)
    if drop - seen:
        raise PromptError(f"no part {sorted(drop - seen)} to leave out: each is a `### ` or `#### ` heading of the text")
    if bad := {s: k for s, k in hits.items() if k != 1}:
        raise PromptError(f"each line part is one line of the text, and these are on another number of lines: {bad}")
    return "".join(out)
