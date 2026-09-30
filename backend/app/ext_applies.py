"""Whether an extension applies to a workspace's corpus, as one quick model call decides it (decide).

An extension's `applies` says in plain words which corpora it is for. thimble sends that description, the corpus's files
folded into patterns (groups) and a few records of the files likeliest to hold what it reads (samples) to the labels
role's model at its effort (low unless thimble's config sets another), as one structured call on the user's own
`claude` with no tools (model.structured). The answer is {applies, claims, reason}: whether it applies, the files or
patterns of the listing that hold those records, and one sentence the analyst reads in Settings. Only the claims that
match files here are kept, and an answer that says it applies and claims none is a failure.

A call that fails decides nothing: the extension stays off here, and the reason says why."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from . import capture, config, prompts, views

log = logging.getLogger("thimble.ext_applies")

PROMPT = "extension-applies"
FOLD = 3  # sibling folders, or file names, of one shape that are folded into one pattern from this many
MANY = 12  # names of one extension in a folder pattern past which they are all folded into `*<ext>`
GROUPS_MAX = 150  # lines of the file listing
SAMPLE_FILES = 6  # files the samples come from
SPREAD = (0.2, 0.4, 0.6, 0.8)  # where in a longer file its further samples are taken, past its first two records
RECORD_CHARS = 300  # of each record
HEAD_BYTES = 64 * 1024  # of a file read for its first records
RECORD_EXTS = (".jsonl", ".ndjson", ".csv", ".tsv", ".json")  # files of records, sampled before any other
TEXT_EXTS = (".log", ".txt", ".md", ".html", ".xml", ".yaml", ".yml")

TOOL_NAME = "decision"
SCHEMA = {
    "type": "object",
    "properties": {
        "applies": {"type": "boolean", "description": "whether the records show what the extension is for"},
        "claims": {"type": "array", "items": {"type": "string"},
                   "description": "the files or patterns of the listing, as it writes them, that hold those records; "
                                  "[] when none do"},
        "reason": {"type": "string", "description": "one sentence naming what in the records decided it"},
    },
    "required": ["applies", "claims", "reason"],
    "additionalProperties": False,
}


def files_of(c: str) -> list[tuple[str, int]]:
    """(corpus-relative path, size) of every file of the corpus, dot-files left out (views.folder_files)."""
    return [(p, size) for p, size, _ in views.folder_files(config.corpus_dir(c), "")]


def key(description: str, first: list[str], files: list[tuple[str, int]]) -> str:
    """What a decision is made from, as a digest: the description, the files a pre-check named, and the corpus's files
    with their sizes. A decision is made again when it changes."""
    h = hashlib.sha1(description.encode())
    h.update(json.dumps(sorted(first)).encode())
    for p, size in files:
        h.update(f"\0{p}\0{size}".encode())
    return h.hexdigest()[:16]


def _shape(name: str) -> str:
    return re.sub(r"\d+", "#", name)


def groups(files: list[tuple[str, int]]) -> list[dict[str, Any]]:
    """The files folded into patterns, by path. FOLD or more sibling folders whose names differ only in their digits,
    or that hold the same names, become `*`, as runs of one experiment do; FOLD or more names in a folder pattern that
    differ only in their digits become one name with `*` for the digits, and past MANY other names of one extension
    those become `*<ext>`. Each {pattern, n, bytes, largest}."""
    children: dict[str, set[str]] = {}
    for path, _ in files:
        parts = path.split("/")
        for i in range(len(parts)):
            children.setdefault("/".join(parts[:i]), set()).add(parts[i])
    folded: set[str] = set()
    for parent, kids in children.items():
        dirs = [k for k in kids if f"{parent}/{k}".lstrip("/") in children]
        for key in (_shape, lambda k: frozenset(_shape(x) for x in children[f"{parent}/{k}".lstrip("/")])):
            by: dict[Any, list[str]] = {}
            for k in dirs:
                by.setdefault(key(k), []).append(k)
            folded |= {f"{parent}/{k}".lstrip("/") for ks in by.values() if len(ks) >= FOLD for k in ks}
    placed, names = [], {}
    for path, size in files:
        parts = path.split("/")
        folder = "/".join("*" if "/".join(parts[: i + 1]) in folded else p for i, p in enumerate(parts[:-1]))
        ext = PurePosixPath(parts[-1]).suffix.lower()
        names.setdefault((folder, ext), set()).add(parts[-1])
        placed.append((path, size, folder, ext, parts[-1]))
    out: dict[str, dict[str, Any]] = {}
    for path, size, folder, ext, name in placed:
        mine = names[(folder, ext)]
        alike = lambda x: sum(_shape(y) == _shape(x) for y in mine) >= FOLD  # noqa: E731
        if alike(name):
            leaf = re.sub(r"\d+", "*", name)
        elif sum(not alike(x) for x in mine) > MANY:
            leaf = f"*{ext}"
        else:
            leaf = name
        pattern = f"{folder}/{leaf}" if folder else leaf
        g = out.setdefault(pattern, {"pattern": pattern, "n": 0, "bytes": 0, "largest": path, "top": -1})
        g["n"] += 1
        g["bytes"] += size
        if size > g["top"]:
            g["top"], g["largest"] = size, path
    return [{k: v for k, v in g.items() if k != "top"} for _, g in sorted(out.items())]


def _size(n: int) -> str:
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,} {unit}" if unit == "bytes" else f"{n:,.1f} {unit}"
        n /= 1024
    return f"{n:,.1f} GB"


def listing(gs: list[dict[str, Any]]) -> str:
    """The file listing the prompt shows: a line per pattern with its files and size, GROUPS_MAX at most."""
    lines = [f"{g['pattern']}  {g['n']:,} files, {_size(g['bytes'])}" if g["n"] > 1 else f"{g['pattern']}  {_size(g['bytes'])}"
             for g in gs[:GROUPS_MAX]]
    if len(gs) > GROUPS_MAX:
        lines.append(f"… and {len(gs) - GROUPS_MAX:,} more patterns")
    return "\n".join(lines) or "(no files)"


def _likeliest(gs: list[dict[str, Any]], first: list[str]) -> list[dict[str, Any]]:
    """The patterns the samples come from: those holding the files a pre-check named, then files of records, then text,
    each largest first."""
    def rank(g: dict[str, Any]) -> tuple[int, int]:
        named = any(views.glob_matches(g["largest"], f) for f in first)
        ext = PurePosixPath(g["largest"]).suffix.lower()
        kind = 0 if named else 1 if ext in RECORD_EXTS else 2 if ext in TEXT_EXTS else 3
        return kind, -g["bytes"]

    return [g for g in sorted(gs, key=rank) if rank(g)[0] < 3][:SAMPLE_FILES]


def _cut(line: str) -> str:
    line = " ".join(line.split())
    return line if len(line) <= RECORD_CHARS else line[:RECORD_CHARS] + f"… ({len(line):,} characters)"


def _records(path: Path) -> list[tuple[str, str]]:
    """A few records of one file as (where, text): its first two lines and, in a file longer than HEAD_BYTES, one at
    each point of SPREAD, or the start of a JSON document; [] for a file that is binary or cannot be read."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            head = f.read(HEAD_BYTES)
            if b"\0" in head[:4096]:
                return []
            if path.suffix.lower() == ".json":
                return [("start", _cut(head.decode("utf-8", "replace")))]
            lines = [x for x in head.decode("utf-8", "replace").splitlines() if x.strip()][:2]
            out = [(f"line {i}", _cut(x)) for i, x in enumerate(lines, 1)]
            for at in SPREAD if size > HEAD_BYTES else ():
                f.seek(int(size * at))
                f.readline()
                line = f.readline(HEAD_BYTES).decode("utf-8", "replace")
                if line.strip():
                    out.append((f"{at:.0%} in", _cut(line)))
            return out
    except OSError:
        return []


def samples(c: str, gs: list[dict[str, Any]], first: list[str]) -> str:
    """The prompt's samples: for each likeliest pattern (_likeliest), a few records of its largest file."""
    corpus = config.corpus_dir(c)
    parts = []
    for g in _likeliest(gs, first):
        recs = _records(corpus / g["largest"])
        if not recs:
            continue
        of = f" (one of {g['pattern']}, {g['n']:,} files)" if g["n"] > 1 else ""
        parts.append(f"{g['largest']}{of}\n" + "\n".join(f"  {where}: {text}" for where, text in recs))
    return "\n\n".join(parts) or "(no file holds records thimble can show)"


def prompt(c: str, title: str, description: str, files: list[tuple[str, int]], first: list[str]) -> str:
    gs = groups(files)
    return prompts.render(PROMPT, {"name": title, "applies": description, "files": listing(gs),
                                   "samples": samples(c, gs, first)})


async def ask(c: str, text: str) -> Any:
    """The call: model.structured on the labels role's model, effort and fast mode (config.models_for). Never raises."""
    from . import model  # noqa: PLC0415

    role = config.models_for(c)["labels"]
    tool = model.ToolSpec(name=TOOL_NAME, description="Your decision on whether the extension applies to this corpus.",
                          input_schema=SCHEMA)
    with capture.scope("extension applies", keep=True):
        return await model.structured(text, tool=tool, model=str(role["model"]), effort=role.get("effort") or None,
                                      cwd=config.corpus_dir(c), speed="fast" if role.get("fast") else "standard")


def _matching(c: str, claims: list[str]) -> list[str]:
    return [x for x in dict.fromkeys(" ".join(str(v).split()) for v in claims) if x and views.claimed_files(c, {"claims": [x]})]


async def decide(c: str, title: str, description: str, files: list[tuple[str, int]], first: list[str],
                 at: str) -> dict[str, Any]:
    """The decision on one extension in workspace `c`: {key, applies, claims, reason, by: "model", ts} or, when the call
    failed, {key, error, ts}. `at` is the key it is made for (key)."""
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        text = await asyncio.to_thread(prompt, c, title, description, files, first)
    except (OSError, ValueError, prompts.PromptError) as e:
        return {"key": at, "error": f"its prompt could not be made ({e})", "ts": ts}
    res = await ask(c, text)
    if res.status != "ok" or not isinstance(res.output, dict):
        log.warning("%s: whether %s applies is not known: %s %s", c, title, res.status, res.detail)
        return {"key": at, "error": f"the model call ended {res.status.replace('_', ' ')}"
                                    + (f" ({res.detail})" if res.detail else ""), "ts": ts}
    out = res.output
    reason = " ".join(str(out.get("reason") or "").split())
    claims = await asyncio.to_thread(_matching, c, [str(x) for x in out.get("claims") or []])
    if out.get("applies") is True and not claims:
        return {"key": at, "error": "the answer says it applies and claims no file of this corpus", "ts": ts}
    return {"key": at, "applies": out.get("applies") is True, "claims": claims, "reason": reason, "by": "model",
            "ts": ts}
