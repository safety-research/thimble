#!/usr/bin/env node
// Screenshot helper for the dev agent (backend/app/dev.py run_shot). Headless Chromium from frontend/node_modules.
//   node scripts/ui_shot.mjs --url <url> --out <png> [--selector <css>] [--wait <ms>]
//                            [--click <css>]... [--scroll-to <css>] [--viewport <w>x<h>] [--highlight]
//                            [--element-out <png>] [--info <json path>] [--scale <n>] [--storage <key>=<json>]...
//                            [--press <key>]... [--offline] [--own-origin]
// Loads the URL at 1440x900 (or --viewport), at device scale 1 (or --scale: 2 draws every CSS pixel as four, as a
// high-density screen does), with each --storage key set in the page's localStorage before any of its scripts run, and waits for the page's own requests to go quiet (no request in flight
// for 500 ms, the SSE streams ignored, hard cap 15 s). Then the actions, in command-line order, each followed by the
// same quiet wait: --click clicks the first match of a CSS selector (repeatable); --scroll-to scrolls the first match
// into view; --press presses a key on the page (repeatable, such as Escape to clear a selection). Then --wait ms (default 500) to settle, then the png: the element's bounding box padded by 24 px when
// --selector is given and found, else the full viewport. --highlight outlines the --selector match; --element-out
// writes the padded element crop to a second png, and --out is then the full viewport; --info writes the result JSON
// to a file as well as stdout. --offline refuses every request but the page's own, as for a figure's page whose
// content a model or a kernel wrote. --own-origin refuses every request and WebSocket that leaves the page's origin, and
// sends the browser's other traffic to a proxy that isn't there, for an app whose code a dev ticket wrote.
// Read-only: PUT/POST/DELETE/PATCH to /api/** are answered 204 and never reach the backend, and every request carries
// `X-Thimble-Peek: 1`, so the files a shot loads are not logged as opened by the analyst.
// Exit 0 on success, 2 if --selector or an action target was not found (the shot is still written), 1 on error.
// One JSON line on stdout describes the result: {ok, out, selector, found, box, actions: [{kind, target, found}],
// element_out, ms}.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')

const VIEWPORT = { width: 1440, height: 900 }
const PAD = 24
const NAV_TIMEOUT_MS = 30_000
const IDLE_QUIET_MS = 500
const IDLE_TIMEOUT_MS = 15_000
const IDLE_POLL_MS = 50
const ACTION_TIMEOUT_MS = 5_000
const STREAM_RE = /\/(events|stream)$/
const MUTATING = new Set(['PUT', 'POST', 'DELETE', 'PATCH'])

const USAGE =
  'usage: node scripts/ui_shot.mjs --url <url> --out <png> [--selector <css>] [--wait <ms>] ' +
  '[--click <css>]... [--scroll-to <css>] [--press <key>]... [--viewport <w>x<h>] [--highlight] [--element-out <png>] ' +
  '[--info <json path>] [--scale <n>] [--storage <key>=<json>]... [--offline] [--own-origin]'

function parseViewport(v) {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(String(v).trim())
  if (!m) throw new Error(`--viewport must be <width>x<height>, got ${JSON.stringify(v)}`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

function parseArgs(argv) {
  const out = { url: null, out: null, selector: null, wait: 500, actions: [], viewport: null, highlight: false, elementOut: null, info: null, scale: 1, storage: [], offline: false, ownOrigin: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`)
      return argv[++i]
    }
    if (a === '--url') out.url = next()
    else if (a === '--out') out.out = next()
    else if (a === '--selector') out.selector = next()
    else if (a === '--wait') out.wait = Number(next())
    else if (a === '--click') out.actions.push({ kind: 'click', target: next() })
    else if (a === '--scroll-to') out.actions.push({ kind: 'scroll-to', target: next() })
    else if (a === '--press') out.actions.push({ kind: 'press', target: next() })
    else if (a === '--scale') out.scale = Number(next())
    else if (a === '--storage') {
      const v = next()
      const eq = v.indexOf('=')
      if (eq < 1) throw new Error(`--storage must be <key>=<json>, got ${JSON.stringify(v)}`)
      out.storage.push([v.slice(0, eq), v.slice(eq + 1)])
    }
    else if (a === '--viewport') out.viewport = parseViewport(next())
    else if (a === '--highlight') out.highlight = true
    else if (a === '--offline') out.offline = true
    else if (a === '--own-origin') out.ownOrigin = true
    else if (a === '--element-out') out.elementOut = next()
    else if (a === '--info') out.info = next()
    else if (a === '-h' || a === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!out.url || !out.out) throw new Error('--url and --out are required')
  if (!Number.isFinite(out.wait) || out.wait < 0) throw new Error('--wait must be a non-negative number of ms')
  if (!Number.isFinite(out.scale) || out.scale < 1 || out.scale > 3) throw new Error('--scale must be a number from 1 to 3')
  for (const act of out.actions) if (!act.target.trim()) throw new Error(`empty value for --${act.kind}`)
  return out
}

/** Clamp a padded element box to the viewport; null if nothing of it is on screen. */
function clip(box, viewport = VIEWPORT) {
  const x0 = Math.max(0, Math.floor(box.x - PAD))
  const y0 = Math.max(0, Math.floor(box.y - PAD))
  const x1 = Math.min(viewport.width, Math.ceil(box.x + box.width + PAD))
  const y1 = Math.min(viewport.height, Math.ceil(box.y + box.height + PAD))
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function isStream(url) {
  try {
    return STREAM_RE.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/** Requests in flight, excluding the SSE streams; a Set so a missed event cannot drift it negative. */
function trackRequests(page) {
  const inflight = new Set()
  page.on('request', (r) => {
    if (!isStream(r.url())) inflight.add(r)
  })
  page.on('requestfinished', (r) => inflight.delete(r))
  page.on('requestfailed', (r) => inflight.delete(r))
  return inflight
}

/** Resolve once no tracked request has been in flight for IDLE_QUIET_MS, or after IDLE_TIMEOUT_MS. */
async function waitQuiet(page, inflight) {
  const deadline = Date.now() + IDLE_TIMEOUT_MS
  let quietSince = null
  while (Date.now() < deadline) {
    if (inflight.size === 0) {
      quietSince ??= Date.now()
      if (Date.now() - quietSince >= IDLE_QUIET_MS) return true
    } else quietSince = null
    await page.waitForTimeout(IDLE_POLL_MS)
  }
  console.error(`idle wait capped at ${IDLE_TIMEOUT_MS} ms with ${inflight.size} request(s) still in flight`)
  return false
}

/** Perform one --click / --scroll-to / --press; returns whether its target was found. Never throws. */
async function perform(page, act) {
  try {
    if (act.kind === 'press') {
      await page.keyboard.press(act.target)
      return true
    }
    const loc = page.locator(act.target).first()
    if ((await loc.count()) === 0) return false
    if (act.kind === 'scroll-to') await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
    else await loc.click({ timeout: ACTION_TIMEOUT_MS })
    return true
  } catch (e) {
    console.error(`--${act.kind} ${JSON.stringify(act.target)}: ${String(e?.message ?? e).split('\n')[0]}`)
    return false
  }
}

/** Runs in the page: a fixed box over the element with an accent outline. */
function highlightBox(box) {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b6ef5'
  const d = document.createElement('div')
  d.setAttribute('data-ui-shot-highlight', '')
  d.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;outline:2px solid ${accent};outline-offset:1px;border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.7);background:color-mix(in oklab, ${accent} 12%, transparent)`
  document.body.appendChild(d)
}

const t0 = Date.now()
let browser = null
let code = 1
try {
  const args = parseArgs(process.argv.slice(2))
  const outPath = resolve(args.out)
  mkdirSync(dirname(outPath), { recursive: true })
  const elementOutPath = args.elementOut ? resolve(args.elementOut) : null
  if (elementOutPath) mkdirSync(dirname(elementOutPath), { recursive: true })
  const viewport = args.viewport ?? VIEWPORT

  // the system's Chrome, Edge or Chromium when thimble's config picks it (backend/app/userconf.py)
  // --own-origin: the page's host goes direct, anything else to the discard port, which refuses it
  if (args.ownOrigin) process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1'
  const fenced = args.ownOrigin
    ? { proxy: { server: 'http://127.0.0.1:9', bypass: new URL(args.url).hostname }, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--dns-prefetch-disable'] }
    : {}
  browser = await chromium.launch({ headless: true, executablePath: process.env.THIMBLE_BROWSER_PATH || undefined, ...fenced })
  const page = await browser.newPage({ viewport, deviceScaleFactor: args.scale })
  if (args.storage.length)
    await page.addInitScript((pairs) => {
      for (const [k, v] of pairs) window.localStorage.setItem(k, v)
    }, args.storage)
  await page.setExtraHTTPHeaders({ 'X-Thimble-Peek': '1' })
  if (args.offline) {
    const own = new URL(args.url).href
    await page.route('**/*', (route) => (route.request().url() === own ? route.continue() : route.abort()))
  }
  if (args.ownOrigin) {
    const origin = new URL(args.url).origin
    const wsOrigin = origin.replace(/^http/, 'ws')
    await page.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()))
    await page.routeWebSocket(/.*/, (ws) => (new URL(ws.url()).origin === wsOrigin ? ws.connectToServer() : ws.close()))
  }
  await page.route('**/api/**', (route) =>
    MUTATING.has(route.request().method()) ? route.fulfill({ status: 204, body: '' }) : route.continue(),
  )
  const inflight = trackRequests(page)
  await page.goto(args.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
  await waitQuiet(page, inflight)

  const actions = []
  for (const act of args.actions) {
    const found = await perform(page, act)
    actions.push({ ...act, found })
    if (found) await waitQuiet(page, inflight)
  }
  if (args.wait > 0) await page.waitForTimeout(args.wait)

  let found = false
  let box = null
  let raw = null
  if (args.selector) {
    try {
      const loc = page.locator(args.selector).first()
      if ((await loc.count()) > 0) {
        const b = await loc.boundingBox()
        if (b && b.width > 0 && b.height > 0) {
          await loc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {})
          raw = (await loc.boundingBox()) ?? b
          box = clip(raw, viewport)
          found = box !== null
        }
      }
    } catch (e) {
      console.error(`selector error: ${String(e?.message ?? e).split('\n')[0]}`)
    }
  }
  if (found && args.highlight) await page.evaluate(highlightBox, raw)

  let elementOut = null
  if (elementOutPath) {
    await page.screenshot({ path: outPath })
    if (found) {
      await page.screenshot({ path: elementOutPath, clip: box })
      elementOut = elementOutPath
    }
  } else if (found) await page.screenshot({ path: outPath, clip: box })
  else await page.screenshot({ path: outPath })

  const missed = (args.selector && !found) || actions.some((a) => !a.found)
  code = missed ? 2 : 0
  const result = { ok: true, out: outPath, selector: args.selector, found, box, actions, element_out: elementOut, ms: Date.now() - t0 }
  if (args.info) writeFileSync(resolve(args.info), JSON.stringify(result) + '\n')
  console.log(JSON.stringify(result))
} catch (e) {
  // without the boxed notice Playwright adds to a failed launch, which names an install command
  console.error(`ui_shot: ${String(e?.stack ?? e?.message ?? e).split('\n').filter((l) => !/^[╔║╚]/.test(l)).join('\n')}`)
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e).split('\n')[0] }))
  code = 1
} finally {
  if (browser) await browser.close().catch(() => {})
}
process.exit(code)
