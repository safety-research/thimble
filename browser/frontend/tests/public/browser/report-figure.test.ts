// A card placed as a figure in the Report, in headless Chromium: the real App and its stylesheets against a made-up
// workspace whose every API answer this file gives, at 1440x900. What it proves, measured with getBoundingClientRect:
//   - the figure fills the page's column: it starts where the text does and, its actions being inside the card, takes
//     the actions' gutter at the right, so it ends as far inside the column as the text starts;
//   - the figure carries no "from canvas" tag and no × of its own;
//   - hovering the figure shows the block's actions (chat, delete, lock) inside the card, on its question line, and the
//     question keeps their room, so it never runs under them; hovering a paragraph still shows them in the gutter;
//   - the card sidebar lists no Orientation section: a card of an earlier orientation's deck lists under Your work;
//   - the column takes the pane's width, the text keeping a card's width; the caption that says the card's takeaway
//     shows it whole, with its citation, and no scroll of its own; a click on the citation opens its evidence, and a
//     click on the caption's other words edits it.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page, Route } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

const WS = 'demo'
const T = '2026-05-16T09:00:00.000+00:00'
let browser: Browser
let out = ''

beforeAll(async () => {
  const script = await bundle(
    'report-figure',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import App from '${src('App.tsx')}'`,
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

const MAIN = {
  id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null,
  attached: { session: 'session-1', cwd: '/home/analyst/demo', since: T }, ended: null, alert: null, running: false,
}
const SETTINGS = { run_cell_result_lines: 40, models: {}, permission_modes: {}, disabled_modes: [], config_error: '' }
const CHART = {
  'application/vnd.vegalite.v5+json': {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { values: [{ hour: '09', edits: 4 }, { hour: '10', edits: 9 }, { hour: '11', edits: 2 }, { hour: '12', edits: 6 }] },
    mark: 'bar',
    encoding: { x: { field: 'hour', type: 'ordinal' }, y: { field: 'edits', type: 'quantitative' } },
  },
}
// a takeaway long enough to wrap over several lines, with a cited number
const TAKEAWAY =
  'Most edits came at [[10:00|card:c1#edits/1]], in one long burst after the agent had read the whole test suite once and before it ran the tests again; ' +
  'the hours before and after it hold fewer edits, and none of them comes close to the burst. The burst ends when the tests pass, so the agent stops editing as soon as it has what it needs, ' +
  'and the last hour holds only the small changes to the notes it wrote at the end of the run.'
const CAPTION = TAKEAWAY.replace('[[10:00|card:c1#edits/1]]', '10:00')
const CELL = {
  id: 'c1', notebook: 'g-orient', kind: 'plot', title: 'When did the agent edits happen during the run?', takeaway: TAKEAWAY,
  created_by: 'main', created_ts: T, ts: T, status: 'ok', code: 'chart()', outputs: [CHART],
}
const CANVAS = { groups: [{ id: 'g-orient', title: 'Orientation', role: 'exploration', parent: null }], cells: [CELL], hidden: [] }
const doc = (locked: boolean) => ({
  id: 'report', type: 'report', renderer: 'document', title: 'Agent edits', generation: 1, frame: false,
  sections: [
    {
      id: 's1', heading: 'When the edits came',
      paragraphs: [{ id: 'p1', sentences: [{ id: 'p1s1', text: 'The agent edited files in bursts, with one long burst in the second hour of the run.', refs: [], tags: [] }] }],
      figures: [{ id: 'f1', cell: 'card:c1', caption: CAPTION, after_paragraph: 'p1', locked }],
    },
  ],
})

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'

function answer(route: Route, locked: boolean) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
  if (url.origin !== ORIGIN) return route.abort()
  const p = url.pathname
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const GET: Record<string, unknown> = {
    '/api/health': { ok: true, leader: 1, boot: 'boot', ui: 'ui' },
    '/api/tour': { seen: true },
    '/api/corpora': [{ name: WS, path: '/home/analyst/demo', registered: true, manifest: null }],
    [`/api/ws/${WS}/instance`]: { stamp: 'stamp-1' },
    [`/api/ws/${WS}/undo`]: { undo: null, redo: null, undo_run: null, held: null },
    [`/api/ws/${WS}/chats`]: [{ ...MAIN, n_messages: 0, last_ts: T }],
    [`/api/ws/${WS}/chats/main`]: { meta: { ...MAIN, orientation: null }, events: [] },
    [`/api/ws/${WS}/settings`]: SETTINGS,
    [`/api/ws/${WS}/concepts`]: [],
    [`/api/ws/${WS}/views`]: [],
    [`/api/ws/${WS}/views/proposals`]: [],
    [`/api/corpora/${WS}/sources`]: [],
    [`/api/ws/${WS}/labels`]: [],
    [`/api/ws/${WS}/labels/presence`]: [],
    [`/api/ws/${WS}/canvas`]: CANVAS,
    [`/api/ws/${WS}/filters`]: {},
    [`/api/ws/${WS}/report-types/presets`]: [],
    [`/api/ws/${WS}/investigations/main/types`]: { report: { exists: true, renderer: 'document', frame: false, name: 'Report' } },
    [`/api/ws/${WS}/investigations/main/types/report`]: doc(locked),
    [`/api/ws/${WS}/checks`]: [],
    [`/api/corpora/${WS}/ref`]: { kind: 'cell', record: CELL },
  }
  if (p.startsWith('/api/')) {
    const method = req.method()
    if (p === '/api/ui/key') return route.fulfill({ status: 204, body: '' })
    if (p === '/api/ui/paired') return json({ paired: true, id: 'x' })
    if (p === `/api/ws/${WS}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': open\n\n' })
    if (p === `/api/corpora/${WS}/sources` && url.searchParams.get('depth') === '1') return json({ path: '', files: [], folders: [], n_files: 0 })
    if (method === 'GET' && p in GET) return json(GET[p])
    if (method === 'POST' && p === `/api/ws/${WS}/telemetry`) return json({ recorded: 1 }, 201)
    return json({ detail: 'not found' }, 404)
  }
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: INDEX })
  const file = path.join(out, p)
  if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
  return route.fulfill({ status: 404, body: '' })
}

async function open(locked = false): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(
    ({ ws }) => {
      localStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      sessionStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      localStorage.setItem(`thimble:${ws}:layout`, JSON.stringify({ chatWidth: 308, chatOpen: true, panes: { root: { kind: 'pane', id: 'p1', surface: 'report' }, focus: 'p1' } }))
    },
    { ws: WS },
  )
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => answer(route, locked))
  await page.goto(`${ORIGIN}/?ws=${WS}`)
  await page.waitForSelector('figure.wu-fig .outputs-vega svg', { timeout: 20000 })
  return { page, close: () => ctx.close() }
}

const box = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect()
    return r ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } : null
  }, sel)

test('a figure fills the text column, carries its actions inside the card, and no from-canvas tag', async () => {
  const { page, close } = await open()
  try {
    const para = await box(page, '.bn-block-content[data-content-type="paragraph"]')
    const fig = await box(page, 'figure.wu-fig')
    assert.ok(para && fig, 'the paragraph and the figure are drawn')
    assert.equal(fig.left, para.left, `the figure starts where the text does ${JSON.stringify({ fig, para })}`)
    const zone = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.wu-zone')!
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right), padL: parseFloat(getComputedStyle(el).paddingLeft) }
    })
    assert.equal(para.left - zone.left, zone.padL, 'the text starts at the column\'s left gutter')
    assert.equal(zone.right - fig.right, zone.padL, `the figure ends as far inside the column as the text starts ${JSON.stringify({ fig, para, zone })}`)
    assert.ok(fig.right > para.right, 'the figure takes the actions\' gutter')
    const head = await page.evaluate(() => document.querySelector('figure.wu-fig .wu-fig-head')?.textContent ?? '')
    assert.ok(!/from canvas/i.test(head), `no from-canvas tag: ${head}`)
    assert.equal(await page.locator('figure.wu-fig .wu-fig-from, figure.wu-fig .wu-fig-x').count(), 0, 'no tag and no × in the head')

    await page.hover('figure.wu-fig .wu-fig-body')
    await page.waitForSelector('.wu-acts', { timeout: 5000 })
    await page.waitForTimeout(200)
    const acts = await box(page, '.wu-acts')
    const q = await box(page, 'figure.wu-fig .wu-fig-q')
    const headBox = await box(page, 'figure.wu-fig .wu-fig-head')
    assert.ok(acts && q && headBox)
    assert.ok(acts.left >= fig.left && acts.right <= fig.right, `the actions stand inside the card ${JSON.stringify({ acts, fig })}`)
    assert.ok(acts.top >= headBox.top - 2 && acts.bottom <= headBox.bottom + 2, `the actions stand on the question line ${JSON.stringify({ acts, headBox })}`)
    assert.ok(q.right <= acts.left, `the question keeps the actions' room ${JSON.stringify({ q, acts })}`)
    assert.equal(await page.locator('.wu-acts button').count(), 3, 'chat, delete and lock')

    // a paragraph's actions still stand in the gutter, past the text's right edge
    await page.hover('.bn-block-content[data-content-type="paragraph"] .bn-inline-content')
    await page.waitForTimeout(300)
    const pacts = await box(page, '.wu-acts')
    assert.ok(pacts && pacts.left > para.right, `a paragraph's actions stand in the gutter ${JSON.stringify({ pacts, para })}`)

    // the sidebar: no Orientation section; the orientation deck's card lists under Your work
    const names = await page.evaluate(() => [...document.querySelectorAll('.wu-sec-name')].map((n) => n.textContent))
    assert.ok(names.length > 0 && !names.includes('Orientation'), `no Orientation section: ${names.join(', ')}`)
    assert.ok(names.includes('Your work'), `Your work is listed: ${names.join(', ')}`)
  } finally {
    await close()
  }
})

test("the figure takes the pane's width and shows the card's takeaway whole, with its citations", async () => {
  const { page, close } = await open()
  try {
    const fig = await box(page, 'figure.wu-fig')
    const para = await box(page, '.bn-block-content[data-content-type="paragraph"]')
    const pane = await box(page, '.wu-page')
    assert.ok(fig && para && pane)
    assert.ok(pane.right - fig.right < 160, `the figure reaches the pane's right side ${JSON.stringify({ fig, pane })}`)
    assert.ok(para.right - para.left <= 720, `the text keeps a card's width ${JSON.stringify(para)}`)
    const cap = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('figure.wu-fig .wu-fig-caption')!
      const chip = el.querySelector<HTMLElement>('.mark[data-ref]')
      return { text: el.textContent ?? '', chip: chip?.textContent ?? null, scroll: el.scrollHeight - el.clientHeight, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) }
    })
    assert.equal(cap.chip, '10:00', `the cited number is a citation ${JSON.stringify(cap)}`)
    assert.ok(cap.text.includes('the last hour holds only the small changes'), 'the whole takeaway is shown')
    assert.ok(cap.scroll <= 1 && cap.lines >= 3, `no scroll of its own ${JSON.stringify(cap)}`)

    // a click on the citation opens its evidence, not the caption's editor; a second click closes it
    await page.click('figure.wu-fig .wu-fig-caption .mark-words')
    await page.waitForSelector('.mark-pop', { timeout: 5000 })
    assert.equal(await page.locator('figure.wu-fig .wu-fig-caption.refedit').count(), 0, "the citation's click is not the caption's")
    await page.click('figure.wu-fig .wu-fig-caption .mark-words')
    await page.waitForSelector('.mark-pop', { state: 'detached', timeout: 5000 })
    // a click on the caption's words edits it, with the citation as a token; leaving it unchanged changes nothing
    await page.click('figure.wu-fig .wu-fig-caption', { position: { x: 400, y: 4 } })
    await page.waitForSelector('figure.wu-fig .wu-fig-caption.refedit .refedit-token', { timeout: 5000 })
    await page.keyboard.press('Escape')
    await page.waitForSelector('figure.wu-fig .wu-fig-caption .mark[data-ref]', { timeout: 5000 })
    // words typed into it are kept, and the citation with them
    await page.click('figure.wu-fig .wu-fig-caption', { position: { x: 400, y: 4 } })
    await page.waitForSelector('figure.wu-fig .wu-fig-caption.refedit', { timeout: 5000 })
    await page.keyboard.type(' Noted by the reader.')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('figure.wu-fig .wu-fig-caption:not(.refedit)')?.textContent?.includes('Noted by the reader.'), null, { timeout: 5000 })
    assert.equal(await page.locator('figure.wu-fig .wu-fig-caption .mark[data-ref]').count(), 1, 'the edited caption keeps its citation')
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
    // the top bar's toggle names what it hides
    assert.equal(await page.locator('button.shell-links[aria-label="Hide citations"]').count(), 1)
  } finally {
    await close()
  }
})
