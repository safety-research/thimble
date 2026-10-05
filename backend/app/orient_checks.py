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

The orientation itself hears of the files it never opened, at its first card and when it asks for its critique
(orient_session.coverage). That check, `unopened`, reads only the calls' input, since a survey's listing names every
file without opening one; a folder counts only where a command names it whole or by a wildcard, since reading one file
of a folder opens none of the others. It names each file with its records and its share of the corpus.
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
import sys
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
JSONL_SUFFIXES = (".jsonl", ".ndjson")
READ_TOOLS = ("Read",)  # a Grep or Glob call searches or lists a file without reading it
UNREAD_LISTED = 12  # unread files named one by one; past this, by kind of file with a count
RECORDS_MAX_BYTES = 200_000_000  # an unopened file past this size gives its size: its records take long to count
UNUSED_PER_KIND = 5  # unused fields and values named per kind of file, the most filled first
UNUSED_LISTED = 20
CALL_TEXT_CHARS = 200_000  # of one call's input and output read for the checks
CALLS_TEXT_CHARS = 30_000_000  # of every call's, together
CRITIC = "critic"  # a critique's chat's agent_type (critique_session.AGENT, which imports this module)
BACKEND_DIR = Path(__file__).resolve().parent.parent  # where `python -m app.orient_checks` runs (check_apart)
UNOPENED_FLAG = "--unopened"  # the child computes unopened rather than check
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


def _read_by_agents(c: str, corpus: Path) -> set[str]:
    """The corpus files a Read call opened in any chat of the workspace but a critique's. A file only a critic opened is
    still one the analysis never read."""
    from . import agents  # noqa: PLC0415

    root = corpus.resolve()
    out: set[str] = set()
    for meta in agents.list_chats(c):
        if meta.get("agent_type") == CRITIC:
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


def _calls_text(c: str, results: bool = True) -> str:
    """The input and output (only the input without `results`) of every stored call of the workspace's orientations
    (calls.py), each cut to CALL_TEXT_CHARS, together up to CALLS_TEXT_CHARS; a critic's own calls are left out, as its
    Reads are."""
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
                  whole: bool = False) -> list[str]:
    fileset = set(files)
    return sorted(fileset - _read_by_cells(cells, fileset) - _read_by_agents(c, corpus)
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


def check(c: str) -> list[Finding]:
    """The coverage findings for workspace `c`: the corpus files nothing opened, then the unused fields and record kinds
    of the opened files. ValueError for a workspace whose corpus is gone."""
    from . import corpus as corpus_mod  # noqa: PLC0415

    ws = config.workspace_dir(c)
    corpus = config.corpus_dir(c)
    files = [s["path"] for s in corpus_mod.list_sources(corpus) if not s.get("hidden")]
    cells = _cells(ws)
    calls_text = _calls_text(c)
    unread = _unread_files(c, corpus, files, cells, calls_text)
    opened = set(files) - set(unread)
    return _unread(unread, files) + _unused(corpus, [f for f in files if f in opened], cells, calls_text)


def unopened(c: str) -> list[Finding]:
    """The orientation's coverage note for workspace `c` (orient_session.coverage), one finding or none: the corpus
    files no card read, no Read call opened and no call's input named, by its path or its folder's whole, the largest
    first, each with its records (its size past RECORDS_MAX_BYTES) and its share of the corpus's bytes; past
    UNREAD_LISTED files, each kind of file with its count and share (a kind of one file as that file). ValueError for a
    workspace whose corpus is gone."""
    from . import corpus as corpus_mod, records  # noqa: PLC0415
    from .tools import hint  # noqa: PLC0415

    corpus = config.corpus_dir(c)
    sizes = {s["path"]: int(s.get("size_bytes") or 0) for s in corpus_mod.list_sources(corpus) if not s.get("hidden")}
    files = list(sizes)
    unread = _unread_files(c, corpus, files, _cells(config.workspace_dir(c)), _calls_text(c, results=False), whole=True)
    if not unread:
        return []
    total = sum(sizes.values()) or 1

    def share(n: int) -> str:
        return f"{n / total:.0%} of the corpus" if n >= total / 100 else "under 1% of the corpus"

    def row(f: str) -> str:
        n = records.count(corpus / f, f) if sizes[f] <= RECORDS_MAX_BYTES else 0
        return f"- `{f}`: {f'{n:,} records' if n else f'{sizes[f] / 1e6:,.1f} MB'}, {share(sizes[f])}"

    if len(unread) <= UNREAD_LISTED:
        rows = [row(f) for f in sorted(unread, key=lambda f: -sizes[f])]
    else:
        kinds: dict[str, list[str]] = {}
        for f in unread:
            kinds.setdefault(_kind_key(f).replace("#", "*"), []).append(f)
        ranked = sorted(kinds.items(), key=lambda kv: -sum(sizes[f] for f in kv[1]))
        rows = [row(fs[0]) if len(fs) == 1 else f"- `{k}`: {len(fs):,} files, {share(sum(sizes[f] for f in fs))}"
                for k, fs in ranked[:UNREAD_LISTED]]
        if len(ranked) > UNREAD_LISTED:
            rows.append(f"- {len(ranked) - UNREAD_LISTED:,} more kinds of file")
    return [Finding("unopened", hint("orient-unopened", n=f"{len(unread):,}", total=f"{len(files):,}", root=str(corpus),
                                     files="\n".join(rows)))]


def child_argv(c: str, *flags: str) -> list[str]:
    """The command of check_apart's child for workspace `c` (a test replaces it with a child that only waits)."""
    return [sys.executable, "-m", "app.orient_checks", c, *flags]


async def check_apart(c: str, timeout_s: float = CHECK_TIMEOUT_S, only_unopened: bool = False) -> list[Finding]:
    """check(c), or unopened(c) with `only_unopened`, run in a child process that reads the same workspaces and registry
    folders as the server. ValueError as check raises it, TimeoutError past `timeout_s`, RuntimeError otherwise. The
    child is killed whenever it is still running as this returns, including when the caller is cancelled."""
    env = {**os.environ, "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR), "THIMBLE_DATA_DIR": str(config.DATA_DIR)}
    argv = child_argv(c, UNOPENED_FLAG) if only_unopened else child_argv(c)
    proc = await asyncio.create_subprocess_exec(*argv, cwd=str(BACKEND_DIR), env=env,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout_s)
    except TimeoutError as e:
        raise TimeoutError(f"the coverage checks ran past {timeout_s:.0f} s") from e
    finally:
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
    stderr = err.decode("utf-8", "replace")
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
    """`python -m app.orient_checks <workspace> [--unopened]`, check_apart's child: the findings as a JSON list on
    stdout, or exit 2 with the reason on stderr for a workspace whose corpus is gone."""
    try:
        found = unopened(argv[0]) if UNOPENED_FLAG in argv[1:] else check(argv[0])
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
