// The product tour (src/tour, shell/TourHost) over the whole app, in headless Chromium: the real App, its stylesheets
// and fonts, against a made-up workspace whose every API answer this file gives, at 1440x900, 1920x1080 and a chat
// column 355 px wide at DPR 2. What it proves, measured with getBoundingClientRect:
//   - the first launch asks first (a welcome with Skip to the workbench and Take the tour) and records the offer in
//     thimble's own state (POST /api/tour/seen); a page loaded after that offers nothing; Settings' Take the tour
//     replays the tour from step 1;
//   - every step: each cutout lies inside the window, everything an example shows in a cutout lies inside that cutout,
//     the popover lies inside the window and its caret points at the first cutout;
//   - step 1's example sits 8 px or more inside its cutout, which lies inside the chat panel; the orientation's Start
//     only shows the started state; the labels' transcript and the report scroll under the wheel; a real ⌘-drag on the
//     example card picks only the words dragged over and its ask box lies inside the cutout; the report shows no check
//     comment until the check is made, and then each comment card stands 8 px above its passage, or below the card
//     above it, before and after the report scrolls;
//   - the page is frozen: clicks, keys and the wheel reach nothing, and the tour writes nothing but the offer.
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
  run_cell_result_lines: 40, hide_chat: false,
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
  [`/api/ws/${WS}/settings`]: SETTINGS,
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
}

/** A page on the made-up origin, answered by this file: the app, the tour's example view, the workspace's API. */
async function open(opts: { W: number; H: number; dpr?: number; chat?: number; seen?: boolean }): Promise<{ page: Page; server: Server; close: () => Promise<void> }> {
  const server: Server = { seen: !!opts.seen, writes: [], telemetry: [] }
  const ctx = await browser.newContext({ viewport: { width: opts.W, height: opts.H }, deviceScaleFactor: opts.dpr ?? 1 })
  await ctx.addInitScript(
    ({ ws, chat }) => {
      // a Mac, so ⌘ is the pointer's key
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined })
      localStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      sessionStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      localStorage.setItem(`thimble:${ws}:layout`, JSON.stringify({ chatWidth: chat, chatOpen: true, panes: { root: { kind: 'pane', id: 'p1', surface: 'report' }, focus: 'p1' } }))
      // what reaches the page: every input an app listener on the document would hear, outside the tour
      ;(window as any).__probe = []
      for (const t of ['mousedown', 'click', 'keydown', 'wheel', 'contextmenu'])
        document.addEventListener(t, (e) => {
          if (!(e.target instanceof Element && e.target.closest('.tour-root, .tour-host'))) (window as any).__probe.push(`${t}:${(e as KeyboardEvent).key || ''}`)
        })
    },
    { ws: WS, chat: opts.chat ?? 308 },
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

/** The whole tour from step 1, with the assertions of each step. */
async function walk(page: Page, tag: string) {
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
  const rd = await page.evaluate(() => {
    const e = document.querySelector('.tour-ex-reader .reader-body')!
    const b = e.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: e.scrollTop }
  })
  await probe(page)
  await page.mouse.move(rd.x, rd.y)
  await page.mouse.wheel(0, 600)
  await sleep(500)
  const rdTop = await page.evaluate(() => document.querySelector('.tour-ex-reader .reader-body')!.scrollTop)
  assert.ok(rdTop > rd.top + 100, `${tag} 5: the wheel scrolls the transcript (${rd.top} to ${rdTop})`)
  assert.deepEqual(await probe(page), [], `${tag} 5: the wheel reached nothing else`)
  await next(page)
  // 6 Views: the example view takes the pointer
  await onStep(page, 6, 'Views')
  await measure(page, `${tag} 6`)
  assert.equal(await page.evaluate(() => document.querySelector('.tour-ex-viewsbar .seg-opt.active')?.textContent?.trim()), 'Timeline', `${tag} 6: the Timeline example is on`)
  await page.waitForFunction(() => {
    const f = document.querySelector<HTMLIFrameElement>('.tour-ex-viewbody iframe')
    return !!f?.contentDocument?.querySelector('.view-pane-frame')
  })
  await next(page)
  // 7 Cards: a real hover on a value shows its source
  await onStep(page, 7, 'Cards on the Canvas')
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
  // 8 ⌘-click: no Next until the analyst asked; a real ⌘-drag over two words picks only those words
  await onStep(page, 8, '⌘-click to ask')
  await page.evaluate(() => (window as any).__tour().api.stopDemo())
  await sleep(300)
  await measure(page, `${tag} 8`)
  assert.deepEqual(await buttons(page), ['back'], `${tag} 8: no Next before the try`)
  assert.match(await body(page), /Now try it yourself/, `${tag} 8: try it yourself`)
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
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => ![...document.querySelectorAll('.pointer-box')].some((b) => !b.closest('.tour-root')))
  await sleep(600)
  assert.equal((await state(page))!.n, 8, `${tag} 8: Esc closes the box and stays on the step`)
  assert.deepEqual(await buttons(page), ['back', 'next'], `${tag} 8: Next once tried`)
  await next(page)
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
  assert.ok(r9.k <= 1 && r9.top === 0, `${tag} 9: the report at its own size or smaller, at its top`)
  await next(page)
  // 10 Checks: the comments, each level with its passage, before and after a scroll
  await onStep(page, 10, 'Checks')
  await page.evaluate(() => {
    const t = (window as any).__tour()
    t.api.stopDemo()
    t.api.els.showChecks()
  })
  await sleep(700)
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
    assert.deepEqual(w, { title: 'Welcome to thimble', text: 'Would you like a product tour?', buttons: ['Skip to the workbench', 'Take the tour'], count: false, holes: 1 })
    assert.ok(await fontOk(page), 'the tour is drawn in Hanken Grotesk, loaded')
    assert.ok(server.seen, 'the offer is recorded once it shows')
    await page.click('.tour-pop [data-tour="skip"]')
    await sleep(300)
    assert.equal(await page.$('.tour-root'), null, 'Skip to the workbench closes it')
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

for (const cfg of [
  { W: 1440, H: 900, dpr: 1, chat: 308 },
  { W: 1920, H: 1080, dpr: 1, chat: 308 },
  { W: 1200, H: 800, dpr: 2, chat: 355 },
]) {
  const tag = `${cfg.W}x${cfg.H}@${cfg.dpr}${cfg.chat !== 308 ? ` chat ${cfg.chat}` : ''}`
  test(`every step at ${tag}: the cutouts, the popover and what they show line up, and the page stays frozen`, async () => {
    const { page, server, close } = await open(cfg)
    try {
      await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
      const panel = await page.evaluate(() => Math.round(document.querySelector('.chat[data-panel="chat"]')!.getBoundingClientRect().width))
      assert.ok(Math.abs(panel - cfg.chat) <= 2, `the chat column is ${panel}px`)
      await page.click('.tour-pop [data-tour="begin"]')
      await walk(page, tag)
      // the layout's own surface again (the stored layout was on the Report)
      assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('.shell-tabs .tab.active')?.dataset.tab), 'report')
      assert.deepEqual(server.writes.filter((x) => !ALLOWED.has(x)), [], 'the tour wrote nothing to the workspace')
      assert.deepEqual(tourClicks(server), [], 'no click in the tour reaches telemetry')
    } finally {
      await close()
    }
  }, 150_000)
}

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
