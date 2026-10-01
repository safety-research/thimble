"""A corpus's folders by name, kept in memory per corpus and brought up to date one folder at a time.

A walk stats each folder it reaches and reads its entries again only when the folder's modification time (or inode)
changed since the last read, so after the first walk a question about every file of a large corpus costs one stat per
folder instead of one per file. A folder is first read when a walk reaches it: walks that leave out dot folders or
symlinked folders never read them. File sizes and times are not kept; callers stat the files they need.

corpus.list_sources and the views' claimed files walk through here, and corpus.forget_sources makes the next walk check
every folder again.
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

DB_SUFFIXES = (".db", ".sqlite", ".sqlite3")  # a file so named is a database (kind 'forge'), forge.db included
SIDE_SUFFIXES = ("-wal", "-shm", "-journal")  # sqlite side files of a database opened read-write elsewhere
SKIPPED_SUFFIXES = tuple(db + side for db in DB_SUFFIXES for side in SIDE_SUFFIXES)  # never listed or counted
# A folder modified this close to when it was read may have changed again within the same modification time, so it is
# read again at its next check.
RACY_NS = 2_000_000_000
KEPT_ANSWERS = 8  # a tree's sorted path lists kept, one per kind of walk


def _hidden(name: str) -> bool:
    return name.startswith(".")


class Node:
    """One folder: its real subfolders, its symlinks to folders, and its files (regular files and symlinks to them) by
    name. A read replaces these containers rather than changing them, so a reader without the lock sees one read whole.
    """

    __slots__ = ("read", "stamp", "checked", "racy", "dirs", "links", "files", "n_shown", "n_all")

    def __init__(self) -> None:
        self.read = False
        self.stamp: tuple[int, int, int] | None = None  # (mtime_ns, inode, device) at the last read
        self.checked = float("-inf")  # time.monotonic() of the last stat
        self.racy = False
        self.dirs: dict[str, Node] = {}
        self.links: dict[str, Node] = {}
        self.files: tuple[str, ...] = ()
        self.n_shown = 0  # files without a dot name, sqlite side files left out
        self.n_all = 0  # files, sqlite side files left out


class Tree:
    def __init__(self, root: Path) -> None:
        self.root = str(root)
        self.top = Node()
        self.lock = threading.Lock()  # one walk at a time; a second caller waits and finds the folders just checked
        self.version = 0  # raised whenever a read finds a folder's entries changed
        self.not_before = float("-inf")  # forget(): a check older than this is no check
        self._answers: dict[tuple[bool, bool, tuple[str, ...]], tuple[int, list[str], float]] = {}
        self._counts: tuple[int, bool, dict[str, tuple[int, int]]] | None = None
        self._refreshing = False

    # ------------------------------------------------------------------ reading folders

    def _check(self, node: Node, path: str, now: float, max_age: float) -> None:
        if node.read and node.checked >= self.not_before and now - node.checked < max_age:
            return
        node.checked = now
        try:
            st = os.stat(path)
        except OSError:
            self._set(node, None, {}, {}, ())
            return
        stamp = (st.st_mtime_ns, st.st_ino, st.st_dev)
        if node.read and stamp == node.stamp and not node.racy:
            return
        dirs: dict[str, Node] = {}
        links: dict[str, Node] = {}
        files: list[str] = []
        try:
            with os.scandir(path) as it:
                for e in it:
                    name = e.name
                    try:
                        if e.is_dir(follow_symlinks=False):
                            dirs[name] = node.dirs.get(name) or Node()
                        elif e.is_symlink():
                            if e.is_dir():
                                links[name] = node.links.get(name) or Node()
                            elif e.is_file():
                                files.append(name)
                        elif e.is_file(follow_symlinks=False):
                            files.append(name)
                    except OSError:
                        continue
        except OSError:
            self._set(node, None, {}, {}, ())
            return
        files.sort()
        self._set(node, stamp, dirs, links, tuple(files))
        node.racy = time.time_ns() - stamp[0] < RACY_NS

    def _set(self, node: Node, stamp: tuple[int, int, int] | None, dirs: dict[str, Node], links: dict[str, Node],
             files: tuple[str, ...]) -> None:
        changed = not node.read or files != node.files or dirs.keys() != node.dirs.keys() or links.keys() != node.links.keys()
        node.stamp = stamp
        if changed:
            counted = [f for f in files if not f.endswith(SKIPPED_SUFFIXES)]
            node.dirs, node.links, node.files = dirs, links, files
            node.n_all = len(counted)
            node.n_shown = sum(1 for f in counted if not _hidden(f))
            node.read = True
            self.version += 1

    def _nodes(self, links: bool, hidden: bool, now: float | None, max_age: float):
        """(node, absolute path, corpus-relative prefix, under a dot name) of every folder the walk reaches, parents first;
        each checked first when `now` is given. A symlinked folder that leads back to one of its own parents is not
        entered."""
        stack: list[tuple[Node, str, str, bool, frozenset]] = [(self.top, self.root, "", False, frozenset())]
        while stack:
            node, path, prefix, hid, above = stack.pop()
            if now is not None:
                self._check(node, path, now, max_age)
            if links:
                me = node.stamp[1:] if node.stamp else None
                if me in above:
                    continue
                above = above | {me}
            yield node, path, prefix, hid
            subs = list(node.dirs.items()) + (list(node.links.items()) if links else [])
            for name, child in subs:
                h = hid or _hidden(name)
                if h and not hidden:
                    continue
                stack.append((child, f"{path}/{name}", f"{prefix}{name}/", h, above))

    # ------------------------------------------------------------------ answers

    def walk(self, *, links: bool, hidden: bool, skip: tuple[str, ...] = (), max_age: float = 0.0) -> tuple[int, list[str]]:
        """(the tree's version, every file's corpus-relative path, sorted) after checking each folder the walk reaches;
        a folder checked less than `max_age` seconds ago is taken as it is. `links` enters symlinked folders, `hidden`
        dot names, and `skip` leaves out files whose names end so. The list is shared: callers never change it."""
        key = (links, hidden, skip)
        with self.lock:
            now = time.monotonic()
            for _ in self._nodes(links, hidden, now, max_age):
                pass
            hit = self._answers.get(key)
            if hit is not None and hit[0] == self.version:
                self._answers[key] = (hit[0], hit[1], time.monotonic())
                return hit[0], hit[1]
            out = [prefix + f for node, _, prefix, hid in self._nodes(links, hidden, None, 0.0) for f in node.files
                   if (hidden or not (hid or _hidden(f))) and not (skip and f.endswith(skip))]
            out.sort()
            self._answers[key] = (self.version, out, time.monotonic())
            while len(self._answers) > KEPT_ANSWERS:
                self._answers.pop(next(iter(self._answers)))
            return self.version, out

    def peek(self, *, links: bool, hidden: bool, skip: tuple[str, ...] = ()) -> tuple[int, list[str], float] | None:
        """The last walk's answer of this kind, however old, without touching the file system: (version, paths, the
        time.monotonic() it was last confirmed); None before the first such walk."""
        return self._answers.get((links, hidden, skip))

    def refresh_in_background(self, *, links: bool, hidden: bool, skip: tuple[str, ...] = (), max_age: float = 0.0) -> None:
        """walk() in a daemon thread, unless one is running already."""
        with _bg_lock:
            if self._refreshing:
                return
            self._refreshing = True

        def run() -> None:
            try:
                self.walk(links=links, hidden=hidden, skip=skip, max_age=max_age)
            except Exception:  # noqa: BLE001 — the next caller walks again
                pass
            finally:
                with _bg_lock:
                    self._refreshing = False

        threading.Thread(target=run, name="corpus-tree", daemon=True).start()

    def counts(self, hidden: bool) -> dict[str, tuple[int, int]]:
        """folder path ('' the root) -> (files under it at any depth, its subfolders), real subfolders only and dot names
        only with `hidden`, sqlite side files left out, from what earlier walks read: no file system access and no lock.
        A folder with a folder below it that no walk has read yet is left out."""
        memo = self._counts
        version = self.version
        if memo is not None and memo[0] == version and memo[1] == hidden:
            return memo[2]
        order = [(node, prefix) for node, _, prefix, _ in self._nodes(False, hidden, None, 0.0)]
        totals: dict[int, int | None] = {}
        out: dict[str, tuple[int, int]] = {}
        for node, prefix in reversed(order):  # children before their parents
            subs = [c for n, c in node.dirs.items() if hidden or not _hidden(n)]
            if not node.read or any(totals.get(id(c)) is None for c in subs):
                totals[id(node)] = None
                continue
            n = (node.n_all if hidden else node.n_shown) + sum(totals[id(c)] or 0 for c in subs)
            totals[id(node)] = n
            out[prefix[:-1]] = (n, len(subs))
        self._counts = (version, hidden, out)
        return out


_bg_lock = threading.Lock()
_trees: dict[str, Tree] = {}
_trees_lock = threading.Lock()


def tree(root: Path) -> Tree:
    """The tree of the corpus folder `root`, made on first use."""
    key = str(root)
    with _trees_lock:
        t = _trees.get(key)
        if t is None:
            t = _trees[key] = Tree(root)
        return t


def forget(root: Path | None = None) -> None:
    """The next walk of `root`'s tree (of every tree when None) checks every folder again."""
    now = time.monotonic()
    with _trees_lock:
        for key, t in _trees.items():
            if root is None or key == str(root):
                t.not_before = now
