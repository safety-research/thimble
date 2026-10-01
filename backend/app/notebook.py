"""Canvas groups and cells: storage, kernels, execution, bounded outputs, SSE.

A group is a notebook file, workspaces/<c>/notebooks/<id>.json, carrying tree fields (parent, kind, anchor, chat), its
role and its cells. Runnable cells carry code and outputs and run on a kernel; data cells carry a payload. Kernels are
detached processes the workspace owns (see the kernels section): one shared kernel for exploration groups, one per group
for everything else (_kernel_for). Oversized stream outputs are bounded to a head and tail with the full text in a side
file. The in-memory notebook cache is used by the event-loop thread only.
"""
from __future__ import annotations

import asyncio
import atexit
import contextlib
import copy
import fcntl
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse, Response
from jupyter_client import AsyncKernelClient
from jupyter_client.connect import write_connection_file
from pydantic import BaseModel, Field
from sse_starlette import EventSourceResponse, ServerSentEvent

from . import cite, config, frames, kernel_wrap, page_fonts, procs, srt
from .ledger import atomic_write_text, read_json, unlinked, write_json

log = logging.getLogger("thimble.notebook")


@asynccontextmanager
async def _lifespan(app: Any):
    """The router's lifespan: first mark the cells the previous server left `running`, then reconnect the recorded
    kernels in the background, so /api/health answers at once. `_reconnect_done` tells wait_reconnect a reconnect is
    under way."""
    global _reconnect_done
    try:
        marked = await asyncio.to_thread(mark_interrupted_cells)
        if marked:
            log.info("cells left running by the previous server, marked interrupted: %s", ", ".join(marked))
    except Exception:  # noqa: BLE001 — never fails the start
        log.exception("marking interrupted cells failed")
    _reconnect_done = asyncio.Event()
    task = asyncio.create_task(_reconnect_on_start())
    try:
        yield
    finally:
        if not task.done():
            task.cancel()


router = APIRouter(lifespan=_lifespan)

EXEC_TIMEOUT = 120.0  # seconds a cell may run before the kernel is interrupted; a run may pass `timeout_s` for longer
# The default allowance for a cell a chat runs, passed as `default_timeout_s` and never stored on the cell.
CHAT_EXEC_TIMEOUT = 30.0
STARTUP_TIMEOUT = 60.0
PANDAS_COLWIDTH = 200  # the widest value a DataFrame shows before it cuts it (kernel_argv)
ERROR_MIME = "application/vnd.thimble.error+json"

# Bounded stream output. Env-overridable; read at call time so tests can lower them.
OUTPUT_MAX_LINES = int(os.environ.get("THIMBLE_OUTPUT_MAX_LINES", "10000"))
OUTPUT_MAX_BYTES = int(os.environ.get("THIMBLE_OUTPUT_MAX_BYTES", str(1_000_000)))
OUTPUT_HEAD_LINES = int(os.environ.get("THIMBLE_OUTPUT_HEAD_LINES", "5000"))
OUTPUT_TAIL_LINES = int(os.environ.get("THIMBLE_OUTPUT_TAIL_LINES", "2000"))
OUTPUTS_DIR = "notebooks/outputs"  # workspace-relative; side files are <cell id>-<output index>.txt
# Where DELETE /notebooks/{nb} moves a group whole, outside list_notebooks' glob, so it can be moved back.
TRASH_DIR = "notebooks/trash"
_SIDE_NAME_RE = re.compile(r"^([A-Za-z0-9_-]+)-(\d+)\.txt$")

_VENV_PYTHON = config.REPO_ROOT / "backend" / ".venv" / "bin" / "python"
PYTHON = str(_VENV_PYTHON) if _VENV_PYTHON.exists() else sys.executable

# The kernel runs analyst- and model-authored code with network access, and its outputs are shown to the model, so it
# must not inherit the backend's secrets. Nothing in the kernel needs them.
_SECRET_ENV_PREFIXES = ("ANTHROPIC_", "OP_", "THIMBLE_", "CLAUDE_")
_SECRET_ENV_RE = re.compile(r"API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", re.I)


def kernel_env() -> dict[str, str]:
    """The backend's environment minus anything that looks like a secret."""
    return {k: v for k, v in os.environ.items()
            if not k.startswith(_SECRET_ENV_PREFIXES) and not _SECRET_ENV_RE.search(k)}


SCRATCH_DIR = "scratch"  # workspace-relative: the kernels' cwd, a symlink mirror of the corpus plus what cells write
VCS_DIR = ".git"  # left out of the mirror (mirror_corpus)


MIRRORS_DIR = "mirrors"  # under thimble's home, which no kernel reads or writes: each scratch mirror's manifest


def _mirror_manifest(scratch: Path) -> Path:
    return _home() / MIRRORS_DIR / f"{hashlib.sha1(str(scratch.resolve()).encode()).hexdigest()[:16]}.json"


def _dir_mtime_ns(path: Path, follow: bool = False) -> int | None:
    try:
        st = os.stat(path, follow_symlinks=follow)
    except OSError:
        return None
    return st.st_mtime_ns if stat.S_ISDIR(st.st_mode) else None


def _drop_dangling(p: Path) -> None:
    if os.path.islink(p) and not os.path.exists(p):
        with contextlib.suppress(OSError):
            p.unlink()


def _mirror_folder(src: Path, dest: Path, names: list[str], links: frozenset[str], dirs: tuple[str, ...] = ()) -> None:
    """One folder of the mirror: a link in `dest` to each of `names` in `src` (`links`, the names that are links in the
    corpus, only while their target exists), re-pointed when it points elsewhere, and the links in `dest` whose target
    is gone removed. A real entry under a corpus name is the kernel's and stays. A link to `src`'s entry under the name of
    one of its folders `dirs` (a corpus file that became a folder) is removed, so the folder can be mirrored."""
    have: dict[str, bool] = {}  # name in dest -> whether it is a link
    with contextlib.suppress(OSError), os.scandir(dest) as it:
        for e in it:
            have[e.name] = e.is_symlink()
    for name in dirs:
        if have.get(name):
            with contextlib.suppress(OSError):
                if os.readlink(dest / name) == str(src / name):
                    (dest / name).unlink()
    for name in names:
        target = src / name
        if name in links and not os.path.exists(target):
            continue
        is_link = have.get(name)
        if is_link is False:
            continue  # a real file the kernel wrote under a corpus file's name: left as it is
        link = dest / name
        if is_link:
            try:
                if os.readlink(link) == str(target):
                    continue
                link.unlink()
            except OSError:
                continue
        try:
            os.symlink(target, link)
        except OSError:
            log.exception("scratch mirror: could not link %s", link)
    wanted = set(names) - links
    for name, is_link in have.items():
        if is_link and name not in wanted:
            _drop_dangling(dest / name)


def mirror_corpus(corpus: Path, scratch: Path) -> None:
    """Make `scratch` mirror the tree under `corpus`: every corpus directory a real directory, every file a symlink, so
    a kernel with `scratch` as cwd reads the corpus by the same relative paths and writes only into `scratch`.
    Idempotent: entries the kernel created are left alone, dangling symlinks removed, moved targets re-pointed.

    The corpus's folders come from corpus_walk, and a manifest under thimble's home keeps, for each folder mirrored,
    its mtime and its scratch folder's mtime as they were right after: a folder whose two mtimes are unchanged is
    skipped without reading either, so mirroring an unchanged corpus costs two stats per folder. A folder that holds
    links is mirrored on every pass, since a link's target comes and goes without its folder's mtime moving. Without a
    manifest for this corpus, the dangling links anywhere in `scratch` are removed first, as no record says which
    corpus folders went. Blocking."""
    from . import corpus_walk  # noqa: PLC0415

    corpus = corpus.resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    manifest = _mirror_manifest(scratch)
    try:
        saved = read_json(manifest, None)
    except (OSError, ValueError):
        saved = None
    done: dict[str, list[int]] = {}
    if isinstance(saved, dict) and saved.get("corpus") == str(corpus) and isinstance(saved.get("dirs"), dict):
        done = {k: v for k, v in saved["dirs"].items() if isinstance(v, list) and len(v) == 2}
    if not done:
        for root, dirs, files in os.walk(scratch):
            for name in [*files, *dirs]:
                _drop_dangling(Path(root) / name)
    # a corpus that is a git repository keeps its objects under .git, never data for a card
    tree = corpus_walk.walk(corpus, frozenset({VCS_DIR}))
    kept: dict[str, list[int]] = {}
    skipped: set[str] = set()
    for rel, folder in tree.items():
        if rel and rel.rpartition("/")[0] in skipped:
            skipped.add(rel)
            continue
        dest = scratch / rel if rel else scratch
        now: int | None = None
        try:
            st = os.stat(dest, follow_symlinks=not rel)
        except FileNotFoundError:
            dest.mkdir()
        else:
            if not stat.S_ISDIR(st.st_mode):
                skipped.add(rel)  # a kernel-made file where the corpus has a directory: the kernel's entry wins
                continue
            now = st.st_mtime_ns
        was = done.get(rel)
        if was is not None and not folder.racy and not folder.links and was == [folder.mtime_ns, now]:
            kept[rel] = was
            continue
        _mirror_folder(corpus / rel if rel else corpus, dest, folder.file_names(), folder.link_names(), folder.dirs)
        for sub in folder.dirs:  # made now, so that the mtime kept below is the one the next pass finds
            with contextlib.suppress(FileExistsError):
                (dest / sub).mkdir()
        after = _dir_mtime_ns(dest, follow=not rel)
        # a folder listed in its racy window is kept with times no pass matches: mirrored again, and swept once gone
        kept[rel] = [folder.mtime_ns, after] if not folder.racy and after is not None else [-1, -1]
    gone = set(done) - set(tree)
    for rel in gone:
        parts = rel.split("/")
        if any("/".join(parts[:i]) in gone for i in range(1, len(parts))):
            continue
        top = scratch / rel
        try:
            unlinked(scratch, top)
        except ValueError:
            continue
        if top.is_symlink():
            continue  # a kernel's link in place of the folder: what it points at is not the mirror's
        for root, dirs, files in os.walk(top):  # the corpus folder is gone, and so are its files
            for name in [*files, *dirs]:
                _drop_dangling(Path(root) / name)
    try:
        manifest.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(manifest, json.dumps({"corpus": str(corpus), "scratch": str(scratch.resolve()), "dirs": kept},
                                               separators=(",", ":")))
    except OSError:
        log.warning("scratch mirror: its manifest %s could not be written", manifest)
    _prune_manifests(manifest)


_manifests_pruned = False


def _prune_manifests(keep: Path) -> None:
    """Remove, once per server run, the manifests of scratch mirrors that are gone, such as a deleted workspace's."""
    global _manifests_pruned
    if _manifests_pruned:
        return
    _manifests_pruned = True
    for p in keep.parent.glob("*.json"):
        if p == keep:
            continue
        try:
            saved = read_json(p, None)
        except (OSError, ValueError):
            saved = None
        where = saved.get("scratch") if isinstance(saved, dict) else None
        if not isinstance(where, str) or not os.path.isdir(where):
            with contextlib.suppress(OSError):
                p.unlink()


MIRROR_MEMO_S = 30.0  # a mirror this recent serves the next kernel's start too
_mirrored: dict[Path, float] = {}  # scratch dir -> when its mirror last ran (monotonic)
_mirror_lock = threading.Lock()  # kernels that start together wait for one walk


def scratch_dir(workspace: str, corpus: Path | None = None, *, fresh: bool = False) -> Path:
    """workspaces/<c>/scratch, mirrored over the corpus and returned: every kernel's cwd. Blocking; kernels starting
    within MIRROR_MEMO_S of the last mirror reuse it rather than walking the corpus again, unless `fresh`."""
    scratch = config.workspace_dir(workspace) / SCRATCH_DIR
    with _mirror_lock:
        last = _mirrored.get(scratch)
        if fresh or last is None or time.monotonic() - last >= MIRROR_MEMO_S or not scratch.is_dir():
            mirror_corpus(corpus if corpus is not None else config.corpus_dir(workspace), scratch)
            _mirrored[scratch] = time.monotonic()
    return scratch


# ----------------------------------------------------------------------------------------------------------
# storage
# ----------------------------------------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id() -> str:
    return secrets.token_hex(4)


MAIN = "main"  # the group a workspace's first cells land in when none is bound; created on demand
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DEFAULT_TITLE = "Notebook"
ANALYST_NOTEBOOK_TITLE = "Your work"  # the analyst's own group; tools.ANALYST_NOTEBOOK_TITLE repeats it
UNNAMED_MAIN_TITLES = ("", DEFAULT_TITLE, "Your notebook")  # stored defaults of `main` the analyst never typed

# A group's role: `exploration` is the orientation's deck, `analyst` the analyst's own group and every thread's;
# `figures` and `finding` are read from stored workspaces. A stored `working` reads as `exploration`, and
# migrate_scratch moves such groups out of the deck.
ROLES = ("exploration", "finding", "analyst", "figures")
DEFAULT_ROLE = "analyst"
LEGACY_WORKING = "working"
FIGURES_ROLE = "figures"
LEGACY_FIGURES_TITLE = "Report figures"  # a figures group stored under role finding
TERMINAL_CREATOR = "terminal"  # created_by of the terminal session's group and cells; the group runs on its own kernel
# how a group lays out its children on the canvas: sequence a column, split a row, grid two columns; a loose group
# draws no frame, its cards sit on the board at their own positions (the cards dragged out of every group)
GROUP_KINDS = ("sequence", "split", "grid", "loose")
DEFAULT_GROUP_KIND = "sequence"
LOOSE_KIND = "loose"
LOOSE_TITLE = "Loose cards"

CELL_KINDS = ("plot", "table", "code", "example", "note", "diagram", "timeline", "label", "custom")
RUNNABLE_KINDS = ("plot", "table", "code", "timeline", "diagram")  # carry code and outputs
DATA_KINDS = ("example", "note", "label", "custom")  # carry a payload
DEFAULT_KIND = "code"
KEPT_ARGS = "kept_args"  # a card type's call arguments Keep set, which the card check gives back as they are
TAKEAWAY_STALE = "takeaway_stale"  # the takeaway was written before the card's last run changed its outputs
# the payload key per data shape; a diagram or a timeline without code carries a dataset
PAYLOAD_KEYS = {"example": "refs", "note": "text", "label": "concept", "custom": "html", "diagram": "dataset", "timeline": "dataset"}
# The canvas layout fields. A group's `pos` {x, y} is on the board for a root group, inside its parent's frame for a
# nested one; null for the default placement. A cell's `pos` works the same way (on the board for a loose card), with
# `width` and `height` in px (null: default width, content height) and `starred`.
CARD_WIDTH_MIN = 220
CARD_WIDTH_MAX = 1200
CARD_HEIGHT_MIN = 100
CARD_HEIGHT_MAX = 4000


def _ws(workspace: str) -> Path:
    try:
        return config.workspace_dir(workspace)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


def notebooks_dir(ws: Path) -> Path:
    """workspaces/<c>/notebooks/, migrating a v0 notebook.json into notebooks/main.json when seen. Does not create the
    directory, so reads never leave files behind."""
    d = ws / "notebooks"
    old = ws / "notebook.json"
    if old.is_file() and not (d / f"{MAIN}.json").exists():
        try:
            data = json.loads(old.read_text("utf-8"))
        except ValueError:
            log.warning("%s is not valid JSON; migrating an empty main notebook and keeping it as notebook.json.bad", old)
            data, bad = {}, True
        else:
            bad = False
        cells = data.get("cells") if isinstance(data, dict) else None
        d.mkdir(exist_ok=True)
        write_json(d / f"{MAIN}.json", _normalize(MAIN, {"title": ANALYST_NOTEBOOK_TITLE, "cells": cells or []}))
        old.replace(old.with_suffix(".json.bad")) if bad else old.unlink()
        log.info("migrated %s -> notebooks/%s.json", old, MAIN)
    return d


def _nb_file(ws: Path, nb_id: str) -> Path:
    if not ID_RE.match(nb_id or ""):
        raise HTTPException(404, f"invalid notebook id: {nb_id!r}")
    return notebooks_dir(ws) / f"{nb_id}.json"


def _created() -> str:
    """Creation stamp of a notebook: microseconds, so the list order is creation order even within one second."""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _title(nb_id: str, role: str, stored: Any) -> str:
    """A group's title as read: what is stored, else DEFAULT_TITLE; the analyst's `main` reads ANALYST_NOTEBOOK_TITLE
    unless the analyst renamed it."""
    title = str(stored) if stored else ""
    if nb_id == MAIN and role == DEFAULT_ROLE and title.strip() in UNNAMED_MAIN_TITLES:
        return ANALYST_NOTEBOOK_TITLE
    return title or DEFAULT_TITLE


def runnable(cell: dict) -> bool:
    """Whether a cell has code the kernel runs: a runnable kind carrying no payload (a diagram or a timeline may be
    either)."""
    return cell.get("kind", DEFAULT_KIND) in RUNNABLE_KINDS and not isinstance(cell.get("payload"), dict)


def _payload_of(kind: str, raw: Any) -> dict:
    """The payload a data cell of `kind` stores: the kind's key always present and coerced to its shape, other keys
    kept as given."""
    key = PAYLOAD_KEYS[kind]
    p = {**raw} if isinstance(raw, dict) else {}
    v = p.get(key)
    if key == "refs":
        items = v if isinstance(v, list) else [v] if v else []
        v = [str(r).strip().strip("[]") for r in items if str(r).strip()]
    elif key in ("text", "html"):
        v = str(v or "")
    elif key == "concept":
        v = str(v) if v else None
    p[key] = v
    return p


def _id_or_none(v: Any) -> str | None:
    return v if isinstance(v, str) and v else None


def _number(v: Any) -> float | None:
    """A finite number that is not a bool, else None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return None
    return float(v)


def pos_of(v: Any) -> dict | None:
    """A group's stored `pos` as {x, y} of ints, None for anything that is not one."""
    if not isinstance(v, dict):
        return None
    x, y = _number(v.get("x")), _number(v.get("y"))
    if x is None or y is None:
        return None
    return {"x": int(round(x)), "y": int(round(y))}


def clamp_width(v: Any) -> int | None:
    """A cell's `width` held to CARD_WIDTH_MIN..CARD_WIDTH_MAX; None for no width of its own."""
    n = _number(v)
    if n is None:
        return None
    return int(min(CARD_WIDTH_MAX, max(CARD_WIDTH_MIN, round(n))))


def clamp_height(v: Any) -> int | None:
    """A cell's `height` held to CARD_HEIGHT_MIN..CARD_HEIGHT_MAX; None for the content's height."""
    n = _number(v)
    if n is None:
        return None
    return int(min(CARD_HEIGHT_MAX, max(CARD_HEIGHT_MIN, round(n))))


def order_of(v: Any) -> int | None:
    """A group's `order` among its parent's cards: a count of them, 0 or more; None for after all of them."""
    n = _number(v)
    if n is None or n < 0:
        return None
    return int(n)


def _normalize_cell(c: dict, nb_id: str) -> None:
    """Give a stored cell the fields every reader expects. An `md` cell reads as a note, one without a kind as code."""
    c.setdefault("notebook", nb_id)
    kind = c.get("kind")
    if kind == "md":
        kind = "note"
        c["kind"] = kind
        c.setdefault("payload", {"text": c.get("text")})
    if kind not in CELL_KINDS:
        kind = DEFAULT_KIND
        c["kind"] = kind
    if kind in ("plot", "table", "code"):
        c.pop("payload", None)
    if runnable(c):
        c.setdefault("code", "")
        c.setdefault("outputs", [])
        c.setdefault("status", "idle")
        c.setdefault("exec_count", None)
        labels: list = []
    else:
        c["payload"] = _payload_of(kind, c.get("payload"))
        if kind == "note":
            c["text"] = c["payload"]["text"]
        labels = [c["payload"]["concept"]] if kind == "label" and c["payload"].get("concept") else []
    c.setdefault("title", "")
    c.setdefault("takeaway", "")
    c.setdefault("takeaway_author", None)
    c.setdefault("labels", labels)
    c.setdefault("locked", False)
    c.setdefault("created_at_event", None)
    c.setdefault("edited", [])
    c.setdefault("created_ts", c.get("ts"))
    c["width"] = clamp_width(c.get("width"))
    c["height"] = clamp_height(c.get("height"))
    c["pos"] = pos_of(c.get("pos"))
    c["starred"] = c.get("starred") is True


def _normalize(nb_id: str, data: Any) -> dict:
    """The stored group shape {id, title, ts, role, kind, parent, anchor, chat, investigation, finding, cells}. Missing
    fields are supplied at read time and land in the file on its next write."""
    data = data if isinstance(data, dict) else {}
    cells = [c for c in (data.get("cells") or []) if isinstance(c, dict)]
    for c in cells:
        _normalize_cell(c, nb_id)
    role = data.get("role")
    role = "exploration" if role == LEGACY_WORKING else role if role in ROLES else DEFAULT_ROLE
    kind = data.get("kind")
    kind = kind if kind in GROUP_KINDS else DEFAULT_GROUP_KIND
    inv = data.get("investigation")
    finding = data.get("finding")
    return {**data, "id": nb_id, "title": _title(nb_id, role, data.get("title")), "ts": str(data.get("ts") or _created()),
            "role": role, "kind": kind,
            "parent": _id_or_none(data.get("parent")), "anchor": _id_or_none(data.get("anchor")),
            "chat": _id_or_none(data.get("chat")),
            "investigation": inv if isinstance(inv, str) and inv else None,
            "finding": finding if isinstance(finding, int) and not isinstance(finding, bool) else None,
            "pos": pos_of(data.get("pos")), "order": order_of(data.get("order")),
            "cells": cells}


# --- bounded stream output ---


def _marker(omitted: int) -> str:
    return f"… {omitted} lines omitted; full output kept …"


def _stream_text(bundle: dict) -> str | None:
    tp = bundle.get("text/plain")
    if isinstance(tp, list):
        tp = "".join(map(str, tp))
    return tp if isinstance(tp, str) else None


def _oversized(text: str) -> bool:
    if len(text) > OUTPUT_MAX_BYTES:
        return True
    if text.count("\n") + (0 if text.endswith("\n") else 1) > OUTPUT_MAX_LINES:  # cheap count; splitlines decides
        return True
    return len(text) * 4 > OUTPUT_MAX_BYTES and len(text.encode("utf-8", "surrogatepass")) > OUTPUT_MAX_BYTES


def _kept(lines: list[str]) -> tuple[int, int]:
    """(head, tail) line counts to keep: OUTPUT_HEAD_LINES / OUTPUT_TAIL_LINES, fewer when the kept text would itself
    exceed OUTPUT_MAX_BYTES (60% of it for the head, 30% for the tail; at least one head line)."""
    n = len(lines)
    head, size = 0, 0
    for ln in lines[: min(OUTPUT_HEAD_LINES, n)]:
        size += len(ln)
        if size > OUTPUT_MAX_BYTES * 3 // 5 and head >= 1:
            break
        head += 1
    tail, size = 0, 0
    for ln in reversed(lines[max(head, n - OUTPUT_TAIL_LINES):]):
        size += len(ln)
        if size > OUTPUT_MAX_BYTES * 3 // 10:
            break
        tail += 1
    return head, tail


def _side_file(ws: Path, rel: Any) -> Path | None:
    """The side file a `truncated.path` names, or None unless it is a plain <cell>-<i>.txt under notebooks/outputs/."""
    if not isinstance(rel, str) or not rel.startswith(OUTPUTS_DIR + "/"):
        return None
    name = rel[len(OUTPUTS_DIR) + 1:]
    return ws / OUTPUTS_DIR / name if _SIDE_NAME_RE.match(name) else None


def _read_side(side: Path) -> str:
    with side.open("r", encoding="utf-8", errors="surrogatepass", newline="") as f:  # byte-exact: no newline translation
        return f.read()


def _bound_stream(ws: Path, cell_id: str, i: int, bundle: dict) -> dict:
    """The bundle, or its bounded form: head + marker + tail as text/plain, the complete text in the side file."""
    text = _stream_text(bundle)
    if text is None or not _oversized(text) or not ID_RE.match(cell_id or ""):
        return bundle
    lines = text.splitlines(keepends=True)
    head, tail = _kept(lines)
    omitted = len(lines) - head - tail
    if omitted < 1:
        return bundle
    side = ws / OUTPUTS_DIR / f"{cell_id}-{i}.txt"
    side.parent.mkdir(parents=True, exist_ok=True)
    with side.open("w", encoding="utf-8", errors="surrogatepass", newline="") as f:
        f.write(text)
    kept = "".join(lines[:head]) + _marker(omitted) + "\n" + "".join(lines[len(lines) - tail:])
    return {**bundle, "text/plain": kept,
            "truncated": {"total_lines": len(lines), "kept_head": head, "kept_tail": tail,
                          "path": f"{OUTPUTS_DIR}/{cell_id}-{i}.txt"}}


def _drop_side_files(ws: Path, cell_id: str) -> None:
    d = ws / OUTPUTS_DIR
    if d.is_dir() and ID_RE.match(cell_id or ""):
        for p in d.glob(f"{cell_id}-*.txt"):
            try:
                p.unlink()
            except OSError:
                pass


def bound_outputs(ws: Path, cell_id: str, outputs: list, *, fresh: bool = False) -> list:
    """`outputs` with every oversized stream bundle bounded (side files written); the SAME list object when nothing
    changed. `fresh` (a new run of the cell) first removes the cell's side files from earlier runs."""
    if fresh:
        _drop_side_files(ws, cell_id)
    out: list | None = None
    for i, b in enumerate(outputs or []):
        if isinstance(b, dict) and "_stream" in b and "truncated" not in b:
            nb = _bound_stream(ws, cell_id, cite.output_index(b, i), b)
            if nb is not b:
                if out is None:
                    out = list(outputs)
                out[i] = nb
    return out if out is not None else outputs


def _bound_cells(ws: Path, nb: dict) -> bool:
    """Bound the oversized untruncated stream bundles of a loaded notebook's cells. True when anything changed."""
    changed = False
    for c in nb["cells"]:
        outs = c.get("outputs")
        if isinstance(outs, list) and outs:
            new = bound_outputs(ws, str(c.get("id") or ""), outs)
            if new is not outs:
                c["outputs"] = new
                changed = True
    return changed


def output_full_text(ws: Path, cell: dict, i: int) -> str | None:
    """The complete text/plain of the cell's output bundle with index `i` (cite.output_at): the side file of a bounded
    stream bundle (its stored text when the file is gone), else the stored text. None when there is no such bundle or
    it has no text/plain."""
    b = cite.output_at(cell.get("outputs"), i)
    if b is None:
        return None
    tr = b.get("truncated")
    if isinstance(tr, dict):
        side = _side_file(ws, tr.get("path"))
        if side is not None and side.is_file():
            return _read_side(side)
    return _stream_text(b)


def _output_kind(b: dict) -> str:
    """What a bundle is, for matching across runs: error, stream:<name>, frame (a table card's DataFrame, frames.py),
    chart, image, table, markdown or text."""
    if ERROR_MIME in b:
        return "error"
    if frames.FRAME_MIME in b:
        return "frame"
    if "_stream" in b:
        return f"stream:{b.get('_stream') or 'stdout'}"
    if any("vega" in k for k in b):
        return "chart"
    if any(k.startswith("image/") for k in b):
        return "image"
    if "text/html" in b:
        return "table"
    if "text/markdown" in b:
        return "markdown"
    return "text"


def _output_digest(b: dict) -> str:
    """kind + a hash of the bundle's content: a table's html, a chart's spec, an image's bytes, else its text (a bounded
    stream's stored head and tail)."""
    kind = _output_kind(b)
    if kind == "error":
        e = b.get(ERROR_MIME) or {}
        payload = json.dumps([e.get("ename"), e.get("evalue")], ensure_ascii=False) if isinstance(e, dict) else str(e)
    elif kind == "chart":
        v = next(b[k] for k in b if "vega" in k)
        payload = json.dumps(v, sort_keys=True, ensure_ascii=False, default=str) if not isinstance(v, str) else v
    elif kind == "image":
        v = next(b[k] for k in b if k.startswith("image/"))
        payload = "".join(map(str, v)) if isinstance(v, list) else str(v)
    elif kind == "table":
        payload = cite._bundle_html(b)
    elif kind == "frame":
        f = b.get(frames.FRAME_MIME) if isinstance(b.get(frames.FRAME_MIME), dict) else {}
        payload = json.dumps([f.get("columns"), f.get("rows")], ensure_ascii=False, default=str)
    else:
        payload = cite._bundle_text(b)
    return kind + ":" + hashlib.sha1(payload.encode("utf-8", "surrogatepass")).hexdigest()


def _table_header(b: dict) -> str:
    """A table bundle's column headers joined, for pairing a re-rendered table (other rows, other values) with its
    earlier self before any other table of the cell."""
    rows = cite._ROW_RE.findall(cite._bundle_html(b))
    if not rows:
        return ""
    return "|".join(cite._strip_tags(m.group(2)) for m in cite._CELL_RE.finditer(rows[0]))


OUT_MEMO = "out_memo"  # the cell's last run that produced output, as output_memo records it


def output_memo(outputs: list | None, previous: dict | None = None) -> dict:
    """What a run's outputs were, for pairing a later run's with them: `outs` holds per bundle its index `i`, digest `d`
    and, for a table, its column headers `h`; `next` is the first index no output of the cell has had, so a dropped
    output's index is never reused."""
    outs: list[dict] = []
    for i, b in cite.iter_outputs(outputs):
        rec: dict = {"i": i, "d": _output_digest(b)}
        if rec["d"].startswith("table:"):
            rec["h"] = _table_header(b)
        outs.append(rec)
    prev_next = previous.get("next") if isinstance(previous, dict) else None
    nxt = max([r["i"] + 1 for r in outs] + [prev_next if isinstance(prev_next, int) and not isinstance(prev_next, bool) else 0])
    return {"next": nxt, "outs": outs}


def _memo_of(cell: dict) -> dict | None:
    """The memo a run of `cell` pairs its outputs against: the stored OUT_MEMO, else its stored outputs' (None when
    none)."""
    memo = cell.get(OUT_MEMO)
    if isinstance(memo, dict) and isinstance(memo.get("outs"), list):
        return memo
    return output_memo(cell.get("outputs")) if cell.get("outputs") else None


def _has_output(outputs: list) -> bool:
    """Whether a run produced an output that is not an error: such a run's outputs become the cell's memo."""
    return any(isinstance(b, dict) and _output_kind(b) != "error" for b in outputs)


def number_outputs(memo: dict | None, outputs: list) -> list:
    """`outputs` with each bundle's `_out` index set so an output the last productive run also had keeps its index:
    first by same content, then by same kind (tables with the same columns first); unmatched bundles take indices from
    `memo["next"]` on. The field is written only when some index differs from its position. Returns the same list."""
    prev: list[dict] = [r for r in ((memo or {}).get("outs") or []) if isinstance(r, dict) and isinstance(r.get("i"), int)]
    ids: list[int | None] = [None] * len(outputs)
    used: set[int] = set()
    if prev:
        digests = {pos: _output_digest(b) for pos, b in enumerate(outputs) if isinstance(b, dict)}
        for pos, d in digests.items():
            pid = next((r["i"] for r in prev if r["i"] not in used and r.get("d") == d), None)
            if pid is not None:
                ids[pos] = pid
                used.add(pid)
        for same_columns in (True, False):  # every table with its earlier self first, then anything of the same kind
            for pos, b in enumerate(outputs):
                if ids[pos] is not None or not isinstance(b, dict):
                    continue
                kind = _output_kind(b)
                if same_columns and kind != "table":
                    continue
                cands = [r for r in prev if r["i"] not in used and str(r.get("d", "")).rsplit(":", 1)[0] == kind]  # the digest is kind:hash; a stream's kind has its own colon
                if same_columns:
                    hdr = _table_header(b)
                    cands = [r for r in cands if r.get("h") == hdr]
                if cands:
                    ids[pos] = cands[0]["i"]
                    used.add(cands[0]["i"])
    stored_next = (memo or {}).get("next")
    nxt = max([stored_next if isinstance(stored_next, int) and not isinstance(stored_next, bool) else 0]
              + [r["i"] + 1 for r in prev] + [i + 1 for i in ids if i is not None])
    for pos, b in enumerate(outputs):
        if isinstance(b, dict) and ids[pos] is None:
            ids[pos] = nxt
            nxt += 1
    positional = all(i is None or i == pos for pos, i in enumerate(ids))
    for pos, b in enumerate(outputs):
        if isinstance(b, dict):
            if positional:
                b.pop(cite.OUT_KEY, None)
            else:
                b[cite.OUT_KEY] = ids[pos]
    return outputs


def hydrate_outputs(ws: Path, outputs: list | None) -> list:
    """Copies of the bounded stream bundles with their complete text: what cite.py searches, so a number in the omitted
    region still links with line numbers counting the complete text."""
    out: list = []
    for b in outputs or []:
        if isinstance(b, dict) and isinstance(b.get("truncated"), dict):
            side = _side_file(ws, b["truncated"].get("path"))
            if side is not None and side.is_file():
                b = {**{k: v for k, v in b.items() if k != "truncated"}, "text/plain": _read_side(side)}
        out.append(b)
    return out


# --- in-memory cache ---

_cache: dict[Path, tuple[tuple[int, int, int], dict]] = {}  # notebook file -> ((mtime_ns, size, inode), notebook)
CACHE_MAX = 64


def _caching() -> bool:
    """Only the event-loop thread uses the cache; worker threads never share its objects."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _sig(st: os.stat_result) -> tuple[int, int, int]:
    return st.st_mtime_ns, st.st_size, st.st_ino


def _cache_put(p: Path, sig: tuple[int, int, int], nb: dict) -> None:
    _cache.pop(p, None)
    _cache[p] = (sig, nb)
    while len(_cache) > CACHE_MAX:
        _cache.pop(next(iter(_cache)))


def clear_cache() -> None:
    _cache.clear()


def read_notebook(ws: Path, nb_id: str) -> dict | None:
    """The notebook, or None if there is no such notebook. `main` always exists (empty until first written).

    On the event-loop thread this is the cached object while the file is unchanged (mtime_ns/size/inode); callers mutate
    it and call write_notebook. A file holding an oversized unbounded stream bundle is bounded and written back once.
    """
    p = _nb_file(ws, nb_id)
    caching = _caching()
    try:
        st: os.stat_result | None = p.stat()
    except OSError:
        st = None
    if st is None or not stat.S_ISREG(st.st_mode):
        if caching:
            _cache.pop(p, None)
        return _normalize(MAIN, {}) if nb_id == MAIN else None
    sig = _sig(st)
    if caching:
        hit = _cache.get(p)
        if hit is not None and hit[0] == sig:
            return hit[1]
    nb = _normalize(nb_id, json.loads(p.read_text("utf-8")))
    if caching:
        if _bound_cells(ws, nb):
            log.info("bounded oversized stream outputs in %s", p)
            write_notebook(ws, nb)  # caches the written state
        else:
            _cache_put(p, sig, nb)
    return nb


def write_notebook(ws: Path, nb: dict) -> None:
    p = _nb_file(ws, nb["id"])
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(p, json.dumps(nb, indent=1))  # a temp of the writer's own: a route and a kernel thread never share one
    if _caching():
        _cache_put(p, _sig(p.stat()), nb)


INTERRUPTED_ENAME = "Interrupted"
INTERRUPTED_EVALUE = "the server stopped while this card ran; run it again"


def mark_interrupted_cells(root: Path | None = None) -> list[str]:
    """Server start: a cell stored `running` was mid-run when the previous server went away, and nothing will write its
    result. Mark each such cell errored with one Interrupted output (code, title and place stay), and end a pending card
    check the same way. Reads every workspace under `root` directly and writes changed notebooks back atomically.
    Returns `<workspace>/<notebook>/<cell>` per cell marked."""
    from . import checkstore  # noqa: PLC0415 — checkstore imports this module

    root = config.WORKSPACES_DIR if root is None else root
    marked: list[str] = []
    files = sorted(root.glob("*/notebooks/*.json")) if root.is_dir() else []
    for p in files:
        if not ID_RE.match(p.stem):
            continue
        try:
            nb = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        cells = nb.get("cells") if isinstance(nb, dict) else None
        if not isinstance(cells, list):
            continue
        changed = False
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            # a card check the previous server left pending ends too, so its card does not keep the check's spinner
            if checkstore.interrupted(cell):
                changed = True
                marked.append(f"{p.parent.parent.name}/{p.stem}/{cell.get('id')} (its check)")
            if cell.get("status") != "running":
                continue
            cell.update(status="error", outputs=[_error_bundle(INTERRUPTED_ENAME, INTERRUPTED_EVALUE)], ts=_now())
            changed = True
            marked.append(f"{p.parent.parent.name}/{p.stem}/{cell.get('id')}")
        if changed:
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(nb, indent=1))
            tmp.replace(p)
            _cache.pop(p, None)
    return marked


def summary(nb: dict) -> dict:
    """A group's row in a listing: its record without the cells, plus n_cells."""
    out = {"id": nb["id"], "title": nb["title"], "n_cells": len(nb["cells"]), "ts": nb["ts"],
           "role": nb.get("role", DEFAULT_ROLE), "kind": nb.get("kind", DEFAULT_GROUP_KIND), "parent": nb.get("parent"),
           "anchor": nb.get("anchor"), "chat": nb.get("chat"),
           "investigation": nb.get("investigation"), "finding": nb.get("finding"), "pos": nb.get("pos"),
           "order": nb.get("order")}
    if nb.get("created_by"):
        out["created_by"] = nb["created_by"]
    if nb.get("session"):  # the THIMBLE_SESSION whose own group it is (tools.SESSION_GROUP_KEY), such as `writer:report`
        out["session"] = nb["session"]
    return out


def _stored(ws: Path) -> list[tuple[str, dict]]:
    """(id, group) for every stored group file (cached on the loop thread; unreadable files are skipped)."""
    d = notebooks_dir(ws)
    out: list[tuple[str, dict]] = []
    for p in sorted(d.glob("*.json")) if d.is_dir() else ():
        if not ID_RE.match(p.stem):
            continue
        try:
            nb = read_notebook(ws, p.stem)
        except ValueError:
            log.warning("skipping unreadable notebook %s", p)
            continue
        if nb is not None:
            out.append((p.stem, nb))
    return out


# A card's name: a unique slug of its question such as `runs-one-end`, shown where the browser would otherwise show its
# id. It is stored when the card is made and remade when the question changes; a card stored without one gets one when
# read (cell_slugs). lib/cellName.slugFromTitle is the same rule.
_SLUG_STOP = frozenset("how what which when where why who do does did the a an of in on for to and or is are was were by per "
                       "each with from at as that this these those many much".split())
SLUG_WORDS = 3
SLUG_MAX = 28
SLUG_DEFAULT = "card"


def slug_of(title: str) -> str:
    """The first SLUG_WORDS words of a question that are not stop words or bare numbers, joined by hyphens, at most
    SLUG_MAX characters ("How do the 16 runs compare in size" is runs-compare-size); SLUG_DEFAULT for a question with
    none."""
    words = [w.strip("-") for w in re.sub(r"[^a-z0-9\s-]", " ", (title or "").lower()).split()]
    words = [w for w in words if w and w not in _SLUG_STOP and not w.isdigit()]
    slug = re.sub(r"-{2,}", "-", "-".join(words[:SLUG_WORDS]))[:SLUG_MAX].rstrip("-")
    return slug or SLUG_DEFAULT


def unique_slug(base: str, taken: set[str]) -> str:
    """`base`, or base-2, base-3 … when another card has it."""
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def cell_slugs(ws: Path) -> dict[str, str]:
    """{card id: its name} for every card of the workspace: the name stored on it, else one made from its question, in
    the order the groups are stored, never one another card already has."""
    cells = [c for _nb_id, nb in _stored(ws) for c in nb.get("cells") or [] if isinstance(c, dict) and c.get("id")]
    out: dict[str, str] = {}
    taken: set[str] = set()
    for c in cells:
        slug = c.get("slug")
        if isinstance(slug, str) and slug and slug not in taken:
            out[c["id"]] = slug
            taken.add(slug)
    for c in cells:
        if c["id"] not in out:
            out[c["id"]] = unique_slug(slug_of(c.get("title") or ""), taken)
            taken.add(out[c["id"]])
    return out


def _name_cell(ws: Path, cell: dict) -> None:
    """Store a name made from the card's question on it, one no other card of the workspace has."""
    taken = {slug for cid, slug in cell_slugs(ws).items() if cid != cell.get("id")}
    cell["slug"] = unique_slug(slug_of(cell.get("title") or ""), taken)


def with_slugs(ws: Path, cells: list[dict]) -> list[dict]:
    """`cells` each with its name (cell_slugs), a card stored without one copied rather than changed in place."""
    names: dict[str, str] | None = None
    out: list[dict] = []
    for c in cells:
        if isinstance(c.get("slug"), str) and c["slug"]:
            out.append(c)
            continue
        names = names if names is not None else cell_slugs(ws)
        out.append({**c, "slug": names.get(str(c.get("id")), slug_of(c.get("title") or ""))})
    return out


def is_figures(nb: dict | None) -> bool:
    """Whether a group (a record or its row) holds a document's figures (FIGURES_ROLE), the legacy shape included."""
    if not isinstance(nb, dict):
        return False
    return nb.get("role") == FIGURES_ROLE or (nb.get("role") == "finding" and str(nb.get("title") or "").strip() == LEGACY_FIGURES_TITLE)


def list_notebooks(ws: Path, *, figures: bool = True) -> list[dict]:
    """A row per stored group, oldest first. A document's figures group is in unless `figures` is false (its cells
    are what the made figures name)."""
    out = [summary(nb) for _, nb in _stored(ws) if figures or not is_figures(nb)]
    out.sort(key=lambda s: (s["ts"], s["id"]))
    return out


def tree_order(rows: list[dict]) -> list[dict]:
    """Group rows in tree order: the roots oldest first, each followed by its subtree."""
    ids = {r["id"] for r in rows}
    children: dict[str, list[dict]] = {}
    roots: list[dict] = []
    for r in sorted(rows, key=lambda s: (str(s.get("ts") or ""), s["id"])):
        parent = r.get("parent")
        if parent and parent in ids and parent != r["id"]:
            children.setdefault(parent, []).append(r)
        else:
            roots.append(r)
    out: list[dict] = []
    seen: set[str] = set()

    def walk(r: dict) -> None:
        if r["id"] in seen:
            return
        seen.add(r["id"])
        out.append(r)
        for child in children.get(r["id"], []):
            walk(child)

    for r in roots:
        walk(r)
    for r in rows:  # groups whose parents point at one another still list once
        walk(r)
    return out


def canvas(ws: Path) -> dict:
    """The canvas: every group the browser shows in tree order, and every cell of those groups, each with its name. A
    Scratch group (migrate_scratch) and its nested groups are left out with their cards, which still resolve by ref;
    `hidden` lists their ids so a citation click can say where the card went."""
    rows = tree_order(list_notebooks(ws, figures=False))
    parent = {r["id"]: r.get("parent") for r in rows}
    nbs = {r["id"]: read_notebook(ws, r["id"]) for r in rows}
    scratch = {gid for gid, nb in nbs.items() if nb is not None and nb.get(SCRATCH_KEY) is True}

    def hidden(gid: str) -> bool:
        seen: set[str] = set()
        g: str | None = gid
        while g and g not in seen:
            if g in scratch:
                return True
            seen.add(g)
            g = parent.get(g)
        return False

    groups = [r for r in rows if not hidden(r["id"])]
    cells: list[dict] = []
    for g in groups:
        nb = nbs.get(g["id"])
        if nb is not None:
            cells.extend(nb["cells"])
    left_out = [str(c.get("id")) for r in rows if hidden(r["id"]) for c in (nbs.get(r["id"]) or {}).get("cells", [])]
    return {"groups": groups, "cells": with_slugs(ws, cells), "hidden": left_out}


def create_notebook(ws: Path, title: str | None = None, *, role: str = DEFAULT_ROLE, investigation: str | None = None,
                    finding: int | None = None, created_by: str | None = None, parent: str | None = None,
                    anchor: str | None = None, chat: str | None = None, kind: str | None = None,
                    pos: Any = None, order: Any = None) -> dict:
    """A new empty group. `parent` names the group it sits under, `anchor` the cell it sits beside, `chat` the chat
    whose cards land in it, `kind` how its children render, `pos` and `order` where it sits (the layout fields above).
    ValueError for a role or kind outside the lists or an unknown parent."""
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}, not {role!r}")
    if kind is not None and kind not in GROUP_KINDS:
        raise ValueError(f"kind must be one of {GROUP_KINDS}, not {kind!r}")
    if parent is not None and (not ID_RE.match(parent) or read_notebook(ws, parent) is None):
        raise ValueError(f"no such group: {parent}")
    n = len(list_notebooks(ws)) + 1
    data: dict = {"title": (title or "").strip() or f"{DEFAULT_TITLE} {n}", "ts": _created(), "role": role,
                  "kind": kind or DEFAULT_GROUP_KIND, "parent": parent, "anchor": anchor, "chat": chat,
                  "investigation": investigation, "finding": finding, "pos": pos, "order": order, "cells": []}
    if created_by:
        data["created_by"] = created_by
    nb = _normalize(_new_id(), data)
    write_notebook(ws, nb)
    return nb


def set_parent(ws: Path, nb: dict, parent: str | None) -> None:
    """Move a group under `parent` (None for the root). ValueError when that would make a cycle."""
    seen: set[str] = set()
    p = parent
    while p and p not in seen:
        if p == nb["id"]:
            raise ValueError("a group cannot sit under itself")
        seen.add(p)
        rec = read_notebook(ws, p) if ID_RE.match(p) else None
        p = rec.get("parent") if rec else None
    nb["parent"] = parent


def _locate(ws: Path, cell_id: str) -> tuple[dict, dict] | None:
    """(notebook, cell) for a cell id, searching every notebook (cell ids are random, hence globally unique)."""
    for _, nb in _stored(ws):
        for c in nb["cells"]:
            if c.get("id") == cell_id:
                return nb, c
    return None


def find_cell(ws: Path, cell_id: str) -> tuple[str, dict] | None:
    """(group id, cell) for a cell id, searching every group (cell ids are random, hence unique across a workspace).
    Every reader of refs comes through here, so a `card:<id>` stays a live ref wherever its card moved."""
    hit = _locate(ws, cell_id)
    return (hit[0]["id"], hit[1]) if hit else None


def get_cell(workspace: str, cell_id: str, *, full_outputs: bool = False) -> dict | None:
    """The cell with this id from any notebook of the workspace (it carries its `notebook` id), or None.

    Raises 404 for an invalid workspace name like the routes. `full_outputs`: a copy whose bounded stream bundles carry
    their complete text (hydrate_outputs), for the citation pass over the cell's outputs; by default the cell as stored.
    """
    ws = _ws(workspace)
    hit = _locate(ws, cell_id)
    if hit is None:
        return None
    cell = hit[1]
    if full_outputs and any(isinstance(b, dict) and "truncated" in b for b in cell.get("outputs") or []):
        return {**cell, "outputs": hydrate_outputs(ws, cell["outputs"])}
    return dict(cell)  # a copy: the stored cell is the cached object, which later runs and edits mutate in place


def active_notebook_id(workspace: str) -> str:
    """settings.active_notebook when it names an existing notebook; else `main`, created if it does not exist yet."""
    ws = _ws(workspace)
    settings = read_json(ws / "settings.json", {})
    nb_id = settings.get("active_notebook") if isinstance(settings, dict) else None
    if isinstance(nb_id, str) and ID_RE.match(nb_id) and _nb_file(ws, nb_id).is_file():
        return nb_id
    if not _nb_file(ws, MAIN).is_file():
        write_notebook(ws, read_notebook(ws, MAIN))
    return MAIN


def load_notebook(workspace: str, nb_id: str = MAIN) -> dict:
    nb = read_notebook(_ws(workspace), nb_id)
    if nb is None:
        raise HTTPException(404, f"no such notebook: {nb_id}")
    return nb


def save_notebook(workspace: str, nb: dict) -> None:
    write_notebook(_ws(workspace), nb)


def _find(nb: dict, cell_id: str) -> dict:
    for c in nb["cells"]:
        if c["id"] == cell_id:
            return c
    raise HTTPException(404, f"no such card: {cell_id}")


def new_cell(kind: str, created_by: str, title: str = "", notebook: str = MAIN, *, code: str | None = None,
             payload: dict | None = None, created_at_event: int | None = None) -> dict:
    """A new cell of `kind`, not yet stored. A runnable kind takes `code`, a data kind `payload`, a diagram or a
    timeline one of the two. ValueError for a kind outside CELL_KINDS or a combination that does not fit."""
    if kind not in CELL_KINDS:
        raise ValueError(f"kind must be one of {', '.join(CELL_KINDS)}, not {kind!r}")
    data = kind in DATA_KINDS or (kind in PAYLOAD_KEYS and code is None)
    if data and code is not None:
        raise ValueError(f"a {kind} card has a payload, not code")
    if not data and payload is not None:
        raise ValueError(f"a {kind} card has code, not a payload")
    now = _now()
    cell: dict = {"id": _new_id(), "notebook": notebook, "kind": kind, "title": title, "takeaway": "", "takeaway_author": None,
                  "labels": [], "locked": False, "created_by": created_by, "created_at_event": created_at_event,
                  "edited": [], "created_ts": now, "ts": now, "width": None, "height": None, "pos": None, "starred": False}
    if data:
        cell["payload"] = _payload_of(kind, payload)
        if kind == "note":
            cell["text"] = cell["payload"]["text"]
        if kind == "label" and cell["payload"]["concept"]:
            cell["labels"] = [cell["payload"]["concept"]]
    else:
        cell.update(code=str(code or ""), exec_count=None, status="idle", outputs=[])
    return cell


def insert_cell(workspace: str, nb_id: str, cell: dict, after: str | None = None) -> dict:
    """Store a new cell in a group, at the end or after the cell `after` names, with its name (slug_of), and announce it.
    404 for an unknown group."""
    nb = load_notebook(workspace, nb_id)
    cell["notebook"] = nb_id
    if not cell.get("slug"):
        _name_cell(_ws(workspace), cell)
    idx = len(nb["cells"])
    if after:
        for i, other in enumerate(nb["cells"]):
            if other.get("id") == after:
                idx = i + 1
                break
    nb["cells"].insert(idx, cell)
    save_notebook(workspace, nb)
    _emit(workspace, cell)
    return cell


def edit_cell(workspace: str, cell_id: str, *, code: str | None = None, title: str | None = None,
              takeaway: str | None = None, payload: dict | None = None, locked: bool | None = None,
              by: str | None = None, width: int | None = None, height: int | None = None,
              starred: bool | None = None, kept_args: dict | None = None, **layout: Any) -> dict:
    """Change the given fields of a cell and announce it: code on a runnable cell, a payload on a data cell (400
    otherwise). A change to code, payload or title is recorded in `edited`; a takeaway set here is the analyst's.
    `width`, `height`, `starred` and `pos` are layout, not edits. `locked` is the analyst's lock, which no model's tool
    may get past; only the browser sends it. `kept_args` are the arguments of a card type's call that Keep wrote with
    the code (cardtypes.keep_route); other new code drops them. 404 for an unknown cell."""
    ws = _ws(workspace)
    hit = _locate(ws, cell_id)
    if hit is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    nb, cell = hit
    was_locked = cell.get("locked") is True
    kind = cell.get("kind", DEFAULT_KIND)
    run = runnable(cell)
    if code is not None and not run:
        raise HTTPException(400, f"a {kind} card has no code")
    if payload is not None and run:
        raise HTTPException(400, f"a {kind} card has code, not a payload")
    changed = False
    if code is not None and code != cell.get("code"):
        cell["code"] = code
        cell.pop(KEPT_ARGS, None)
        changed = True
    if kept_args:
        cell[KEPT_ARGS] = kept_args
    if payload is not None:
        new = _payload_of(kind, payload)
        if new != cell.get("payload"):
            cell["payload"] = new
            if kind == "note":
                cell["text"] = new["text"]
            if kind == "label":
                cell["labels"] = [new["concept"]] if new["concept"] else []
            changed = True
    if title is not None and title != cell.get("title", ""):
        cell["title"] = title
        _name_cell(ws, cell)
        changed = True
    if changed:
        cell.setdefault("edited", []).append({"by": (by or "").strip() or "user", "ts": _now()})
    if takeaway is not None:
        cell["takeaway"] = takeaway
        cell["takeaway_author"] = "analyst" if takeaway.strip() else None
        cell.pop(TAKEAWAY_STALE, None)
        if takeaway.strip() and run:
            _verify_hook("takeaway", workspace, nb, cell)
    if locked is not None:
        cell["locked"] = bool(locked)
    if width is not None:
        cell["width"] = clamp_width(width)
    if height is not None:
        cell["height"] = clamp_height(height)
    if starred is not None:
        cell["starred"] = bool(starred)
    if "pos" in layout:
        cell["pos"] = pos_of(layout["pos"])
    write_notebook(ws, nb)
    _emit(workspace, cell)
    if locked is not None and bool(locked) != was_locked:
        from . import telemetry  # noqa: PLC0415

        telemetry.note(workspace, "lock" if locked else "unlock", f"card:{cell_id}")
    return cell


def delete_cell(workspace: str, cell_id: str) -> None:
    """Remove a cell from its group, with its outputs' side files. 404 for an unknown cell."""
    ws = _ws(workspace)
    hit = _locate(ws, cell_id)
    if hit is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    nb, _cell = hit
    nb["cells"] = [x for x in nb["cells"] if x.get("id") != cell_id]
    write_notebook(ws, nb)
    _drop_side_files(ws, cell_id)
    _emit(workspace, {**_cell, "notebook": nb["id"]}, what="deleted")


def loose_group(ws: Path) -> str:
    """The id of the workspace's loose group (LOOSE_KIND), made on first use: a card dragged out of every group lives
    there, at its own place on the board."""
    for nb_id, nb in _stored(ws):
        if nb.get("kind") == LOOSE_KIND:
            return nb_id
    return str(create_notebook(ws, LOOSE_TITLE, kind=LOOSE_KIND)["id"])


_LAST = object()  # move_cells' default `after`: the end of the group's flow


def move_cells(workspace: str, cell_ids: list[str], group: str | None, *, after: Any = _LAST, pos: Any = None) -> list[dict]:
    """Move cards into `group` (None for the loose group) in the order given: into its flow after the card `after` names
    (None first, default last), or one card free at `pos`. A runnable card that changes group keeps the kernel it ran
    on. Returns the moved cards. 404 for an unknown group or card; 400 for no cards, duplicates, `pos` with several
    cards, or a bad `after`. Nothing changes on an error."""
    ws = _ws(workspace)
    ids = [str(i) for i in cell_ids]
    if not ids:
        raise HTTPException(400, "no cards to move")
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "a card is named twice")
    if pos is not None and len(ids) > 1:
        raise HTTPException(400, "pos places one card; several cards go into the flow")
    if pos is not None and pos_of(pos) is None:
        raise HTTPException(400, "pos must be {x, y} numbers or null")
    target_id = group if group is not None else loose_group(ws)
    target = read_notebook(ws, target_id) if ID_RE.match(target_id or "") else None
    if target is None:
        raise HTTPException(404, f"no such group: {group}")
    # one object per group, whoever located it: off the event loop every read is a fresh copy (read_notebook)
    books: dict[str, dict] = {target_id: target}
    found: list[tuple[str, dict]] = []
    for cid in ids:
        hit = _locate(ws, cid)
        if hit is None:
            raise HTTPException(404, f"no such card: {cid}")
        src = books.setdefault(hit[0]["id"], hit[0])
        found.append((src["id"], next(c for c in src["cells"] if c.get("id") == cid)))
    if after is not _LAST and after is not None:
        if after in ids:
            raise HTTPException(400, "a card cannot follow itself")
        if not any(c.get("id") == after for c in target["cells"]):
            raise HTTPException(400, f"no card {after} in group {target_id}")
    moved: list[dict] = []
    for src_id, cell in found:
        src = books[src_id]
        src["cells"] = [c for c in src["cells"] if c.get("id") != cell["id"]]
        if src_id != target_id and runnable(cell) and not isinstance(cell.get("kernel"), str):
            cell["kernel"] = _kernel_for(src, None, cell, ws) or ""
        cell["notebook"] = target_id
        cell["pos"] = pos_of(pos)
        moved.append(cell)
    at = len(target["cells"]) if after is _LAST else 0
    if after is not _LAST and after is not None:
        at = next(i for i, c in enumerate(target["cells"]) if c.get("id") == after) + 1
    target["cells"][at:at] = moved
    for nb in books.values():
        write_notebook(ws, nb)
    for cell in moved:
        _emit(workspace, cell, what="moved")
    return moved


def _reject_data_run(cell: dict) -> None:
    """Every run path answers 400 for a data cell: it has no code."""
    if not runnable(cell):
        raise HTTPException(400, f"a {cell.get('kind', DEFAULT_KIND)} card has no code to run")


# ----------------------------------------------------------------------------------------------------------
# SSE subscribers
# ----------------------------------------------------------------------------------------------------------

_subscribers: dict[tuple[str, str], set[asyncio.Queue]] = {}  # (workspace, notebook id) -> queues


def _emit(workspace: str, cell: dict, *, what: str | None = None) -> None:
    """Announce a card change: the whole cell on its group's SSE, and one `cell {notebook, cell, kind}` record on the
    workspace stream. `what` names the change (ran, note, edited, deleted). Off the event loop the workspace record is
    skipped (investigation.emit is loop-only)."""
    data = json.dumps(cell)
    for q in _subscribers.get((workspace, cell.get("notebook", MAIN)), ()):
        q.put_nowait(data)
    cid = str(cell.get("id") or "")
    if not cid:
        return
    from . import canvas_history  # noqa: PLC0415 — every version of every card, for the workspace export

    op = canvas_history.record(workspace, cell, what)
    try:
        from . import investigation  # lazy: keeps this module light at import

        rec = {"type": "cell", "notebook": str(cell.get("notebook") or MAIN), "cell": cid,
               "kind": what or ("ran" if runnable(cell) else "note")}
        if op:  # the history's op (created, edited, ran, deleted, ...): the Canvas tab's dot lights for a card made or gone
            rec["op"] = op
        investigation.emit(workspace, investigation.MAIN, rec)
    except RuntimeError:  # no running loop: a worker thread; the group's SSE carried it
        pass
    except Exception:  # noqa: BLE001
        log.debug("workspace cell record not written", exc_info=True)


# - --------------------------------------------------------------------------------------------------------- kernels,
#  detached from the server
#  ----------------------------------------------------------------------------------------------------------
#
# A kernel is a process the workspace owns, launched in its own session without ipykernel's parent poller, so it
# outlives the server. It is recorded under workspaces/<c>/kernels/: <key>.json (name, pid, pgid, connection file, cwd,
# server pid, home, ...) beside <key>.conn.json (mode 0600) and <key>.log; `key` is `shared` or `k-<name>`.
#
# At start (reconnect_all, in the background) a kernel the previous server handed over and that answers kernel_info on
# its control channel is reconnected with its variables; one that does not answer within RECONNECT_TIMEOUT is killed; a
# kernel of this THIMBLE_HOME whose server ended without handing it over is killed; another home's, or a live server's,
# is left alone; a record whose pid is dead or reused is dropped; and an unrecorded ipykernel of this WORKSPACES_DIR is
# killed. Every signal goes to a pid whose command line was just checked.
#
# Kernels end with the server: shutdown() kills them unless the server is restarting, when it detaches them for the next
# server. A restart says so with <THIMBLE_HOME>/kernels-handoff.json (cli.hand_over_kernels); a `--reload` worker writes
# it for itself. An exit that skips the lifespan still kills kernels from an atexit hook. Explicit shutdown sends
# SIGTERM to the process group, SIGKILL after KILL_WAIT_S, and removes the record. A watchdog inside the kernel exits
# once the recorded server has been gone for KERNEL_TTL_S. Interrupt is SIGINT to the process group.
#
# With `kernel_wrap: bwrap` the argv runs inside bubblewrap: the recorded pid is bwrap's outer process, which leads the
# process group. The kernel cannot see the server's pid there, so its watchdog reads a LEASE instead: an flock on
# kernels/<key>.lease this server holds while attached; a free lease counts as "server gone". A wrapped kernel is three
# processes with the kernel's command line, so the orphan sweep counts members of a claimed process group as claimed.

KERNELS_DIR = "kernels"  # workspace-relative
KERNEL_TTL_S = 300.0  # the in-kernel watchdog exits this long after the recorded server disappeared (seconds)
WATCHDOG_POLL_S = 5.0
RECONNECT_TIMEOUT = 10.0  # seconds a recorded kernel gets to answer kernel_info on its control channel
KILL_WAIT_S = 3.0  # SIGTERM, then this long, then SIGKILL
_SHARED_KEY = "shared"
LAST_RECONNECT: dict[str, list[str]] | None = None  # what reconnect_all did at this server's start
RECONNECT_WAIT_S = 60.0  # the most wait_reconnect holds a caller (every recorded kernel gets RECONNECT_TIMEOUT to answer)
_reconnect_done: asyncio.Event | None = None  # set by the lifespan before the reconnect starts; None = none scheduled (tests)

# Runs inside the kernel: `exec(<this>, {RECORD, TTL, POLL, LEASE})` as an IPKernelApp.exec_line with its own globals.
_WATCHDOG_SRC = """\
import fcntl, json, os, threading, time
def _alive(pid, lease):
    if lease:
        try:
            fd = os.open(lease, os.O_RDONLY)
        except OSError:
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
            return False
        finally:
            os.close(fd)
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
def _watch(record, ttl, poll, lease):
    gone = None
    while True:
        time.sleep(poll)
        try:
            with open(record) as f:
                pid = int(json.load(f).get("server_pid") or 0)
        except Exception:
            pid = 0
        if _alive(pid, lease):
            gone = None
        elif gone is None:
            gone = time.monotonic()
        elif time.monotonic() - gone >= ttl:
            os._exit(0)
threading.Thread(target=_watch, args=(RECORD, TTL, POLL, LEASE), daemon=True, name="thimble-watchdog").start()
"""


# Cell reads. Runs inside the kernel as a second exec_line with globals {ROOTS, CAP, MIME}: an audit hook records the
# paths a cell opens for reading, lists or connects to (sqlite3) under the scratch mirror or the corpus, relative,
# deduped and capped at CAP, between pre_run_cell and post_run_cell, and publishes them as one READS_MIME bundle, which
# _execute strips and hands to _execute_cell for `cell.reads`. Writes and paths outside the roots are ignored; the hook
# never raises.
READS_MIME = "application/vnd.thimble.reads+json"
READS_CAP = 400
_READS_SRC = """\
import os, sys, threading
from IPython import get_ipython
from IPython.display import publish_display_data
_st = {"on": False, "seen": set(), "order": [], "n": 0}
_lk = threading.Lock()
_W = frozenset("wax")
def _rel(p):
    try:
        if isinstance(p, bytes):
            p = os.fsdecode(p)
        if not isinstance(p, str) or not p:
            return None
        a = p if os.path.isabs(p) else os.path.join(os.getcwd(), p)
        a = os.path.normpath(a)
        for root in ROOTS:
            if a == root:
                return "."
            if a.startswith(root + os.sep):
                return a[len(root) + 1:].replace(os.sep, "/")
    except Exception:
        pass
    return None
def _add(p):
    r = _rel(p)
    if r is None:
        return
    with _lk:
        if r in _st["seen"]:
            return
        _st["seen"].add(r)
        _st["n"] += 1
        if len(_st["order"]) < CAP:
            _st["order"].append(r)
def _hook(event, args):
    if not _st["on"]:
        return
    try:
        if event == "open":
            mode = args[1] if len(args) > 1 else None
            if isinstance(mode, str):
                if _W & set(mode):
                    return
            elif len(args) > 2 and isinstance(args[2], int) and (args[2] & os.O_ACCMODE) != os.O_RDONLY:
                return
            _add(args[0])
        elif event in ("os.scandir", "os.listdir"):
            _add(args[0] if args and args[0] is not None else ".")
        elif event == "sqlite3.connect":
            _add(args[0])
        elif event == "glob.glob":
            pat = args[0] if isinstance(args[0], str) else ""
            head = pat.split("*", 1)[0].split("?", 1)[0].split("[", 1)[0]
            _add(os.path.dirname(head) or ".")
    except Exception:
        pass
def _pre(*a, **k):
    with _lk:
        _st["seen"].clear(); _st["order"].clear(); _st["n"] = 0
    _st["on"] = True
def _post(*a, **k):
    _st["on"] = False
    with _lk:
        reads, n = list(_st["order"]), _st["n"]
    try:  # published for every cell, an empty list included, so a re-run that reads nothing clears the old reads
        publish_display_data({MIME: {"reads": reads, "n": n}})
    except Exception:
        pass
_ip = get_ipython()
if _ip is not None:
    _ip.events.register("pre_run_cell", _pre)
    _ip.events.register("post_run_cell", _post)
    sys.addaudithook(_hook)
"""


def reads_bundle(bundle: dict) -> dict | None:
    """The reads record {reads, n} when `bundle` is the kernel's READS_MIME display bundle, else None."""
    data = bundle.get(READS_MIME) if isinstance(bundle, dict) else None
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return None
    if not isinstance(data, dict):
        return None
    reads = [str(r) for r in (data.get("reads") or []) if isinstance(r, str)]
    n = data.get("n")
    return {"reads": reads, "n": n if isinstance(n, int) and not isinstance(n, bool) else len(reads)}


def kernel_argv(connection_file: Path, record: Path, ttl: float | None = None, poll: float | None = None,
                roots: tuple[str, ...] | None = None, lease: Path | None = None, workspace: Path | None = None) -> list[str]:
    """The kernel's command line: backend/.venv's python -m ipykernel_launcher on our connection file, rendering config,
    the watchdog, with `roots` the cell-reads audit hook, and with `workspace` the `thimble` module (kernel_thimble.py).
    `lease` makes the watchdog read the server's presence off that file's flock instead of the recorded pid."""
    watchdog = {"RECORD": str(record), "TTL": KERNEL_TTL_S if ttl is None else ttl, "POLL": WATCHDOG_POLL_S if poll is None else poll,
                "LEASE": str(lease) if lease is not None else None}
    reads = ([f"--IPKernelApp.exec_lines=exec({_READS_SRC!r}, {{'ROOTS': {tuple(str(r) for r in roots)!r}, 'CAP': {READS_CAP!r}, 'MIME': {READS_MIME!r}}})"]
             if roots else [])
    helpers = ([f"--IPKernelApp.exec_lines=exec({_THIMBLE_INSTALL!r}, {{'SRC': {_thimble_src()!r}, 'WS': {str(workspace)!r}}})"]
               if workspace is not None else [])
    return [
        PYTHON, "-m", "ipykernel_launcher", "-f", str(connection_file),
        # no ~/.ipython history.sqlite: cell code (which may quote corpus text) stays in workspaces/<c>/
        "--HistoryManager.enabled=False",
        # crisp fonts: matplotlib inline figures as SVG
        "--InlineBackend.figure_format=svg",
        # interactive charts: Altair emits the Vega-Lite mime instead of an html+script blob
        "--IPKernelApp.exec_lines=import altair as _alt; _alt.renderers.enable('mimetype'); del _alt",
        # a DataFrame shows each value up to PANDAS_COLWIDTH characters instead of pandas' 50, so refs, paths and ids
        # reach the card and the model whole
        f"--IPKernelApp.exec_lines=import pandas as _pd; _pd.set_option('display.max_colwidth', {PANDAS_COLWIDTH}); del _pd",
        # a matplotlib figure ending a cell is drawn whatever the backend: with `matplotlib.use("Agg")` IPython has no
        # Figure formatter, so the formatter registered by name below draws through print_figure. The same line wraps
        # the displayhook so a figure is drawn once under the inline backend (see _FIGURE_FORMAT_SRC).
        f"--IPKernelApp.exec_lines=exec({_FIGURE_FORMAT_SRC!r})",
        # the page's faces for matplotlib, added when a card first imports it (page_fonts.py)
        f"--IPKernelApp.exec_lines=exec({page_fonts.HOOK_SRC!r}, {{'FONTS': {page_fonts.files()!r}}})",
        f"--IPKernelApp.exec_lines=exec({_WATCHDOG_SRC!r}, {watchdog!r})",
    ] + reads + helpers


# The figure formatter kernel_argv registers: by type name, so nothing imports matplotlib at start; the inline backend,
# when it loads, registers its own formatter in front of this one. SVG, like the inline backend's figure_format.
#
# The displayhook wrapper: a cell ending in `fig` has the figure drawn as its result, and the inline backend's
# post_execute flush would draw it again, giving two byte-different SVGs of one figure. The wrapper closes the figure
# the displayhook just drew when the inline backend is active, so the flush has nothing left to draw. Other backends
# have no flush and are left alone; `display(fig)` still shows.
_FIGURE_FORMAT_SRC = ("import IPython.core.pylabtools as _pt\n"
                      "get_ipython().display_formatter.formatters['image/svg+xml'].for_type_by_name("
                      "'matplotlib.figure', 'Figure', lambda fig, _pt=_pt: _pt.print_figure(fig, 'svg'))\n"
                      "def _once(hook):\n"
                      "    formatted = hook.compute_format_data\n"
                      "    def compute_format_data(result):\n"
                      "        data = formatted(result)\n"
                      "        try:\n"
                      "            import sys\n"
                      "            mf, plt = sys.modules.get('matplotlib.figure'), sys.modules.get('matplotlib.pyplot')\n"
                      "            if (mf is not None and plt is not None and isinstance(result, mf.Figure)\n"
                      "                    and plt.fignum_exists(getattr(result, 'number', None))\n"
                      "                    and str(sys.modules['matplotlib'].get_backend()).lower() in ('inline', 'module://matplotlib_inline.backend_inline')):\n"
                      "                plt.close(result)\n"
                      "        except Exception:\n"
                      "            pass\n"
                      "        return data\n"
                      "    hook.compute_format_data = compute_format_data\n"
                      "_once(get_ipython().displayhook)\n"
                      "del _pt, _once\n")

# matplotlib's defaults for a card's figure, read when a card imports matplotlib, so a kernel starts no slower.
MATPLOTLIBRC = Path(__file__).with_name("matplotlibrc")

# The `thimble` module (kernel_thimble.py) installed in the kernel: a module built from the file's source with WS set
# and registered in sys.modules (the source is read once, at first use).
_THIMBLE_INSTALL = "import sys, types\nm = types.ModuleType('thimble')\nm.WS = WS\nexec(SRC, m.__dict__)\nsys.modules['thimble'] = m\n"
_THIMBLE_SRC_CACHE: list[str] = []


# A reconnected kernel holds the `thimble` module of the server that started it, so on reconnecting the current source
# is run again into that module, silently and without waiting; the reply is skipped by _execute, which reads only its
# own.
_THIMBLE_REFRESH = ("import sys as _s\n"
                    "if 'thimble' in _s.modules:\n"
                    "    exec(SRC, _s.modules['thimble'].__dict__)\n"
                    "del _s\n")


def _refresh_thimble(k: _Kernel) -> None:
    try:
        if k.kc is not None:
            k.kc.execute(f"exec({_THIMBLE_REFRESH!r}, {{'SRC': {_thimble_src()!r}}})", silent=True,
                         store_history=False, allow_stdin=False)
    except Exception:  # noqa: BLE001 — a kernel that keeps its module still runs every card that needs nothing new
        log.debug("kernel %s: the thimble module was not refreshed", k.key, exc_info=True)


def _thimble_src() -> str:
    if not _THIMBLE_SRC_CACHE:
        _THIMBLE_SRC_CACHE.append((Path(__file__).with_name("kernel_thimble.py")).read_text("utf-8"))
    return _THIMBLE_SRC_CACHE[0]


def _kernel_key(name: str | None) -> str:
    return _SHARED_KEY if name is None else f"k-{name}"


def _name_from_key(key: str) -> str | None:
    return None if key == _SHARED_KEY else key[2:]


def _ws_dir(workspace: str) -> Path:
    """workspaces/<c> as a path, unvalidated: reconnect_all reads records of workspaces whose corpus may be gone."""
    return config.WORKSPACES_DIR / workspace


def _kernel_paths(ws: Path, key: str) -> tuple[Path, Path, Path]:
    """(record, connection file, log) of the kernel `key` under workspaces/<c>/kernels/."""
    d = ws / KERNELS_DIR
    return d / f"{key}.json", d / f"{key}.conn.json", d / f"{key}.log"


class _Kernel:
    """One kernel process of a workspace: `name` None for the shared kernel, else the dedicated kernel's name. The
    file paths are fixed at creation (never recomputed from config later)."""

    def __init__(self, workspace: str, name: str | None = None) -> None:
        self.workspace, self.name = workspace, name
        self.key = _kernel_key(name)
        self.record, self.conn, self.log = _kernel_paths(_ws_dir(workspace), self.key)
        self.lease = self.record.with_suffix(".lease")  # a wrapped kernel's liveness file
        self.home = self.record.with_suffix(".home")  # HOME of a kernel under srt, emptied at each start
        self.lease_fd: int | None = None  # this server's flock on it while held
        self.kc: AsyncKernelClient | None = None  # channels to the process; None while detached or not started
        self.pid: int | None = None
        self.pgid: int | None = None
        self.wrap: str | None = None  # the wrapper it runs in (config.KERNEL_WRAPS), from its record
        self.lock = asyncio.Lock()
        self.last_reads: dict | None = None  # the READS_MIME record of the last execution (_execute), read by _execute_cell
        self.last_labels: list[str] = []  # the labels the last card run read (_run_card_code, LABELS_EXPR)
        self.last_label_revs: dict[str, int] = {}  # and the revision of each it read (concepts.py, Revisions)
        # the last execution's user expressions as the execute reply returned them, and the position of the
        # execute_result in its outputs, which a table card's frame replaces (frames.apply_run)
        self.last_expr: dict | None = None
        self.last_result: int | None = None

    def alive(self) -> bool:
        """The kernel process runs: the pid is live and its command line still names our connection file."""
        return _is_kernel_process(self.pid, self.conn)

    def interrupt(self) -> None:
        """SIGINT to the kernel's process group; under srt, where the kernel is in a session of its own, an
        interrupt_request on its control channel, which has the kernel send itself SIGINT."""
        if self.wrap == config.KERNEL_WRAP_SRT and self.kc is not None:
            self.kc.control_channel.send(self.kc.session.msg("interrupt_request", {}))
            return
        _signal(self.pid, self.pgid, signal.SIGINT)


_kernels: dict[str, _Kernel] = {}  # the shared per-workspace kernel: the run session's exploration notebooks
_exec_kernels: dict[tuple[str, str], _Kernel] = {}  # named dedicated execution kernels, keyed (workspace, name)


def _kernel(workspace: str, kernel: str | None = None) -> _Kernel:
    """The workspace's shared kernel, or (with `kernel`) the named dedicated execution kernel, which starts in the same
    scratch cwd but shares no state, lock or lifecycle with the shared one."""
    if kernel:
        key = (workspace, kernel)
        k = _exec_kernels.get(key)
        if k is None:
            k = _exec_kernels[key] = _Kernel(workspace, kernel)
        return k
    k = _kernels.get(workspace)
    if k is None:
        k = _kernels[workspace] = _Kernel(workspace)
    return k


# --- processes: everything below signals a pid only after reading its command line ---


def _pid_alive(pid: int | None) -> bool:
    """A live, non-zombie process (kill(pid, 0) still answers for a zombie). procs.alive: /proc, else ps."""
    return procs.alive(pid)


def _proc_pgid(pid: int | None) -> int | None:
    """The process group of `pid`; None when it is gone."""
    return procs.pgid(pid)


def _proc_argv(pid: int) -> list[str]:
    return procs.argv(pid)


def _is_kernel_process(pid: int | None, connection_file: Path) -> bool:
    """`pid` is a live ipykernel launched on `connection_file` (so a reused pid is never mistaken for our kernel)."""
    if not _pid_alive(pid):
        return False
    argv = _proc_argv(pid)  # type: ignore[arg-type]
    return any("ipykernel_launcher" in a for a in argv) and str(connection_file) in argv


def _signal(pid: int | None, pgid: int | None, sig: int) -> None:
    """`sig` to the kernel's process group (it leads its own), so a subprocess a cell spawned gets it too."""
    if not pid:
        return
    try:
        os.killpg(pgid or pid, sig)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def _reap(pid: int) -> None:
    """Collect the exit status when the process is this server's child (a kernel it launched); nothing otherwise."""
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


def _group_alive(pid: int, pgid: int | None) -> bool:
    """The process, or any member of its group, still exists: a wrapped kernel's outer bwrap may die of SIGTERM while
    the kernel inside has not, and the group must then get the SIGKILL. A zombie child is reaped first."""
    if _pid_alive(pid):
        return True
    if not pgid:
        return False
    try:
        os.killpg(pgid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def _terminate(pid: int, pgid: int | None, connection_file: Path) -> None:
    """SIGTERM, then SIGKILL after KILL_WAIT_S, to the process group, only while the process's command line names our
    connection file, until no member of its group is left. Blocking; call it in a thread."""
    if not _is_kernel_process(pid, connection_file):
        _reap(pid)
        return
    _signal(pid, pgid, signal.SIGTERM)
    deadline = time.monotonic() + KILL_WAIT_S
    while _group_alive(pid, pgid) and time.monotonic() < deadline:
        _reap(pid)
        time.sleep(0.05)
    if _group_alive(pid, pgid):
        _signal(pid, pgid, signal.SIGKILL)
        deadline = time.monotonic() + 2.0
        while _group_alive(pid, pgid) and time.monotonic() < deadline:
            _reap(pid)
            time.sleep(0.05)
    _reap(pid)


def _kernel_processes(root: Path) -> list[tuple[int, Path, str]]:
    """(pid, connection file, workspace) of every live ipykernel of this user launched for a workspace under `root`: its
    connection file lies under <root>/<c>/kernels/, or its cwd under <root>/<c>/. For a wrapped kernel that is three
    processes; reconnect_all tells them apart by process group."""
    prefix, out = f"{root}/", []
    for pid, argv in procs.commands().items():
        if not any("ipykernel_launcher" in a for a in argv) or "-f" not in argv:
            continue
        i = argv.index("-f") + 1
        conn = argv[i] if i < len(argv) else ""
        if not conn or not _pid_alive(pid):
            continue
        if conn.startswith(prefix) and f"/{KERNELS_DIR}/" in conn and conn.endswith(".conn.json"):
            out.append((pid, Path(conn), Path(conn).parent.parent.name))
            continue
        wd = procs.cwd(pid)
        if wd is not None and procs.under(wd, root):
            try:
                parts = wd.resolve().relative_to(root.resolve()).parts
            except (OSError, ValueError):
                parts = ()
            if parts:
                out.append((pid, Path(conn), parts[0]))
    return out


# --- records ---


def _read_record(path: Path) -> dict | None:
    try:
        rec = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) else None


def _write_record(k: _Kernel, rec: dict) -> None:
    k.record.parent.mkdir(parents=True, exist_ok=True)
    write_json(k.record, rec)  # tmp + replace: the kernel's watchdog reads it


def _drop_files(*paths: Path) -> None:
    for p in paths:
        try:
            p.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            log.exception("could not remove %s", p)


def _record_pid(rec: dict, field: str = "pid") -> int | None:
    v = rec.get(field)
    return v if isinstance(v, int) and v > 0 else None


def recorded_kernels(workspace: str) -> list[str | None]:
    """Names (None = the shared kernel) of the kernels recorded under workspaces/<c>/kernels/, attached or not."""
    d = _ws_dir(workspace) / KERNELS_DIR
    if not d.is_dir():
        return []
    return [_name_from_key(p.stem) for p in sorted(d.glob("*.json")) if not p.name.endswith(".conn.json")]


# --- start, attach, detach, kill ---


def _client(connection_file: Path) -> AsyncKernelClient:
    kc = AsyncKernelClient()
    kc.load_connection_file(str(connection_file))
    kc.start_channels()
    return kc


async def _wait_ready(k: _Kernel, kc: AsyncKernelClient, timeout: float, *, control: bool) -> None:
    """kernel_info until the reply arrives and iopub has delivered something: on the shell channel for a fresh kernel,
    on the control channel for a recorded one (which answers there even while the shell runs a cell). Liveness is the
    pid, since the heartbeat has not started while a kernel boots. `kc` becomes k.kc only once this returns."""
    ch = kc.control_channel if control else kc.shell_channel
    deadline = time.monotonic() + timeout
    while True:
        ch.send(kc.session.msg("kernel_info_request"))
        try:
            reply = await ch.get_msg(timeout=1)
        except Empty:
            reply = None
        except asyncio.CancelledError:
            if _really_cancelled():
                raise
            raise RuntimeError("the kernel's channels were closed while waiting for it") from None  # a concurrent kill
        if reply is not None and reply["msg_type"] == "kernel_info_reply":
            try:
                await kc.iopub_channel.get_msg(timeout=0.2)
            except Empty:
                pass  # iopub not connected yet: ask again
            else:
                try:
                    kc._handle_kernel_info_reply(reply)
                except Exception:  # noqa: BLE001 — protocol adaptation only
                    pass
                break
        if not k.alive():
            raise RuntimeError("the kernel died before answering kernel_info")
        if time.monotonic() > deadline:
            raise TimeoutError(f"the kernel did not answer kernel_info within {timeout:g} s")
    while True:  # what iopub caught meanwhile belongs to no run
        try:
            await kc.iopub_channel.get_msg(timeout=0.2)
        except Empty:
            break


def _ws_settings(workspace: str) -> dict:
    """workspaces/<c>/settings.json as a dict ({} for none, a broken one or one another name can change, config.linked):
    what config.resolve_kernel_wrap reads."""
    path = _ws_dir(workspace) / "settings.json"
    if config.linked(path):
        log.warning("%s: %s is a link or has another name, so its %s is ignored", workspace, path, config.KERNEL_WRAP_KEY)
        return {}
    try:
        s = read_json(path, {})
    except (OSError, ValueError):
        return {}
    return s if isinstance(s, dict) else {}


def _venv() -> Path | None:
    """backend/.venv when the kernel runs its python (PYTHON), else None."""
    return _VENV_PYTHON.parent.parent if PYTHON == str(_VENV_PYTHON) else None


def _kernel_reads() -> list[Path]:
    """Files of the backend a wrapped kernel reads: the page's fonts (page_fonts) and thimble's matplotlibrc."""
    return [page_fonts.FONTS_DIR, MATPLOTLIBRC]


def _kernel_hides() -> list[Path]:
    """What a kernel under srt must not see besides the home folder: thimble's folders (THIMBLE_HOME, the registry, the
    workspaces, the install tree) and Claude Code's config. The kernel's own paths inside them are shown again."""
    paths = [_home(), config.DATA_DIR, config.WORKSPACES_DIR, config.REPO_ROOT, config.claude_config_dir()]
    return list(dict.fromkeys(Path(os.path.realpath(p)) for p in paths))


def _guarded_files(workspace: str) -> None:
    """Each of kernel_wrap.HIDDEN_FILES (`{}`) and READ_ONLY_FILES (empty) made in the workspace when missing: a wrapper
    guards a file that exists, where for a missing one bwrap would guard nothing and srt would leave an empty read-only
    file in its place while the kernel runs, which the server could not write. Each of READ_ONLY_DIRS is made too, since
    bwrap fails on a missing one, in place of a link or a file a kernel left there: the wrapper would show it a link's
    target, and a file stops the folder from being made."""
    for name in kernel_wrap.READ_ONLY_DIRS:
        d = _ws_dir(workspace) / name
        if d.is_symlink() or (d.exists() and not d.is_dir()):
            d.unlink()
        config.private_dir(d)
    files = [*((n, "{}\n") for n in kernel_wrap.HIDDEN_FILES), *((n, "") for n in kernel_wrap.READ_ONLY_FILES)]
    for name, text in files:
        p = _ws_dir(workspace) / name
        with contextlib.suppress(FileExistsError):
            with open(p, "x", encoding="utf-8") as f:
                f.write(text)
        with contextlib.suppress(OSError):
            if not p.is_symlink() and p.stat().st_size == 0 and not os.access(p, os.W_OK):
                p.chmod(0o600)  # srt's placeholder from a kernel that did not end cleanly


def wrapped_argv(argv: list[str], *, workspace: str, corpus: Path, connection_file: Path, source: str = "settings") -> list[str]:
    """`argv` inside bubblewrap (kernel_wrap.kernel_wrap_argv). RuntimeError when bwrap is not on PATH: a workspace set
    to bwrap never runs unwrapped."""
    bwrap = shutil.which("bwrap")
    if bwrap is None:
        log.error("kernel for %s: %s is bwrap (%s) but bwrap is not on PATH; the kernel is not started — %s",
                  workspace, config.KERNEL_WRAP_KEY, source, config.NO_WRAP_HINT)

        raise RuntimeError("the kernel wrap is bwrap but bubblewrap (bwrap) is not installed, so the kernel did not start")
    _guarded_files(workspace)
    return kernel_wrap.kernel_wrap_argv(argv, corpus_dir=Path(corpus).resolve(), workspace_dir=_ws_dir(workspace).resolve(),
                                        connection_dir=connection_file.parent.resolve(), venv=_venv(), python=PYTHON,
                                        read=_kernel_reads(), bwrap=bwrap)


def sandboxed_argv(argv: list[str], *, workspace: str, corpus: Path, source: str = "settings") -> list[str]:
    """`argv` inside Anthropic's sandbox runtime (kernel_wrap.srt_argv with kernel_wrap.srt_rules). RuntimeError when
    node or the runtime's package is missing: a workspace set to srt never runs unwrapped."""
    node, srt_dir = srt.node(), srt.package(config.REPO_ROOT)
    if node is None or srt_dir is None:
        missing = ("node is not on PATH" if node is None else
                   f"the sandbox runtime is not installed in {config.REPO_ROOT.joinpath(*srt.PACKAGE)}")
        log.error("kernel for %s: %s is srt (%s) but %s; the kernel is not started — %s",
                  workspace, config.KERNEL_WRAP_KEY, source, missing, config.NO_WRAP_HINT)
        raise RuntimeError(f"the kernel wrap is srt but {missing}, so the kernel did not start")
    _guarded_files(workspace)
    rules = kernel_wrap.srt_rules(corpus_dir=Path(corpus).resolve(), workspace_dir=_ws_dir(workspace).resolve(),
                                  venv=_venv(), python=PYTHON, srt_dir=srt_dir, read=_kernel_reads(),
                                  hide=_kernel_hides(), home=Path(os.path.realpath(Path.home())), platform=sys.platform)
    return kernel_wrap.srt_argv(argv, node=node, srt_dir=srt_dir, rules=rules)


def _fresh_home(k: _Kernel) -> None:
    """The kernel's HOME for srt (k.home), empty, with the TMPDIR kernel_wrap.srt_env puts in it: what a cell left there
    does not reach the next start."""
    shutil.rmtree(k.home, ignore_errors=True)
    (k.home / "tmp").mkdir(parents=True, exist_ok=True)


LEASE_TRIES = 20  # _hold_lease: 50 ms apart, so a watchdog's own probe (lock, unlock) never costs the server the lease


def _hold_lease(k: _Kernel) -> None:
    """This server's flock on kernels/<key>.lease, held until _release_lease. Blocking (a short retry). A lease another
    process keeps is logged and left; the next attach takes it back."""
    if k.lease_fd is not None:
        return
    fd = os.open(k.lease, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    for _ in range(LEASE_TRIES):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            time.sleep(0.05)
        else:
            k.lease_fd = fd
            return
    os.close(fd)
    log.warning("kernel %s of %s: the lease %s is held by another process; not taken", k.key, k.workspace, k.lease)


def _release_lease(k: _Kernel, drop: bool = False) -> None:
    """The flock let go (closing the fd releases it); `drop` removes the file too (an explicit shutdown)."""
    fd, k.lease_fd = k.lease_fd, None
    if fd is not None:
        os.close(fd)
    if drop:
        _drop_files(k.lease)


async def _launch(k: _Kernel, workspace: str) -> None:
    """A fresh kernel process in the workspace's scratch mirror, recorded and connected. Call with k.lock held."""
    corpus = config.corpus_dir(workspace)
    cwd = await asyncio.to_thread(scratch_dir, workspace, corpus)  # the scratch mirror (module docstring)
    k.record.parent.mkdir(parents=True, exist_ok=True)
    _drop_files(k.record, k.conn)
    wrap, source = await asyncio.to_thread(config.resolve_kernel_wrap, _ws_settings(workspace))
    wrapped = wrap in config.KERNEL_WRAPPED
    argv = kernel_argv(k.conn, k.record, roots=(str(cwd), str(Path(corpus).resolve())), lease=k.lease if wrapped else None,
                       workspace=_ws_dir(workspace).resolve())
    # paths only so far: a missing wrapper fails here, before any file is written
    if wrap == config.KERNEL_WRAP_BWRAP:
        argv = wrapped_argv(argv, workspace=workspace, corpus=corpus, connection_file=k.conn, source=source)
    elif wrap == config.KERNEL_WRAP_SRT:
        argv = sandboxed_argv(argv, workspace=workspace, corpus=corpus, source=source)
    await asyncio.to_thread(write_connection_file, str(k.conn), ip="127.0.0.1", key=secrets.token_hex(16).encode())
    env = kernel_env()
    env.pop("JPY_PARENT_PID", None)  # no parent poller: the kernel outlives this server
    env.setdefault("MATPLOTLIBRC", str(MATPLOTLIBRC))  # thimble's figure defaults, unless the environment names its own
    if wrap == config.KERNEL_WRAP_SRT:
        env = kernel_wrap.srt_env(env, home=k.home)
        await asyncio.to_thread(_fresh_home, k)
    if wrapped:
        await asyncio.to_thread(_hold_lease, k)  # before the process exists: its watchdog never sees a free lease
    log.info("starting kernel %s for %s in %s (a mirror of %s)%s", k.key, workspace, cwd, corpus,
             f"; wrapped in {wrap} ({source})" if wrapped else "")
    with k.log.open("wb") as out:
        proc = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL,
                                stdout=out, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    k.pid = k.pgid = proc.pid
    k.wrap = wrap
    _write_record(k, {"name": k.name, "workspace": workspace, "pid": proc.pid, "pgid": proc.pid,
                      "connection_file": str(k.conn), "cwd": str(cwd), "started": _now(), "server_pid": os.getpid(),
                      "home": str(_home()), "attached": _now(), "wrap": wrap})
    kc = _client(k.conn)
    try:
        await _wait_ready(k, kc, STARTUP_TIMEOUT, control=False)
    except BaseException:
        kc.stop_channels()
        await _kill(k)
        raise
    k.kc = kc


async def _attach(k: _Kernel) -> bool:
    """Reconnect to the kernel its record describes. True when it answers; otherwise the record, and a silent live
    kernel, are gone afterwards. Call with k.lock held."""
    rec = _read_record(k.record)
    if rec is None:
        return False
    pid = _record_pid(rec)
    if not _is_kernel_process(pid, k.conn):  # dead, or the pid now belongs to another program: never signalled
        log.info("kernel %s of %s: record for pid %s is stale; dropped", k.key, k.workspace, pid)
        _drop_files(k.record, k.conn)
        return False
    k.pid, k.pgid = pid, _record_pid(rec, "pgid") or pid
    kc = _client(k.conn)
    try:
        await _wait_ready(k, kc, RECONNECT_TIMEOUT, control=True)
    except asyncio.CancelledError:
        kc.stop_channels()
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("kernel %s of %s (pid %s) does not answer (%s); killed", k.key, k.workspace, pid, e)
        kc.stop_channels()
        await _kill(k)
        return False
    k.kc = kc
    k.wrap = rec.get("wrap")
    _refresh_thimble(k)
    if k.wrap in config.KERNEL_WRAPPED:
        await asyncio.to_thread(_hold_lease, k)  # a wrapped kernel's watchdog reads this server's presence off it
    _write_record(k, {**rec, "server_pid": os.getpid(), "attached": _now()})
    log.info("reconnected kernel %s of %s (pid %s)", k.key, k.workspace, pid)
    return True


async def _ensure_started(k: _Kernel, workspace: str, kernel: str | None = None) -> None:
    """Start the kernel if it is not running: keep a live connection, reconnect a recorded kernel, else launch a fresh
    one. Call with k.lock held. `kernel` is the dedicated kernel's name (kept for callers)."""
    if k.kc is not None:
        if k.alive():
            return
        await _kill(k)  # the process is gone: forget its channels and record
    if await _attach(k):
        return
    await _launch(k, workspace)


def _detach(k: _Kernel) -> None:
    """Leave the process running for the next server and close only this server's channels. The pid stays on the object
    so an interrupted run can tell a living kernel from a dead one."""
    kc, k.kc = k.kc, None
    if kc is not None:
        kc.stop_channels()
    _release_lease(k)  # the file stays: the next server's _attach takes the lease back


async def _kill(k: _Kernel) -> None:
    """Explicit shutdown of one kernel: channels closed, the process (this server's, or the one its record names)
    terminated through its pid, record and connection file removed. Idempotent."""
    kc, k.kc = k.kc, None
    if kc is not None:
        kc.stop_channels()
    pid, pgid = k.pid, k.pgid
    if pid is None:  # not attached: the record may still name a live kernel of a previous server
        rec = _read_record(k.record) or {}
        pid, pgid = _record_pid(rec), _record_pid(rec, "pgid")
    k.pid = k.pgid = None
    if pid is not None:
        await asyncio.to_thread(_terminate, pid, pgid or pid, k.conn)
    _release_lease(k, drop=True)
    _drop_files(k.record, k.conn)
    await asyncio.to_thread(shutil.rmtree, k.home, True)


async def shutdown_kernel(workspace: str, kernel: str | None = None) -> None:
    """Explicit shutdown of the workspace's shared kernel, or (with `kernel`) one dedicated kernel, whose entry is
    forgotten too. Reaches a kernel a previous server recorded."""
    if kernel:
        k = _exec_kernels.pop((workspace, kernel), None) or _Kernel(workspace, kernel)
    else:
        k = _kernels.get(workspace) or _Kernel(workspace)
    await _kill(k)


async def shutdown_workspace(workspace: str) -> None:
    """Explicit shutdown of every kernel of one workspace, recorded ones included, so a restart or reset leaves none
    running."""
    names = {None, *[name for w, name in _exec_kernels if w == workspace], *recorded_kernels(workspace)}
    for name in sorted(names, key=lambda n: (n is not None, n or "")):
        await shutdown_kernel(workspace, kernel=name)


async def shutdown_all() -> None:
    """Explicit shutdown of every kernel this server holds, all at once, so a stopping server ends them within
    KILL_WAIT_S."""
    ks = [*_kernels.values(), *_exec_kernels.values()]
    _kernels.clear()
    _exec_kernels.clear()
    for r in await asyncio.gather(*(_kill(k) for k in ks), return_exceptions=True):
        if isinstance(r, BaseException):
            log.error("stopping a kernel failed: %r", r)


async def detach_all() -> None:
    """Leave every kernel this server holds running with its record, for the next server to take back (a restart)."""
    for k in [*_kernels.values(), *_exec_kernels.values()]:
        _detach(k)
    _kernels.clear()
    _exec_kernels.clear()


def _home() -> Path:
    from . import cli  # noqa: PLC0415 — cli imports config, procs and cc_channel only

    return cli.home()


def _under_reloader() -> bool:
    """This server is the worker of uvicorn's `--reload` (the dev stack), whose reloader ends it with SIGTERM to load
    changed code: its parent is that reloader, a uvicorn command with --reload."""
    parent = procs.argv(os.getppid())
    return "--reload" in parent and any("uvicorn" in a for a in parent)


def _server_alive(pid: int | None) -> bool:
    """`pid` is a live thimble server (a uvicorn process), not a reused pid of another program."""
    return bool(pid) and procs.alive(pid) and any("uvicorn" in a or "app.main" in a for a in procs.argv(pid))


async def shutdown() -> None:
    """Lifespan shutdown and dev's pre-execv hook: kernels end with the server, unless it is restarting, when they are
    detached for the next server."""
    from . import cli  # noqa: PLC0415

    held = len(_kernels) + len(_exec_kernels)
    if cli.kernel_handoff() == os.getpid() or (held and _under_reloader() and cli.hand_over_kernels(os.getpid())):
        if held:
            log.info("restarting: %d kernel(s) left running for the next server", held)
        await detach_all()
        return
    await shutdown_all()
    if held:
        log.info("stopped %d kernel(s) with the server", held)


def _kill_left_at_exit() -> None:
    """The interpreter exits with kernels still held (uvicorn skipped the lifespan on a forced exit): terminate them as
    shutdown_all would; nothing when shutdown ran."""
    ks = [*_kernels.values(), *_exec_kernels.values()]
    _kernels.clear()
    _exec_kernels.clear()
    for k in ks:
        try:
            if k.pid:
                _terminate(k.pid, k.pgid or k.pid, k.conn)
            _drop_files(k.record, k.conn)
        except Exception:  # noqa: BLE001 — the interpreter is exiting; the next server's start reaps what is left
            pass


atexit.register(_kill_left_at_exit)


def _descends(pid: int, roots: set[int], tree: dict[int, int]) -> bool:
    """`pid` lies below one of `roots` in the process tree `tree` ({pid: parent}, procs.parents)."""
    seen: set[int] = set()
    q = tree.get(pid)
    while q and q not in seen:
        if q in roots:
            return True
        seen.add(q)
        q = tree.get(q)
    return False


async def reconnect_all() -> dict[str, list[str]]:
    """Server start: reconnect every recorded kernel that answers, kill those that do not, drop stale records, and kill
    unrecorded kernels launched under this WORKSPACES_DIR. Returns {reconnected, reaped}, kept in LAST_RECONNECT."""
    global LAST_RECONNECT
    from . import cli  # noqa: PLC0415

    out: dict[str, list[str]] = {"reconnected": [], "reaped": []}
    root = config.WORKSPACES_DIR
    handed = cli.kernel_handoff()  # the restarted server whose kernels this one takes back (kernels section comment)
    home = str(_home())
    records = sorted(root.glob(f"*/{KERNELS_DIR}/*.json")) if root.is_dir() else []
    for record in records:
        if record.name.endswith(".conn.json"):
            continue
        rec = _read_record(record) or {}
        owner = _record_pid(rec, "server_pid")
        if rec.get("home") not in (None, home) or (owner not in (None, os.getpid(), handed) and _server_alive(owner)):
            continue  # another home's kernel, or one a running server holds: never ours to take or stop
        c, name = record.parent.parent.name, _name_from_key(record.stem)
        k = _kernel(c, name)
        async with k.lock:
            if k.kc is not None:  # a request got there first
                ok = True
            elif owner is not None and owner in (os.getpid(), handed):
                ok = await _attach(k)
            else:
                log.warning("kernel %s of %s: its server (pid %s) ended without handing it over; stopped", k.key, c, owner)
                await _kill(k)
                ok = False
        (out["reconnected"] if ok else out["reaped"]).append(f"{c}/{k.key}")
    swept: set[int] = set()  # leaders terminated in this pass: their group went with them
    found = await asyncio.to_thread(_kernel_processes, root)
    tree = await asyncio.to_thread(procs.parents) if found else {}
    for pid, conn, c in found:
        pgid = _proc_pgid(pid)
        claimed = {k.pid for k in [*_kernels.values(), *_exec_kernels.values()] if k.pid}
        if pid in claimed or pgid in claimed or pgid in swept or _descends(pid, claimed | swept, tree):
            # ours, or a member of a wrapped kernel: bwrap's init and the kernel inside show the same command line, and
            # under srt the kernel runs below the launcher in a session of its own
            continue
        ours = conn.name.endswith(".conn.json") and procs.under(conn, root)  # a connection file this tree owns
        rec = _read_record(conn.with_name(conn.name[: -len(".conn.json")] + ".json")) if ours else None
        rp = _record_pid(rec or {})
        if rp is not None and (rp in (pid, pgid) or _descends(pid, {rp}, tree)):
            continue  # a launch in progress claims it (or the group or tree it belongs to)
        log.warning("orphan kernel pid %s (%s, workspace %s) has no record; killed", pid, conn, c)
        await asyncio.to_thread(_terminate, pid, pid, conn)
        swept.add(pid)
        if ours:
            _drop_files(conn)
        key = conn.name[: -len(".conn.json")] if ours else f"pid-{pid}"
        out["reaped"].append(f"{c}/{key}")
    if handed is not None:
        cli.clear_kernel_handoff(handed)
    LAST_RECONNECT = out
    if out["reconnected"] or out["reaped"]:
        log.info("kernels at start: reconnected %s; reaped %s", out["reconnected"] or "none", out["reaped"] or "none")
    return out


async def _reconnect_on_start() -> None:
    try:
        await reconnect_all()
    except Exception:  # noqa: BLE001 — never fails the start
        log.exception("kernel reconnect at start failed")
    finally:
        if _reconnect_done is not None:
            _reconnect_done.set()


async def wait_reconnect(timeout: float = RECONNECT_WAIT_S) -> bool:
    """Wait for the start-up reconnect to finish, so a reader of LAST_RECONNECT sees what it did: True once finished or
    when none was scheduled, False on timeout."""
    ev = _reconnect_done
    if ev is None or ev.is_set():
        return True
    try:
        await asyncio.wait_for(ev.wait(), timeout)
    except asyncio.TimeoutError:
        return False
    return True


def _error_bundle(ename: str, evalue: str, traceback: list[str] | None = None) -> dict:
    return {ERROR_MIME: {"ename": ename, "evalue": evalue, "traceback": traceback or []}}


def _really_cancelled() -> bool:
    """True if the current task itself was cancelled (as opposed to a future it awaited being cancelled)."""
    t = asyncio.current_task()
    return t is None or t.cancelling() > 0


def positive_timeout(value: Any) -> float | None:
    """`timeout_s` as a float (None passes through); ValueError for anything but a positive finite number of seconds."""
    if value is None:
        return None
    try:
        t = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"timeout_s must be a positive number of seconds, not {value!r}") from None
    if isinstance(value, bool) or not t > 0 or t == float("inf") or t != t:
        raise ValueError(f"timeout_s must be a positive number of seconds, not {value!r}")
    return t


async def _execute(k: _Kernel, code: str, timeout: float | None = None,
                   user_expressions: dict[str, str] | None = None) -> tuple[list[dict], int | None, str]:
    """Run code on the kernel and collect iopub output into mime bundles. Returns (outputs, exec_count, status).

    `timeout` (seconds) is how long the code may run before an interrupt; None = EXEC_TIMEOUT. The TimeoutError bundle
    records the limit as `timeout_s`. `user_expressions` are evaluated after the code in the same request; their values
    land on k.last_expr and the execute_result's position on k.last_result.
    """
    timeout = EXEC_TIMEOUT if timeout is None else timeout
    kc = k.kc
    assert kc is not None
    k.last_expr = None
    k.last_result = None
    msg_id = kc.execute(code, allow_stdin=False, user_expressions=user_expressions or None)
    outputs: list[dict] = []
    display_index: dict[str, int] = {}  # transient display_id -> index in outputs (for update_display_data)
    chunks: dict[int, list[str]] = {}  # index in outputs -> pieces of a stream bundle's text, joined once at the end
    exec_count: int | None = None
    status = "ok"
    deadline = time.monotonic() + timeout
    interrupted = False
    dead = False
    idle = False
    k.last_reads = None  # set from the READS_MIME bundle the reads hook publishes at the end of the cell (kernel_argv)

    while not idle:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if interrupted:  # did not become idle within the grace period after interrupt: give up on it
                dead = True
                break
            interrupted = True
            log.warning("execution exceeded %ss; interrupting kernel", timeout)
            bundle = _error_bundle("TimeoutError", f"execution exceeded {timeout:g} s and was interrupted")
            bundle[ERROR_MIME]["timeout_s"] = timeout
            outputs.append(bundle)
            status = "error"
            try:
                k.interrupt()
            except Exception:
                log.exception("interrupt failed")
            deadline = time.monotonic() + 10
            continue
        try:
            msg = await kc.get_iopub_msg(timeout=min(1.0, remaining))
        except Empty:
            if not k.alive():
                dead = True
                break
            continue
        except asyncio.CancelledError:
            # closing the zmq socket cancels the pending poll future, which surfaces here as CancelledError without our
            # task being cancelled; a real cancellation propagates
            if _really_cancelled():
                raise
            dead = True
            break
        except Exception:  # channels closed underneath us
            dead = True
            break
        if msg["parent_header"].get("msg_id") != msg_id:
            continue
        mtype, content = msg["msg_type"], msg["content"]
        if mtype == "stream":
            name, text = content.get("name", "stdout"), content.get("text", "")
            if outputs and outputs[-1].get("_stream") == name:
                chunks[len(outputs) - 1].append(text)  # `+=` on the dict item would re-copy the whole text per message
            else:
                chunks[len(outputs)] = [text]
                outputs.append({"text/plain": "", "_stream": name})
        elif mtype in ("display_data", "execute_result"):
            bundle = dict(content.get("data") or {})
            rb = reads_bundle(bundle) if mtype == "display_data" else None
            if rb is not None:  # the cell-reads record: not an output of the cell (module comment on _READS_SRC)
                k.last_reads = rb
                continue
            did = (content.get("transient") or {}).get("display_id")
            if did:
                display_index[did] = len(outputs)
            if mtype == "execute_result":
                k.last_result = len(outputs)
            outputs.append(bundle)
            if mtype == "execute_result" and content.get("execution_count") is not None:
                exec_count = content["execution_count"]
        elif mtype == "update_display_data":
            did = (content.get("transient") or {}).get("display_id")
            if did in display_index:
                outputs[display_index[did]] = dict(content.get("data") or {})
        elif mtype == "error":
            outputs.append(_error_bundle(content.get("ename", "Error"), content.get("evalue", ""), content.get("traceback")))
            status = "error"
        elif mtype == "status" and content.get("execution_state") == "idle":
            idle = True

    for j, parts in chunks.items():
        outputs[j]["text/plain"] = "".join(parts)
    if dead:
        if k.kc is None and k.alive():  # detached under us (a server restart): the kernel runs on with its state
            outputs.append(_error_bundle("Disconnected", "the server restarted while this card ran; the kernel kept "
                                                         "its variables — run the card again"))
        else:
            outputs.append(_error_bundle("KernelDied", "the kernel died or was restarted; the next run starts a fresh kernel"))
            await _kill(k)
        return outputs, exec_count, "error"

    # the execute_reply on the shell channel carries the execution count (also for errors)
    reply_deadline = time.monotonic() + 5
    while time.monotonic() < reply_deadline:
        try:
            reply = await kc.get_shell_msg(timeout=1)
        except Empty:
            continue
        except asyncio.CancelledError:
            if _really_cancelled():
                raise
            break
        except Exception:
            break
        if reply["parent_header"].get("msg_id") == msg_id:
            c = reply["content"]
            if isinstance(c.get("user_expressions"), dict):
                k.last_expr = c["user_expressions"]
            if c.get("execution_count") is not None:
                exec_count = c["execution_count"]
            if c.get("status") == "error":
                status = "error"
            break
    return outputs, exec_count, status


def _kernel_for(nb: dict, kernel: str | None, cell: dict | None = None, ws: Path | None = None) -> str | None:
    """The kernel a cell of `nb` executes on: an explicit `kernel` wins; a card moved from another group keeps the
    kernel it ran on (`cell.kernel`). Otherwise exploration groups run on the shared kernel (None) and every other group
    on a dedicated kernel named after it. The terminal's own cells run on its dedicated kernel wherever they land."""
    if kernel:
        return kernel
    kept = (cell or {}).get("kernel")
    if isinstance(kept, str):  # a card moved out of the group it ran in keeps that kernel (move_cells); '' is shared
        return kept or None
    if nb.get("role", DEFAULT_ROLE) == "exploration" and nb.get("created_by") != TERMINAL_CREATOR \
            and (cell or {}).get("created_by") != TERMINAL_CREATOR:
        return None
    return str(nb.get("id") or MAIN)


async def _execute_cell(workspace: str, nb: dict, cell: dict, kernel: str | None = None,
                        timeout_s: float | None = None, default_s: float | None = None) -> tuple[dict, dict]:
    """Run `cell` of the loaded group `nb`. Returns (the cell as stored, the cell with its complete outputs). Two saves
    per run: the pre-run state before the kernel runs, so a crash mid-run loses nothing, and the result after. `kernel`
    names a dedicated kernel; None picks by the group. `timeout_s` is stored as the cell's allowance; None uses the
    stored one, else `default_s`, else EXEC_TIMEOUT."""
    ws = _ws(workspace)
    kernel = _kernel_for(nb, kernel, cell, ws)
    timeout_s = positive_timeout(timeout_s)
    if timeout_s is not None:
        cell["timeout_s"] = timeout_s
    else:
        try:
            timeout_s = positive_timeout(cell.get("timeout_s"))
        except ValueError:
            timeout_s = None
        if timeout_s is None:
            timeout_s = positive_timeout(default_s)
    cell["status"] = "running"
    cell["started"] = _now()
    write_notebook(ws, nb)
    _emit(workspace, cell)
    code = cell["code"]

    duration = 0.0
    reads: dict | None = None  # the corpus paths the cell read (the kernel's reads hook); None = not reported
    labels: list[str] = []  # the labels the code read (LABELS_EXPR)
    revs: dict[str, int] = {}  # the revision of each it read
    try:
        k = _kernel(workspace, kernel)
        async with k.lock:  # one execution at a time per kernel
            await _ensure_started(k, workspace, kernel)
            t0 = time.monotonic()
            outputs, exec_count, status = await _run_card_code(k, code, cell.get("kind"), timeout_s)
            duration = time.monotonic() - t0
            reads = k.last_reads
            labels, revs = k.last_labels, k.last_label_revs
    except Exception as e:  # noqa: BLE001 — a kernel that failed to start is reported as an output, never raised
        log.exception("run failed")
        outputs, exec_count, status = [_error_bundle(type(e).__name__, str(e))], None, "error"

    # the group may have been rewritten or the cell deleted meanwhile: re-read and update the cell where it lives now;
    # a deleted cell gets its result returned without being resurrected
    current = read_notebook(ws, nb["id"])
    target = next((c for c in current["cells"] if c.get("id") == cell["id"]), None) if current else None
    if target is None:
        gone = {**cell, "outputs": outputs, "exec_count": exec_count, "status": status}
        return gone, gone
    memo = _memo_of(target)
    number_outputs(memo, outputs)  # an output the last productive run also had keeps its @out index
    if _has_output(outputs):
        target[OUT_MEMO] = output_memo(outputs, memo)
    stored = bound_outputs(ws, cell["id"], outputs, fresh=True)
    target.update(outputs=stored, exec_count=exec_count, status=status, ts=_now(),
                  duration_s=round(duration, 3), labels=labels, label_revs=revs)
    if reads is not None:
        target["reads"] = reads["reads"]
        if reads["n"] > len(reads["reads"]):
            target["reads_more"] = reads["n"] - len(reads["reads"])
        else:
            target.pop("reads_more", None)
    _verify_hook("ran", workspace, current, target)
    write_notebook(ws, current)
    _emit(workspace, target)
    return target, (target if stored is outputs else {**target, "outputs": outputs})


# The labels a card uses: kernel_thimble notes each label thimble.labels("<name>") returns during a cell, with its
# revision, and this user expression reads them back, so the card's `labels` and `label_revs` say which labels it used
# and whether they changed since (concepts.stale_in). A cell that raised skips its user expressions.
LABELS_EXPR_KEY = "thimble_labels"
LABELS_EXPR = "__import__('thimble')._labels_read()"


def labels_read(reply: Any) -> dict[str, int | None]:
    """The labels in LABELS_EXPR's reply as {id: rev} in the order read; a bare id has no revision (None). {} when the
    expression failed or did not run."""
    if not isinstance(reply, dict) or reply.get("status") != "ok":
        return {}
    data = reply.get("data") if isinstance(reply.get("data"), dict) else {}
    try:
        got = json.loads(data.get("text/plain")) if isinstance(data.get("text/plain"), str) else None
    except ValueError:
        return {}
    out: dict[str, int | None] = {}
    for x in got if isinstance(got, list) else []:
        if isinstance(x, str) and x:
            out.setdefault(x, None)
        elif isinstance(x, dict) and isinstance(x.get("id"), str) and x["id"]:
            out.setdefault(x["id"], x["rev"] if isinstance(x.get("rev"), int) and not isinstance(x["rev"], bool) else None)
    return out


async def _run_card_code(k: _Kernel, code: str, kind: str | None, timeout_s: float | None,
                         extra_exprs: dict[str, str] | None = None) -> tuple[list[dict], int | None, str]:
    """_execute for a card's code, with the caller holding the kernel's lock: a table card's DataFrame is read in the
    same request and kept in place of pandas' display, and the labels the code read land on k.last_labels and
    k.last_label_revs. `extra_exprs` are more user expressions for the same request."""
    from . import cardtypes  # noqa: PLC0415 — cardtypes imports views, which imports this module lazily

    if cardtypes.CARD_CALL in code:
        await cardtypes.refresh_quietly(k.workspace, warm=False)
    exprs = {frames.EXPR_KEY: frames.CAPTURE} if frames.captures(kind) else {}
    exprs[LABELS_EXPR_KEY] = LABELS_EXPR
    exprs.update(extra_exprs or {})
    outputs, exec_count, status = await _execute(k, code, timeout_s, exprs)
    read = labels_read((k.last_expr or {}).get(LABELS_EXPR_KEY))
    k.last_labels = list(read)
    k.last_label_revs = {cid: rev for cid, rev in read.items() if rev is not None}
    if frames.EXPR_KEY in exprs:
        try:
            outputs = frames.apply_run(outputs, status, (k.last_expr or {}).get(frames.EXPR_KEY), k.last_result)
        except Exception:  # noqa: BLE001 — a frame that cannot be kept leaves the DataFrame's own display
            log.exception("the frame of a table card was not kept")
    return outputs, exec_count, status


def _verify_hook(event: str, workspace: str, nb: dict, cell: dict) -> None:
    """Verification's one enqueue point: `ran` from _execute_cell and `takeaway` from append_takeaway, both before the
    notebook is written so the hook's fields land in the same save. Never raises."""
    try:
        from . import verify  # lazy: verify imports this module
    except ImportError:
        return
    try:
        (verify.on_cell_ran if event == "ran" else verify.on_takeaway)(workspace, nb, cell)
    except Exception:  # noqa: BLE001
        log.exception("verification hook (%s) failed for cell %s", event, cell.get("id"))


async def execute_on(workspace: str, kernel: str, code: str, timeout_s: float | None = None) -> tuple[list[dict], int | None, str]:
    """Run `code` on the workspace's dedicated kernel `kernel` and return (outputs, exec_count, status) without storing
    a cell. Raises when the kernel cannot start; a code error is an `error` status with its bundle."""
    if not kernel:
        raise ValueError("execute_on needs a dedicated kernel name")
    k = _kernel(workspace, kernel)
    async with k.lock:
        await _ensure_started(k, workspace, kernel)
        return await _execute(k, code, positive_timeout(timeout_s))


def _trial_code(fn: str, tid: str) -> str:
    """The expression that calls one of the kernel's trial functions, doing nothing in a kernel without the `thimble`
    module. It rides the kernel's ordinary requests, since a separate silent request can leave the next run waiting for
    a reply that never comes."""
    return f"(lambda t: t and t._trial_{fn}({tid!r}))(__import__('sys').modules.get('thimble'))"


TRIAL_EXPR_KEY = "thimble_trial"  # the user expression that ends a trial (trial_run)


async def trial_run(workspace: str, cell_id: str, code: str) -> dict:
    """The card as it would be with `code`, run on the card's kernel and not stored: a fix the card check tries before
    applying it. Returns {**card, code, outputs, status, exec_count, trial}, its outputs numbered against the card's.
    The names the run bound are noted under `trial` so trial_settle can put them back when the fix is refused. KeyError
    for a missing card, ValueError for one that runs no code."""
    ws = _ws(workspace)
    hit = _locate(ws, cell_id)
    if hit is None:
        raise KeyError(cell_id)
    nb, cell = hit
    if not runnable(cell):
        raise ValueError(f"a {cell.get('kind', DEFAULT_KIND)} card has no code to run")
    kernel = _kernel_for(nb, None, cell, ws)
    try:
        timeout_s = positive_timeout(cell.get("timeout_s"))
    except ValueError:
        timeout_s = None
    tid = secrets.token_hex(6)
    try:
        k = _kernel(workspace, kernel)
        async with k.lock:
            await _ensure_started(k, workspace, kernel)
            # the bindings are noted by a first line of the same request, and what the code bound by a user expression
            # after it, so nothing else runs between them
            outputs, exec_count, status = await _run_card_code(k, f"{_trial_code('begin', tid)}\n{code}", cell.get("kind"),
                                                               timeout_s, {TRIAL_EXPR_KEY: _trial_code("end", tid)})
            labels, revs = k.last_labels, k.last_label_revs
    except Exception as e:  # noqa: BLE001 — a kernel that failed to start is the trial's error, as for a run
        outputs, exec_count, status, labels, revs = [_error_bundle(type(e).__name__, str(e))], None, "error", [], {}
    number_outputs(_memo_of(cell), outputs)
    return {**copy.deepcopy(cell), "code": code, "outputs": outputs, "status": status, "exec_count": exec_count,
            "labels": labels, "label_revs": revs, "trial": tid}


async def trial_settle(workspace: str, cell_id: str, tid: str, *, keep: bool) -> None:
    """The end of a trial_run: a kept fix's trial is forgotten, and a refused one has its bound names put back where no
    run since has rebound them. A card or kernel gone since leaves nothing to settle."""
    ws = _ws(workspace)
    hit = _locate(ws, cell_id)
    if hit is None or not tid:
        return
    nb, cell = hit
    key = _kernel_for(nb, None, cell, ws)
    k = _kernel(workspace, key)
    async with k.lock:
        if k.kc is not None and k.alive():  # a kernel stopped since took the trial's names with it
            await _execute(k, _trial_code("drop" if keep else "undo", tid), 10)


def land_run(workspace: str, nb: dict, cell: dict, code: str, outputs: list[dict], status: str, *, by: str,
             labels: list[str] | None = None, label_revs: dict[str, int] | None = None) -> None:
    """Make a run made elsewhere the card's own, in the loaded group `nb`: its code and trial outputs, recorded in
    `edited` as by `by`. The takeaway stays and is linked again against the new outputs."""
    ws = _ws(workspace)
    if code != cell.get("code"):
        cell["previous_code"] = str(cell.get("code") or "")
        cell["code"] = code
        cell.setdefault("edited", []).append({"by": by, "ts": _now()})
    memo = _memo_of(cell)
    number_outputs(memo, outputs)
    if _has_output(outputs):
        cell[OUT_MEMO] = output_memo(outputs, memo)
    cell.update(outputs=bound_outputs(ws, str(cell.get("id") or ""), outputs, fresh=True), status=status, ts=_now(),
                labels=list(labels or []), label_revs=dict(label_revs or {}))
    if status == "ok":
        _verify_hook("ran", workspace, nb, cell)


async def _run_cell(workspace: str, nb_id: str, cell_id: str, kernel: str | None = None,
                    timeout_s: float | None = None) -> dict:
    """Run an existing cell; the cell as stored (bounded outputs). 400 for a data cell."""
    nb = load_notebook(workspace, nb_id)
    cell = _find(nb, cell_id)
    _reject_data_run(cell)
    stored, _ = await _execute_cell(workspace, nb, cell, kernel, timeout_s)
    return stored


async def edit_and_run(workspace: str, nb_id: str, cell_id: str, code: str, *, by: str,
                       timeout_s: float | None = None, default_timeout_s: float | None = None,
                       title: str | None = None, kind: str | None = None, from_dataset: bool = False) -> dict:
    """Replace a cell's code and run it again in place, for the `edit_card` tool. The replaced code stays as
    `previous_code`, the edit is recorded in `edited`, the stale takeaway is cleared. A run of the same code, title and
    kind keeps the takeaway, marked TAKEAWAY_STALE when the outputs' text changed. `title` and `kind` change in the
    same edit when given. `from_dataset` turns a diagram or timeline stored with a dataset into a card of code. Returns
    the cell with complete outputs. 404 for an unknown cell, 400 for a data cell or a kind without code."""
    nb = load_notebook(workspace, nb_id)
    cell = _find(nb, cell_id)
    if from_dataset and cell.get("kind") in ("diagram", "timeline") and isinstance(cell.get("payload"), dict):
        cell.pop("payload", None)
    _reject_data_run(cell)
    if kind is not None and kind not in RUNNABLE_KINDS:
        raise HTTPException(400, f"a {kind} card has no code to run; the runnable kinds are {', '.join(RUNNABLE_KINDS)}")
    changed = code != cell.get("code") or (title and title != cell.get("title")) or (kind and kind != cell.get("kind"))
    if code != cell.get("code"):
        cell["previous_code"] = str(cell.get("code") or "")
        cell["code"] = code
        cell.pop(KEPT_ARGS, None)
    if title:
        cell["title"] = title
    if kind:
        cell["kind"] = kind
    if changed:
        cell.setdefault("edited", []).append({"by": by, "ts": _now()})
    kept = "" if changed else str(cell.get("takeaway") or "").strip()
    before = outputs_text(hydrate_outputs(_ws(workspace), cell.get("outputs"))) if kept else ""
    if not kept:
        cell["takeaway"] = ""
        cell["takeaway_author"] = None
        cell.pop(TAKEAWAY_STALE, None)
    _, full = await _execute_cell(workspace, nb, cell, None, timeout_s, default_timeout_s)
    if kept and outputs_text(full.get("outputs") or []) != before:
        cell[TAKEAWAY_STALE] = True
        full[TAKEAWAY_STALE] = True
        write_notebook(_ws(workspace), nb)
        _emit(workspace, cell)
    return dict(full)  # a copy: the stored cell is the cached object


# ----------------------------------------------------------------------------------------------------------
# outputs as text, for the models that read a cell
# ----------------------------------------------------------------------------------------------------------

OUTPUTS_TEXT_CHARS = 6000


def _outputs_as_text(outputs: list[dict]) -> tuple[str, list[str]]:
    """Plain-text rendering of a cell's outputs for a model, plus notes for rich outputs."""
    parts: list[str] = []
    notes: list[str] = []
    for b in outputs or []:
        if not isinstance(b, dict):
            continue
        err = next((v for k, v in b.items() if k.startswith("application/vnd.thimble.error")), None)
        if isinstance(err, dict):
            parts.append(f"ERROR {err.get('ename', '')}: {err.get('evalue', '')}")
            continue
        chart = False
        if any(k.startswith("image/") for k in b):
            notes.append("a chart/image was rendered")
            chart = True
        if "text/html" in b and "text/plain" not in b:
            notes.append("an html table was rendered")
        if any("vegalite" in k for k in b):
            notes.append("a vega-lite chart was rendered")
            chart = True
        tp = b.get("text/plain")
        if isinstance(tp, list):
            tp = "".join(map(str, tp))
        # a chart's text/plain is its repr or the renderer's companion notice, never the result: the note above says
        # what rendered, and a model reading that notice would take the chart for broken
        if isinstance(tp, str) and tp.strip() and not chart:
            parts.append(tp.rstrip())
    text = "\n".join(parts)
    if len(text) > OUTPUTS_TEXT_CHARS:
        half = OUTPUTS_TEXT_CHARS // 2
        text = text[:half] + "\n…[truncated]…\n" + text[-half:]
    return text, sorted(set(notes))


def outputs_text(outputs: list[dict], limit: int = OUTPUTS_TEXT_CHARS) -> str:
    """Plain-text rendering of a cell's outputs (streams, text/plain results, errors as one line each), truncated in
    the middle to `limit` chars, with one trailing line naming any rich outputs (chart, html table). For the thread
    context and anything else that shows a cell's result to a model."""
    text, notes = _outputs_as_text(outputs)
    if len(text) > limit:
        half = limit // 2
        text = text[:half] + "\n…[truncated]…\n" + text[len(text) - half:]
    if notes:
        text = (text + "\n" if text else "") + "[" + "; ".join(notes) + "]"
    return text


def append_takeaway(workspace: str, cell_id: str, text: str, *, only_if_empty: bool = False, overwrite: bool = False,
                    author: str | None = None) -> bool:
    """Attach a takeaway to a cell: appended by default, replaced with `overwrite`, left alone with `only_if_empty`
    when the cell has one. `author` is recorded as `takeaway_author` (model, thimble, analyst). False when the cell
    is gone."""
    text = (text or "").strip()
    if not text:
        return False
    ws = _ws(workspace)
    hit = _locate(ws, cell_id)
    if hit is None:
        return False
    nb, cell = hit
    existing = cell.get("takeaway") or ""
    if only_if_empty and existing.strip():
        return True
    cell["takeaway"] = text if overwrite or not existing else (existing + "\n\n" + text).strip()
    cell.pop(TAKEAWAY_STALE, None)
    if author:
        cell["takeaway_author"] = author
    if runnable(cell):
        _verify_hook("takeaway", workspace, nb, cell)  # links the takeaway's numbers to the outputs
    write_notebook(ws, nb)
    _emit(workspace, cell)
    return True


async def run_code(
    workspace: str,
    code: str,
    created_by: str,
    title: str = "",
    notebook: str | None = None,
    created_at_event: int | None = None,
    replace: str | None = None,
    kernel: str | None = None,
    timeout_s: float | None = None,
    default_timeout_s: float | None = None,
    kind: str | None = None,
) -> dict:
    """Create a runnable cell at the end of a group and run it, or with `replace` re-run that cell with the new code,
    its stale takeaway cleared. `notebook` defaults to the bound group, else `main`. `created_at_event` is the index of
    the tool_use record that made the cell. `timeout_s` is stored as the cell's allowance; `default_timeout_s` applies
    when none is named and is never stored. Returns the cell with complete outputs; the group stores the bounded
    version."""
    _, full = await _run_code(workspace, code, created_by, title, notebook, created_at_event, replace, kernel, timeout_s,
                              default_timeout_s, kind)
    return dict(full)  # a copy: the stored cell is the cached object, which later runs and edits mutate in place


async def _run_code(
    workspace: str,
    code: str,
    created_by: str,
    title: str = "",
    notebook: str | None = None,
    created_at_event: int | None = None,
    replace: str | None = None,
    kernel: str | None = None,
    timeout_s: float | None = None,
    default_timeout_s: float | None = None,
    kind: str | None = None,
) -> tuple[dict, dict]:
    """run_code returning (the cell as stored, the cell with its complete outputs). One load, one save."""
    timeout_s = positive_timeout(timeout_s)  # reject a bad value before anything is written
    if kind is not None and kind not in RUNNABLE_KINDS:
        raise ValueError(f"a {kind} card has no code to run; the runnable kinds are {', '.join(RUNNABLE_KINDS)}")
    if replace:
        hit = _locate(_ws(workspace), replace)
        if hit is not None:
            nb, cell = hit
            _reject_data_run(cell)
            cell["code"] = code
            if title and title != cell.get("title"):
                cell["title"] = title
                _name_cell(_ws(workspace), cell)
            if kind:
                cell["kind"] = kind
            cell["takeaway"] = ""
            cell["takeaway_author"] = None
            _emit(workspace, cell)
            return await _execute_cell(workspace, nb, cell, kernel, timeout_s, default_timeout_s)
        # the target is gone: append a fresh cell
    nb_id = notebook or active_notebook_id(workspace)
    nb = load_notebook(workspace, nb_id)
    cell = new_cell(kind or DEFAULT_KIND, created_by, title, nb_id, code=code, created_at_event=created_at_event)
    _name_cell(_ws(workspace), cell)
    nb["cells"].append(cell)
    _emit(workspace, cell)
    return await _execute_cell(workspace, nb, cell, kernel, timeout_s, default_timeout_s)


# ----------------------------------------------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------------------------------------------

CellKind = Literal["plot", "table", "code", "example", "note", "diagram", "timeline", "label", "custom"]
RunnableKind = Literal["plot", "table", "code", "timeline", "diagram"]
GroupKind = Literal["sequence", "split", "grid"]  # the loose group is made by move_cells alone
Role = Literal["exploration", "finding", "analyst", "figures"]


class NewCell(BaseModel):
    kind: CellKind = "code"
    title: str = ""
    code: str | None = None
    payload: dict | None = None
    created_by: str = "user"
    created_at_event: int | None = None
    after: str | None = None


class CellEdit(BaseModel):
    """PUT body: only the given fields change."""

    code: str | None = None
    title: str | None = None
    takeaway: str | None = None
    payload: dict | None = None
    locked: bool | None = None
    by: str | None = None  # who edits: user (the default) or chat:<id>
    width: int | None = None  # the card's width on the canvas, CARD_WIDTH_MIN..MAX
    height: int | None = None  # its height, CARD_HEIGHT_MIN..MAX
    starred: bool | None = None
    pos: dict | None = None  # its place inside its group's frame; null returns it to the group's flow


class CellMove(BaseModel):
    """POST body of a move: the cards in order, the group they go to (null for the loose group), and where: `after` a
    card of that group (null for first, left out for last), or `pos` for one card placed free."""

    cells: list[str]
    group: str | None = None
    after: str | None = None
    pos: dict | None = None


class RunBody(BaseModel):
    code: str
    kind: RunnableKind = "code"
    title: str = ""
    created_by: str = "user"
    created_at_event: int | None = None
    timeout_s: float | None = Field(default=None, gt=0)


class NewNotebook(BaseModel):
    title: str | None = None
    parent: str | None = None
    kind: GroupKind | None = None
    pos: dict | None = None
    order: int | None = None
    role: Role | None = None
    anchor: str | None = None
    chat: str | None = None
    investigation: str | None = None
    finding: int | None = None


class NotebookMeta(BaseModel):
    title: str | None = None
    parent: str | None = None
    kind: GroupKind | None = None
    pos: dict | None = None  # where the group's frame sits (the layout fields); null returns it to the default placement
    order: int | None = None  # how many of its parent's cards come before it in the flow; null for after all of them


# Routes are `async def` so everything (including _emit into subscriber queues) runs on the event loop thread.


@router.get("/ws/{c}/canvas")
async def canvas_route(c: str) -> dict:
    """The canvas as the browser shows it, the orientation's cards among them as it adds them. A Scratch group is marked
    first (migrate_scratch), so canvas() leaves it out."""
    migrate_scratch(c)
    migrate_writer_groups(c)
    return canvas(_ws(c))


# Scratch: a working group of role `working` in stored workspaces. Its cards are kept, since their ids are cited: on
# open, each top-level `working` group moves to the root as SCRATCH_TITLE, role exploration, after every other root
# group, marked SCRATCH_KEY, and groups nested in it become role exploration. canvas() leaves out a marked group and
# everything in it; its cards stay in the files, so refs resolve. A root titled SCRATCH_TITLE with role exploration gets
# the mark too. Runs once per workspace and process.
SCRATCH_TITLE = "Orientation scratch"
SCRATCH_KEY = "scratch"
_scratch_migrated: set[str] = set()


def migrate_scratch(c: str) -> list[str]:
    """Move a Scratch group out of the deck and mark it (see above); the ids of the groups moved or marked."""
    try:
        ws = config.workspace_dir(c)
    except (ValueError, HTTPException):
        return []
    if str(ws) in _scratch_migrated:  # by folder, so a workspace made again under the same name is looked at again
        return []
    _scratch_migrated.add(str(ws))
    d = notebooks_dir(ws)
    raw: dict[str, dict] = {}
    marked: list[str] = []
    for p in sorted(d.glob("*.json")) if d.is_dir() else ():
        if not ID_RE.match(p.stem):
            continue
        try:
            data = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        if data.get("role") == LEGACY_WORKING:
            raw[p.stem] = data
        elif (data.get("title") == SCRATCH_TITLE and not data.get("parent") and data.get("role") == "exploration"
              and SCRATCH_KEY not in data):
            marked.append(p.stem)
    moved: list[str] = []
    for gid, data in raw.items():
        nb = read_notebook(ws, gid)
        if nb is None:
            continue
        nb["role"] = "exploration"
        if data.get("parent") not in raw:
            nb.update(parent=None, title=SCRATCH_TITLE, kind=DEFAULT_GROUP_KIND, pos=None, order=None, ts=_created())
            nb[SCRATCH_KEY] = True
            moved.append(gid)
        write_notebook(ws, nb)
    for gid in marked:
        nb = read_notebook(ws, gid)
        if nb is not None:
            nb[SCRATCH_KEY] = True
            write_notebook(ws, nb)
            moved.append(gid)
    if moved:
        log.info("%s: moved and marked the orientation's old Scratch, off the canvas (%s)", c, ", ".join(moved))
    return moved


# A writer's figures group stored inside the analyst's Your work moves to the root on the canvas's first read in a
# process, when every card in it and in the groups under it was made by a writer and it has at least one. It keeps its
# cards, title and subgroups. Groups with anyone else's card, and threads' groups, stay. A moved group is stamped with
# its writer's THIMBLE_SESSION (unless a root group already carries it) and each move writes a `group-moved` history
# line. What is moved no longer matches, so running it again moves nothing.
_writer_groups_migrated: set[str] = set()


def migrate_writer_groups(c: str) -> list[str]:
    """Move writers' figures groups out of Your work (see above); the ids of the groups moved."""
    from . import agents, canvas_history  # noqa: PLC0415 — agents imports this module

    try:
        ws = config.workspace_dir(c)
    except (ValueError, HTTPException):
        return []
    if str(ws) in _writer_groups_migrated:  # by folder, as migrate_scratch
        return []
    _writer_groups_migrated.add(str(ws))
    session_key = "session"  # tools.SESSION_GROUP_KEY; tools imports this module lazily
    rows = list_notebooks(ws, figures=False)
    nbs = {r["id"]: read_notebook(ws, r["id"]) for r in rows}
    kids: dict[str, list[str]] = {}
    for gid, nb in nbs.items():
        if nb is not None and nb.get("parent"):
            kids.setdefault(str(nb["parent"]), []).append(gid)
    writers: dict[str, str | None] = {}  # maker -> the writer's doc, None when the maker is not a writer's chat

    def writer_doc(maker: Any) -> str | None:
        key = str(maker or "")
        if key not in writers:
            meta = agents.meta_or_none(c, key[5:]) if key.startswith("chat:") and ID_RE.match(key[5:]) else None
            writers[key] = str(meta.get("doc") or "report") if meta and meta.get("role") == "writer" else None
        return writers[key]

    def docs_of(gid: str, seen: set[str]) -> set[str] | None:
        """The docs of the writers who made every card in group `gid` and under it; None when anyone else made one,
        or the group or one under it is the analyst's or a thread's."""
        if gid in seen:
            return set()
        seen.add(gid)
        nb = nbs.get(gid)
        if nb is None or nb.get("anchor") or nb.get("chat"):
            return None
        if nb.get("created_by") and writer_doc(nb["created_by"]) is None:
            return None
        out: set[str] = set()
        for cell in nb.get("cells") or []:
            d = writer_doc(cell.get("created_by"))
            if d is None:
                return None
            out.add(d)
        for k in kids.get(gid, []):
            sub = docs_of(k, seen)
            if sub is None:
                return None
            out |= sub
        return out

    stamped = {str(nb.get(session_key)) for nb in nbs.values() if nb is not None and not nb.get("parent") and nb.get(session_key)}
    moved: list[str] = []
    for root_id, root in nbs.items():
        if (root is None or root.get("parent") or (root.get("role") or DEFAULT_ROLE) != "analyst" or root.get(session_key)
                or root.get("kind") == LOOSE_KIND or root.get("anchor") or root.get("chat")):
            continue
        for gid in list(kids.get(root_id, [])):
            docs = docs_of(gid, set())
            if not docs:  # someone else's card in it, or no card at all
                continue
            nb = read_notebook(ws, gid)
            if nb is None:
                continue
            cards = [str(x.get("id")) for x in nb.get("cells") or []]
            nb.update(parent=None, pos=None, order=None)
            key = f"writer:{sorted(docs)[0]}" if len(docs) == 1 else None
            if key and key not in stamped:
                nb[session_key] = key
                stamped.add(key)
            write_notebook(ws, nb)
            canvas_history.group_moved(c, gid, title=str(nb.get("title") or ""), by="migration", from_parent=root_id,
                                       to_parent=None, cards=cards)
            moved.append(gid)
    if moved:
        log.info("%s: moved an older writer's figures out of Your work to the root (%s)", c, ", ".join(moved))
    return moved


@router.get("/ws/{c}/notebooks")
async def list_notebooks_route(c: str) -> list[dict]:
    return list_notebooks(_ws(c), figures=False)


def cell_names(ws: Path) -> list[dict]:
    """[{id, notebook, kind, title, slug, exec_count, ts, status}] for every cell of every group, no outputs: what a
    chip needs to label a `card:<id>` ref by the card's name (cell_slugs)."""
    names = cell_slugs(ws)
    out: list[dict] = []
    for nb_id, nb in _stored(ws):
        for cell in nb.get("cells") or []:
            if not isinstance(cell, dict) or not cell.get("id"):
                continue
            out.append({"id": cell["id"], "notebook": nb_id, "kind": cell.get("kind", DEFAULT_KIND), "title": cell.get("title") or "",
                        "slug": names.get(cell["id"]), "exec_count": cell.get("exec_count"), "ts": cell.get("ts"), "status": cell.get("status")})
    return out


@router.get("/ws/{c}/cells/names")
async def cell_names_route(c: str) -> list[dict]:
    return cell_names(_ws(c))


def _parent_exists(ws: Path, parent: str | None) -> None:
    if parent is not None and (not ID_RE.match(parent) or read_notebook(ws, parent) is None):
        raise HTTPException(404, f"no such group: {parent}")


@router.post("/ws/{c}/notebooks")
async def create_notebook_route(c: str, body: NewNotebook | None = None) -> dict:
    """A new group; returns its summary. 404 for an unknown parent."""
    b = body or NewNotebook()
    ws = _ws(c)
    _parent_exists(ws, b.parent)
    if b.pos is not None and pos_of(b.pos) is None:
        raise HTTPException(400, "pos must be {x, y} numbers or null")
    return summary(create_notebook(ws, b.title, role=b.role or DEFAULT_ROLE, investigation=b.investigation, finding=b.finding,
                                   parent=b.parent, anchor=b.anchor, chat=b.chat, kind=b.kind, pos=b.pos, order=b.order))


@router.get("/ws/{c}/notebooks/{nb}")
async def get_notebook(c: str, nb: str) -> dict:
    return load_notebook(c, nb)


@router.put("/ws/{c}/notebooks/{nb}")
async def update_notebook(c: str, nb: str, body: NotebookMeta) -> dict:
    """Rename a group, move it under another group (`parent`, null for the root), change its kind, or place its frame
    (`pos` {x, y} and `order`, the layout fields; null for the default placement). Returns the summary. 404 for an
    unknown parent, 400 for a move that would make a cycle or a pos that is not {x, y}; nothing changes on an error."""
    notebook = load_notebook(c, nb)
    ws = _ws(c)
    fields = body.model_fields_set
    if "pos" in fields and body.pos is not None and pos_of(body.pos) is None:
        raise HTTPException(400, "pos must be {x, y} numbers or null")
    if "parent" in fields:
        _parent_exists(ws, body.parent)
        try:
            set_parent(ws, {**notebook}, body.parent)  # the cycle check first, on a copy
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        notebook["parent"] = body.parent
    if "pos" in fields:
        notebook["pos"] = pos_of(body.pos)
    if "order" in fields:
        notebook["order"] = order_of(body.order)
    if body.title is not None and body.title.strip():
        notebook["title"] = body.title.strip()
    if body.kind is not None:
        notebook["kind"] = body.kind
    save_notebook(c, notebook)
    return summary(notebook)


def trash_notebook(ws: Path, nb_id: str) -> bool:
    """Remove a group from the workspace's list: its file moves to TRASH_DIR whole (its cells' side files stay where
    the file names them), the read cache forgets it, and settings.active_notebook is cleared when it named it. False
    when there is no such file."""
    p = _nb_file(ws, nb_id)
    if not p.is_file():
        return False
    trash = ws / TRASH_DIR
    trash.mkdir(parents=True, exist_ok=True)
    p.replace(trash / p.name)
    _cache.pop(p, None)
    settings = read_json(ws / "settings.json", {})
    if isinstance(settings, dict) and settings.get("active_notebook") == nb_id:
        write_json(ws / "settings.json", {**settings, "active_notebook": None})
    return True


def subtree(ws: Path, nb_id: str) -> list[str]:
    """The group and every group under it, parents before children."""
    kids: dict[str, list[str]] = {}
    for gid, g in _stored(ws):
        if g.get("parent"):
            kids.setdefault(str(g["parent"]), []).append(gid)
    out: list[str] = []
    todo = [nb_id]
    while todo:
        gid = todo.pop(0)
        if gid in out:
            continue
        out.append(gid)
        todo.extend(kids.get(gid, []))
    return out


@router.delete("/ws/{c}/notebooks/{nb}")
async def delete_notebook(c: str, nb: str) -> dict:
    """Trash a group with everything in it: the groups under it and all their cards (the canvas deletes a frame with
    its contents). Every card is announced as deleted."""
    ws = _ws(c)
    if read_notebook(ws, nb) is None or not _nb_file(ws, nb).is_file():
        raise HTTPException(404, f"no such notebook: {nb}")
    gone: list[dict] = []
    for gid in subtree(ws, nb):
        g = read_notebook(ws, gid)
        if g is not None and trash_notebook(ws, gid):
            gone.extend({**cell, "notebook": gid} for cell in g["cells"])
    for cell in gone:
        _emit(c, cell, what="deleted")
    return {"ok": True}


@router.post("/ws/{c}/cells/move")
async def move_cells_route(c: str, body: CellMove) -> list[dict]:
    """Move cards: reorder them in their group, put them in another group's flow, or place one free (CellMove)."""
    kw: dict[str, Any] = {"pos": body.pos}
    if "after" in body.model_fields_set:
        kw["after"] = body.after
    return move_cells(c, body.cells, body.group, **kw)


@router.post("/ws/{c}/notebooks/{nb}/cells")
async def create_cell(c: str, nb: str, body: NewCell) -> dict:
    """A new cell in the group, at the end or after `after`. 400 for code on a data kind or a payload on a runnable one."""
    load_notebook(c, nb)  # 404 before anything is made
    try:
        cell = new_cell(body.kind, body.created_by, body.title, nb, code=body.code, payload=body.payload,
                        created_at_event=body.created_at_event)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return insert_cell(c, nb, cell, body.after)


def _cell_in(c: str, nb: str, cell_id: str) -> dict:
    """The cell when it is in that group; 404 otherwise."""
    return _find(load_notebook(c, nb), cell_id)


def _edit_args(body: CellEdit) -> dict:
    """edit_cell's keywords from a PUT body: `pos` only when it was sent (null clears it), 400 when it is not {x, y}."""
    args = body.model_dump(exclude={"pos"})
    if "pos" in body.model_fields_set:
        if body.pos is not None and pos_of(body.pos) is None:
            raise HTTPException(400, "pos must be {x, y} numbers or null")
        args["pos"] = body.pos
    return args


@router.put("/ws/{c}/notebooks/{nb}/cells/{cell_id}")
async def update_cell(c: str, nb: str, cell_id: str, body: CellEdit) -> dict:
    _cell_in(c, nb, cell_id)
    return edit_cell(c, cell_id, **_edit_args(body))


@router.put("/ws/{c}/cells/{cell_id}")
async def update_cell_by_id(c: str, cell_id: str, body: CellEdit) -> dict:
    return edit_cell(c, cell_id, **_edit_args(body))


@router.get("/ws/{c}/cells/{cell_id}")
async def get_cell_route(c: str, cell_id: str) -> dict:
    cell = get_cell(c, cell_id)
    if cell is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    return cell


@router.delete("/ws/{c}/notebooks/{nb}/cells/{cell_id}")
async def delete_cell_route(c: str, nb: str, cell_id: str) -> dict:
    _cell_in(c, nb, cell_id)
    delete_cell(c, cell_id)
    return {"ok": True}


@router.delete("/ws/{c}/cells/{cell_id}")
async def delete_cell_by_id(c: str, cell_id: str) -> dict:
    delete_cell(c, cell_id)
    return {"ok": True}


@router.get("/ws/{c}/notebooks/{nb}/cells/{cell_id}/outputs/{i}/full")
async def output_full(c: str, nb: str, cell_id: str, i: int) -> PlainTextResponse:
    """The complete text of the cell's output with index `i` as text/plain: the side file of a bounded stream bundle,
    else the stored text. 404 when the cell has no such text output."""
    cell = _cell_in(c, nb, cell_id)
    text = await asyncio.to_thread(output_full_text, _ws(c), cell, i)  # the side file can be tens of MB
    if text is None:
        raise HTTPException(404, f"card {cell_id} has no text output {i}")
    return PlainTextResponse(text)


@router.post("/ws/{c}/notebooks/{nb}/cells/{cell_id}/run")
async def run_cell(c: str, nb: str, cell_id: str) -> dict:
    return await _run_cell(c, nb, cell_id)


@router.post("/ws/{c}/cells/{cell_id}/run")
async def run_cell_by_id(c: str, cell_id: str) -> dict:
    hit = find_cell(_ws(c), cell_id)
    if hit is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    return await _run_cell(c, hit[0], cell_id)


# Regenerate Card runs in the background once it waits for a label's run, and the loop keeps only weak references to
# tasks, so each is held here until it ends.
_regenerating: set[asyncio.Task] = set()


@router.post("/ws/{c}/cells/{cell_id}/regenerate")
async def regenerate_cell(c: str, cell_id: str, response: Response) -> dict:
    """Run a card again on its labels as they are now (the Regenerate Card offered once a label it counts by has
    changed), then start the card check, which brings the takeaway up to date while the automatic check is on. A card
    that gets no check keeps its takeaway; one whose outputs are unchanged is not read again. Labels whose rows were
    made under another definition run first: the answer is then 202 with the card and `waiting` (those label ids), and
    the card runs when their runs end. Otherwise the card as stored after its run. 404 for no such card, 400 for one
    with no code."""
    hit = find_cell(_ws(c), cell_id)
    if hit is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    if not runnable(hit[1]):
        raise HTTPException(400, f"a {hit[1].get('kind', DEFAULT_KIND)} card has no code to run")
    from . import concepts  # noqa: PLC0415 — concepts imports this module

    waiting = await concepts.bring_current(c, [str(x) for x in hit[1].get("labels") or []])
    if not waiting:
        return await _regenerate(c, cell_id)
    task = asyncio.get_running_loop().create_task(_regenerate_after(c, cell_id, waiting), name=f"thimble-regenerate-{cell_id}")
    _regenerating.add(task)
    task.add_done_callback(_regenerating.discard)
    response.status_code = 202
    return {**copy.deepcopy(hit[1]), "waiting": waiting}


async def _regenerate(c: str, cell_id: str) -> dict:
    """regenerate_cell's run and card check, wherever the card is now; the card as stored."""
    hit = find_cell(_ws(c), cell_id)
    if hit is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    stored = await _run_cell(c, hit[0], cell_id)
    from . import card_check, checkstore  # noqa: PLC0415 — card_check imports this module

    if stored.get("status") == "ok" and card_check.enabled() and card_check.auto(c):
        rec = checkstore.current(c, cell_id) or {}
        card_check.start(c, cell_id, str(rec.get("author") or card_check.MAIN))
    return stored


async def _regenerate_after(c: str, cell_id: str, waiting: list[str]) -> None:
    """The rest of a regenerate_cell that waited: the labels in `waiting` finish, then the card runs. A failed or
    stopped label run leaves the card as it was, its tag still red. Never raises."""
    from . import concepts  # noqa: PLC0415

    try:
        for cid in waiting:
            try:
                summary = await concepts.wait_apply(c, cid, float("inf"))
            except HTTPException as e:
                log.info("regenerate: card:%s stays as it was, since label %s did not run: %s", cell_id, cid, e.detail)
                return
            if summary.get("stopped"):
                log.info("regenerate: card:%s stays as it was, since the run of label %s was stopped", cell_id, cid)
                return
        await _regenerate(c, cell_id)
    except Exception:  # noqa: BLE001 — a background task: its failure is logged, the card stays as it was
        log.exception("regenerate: card:%s failed", cell_id)


@router.post("/ws/{c}/notebooks/{nb}/run")
async def run(c: str, nb: str, body: RunBody) -> dict:
    """Create a runnable cell in the group and run it; the cell as stored (bounded outputs)."""
    load_notebook(c, nb)  # 404 before creating anything
    stored, _ = await _run_code(c, body.code, body.created_by, body.title, notebook=nb, created_at_event=body.created_at_event,
                                timeout_s=body.timeout_s, kind=body.kind)
    return stored


@router.post("/ws/{c}/notebook/restart")
async def restart(c: str) -> dict:
    """Restart the workspace's kernels, the shared one and every dedicated one. The next run starts a fresh kernel."""
    _ws(c)  # validates the workspace
    await shutdown_workspace(c)  # attached or only recorded
    return {"ok": True}


@router.get("/ws/{c}/notebooks/{nb}/events")
async def events(c: str, nb: str) -> EventSourceResponse:
    """The group's cell stream. `main` may be subscribed before it is materialized; any other group must exist."""
    if nb != MAIN and not _nb_file(_ws(c), nb).is_file():
        raise HTTPException(404, f"no such notebook: {nb}")
    _nb_file(_ws(c), nb)
    key = (c, nb)
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(key, set()).add(q)

    async def gen():
        try:
            while True:
                yield {"event": "cell", "data": await q.get()}
        finally:
            _subscribers.get(key, set()).discard(q)

    return EventSourceResponse(
        gen(), ping=15, ping_message_factory=lambda: ServerSentEvent(data="{}", event="ping")
    )


# ----------------------------------------------------------------------------------------------------------
# .ipynb export
# ----------------------------------------------------------------------------------------------------------

_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _md_ipynb(cell_id: str, text: str, kind: str | None = None) -> dict:
    return {"cell_type": "markdown", "id": cell_id, "metadata": {"thimble": {"kind": kind}} if kind else {}, "source": text}


def _ipynb_outputs(outputs: list) -> list[dict]:
    out: list[dict] = []
    for b in outputs or []:
        if not isinstance(b, dict):
            continue
        if "_stream" in b:
            tp = b.get("text/plain")
            text = "".join(map(str, tp)) if isinstance(tp, list) else str(tp or "")
            out.append({"output_type": "stream", "name": str(b.get("_stream") or "stdout"), "text": text})
            continue
        err = b.get(ERROR_MIME)
        if isinstance(err, dict):
            out.append({"output_type": "error", "ename": str(err.get("ename") or "Error"),
                        "evalue": str(err.get("evalue") or ""),
                        "traceback": [str(t) for t in err.get("traceback") or []]})
            continue
        data = {k: v for k, v in b.items() if "/" in k}  # mime keys only; drops `truncated` and other private keys
        if data:
            out.append({"output_type": "display_data", "data": data, "metadata": {}})
    return out


def _data_ipynb(cell: dict) -> dict:
    """A data cell for the export: a note as its markdown, an example as the list of its refs, a label as its concept,
    a dataset as fenced JSON, a custom card as a raw HTML cell."""
    kind = cell.get("kind", DEFAULT_KIND)
    payload = cell.get("payload") or {}
    if kind == "custom":
        return {"cell_type": "raw", "id": cell["id"], "metadata": {"format": "text/html", "thimble": {"kind": kind}},
                "source": str(payload.get("html") or "")}
    if kind == "note":
        body = str(payload.get("text") or "")
    elif kind == "example":
        body = "\n".join(f"- [[{r}]]" for r in payload.get("refs") or [])
    elif kind == "label":
        body = f"Label `{payload.get('concept') or ''}`"
    else:
        body = "```json\n" + json.dumps(payload.get("dataset"), ensure_ascii=False, indent=1, default=str) + "\n```"
    return _md_ipynb(cell["id"], body, kind)


def to_ipynb(nb: dict) -> dict:
    """The group as nbformat-4.5 JSON: each cell's question as a markdown heading, a runnable cell as code with its
    outputs, a data cell by its kind (_data_ipynb), the takeaway as a markdown cell after it. Bounded stream outputs
    export as stored, marker line included."""
    cells: list[dict] = []
    for cell in nb.get("cells") or []:
        title = str(cell.get("title") or "").strip()
        if title:
            cells.append(_md_ipynb(f"{cell['id']}-q", f"### {title}"))
        if runnable(cell):
            cells.append({
                "cell_type": "code", "id": cell["id"], "metadata": {"thimble": {"kind": cell.get("kind", DEFAULT_KIND)}},
                "execution_count": cell.get("exec_count"),
                "source": str(cell.get("code") or ""),
                "outputs": _ipynb_outputs(cell.get("outputs") or []),
            })
        else:
            cells.append(_data_ipynb(cell))
        takeaway = str(cell.get("takeaway") or "").strip()
        if takeaway:
            cells.append(_md_ipynb(f"{cell['id']}-t", takeaway))
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
            "thimble": {k: nb.get(k) for k in ("id", "title", "role", "kind", "parent", "anchor", "chat")},
        },
        "cells": cells,
    }


@router.get("/ws/{c}/notebooks/{nb}/ipynb")
async def export_ipynb(c: str, nb: str) -> Response:
    """Download the group as a .ipynb file. 404 for a group that does not exist."""
    doc = load_notebook(c, nb)
    name = _FILENAME_RE.sub("-", doc.get("title") or nb).strip("-.") or nb
    return Response(
        json.dumps(to_ipynb(doc), ensure_ascii=False, indent=1),
        media_type="application/x-ipynb+json",
        headers={"Content-Disposition": f'attachment; filename="{name}.ipynb"'},
    )
