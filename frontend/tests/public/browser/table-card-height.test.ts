// A long table card on the board (canvas/FrameTable, bodies CARD_TABLE_ROWS), drawn by the real Canvas with thimble's
// stylesheets in a real browser: it shows its first 15 rows and `… 91 more rows`, as the terminal's card does, so Fit
// keeps the board readable, and focus mode shows every row (bug hunt D5: a 106-row table drew 3,200 px tall and Fit
// zoomed the board to 11%).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const ROWS = Array.from({ length: 106 }, (_, i) => [`10.${i}.x.x`, 400 - i, 600 - i, '2026-05-24', '2026-07-02'])
const FRAME = {
  columns: ['range', 'names', 'saves', 'first day', 'last day'],
  types: { range: 'nominal', names: 'quantitative', saves: 'quantitative', 'first day': 'nominal', 'last day': 'nominal' },
  index: 'range',
  label: 'range',
  rows: ROWS,
  total: ROWS.length,
  view: { columns: ['names', 'saves', 'first day', 'last day'], formats: {}, more: 0 },
}
const TS = '2026-10-10T12:00:00+00:00'
const table = { id: 'ranges', notebook: 'g', kind: 'table', title: 'Which address ranges did many names share?', takeaway: 'Most ranges were shared.', created_by: 'model', ts: TS, payload: {}, status: 'ok', outputs: [{ 'application/vnd.thimble.frame+json': FRAME, 'text/plain': 'ranges' }] }
const note = { id: 'first', notebook: 'g', kind: 'note', title: 'Which pages were edited first?', takeaway: '', created_by: 'model', ts: TS, payload: { text: 'The welcome page.' }, text: 'The welcome page.' }
const CANVAS = {
  groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }],
  cells: [note, table],
}

beforeAll(async () => {
  const script = await bundle(
    'table-card',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="ranges"]')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The rows a table draws (not hidden), and the line under it. */
const shown = (root: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)!
    const rows = [...el.querySelectorAll<HTMLTableRowElement>('.frame-table tbody tr')].filter((tr) => tr.offsetHeight > 0).length
    return { rows, more: el.querySelector('.frame-table .outputs-showall')?.textContent ?? null, height: (el.closest('.bcell') as HTMLElement | null)?.offsetHeight ?? 0 }
  }, root)

test('a 106-row table card shows 15 rows and `… 91 more rows`, Fit stays readable, and focus mode shows every row', async () => {
  const card = await shown('[data-cell="ranges"]')
  assert.equal(card.rows, 15, 'the terminal card rule: 15 rows')
  assert.equal(card.more, '… 91 more rows')
  assert.ok(card.height < 800, `the card is ${card.height}px tall`)

  await page.click('.bctl-fit')
  await page.waitForTimeout(200)
  const zoom = Number((await page.textContent('.bctl-pct'))?.replace('%', ''))
  assert.ok(zoom >= 50, `Fit zooms to ${zoom}%`)

  await page.dblclick('[data-cell="ranges"] .frame-table tbody td')
  await page.waitForSelector('.bfocus .frame-table')
  const focus = await page.evaluate(() => [...document.querySelectorAll<HTMLTableRowElement>('.bfocus .frame-table tbody tr')].filter((tr) => tr.offsetHeight > 0).length)
  assert.equal(focus, 106, 'focus mode shows every row')
})
