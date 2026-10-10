// The view kit's search, table and diff (backend/app/viewer_search.js, viewer_table.js, viewer_diff.js) in a real
// browser, each page holding the view in a sandboxed frame as ViewerFrame does, in the theme's own tokens: a table of
// 20,000 rows draws only those near its view and keeps them as it scrolls, opens and sorts within a bound far above what
// it takes, and its strip shows Color by's colours of every row; the search washes every match on screen and the current
// one more strongly, puts a lane of ticks on the list's strip (with no Color by, on a strip of its own), and a click on a
// tick goes to that match; the diff sets the two versions side by side, a changed line level with the line it became,
// inline in a narrow mount, and its tints follow the paper. What the parts decide without layout is
// tests/public/data-kit.test.ts.
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
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_search.js', 'viewer_table.js', 'viewer_diff.js', 'viewer_range.js']
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
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'folder', title: 'Folder' }] })
window.side = thimble.side({ mount: '#body' })
window.search = thimble.search({ mount: '#search' })
const t0 = performance.now()
window.table = thimble.table({ mount: '#list', rows: mails, side, search, sort: { by: 't', desc: true },
  columns: [{ name: 'from', title: 'From', width: 120 }, { name: 'subject', title: 'Subject' }, { name: 't', title: 'Date', type: 'time' }] })
window.drawMs = performance.now() - t0
</script>`)

const CHAT = page(`<div class="top"><span id="search"></span></div><div id="chat" style="height:520px;overflow-y:auto;padding:0 8px">
${Array.from({ length: 400 }, (_, i) => `<div class="msg" data-anchor="chat.jsonl#L${i + 1}" style="padding:4px 0">${i % 50 === 9 ? 'the gale is here' : 'calm sea'} ${i}</div>`).join('')}</div>
<script>window.search = thimble.search({ mount: '#search', in: '#chat' })</script>`)

const BEFORE = ['# Memory', '- Ana runs the timetable.', ...Array.from({ length: 30 }, (_, i) => `- note ${i}`), '- Cy is the harbor master.'].join('\n')
const AFTER = ['# Memory', '- Ana runs the timetable and the roster, every week of the summer season.', ...Array.from({ length: 30 }, (_, i) => `- note ${i}`), '- Dee is the harbor master.'].join('\n')
const DIFF = (dark: boolean) =>
  page(`<div id="wide" style="width:900px"></div><div id="narrow" style="width:360px"></div>
<script>
window.wide = thimble.diff({ mount: '#wide', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)} })
window.narrow = thimble.diff({ mount: '#narrow', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)} })
</script>`, dark)

let browser: Browser

beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page holding `doc` in a sandboxed frame 1000 px wide. */
async function framed(doc: string): Promise<{ page: Page; frame: () => Frame }> {
  const p = await browser.newPage({ viewport: { width: 1040, height: 700 } })
  await p.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:1000px;height:660px"></iframe></body></html>`)
  await p.evaluate((d) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = d), doc)
  const frame = () => p.frames().find((f) => f !== p.mainFrame())!
  await p.waitForTimeout(400)
  return { page: p, frame }
}
const typeIn = async (frame: () => Frame, text: string) => {
  await frame().locator('.thimble-search-input').fill(text)
  await frame().waitForTimeout(350)
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

  test('the search: its wash on the matches on screen, the current one stronger; a lane of ticks before the colours; a click on a tick goes there', async () => {
    const { page: p, frame } = await framed(INBOX)
    await typeIn(frame, 'gale warning')
    const got = await frame().evaluate(() => {
      const s = (window as any).search
      const hl = (CSS as any).highlights
      const cur = [...hl.get('thimble-search-current')][0] as Range
      return { count: s.count, at: s.at, current: cur ? cur.toString() : null, others: hl.get('thimble-search')?.size ?? 0, label: document.querySelector('.thimble-search-count')!.textContent }
    })
    // 21 rows hold it, sorted the newest first: the first match is at the top of the list
    assert.equal(got.count, 21)
    assert.equal(got.at, 0)
    assert.equal(got.current, 'Gale warning')
    assert.equal(got.label, '1 of 21')
    // the strip: the search's lane, then Color by's
    await p.waitForTimeout(150)
    const lanes = await canvasOf(frame, 0)
    assert.equal(lanes.width, 22)
    assert.ok(lanes.drawn >= 21 && lanes.drawn < 200, `${lanes.drawn} pixels of ticks`)
    // a click on the 11th tick goes to that match: sorted the newest first, mail 9975 (row 10,024 of the list), its row
    // drawn and its words the current match
    const box = await frame().evaluate(() => {
      const r = document.querySelector('.thimble-colour-strip .thimble-colour-track')!.getBoundingClientRect()
      return { x: r.left, y: r.top, h: r.height }
    })
    const frameBox = (await p.locator('#f').boundingBox())!
    await p.mouse.click(frameBox.x + box.x + 6, frameBox.y + box.y + (10024.5 / 20000) * box.h)
    await p.waitForTimeout(200)
    const after = await frame().evaluate(() => {
      const s = (window as any).search
      const cur = [...(CSS as any).highlights.get('thimble-search-current')][0] as Range
      const row = cur && (cur.startContainer.parentElement!.closest('.thimble-table-row') as HTMLElement)
      return { at: s.at, row: row ? row.getAttribute('data-anchor') : null }
    })
    assert.equal(after.at, 10)
    assert.equal(after.row, 'mail.jsonl#L9976')
    // Enter steps on from there
    await frame().locator('.thimble-search-input').press('Enter')
    assert.equal(await frame().evaluate(() => (window as any).search.at), 11)
    await p.close()
  })
})

describe('the table in a narrow pane', () => {
  test('columns given more width than the pane has give it up, so no cell is drawn over the next, and fit again as the pane widens', async () => {
    const doc = page(`<div id="pane" style="width:380px;height:300px;display:flex"><div id="list" style="flex:1;min-height:0"></div></div>
<script>
window.table = thimble.table({ mount: '#list', rows: Array.from({ length: 200 }, (_, i) => ({ ref: 'm#L' + (i + 1), from: 'someone.with.a.long.name@example.org', subject: 'A subject that runs on ' + i, n: i * 1000, t: 1775000000 + i * 61 })),
  columns: [{ name: 'from', title: 'From', width: 220 }, { name: 'subject', title: 'Subject' }, { name: 'n', title: 'Size', type: 'number' }, { name: 't', title: 'Date', type: 'time' }] })
</script>`)
    const { page: p, frame } = await framed(doc)
    // each cell of a row ends where the next begins or before, and holds its own padding
    const cells = () =>
      frame().evaluate(() =>
        [...document.querySelector('.thimble-table-row')!.children].map((c) => {
          const r = c.getBoundingClientRect()
          return [Math.round(r.left), Math.round(r.right)]
        }),
      )
    const fits = (cs: number[][]) => cs.every(([l, r], i) => r - l >= 16 && (i === 0 || l >= cs[i - 1][1] - 1))
    const narrow = await cells()
    assert.ok(fits(narrow), JSON.stringify(narrow))
    // the subject keeps a readable width rather than none
    assert.ok(narrow[1][1] - narrow[1][0] >= 60, JSON.stringify(narrow))
    // wider: the From column takes its width again
    await frame().evaluate(() => ((document.getElementById('pane') as HTMLElement).style.width = '900px'))
    await p.waitForTimeout(150)
    const wide = await cells()
    assert.ok(fits(wide), JSON.stringify(wide))
    assert.equal(wide[0][1] - wide[0][0], 220)
    await p.close()
  })
})

describe('the search alone', () => {
  test('on a list with no Color by: a strip of its own with the lane of ticks, which a scroll to the match follows', async () => {
    const { page: p, frame } = await framed(CHAT)
    const plain = await frame().evaluate(() => document.querySelector('.thimble-colour-strip')!.hasAttribute('data-plain'))
    assert.equal(plain, true)
    await typeIn(frame, 'GALE')
    await p.waitForTimeout(150)
    const strip = await canvasOf(frame, 0)
    assert.equal(strip.width, 13)
    assert.ok(strip.drawn >= 8, `${strip.drawn} pixels of ticks`)
    // the last match: the list scrolls to it, in the middle
    await frame().evaluate(() => (window as any).search.go(7))
    const shown = await frame().evaluate(() => {
      const cur = [...(CSS as any).highlights.get('thimble-search-current')][0] as Range
      const r = cur.getBoundingClientRect()
      const c = document.getElementById('chat')!.getBoundingClientRect()
      return { text: cur.toString(), inView: r.top >= c.top && r.bottom <= c.bottom, record: cur.startContainer.parentElement!.closest('[data-anchor]')!.getAttribute('data-anchor') }
    })
    assert.deepEqual(shown, { text: 'gale', inView: true, record: 'chat.jsonl#L360' })
    await p.close()
  })
})

describe('the diff', () => {
  const tints: string[] = []
  for (const dark of [false, true])
    test(`side by side in a wide mount, a changed line level with the line it became; inline in a narrow one; tints on the ${dark ? 'dark' : 'light'} paper`, async () => {
      const { page: p, frame } = await framed(DIFF(dark))
      const got = await frame().evaluate(() => {
        const w = window as any
        const row = [...document.querySelectorAll('#wide .thimble-diff-row')].find((r) => r.querySelector('ins.thimble-diff-w'))!
        const [l, r] = [...row.querySelectorAll('.thimble-diff-tx')].map((e) => e.getBoundingClientRect())
        const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor
        const paper = getComputedStyle(document.body).backgroundColor
        return {
          modes: [w.wide.mode, w.narrow.mode],
          level: Math.abs(l.top - r.top) < 1 && Math.abs(l.height - r.height) < 1,
          sideBySide: r.left > l.right - 1,
          del: bg('#wide .thimble-diff-del'),
          ins: bg('#wide .thimble-diff-ins'),
          same: bg('#wide .thimble-diff-same'),
          paper,
          number: getComputedStyle(document.querySelector('#wide .thimble-diff-no[data-n]')!, '::before').content,
          folded: document.querySelectorAll('#wide [data-thimble-fold][hidden]').length,
        }
      })
      assert.deepEqual(got.modes, ['split', 'inline'])
      assert.equal(got.level, true)
      assert.equal(got.sideBySide, true)
      assert.notEqual(got.del, got.ins)
      assert.notEqual(got.del, 'rgba(0, 0, 0, 0)')
      assert.equal(got.same, 'rgba(0, 0, 0, 0)')
      // the dark paper's problem red is another, so is its tint
      tints.push(got.del)
      if (dark) assert.notEqual(tints[1], tints[0])
      assert.equal(got.number, '"1"')
      assert.equal(got.folded, 1)
      await p.close()
    })
})
