"""Fix thimble from the browser: the chat agent's tools that work in a fix's copy of thimble, and nothing else.

`/fix <what to change>` (typed in the chat, or the top bar's Fix…) asks the chat agent to change thimble. The kernel
makes the copy (plugin/engine/kernel/fix.py, `fix.new`: a git checkout of thimble under the kernel's THIMBLE_HOME, the
same place the terminal's `thimble fix` uses), and the agent works in it with these tools only:

    fix_start {title}                 makes the copy; its slug and the files at its top
    fix_files {slug, dir?}            the files under a folder of the copy
    fix_read  {slug, path}            one file of the copy, with line numbers
    fix_edit  {slug, path, old, new}  replaces `old` (found once) with `new`; with no `old`, writes the whole file
    fix_test  {slug, path?, args?}    the copy's own tests (pytest), run in the browser's sandbox, the copy read-only
    fix_use   {slug} / fix_undo {}    turns the copy on for the person's thimble, or back to the release (kernel)

Every path goes through `inside`, which refuses a path outside the copy however it is written: `..`, an absolute path,
a symlink that leads out (the file's own, or a folder's on the way), and the copy's .git. The agent gets no shell and
no network; the tests run in the sandbox (cards/sandbox.py), which shows the copy read-only.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from .tools import Result

SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,79}")
FILES_MAX = 400
READ_LINES = 2000
WRITE_MAX = 400_000
SKIP = {".git", "node_modules", "__pycache__", ".venv", "dist", ".pytest_cache"}


class OutsideCopy(ValueError):
    """A path that is not inside the fix's copy."""


def inside(copy_root: str | Path, path: str | Path) -> Path:
    """`path` (relative to the copy, or absolute) as the real path it names, symlinks resolved; OutsideCopy unless
    that is inside the copy's real path and outside its .git. The path need not exist yet (a new file): what exists of
    it is resolved, and the rest may not hold `..`."""
    root = Path(os.path.realpath(copy_root))
    raw = str(path or ".")
    if "\x00" in raw:
        raise OutsideCopy("a path holds no NUL character")
    p = Path(raw)
    full = p if p.is_absolute() else root / p
    real = Path(os.path.realpath(full))
    if real != root and root not in real.parents:
        raise OutsideCopy(f"{raw} is outside the fix's copy; the fix tools read and change only the copy")
    rel = real.relative_to(root)
    if rel.parts and rel.parts[0] == ".git":
        raise OutsideCopy(f"{raw} is in the copy's .git folder, which the fix tools leave alone")
    return real


def _copy(slug: str) -> Path:
    from .kernel_fix import fix  # noqa: PLC0415

    if not isinstance(slug, str) or not SLUG.fullmatch(slug):
        raise OutsideCopy(f"{slug!r} is not the name of a fix")
    fx = fix.load(slug)
    wt = fx.get("worktree")
    if not wt or not Path(wt).is_dir():
        raise OutsideCopy(f"the fix {slug} has no copy of thimble's code (a request has none)")
    return Path(wt)


def _rel(root: Path, p: Path) -> str:
    return str(p.relative_to(Path(os.path.realpath(root)))) or "."


# ---- the tools

async def fix_start(t: Any, args: dict[str, Any]) -> Result:
    from .kernel_fix import fix  # noqa: PLC0415

    fx = fix.new(str(args.get("title") or ""), "fix")
    t.fix_slug = fx["slug"]
    top = sorted(x.name + ("/" if x.is_dir() else "") for x in Path(fx["worktree"]).iterdir() if x.name not in SKIP)
    return Result(f"Fix {fx['slug']}: a copy of thimble {fx.get('version') or ''} on branch {fx['branch']}. Its top "
                  f"folder holds: {', '.join(top)}. Work with fix_files, fix_read and fix_edit; run fix_test; then "
                  f"fix_use turns it on for the analyst.")


async def fix_files(t: Any, args: dict[str, Any]) -> Result:
    root = _copy(str(args.get("slug")))
    base = inside(root, str(args.get("dir") or "."))
    if not base.is_dir():
        return Result(f"{args.get('dir')} is not a folder of the copy", True)
    out = []
    for d, dirs, files in os.walk(base):
        dirs[:] = sorted(x for x in dirs if x not in SKIP)
        for f in sorted(files):
            p = Path(d) / f
            try:
                inside(root, p)
            except OutsideCopy:
                continue  # a link out of the copy is not listed
            out.append(str(p.relative_to(Path(os.path.realpath(root)))))
            if len(out) >= FILES_MAX:
                return Result("\n".join(out) + f"\n[stopped at {FILES_MAX}: name a folder]")
    return Result("\n".join(out) or "no files")


async def fix_read(t: Any, args: dict[str, Any]) -> Result:
    root = _copy(str(args.get("slug")))
    p = inside(root, str(args.get("path") or ""))
    if not p.is_file():
        return Result(f"{args.get('path')} is not a file of the copy", True)
    lines = p.read_text(errors="replace").splitlines()
    start = max(1, int(args.get("offset") or 1))
    body = "\n".join(f"{n}\t{line}" for n, line in enumerate(lines[start - 1:start - 1 + READ_LINES], start))
    more = len(lines) - (start - 1 + READ_LINES)
    return Result((body or "(empty file)") + (f"\n[{more} more lines: offset {start + READ_LINES}]" if more > 0 else ""))


async def fix_edit(t: Any, args: dict[str, Any]) -> Result:
    root = _copy(str(args.get("slug")))
    p = inside(root, str(args.get("path") or ""))
    new = str(args.get("new") if args.get("new") is not None else "")
    old = args.get("old")
    if len(new) > WRITE_MAX:
        return Result(f"the text is over {WRITE_MAX} characters", True)
    if old in (None, ""):
        p.parent.mkdir(parents=True, exist_ok=True)
        inside(root, p.parent)
        p.write_text(new)
        return Result(f"wrote {_rel(root, p)} ({len(new.splitlines())} lines)")
    if not p.is_file():
        return Result(f"{args.get('path')} is not a file of the copy; give no `old` to write a new file", True)
    text = p.read_text()
    n = text.count(str(old))
    if n != 1:
        return Result(f"`old` is found {n} times in {_rel(root, p)}; give text that is found once", True)
    p.write_text(text.replace(str(old), new, 1))
    return Result(f"changed {_rel(root, p)}")


async def fix_test(t: Any, args: dict[str, Any]) -> Result:
    from .cards import sandbox  # noqa: PLC0415

    root = _copy(str(args.get("slug")))
    target = inside(root, str(args.get("path") or "plugin"))
    extra = [str(a) for a in (args.get("args") or []) if isinstance(a, str) and a.startswith("-")]
    res = await sandbox.run_tests(Path(os.path.realpath(root)), [_rel(root, target), *extra],
                                  unsandboxed=bool(getattr(t, "unsandboxed", False)))
    return Result(res["text"], not res["ok"])


async def fix_use(t: Any, args: dict[str, Any]) -> Result:
    from .kernel_fix import fix  # noqa: PLC0415

    slug = str(args.get("slug"))
    _copy(slug)
    said = fix.use(slug)
    from .hub import hub  # noqa: PLC0415

    hub.publish(t.ws, {"type": "fix", "slug": slug, "status": fix.load(slug).get("status")})
    return Result(said)


async def fix_undo(t: Any, args: dict[str, Any]) -> Result:
    from .kernel_fix import fix  # noqa: PLC0415

    said = fix.undo()
    from .hub import hub  # noqa: PLC0415

    hub.publish(t.ws, {"type": "fix", "slug": "", "status": "undone"})
    return Result(said)


TOOLS = {"fix_start": fix_start, "fix_files": fix_files, "fix_read": fix_read, "fix_edit": fix_edit,
         "fix_test": fix_test, "fix_use": fix_use, "fix_undo": fix_undo}


def register() -> None:
    from . import tools  # noqa: PLC0415

    for name, fn in TOOLS.items():
        tools.register(name, fn)


# ---- /fix typed in the chat

def expand(text: str) -> str | None:
    """What the chat agent reads for `/fix …` typed in the chat (or sent by the top bar's Fix…), or None when the
    message is no /fix."""
    m = re.match(r"^/fix\b\s*(.*)$", text.strip(), re.S)
    if not m:
        return None
    want = " ".join(m.group(1).split())
    if want in ("submit", "share", "send"):
        return ("The analyst typed /fix submit: write the draft of the fix you made for them with draft_report, with "
                "its slug, so they can review the exact text.")
    if not want:
        return "The analyst typed /fix with nothing after it. Ask them in one line what thimble should do differently."
    return (f"The analyst wants thimble changed: \"{want}\". Make the change in a copy of thimble: fix_start makes "
            "the copy, then read and change its files with fix_files, fix_read and fix_edit, add a test on made-up "
            "data, and run fix_test. When the tests pass, fix_use turns the copy on for the analyst; say in one line "
            "what changed and that Undo goes back. If the change cannot be made in thimble's code, draft it as a "
            "request with draft_report instead.")
