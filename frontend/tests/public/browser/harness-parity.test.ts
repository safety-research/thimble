// The card harness against the canvas. The card check reads a picture of each card that the harness's page draws
// (src/render.tsx, which backend/app/render.py drives in a headless Chromium), so that picture must be the card the
// analyst sees. Each invented card of cards.json, one of every kind, is drawn by the harness and by the canvas's own
// CellCard at rest, at the same place in one page, and the two must agree: the card's box within 1 px and at most 0.5%
// of pixels different. Then a label card drawn from the label its request carries, and wide tables at the card's
// width. The page is bundled with the app's stylesheet and its own faces, and answers its API calls from the request,
// as the harness does; a request to any other host is refused.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { cleanup, FRONTEND, launch, tempDir } from './page.ts'

type Card = { id: string; kind: string; title: string; width?: number | null; [k: string]: unknown }
const { cards } = JSON.parse(readFileSync(path.join(__dirname, 'cards.json'), 'utf8')) as { cards: Card[] }
const ORIGIN = 'http://thimble.render'
const BOX_PX = 1
const PIXELS = 0.005
let browser: Browser
let page: Page
const pageErrors: string[] = []

beforeAll(async () => {
  const dir = tempDir('parity')
  await build({
    entryPoints: { bundle: path.join(__dirname, 'parity.tsx') },
    nodePaths: [path.join(FRONTEND, 'node_modules')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'dataurl', '.png': 'dataurl' },
    assetNames: 'assets/[name]-[hash]',
    define: { 'process.env.NODE_ENV': '"production"' },
    outdir: dir,
    logLevel: 'error',
  })
  browser = await launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  // the page's own files from the bundle's folder, and nothing from another origin, as in the harness
  await context.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) return route.abort()
    const rel = url.pathname.replace(/^\/+/, '') || 'index.html'
    if (rel === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><script src="/bundle.js"></script></body></html>' })
    try {
      const body = readFileSync(path.join(dir, rel))
      const type = rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.css') ? 'text/css' : rel.endsWith('.woff2') ? 'font/woff2' : rel.endsWith('.woff') ? 'font/woff' : 'application/octet-stream'
      return route.fulfill({ status: 200, contentType: type, body })
    } catch {
      return route.fulfill({ status: 404, body: '' })
    }
  })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto(`${ORIGIN}/index.html`)
  await page.waitForFunction(() => !!(window as any).__thimbleRender?.ready && !!(window as any).__parity)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const request = (card: Card) => ({ ws: 'fixture', card, citations: {}, names: [{ id: card.id, title: card.title }], theme: { paper: 'warm', accent: 'iris' }, width: card.width || 720 })
type Box = { x: number; y: number; width: number; height: number }
type Drawn = { box: Box; error?: string; requests: string[] }
const draw = (req: object): Promise<Drawn> => page.evaluate((r) => (window as any).__thimbleRender.render(r), req)
const clip = (b: Box) => {
  const x = Math.floor(b.x)
  const y = Math.floor(b.y)
  return { x, y, width: Math.ceil(b.x + b.width) - x, height: Math.ceil(b.y + b.height) - y }
}

test("the harness page loads with the app's own faces", async () => {
  const fonts = await page.evaluate(async () => {
    const faces = ['400 13px "Hanken Grotesk"', '500 13px "Hanken Grotesk"', '400 12px "Geist Mono"']
    await Promise.all(faces.map((f) => document.fonts.load(f)))
    return faces.map((f) => document.fonts.check(f))
  })
  assert.deepEqual(fonts, [true, true, true], 'the fonts come from the bundle, not from the network')
})

for (const card of cards) {
  test(`parity: ${card.kind} ${card.id}`, async () => {
    const h = await draw(request(card))
    assert.equal(h.error, undefined, h.error)
    assert.deepEqual(h.requests, [], 'the harness answered every call the card made')
    const hShot = await page.screenshot({ clip: clip(h.box), fullPage: true, animations: 'disabled', caret: 'hide' })
    const c: { box: Box } = await page.evaluate(([cell, w, names]: any) => (window as any).__parity.mountCanvas(cell, w, names), [card, card.width || 720, [{ id: card.id, title: card.title }]] as const)
    const cShot = await page.screenshot({ clip: clip(c.box), fullPage: true, animations: 'disabled', caret: 'hide' })
    await page.evaluate(() => (window as any).__parity.unmountCanvas())
    assert.ok(Math.abs(h.box.width - c.box.width) <= BOX_PX && Math.abs(h.box.height - c.box.height) <= BOX_PX, `box: harness ${JSON.stringify(h.box)}, canvas ${JSON.stringify(c.box)}`)
    const off: number = await page.evaluate(([a, b]: any) => (window as any).__parity.pixels(a, b), [hShot.toString('base64'), cShot.toString('base64')])
    assert.ok(off >= 0 && off <= PIXELS, `${(off * 100).toFixed(2)}% of pixels differ`)
  })
}

test('no page errors while drawing', () => {
  assert.deepEqual(pageErrors, [])
})

// ---- label cards

test('a label card draws from the label its request carries, and every call it makes is answered', async () => {
  const concept = { id: 'k1', name: 'refund asks', description: '', kind: 'regex', unit: 'record', spec: '(?i)refund', labels: ['refund', 'other'], counts: { refund: 3, other: 5 }, n_labeled: 8, glob: '', marks: null, model: '', classes: [], run: null }
  const rows = { refund: [{ ref: 'tickets.jsonl#L2', label: 'refund', text: 'Please refund the second charge' }], other: [{ ref: 'tickets.jsonl#L3', label: 'other', text: 'How do I add a seat?' }] }
  const card = { id: 'lab00001', notebook: 'main', kind: 'label', title: 'refund asks', payload: { concept: 'k1' }, takeaway: '', labels: ['k1'], width: 720 }
  const h = await draw({ ...request(card), label: { concept, rows, settings: {} } })
  assert.equal(h.error, undefined, h.error)
  assert.deepEqual(h.requests, [], 'the harness answered every call the label card made')
  const text = await page.evaluate(() => document.querySelector('.render-stage article.canvas-card')?.textContent ?? '')
  assert.match(text, /refund/)
  assert.match(text, /Please refund the second charge/, 'one example per value, from the rows the request carries')
})

test('a label card shows what the label found first, and its rule behind one line', async () => {
  const concept = {
    id: 'k2', name: 'where a ticket links', description: '', kind: 'regex', unit: 'record', spec: 'https?://(status\\.example\\.com|help\\.example\\.org)\\S*',
    labels: ['to the status page', 'to the help centre', 'blocked: other', 'no outside links'], counts: { 'to the status page': 5102, 'to the help centre': 1200, 'no outside links': 5093 }, n_labeled: 11395,
    glob: 'exports/2026-05/tickets.jsonl', marks: 'record', model: '', classes: [], run: null,
  }
  const status = '…see outer https://status.example.com/api?q=%5B.charge%5D and more'
  const rows = {
    'to the status page': [{ ref: 'tickets.jsonl#L4', label: 'to the status page', text: status, match: 'https://status.example.com/api?q=%5B.charge%5D' }],
    // the first row repeats the example above, so the next one is shown
    'to the help centre': [
      { ref: 'tickets.jsonl#L7', label: 'to the help centre', text: status, match: 'https://help.example.org/refunds' },
      { ref: 'tickets.jsonl#L8', label: 'to the help centre', text: 'read https://help.example.org/refunds first', match: 'https://help.example.org/refunds' },
    ],
    // a value that says nothing matched shows an example only with the words that earned it, and this row has none
    'no outside links': [{ ref: 'tickets.jsonl#L9', label: 'no outside links', text: 'Describe the problem here.' }],
  }
  const card = { id: 'lab00002', notebook: 'main', kind: 'label', title: 'Where do the outside links in each ticket point?', payload: { concept: 'k2' }, takeaway: 'Most go to the status page, [[5102|concept:k2/to the status page]] of the tickets.', labels: ['k2'], width: 720 }
  const h = await draw({ ...request(card), label: { concept, rows, settings: {} } })
  assert.equal(h.error, undefined, h.error)
  const got = await page.evaluate(() => {
    const el = document.querySelector('.render-stage article.canvas-card')!
    const q = (s: string) => Array.from(el.querySelectorAll(s)).map((x) => x.textContent)
    const body = el.querySelector('.bcell-label')!
    const first = Array.from(body.children).find((c) => !c.classList.contains('bcell-label-glob'))
    return {
      glob: q('.bcell-label-glob'),
      values: q('.bcell-values tbody tr td:first-child'),
      firstAfterGlob: first?.className ?? '',
      spec: q('.bcell-label-spec'),
      toggle: q('.bcell-label-rule-toggle'),
      passage: q('.bcell-q-passage'),
      exampleValues: q('.bcell-label-example-value'),
      examples: q('.bcell-label-example-text'),
      valueFont: getComputedStyle(el.querySelector('.bcell-value')!).fontFamily,
      name: q('.bcell-label-name'),
      cite: q('.bcell-take .refchip-value'),
    }
  })
  assert.deepEqual(got.glob, ['…/tickets.jsonl'], 'under a question of its own, only a short glob; the name is in the details')
  assert.deepEqual(got.name, [], 'the label name line is not repeated under the question')
  assert.equal(got.firstAfterGlob, 'bcell-values', 'the values come first')
  assert.deepEqual(got.values, ['to the status page', 'to the help centre', 'no outside links'], 'a value no record got is left off')
  assert.deepEqual(got.spec, [], 'the rule is closed')
  assert.deepEqual(got.toggle, ['regex · show rule'])
  assert.match(got.valueFont, /Hanken/, 'a value is words, in the body face')
  assert.deepEqual(got.passage, ['https://status.example.com/api?q=[.charge]', 'https://help.example.org/refunds'], 'the match marked, its percent-encoding decoded')
  assert.deepEqual(got.exampleValues, ['to the status page', 'to the help centre'], 'the value that says nothing matched shows no example')
  assert.match(got.examples[1] ?? '', /read https:\/\/help\.example\.org\/refunds first/, 'an example another value already shows gives way to the next row')
  assert.deepEqual(got.cite, ['5,102'], 'a long number in a citation takes thousands separators')
  await page.evaluate(() => document.querySelector<HTMLElement>('.render-stage .bcell-label-rule-toggle')!.click())
  await page.waitForFunction(() => !!document.querySelector('.render-stage .bcell-label-spec'))
  assert.match(await page.evaluate(() => document.querySelector('.render-stage .bcell-label-spec')!.textContent ?? ''), /status/, 'show rule opens the rule')
})

// ---- wide tables

/** A table card whose frame has `cols` columns beside its row names, each value made by `cell(row, col)`. */
const wideCard = (id: string, cols: string[], cell: (r: number, c: number) => string | number, numeric: boolean, name = (r: number) => `row ${r + 1}`) => {
  const columns = ['name', ...cols]
  const rows = Array.from({ length: 5 }, (_, r) => [name(r), ...cols.map((_, c) => cell(r, c))])
  const types = Object.fromEntries(columns.map((c, i) => [c, i > 0 && numeric ? 'quantitative' : 'nominal']))
  const frame = { columns, types, index: 'name', rows, total: rows.length, label: 'name', view: { columns: cols, formats: {}, more: 0 } }
  return { id, notebook: 'nb1', kind: 'table', title: 'A wide table', takeaway: '', takeaway_author: 'model', code: 'df', status: 'ok', exec_count: 1,
           created_by: 'terminal', payload: null, width: 576, outputs: [{ 'application/vnd.thimble.frame+json': frame, 'text/plain': '...' }] }
}

/** For each header of the drawn table: how far its right edge lies past the table box's visible right edge, and
 * whether the box scrolls sideways to it. */
const columnsReach = (): Promise<{ past: number; reachable: boolean }[]> =>
  page.evaluate(() => {
    const box = document.querySelector('.render-stage .frame-table-box')!
    const b = box.getBoundingClientRect()
    const scrolls = getComputedStyle(box).overflowX !== 'visible' && box.scrollWidth > box.clientWidth
    return [...box.querySelectorAll('thead th')].map((th) => {
      const r = th.getBoundingClientRect()
      return { past: Math.round(r.right - b.right), reachable: r.right - b.left <= (scrolls ? box.scrollWidth : b.width) + 1 }
    })
  })

test("a table of text wider than the card wraps so every column shows at the card's width", async () => {
  const cols = ['customer', 'opened (UTC)', 'queue', 'reference', 'replies']
  const cell = (r: number, c: number) => ['mara.lopez.1982', `2026-06-18 1${r}:46`, `BillingEscalationQueue99${r}`, `refund1100619580435${r}215`, `${r + 1}`][c]
  const h = await draw(request(wideCard('wide0001', cols, cell, false, (r) => `tickets.jsonl#L1${r}0951`)))
  assert.equal(h.error, undefined, h.error)
  const reach = await columnsReach()
  assert.equal(reach.length, cols.length + 1)
  assert.ok(reach.every((c) => c.past <= 1), `every column inside the card: ${JSON.stringify(reach)}`)
})

test('a table of twelve number columns reaches every column, inside the card or by scrolling sideways', async () => {
  const cols = Array.from({ length: 12 }, (_, i) => `measure ${i + 1}`)
  const h = await draw(request(wideCard('wide0002', cols, (r, c) => 1000000 + r * 1000 + c, true)))
  assert.equal(h.error, undefined, h.error)
  const reach = await columnsReach()
  assert.equal(reach.length, 13)
  assert.ok(reach.every((c) => c.reachable), `every column reachable: ${JSON.stringify(reach)}`)
})
