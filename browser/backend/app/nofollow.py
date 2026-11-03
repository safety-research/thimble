"""The server's own file access below a folder that sandboxed code writes, which never follows a link that code put there.

The server runs in no sandbox, and the code it runs for the analyst does, but that code still writes some of the folders
the server reads and writes: a card's code writes its workspace (notebook's kernels, under srt or bwrap), main's and the
agents' commands write their folders there, and on Claude Code sign-in main's Bash writes its session's short temp folder
(runtime_cc). A link put in place of a file or a folder there would lead the server's open outside, to a file the
sandbox keeps from that code. So each call here opens such a path from its root one part at a time, each part by its own
name in the folder above it (os.open's dir_fd) with O_NOFOLLOW, and the file itself with O_NOFOLLOW and O_NONBLOCK, then
checks by its descriptor that it is a regular file: the part checked is the part opened, with no gap between a check and
an open. A link, or an entry of another kind on the way (a FIFO, a file where a folder goes), fails the call with Linked,
an OSError, rather than lead anywhere, and a FIFO cannot hold the server. A write that makes its file (append, write,
open with O_CREAT) puts a file of its own in place of a link or another entry at the file's own name.

The root: for a path under the workspaces folder (config.WORKSPACES_DIR) that folder, else the one the caller names
(`root`: "/" for a path a tool resolved, runtime_cc's temp folder). The root and the folders above it are opened as
usual, since no sandboxed code can change them, and so is a path under no root, as before, except that a file there
must be a regular file too. POSIX openat and its kin (dir_fd), so macOS works as Linux does, without /proc or openat2.
"""
from __future__ import annotations

import contextlib
import errno
import os
import secrets
import stat
from pathlib import Path
from typing import Iterator, Union

PathLike = Union[str, "os.PathLike[str]"]

_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
DIR_FLAGS = os.O_RDONLY | _DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | _CLOEXEC  # a folder below the root
# a folder on the way to the one a call wants, which it only goes through: on Linux opened for that alone (O_PATH), so
# a folder the person may enter but not list is no obstacle, as it is none to an open by path
PASS_FLAGS = (os.O_PATH | _DIRECTORY | os.O_NOFOLLOW | _CLOEXEC) if hasattr(os, "O_PATH") else DIR_FLAGS
FILE_FLAGS = os.O_NOFOLLOW | os.O_NONBLOCK | _CLOEXEC  # a file below the root, besides the caller's flags
# what an open with O_NOFOLLOW says of a link, and with O_DIRECTORY of a link or a file (macOS ELOOP, Linux ENOTDIR for
# a folder's open, FreeBSD EMLINK), and with O_NONBLOCK of a FIFO opened to write with no reader (ENXIO)
_LINKED = frozenset({errno.ELOOP, errno.ENOTDIR, errno.EMLINK, errno.ENXIO, errno.EISDIR})
REPLACE_TRIES = 3  # a write puts its file in place of what sandboxed code put at its name, this many times at most


class Linked(OSError):
    """A link, or an entry of another kind than the call needs (a FIFO, a file where a folder goes, a folder where a
    file goes), where the server's own file or folder was to be: what sandboxed code may have put there."""


def _linked(e: OSError, where: str) -> OSError:
    return Linked(e.errno, f"{where} is a link or not what thimble keeps there, so thimble left it alone") \
        if e.errno in _LINKED else e


def _workspaces() -> Path:
    from . import config  # noqa: PLC0415 — config imports nothing of this module

    return config.WORKSPACES_DIR


def split(path: PathLike, root: PathLike | None = None) -> tuple[str, tuple[str, ...]] | None:
    """(the root, the parts of `path` below it): `root` when given, which must hold `path`, else the workspaces folder;
    None for a path under no root, which is opened as usual. Lexical, on the absolute normal form of `path` and on
    both the spelling and the real path of the root."""
    p = os.path.normpath(os.path.abspath(os.fspath(path)))
    base = _workspaces() if root is None else root
    for b in dict.fromkeys((os.path.normpath(os.path.abspath(os.fspath(base))), os.path.realpath(base))):
        if p == b:
            return b, ()
        head = b.rstrip(os.sep) + os.sep
        if p.startswith(head):
            return b, tuple(p[len(head):].split(os.sep))
    if root is not None:
        raise ValueError(f"{p} is not under {base}")
    return None


def _down(fd: int, name: str, make: bool, mode: int, flags: int = DIR_FLAGS) -> int:
    """The folder `name` in the folder `fd`, opened with `flags` without following a link, made first when missing and
    `make`."""
    try:
        return os.open(name, flags, dir_fd=fd)
    except FileNotFoundError:
        if not make:
            raise
    except OSError as e:
        raise _linked(e, name) from None
    with contextlib.suppress(FileExistsError):
        os.mkdir(name, mode, dir_fd=fd)
    try:
        return os.open(name, flags, dir_fd=fd)
    except OSError as e:
        raise _linked(e, name) from None


def walk(path: PathLike, *, root: PathLike | None = None, make: bool = False, mode: int = 0o777) -> int:
    """A descriptor of the folder `path`, its parts below the root opened one at a time without following a link (the
    module note), each made when missing and `make` (with `mode`, less the umask). The caller closes it."""
    sp = split(path, root)
    if sp is None:
        if make:
            os.makedirs(path, mode, exist_ok=True)
        return os.open(path, os.O_RDONLY | _DIRECTORY | _CLOEXEC)
    base, parts = sp
    if make:
        os.makedirs(base, exist_ok=True)
    fd = os.open(base, (PASS_FLAGS & ~os.O_NOFOLLOW if parts else os.O_RDONLY | _DIRECTORY) | _CLOEXEC)
    try:
        for i, part in enumerate(parts):
            below = _down(fd, part, make, mode, DIR_FLAGS if i == len(parts) - 1 else PASS_FLAGS)
            os.close(fd)
            fd = below
    except BaseException:
        os.close(fd)
        raise
    return fd


@contextlib.contextmanager
def folder(path: PathLike, *, root: PathLike | None = None, make: bool = False, mode: int = 0o777) -> Iterator[int]:
    """walk's descriptor for the block, closed after it."""
    fd = walk(path, root=root, make=make, mode=mode)
    try:
        yield fd
    finally:
        os.close(fd)


def _parent(path: PathLike) -> tuple[str, str]:
    p = os.path.normpath(os.path.abspath(os.fspath(path)))
    return os.path.dirname(p), os.path.basename(p)


def open_at(fd: int, name: str, flags: int, mode: int = 0o666) -> int:
    """The regular file `name` in the folder `fd`, opened with `flags` and without following a link or holding on a
    FIFO; Linked for anything else there. With O_CREAT, a link or another entry at `name` is removed and the file made
    anew in its place (O_EXCL), so the server's write never goes where that entry leads."""
    for _ in range(REPLACE_TRIES):
        try:
            got = os.open(name, flags | FILE_FLAGS, mode, dir_fd=fd)
        except OSError as e:
            err = _linked(e, name)
            if not (flags & os.O_CREAT and isinstance(err, Linked) and e.errno != errno.EISDIR):
                raise err from None
            with contextlib.suppress(FileNotFoundError):
                os.unlink(name, dir_fd=fd)
            flags |= os.O_EXCL
            continue
        try:
            plain = stat.S_ISREG(os.fstat(got).st_mode)
        except OSError:
            os.close(got)
            raise
        if plain:
            return got
        os.close(got)
        if not flags & os.O_CREAT:
            raise Linked(errno.EINVAL, f"{name} is not a regular file, so thimble left it alone")
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name, dir_fd=fd)
        flags |= os.O_EXCL
    raise Linked(errno.EEXIST, f"{name} kept coming back as something thimble does not keep there")


def open(path: PathLike, flags: int, mode: int = 0o666, *, root: PathLike | None = None,  # noqa: A001
         make: bool = False) -> int:
    """A descriptor of the file `path` (open_at), its folder walked (walk; `make` makes it). A path under no root is
    opened as usual, a link followed, and must be a regular file too (Linked), so a FIFO holds no caller there either."""
    if split(path, root) is None:
        if make:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        got = os.open(path, flags | os.O_NONBLOCK | _CLOEXEC, mode)
        try:
            plain = stat.S_ISREG(os.fstat(got).st_mode)
        except OSError:
            os.close(got)
            raise
        if not plain:
            os.close(got)
            raise Linked(errno.EINVAL, f"{os.fspath(path)} is not a regular file, so thimble left it alone")
        return got
    parent, name = _parent(path)
    with folder(parent, root=root, make=make) as fd:
        return open_at(fd, name, flags, mode)


def read_bytes(path: PathLike, *, root: PathLike | None = None) -> bytes:
    with os.fdopen(open(path, os.O_RDONLY, root=root), "rb") as f:
        return f.read()


def read_text(path: PathLike, encoding: str = "utf-8", errors: str = "strict", *, root: PathLike | None = None) -> str:
    return read_bytes(path, root=root).decode(encoding, errors)


def write_bytes(path: PathLike, data: bytes, *, root: PathLike | None = None, make: bool = False,
                mode: int = 0o666) -> None:
    """`data` as the whole file at `path`, written in place as Path.write_bytes writes it (made with `mode` when new),
    never through a link (open_at)."""
    with os.fdopen(open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode, root=root, make=make), "wb") as f:
        f.write(data)


def write_text(path: PathLike, text: str, encoding: str = "utf-8", *, root: PathLike | None = None,
               make: bool = False) -> None:
    write_bytes(path, text.encode(encoding), root=root, make=make)


def append_bytes(path: PathLike, data: bytes, *, root: PathLike | None = None, make: bool = False,
                 sync: bool = False, mode: int = 0o666) -> None:
    """`data` at the end of the file at `path`, made when missing, never through a link (open_at); fsync'd with
    `sync`."""
    fd = open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, mode, root=root, make=make)
    with os.fdopen(fd, "ab") as f:
        f.write(data)
        if sync:
            f.flush()
            os.fsync(f.fileno())


def temp_at(fd: int, name: str, data: bytes, mode: int = 0o600) -> str:
    """A temp file of this writer's own beside `name` in the folder `fd` that holds `data` (`.<name>.<8 hex
    digits>.tmp`, under the export's ignore patterns, made with O_EXCL), by its name; nothing is left on a failure."""
    tmp = f".{name}.{secrets.token_hex(4)}.tmp"
    out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE_FLAGS, mode, dir_fd=fd)
    try:
        with os.fdopen(out, "wb") as f:
            f.write(data)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp, dir_fd=fd)
        raise
    return tmp


def replace_at(fd: int, name: str, data: bytes, mode: int = 0o600) -> None:
    """`data` as the file `name` in the folder `fd`, by a temp file (temp_at) renamed over it: a reader sees the old file
    or the new one, and a link at `name` is replaced, never followed."""
    tmp = temp_at(fd, name, data, mode)
    try:
        os.rename(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp, dir_fd=fd)
        raise


def replace(path: PathLike, data: bytes, *, root: PathLike | None = None, make: bool = False,
            mode: int = 0o600) -> None:
    """replace_at for `path`, its folder walked (walk)."""
    parent, name = _parent(path)
    with folder(parent, root=root, make=make) as fd:
        replace_at(fd, name, data, mode)


def lstat(path: PathLike, *, root: PathLike | None = None) -> os.stat_result:
    """The entry at `path` as it is, a link as a link."""
    parent, name = _parent(path)
    with folder(parent, root=root) as fd:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)


def lexists(path: PathLike, *, root: PathLike | None = None) -> bool:
    try:
        lstat(path, root=root)
    except OSError:
        return False
    return True


def unlink(path: PathLike, *, root: PathLike | None = None, missing_ok: bool = True) -> None:
    """The entry at `path` removed (a link, never what it points to)."""
    parent, name = _parent(path)
    try:
        with folder(parent, root=root) as fd:
            os.unlink(name, dir_fd=fd)
    except FileNotFoundError:
        if not missing_ok:
            raise


def rename(src: PathLike, dst: PathLike, *, root: PathLike | None = None) -> None:
    """The entry at `src` moved to `dst`, both folders walked (walk)."""
    sp, sn = _parent(src)
    dp, dn = _parent(dst)
    with folder(sp, root=root) as sfd, folder(dp, root=root) as dfd:
        os.rename(sn, dn, src_dir_fd=sfd, dst_dir_fd=dfd)


def makedirs(path: PathLike, *, root: PathLike | None = None, mode: int = 0o777) -> None:
    """The folder `path` and those above it below the root, made where missing (walk)."""
    os.close(walk(path, root=root, make=True, mode=mode))


def own_folder(path: PathLike, *, root: PathLike | None = None, mode: int = 0o700) -> int:
    """A descriptor of the folder `path`, made when missing, in place of a link or another entry there (removed first),
    its mode set to `mode` through the descriptor when it allows more: for a folder of the server's own that sandboxed
    code may replace (a workspace's kernels/, tmp/, scratch/). The folders above it are walked and made as usual."""
    parent, name = _parent(path)
    with folder(parent, root=root, make=True) as fd:
        for _ in range(REPLACE_TRIES):
            try:
                got = _down(fd, name, True, mode)
            except Linked:
                rmtree_at(fd, name)
                continue
            try:
                if os.fstat(got).st_mode & 0o777 & ~mode:
                    with contextlib.suppress(OSError):  # a folder of another owner keeps its mode
                        os.fchmod(got, mode)
            except BaseException:
                os.close(got)
                raise
            return got
    raise Linked(errno.EEXIST, f"{name} kept coming back as something thimble does not keep there")


def rmtree_at(fd: int, name: str) -> None:
    """The entry `name` of the folder `fd` removed: a folder with all it holds, a link as a link, without following a
    link inside it. Nothing when it is missing."""
    try:
        sub = os.open(name, DIR_FLAGS, dir_fd=fd)
    except FileNotFoundError:
        return
    except OSError as e:
        if e.errno not in _LINKED:
            raise
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name, dir_fd=fd)
        return
    try:
        for entry in os.listdir(sub):
            rmtree_at(sub, entry)
    finally:
        os.close(sub)
    with contextlib.suppress(FileNotFoundError):
        os.rmdir(name, dir_fd=fd)


def rmtree(path: PathLike, *, root: PathLike | None = None, ignore_errors: bool = False) -> None:
    """rmtree_at for `path`, its folder walked (walk)."""
    parent, name = _parent(path)
    try:
        with folder(parent, root=root) as fd:
            rmtree_at(fd, name)
    except FileNotFoundError:
        pass
    except OSError:
        if not ignore_errors:
            raise
