"""Text that one of thimble's agents reads with Claude Code's Read tool, written so that a Read call returns it whole.

Read refuses a file over 256KB and returns at most 25k tokens a call, and dense lines such as a table's run about 3
characters to a token, so a file of about 75k-100k characters fails whole, and an offset/limit window of dense lines can
fail too. write cuts a text that one call cannot return at line ends (cut) into <name>.md, <name>-2.md… of at most
PART_CHARS characters each, which the agent's prompt names in order (named): a writer's context (write_session), a
check's task file (checks) and the critic's brief (critique_session). window gives how many lines of a file too large
to read whole one Read call returns whole wherever it starts, for the critic's transcript digest, which stays one file
that the critic reads in windows and an extension's program gets whole."""
from __future__ import annotations

import re
from pathlib import Path

from .ledger import write_under

# of one file: small enough that one Read call returns it whole, under both the tool's file-size cap (256KB) and its
# cap on the tokens a call returns (25k), which a larger file trips with no recourse, since dense lines put even a small
# offset/limit window past the token cap. 40k, not 60k: dense lines such as a table's run about 3 characters to a token,
# so 60k characters come to about 20k tokens before Read adds a line-number prefix to every line, close to the cap,
# while 40k come to about 13k. At 4 bytes a character at most, 40k characters are at most 160KB.
PART_CHARS = 40_000
LINE_PREFIX_CHARS = 8  # what Read puts before each line it returns, its number and a tab, which a window counts


def cut(text: str, limit: int | None = None) -> list[str]:
    """`text` cut at line ends into parts of at most `limit` (PART_CHARS) characters, a line longer than that alone cut
    mid-line, so that the session's Read tool returns each part whole. The parts joined are `text`."""
    limit = PART_CHARS if limit is None else max(1, limit)
    parts: list[str] = []
    piece: list[str] = []
    size = 0
    for line in text.splitlines(keepends=True):
        if size and size + len(line) > limit:
            parts.append("".join(piece))
            piece, size = [], 0
        while len(line) > limit:
            parts.append(line[:limit])
            line = line[limit:]
        if line:
            piece.append(line)
            size += len(line)
    if piece:
        parts.append("".join(piece))
    return parts or [""]


def paths(first: Path, n: int) -> list[Path]:
    """The `n` files of a text whose first file is `first`: `first`, then <stem>-2<suffix>, <stem>-3<suffix>… beside
    it."""
    return [first if i == 0 else first.with_name(f"{first.stem}-{i + 1}{first.suffix}") for i in range(n)]


def write(base: Path, first: Path, text: str) -> list[Path]:
    """`text` written under `base` (write_under, since agents can write these folders) as `first` alone when one Read
    call returns it whole, else cut (cut) into `first` and the files after it (paths). The files of an earlier, larger
    text that this one no longer needs are removed. The paths written, in order."""
    parts = cut(text)
    out = paths(first, len(parts))
    for path, part in zip(out, parts):
        write_under(base, path, part)
    later = re.compile(rf"{re.escape(first.stem)}-[1-9][0-9]*{re.escape(first.suffix)}")
    for old in first.parent.glob(f"{first.stem}-*{first.suffix}"):
        if later.fullmatch(old.name) and old not in out:
            old.unlink(missing_ok=True)
    return out


def named(written: list[Path], one: str, many: str) -> str:
    """The prompt's line that names the files write wrote: the hint `one` with its {path}, or with several files the
    hint `many` with {n} and {paths}, in order."""
    from . import tools  # noqa: PLC0415 — tools is large, and this module is imported by the ones it loads lazily

    if len(written) == 1:
        return tools.hint(one, path=str(written[0]))
    return tools.hint(many, n=len(written), paths=", ".join(str(p) for p in written))


def window(lines: list[str], limit: int | None = None) -> int:
    """How many of a file's `lines` one Read call returns whole wherever it starts: every run of that many lines, each
    with Read's line-number prefix (LINE_PREFIX_CHARS), is at most `limit` (PART_CHARS) characters. All of them when the
    file fits, and at least 1."""
    limit = PART_CHARS if limit is None else max(1, limit)
    sizes = [len(x) + 1 + LINE_PREFIX_CHARS for x in lines]
    n = len(sizes)
    best, j, total = n, 0, 0
    for i in range(n):
        if j < i:
            j, total = i, 0
        while j < n and total + sizes[j] <= limit:
            total += sizes[j]
            j += 1
        if j == n:  # a window from here reaches the end, which a shorter read past the end returns whole too
            break
        best = min(best, max(1, j - i))
        if j > i:
            total -= sizes[i]
    return max(1, best)
