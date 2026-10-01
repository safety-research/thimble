// The product tour (src/tour, shell/TourHost) over the whole app, in headless Chromium: the real App, its stylesheets
// and fonts, against a made-up workspace whose every API answer this file gives, at 1440x900, 1920x1080 and a chat
// column 355 px wide at DPR 2 (in a 1200 and a 1100 px window, where the Files sidebar folds). What it proves, measured
// with getBoundingClientRect:
//   - the first launch asks first (a welcome, "Would you like a short tour?", with Skip and Take the tour) and records
//     the offer in thimble's own state (POST /api/tour/seen); a page loaded after that offers nothing; Settings' Take
//     the tour replays the tour from step 1; with the chat column folded the tour leaves out its chat steps;
//   - every step: each cutout lies inside the window, everything an example shows in a cutout lies inside that cutout,
//     the popover lies inside the window, covers no cutout wherever the window has room for it beside the first, and its
//     caret points at the first cutout;
//   - step 1's example sits 8 px or more inside its cutout, which lies inside the chat panel; step 3 says what the
//     orientation does, and its Start only shows the started state;
//   - step 5: the wheel scrolls the labels' transcript in steps with every record moving by exactly the scroll, its
//     height, the cutout and the Labels pane still and the ruler's thumb following, and the wheel over the ruler too;
//   - step 6: inside the example view the wheel and a click work and reach nothing else; in its header strip no item
//     meets another or anything of the view, nothing of the tour (a badge, the popover, the views bar) meets it, the
//     label control counts the labels on, the unreadable line is counted in the strip's ink, and the page's Only these
//     shows as thimble's filter chip with how many events it hides, which the chip clears;
//   - step 7: the card is in plain words; on its first entry the demo plays once the card is in place, comes to rest on
//     08:04 as its source shows and the card holds still, also with the Canvas drawn 1.5 s late; a real hover on a value
//     shows its source, and a hover that stops the demo leaves the ⌘ demo to play at once on step 8;
//   - step 8: in the ⌘-click demo the key badge stands inside the card and over none of its text; then "⌘-click here"
//     points at the end of an entry and covers no text and not the popover, until the first try; a real ⌘-drag on the
//     example card picks only the words dragged over and its ask box lies inside the cutout;
//   - step 9: the report's first figure is the small table, every chart and table is as wide as its figure, and with no
//     check made there is no comment margin, so its text column is as wide as thimble's own Report draws it, also after
//     Back from step 10; step 10: the demo makes the check, the margin stands at Run and not before, the comments appear
//     in it, and only then does the page scroll to one; each comment card stands 8 px above its passage, or below the
//     card above it, before and after the report scrolls;
//   - the page is frozen: clicks, keys and the wheel reach nothing, the tour writes nothing but the offer, and telemetry
//     records nothing while it runs; Enter in the page's ask box sends nothing, and an ask box left open closes when
//     the tour starts.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page, Route } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const WS = 'demo'
const T = '2026-05-16T09:00:00.000+00:00'
let browser: Browser
let out = ''

beforeAll(async () => {
  const script = await bundle(
    'tour',
    [
      `import '${src('tour/freeze.ts')}'`,
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import App from '${src('App.tsx')}'`,
      `import { currentTour } from '${src('tour/run.ts')}'`,
      `;(window as any).__tour = () => currentTour()`,
      `createRoot(document.getElementById('root')!).render(<App />)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.json': 'json' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  out = path.dirname(script)
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

// ---------- the made-up workspace: one main session attached, no cards, no report, a few files
const MAIN = {
  id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null,
  attached: { session: 'session-1', cwd: '/home/analyst/demo', since: T }, ended: null, alert: null, running: false,
}
const SETTINGS = {
  run_cell_result_lines: 40,
  models: Object.fromEntries(['orient', 'critic', 'writer', 'checks', 'verify', 'labels', 'dev'].map((r) => [r, { model: 'claude-opus-5-5', effort: 'high', fast: false }])),
  permission_modes: {}, disabled_modes: [], config_error: '', untrusted: null,
}
const FILES = ['README.md', 'deploys.csv', 'agents.log', 'chat/ops.json', 'tickets/index.csv'].map((p) => ({ path: p, kind: 'text', size_bytes: 1200, title: p.split('/').pop() }))
/** One folder's own entries, as `GET /corpora/{c}/sources?path=&depth=1` answers. */
const folder = (at: string) => {
  const inside = FILES.filter((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === at)
  const sub = at ? [] : [...new Set(FILES.filter((f) => f.path.includes('/')).map((f) => f.path.split('/')[0]))]
  return { path: at, files: inside, folders: sub.map((d) => ({ path: d, name: d, n_files: FILES.filter((f) => f.path.startsWith(`${d}/`)).length, n_folders: 0, is_run: false })), n_files: FILES.length }
}
/** A file's first lines, as `GET /corpora/{c}/source` answers. */
const sourcePage = (p: string) => {
  const lines = [`# ${p}`, '', 'A made-up file for the tour check.']
  return { path: p, kind: 'text', total_lines: lines.length, start: 1, records: lines.map((text, k) => ({ line: k + 1, record: { text }, blocks: [{ kind: 'text', text }], meta: {} })) }
}
const GET: Record<string, unknown> = {
  '/api/health': { ok: true, leader: 1, boot: 'boot', ui: 'ui' },
  '/api/corpora': [{ name: WS, path: '/home/analyst/demo', registered: true, manifest: null }],
  [`/api/ws/${WS}/instance`]: { stamp: 'stamp-1' },
  [`/api/ws/${WS}/undo`]: { undo: null, redo: null, undo_run: null, held: null },
  [`/api/ws/${WS}/chats`]: [{ ...MAIN, n_messages: 0, last_ts: T }],
  [`/api/ws/${WS}/chats/main`]: { meta: { ...MAIN, orientation: null }, events: [] },
  [`/api/ws/${WS}/concepts`]: [],
  [`/api/ws/${WS}/views`]: [],
  [`/api/ws/${WS}/views/proposals`]: [],
  [`/api/corpora/${WS}/sources`]: FILES,
  [`/api/ws/${WS}/labels`]: [],
  [`/api/ws/${WS}/labels/presence`]: [],
  [`/api/ws/${WS}/canvas`]: { groups: [], cells: [], hidden: [] },
  [`/api/ws/${WS}/filters`]: {},
  [`/api/ws/${WS}/report-types/presets`]: [],
  [`/api/ws/${WS}/investigations/main/types`]: { report: { exists: false, renderer: 'document', frame: false, name: 'Report' } },
  [`/api/ws/${WS}/investigations/main/types/report/frame`]: { id: 'report', type: 'report', renderer: 'document', title: '', sections: [], frame: true, generation: 0 },
  [`/api/ws/${WS}/checks`]: [],
}
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.html': 'text/html', '.svg': 'image/svg+xml' }
const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'

interface Server {
  seen: boolean
  /** every request that is not a read, as `METHOD path` */
  writes: string[]
  /** the telemetry the page sent */
  telemetry: { kind: string; detail?: { label?: string } }[]
  /** the workspace's settings */
  settings: typeof SETTINGS
}

/** A page on the made-up origin, answered by this file: the app, the tour's example view, the workspace's API. */
async function open(opts: { W: number; H: number; dpr?: number; chat?: number; seen?: boolean; folded?: boolean; paper?: string }): Promise<{ page: Page; server: Server; close: () => Promise<void> }> {
  const server: Server = { seen: !!opts.seen, writes: [], telemetry: [], settings: { ...SETTINGS } }
  const ctx = await browser.newContext({ viewport: { width: opts.W, height: opts.H }, deviceScaleFactor: opts.dpr ?? 1 })
  await ctx.addInitScript(
    ({ ws, chat, open, paper }) => {
      if (paper) localStorage.setItem('thimble:paper', paper)
      // a Mac, so ⌘ is the pointer's key
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined })
      localStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      sessionStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      localStorage.setItem(`thimble:${ws}:layout`, JSON.stringify({ chatWidth: chat, chatOpen: open, panes: { root: { kind: 'pane', id: 'p1', surface: 'report' }, focus: 'p1' } }))
      // what reaches the page: every input an app listener on the document would hear, outside the tour
      ;(window as any).__probe = []
      for (const t of ['mousedown', 'click', 'keydown', 'wheel', 'contextmenu'])
        document.addEventListener(t, (e) => {
          if (!(e.target instanceof Element && e.target.closest('.tour-root, .tour-host'))) (window as any).__probe.push(`${t}:${(e as KeyboardEvent).key || ''}`)
        })
    },
    { ws: WS, chat: opts.chat ?? 308, open: !opts.folded, paper: opts.paper },
  )
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => answer(route, server))
  await page.goto(`${ORIGIN}/?ws=${WS}`)
  return { page, server, close: () => ctx.close() }
}

function answer(route: Route, server: Server) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
  if (url.origin !== ORIGIN) return route.abort()
  const p = url.pathname
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p.startsWith('/api/')) {
    const method = req.method()
    if (method !== 'GET' && method !== 'HEAD') server.writes.push(`${method} ${p}`)
    if (p.endsWith('/telemetry')) server.telemetry.push(...JSON.parse(req.postData() || '[]'))
    if (p === '/api/tour') return json({ seen: server.seen })
    if (p === '/api/tour/seen' && method === 'POST') {
      server.seen = true
      return json({ seen: true })
    }
    if (p === '/api/ui/key') return route.fulfill({ status: 204, body: '' })
    if (p === `/api/ws/${WS}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': open\n\n' })
    if (p === `/api/corpora/${WS}/sources` && url.searchParams.get('depth') === '1') return json(folder(url.searchParams.get('path') ?? ''))
    if (p === `/api/corpora/${WS}/source`) return json(sourcePage(url.searchParams.get('path') ?? 'README.md'))
    if (p === `/api/ws/${WS}/labels/ruler`) return json({ path: url.searchParams.get('path') ?? '', total: 3, bins: 400, labels: [] })
    if (method === 'GET' && p === `/api/ws/${WS}/settings`) return json(server.settings)
    if (method === 'GET' && p in GET) return json(GET[p])
    if (method === 'PUT' && p === `/api/ws/${WS}/render/theme`) return json({ paper: 'warm', accent: 'iris' })
    if (method === 'POST' && p === `/api/ws/${WS}/telemetry`) return json({ recorded: 1 }, 201)
    return json({ detail: 'not found' }, 404)
  }
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: INDEX })
  const file = p.startsWith('/tour/') ? path.join(FRONTEND, 'public', p) : path.join(out, p)
  if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
  return route.fulfill({ status: 404, body: '' })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type St = { i: number; title: string; n: number; total: number; holes: number; demo: string; after: boolean; welcome: boolean }
const state = (page: Page): Promise<St | null> => page.evaluate(() => (window as any).__tour()?.state() ?? null)
const buttons = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tour-pop button')].map((b) => b.dataset.tour))
const body = (page: Page) => page.evaluate(() => document.querySelector('.tour-body')?.textContent ?? '')
const probe = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__probe.splice(0))
/** Wait for step `n` (its number) to be drawn: its example in place and the popover shown. */
async function onStep(page: Page, n: number, title?: string) {
  await page.waitForFunction(
    ({ n, title }) => {
      const s = (window as any).__tour()?.state()
      const pop = document.querySelector<HTMLElement>('.tour-pop')
      return s && s.n === n && (!title || s.title === title) && pop && pop.style.visibility !== 'hidden' && (window as any).__tour().geometry()
    },
    { n, title },
    { timeout: 15000 },
  )
  await sleep(500)
}
const next = (page: Page) => page.click('.tour-pop [data-tour="next"]')

// in the page: what a cutout shows lies inside it. Every element drawn in an example container (a size, visible, and
// clipped by its ancestors' boxes) that meets the cutout must lie inside it; a container whose background only covers
// the page beneath (data-ground) is not itself counted, its contents are.
const SPILL = () => {
  const g = (window as any).__tour().geometry()
  const clipRect = (el: Element, stop: Element) => {
    const b = el.getBoundingClientRect()
    let r = { l: b.left, t: b.top, r: b.right, b: b.bottom }
    for (let p = el.parentElement; p && p !== stop.parentElement && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clipPath !== 'none') {
        const q = p.getBoundingClientRect()
        r = { l: Math.max(r.l, q.left), t: Math.max(r.t, q.top), r: Math.min(r.r, q.right), b: Math.min(r.b, q.bottom) }
      }
    }
    return r
  }
  const bad: { hole: number; el: string; out: number }[] = []
  const roots = [...document.querySelectorAll<HTMLElement>('.tour-ex > *, .tour-host > *, .tour-fx > *:not(.tour-cursor):not(.tour-key):not(.tour-ripple)')]
  g.holes.forEach((h: { x: number; y: number; w: number; h: number }, k: number) => {
    for (const root of roots) {
      const rb = root.getBoundingClientRect()
      if (!(rb.right > h.x + 1 && rb.left < h.x + h.w - 1 && rb.bottom > h.y + 1 && rb.top < h.y + h.h - 1)) continue
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (el === root && root.dataset.ground) continue
        if (el.closest('.tour-tag') && el !== root.querySelector('.tour-tag')) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue
        const r = clipRect(el, root)
        if (r.r - r.l < 1 || r.b - r.t < 1) continue
        if (!(r.r > h.x + 1 && r.l < h.x + h.w - 1 && r.b > h.y + 1 && r.t < h.y + h.h - 1)) continue
        const o = Math.max(h.x - r.l, r.r - (h.x + h.w), h.y - r.t, r.b - (h.y + h.h))
        if (o > 0.5) bad.push({ hole: k, el: String((el as HTMLElement).className?.toString() || el.tagName).slice(0, 40), out: Math.round(o * 10) / 10 })
      }
    }
  })
  return bad.slice(0, 5)
}

/** The assertions every step's drawing must meet. */
async function measure(page: Page, label: string) {
  const g = await page.evaluate(() => (window as any).__tour().geometry())
  assert.ok(g, `${label}: drawn`)
  const { w: vw, h: vh } = g.viewport
  g.holes.forEach((h: { x: number; y: number; w: number; h: number }, k: number) => {
    const o = Math.max(-h.x, -h.y, h.x + h.w - vw, h.y + h.h - vh)
    assert.ok(o <= 0.5, `${label}: cutout ${k} lies ${o}px past the window`)
  })
  const p = g.pop
  assert.ok(p && p.x >= -0.5 && p.y >= -0.5 && p.x + p.w <= vw + 0.5 && p.y + p.h <= vh + 0.5, `${label}: the popover lies inside the window ${JSON.stringify(p)}`)
  // the popover covers no cutout, unless the cutouts leave it no free place: then no place beside the first cutout, on any
  // side and kept inside the window, would cover less
  type B = { x: number; y: number; w: number; h: number }
  const cover = (q: { x: number; y: number }) =>
    g.holes.reduce((a: number, h: B) => a + Math.max(0, Math.min(q.x + p.w, h.x + h.w) - Math.max(q.x, h.x)) * Math.max(0, Math.min(q.y + p.h, h.y + h.h) - Math.max(q.y, h.y)), 0)
  const now = cover(p)
  if (now > 1 && g.holes[0]) {
    const h0: B = g.holes[0]
    const clamp = (x: number, y: number) => ({ x: Math.max(12, Math.min(vw - p.w - 12, x)), y: Math.max(12, Math.min(vh - p.h - 12, y)) })
    const places = [clamp(h0.x + h0.w + 14, p.y), clamp(h0.x - 14 - p.w, p.y), clamp(p.x, h0.y + h0.h + 14), clamp(p.x, h0.y - 14 - p.h)]
    const least = Math.min(...places.map(cover))
    assert.ok(now <= least + 1, `${label}: the popover covers ${Math.round(now)}px² of the cutouts where ${Math.round(least)}px² was possible`)
  }
  if (g.caret && g.holes[0]) {
    const h = g.holes[0],
      c = { x: g.caret.x + g.caret.w / 2, y: g.caret.y + g.caret.h / 2 }
    const side = p.x >= h.x + h.w - 1 ? 'right' : p.x + p.w <= h.x + 1 ? 'left' : p.y >= h.y + h.h - 1 ? 'bottom' : 'top'
    const along = side === 'right' || side === 'left' ? [c.y, h.y, h.y + h.h] : [c.x, h.x, h.x + h.w]
    const gap = side === 'right' ? c.x - (h.x + h.w) : side === 'left' ? h.x - c.x : side === 'bottom' ? c.y - (h.y + h.h) : h.y - c.y
    assert.ok(along[0] >= along[1] + 8 && along[0] <= along[2] - 8, `${label}: the caret points at the cutout (${side}, ${along.map(Math.round)})`)
    assert.ok(gap <= 24, `${label}: the caret is ${Math.round(gap)}px from the cutout`)
  }
  const spill = await page.evaluate(SPILL)
  assert.deepEqual(spill, [], `${label}: something shown spills past its cutout`)
  return g
}

/** The comment cards against their passages: each 8 px (scaled with the report) above its passage's first line, or
 * pushed down only to clear the card above it. */
const commentsLevel = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('.tour-ex-report')!,
      k = (window as any).__tour().api.els.k || 1
    const cards = [...root.querySelectorAll('.wu-cm')]
      .map((c) => {
        const p = root.querySelector(`[data-cids~="${c.getAttribute('data-comment')}"]`)!
        const b = c.getBoundingClientRect()
        return { top: b.top, bottom: b.bottom, passage: p.getBoundingClientRect().top, visible: getComputedStyle(c).visibility !== 'hidden' }
      })
      .sort((a, b) => a.passage - b.passage)
    let prev: { bottom: number } | null = null
    return cards.map((c) => {
      const off = c.top - (c.passage - 8 * k)
      const pushed = prev ? c.top - (prev.bottom + 8 * k) : null
      prev = c
      return { off: Math.round(off * 10) / 10, ok: c.visible && (Math.abs(off) <= 4 || (off > 0 && pushed != null && Math.abs(pushed) <= 4)) }
    })
  })

// in the page, from Next on step 6 on, every frame: the step, the demo pointer's tip, the card's box, the centre of the
// card's 08:04 and whether the demo's source shows
const LOG7 = () => {
  const w = window as any
  w.__log7 = []
  const t0 = performance.now()
  const f = () => {
    if (!w.__log7) return
    const c = document.querySelector<HTMLElement>('.tour-cursor'),
      m = c && /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(c.style.transform)
    const card = w.__tour().api.els.card as Element | undefined,
      b = card?.getBoundingClientRect()
    const chip = card && [...card.querySelectorAll('.refchip-value')].find((x) => x.textContent?.trim() === '08:04')?.getBoundingClientRect()
    w.__log7.push({
      t: Math.round(performance.now() - t0),
      n: w.__tour().state().n,
      at: m ? [+m[1] + 8, +m[2] + 7] : null,
      card: b ? [b.x, b.y, b.width].map(Math.round).join() : null,
      chip: chip ? [chip.x + chip.width / 2, chip.y + chip.height * 0.6] : null,
      src: !!document.querySelector('.tour-fx .refchip-pop[data-demo]'),
    })
    if (w.__log7.length < 2400) requestAnimationFrame(f)
  }
  requestAnimationFrame(f)
}
type Log7 = { t: number; n: number; at: number[] | null; card: string | null; chip: number[] | null; src: boolean }
const takeLog7 = (page: Page): Promise<Log7[]> =>
  page.evaluate(() => {
    const l = (window as any).__log7
    ;(window as any).__log7 = null
    return l
  })
/** The cards demo, from the log of its entry: the pointer showed within `maxMs` of Next, got 100 px or more from where
 * it was first seen through 3 or more places, and stood within 3 px of 08:04 when the source first showed, the card not
 * moving from the pointer's first frame on. */
const judge7 = (log: Log7[], maxMs = 2000) => {
  const on = log.filter((x) => x.n === 7)
  const firstAt = on.find((x) => x.at)
  const srcAt = on.find((x) => x.src && x.at)
  const pts = on.filter((x) => x.at).map((x) => x.at!)
  const places = new Set(pts.map((q) => q.map(Math.round).join())).size
  const moved = pts.length ? Math.round(Math.max(...pts.map((q) => Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1])))) : 0
  const cards = new Set(on.filter((x) => firstAt && x.t >= firstAt.t && x.card).map((x) => x.card))
  const rest = srcAt?.chip ? { dx: Math.round((srcAt.at![0] - srcAt.chip[0]) * 10) / 10, dy: Math.round((srcAt.at![1] - srcAt.chip[1]) * 10) / 10 } : null
  const firstMs = firstAt ? firstAt.t : null
  return { ok: firstMs != null && firstMs <= maxMs && places >= 3 && moved >= 100 && !!rest && Math.abs(rest.dx) <= 3 && Math.abs(rest.dy) <= 3 && cards.size === 1, firstMs, places, moved, rest, cardBoxes: cards.size }
}

// in the page: the ⌘-click cue over a little more than one pulse of its nudge, against the end of the 08:29 entry's text
const CUE = async () => {
  const out: ({ gap: number; dy: number; hits: string[]; overPop: boolean; text: string | null } | null)[] = []
  for (let n = 0; n < 8; n++) {
    const cue = document.querySelector('.tour-cue')
    if (!cue) out.push(null)
    else {
      const card = (window as any).__tour().api.els.card as Element
      const label = [...card.querySelectorAll('.canvas-tl-row')].find((r) => r.querySelector('.canvas-tl-time')?.textContent?.trim() === '08:29')!.querySelector('.canvas-tl-label')!
      const q = document.createRange()
      q.selectNodeContents(label)
      const end = [...q.getClientRects()].filter((b) => b.width > 1).reduce((a, b) => (b.bottom > a.bottom + 1 || (Math.abs(b.bottom - a.bottom) <= 1 && b.right > a.right) ? b : a))
      const ar = cue.querySelector('.tour-cue-arrow')!.getBoundingClientRect(),
        lb = cue.querySelector('.tour-cue-label')!.getBoundingClientRect(),
        tip = ar.left - 1
      const hits: string[] = []
      const zones: [string, { left: number; right: number; top: number; bottom: number }][] = [
        ['arrow', { left: tip, right: ar.right, top: ar.top - 5, bottom: ar.bottom + 5 }],
        ['label', lb],
      ]
      const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        if (!t.textContent?.trim()) continue
        const r = document.createRange()
        r.selectNodeContents(t)
        for (const b of r.getClientRects())
          for (const [nm, c] of zones) if (b.width > 0 && b.right > c.left + 0.5 && b.left < c.right - 0.5 && b.bottom > c.top + 0.5 && b.top < c.bottom - 0.5) hits.push(`${nm}: ${t.textContent.slice(0, 24)}`)
      }
      const p = document.querySelector('.tour-pop')!.getBoundingClientRect()
      out.push({
        gap: Math.round((tip - end.right) * 10) / 10,
        dy: Math.round(((ar.top + ar.bottom) / 2 - (end.top + end.bottom) / 2) * 10) / 10,
        hits,
        overPop: lb.right > p.left && lb.left < p.right && lb.bottom > p.top && lb.top < p.bottom,
        text: cue.textContent,
      })
    }
    await new Promise((r) => setTimeout(r, 230))
  }
  return out
}

/** The example view's header, the strip thimble draws above every view, inside the example's frame: none of its items
 * meets another, nothing else of the view meets them, the item drawn at each item's centre is the item itself, the
 * label control is level with the strip's first row, and nothing of the tour (a badge, the popover, the views bar)
 * meets the strip. Also its label control's words, its
 * residue's words and ink against the ink of its files, and a filter's chip with what it hides. */
async function viewHead(page: Page) {
  const hf = page.frames().find((f) => f.url().includes('/tour/timeline/view.html'))
  if (!hf) return { ok: false, why: 'no view header' } as const
  const inner = await hf.evaluate(() => {
    const h = document.querySelector('.scope-head')!
    const vis = (e: Element) => {
      const cs = getComputedStyle(e),
        b = e.getBoundingClientRect()
      return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0 && b.width > 0.5 && b.height > 0.5
    }
    const name = (e: Element) => (e.textContent?.trim() || String((e as HTMLElement).className)).slice(0, 24)
    const R = (e: Element) => {
      const b = e.getBoundingClientRect()
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, n: name(e) }
    }
    const meet = (a: ReturnType<typeof R>, b: ReturnType<typeof R>) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5
    const items = [...h.querySelectorAll('button, .sh-dot, .seg, .view-pane-hidden')].filter((e) => vis(e) && !e.parentElement!.closest('.seg'))
    const ri = items.map(R)
    const bad: string[] = []
    for (let i = 0; i < ri.length; i++) for (let j = i + 1; j < ri.length; j++) if (meet(ri[i], ri[j])) bad.push(`${ri[i].n} / ${ri[j].n}`)
    for (const e of (h.closest('.files-body.is-view') || document.body).querySelectorAll('*')) {
      if (h.contains(e) || e.contains(h) || e.closest('.sh-pop') || !vis(e)) continue
      const r = R(e)
      for (const it of ri)
        if (meet(r, it)) {
          bad.push(`${it.n} / ${r.n}`)
          break
        }
    }
    for (const e of items) {
      const b = e.getBoundingClientRect(),
        top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      if (top && !e.contains(top) && !top.contains(e)) bad.push(`${name(e)} under ${name(top)}`)
    }
    const res = h.querySelector('.view-pane-residue'),
      files = h.querySelector('[data-pop="files"]')!
    const all = ri.concat([R(h)])
    return {
      bad: bad.slice(0, 6),
      n: ri.length,
      u: { l: Math.min(...all.map((r) => r.l)), t: Math.min(...all.map((r) => r.t)), r: Math.max(...all.map((r) => r.r)), b: Math.max(...all.map((r) => r.b)) },
      lead: h.querySelector('.view-pane-side-show')?.textContent?.trim() ?? null,
      // the label control's centre against the strip's first item's, in px
      level: (() => {
        const a = h.querySelector('.view-pane-side-show')!.getBoundingClientRect(),
          b = h.querySelector('.sh-unit')!.getBoundingClientRect()
        return Math.round(Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) * 10) / 10
      })(),
      residueText: res?.textContent?.trim() ?? null,
      residue: res ? getComputedStyle(res).color : null,
      ink: getComputedStyle(files).color,
      negative: (() => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--status-negative)'
        h.append(probe)
        const c = getComputedStyle(probe).color
        probe.remove()
        return c
      })(),
      filter: h.querySelector('.view-pane-filter .chip-text')?.textContent ?? null,
      hidden: h.querySelector('.view-pane-hidden')?.textContent ?? null,
    }
  })
  const fb = (await (await hf.frameElement()).boundingBox())!
  const H = { l: fb.x + inner.u.l, t: fb.y + inner.u.t, r: fb.x + inner.u.r, b: fb.y + inner.u.b }
  const outer = await page.evaluate((H) => {
    const frame = document.querySelector('.tour-ex-viewbody iframe')!,
      bad: string[] = []
    for (const e of document.querySelectorAll('.tour-root *, .tour-host *')) {
      if (e === frame || e.contains(frame) || e.matches('.tour-ex, .tour-fx, .tour-block, svg.tour-dim, svg.tour-dim *')) continue
      const cs = getComputedStyle(e)
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue
      const b = e.getBoundingClientRect()
      if (b.width < 0.5 || b.height < 0.5) continue
      if (Math.min(b.right, H.r) - Math.max(b.left, H.l) > 0.5 && Math.min(b.bottom, H.b) - Math.max(b.top, H.t) > 0.5) bad.push(String((e as HTMLElement).className || e.tagName).slice(0, 30))
    }
    return bad.slice(0, 6)
  }, H)
  const residueOk = /^(1 unreadable (line|file)|\d+ unreadable (lines|files))$/.test(inner.residueText || '') && inner.residue === inner.ink && inner.residue !== inner.negative
  return { ok: !inner.bad.length && !outer.length && inner.n >= 5 && residueOk && inner.level <= 1, inner: inner.bad, outer, items: inner.n, lead: inner.lead, level: inner.level, residueText: inner.residueText, residue: inner.residue, ink: inner.ink, filter: inner.filter, hidden: inner.hidden }
}

// in the page: the report example's inner width, its text column's width, and whether its comment margin shows
const REPORTCOL = () => {
  const root = document.querySelector('.tour-ex-report')!,
    rail = root.querySelector<HTMLElement>('.wu-rail')
  return { inner: (root.firstElementChild as HTMLElement).offsetWidth, col: root.querySelector<HTMLElement>('.wu-page-col')!.offsetWidth, margin: !!rail && getComputedStyle(rail).display !== 'none' && rail.offsetWidth > 0 }
}
// in the page: each figure of the report example, its chart's or table's width on screen against its content's width
const FIGS = () => {
  const root = document.querySelector('.tour-ex-report')!,
    k = (window as any).__tour().api.els.k || 1
  return [...root.querySelectorAll('figure.wu-fig')].map((f) => {
    const body = f.querySelector<HTMLElement>('.wu-fig-body')!,
      cs = getComputedStyle(body)
    const el = f.querySelector('.outputs-vega svg') || f.querySelector('table')
    return {
      id: (f.getAttribute('data-tour-anchor') || '').slice(5),
      content: Math.round((body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * k * 10) / 10,
      width: el ? Math.round(el.getBoundingClientRect().width * 10) / 10 : null,
    }
  })
}
const OWN = new Map<number, { panel: number; col: number; margin: boolean }>()
/** thimble's own Report on this made-up workspace, which has no comments and no check on: its text column's width for a
 * Report panel `panel` px wide (beside a 308 px chat column) */
async function ownReport(panel: number) {
  const known = OWN.get(panel)
  if (known) return known
  const { page, close } = await open({ W: panel + 344, H: 900, seen: true })
  try {
    await page.waitForSelector('[data-panel="report"] .wu-page-col', { timeout: 20000 })
    await sleep(1500)
    const own = await page.evaluate(() => ({
      panel: Math.round(document.querySelector('[data-panel="report"].shell-panel')!.getBoundingClientRect().width),
      col: document.querySelector<HTMLElement>('[data-panel="report"] .wu-page-col')!.offsetWidth,
      margin: !!document.querySelector('[data-panel="report"] .wu-rail'),
    }))
    assert.ok(own.panel === panel && !own.margin, `thimble's own Report measured with a ${panel} px panel and no margin ${JSON.stringify(own)}`)
    OWN.set(panel, own)
    return own
  } finally {
    await close()
  }
}

/** The whole tour from step 1, with the assertions of each step. */
async function walk(page: Page, tag: string, folds?: boolean, send = false) {
  // 1 the chat
  await onStep(page, 1, 'Your Claude Code session')
  let g = await measure(page, `${tag} 1`)
  assert.deepEqual(await buttons(page), ['skip', 'next'], `${tag} 1: Skip tour and Next`)
  const inset = await page.evaluate((h) => {
    const panel = document.querySelector('.chat[data-panel="chat"]')!.getBoundingClientRect()
    const r = (sel: string) => document.querySelector(sel)?.getBoundingClientRect()
    const items = { badge: r('.tour-ex-chat .tour-tag'), bubble: r('.tour-ex-chat .msg-user'), bash: r('.tour-ex-chat .chat-callrun-chip'), reply: r('.tour-ex-chat .chat-text') }
    const ins = Object.fromEntries(Object.entries(items).map(([k, b]) => [k, b ? Math.min(b.left - h.x, h.x + h.w - b.right, b.top - h.y, h.y + h.h - b.bottom) : null]))
    return { ins, inPanel: Math.min(h.x - panel.left, panel.right - (h.x + h.w), h.y - panel.top, panel.bottom - (h.y + h.h)) }
  }, g.holes[0])
  for (const [name, v] of Object.entries(inset.ins)) assert.ok(v != null && v >= 8, `${tag} 1: the example's ${name} is ${v}px inside the cutout`)
  assert.ok(inset.inPanel >= -0.5, `${tag} 1: the cutout lies inside the chat panel (${inset.inPanel})`)
  // the page is frozen: a click, a wheel and keys outside the tour reach nothing
  await probe(page)
  await page.mouse.click(Math.round(g.viewport.w * 0.6), Math.round(g.viewport.h * 0.6))
  await page.mouse.wheel(0, 300)
  await page.keyboard.type('zz')
  await sleep(200)
  assert.deepEqual(await probe(page), [], `${tag} 1: nothing reaches the page`)
  await next(page)
  // 2 the terminal
  await onStep(page, 2, 'Your terminal')
  await sleep(500)
  await measure(page, `${tag} 2`)
  assert.equal((await state(page))!.holes, 2, `${tag} 2: the terminal and the chat`)
  assert.deepEqual(await buttons(page), ['back', 'next'], `${tag} 2: Back and Next`)
  await next(page)
  // 3 the orientation: no Next until Start, which only shows the started state
  await onStep(page, 3, 'The orientation')
  await measure(page, `${tag} 3`)
  assert.match(await body(page), /^A background agent explores your files and drafts an analysis for you to review\. Press Start/, `${tag} 3: what the orientation does`)
  assert.deepEqual(await buttons(page), ['back'], `${tag} 3: no Next before Start`)
  const start = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tour-ex-gate button')].find((x) => x.textContent?.trim() === 'Start')!.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  await probe(page)
  await page.mouse.click(start.x, start.y)
  await page.waitForFunction(() => document.querySelector('.tour-body')?.textContent?.startsWith('The orientation has started'), null, { timeout: 3000 })
  await sleep(300)
  await measure(page, `${tag} 3 (started)`)
  assert.deepEqual(await buttons(page), ['back', 'next'], `${tag} 3: Next once started`)
  assert.deepEqual(await probe(page), [], `${tag} 3: Start reached nothing of the page`)
  await next(page)
  // 4 Files
  await onStep(page, 4, 'Files')
  g = await measure(page, `${tag} 4`)
  assert.match(await body(page), /^In the meantime, you can explore the files and views\./, `${tag} 4: In the meantime`)
  const files = await page.evaluate(() => {
    const b = document.querySelector('[data-panel="files"].shell-panel')!.getBoundingClientRect()
    return [b.x, b.y, b.width, b.height]
  })
  assert.ok(files.every((v, k) => Math.abs(v - [g.targets[0].x, g.targets[0].y, g.targets[0].w, g.targets[0].h][k]) <= 1), `${tag} 4: the cutout is the Files panel`)
  await next(page)
  // 5 Labels: the wheel over the transcript scrolls it
  await onStep(page, 5, 'Labels')
  await sleep(400)
  await measure(page, `${tag} 5`)
  // the example's Labels pane and transcript side by side inside the Files panel, whether its sidebar docks or folds
  const lay = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
    const P = r('[data-panel="files"].shell-panel'), lab = r('.tour-ex-labels'), rd = r('.tour-ex-reader')
    const inside = (b: DOMRect) => b.left >= P.left - 0.5 && b.right <= P.right + 0.5 && b.top >= P.top - 0.5 && b.bottom <= P.bottom + 0.5
    return { folded: ![...document.querySelectorAll('.files-labels')].some((e) => !e.closest('.tour-root')), inside: inside(lab) && inside(rd), apart: lab.right <= rd.left + 0.5 }
  })
  assert.ok(lay.inside && lay.apart, `${tag} 5: the labels pane and the transcript lie apart inside the Files panel ${JSON.stringify(lay)}`)
  if (folds !== undefined) assert.equal(lay.folded, folds, `${tag} 5: the Files sidebar ${folds ? 'folds' : 'docks'}`)
  // in wheel steps of 100 px down and back up, every record on screen moves by exactly the scroll, and the transcript's
  // height, the cutout and the Labels pane hold still while the ruler's thumb follows
  const look5 = () =>
    page.evaluate(() => {
      const sc = document.querySelector('.tour-ex-reader .reader-body')!,
        b = sc.getBoundingClientRect(),
        rows: Record<string, number> = {}
      for (const r of sc.querySelectorAll('.reader-record')) {
        const q = r.getBoundingClientRect()
        if (q.bottom > b.top + 10 && q.top < b.bottom - 10) rows[r.querySelector('[data-line]')?.getAttribute('data-line') ?? ''] = q.top
      }
      const L = document.querySelector('.tour-ex-labels')!.getBoundingClientRect()
      const holes = (window as any).__tour().geometry().holes as { x: number; y: number; w: number; h: number }[]
      const fixed = [[L.x, L.y, L.width, L.height], ...holes.map((h) => [h.x, h.y, h.w, h.h])].map((v) => v.map(Math.round).join()).join(';')
      return { top: sc.scrollTop, sh: sc.scrollHeight, rows, fixed, thumb: document.querySelector('.tour-ex-reader .reader-ruler-thumb')?.getBoundingClientRect().top ?? null, mid: { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
    })
  await probe(page)
  const first5 = await look5()
  let prev5 = first5,
    worst = 0
  const off: unknown[] = []
  for (const dy of [100, 100, 100, 100, 100, 100, -100, -100, -100, -100, -100, -100]) {
    await page.mouse.move(first5.mid.x, first5.mid.y)
    await page.mouse.wheel(0, dy)
    await sleep(120)
    const cur = await look5(),
      d = cur.top - prev5.top
    for (const [id, y] of Object.entries(prev5.rows)) if (cur.rows[id] != null) worst = Math.max(worst, Math.abs(cur.rows[id] - y + d))
    if (Math.abs(d) < 1 || cur.sh !== first5.sh || cur.fixed !== first5.fixed || cur.thumb == null || prev5.thumb == null || Math.sign(cur.thumb - prev5.thumb) !== Math.sign(d))
      off.push({ dy, d, sh: [first5.sh, cur.sh], fixed: cur.fixed === first5.fixed, thumb: [prev5.thumb, cur.thumb] })
    prev5 = cur
  }
  assert.ok(worst <= 1 && !off.length, `${tag} 5: the transcript scrolls in steps with no record jumping (worst ${Math.round(worst * 10) / 10} px), its height, the cutout and the Labels pane still, the thumb following ${JSON.stringify(off.slice(0, 3))}`)
  // the wheel over the ruler scrolls the transcript too, and a long wheel scrolls it far
  const rb = await page.evaluate(() => {
    const b = document.querySelector('.tour-ex-reader .reader-ruler')!.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: document.querySelector('.tour-ex-reader .reader-body')!.scrollTop }
  })
  await page.mouse.move(rb.x, rb.y)
  await page.mouse.wheel(0, 240)
  await sleep(300)
  const overRuler = (await page.evaluate(() => document.querySelector('.tour-ex-reader .reader-body')!.scrollTop)) - rb.top
  assert.ok(overRuler >= 100, `${tag} 5: the wheel over the ruler scrolls the transcript (${overRuler})`)
  await page.mouse.move(first5.mid.x, first5.mid.y)
  await page.mouse.wheel(0, 600)
  await sleep(500)
  const rdTop = await page.evaluate(() => document.querySelector('.tour-ex-reader .reader-body')!.scrollTop)
  assert.ok(rdTop > rb.top + overRuler + 100, `${tag} 5: the wheel scrolls the transcript (${rb.top + overRuler} to ${rdTop})`)
  assert.deepEqual(await probe(page), [], `${tag} 5: the wheel reached nothing else`)
  await next(page)
  // 6 Views: the example view takes the pointer
  await onStep(page, 6, 'Views')
  await measure(page, `${tag} 6`)
  assert.equal(await page.evaluate(() => document.querySelector('.tour-ex-viewsbar .seg-opt.active')?.textContent?.trim()), 'Timeline', `${tag} 6: the Timeline example is on`)
  assert.equal(await page.evaluate(() => !!document.querySelector('.tour-ex-viewbody .tour-tag')), false, `${tag} 6: no Example badge on the view`)
  await page.waitForFunction(() => {
    const f = document.querySelector<HTMLIFrameElement>('.tour-ex-viewbody iframe')
    return !!f?.contentDocument?.querySelector<HTMLIFrameElement>('.view-pane-frame')?.contentDocument?.getElementById('list')
  })
  // inside the example view the wheel scrolls its list and a click reaches its page; the app sees none of it
  const view = page.frames().find((f) => new URL(f.url()).pathname.endsWith('/tour/timeline/page.html'))!
  // the page's text cells clip at their content edge, so a mark on a word past the ellipsis does not show in the padding
  const unclipped = await view.evaluate(() =>
    [...document.querySelectorAll('#tbl td.x')].flatMap((td) => {
      const xt = td.querySelector('.xt'),
        cs = getComputedStyle(td),
        b = td.getBoundingClientRect(),
        x = xt?.getBoundingClientRect()
      return !xt || !x || getComputedStyle(xt).overflow !== 'hidden' || x.right > b.right - parseFloat(cs.paddingRight) + 0.5 ? [td.textContent!.slice(0, 30)] : []
    }),
  )
  assert.deepEqual(unclipped.slice(0, 3), [], `${tag} 6: the example's text cells clip at their content edge`)
  const listTop = () => view.evaluate(() => document.getElementById('list')!.scrollTop)
  const top0 = await listTop()
  await view.evaluate(() => {
    ;(window as any).__clicks = 0
    document.addEventListener('click', () => (window as any).__clicks++, true)
  })
  const vb = await page.evaluate(() => {
    const b = document.querySelector('.tour-ex-viewbody iframe')!.getBoundingClientRect()
    return { x: b.x + b.width * 0.6, y: b.y + b.height * 0.75 }
  })
  await probe(page)
  await page.mouse.move(vb.x, vb.y)
  await page.mouse.wheel(0, 500)
  await sleep(700)
  await page.mouse.click(vb.x, vb.y)
  await sleep(400)
  const top1 = await listTop()
  assert.ok(top1 > top0 + 50, `${tag} 6: the wheel scrolls the example view's list (${top0} to ${top1})`)
  assert.equal(await view.evaluate(() => (window as any).__clicks), 1, `${tag} 6: a click reaches the example view`)
  assert.deepEqual(await probe(page), [], `${tag} 6: nothing reached the app`)
  assert.equal((await state(page))!.title, 'Views', `${tag} 6: still on Views`)
  // the view's header strip: nothing in it meets anything, its label control says how many labels are on, and the
  // line the reader could not read is counted in the strip's ink
  let hv = await viewHead(page)
  assert.ok(hv.ok && hv.lead === '2 labels on' && hv.residueText === '1 unreadable line' && !hv.filter, `${tag} 6: the view's header ${JSON.stringify(hv)}`)
  // a label switched off in the page's colour menu leaves one on
  await view.evaluate(() => document.querySelector<HTMLElement>('.th-colour-by')!.click())
  await view.evaluate(() => document.querySelector<HTMLElement>('.th-item[data-lab="Charged twice"]')!.click())
  await sleep(200)
  assert.equal((await viewHead(page)).lead, '1 label on', `${tag} 6: one label on`)
  await view.evaluate(() => document.querySelector<HTMLElement>('.th-item[data-lab="Charged twice"]')!.click())
  await view.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  // the page's Only these shows as thimble's filter chip with how many events it hides, beside the strip's items, and
  // the chip clears it
  await view.evaluate(() => document.querySelector<HTMLElement>('.th-lg[data-k="Database connections"] .th-lname')!.click())
  await view.evaluate(() => document.querySelector<HTMLElement>('.th-only')!.click())
  await sleep(300)
  hv = await viewHead(page)
  const lacking = await view.evaluate(() => (window as any).DATA.events.filter((e: { marks: string[] }) => !e.marks.includes('Database connections')).length)
  assert.ok(hv.ok && hv.lead === '2 labels on' && hv.filter === 'Database connections · connections' && hv.hidden === `${lacking} hidden`, `${tag} 6: the filter in the view's header ${JSON.stringify(hv)}`)
  const hf = page.frames().find((f) => f.url().includes('/tour/timeline/view.html'))!
  await hf.evaluate(() => document.querySelector<HTMLElement>('.view-pane-filter')!.click())
  await sleep(200)
  hv = await viewHead(page)
  assert.ok(hv.ok && !hv.filter && !hv.hidden && (await view.evaluate(() => (window as any).mock.thimble.state.iso)) === null, `${tag} 6: the chip clears the filter ${JSON.stringify(hv)}`)
  // the unreadable line opens thimble's list of it under the header's items, in neutral ink, above the page, and closes
  // again
  await hf.evaluate(() => document.querySelector<HTMLElement>('.view-pane-residue')!.click())
  await sleep(200)
  const rl = await hf.evaluate(() => {
    const list = document.querySelector('.view-pane-residue-list'),
      head = Math.max(...[...document.querySelectorAll('.scope-head .sh, .scope-head .view-pane-side-show')].map((e) => e.getBoundingClientRect().bottom)),
      body = document.querySelector('.view-pane-body')!.getBoundingClientRect()
    if (!list) return null
    const b = list.getBoundingClientRect(),
      why = list.querySelector('.view-pane-list-why')!
    const ink = (v: string) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${v})`
      document.body.append(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    }
    return {
      items: [...list.querySelectorAll('.view-pane-list-item')].map((x) => x.textContent),
      between: b.top >= head - 0.5 && b.bottom <= body.top + 0.5 && b.left >= 0 && b.right <= innerWidth + 0.5,
      why: getComputedStyle(why).color,
      tertiary: ink('--text-tertiary'),
      negative: ink('--status-negative'),
      expanded: document.querySelector('.view-pane-residue')!.getAttribute('aria-expanded'),
    }
  })
  assert.ok(
    rl && rl.items.length === 1 && rl.items[0]!.startsWith('agents.log#L29') && rl.between && rl.why === rl.tertiary && rl.why !== rl.negative && rl.expanded === 'true',
    `${tag} 6: the unreadable line listed under the header ${JSON.stringify(rl)}`,
  )
  await hf.evaluate(() => document.querySelector<HTMLElement>('.view-pane-residue')!.click())
  await sleep(200)
  assert.equal(await hf.evaluate(() => !!document.querySelector('.view-pane-residue-list')), false, `${tag} 6: the list closes`)
  assert.equal((await state(page))!.title, 'Views', `${tag} 6: still on Views`)
  await page.evaluate(LOG7)
  await next(page)
  // 7 Cards: the demo shows the source of 08:04; the card is in plain words; a real hover on a value shows its source
  await onStep(page, 7, 'Cards on the Canvas')
  await page.waitForFunction(() => document.querySelector('.tour-fx .refchip-pop[data-demo] .hl')?.textContent === '08:04', null, { timeout: 8000 })
  // on its first entry the demo plays once the card is in place: the pointer shows soon after Next, glides and comes to
  // rest on 08:04 as its source shows, and the card holds still
  const r7 = judge7(await takeLog7(page))
  assert.ok(r7.ok, `${tag} 7: the cards demo plays onto 08:04 ${JSON.stringify(r7)}`)
  const words = await page.evaluate(() => {
    const c = (window as any).__tour().api.els.card as Element
    return { text: [...c.querySelectorAll('.canvas-tl-label, .bcell-take-text')].map((e) => e.textContent ?? ''), check: !!c.querySelector('.bcell-check') }
  })
  assert.ok(words.text.length > 5 && !words.text.some((t) => t.includes(';')) && !words.check, `${tag} 7: the example card in plain words, without semicolons or a check mark ${JSON.stringify(words)}`)
  await page.evaluate(() => (window as any).__tour().api.stopDemo())
  await sleep(300)
  await measure(page, `${tag} 7`)
  const chip = await page.evaluate(() => {
    const c = [...(window as any).__tour().api.els.card.querySelectorAll('.refchip-value')].find((e: Element) => e.textContent?.trim() === '08:29') as Element
    const b = c.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  await page.mouse.move(chip.x - 40, chip.y - 40)
  await page.mouse.move(chip.x, chip.y, { steps: 4 })
  await sleep(700)
  assert.equal(await page.evaluate(() => document.querySelector('.tour-fx .refchip-pop[data-src]:not([data-demo]) .hl')?.textContent), '08:29', `${tag} 7: a hover shows the value's source`)
  await page.mouse.move(g.viewport.w - 30, g.viewport.h - 30, { steps: 4 })
  await sleep(500)
  await next(page)
  // 8 ⌘-click: the demo's ⌘-drag, with its key badge inside the card and never over its text; no Next until the analyst
  // asked; a real ⌘-drag over two words picks only those words
  await onStep(page, 8, '⌘-click to ask')
  const seen: { badge: { over: string; inCard: boolean; key: string } | null; sel: number; hl: number | null; cardW: number; asked: number; after: boolean }[] = []
  for (let k = 0; k < 120; k++) {
    const f = await page.evaluate(() => {
      const card = (window as any).__tour().api.els.card as Element
      const C = card.getBoundingClientRect()
      const key = document.querySelector('.tour-key')
      let badge = null
      if (key) {
        const b = key.getBoundingClientRect()
        let over = ''
        const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
        for (let n = w.nextNode(); n && !over; n = w.nextNode()) {
          if (!n.textContent?.trim()) continue
          const q = document.createRange()
          q.selectNodeContents(n)
          for (const r of q.getClientRects()) if (r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom) over = n.textContent.slice(0, 40)
        }
        badge = { over, inCard: b.left >= C.left && b.right <= C.right && b.top >= C.top && b.bottom <= C.bottom, key: key.querySelector('b')?.textContent ?? '' }
      }
      const hl = document.querySelector('.tour-fx .pointer-hl.tour-mock')
      return {
        badge,
        sel: getSelection()?.toString().length ?? 0,
        hl: hl ? hl.getBoundingClientRect().width : null,
        cardW: C.width,
        asked: document.querySelector<HTMLTextAreaElement>('.tour-fx .pointer-box.tour-mock textarea')?.value.length ?? 0,
        after: !!document.querySelector('.tour-after'),
      }
    })
    seen.push(f)
    if (f.after) break
    await sleep(150)
  }
  const badges = seen.map((f) => f.badge).filter((b): b is NonNullable<typeof b> => !!b)
  assert.ok(badges.length > 0 && badges.every((b) => b.key === '⌘' && b.inCard && !b.over), `${tag} 8: the ⌘ badge stands inside the card, over none of its text ${JSON.stringify(badges.filter((b) => b.over || !b.inCard).slice(0, 2))}`)
  assert.ok(seen.some((f) => f.sel > 3), `${tag} 8: the demo selects words`)
  assert.ok(seen.some((f) => f.hl != null && f.hl > 10 && f.hl < f.cardW * 0.6), `${tag} 8: the demo picks a few words, not the card`)
  assert.ok(seen.some((f) => f.asked > 20), `${tag} 8: the demo types a question in the ask box`)
  assert.ok(seen[seen.length - 1].after, `${tag} 8: the demo ends`)
  await sleep(300)
  await measure(page, `${tag} 8`)
  assert.deepEqual(await buttons(page), ['back'], `${tag} 8: no Next before the try`)
  assert.match(await body(page), /Now try it yourself/, `${tag} 8: try it yourself`)
  // once the demo is over, "⌘-click here" points at the end of the 08:29 entry's text, 0 to 8 px past it and level
  // with its last line, through its nudge, and covers no text of the card and not the popover
  const cue = await page.evaluate(CUE)
  const cues = cue.filter((c): c is NonNullable<typeof c> => !!c)
  assert.ok(
    cues.length === cue.length && cues.every((c) => c.text === '⌘-click here' && c.gap >= 0 && c.gap <= 8 && Math.abs(c.dy) <= 2 && !c.hits.length && !c.overPop),
    `${tag} 8: the cue points at the entry and covers no text ${JSON.stringify(cue)}`,
  )
  const span = await page.evaluate(() => {
    const card = (window as any).__tour().api.els.card as Element
    const label = [...card.querySelectorAll('.canvas-tl-row')].find((r) => r.querySelector('.canvas-tl-time')?.textContent?.trim() === '08:29')!.querySelector('.canvas-tl-label')!
    const node = [...label.childNodes].find((n) => n.nodeType === 3 && n.textContent?.trim()) as Text
    const at = (k: number, right = false) => {
      const q = document.createRange()
      q.setStart(node, k)
      q.setEnd(node, k + 1)
      const b = q.getBoundingClientRect()
      return { x: right ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 }
    }
    const end = node.textContent!.indexOf(' ', node.textContent!.indexOf(' ') + 1)
    return { a: at(0), z: at(end - 1, true), cardW: card.getBoundingClientRect().width }
  })
  await page.mouse.move(span.a.x - 20, span.a.y)
  await page.keyboard.down('Meta')
  await page.mouse.move(span.a.x, span.a.y, { steps: 3 })
  await page.mouse.down()
  await page.mouse.move(span.z.x, span.z.y, { steps: 6 })
  await page.mouse.up()
  await sleep(250)
  await page.keyboard.up('Meta')
  await page.waitForFunction(() => [...document.querySelectorAll('.pointer-box')].some((b) => !b.closest('.tour-root')), null, { timeout: 5000 })
  await sleep(700)
  const asking = await measure(page, `${tag} 8 (asking)`)
  assert.equal(await page.$('.tour-cue'), null, `${tag} 8: the cue is gone once the analyst tried`)
  const picked = await page.evaluate((h) => {
    const box = [...document.querySelectorAll('.pointer-box')].find((b) => !b.closest('.tour-root'))!
    const hl = [...document.querySelectorAll('.pointer-hl[data-on]')].find((x) => !x.closest('.tour-root'))!
    const ins = (e: Element) => {
      const b = e.getBoundingClientRect()
      return Math.min(b.left - h.x, h.x + h.w - b.right, b.top - h.y, h.y + h.h - b.bottom)
    }
    return { box: ins(box), hl: ins(hl), w: hl.getBoundingClientRect().width }
  }, asking.holes[0])
  assert.ok(picked.box >= -0.5 && picked.hl >= -0.5, `${tag} 8: the ask box and the highlight lie inside the cutout ${JSON.stringify(picked)}`)
  assert.ok(picked.w > 10 && picked.w < span.cardW * 0.5, `${tag} 8: only the words dragged over are picked (${Math.round(picked.w)} of ${Math.round(span.cardW)}px)`)
  await page.keyboard.type('What happened here?')
  if (send) {
    // Enter sends nothing while the tour runs (the walk's writes are checked after it): the box closes and the tour
    // moves on
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => ![...document.querySelectorAll('.pointer-box')].some((b) => !b.closest('.tour-root')))
  } else {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => ![...document.querySelectorAll('.pointer-box')].some((b) => !b.closest('.tour-root')))
    await sleep(600)
    assert.equal((await state(page))!.n, 8, `${tag} 8: Esc closes the box and stays on the step`)
    assert.equal(await page.$('.tour-cue'), null, `${tag} 8: the cue stays gone after Esc`)
    assert.deepEqual(await buttons(page), ['back', 'next'], `${tag} 8: Next once tried`)
    await next(page)
  }
  // 9 the Report: at most its own size, no comment yet, the wheel scrolls it
  await onStep(page, 9, 'The Report')
  await measure(page, `${tag} 9`)
  const r9 = await page.evaluate(() => {
    const root = document.querySelector('.tour-ex-report')!
    return {
      shown: [...root.querySelectorAll('.wu-cm')].filter((c) => getComputedStyle(c).visibility !== 'hidden').length,
      k: (window as any).__tour().api.els.k,
      top: root.querySelector('.wu-page')!.scrollTop,
    }
  })
  assert.equal(r9.shown, 0, `${tag} 9: no check comment before the check is made`)
  const fig = await page.evaluate(() => {
    const root = document.querySelector('.tour-ex-report')!
    const first = root.querySelector('figure.wu-fig')
    return {
      q: first?.querySelector('.wu-fig-q')?.textContent?.trim(),
      rows: first?.querySelectorAll('tbody tr').length ?? 0,
      check: [...root.querySelectorAll<HTMLElement>('.wu-check')].filter((e) => /Alternative explanations/.test(e.textContent ?? '') && getComputedStyle(e).display !== 'none').length,
    }
  })
  assert.deepEqual(fig, { q: 'How close did the database come to its limit of 200 connections?', rows: 4, check: 0 }, `${tag} 9: the first figure is the small table, and the check is not made yet`)
  assert.ok(r9.k <= 1 && r9.top === 0, `${tag} 9: the report at its own size or smaller, at its top`)
  // every chart and table as wide as its figure; no comment margin until the check is made, so the text column is as
  // wide as thimble's own Report draws it with no check on, for a panel as wide as the example is laid out
  const figs = await page.evaluate(FIGS)
  assert.ok(figs.length === 5 && figs.every((f) => f.width != null && Math.abs(f.width - f.content) <= 3), `${tag} 9: every chart and table as wide as its figure ${JSON.stringify(figs)}`)
  const col9 = await page.evaluate(REPORTCOL)
  const own = await ownReport(col9.inner)
  assert.ok(!col9.margin && Math.abs(col9.col - own.col) <= 1, `${tag} 9: no comment margin, and the column as wide as thimble's own Report ${JSON.stringify({ col9, own })}`)
  // 10 Checks: the demo opens a new check, named, and runs it; the margin stands at Run and not before, the comments
  // appear in it, and only then does the page scroll to one
  await next(page)
  const watch10 = async () => {
    const seen: { n: number; card: boolean; name: string | null; hidden: boolean; margin: boolean; top: number; demo: string }[] = []
    for (let k = 0; k < 400; k++) {
      const f = await page.evaluate(() => {
        const t = (window as any).__tour(),
          st = t.state()
        const c = document.querySelector('.tour-fx .check-card')
        const root = t.api.els.root as HTMLElement | undefined,
          pg = t.api.els.page as HTMLElement | undefined
        const rail = root?.querySelector<HTMLElement>('.wu-rail')
        return { n: st.n, card: !!c, name: c?.querySelector('input')?.value ?? null, hidden: !!root?.classList.contains('tour-checks-hidden'), margin: !!rail && getComputedStyle(rail).display !== 'none' && rail.offsetWidth > 0, top: Math.round(pg?.scrollTop || 0), demo: st.demo }
      })
      if (f.n === 10) seen.push(f)
      if (f.n === 10 && f.demo === 'done') break
      await sleep(80)
    }
    const shownAt = seen.findIndex((f) => !f.hidden)
    const marginAt = seen.findIndex((f) => f.margin)
    const movedAt = shownAt > 0 ? seen.findIndex((f, k) => k > shownAt && Math.abs(f.top - seen[shownAt].top) > 20) : -1
    return { ok: seen.some((f) => f.card && f.name === 'Alternative explanations') && !!seen.length && !seen[0].margin && marginAt > 0 && marginAt <= shownAt && shownAt > 0 && movedAt > shownAt && seen[seen.length - 1].demo === 'done', marginAt, shownAt, movedAt, frames: seen.length }
  }
  const d10 = await watch10()
  assert.ok(d10.ok, `${tag} 10: the check is named and run; the margin stands, then the comments show in it, then the page scrolls ${JSON.stringify(d10)}`)
  await onStep(page, 10, 'Checks')
  // Back to the Report: the margin goes again and the column is thimble's own again; Next makes the check again
  const m10 = await page.evaluate(REPORTCOL)
  await page.click('.tour-pop [data-tour="back"]')
  await onStep(page, 9, 'The Report')
  await sleep(500)
  const b9 = await page.evaluate(REPORTCOL)
  assert.ok(m10.margin && !b9.margin && Math.abs(b9.col - own.col) <= 1, `${tag} 9/10: the margin with the comments on step 10 and none after Back ${JSON.stringify({ m10, b9, own })}`)
  await next(page)
  await onStep(page, 10, 'Checks')
  await page.waitForFunction(() => (window as any).__tour().state().demo === 'done', null, { timeout: 25000 })
  await sleep(700)
  assert.equal(
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tour-ex-report .wu-check')].filter((e) => /Alternative explanations/.test(e.textContent ?? '') && getComputedStyle(e).display !== 'none').length),
    1,
    `${tag} 10: the check is in the Checks pane`,
  )
  await measure(page, `${tag} 10`)
  const before = await commentsLevel(page)
  assert.ok(before.length >= 2 && before.every((c) => c.ok), `${tag} 10: each comment card level with its passage ${JSON.stringify(before)}`)
  const pg = await page.evaluate(() => {
    const b = document.querySelector('.tour-ex-report .wu-page')!.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  await page.mouse.move(pg.x, pg.y)
  await page.mouse.wheel(0, 1400)
  await sleep(800)
  const scrolled = await page.evaluate(() => document.querySelector('.tour-ex-report .wu-page')!.scrollTop)
  assert.ok(scrolled > 300, `${tag} 10: the wheel scrolls the report (${scrolled})`)
  const after = await commentsLevel(page)
  assert.ok(after.every((c) => c.ok), `${tag} 10: still level once scrolled ${JSON.stringify(after)}`)
  assert.deepEqual(await buttons(page), ['back', 'done'], `${tag} 10: Back and Done`)
  await page.click('.tour-pop [data-tour="done"]')
  await sleep(500)
  assert.equal(await page.evaluate(() => !!document.querySelector('.tour-root, .tour-host')), false, `${tag}: Done removes the tour and its examples`)
}

const fontOk = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready
    const family = getComputedStyle(document.querySelector('.tour-title')!).fontFamily.split(',')[0].replace(/['"]/g, '')
    return family === 'Hanken Grotesk' && document.fonts.check('16px "Hanken Grotesk"') && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Hanken Grotesk' && f.status === 'loaded')
  })

/** What a run of the tour may write: the browser's key, the theme, telemetry and the offer, and nothing else. */
const ALLOWED = new Set(['POST /api/ui/key', `PUT /api/ws/${WS}/render/theme`, 'POST /api/tour/seen', `POST /api/ws/${WS}/telemetry`])
/** The telemetry of a click in the tour, which is not the analyst's work and is never sent. */
const tourClicks = (s: Server) => s.telemetry.filter((t) => t.kind === 'ui-click')
/** Everything telemetry sent but the page's load, which comes before the tour: while the tour runs, nothing. */
const tourTelemetry = (s: Server) => s.telemetry.filter((t) => t.kind !== 'page-load').map((t) => t.kind)

test('the first launch asks first, records the offer in thimble’s own state, and offers nothing once answered', async () => {
  const { page, server, close } = await open({ W: 1440, H: 900 })
  try {
    await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
    const w = await page.evaluate(() => ({
      title: document.querySelector('.tour-title')?.textContent,
      text: document.querySelector('.tour-body')?.textContent,
      buttons: [...document.querySelectorAll('.tour-pop button')].map((b) => b.textContent?.trim()),
      count: !!document.querySelector('.tour-count'),
      holes: document.querySelectorAll('.tour-dim mask rect').length,
    }))
    assert.deepEqual(w, { title: 'Welcome to thimble', text: 'Would you like a short tour?', buttons: ['Skip', 'Take the tour'], count: false, holes: 1 })
    assert.ok(await fontOk(page), 'the tour is drawn in Hanken Grotesk, loaded')
    assert.ok(server.seen, 'the offer is recorded once it shows')
    await page.click('.tour-pop [data-tour="skip"]')
    await sleep(300)
    assert.equal(await page.$('.tour-root'), null, 'Skip closes it')
    await page.reload()
    await page.waitForSelector('.shell .chat-foot')
    await sleep(2500)
    assert.equal(await page.$('.tour-root'), null, 'a page loaded after the offer offers nothing')
    assert.deepEqual(server.writes.filter((x) => !ALLOWED.has(x)), [], 'nothing else was written')
    assert.deepEqual(tourClicks(server), [], 'no click in the tour reaches telemetry')
  } finally {
    await close()
  }
}, 60_000)

test('Esc on the welcome closes it, and the offer stays recorded', async () => {
  const { page, server, close } = await open({ W: 1440, H: 900 })
  try {
    await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
    await probe(page)
    await page.keyboard.press('Escape')
    await sleep(300)
    assert.equal(await page.$('.tour-root'), null, 'Esc closes the welcome')
    assert.deepEqual(await probe(page), [], 'the Esc reached nothing of the page')
    assert.ok(server.seen, 'the offer is recorded')
  } finally {
    await close()
  }
}, 60_000)

for (const cfg of [
  { W: 1440, H: 900, dpr: 1, chat: 308, folds: false },
  { W: 1920, H: 1080, dpr: 1, chat: 308, folds: false, send: true },
  { W: 1200, H: 800, dpr: 2, chat: 355 },
  // a Files panel too narrow for its sidebar, which folds
  { W: 1100, H: 800, dpr: 2, chat: 355, folds: true },
]) {
  const tag = `${cfg.W}x${cfg.H}@${cfg.dpr}${cfg.chat !== 308 ? ` chat ${cfg.chat}` : ''}`
  test(`every step at ${tag}: the cutouts, the popover and what they show line up, and the page stays frozen`, async () => {
    const { page, server, close } = await open(cfg)
    try {
      await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
      const panel = await page.evaluate(() => Math.round(document.querySelector('.chat[data-panel="chat"]')!.getBoundingClientRect().width))
      assert.ok(Math.abs(panel - cfg.chat) <= 2, `the chat column is ${panel}px`)
      await page.click('.tour-pop [data-tour="begin"]')
      await walk(page, tag, cfg.folds, cfg.send)
      // the layout's own surface again (the stored layout was on the Report)
      assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('.shell-tabs .tab.active')?.dataset.tab), 'report')
      assert.deepEqual(server.writes.filter((x) => !ALLOWED.has(x)), [], 'the tour wrote nothing to the workspace')
      // past telemetry's flush delay, so anything recorded during the tour has been sent
      await sleep(2500)
      assert.deepEqual(tourTelemetry(server), [], 'telemetry recorded nothing of the tour, ⌘-click on the example included')
    } finally {
      await close()
    }
  }, 150_000)
}

/** From the welcome to step 6, Views, with the orientation's Start pressed on step 3. */
async function toViews(page: Page) {
  await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
  await page.click('.tour-pop [data-tour="begin"]')
  await onStep(page, 1)
  await next(page)
  await onStep(page, 2)
  await next(page)
  await onStep(page, 3)
  const sb = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tour-ex-gate button')].find((x) => x.textContent?.trim() === 'Start')!.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  await page.mouse.click(sb.x, sb.y)
  await page.waitForFunction(() => document.querySelector('.tour-body')?.textContent?.startsWith('The orientation has started'), null, { timeout: 3000 })
  for (const n of [4, 5, 6]) {
    await next(page)
    await onStep(page, n)
  }
}

test('on the Dark paper the example view and its page take the workbench’s colours', async () => {
  const { page, close } = await open({ W: 1440, H: 900, paper: 'dark' })
  try {
    await toViews(page)
    await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.tour-ex-viewbody iframe')?.contentDocument?.querySelector<HTMLIFrameElement>('.view-pane-frame')?.contentDocument?.getElementById('list'))
    // in each document: its theme, its card ground and text ink, and the colour of the first label
    const colours = () => {
      const ink = (prop: string, v: string) => {
        const probe = document.createElement('span')
        probe.style.setProperty(prop, `var(${v})`)
        document.body.append(probe)
        const c = getComputedStyle(probe).getPropertyValue(prop)
        probe.remove()
        return c
      }
      return { theme: document.documentElement.getAttribute('data-theme'), card: ink('background-color', '--surface-card'), text: ink('color', '--text-primary'), label: ink('color', '--label-1') }
    }
    const app = await page.evaluate(colours)
    const view = page.frames().find((f) => new URL(f.url()).pathname.endsWith('/tour/timeline/page.html'))!
    const got = { ...(await view.evaluate(colours)), body: await view.evaluate(() => getComputedStyle(document.body).backgroundColor) }
    assert.ok(app.theme === 'dark' && got.theme === 'dark' && got.body === app.card && got.card === app.card && got.text === app.text && got.label === app.label, `the example's page in the workbench's dark colours ${JSON.stringify({ app, got })}`)
    const hv = await viewHead(page)
    assert.ok(hv.ok && hv.residueText === '1 unreadable line', `the view's header on the Dark paper ${JSON.stringify(hv)}`)
  } finally {
    await close()
  }
}, 90_000)

test('the cards demo waits for a Canvas drawn late, and a hover that stops it leaves the ⌘ demo to play at once', async () => {
  const { page, close } = await open({ W: 1440, H: 900 })
  try {
    await toViews(page)
    // the Canvas panel shows only 1.5 s after Next, as a slow first draw would
    await page.evaluate(() => {
      const st = document.createElement('style')
      st.textContent = '[data-panel="canvas"].shell-panel { display: none !important }'
      document.head.append(st)
      setTimeout(() => st.remove(), 1500)
    })
    await page.evaluate(LOG7)
    await next(page)
    await page.waitForFunction(() => document.querySelector('.tour-fx .refchip-pop[data-demo] .hl')?.textContent === '08:04', null, { timeout: 10000 })
    const r7 = judge7(await takeLog7(page), 3000)
    assert.ok(r7.ok && r7.firstMs! >= 1500, `the demo waits for the card and plays onto 08:04 ${JSON.stringify(r7)}`)
    // a hover on a value stops the demo and shows that value's source
    const c = await page.evaluate(() => {
      const el = [...(window as any).__tour().api.els.card.querySelectorAll('.refchip-value')].find((x: Element) => x.textContent?.trim() === '08:29') as Element
      const b = el.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    })
    await page.mouse.move(c.x + 60, c.y - 60, { steps: 4 })
    await page.mouse.move(c.x, c.y, { steps: 6 })
    await sleep(1200)
    const hov = await page.evaluate(() => ({ demo: (window as any).__tour().state().demo, src: document.querySelectorAll('.tour-fx [data-src]:not([data-demo])').length }))
    assert.deepEqual(hov, { demo: 'stopped', src: 1 }, 'the hover stopped the demo and shows the source')
    // Next plays the ⌘ demo at once, and the hovered source is closed
    await page.evaluate(() => {
      const w = window as any
      w.__log8 = []
      const t0 = performance.now()
      const f = () => {
        if (!w.__log8) return
        const el = document.querySelector<HTMLElement>('.tour-cursor'),
          m = el && /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform)
        w.__log8.push({ t: Math.round(performance.now() - t0), n: w.__tour().state().n, at: m ? `${Math.round(+m[1])},${Math.round(+m[2])}` : null, key: !!document.querySelector('.tour-key'), src: document.querySelectorAll('.tour-fx [data-src]:not([data-demo])').length })
        if (w.__log8.length < 600) requestAnimationFrame(f)
      }
      requestAnimationFrame(f)
    })
    const nb = await page.evaluate(() => {
      const b = document.querySelector('.tour-pop [data-tour="next"]')!.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    })
    await page.mouse.move(nb.x, nb.y, { steps: 6 })
    await page.mouse.down()
    await page.mouse.up()
    await sleep(2500)
    const l8 = ((await page.evaluate(() => {
      const l = (window as any).__log8
      ;(window as any).__log8 = null
      return l
    })) as { t: number; n: number; at: string | null; key: boolean; src: number }[]).filter((x) => x.n === 8)
    const first8 = l8.find((x) => x.at)
    const r8 = { first: first8?.t ?? null, places: new Set(l8.filter((x) => x.at).map((x) => x.at)).size, key: l8.some((x) => x.key), src: l8.length ? l8[l8.length - 1].src : null }
    assert.ok(r8.first != null && r8.first <= 1000 && r8.places >= 10 && r8.key && r8.src === 0, `the ⌘ demo plays at once and the hovered source is closed ${JSON.stringify(r8)}`)
    await page.keyboard.press('Escape')
  } finally {
    await close()
  }
}, 90_000)

test('Settings’ Take the tour replays the tour from step 1, without the welcome', async () => {
  const { page, close } = await open({ W: 1440, H: 900, seen: true })
  try {
    await page.waitForSelector('.shell .chat-foot')
    await sleep(1500)
    assert.equal(await page.$('.tour-root'), null, 'nothing shows by itself once offered')
    await page.click('[data-tel="settings"]')
    await page.waitForSelector('.settings-foot .settings-tour')
    const foot = await page.evaluate(() => [...document.querySelectorAll('.settings-foot button')].map((b) => b.textContent?.trim()))
    assert.deepEqual(foot, ['Take the tour', 'Cancel', 'Save'])
    await page.click('.settings-foot .settings-tour')
    await onStep(page, 1, 'Your Claude Code session')
    const st = await state(page)
    assert.ok(st && !st.welcome && st.i === 0 && st.total === 10, 'step 1 of 10, no welcome')
    await page.keyboard.press('Escape')
    await sleep(400)
    assert.equal(await page.$('.tour-root'), null, 'Esc closes the tour')
  } finally {
    await close()
  }
}, 60_000)

test('with the chat column folded the tour leaves out its three chat steps and starts on Files, without In the meantime', async () => {
  const { page, close } = await open({ W: 1440, H: 900, folded: true })
  try {
    await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
    await page.click('.tour-pop [data-tour="begin"]')
    await onStep(page, 1, 'Files')
    assert.equal((await state(page))!.total, 7)
    assert.equal(await body(page), 'The files browser exposes global views on the corpus.', 'no orientation to wait for')
    await measure(page, 'chat folded 1')
    assert.deepEqual(await buttons(page), ['skip', 'next'])
  } finally {
    await close()
  }
}, 60_000)

test('an ask box left open closes when Settings’ Take the tour starts the tour, and sends nothing', async () => {
  const { page, server, close } = await open({ W: 1440, H: 900, seen: true })
  try {
    await page.waitForSelector('.shell .chat-foot')
    // something on the page that a ⌘-click asks about, as a file's row or a card is
    await page.evaluate(() => {
      const el = document.createElement('div')
      el.setAttribute('data-anchor', 'README.md')
      el.setAttribute('data-anchor-text', 'README.md')
      el.textContent = 'README.md'
      Object.assign(el.style, { position: 'fixed', left: '700px', top: '400px', width: '200px', height: '30px', zIndex: '10' })
      document.querySelector('.shell')!.append(el)
    })
    const b = { x: 700, y: 400, height: 30 }
    await page.mouse.move(b.x + 20, b.y + b.height / 2)
    await page.keyboard.down('Meta')
    await page.mouse.click(b.x + 20, b.y + b.height / 2)
    await page.keyboard.up('Meta')
    await page.waitForSelector('.pointer-box')
    await page.keyboard.type('A draft')
    await page.click('[data-tel="settings"]')
    await page.click('.settings-foot .settings-tour')
    await onStep(page, 1, 'Your Claude Code session')
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.pointer-box')].some((x) => !x.closest('.tour-root'))), false, 'the ask box closed')
    await page.keyboard.press('Enter')
    await sleep(300)
    await page.keyboard.press('Escape')
    await sleep(400)
    assert.equal(await page.$('.tour-root'), null, 'Esc closes the tour')
    assert.deepEqual(server.writes.filter((x) => !ALLOWED.has(x)), [], 'nothing was sent')
  } finally {
    await close()
  }
}, 60_000)
