"""Views: viewers written for how a corpus arranges its records, and the proposals they start as.

A view is three files in `workspaces/<c>/views/<slug>/`, written by the dev agent's session (dev.run_view):
view.json {name, description, claims, unit, accepts, units, derived, libs, built}, reader.py (the contract in
view_host.py), and view.html, drawn in a sandboxed frame that loads nothing but the view's media route. `claims` are globs
of the files the view opens, `unit` "file" for a viewer of one file at a time (a mode of the File browser), `accepts`
the fragment forms it understands (`L<n>`), `units` its own `view:<slug>/<key>` units, `derived` the fields its reader
made rather than read ({field, from, how}); `why` and `declares` are read for `description` and `units`.

Code holds every view to three things the analyst can always see above it. Its residue (shown): each claimed file is
read to the end by build_index or listed by the reader's hidden() with a why, a claim that matches no file is missing,
and the lines the reader could not parse are its problems(); the checks fail on a file neither read nor hidden. Its
derived fields, counted above the view. Its labels: the checks load the page with a test label and fail when the marks
do not show on the records it shows (label_problems).
thimble also ships file-type viewers under the same contract (BUILTIN_VIEWERS). Readers run on the workspace's
`views`
kernel with a cached index; refs.resolve hands file refs with a fragment to enrich_file_ref, and resolve_sync bridges
synchronous callers to the kernel on the server's loop.

A proposal is a view ticket in `views/proposals.json` that starts building as soon as it is proposed. Until the
server
stamps `built` into view.json the view is a draft that nothing lists or opens. After each session turn the server
runs
`gate` (the files' validation, then `check`); a pass stamps `built`, a failure goes back to the session up to
dev.MAX_ATTEMPTS times. A change to a built view (revise) copies its files aside and restores them if the change
fails.
Progress is `view {slug, status, chat?}` on the workspace stream."""
from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import functools
import hashlib
import itertools
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from . import config, headless, investigation, prompts, refs, userconf
from .ledger import atomic_write_text, read_json, unlinked, write_json

log = logging.getLogger("thimble.views")

KERNEL = "views"  # the workspace's dedicated kernel for readers
VIEWS_SUBDIR = "views"
CACHE_SUBDIR = "cache"
PROPOSALS_FILE = "proposals.json"
DELETED_FILE = "deleted.json"  # the proposals the analyst deleted, [{slug, name, counted, ts}] (delete_proposal)
KEY_REFS_FILE = "key-refs.json"  # view:<slug>/<key> -> {refs, excerpt, label, name}, kept past the view's deletion
# under the workspace, beside the views folder, which a kernel may only read (kernel_wrap.READ_ONLY_DIRS): each view's
# index as the views kernel pickled it and the bytes build_index read of each claimed file, by fingerprint, and the
# indexes of the card types (cardtypes.py, extensions.card_types)
INDEXES_SUBDIR = "view-indexes"
VIEW_JSON, READER_PY, VIEW_HTML = "view.json", "reader.py", "view.html"
TOOLS_PROMPT = "tools"  # prompts/tools.md, whose lowercase sections are the lines the view tools' results carry
# a view ticket's status on its proposal row; `dropped` is an orientation proposal that could not be built through its
# repairs. An orientation's proposal carries `held: true` until its view first passes its checks (mark_built): it builds
# at once, and the analyst hears of it only then.
# `suggested` is a viewer for a file type the File browser proposed (suggest), which builds only once the analyst
# accepts it.
STATUSES = ("queued", "building", "built", "failed", "dropped", "suggested")
PENDING = ("queued", "building")  # the statuses a restart queues again (dev.recover_views)
SHOTS_KEPT = 5  # the check pictures kept per view, newest first (the session Reads the latest)
# views/.versions/<slug>/<version>/: the view's files at each version that passed its checks, named by their digest,
# which a page loaded at that version keeps reading while the view changes (the routes' `v`); the newest are kept
VERSIONS_SUBDIR = ".versions"
VERSIONS_KEPT = 5
VERSION_RE = re.compile(r"^[0-9a-f]{12}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
# the route names under /views/ and the Reader's built-in file views, which its switcher keys by
RESERVED_SLUGS = {"proposals", "forge", "raw", "records", "table", "text", "transcript", "lib", "frame", "resolve",
                  "suggestions", "suggest"}
BUILD_TIMEOUT_S = 180.0  # a call that may build the index over the claimed files
CALL_TIMEOUT_S = 15.0  # a call once the index for the fingerprint is known to be built
LABEL_MAX = 40  # chars of a chip label a reader supplies (chips stay short)
EXCERPT_MAX = refs.EXCERPT_MAX
REFS_MAX = 200  # file refs a resolved locator carries
MEMO_MAX = 5000  # resolved locators kept in memory
ERROR_MAX = 2000
PROBLEMS_SHOWN = 20  # the lines a reader could not read that thimble lists beside the view (reader_problems)
DERIVED_MAX = 100  # the derived fields a view lists
DERIVED_CHARS = {"field": 80, "from": 300, "how": 600}
WHY_CHARS = 300  # of why hidden() leaves a file out
NOT_SHOWN_NAMED = 5  # the files a failed check names that the view neither read whole nor hid
FILES_LISTED = 500  # the claimed files a view's record lists (_public)
SIBLING_SAMPLE = 200  # of a claimed folder's paths, those looked for in a folder beside it (sibling_files)
SOURCE_MAX = 400_000  # chars of reader.py or view.html a view may hold
# the checks: sample lines per claimed file, files sampled, keys followed, cited records read per key
CHECK_LINES, CHECK_FILES, CHECK_KEYS, CHECK_KEY_REFS = 3, 3, 3, 30
SHOT_TIMEOUT_S, SHOT_STATE_S = 30.0, 30.0  # a headless run's time: the browser's start, then each state's
SHOT_SIZE = (800, 700)  # the view's pane in a 1440×900 window, beside the chat and the Labels sidebar
# a page anchoring fewer than one in ANCHORED_SHARE of the record refs its fetches returned is noted by the gate
# (unmarked); the strings of each answer read for them, FETCHED_SCAN_MAX at most
ANCHORED_SHARE = 10
FETCHED_SCAN_MAX = 200_000
_RECORD_REF = re.compile(r"^[^\s#][^#\n]*#L[1-9]\d*$")  # a record ref, `<path>#L<n>` (frontend files/labels recordRef)
FOLDER_CACHE_S = 5.0
_NODE_MODULES = config.REPO_ROOT / "frontend" / "node_modules"
# The libraries a view page may use, served by thimble and inlined into the page. vega-embed needs vega and vega-lite
# before it, so a view that names it gets all three in this order.
LIBS: dict[str, Path] = {
    "vega": _NODE_MODULES / "vega" / "build" / "vega.min.js",
    "vega-lite": _NODE_MODULES / "vega-lite" / "build" / "vega-lite.min.js",
    "vega-embed": _NODE_MODULES / "vega-embed" / "build" / "vega-embed.min.js",
}
LIB_NEEDS = {"vega-lite": ("vega",), "vega-embed": ("vega", "vega-lite")}
BRIDGE_JS = Path(__file__).with_name("viewer_bridge.js")
KIT_CSS = Path(__file__).with_name("viewer_kit.css")  # thimble's chips, buttons, segmented controls, tables and list rows
HOST_PY = Path(__file__).with_name("view_host.py")
KERNEL_THIMBLE = Path(__file__).with_name("kernel_thimble.py")  # the `thimble` module a reader imports (view_host)
# The test label of the checks and the review: it marks every record whose line is a multiple of PROBE_EVERY, about one
# in seven, so a picture shows whether labels reach the page without any label being defined (kernel_thimble._probed).
PROBE_EVERY = 7
NO_LABELS: dict[str, Any] = {"labels": [], "filter": None}
SHOT_SCRIPT = config.REPO_ROOT / "scripts" / "view_shot.mjs"
SHOT_LINE_MAX = 16 * 1024 * 1024  # bytes of one message line from the headless page, such as a marks request
NODE_MIN = 20  # the Node major the checks need, as scripts/install.sh asks for it
# plugin/viewers holds the worked examples a view ticket's session reads and the file-type viewers thimble ships
VIEWERS_DIR = config.REPO_ROOT / "plugin" / "viewers"
EXAMPLES_DIR = VIEWERS_DIR
BUILTIN_VIEWERS = ("pdf",)
BUILTIN_CACHE = ".builtin"  # under the workspace's views folder: a built-in viewer's index cache and check shots
# Scripts and styles inline (the bridge, the vendored libraries, the view's own), images as data or blob URLs, workers
# from blob URLs, and eval for vega's expression parser. `{media}` is the view's own media route (frame_document),
# the one URL an image, audio or video element may load; no script can fetch anything (connect-src 'none'). No policy
# covers WebRTC, which the page's head in the browser (frontend lib/frame.ts NO_RTC) and the headless shots take away.
FRAME_CSP = ("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; "
             "img-src data: blob:{media}; font-src data:; media-src data: blob:{media}; worker-src blob:; "
             "connect-src 'none'; form-action 'none'; base-uri 'none'")
# The files the media route serves, by suffix: images, audio and video, which an element shows without the page reading
# their bytes. No SVG (its scripts would run if opened on its own) and no other type.
MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".avif": "image/avif", ".bmp": "image/bmp",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".oga": "audio/ogg",
    ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".weba": "audio/webm",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".ogv": "video/ogg",
}
# the type is the one MEDIA_TYPES names, never sniffed, and the file opened on its own runs nothing
MEDIA_HEADERS = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"}
# the origin the browser reaches this server at (location.origin, through Vite's proxy in development)
ORIGIN_RE = re.compile(r"https?://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?")  # used with fullmatch
# the media route's origin in the headless page of the checks, which view_shot.mjs answers from the files media_file
# names, since that page has no server to reach
SHOT_MEDIA_ORIGIN = "http://thimble.invalid"


class ReaderError(Exception):
    """A reader call that did not answer: reader.py raised, timed out, or the kernel did not start."""

    def __init__(self, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _emit(c: str, slug: str, status: str, **extra: Any) -> None:
    """The `view` event on the workspace stream. investigation.emit runs on the event loop only, so a caller in a
    worker thread (a route's blocking part) hands it to the bound loop. A held proposal's build sends none: the analyst
    hears of it once its view is built (mark_built)."""
    if slug in held_slugs(c):
        return
    event = {"type": "view", "slug": slug, "status": status, **extra}

    def send() -> None:
        try:
            investigation.emit(c, investigation.MAIN, event)
        except Exception:  # noqa: BLE001
            log.exception("view event (%s %s %s) not emitted", c, slug, status)

    if _thread_loop() is not None:
        send()
    elif _loop is not None and _loop.is_running() and not _loop.is_closed():
        _loop.call_soon_threadsafe(send)
    else:
        log.info("view event (%s %s %s) not emitted: no event loop", c, slug, status)


# ----------------------------------------------------------------------------------------------------------
# the event loop the views kernel runs on (resolve_sync)
# ----------------------------------------------------------------------------------------------------------

_loop: asyncio.AbstractEventLoop | None = None


def _bind_loop() -> None:
    """Remember the running loop, the one whose kernel client resolve_sync must use from other threads."""
    global _loop
    with contextlib.suppress(RuntimeError):
        _loop = asyncio.get_running_loop()


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    """The router's lifespan (FastAPI merges it into the app's): the server's loop is bound before the first request,
    so the first hover over a cited record can reach the views kernel from the /ref route's thread."""
    _bind_loop()
    yield


router = APIRouter(lifespan=_lifespan)


# ----------------------------------------------------------------------------------------------------------
# views on disk
# ----------------------------------------------------------------------------------------------------------


def views_dir(c: str) -> Path:
    return config.workspace_dir(c) / VIEWS_SUBDIR


def _view_dirs(c: str) -> dict[str, Path]:
    """slug -> the view's directory, for every directory under the workspace's views that holds a view.json."""
    base = views_dir(c)
    if not base.is_dir():
        return {}
    return {d.name: d for d in sorted(base.iterdir())
            if d.is_dir() and SLUG_RE.match(d.name) and (d / VIEW_JSON).is_file()}


def _str_list(v: Any) -> list[str]:
    if isinstance(v, str):
        v = [v]
    return [s for s in (" ".join(str(x).split()) for x in v) if s] if isinstance(v, list) else []


def _forms(v: Any) -> list[dict[str, str]]:
    """[{form, means}] from a list of forms, each a string or {form, means}."""
    out: list[dict[str, str]] = []
    for x in v if isinstance(v, list) else ([v] if v else []):
        if isinstance(x, dict):
            form, means = str(x.get("form") or "").strip(), " ".join(str(x.get("means") or "").split())
        else:
            form, means = str(x).strip(), ""
        if form:
            out.append({"form": form, "means": means})
    return out


def _cut(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _derived(v: Any) -> list[dict[str, str]]:
    """[{field, from, how, kind}] from view.json's `derived` or a reader's derived(index): each with a field name, the
    first entry of a field kept, `kind` "inferred" for a value the files do not state (a join, an estimate, a
    classification) and "" otherwise. The inferred fields come first, each list in its own order."""
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for x in v if isinstance(v, list) else []:
        if not isinstance(x, dict):
            continue
        d = {k: _cut(" ".join(str(x.get(k) or "").split()), n) for k, n in DERIVED_CHARS.items()}
        d["kind"] = "inferred" if str(x.get("kind") or "").strip().lower() == "inferred" else ""
        if d["field"] and d["field"] not in seen:
            seen.add(d["field"])
            out.append(d)
    return sorted(out, key=lambda d: d["kind"] != "inferred")[:DERIVED_MAX]


def _unit(v: Any) -> Any:
    """view.json's `unit`: "file" for a viewer of one file at a time, else what the view picks among (a name or an
    object), '' when it names none."""
    if isinstance(v, str):
        return " ".join(v.split()).lower() if v.strip().lower() == "file" else " ".join(v.split())
    return v if isinstance(v, dict) and v else ""


def _libs(v: Any) -> list[str]:
    """The named libraries with what each needs ahead of it, in LIBS order."""
    wanted = set(_str_list(v)) & set(LIBS)
    for name in list(wanted):
        wanted.update(LIB_NEEDS.get(name, ()))
    return [n for n in LIBS if n in wanted]


def _normalize_view(slug: str, raw: Any, *, where: Path | None = None, origin: str = "workspace") -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    d = where
    return {
        "origin": origin,  # workspace (written for this corpus) or builtin (a file-type viewer thimble ships)
        "slug": slug,
        "name": " ".join(str(raw.get("name") or slug).split()),
        "description": " ".join(str(raw.get("description") or raw.get("why") or "").split()),
        "claims": _str_list(raw.get("claims")),
        "unit": _unit(raw.get("unit")),
        "accepts": _forms(raw.get("accepts")),
        "units": _forms(raw.get("units") if raw.get("units") is not None else raw.get("declares")),
        "derived": _derived(raw.get("derived")),
        "libs": _libs(raw.get("libs")),
        "built": str(raw.get("built") or ""),
        "version": str(raw.get("version") or ""),
        # a workspace view the server has not stamped `built` is a view ticket's work in progress, which only its
        # checks read (module note); a file-type viewer thimble ships is never one
        "draft": origin == "workspace" and not raw.get("built"),
        # a view whose reader or page is missing is listed so it can be deleted, and never opens a citation
        "ok": bool(d is not None and (d / READER_PY).is_file() and (d / VIEW_HTML).is_file() and _str_list(raw.get("claims"))),
        "dir": str(d) if d else None,
    }


def _builtin_dir(slug: str) -> Path | None:
    d = VIEWERS_DIR / slug
    return d if slug in BUILTIN_VIEWERS and (d / VIEW_JSON).is_file() else None


def read_view(c: str, slug: str) -> dict[str, Any] | None:
    """The view record (view.json normalised, plus `origin`, `ok` and `dir`): the workspace's view of that slug, else
    the built-in viewer of that slug; None when there is neither."""
    d = _view_dirs(c).get(slug)
    if d is None:
        return read_builtin(slug)
    return _normalize_view(slug, _view_json(d), where=d)


def _view_json(d: Path) -> dict[str, Any]:
    """A view folder's view.json, {} when it cannot be read or is no object."""
    try:
        raw = json.loads((d / VIEW_JSON).read_text("utf-8"))
    except (OSError, ValueError) as e:
        log.warning("view %s: view.json unreadable (%s)", d.name, e)
        return {}
    return raw if isinstance(raw, dict) else {}


def read_built(c: str, slug: str) -> dict[str, Any] | None:
    """The view as it last passed its checks: what every reader of a view but its own checks uses, since a draft never
    opens a citation. While a session may be writing the view's folder (_changing), or has left it a draft, that is the
    version kept when it last passed (_as_built); otherwise read_view. None for a view that never passed."""
    v = read_view(c, slug)
    if v is not None and v["origin"] == "workspace" and (v["draft"] or _changing(c, slug)):
        kept = _as_built(c, slug, v)
        if kept is not None:
            return kept
    return None if v is None or v["draft"] else v


def _changing(c: str, slug: str) -> bool:
    """Whether a session may be writing the view's folder: a change to it (revise, whose copy aside stays until the
    change ends) or a revision its review asked for."""
    from . import view_review  # noqa: PLC0415 — the review imports this module

    return _revision_dir(c, slug).is_dir() or view_review.revising(c, slug)


def _as_built(c: str, slug: str, live: dict[str, Any]) -> dict[str, Any] | None:
    """The view at the version it last passed its checks at: the kept version its folder's stamp names, else the one its
    copy aside (_keep_built) names, else the newest kept, else that copy itself; None when there is none."""
    root, aside = _versions_dir(c, slug), _revision_dir(c, slug)
    stamps = [live["version"], str(_view_json(aside).get("version") or "") if (aside / VIEW_JSON).is_file() else ""]
    d = next((root / s for s in stamps if VERSION_RE.match(s) and (root / s / VIEW_JSON).is_file()), None)
    if d is None:
        try:
            kept = [x for x in root.iterdir() if VERSION_RE.match(x.name) and (x / VIEW_JSON).is_file()]
        except OSError:
            kept = []
        d = max(kept, key=lambda x: x.stat().st_mtime_ns) if kept else aside if (aside / VIEW_JSON).is_file() else None
    if d is None:
        return None
    v = _normalize_view(slug, _view_json(d), where=d)
    return None if v["draft"] else v


def list_views(c: str) -> list[dict[str, Any]]:
    """The workspace's views as read_built reads them, the views of held proposals left out (held_slugs), then the
    built-in viewers they do not override. A draft does not override a built-in viewer of its slug."""
    held = held_slugs(c)
    mine = [v for v in _own_views(c) if v["slug"] not in held]
    have = {v["slug"] for v in mine}
    return [*mine, *(v for s in BUILTIN_VIEWERS if s not in have and (v := read_builtin(s)) is not None)]


def _own_views(c: str) -> list[dict[str, Any]]:
    """The workspace's own views as read_built reads them, held ones kept (list_proposals settles its rows against
    them)."""
    return [v for s in _view_dirs(c) if (v := read_built(c, s)) is not None]


def held_slugs(c: str) -> set[str]:
    """The slugs of the orientation's proposals whose views have not passed their checks yet, read from the stored rows
    (list_proposals reads list_views)."""
    try:
        p = proposals_path(c)
        raw = read_json(p, []) if p.is_file() else []
    except (OSError, ValueError, HTTPException):
        return set()
    if not isinstance(raw, list):
        return set()
    return {str(x["slug"]) for x in raw
            if isinstance(x, dict) and x.get("slug") and (x.get("held") or x.get("status") == "held")}


def read_builtin(slug: str) -> dict[str, Any] | None:
    """The built-in viewer of that slug, normalised, or None."""
    d = _builtin_dir(slug)
    return None if d is None else _normalize_view(slug, _view_json(d), where=d, origin="builtin")


def cache_dir(c: str, view: dict[str, Any]) -> Path:
    """Where a view's check pictures go, and a built-in viewer's copy of its reader: beside a workspace view, for each of
    its versions, and under the workspace's views folder for a built-in one (whose own folder is part of thimble). The
    server writes it; a kernel may only read it."""
    if view.get("origin") == "builtin":
        return views_dir(c) / BUILTIN_CACHE / view["slug"]
    return views_dir(c) / view["slug"] / CACHE_SUBDIR


def indexes_dir(c: str) -> Path:
    """The workspace's folder of indexes (INDEXES_SUBDIR), which the views kernel and a card's kernel write."""
    return config.workspace_dir(c) / INDEXES_SUBDIR


def index_dir(c: str, slug: str) -> Path:
    """Where the view's index and the bytes its build_index read are kept, by fingerprint."""
    return indexes_dir(c) / slug


def _check_slug(slug: str) -> str:
    slug = str(slug or "").strip()
    if not SLUG_RE.match(slug):
        raise HTTPException(400, f"invalid view slug: {slug!r} (lower-case letters, digits and hyphens)")
    if slug in RESERVED_SLUGS:
        raise HTTPException(400, f"the slug {slug!r} is taken (a route or a file view's name); choose another")
    return slug


def source_problems(claims: Any, reader: str, html: str, libs: Any) -> list[str]:
    """What makes a view's files unable to run, as lines for whoever wrote them: no claims, an empty or oversized reader
    or page, a reader that does not parse or lacks one of its three functions, a library thimble does not have."""
    out: list[str] = []
    if not _str_list(claims):
        out.append("a view claims at least one file: give `claims` in view.json as corpus-relative globs")
    for label, text in ((READER_PY, reader), (VIEW_HTML, html)):
        if not text.strip():
            out.append(f"{label} is empty")
        elif len(text) > SOURCE_MAX:
            out.append(f"{label} is {len(text):,} characters; the most a view holds is {SOURCE_MAX:,}")
    if reader.strip():
        try:
            compile(reader, READER_PY, "exec")
        except SyntaxError as e:
            out.append(f"{READER_PY} does not parse: line {e.lineno}: {e.msg}")
        else:
            missing = [fn for fn in ("build_index", "records", "resolve") if not re.search(rf"^def {fn}\s*\(", reader, re.M)]
            if missing:
                out.append(f"{READER_PY} defines no {', '.join(f'{m}()' for m in missing)} at its top level")
    unknown = sorted(set(_str_list(libs)) - set(LIBS))
    if unknown:
        out.append(f"no library {', '.join(unknown)}; a view may use {', '.join(LIBS)}")
    return out


def write_view(c: str, slug: str, *, name: str, description: str, claims: Any, accepts: Any = None, units: Any = None,
               derived: Any = None, libs: Any = None, reader: str, html: str) -> dict[str, Any]:
    """Write or replace a view's three files, validated (source_problems), and register it built (mark_built): a view
    of thimble's own making, as the tests make theirs; a view ticket's session writes the files itself."""
    slug = _check_slug(slug)
    reader_src = str(reader or "").replace("\r\n", "\n")
    html_src = str(html or "").replace("\r\n", "\n")
    problems = source_problems(claims, reader_src, html_src, libs)
    if problems:
        raise HTTPException(400, problems[0])
    stored = {"name": " ".join(str(name or slug).split()) or slug, "description": " ".join(str(description or "").split()),
              "claims": _str_list(claims), "accepts": _forms(accepts), "units": _forms(units), "libs": _libs(libs)}
    if _derived(derived):
        stored["derived"] = _derived(derived)
    d = views_dir(c) / slug
    d.mkdir(parents=True, exist_ok=True)
    atomic_write_text(d / READER_PY, reader_src.rstrip("\n") + "\n")
    atomic_write_text(d / VIEW_HTML, html_src.rstrip("\n") + "\n")
    write_json(d / VIEW_JSON, stored)
    return mark_built(c, slug)


def mark_built(c: str, slug: str) -> dict[str, Any]:
    """Register the view in the slug's folder: `built` stamped into its view.json (the only writer of that field), its
    memo dropped, and a proposal under the slug marked built, and no longer held, so an orientation's view reaches the
    analyst as soon as it passes its checks. Emits `view {slug, status: built}`, with `asked` for a view the analyst
    asked for, which the browser then opens; a viewer accepted in the File browser (accept) shows there as the file's
    mode instead."""
    d = views_dir(c) / slug
    raw = _view_json(d)
    version = view_digest(d)[:12]
    write_json(d / VIEW_JSON, {**raw, "built": _now(), "version": version})
    _publish(c, slug, version)
    _forget(c, slug)
    prop = read_proposal(c, slug)
    if prop is not None:
        update_proposal(c, slug, status="built", error=None, held=None)
    opens = prop is not None and bool(prop.get("asked")) and not prop.get("accepted")
    _emit(c, slug, "built", version=version, **({"asked": True} if opens else {}))
    return read_view(c, slug) or _normalize_view(slug, raw, where=d)


def _versions_dir(c: str, slug: str) -> Path:
    return views_dir(c) / VERSIONS_SUBDIR / slug


def _publish(c: str, slug: str, version: str) -> None:
    """Keep the view's files as they passed their checks at `version` (VERSIONS_SUBDIR), the newest VERSIONS_KEPT."""
    root = _versions_dir(c, slug)
    dst = root / version
    if not dst.is_dir():
        tmp = root / f".{version}.tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        for f in (views_dir(c) / slug).iterdir():
            if f.is_file() and not f.is_symlink():
                shutil.copy2(f, tmp / f.name)
        os.replace(tmp, dst)
    os.utime(dst)
    kept = sorted((x for x in root.iterdir() if x.is_dir() and VERSION_RE.match(x.name)),
                  key=lambda x: x.stat().st_mtime_ns, reverse=True)
    for old in kept[VERSIONS_KEPT:]:
        shutil.rmtree(old, ignore_errors=True)


def read_version(c: str, slug: str, version: str) -> dict[str, Any] | None:
    """The view as it was at `version` (_publish), else the built view when that is its version; None when neither."""
    if VERSION_RE.match(str(version or "")):
        d = _versions_dir(c, slug) / version
        if (d / VIEW_JSON).is_file():
            return _normalize_view(slug, _view_json(d), where=d)
    live = read_built(c, slug)
    return live if live is not None and live["version"] == version else None


def delete_view(c: str, slug: str) -> None:
    """Remove the view and the proposal it was built from, stopping a change being made to it; it is kept in
    DELETED_FILE, so the orientation never proposes it again. Its `view:` refs keep resolving through key-refs.json. A
    built-in viewer is not deleted."""
    from . import dev  # noqa: PLC0415

    d = _view_dirs(c).get(slug)
    if d is None:
        if _builtin_dir(slug) is not None:
            raise HTTPException(400, f"{slug} is a viewer thimble ships; a workspace view of the same slug overrides it")
        raise HTTPException(404, f"no such view: {slug}")
    _keep_deleted(c, read_proposal(c, slug) or {"slug": slug, "name": _view_json(d).get("name") or slug})
    dev.stop_view(c, slug, "deleted")
    _stop_review(c, slug, forget=True)
    shutil.rmtree(d, ignore_errors=True)
    shutil.rmtree(_versions_dir(c, slug), ignore_errors=True)
    shutil.rmtree(index_dir(c, slug), ignore_errors=True)
    drop_built_copy(c, slug)
    _forget(c, slug)
    items = list_proposals(c)
    if any(p.get("slug") == slug for p in items):
        _save_proposals(c, [p for p in items if p.get("slug") != slug])
    _emit(c, slug, "deleted")


# ----------------------------------------------------------------------------------------------------------
# the files a view claims, and which views open a file
# ----------------------------------------------------------------------------------------------------------


_folder_cache: dict[tuple[Path, str], dict[str, Any]] = {}  # (corpus, folder) -> {ts, files}
_folder_lock = threading.Lock()


def folder_path(corpus: Path, rel: str) -> Path:
    """The folder `rel` (corpus-relative; '' or '.' is the corpus root) as an absolute path; 404 when it is not a
    directory under the corpus."""
    rel = (rel or "").strip().strip("/")
    try:
        p = config.safe_corpus_path(corpus, rel or ".")
    except ValueError:
        raise HTTPException(404, f"no such folder: {rel!r}") from None
    if not p.is_dir():
        raise HTTPException(404, f"no such folder: {rel!r}")
    return p


def _walk_folder(corpus: Path, rel: str) -> list[tuple[str, int, int]]:
    """Every regular file under the folder, recursively, as (corpus-relative path, size, mtime_ns), sorted by path.
    Dot-files
    and sqlite side files are left out; symlinks are followed. Uses scandir and string joins for speed on large
    corpora."""
    root = folder_path(corpus, rel)
    base = root.relative_to(corpus).as_posix()
    prefix = "" if base in ("", ".") else base + "/"
    out: list[tuple[str, int, int]] = []
    stack: list[tuple[str, str]] = [(str(root), prefix)]
    while stack:
        d, pre = stack.pop()
        try:
            entries = list(os.scandir(d))
        except OSError:
            continue
        for e in entries:
            name = e.name
            if name.startswith("."):
                continue
            try:
                if e.is_dir():
                    stack.append((e.path, f"{pre}{name}/"))
                    continue
                if name.endswith(("-wal", "-shm", "-journal")) or not e.is_file():
                    continue
                st = e.stat()
            except OSError:
                continue
            out.append((f"{pre}{name}", st.st_size, st.st_mtime_ns))
    out.sort()
    return out


def folder_files(corpus: Path, rel: str) -> list[tuple[str, int, int]]:
    """_walk_folder, cached FOLDER_CACHE_S per (corpus, folder): the list is shared, so callers never mutate it. A
    404 for a missing folder is raised on every call (the walk is not cached for it)."""
    key = (corpus, (rel or "").strip("/"))
    now = time.monotonic()
    with _folder_lock:
        hit = _folder_cache.get(key)
        if hit is not None and now - hit["ts"] < FOLDER_CACHE_S:
            return hit["files"]
    files = _walk_folder(corpus, rel)
    with _folder_lock:
        _folder_cache[key] = {"ts": time.monotonic(), "files": files}
    return files


def glob_matches(rel_file: str, pattern: str | None) -> bool:
    """`pattern` against the file's corpus-relative path and its basename, so a claim may name a file type anywhere
    (`*.jsonl`) or a path from the corpus root (`boards/*.jsonl`); '' or '*' matches everything."""
    if not pattern or pattern == "*":
        return True
    return fnmatch.fnmatch(rel_file, pattern) or fnmatch.fnmatch(rel_file.rsplit("/", 1)[-1], pattern)


def records_text(c: str, slug: str) -> str:
    """What the records of the files the view claims hold (fields.describe), under a line saying so; "" for no view or
    files that cannot be described. Blocking, so never on the server's loop."""
    from . import fields  # noqa: PLC0415

    view = read_built(c, slug)
    if view is None:
        return ""
    try:
        text = fields.describe(config.corpus_dir(c), [f[0] for f in claimed_files(c, view)])
    except Exception as e:  # noqa: BLE001 — the view's other lines stand without it
        log.warning("%s: the records of view %s were not described: %s", c, slug, e)
        text = ""
    return f"The records the view reads:\n{text}" if text else ""


def claims_path(view: dict[str, Any], rel: str) -> bool:
    return any(glob_matches(rel, g) for g in view.get("claims") or [])


_GLOB_CHARS = re.compile(r"[*?\[]")


def claimed_files(c: str, view: dict[str, Any]) -> list[tuple[str, int, int]]:
    """(path, size, mtime_ns) of every corpus file the view claims, in path order. Claims that name files outright
    are stat'ed; a glob walks the corpus (folder_files, cached)."""
    corpus = config.corpus_dir(c)
    claims = view.get("claims") or []
    if claims and not any(_GLOB_CHARS.search(g) for g in claims):
        out = []
        for g in sorted(set(claims)):
            try:
                p = config.safe_corpus_path(corpus, g)
                st = p.stat()
            except (ValueError, OSError):
                continue
            if p.is_file():
                out.append((g, st.st_size, st.st_mtime_ns))
        return out
    return [f for f in folder_files(corpus, "") if claims_path(view, f[0])]


def unmatched_claims(c: str, claims: Any, near: int = 3) -> dict[str, list[str]]:
    """Each claim that matches no file of the corpus, mapped to up to `near` real paths near it (_paths_near); {} when
    every
    claim matches. propose_view refuses a proposal with an unmatched claim, since its view could open nothing."""
    corpus = config.corpus_dir(c)
    claims_l = list(dict.fromkeys(_str_list(claims)))
    literal = not any(_GLOB_CHARS.search(g) for g in claims_l)
    files: list[str] | None = None

    def walk() -> list[str]:
        nonlocal files
        if files is None:
            files = [f for f, _, _ in folder_files(corpus, "")]
        return files

    out: dict[str, list[str]] = {}
    for g in claims_l:
        if literal:
            try:
                hit = config.safe_corpus_path(corpus, g).is_file()
            except (ValueError, OSError):
                hit = False
        else:
            hit = any(glob_matches(f, g) for f in walk())
        if not hit:
            out[g] = _paths_near(walk(), g, near)
    return out


def _paths_near(files: list[str], claim: str, n: int) -> list[str]:
    """Up to n corpus files near a claim that matches none, for the model to correct it from: same-named files in other
    folders, then files under the deepest existing folder of the claim, one of each file type first."""
    tail = claim.rsplit("/", 1)[-1]
    out = list(itertools.islice((f for f in files if fnmatch.fnmatch(f.rsplit("/", 1)[-1], tail)), n))
    head = _GLOB_CHARS.split(claim, 1)[0]
    folder = head.rsplit("/", 1)[0] if "/" in head else ""
    while True:
        under = [f for f in files if f.startswith(folder + "/")] if folder else files
        if under or not folder:
            break
        folder = folder.rsplit("/", 1)[0] if "/" in folder else ""
    first_of_type: dict[str, str] = {}
    for f in under:
        first_of_type.setdefault(os.path.splitext(f)[1], f)
    for f in itertools.chain(first_of_type.values(), under):
        if len(out) >= n:
            break
        if f not in out:
            out.append(f)
    return out


def media_file(c: str, slug: str, rel: str) -> tuple[Path, str]:
    """(the absolute path, its media type) of a file the view's page loads by URL: a clean corpus-relative path, claimed
    by the
    view, of a MEDIA_TYPES type, and a regular file inside the corpus. Raises HTTPException 404, 409, 400, 403 or
    415."""
    view = read_view(c, slug)
    if view is None:
        raise HTTPException(404, f"no such view: {slug}")
    if not view["ok"]:
        raise HTTPException(409, f"the view {slug!r} has no reader.py, view.html or claims")
    rel = str(rel or "")
    parts = rel.split("/")
    if not rel or "\\" in rel or "\0" in rel or any(not x or x.startswith(".") for x in parts):
        raise HTTPException(400, f"not a corpus-relative path: {rel!r}")
    if not claims_path(view, rel):
        raise HTTPException(403, f"the view {slug!r} does not claim {rel} (view.json claims: {', '.join(view['claims'])})")
    media_type = MEDIA_TYPES.get(Path(rel).suffix.lower())
    if media_type is None:
        raise HTTPException(415, f"{rel} is not an image, audio or video file")
    try:
        p = config.safe_corpus_path(config.corpus_dir(c), rel)
    except ValueError:
        raise HTTPException(404, f"no such file: {rel}") from None
    if not p.is_file():
        raise HTTPException(404, f"no such file: {rel}")
    return p, media_type


def corpus_media_file(c: str, rel: str) -> tuple[Path, str]:
    """(the absolute path, its media type) of a corpus media file a card shows: media_file's path and type checks
    without a
    view's claim. Raises HTTPException 400, 415 or 404."""
    rel = str(rel or "")
    parts = rel.split("/")
    if not rel or "\\" in rel or "\0" in rel or any(not x or x.startswith(".") for x in parts):
        raise HTTPException(400, f"not a corpus-relative path: {rel!r}")
    media_type = MEDIA_TYPES.get(Path(rel).suffix.lower())
    if media_type is None:
        raise HTTPException(415, f"{rel} is not an image, audio or video file")
    try:
        p = config.safe_corpus_path(config.corpus_dir(c), rel)
    except ValueError:
        raise HTTPException(404, f"no such file: {rel}") from None
    if not p.is_file():
        raise HTTPException(404, f"no such file: {rel}")
    return p, media_type


def fingerprint(files: list[tuple[str, int, int]], reader_src: str = "") -> str:
    """sha1 over the (path, size, mtime) list plus reader.py's source."""
    h = hashlib.sha1()
    h.update(json.dumps(files, separators=(",", ":")).encode("utf-8"))
    h.update(b"\0")
    h.update(reader_src.encode("utf-8"))
    return h.hexdigest()[:20]


_PLACEHOLDER = re.compile(r"<([^<>]+)>")
_NUMERIC_NAMES = {"n", "m", "k", "i", "j", "line", "page", "p", "row", "rev", "seq"}


def form_regex(form: str) -> re.Pattern[str]:
    """A form such as `L<n>` or `<Sheet>!<A1>` as a regex over a fragment: a placeholder named like a number (`<n>`)
    matches digits, any other one a run of characters, the rest literally."""
    out, pos = [], 0
    for m in _PLACEHOLDER.finditer(form):
        out.append(re.escape(form[pos:m.start()]))
        out.append(r"\d+" if m.group(1).strip().lower() in _NUMERIC_NAMES else r".+?")
        pos = m.end()
    out.append(re.escape(form[pos:]))
    return re.compile("^" + "".join(out) + "$")


def accepts(view: dict[str, Any], fragment: str) -> bool:
    return any(form_regex(f["form"]).match(fragment) for f in view.get("accepts") or [])


def views_for(c: str, path: str, fragment: str | None = None) -> list[dict[str, Any]]:
    """The working views that claim the file (and accept the fragment, when one is given): the view built last first,
    and a view written for this corpus before a file-type viewer."""
    try:
        listed = list_views(c)
    except (ValueError, OSError):
        return []
    hit = [v for v in listed if v["ok"] and claims_path(v, path) and (fragment is None or accepts(v, fragment))]
    hit.sort(key=lambda v: v["built"], reverse=True)
    hit.sort(key=lambda v: v["origin"] == "builtin")  # a view written for this corpus before a file-type viewer
    return hit


# ----------------------------------------------------------------------------------------------------------
# reader calls on the views kernel
# ----------------------------------------------------------------------------------------------------------

_ready: set[tuple[str, str, str]] = set()  # (workspace, slug, fingerprint) whose index a call has built or loaded
_mirrored: set[tuple[str, str, str]] = set()  # (workspace, slug, fingerprint) the scratch mirror was refreshed for
_memo: OrderedDict[tuple[str, str, str, str], dict[str, Any] | None] = OrderedDict()  # (c, slug, fp, locator) -> answer
_memo_lock = threading.Lock()


def _forget(c: str, slug: str) -> None:
    with _memo_lock:
        for k in [k for k in _memo if k[0] == c and k[1] == slug]:
            del _memo[k]
    for k in [k for k in _ready if k[0] == c and k[1] == slug]:
        _ready.discard(k)


def _host_src() -> str:
    return HOST_PY.read_text("utf-8")


_SNIPPET = """import sys as _s
if getattr(_s.modules.get('_thimble_views'), 'VERSION', None) != {version!r}:
    import types as _t
    _m = _t.ModuleType('_thimble_views')
    exec({src!r}, _m.__dict__)
    _m.VERSION = {version!r}
    _s.modules['_thimble_views'] = _m
_s.modules['_thimble_views'].call({req!r})
"""


def snippet(req: dict[str, Any]) -> str:
    """The code one reader call runs on the kernel: view_host installed when it is missing or changed, then call()."""
    src = _host_src()
    version = hashlib.sha1(src.encode("utf-8")).hexdigest()[:12]
    return _SNIPPET.format(version=version, src=src, req=json.dumps(req, ensure_ascii=False))


async def _kernel_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    """(outputs, status) of the code on the workspace's views kernel. Tests replace it (views._runner)."""
    from . import notebook  # lazy: the notebook module loads the kernel machinery

    outputs, _, status = await notebook.execute_on(c, KERNEL, code, timeout_s=timeout)
    return outputs, status


_runner = _kernel_run


def _answer_from(outputs: list[dict]) -> dict[str, Any] | None:
    """The host's answer: the last stdout line after the sentinel."""
    from .view_host import SENTINEL

    text = "".join(b.get("text/plain", "") for b in outputs if b.get("_stream") == "stdout")
    for line in reversed(text.split("\n")):  # not splitlines, which also breaks at the sentinel's \x1e
        if line.startswith(SENTINEL):
            try:
                return json.loads(line[len(SENTINEL):])
            except ValueError:
                return None
    return None


def _kernel_error(outputs: list[dict]) -> str:
    for b in outputs:
        err = b.get("application/vnd.thimble.error+json")
        if isinstance(err, dict):
            return f"{err.get('ename', 'Error')}: {err.get('evalue', '')}".strip()
    stderr = "".join(b.get("text/plain", "") for b in outputs if b.get("_stream") == "stderr").strip()
    return stderr[-ERROR_MAX:] or "the kernel printed no answer"


def _prepare(c: str, slug: str, version: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """(the view, the request without op and arg): the claimed files, their fingerprint, the index cache path and where
    the bytes build_index read are kept; with `version`, the view at that version (read_version). Blocking (the claimed
    files are stat'ed or the corpus walked); ReaderError for a view that cannot run."""
    view, req, _ = _prepared(c, slug, version)
    return view, req


def _prepared(c: str, slug: str, version: str | None = None) -> tuple[dict[str, Any], dict[str, Any],
                                                                       list[tuple[str, int, int]]]:
    """_prepare's view and request, and the claimed files they were made from."""
    view = read_version(c, slug, version) if version else read_view(c, slug)
    if view is None:
        raise ReaderError(f"no view {slug!r}" + (f" at version {version}; reload it" if version else ""))
    if not view["ok"]:
        raise ReaderError(f"the view {slug!r} has no reader.py, view.html or claims")
    reader_path = Path(view["dir"]) / READER_PY
    files = claimed_files(c, view)
    src = reader_path.read_text("utf-8")
    fp = fingerprint(files, src)
    if (c, slug, fp) not in _mirrored:
        from . import notebook  # noqa: PLC0415 — the kernel machinery loads lazily

        # the kernel reads the corpus through its scratch mirror, which must hold a file added since it was made
        notebook.scratch_dir(c, config.corpus_dir(c), fresh=True)
        _mirrored.add((c, slug, fp))
    cache = cache_dir(c, view)
    if view["origin"] == "builtin":
        # the kernel's sandbox holds the workspace but not thimble's own folder, so it reads a copy
        reader_path = cache / READER_PY
        try:
            unlinked(config.workspace_dir(c), reader_path)
        except ValueError as e:
            raise ReaderError(f"the reader's copy cannot be written: {e}") from None
        if reader_path.is_symlink() or not reader_path.is_file() or reader_path.read_text("utf-8") != src:
            reader_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(reader_path, src)
    index = index_dir(c, slug)
    req = {"slug": slug, "reader": str(reader_path.resolve()), "fp": fp, "paths": [f[0] for f in files],
           "cache": str((index / f"{fp}.index.pickle").resolve()), "reads": str((index / f"{fp}.reads.json").resolve()),
           "thimble": str(KERNEL_THIMBLE)}
    return view, req, files


async def _call(c: str, req: dict[str, Any], op: str, arg: Any = None) -> Any:
    """One reader operation; ReaderError when it raised, timed out or the kernel did not answer."""
    _bind_loop()
    key = (c, req["slug"], req["fp"])
    timeout = CALL_TIMEOUT_S if key in _ready else BUILD_TIMEOUT_S
    try:
        outputs, status = await _runner(c, snippet({**req, "op": op, "arg": arg}), timeout)
    except Exception as e:  # noqa: BLE001 — the kernel did not start
        raise ReaderError(f"the views kernel did not start: {type(e).__name__}: {e}") from e
    ans = _answer_from(outputs)
    if ans is None:
        raise ReaderError(_kernel_error(outputs))
    if not ans.get("ok"):
        raise ReaderError(str(ans.get("error") or "the reader failed"), str(ans.get("traceback") or ""))
    if op != "applies":  # applies builds no index, so each call gets the time a build does
        _ready.add(key)
    return ans.get("result")


async def reader_call(c: str, slug: str, op: str, arg: Any = None, *, labels: dict[str, Any] | None = None,
                      version: str | None = None) -> Any:
    """reader.<op>(index, arg) for the view, op being index, records or resolve (resolve goes through resolve_locator,
    which cleans and memoises the answer). A records call runs with `labels` as the labels context thimble.marked and
    thimble.kept read, by default the workspace's (labels_context); labels apply when records are served, so they are no
    part of the index's fingerprint. `version` is the version a page was loaded at (read_version)."""
    _, req = await asyncio.to_thread(_prepare, c, slug, version)
    if op == "records":
        ctx = labels if labels is not None else await asyncio.to_thread(labels_context, c)
        req = {**req, "labels": _wire(ctx)}
    return await _call(c, req, op, arg)


def clean_problems(raw: Any) -> dict[str, Any]:
    """reader.problems(index) as {count, examples: [{ref, why}]}, the first PROBLEMS_SHOWN examples. A reader returns
    them all as a list, or, where they may be many, {count, examples} with the first of them."""
    if isinstance(raw, dict):
        items = raw.get("examples") if isinstance(raw.get("examples"), list) else []
        count = raw.get("count")
        count = count if isinstance(count, int) and not isinstance(count, bool) and count >= len(items) else len(items)
    else:
        items = raw if isinstance(raw, list) else []
        count = len(items)
    examples = []
    for x in items[:PROBLEMS_SHOWN]:
        x = x if isinstance(x, dict) else {"why": x}
        examples.append({"ref": str(x.get("ref") or "")[:500], "why": " ".join(str(x.get("why") or "").split())[:500]})
    return {"count": count, "examples": examples}


async def reader_problems(c: str, slug: str, version: str | None = None) -> dict[str, Any]:
    """The lines of the claimed files the view's reader could not read (reader.problems), which thimble shows beside
    the view's page."""
    return clean_problems(await reader_call(c, slug, "problems", version=version))


def _hidden(raw: Any) -> dict[str, str]:
    """{path: why} from a reader's hidden(index), [{path, why}]; a path given twice keeps its first why."""
    out: dict[str, str] = {}
    for x in raw if isinstance(raw, list) else []:
        x = x if isinstance(x, dict) else {"path": x}
        path = str(x.get("path") or "").strip().removeprefix("./")
        if path and path not in out:
            out[path] = " ".join(str(x.get("why") or "").split())[:WHY_CHARS]
    return out


def not_shown(files: list[tuple[str, int, int]], reads: dict[str, int], hidden: dict[str, str]) -> list[dict[str, Any]]:
    """The claimed files the view does not show whole, in path order, each {path, size, read, why}: those build_index
    did not read to the end, with why hidden() gives ('' when it gives none), and those hidden() lists though read.
    An image, audio or video file counts as read, since the page shows it whole through thimble.mediaUrl."""
    out = []
    for path, size, _ in files:
        n = int(reads.get(path) or 0)
        whole = n >= size or Path(path).suffix.lower() in MEDIA_TYPES
        if not whole or path in hidden:
            out.append({"path": path, "size": size, "read": min(n, size), "why": hidden.get(path, "")})
    return out


def _alike(a: str, b: str) -> bool:
    """Whether two folder names read as two of one kind, such as two runs: the same but for their digits, or sharing a
    start or an end of three characters or more."""
    if re.sub(r"\d+", "#", a) == re.sub(r"\d+", "#", b):
        return True
    return len(os.path.commonprefix([a, b])) >= 3 or len(os.path.commonprefix([a[::-1], b[::-1]])) >= 3


def sibling_files(claimed: list[str], every: list[str]) -> list[str]:
    """The files the claims leave out of each folder beside a claimed file's folder that holds the same files, such as
    another run's beside the one run a view claims. Such a folder has a name of the claimed one's kind (_alike) and
    holds at least half of the paths the claimed files have below the claimed folder (of SIBLING_SAMPLE of them). Of its
    files, those returned have a path below it that a claimed file has below the claimed folder, or are in the same
    subfolder and of the same type as files the claimed folder holds only claimed ones of."""
    mine = set(claimed)
    under: dict[tuple[str, str], set[str]] = {}
    for p in mine:
        parts = p.split("/")
        for i in range(len(parts) - 1):
            under.setdefault(("/".join(parts[:i]), parts[i]), set()).add("/".join(parts[i + 1:]))
    if not under:
        return []
    parents = {q for q, _ in under}
    # parent -> folder -> kind -> (rests of every file, rests of the unclaimed ones)
    tree: dict[str, dict[str, dict[tuple[str, str], tuple[list[str], list[str]]]]] = {}
    for p in every:
        parts = p.split("/")
        for i in range(len(parts) - 1):
            q = "/".join(parts[:i])
            if q in parents:
                rest = "/".join(parts[i + 1:])
                kind = (os.path.dirname(rest), os.path.splitext(rest)[1])
                both = tree.setdefault(q, {}).setdefault(parts[i], {}).setdefault(kind, ([], []))
                both[0].append(rest)
                if p not in mine:
                    both[1].append(rest)
    have = set(every)
    out: set[str] = set()
    for (q, r), rests in under.items():
        kinds = {(os.path.dirname(x), os.path.splitext(x)[1]) for x in rests}
        own = tree.get(q, {}).get(r, {})
        whole = {k for k in kinds if not own.get(k, ([], []))[1]}  # kinds the claimed folder holds only claimed files of
        sample = sorted(rests)[:SIBLING_SAMPLE]
        for s, by_kind in (tree.get(q) or {}).items():
            if s == r or not kinds & set(by_kind):
                continue
            base = f"{q}/{s}" if q else s
            if not _alike(r, s) or sum(f"{base}/{x}" in have for x in sample) * 2 < len(sample):
                continue
            out |= {f"{base}/{x}" for k in kinds for x in by_kind.get(k, ([], []))[1] if x in rests or k in whole}
    return sorted(out)


def missing_files(claims: list[str], claimed: list[str]) -> list[dict[str, str]]:
    """What the claims expect and the corpus lacks, each {path, why}: a claim that matches no file, and, for a claim of
    files in each of several folders (`runs/*/manifest.json`), what it names in a folder that holds other claimed files
    and none it matches, as `runs/r3/manifest.json`. The folder is the claim's path up to its last wildcard folder."""
    out: list[dict[str, str]] = []
    for g in claims:
        hit = [p for p in claimed if glob_matches(p, g)]
        if not hit:
            out.append({"path": g, "why": "no file matches it"})
            continue
        parts = g.split("/")
        wild = [i for i, x in enumerate(parts[:-1]) if _GLOB_CHARS.search(x)]
        if not wild:
            continue
        depth = wild[-1] + 1
        unit, rest = "/".join(parts[:depth]), "/".join(parts[depth:])
        def folder(p: str) -> str | None:
            q = p.split("/")
            return "/".join(q[:depth]) if len(q) > depth and fnmatch.fnmatch("/".join(q[:depth]), unit) else None
        have = {f for p in hit if (f := folder(p))}
        if len(have) < 2:
            continue
        for f in sorted({f for p in claimed if (f := folder(p))} - have):
            out.append({"path": f"{f}/{rest}", "why": "the other folders have it"})
    return out


async def shown(c: str, slug: str, version: str | None = None) -> dict[str, Any]:
    """What thimble draws above the view: {files, not_shown: {count, unexplained, unclaimed, files}, missing, derived,
    errors}. `files` is the count of claimed files and not_shown the ones the view does not show whole (not_shown),
    then the files of folders like the claimed ones that the claims leave out (sibling_files, `claimed` false, counted
    in `unclaimed`), the first FILES_LISTED of them, `unexplained` counting those hidden() gives no why for; missing is
    what the claims expect and the corpus lacks (missing_files); unplaced the records the reader's unplaced(index) says
    it could not place, as clean_problems gives them; derived is view.json's list, then the fields the reader's
    derived(index) adds; errors say what failed of hidden(), derived() and unplaced()."""
    view, req, files = await asyncio.to_thread(_prepared, c, slug, version)
    every = await asyncio.to_thread(folder_files, config.corpus_dir(c), "")
    ans = await _call(c, req, "shown")
    ans = ans if isinstance(ans, dict) else {}
    reads = ans.get("reads") if isinstance(ans.get("reads"), dict) else {}
    errors = []
    parts = {}
    for name in ("hidden", "derived", "unplaced"):
        part = ans.get(name) if isinstance(ans.get(name), dict) else {}
        if part.get("error"):
            errors.append(f"{name}() failed: {part['error']}")
        parts[name] = part.get("result")
    hidden = _hidden(parts["hidden"])
    rows = not_shown(files, reads, hidden)
    sizes = {f[0]: f[1] for f in every}
    rows += [{"path": p, "size": sizes.get(p, 0), "read": 0, "why": hidden.get(p, ""), "claimed": False}
             for p in sibling_files([f[0] for f in files], list(sizes))]
    return {"files": len(files),
            "not_shown": {"count": len(rows), "unexplained": sum(1 for r in rows if not r["why"]),
                          "unclaimed": sum(1 for r in rows if r.get("claimed") is False), "files": rows[:FILES_LISTED]},
            "missing": missing_files(view["claims"], [f[0] for f in files]),
            "unplaced": clean_problems(parts["unplaced"]),
            "derived": _derived([*view["derived"], *(parts["derived"] if isinstance(parts["derived"], list) else [])]),
            "errors": errors}


# ----------------------------------------------------------------------------------------------------------
# labels in views: what is on and the filter, and the marks of records and units
# ----------------------------------------------------------------------------------------------------------


def _label_colour(n: Any) -> str:
    from .kernel_thimble import LABEL_COLOURS  # noqa: PLC0415

    return LABEL_COLOURS[n] if isinstance(n, int) and 0 <= n < len(LABEL_COLOURS) else LABEL_COLOURS[1]


def labels_context(c: str, only: list[str] | None = None) -> dict[str, Any]:
    """The labels a view's reader sees: {labels: [{id, name, colour, values: [{name, colour, highlight}], jsonl}],
    filter: {id, label, value, colour} | None}. The labels are those over records the analyst turned on in Files, and
    the Files filter's label, which counts as on while it filters; with `only`, the labels of those ids in that order,
    and no filter. Colours are the palette's hex values."""
    from . import concepts  # noqa: PLC0415

    try:
        ws = config.workspace_dir(c)
        ks = concepts.list_concepts(ws)
        f = None if only is not None else concepts.read_filters(ws).get("files")
    except (HTTPException, OSError, ValueError):
        return dict(NO_LABELS)
    if only is not None:
        by_id = {k["id"]: k for k in ks}
        ks = [by_id[i] for i in dict.fromkeys(only) if i in by_id]
    out: list[dict[str, Any]] = []
    for k in ks:
        if k["unit"] not in concepts.FILE_UNITS or k.get("marks") == "file":
            continue
        if only is None and not (k["shown"] or (f and f.get("concept") == k["id"])):
            continue
        classes = k.get("classes") or []
        lit = [cl for cl in classes if cl.get("highlight")] or classes
        out.append({"id": k["id"], "name": k["name"], "colour": _label_colour(lit[0].get("color") if lit else 1),
                    "values": [{"name": cl["name"], "colour": _label_colour(cl.get("color")), "highlight": bool(cl.get("highlight"))}
                               for cl in classes],
                    "jsonl": str(concepts.labels_file(ws, k["id"]))})
    filt = None
    k = next((x for x in out if f and x["id"] == f.get("concept")), None)
    if k is not None:
        v = next((x for x in k["values"] if x["name"] == f.get("value")), None)
        filt = {"id": k["id"], "label": k["name"], "value": str(f.get("value")), "colour": v["colour"] if v else k["colour"]}
    return {"labels": out, "filter": filt}


def _wire(ctx: dict[str, Any]) -> dict[str, Any]:
    """The labels context as the kernel gets it: without what this process looked up for it (kernel_thimble keeps a
    label's members on it as `_members`)."""
    if not ctx.get("labels"):
        return ctx
    return {**ctx, "labels": [{k: v for k, v in lab.items() if not k.startswith("_")} for lab in ctx["labels"]]}


def probe_context(filtered: bool = False) -> dict[str, Any]:
    """The test label's context (kernel_thimble's probe): it marks about one record in seven, and with `filtered` the
    filter keeps just those."""
    return {"probe": PROBE_EVERY, "filter": bool(filtered)}


def labels_state(ctx: dict[str, Any] | None) -> dict[str, Any]:
    """{labels, filter} of a context as the page's thimble.onLabels hands them (kernel_thimble.view_labels)."""
    from . import kernel_thimble  # noqa: PLC0415

    return kernel_thimble._view_labels(ctx or NO_LABELS)


def _record_mark(ctx: dict[str, Any], ref: str) -> dict[str, Any] | None:
    """A record's mark for the bridge, {bar, names, spans, keep?}: the first label's colour as its bar, and with a filter
    whether it is kept; None for a record no label marks and no filter keeps."""
    from . import kernel_thimble  # noqa: PLC0415

    marks = kernel_thimble._marked(ctx, ref)
    out: dict[str, Any] = {}
    if marks:
        out = {"bar": marks[0]["colour"], "names": list(dict.fromkeys(m["label"] for m in marks)), "spans": []}
    if ctx.get("filter"):
        keep = kernel_thimble._kept(ctx, ref)
        if not keep and not out:
            return None
        out["keep"] = keep
    return out or None


def _unit_mark(ctx: dict[str, Any], rs: list[str]) -> dict[str, Any] | None:
    """A unit's mark from the records it stands for: marked by each label that marks any of them, its bar the colour most
    of its marked records take, and with a filter kept as kernel_thimble.kept_unit keeps it."""
    from . import kernel_thimble  # noqa: PLC0415

    names: dict[str, None] = {}
    colours: dict[str, int] = {}
    for r in rs:
        for m in kernel_thimble._marked(ctx, r):
            names.setdefault(m["label"], None)
            colours[m["colour"]] = colours.get(m["colour"], 0) + 1
    out: dict[str, Any] = {}
    if names:
        out = {"bar": max(colours, key=lambda k: colours[k]), "names": list(names), "spans": []}
    if ctx.get("filter"):
        keep = kernel_thimble._kept_unit(ctx, rs)
        if not keep and not out:
            return None
        out["keep"] = keep
    return out or None


async def marks_for(c: str, slug: str, ref_list: list[str], ctx: dict[str, Any] | None = None,
                    version: str | None = None) -> dict[str, dict[str, Any]]:
    """{ref: mark} for the bridge: the marks of record refs (`<path>#L<n>`) and of the view's unit refs
    (`view:<slug>/<key>`, resolved in one kernel round trip by the view at `version` and marked from their first
    REFS_MAX records) under the labels context `ctx` (default the workspace's). A ref no label marks and no filter keeps
    is left out."""
    ctx = ctx if ctx is not None else await asyncio.to_thread(labels_context, c)
    if not ctx.get("probe") and not ctx.get("labels"):
        return {}
    records = [r for r in ref_list if _RECORD_REF.match(r)]
    prefix = f"view:{slug}/"
    units = [r for r in ref_list if r.startswith(prefix) and len(r) > len(prefix)]
    out: dict[str, dict[str, Any]] = {}
    for r in records:
        if (m := _record_mark(ctx, r)) is not None:
            out[r] = m
    if units:
        answers = await resolve_many(c, slug, [{"key": r[len(prefix):]} for r in units], version)
        for r, res in zip(units, answers):
            if res is not None and (m := _unit_mark(ctx, res["refs"][:REFS_MAX])) is not None:
                out[r] = m
    return out


def _label(v: Any) -> str:
    s = " ".join(str(v or "").split())
    return s if len(s) <= LABEL_MAX else s[: LABEL_MAX - 1] + "…"


def _file_ref_ok(r: str) -> bool:
    try:
        return "path" in refs.parse_ref(r)
    except ValueError:
        return False


def clean_resolved(raw: Any) -> dict[str, Any] | None:
    """A reader's resolve() answer as thimble keeps it: {excerpt, label, refs, key, target}, the excerpt cut to
    EXCERPT_MAX, the label to LABEL_MAX, the refs to parseable file refs; None for None. ReaderError for another type."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ReaderError(f"resolve() returned a {type(raw).__name__}; it returns a dict or None")
    rs = raw.get("refs")
    rs = [rs] if isinstance(rs, str) else rs if isinstance(rs, list) else []
    return {
        "excerpt": str(raw.get("excerpt") or "")[:EXCERPT_MAX],
        "label": _label(raw.get("label")),
        "refs": [str(r) for r in rs if _file_ref_ok(str(r))][:REFS_MAX],
        "key": None if raw.get("key") in (None, "") else str(raw["key"]),
        "target": raw.get("target"),
    }


def _locator_key(locator: dict[str, Any]) -> str:
    return json.dumps(locator, sort_keys=True, ensure_ascii=False)


def _memo_get(k: tuple[str, str, str, str]) -> tuple[bool, dict[str, Any] | None]:
    with _memo_lock:
        if k in _memo:
            _memo.move_to_end(k)
            return True, _memo[k]
    return False, None


def _memo_put(k: tuple[str, str, str, str], v: dict[str, Any] | None) -> None:
    with _memo_lock:
        _memo[k] = v
        _memo.move_to_end(k)
        while len(_memo) > MEMO_MAX:
            _memo.popitem(last=False)


async def resolve_locator(c: str, slug: str, locator: dict[str, Any], version: str | None = None) -> dict[str, Any] | None:
    """reader.resolve for {path, fragment} (a file ref) or {key} (a view ref), by the view at `version` when given,
    cleaned (clean_resolved) and memoised per fingerprint. A built view's answer for a key is also kept in
    key-refs.json; a draft's, which only its checks ask, is not, since nothing may cite a draft."""
    view, req = await asyncio.to_thread(_prepare, c, slug, version)
    mk = (c, slug, req["fp"], _locator_key(locator))
    hit, value = _memo_get(mk)
    if hit:
        return value
    out = clean_resolved(await _call(c, req, "resolve", locator))
    _memo_put(mk, out)
    if out is not None and "key" in locator and not view["draft"]:
        _keep_key_refs(c, slug, str(locator["key"]), out)
    return out


async def resolve_many(c: str, slug: str, locators: list[dict[str, Any]],
                       version: str | None = None) -> list[dict[str, Any] | None]:
    """resolve_locator for many locators, in one kernel round trip for those not memoised; a locator whose resolve
    raised answers None."""
    view, req = await asyncio.to_thread(_prepare, c, slug, version)
    out: list[dict[str, Any] | None] = [None] * len(locators)
    todo: list[int] = []
    for i, loc in enumerate(locators):
        hit, value = _memo_get((c, slug, req["fp"], _locator_key(loc)))
        if hit:
            out[i] = value
        else:
            todo.append(i)
    if not todo:
        return out
    answers = await _call(c, req, "resolve_many", [locators[i] for i in todo])
    for i, ans in zip(todo, answers if isinstance(answers, list) else []):
        if not isinstance(ans, dict) or not ans.get("ok"):
            continue
        try:
            value = clean_resolved(ans.get("result"))
        except ReaderError:
            continue
        _memo_put((c, slug, req["fp"], _locator_key(locators[i])), value)
        out[i] = value
        if value is not None and "key" in locators[i] and not view["draft"]:
            _keep_key_refs(c, slug, str(locators[i]["key"]), value)
    return out


def _thread_loop() -> asyncio.AbstractEventLoop | None:
    with contextlib.suppress(RuntimeError):
        return asyncio.get_running_loop()
    return None


def resolve_sync(c: str, slug: str, locator: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """resolve_locator for synchronous callers (refs.resolve): (status, answer), status `ok`, `unknown` (on the event
    loop
    with no memoised answer: the call starts in the background) or `error`."""
    running = _thread_loop()
    if running is not None:
        try:
            _, req = _prepare(c, slug)
        except ReaderError:
            return "error", None
        hit, value = _memo_get((c, slug, req["fp"], _locator_key(locator)))
        if hit:
            return "ok", value
        task = running.create_task(resolve_locator(c, slug, locator))
        task.add_done_callback(lambda t: t.cancelled() or t.exception())  # never "exception was never retrieved"
        return "unknown", None
    loop = _loop
    if loop is None or loop.is_closed() or not loop.is_running():
        return "unknown", None
    fut = asyncio.run_coroutine_threadsafe(resolve_locator(c, slug, locator), loop)
    try:
        return "ok", fut.result(BUILD_TIMEOUT_S + 5)
    except ReaderError as e:
        log.info("view %s/%s could not resolve %s: %s", c, slug, locator, e.message)
        return "error", None
    except Exception as e:  # noqa: BLE001 — a timeout or a closed loop leaves the file's own resolution standing
        fut.cancel()
        log.info("view %s/%s did not resolve %s: %s", c, slug, locator, e)
        return "error", None


# ----------------------------------------------------------------------------------------------------------
# refs: file refs a view accepts, and view:<slug>/<key>
# ----------------------------------------------------------------------------------------------------------


def _key_refs_path(c: str) -> Path:
    return views_dir(c) / KEY_REFS_FILE


_key_lock = threading.Lock()


def key_refs(c: str) -> dict[str, dict[str, Any]]:
    p = _key_refs_path(c)
    raw = read_json(p, {}) if p.is_file() else {}
    return raw if isinstance(raw, dict) else {}


def _keep_key_refs(c: str, slug: str, key: str, out: dict[str, Any]) -> None:
    """A view key's answer, kept so the ref keeps naming its file lines after the view is gone."""
    view = read_view(c, slug)
    rec = {"refs": out["refs"][:REFS_MAX], "excerpt": out["excerpt"], "label": out["label"],
           "name": view["name"] if view else slug, "ts": _now()}
    with _key_lock:
        allk = key_refs(c)
        ref = f"view:{slug}/{key}"
        if allk.get(ref, {}).get("refs") == rec["refs"] and allk.get(ref, {}).get("excerpt") == rec["excerpt"]:
            return
        allk[ref] = rec
        p = _key_refs_path(c)
        p.parent.mkdir(parents=True, exist_ok=True)
        write_json(p, allk)


def _fragment_of(ref: str) -> str | None:
    return ref.split("#", 1)[1] if "#" in ref else None


def enrich_file_ref(corpus_dir: Path, ref: str, out: dict[str, Any]) -> None:
    """refs.resolve's last step for a file ref with a fragment: the first view that claims the file, accepts the
    fragment and knows the locator gives the excerpt, and the answer names the view. Never raises; a view that fails
    leaves the file's own resolution as it was."""
    fragment = _fragment_of(ref)
    path = out.get("path")
    if not fragment or not path:
        return
    try:
        c = config.workspace_for_corpus_dir(corpus_dir)
        candidates = views_for(c, str(path), fragment)
    except Exception:  # noqa: BLE001
        return
    for v in candidates:
        try:
            status, res = resolve_sync(c, v["slug"], {"path": str(path), "fragment": fragment})
        except Exception:  # noqa: BLE001
            log.exception("view %s: resolving %s failed", v["slug"], ref)
            continue
        if status == "ok" and res is not None:
            out["excerpt"] = res["excerpt"]
            out["view"] = {"slug": v["slug"], "name": v["name"], "label": res["label"], "key": res["key"]}
            meta = out.setdefault("meta", {})
            if isinstance(meta, dict):
                meta["view"] = v["slug"]
            return
        if status == "unknown":
            return  # asked on the loop: the answer lands in the memo for the next reader of this ref


def resolve_view_ref(corpus_dir: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """`view:<slug>` (the view itself: its name and what it is for) or `view:<slug>/<key>` (the unit the key names:
    its excerpt, label and the file refs it stands for). A key whose view is gone answers from key-refs.json with
    meta.deleted. Raises refs.RefError 404 for what no view, proposal or kept answer knows."""
    c = config.workspace_for_corpus_dir(corpus_dir)
    slug, key = p["slug"], p.get("key")
    view = read_built(c, slug)
    if not key:
        if view is not None:
            return {"ref": ref, "kind": "view", "slug": slug, "key": None, "record": None, "label": view["name"],
                    "excerpt": view["description"] or view["name"], "refs": [], "meta": {"slug": slug, "name": view["name"]}}
        prop = read_proposal(c, slug)
        if prop is not None:
            return {"ref": ref, "kind": "view", "slug": slug, "key": None, "record": None, "label": prop["name"],
                    "excerpt": prop.get("why") or prop["name"], "refs": [],
                    "meta": {"slug": slug, "name": prop["name"], "proposal": True, "status": prop.get("status")}}
        raise refs.RefError(f"no view {slug!r}", 404)
    if view is not None and view["ok"]:
        status, res = resolve_sync(c, slug, {"key": key})
        if status == "ok" and res is None:
            raise refs.RefError(f"the view {view['name']!r} has no {key!r}", 404)
        if status == "ok" and res is not None:
            return {"ref": ref, "kind": "view", "slug": slug, "key": key, "record": None, "label": res["label"],
                    "excerpt": res["excerpt"], "refs": res["refs"], "target": res["target"],
                    "meta": {"slug": slug, "name": view["name"], "refs": res["refs"]}}
    kept = key_refs(c).get(ref)
    if kept:
        return {"ref": ref, "kind": "view", "slug": slug, "key": key, "record": None, "label": kept.get("label") or "",
                "excerpt": kept.get("excerpt") or "", "refs": list(kept.get("refs") or []),
                "meta": {"slug": slug, "name": kept.get("name") or slug, "refs": list(kept.get("refs") or []),
                         "deleted": view is None, "stale": True}}
    if view is None:
        raise refs.RefError(f"no view {slug!r}", 404)
    raise refs.RefError(f"the view {view['name']!r} could not resolve {key!r} now", 404)


# ----------------------------------------------------------------------------------------------------------
# the forms the model learns ({{forms}} in prompts/shared.md, and the view tools' results)
# ----------------------------------------------------------------------------------------------------------

FORM_PAD = 44  # the width of the description column in shared.md's table of forms


def view_forms(view: dict[str, Any]) -> list[tuple[str, str]]:
    """(the form as written in a citation, what it means) for every form the view accepts and every unit it gives. A view over one
    named file writes it in the form; a view over a glob or several files writes `<file>#<form>`, and its meaning says
    which files (a file-type viewer's meaning names the type)."""
    out: list[tuple[str, str]] = []
    claims = view.get("claims") or []
    one = claims[0] if len(claims) == 1 and not _GLOB_CHARS.search(claims[0]) else None
    for f in view.get("accepts") or []:
        out.append((f"{one or '<file>'}#{f['form']}", f["means"] or f"a place in {', '.join(claims)}"))
    for f in view.get("units") or []:
        out.append((f"view:{view['slug']}/{f['form']}", f["means"] or f"a unit of {view['name']}"))
    return out


def forms_text(c: str | None) -> str:
    """The rows of shared.md's table of forms that the workspace's views add, one per form ('' for none). A built-in
    viewer's
    forms are listed only where the corpus holds a file it claims."""
    rows: list[str] = []
    try:
        listed = [v for v in list_views(c) if v["ok"]] if c else []
        listed = [v for v in listed if v["origin"] != "builtin" or claimed_files(c, v)]
    except (ValueError, OSError, HTTPException):
        listed = []
    for v in listed:
        for form, means in view_forms(v):
            desc = f"{means} ({v['name']})"
            rows.append(f"    {desc.ljust(FORM_PAD - 1)} {form}")
    return "\n".join(rows) if rows else ""


def forms_sentence(view: dict[str, Any]) -> str:
    """The forms as one sentence for a tool result: "`posts.jsonl#L<n>` cites the post … and `view:…` cites …"."""
    parts = [f"`{form}` cites {means}" for form, means in view_forms(view)]
    if not parts:
        return ""
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


# ----------------------------------------------------------------------------------------------------------
# proposals
# ----------------------------------------------------------------------------------------------------------


def proposals_path(c: str) -> Path:
    return views_dir(c) / PROPOSALS_FILE


# a proposal's `spec`, the fields propose_view requires beside its free-text `why`, in the order a ticket lists them,
# each with the words it is named by
SPEC_FIELDS = (("unit", "Unit"), ("overview", "Overview"), ("zoom", "Zoom"), ("filter", "Filter"), ("details", "Details"))


def clean_spec(raw: Any) -> dict[str, str]:
    """The spec fields `raw` holds, each with its whitespace collapsed; empty ones are left out."""
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, _ in SPEC_FIELDS if (v := " ".join(str(raw.get(k) or "").split()))}


def spec_arrangement(spec: dict[str, str]) -> str:
    """A spec as the proposal's `arrangement`: one `<Field>: <text>` line per field."""
    return "\n".join(f"{label}: {spec[k]}" for k, label in SPEC_FIELDS if spec.get(k))


def spec_lines(prop: dict[str, Any]) -> str:
    """A proposal's layout as a ticket's bullets: one per spec field, or one holding the free-text arrangement of a
    proposal without a spec."""
    spec = clean_spec(prop.get("spec"))
    if spec:
        return "\n".join(f"- {label}: {spec[k]}" for k, label in SPEC_FIELDS if spec.get(k))
    return f"- The unit and the layout: {' '.join(str(prop.get('arrangement') or '').split()) or '-'}"


def _lines(text: Any) -> str:
    """`text` with each line's whitespace collapsed and blank lines dropped."""
    return "\n".join(t for ln in str(text or "").splitlines() if (t := " ".join(ln.split())))


def _normalize_proposal(p: dict[str, Any]) -> dict[str, Any]:
    """A stored row as the routes give it, with legacy fields normalised: a glob reads as its claim, and a `proposed`
    status
    reads as queued."""
    out = {k: v for k, v in p.items() if k not in ("renderer", "data_md", "glob", "view", "path")}
    out["claims"] = _str_list(p.get("claims")) or _str_list(p.get("glob"))
    out.setdefault("arrangement", "")
    if out.get("status") == "held":  # a row stored when a held proposal waited unbuilt
        out.update(status="queued", held=True)
    if out.get("status") not in STATUSES:
        out["status"] = "queued"
    return out


def _settle_status(c: str, p: dict[str, Any], built: set[str]) -> dict[str, Any]:
    """A proposal marked built whose view has no reader or was never stamped built is queued to be built again."""
    if p.get("status") == "built" and p["slug"] not in built:
        p = {**p, "status": "queued"}
    return p


def list_proposals(c: str) -> list[dict[str, Any]]:
    p = proposals_path(c)
    raw = read_json(p, []) if p.is_file() else []
    if not isinstance(raw, list):
        return []
    built = {v["slug"] for v in _own_views(c) if v["ok"]}
    return [_settle_status(c, _normalize_proposal(x), built) for x in raw if isinstance(x, dict) and x.get("slug")]


def _save_proposals(c: str, items: list[dict[str, Any]]) -> None:
    p = proposals_path(c)
    p.parent.mkdir(parents=True, exist_ok=True)
    write_json(p, items)


# proposals.json is read, changed and written again by the tool, the routes and every view ticket's run; the lock keeps
# one writer from dropping another's change when a route runs in a worker thread
_proposals_lock = threading.RLock()


def read_proposal(c: str, slug: str) -> dict[str, Any] | None:
    return next((p for p in list_proposals(c) if p.get("slug") == slug), None)


def update_proposal(c: str, slug: str, **fields: Any) -> dict[str, Any] | None:
    """Set fields on the proposal (a None value removes the field); None when there is no such proposal."""
    with _proposals_lock:
        items = list_proposals(c)
        for p in items:
            if p.get("slug") == slug:
                for k, v in fields.items():
                    if v is None:
                        p.pop(k, None)
                    else:
                        p[k] = v
                _save_proposals(c, items)
                return p
    return None



def _slug_for(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40]


def _unique_slug(c: str, name: str) -> str:
    """A slug from the name that no proposal, view or route holds; a taken one gets a numeric suffix."""
    base = _slug_for(name) or "view"
    taken = set(_view_dirs(c)) | {str(p["slug"]) for p in list_proposals(c)} | RESERVED_SLUGS | set(BUILTIN_VIEWERS)
    slug, n = base, 2
    while slug in taken or not SLUG_RE.match(slug):
        slug = f"{base[:36]}-{n}"
        n += 1
    return slug


def title_case(name: Any) -> str:
    """A view's display name in Title Case, whitespace collapsed, capitals already there kept ("API logs" -> "API
    Logs")."""
    words = " ".join(str(name or "").split()).split(" ")
    return " ".join("-".join(p[:1].upper() + p[1:] for p in w.split("-")) for w in words)


# the views the orientation may propose in a workspace, those the analyst deleted included; a viewer it suggests for a
# file type is not counted, nor a view dropped
VIEW_PROPOSALS_MAX = 4


def _counted(p: dict[str, Any]) -> bool:
    """Whether a proposal counts toward VIEW_PROPOSALS_MAX: the orientation's, neither dropped nor a file-type viewer."""
    return (bool(p.get("orientation") or p.get("held")) and p.get("status") not in ("dropped", "suggested")
            and not offered_type_viewer(p.get("claims")))


def install_viewer(c: str, slug: str, d: Path, claims: Any, *, why: str, proposed_by: str, orientation: bool,
                   extension: str | None = None, libs: Any = None) -> None:
    """The viewer in folder `d` as the workspace's view `slug` claiming `claims`, under a built proposal (an
    `orientation` one counts toward VIEW_PROPOSALS_MAX) that keeps the digest of the files as installed (`installed`)
    and the `extension` they came from. `libs`, when given, are the libraries its page gets in place of view.json's."""
    raw = read_json(d / VIEW_JSON, {})
    v = _normalize_view(slug, raw)
    with _proposals_lock:
        items = [p for p in list_proposals(c) if p.get("slug") != slug]
        prop = {"slug": slug, "name": title_case(raw.get("name") or slug), "why": " ".join(why.split()),
                "claims": _str_list(claims), "arrangement": v["description"],
                "proposed_by": proposed_by, "status": "queued", "orientation": orientation, "ts": _now()}
        if extension:
            prop["extension"] = extension
        items.append(prop)
        _save_proposals(c, items)
    write_view(c, slug, name=raw.get("name") or slug, description=v["description"], claims=_str_list(claims),
               accepts=v["accepts"], units=v["units"], derived=v["derived"], libs=raw.get("libs") if libs is None else libs,
               reader=(d / READER_PY).read_text("utf-8"), html=(d / VIEW_HTML).read_text("utf-8"))
    update_proposal(c, slug, installed=view_digest(views_dir(c) / slug))


def stale_install(c: str, slug: str, src: Path) -> bool:
    """Whether the workspace's view `slug` is thimble's install of the viewer in folder `src`, unchanged since (its
    proposal's `installed` digest), and older than that folder's files."""
    prop = read_proposal(c, slug) or {}
    d = views_dir(c) / slug
    if not prop.get("installed") or not d.is_dir() or view_digest(d) != prop["installed"]:
        return False
    try:
        return any((d / n).read_bytes() != (src / n).read_bytes() for n in (READER_PY, VIEW_HTML))
    except OSError:
        return False


def orphaned(c: str) -> list[str]:
    """The workspace's views that are thimble's install of a viewer or card type it no longer ships (VIEWERS_DIR), with
    no extension behind them, unchanged since (their proposal's `installed` digest)."""
    out = []
    for slug, d in _view_dirs(c).items():
        prop = read_proposal(c, slug) or {}
        if (prop.get("installed") and not prop.get("extension") and not (VIEWERS_DIR / slug / VIEW_JSON).is_file()
                and view_digest(d) == prop["installed"]):
            out.append(slug)
    return out


def withdraw(c: str, slug: str, extension: str | None) -> bool:
    """Take out the view `slug` that `extension` installed (thimble, for None), when nobody changed it since, without
    counting it deleted: the extension stopped running here, or thimble no longer ships it. Its `view:` refs keep
    resolving through key-refs.json. True when it went."""
    prop = read_proposal(c, slug) or {}
    d = _view_dirs(c).get(slug)
    if prop.get("extension") != extension or d is None or view_digest(d) != prop.get("installed"):
        return False
    _stop_review(c, slug, forget=True)
    shutil.rmtree(d, ignore_errors=True)
    shutil.rmtree(_versions_dir(c, slug), ignore_errors=True)
    _forget(c, slug)
    with _proposals_lock:
        _save_proposals(c, [p for p in list_proposals(c) if p.get("slug") != slug])
    _emit(c, slug, "deleted")
    return True


def orientation_views(c: str) -> list[dict[str, Any]]:
    """The views the orientation proposed that count toward VIEW_PROPOSALS_MAX."""
    return [p for p in list_proposals(c) if _counted(p)]


def deleted_proposals(c: str) -> list[dict[str, Any]]:
    """The proposals the analyst deleted (delete_proposal), which the orientation cannot propose again."""
    p = views_dir(c) / DELETED_FILE
    raw = read_json(p, []) if p.is_file() else []
    return [x for x in raw if isinstance(x, dict) and x.get("name")] if isinstance(raw, list) else []


def _keep_deleted(c: str, prop: dict[str, Any]) -> None:
    with _proposals_lock:
        name = str(prop["name"])
        items = deleted_proposals(c)
        same = [x for x in items if str(x["name"]).casefold() == name.casefold()]
        counted = _counted(prop) or any(x.get("counted") for x in same)
        items = [x for x in items if x not in same]
        items.append({"slug": prop.get("slug"), "name": name, "counted": counted, "ts": _now()})
        write_json(views_dir(c) / DELETED_FILE, items)


def propose(c: str, name: str, why: str, claims: Any, arrangement: str, proposed_by: str = "analyst",
            orientation: bool = False, asked: bool = False, suggested: bool = False,
            spec: dict[str, Any] | None = None) -> dict[str, Any]:
    """Store a proposal, announce it and queue it for the dev agent at once (dev.queue_view). A proposal of the same
    name not yet built is replaced under its slug, its build stopped. An `orientation` proposal is stored
    `orientation: true` and, unless `suggested`, `held: true`, queued unannounced until its view passes its checks
    (mark_built); a held proposal proposed again unchanged is left as it is, and changed it is revised (revise), still
    held. A workspace gets at most VIEW_PROPOSALS_MAX views from the orientation, those the analyst deleted included:
    one more under a new name is refused (409), and one under a name it proposed before improves that view in place.
    One the analyst deleted is refused (409).
    `asked` says the analyst asked for it. With `suggested` (a viewer for a file type the File browser proposes) it is
    stored `suggested` and not queued until the analyst accepts it (accept). A `spec` (propose_view's fields) is stored
    with the proposal and written out as its `arrangement`."""
    name = title_case(name)
    if not name:
        raise HTTPException(400, "a proposal needs a name")
    claims_l = _str_list(claims)
    if not claims_l:
        raise HTTPException(400, "a proposal claims at least one file: give `claims` as corpus-relative globs")
    spec = clean_spec(spec)
    hold = orientation and not suggested
    if orientation:
        gone = deleted_proposals(c)
        if any(str(d["name"]).casefold() == name.casefold() for d in gone):
            raise HTTPException(409, _hint("propose_view-deleted", view=name))
        mine = orientation_views(c)
        spent = [*(str(p["name"]) for p in mine), *(str(d["name"]) for d in gone if d.get("counted"))]
        if hold and len(spent) >= VIEW_PROPOSALS_MAX and not any(n.casefold() == name.casefold() for n in spent):
            raise HTTPException(409, _hint("propose_view-cap", view=name, n=VIEW_PROPOSALS_MAX, views=", ".join(spent)))
    arrangement = spec_arrangement(spec) if spec else _lines(arrangement)
    if not arrangement:
        raise HTTPException(400, "a proposal says which records a unit gathers and how the page lays it out (`arrangement`)")
    # a view already built under this name is changed in place, as the analyst still uses it, rather than built again
    # beside it under a new slug
    if (built := built_slug(c, name)) is not None:
        return revise(c, built, "", why=why, claims=claims_l, arrangement=arrangement, proposed_by=proposed_by,
                      asked=asked, spec=spec or None)
    with _proposals_lock:
        items = list_proposals(c)
        old = next((p for p in items if str(p.get("name", "")).casefold() == name.casefold()
                    and (p.get("status") != "built" or p.get("held"))), None)
        why = " ".join(str(why or "").split())
        if old is not None and old.get("held") and hold and old.get("status") not in ("dropped", "suggested"):
            if (old.get("why"), old.get("claims"), old.get("arrangement")) == (why, claims_l, arrangement):
                return old  # the same proposal again: its build goes on, or its view stays built
            # changed, such as after the critique: its build goes on from its draft, or its view is changed
            return revise(c, old["slug"], "", why=why, claims=claims_l, arrangement=arrangement,
                          proposed_by=proposed_by, spec=spec or None)
        if old is not None:
            _stop_review(c, old["slug"], forget=True)
            _stop_build(c, old["slug"], "replaced", force=bool(old.get("held")))
            items = [p for p in list_proposals(c) if p.get("slug") != old["slug"]]
        slug = old["slug"] if old is not None else _unique_slug(c, name)
        prop = {"slug": slug, "name": name, "why": why, "claims": claims_l, "arrangement": arrangement,
                "proposed_by": str(proposed_by or "analyst"), "status": "suggested" if suggested else "queued", "ts": _now()}
        if spec:
            prop["spec"] = spec
        if orientation:
            prop["orientation"] = True
        if hold:
            prop["held"] = True
        if asked:
            prop["asked"] = True
        items.append(prop)
        _save_proposals(c, items)
    _emit(c, slug, prop["status"])
    if not suggested:
        _queue(c, slug)
    return prop


def _stop_review(c: str, slug: str, forget: bool = False) -> None:
    """A change to the view stops its review (view_review); a view replaced or deleted stops it with `forget`, so the
    review leaves nothing on the proposal that takes its slug."""
    from . import view_review  # noqa: PLC0415

    view_review.stop(c, slug, view_review.CHANGED_NOTE, forget=forget)


def _queue(c: str, slug: str) -> None:
    from . import dev  # noqa: PLC0415 — the dev agent's runner imports this module

    dev.queue_view(c, slug)


def _stop_build(c: str, slug: str, why: str, force: bool = False) -> None:
    """Stop the proposal's build, if one runs, and empty its folder: a dismissed or replaced ticket leaves no draft.
    With `force` (a held proposal replaced) a view built under it goes too, since nobody has seen it."""
    from . import dev  # noqa: PLC0415

    dev.stop_view(c, slug, why)
    d = views_dir(c) / slug
    if d.is_dir() and (force or not _view_json(d).get("built")):
        shutil.rmtree(d, ignore_errors=True)
        shutil.rmtree(index_dir(c, slug), ignore_errors=True)
    _forget(c, slug)


# ----------------------------------------------------------------------------------------------------------
# a change to a view (revise): a view ticket on the view's own proposal
# ----------------------------------------------------------------------------------------------------------

REVISIONS_SUBDIR = ".revisions"  # views/.revisions/<slug>/: the built view's files while a change to it is made


def built_slug(c: str, name_or_ref: str) -> str | None:
    """The slug of the workspace's built view named `name_or_ref` (a name, any case, a slug or a `view:<slug>` ref),
    or None."""
    key = " ".join(str(name_or_ref or "").split())
    if key.startswith("view:"):
        key = key[len("view:"):].split("/", 1)[0].split("#", 1)[0]
    mine = [v for v in list_views(c) if v.get("origin") == "workspace"]
    hit = next((v for v in mine if v["slug"] == key), None) or next(
        (v for v in mine if v["name"].casefold() == key.casefold()), None)
    return str(hit["slug"]) if hit else None


def _revision_dir(c: str, slug: str) -> Path:
    return views_dir(c) / REVISIONS_SUBDIR / slug


def _keep_built(c: str, slug: str) -> None:
    """Copy the built view's files (its cache left out) aside before a change to them, unless a copy is there already
    (a second change while the first is made keeps the copy of the built view)."""
    src, dst = views_dir(c) / slug, _revision_dir(c, slug)
    if dst.is_dir() or not src.is_dir():
        return
    dst.mkdir(parents=True, exist_ok=True)
    for p in src.iterdir():
        if p.name == CACHE_SUBDIR or p.is_symlink():
            continue
        if p.is_dir():
            shutil.copytree(p, dst / p.name, symlinks=True)
        else:
            shutil.copy2(p, dst / p.name)


def restore_built(c: str, slug: str) -> bool:
    """Put the view back as it was before the change (_keep_built), its answers memo dropped; False when there was no
    copy. The copy's view.json carries its `built` stamp, so the view opens citations again at once."""
    src, dst = _revision_dir(c, slug), views_dir(c) / slug
    if not src.is_dir():
        return False
    dst.mkdir(parents=True, exist_ok=True)
    for p in dst.iterdir():
        if p.name == CACHE_SUBDIR:
            continue
        shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
    for p in src.iterdir():
        if p.is_symlink():
            continue
        shutil.copytree(p, dst / p.name, symlinks=True) if p.is_dir() else shutil.copy2(p, dst / p.name)
    shutil.rmtree(src, ignore_errors=True)
    _forget(c, slug)
    return True


def drop_built_copy(c: str, slug: str) -> None:
    shutil.rmtree(_revision_dir(c, slug), ignore_errors=True)


def view_digest(d: Path) -> str:
    """A digest of the view's files in `d`: the files at the folder's top level, view.json read without the `built`
    and `version` stamps; subfolders (the cache, Python's bytecode) are left out."""
    h = hashlib.sha256()
    try:
        files = sorted(p for p in d.iterdir() if p.is_file())
    except OSError:
        return ""
    for p in files:
        data = p.read_bytes()
        if p.name == VIEW_JSON:
            with contextlib.suppress(ValueError):
                raw = json.loads(data)
                if isinstance(raw, dict):
                    raw.pop("built", None)
                    raw.pop("version", None)
                data = json.dumps(raw, sort_keys=True).encode()
        h.update(p.name.encode() + b"\0" + hashlib.sha256(data).digest())
    return h.hexdigest()


def unchanged_since_built(c: str, slug: str) -> bool:
    """Whether a change to the built view `slug` has left its files as they were built (the copy _keep_built made);
    False when there is no copy."""
    kept = _revision_dir(c, slug)
    return kept.is_dir() and view_digest(kept) == view_digest(views_dir(c) / slug)


def end_revision(c: str, slug: str, error: str | None = None, *, failed_change: str | None = None) -> None:
    """A change to a built view that failed (`error`) or was dismissed: the view as it was, its proposal built again
    with the error kept, and `view {built}` on the stream. `failed_change`, the request of a change that failed, stays
    on the proposal for retry."""
    restore_built(c, slug)
    update_proposal(c, slug, status="built", change=None, changed=None, revision=None, error=error,
                    failed_change=failed_change)
    _emit(c, slug, "built")


def revise(c: str, slug: str, request: str, *, why: str | None = None, claims: Any = None,
           arrangement: str | None = None, proposed_by: str = "analyst", asked: bool = False,
           spec: dict[str, Any] | None = None) -> dict[str, Any]:
    """A change to the view `slug`, as a view ticket on its proposal (made from the view when it has none): `request` is
    the
    analyst's words, and given fields replace the proposal's. A built view's files are copied aside first
    (restore_built),
    and the proposal is marked `revision` and `changed`. A running build stops, its draft kept. Queued at once. 404
    for
    no such view or proposal."""
    from . import dev  # noqa: PLC0415

    request = str(request or "").strip()
    _stop_review(c, slug)
    with _proposals_lock:
        prop = read_proposal(c, slug)
        view = read_built(c, slug)
        if prop is None and view is None:
            raise HTTPException(404, f"no such view: {slug}")
        if prop is None:
            items = list_proposals(c)
            prop = {"slug": slug, "name": view["name"], "why": view["description"], "claims": view["claims"], "arrangement": "",
                    "proposed_by": str(proposed_by or "analyst"), "status": "built", "ts": _now()}
            _save_proposals(c, [*items, prop])
        revision = view is not None or bool(prop.get("revision"))
        pending = prop.get("status") in PENDING
        if pending:
            # the build stops and its draft stays: the session goes on from it with the change
            dev.stop_view(c, slug, "revised")
        change = "\n\n".join(x for x in (str(prop.get("change") or "") if pending else "", request) if x)
        fields: dict[str, Any] = {"status": "queued", "error": None, "change": change or None, "changed": True,
                                  "revision": revision or None, "asked": True if asked else None,
                                  "failed_change": None, "ts": _now()}
        spec = clean_spec(spec)
        for k, v in (("why", " ".join(str(why or "").split())), ("claims", _str_list(claims)),
                     ("arrangement", spec_arrangement(spec) if spec else _lines(arrangement)), ("spec", spec)):
            if v:
                fields[k] = v
        if revision:
            _keep_built(c, slug)
        prop = update_proposal(c, slug, **fields) or prop
    _emit(c, slug, "queued", chat=prop.get("chat"))
    _queue(c, slug)
    return {**prop, "revised": True}


def message(c: str, slug: str, text: str) -> dict[str, Any]:
    """What the analyst typed in the thread of the view's build: logged there, then applied as a change to the view
    (revise,
    `asked`) in the same session. 400 for an empty message, 404 for no such view or proposal."""
    from . import agents  # noqa: PLC0415

    text = str(text or "").strip()
    if not text:
        raise HTTPException(400, "empty message")
    prop = read_proposal(c, slug)
    if prop is None and read_built(c, slug) is None:
        raise HTTPException(404, f"no such view: {slug}")
    chat = str((prop or {}).get("chat") or "")
    if chat and agents.meta_or_none(c, chat) is not None:
        agents.Recorder(c, chat).record("user", text=text, by=agents.BROWSER)
    return revise(c, slug, text, asked=True)


def retry(c: str, slug: str) -> dict[str, Any]:
    """Queue a failed proposal again (the Retry of its chip); its run resumes the same session when it has one. A built
    view whose last change failed (`failed_change`) is changed again with the same request. 404 for no such proposal,
    409 for one that is built with no failed change, queued or building."""
    prop = read_proposal(c, slug)
    if prop is None:
        raise HTTPException(404, f"no such proposal: {slug}")
    if prop.get("status") == "built" and prop.get("failed_change") is not None:
        return revise(c, slug, str(prop["failed_change"]), asked=True)
    if prop.get("status") != "failed":
        raise HTTPException(409, f"the view {prop['name']!r} is {prop.get('status')}, not failed")
    prop = update_proposal(c, slug, status="queued", error=None) or prop
    _emit(c, slug, "queued", chat=prop.get("chat"))
    _queue(c, slug)
    return prop


def drop(c: str, slug: str, why: str) -> dict[str, Any] | None:
    """Leave an orientation's proposal out once its build failed through its repairs (dev._view_dropped): the row stays
    as `dropped` with the reason, so every chip that names it knows to hide, its draft folder is removed, and
    `view {dropped}` goes on the stream. None when there is no such proposal."""
    prop = update_proposal(c, slug, status="dropped", error=" ".join(str(why or "").split())[:ERROR_MAX] or None)
    if prop is None:
        return None
    d = views_dir(c) / slug
    if d.is_dir() and not _view_json(d).get("built"):
        shutil.rmtree(d, ignore_errors=True)
        shutil.rmtree(index_dir(c, slug), ignore_errors=True)
    _forget(c, slug)
    _emit(c, slug, "dropped", chat=prop.get("chat"))
    return prop


def delete_proposal(c: str, slug: str) -> None:
    """Delete the proposal: its build is stopped, its folder removed, and its view with it when it was built; it is kept
    in DELETED_FILE, so the orientation never proposes it again. A change to a built view that is dismissed while it is
    made stops, and the view is put back as it was."""
    from . import dev  # noqa: PLC0415

    with _proposals_lock:
        items = list_proposals(c)
        hit = next((p for p in items if p.get("slug") == slug), None)
        if hit is None:
            raise HTTPException(404, f"no such proposal: {slug}")
        if hit.get("revision") and hit.get("status") in PENDING:
            # a running build puts the view back itself once its session has stopped (dev.run_view)
            if not dev.stop_view(c, slug, "dismissed"):
                end_revision(c, slug)
            return
        _stop_build(c, slug, "dismissed")
        _save_proposals(c, [p for p in list_proposals(c) if p.get("slug") != slug])
        _keep_deleted(c, hit)
        if hit.get("status") == "suggested":
            for suffix in {s for g in hit.get("claims") or [] if (s := type_suffix(g))}:
                _answer_suffix(c, suffix, "dismissed")
    if slug in _view_dirs(c):
        delete_view(c, slug)
    else:
        _emit(c, slug, "deleted")


# ----------------------------------------------------------------------------------------------------------
# the gate: a view ticket's checks, which the session runs through the check route and the server after each turn
# ----------------------------------------------------------------------------------------------------------


async def gate(c: str, slug: str, locators: list[str] | None = None, *, shot_dir: Path | None = None,
               picture: bool = False) -> dict[str, Any]:
    """Whether the view in the slug's folder may be registered: its files' own problems (source_problems; view.json
    written by thimble alone once it names `built`), then, when there are none, check() with `locators` beside the
    sampled lines. The report check() returns, with the files' problems among its `problems`. With `picture` the page
    as it opens is pictured for the session."""
    d = views_dir(c) / slug
    if not (d / VIEW_JSON).is_file():
        return {"ok": False, "view": None, "problems": [f"{d / VIEW_JSON} does not exist yet"], "checks": [], "page": None}
    raw = _view_json(d)
    text = {n: (d / n).read_text("utf-8", errors="replace") if (d / n).is_file() else "" for n in (READER_PY, VIEW_HTML)}
    problems = source_problems(raw.get("claims"), text[READER_PY], text[VIEW_HTML], raw.get("libs"))
    # a change to a built view starts from files that carry thimble's own stamp, so it is no sign of a session's
    # writing there (a session that removes it is fine too; mark_built stamps the view again)
    if raw.get("built") and (prop := read_proposal(c, slug)) is not None and prop.get("status") != "built" \
            and not prop.get("revision"):
        problems.append("view.json names `built`, which thimble adds when the view passes; remove it")
    if problems:
        return {"ok": False, "view": read_view(c, slug), "problems": problems, "checks": [], "page": None}
    report = await check(c, slug, locators, shot_dir=shot_dir, picture=picture)
    if picture:
        _prune_shots(shot_dir or (d / CACHE_SUBDIR / "shots"))
    _gate_notes[(c, slug)] = [ln for ln in gate_lines(report) if ln.startswith(("unread: ", "files: ", "page: ", "note: "))]
    return report


_gate_notes: dict[tuple[str, str], list[str]] = {}


def gate_notes(c: str, slug: str) -> list[str]:
    """What the view's last checks found, as gate_lines' lines on its files, its page and its notes, which the review
    reads beside its pictures; [] before any check in this process."""
    return _gate_notes.get((c, slug), [])


def _prune_shots(d: Path) -> None:
    """Keep the check pictures of a view's newest SHOTS_KEPT runs, each run's pictures with its page and states file."""
    try:
        files = list(d.glob("check-*"))
        runs = sorted({m.group(1) for p in files if (m := re.match(r"(check-\d+)", p.name))}, reverse=True)
    except OSError:
        return
    for run in runs[SHOTS_KEPT:]:
        for p in files:
            if p.name.startswith(run + "-") or p.name.startswith(run + "."):
                with contextlib.suppress(OSError):
                    p.unlink()


def gate_lines(report: dict[str, Any]) -> list[str]:
    """The report as lines for the session: the index, each problem, the reader's traceback, each check and the page."""
    lines: list[str] = []
    if report.get("index"):
        lines.append(f"index: {report['index']['files']} file(s) in {report['index']['seconds']} s")
    if (unread := report.get("unread") or {}).get("count"):
        first = unread["examples"][0]
        lines.append(f"unread: {unread['count']} line(s) the reader could not parse, such as {first['ref']}: {first['why']}")
    if cov := report.get("coverage"):
        ns = cov["not_shown"]
        beside = ns.get("unclaimed", 0)
        lines.append(f"files: {cov['files'] - (ns['count'] - beside)} of {cov['files']} read to the end, "
                     + (f"{beside} unclaimed beside them, " if beside else "")
                     + f"{ns['count'] - ns['unexplained']} hidden with a why"
                     + (f", {len(cov['missing'])} missing" if cov.get("missing") else "")
                     + (f", {cov['unplaced']['count']} records not placed" if (cov.get("unplaced") or {}).get("count") else "")
                     + "; derived fields: " + (", ".join(d["field"] for d in cov["derived"]) or "none"))
    for p in report.get("problems") or []:
        lines.append(f"problem: {p}")
    if report.get("traceback"):
        lines.append(report["traceback"].strip()[-1500:])
    for r in report.get("checks") or []:
        if r["ok"]:
            note = f" ({r['unchecked']})" if r.get("unchecked") else ""
            lines.append(f"ok  {r['locator']} -> {r.get('label') or '(no label)'}: {' '.join(str(r.get('excerpt') or '').split())[:120]}{note}")
        else:
            lines.append(f"bad {r['locator']}: {r.get('why')}")
    page = report.get("page") or {}
    shots = report.get("shots") or []
    if page.get("unavailable"):
        lines.append("note: " + _hint("view-no-screenshots"))
    for s in shots:
        if s.get("ok"):
            x = s.get("shown") or {}
            lines.append(f"page: {s.get('state')}, {int(x.get('records') or 0)} records and {int(x.get('units') or 0)} "
                         f"units shown, {int(x.get('drawn') or 0)} of the {int(x.get('due') or 0)} the test label marks "
                         "drawn marked"
                         + (f", {int(x.get('unkept') or 0)} records shown that the filter drops"
                            if s.get("state") == "filtered" else ""))
        else:
            lines.append(f"page: {s.get('state')}: " + "; ".join(s.get("errors") or ["did not load"]))
        if s.get("png"):
            lines.append(f"png: {s['png']}")
    if page and not shots and not page.get("unavailable"):
        if page.get("ok"):
            lines.append(f"page: loaded, {page.get('fetches', 0)} fetch(es), no errors")
        else:
            lines.append("page: " + "; ".join(page.get("errors") or ["did not load"]))
    lines += [f"note: {n}" for n in report.get("notes") or []]
    return [ln for ln in lines if ln]


def first_failure(report: dict[str, Any]) -> str:
    """The first line of the report that failed: a problem, a bad check or a page that did not load ('' for none)."""
    for ln in gate_lines(report):
        if ln.startswith(("problem: ", "bad ")) or (ln.startswith("page: ") and not _PAGE_LOADED.match(ln)):
            return ln
    return ""


_PAGE_LOADED = re.compile(r"^page: [a-z]+, ")  # a page line of a page that loaded (gate_lines)


def built_line(view: dict[str, Any]) -> str:
    """What main hears when a view is built (the `view` event, dev.run_view): the files that open in it now and the
    citation forms it adds, since main's prompt, with its table of forms, was rendered before the view existed."""
    return _hint("view-built", view=view.get("name", ""), claims=", ".join(view.get("claims") or []),
                 forms=forms_sentence(view) or _hint("view-no-forms"))


# ----------------------------------------------------------------------------------------------------------
# the page: the frame document every host of a view loads
# ----------------------------------------------------------------------------------------------------------


def media_url(origin: str, c: str, slug: str) -> str:
    """The view's media route as the frame's browser reaches it: the origin, then the route's path under /api, where
    main.create_app mounts every router. Workspace names (config.NAME_RE) and slugs (SLUG_RE) need no escaping in a URL
    or a policy. ValueError for an origin that is not scheme, host and port."""
    if not ORIGIN_RE.fullmatch(origin or ""):
        raise ValueError(f"not an origin: {origin!r}")
    return f"{origin}/api/ws/{c}/views/{slug}/media"


def _script_text(js: str) -> str:
    """Script text safe inside an inline <script>: a `</script` in a library's source would end the element."""
    return js.replace("</script", "<\\/script").replace("</SCRIPT", "<\\/SCRIPT")


def frame_document(view: dict[str, Any], media: str | None = None, *, card: bool = False,
                   derived: list[dict[str, str]] | None = None) -> str:
    """The view's page as a frame loads it: the policy that blocks every load but the view's media route, the bridge
    (viewer_bridge.js), thimble's parts (viewer_kit.css), the vendored libraries the view names, then view.html, whose
    own styles come after the parts. The browser adds the theme's tokens (ViewerFrame.tsx). `media` is the media
    route's absolute URL (media_url), which the policy allows for images, audio and video and thimble.mediaUrl builds
    on; without it the page loads no URL at all. `card` marks the page as a card's (cardtypes.py), which draws what the
    bridge's `init` brings; `page` names a page file other than view.html (a card type's own card.html). `derived` is
    the view's derived fields (derived_fields), view.json's when not given, which the bridge marks wherever the page
    names one with data-field."""
    page = Path(view["dir"]) / (view.get("page") or VIEW_HTML)
    if page.is_symlink() or Path(view["dir"]).is_symlink():
        raise HTTPException(404, f"the page of {view['slug']!r} is a symlink")
    html = page.read_text("utf-8")
    fields = (view.get("derived") or []) if derived is None else derived
    who = json.dumps({"slug": view["slug"], "name": view["name"], "media": media, **({"card": True} if card else {}),
                      **({"derived": fields} if fields else {})}, ensure_ascii=False)
    csp = FRAME_CSP.format(media=f" {media}" if media else "")
    head = [f'<meta http-equiv="Content-Security-Policy" content="{csp}">',
            '<meta charset="utf-8">',
            f"<script>window.__thimbleView = {_script_text(who)}</script>",
            f"<script>{_script_text(BRIDGE_JS.read_text('utf-8'))}</script>",
            f"<style>{KIT_CSS.read_text('utf-8')}</style>"]
    for name in view.get("libs") or []:
        p = LIBS.get(name)
        if p is not None and p.is_file():
            head.append(f"<script>{_script_text(p.read_text('utf-8'))}</script>")
        else:
            head.append(f"<script>console.error({json.dumps(f'the library {name} is not installed here')})</script>")
    # the policy comes first, before any markup of the view: a meta policy only governs what is parsed after it. The
    # view's own <head> content, parsed after this head, still lands in the document's head.
    body = re.sub(r"^\s*<!doctype[^>]*>", "", html, count=1, flags=re.I)
    return "<!doctype html><head>" + "".join(head) + "</head>" + body


async def derived_fields(c: str, slug: str, view: dict[str, Any], version: str | None = None) -> list[dict[str, str]]:
    """The view's derived fields: view.json's, and when reader.py defines derived() those it adds too (shown); only
    view.json's when the reader fails."""
    try:
        src = (Path(view["dir"]) / READER_PY).read_text("utf-8")
    except (OSError, TypeError):
        return view.get("derived") or []
    if not re.search(r"^def derived\s*\(", src, re.M):
        return view.get("derived") or []
    try:
        return (await shown(c, slug, version))["derived"]
    except ReaderError:
        return view.get("derived") or []


# ----------------------------------------------------------------------------------------------------------
# the checks and the screenshot: the page loaded headless, fed by the reader
# ----------------------------------------------------------------------------------------------------------


@functools.lru_cache(maxsize=4)
def _node_version(node: str, mtime_ns: int) -> str:
    """`node -v` of the binary at `node`, '' when it does not answer. Keyed by its mtime, so an upgrade is seen."""
    try:
        return subprocess.run([node, "-v"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def build_problem() -> str:
    """Why a view cannot be built and checked on this machine, '' when it can: the checks need Node 20+ and the
    frontend's packages. The line reaches the orientation and main too, so it names what is missing and no command
    (`thimble doctor` names them)."""
    version = ""
    if node := shutil.which("node"):  # the one shoot runs
        with contextlib.suppress(OSError):
            version = _node_version(node, os.stat(node).st_mtime_ns)
    m = re.match(r"v(\d+)", version)
    if not m or int(m.group(1)) < NODE_MIN:
        found = f"Node {version.lstrip('v')}" if m else "no Node"
        return f"Custom views need Node {NODE_MIN}+, and this machine has {found}."
    if not SHOT_SCRIPT.is_file():
        return f"Custom views need {SHOT_SCRIPT}, which this install lacks."
    if not (_NODE_MODULES / "playwright").is_dir() or not all(p.is_file() for p in LIBS.values()):
        return "Custom views need the frontend's packages, which are not installed here."
    return ""


async def shoot(c: str, slug: str, open_place: dict[str, Any] | None, out_png: Path, *, width: int = SHOT_SIZE[0],
                height: int = SHOT_SIZE[1], labels: dict[str, Any] | None = None) -> dict[str, Any]:
    """One state of shoot_states: the page at `open_place` with the labels context `labels` (the workspace's by
    default), written to `out_png`."""
    ctx = labels if labels is not None else await asyncio.to_thread(labels_context, c)
    res = await shoot_states(c, slug, [{"out": out_png, "open": open_place, "labels": ctx}], width=width, height=height)
    return res[0]


async def shoot_states(c: str, slug: str, states: list[dict[str, Any]], *, width: int = SHOT_SIZE[0],
                       height: int = SHOT_SIZE[1], answers: int = 0,
                       prepared: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Load the view's page headless once per state (shoot_page), each state {out, open, labels}: send it `open`,
    answer its fetches from the reader and its marks requests under the state's labels context (NO_LABELS, a
    probe_context or labels_context), serve its media requests with the file media_file names, and write a picture of it
    to `out`, when it names one. Returns one result per state, {ok, errors, fetches, height, refs, records, units,
    marked, hidden, shown, fonts, fetched_records, png?}, and with `answers` the first that many reader answers each
    state's page got; without Node or the frontend's packages each has build_problem's line as its one error. With
    `prepared`, a reader request of its own (robust_check's), the page's fetches are answered from it."""
    view = read_view(c, slug)
    if view is None:
        return [{"ok": False, "errors": [f"no view {slug!r}"], "fetches": 0} for _ in states]
    media = media_url(SHOT_MEDIA_ORIGIN, c, slug)
    ctxs = [s.get("labels") if s.get("labels") is not None else dict(NO_LABELS) for s in states]
    fetched: list[set[str]] = [set() for _ in states]  # the record refs each state's reader answers handed its page
    kept: list[list[Any]] = [[] for _ in states]  # the first `answers` reader answers of each state

    async def answer(kind: str, i: int, msg: dict[str, Any]) -> dict[str, Any]:
        if kind == "fetch":
            try:
                if prepared is not None:
                    data = await _call(c, {**prepared, "labels": _wire(ctxs[i])}, "records", msg.get("query"))
                else:
                    data = await reader_call(c, slug, "records", msg.get("query"), labels=ctxs[i])
            except ReaderError as e:
                return {"error": e.message}
            strings: list[str] = []
            _strings(data, strings)
            fetched[i].update(s for s in strings[:FETCHED_SCAN_MAX] if _RECORD_REF.match(s))
            if len(kept[i]) < answers:
                kept[i].append(data)
            return {"data": data}
        if kind == "marks":
            refs_in = [str(r) for r in msg.get("refs") or []][:5000]
            try:
                marks = await marks_for(c, slug, refs_in, ctxs[i]) if refs_in else {}
            except ReaderError:
                marks = {}
            return {"marks": marks, **_state_labels(ctxs[i])}
        # the script reads the bytes itself, a range at a time; here the path passes the route's checks
        try:
            f, media_type = await asyncio.to_thread(media_file, c, slug, str(msg.get("path") or ""))
            return {"file": str(f), "type": media_type, "size": f.stat().st_size}
        except (HTTPException, OSError) as e:
            return {"error": str(getattr(e, "detail", e))}

    shot_states = [{"out": s.get("out"), "open": s.get("open") or {}} for s in states]
    doc = frame_document(view, media, derived=await derived_fields(c, slug, view))
    out = await shoot_page(doc, shot_states, answer, width=width, height=height, media=media)
    for i, r in enumerate(out):
        r["fetched_records"] = len(fetched[i])
        if answers:
            r["answers"] = kept[i]
    return out


async def shoot_page(doc: str, states: list[dict[str, Any]], answer: Any, *, width: int, height: int,
                     media: str | None = None) -> list[dict[str, Any]]:
    """Load a frame document headless once per state (scripts/view_shot.mjs, in the frontend's Playwright Chromium),
    each state {out, open}, send it `open` once it says ready, and write a picture of it to `out` when it names one. Every
    request the page makes, `fetch`, `marks` or `media`, is answered by `await answer(kind, state index, message)`, a
    dict of the answer's fields. Returns one result per state, {ok, errors, fetches, fonts, png?, ...} as view_shot.mjs
    reports it; without Node or the frontend's packages each has build_problem's line as its one error, and without the
    browser (headless.missing) each is `unavailable`, its one error headless.NO_SCREENSHOTS."""
    def failed(why: str) -> list[dict[str, Any]]:
        return [{"ok": False, "errors": [why], "fetches": 0} for _ in states]

    def unavailable() -> list[dict[str, Any]]:
        return [{"ok": False, "unavailable": True, "errors": [headless.NO_SCREENSHOTS], "fetches": 0} for _ in states]

    if why := await asyncio.to_thread(build_problem):
        return failed(why)
    path = headless.launch(headless.PAGES)
    if path is None or headless.missing(headless.PAGES):
        return unavailable()
    if not states:
        return []
    with tempfile.TemporaryDirectory(prefix="thimble-view-") as work:
        return await _shoot_in(Path(work), doc, states, answer, path, width=width, height=height, media=media)


async def _shoot_in(work: Path, doc: str, states: list[dict[str, Any]], answer: Any, path: str | None, *, width: int,
                    height: int, media: str | None) -> list[dict[str, Any]]:
    """shoot_page's run, with the frame document and the states written to `work`."""
    def failed(why: str) -> list[dict[str, Any]]:
        return [{"ok": False, "errors": [why], "fetches": 0} for _ in states]

    def unavailable() -> list[dict[str, Any]]:
        return [{"ok": False, "unavailable": True, "errors": [headless.NO_SCREENSHOTS], "fetches": 0} for _ in states]

    frame_file = work / "frame.html"
    atomic_write_text(frame_file, doc)
    states_file = work / "states.json"
    for s in states:
        if s.get("out"):
            Path(s["out"]).parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(states_file, json.dumps([{**s, "out": str(s["out"]) if s.get("out") else None} for s in states],
                                              default=str))
    cmd = ["node", str(SHOT_SCRIPT), "--frame", str(frame_file), "--states", str(states_file), "--viewport",
           f"{width}x{height}", *(["--media", media] if media else [])]
    try:
        proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(config.REPO_ROOT), stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    limit=SHOT_LINE_MAX,
                                                    env={**os.environ, **({userconf.BROWSER_ENV: path} if path else {})})
    except OSError as e:
        return failed(f"the headless browser could not start: {e}")
    results: list[dict[str, Any]] | None = None
    launch_error = ""  # the run's own error when the browser did not start

    async def reply(obj: dict[str, Any]) -> None:
        assert proc.stdin is not None
        proc.stdin.write((json.dumps(obj, ensure_ascii=False, default=str) + "\n").encode("utf-8"))
        await proc.stdin.drain()

    def state_of(msg: dict[str, Any]) -> int:
        try:
            i = int(msg.get("state") or 0)
        except (TypeError, ValueError):
            i = 0
        return i if 0 <= i < len(states) else 0

    async def converse() -> None:
        nonlocal results, launch_error
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            kind = next((k for k in ("fetch", "marks", "media") if k in msg), None)
            if kind is not None:
                await reply({"id": msg[kind], **await answer(kind, state_of(msg), msg)})
            elif msg.get("done"):
                results = list(msg.get("states") or [])
                if msg.get("error") and not results:
                    launch_error = str(msg["error"])
                    results = [{"ok": False, "errors": [launch_error.splitlines()[0][:400]]} for _ in states]
                return

    limit = SHOT_TIMEOUT_S + SHOT_STATE_S * len(states)
    try:
        await asyncio.wait_for(converse(), limit)
    except asyncio.TimeoutError:
        results = None
        timed_out = f"the headless page did not finish in {limit:g} s"
    else:
        timed_out = ""
    finally:
        with contextlib.suppress(Exception):
            proc.stdin.close()  # type: ignore[union-attr]
        try:
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
    err = (await proc.stderr.read()).decode("utf-8", "replace") if results is None and proc.stderr else ""
    if gone := headless.why_missing(launch_error + err):
        headless.mark_missing(headless.PAGES, gone)
        return unavailable()
    if results is None:
        why = timed_out or (f"the headless browser exited {proc.returncode}: {err[-400:]}" if proc.returncode else
                            "the headless page did not finish")
        results = [{"ok": False, "errors": [why], "fetches": 0} for _ in states]
    out: list[dict[str, Any]] = []
    for i, s in enumerate(states):
        r = dict(results[i]) if i < len(results) and isinstance(results[i], dict) else {"ok": False, "errors": ["the state was not shot"]}
        r.setdefault("errors", [])
        r.setdefault("fetches", 0)
        if s.get("out") and Path(s["out"]).is_file():
            r["png"] = str(s["out"])
        out.append(r)
    return out


def _state_labels(ctx: dict[str, Any]) -> dict[str, Any]:
    """The `on` and `filter` of a labels message, as ViewerFrame sends them: the labels that are on, each {name,
    colour, values}, and the filter {label, value, colour} or None."""
    st = labels_state(ctx)
    return {"on": st["labels"], "filter": st["filter"]}


def _strings(v: Any, out: list[str]) -> None:
    if isinstance(v, str):
        out.append(v)
    elif isinstance(v, dict):
        for x in v.values():
            _strings(x, out)
    elif isinstance(v, list):
        for x in v:
            _strings(x, out)
    elif v is not None:
        out.append(json.dumps(v))


def _squeeze(s: str) -> str:
    return " ".join(s.split())


# files whose bytes are not their text even when no NUL shows in their first block (a small PDF, an uncompressed
# workbook part): a view's excerpt of them is not compared with their bytes
BINARY_SUFFIXES = {".pdf", ".xlsx", ".xlsm", ".xls", ".docx", ".pptx", ".odt", ".ods", ".zip", ".gz", ".png", ".jpg",
                   ".jpeg", ".gif", ".webp", ".psd", ".db", ".sqlite", ".sqlite3"}


JSON_DECODE_MAX = 20_000_000  # bytes of a .json document the checks decode to read its string values


@functools.lru_cache(maxsize=8)
def _json_strings(path: str, mtime_ns: int, size: int) -> str:
    """Every string value of a JSON document, joined; '' when it does not parse. Keyed by the file's mtime and size, so
    the refs one check cites into the same document decode it once."""
    parts: list[str] = []
    try:
        _strings(json.loads(Path(path).read_text("utf-8", errors="replace")), parts)
    except ValueError:
        return ""
    return "\n".join(parts)


def source_text(c: str, file_ref: str) -> str | None:
    """Every string of the records a file ref cites, joined: what an excerpt's lines must appear in to count as literal
    source. A .json document's decoded string values count too. '' when the ref does not resolve, None for a binary
    file."""
    try:
        res = refs.resolve_base(config.corpus_dir(c), file_ref)
    except refs.RefError:
        return ""
    suffix = Path(str(res.get("path") or "")).suffix.lower()
    if (res.get("meta") or {}).get("binary") or suffix in BINARY_SUFFIXES:
        return None
    parts: list[str] = []
    for r in res.get("records") or ([{"record": res.get("record")}] if res.get("record") is not None else []):
        _strings(r.get("record"), parts)
    if suffix == ".json":
        try:
            path = config.safe_corpus_path(config.corpus_dir(c), str(res["path"]))
            st = path.stat()
            if st.st_size <= JSON_DECODE_MAX:
                parts.append(_json_strings(str(path), st.st_mtime_ns, st.st_size))
        except (OSError, ValueError, KeyError):
            pass
    return "\n".join(parts)


def missing_lines(excerpt: str, source: str) -> list[str]:
    """The excerpt's non-blank lines that are not in the source text (whitespace runs compared as one space)."""
    src = _squeeze(source)
    return [ln.strip() for ln in excerpt.splitlines() if ln.strip() and _squeeze(ln) not in src]


def _covers(ref_list: list[str], path: str, line: int) -> bool:
    for r in ref_list:
        try:
            p = refs.parse_ref(r)
        except ValueError:
            continue
        if p.get("path") != path or "line" not in p:
            continue
        if p["line"] <= line <= p.get("end_line", p["line"]):
            return True
    return False


def _sample_lines(c: str, rel: str, n: int = CHECK_LINES) -> list[int]:
    """Up to n line numbers spread over the file: the first, the middle and the one two thirds in."""
    from . import corpus  # noqa: PLC0415

    try:
        total = len(corpus.line_offsets(config.safe_corpus_path(config.corpus_dir(c), rel)))
    except (ValueError, OSError):
        return []
    picks = sorted({1, max(1, total // 2), max(1, (2 * total) // 3)})
    return [x for x in picks if 1 <= x <= total][:n]


def _sample_files(files: list[tuple[str, int, int]], n: int = CHECK_FILES) -> list[str]:
    """Up to n claimed files spread over the claims: the largest, then the first and the middle in path order, since the
    first
    files alone can be unrepresentative."""
    if not files:
        return []
    picks = [max(files, key=lambda f: f[1])[0], files[0][0], files[len(files) // 2][0]]
    return list(dict.fromkeys(picks))[:n]


def _is_line_form(form: str) -> bool:
    return bool(re.fullmatch(r"L<[^<>]+>", form.strip()))


async def check(c: str, slug: str, locators: list[str] | None = None, *, shot_dir: Path | None = None,
                picture: bool = False) -> dict[str, Any]:
    """A view's checks, all by code: the index builds, every claimed file is read or hidden with a why, locators and
    sampled lines round-trip (the answer cites the line back and its excerpt is literal source), declared keys resolve,
    the page loads headless without errors, and the test label's marks show on the records it shows (label_problems).
    Fields of the fetched records that the lines they cite do not hold and `derived` does not list are noted
    (unlisted_derived). Without the headless browser the page is not loaded (its `page` is `unavailable`) and the other
    checks decide. With `picture` the page as it opens is pictured. Returns {ok, view, index, checks, page, shots,
    coverage, unread, problems, notes}."""
    view = read_view(c, slug)
    if view is None:
        return {"ok": False, "view": None, "problems": [f"no view {slug!r}"], "checks": [], "page": None}
    report: dict[str, Any] = {"ok": False, "view": view, "problems": [], "notes": [], "checks": [], "page": None}
    if not view["ok"]:
        report["problems"].append("the view has no reader.py, no view.html or no claims")
        return report
    files = await asyncio.to_thread(claimed_files, c, view)
    if not files:
        report["problems"].append(f"no file of the corpus matches the claims {', '.join(view['claims'])}")
        return report
    t0 = time.monotonic()
    try:
        await reader_call(c, slug, "index")
    except ReaderError as e:
        report["problems"].append(f"build_index failed: {e.message}")
        report["traceback"] = e.detail
        return report
    report["index"] = {"files": len(files), "seconds": round(time.monotonic() - t0, 2)}
    try:
        report["unread"] = await reader_problems(c, slug)
    except ReaderError as e:
        report["problems"].append(f"problems() failed: {e.message}")
    try:
        report["coverage"] = cov = await shown(c, slug)
    except ReaderError as e:
        report["problems"].append(f"hidden() or derived() failed: {e.message}")
    else:
        report["problems"] += cov["errors"]
        if cov["not_shown"]["unexplained"]:
            rows = [r for r in cov["not_shown"]["files"] if not r["why"] and r.get("claimed", True)]
            if rows:
                report["problems"].append(_hint("view-not-shown", count=len(rows), files="; ".join(
                    f"{r['path']} (read {r['read']:,} of {r['size']:,} bytes)" for r in rows[:NOT_SHOWN_NAMED])
                    + (" and more" if len(rows) > NOT_SHOWN_NAMED else "")))
        beside = [r["path"] for r in cov["not_shown"]["files"] if not r["why"] and not r.get("claimed", True)]
        if beside:
            report["notes"].append(_hint("view-not-claimed", count=cov["not_shown"]["unclaimed"], files="; ".join(
                beside[:NOT_SHOWN_NAMED]) + (" and more" if len(beside) > NOT_SHOWN_NAMED else "")))
        if cov["missing"]:
            report["notes"].append(_hint("view-missing", files="; ".join(
                f"{m['path']} ({m['why']})" for m in cov["missing"][:NOT_SHOWN_NAMED])
                + (" and more" if len(cov["missing"]) > NOT_SHOWN_NAMED else "")))

    wanted: list[str] = list(dict.fromkeys(str(x).strip() for x in (locators or []) if str(x).strip()))
    # sampled lines beside the locators, so a view is never checked only on the refs its author chose; a binary file
    # (a workbook, a video) has no lines to sample, its rows are cited in its own notation
    if any(_is_line_form(f["form"]) for f in view["accepts"]):
        corpus = config.corpus_dir(c)
        texts = await asyncio.to_thread(lambda: [f for f in files if _texty(corpus, f[0])])
        for rel in _sample_files(texts):
            wanted += [loc for n in await asyncio.to_thread(_sample_lines, c, rel) if (loc := f"{rel}#L{n}") not in wanted]
    keys: list[str] = []

    async def check_one(loc: str) -> dict[str, Any]:
        row: dict[str, Any] = {"locator": loc, "ok": False}
        try:
            p = refs.parse_ref(loc)
        except ValueError as e:
            row["why"] = str(e)
            return row
        try:
            if p["kind"] == "view":
                if p["slug"] != slug or not p.get("key"):
                    row["why"] = f"not a key of this view (view:{slug}/<key>)"
                    return row
                res = await resolve_locator(c, slug, {"key": p["key"]})
            else:
                frag = _fragment_of(loc)
                if not frag or not claims_path(view, p["path"]) or not accepts(view, frag):
                    row["why"] = "the view does not claim this file or accept this fragment (view.json claims, accepts)"
                    return row
                res = await resolve_locator(c, slug, {"path": p["path"], "fragment": frag})
        except ReaderError as e:
            row["why"] = f"resolve() failed: {e.message}"
            return row
        if res is None:
            row["why"] = "resolve() answered None"
            return row
        row.update(label=res["label"], excerpt=res["excerpt"][:300], refs=len(res["refs"]))
        if not res["excerpt"].strip():
            row["why"] = "the excerpt is empty"
            return row
        if not res["refs"]:
            row["why"] = "the answer cites no file ref (`refs`)"
            return row
        if p["kind"] != "view" and "line" in p and not _covers(res["refs"], p["path"], p["line"]):
            row["why"] = f"the answer does not cite {loc} back (its refs: {', '.join(res['refs'][:3])})"
            return row
        texts = await asyncio.to_thread(lambda: [source_text(c, r) for r in res["refs"][:CHECK_KEY_REFS]])
        if all(t is None for t in texts):
            row["unchecked"] = "the cited file is binary, so the excerpt was not compared with it"
        else:
            gone = missing_lines(res["excerpt"], "\n".join(t for t in texts if t))
            if gone:
                row["why"] = f"the excerpt is not literal text of the records it cites: {gone[0][:160]!r}"
                return row
        if res["key"] and res["key"] not in keys and p["kind"] != "view":
            keys.append(res["key"])
        row["ok"] = True
        return row

    for loc in wanted:
        report["checks"].append(await check_one(loc))
    if view["units"]:
        for key in keys[:CHECK_KEYS]:
            report["checks"].append(await check_one(f"view:{slug}/{key}"))
    if not report["checks"]:
        report["problems"].append("no locator was checked: pass `locators` with refs the view should open")

    base = shot_dir or (cache_dir(c, view) / "shots")
    shots = await shoot_checks(c, slug, view, files, report["checks"], base, f"check-{int(time.time())}", picture=picture)
    if shots and all(s.get("unavailable") for s in shots):
        report["shots"], report["page"] = [], {"ok": False, "unavailable": True, "errors": [], "fetches": 0}
    else:
        report["shots"], report["page"] = shots, _page_of(shots)
    problems, notes = label_problems(view, files, shots)
    report["problems"] += problems
    report["notes"] += notes
    page = report["page"]
    if not report["problems"] and all(r["ok"] for r in report["checks"]) and (page.get("ok") or page.get("unavailable")):
        overview = next((s for s in shots if s.get("state") == "overview"), {})
        problems, notes = await robust_check(c, slug, view, files, overview.get("shown"))
        report["problems"] += problems
        report["notes"] += notes
    declared = {d["field"] for d in (report.get("coverage") or {}).get("derived") or view["derived"]}
    if unlisted := await asyncio.to_thread(unlisted_derived, c, shots, declared):
        report["notes"].append(_hint("view-derived-unlisted", fields="; ".join(
            f"{x['field']} ({x['value']!r} on {x['ref']})" for x in unlisted)))
    page = report["page"]
    report["ok"] = (not report["problems"] and all(r["ok"] for r in report["checks"])
                    and bool(page.get("ok") or page.get("unavailable")))
    return report


# the states the checks load the page in, with the test label on: the page as the Views bar opens it, the same filtered
# to the test label, and the first place that resolved
CHECK_STATES = ("overview", "filtered", "detail")
ANSWERS_KEPT = 2  # reader answers per state the checks keep, for unlisted_derived and the review


async def first_place(c: str, slug: str, checks: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The `open` message for the first check that passed, None when none did."""
    first_ok = next((r for r in checks if r["ok"]), None)
    if first_ok is None:
        return None
    loc = first_ok["locator"]
    p = refs.parse_ref(loc)
    loc_d = {"key": p["key"]} if p["kind"] == "view" else {"path": p["path"], "fragment": _fragment_of(loc)}
    return await open_place(c, slug, loc, loc_d)


async def shoot_checks(c: str, slug: str, view: dict[str, Any], files: list[tuple[str, int, int]],
                       checks: list[dict[str, Any]], base: Path, stem: str, *, picture: bool = False) -> list[dict[str, Any]]:
    """The page loaded in CHECK_STATES with the test label on: the overview, opened on its first claimed file as the
    Views bar opens it, the same filtered to the test label, and the detail, the first place that resolved. Only with
    `picture` is anything pictured: the overview. Each result carries its `state` name."""
    overview = {"ref": None, "path": files[0][0]} if files else {"ref": None}
    detail = await first_place(c, slug, checks) or overview
    states = [{"out": base / f"{stem}-overview.png" if picture else None, "open": overview, "labels": probe_context()},
              {"out": None, "open": overview, "labels": probe_context(True)},
              {"out": None, "open": detail, "labels": probe_context()}]
    shots = await shoot_states(c, slug, states, answers=ANSWERS_KEPT)
    return [{**s, "state": name} for s, name in zip(shots, CHECK_STATES)]


def _page_of(shots: list[dict[str, Any]]) -> dict[str, Any]:
    """The shots as one page result: ok when every shot loaded without errors, their errors and fetches together, and
    the detail shot's picture (the one a session looked at before there were two)."""
    if not shots:
        return {"ok": False, "errors": ["no picture was taken"], "fetches": 0}
    errors = list(dict.fromkeys(e for s in shots for e in s.get("errors") or []))
    page = {"ok": all(s.get("ok") for s in shots), "errors": errors, "fetches": sum(int(s.get("fetches") or 0) for s in shots),
            "refs": max(int(s.get("refs") or 0) for s in shots), "records": max(int(s.get("records") or 0) for s in shots),
            "units": max(int(s.get("units") or 0) for s in shots),
            "fetched_records": max(int(s.get("fetched_records") or 0) for s in shots)}
    png = shots[-1].get("png") or shots[0].get("png")
    if png:
        page["png"] = png
    return page


def lined(view: dict[str, Any], files: list[tuple[str, int, int]]) -> bool:
    """Whether the view claims a file with lines, whose records labels can mark (not only binary or media files)."""
    return any(Path(f[0]).suffix.lower() not in BINARY_SUFFIXES and Path(f[0]).suffix.lower() not in MEDIA_TYPES
               for f in files)


SNIFF_BYTES = 4096


def _texty(corpus: Path, rel: str) -> bool:
    """Whether a corpus file has lines: not of a binary or media type, and no NUL byte in its first SNIFF_BYTES."""
    suffix = Path(rel).suffix.lower()
    if suffix in BINARY_SUFFIXES or suffix in MEDIA_TYPES:
        return False
    try:
        with config.safe_corpus_path(corpus, rel).open("rb") as f:
            return b"\0" not in f.read(SNIFF_BYTES)
    except (OSError, ValueError):
        return False


def label_problems(view: dict[str, Any], files: list[tuple[str, int, int]],
                   shots: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    """(problems, notes) of labels in the page, from what each loaded state shows at its end (view_shot.mjs `shown`),
    for a view of files with lines. It fails when no record or unit is shown anchored; when fewer than one in
    ANCHORED_SHARE of the records the reader answered are shown anchored and no unit is; and when a record or unit the
    test label marks is shown without its mark. Records shown, filtered to the test label, whose anchor the filter does
    not keep are noted, since a record the page draws for several lines is anchored by one of them."""
    if not lined(view, files):
        return [], []
    loaded = {str(s.get("state")): s.get("shown") for s in shots if s.get("ok") and isinstance(s.get("shown"), dict)}
    seen = [(name, x) for name, x in loaded.items() if name != "filtered"]
    if not seen:
        return [], []
    problems: list[str] = []
    notes: list[str] = []
    records = max(int(x.get("records") or 0) for _, x in seen)
    units = max(int(x.get("units") or 0) for _, x in seen)
    if not records and not units:
        return [_hint("view-no-anchors", slug=view["slug"])], []
    fetched = max(int(s.get("fetched_records") or 0) for s in shots if s.get("state") != "filtered")
    if not units and records < max(1, fetched // ANCHORED_SHARE):
        problems.append(_hint("view-few-anchors", fetched=fetched, records=records))
    for name, x in seen:
        due, drawn = int(x.get("due") or 0), int(x.get("drawn") or 0)
        if drawn < due:
            problems.append(_hint("view-marks-missing", state=name, due=due, missing=due - drawn))
            break
    if (f := loaded.get("filtered")) is not None and (unkept := int(f.get("unkept") or 0)):
        notes.append(_hint("view-filter-unkept", unkept=unkept, records=int(f.get("records") or 0)))
    return problems, notes


ROBUST_SUBDIR = "robust"  # under the view's index folder: the corpus copy robust_check runs the view on
ROBUST_BYTES = 256 * 1024 * 1024  # of the claimed files the copy links, smallest first
TORN_MAX = 64 * 1024 * 1024  # bytes of the file the copy tears, which it copies whole
TORN_SUFFIXES = (".jsonl", ".ndjson")
TORN_LINE = '{"torn": "a line cut short'


def _robust_pick(view: dict[str, Any], files: list[tuple[str, int, int]]) -> tuple[str | None, str | None]:
    """(the claimed file the copy leaves out, the one it adds a torn line to): first a file of a claim of one file in
    each of several folders (`runs/*/manifest.json`), else the smallest of a claim of several files; and the smallest
    JSON lines file of at most TORN_MAX bytes. None for either when there is none, and nothing left out of one file."""
    removed = None
    by_claim = [(g, [f for f in files if glob_matches(f[0], g)]) for g in view["claims"]]
    for g, hit in by_claim:
        head, _, base = g.rpartition("/")
        if head and _GLOB_CHARS.search(head) and not _GLOB_CHARS.search(base) and len(hit) >= 2:
            removed = hit[-1][0]
            break
    if removed is None:
        removed = next((min(hit, key=lambda f: f[1])[0] for _, hit in by_claim if len(hit) >= 2), None)
    torn = min((f for f in files if f[0] != removed and Path(f[0]).suffix.lower() in TORN_SUFFIXES and f[1] <= TORN_MAX),
               key=lambda f: f[1], default=None)
    return removed, torn[0] if torn else None


def robust_copy(c: str, slug: str, view: dict[str, Any], files: list[tuple[str, int, int]]) -> dict[str, Any] | None:
    """The corpus copy robust_check runs the view on, in the view's index folder, which the views kernel reads: every
    claimed file linked but the one _robust_pick leaves out, and the one it tears copied with a torn line after its
    last. Past ROBUST_BYTES the largest files are left out too (`cut`). {root, files, removed, torn (the torn line's
    ref), cut}, or None when there is nothing to leave out or tear. Blocking."""
    removed, torn = _robust_pick(view, files)
    if removed is None and torn is None:
        return None
    corpus = config.corpus_dir(c)
    d = index_dir(c, slug) / ROBUST_SUBDIR
    shutil.rmtree(d, ignore_errors=True)
    root = d / "corpus"
    out: list[tuple[str, int, int]] = []
    total, cut, torn_ref = 0, False, None
    for rel, size, mtime in sorted(files, key=lambda f: (f[1], f[0])):
        if rel == removed:
            continue
        if total + size > ROBUST_BYTES and rel != torn:
            cut = True
            continue
        src = config.safe_corpus_path(corpus, rel).resolve()
        dst = root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if rel == torn:
            shutil.copyfile(src, dst)
            with dst.open("rb+") as fh:
                fh.seek(0, os.SEEK_END)
                if fh.tell():
                    fh.seek(-1, os.SEEK_END)
                    if fh.read(1) != b"\n":
                        fh.write(b"\n")
                fh.write(TORN_LINE.encode("utf-8"))
            with dst.open("rb") as fh:
                newlines = sum(block.count(b"\n") for block in iter(lambda: fh.read(1 << 20), b""))
            torn_ref = f"{rel}#L{newlines + 1}"
            st = dst.stat()
            size, mtime = st.st_size, st.st_mtime_ns
        else:
            os.symlink(src, dst)
        total += size
        out.append((rel, size, mtime))
    return {"root": root, "files": sorted(out), "removed": removed, "torn": torn_ref, "cut": cut}


async def robust_check(c: str, slug: str, view: dict[str, Any], files: list[tuple[str, int, int]],
                       shown: dict[str, Any] | None) -> tuple[list[str], list[str]]:
    """(problems, notes) of the view run on a copy of its files with one missing and a torn line (robust_copy), as a
    real corpus may be: build_index and problems() must not fail, problems() must report the torn line, and the page
    must load without errors and, when `shown` (what the overview showed over the whole corpus) anchored records or
    units and the copy left nothing else out, show some too."""
    copy = await asyncio.to_thread(robust_copy, c, slug, view, files)
    if copy is None or not copy["files"]:
        return [], []
    try:
        _, req = await asyncio.to_thread(_prepare, c, slug)
        d = index_dir(c, slug) / ROBUST_SUBDIR
        req = {**req, "slug": f"{slug}_robust", "fp": "r" + fingerprint(copy["files"], req["fp"]),
               "paths": [f[0] for f in copy["files"]], "cache": str((d / "index.pickle").resolve()),
               "reads": str((d / "reads.json").resolve()), "root": str(copy["root"].resolve())}
        what = " and ".join([*([f"{copy['removed']} missing"] if copy["removed"] else []),
                             *([f"a torn line at {copy['torn']}"] if copy["torn"] else [])])
        try:
            await _call(c, req, "index")
            got = clean_problems(await _call(c, req, "problems"))
        except ReaderError as e:
            return [_hint("view-robust-reader", what=what, error=e.message)], []
        problems: list[str] = []
        if copy["torn"] and not got["count"]:
            problems.append(_hint("view-robust-torn", ref=copy["torn"]))
        overview = {"ref": None, "path": copy["files"][0][0]}
        s = (await shoot_states(c, slug, [{"out": None, "open": overview, "labels": probe_context()}], prepared=req))[0]
        if s.get("unavailable"):
            return problems, []
        if not s.get("ok"):
            problems.append(_hint("view-robust-page", what=what, errors="; ".join(s.get("errors") or ["it did not load"])[:600]))
        else:
            before = int((shown or {}).get("records") or 0) + int((shown or {}).get("units") or 0)
            after = int((s.get("shown") or {}).get("records") or 0) + int((s.get("shown") or {}).get("units") or 0)
            if before and not after and not copy["cut"]:
                problems.append(_hint("view-robust-empty", what=what))
        return problems, []
    finally:
        await asyncio.to_thread(shutil.rmtree, index_dir(c, slug) / ROBUST_SUBDIR, True)


DERIVED_SAMPLE = 60  # records of the checks' reader answers compared with the lines they cite
DERIVED_NAMED = 40  # unlisted fields a note names
# fields that need no entry in `derived`: a record's place and the page's own keys
_POSITION_KEYS = {"ref", "refs", "line", "lines", "path", "file", "key", "anchor", "offset", "index", "idx", "n", "id",
                  "uid", "row", "pos", "position", "order", "rank", "i", "k", "seq"}
_KEY_SUFFIXES = ("_key", "_idx", "_index", "_pos", "_row", "_order", "_rank")
_COUNT_NAME = re.compile(r"(^|_)(n|num|count|counts|total|totals|size|len|length)(_|$)|^n[A-Z]|Count$|^(num|count)[A-Z]")
# values a reader puts in for a missing one
_DEFAULTS = {"", "-", "?", "—", "unknown", "none", "null", "n/a", "na", "other", "missing", "(none)", "(unknown)"}


def _answer_records(v: Any, out: dict[str, dict[str, Any]]) -> None:
    """The objects in a reader's answer that cite one record, by the record ref (`<path>#L<n>`) among their values."""
    if len(out) >= DERIVED_SAMPLE:
        return
    if isinstance(v, dict):
        ref = next((x for x in v.values() if isinstance(x, str) and _RECORD_REF.match(x)), None)
        if ref is not None and ref not in out:
            out[ref] = v
        for x in v.values():
            if isinstance(x, (dict, list)):
                _answer_records(x, out)
    elif isinstance(v, list):
        for x in v:
            _answer_records(x, out)


def _scalars(v: Any, out: list[str]) -> None:
    if isinstance(v, dict):
        for x in v.values():
            _scalars(x, out)
    elif isinstance(v, list):
        for x in v:
            _scalars(x, out)
    elif isinstance(v, str):
        out.append(v)
    elif isinstance(v, (int, float)) and not isinstance(v, bool):
        out.append(json.dumps(v))


def _held(value: Any, text: str, numbers: set[float]) -> bool:
    """Whether a field's value is in the text of the line it cites: a string, without an ellipsis it was cut at, or its
    first 80 characters; a number as written or equal to one of the line's."""
    if isinstance(value, (int, float)):
        return json.dumps(value) in text or float(value) in numbers
    v = _squeeze(value).rstrip("…").removesuffix("...").strip()
    return not v or v[:80] in text


def _exempt(field: str, value: Any) -> bool:
    """Whether a field needs no entry in `derived`: a record's place or a key of the page's own, a count, or a value put
    in for a missing one."""
    low = field.lower()
    if low in _POSITION_KEYS or low.endswith(_KEY_SUFFIXES):
        return True
    if isinstance(value, int) and (_COUNT_NAME.search(field) or (low.endswith("s") and not low.endswith("ss"))):
        return True
    return isinstance(value, str) and value.strip().lower() in _DEFAULTS


def unlisted_derived(c: str, shots: list[dict[str, Any]], declared: set[str]) -> list[dict[str, str]]:
    """Every field of the records the checks' reader answers handed the page whose values the line each record cites
    does not hold, for at least two records and most of those that have the field, and that `declared` does not name:
    [{field, value, ref}], each with one such value. A record is an object of an answer with a record ref among its
    values. Left out as needing no entry: positions and the page's own keys, counts, values put in for missing ones
    (_exempt), a field whose missed values are all one value (a default), values that are lists or objects, and a value
    the line holds under another name (a rename). Blocking."""
    recs: dict[str, dict[str, Any]] = {}
    for s in shots:
        for a in s.get("answers") or []:
            _answer_records(a, recs)
    seen: dict[str, int] = {}
    missed: dict[str, list[tuple[Any, str]]] = {}
    for ref, rec in recs.items():
        try:
            res = refs.resolve_base(config.corpus_dir(c), ref)
        except (refs.RefError, ValueError):
            continue
        if (res.get("meta") or {}).get("binary"):
            continue
        parts: list[str] = []
        for r in res.get("records") or ([{"record": res.get("record")}] if res.get("record") is not None else []):
            _scalars(r.get("record"), parts)
        if not parts:
            continue
        text = _squeeze("\n".join(parts))
        numbers: set[float] = set()
        for x in parts:
            with contextlib.suppress(ValueError):
                numbers.add(float(x))
        line = refs.parse_ref(ref).get("line")
        for k, v in rec.items():
            if k in declared or v is None or isinstance(v, (bool, dict, list)) or _exempt(k, v):
                continue
            if v == ref or v == line or (isinstance(v, str) and (len(v.strip()) < 2 or _RECORD_REF.match(v))):
                continue
            seen[k] = seen.get(k, 0) + 1
            if not _held(v, text, numbers):
                missed.setdefault(k, []).append((v, ref))
    out = []
    for k, xs in missed.items():
        if len(xs) >= 2 and len(xs) * 2 > seen[k] and len({json.dumps(v, default=str) for v, _ in xs}) > 1:
            v, ref = xs[0]
            out.append({"field": k, "value": _cut(str(v), 60), "ref": ref})
    return out[:DERIVED_NAMED]


async def open_place(c: str, slug: str, ref: str | None, locator: dict[str, Any] | None,
                     version: str | None = None) -> dict[str, Any]:
    """The `open` message a view's page gets: the ref, its parsed locator and the answer of the reader at `version`."""
    if not ref or locator is None:
        return {"ref": None}
    out: dict[str, Any] = {"ref": ref, **locator}
    try:
        res = await resolve_locator(c, slug, locator, version)
    except ReaderError as e:
        out["error"] = e.message
        return out
    if res is None:
        out["error"] = "the view does not know this place"
    else:
        out.update(target=res["target"], key=res["key"], label=res["label"], excerpt=res["excerpt"], refs=res["refs"])
    return out


def locator_of(ref: str) -> dict[str, Any] | None:
    """{key} for view:<slug>/<key>, {path, fragment} for a file ref with a fragment, None otherwise."""
    try:
        p = refs.parse_ref(ref)
    except ValueError:
        return None
    if p["kind"] == "view":
        return {"key": p["key"]} if p.get("key") else None
    frag = _fragment_of(ref)
    return {"path": p["path"], "fragment": frag} if "path" in p and frag else None


# ----------------------------------------------------------------------------------------------------------
# the tool cases this module owns (tools.REGISTRY and tools._h_read_ref / _h_screenshot call them)
# ----------------------------------------------------------------------------------------------------------


def _hint(section: str, **values: Any) -> str:
    from . import tools  # noqa: PLC0415

    return tools.hint(section, **values)


def _fold(v: Any) -> Any:
    """A tool argument a client sent as a JSON string where the schema has a list or an object."""
    if isinstance(v, str) and v.strip()[:1] in ("[", "{"):
        with contextlib.suppress(ValueError):
            return json.loads(v)
    return v


async def tool_read_ref(ctx: Any, args: dict[str, Any]) -> Any:
    """`read_ref` on a view ref: `view:<slug>` names the view, its files and its forms (or a proposal's fields), and
    `view:<slug>/<key>` gives the unit the key names, its excerpt and the file refs it stands for."""
    from . import tools  # noqa: PLC0415

    _bind_loop()
    ref = str(args.get("ref") or "").strip()
    try:
        p = refs.parse_ref(ref)
    except ValueError as e:
        return tools.err(f"read_ref: {e}")
    view = read_built(ctx.c, p["slug"])
    if not p.get("key"):
        if view is not None:
            lines = [f"{ref} ({view['name']})", view["description"], f"claims: {', '.join(view['claims'])}"]
            # the arrangement lives on the proposal it was built from, and a change to the view restates it
            arrangement = str((read_proposal(ctx.c, p["slug"]) or {}).get("arrangement") or "")
            if arrangement:
                lines.append(f"arrangement: {arrangement}")
            forms = view_forms(view)
            lines += [f"form: {f}  {m}" for f, m in forms] or ["forms: none"]
            lines.append(await asyncio.to_thread(records_text, ctx.c, p["slug"]))
            return tools.ok("\n".join(ln for ln in lines if ln))
        prop = read_proposal(ctx.c, p["slug"])
        if prop is not None:
            return tools.ok("\n".join([f"{ref} (a proposal, {prop.get('status')})", f"name: {prop['name']}",
                                       f"why: {prop.get('why', '')}", f"claims: {', '.join(prop.get('claims') or [])}",
                                       f"arrangement: {prop.get('arrangement', '')}"]))
        return tools.err(f"read_ref: no view {p['slug']!r}")
    try:
        res = await asyncio.to_thread(resolve_view_ref, config.corpus_dir(ctx.c), p, ref)
    except refs.RefError as e:
        return tools.err(f"read_ref: {ref} does not resolve: {e.detail}")
    rs = res.get("refs") or []
    lines = [f"{ref} ({res.get('label') or ''})".rstrip(), str(res.get("excerpt") or "").strip() or "(empty)"]
    if rs:
        lines.append("cites: " + ", ".join(rs[:20]) + (f" … {len(rs) - 20} more" if len(rs) > 20 else ""))
    if (res.get("meta") or {}).get("deleted"):
        lines.append("(the view is deleted; this is the answer it gave last)")
    return tools.ok("\n".join(lines))


def opening_view(c: str, ref: str) -> str | None:
    """The slug of the view a screenshot of this file ref shows it in (views_for's first), None when no view claims the
    file and accepts the fragment, or the ref is not a file ref with a fragment."""
    loc = locator_of(ref)
    if loc is None or "path" not in loc:
        return None
    hit = views_for(c, loc["path"], loc["fragment"])
    return str(hit[0]["slug"]) if hit else None


async def tool_screenshot(ctx: Any, args: dict[str, Any]) -> Any:
    """`screenshot` of `view:<slug>` or `view:<slug>/<key>`, or of a place in a file a view opens (such as lines of a
    file the view claims): the view's page loaded headless at that place."""
    from . import tools  # noqa: PLC0415

    _bind_loop()
    ref = str(args.get("ref") or "").strip()
    try:
        p = refs.parse_ref(ref)
    except ValueError as e:
        return tools.err(f"screenshot: {e}")
    if p["kind"] == "view":
        slug, at = p["slug"], ref if p.get("key") else None
    else:
        slug, at = await asyncio.to_thread(opening_view, ctx.c, ref), ref
        if slug is None:
            return tools.err("screenshot: " + tools.hint("screenshot-none", what=f"No view opens {ref}"))
    if read_built(ctx.c, slug) is None:
        return tools.err(f"screenshot: no view {slug!r}")
    import base64  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="thimble-view-shot-") as d:
        place = await open_place(ctx.c, slug, at, locator_of(ref))
        res = await shoot(ctx.c, slug, place, Path(d) / "view.png")
        png = res.get("png")
        if res.get("unavailable"):
            return tools.err(headless.NO_SCREENSHOTS)
        if not png or not Path(png).is_file():
            return tools.err("screenshot: " + "; ".join(res.get("errors") or ["no picture was taken"]))
        data = base64.b64encode(Path(png).read_bytes()).decode("ascii")
    note = "" if res.get("ok") else " (the page reported: " + "; ".join(res.get("errors") or []) + ")"
    return tools.ToolResult([{"type": "text", "text": f"screenshot of {ref}{note}"},
                             {"type": "image", "data": data, "mimeType": "image/png"}])


# ----------------------------------------------------------------------------------------------------------
# viewers for a file type: a view whose claims are all one extension's glob, proposed by the File browser (suggest)
# ----------------------------------------------------------------------------------------------------------

SUGGESTIONS_FILE = "suggestions.json"  # {suffix: {answer: suggested | none | dismissed, slug?, ts}}, one per suffix
# the suffixes the files view reads well, and those a built-in viewer or mode reads: no viewer is proposed for them
ORDINARY_SUFFIXES = frozenset(
    ".txt .md .markdown .rst .log .out .err .json .jsonl .ndjson .csv .tsv .yaml .yml .toml .ini .cfg .conf .env .xml "
    ".html .htm .css .js .mjs .cjs .ts .tsx .jsx .py .sh .bash .zsh .rb .go .rs .java .kt .c .h .cc .cpp .hpp .cs .php "
    ".sql .r .jl .lua .pl .swift .scala .diff .patch .lock .pdf .db .sqlite .sqlite3".split())
_TYPE_GLOB = re.compile(r"^(?:\*\*/)?\*(\.[A-Za-z0-9_+-]{1,16})$")
SUGGEST_HEAD_LINES, SUGGEST_LINE_CHARS = 40, 300  # of a text file's start the proposal is written from
SUGGEST_HEX_BYTES, SUGGEST_SCAN_BYTES, SUGGEST_RUN_MIN = 512, 65536, 6  # of a binary file's start
SUGGEST_TIMEOUT_S = 30.0
SUGGEST_PROMPT = "file-viewer"


def type_suffix(glob: str) -> str | None:
    """The suffix a claim names when it is one extension's glob (`**/*.vtt`, `*.vtt`), lower-cased; None otherwise."""
    m = _TYPE_GLOB.match(str(glob or "").strip())
    return m.group(1).lower() if m else None


def file_type_viewer(view: dict[str, Any]) -> bool:
    """Whether the view is a viewer of one file at a time, a mode of the File browser: its `unit` is "file", or, with no
    unit, every claim is one extension's glob."""
    if view.get("unit"):
        return view["unit"] == "file"
    claims = view.get("claims") or []
    return bool(claims) and all(type_suffix(g) for g in claims)


def offered_type_viewer(claims: Any) -> bool:
    """Whether a proposal claiming `claims` is a viewer of unusual file types, which the File browser offers beside Raw
    before it is built: every claim one extension's glob, of a suffix that neither the files view nor a media player
    reads."""
    suffixes = [type_suffix(g) for g in _str_list(claims)]
    return bool(suffixes) and all(s and s not in ORDINARY_SUFFIXES and s not in MEDIA_TYPES for s in suffixes)


def _suggestions_path(c: str) -> Path:
    return views_dir(c) / SUGGESTIONS_FILE


def suggestions(c: str) -> dict[str, dict[str, Any]]:
    p = _suggestions_path(c)
    raw = read_json(p, {}) if p.is_file() else {}
    return raw if isinstance(raw, dict) else {}


def _answer_suffix(c: str, suffix: str, answer: str, slug: str | None = None) -> None:
    with _proposals_lock:
        allk = suggestions(c)
        allk[suffix] = {"answer": answer, **({"slug": slug} if slug else {}), "ts": _now()}
        p = _suggestions_path(c)
        p.parent.mkdir(parents=True, exist_ok=True)
        write_json(p, allk)


def suffix_of(rel: str) -> str:
    return Path(rel).suffix.lower()


def suggestion_for(c: str, rel: str) -> dict[str, Any]:
    """What thimble proposes for opening the file `rel` in the File browser: {path, suffix, eligible, reason, answer,
    proposal}. `eligible` holds when a viewer may be proposed for its type: no view claims it, it is no media, its
    suffix is not one the files view reads well, a file with no suffix is binary, and the workspace has no proposal or
    answer for the suffix yet. `proposal` is the proposal for its type, when there is one."""
    from . import corpus as corpus_mod  # noqa: PLC0415

    rel = str(rel or "").strip().strip("/")
    suffix = suffix_of(rel)
    out: dict[str, Any] = {"path": rel, "suffix": suffix, "eligible": False, "reason": "", "answer": None, "proposal": None}
    try:
        p = config.safe_corpus_path(config.corpus_dir(c), rel)
    except ValueError:
        out["reason"] = "not a corpus file"
        return out
    if not p.is_file():
        out["reason"] = "not a corpus file"
        return out
    kept = suggestions(c).get(suffix) if suffix else None
    out["answer"] = kept.get("answer") if isinstance(kept, dict) else None
    out["proposal"] = next((x for x in list_proposals(c) if x.get("status") != "dropped"
                            and any(type_suffix(g) == suffix for g in x.get("claims") or [])), None) if suffix else None
    if views_for(c, rel):
        out["reason"] = "a view opens it"
    elif suffix in MEDIA_TYPES:
        out["reason"] = "a media file"
    elif suffix in ORDINARY_SUFFIXES:
        out["reason"] = "the files view reads it"
    elif not suffix and not corpus_mod.sniff_binary(p):
        out["reason"] = "a text file with no suffix"
    elif out["proposal"] is not None or any(claims_path(x, rel) for x in list_proposals(c) if x.get("status") != "dropped"):
        out["reason"] = "a proposal claims it"
    elif out["answer"]:
        out["reason"] = f"already answered ({out['answer']})"
    else:
        out["eligible"] = bool(suffix)
        out["reason"] = "" if suffix else "a file with no suffix"
    return out


def file_head(p: Path) -> tuple[str, str]:
    """(what the start is, the start) of a file for the proposal: the first lines of a text file, each cut, or for a
    binary file its first bytes as hex and the printable runs of its first 64 KB."""
    from . import corpus as corpus_mod  # noqa: PLC0415

    if not corpus_mod.sniff_binary(p):
        lines = []
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            for i, ln in enumerate(f):
                if i >= SUGGEST_HEAD_LINES:
                    break
                ln = ln.rstrip("\n")
                lines.append(ln if len(ln) <= SUGGEST_LINE_CHARS else ln[:SUGGEST_LINE_CHARS] + "…")
        return f"its first {len(lines)} lines", "\n".join(lines)
    with open(p, "rb") as f:
        data = f.read(SUGGEST_SCAN_BYTES)
    hexed = data[:SUGGEST_HEX_BYTES].hex(" ")
    runs = re.findall(rb"[\x20-\x7e]{%d,}" % SUGGEST_RUN_MIN, data)
    text = "\n".join(r.decode("ascii") for r in runs[:200])
    return (f"its first {min(len(data), SUGGEST_HEX_BYTES)} bytes as hex, then the printable runs of its first "
            f"{len(data):,} bytes"), f"{hexed}\n\n{text}"


def _fmt_size(n: int) -> str:
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n} bytes"


async def _suggest_call(c: str, system: str, user: str, tool: Any) -> Any:
    """The proposal's one model call: the `dev` role's model at low effort (the fallback model after a refusal, as
    model.structured runs it). Tests replace it."""
    from . import model  # noqa: PLC0415

    role = config.models_for(c).get("dev") or dict(config.ROLE_MODELS_DEFAULT["dev"])
    return await model.structured(user, tool=tool, model=role.get("model") or config.ROLE_MODELS_DEFAULT["dev"]["model"],
                                  effort="low", system_append=system, cwd=config.corpus_dir(c))


async def suggest(c: str, rel: str) -> str | None:
    """Propose a viewer for the type of the file `rel` the analyst opened, when suggestion_for says one may be: one
    model call reads the file's start (prompts/file-viewer.md) and says whether a viewer would help; a yes is stored as
    a `suggested` proposal claiming the suffix's glob, a no as the suffix's answer, so it is never asked again. The
    proposal's slug, or None. A call that fails caches nothing, so the next file of the type asks again."""
    from . import model, prompts, tools  # noqa: PLC0415

    got = await asyncio.to_thread(suggestion_for, c, rel)
    if not got["eligible"]:
        return None
    suffix = got["suffix"]
    p = config.safe_corpus_path(config.corpus_dir(c), got["path"])
    what, head = await asyncio.to_thread(file_head, p)
    count = sum(1 for f, _, _ in await asyncio.to_thread(folder_files, config.corpus_dir(c), "") if suffix_of(f) == suffix)
    secs = {name: prompts.section(SUGGEST_PROMPT, name).strip() for name in ("suggest", "file", "proposal")}
    system = prompts._fill(secs["suggest"], {}, f"{SUGGEST_PROMPT}.md")
    user = prompts._fill(secs["file"], {"path": got["path"], "size": _fmt_size(p.stat().st_size), "count": str(count),
                                        "suffix": suffix, "what": what, "head": head}, f"{SUGGEST_PROMPT}.md")
    desc, schema = tools.split_section(secs["proposal"])
    tool = model.ToolSpec(name="proposal", description=desc, input_schema=schema)
    try:
        res = await asyncio.wait_for(_suggest_call(c, system, user, tool), SUGGEST_TIMEOUT_S)
    except (asyncio.TimeoutError, Exception) as e:  # noqa: BLE001 — a failed call asks again next time
        log.info("no viewer suggestion for %s/%s: %s", c, rel, e)
        return None
    out = res.output if getattr(res, "status", "") == "ok" and isinstance(res.output, dict) else None
    if out is None:
        log.info("no viewer suggestion for %s/%s: the call ended %s", c, rel, getattr(res, "status", "?"))
        return None
    name = " ".join(str(out.get("name") or "").split())
    if not out.get("help") or not name or not str(out.get("arrangement") or "").strip():
        await asyncio.to_thread(_answer_suffix, c, suffix, "none")
        return None
    # the checks ran off the loop: a proposal made meanwhile for the suffix stands
    if (await asyncio.to_thread(suggestion_for, c, rel))["proposal"] is not None:
        return None
    prop = await asyncio.to_thread(propose, c, name, str(out.get("why") or ""), [f"**/*{suffix}"],
                                   str(out.get("arrangement") or ""), "files", False, False, True)
    await asyncio.to_thread(_answer_suffix, c, suffix, "suggested", prop["slug"])
    return str(prop["slug"])


def accept(c: str, slug: str) -> dict[str, Any]:
    """Build a suggested viewer: its proposal queued as one the analyst asked for, on the build path every view takes.
    404 for no such proposal, 409 for one that is not suggested."""
    prop = read_proposal(c, slug)
    if prop is None:
        raise HTTPException(404, f"no such proposal: {slug}")
    if prop.get("status") != "suggested":
        raise HTTPException(409, f"the view {prop['name']!r} is {prop.get('status')}, not suggested")
    prop = update_proposal(c, slug, status="queued", asked=True, accepted=True, ts=_now()) or prop
    _emit(c, slug, "queued", asked=True)
    _queue(c, slug)
    return prop


# ----------------------------------------------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------------------------------------------


def _view_or_404(c: str, slug: str, version: str | None = None) -> dict[str, Any]:
    """The built view, or with `version` the view at the version a page was loaded at (read_version); 404 for none."""
    config.workspace_dir(c)
    v = read_version(c, slug, version) if version else read_built(c, slug)
    if v is None:
        raise HTTPException(404, f"no such view: {slug}" + (f" at version {version}; reload it" if version else ""))
    return v


def _public(v: dict[str, Any], c: str | None = None) -> dict[str, Any]:
    """A view record for a route's answer: everything but the on-disk directory, with its forms, and with `c` the files
    it claims, `files` (the first FILES_LISTED) and `n_files`, and the first of them (what Raw shows of a view opened on
    its own). Blocking when a claim is a glob (the corpus walk)."""
    out = {k: x for k, x in v.items() if k != "dir"}
    out["forms"] = [{"form": f, "means": m} for f, m in view_forms(v)]
    out["file_type"] = file_type_viewer(v)
    if c is not None:
        try:
            files = claimed_files(c, v) if v["ok"] else []
        except (ValueError, OSError, HTTPException):
            files = []
        out["first_file"] = files[0][0] if files else None
        out["files"] = [f[0] for f in files[:FILES_LISTED]]
        out["n_files"] = len(files)
    return out


def _recover(c: str) -> None:
    """Each time a workspace's views or proposals are listed, view tickets queued or building with no run in this
    process are
    queued again (dev.recover_views)."""
    from . import dev  # noqa: PLC0415

    dev.recover_views(c)


@router.get("/ws/{c}/views/proposals")
async def list_proposals_route(c: str) -> list[dict[str, Any]]:
    """The proposals. A held one, an orientation's proposal whose view has not passed its checks yet, is listed with
    `held` for the orientation's card, and the views bar leaves it out."""
    config.workspace_dir(c)
    _bind_loop()
    _recover(c)
    return list_proposals(c)


@router.get("/ws/{c}/views/suggestions")
async def suggestions_route(c: str, path: str) -> dict[str, Any]:
    """What thimble proposes for a file opened in the File browser (suggestion_for): whether a viewer may be proposed
    for its type, why not, the workspace's answer for the type, and the proposal for it when there is one."""
    config.workspace_dir(c)
    return await asyncio.to_thread(suggestion_for, c, path)


class SuggestBody(BaseModel):
    path: str


@router.post("/ws/{c}/views/suggest")
async def suggest_route(c: str, body: SuggestBody) -> dict[str, Any]:
    """Propose a viewer for the type of a file the analyst opened (suggest): {slug} of the suggested proposal, or null.
    It never fails for the analyst."""
    config.workspace_dir(c)
    _bind_loop()
    try:
        return {"slug": await suggest(c, body.path)}
    except Exception:  # noqa: BLE001 — a proposal thimble could not write is no proposal
        log.exception("the viewer suggestion for %s/%s failed", c, body.path)
        return {"slug": None}


@router.post("/ws/{c}/views/proposals/{slug}/accept")
async def accept_route(c: str, slug: str) -> dict[str, Any]:
    """Build a suggested viewer (accept); it comes back queued."""
    config.workspace_dir(c)
    _bind_loop()
    return accept(c, slug)


@router.post("/ws/{c}/views/proposals/{slug}/retry")
async def retry_route(c: str, slug: str) -> dict[str, Any]:
    """Queue a failed proposal, or a built view's failed change, again; it comes back `queued` (404 for none, 409 for
    one with nothing failed)."""
    config.workspace_dir(c)
    _bind_loop()
    return retry(c, slug)


class ViewMessage(BaseModel):
    text: str


@router.post("/ws/{c}/views/proposals/{slug}/message")
async def message_route(c: str, slug: str, body: ViewMessage) -> dict[str, Any]:
    """A message typed in the view's build thread: logged there and queued as a change to the view (message); answers
    the proposal."""
    config.workspace_dir(c)
    _bind_loop()
    return message(c, slug, body.text)


@router.delete("/ws/{c}/views/proposals/{slug}")
async def delete_proposal_route(c: str, slug: str) -> dict[str, Any]:
    config.workspace_dir(c)
    delete_proposal(c, slug)
    return {"ok": True}


@router.get("/ws/{c}/views")
async def list_views_route(c: str, path: str | None = None) -> list[dict[str, Any]]:
    """Every view; with `path` (a corpus-relative file) the working views that claim it (views_for)."""
    config.workspace_dir(c)
    _bind_loop()
    _recover(c)
    if path is None:
        return await asyncio.to_thread(lambda: [_public(v, c) for v in list_views(c)])
    return [_public(v) for v in views_for(c, path.strip().strip("/"))]


@router.get("/ws/{c}/views/{slug}")
async def get_view_route(c: str, slug: str) -> dict[str, Any]:
    return _public(_view_or_404(c, slug))


@router.delete("/ws/{c}/views/{slug}")
async def delete_view_route(c: str, slug: str) -> dict[str, Any]:
    config.workspace_dir(c)
    delete_view(c, slug)
    return {"ok": True}


@router.get("/ws/{c}/views/{slug}/frame")
async def frame_route(c: str, slug: str, request: Request, origin: str | None = None,
                      v: str | None = None) -> HTMLResponse:
    """The page as a frame loads it (frame_document), as srcdoc text, at version `v` when given (VERSIONS_SUBDIR): the
    records, marks and resolve routes then answer for the same version, so the page stays as loaded while the view
    changes. `origin` is the page's location.origin, since through Vite's proxy the request's host may not be one the
    browser can reach; without it, the request's host."""
    view = _view_or_404(c, slug, v)
    if not view["ok"]:
        raise HTTPException(409, f"the view {slug!r} has no reader.py, view.html or claims")
    try:
        media = media_url(origin or f"{request.url.scheme}://{request.url.netloc}", c, slug)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    derived = await derived_fields(c, slug, view, v)
    return HTMLResponse(await asyncio.to_thread(functools.partial(frame_document, view, media, derived=derived)))


@router.get("/ws/{c}/views/{slug}/media")
async def media_route(c: str, slug: str, path: str) -> FileResponse:
    """An image, audio or video file the view claims, after media_file's checks. FileResponse answers Range requests, so
    a
    player seeks without loading the file whole."""
    _view_or_404(c, slug)  # a draft's page loads its media only in the checks' headless page (shoot)
    f, media_type = await asyncio.to_thread(media_file, c, slug, path)
    return FileResponse(f, media_type=media_type, headers=MEDIA_HEADERS)


@router.get("/ws/{c}/media")
async def card_media_route(c: str, path: str) -> FileResponse:
    """A corpus media file for a card, after corpus_media_file's checks; ranges answered as media_route's are."""
    config.workspace_dir(c)
    f, media_type = await asyncio.to_thread(corpus_media_file, c, path)
    return FileResponse(f, media_type=media_type, headers=MEDIA_HEADERS)


class RecordsBody(BaseModel):
    query: Any = None


@router.post("/ws/{c}/views/{slug}/records")
async def records_route(c: str, slug: str, body: RecordsBody, v: str | None = None) -> dict[str, Any]:
    """reader.records(index, query): what the view's page, loaded at version `v`, asked for with thimble.fetch. 502 with
    the reader's error."""
    _view_or_404(c, slug, v)
    try:
        return {"data": await reader_call(c, slug, "records", body.query, version=v)}
    except ReaderError as e:
        raise HTTPException(502, {"message": e.message, "traceback": e.detail[-ERROR_MAX:]}) from None


@router.get("/ws/{c}/views/{slug}/problems")
async def problems_route(c: str, slug: str, v: str | None = None) -> dict[str, Any]:
    """The lines the view's reader could not read, {count, examples: [{ref, why}]} (reader_problems). 502 with the
    reader's error."""
    _view_or_404(c, slug, v)
    try:
        return await reader_problems(c, slug, v)
    except ReaderError as e:
        raise HTTPException(502, {"message": e.message, "traceback": e.detail[-ERROR_MAX:]}) from None


@router.get("/ws/{c}/views/{slug}/shown")
async def shown_route(c: str, slug: str, v: str | None = None) -> dict[str, Any]:
    """What the view does not show and what it derived, the two menus above its page (shown). 502 with the reader's
    error."""
    _view_or_404(c, slug, v)
    try:
        return await shown(c, slug, v)
    except ReaderError as e:
        raise HTTPException(502, {"message": e.message, "traceback": e.detail[-ERROR_MAX:]}) from None


class MarksBody(BaseModel):
    refs: list[str] = []


MARKS_MAX = 2000  # refs one marks request answers


@router.post("/ws/{c}/views/{slug}/marks")
async def marks_route(c: str, slug: str, body: MarksBody, v: str | None = None) -> dict[str, Any]:
    """The marks of the labels that are on for refs the view's page shows, {ref: {bar, names, spans, keep?}} (marks_for):
    its units' refs above all, which the browser cannot mark from the label rows it reads. 502 with the reader's error."""
    _view_or_404(c, slug, v)
    try:
        return await marks_for(c, slug, [str(r) for r in body.refs][:MARKS_MAX], version=v)
    except ReaderError as e:
        raise HTTPException(502, {"message": e.message, "traceback": e.detail[-ERROR_MAX:]}) from None


@router.get("/ws/{c}/views/{slug}/resolve")
async def resolve_route(c: str, slug: str, ref: str, v: str | None = None) -> dict[str, Any]:
    """The `open` message for a ref in this view, at version `v` when given: {ref, path?, fragment?, key?, target,
    label, excerpt, refs} or with `error` when the reader does not know it; `{ref: null}` for a ref with no locator."""
    _view_or_404(c, slug, v)
    return await open_place(c, slug, ref, locator_of(ref), v)


class CheckBody(BaseModel):
    locators: list[str] | None = None
    picture: bool = False


@router.post("/ws/{c}/views/{slug}/check")
async def check_route(c: str, slug: str, request: Request, body: CheckBody | None = None) -> dict[str, Any]:
    """A view ticket's session checking its draft: the gate with `locators` beside the sampled lines, {ok, lines, png},
    `png` the picture of the page as it opens when `picture` asks for one. The locators are kept on the proposal for the
    server's gate after the turn. Loopback only, and like every write only with the token's proof (view_check.py) or
    the analyst's cookie (hook_auth.LocalWriteGuard)."""
    from . import dev  # noqa: PLC0415

    if not dev._is_loopback(request):
        raise HTTPException(403, "a view's checks run from localhost only")
    config.workspace_dir(c)
    _check_slug(slug)
    _bind_loop()
    locators = [str(x).strip() for x in (body.locators if body and body.locators else []) if str(x).strip()]
    if locators and read_proposal(c, slug) is not None:
        update_proposal(c, slug, locators=locators)
    report = await gate(c, slug, locators or _kept_locators(c, slug), picture=bool(body and body.picture))
    return {"ok": bool(report.get("ok")), "lines": gate_lines(report), "png": (report.get("page") or {}).get("png")}


def _kept_locators(c: str, slug: str) -> list[str] | None:
    """The locators the session last checked, which the server's gate checks again (None for none)."""
    prop = read_proposal(c, slug) or {}
    kept = prop.get("locators")
    return [str(x) for x in kept] if isinstance(kept, list) and kept else None
