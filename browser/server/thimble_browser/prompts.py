"""The texts Claude reads in thimble browser, and how they stay the same as the terminal plugin's.

Every prompt is a file under browser/prompts/. Three directives join them:
- `{{include:<file>}}` puts in another file of browser/prompts/;
- `{{shared:<part>}}` puts in a part of the terminal plugin's text, as shared.json says (below);
- `{{<slot>}}` is a value the server fills, such as the folder's path (`{{workdir}}`) or, in the terminal's texts, the
  temp folder (`{{TMPDIR}}`).

Shared parts. The terminal plugin's texts are read from the plugin itself, plugin/ at the top of the repository, when
the server makes a prompt: its guidance (how to write for the analyst, cite claims, draw cards and make labels), the
card tool's description, the checker's and the designer's prompts, and the label classifier. A part names a file of the
plugin (`file`) or a prompt of its registry (`prompt`, plugin/prompts/registry.mjs), whose one file is the one read.
prompts/shared.json names each shared part: where it comes from, the `## ` section, which of its bullets (all when not
given), and the few literal changes the browser needs, such as the terminal's Bash call written as the browser's
run_python call. Each change is a pair of exact strings, and the test (tests/test_prompt_parity.py) fails when the
terminal's text no longer holds a string that a change replaces. So the browser follows every edit to the terminal's
text with no change here, and an edit that touches a replaced string stops the test until someone looks at it.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2] / "prompts"
PLUGIN = Path(__file__).resolve().parents[3] / "plugin"
REGISTRY = "prompts/registry.mjs"
DIRECTIVE = re.compile(r"\{\{(include|shared):([A-Za-z0-9_./-]+)\}\}")
SLOT = re.compile(r"\{\{([A-Za-z_]+)\}\}")


class PromptError(Exception):
    pass


def read(rel: str) -> str:
    p = (ROOT / rel).resolve()
    if ROOT.resolve() not in p.parents:
        raise PromptError(f"{rel}: outside prompts/")
    try:
        return p.read_text(encoding="utf-8")
    except OSError as e:
        raise PromptError(f"{rel}: {e}") from None


def plugin_read(rel: str) -> str:
    """A file of the terminal plugin, by its path under plugin/."""
    p = (PLUGIN / rel).resolve()
    if PLUGIN.resolve() not in p.parents:
        raise PromptError(f"{rel}: outside plugin/")
    try:
        return p.read_text(encoding="utf-8")
    except OSError as e:
        raise PromptError(f"the terminal plugin's {rel}: {e}") from None


def prompt_file(name: str) -> str:
    """The file of a prompt in the plugin's registry, as a path under plugin/: the `file` its entry names, else
    prompts/<name>.md. The registry is JavaScript, and this reads only its table's plain form;
    tests/test_prompt_parity.py checks the result against what Node reads from it."""
    text = plugin_read(REGISTRY)
    start = re.search(rf"^  (['\"]?){re.escape(name)}\1:\s*\{{", text, re.M)
    if not start:
        raise PromptError(f"the terminal plugin's {REGISTRY} has no prompt {name!r}")
    rest = text[start.end():]
    end = re.search(r"^  (['\"]?)[A-Za-z0-9_-]+\1:\s*\{|^\}", rest, re.M)
    entry = rest[: end.start()] if end else rest
    file = re.search(r"\bfile:\s*'([^']+)'", entry)
    return file.group(1) if file else f"prompts/{name}.md"


def source_file(spec: dict[str, Any]) -> str:
    """The path under plugin/ that a shared part comes from."""
    return prompt_file(spec["prompt"]) if spec.get("prompt") else spec["file"]


def body_of(text: str) -> str:
    """A SKILL.md without its frontmatter."""
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end >= 0:
            return text[end + 5:].lstrip("\n")
    return text


def section(text: str, heading: str) -> str:
    """The body of the `## heading` section, up to the next `## ` heading."""
    lines = body_of(text).split("\n")
    out: list[str] = []
    inside = False
    for line in lines:
        if line.startswith("## "):
            if inside:
                break
            inside = line[3:].strip() == heading
            continue
        if inside:
            out.append(line)
    if not inside and not out:
        raise PromptError(f"no section '## {heading}'")
    return "\n".join(out).strip("\n")


def split_bullets(body: str) -> tuple[list[str], list[str], list[str]]:
    """(the paragraphs before the first bullet, the top-level bullets, what follows the last bullet). A bullet is a
    line starting with "- " and the lines indented under it."""
    head: list[str] = []
    bullets: list[list[str]] = []
    tail: list[str] = []
    for line in body.split("\n"):
        if line.startswith("- "):
            if tail:  # text after a list, then a new list: keep it all in the tail
                tail.append(line)
            else:
                bullets.append([line])
        elif bullets and not tail and (line.startswith("  ") or (line == "" and False)):
            bullets[-1].append(line)
        elif bullets:
            tail.append(line)
        else:
            head.append(line)
    return ["\n".join(head).strip("\n")], ["\n".join(b) for b in bullets], ["\n".join(tail).strip("\n")]


@lru_cache(maxsize=1)
def manifest() -> dict[str, Any]:
    return json.loads(read("shared.json"))


def reflow(text: str) -> str:
    """The text with each paragraph and each bullet on one line, so a change can match words that the terminal's file
    wraps across lines. Code fences stay as they are. The words do not change."""
    out: list[str] = []
    fence = False
    cur: list[str] = []

    def flush() -> None:
        if cur:
            out.append(" ".join(s.strip() for s in cur))
            cur.clear()

    for line in text.split("\n"):
        if line.startswith("```"):
            flush()
            fence = not fence
            out.append(line)
            continue
        if fence:
            out.append(line)
        elif not line.strip():
            flush()
            out.append("")
        elif line.startswith("<!--"):
            flush()
            out.append(line)
        elif line.startswith("- ") or line.startswith("#"):
            flush()
            cur.append(line)
        else:
            if cur and cur[0].startswith("- ") and not line.startswith("  "):
                flush()  # a paragraph right after a list is not part of its last bullet
            cur.append(line)
    flush()
    return "\n".join(out)


def source_part(name: str) -> str:
    """A shared part as the terminal's text has it, before the browser's changes, each paragraph on one line."""
    spec = manifest()["parts"].get(name)
    if not spec:
        raise PromptError(f"no shared part '{name}' in prompts/shared.json")
    text = plugin_read(source_file(spec))
    if spec.get("until"):
        if spec["until"] not in text:
            raise PromptError(f"shared part '{name}': the terminal's text no longer has {spec['until']!r}")
        text = text.split(spec["until"], 1)[0]
    if spec.get("after"):
        if spec["after"] not in text:
            raise PromptError(f"shared part '{name}': the terminal's text no longer has {spec['after']!r}")
        text = text.split(spec["after"], 1)[1]
    if spec.get("section"):
        text = section(text, spec["section"])
    if "bullets" in spec:
        head, bullets, tail = split_bullets(text)
        keep = [bullets[i - 1] for i in spec["bullets"]]
        parts = [h for h in head if h and spec.get("head", True)] + keep
        if spec.get("tail", False):
            parts += [t for t in tail if t]
        text = "\n".join(parts)
    return reflow(text.strip("\n"))


def shared(name: str) -> str:
    """A shared part as the browser uses it: the terminal's text with the changes shared.json lists."""
    spec = manifest()["parts"][name]
    text = source_part(name)
    for old, new in spec.get("replace", []):
        if old not in text:
            raise PromptError(f"shared part '{name}': the terminal's text no longer has {old!r}")
        text = text.replace(old, new)
    for old in spec.get("drop", []):
        if old not in text:
            raise PromptError(f"shared part '{name}': the terminal's text no longer has {old!r}")
        text = text.replace(old, "").replace("  ", " ")
    text = re.sub(r" +\n", "\n", text)
    if spec.get("heading"):
        text = f"## {spec['heading']}\n\n{text}"
    return text


def render(rel: str, slots: dict[str, str] | None = None, _depth: int = 0) -> str:
    if _depth > 8:
        raise PromptError("includes nest too deep")
    text = read(rel)

    def directive(m: re.Match) -> str:
        kind, arg = m.group(1), m.group(2)
        return render(arg, slots, _depth + 1) if kind == "include" else shared(arg)

    text = DIRECTIVE.sub(directive, text)
    if _depth == 0:
        vals = slots or {}

        def slot(m: re.Match) -> str:
            if m.group(1) not in vals:
                raise PromptError(f"{rel}: no value for {{{{{m.group(1)}}}}}")
            return vals[m.group(1)]

        text = SLOT.sub(slot, text)
    return text


def fill(text: str, slots: dict[str, str]) -> str:
    """`text` with each `{{NAME}}` that `slots` holds filled in; the others stay as written (the terminal's
    registry.mjs fill)."""
    return SLOT.sub(lambda m: slots.get(m.group(1), m.group(0)), text)


def tool_text(name: str, slots: dict[str, str] | None = None) -> str:
    """The description of one of the browser's tools: its `## <name>` section in prompts/tools.md, or in a
    feature's prompts/tools-<feature>.md, with its shared parts put in and `slots` filled."""
    for p in [ROOT / "tools.md", *sorted(ROOT.glob("tools-*.md"))]:
        text = p.read_text(encoding="utf-8")
        if re.search(rf"^## {re.escape(name)}$", text, re.M):
            body = DIRECTIVE.sub(lambda m: render(m.group(2), None, 1) if m.group(1) == "include" else shared(m.group(2)),
                                 section(text, name))
            return fill(body, slots or {})
    raise PromptError(f"no tool text for {name!r} in prompts/tools*.md")
