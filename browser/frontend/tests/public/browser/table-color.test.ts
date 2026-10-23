// Color by in Files' Table mode (src/files/Reader.tsx, views/table.tsx), in a real browser: Chromium and, where
// Playwright's WebKit starts, WebKit. A file of JSON lines and a CSV file in the Table mode show the same Color by control
// as the Transcript mode, its choice the file's first key; each row carries its value's color as a band on its left
// edge (views/common.tsx EdgeBands), in the chip's color; the overview track is painted in those colors. A chip turned
// off takes its value's color off its rows, which stay, and off the overview; turned on again it brings the color back.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { chromium, webkit, type BrowserType, type Page } from 'playwright'
import { bundle, cleanup, ORIGIN, src } from './page.ts'

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
let dir = ''

beforeAll(async () => {
  const script = await bundle(
    'table-color',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Reader } from '${src('files/Reader.tsx')}'`,
      `const TOTAL = 400`,
      `const CSV = new URLSearchParams(location.search).get('file') === 'csv'`,
      `const PATH = CSV ? 'notes.csv' : 'events.jsonl'`,
      `localStorage.setItem('thimble:ws:viewOf:' + PATH, JSON.stringify('table'))`,
      // a JSON line's event_type is "request" on every fifth line, else "save"; a CSV row's kind is "alert" on every
      // fourth, else "note" (the CSV's first line names its columns)
      `const value = (i) => (CSV ? (i % 4 ? 'note' : 'alert') : i % 5 ? 'save' : 'request')`,
      `const line = (i) => (i === 1 ? 'who,kind,text' : 'agent' + (i % 3) + ',' + value(i) + ',"a note, with a comma, ' + i + '"')`,
      `const rec = (i) => (CSV ? { line: i, record: { text: line(i) }, blocks: [{ kind: 'raw', text: line(i) }], meta: {} } : { line: i, record: { event_id: 'e' + i, event_type: value(i), page: 'Page' + (i % 97), time: '2026-06-18T20:' + String(i % 60).padStart(2, '0') + ':00Z' }, blocks: [], meta: {} })`,
      `const page = (a, b) => { const out = []; for (let i = Math.max(1, a); i <= Math.min(TOTAL, b); i++) out.push(rec(i)); return { path: PATH, kind: CSV ? 'text' : 'events', total_lines: TOTAL, start: Math.max(1, a), records: out } }`,
      `const values = CSV ? ['note', 'alert'] : ['save', 'request']`,
      `const keys = { path: PATH, total: TOTAL, bins: 100, partial: false, bytes: [], keys: [{ key: CSV ? 'kind' : 'event_type', values: values.map((v, r) => ({ value: v, n: r ? 100 : 300 })), more: { values: 0, n: 0 }, none: 0, at: Array.from({ length: 100 }, (_, b) => (b % 10 < 3 ? 1 : 0)) }] }`,
      `const answer = (u) => {`,
      `  const p = u.pathname, s = u.searchParams`,
      `  if (p.endsWith('/source/around')) { const l = +s.get('line'); return page(l - +s.get('before'), l + +s.get('after')) }`,
      `  if (p.endsWith('/source/lines')) return { path: PATH, total_lines: TOTAL, estimated: false, indexed: 1 }`,
      `  if (p.endsWith('/source/keys')) return keys`,
      `  if (p.endsWith('/source')) { const a = +s.get('start'); return page(a, a + +s.get('count') - 1) }`,
      `  return null`,
      `}`,
      `;(window as any).fetch = async (url) => {`,
      `  const got = answer(new URL(String(url), location.origin))`,
      `  await new Promise((r) => setTimeout(r, 10))`,
      `  if (got == null) return new Response(JSON.stringify({ detail: 'not here' }), { status: 404, headers: { 'content-type': 'application/json' } })`,
      `  return new Response(JSON.stringify(got), { status: 200, headers: { 'content-type': 'application/json' } })`,
      `}`,
      `const labels = { all: [], on: [], focus: null, setFocus() {}, byId: new Map(), presence: new Map(), toggle() {}, setClasses() {}, setColour() {}, save: async () => ({}), remove: async () => {} }`,
      `createRoot(document.getElementById('root')!).render(<div style={{ height: 640, display: 'flex' }}><div className="files-main"><Reader workspace="ws" path={PATH} kind={CSV ? 'text' : 'events'} labels={labels} lead={null} /></div></div>)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.json': 'json' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  dir = path.dirname(script)
})

afterAll(() => cleanup())

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['webkit', webkit],
]

async function open(page: Page, query: string) {
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/${query}`)
  await page.waitForSelector('.reader-table-row.has-cb', { timeout: 20000 })
  await page.waitForTimeout(300)
}

/** The rows drawn: each one's line, the color of the band on its left edge (null for none), and each chip's value with
 * its swatch's color. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.reader-table-row[data-line]')].map((tr) => {
      const band = tr.querySelector('td.reader-table-gutter .reader-band')
      return { line: Number(tr.dataset.line), edge: tr.classList.contains('has-cb') && band ? getComputedStyle(band).backgroundColor : null }
    })
    const chips = Object.fromEntries([...document.querySelectorAll<HTMLElement>('.reader-colorbar .colorby-chip')].map((c) => [c.dataset.value!, getComputedStyle(c.querySelector('.colorby-sw')!).backgroundColor]))
    return { rows, chips, choice: document.querySelector('.reader-colorbar .colorby-trigger b')?.textContent ?? null }
  })

/** The colors on the overview's canvas, as rgb() strings, each with how many pixels show it; `painted`: the pixels
 * painted in any color, faded or not, past the plain track's faint ink. */
const overview = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.track-over .track-canvas')!
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    const n = new Map<string, number>()
    let painted = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) painted++
      if (d[i + 3] === 255) n.set(`rgb(${d[i]}, ${d[i + 1]}, ${d[i + 2]})`, (n.get(`rgb(${d[i]}, ${d[i + 1]}, ${d[i + 2]})`) ?? 0) + 1)
    }
    return { colors: Object.fromEntries(n), painted }
  })

for (const [name, engine] of ENGINES)
  for (const file of ['jsonl', 'csv'])
    test(`${name}, a ${file === 'csv' ? 'CSV file' : 'file of JSON lines'} in the Table mode: Color by colors each row's edge and the overview, and a value turned off keeps its rows, without its color`, async (ctx) => {
      const browser = await engine.launch({ headless: true }).catch(() => null)
      if (!browser) return ctx.skip()
      try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
        await open(page, `?file=${file}`)
        const [on, other] = file === 'csv' ? ['note', 'alert'] : ['save', 'request']
        const valueOf = (line: number) => (file === 'csv' ? (line % 4 ? 'note' : 'alert') : line % 5 ? 'save' : 'request')
        const got = await drawn(page)
        assert.equal(got.choice, file === 'csv' ? 'kind' : 'event_type', 'the choice is the file\'s first key')
        assert.deepEqual(Object.keys(got.chips).sort(), [on, other].sort(), `a chip per value: ${JSON.stringify(got.chips)}`)
        assert.notEqual(got.chips[on], got.chips[other], 'the values have colors of their own')
        assert.ok(got.rows.length > 10, `rows drawn: ${got.rows.length}`)
        for (const r of got.rows) assert.equal(r.edge, got.chips[valueOf(r.line)], `row ${r.line}'s edge is its value's color: ${JSON.stringify(r)}`)
        // the overview in the values' colors
        const px = await overview(page)
        for (const v of [on, other]) assert.ok((px.colors[got.chips[v]] ?? 0) > 50, `the overview shows ${v} (${got.chips[v]}): ${JSON.stringify(px)}`)
        // the other value turned off: its rows stay, every line in order, without its color; the overview shows the
        // value that is on and no trace of the other, as the rows do
        await page.locator(`.reader-colorbar .colorby-chip[data-value="${other}"]`).click()
        await page.waitForTimeout(200)
        const off = await drawn(page)
        assert.ok(off.rows.length > 10 && off.rows.some((r) => valueOf(r.line) === other), `${other} rows still drawn: ${off.rows.map((r) => r.line).slice(0, 20)}`)
        const lines = off.rows.map((r) => r.line)
        assert.ok(lines.every((l, i) => i === 0 || l === lines[i - 1] + 1), `no row left out: ${lines.slice(0, 30)}`)
        for (const r of off.rows) assert.equal(r.edge, valueOf(r.line) === on ? got.chips[on] : null, `row ${r.line}: ${valueOf(r.line) === on ? 'its color' : 'no color'}: ${JSON.stringify(r)}`)
        const pxOff = await overview(page)
        assert.ok((pxOff.colors[got.chips[on]] ?? 0) > 50, `the overview still shows ${on}: ${JSON.stringify(pxOff)}`)
        assert.equal(pxOff.colors[got.chips[other]] ?? 0, 0, `the overview shows no ${other}: ${JSON.stringify(pxOff)}`)
        assert.equal(pxOff.painted, pxOff.colors[got.chips[on]], `nothing else is painted on the overview, faded or not: ${JSON.stringify(pxOff)}`)
        // on again: the color is back on its rows and the overview
        await page.locator(`.reader-colorbar .colorby-chip[data-value="${other}"]`).click()
        await page.waitForTimeout(200)
        const back = await drawn(page)
        for (const r of back.rows) assert.equal(r.edge, got.chips[valueOf(r.line)], `row ${r.line}'s edge is its value's color again: ${JSON.stringify(r)}`)
        assert.ok(((await overview(page)).colors[got.chips[other]] ?? 0) > 50, `the overview shows ${other} again`)
      } finally {
        await browser.close()
      }
    }, 120_000)
