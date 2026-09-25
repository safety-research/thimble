"""The card harness: a card drawn offscreen with the app's own card face and shot as a PNG, so the card check
(card_check.py) sees the card as the analyst will.

One headless Chromium keeps POOL_PAGES pages loaded on `render.html` (frontend/src/render.tsx), which mounts CardFace
with a stub canvas context. Each request carries everything the page needs (the card, its resolved refs, card and
label names, cited calls, the theme), so the page never calls the API. The page comes from THIMBLE_RENDER_URL, the
Vite dev server in dev mode, or the built UI served from memory at RENDER_ORIGIN. A page is replaced after
RECYCLE_AFTER renders or any failure; without Playwright or its Chromium, available() is False and why() says why."""
from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config

log = logging.getLogger("thimble.render")

POOL_PAGES = max(1, int(os.environ.get("THIMBLE_RENDER_PAGES", "4") or "4"))
RECYCLE_AFTER = 200  # renders a page serves before it is replaced
RENDER_TIMEOUT_S = float(os.environ.get("THIMBLE_RENDER_TIMEOUT_S", "8") or "8")
PAGE_LOAD_TIMEOUT_S = 30.0
SCALE = 2  # device pixels per CSS pixel, what a retina display shows
VIEWPORT = {"width": 1280, "height": 1000}  # a taller card is shot beyond the viewport
CARD_W = 720  # frontend/src/canvas/layout.ts CARD_W: a card's width when it has none of its own
RENDER_ORIGIN = "http://thimble.render"
RENDER_PAGE = "render.html"
THEMES_FILE = "render-theme.json"  # workspaces/<c>/: the theme the analyst's browser last reported
PAPERS = ("warm", "neutral", "dark")  # frontend/src/lib/theme.ts
ACCENTS = ("pink", "orange", "yellow", "lime", "blue", "iris", "graphite")
DEFAULT_THEME = {"paper": "warm", "accent": "iris"}
_TAKEAWAY_REF = re.compile(r"\[\[(?:[^\[\]|]*\|)?([^\[\]|]+?)\]\]")


def enabled() -> bool:
    """Whether the harness may run here: THIMBLE_RENDER unset or on (the test suite turns it off in conftest.py)."""
    return os.environ.get("THIMBLE_RENDER", "on").strip().lower() not in ("0", "off", "false", "no")


@dataclass
class Rendered:
    """One card drawn: `png` the card at SCALE (None when the page failed), its box in CSS px, whether the fonts the
    card asks for were loaded, the API paths the page asked for that the request did not answer, and the times in ms."""

    png: bytes | None = None
    box: dict[str, float] = field(default_factory=dict)
    fonts: bool = True
    requests: list[str] = field(default_factory=list)
    ms: dict[str, float] = field(default_factory=dict)
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error and self.png is not None


class Unavailable(RuntimeError):
    """The harness cannot draw here: no Playwright, no Chromium, no render page, or THIMBLE_RENDER is off."""


# --------------------------------------------------------------------------- the page's source


def page_source() -> tuple[str, Path | None]:
    """(the URL the pool's pages open, the folder served at RENDER_ORIGIN or None when the URL is a server's)."""
    url = os.environ.get("THIMBLE_RENDER_URL", "").strip()
    if url:
        return url, None
    if os.environ.get("THIMBLE_DEV", "").strip().lower() in ("1", "true", "yes", "on"):  # main.dev_mode's rule
        front = os.environ.get("THIMBLE_FRONTEND_URL", "").strip().rstrip("/")
        if front:
            return f"{front}/{RENDER_PAGE}", None
    folder = Path(os.environ.get("THIMBLE_RENDER_DIR", "").strip() or config.FRONTEND_DIST)
    return f"{RENDER_ORIGIN}/{RENDER_PAGE}", folder


def _serve_path(folder: Path, url: str) -> Path | None:
    """The file of `folder` a request for `url` at RENDER_ORIGIN names; None outside the folder or for a missing file."""
    rel = urlsplit(url).path.lstrip("/") or RENDER_PAGE
    try:
        p = (folder / rel).resolve()
        root = folder.resolve()
    except OSError:
        return None
    if root != p and root not in p.parents:
        return None
    return p if p.is_file() else None


# --------------------------------------------------------------------------- the pool


class Pool:
    """One headless Chromium and its warm pages (module note). Every method is safe to call from any task; render()
    waits for a free page."""

    def __init__(self, pages: int = POOL_PAGES) -> None:
        self.size = pages
        self._pw: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._free: asyncio.Queue[Any] | None = None
        self._uses: dict[int, int] = {}
        self._lock = asyncio.Lock()
        self._started = False
        self.why = ""
        self.launch_ms = 0.0
        self._warned_fonts = False

    @property
    def ready(self) -> bool:
        return self._started and self._browser is not None and self._browser.is_connected()

    async def start(self) -> bool:
        """Launch the browser and load its pages; False (and `why`) when it cannot. A second call while running is a
        no-op."""
        async with self._lock:
            if self.ready:
                return True
            await self._close()
            t0 = time.perf_counter()
            try:
                from playwright.async_api import async_playwright  # noqa: PLC0415 — optional until install.sh ran
            except ImportError:
                self.why = "Playwright is not installed in backend/.venv (scripts/install.sh installs it)"
                return False
            url, folder = page_source()
            if folder is not None and _serve_path(folder, url) is None:
                self.why = f"there is no {RENDER_PAGE} in {folder} (build the UI, or set THIMBLE_RENDER_DIR)"
                return False
            try:
                self._pw = await async_playwright().start()
                self._browser = await self._pw.chromium.launch(headless=True)
                self._context = await self._browser.new_context(viewport=VIEWPORT, device_scale_factor=SCALE,
                                                                reduced_motion="reduce")
                if folder is not None:
                    await self._context.route(f"{RENDER_ORIGIN}/**", lambda route: _fulfil(route, folder))
                # nothing leaves the machine: a page asset from another origin (a web font's stylesheet) is refused, so
                # a render never waits on the network and draws the same offline
                await self._context.route(re.compile(r"^https?://(?!127\.0\.0\.1|localhost|thimble\.render)"),
                                          lambda route: route.abort())
                pages = await asyncio.gather(*(self._new_page(url) for _ in range(self.size)))
            except Exception as e:  # noqa: BLE001 — a missing browser, a page that did not load: the harness is off
                self.why = _launch_why(e)
                log.warning("render: the harness could not start: %s", self.why)
                await self._close()
                return False
            self._free = asyncio.Queue()
            for p in pages:
                self._free.put_nowait(p)
            self._started = True
            self.why = ""
            self.launch_ms = round((time.perf_counter() - t0) * 1000, 1)
            log.info("render: %d pages ready from %s in %.0f ms", self.size, url, self.launch_ms)
            return True

    async def _new_page(self, url: str) -> Any:
        page = await self._context.new_page()
        await page.goto(url, wait_until="load", timeout=PAGE_LOAD_TIMEOUT_S * 1000)
        await page.wait_for_function("() => !!(window.__thimbleRender && window.__thimbleRender.ready)",
                                     timeout=PAGE_LOAD_TIMEOUT_S * 1000)
        self._uses[id(page)] = 0
        return page

    async def _replace(self, page: Any) -> None:
        """A fresh page in place of `page` (recycled or failed), in the background of the render that returned it."""
        self._uses.pop(id(page), None)
        try:
            await page.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            fresh = await self._new_page(page_source()[0])
        except Exception:  # noqa: BLE001 — the browser went away: the next render launches it again
            log.warning("render: a page could not be replaced", exc_info=True)
            self._started = False
            return
        if self._free is not None:
            self._free.put_nowait(fresh)

    async def render(self, request: dict[str, Any], *, timeout_s: float = RENDER_TIMEOUT_S) -> Rendered:
        """Draw one card (module note, a render). Raises Unavailable when the harness cannot run; any other failure is a
        Rendered with `error`."""
        if not self.ready and not await self.start():
            raise Unavailable(self.why or "the harness is not running")
        assert self._free is not None
        page = await self._free.get()
        t0 = time.perf_counter()
        broken = False
        res = Rendered()
        try:
            await asyncio.wait_for(self._render_on(page, request, res), timeout_s)
            return res
        except asyncio.TimeoutError:
            broken = True
            res.error = res.error or f"the card did not settle within {timeout_s:g} s"
            res.ms.setdefault("total", round((time.perf_counter() - t0) * 1000, 1))
            return res
        except Exception as e:  # noqa: BLE001 — a page error is the card's finding, and the page is replaced
            broken = True
            log.warning("render: the page failed", exc_info=True)
            res.error = res.error or f"the render page failed: {type(e).__name__}: {str(e)[:300]}"
            res.ms.setdefault("total", round((time.perf_counter() - t0) * 1000, 1))
            return res
        finally:
            self._uses[id(page)] = self._uses.get(id(page), 0) + 1
            if broken or self._uses.get(id(page), 0) >= RECYCLE_AFTER:
                asyncio.get_running_loop().create_task(self._replace(page), name="render-replace-page")
            elif self._free is not None:
                self._free.put_nowait(page)

    async def _render_on(self, page: Any, request: dict[str, Any], res: Rendered) -> None:
        t0 = time.perf_counter()
        out = await page.evaluate("(req) => window.__thimbleRender.render(req)", request)
        t1 = time.perf_counter()
        res.box = out.get("box") or {}
        res.fonts = bool(out.get("fonts", True))
        res.requests = list(out.get("requests") or [])
        res.error = str(out.get("error") or "")
        if not res.fonts and not self._warned_fonts:
            # a fallback face changes every width the card is drawn at: the page's own faces did not load
            self._warned_fonts = True
            log.warning("render: the render page drew in a fallback face (its fonts did not load)")
        if not res.error and res.box.get("width"):
            res.png = await page.screenshot(clip=_clip(res.box), full_page=True, type="png", animations="disabled",
                                            caret="hide")
        t2 = time.perf_counter()
        page_ms = {k: v for k, v in (out.get("ms") or {}).items() if isinstance(v, (int, float))}
        res.ms = {"page": round((t1 - t0) * 1000, 1), "shot": round((t2 - t1) * 1000, 1),
                  "total": round((t2 - t0) * 1000, 1), **page_ms}

    async def stop(self) -> None:
        async with self._lock:
            await self._close()

    async def _close(self) -> None:
        self._started = False
        self._free = None
        self._uses.clear()
        for thing, how in ((self._context, "close"), (self._browser, "close"), (self._pw, "stop")):
            if thing is not None:
                try:
                    await getattr(thing, how)()
                except Exception:  # noqa: BLE001
                    pass
        self._context = self._browser = self._pw = None


async def _fulfil(route: Any, folder: Path) -> None:
    p = _serve_path(folder, route.request.url)
    if p is None:
        await route.fulfill(status=404, body="")
        return
    ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    if p.suffix in (".js", ".mjs"):
        ctype = "text/javascript"
    await route.fulfill(status=200, body=p.read_bytes(), headers={"content-type": ctype})


def _clip(box: dict[str, float]) -> dict[str, float]:
    """A box snapped outward to whole CSS px, so the picture holds the card's hairline border on every side."""
    x, y = int(box.get("x", 0)), int(box.get("y", 0))
    w = int(-(-(box.get("x", 0) + box.get("width", 0)) // 1)) - x
    h = int(-(-(box.get("y", 0) + box.get("height", 0)) // 1)) - y
    return {"x": x, "y": y, "width": max(1, w), "height": max(1, h)}


def _launch_why(e: Exception) -> str:
    """Why the browser did not start, with the command that fixes it: the browser was never fetched, or the machine
    lacks the system libraries it links (a bare Linux server; Playwright names them)."""
    text = str(e)
    if "missing dependencies" in text or "install-deps" in text:
        return ("this machine lacks the system libraries headless Chromium needs: run `sudo backend/.venv/bin/python -m "
                "playwright install-deps chromium-headless-shell`")
    if "Executable doesn't exist" in text or "playwright install" in text:
        return "Playwright's Chromium is not installed: run `backend/.venv/bin/python -m playwright install chromium-headless-shell`"
    return f"{type(e).__name__}: {text.splitlines()[0][:300] if text else ''}"


_pool: Pool | None = None


def pool() -> Pool:
    global _pool
    if _pool is None:
        _pool = Pool()
    return _pool


def available() -> bool:
    """Whether a render can run now without a launch (the pool is up)."""
    return enabled() and _pool is not None and _pool.ready


def why() -> str:
    if not enabled():
        return "THIMBLE_RENDER is off"
    return pool().why


async def start() -> bool:
    return enabled() and await pool().start()


async def shutdown() -> None:
    """main's lifespan hook: the browser goes with the server."""
    global _pool
    if _pool is not None:
        await _pool.stop()
        _pool = None


# --------------------------------------------------------------------------- the request


def cited_refs(cell: dict[str, Any]) -> list[str]:
    """Every ref a card's page resolves: its takeaway's citations (value refs and bare refs) and an example card's
    records, each once, in order."""
    out: list[str] = []
    for m in _TAKEAWAY_REF.finditer(str(cell.get("takeaway") or "")):
        ref = m.group(1).strip()
        if ref and ref not in out:
            out.append(ref)
    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    for ref in payload.get("refs") or []:
        if isinstance(ref, str) and ref.strip() and ref.strip() not in out:
            out.append(ref.strip())
    return out


def resolve_all(c: str, refs: list[str]) -> dict[str, Any]:
    """{ref: what GET /corpora/{c}/ref returns for it}; a ref that does not resolve maps to {error, status}, which the
    page's stub answers with that status, as the API would."""
    from . import refs as refs_mod  # noqa: PLC0415 — refs imports views and notebook lazily; kept off import time

    try:
        corpus = config.corpus_dir(c)
    except ValueError as e:
        return {r: {"error": str(e), "status": 404} for r in refs}
    out: dict[str, Any] = {}
    for r in refs:
        try:
            out[r] = refs_mod.resolve(corpus, r)
        except refs_mod.RefError as e:
            out[r] = {"error": str(e.detail), "status": e.status}
        except Exception as e:  # noqa: BLE001 — one bad ref never stops the card's render
            out[r] = {"error": f"{type(e).__name__}: {e}", "status": 500}
    return out


def card_names(c: str, refs: list[str], own: dict[str, Any]) -> list[dict[str, str]]:
    """The names (question) of the card and of every card a ref names, as GET /ws/{c}/cells/names lists them, so a
    chip reads as the canvas shows it."""
    from . import cite, notebook  # noqa: PLC0415

    ids = {str(own.get("id") or "")}
    for r in refs:
        if cite.is_card_ref(r):
            m = re.match(cite.CARD_RE + r"([A-Za-z0-9_-]+)", r)
            if m:
                ids.add(m.group(1))
    out = []
    for cid in sorted(i for i in ids if i):
        cell = own if cid == own.get("id") else notebook.get_cell(c, cid)
        if cell:
            out.append({"id": cid, "notebook": str(cell.get("notebook") or ""), "title": str(cell.get("title") or "")})
    return out


def label_names(c: str, cell: dict[str, Any]) -> list[dict[str, Any]]:
    """The labels the card uses, each with its name, colour source and revision, as GET /ws/{c}/concepts lists them; a
    label that is gone is left out."""
    from . import concepts  # noqa: PLC0415 — concepts imports the notebook machinery

    ids = [str(x) for x in (cell.get("labels") or []) if x]
    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    if cell.get("kind") == "label" and payload.get("concept"):
        ids.append(str(payload["concept"]))
    out = []
    for cid in dict.fromkeys(ids):
        try:
            _, concept = concepts.load_concept(c, cid)
        except Exception:  # noqa: BLE001 — a label that is gone draws no chip, as on the canvas
            continue
        out.append({"id": cid, "name": str(concept.get("name") or ""), "unit": concept.get("unit"),
                    "marks": concept.get("marks"), "labels": list(concept.get("labels") or []),
                    "classes": list(concept.get("classes") or []), "rev": concept.get("rev", 0),
                    "changes": list(concept.get("changes") or [])})
    return out


def call_part(c: str, refs: list[str]) -> dict[str, Any]:
    """{"calls": {"<chat>/<n>": the call as GET /ws/{c}/calls/{chat}/{n} returns it}} for the calls the refs cite, so a
    call
    citation's preview can load; a call not in the store is left out."""
    from . import calls  # noqa: PLC0415 — calls imports the chat machinery; kept off import time

    out: dict[str, Any] = {}
    for r in refs:
        p = calls.parse_ref(r)
        key = f"{p['chat_id']}/{p['n']}" if p else ""
        if not key or key in out:
            continue
        try:
            out[key] = calls.whole(c, p["chat_id"], p["n"])
        except Exception:  # noqa: BLE001 — one call that is gone never stops the card's render
            continue
    return {"calls": out} if out else {}


def theme(c: str) -> dict[str, str]:
    """The theme the analyst's browser last reported for workspace `c` (PUT /ws/{c}/render/theme), else Warm and iris."""
    try:
        data = json.loads((config.workspace_dir(c) / THEMES_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return dict(DEFAULT_THEME)
    paper = data.get("paper") if data.get("paper") in PAPERS else DEFAULT_THEME["paper"]
    accent = data.get("accent") if data.get("accent") in ACCENTS else DEFAULT_THEME["accent"]
    return {"paper": paper, "accent": accent}


LABEL_ROWS = 3  # the rows of each value a label card's face picks its example from (canvas/bodies.tsx EXAMPLE_ROWS)


def label_data(c: str, cell: dict[str, Any]) -> dict[str, Any] | None:
    """What a label card's face reads from the API: the label, the first LABEL_ROWS rows of each value, and the
    workspace
    settings. None for any other card or a label that is gone."""
    payload = cell.get("payload") if cell.get("kind") == "label" else None
    concept_id = str(payload.get("concept") or "") if isinstance(payload, dict) else ""
    if not concept_id:
        return None
    from functools import partial  # noqa: PLC0415

    from . import concepts, ledger  # noqa: PLC0415 — both import the notebook machinery

    try:
        ws, concept = concepts.load_concept(c, concept_id)
    except Exception:  # noqa: BLE001 — a label that is gone draws as the canvas draws it, without its label
        return None
    detail = concepts.with_stats(ws, concepts.coloured(ws, concept))
    values = list(dict.fromkeys([*(str(v) for v in detail.get("labels") or [] if v),
                                 *(str(v) for v in (detail.get("counts") or {}) if v)]))
    texts = partial(concepts.unit_texts, c, concept)
    rows = {v: concepts.concept_rows(ws, concept_id, v, LABEL_ROWS, 0, texts).get("rows") or [] for v in values}
    try:
        settings = ledger.get_settings(c)
    except Exception:  # noqa: BLE001 — without the settings a prompt label's model goes unnamed
        settings = {}
    return json.loads(json.dumps({"concept": detail, "rows": rows, "settings": settings}, default=str))


def request_for(c: str, cell: dict[str, Any], *, width: int | None = None) -> dict[str, Any]:
    """The render request for one card as it stands (module note, the page): the card as the canvas reads it, its refs
    resolved, the cards they name, the theme and the width, and for a label card its label (label_data), whose rows
    without their own text are quoted from the records their refs resolve to."""
    refs = cited_refs(cell)
    label = label_data(c, cell)
    for rows in (label or {}).get("rows", {}).values():
        for r in rows:
            ref = str(r.get("ref") or "") if isinstance(r, dict) else ""
            if ref and not str(r.get("text") or "").strip() and ref not in refs:
                refs.append(ref)
    w = width or cell.get("width") or CARD_W
    # the card as it will stand at rest: check records, earlier fixes and a fix candidate's mark are not its content
    card = {k: v for k, v in cell.items() if k not in ("check", "fixes", "candidate")}
    return {
        "ws": c,
        "card": card,
        "citations": resolve_all(c, refs),
        **call_part(c, refs),
        "names": card_names(c, refs, cell),
        "labels": label_names(c, cell),
        "theme": theme(c),
        "width": int(w) if isinstance(w, (int, float)) and w > 0 else CARD_W,
        **({"label": label} if label else {}),
    }


async def render_card(c: str, cell: dict[str, Any], *, width: int | None = None,
                      timeout_s: float = RENDER_TIMEOUT_S) -> Rendered:
    """One card of workspace `c` drawn now (Unavailable when the harness cannot run)."""
    if not enabled():
        raise Unavailable("THIMBLE_RENDER is off")
    req = await asyncio.to_thread(request_for, c, cell, width=width)
    return await pool().render(req, timeout_s=timeout_s)


# --------------------------------------------------------------------------- routes

async def _lifespan(app: Any):
    """The router's lifespan (FastAPI merges it into the app's): the browser is launched in the background, so the
    server answers at once and the first card finds the pool warm."""
    task = asyncio.get_running_loop().create_task(start(), name="render-start") if enabled() else None
    yield
    if task is not None and not task.done():
        task.cancel()


router = APIRouter(lifespan=_lifespan)


class ThemeBody(BaseModel):
    paper: str
    accent: str


@router.put("/ws/{c}/render/theme")
async def put_theme(c: str, body: ThemeBody) -> dict[str, str]:
    """The browser reports its paper and accent (lib/theme.ts), so a card is drawn offscreen in the analyst's colours."""
    if body.paper not in PAPERS or body.accent not in ACCENTS:
        raise HTTPException(400, f"paper must be one of {', '.join(PAPERS)} and accent one of {', '.join(ACCENTS)}")
    try:
        p = config.workspace_dir(c) / THEMES_FILE
    except ValueError as e:
        raise HTTPException(404, str(e))
    p.write_text(json.dumps({"paper": body.paper, "accent": body.accent}), "utf-8")
    return {"paper": body.paper, "accent": body.accent}


@router.get("/render/status")
async def status() -> dict[str, Any]:
    """Whether the harness runs, and why not."""
    return {"enabled": enabled(), "ready": available(), "why": why(), "pages": POOL_PAGES,
            "source": page_source()[0]}
