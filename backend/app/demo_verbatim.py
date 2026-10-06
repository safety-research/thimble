"""How much of a corpus's own text a file copies, for `thimble demo --export` (demo.py), in the standard library alone.

A pre-cache goes into the public repository, while the datasets it was made on are fetched from their publishers and
not redistributed. Cards and the report quote the records they cite, which is what they are for, but nothing in a
pre-cache may carry long stretches of a record. This module finds those stretches.

The text compared. Every string value of a JSON or JSONL file (a record, a card, a label's row), so the comparison
does not depend on how either side escaped or indented it, and the whole of any other text file (a CSV file is one
string), each with its runs of white space collapsed to one space. A string shorter than WINDOW cannot match and is
skipped. Files that are not text (PDFs, pictures) are not indexed.

The index. Corpus(folder) hashes the WINDOW characters at every STRIDE-th position of every corpus string. A file's
text is then hashed at every position, and the windows found in the index are merged where they overlap. Any stretch
the two share of WINDOW + STRIDE - 1 characters or more holds an indexed window, so it is found; its measured length
can fall short of the true one by up to STRIDE - 1 characters at each end. The hashes are Python's 64-bit string
hashes, made in one process, so a false match is not a practical concern.

The threshold. A stretch measured at LONG characters or more is a long verbatim run, and the export refuses a file
that holds one. Every stretch of LONG + 2 * (STRIDE - 1) characters is refused; one between LONG and that may measure
short and pass. LONG is 400 characters, about 70 words: across the cards, documents, label values and views of nine
finished orientations (three each of collusion-wiki, mythos-5 and rubyhack, 2026-10-05) the longest stretch shared
with the corpus measured 105 characters, while the orientations' conversations and work files shared stretches of
thousands (demos/README.md).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator

WINDOW = 64
STRIDE = 32
LONG = 400  # characters; a stretch measured this long is refused (module note)
TEXT_SUFFIXES = (".json", ".jsonl", ".md", ".txt", ".csv", ".tsv", ".html", ".htm", ".xml", ".yaml", ".yml", ".py",
                 ".js", ".log", ".vtt", ".srt")
_WS = re.compile(r"\s+")


def _norm(s: str) -> str:
    return _WS.sub(" ", s).strip()


def _strings(value: Any) -> Iterator[str]:
    """Every string in a JSON value, keys included."""
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            yield v
        elif isinstance(v, dict):
            stack.extend(v.keys())
            stack.extend(v.values())
        elif isinstance(v, list):
            stack.extend(v)


def segments(name: str, text: str) -> Iterator[str]:
    """The normalized strings of a file's text: a JSON or JSONL file's string values (a line that is not JSON as
    itself), else the whole text."""
    low = name.lower()
    if low.endswith(".jsonl"):
        for line in text.split("\n"):  # not splitlines(): records hold U+2028
            if not line.strip():
                continue
            try:
                yield from (_norm(s) for s in _strings(json.loads(line)))
            except ValueError:
                yield _norm(line)
        return
    if low.endswith(".json"):
        try:
            yield from (_norm(s) for s in _strings(json.loads(text)))
            return
        except ValueError:
            pass
    yield _norm(text)


class Corpus:
    """The index of a corpus folder's text (module note): every text file under it, hidden ones left out."""

    def __init__(self, folder: Path | None = None, files: Iterable[tuple[str, str]] = ()) -> None:
        self.index: set[int] = set()
        self.chars = 0
        self.files = 0
        if folder is not None:
            for p in sorted(folder.rglob("*")):
                rel = p.relative_to(folder)
                if p.is_file() and not any(x.startswith(".") for x in rel.parts) and p.suffix.lower() in TEXT_SUFFIXES:
                    self.add(rel.as_posix(), p.read_bytes().decode("utf-8", "replace"))
        for name, text in files:
            self.add(name, text)

    def add(self, name: str, text: str) -> None:
        self.files += 1
        for s in segments(name, text):
            n = len(s)
            if n < WINDOW:
                continue
            self.chars += n
            self.index.update(hash(s[i:i + WINDOW]) for i in range(0, n - WINDOW + 1, STRIDE))


@dataclass
class Found:
    """The shared stretches of one file: the longest, how many reach LONG and how many characters they hold, how many
    characters all of them hold, and the start of the longest."""
    longest: int = 0
    long_runs: int = 0
    long_chars: int = 0
    shared: int = 0
    sample: str = ""


def runs(corpus: Corpus, s: str) -> list[tuple[int, int]]:
    """The stretches of the normalized string `s` the corpus holds, as (start, end), merged where they overlap."""
    out: list[tuple[int, int]] = []
    index = corpus.index
    for i in range(0, len(s) - WINDOW + 1):
        if hash(s[i:i + WINDOW]) in index:
            if out and i <= out[-1][1]:
                out[-1] = (out[-1][0], i + WINDOW)
            else:
                out.append((i, i + WINDOW))
    return out


def scan(corpus: Corpus, name: str, text: str, long: int = LONG) -> Found:
    """What file `name` with `text` shares with the corpus (Found)."""
    found = Found()
    if not corpus.index:
        return found
    for s in segments(name, text):
        if len(s) < WINDOW:
            continue
        for a, b in runs(corpus, s):
            n = b - a
            found.shared += n
            if n > found.longest:
                found.longest, found.sample = n, s[a:a + 80]
            if n >= long:
                found.long_runs += 1
                found.long_chars += n
    return found
