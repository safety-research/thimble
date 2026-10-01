"""The indexes view readers keep on disk (workspaces/<c>/view-indexes), held to a bounded size.

A reader's index is pickled by fingerprint (views._prepare): `<dir>/<fp>.index.pickle`, with `<fp>.reads.json` beside
it, where `<dir>` is a view's slug, or a folder below a dot-folder for a card type: `.cardtypes/<slug>` for one thimble
ships, `.extensions/<extension>/<view>` or `.extensions/<extension>/cards/<slug>` for an extension's. The fingerprint
changes with the claimed files and with reader.py, so every change to either leaves a new pickle beside the old ones.
thimble keeps:

- in each folder, the KEEP_PER_DIR most recently used fingerprints (a page still on the version before a change uses
  the older one);
- no folder of a view that no longer exists (a dot-folder is no view's, so it is never deleted whole);
- across every workspace, at most cap() bytes of pickles, the least recently used deleted first, but never one used in
  the last IN_USE_S.

A pickle's mtime is its last use, which `used` sets at most once per TOUCH_S. The folder of a new index is pruned
when it is built (`built`), a deleted view's when it is deleted (`drop`), and everything at the server's start
(views.prune_indexes). Pickles a cancelled build left half-written (`*.tmp`), and the progress files of calls
(CALLS_DIR) that a cancelled call wrote after it ended, go once they are TMP_AGE_S old.
"""
from __future__ import annotations

import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("thimble.view_indexes")

INDEXES_SUBDIR = "view-indexes"
PICKLE = ".index.pickle"
READS = ".reads.json"
KEEP_PER_DIR = 2
IN_USE_S = 600.0
TOUCH_S = 60.0
TMP_AGE_S = 3600.0
CALLS_DIR = ".calls"  # view_calls.PROGRESS_SUBDIR

_lock = threading.Lock()
_touched: dict[str, float] = {}


def cap() -> int:
    """The bytes of index pickles kept across every workspace: 4 GB, or THIMBLE_INDEX_CACHE_MB."""
    try:
        mb = int(os.environ.get("THIMBLE_INDEX_CACHE_MB", ""))
    except ValueError:
        mb = 0
    return (mb if mb > 0 else 4096) * 1024 * 1024


def used(pickle: Path) -> None:
    """Note a use of the index pickled at `pickle`: its mtime, at most once per TOUCH_S."""
    key = str(pickle)
    now = time.monotonic()
    if now - _touched.get(key, -TOUCH_S) < TOUCH_S:
        return
    _touched[key] = now
    try:
        os.utime(pickle)
    except OSError:
        pass


def _fp(p: Path) -> str:
    return p.name[: -len(PICKLE)]


def _remove(pickle: Path) -> int:
    """Delete one index (its pickle and its reads); the bytes freed."""
    freed = 0
    for p in (pickle, pickle.with_name(_fp(pickle) + READS)):
        try:
            freed += p.stat().st_size
            p.unlink()
        except OSError:
            pass
    _touched.pop(str(pickle), None)
    return freed


def _pickles(d: Path) -> list[Path]:
    try:
        return [p for p in d.iterdir() if p.name.endswith(PICKLE) and p.is_file() and not p.is_symlink()]
    except OSError:
        return []


def _mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0


def prune_dir(d: Path, keep: str | None = None) -> int:
    """Keep the KEEP_PER_DIR most recently used fingerprints of one folder (`keep`'s always, the one just built), and
    delete half-written pickles older than TMP_AGE_S; the bytes freed."""
    freed = 0
    ps = sorted(_pickles(d), key=_mtime, reverse=True)
    if keep:
        ps.sort(key=lambda p: _fp(p) != keep)
    for p in ps[KEEP_PER_DIR:]:
        freed += _remove(p)
    now = time.time()
    try:
        tmps = [p for p in d.iterdir() if p.name.endswith(".tmp") and p.is_file()]
    except OSError:
        tmps = []
    for p in tmps:
        if now - _mtime(p) > TMP_AGE_S:
            try:
                freed += p.stat().st_size
                p.unlink()
            except OSError:
                pass
    return freed


def _folders(root: Path) -> list[Path]:
    """The folders under a workspace's indexes folder that may hold indexes: one per view, and every folder below a
    dot-folder (the card types'), at any depth, without following links."""
    out: list[Path] = []
    try:
        subs = [d for d in root.iterdir() if d.is_dir() and not d.is_symlink()]
    except OSError:
        return out
    for d in subs:
        if d.name == CALLS_DIR:
            continue
        if not d.name.startswith("."):
            out.append(d)
            continue
        for here, dirs, _ in os.walk(d):
            dirs[:] = [x for x in dirs if not os.path.islink(os.path.join(here, x))]
            out.append(Path(here))
    return out


def built(c: str, pickle: Path) -> None:
    """A new index was pickled at `pickle`: its folder keeps the newest fingerprints, and the total is held to cap(),
    in a thread of its own so no request waits for it."""
    used(pickle)

    def run() -> None:
        try:
            with _lock:
                freed = prune_dir(pickle.parent, keep=_fp(pickle))
                freed += enforce_cap(protect={pickle})
            if freed:
                log.info("%s: %.1f MB of old view indexes deleted", c, freed / 1e6)
        except Exception:  # noqa: BLE001
            log.exception("%s: pruning view indexes failed", c)

    threading.Thread(target=run, name="view-index-prune", daemon=True).start()


def drop(c: str, slug: str) -> int:
    """Delete the indexes of the view `slug`, which was deleted; the bytes freed."""
    d = config.workspace_dir(c) / INDEXES_SUBDIR / slug
    if not d.is_dir() or d.is_symlink():
        return 0
    freed = sum(p.stat().st_size for p in d.rglob("*") if p.is_file())
    shutil.rmtree(d, ignore_errors=True)
    return freed


def enforce_cap(protect: "set[Path] | None" = None, limit: int | None = None) -> int:
    """Delete the least recently used pickles of every workspace while they come to more than `limit` (cap()), never one
    used in the last IN_USE_S or in `protect`; the bytes freed."""
    limit = cap() if limit is None else limit
    protect = protect or set()
    every: list[tuple[float, int, Path]] = []
    root = config.WORKSPACES_DIR
    try:
        workspaces = [w for w in root.iterdir() if w.is_dir()]
    except OSError:
        return 0
    for w in workspaces:
        for d in _folders(w / INDEXES_SUBDIR):
            for p in _pickles(d):
                try:
                    st = p.stat()
                except OSError:
                    continue
                every.append((st.st_mtime, st.st_size, p))
    total = sum(s for _, s, _ in every)
    freed = 0
    now = time.time()
    for mtime, size, p in sorted(every):
        if total <= limit:
            break
        if p in protect or now - mtime < IN_USE_S:
            continue
        got = _remove(p)
        total -= size
        freed += got
    return freed


def prune_workspace(c: str, alive: Any) -> int:
    """Prune one workspace's indexes: the folders of views `alive(slug)` says are gone deleted, the others kept to their
    newest fingerprints; the bytes freed."""
    root = config.workspace_dir(c) / INDEXES_SUBDIR
    freed = 0
    for d in _folders(root):
        if d.parent == root and not d.name.startswith(".") and not alive(d.name):
            freed += drop(c, d.name)
        else:
            freed += prune_dir(d)
    now = time.time()
    try:
        stale = [p for p in (root / CALLS_DIR).iterdir() if p.is_file() and now - _mtime(p) > TMP_AGE_S]
    except OSError:
        stale = []
    for p in stale:
        try:
            freed += p.stat().st_size
            p.unlink()
        except OSError:
            pass
    return freed


def usage(c: str | None = None) -> dict[str, int]:
    """{bytes, indexes} of the pickles of one workspace, or of every workspace."""
    roots = [config.workspace_dir(c) / INDEXES_SUBDIR] if c else \
        [w / INDEXES_SUBDIR for w in (config.WORKSPACES_DIR.iterdir() if config.WORKSPACES_DIR.is_dir() else [])]
    total = n = 0
    for root in roots:
        for d in _folders(root):
            for p in _pickles(d):
                total += _size(p) + _size(p.with_name(_fp(p) + READS))
                n += 1
    return {"bytes": total, "indexes": n}


def _size(p: Path) -> int:
    try:
        return p.stat().st_size
    except OSError:
        return 0
