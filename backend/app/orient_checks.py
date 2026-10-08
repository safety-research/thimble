"""The coverage checks a critique starts from: what code can find missing from the orientation's analysis before the
critic reads it. The `critique` tool runs them and puts the findings in the critique's first message, where the critic
confirms each item before listing it. The checks look at the stored workspace as a whole, without a model:

  unread files       corpus files that no card's code read (cell.reads), no Read call of the orientation, its
                     subagents or another chat opened (a critic's own Reads do not count), and no stored call of the
                     orientation named in its input or output (a named folder counts for the files under it). A card
                     whose reads were capped counts as reading every file in the folders it read from.
  unused fields      top-level fields of JSON Lines records (and one level into object fields), and the values of a
                     field naming a record's kind (KIND_FIELDS), that no card or orientation call names. Records are
                     sampled from the start, middle and end of up to FILES_PER_KIND files per kind of file (the path
                     with its ids masked), within SAMPLE_BYTES a file, until UNUSED_LISTED findings, at most
                     KINDS_SAMPLED kinds and SAMPLE_TOTAL_BYTES in all.

The call text can run to tens of megabytes, so it is split into words and path runs once and each field, value and path
is a set lookup. The checks run in a child process (check_apart), since pure-Python parsing in a server thread would
hold the interpreter lock; an abandoned critique kills the child. Every line the model reads is a `## check-*` section
of prompts/tools.md.

The coverage line says how much of the corpus one orientation saw: the files whose lines or records its tool outputs
showed, grouped by glob, then its share of the files and of their lines: `Coverage: viewed only src/*.jsonl,
board.jsonl · 22% of files · 12% of lines` (`of records` when a file of the corpus is not read by lines, such as a
database or a PDF). Only the calls of the orientation's chat and the chats under it (its subagents' and workflow
agents', never a critique's) count, each by what its stored output (calls.py) showed (_seen):

  Read         the lines its output numbers; a PDF's pages
  any other    each line of its output (SEEN_CHARS at most, as much as Claude Code shows of a Bash output) that is a
               line of a file the call's input names (by path, folder or wildcard; for add_card and edit_card also the
               files the card's code read), or a long enough piece of one, such as a field a script printed or a cell
               of a table; a line found in a file the call names by its own path (or a wildcard) counts there alone,
               not in the other files of a folder the call also names, and a line found in more than SHARED_MAX of the
               files counts in none
  a file made  a call that reads a file outside the corpus (a Read, cat, grep, ...) by its absolute path counts as
               above against the corpus files named by the calls whose input gave that path, its folder or a path in
               it: a dump the orientation wrote of agents/a.jsonl into work/dumps/ and read there counts as lines of
               agents/a.jsonl. So does a long output Claude Code saved to a file, against the files of the call it came
               from

So a command that only counts or lists (wc, ls, find, grep -c) shows no line of a file and counts nothing. The search
reads each file up to LINE_SCAN_BYTES for whole lines and PIECE_SCAN_BYTES for pieces, within LINE_SCAN_TOTAL and
PIECE_SCAN_TOTAL in all, so in a very large corpus the line can count less than was seen. It can count more where the
files a call names hold the same text: a line found in up to SHARED_MAX of them counts in each, so a file that repeats
another's records (a table exported as JSON Lines, both named) counts as seen with it. The orientation's end adds it
to its transcript (orient_session.measure), and a critique's first message gives it in place of the unread line. A
file's lines or records are records.count's, estimated from its bytes past COUNT_BYTES (`~`).
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import itertools
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("thimble.orient_checks")

KIND_FIELDS = ("type", "kind", "event_type", "event", "record_type", "role", "action", "op", "subtype", "category", "status")
KIND_VALUES_MAX = 40  # a kind field with more distinct values than this names something else (an id, a free text)
KIND_VALUE_CHARS = 40
FILES_PER_KIND = 3
SAMPLE_BYTES = 1_500_000  # read from one file, split between its start, middle and end
SAMPLE_RECORDS = 600  # parsed from one file at most
KINDS_SAMPLED = 200  # kinds of file sampled at most, spread over the corpus's order
SAMPLE_TOTAL_BYTES = 200_000_000  # read from every sampled file together
CHECK_TIMEOUT_S = 600.0  # check_apart's child is stopped after this long
CHILD_POLL_S = 0.05  # how often check_apart looks whether its child has ended
JSONL_SUFFIXES = (".jsonl", ".ndjson")
READ_TOOLS = ("Read",)  # a Grep or Glob call searches or lists a file without reading it
UNREAD_LISTED = 12  # unread files named one by one; past this, by kind of file with a count
RECORDS_MAX_BYTES = 200_000_000  # a file past this size has its records estimated (coverage): they take long to count
UNUSED_PER_KIND = 5  # unused fields and values named per kind of file, the most filled first
UNUSED_LISTED = 20
CALL_TEXT_CHARS = 200_000  # of one call's input and output read for the checks
CALLS_TEXT_CHARS = 30_000_000  # of every call's, together
CRITIC = "critic"  # a critique's chat's agent_type, `thimble:critic` as a subagent (critique_session, _critic)
BACKEND_DIR = Path(__file__).resolve().parent.parent  # where `python -m app.orient_checks` runs (check_apart)
COVERAGE_FLAG = "--coverage"  # the child adds the coverage line of the orientation chat named next (coverage)
ONLY_FLAG = "--only"  # with COVERAGE_FLAG, the child computes the coverage line alone
COVERAGE_GLOBS = 8  # globs of folder and suffix the coverage line groups files into; past this, by top folder
COVERAGE_LISTED = 6  # globs of viewed files the coverage line names; the rest are counted
COVERAGE_NAMED = 2  # a glob with this few files viewed has them named
COUNT_BYTES = 500_000_000  # of files whose records the coverage line counts; the rest are estimated from their bytes
LINE_READERS = ("lines", "csv")  # the records.reader_of readers whose records are lines, which the line counts as lines
# what the orientation saw (_seen, module note)
SEEN_CHARS = 30_000  # of one call's output read: as much as Claude Code shows of a Bash output by default
SEEN_LINES = 2_000  # of one call's output lines read
LINE_MIN = 8  # characters an output line holds at least to be looked for whole among a file's lines
PIECE_MIN = 20  # characters a piece of an output line holds at least to be searched for inside a file
PIECE_WINDOW = 40  # of a longer piece, the characters at its middle that are searched for
PIECES_PER_LINE = 2  # pieces of one output line searched for, the longest first, until one is found
PIECES_PER_CALL = 400  # output lines of one call whose pieces are searched for, spread over its output
SHARED_MAX = 3  # files an output line may be found in and still count as a line seen in each
LINE_SCAN_BYTES = 1 << 30  # of one file read for whole lines
LINE_SCAN_TOTAL = 8 << 30  # of every file together
PIECE_SCAN_BYTES = 64 << 20  # of one file searched for a piece
PIECE_SCAN_TOTAL = 24 << 30  # searched for pieces in all, each search counting the bytes it went through
PDF_PAGES = 10  # pages Read shows of a PDF without `pages`, which it takes only for PDFs past this many
# a prefix an output line may carry before a file's line: Read's and cat -n's number, an add_card output's address, and
# grep's file name and line number
_LINE_PREFIX_RE = re.compile(r"^(?:\s*\d+(?:\t|→)|L\d+\||(?:[\w./-]+:)?\d+[:-]|[\w./-]+\.\w+:)")
_NUMBERED_RE = re.compile(r"^\s*(\d+)(?:\t|→)")  # a line of a Read result: its number, then the file's line
# where an output line is cut into pieces: what JSON escapes (a quote, a backslash with what it escapes, a character past
# ASCII), and the separators of printed columns (a tab, a bar, two spaces)
_PIECE_SPLIT_RE = re.compile(r'\\u[0-9a-fA-F]{4}|\\.|["\t|]| {2,}|[^\x20-\x7e]')
_CARD_RE = re.compile(r"^card:([A-Za-z0-9_-]+)", re.M)  # the card an add_card or edit_card result names on a line
_PAGES_RE = re.compile(r"(\d+)(?:\s*-\s*(\d+))?")
_DIGITS_RE = re.compile(r"\d+")
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")
_HEX_ID_RE = re.compile(r"(?=.*\d)[0-9a-f]{3,}", re.I)  # a whole token of hex digits, at least one of them a digit
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")  # the characters of a whole word, as _Text.names bounds one
_PATH_RE = re.compile(r"[\w./-]+")  # the characters a path is written with, as _read_by_calls splits the text
# where Claude Code says it put a long output it showed only the start of, which the agent then reads with Read
_SAVED_RE = re.compile(r"saved to:?\s+(/[^\s'\"<>]+)", re.I)
# folders whose paths name no file an orientation made from the corpus (`2>/dev/null`, `/usr/bin/python3`)
SYSTEM_DIRS = ("/dev", "/proc", "/sys", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc")
_GLOB_RE = re.compile(r"[\w./*?-]+")  # a run of path characters that may hold a wildcard (_globbed)


@dataclass
class Finding:
    """One line of the result: the check it comes from and its text, already filled."""

    check: str
    text: str


@dataclass
class _Kind:
    """What the sampled records of one kind of file hold: its example file, how many records were read, how often each
    field was filled, and the values of each kind field."""

    example: str
    records: int = 0
    filled: Counter = field(default_factory=Counter)
    values: dict[str, Counter] = field(default_factory=dict)


# --------------------------------------------------------------------------- the workspace's cards and reads


def _cells(ws: Path) -> list[dict[str, Any]]:
    from . import notebook  # noqa: PLC0415 — notebook imports the kernel machinery, which the checks need only here

    return [cell for _, nb in notebook._stored(ws) for cell in nb.get("cells") or [] if isinstance(cell, dict)]


def _cell_text(cell: dict[str, Any]) -> str:
    from . import material  # noqa: PLC0415

    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    parts = [str(cell.get(k) or "") for k in ("title", "code", "takeaway")]
    parts.append(json.dumps(payload, ensure_ascii=False, default=str) if payload else "")
    parts.append(material.outputs_as_text(cell.get("outputs")))
    return "\n".join(parts)


def _read_by_cells(cells: list[dict[str, Any]], files: set[str]) -> set[str]:
    """The corpus files the cards' code read: each card's recorded reads, and for a card whose reads were capped every
    file in the folders its recorded reads fall in."""
    out: set[str] = set()
    for cell in cells:
        reads = [str(r) for r in cell.get("reads") or [] if isinstance(r, str)]
        out.update(r for r in reads if r in files)
        if cell.get("reads_more"):
            folders = {os.path.dirname(r) for r in reads}
            out.update(f for f in files if os.path.dirname(f) in folders)
    return out


def _read_by_agents(c: str, corpus: Path) -> set[str]:
    """The corpus files a Read call opened in any chat of the workspace but a critique's. A file only a critic opened is
    still one the analysis never read."""
    from . import agents  # noqa: PLC0415

    out: set[str] = set()
    for meta in agents.list_chats(c):
        if _critic(meta):
            continue
        _, log_path = agents.paths(c, str(meta["id"]))
        for rec in agents.read_events(log_path):
            if rec.get("type") != "tool_use" or rec.get("name") not in READ_TOOLS:
                continue
            inp = rec.get("input") if isinstance(rec.get("input"), dict) else {}
            rel = _corpus_rel(corpus, inp.get("file_path"))
            if rel:
                out.add(rel)
    return out


def _corpus_rel(corpus: Path, raw: Any) -> str:
    """A path a call gave, absolute or from the corpus folder, as a corpus-relative path; '' outside the corpus."""
    raw = str(raw or "").strip()
    if not raw:
        return ""
    root = corpus.resolve()
    p = Path(raw) if os.path.isabs(raw) else root / raw
    try:
        return p.resolve().relative_to(root).as_posix()
    except (OSError, ValueError):
        return ""


def _calls_text(c: str) -> str:
    """The input and output of every stored call of the workspace's orientations (calls.py), each cut to
    CALL_TEXT_CHARS, together up to CALLS_TEXT_CHARS; a critic's own calls are left out, as its Reads are."""
    from . import calls  # noqa: PLC0415

    ws = config.workspace_dir(c)
    folder = ws / calls.CALLS_DIR
    parts: list[str] = []
    total = 0
    critics = _critic_chats(c) if folder.is_dir() else set()
    for path in sorted(folder.glob("*.jsonl")) if folder.is_dir() else []:
        chat = path.stem
        for row in calls.listing(c, chat):
            if row.get("chat") in critics:
                continue
            full = calls.get(c, chat, int(row["n"])) or {}
            text = json.dumps(full.get("input"), ensure_ascii=False, default=str) + "\n" + str(full.get("result") or "")
            text = text[:CALL_TEXT_CHARS]
            parts.append(text)
            total += len(text)
            if total > CALLS_TEXT_CHARS:
                return "\n".join(parts)
    return "\n".join(parts)


def _own_calls(c: str, chats: set[str]) -> Iterator[dict[str, Any]]:
    """Each stored call (calls.py) made in `chats`, or in a chat of theirs not yet known, whole: {name, input, result?,
    is_error?, ...}."""
    from . import calls  # noqa: PLC0415

    folder = config.workspace_dir(c) / calls.CALLS_DIR
    for path in sorted(folder.glob("*.jsonl")) if folder.is_dir() else []:
        if path.stem not in chats:
            continue
        for row in calls.listing(c, path.stem):
            if row.get("chat") and row["chat"] not in chats:
                continue
            full = calls.get(c, path.stem, int(row["n"]))
            if full:
                yield full


def _critic_chats(c: str) -> set[str]:
    from . import agents  # noqa: PLC0415

    return {str(m["id"]) for m in agents.list_chats(c) if _critic(m)}


def _critic(meta: dict[str, Any]) -> bool:
    """Whether a chat is a critique's: thimble's critic, or an extension's (`<extension>:critic`)."""
    kind = str(meta.get("agent_type") or "")
    return kind == CRITIC or kind.endswith(":" + CRITIC) or meta.get("mode_agent") == CRITIC


def _orientation_chats(c: str, chat: str) -> set[str]:
    """The orientation chat `chat` and every chat under it, its subagents' and workflow agents' steps, less a
    critique's chat and the chats under that."""
    from . import agents  # noqa: PLC0415

    under: dict[str, list[dict[str, Any]]] = {}
    for meta in agents.list_chats(c):
        under.setdefault(str(meta.get("parent") or ""), []).append(meta)
    out: set[str] = set()
    todo = [chat]
    while todo:
        cur = todo.pop()
        if cur in out:
            continue
        out.add(cur)
        todo.extend(str(m["id"]) for m in under.get(cur, []) if m.get("id") and not _critic(m))
    return out


def _read_by_calls(text: str, corpus: Path, files: set[str], by_path: set[str] | None = None) -> set[str]:
    """The corpus files a call's text names: a file by its corpus-relative or absolute path filling whole components of
    a run of path characters, and every file under a folder named the same way, as a bare word too (`os.listdir('runs')`).
    A path holding other characters (a space) is searched for in the whole text instead. A wildcard pattern's files are
    _globbed's. `by_path`, when given, gets the files named by their own path alone."""
    if not text:
        return set()
    root = str(corpus.resolve()).rstrip("/") + "/"
    text = text.replace(root, "")
    depth = max((f.count("/") + 1 for f in files), default=1)
    heads: set[str] = set()  # the leading components of each run, where a folder can be named
    spans: set[str] = set()  # each sequence of up to `depth` whole components of a run, where a file can be named
    for run in set(_PATH_RE.findall(text)):
        parts = run.split("/")
        heads.update("/".join(parts[:j]) for j in range(1, min(len(parts), depth) + 1))
        for r in {run, run.rstrip(".")}:  # a path at the end of a sentence is still named
            parts = r.split("/")
            for i in range(len(parts)):
                spans.update("/".join(parts[i:j]) for j in range(i + 1, min(len(parts), i + depth) + 1))

    def plain(path: str) -> bool:
        return _PATH_RE.fullmatch(path) is not None

    out = {f for f in files if (f in spans if plain(f) else f in text)}
    if by_path is not None:
        by_path.update(out)
    folders = {os.path.dirname(f) for f in files} - {""}
    named = {d for d in folders
             if (d in heads if plain(d) else re.search(rf"(?<![\w./-]){re.escape(d)}(?:/|(?![\w.-]))", text))}
    for f in files:
        parts = f.split("/")
        if any("/".join(parts[:i]) in named for i in range(1, len(parts))):
            out.add(f)
    return out


def _globbed(text: str, files: set[str]) -> set[str]:
    """The files a wildcard pattern of the text matches by its trailing components, as a shell or glob() would from
    some folder: `*.txt` in `cd tickets && cat *.txt` matches every file named so in any folder. Only a pattern with a
    word character and a dot or a slash counts (`*.jsonl`, `runs/*/`), since `*` also multiplies and repeats. A
    pattern's last component is matched against the names that hold its longest literal part, then its folders."""
    by_name: dict[str, list[str]] = {}
    for f in files:
        by_name.setdefault(f.rpartition("/")[2], []).append(f)
    out: set[str] = set()
    for pat in {r.strip("/") for r in _GLOB_RE.findall(text) if "*" in r or "?" in r}:
        if not re.search(r"\w", pat) or not re.search(r"[./]", pat):
            continue
        folder, _, last = pat.rpartition("/")
        literal, name = max(re.split(r"[*?]", last), key=len), re.compile(_glob_rx(last))
        found = [f for n in by_name if literal in n and name.fullmatch(n) for f in by_name[n] if f not in out]
        if folder:
            within, path = max(re.split(r"[*?]", folder), key=len), re.compile(rf"(?:^|/){_glob_rx(pat)}$")
            found = [f for f in found if within in f and path.search(f)]
        out.update(found)
    return out


def _glob_rx(pattern: str) -> str:
    """The regex of a wildcard pattern: `**` any run of characters, `*` any within one component, `?` one."""
    return re.escape(pattern).replace(r"\*\*", ".*").replace(r"\*", "[^/]*").replace(r"\?", "[^/]")


# --------------------------------------------------------------------------- sampling records


def _kind_key(rel: str) -> str:
    """A kind of file: its path with ids masked, so run-7/log.jsonl and run-12/log.jsonl are one. A uuid, a hex token of
    three or more digits holding a digit, and each other run of digits become `#`."""

    def mask(m: re.Match) -> str:
        token = m.group(0)
        return "#" if _HEX_ID_RE.fullmatch(token) else _DIGITS_RE.sub("#", token)

    return _TOKEN_RE.sub(mask, _UUID_RE.sub("#", rel))


def _sample_lines(path: Path) -> list[bytes]:
    """Whole lines from the start, the middle and the end of a file, a third of SAMPLE_RECORDS from each, read within
    SAMPLE_BYTES."""
    third = SAMPLE_RECORDS // 3
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            if size <= SAMPLE_BYTES:
                lines = f.read().splitlines()
                if len(lines) <= SAMPLE_RECORDS:
                    return lines
                mid = len(lines) // 2
                return lines[:third] + lines[mid - third // 2 : mid + third - third // 2] + lines[-third:]
            part = SAMPLE_BYTES // 3
            out: list[bytes] = []
            for start in (0, size // 2, size - part):
                f.seek(start)
                chunk = f.read(part).splitlines()
                out.extend(chunk[1 if start else 0 : -1][:third])  # a chunk's first and last lines may be cut
            return out
    except OSError:
        return []


def _sample(corpus: Path, files: list[str]) -> Iterator[_Kind]:
    """What the sampled records of each kind of JSON Lines file of the corpus hold, one kind at a time, so the caller
    stops the reading once it has its findings. Past KINDS_SAMPLED kinds, that many are sampled, spread evenly over the
    corpus's order, and the reading stops once SAMPLE_TOTAL_BYTES have been read."""
    by_kind: dict[str, list[str]] = {}
    for rel in files:
        if rel.lower().endswith(JSONL_SUFFIXES):
            by_kind.setdefault(_kind_key(rel), []).append(rel)
    keys = list(by_kind)
    if len(keys) > KINDS_SAMPLED:
        keys = [keys[int((i + 0.5) * len(keys) / KINDS_SAMPLED)] for i in range(KINDS_SAMPLED)]
    budget = SAMPLE_TOTAL_BYTES
    for key in keys:
        if budget <= 0:
            return
        rels = by_kind[key]
        kind = _Kind(example=rels[0] if len(rels) == 1 else key.replace("#", "*"))
        for rel in rels[:FILES_PER_KIND]:
            try:
                budget -= min((corpus / rel).stat().st_size, SAMPLE_BYTES)
            except OSError:
                continue
            for line in _sample_lines(corpus / rel):
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                kind.records += 1
                for name, value in rec.items():
                    if value in (None, "", [], {}):
                        continue
                    kind.filled[str(name)] += 1
                    if isinstance(value, dict):
                        for sub, v in value.items():
                            if v not in (None, "", [], {}):
                                kind.filled[f"{name}.{sub}"] += 1
                    if str(name) in KIND_FIELDS and isinstance(value, str) and len(value) <= KIND_VALUE_CHARS:
                        kind.values.setdefault(str(name), Counter())[value] += 1
        if kind.records:
            yield kind


class _Text:
    """The cards' and calls' text, lowercased, with the set of its whole words, so naming a field is a set lookup."""

    def __init__(self, text: str) -> None:
        self.text = text.lower()
        self.words = set(_WORD_RE.findall(self.text))

    def names(self, word: str) -> bool:
        """Whether the text names a field or value as a whole word, ignoring case. A word with other characters
        (`tool-use`) is searched for only when each of its words is in the text."""
        w = word.lower()
        if _WORD_RE.fullmatch(w):
            return w in self.words
        if not all(p in self.words for p in _WORD_RE.findall(w)):
            return False
        i = self.text.find(w)
        while i >= 0:
            before, after = self.text[i - 1 : i], self.text[i + len(w) : i + len(w) + 1]
            if not _WORD_RE.fullmatch(before or "-") and not _WORD_RE.fullmatch(after or "-"):
                return True
            i = self.text.find(w, i + 1)
        return False


# --------------------------------------------------------------------------- the checks


def _unread_files(c: str, corpus: Path, files: list[str], cells: list[dict[str, Any]], calls_text: str = "") -> list[str]:
    fileset = set(files)
    return sorted(fileset - _read_by_cells(cells, fileset) - _read_by_agents(c, corpus)
                  - _read_by_calls(calls_text, corpus, fileset))


def _unread(unread: list[str], files: list[str]) -> list[Finding]:
    from .tools import hint  # noqa: PLC0415

    if not unread:
        return []
    if len(unread) <= UNREAD_LISTED:
        listed = ", ".join(f"`{f}`" for f in unread)
    else:
        kinds = Counter(_kind_key(f) for f in unread)
        listed = ", ".join(f"`{k.replace('#', '*')}` ({n})" for k, n in kinds.most_common(UNREAD_LISTED))
        if len(kinds) > UNREAD_LISTED:
            listed += f", and {len(kinds) - UNREAD_LISTED} more kinds"
    return [Finding("unread", hint("check-unread", n=f"{len(unread):,}", total=f"{len(files):,}", files=listed))]


def _unused(corpus: Path, files: list[str], cells: list[dict[str, Any]], calls_text: str = "") -> list[Finding]:
    """The unused fields of the kinds of file the orientation opened; a kind nobody opened is the unread line's. A
    field or value named in a card or in a call of the orientation's counts as used."""
    text = _Text("\n".join(_cell_text(cell) for cell in cells) + "\n" + calls_text)
    out: list[Finding] = []
    for kind in _sample(corpus, files):
        out += itertools.islice(_unused_of(kind, text), UNUSED_PER_KIND)
        if len(out) >= UNUSED_LISTED:
            break
    return out[:UNUSED_LISTED]


def _unused_of(kind: _Kind, text: _Text) -> Iterator[Finding]:
    """One kind of file's unused values of its kind fields, then its unused fields, the most filled first. The kinds of
    record come first, since a kind nobody counted hides a whole class of records."""
    from .tools import hint  # noqa: PLC0415

    for name, values in kind.values.items():
        if len(values) > KIND_VALUES_MAX:
            continue
        for value, n in values.most_common():
            if not text.names(value):
                yield Finding("unused", hint("check-unused-kind", file=kind.example, field=name, value=value,
                                             count=f"{n:,}", sampled=f"{kind.records:,}"))
    for name, n in kind.filled.most_common():
        if not text.names(name.rsplit(".", 1)[-1]):
            yield Finding("unused", hint("check-unused", file=kind.example, field=name, filled=f"{n:,}",
                                         sampled=f"{kind.records:,}"))


def check(c: str, coverage_of: str | None = None) -> list[Finding]:
    """The coverage findings for workspace `c`: the corpus files nothing opened, then the unused fields and record kinds
    of the opened files. With `coverage_of`, an orientation chat, its coverage line stands in for the unread line.
    ValueError for a workspace whose corpus is gone."""
    from . import corpus as corpus_mod  # noqa: PLC0415

    ws = config.workspace_dir(c)
    corpus = config.corpus_dir(c)
    files = [s["path"] for s in corpus_mod.list_sources(corpus) if not s.get("hidden")]
    cells = _cells(ws)
    calls_text = _calls_text(c)
    unread = _unread_files(c, corpus, files, cells, calls_text)
    opened = set(files) - set(unread)
    first = [coverage(c, coverage_of)] if coverage_of else _unread(unread, files)
    return first + _unused(corpus, [f for f in files if f in opened], cells, calls_text)


def _glob(rel: str, top: bool = False) -> str:
    """The glob a file is grouped under in the coverage line: its folder with ids masked, and its suffix
    (`runs/run-12/log.jsonl` is `runs/run-*/*.jsonl`), or with `top` its top folder whole (`runs/**`); a file at the
    corpus's root goes by its suffix (`*.md`)."""
    folder, _, name = rel.rpartition("/")
    stem, dot, ext = name.rpartition(".")
    suffix = f".{ext}" if dot and stem else ""
    if folder and top:
        return folder.split("/", 1)[0] + "/**"
    if folder:
        return _kind_key(folder).replace("#", "*") + "/*" + suffix
    return "*" + suffix


def _records_of(corpus: Path, sizes: dict[str, int]) -> tuple[dict[str, int], bool]:
    """Each file's records (records.count), and whether any was estimated: the smallest files are counted first, up to
    COUNT_BYTES in all and RECORDS_MAX_BYTES a file, and each other file's records are estimated from its bytes at the
    rate of the counted files with its suffix, else of all the counted files."""
    from . import records  # noqa: PLC0415

    counts: dict[str, int] = {}
    budget = COUNT_BYTES
    for f in sorted(sizes, key=lambda f: sizes[f]):
        if sizes[f] > RECORDS_MAX_BYTES or sizes[f] > budget:
            continue
        try:
            counts[f] = records.count(corpus / f, f)
        except Exception:  # noqa: BLE001 — a file that cannot be read holds no records the analysis could read
            counts[f] = 0
        budget -= sizes[f]
    rest = [f for f in sizes if f not in counts]
    if not rest:
        return counts, False

    def rate(fs: "list[str]") -> float:
        n, b = sum(counts[f] for f in fs), sum(sizes[f] for f in fs)
        return n / b if n and b else 0.0

    def suffix(f: str) -> str:
        name = f.rpartition("/")[2]
        return name.rpartition(".")[2] if "." in name else ""

    overall = rate(list(counts))
    by_suffix: dict[str, list[str]] = {}
    for f in counts:
        by_suffix.setdefault(suffix(f), []).append(f)
    for f in rest:
        counts[f] = round(sizes[f] * (rate(by_suffix.get(suffix(f), [])) or overall))
    return counts, True


def _share(n: float, total: float) -> str:
    """n of total as a whole percentage, 100% only when it is all, 0% only when it is none and <1% below a half."""
    if total <= 0 or n <= 0:
        return "0%"
    if n >= total:
        return "100%"
    if 100 * n / total < 0.5:
        return "<1%"
    return f"{min(99, round(100 * n / total))}%"


# --------------------------------------------------------------------------- what the orientation saw


@dataclass
class _Shown:
    """One line of a call's output: the call, the forms in which it may be a file's line whole, its pieces as searched
    for (_pieces), and the files it may be a line of: those the call names, by path, folder or wildcard, and those it
    reads a file made from."""

    call: int
    wholes: tuple[bytes, ...]
    pieces: tuple[bytes, ...]
    files: tuple[str, ...]
    direct: frozenset[str] = frozenset()  # of `files`, those the call names by their own path or a wildcard


def _read_shown(row: dict[str, Any], rel: str, reader: str | None) -> set[int]:
    """The lines a Read call's output showed of the file `rel`, by the numbers it gives them; for a PDF its pages."""
    result = str(row.get("result") or "")
    if reader == "pdf":
        inp = row.get("input") if isinstance(row.get("input"), dict) else {}
        pages: set[int] = set()
        for m in _PAGES_RE.finditer(str(inp.get("pages") or "")):
            lo = int(m.group(1))
            pages.update(range(lo, int(m.group(2) or lo) + 1))
        return pages or set(range(1, PDF_PAGES + 1))
    return {int(m.group(1)) for line in result.split("\n") if (m := _NUMBERED_RE.match(line))}


def _pieces(line: str) -> tuple[bytes, ...]:
    """What is searched for of an output line inside a file's lines: its PIECES_PER_LINE longest pieces of PIECE_MIN
    characters or more, cut where JSON escapes or printed columns split a line (_PIECE_SPLIT_RE), each the PIECE_WINDOW
    characters at its middle when longer, so a field printed after another, or cut short, is still found."""
    found = []
    for p in _PIECE_SPLIT_RE.split(line):
        p = p.strip().rstrip(".").strip()  # a value printed cut short ends with ...
        if len(p) >= PIECE_MIN:
            found.append(p)
    out = []
    for p in sorted(found, key=len, reverse=True)[:PIECES_PER_LINE]:
        if len(p) > PIECE_WINDOW:
            mid = (len(p) - PIECE_WINDOW) // 2
            p = p[mid: mid + PIECE_WINDOW]
        out.append(p.encode("ascii"))
    return tuple(out)


def _shown_lines(k: int, text: str, files: set[str], direct: set[str] = frozenset()) -> Iterator[_Shown]:
    """The output lines of call `k` (SEEN_CHARS and SEEN_LINES at most) that may be lines of `files`, of which the call
    names `direct` by their own path."""
    if not files:
        return
    names = tuple(sorted(files))
    direct = frozenset(direct)
    for line in text[:SEEN_CHARS].split("\n")[:SEEN_LINES]:
        line = line.rstrip("\r")
        bare = _LINE_PREFIX_RE.sub("", line, count=1)
        wholes = tuple(dict.fromkeys(x.encode("utf-8", "replace") for x in (line, bare) if len(x.strip()) >= LINE_MIN))
        pieces = _pieces(bare)
        if wholes or pieces:
            yield _Shown(k, wholes, pieces, names, direct)


def _whole_hits(corpus: Path, shown: list[_Shown], sizes: dict[str, int]) -> dict[int, dict[str, int]]:
    """{output line: {file: the number of its first line equal to it}}, each file read once, the smallest first, up to
    LINE_SCAN_BYTES, LINE_SCAN_TOTAL in all, and only until every output line looked for in it was found."""
    wanted: dict[str, dict[bytes, list[int]]] = {}
    for i, s in enumerate(shown):
        for f in s.files:
            for w in s.wholes:
                wanted.setdefault(f, {}).setdefault(w, []).append(i)
    hits: dict[int, dict[str, int]] = {}
    total = LINE_SCAN_TOTAL
    for f in sorted(wanted, key=lambda f: sizes.get(f, 0)):
        lines = wanted[f]
        left = {i for ids in lines.values() for i in ids}
        cap = min(LINE_SCAN_BYTES, total)
        read = 0
        try:
            with open(corpus / f, "rb") as fh:
                for n, raw in enumerate(fh, 1):
                    read += len(raw)
                    ids = lines.get(raw.rstrip(b"\r\n"))
                    if ids:
                        for i in ids:
                            hits.setdefault(i, {}).setdefault(f, n)
                            left.discard(i)
                        if not left:
                            break
                    if read >= cap:
                        break
        except OSError:
            continue
        total -= read
        if total <= 0:
            break
    return hits


def _piece_hits(corpus: Path, wanted: dict[str, set[bytes]], budget: list[int],
                sizes: dict[str, int]) -> dict[tuple[str, bytes], int]:
    """{(file, piece): the offset of its first occurrence in the file} for each piece searched for in each file, the
    smallest file first, within PIECE_SCAN_BYTES of the file and what is left of `budget` (one int, the bytes the
    searches may still go through)."""
    import mmap  # noqa: PLC0415

    out: dict[tuple[str, bytes], int] = {}
    for f in sorted(wanted, key=lambda f: (sizes.get(f, 0), f)):
        if budget[0] <= 0:
            break
        try:
            with open(corpus / f, "rb") as fh:
                size = os.fstat(fh.fileno()).st_size
                if not size:
                    continue
                with mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                    end = min(size, PIECE_SCAN_BYTES)
                    for piece in sorted(wanted[f]):
                        if budget[0] <= 0:
                            break
                        at = mm.find(piece, 0, end)
                        budget[0] -= at + len(piece) if at >= 0 else end
                        if at >= 0:
                            out[(f, piece)] = at
        except (OSError, ValueError):
            continue
    return out


def _outside(text: str, root: Path) -> set[str]:
    """The absolute paths a call's text gives that are outside the corpus `root`, neither the corpus's folder nor one
    above it, nor in SYSTEM_DIRS; normalized, without a trailing slash."""
    top = root.as_posix()
    out: set[str] = set()
    for run in set(_PATH_RE.findall(text)):
        if not run.startswith("/") or run.startswith("//"):
            continue
        p = os.path.normpath(run)
        if p == "/" or _nested(p, top) or any(p == d or p.startswith(d + "/") for d in SYSTEM_DIRS):
            continue
        out.add(p)
    return out


def _nested(a: str, b: str) -> bool:
    """Whether one of two normalized absolute paths is the other or in it."""
    return a == b or a.startswith(b.rstrip("/") + "/") or b.startswith(a.rstrip("/") + "/")


def _line_numbers(path: Path, offsets: set[int]) -> set[int]:
    """The numbers of the lines that hold these byte offsets of a file."""
    out: set[int] = set()
    n, pos = 1, 0
    try:
        with open(path, "rb") as fh:
            for at in sorted(offsets):
                while pos < at:
                    block = fh.read(min(1 << 24, at - pos))
                    if not block:
                        return out
                    n += block.count(b"\n")
                    pos += len(block)
                out.add(n)
    except OSError:
        pass
    return out


def _seen(c: str, corpus: Path, sizes: dict[str, int], chats: set[str]) -> dict[str, set[int]]:
    """{file: the numbers of its lines (a PDF's pages) that the calls made in `chats` showed} (module note): a Read's
    numbered lines, and each output line of any other call, or of a Read outside the corpus, that is, or holds a piece
    of, a line of a file the call names or made the file it reads (a path outside the corpus that a call naming corpus
    files gave, or a saved output of one), found in SHARED_MAX of those files at most."""
    from . import records  # noqa: PLC0415

    files = set(sizes)
    root = corpus.resolve()
    cards = {str(cell.get("id")): [str(r) for r in cell.get("reads") or [] if isinstance(r, str)]
             for cell in _cells(config.workspace_dir(c))}
    seen: dict[str, set[int]] = {}
    shown: list[_Shown] = []
    made: dict[str, set[str]] = {}  # {a path outside the corpus: the corpus files the calls whose input gave it name}
    # (call, its output, files it names, those by their own path or a wildcard, paths outside the corpus it gives)
    rows: list[tuple[int, str, set[str], set[str], set[str]]] = []
    for k, row in enumerate(_own_calls(c, chats)):
        # a call that printed nothing (a script writing a dump) still names the files it made one from
        result = "" if row.get("is_error") or not isinstance(row.get("result"), str) else row["result"]
        name = str(row.get("name") or "").rsplit("__", 1)[-1]
        inp = row.get("input") if isinstance(row.get("input"), dict) else {}
        if name == "Read":
            rel = _corpus_rel(corpus, inp.get("file_path"))
            if rel in files and result:
                seen.setdefault(rel, set()).update(_read_shown(row, rel, records.reader_of(corpus / rel, rel)))
            elif result and not rel:
                rows.append((k, result, set(), set(), _outside(str(inp.get("file_path") or ""), root)))
            continue
        text = json.dumps(inp, ensure_ascii=False, default=str)
        direct: set[str] = set()
        globbed = _globbed(text, files)
        named = _read_by_calls(text, corpus, files, direct) | globbed
        direct |= globbed
        if name in ("add_card", "edit_card"):
            for cid in _CARD_RE.findall(result[:SEEN_CHARS]):
                read = {r for r in cards.get(cid, ()) if r in files}
                named |= read
                direct |= read
        outside = _outside(text, root)
        for p in outside if named else ():
            made.setdefault(p, set()).update(named)
        if result:
            rows.append((k, result, named, direct, outside))
    for k, result, named, direct, outside in rows:
        derived = {f for p, fs in made.items() if any(_nested(p, q) for q in outside) for f in fs} if outside else set()
        for m in _SAVED_RE.finditer(result[:SEEN_CHARS]):
            made.setdefault(os.path.normpath(m.group(1)), set()).update(named | derived)
        shown.extend(_shown_lines(k, result, named | derived, direct))
    whole = _whole_hits(corpus, shown, sizes)
    offsets: dict[str, set[int]] = {}

    def credit(hits: dict[str, int], into: dict[str, set[int]], direct: frozenset[str]) -> bool:
        # a line found in a file the call names by its own path came from there, not from the other files that hold
        # it under a folder the call named (`sqlite3 forge.db "select * from agents"` names agents/ too)
        hits = {f: at for f, at in hits.items() if f in direct} or hits
        if not 1 <= len(hits) <= SHARED_MAX:
            return False
        for f, at in hits.items():
            into.setdefault(f, set()).add(at)
        return True

    left: dict[int, list[int]] = {}  # by call, the output lines no whole line of a file was found for
    for i, s in enumerate(shown):
        if not credit(whole.get(i, {}), seen, s.direct) and s.pieces:
            left.setdefault(s.call, []).append(i)
    todo = []
    for ids in left.values():  # PIECES_PER_CALL of each call's lines, spread over its output
        step = max(1, len(ids) / PIECES_PER_CALL)
        todo.extend(ids[int(j * step)] for j in range(min(len(ids), PIECES_PER_CALL)))
    budget = [PIECE_SCAN_TOTAL]
    for p in range(PIECES_PER_LINE):
        wanted: dict[str, set[bytes]] = {}
        for i in todo:
            if p < len(shown[i].pieces):
                for f in shown[i].files:
                    wanted.setdefault(f, set()).add(shown[i].pieces[p])
        found = _piece_hits(corpus, wanted, budget, sizes)
        todo = [i for i in todo if p < len(shown[i].pieces) and not credit(
            {f: found[(f, shown[i].pieces[p])] for f in shown[i].files if (f, shown[i].pieces[p]) in found}, offsets,
            shown[i].direct)]
    for f, at in offsets.items():
        seen.setdefault(f, set()).update(_line_numbers(corpus / f, at))
    return seen


def coverage(c: str, chat: str) -> Finding:
    """The coverage line of the orientation chat `chat` in workspace `c` (module note): the files whose lines or
    records the calls of it and the chats under it showed (_seen), grouped by glob: each glob whose every file it
    viewed, a file alone in its glob, and of a glob it viewed in part, its viewed files when they are COVERAGE_NAMED or
    fewer, else the glob with how many of its files; then the share of the files viewed and of their lines (records
    when a file is not read by lines). ValueError for a workspace whose corpus is gone."""
    from . import corpus as corpus_mod, records  # noqa: PLC0415
    from .tools import hint  # noqa: PLC0415

    corpus = config.corpus_dir(c)
    sizes = {s["path"]: int(s.get("size_bytes") or 0) for s in corpus_mod.list_sources(corpus) if not s.get("hidden")}
    files = list(sizes)
    seen = _seen(c, corpus, sizes, _orientation_chats(c, chat))
    counts, estimated = _records_of(corpus, sizes)
    viewed = [f for f in files if seen.get(f)]
    shares = hint("orient-coverage-files", files=_share(len(viewed), len(files)))
    if sum(counts.values()):
        lines = all(records.reader_of(corpus / f, f) in LINE_READERS for f in files if counts.get(f))
        part = ("~" if estimated else "") + _share(sum(min(len(seen[f]), counts.get(f, 0)) for f in viewed),
                                                   sum(counts.values()))
        shares = hint("orient-coverage-shares", files=_share(len(viewed), len(files)), share=part,
                      measure="lines" if lines else "records")
    if not viewed:
        return Finding("coverage", hint("orient-coverage-nothing", shares=shares))
    if len(viewed) == len(files):
        return Finding("coverage", hint("orient-coverage-every", shares=shares))
    groups: dict[str, list[str]] = {}
    for f in files:
        groups.setdefault(_glob(f), []).append(f)
    if len(groups) > COVERAGE_GLOBS:
        groups = {}
        for f in files:
            groups.setdefault(_glob(f, top=True), []).append(f)

    def files_word(n: int) -> str:
        return f"{n:,} file" if n == 1 else f"{n:,} files"

    side: list[tuple[int, str]] = []  # (records, name) of each viewed group, listed the most records first
    for g, fs in groups.items():
        opened = [f for f in fs if seen.get(f)]
        if not opened:
            continue
        if len(opened) == len(fs):
            side.append((sum(counts.get(f, 0) for f in fs), fs[0] if len(fs) == 1 else g))
        elif len(opened) <= COVERAGE_NAMED:
            side.extend((counts.get(f, 0), f) for f in opened)
        else:
            side.append((sum(counts.get(f, 0) for f in opened), f"{g} ({len(opened):,} of {files_word(len(fs))})"))
    names = [name for _, name in sorted(side, key=lambda x: (-x[0], x[1]))]
    listed = ", ".join(names[:COVERAGE_LISTED])
    if len(names) > COVERAGE_LISTED:
        listed += f", and {len(names) - COVERAGE_LISTED:,} more"
    return Finding("coverage", hint("orient-coverage", viewed=listed, shares=shares))


def child_argv(c: str, *flags: str) -> list[str]:
    """The command of check_apart's child for workspace `c` (a test replaces it with a child that only waits)."""
    return [sys.executable, "-m", "app.orient_checks", c, *flags]


async def check_apart(c: str, timeout_s: float = CHECK_TIMEOUT_S, coverage_of: str | None = None,
                      only: bool = False) -> list[Finding]:
    """check(c, coverage_of), or with `only` the coverage line of the orientation chat `coverage_of` alone, run in a
    child process that reads the same workspaces and registry folders as the server. ValueError as check raises it,
    TimeoutError past `timeout_s`, RuntimeError otherwise. The child is killed whenever it is still running as this
    returns, including when the caller is cancelled. It is started with Popen and polled, writing into temporary files,
    rather than through asyncio's subprocess transport, whose start, when cancelled as the event loop closes (the
    server's stop just as an orientation ends), leaves the loop waiting for good."""
    env = {**os.environ, "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR), "THIMBLE_DATA_DIR": str(config.DATA_DIR)}
    flags = [COVERAGE_FLAG, coverage_of, *([ONLY_FLAG] if only else [])] if coverage_of else []
    argv = child_argv(c, *flags)
    with tempfile.TemporaryFile() as out_f, tempfile.TemporaryFile() as err_f:
        try:
            proc = subprocess.Popen(argv, cwd=str(BACKEND_DIR), env=env, stdin=subprocess.DEVNULL, stdout=out_f,
                                    stderr=err_f)
        except OSError as e:
            raise RuntimeError(f"the coverage checks did not start: {e}") from e
        try:
            deadline = time.monotonic() + timeout_s
            while proc.poll() is None:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"the coverage checks ran past {timeout_s:.0f} s")
                await asyncio.sleep(CHILD_POLL_S)
        finally:
            if proc.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                proc.wait()
        out_f.seek(0)
        err_f.seek(0)
        out, stderr = out_f.read(), err_f.read().decode("utf-8", "replace")
    last = (stderr.strip().splitlines() or [""])[-1]
    if proc.returncode == 2:
        raise ValueError(last)
    try:
        rows = json.loads(out) if proc.returncode == 0 else None
    except ValueError:
        rows = None
    if not isinstance(rows, list):
        raise RuntimeError(f"the coverage checks failed (exit {proc.returncode}): {last}")
    return [Finding(str(r["check"]), str(r["text"])) for r in rows]


def main(argv: list[str]) -> int:
    """`python -m app.orient_checks <workspace> [--coverage <orientation chat> [--only]]`, check_apart's child: the
    findings as a JSON list on stdout, or exit 2 with the reason on stderr for a workspace whose corpus is gone."""
    rest = argv[1:]
    chat = rest[rest.index(COVERAGE_FLAG) + 1] if COVERAGE_FLAG in rest[:-1] else None
    try:
        found = [coverage(argv[0], chat)] if chat and ONLY_FLAG in rest else check(argv[0], chat)
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2
    print(json.dumps([dataclasses.asdict(f) for f in found], ensure_ascii=False))
    return 0


def text(found: list[Finding]) -> str:
    """The findings one line each, or the line that says there are none, as the critique's first message shows them."""
    from . import tools  # noqa: PLC0415

    return "\n".join(f"- {f.text}" for f in found) if found else tools.hint("check-none")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
