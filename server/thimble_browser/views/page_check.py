"""The view builder's check of a view's page: the page loaded in headless Chromium as the analyst's browser loads it.

The reader's check (views.check) runs reader.py, but nothing there draws view.html, so a page that throws or shows
nothing was caught only when the analyst opened it. This check loads the page's frame (views.frame_document) in a
sandboxed iframe of a page that plays the part the app plays (frontend/src/files/ViewerFrame.tsx): it answers the page's
`thimble.fetch` calls from the view's reader, run in the card sandbox as for the analyst, and sends the open message.
Once the page has been quiet for QUIET_S it is measured. It fails on an uncaught error, an error the page reports, a
load the frame's policy refused, a request for anything off the page, and a page that shows nothing. It saves a picture
of the page (`check.png` in the view's folder), which the builder's view_check gives back.

Safety. Chromium runs as a child of the server with its own sandbox on (chromium_sandbox=True), never inside
bubblewrap. Every request the page makes is answered by this module, never by the network: the host page and the
view's media files from the folder (each with the media route's checks), every other request aborted, and no host
name resolves, so not even a DNS lookup leaves. The browser has
no user profile (a fresh context in a temporary folder that is removed after), no downloads, and the whole check stops
after LIMIT_S. Where Chromium cannot start, or cannot start its sandbox, the check is skipped with a line that says why.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
import time
from pathlib import Path
from typing import Any

from .. import corpus
from ..readers import refs

LIMIT_S = 90.0  # the whole check, Chromium's start included
READY_S = 15.0  # until the page's bridge says it is ready
QUIET_S = 0.9  # no fetch running and nothing new for this long: the page has settled
HARD_S = 30.0  # after open, the page is measured at this point if it never settles
VIEWPORT = {"width": 1200, "height": 800}
HOST = "http://thimble.invalid/view-check"  # the page that holds the frame; Chromium never asks the network for it
MEDIA = "http://thimble.invalid/media"  # the view's media route inside the check
MEDIA_MAX = 32 * 1024 * 1024  # bytes of one media file the check serves
ERRORS_MAX = 12
TOKENS = Path(__file__).resolve().parents[3] / "frontend" / "src" / "styles" / "tokens.css"
SHOT = "check.png"
ARGS = ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-extensions",
        "--disable-component-update",
        # no host name resolves, so not even a DNS lookup (a prefetch hint) leaves
        "--host-resolver-rules=MAP * ~NOTFOUND", "--dns-prefetch-disable"]
NO_RTC = ("<script>for(const k of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel'])try{"
          "Object.defineProperty(window,k,{value:undefined})}catch{}</script>")

# The host page's script: it puts the frame in its sandboxed iframe and plays the app's half of the bridge.
HOST_JS = r"""
(doc) => {
  const f = document.getElementById('f')
  const post = (msg) => f.contentWindow.postMessage(msg, '*')
  const labels = () => post({ type: 'thimble:labels', marks: {}, on: [], filter: null, all: [], palette: [], answered: -1 })
  window.__ready = false
  window.__height = null
  addEventListener('message', async (e) => {
    if (e.source !== f.contentWindow) return
    const d = e.data || {}
    if (d.type === 'thimble:ready') {
      window.__ready = true
      post({ type: 'thimble:key', key: 'check' })
      labels()
      post({ type: 'thimble:open', open: { ref: null, query: null } })
    } else if (d.type === 'thimble:fetch') {
      const got = await window.thimbleFetch(d.query)
      post({ type: 'thimble:result', id: d.id, data: got.data, error: got.error })
    } else if (d.type === 'thimble:anchors') {
      labels()
    } else if (d.type === 'thimble:error') {
      window.thimbleNote('error', String(d.message || 'the view failed'))
    } else if (d.type === 'thimble:size') {
      window.__height = d.height
    } else if (d.type === 'thimble:labelCall') {
      post({ type: 'thimble:labelDone', id: d.id, error: 'no labels in the check' })
    }
  })
  f.srcdoc = doc
}
"""

# What the frame shows once settled, read inside the frame: its text, and its visible elements that draw something.
MEASURE_JS = r"""
() => {
  const body = document.body
  if (!body) return { text: 0, drawn: 0, anchors: 0 }
  const W = innerWidth, H = innerHeight
  let drawn = 0
  for (const el of body.querySelectorAll('svg, canvas, img, video, table, [data-anchor]')) {
    const r = el.getBoundingClientRect()
    if (r.width > 4 && r.height > 4 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H) drawn++
  }
  return { text: (body.innerText || '').trim().length, drawn, anchors: body.querySelectorAll('[data-anchor]').length }
}
"""


def _frame_doc(doc: str) -> str:
    """The frame document as the app hands it to the iframe: no WebRTC, the theme's tokens, then the page."""
    tokens = TOKENS.read_text(encoding="utf-8") if TOKENS.is_file() else ""
    style = NO_RTC + ("<style>" + tokens.replace("</style", "<\\/style") + "</style>" if tokens else "")
    at = doc.lower().find("<head>")
    return doc[:at + 6] + style + doc[at + 6:] if at >= 0 else style + doc


def _host_html() -> str:
    return ('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fbfaf7">'
            '<iframe id="f" sandbox="allow-scripts" style="border:0;width:100%;height:100vh;display:block">'
            "</iframe></body></html>")


async def _launch(pw: Any, tmp: str) -> Any:
    """Headless Chromium with its own sandbox: the check's only way to start it. Its environment is a temporary folder
    as its home and nothing else of the server's, and Playwright gives it a fresh profile that is removed after."""
    return await pw.chromium.launch(headless=True, chromium_sandbox=True, downloads_path=tmp,
                                    env={"HOME": tmp, "TMPDIR": tmp, "XDG_CONFIG_HOME": tmp, "XDG_CACHE_HOME": tmp,
                                         "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                                    args=ARGS)


def _media_answer(folder: Path, claims: list[str], url: str) -> tuple[int, bytes, str]:
    """(status, body, type) for a request to the check's media route: an image, audio or video file the view claims,
    with the media route's checks (media.media_file)."""
    from urllib.parse import parse_qs, urlparse  # noqa: PLC0415

    from .. import views  # noqa: PLC0415

    rel = (parse_qs(urlparse(url).query).get("path") or [""])[0]
    parts = rel.split("/")
    media_type = refs.MEDIA_TYPES.get(Path(rel).suffix.lower())
    if not rel or "\\" in rel or any(not x or x.startswith(".") for x in parts) or media_type is None:
        return 400, b"", "text/plain"
    if not views.claims_path(claims, rel):
        return 403, b"", "text/plain"
    try:
        p = corpus.inside(folder, rel)
    except corpus.OutsideFolder:
        return 404, b"", "text/plain"
    if not p.is_file() or p.stat().st_size > MEDIA_MAX:
        return 404, b"", "text/plain"
    return 200, p.read_bytes(), media_type


async def run(ws: str, slug: str, folder: Path) -> dict[str, Any]:
    """{lines, shot}: the check's lines (each failure a line, a pass `ok: ...`, a skip `skipped: ...`) and the picture's
    path, None without one."""
    try:
        from playwright.async_api import async_playwright  # noqa: PLC0415
    except ImportError:
        return {"lines": ["skipped: the page was not drawn, since the server has no Playwright (install the "
                          "`pagecheck` extra, then `playwright install chromium`)"], "shot": None}
    try:
        return await asyncio.wait_for(_check(async_playwright, ws, slug, folder), LIMIT_S)
    except asyncio.TimeoutError:
        return {"lines": [f"the page check stopped after {LIMIT_S:.0f} s: the page did not settle in that time"],
                "shot": None}


async def _check(async_playwright: Any, ws: str, slug: str, folder: Path) -> dict[str, Any]:
    from .. import views  # noqa: PLC0415

    d = views.view_dir(ws, slug)
    meta = views.read_meta(d) or {}
    claims = views.claims_of(meta)
    doc = _frame_doc(views.frame_document((d / "view.html").read_text(encoding="utf-8"), slug,
                                          str(meta.get("name") or slug), libs=list(meta.get("libs") or []),
                                          media=MEDIA))
    errors: list[str] = []
    refused: list[str] = []
    state = {"inflight": 0, "fetches": 0, "last": time.monotonic()}

    def note(line: str) -> None:
        state["last"] = time.monotonic()
        if len(errors) < ERRORS_MAX and line not in errors:
            errors.append(line[:400])

    async def fetch(query: Any) -> dict[str, Any]:
        state["inflight"] += 1
        state["fetches"] += 1
        state["last"] = time.monotonic()
        try:
            got = await views.run_reader(ws, slug, folder, "records", query)
        finally:
            state["inflight"] -= 1
            state["last"] = time.monotonic()
        if not got.get("ok"):
            note(f"thimble.fetch({json.dumps(query)[:200]}) failed in the reader: {got.get('error')}")
            return {"error": str(got.get("error") or "the reader failed")}
        return {"data": got.get("result")}

    async def route(r: Any) -> None:
        url = r.request.url
        if url == HOST:
            await r.fulfill(status=200, content_type="text/html", body=_host_html())
        elif url == MEDIA or url.startswith(MEDIA + "?"):
            status, body, media_type = await asyncio.to_thread(_media_answer, folder, claims, url)
            if status != 200:
                note(f"thimble.mediaUrl: {url[len(MEDIA):][:200]} is no image, audio or video file the view claims")
            await r.fulfill(status=status, body=body, content_type=media_type)
        else:
            refused.append(url[:200])
            await r.abort()

    with tempfile.TemporaryDirectory(prefix="thimble-page-check-") as tmp:
        try:
            pw_cm = async_playwright()
            pw = await pw_cm.__aenter__()
        except Exception as e:  # noqa: BLE001 — no driver: the check is skipped
            return {"lines": [f"skipped: the page was not drawn, since Playwright did not start ({_plain(e)})"],
                    "shot": None}
        try:
            try:
                browser = await _launch(pw, tmp)
            except Exception as e:  # noqa: BLE001
                why = _plain(e)
                if "sandbox" in why.lower():
                    why = ("Chromium cannot start its own sandbox on this machine, and the check never runs it "
                           "without one")
                elif "executable doesn't exist" in why.lower():
                    why = "Chromium is not installed (run `playwright install chromium`)"
                return {"lines": [f"skipped: the page was not drawn: {why}"], "shot": None}
            try:
                shot = views.view_dir(ws, slug) / SHOT
                shown = await _draw(browser, doc, route, fetch, note, state, shot)
            except Exception as e:  # noqa: BLE001 — a page that crashed Chromium's renderer, or a broken check
                return {"lines": [f"the page could not be drawn: {_plain(e)}"], "shot": None}
            finally:
                await browser.close()
        finally:
            await pw_cm.__aexit__(None, None, None)
    lines = []
    csp = [e for e in errors if "Content Security Policy" in e]
    lines += [f"the frame's policy refused a load: {e}" for e in csp]
    lines += [f"the page failed: {e}" for e in errors if e not in csp and not e.startswith("console: Failed to load")]
    lines += [f"the page asked for {u}, but a view loads nothing from the network: inline what it needs, or name a "
              "library in `libs`" for u in dict.fromkeys(refused)]
    if not shown["text"] and not shown["drawn"]:
        lines.append("the page shows nothing after it settled: no text, and no chart, table, image or anchored "
                     "element in view")
    if not lines:
        lines.append(f"ok: the page drew in headless Chromium after {state['fetches']} fetch(es): "
                     f"{shown['text']} characters of text, {shown['drawn']} elements in view, {shown['anchors']} "
                     "with data-anchor")
    w, h = VIEWPORT["width"], VIEWPORT["height"]
    lines.append(f"ok: a picture of the page as the analyst first sees it, {w}x{h}, is {shot.name} in the view's folder")
    return {"lines": lines, "shot": str(shot)}


async def _draw(browser: Any, doc: str, route: Any, fetch: Any, note: Any, state: dict[str, Any],
                shot: Path) -> dict[str, Any]:
    """Load the frame in the host page, answer it until it settles, measure what it shows and take its picture."""
    context = await browser.new_context(viewport=VIEWPORT, accept_downloads=False, service_workers="block")
    try:
        page = await context.new_page()
        await page.add_init_script(NO_RTC[len("<script>"):-len("</script>")])
        await page.route("**/*", route)
        page.on("console", lambda m: m.type == "error" and note(f"console: {m.text}"))
        page.on("pageerror", lambda e: note(f"uncaught: {e}"))
        await page.expose_function("thimbleFetch", fetch)
        await page.expose_function("thimbleNote", lambda kind, text: note(f"the page reported: {text}"))
        await page.goto(HOST)
        await page.evaluate(HOST_JS, doc)
        t0 = time.monotonic()
        while not await page.evaluate("() => window.__ready") and time.monotonic() - t0 < READY_S:
            await asyncio.sleep(0.05)
        if not await page.evaluate("() => window.__ready"):
            note("the page never said it was ready: the view kit did not load, or a script stopped it")
        start = time.monotonic()
        state["last"] = max(state["last"], start)
        while True:
            await asyncio.sleep(0.1)
            now = time.monotonic()
            if state["inflight"] == 0 and now - state["last"] > QUIET_S and now - start > 1.2:
                break
            if now - start > HARD_S and state["inflight"] == 0:
                break
        frame = page.frames[1] if len(page.frames) > 1 else None
        shown = await frame.evaluate(MEASURE_JS) if frame is not None else {"text": 0, "drawn": 0, "anchors": 0}
        await page.screenshot(path=str(shot))
        return shown
    finally:
        await context.close()


def _plain(e: Exception) -> str:
    """An error's message without the boxed notice Playwright adds, and on one line."""
    lines = [x for x in str(e).splitlines() if x.strip() and not x.lstrip().startswith(("╔", "║", "╚"))]
    return " ".join(lines)[:300]
