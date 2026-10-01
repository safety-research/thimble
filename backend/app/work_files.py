"""What an agent's work folder keeps once its run ends. A session over a large corpus can leave gigabytes of extracts
there (pickled indexes, copies of big files), so when a run finishes thimble deletes its subagents' scratch folders
(`tmp_*`, scratch_hook) and every other file of at least EXTRACT_MIN bytes that nothing uses. A run that goes on (the
analyst stopped it, or a message waits for it) loses only its scratch folders, and a failed run, which is resumed,
keeps everything (the callers decide which).

A file is used when a card's code (any version a notebook keeps, a deleted group's too), a stored document (a report),
a label's definition (a code label's script) or a check names it, by its path in the work folder or by its name, in a
text that also names the work folder; or when a used script or note (SCRIPT_SUFFIXES, at most TEXT_MAX bytes) names it,
so a script a card names keeps the files it reads. Always kept: smaller files, the folder's entries whose names start
with a dot (the session's rendered prompts, caches and Claude Code's own files) and Python environments (a folder that
holds pyvenv.cfg). Links are removed as links, never followed. Blocking."""
from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("thimble.work_files")

EXTRACT_MIN = 1024 * 1024
TEXT_MAX = 2 * 1024 * 1024
TEMP_PREFIX = "tmp_"  # scratch_hook.PREFIX
SCRIPT_SUFFIXES = (".py", ".sh", ".sql", ".r", ".jl", ".js", ".mjs", ".ipynb", ".md", ".txt", ".json", ".yaml",
                   ".yml", ".toml", ".cfg", ".ini")
CODE_KEYS = ("code", "previous_code")
# where the texts that may name a work folder's files are kept, the keys whose strings count (None for all), and
# their files: notebooks and the groups deleted to notebook.TRASH_DIR, report_types.doc_file, concepts.concepts_dir and
# the checks' records
TEXT_SOURCES = (("notebooks", CODE_KEYS, "*.json"), ("notebooks/trash", CODE_KEYS, "*.json"),
                ("investigations", None, "*/*.json"), ("concepts", None, "*.json"), ("checks", None, "*.json"))


def _strings(x: Any, out: list[str], keys: tuple[str, ...] | None) -> None:
    """The strings in `x`; with `keys`, only those under one of them, at any depth."""
    if isinstance(x, dict):
        for k, v in x.items():
            _strings(v, out, None if keys is not None and k in keys else keys)
    elif isinstance(x, list):
        for v in x:
            _strings(v, out, keys)
    elif isinstance(x, str) and keys is None:
        out.append(x)


def _texts(ws: Path) -> list[str]:
    """Every card's code the workspace's notebooks keep, and the text of each stored document, label and check."""
    out: list[str] = []
    for sub, keys, pattern in TEXT_SOURCES:
        folder = ws / sub
        for p in sorted(folder.glob(pattern)) if folder.is_dir() else []:
            try:
                _strings(json.loads(p.read_text("utf-8")), out, keys)
            except (OSError, ValueError):
                continue
    return out


def _work_names(work: Path, ws: Path) -> set[str]:
    """The ways a text names the work folder: its path as given and resolved, and its path in the workspace."""
    out = {str(work), str(work.resolve())}
    try:
        out.add(work.resolve().relative_to(ws.resolve()).as_posix())
    except ValueError:
        pass
    return out


def _files(work: Path) -> tuple[dict[str, int], list[Path]]:
    """({path relative to `work`: bytes} of its files the rule looks at, its `tmp_*` entries)."""
    found: dict[str, int] = {}
    temp: list[Path] = []
    for root, dirs, files in os.walk(work):
        if "pyvenv.cfg" in files and Path(root) != work:
            dirs[:] = []
            continue
        here = Path(root)
        keep = []
        for d in dirs:
            if d.startswith(".") or os.path.islink(os.path.join(root, d)):
                continue
            if here == work and d.startswith(TEMP_PREFIX):
                temp.append(here / d)
                continue
            keep.append(d)
        dirs[:] = keep
        for f in files:
            if here == work and f.startswith("."):
                continue
            p = here / f
            if here == work and f.startswith(TEMP_PREFIX):
                temp.append(p)
                continue
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if not os.path.islink(p):
                found[p.relative_to(work).as_posix()] = st.st_size
    return found, temp


def _named(rel: str, blob: str) -> bool:
    return rel in blob or os.path.basename(rel) in blob


def _read_text(path: Path) -> str | None:
    try:
        if path.stat().st_size > TEXT_MAX:
            return None
        raw = path.read_bytes()
    except OSError:
        return None
    return None if b"\0" in raw[:4096] else raw.decode("utf-8", "replace")


def used(c: str, work: Path, files: dict[str, int]) -> set[str]:
    """The files of `files` (relative to the work folder) that something uses (module note)."""
    ws = config.workspace_dir(c)
    names = _work_names(work, ws)
    blob = "\n".join(t for t in _texts(ws) if any(n in t for n in names))
    out: set[str] = set()
    while blob:
        found = {rel for rel in files if rel not in out and _named(rel, blob)}
        out |= found
        blob = "\n".join(t for rel in sorted(found) if rel.lower().endswith(SCRIPT_SUFFIXES)
                         and (t := _read_text(work / rel)) is not None)
    return out


def clear(c: str, work: Path, extracts: bool = True) -> dict[str, int]:
    """Delete from the work folder `work` of workspace `c` what the module note says it does not keep, its large files
    only with `extracts`; {files, bytes} deleted."""
    freed = {"files": 0, "bytes": 0}
    if not work.is_dir() or work.is_symlink():
        return freed
    files, temp = _files(work)
    if not extracts:
        files = {}
    for p in temp:
        try:
            if p.is_dir() and not p.is_symlink():
                for root, _dirs, names in os.walk(p):
                    for f in names:
                        with_size = os.path.join(root, f)
                        freed["bytes"] += os.lstat(with_size).st_size
                        freed["files"] += 1
                shutil.rmtree(p)
            else:
                freed["bytes"] += p.lstat().st_size
                freed["files"] += 1
                p.unlink()
        except OSError as e:
            log.info("%s: the temporary %s was not deleted (%s)", c, p, e)
    big = {rel: size for rel, size in files.items() if size >= EXTRACT_MIN}
    keep = used(c, work, files) if big else set()
    emptied: set[Path] = set()
    for rel, size in big.items():
        if rel in keep:
            continue
        try:
            (work / rel).unlink()
        except OSError as e:
            log.info("%s: the extract %s was not deleted (%s)", c, work / rel, e)
            continue
        freed["files"] += 1
        freed["bytes"] += size
        emptied.add((work / rel).parent)
    for d in sorted(emptied, key=lambda p: len(p.parts), reverse=True):
        while d != work and work in d.parents:
            try:
                d.rmdir()
            except OSError:
                break
            d = d.parent
    if freed["files"]:
        log.info("%s: %d files (%.1f MB) the agent left in %s deleted", c, freed["files"], freed["bytes"] / 1e6, work)
    return freed


def _clear_logged(c: str, work: Path, extracts: bool) -> None:
    try:
        clear(c, work, extracts)
    except Exception:  # noqa: BLE001 — a cleanup that fails leaves the files, never the run's end
        log.exception("%s: the files the agent left in %s were not cleared", c, work)


def clear_soon(c: str, work: Path, extracts: bool = True) -> None:
    """clear() in a worker thread when an event loop runs here, else now."""
    import asyncio  # noqa: PLC0415

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _clear_logged(c, work, extracts)
        return
    loop.run_in_executor(None, _clear_logged, c, work, extracts)


def after_run(c: str, work: Path, status: str) -> None:
    """What the end of a run with this status clears (module note): everything it may once it finished, its scratch
    folders once it was stopped, nothing when it failed."""
    if status == "done":
        clear_soon(c, work)
    elif status == "stopped":
        clear_soon(c, work, extracts=False)
