// The product tour (src/tour, shell/TourHost, shell/TourFrame) over the whole app in headless Chromium: the real App,
// its stylesheets and fonts, against made-up workspaces whose every API answer this file gives: the analyst's own
// folder, `pilot` (a session attached, five files of their own), and a worked example the tour runs in,
// `example-timeline` (no session: a demo page). The first launch asks first (a welcome with Skip and Take the tour)
// and records the offer in thimble's own state (POST /api/tour/seen), writing nothing else; a page loaded after that
// offers nothing; and the page the screenshot tool opens at a card (backend tools._shot_card_in_ui) shows no welcome
// over the card and records no offer. The tour never lays an example over the analyst's files: Take the tour opens the
// demo workspace in a frame under a banner that says it is example data, the steps run in that frame, and Exit tour (or
// the tour's own end) leaves the analyst's page exactly as it was. With no demo installed, the frame first sets up the
// tour's example workspace (POST /api/tour/workspace), and the tour runs there all the same.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page, Route } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const WS = 'pilot'
const DEMO = 'example-timeline'
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

// ---------- the made-up workspaces: the analyst's folder with its session attached, and the worked example without one
const mainOf = (ws: string, attached: boolean, ended = false) => ({
  id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null,
  attached: attached ? { session: 'session-1', cwd: `/home/analyst/${ws}`, since: T } : null,
  ended: ended ? { session: 'session-0', cwd: `/home/analyst/${ws}`, at: T } : null,
  alert: null, running: false,
})
const SETTINGS = {
  run_cell_result_lines: 40,
  models: Object.fromEntries(['orient', 'critic', 'writer', 'checks', 'verify', 'labels', 'dev'].map((r) => [r, { model: 'claude-opus-5-5', effort: 'high', fast: false }])),
  permission_modes: {}, disabled_modes: [], config_error: '',
}
const FILES: Record<string, string[]> = {
  [WS]: ['P1.txt', 'P2.txt', 'P3.txt', 'P4.txt', 'P5.txt'],
  [DEMO]: ['deploys.csv', 'agents.log', 'chat/ops.json', 'tickets/index.csv'],
}
const filesOf = (ws: string) => FILES[ws].map((p) => ({ path: p, kind: 'text', size_bytes: 1200, title: p.split('/').pop() }))
/** One folder's own entries, as `GET /corpora/{c}/sources?path=&depth=1` answers. */
const folder = (ws: string, at: string) => {
  const all = filesOf(ws)
  const inside = all.filter((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === at)
  const sub = at ? [] : [...new Set(all.filter((f) => f.path.includes('/')).map((f) => f.path.split('/')[0]))]
  return { path: at, files: inside, folders: sub.map((d) => ({ path: d, name: d, n_files: all.filter((f) => f.path.startsWith(`${d}/`)).length, n_folders: 0, is_run: false })), n_files: all.length }
}
/** A file's first lines, as `GET /corpora/{c}/source` answers. */
const sourcePage = (p: string) => {
  const lines = [`# ${p}`, '', 'A made-up file for the tour check.']
  return { path: p, kind: 'text', total_lines: lines.length, start: 1, records: lines.map((text, k) => ({ line: k + 1, record: { text }, blocks: [{ kind: 'text', text }], meta: {} })) }
}
const GET = (ws: string, ended = false): Record<string, unknown> => {
  const main = mainOf(ws, ws === WS, ended && ws !== WS)
  return {
    [`/api/ws/${ws}/instance`]: { stamp: 'stamp-1' },
    [`/api/ws/${ws}/undo`]: { undo: null, redo: null, undo_run: null, held: null },
    [`/api/ws/${ws}/chats`]: [{ ...main, n_messages: 0, last_ts: T }],
    [`/api/ws/${ws}/chats/main`]: { meta: { ...main, orientation: null }, events: [] },
    [`/api/ws/${ws}/concepts`]: [],
    [`/api/ws/${ws}/views`]: [],
    // a view proposal waiting for the analyst, which the chat shows only once the tour ends
    [`/api/ws/${ws}/views/proposals`]:
      ws === WS ? [{ slug: 'deploy-timeline', name: 'Deploy Timeline', description: 'Every deploy on one time axis.', task: 'see which deploys broke the database', claims: ['P1.txt'], status: 'suggested', proposed_by: 'proposer', offered: { at: T, after: 'main' } }] : [],
    [`/api/corpora/${ws}/sources`]: filesOf(ws),
    [`/api/ws/${ws}/labels`]: [],
    [`/api/ws/${ws}/labels/presence`]: [],
    [`/api/ws/${ws}/canvas`]: { groups: [], cells: [], hidden: [] },
    [`/api/ws/${ws}/filters`]: {},
    [`/api/ws/${ws}/report-types/presets`]: [],
    [`/api/ws/${ws}/investigations/main/types`]: { report: { exists: false, renderer: 'document', frame: false, name: 'Report' } },
    [`/api/ws/${ws}/investigations/main/types/report/frame`]: { id: 'report', type: 'report', renderer: 'document', title: '', sections: [], frame: true, generation: 0 },
    [`/api/ws/${ws}/checks`]: [],
  }
}
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.html': 'text/html', '.svg': 'image/svg+xml' }
const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'

interface Server {
  seen: boolean
  /** every request that is not a read, as `METHOD path` */
  writes: string[]
  /** the telemetry the page sent */
  telemetry: { kind: string; detail?: { label?: string } }[]
  /** the workspaces this server holds: the analyst's folder, and the worked example unless `demo` is false */
  names: string[]
  /** the workspaces the start page lists: the same, and with `ghost` the worked example though the server holds none */
  rows: string[]
  /** a session attached to the worked example once and ended */
  ended: boolean
}

/** A page on the made-up origin, answered by this file: the app, the tour's example view, the workspaces' API. */
async function open(opts: { W: number; H: number; chat?: number; seen?: boolean; folded?: boolean; surface?: string; ref?: string; demo?: boolean; ghost?: boolean; ended?: boolean }): Promise<{ page: Page; server: Server; close: () => Promise<void> }> {
  const names = opts.demo === false || opts.ghost ? [WS] : [WS, DEMO]
  const server: Server = { seen: !!opts.seen, writes: [], telemetry: [], names, rows: opts.ghost ? [WS, DEMO] : names, ended: !!opts.ended }
  const ctx = await browser.newContext({ viewport: { width: opts.W, height: opts.H }, deviceScaleFactor: 1 })
  await ctx.addInitScript(
    ({ ws, demo, chat, open, surface }) => {
      // a Mac, so ⌘ is the pointer's key
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined })
      // the analyst's page only: the tour's frame is a page of its own on the same storage
      if (window.top !== window) return
      for (const w of [ws, demo]) {
        localStorage.setItem(`thimble:${w}:instance`, JSON.stringify('stamp-1'))
        sessionStorage.setItem(`thimble:${w}:instance`, JSON.stringify('stamp-1'))
      }
      localStorage.setItem(`thimble:${ws}:layout`, JSON.stringify({ chatWidth: chat, chatOpen: open, panes: { root: { kind: 'pane', id: 'p1', surface }, focus: 'p1' } }))
      // the demo was opened before, on its Canvas
      localStorage.setItem(`thimble:${demo}:layout`, JSON.stringify({ chatWidth: 308, chatOpen: true, panes: { root: { kind: 'pane', id: 'p1', surface: 'canvas' }, focus: 'p1' } }))
      localStorage.setItem(`thimble:${demo}:opened`, 'true')
      // what reaches the page: every input an app listener on the document would hear, outside the tour
      ;(window as any).__probe = []
      for (const t of ['mousedown', 'click', 'keydown', 'wheel', 'contextmenu'])
        document.addEventListener(t, (e) => {
          if (!(e.target instanceof Element && e.target.closest('.tour-root, .tour-host, .tour-frame'))) (window as any).__probe.push(`${t}:${(e as KeyboardEvent).key || ''}`)
        })
    },
    { ws: WS, demo: DEMO, chat: opts.chat ?? 308, open: !opts.folded, surface: opts.surface ?? 'files' },
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
    if (p === '/api/health') return json({ ok: true, leader: 1, boot: 'boot', ui: 'ui' })
    if (p === '/api/tour') return json({ seen: server.seen })
    if (p === '/api/tour/seen' && method === 'POST') {
      server.seen = true
      return json({ seen: true })
    }
    if (p === '/api/tour/workspace' && method === 'POST') {
      // the server sets up the worked example from the sample it ships (backend tour.py)
      for (const list of [server.names, server.rows]) if (!list.includes(DEMO)) list.push(DEMO)
      return json({ name: DEMO })
    }
    if (p === '/api/ui/key') return route.fulfill({ status: 204, body: '' })
    if (p === '/api/ui/paired') return json({ paired: true, id: 'x' })
    if (p === '/api/corpora') return json(server.names.map((n) => ({ name: n, path: `/home/analyst/${n}`, registered: true, manifest: null })))
    if (p === '/api/workspaces')
      return json(
        server.rows.map((n) =>
          n === WS
            ? { name: n, kind: 'folder', label: n, folder: n, path: `/home/analyst/${n}` }
            : { name: n, kind: 'example', label: n, folder: n, path: `/home/analyst/.thimble/examples/${n}`, view: { slug: 'timeline', name: 'Timeline' } },
        ),
      )
    const ws = server.names.find((n) => p.startsWith(`/api/ws/${n}/`) || p.startsWith(`/api/corpora/${n}/`))
    if (!ws) return json({ detail: 'not found' }, 404)
    if (p === `/api/ws/${ws}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': open\n\n' })
    if (p === `/api/corpora/${ws}/sources` && url.searchParams.get('depth') === '1') return json(folder(ws, url.searchParams.get('path') ?? ''))
    if (p === `/api/corpora/${ws}/source`) return json(sourcePage(url.searchParams.get('path') ?? FILES[ws][0]))
    if (p === `/api/ws/${ws}/labels/ruler`) return json({ path: url.searchParams.get('path') ?? '', total: 3, bins: 400, labels: [] })
    if (method === 'GET' && p === `/api/ws/${ws}/settings`) return json(SETTINGS)
    const get = GET(ws, server.ended)
    if (method === 'GET' && p in get) return json(get[p])
    if (method === 'PUT' && p === `/api/ws/${ws}/render/theme`) return json({ paper: 'warm', accent: 'iris' })
    if (method === 'POST' && p === `/api/ws/${ws}/telemetry`) return json({ recorded: 1 }, 201)
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

/** What a run of the tour may write: the browser's sign-in, the analyst's theme, telemetry and the offer, and nothing
 * else; nothing at all to the demo workspace. */
const ALLOWED = new Set(['POST /api/ui/key', `PUT /api/ws/${WS}/render/theme`, 'POST /api/tour/seen', `POST /api/ws/${WS}/telemetry`])
/** The telemetry of a click in the tour, which is not the analyst's work and is never sent. */
const tourClicks = (s: Server) => s.telemetry.filter((t) => t.kind === 'ui-click')

/** What the analyst's own page shows: its file tree, its focused surface, any of the tour's examples in it, and the
 * stored layouts of both workspaces. */
const pageState = (page: Page) =>
  page.evaluate(
    ({ ws, demo }) => ({
      files: (document.querySelector<HTMLElement>('.shell [data-panel="files"]')?.innerText ?? '').slice(0, 400),
      tab: document.querySelector<HTMLElement>('.shell-tabs .tab.active')?.dataset.tab ?? null,
      examples: document.querySelectorAll('.tour-ex > *, .tour-host > *, .tour-tag').length,
      layout: localStorage.getItem(`thimble:${ws}:layout`),
      demoKeys: Object.keys(localStorage)
        .filter((k) => k.startsWith(`thimble:${demo}:`))
        .sort()
        .map((k) => [k, localStorage.getItem(k)]),
    }),
    { ws: WS, demo: DEMO },
  )

/** The tour's frame, once the page in it is there. */
async function tourFrame(page: Page): Promise<Frame> {
  const el = await page.waitForSelector('iframe.tour-frame-page', { timeout: 20000 })
  const frame = await el.contentFrame()
  assert.ok(frame, 'the frame has a page')
  return frame
}

/** The popover in the frame: its title and count, once it shows step `n`. */
async function stepIn(frame: Frame, n: number) {
  await frame.waitForFunction(
    (k) => !!document.querySelector('.tour-count')?.textContent?.startsWith(`${k} of`) && getComputedStyle(document.querySelector('.tour-pop')!).visibility !== 'hidden',
    n,
    { timeout: 20000 },
  )
  return frame.evaluate(() => ({ title: document.querySelector('.tour-title')?.textContent, count: document.querySelector('.tour-count')?.textContent }))
}

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

test('the tour runs in the demo workspace’s frame under its banner, never over the analyst’s files, and Exit tour leaves their page as it was', async () => {
  const { page, server, close } = await open({ W: 1440, H: 900 })
  try {
    await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
    const before = await pageState(page)
    assert.ok(before.files.includes('pilot') && before.files.includes('5 files'), 'the analyst’s own folder shows')
    await page.click('.tour-pop [data-tour="begin"]')
    const frame = await tourFrame(page)
    // the banner, on the analyst's page above the frame
    const banner = await page.evaluate(() => {
      const b = document.querySelector('.tour-banner')
      const f = document.querySelector<HTMLIFrameElement>('iframe.tour-frame-page')
      return { text: [...(b?.children ?? [])].map((e) => e.textContent?.trim()).filter(Boolean).join(' | '), src: f && new URL(f.src).search, top: b?.getBoundingClientRect().top, below: !!f && f.getBoundingClientRect().top >= (b?.getBoundingClientRect().bottom ?? 0) - 0.5 }
    })
    assert.deepEqual(banner, { text: 'Tour | · | Example data, not your files | Exit tour', src: `?ws=${DEMO}&tour=frame`, top: 0, below: true })
    // the steps run in the frame, on the demo workspace's own page: its Demo tag, its disabled composer, its files
    assert.deepEqual(await stepIn(frame, 1), { title: 'The chat', count: '1 of 9' })
    const inFrame = await frame.evaluate(() => ({
      demoTag: !!document.querySelector('.shell-demo'),
      demoLine: !!document.querySelector('.shell-demo-line'),
      composer: !!document.querySelector('.chat-composer textarea:disabled'),
    }))
    assert.deepEqual(inFrame, { demoTag: true, demoLine: false, composer: true }, 'a demo page: its tag, its disabled composer, and the banner in place of its line')
    // the Labels step: its example transcript is in the frame, over the demo's files, and nothing of it on the analyst's page
    for (let n = 2; n <= 4; n++) {
      await frame.click('.tour-pop [data-tour="next"]')
      await stepIn(frame, n)
    }
    assert.equal((await stepIn(frame, 4)).title, 'Labels')
    await frame.waitForSelector('.tour-ex-reader .reader-tab-name', { timeout: 10000 })
    assert.ok(await frame.evaluate(() => document.querySelector('.tour-ex-reader .reader-tab-name')?.textContent?.includes('agent-05.jsonl')), 'the example transcript shows in the frame')
    const demoFiles = await frame.evaluate(() => document.querySelector<HTMLElement>('.shell [data-panel="files"]')?.innerText ?? '')
    assert.ok(demoFiles.includes('example-timeline') && !demoFiles.includes('pilot'), 'over the demo’s own folder')
    const during = await pageState(page)
    assert.equal(during.examples, 0, 'no example on the analyst’s page')
    assert.equal(during.files, before.files, 'the analyst’s files as they were')
    assert.equal(await page.evaluate(() => !!document.querySelector('.tour-root')), false, 'no tour on the analyst’s page')
    // the analyst's page takes no input meanwhile: a key on it reaches none of its listeners
    await page.focus('.tour-banner-exit')
    await page.keyboard.press('k')
    assert.deepEqual(await page.evaluate(() => (window as any).__probe.filter((x: string) => x.startsWith('keydown'))), [], 'no key reaches the analyst’s page')
    await page.click('.tour-banner-exit')
    await page.waitForFunction(() => !document.querySelector('.tour-frame'), null, { timeout: 5000 })
    await sleep(300)
    const after = await pageState(page)
    assert.deepEqual(after, before, 'the analyst’s page and storage are exactly as they were, the demo’s too')
    assert.equal(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert')), false, 'the page takes input again')
    assert.deepEqual(server.writes.filter((x) => !ALLOWED.has(x)), [], 'nothing else was written, nothing to the demo')
    assert.deepEqual(tourClicks(server), [], 'no click in the tour reaches telemetry')
  } finally {
    await close()
  }
}, 90_000)

test('the tour’s own end closes its frame: Skip tour on its first step, and Esc', async () => {
  const { page, close } = await open({ W: 1280, H: 800, seen: true })
  try {
    await page.waitForSelector('.shell .chat-foot', { timeout: 20000 })
    for (const how of ['skip', 'escape']) {
      // Settings' Take the tour opens the frame at once
      await page.click('button[aria-label="Settings"]')
      await page.click('.settings-tour')
      const frame = await tourFrame(page)
      await stepIn(frame, 1)
      if (how === 'skip') await frame.click('.tour-pop [data-tour="skip"]')
      else await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('.tour-frame'), null, { timeout: 5000 })
    }
  } finally {
    await close()
  }
}, 90_000)

test('the frame shows the demo as a demo page even after a session there ended, not the session card', async () => {
  const { page, close } = await open({ W: 1280, H: 800, seen: true, ended: true })
  try {
    await page.waitForSelector('.shell .chat-foot', { timeout: 20000 })
    await page.click('button[aria-label="Settings"]')
    await page.click('.settings-tour')
    const frame = await tourFrame(page)
    assert.equal((await stepIn(frame, 1)).title, 'The chat')
    await sleep(2000)
    assert.deepEqual(await frame.evaluate(() => ({ gone: !!document.querySelector('.shell-gone'), demoTag: !!document.querySelector('.shell-demo') })), { gone: false, demoTag: true })
  } finally {
    await close()
  }
}, 60_000)

test('a frame whose tour does not start closes, and the page says so', async () => {
  // the start page lists the worked example, but the server holds no such workspace: the frame's page is the start page
  const { page, close } = await open({ W: 1280, H: 800, seen: true, ghost: true })
  try {
    await page.waitForSelector('.shell .chat-foot', { timeout: 20000 })
    await page.click('button[aria-label="Settings"]')
    await page.click('.settings-tour')
    await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
    assert.equal(await page.$('.tour-frame'), null, 'the frame is gone')
    const w = await page.evaluate(() => ({
      title: document.querySelector('.tour-title')?.textContent,
      buttons: [...document.querySelectorAll('.tour-pop button')].map((b) => b.textContent?.trim()),
    }))
    assert.deepEqual(w, { title: "The tour didn't open", buttons: ['Close'] })
    await page.click('.tour-pop [data-tour="skip"]')
    await sleep(300)
    assert.equal(await page.$('.tour-root'), null, 'Close closes it')
  } finally {
    await close()
  }
}, 60_000)

test('with no demo installed, Take the tour sets up the example workspace and runs the tour there', async () => {
  const { page, server, close } = await open({ W: 1440, H: 900, demo: false })
  try {
    await page.waitForSelector('.tour-pop.tour-welcome', { timeout: 20000 })
    assert.equal(await page.evaluate(() => document.querySelector('.tour-body')?.textContent), 'Would you like a short tour? The demo tour uses example data.')
    const before = await pageState(page)
    await page.click('.tour-pop [data-tour="begin"]')
    const frame = await tourFrame(page)
    assert.deepEqual(await stepIn(frame, 1), { title: 'The chat', count: '1 of 9' })
    assert.ok(server.writes.includes('POST /api/tour/workspace'), 'the workspace was set up')
    await page.click('.tour-banner-exit')
    await page.waitForFunction(() => !document.querySelector('.tour-frame'), null, { timeout: 5000 })
    await sleep(300)
    const after = await pageState(page)
    assert.equal(after.files, before.files, 'the analyst’s folder as it was')
    assert.equal(after.examples, 0, 'no example on it')
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
