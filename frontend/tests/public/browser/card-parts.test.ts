// The ⌘ pointer inside a card (src/pointer/parts.ts through src/pointer/CmdPointer.tsx), over the canvas's own card
// face: the highlight and a ⌘-click take the innermost part under the pointer, and the thread the box posts is about
// that part. A table's value is its cell's span and its row label the row; a line of printed output is its line's span;
// a chart's bar is its datum's fields; a timeline's event, a diagram's node and an edge's label are their own text; the
// card's edge and its question's line still take the whole card and the question's text.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { addStyles, bundle, cleanup, launch, ORIGIN, serve, src } from './page.ts'

let script: string
let browser: Browser
let page: Page
const posted: { anchor: string; anchor_text: string | null }[] = []

const TABLE = `<table class="dataframe"><thead><tr><th></th><th>pages</th><th>revisions</th></tr><tr><th>wiki</th><th></th><th></th></tr></thead><tbody><tr><th>north</th><td>3,120</td><td>11,206</td></tr><tr><th>south</th><td>540</td><td>1,086</td></tr></tbody></table>`
const cell = (id: string, kind: string, extra: object) => ({ id, notebook: 'g', kind, title: `Question of ${id}`, created_by: 'user', ts: '2026-09-22T10:00:00Z', takeaway: '', ...extra })
const CARDS = [
  cell('tab1', 'table', { outputs: [{ 'text/html': TABLE, 'text/plain': 'the table' }] }),
  cell('out1', 'code', { code: 'print(1)', outputs: [{ 'text/plain': 'rows 12480\ncols 32\nwikis 4', _stream: 'stdout' }] }),
  cell('bar1', 'plot', {
    outputs: [
      {
        'application/vnd.vegalite.v5+json': {
          $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
          data: { values: [{ wiki: 'north', saves: 11206 }, { wiki: 'south', saves: 1086 }, { wiki: 'east', saves: 142 }] },
          mark: 'bar',
          encoding: { x: { field: 'wiki', type: 'nominal' }, y: { field: 'saves', type: 'quantitative' } },
        },
      },
    ],
  }),
  cell('tl1', 'timeline', { payload: { dataset: { events: [{ time: '2026-05-24', label: 'first save' }, { time: '2026-06-18', label: 'peak afternoon' }, { time: '2026-07-14', label: 'last deletion' }] } } }),
  cell('dg1', 'diagram', { payload: { dataset: { nodes: [{ id: 'a', label: 'agents' }, { id: 'w', label: 'north wiki' }], edges: [{ source: 'a', target: 'w', label: 'saves' }] } } }),
]

beforeAll(async () => {
  script = await bundle('card-parts', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { CardFace } from '${src('canvas/CardFace.tsx')}'`,
    `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
    `window.__mount = (cards) => { const el = document.createElement('div'); el.style.cssText = 'position:absolute;left:20px;top:0;width:560px'; document.body.appendChild(el); flushSync(() => createRoot(el).render(<><div data-panel="canvas">{cards.map((c) => <div key={c.id} className="bcell" style={{ position: 'relative', width: 560, marginBottom: 24 }}><CardFace cell={c} width={532} label={{ concept: null, error: null }} /></div>)}</div><CmdPointer ws="w" /></>)) }`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1100, height: 2400 } })
  page.on('pageerror', (e) => assert.fail(String(e)))
  await serve(page, (req, url) => {
    if (url.pathname === '/api/ws/w/chats' && req.method() === 'POST') {
      posted.push(JSON.parse(req.postData() ?? '{}'))
      return { json: { detail: 'no session' }, status: 409 }
    }
    return undefined
  })
  await page.goto(`${ORIGIN}/?ws=w`)
  await addStyles(page, ['tokens', 'base', 'components', 'spinner', 'refchip', 'outputs', 'canvas', 'pointer'])
  await page.addScriptTag({ path: script })
  await page.evaluate((cards) => (window as any).__mount(cards), CARDS)
  await page.waitForSelector('[data-cell="bar1"] .mark-rect path')
  await page.waitForSelector('[data-cell="dg1"] .canvas-diagram-node')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The point `dx`, `dy` into the first element `sel` matches (its middle when not given). */
async function pointIn(sel: string, dx?: number, dy?: number) {
  const r = await page.locator(sel).first().boundingBox()
  assert.ok(r, `${sel} is drawn`)
  return { x: r.x + (dx ?? r.width / 2), y: r.y + (dy ?? r.height / 2) }
}

/** ⌘-hover then ⌘-click at `p`, then a question sent from the box: the highlight's box and the thread it posted. */
async function point(p: { x: number; y: number }) {
  await page.mouse.move(p.x - 10, p.y - 10)
  await page.keyboard.down('Control')
  await page.mouse.move(p.x, p.y)
  const lit = await page.evaluate(() => {
    const h = document.querySelector<HTMLElement>('.pointer-hl')!
    return { on: h.hasAttribute('data-on'), kind: h.dataset.kind, w: parseFloat(h.style.width), h: parseFloat(h.style.height) }
  })
  await page.mouse.click(p.x, p.y)
  await page.keyboard.up('Control')
  await page.waitForSelector('.pointer-box')
  await page.keyboard.type('why')
  await page.keyboard.press('Enter')
  for (let i = 0; i < 60 && !posted.length; i++) await page.waitForTimeout(50)
  await page.keyboard.press('Escape')
  await page.mouse.move(1, 1)
  return { lit, thread: posted.pop() }
}

test("a table's value is its cell's span, and its row label is the row with each column's value", async () => {
  const cellAt = await point(await pointIn('[data-cell="tab1"] tbody tr:nth-child(1) td:nth-child(3)'))
  assert.equal(cellAt.lit.kind, 'region')
  assert.ok(cellAt.lit.w < 200, `the cell lights, not the card (${cellAt.lit.w}px)`)
  assert.deepEqual(cellAt.thread, { ...cellAt.thread, anchor: 'card:tab1#revisions/north', anchor_text: '11,206' })
  const row = await point(await pointIn('[data-cell="tab1"] tbody tr:nth-child(2) th'))
  assert.equal(row.thread?.anchor, 'card:tab1')
  assert.equal(row.thread?.anchor_text, 'south · pages: 540 · revisions: 1,086')
})

test('a line of printed output is its line', async () => {
  const { thread } = await point(await pointIn('[data-cell="out1"] pre.outputs-text', 20, undefined))
  assert.match(thread?.anchor ?? '', /^card:out1@out0#L[123]$/)
  const n = Number(/#L(\d)$/.exec(thread!.anchor)![1])
  assert.equal(thread?.anchor_text, ['rows 12480', 'cols 32', 'wikis 4'][n - 1], 'the text of the line the ref names')
})

test("a chart's bar is its datum's fields", async () => {
  const { lit, thread } = await point(await pointIn('[data-cell="bar1"] .mark-rect path'))
  assert.ok(lit.w < 200, `the bar lights (${lit.w}px)`)
  assert.equal(thread?.anchor, 'card:bar1')
  assert.equal(thread?.anchor_text, 'bar · wiki: north · saves: 11,206')
})

test("a timeline's event, a diagram's node and an edge's label are their own text", async () => {
  const ev = await point(await pointIn('[data-cell="tl1"] .canvas-tl-row:nth-child(2)'))
  assert.equal(ev.thread?.anchor, 'card:tl1')
  assert.match(ev.thread?.anchor_text ?? '', /^Jun 18\s+peak afternoon$/, 'the event as the timeline shows it')
  const node = await point(await pointIn('[data-cell="dg1"] .canvas-diagram-node rect'))
  assert.equal(node.thread?.anchor_text, 'agents')
  const edge = await point(await pointIn('[data-cell="dg1"] .canvas-diagram-label-bg'))
  assert.equal(edge.thread?.anchor_text, 'agents → north wiki: saves')
})

test("the card's edge takes the whole card, and its question is text", async () => {
  const edge = await point(await pointIn('[data-cell="tab1"]', 3, 120))
  assert.equal(edge.thread?.anchor, 'card:tab1')
  assert.equal(edge.thread?.anchor_text, 'Question of tab1', "the card's own text")
  assert.ok(edge.lit.w > 500, 'the card lights')
  const q = await point(await pointIn('[data-cell="tab1"] .bcell-q', 10))
  assert.equal(q.lit.kind, 'word', 'a word of the question is tinted')
  assert.equal(q.thread?.anchor, 'card:tab1')
  assert.equal(q.thread?.anchor_text, 'Question of tab1')
})
