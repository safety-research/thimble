// Fit on a board of many groups (canvas/layout.ts columnsOf), drawn by the real Canvas with thimble's stylesheets in a
// real browser: 25 cards in 18 groups, most of them groups nested in the analyst's frame, as main's questions and
// labels leave them. The nested groups flow down side-by-side columns in their order, so Fit shows the board at a zoom
// where the cards are told apart, no card covers another, and the groups keep their order (bug hunt E5: every group
// stood in one column and Fit zoomed to 8%). THIMBLE_CANVAS_FIT_SHOT=<file.png> saves a picture of the board after Fit.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const TS = '2026-10-10T12:00:00+00:00'
const group = (id: string, title: string, parent: string | null, extra: object = {}) => ({ id, title, parent, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const text = (n: number) => Array.from({ length: 3 + (n % 4) }, (_, i) => `Line ${i + 1} of the answer about step ${n}: the lamp moved ${n + i} times.`).join('\n\n')
const note = (id: string, notebook: string, n: number, by = 'model') => ({ id, notebook, kind: 'note', title: `Which shelf held lamp ${n} longest?`, takeaway: `Shelf ${n % 5} held it ${n + 2} days.`, created_by: by, ts: TS, payload: { text: text(n) }, text: text(n) })

// the orientation's deck (3 cards), the analyst's frame with 15 nested groups (21 cards), and a thread's group beside a
// card of one of them (1 card): 25 cards, 18 groups
const nested = Array.from({ length: 15 }, (_, i) => group(`q${i}`, `lamp question ${i + 1}`, 'work'))
const GROUPS = [group('deck', 'Orientation', null, { role: 'exploration' }), group('work', 'Your work', null), ...nested, group('thr', 'main/why shelf 2', 'q3', { anchor: 'c3a', chat: 'thr' })]
const CELLS = [
  ...[0, 1, 2].map((n) => note(`o${n}`, 'deck', n, 'orient')),
  ...nested.flatMap((g, i) => (i < 6 ? [note(`c${i}a`, g.id, i), note(`c${i}b`, g.id, i + 20)] : [note(`c${i}a`, g.id, i)])),
  note('t0', 'thr', 40, 'chat:thr'),
]
const CANVAS = { groups: GROUPS, cells: CELLS }

beforeAll(async () => {
  const script = await bundle(
    'canvas-fit-groups',
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
  // the canvas's room in a 1600 × 1000 window beside the chat
  page = await browser.newPage({ viewport: { width: 1260, height: 950 } })
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
  await page.waitForSelector('[data-cell="t0"]')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test('Fit shows 25 cards in 18 groups readably, the nested groups in columns in their order, no card over another', async () => {
  await page.click('.bctl-fit')
  await page.waitForTimeout(200)
  const zoom = Number((await page.textContent('.bctl-pct'))?.replace('%', ''))
  const shot = process.env.THIMBLE_CANVAS_FIT_SHOT
  if (shot) writeFileSync(path.resolve(shot), await page.screenshot())
  assert.ok(zoom >= 18, `Fit zooms to ${zoom}%`)

  const boxes = await page.evaluate((ids) => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect()
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
    }
    return { cards: ids.cells.map((id) => box(`[data-cell="${id}"]`)), frames: ids.groups.map((id) => box(`[data-group="${id}"]`)) }
  }, { cells: CELLS.map((c) => c.id), groups: nested.map((g) => g.id) })
  const cards = boxes.cards.map((b, i) => {
    assert.ok(b, `card ${CELLS[i].id} is drawn`)
    return b
  })
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) {
      const [a, b] = [cards[i], cards[j]]
      assert.ok(a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5, `${CELLS[i].id} and ${CELLS[j].id} overlap`)
    }
  // the nested groups read in their order, down each column and then across, and stand side by side
  const frames = boxes.frames.map((b, i) => {
    assert.ok(b, `group ${nested[i].id} is drawn`)
    return b
  })
  for (let i = 1; i < frames.length; i++) {
    const [a, b] = [frames[i - 1], frames[i]]
    assert.ok(b.x > a.x + 0.5 || (Math.abs(b.x - a.x) <= 0.5 && b.y > a.y), `${nested[i].id} comes after ${nested[i - 1].id}`)
  }
  assert.ok(new Set(frames.map((f) => Math.round(f.x))).size > 1, 'the nested groups stand side by side')
})
