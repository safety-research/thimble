// The product tour's welcome (src/tour, shell/TourHost) over the whole app in headless Chromium: the real App, its
// stylesheets and fonts, against a made-up workspace whose every API answer this file gives. The first launch asks
// first (a welcome with Skip and Take the tour) and records the offer in thimble's own state (POST /api/tour/seen),
// writing nothing else; a page loaded after that offers nothing; and the page the screenshot tool opens at a card
// (backend tools._shot_card_in_ui) shows no welcome over the card and records no offer.
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
  permission_modes: {}, disabled_modes: [], config_error: '',
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
  // a view proposal waiting for the analyst, which the chat shows only once the tour ends
  [`/api/ws/${WS}/views/proposals`]: [{ slug: 'deploy-timeline', name: 'Deploy Timeline', description: 'Every deploy on one time axis.', task: 'see which deploys broke the database', claims: ['deploys.csv'], status: 'suggested', proposed_by: 'proposer', offered: { at: T, after: 'main' } }],
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
  /** the workspace's own views */
  views: unknown[]
}

/** A page on the made-up origin, answered by this file: the app, the tour's example view, the workspace's API. */
async function open(opts: { W: number; H: number; dpr?: number; chat?: number; seen?: boolean; folded?: boolean; paper?: string; views?: unknown[]; surface?: string; ref?: string }): Promise<{ page: Page; server: Server; close: () => Promise<void> }> {
  const server: Server = { seen: !!opts.seen, writes: [], telemetry: [], settings: { ...SETTINGS }, views: opts.views ?? [] }
  const ctx = await browser.newContext({ viewport: { width: opts.W, height: opts.H }, deviceScaleFactor: opts.dpr ?? 1 })
  await ctx.addInitScript(
    ({ ws, chat, open, paper, surface }) => {
      if (paper) localStorage.setItem('thimble:paper', paper)
      // a Mac, so ⌘ is the pointer's key
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined })
      localStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      sessionStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      localStorage.setItem(`thimble:${ws}:layout`, JSON.stringify({ chatWidth: chat, chatOpen: open, panes: { root: { kind: 'pane', id: 'p1', surface }, focus: 'p1' } }))
      // what reaches the page: every input an app listener on the document would hear, outside the tour
      ;(window as any).__probe = []
      for (const t of ['mousedown', 'click', 'keydown', 'wheel', 'contextmenu'])
        document.addEventListener(t, (e) => {
          if (!(e.target instanceof Element && e.target.closest('.tour-root, .tour-host'))) (window as any).__probe.push(`${t}:${(e as KeyboardEvent).key || ''}`)
        })
    },
    { ws: WS, chat: opts.chat ?? 308, open: !opts.folded, paper: opts.paper, surface: opts.surface ?? 'report' },
  )
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => answer(route, server))
  await page.goto(`${ORIGIN}/?ws=${WS}${opts.ref ? `&ref=${encodeURIComponent(opts.ref)}` : ''}`)
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
    if (p === '/api/ui/paired') return json({ paired: true, id: 'x' })
    if (p === `/api/ws/${WS}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': open\n\n' })
    if (p === `/api/corpora/${WS}/sources` && url.searchParams.get('depth') === '1') return json(folder(url.searchParams.get('path') ?? ''))
    if (p === `/api/corpora/${WS}/source`) return json(sourcePage(url.searchParams.get('path') ?? 'README.md'))
    if (p === `/api/ws/${WS}/labels/ruler`) return json({ path: url.searchParams.get('path') ?? '', total: 3, bins: 400, labels: [] })
    if (method === 'GET' && p === `/api/ws/${WS}/settings`) return json(server.settings)
    if (method === 'GET' && p === `/api/ws/${WS}/views`) return json(server.views)
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

const fontOk = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready
    const family = getComputedStyle(document.querySelector('.tour-title')!).fontFamily.split(',')[0].replace(/['"]/g, '')
    return family === 'Hanken Grotesk' && document.fonts.check('16px "Hanken Grotesk"') && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Hanken Grotesk' && f.status === 'loaded')
  })

/** What a run of the tour may write: the browser's sign-in, the theme, telemetry and the offer, and nothing else. */
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
    assert.deepEqual(w, { title: 'Welcome to thimble', text: 'Would you like a short tour? The demo tour uses example data.', buttons: ['Skip', 'Take the tour'], count: false, holes: 1 })
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

test('the page the screenshot tool opens at a card offers no welcome over it, nor records the offer', async () => {
  // a first launch whose dashboard has not been opened yet: the card screenshot (backend tools._shot_card_in_ui) loads
  // the page at `?ref=`, and the welcome would stand over the card in its picture
  const { page, server, close } = await open({ W: 1440, H: 900, folded: true, surface: 'canvas', ref: 'card:c0ffee00' })
  try {
    await page.waitForSelector('.shell .board-viewport')
    await sleep(3000)
    assert.equal(await page.evaluate(() => !!document.querySelector('.tour-root')), false, 'no welcome')
    assert.equal(server.seen, false, 'the offer is not recorded, so the analyst gets it')
  } finally {
    await close()
  }
}, 60_000)
