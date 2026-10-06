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

The coverage line says how much of the corpus one orientation opened, grouped by glob, with its share of the files and
of the records they hold: `Coverage: viewed board.jsonl, agents/agent-01.jsonl · not viewed agents/*.jsonl (2 of 3
files), *.md (2 files) · 33% of 6 files, holding 41% of the records`. It is the unread check made stricter and kept to the orientation: only the orientation's chat
and the chats under it (its subagents' and workflow agents', never a critique's) count, with the cards of its deck and
the input of its calls alone, since a survey's listing names every file without opening one; and a folder counts only
where a command names it whole or by a wildcard, since reading one file of a folder opens none of the others. The
orientation's end adds it to its transcript (orient_session.measure), and a critique's first message gives it in place
of the unread line. A file's records are records.count's, estimated from its bytes past COUNT_BYTES (`~`), and the
bytes stand in when no file holds records.
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
from datetime import datetime, timezone
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
CRITIC = "critic"  # a critique's chat's agent_type (critique_session.AGENT, which imports this module)
BACKEND_DIR = Path(__file__).resolve().parent.parent  # where `python -m app.orient_checks` runs (check_apart)
COVERAGE_FLAG = "--coverage"  # the child adds the coverage line of the orientation chat named next (coverage)
ONLY_FLAG = "--only"  # with COVERAGE_FLAG, the child computes the coverage line alone
COVERAGE_GLOBS = 8  # globs of folder and suffix the coverage line groups files into; past this, by top folder
COVERAGE_LISTED = 6  # globs the coverage line names on each side, viewed and not viewed; the rest are counted
COVERAGE_NAMED = 2  # a glob with this few files viewed has them named, and the rest of it named as not viewed
COUNT_BYTES = 500_000_000  # of files whose records the coverage line counts; the rest are estimated from their bytes
_DIGITS_RE = re.compile(r"\d+")
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")
_HEX_ID_RE = re.compile(r"(?=.*\d)[0-9a-f]{3,}", re.I)  # a whole token of hex digits, at least one of them a digit
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")  # the characters of a whole word, as _Text.names bounds one
_PATH_RE = re.compile(r"[\w./-]+")  # the characters a path is written with, as _read_by_calls splits the text
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


def _read_by_agents(c: str, corpus: Path, chats: "set[str] | None" = None) -> set[str]:
    """The corpus files a Read call opened in any chat of the workspace but a critique's, or in `chats` alone. A file
    only a critic opened is still one the analysis never read."""
    from . import agents  # noqa: PLC0415

    root = corpus.resolve()
    out: set[str] = set()
    for meta in agents.list_chats(c):
        if meta.get("agent_type") == CRITIC or (chats is not None and str(meta.get("id")) not in chats):
            continue
        _, log_path = agents.paths(c, str(meta["id"]))
        for rec in agents.read_events(log_path):
            if rec.get("type") != "tool_use" or rec.get("name") not in READ_TOOLS:
                continue
            inp = rec.get("input") if isinstance(rec.get("input"), dict) else {}
            raw = str(inp.get("file_path") or "").strip()
            if not raw:
                continue
            p = Path(raw) if os.path.isabs(raw) else root / raw
            try:
                out.add(p.resolve().relative_to(root).as_posix())
            except (OSError, ValueError):
                continue
    return out


def _calls_text(c: str, results: bool = True, chats: "set[str] | None" = None) -> str:
    """The input and output (only the input without `results`) of every stored call of the workspace's orientations
    (calls.py), each cut to CALL_TEXT_CHARS, together up to CALLS_TEXT_CHARS; a critic's own calls are left out, as its
    Reads are. With `chats`, only the calls made in those chats (or in a chat not yet known) are read."""
    from . import calls  # noqa: PLC0415

    ws = config.workspace_dir(c)
    folder = ws / calls.CALLS_DIR
    parts: list[str] = []
    total = 0
    critics = _critic_chats(c) if folder.is_dir() else set()
    for path in sorted(folder.glob("*.jsonl")) if folder.is_dir() else []:
        chat = path.stem
        if chats is not None and chat not in chats:
            continue
        for row in calls.listing(c, chat):
            if row.get("chat") in critics or (chats is not None and row.get("chat") and row["chat"] not in chats):
                continue
            full = calls.get(c, chat, int(row["n"])) or {}
            text = json.dumps(full.get("input"), ensure_ascii=False, default=str)
            text += "\n" + str(full.get("result") or "") if results else ""
            text = text[:CALL_TEXT_CHARS]
            parts.append(text)
            total += len(text)
            if total > CALLS_TEXT_CHARS:
                return "\n".join(parts)
    return "\n".join(parts)


def _critic_chats(c: str) -> set[str]:
    from . import agents  # noqa: PLC0415

    return {str(m["id"]) for m in agents.list_chats(c) if m.get("agent_type") == CRITIC}


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


def _deck_cells(c: str) -> list[dict[str, Any]]:
    """The cards of the latest orientation's deck, where every card it adds goes, that it made or changed: an earlier
    orientation's card in the same deck counts only once this one edited it. None when its deck is off."""
    from . import notebook, orientation  # noqa: PLC0415

    run = orientation.read_run(c) or {}
    deck = orientation.deck_of(run)
    nb = notebook.read_notebook(config.workspace_dir(c), deck) if deck else None
    since = str(run.get("started") or "")

    def touched(cell: dict[str, Any]) -> bool:
        stamps = [cell.get("created_ts") or cell.get("ts"), *(e.get("ts") for e in cell.get("edited") or []
                                                              if isinstance(e, dict))]
        return not since or any(_after(t, since) for t in stamps)

    return [cell for cell in (nb or {}).get("cells") or [] if isinstance(cell, dict) and touched(cell)]


def _after(ts: Any, since: str) -> bool:
    """Whether the ISO time `ts` is at or after `since`; a time that does not parse counts."""

    def at(v: Any) -> datetime | None:
        try:
            t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            return None
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)

    t, s = at(ts), at(since)
    return t is None or s is None or t >= s


def _read_by_calls(text: str, corpus: Path, files: set[str], whole: bool = False) -> set[str]:
    """The corpus files the orientation's calls named: a file by its corpus-relative or absolute path filling whole
    components of a run of path characters, and every file under a folder named the same way. With `whole`, a folder
    is named only where a run holding a slash ends at it (`ls tickets/`, `tickets/*.txt`, `ls <corpus>/tickets`), not
    where it leads a file's path, so reading one file of a folder leaves the others unread, nor as a bare word, which
    prose holds too; and a wildcard pattern names the files it matches (_globbed). A path holding other characters (a
    space) is searched for in the whole text instead."""
    if not text:
        return set()
    root = str(corpus.resolve()).rstrip("/") + "/"
    text = text.replace(root, "/" if whole else "")  # with `whole`, a path from the corpus keeps a slash
    depth = max((f.count("/") + 1 for f in files), default=1)
    heads: set[str] = set()  # the leading components of each run (trailing with `whole`), where a folder can be named
    spans: set[str] = set()  # each sequence of up to `depth` whole components of a run, where a file can be named
    for run in set(_PATH_RE.findall(text)):
        if whole:
            parts = run.rstrip("/").split("/") if "/" in run else []
            heads.update("/".join(parts[i:]) for i in range(len(parts)))
        else:
            parts = run.split("/")
            heads.update("/".join(parts[:j]) for j in range(1, min(len(parts), depth) + 1))
        for r in {run, run.rstrip(".")}:  # a path at the end of a sentence is still named
            parts = r.split("/")
            for i in range(len(parts)):
                spans.update("/".join(parts[i:j]) for j in range(i + 1, min(len(parts), i + depth) + 1))

    def plain(path: str) -> bool:
        return _PATH_RE.fullmatch(path) is not None

    out = {f for f in files if (f in spans if plain(f) else f in text)}
    folders = {os.path.dirname(f) for f in files} - {""}

    def spaced(d: str) -> str:  # the regex of a folder whose name holds a space, named as `whole` or not asks
        e = re.escape(d)
        return rf"/{e}/?(?![\w./-])|(?<![\w./-]){e}/(?![\w.-])" if whole else rf"(?<![\w./-]){e}(?:/|(?![\w.-]))"

    named = {d for d in folders if (d in heads if plain(d) else re.search(spaced(d), text))}
    for f in files:
        parts = f.split("/")
        if any("/".join(parts[:i]) in named for i in range(1, len(parts))):
            out.add(f)
    return out | _globbed(text, files) if whole else out


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


def _unread_files(c: str, corpus: Path, files: list[str], cells: list[dict[str, Any]], calls_text: str = "",
                  whole: bool = False, chats: "set[str] | None" = None) -> list[str]:
    fileset = set(files)
    return sorted(fileset - _read_by_cells(cells, fileset) - _read_by_agents(c, corpus, chats)
                  - _read_by_calls(calls_text, corpus, fileset, whole))


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
    """n of total as a whole percentage, 100% only when it is all and 0% only when it is none."""
    if total <= 0 or n <= 0:
        return "0%"
    if n >= total:
        return "100%"
    return f"{min(99, max(1, round(100 * n / total)))}%"


def coverage(c: str, chat: str) -> Finding:
    """The coverage line of the orientation chat `chat` in workspace `c` (module note): the corpus files no card of its
    deck read, no Read call of it or the chats under it opened and no call's input named, by its path or its folder's
    whole, grouped by glob: each glob it viewed whole, each it never viewed with its count of files, and of a glob it
    viewed in part, the files it viewed and the rest of the glob when they are COVERAGE_NAMED or fewer, else the glob
    with how many of its files; then the share of the files viewed and of the records they hold (of their bytes when
    no file holds records). ValueError for a workspace whose corpus is gone."""
    from . import corpus as corpus_mod  # noqa: PLC0415
    from .tools import hint  # noqa: PLC0415

    corpus = config.corpus_dir(c)
    sizes = {s["path"]: int(s.get("size_bytes") or 0) for s in corpus_mod.list_sources(corpus) if not s.get("hidden")}
    files = list(sizes)
    own = _orientation_chats(c, chat)
    unread = set(_unread_files(c, corpus, files, _deck_cells(c), _calls_text(c, results=False, chats=own),
                               whole=True, chats=own))
    counts, estimated = _records_of(corpus, sizes)
    weight = counts if sum(counts.values()) else sizes
    measure = "records" if weight is counts else "bytes"
    viewed = [f for f in files if f not in unread]

    def files_word(n: int) -> str:
        return f"{n:,} file" if n == 1 else f"{n:,} files"

    total = files_word(len(files))
    files_share = _share(len(viewed), len(files))
    part_share = ("~" if estimated and measure == "records" else "") + _share(sum(weight[f] for f in viewed),
                                                                              sum(weight.values()))
    if not unread:
        return Finding("coverage", hint("orient-coverage-every", total=total, measure=measure))
    groups: dict[str, list[str]] = {}
    for f in files:
        groups.setdefault(_glob(f), []).append(f)
    if len(groups) > COVERAGE_GLOBS:
        groups = {}
        for f in files:
            groups.setdefault(_glob(f, top=True), []).append(f)
    seen: list[tuple[int, str]] = []  # (weight, name) of each side, listed the heaviest first
    unseen: list[tuple[int, str]] = []
    for g, fs in groups.items():
        opened = [f for f in fs if f not in unread]
        rest = [f for f in fs if f in unread]
        if not rest:
            seen.append((sum(weight[f] for f in fs), fs[0] if len(fs) == 1 else g))
        elif not opened:
            unseen.append((sum(weight[f] for f in fs), fs[0] if len(fs) == 1 else f"{g} ({files_word(len(fs))})"))
        elif len(opened) <= COVERAGE_NAMED:  # a few files of a glob viewed: those files, and the rest of the glob
            seen.extend((weight[f], f) for f in opened)
            unseen.append((sum(weight[f] for f in rest),
                           rest[0] if len(rest) == 1 else f"{g} ({len(rest):,} of {files_word(len(fs))})"))
        else:
            seen.append((sum(weight[f] for f in opened), f"{g} ({len(opened):,} of {files_word(len(fs))})"))

    def listed(side: "list[tuple[int, str]]") -> str:
        names = [name for _, name in sorted(side, key=lambda x: (-x[0], x[1]))]
        if len(names) <= COVERAGE_LISTED:
            return ", ".join(names)
        return ", ".join(names[:COVERAGE_LISTED]) + f", and {len(names) - COVERAGE_LISTED:,} more"

    return Finding("coverage", hint("orient-coverage", viewed=listed(seen) if seen else hint("orient-coverage-nothing"),
                                    unviewed=listed(unseen), files=files_share, total=total, records=part_share,
                                    measure=measure))


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
