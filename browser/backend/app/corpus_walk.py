"""One walk of a folder tree, shared by the callers that need the names in it (notebook.mirror_corpus).

walk(root) returns every folder under `root` by its root-relative path ('' the root), each with its mtime_ns, its real
subfolders and the names of its other entries (files, links of any kind, sockets). A folder's mtime moves whenever an
entry is added to it, removed from it or renamed in it, so a later walk lists again only the folders whose mtime moved
and keeps the others as they were: a walk of an unchanged tree costs one stat per folder. A folder listed within
RACY_NS of its own mtime is listed again by the next walk, since a change in the same clock tick leaves the mtime as it
was. Sizes and times of files are not kept: a file's content changes without its folder's mtime moving.

One walk runs at a time per (root, pruned names); a caller that comes while one runs waits for it, then reuses what it
listed. Blocking.
"""
from __future__ import annotations

import os
import stat
import threading
import time
from dataclasses import dataclass

RACY_NS = 2_000_000_000
_SEP = "\0"  # no file name holds it


@dataclass(frozen=True, slots=True)
class Folder:
    """One folder as a walk found it. `files` and `links` are names joined by NUL (one string per folder keeps a large
    tree small in memory); `links` are the entries of `files` that are symbolic links."""

    mtime_ns: int
    dirs: tuple[str, ...]
    files: str
    links: str
    racy: bool

    def file_names(self) -> list[str]:
        return self.files.split(_SEP) if self.files else []

    def link_names(self) -> frozenset[str]:
        return frozenset(self.links.split(_SEP)) if self.links else frozenset()


Tree = dict[str, Folder]  # folder path relative to the root ('' the root) -> Folder, parents before children

_trees: dict[tuple[str, frozenset[str]], Tree] = {}
_locks: dict[tuple[str, frozenset[str]], threading.Lock] = {}
_locks_lock = threading.Lock()


def _list(path: str, mtime_ns: int, prune: frozenset[str]) -> Folder:
    dirs: list[str] = []
    files: list[str] = []
    links: list[str] = []
    listed_at = time.time_ns()
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.name in prune:
                    continue
                try:
                    if e.is_dir(follow_symlinks=False):
                        dirs.append(e.name)
                        continue
                    if e.is_symlink():
                        links.append(e.name)
                except OSError:
                    pass
                files.append(e.name)
    except OSError:
        return Folder(mtime_ns, (), "", "", True)
    dirs.sort()
    files.sort()
    return Folder(mtime_ns, tuple(dirs), _SEP.join(files), _SEP.join(links), listed_at - mtime_ns < RACY_NS)


def walk(root: str | os.PathLike[str], prune: frozenset[str] = frozenset()) -> Tree:
    """Every folder under `root` (module note), with entries named in `prune` left out at every depth. Links to folders
    are entries, never entered. The tree returned is shared: callers never mutate it."""
    base = os.fspath(root)
    key = (base, prune)
    with _locks_lock:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        old = _trees.get(key, {})
        new: Tree = {}
        stack = [""]
        while stack:
            rel = stack.pop()
            path = os.path.join(base, rel) if rel else base
            try:
                st = os.stat(path, follow_symlinks=False)
            except OSError:
                continue
            if not stat.S_ISDIR(st.st_mode):
                continue
            prev = old.get(rel)
            folder = prev if prev is not None and not prev.racy and prev.mtime_ns == st.st_mtime_ns else _list(path, st.st_mtime_ns, prune)
            new[rel] = folder
            stack.extend(reversed([f"{rel}/{d}" if rel else d for d in folder.dirs]))
        _trees[key] = new
        return new


def forget(root: str | os.PathLike[str] | None = None) -> None:
    """Drop what walks of `root` (every root when None) listed, so the next walk lists every folder again."""
    with _locks_lock:
        for key in [k for k in _trees if root is None or k[0] == os.fspath(root)]:
            _trees.pop(key, None)
