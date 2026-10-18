// The view kit's table (backend/app/viewer_table.js) in a real browser, the page holding the view in a sandboxed frame
// as ViewerFrame does, in the theme's own tokens: a table of 20,000 rows draws within a bound far above what it takes,
// only the rows near its view, keeps them as it scrolls, and its strip shows Color by's colours of every row. What the
// kit's parts decide without layout is tests/public/data-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_messages.js', 'viewer_search.js', 'viewer_table.js', 'viewer_diff.js', 'viewer_record.js', 'viewer_range.js']
    .map((n) => `<script>${inline(read(n))}</script>`)
    .join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
// the theme's own tokens, light and dark (data-paper="dark")
const TOKENS = readFileSync(path.join(FRONTEND, 'src', 'styles', 'tokens.css'), 'utf8') + ':root{--font-body:sans-serif;--font-mono:monospace}'
// A bound many times what a step takes in headless Chromium (a table of 20,000 rows draws in about 0.1 s here), so a
// slower machine passes and a table that draws every row fails.
const DRAW_MS = 2500

const page = (body: string, dark = false) =>
  `<!doctype html><html${dark ? ' data-paper="dark"' : ''}><head><style>${TOKENS} html,body{margin:0;height:100%} body{background:var(--surface-card);overflow:hidden}
.top{display:flex;gap:8px;align-items:center;padding:8px} #body{height:560px} #list{min-height:0}</style>${KIT}</head><body>${body}</body></html>`

const INBOX = page(`<div class="top"><span id="search"></span><span id="colour"></span></div><div id="body"><div id="list"></div></div>
<script>
const T0 = Date.UTC(2026, 3, 1) / 1000
window.mails = Array.from({ length: 20000 }, (_, i) => ({ ref: 'mail.jsonl#L' + (i + 1), from: ['ana', 'bo', 'cy', 'dee'][i % 4], subject: (i % 997 === 5 ? 'Gale warning ' : 'Note ') + i, t: T0 + i * 60, folder: ['Inbox', 'Ops', 'Billing'][i % 3] }))
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'folder', title: 'Folder' }], initial: 'folder' })
window.side = thimble.side({ mount: '#body' })
window.search = thimble.search({ mount: '#search' })
const t0 = performance.now()
window.table = thimble.table({ mount: '#list', rows: mails, side, search, sort: { by: 't', desc: true },
  columns: [{ name: 'from', title: 'From', width: 120 }, { name: 'subject', title: 'Subject' }, { name: 't', title: 'Date', type: 'time' }] })
window.drawMs = performance.now() - t0
</script>`)

let browser: Browser

beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page holding `doc` in a sandboxed frame `width` px wide, 1000 by default. */
async function framed(doc: string, width = 1000): Promise<{ page: Page; frame: () => Frame }> {
  const p = await browser.newPage({ viewport: { width: width + 40, height: 700 } })
  await p.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:${width}px;height:660px"></iframe></body></html>`)
  await p.evaluate((d) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = d), doc)
  const frame = () => p.frames().find((f) => f !== p.mainFrame())!
  await p.waitForTimeout(400)
  return { page: p, frame }
}
/** the strip's canvas: its width in css px, and how many of its pixels in the lane `lane` are drawn */
const canvasOf = (frame: () => Frame, lane: number) =>
  frame().evaluate((lane) => {
    const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
    const dpr = window.devicePixelRatio || 1
    const x = Math.round((3 + lane * 9 + 3) * dpr)
    const data = cv.getContext('2d')!.getImageData(x, 0, 1, cv.height).data
    let drawn = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) drawn++
    return { width: parseFloat(cv.style.width), drawn }
  }, lane)

describe('the table, with Color by and the search', () => {
  test('20,000 rows: drawn in a bound, only those near the view, kept as it scrolls; the strip shows every row', async () => {
    const { page: p, frame } = await framed(INBOX)
    const drawMs = await frame().evaluate(() => (window as any).drawMs)
    assert.ok(drawMs < DRAW_MS, `the table took ${drawMs} ms`)
    const rows = () => frame().evaluate(() => document.querySelectorAll('.thimble-table-row').length)
    assert.ok((await rows()) < 100, `${await rows()} rows drawn`)
    // a short scroll keeps the rows still near the view as they were, and draws the new ones
    const kept = await frame().evaluate(async () => {
      const list = document.getElementById('list')!
      const row = document.querySelector('.thimble-table-row[data-thimble-row="20"]')
      list.scrollTop += 140
      await new Promise((r) => setTimeout(r, 100))
      return { same: document.querySelector('.thimble-table-row[data-thimble-row="20"]') === row, last: Math.max(...[...document.querySelectorAll('.thimble-table-row')].map((e) => +e.getAttribute('data-thimble-row')!)) }
    })
    assert.equal(kept.same, true)
    assert.ok(kept.last > 30)
    // to the end: the last row drawn, the first ones gone
    const end = await frame().evaluate(async () => {
      const list = document.getElementById('list')!
      list.scrollTop = list.scrollHeight
      await new Promise((r) => setTimeout(r, 100))
      return { last: !!document.querySelector('.thimble-table-row[data-thimble-row="19999"]'), first: !!document.querySelector('.thimble-table-row[data-thimble-row="0"]') }
    })
    assert.deepEqual(end, { last: true, first: false })
    // a sort by a click on a head, in a bound
    const sortMs = await frame().evaluate(() => {
      const t0 = performance.now()
      ;(document.querySelector('[data-col="from"]') as HTMLElement).click()
      return performance.now() - t0
    })
    assert.ok(sortMs < DRAW_MS, `the sort took ${sortMs} ms`)
    // the strip: one lane, Color by's, drawn down its whole height for rows never scrolled to
    await p.waitForTimeout(150)
    const strip = await canvasOf(frame, 0)
    assert.equal(strip.width, 13)
    assert.ok(strip.drawn > 300, `${strip.drawn} pixels drawn`)
    await p.close()
  })
})
