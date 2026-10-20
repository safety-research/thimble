"""The texts Claude reads in thimble browser, and how they stay the same as the terminal plugin's.

Every prompt is a file under prompts/ at the top of the repository. Three directives join them:
- `{{include:<file>}}` puts in another file of prompts/;
- `{{shared:<part>}}` puts in a part of the terminal plugin's text, as shared.json says (below);
- `{{<slot>}}` is a value the server fills, such as the folder's path.

Shared parts. The terminal plugin's texts that both products use (its thimble skill, its explain lens) are copied, as
they are, into prompts/terminal/, with prompts/terminal/SOURCE.json naming the commit they came from and their
sha256. `scripts/sync-terminal-prompts` copies them again. prompts/shared.json names each shared part: the file, the
`## ` section, which of its bullets (all when not given), and the few literal changes the browser needs, such as a ref
of the terminal's own form written in the browser's form. Each change is a pair of exact strings, and the test
(tests/test_prompt_parity.py) fails when the terminal's text no longer holds a string that a change replaces. So the
browser follows every edit to the terminal's text with no change here, and an edit that touches a replaced string
stops the test until someone looks at it.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2] / "prompts"
DIRECTIVE = re.compile(r"\{\{(include|shared):([A-Za-z0-9_./-]+)\}\}")
SLOT = re.compile(r"\{\{([a-z_]+)\}\}")


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
    text = read(spec["file"])
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


def tool_text(name: str) -> str:
    """The description of one of the browser's tools: the `## <name>` section of prompts/browser/tools.md."""
    return section(read("browser/tools.md"), name)
