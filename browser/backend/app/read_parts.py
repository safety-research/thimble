"""Text that one of thimble's agents reads with Claude Code's Read tool, written so that a Read call returns it whole.

Read refuses a file over 256KB, and it counts the tokens of a text past READ_UNITS (25,000 UTF-16 code units): past 25k
tokens, a whole-file Read gives only the file's first lines and an offset/limit Read fails. Text in Chinese, Japanese or
Korean, or a table of ids or numbers, runs to a token for every 0.9 to 1.5 characters, so it passes that cap well under
40,000 characters. write cuts a text that one call cannot return at line ends (cut) into <name>.md, <name>-2.md… of at
most READ_UNITS code units each, which Read returns whole whatever they hold, and the agent's prompt names them in order
(named): a writer's context (write_session), a check's task file (checks) and the critic's brief (critique_session).
window gives how many lines of a file too large to read whole one Read call returns whole wherever it starts, for the
critic's transcript digest, which stays one file that the critic reads in windows and an extension's program gets
whole."""
from __future__ import annotations

import re
from pathlib import Path

from .ledger import write_under

# of one file or window: what Claude Code's Read returns whole without counting its tokens. Read (2.1.300) estimates a
# text's tokens as its length in UTF-16 code units over 4 and counts them with the API only when that estimate passes
# 6,250, a quarter of its 25k-token cap, so a text of at most 25,000 code units comes back whole whatever it holds; its
# line-number prefix is not counted. A live session counted 26k to 42k tokens for 40,000 characters of Chinese,
# Japanese, Korean, ids or numbers. At 3 bytes a code unit at most in UTF-8, 25,000 come to at most 75KB, under the
# file-size cap.
READ_UNITS = 25_000
LINE_PREFIX_CHARS = 8  # what Read puts before each line it returns, its number and a tab; a window leaves room for it


def units(text: str) -> int:
    """`text`'s length in UTF-16 code units, as Claude Code measures it: a character past U+FFFF, such as most emoji,
    counts 2."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _head(line: str, limit: int) -> int:
    """How many of `line`'s first characters come to at most `limit` code units (units), at least 1."""
    k = min(len(line), limit)
    while k > 1 and (over := units(line[:k]) - limit) > 0:
        k = max(1, k - (over + 1) // 2)  # a character is 1 or 2 units, so this many must go, and never more
    return k


def cut(text: str, limit: int | None = None) -> list[str]:
    """`text` cut at line ends into parts of at most `limit` (READ_UNITS) code units (units), a line longer than that
    alone cut mid-line between characters, so that the session's Read tool returns each part whole. The parts joined
    are `text`."""
    limit = READ_UNITS if limit is None else max(1, limit)
    parts: list[str] = []
    piece: list[str] = []
    size = 0
    for line in text.splitlines(keepends=True):
        n = units(line)
        if size and size + n > limit:
            parts.append("".join(piece))
            piece, size = [], 0
        while n > limit:
            k = _head(line, limit)
            parts.append(line[:k])
            line = line[k:]
            n = units(line)
        if line:
            piece.append(line)
            size += n
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
    with its line break and room for Read's line-number prefix (LINE_PREFIX_CHARS), is at most `limit` (READ_UNITS) code
    units (units). All of them when the file fits, and at least 1."""
    limit = READ_UNITS if limit is None else max(1, limit)
    sizes = [units(x) + 1 + LINE_PREFIX_CHARS for x in lines]
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
