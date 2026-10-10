// The view kit's search, table and diff (backend/app/viewer_search.js, viewer_table.js, viewer_diff.js) in a real
// browser, each page holding the view in a sandboxed frame as ViewerFrame does, in the theme's own tokens: a table of
// 20,000 rows draws only those near its view and keeps them as it scrolls, opens and sorts within a bound far above what
// it takes, and its strip shows Color by's colours of every row; a column of numbers is as wide as its head's title
// with the sort's arrow; the search washes every match on screen and the current
// one more strongly, puts a lane of ticks on the list's strip (with no Color by, on a strip of its own), and a click on a
// tick goes to that match; it finds the words a transcript or a record folds away (viewer_transcript.js,
// viewer_record.js), ticks them where they stand, and going to one opens its fold so the match shows; a table beside the
// side panel keeps its main column of text, drops columns in their order rather than draw a cell under the strip, and
// draws them again when the panel closes; the diff sets the two versions side by side, a changed line level with the line
// it became, inline in a narrow mount, and its tints follow the paper; a patch's file head and hunk lines span both
// sides; a table column's second line (sub) stands under its value inside the row. What the parts decide without layout
// is tests/public/data-kit.test.ts.
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
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_search.js', 'viewer_table.js', 'viewer_diff.js', 'viewer_record.js', 'viewer_range.js']
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
<div id="padded" style="box-sizing:border-box;width:800px;padding:0 40px"></div>
<script>
window.wide = thimble.diff({ mount: '#wide', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)} })
window.narrow = thimble.diff({ mount: '#narrow', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)} })
window.padded = thimble.diff({ mount: '#padded', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)} })
</script>`, dark)
// a commit's patch of one file in two hunks, as a forge stores it
const PATCH = ['--- a/brindle/schedules.py', '+++ b/brindle/schedules.py', '@@ -112,3 +112,4 @@ class Schedule:', '     def _occurrence(self, n):',
  '-        at = self.anchor + n * self.period', '+        local = self.anchor.replace(tzinfo=None)', '+        at = local + n * self.period', '         return at',
  '@@ -140,2 +141,2 @@ class Schedule:', '-        return None', '+        return self.anchor', '     # end'].join('\n')
const PATCHED = page(`<div id="wide" style="width:900px"></div><div id="narrow" style="width:360px"></div>
<script>
window.wide = thimble.diff({ mount: '#wide', patch: ${JSON.stringify(PATCH)} })
window.narrow = thimble.diff({ mount: '#narrow', patch: ${JSON.stringify(PATCH)} })
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

describe('the table with a second line', () => {
  test("a column's sub: under its value, both lines inside the row's height and cut with an ellipsis, light and dark", async () => {
    for (const dark of [false, true]) {
      const doc = page(`<div id="pane" style="width:600px;height:400px;display:flex"><div id="list" style="flex:1;min-height:0"></div></div>
<script>
window.table = thimble.table({ mount: '#list', rows: Array.from({ length: 50 }, (_, i) => ({ ref: 'pr#' + (i + 1), title: 'A pull request whose title runs on and on past its column, as a long title does in a narrow pane ' + i, n: i, by: 'ash' })),
  columns: [{ name: 'title', title: 'Pull request', sub: (r) => '#' + r.n + ' opened 09:24 by ' + r.by + ' · fixes #1 · approved · merged by its author · merged over a change request' },
    { name: 'n', title: 'Comments', type: 'number' }] })
</script>`, dark)
      const { page: p, frame } = await framed(doc)
      const got = await frame().evaluate(() => {
        const row = document.querySelector('.thimble-table-row') as HTMLElement
        const box = (sel: string) => row.querySelector(sel)!.getBoundingClientRect()
        const rr = row.getBoundingClientRect()
        const line = row.querySelector('.thimble-table-line') as HTMLElement
        const sub = row.querySelector('.thimble-table-sub') as HTMLElement
        return {
          row: [rr.top, rr.bottom], line: [box('.thimble-table-line').top, box('.thimble-table-line').bottom], sub: [box('.thimble-table-sub').top, box('.thimble-table-sub').bottom],
          cut: [line.scrollWidth > line.clientWidth, sub.scrollWidth > sub.clientWidth], ellipsis: getComputedStyle(sub).textOverflow,
          inks: [getComputedStyle(line).color, getComputedStyle(sub).color],
          next: (document.querySelectorAll('.thimble-table-row')[1] as HTMLElement).getBoundingClientRect().top,
        }
      })
      // both lines inside the row, the second under the first, and the next row below it
      assert.ok(got.line[0] >= got.row[0] && got.sub[0] >= got.line[1] - 1 && got.sub[1] <= got.row[1], JSON.stringify(got))
      assert.ok(got.next >= got.row[1] - 1, JSON.stringify(got))
      // each cut at the column's edge with an ellipsis, the second line in a quieter ink than the first
      assert.deepEqual(got.cut, [true, true])
      assert.equal(got.ellipsis, 'ellipsis')
      assert.notEqual(got.inks[0], got.inks[1])
      await p.close()
    }
  })
})

describe('the table under the lanes', () => {
  test('its rows carry their times in the order they stand, so the lanes tint the rows in view as it scrolls, sorted by time or not', async () => {
    const doc = page(`<div id="lanes" style="width:800px"></div><div id="list" style="height:300px"></div>
<script>
const T0 = Date.UTC(2026, 4, 16) / 1000
window.events = Array.from({ length: 2000 }, (_, i) => ({ ref: 'e.jsonl#L' + (i + 1), t: T0 + i * 60, source: ['alert', 'chat', 'deploy'][i % 3], text: 'event ' + i }))
window.lanes = thimble.timeline({ mount: '#lanes', rows: 'source', follow: '#list' })
window.lanes.draw(events)
window.table = thimble.table({ mount: '#list', rows: events, sort: { by: 't', desc: true },
  columns: [{ name: 't', title: 'Time', type: 'time' }, { name: 'source', title: 'Source', width: 90 }, { name: 'text', title: 'Text' }] })
</script>`)
    const { page: p, frame } = await framed(doc)
    // the rows drawn, in the page's order: their places among the rows and their times; and the times of those in view
    const state = () =>
      frame().evaluate(() => {
        const box = document.getElementById('list')!.getBoundingClientRect()
        const rows = [...document.querySelectorAll('#list .thimble-table-row')] as HTMLElement[]
        const seen = rows.filter((r) => r.getBoundingClientRect().bottom > box.top && r.getBoundingClientRect().top < box.bottom).map((r) => +r.dataset.t!)
        const span = document.querySelector('.thimble-lanes-span') as HTMLElement
        const sc = (window as any).lanes.scale
        return {
          order: rows.map((r) => +r.dataset.thimbleRow!),
          timed: rows.every((r) => r.dataset.t === String((window as any).table.rows[+r.dataset.thimbleRow!].t)),
          shown: span.style.display,
          span: [parseFloat(span.style.left), parseFloat(span.style.left) + parseFloat(span.style.width)],
          want: [sc.x(Math.min(...seen)), sc.x(Math.max(...seen))],
          names: parseFloat(getComputedStyle(document.getElementById('lanes')!).getPropertyValue('--thimble-names')) || 0,
        }
      })
    const tinted = (s: Awaited<ReturnType<typeof state>>) => Math.abs(s.span[0] - s.names - s.want[0]) <= 2.5 && Math.abs(s.span[1] - s.names - s.want[1]) <= 2.5
    const ordered = (s: Awaited<ReturnType<typeof state>>) => s.order.every((k, i) => !i || k > s.order[i - 1])
    let s = await state()
    assert.equal(s.timed, true)
    assert.equal(s.shown, 'block')
    assert.ok(tinted(s), JSON.stringify(s))
    // to the middle, then back up a little, which draws rows above those kept: still in the order they stand
    await frame().evaluate(async () => {
      const list = document.getElementById('list')!
      list.scrollTop = 28 * 1000
      await new Promise((r) => setTimeout(r, 120))
      list.scrollTop -= 28 * 20
      await new Promise((r) => setTimeout(r, 120))
    })
    s = await state()
    assert.ok(ordered(s), JSON.stringify(s.order))
    assert.ok(tinted(s), JSON.stringify(s))
    // sorted by the source: the tint spans the earliest and the latest of the rows in view
    await frame().evaluate(async () => {
      ;(document.querySelector('[data-col="source"]') as HTMLElement).click()
      await new Promise((r) => setTimeout(r, 120))
    })
    s = await state()
    assert.ok(ordered(s), JSON.stringify(s.order))
    assert.ok(tinted(s), JSON.stringify(s))
    await p.close()
  })
})

describe("the table's heads", () => {
  test("a column of short numbers is as wide as its head's title in capitals with the sort's arrow beside it", async () => {
    // Live check 0.7.0: a forge's Comments column, its counts one digit, read COMME… once sorted by it
    const doc = page(`<div id="list" style="height:300px"></div>
<script>
window.table = thimble.table({ mount: '#list', sort: { by: 'comments', desc: true },
  rows: Array.from({ length: 50 }, (_, i) => ({ ref: 'forge.db#prs/' + (100 + i), title: 'A pull request ' + i, comments: i % 4, reviews: i % 9, merged: 1775000000 + i * 61 })),
  columns: [{ name: 'title', title: 'Title' }, { name: 'comments', title: 'Comments', type: 'number' }, { name: 'reviews', title: 'Reviews', type: 'number' }, { name: 'merged', title: 'Merged', type: 'time' }] })
</script>`)
    const { page: p, frame } = await framed(doc)
    const cut = () =>
      frame().evaluate(() =>
        [...document.querySelectorAll('.thimble-table-th.active .thimble-table-title')]
          .filter((t) => t.scrollWidth > t.clientWidth + 0.5)
          .map((t) => `${t.textContent} ${t.scrollWidth} > ${t.clientWidth}`),
      )
    assert.deepEqual(await cut(), [])
    for (const col of ['reviews', 'merged']) {
      await frame().locator(`[data-col="${col}"]`).click()
      await p.waitForTimeout(100)
      assert.equal(await frame().evaluate(() => document.querySelectorAll('.thimble-table-th.active').length), 1)
      assert.deepEqual(await cut(), [], `sorted by ${col}`)
    }
    await p.close()
  })
})

// A forge's pull requests, five columns: their times share a year and have seconds
const PULLS = (columns: object[], pane = '') =>
  page(`<div class="top"><span id="search"></span><span id="colour"></span></div><div id="body" style="${pane}"><div id="list"></div></div>
<script>
const T0 = Date.UTC(2026, 3, 1) / 1000
window.prs = Array.from({ length: 300 }, (_, i) => ({ ref: 'forge.db#prs/' + (65000 - i), number: 65000 - i, title: 'BUG: a title that says what the change fixes ' + i,
  author: 'gh:contributor-' + (i % 17), state: ['open', 'merged', 'closed'][i % 3], t: T0 - i * 3607 }))
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'state', title: 'State' }] })
window.side = thimble.side({ mount: '#body' })
window.search = thimble.search({ mount: '#search' })
window.table = thimble.table({ mount: '#list', rows: prs, side, search, sort: { by: 't', desc: true }, columns: ${JSON.stringify(columns)} })
</script>`)
/** the table's head titles, each cell's left and right edge in the head and the first row, the body's right edge, the
 *  width and text of each cell of the first row by its column's title (as drawn: the parts of a time drawn 0 wide left
 *  out), and the widest of those parts */
const columnsOf = (frame: () => Frame) =>
  frame().evaluate(() => {
    const edges = (el: Element) => [...el.children].map((c) => [c.getBoundingClientRect().left, c.getBoundingClientRect().right])
    const head = document.querySelector('.thimble-table-head')!
    const row = document.querySelector('.thimble-table-row[data-thimble-row="0"]')!
    const titles = [...head.children].map((c) => c.textContent!)
    const drawn = (c: Element) => [...c.childNodes].map((n) => ((n as Element).classList?.contains('thimble-table-cut') ? '' : n.textContent)).join('')
    const cells: Record<string, { w: number; text: string }> = {}
    ;[...row.children].forEach((c, i) => (cells[titles[i]] = { w: c.getBoundingClientRect().width, text: drawn(c) }))
    const cut = Math.max(0, ...[...document.querySelectorAll('.thimble-table-cut')].map((e) => e.getBoundingClientRect().width))
    return { titles, head: edges(head), row: edges(row), body: document.querySelector('.thimble-table-body')!.getBoundingClientRect().right, cells, cut }
  })
type Columns = Awaited<ReturnType<typeof columnsOf>>
/** no cell of the head or the row passes the body's right edge, so none is under the strip, and none is drawn over the next */
const inside = (c: Columns) =>
  [c.head, c.row].every((cs) => cs.length === c.titles.length && cs.every(([l, r], i) => r <= c.body + 0.5 && (i === 0 || l >= cs[i - 1][1] - 0.5)))

describe('the table beside the side panel', () => {
  test('five columns at 1048 px: the panel opens, the first column of text keeps its min, columns drop in their order and none is under the strip; they come back as it closes', async () => {
    const MIN = 460
    const doc = PULLS([
      { name: 'number', title: '#', type: 'number' },
      { name: 'title', title: 'Title', min: MIN },
      { name: 'author', title: 'Author', width: 150, drop: 2 },
      { name: 'state', title: 'State', width: 80, drop: 1 },
      { name: 't', title: 'Opened', type: 'time', drop: 3 },
    ])
    const { page: p, frame } = await framed(doc, 1048)
    const wide = await columnsOf(frame)
    assert.deepEqual(wide.titles, ['#', 'Title', 'Author', 'State', 'Opened'])
    assert.ok(inside(wide), JSON.stringify(wide))
    assert.equal(wide.cells.Opened.text, '2026-04-01 00:00:00')
    // the panel takes 0.4 of the mount: Opened drops first (3), then Author (2), and State (1) stays
    await frame().evaluate(() => (window as any).table.open('forge.db#prs/65000'))
    await p.waitForTimeout(150)
    const beside = await columnsOf(frame)
    assert.deepEqual(beside.titles, ['#', 'Title', 'State'], JSON.stringify(beside))
    assert.ok(beside.cells.Title.w >= MIN, JSON.stringify(beside))
    assert.ok(inside(beside), JSON.stringify(beside))
    const held = await frame().evaluate(() => {
      const w = window as any
      // a dropped column is still searched, and the panel's default details still show it whole
      w.search.set('gh:contributor-3')
      const fields = [...document.querySelectorAll('.thimble-side .thimble-table-fields dt')].map((e) => [e.textContent, e.nextElementSibling!.textContent])
      return { count: w.search.count, fields }
    })
    assert.equal(held.count, 18)
    assert.deepEqual(held.fields, [['#', '65,000'], ['Title', 'BUG: a title that says what the change fixes 0'], ['Author', 'gh:contributor-0'], ['State', 'open'], ['Opened', '2026-04-01 00:00:00']])
    // "o" is twice in each dropped Author and once in a State "open" or "closed": every one counts, and the current
    // match, the first of the top row, is washed in its State cell
    const shown = await frame().evaluate(() => {
      const w = window as any
      w.search.set('o')
      const cur = [...(CSS as any).highlights.get('thimble-search-current')][0] as Range
      const cell = cur.startContainer.parentElement!.closest('.thimble-table-td')!
      return { count: w.search.count, at: w.search.at, cell: cell.textContent, row: cell.parentElement!.getAttribute('data-anchor') }
    })
    assert.deepEqual(shown, { count: 800, at: 0, cell: 'open', row: 'forge.db#prs/65000' })
    // closed: every column is back
    await frame().evaluate(() => (window as any).side.close())
    await p.waitForTimeout(150)
    const back = await columnsOf(frame)
    assert.deepEqual(back.titles, ['#', 'Title', 'Author', 'State', 'Opened'])
    assert.ok(inside(back), JSON.stringify(back))
    assert.equal(await frame().evaluate(() => (window as any).search.count), 800)
    await p.close()
  })

  test('with no drop given, a narrowing table writes its times shorter, then drops the rightmost columns, the one the rows are sorted by last, never the main column', async () => {
    const doc = PULLS(
      [
        { name: 'number', title: '#', type: 'number' },
        { name: 'title', title: 'Title' },
        { name: 'author', title: 'Author', width: 150 },
        { name: 'state', title: 'State', width: 80 },
        { name: 't', title: 'Opened', type: 'time' },
      ],
      'width:1000px',
    )
    const { page: p, frame } = await framed(doc, 1048)
    const at = async (width: number) => {
      await frame().evaluate((w) => ((document.getElementById('body') as HTMLElement).style.width = w + 'px'), width)
      await p.waitForTimeout(150)
      return columnsOf(frame)
    }
    const steps: [number, string[], string | null][] = [
      [1000, ['#', 'Title', 'Author', 'State', 'Opened'], '2026-04-01 00:00:00'],
      // without the seconds, then without the year, which every row shares
      [520, ['#', 'Title', 'Author', 'State', 'Opened'], '04-01 00:00'],
      // the rows are sorted by Opened, which drops after the others and keeps its arrow
      [380, ['#', 'Title', 'Author', 'Opened'], '04-01 00:00'],
      [250, ['Title', 'Opened'], '04-01 00:00'],
      [100, ['Title'], null],
      [1000, ['#', 'Title', 'Author', 'State', 'Opened'], '2026-04-01 00:00:00'],
    ]
    const march = () => frame().evaluate(() => ((window as any).search.set('2026-03-31 2'), (window as any).search.count))
    for (const [width, titles, opened] of steps) {
      const got = await at(width)
      assert.deepEqual(got.titles, titles, `${width}px: ${JSON.stringify(got)}`)
      if (opened) assert.equal(got.cells.Opened.text, opened, `${width}px`)
      assert.equal(got.cut, 0, `${width}px`)
      assert.ok(inside(got), `${width}px: ${JSON.stringify(got)}`)
      if (width > 200) assert.ok(got.cells.Title.w >= 120, `${width}px: ${JSON.stringify(got)}`)
      // Title, which takes the width left, is the widest column of text: the others gave up width with it
      if (width === 520) assert.ok(got.cells.Title.w > got.cells.Author.w, `${width}px: ${JSON.stringify(got)}`)
      // the search finds a time whole at every width, its year and seconds drawn or not: the three from 20:00 to 22:59
      if (opened) assert.equal(await march(), 3, `${width}px`)
      if (titles.includes('Opened')) assert.equal(await frame().evaluate(() => document.querySelector('.thimble-table-th.active')?.textContent), 'Opened', `${width}px`)
    }
    // a click on Author's head sorts by it: Opened drops now, as the rightmost, and State is drawn again
    await at(380)
    await frame().evaluate(() => (document.querySelector('.thimble-table-th[data-col="author"]') as HTMLElement).click())
    const byAuthor = await columnsOf(frame)
    assert.deepEqual(byAuthor.titles, ['#', 'Title', 'Author', 'State'], JSON.stringify(byAuthor))
    assert.ok(inside(byAuthor), JSON.stringify(byAuthor))
    assert.equal(await frame().evaluate(() => document.querySelector('.thimble-table-th.active')!.textContent), 'Author')
    await frame().evaluate(() => (window as any).table.sortBy('t', true))
    // the current match is washed in the time it is in, where the time shows
    const washed = await frame().evaluate(() => {
      const w = window as any
      ;(document.getElementById('body') as HTMLElement).style.width = '520px'
      return new Promise<string>((done) =>
        setTimeout(() => {
          w.search.set('03-31 22:59')
          const cur = [...(CSS as any).highlights.get('thimble-search-current')][0] as Range
          done(cur.toString() + ' in ' + cur.startContainer.parentElement!.closest('.thimble-table-td')!.className)
        }, 150),
      )
    })
    assert.equal(washed, '03-31 22:59 in thimble-table-td thimble-table-time')
    await frame().evaluate(() => (window as any).search.set(''))
    // times that span two years keep the year
    await frame().evaluate(() => {
      const w = window as any
      w.table.draw(w.prs.concat([{ ref: 'forge.db#prs/1', number: 1, title: 'Initial commit', author: 'gh:founder', state: 'merged', t: Date.UTC(2025, 0, 2) / 1000 }]))
    })
    const years = await at(520)
    assert.equal(years.cells.Opened.text, '2026-04-01 00:00')
    assert.ok(inside(years), JSON.stringify(years))
    await p.close()
  })

  test('an inbox whose From has a width: Subject, which takes the width left, is the main column, keeps 120 px and drops last', async () => {
    const doc = page(`<div id="body" style="width:1000px"><div id="list"></div></div>
<script>
const T0 = Date.UTC(2026, 3, 1) / 1000
window.table = thimble.table({ mount: '#list', sort: { by: 't', desc: true },
  rows: Array.from({ length: 2000 }, (_, i) => ({ ref: 'mail.jsonl#L' + (i + 1), from: ['Ana Lopez <ana@harbor.org>', 'Bo Chen'][i % 2], subject: 'Re: Passage plan for the Thursday crossing ' + i, t: T0 + i * 60 })),
  columns: [{ name: 'from', title: 'From', width: 200 }, { name: 'subject', title: 'Subject' }, { name: 't', title: 'Date', type: 'time' }] })
</script>`)
    const { page: p, frame } = await framed(doc, 1048)
    const steps: [number, string[]][] = [
      [1000, ['From', 'Subject', 'Date']],
      [500, ['From', 'Subject', 'Date']],
      [380, ['From', 'Subject', 'Date']],
      // the rows are sorted by Date, which drops after From
      [260, ['Subject', 'Date']],
      [150, ['Subject']],
      [1000, ['From', 'Subject', 'Date']],
    ]
    for (const [width, titles] of steps) {
      await frame().evaluate((w) => ((document.getElementById('body') as HTMLElement).style.width = w + 'px'), width)
      await p.waitForTimeout(150)
      const got = await columnsOf(frame)
      assert.deepEqual(got.titles, titles, `${width}px: ${JSON.stringify(got)}`)
      assert.ok(inside(got), `${width}px: ${JSON.stringify(got)}`)
      assert.ok(got.cells.Subject.w >= Math.min(120, width), `${width}px: ${JSON.stringify(got)}`)
      // beside a From of 200 px, Subject is the wider: From gives up width with it, and the dates their year
      if (width === 500) assert.ok(got.cells.Subject.w > got.cells.From.w && /^\d\d-\d\d /.test(got.cells.Date.text), `${width}px: ${JSON.stringify(got)}`)
    }
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

// A transcript and a record that fold words away: a text turn of 20 lines whose lines wrap, a word at its line 15; a tool
// call folded to one line, a word only on line 9 of what came back; a record with a word three levels deep, under a
// folded value, and a word on line 12 of a long string
const WIDE = 'of the notes, long enough that the line wraps in the column of the transcript as it is drawn here, and once more in a narrower pane than this one'
const NOTES = Array.from({ length: 20 }, (_, i) => (i === 14 ? 'line 15: a kestrel hovers over the field' : `line ${i + 1} ${WIDE}`)).join('\n')
const OUTPUT = Array.from({ length: 12 }, (_, i) => (i === 8 ? 'birds.txt:9: osprey, near the dam' : `birds.txt:${i + 1}: gull`)).join('\n')
const calm = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ ref: `s.jsonl#L${from + i}`, speaker: 'lead', kind: 'text', text: `calm turn ${from + i}` }))
const TURNS = [
  ...calm(1, 8),
  { ref: 's.jsonl#L9', speaker: 'lead', kind: 'text', text: NOTES },
  ...calm(10, 8),
  { ref: 's.jsonl#L18', speaker: 'lead', kind: 'tool', tool: 'Bash', input: 'grep -n . birds.txt', output: OUTPUT },
  ...calm(19, 12),
]
const FOLDED_TRANSCRIPT = page(`<div class="top"><span id="search"></span><span id="colour"></span></div><div id="turns" style="height:420px;overflow-y:auto"></div>
<script>
window.colour = thimble.colorBy({ mount: '#colour', fields: [] })
window.search = thimble.search({ mount: '#search', in: '#turns' })
window.opened = []
window.tr = thimble.transcript({ mount: '#turns', onOpen: (t) => window.opened.push(t.ref) })
tr.draw(${JSON.stringify(TURNS)}, { title: 'lead · Run 1' })
</script>`)
const REC = {
  seen: 'a heron flew over',
  ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field_${i + 1}`, `value ${i + 1}`])),
  meta: { source: { tag: 'a heron by the weir' } },
  notes: Array.from({ length: 20 }, (_, i) => (i === 11 ? 'line 12: a plover on the shingle' : `line ${i + 1} of the field notes`)).join('\n'),
}
const FOLDED_RECORD = page(`<div class="top"><span id="search"></span><span id="colour"></span></div><div id="rec" style="width:420px;height:300px;overflow-y:auto;padding:0 8px"></div>
<script>
window.colour = thimble.colorBy({ mount: '#colour', fields: [] })
window.search = thimble.search({ mount: '#search', in: '#rec' })
thimble.record({ mount: '#rec', value: ${JSON.stringify(REC)}, ref: 'notes.jsonl#L3' })
</script>`)

/** the search's current match: its text, whether its box is inside the element `within` and inside the box that
 * scrolls, as drawn */
const currentIn = (frame: () => Frame, within: string, box: string) =>
  frame().evaluate(
    ([within, box]) => {
      const cur = [...((CSS as any).highlights.get('thimble-search-current') ?? [])][0] as Range | undefined
      if (!cur) return null
      const r = cur.getBoundingClientRect()
      const inside = (sel: string) => {
        const c = document.querySelector(sel)!.getBoundingClientRect()
        return r.height > 0 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5
      }
      return { text: cur.toString(), within: inside(within), shown: inside(box) }
    },
    [within, box],
  )
/** where an element, or the search's current match, stands in the box that scrolls, as fractions of its height */
const placeIn = (frame: () => Frame, box: string, sel: string | null) =>
  frame().evaluate(
    ({ box, sel }) => {
      const b = document.querySelector(box)!
      const r = sel ? document.querySelector(sel)!.getBoundingClientRect() : ([...(CSS as any).highlights.get('thimble-search-current')][0] as Range).getBoundingClientRect()
      const top0 = b.getBoundingClientRect().top + b.clientTop - b.scrollTop
      return [(r.top - top0) / b.scrollHeight, (r.bottom - top0) / b.scrollHeight]
    },
    { box, sel },
  )
/** the ticks drawn in the search's lane of the strip, each [top, bottom] as fractions of its height */
const ticksDrawn = (frame: () => Frame) =>
  frame().evaluate(() => {
    const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
    const dpr = window.devicePixelRatio || 1
    const data = cv.getContext('2d')!.getImageData(Math.round(6 * dpr), 0, 1, cv.height).data
    const out: number[][] = []
    let start = -1
    for (let y = 0; y <= cv.height; y++) {
      const on = y < cv.height && data[y * 4 + 3] > 200
      if (on && start < 0) start = y
      if (!on && start >= 0) {
        out.push([start / cv.height, y / cv.height])
        start = -1
      }
    }
    return out
  })
/** `n` ticks drawn, one at the place given, within a few pixels of the strip */
const tickAt = (ticks: number[][], place: number[], what: string, n = 1) => {
  assert.equal(ticks.length, n, `${what}: ${n} ticks, ${JSON.stringify(ticks)}`)
  const slack = 0.012
  assert.ok(ticks.some((t) => t[1] >= place[0] - slack && t[0] <= place[1] + slack), `${what}: a tick at its place ${JSON.stringify(place)}, ${JSON.stringify(ticks)}`)
}

// A transcript in a narrow pane, every turn open: a word on line 3 of a long block whose first lines wrap, so it lies past
// the block's sixth line as drawn, and once in a short turn above it; a tool's output of long paths, which break at their
// hyphens rather than fill their lines
const CUT = Array.from({ length: 9 }, (_, i) => (i === 2 ? `line 3: a dunlin on the mud ${WIDE}` : `line ${i + 1} ${WIDE}`)).join('\n')
const PATHS = Array.from({ length: 9 }, (_, i) => JSON.stringify({ i, path: '/usr/lib/python3/site-packages/pandas/core/frame.py', msg: 'x'.repeat(60 + i * 30) })).join('\n')
const CUT_TRANSCRIPT = page(`<div class="top"><span id="search"></span><span id="colour"></span></div><div id="turns" style="width:380px;height:420px;overflow-y:auto"></div>
<script>
window.colour = thimble.colorBy({ mount: '#colour', fields: [] })
window.search = thimble.search({ mount: '#search', in: '#turns' })
window.tr = thimble.transcript({ mount: '#turns', fold: () => false })
tr.draw(${JSON.stringify([
  { ref: 'c.jsonl#L1', speaker: 'lead', kind: 'text', text: 'a dunlin flies past' },
  ...calm(2, 4),
  { ref: 'c.jsonl#L6', speaker: 'lead', kind: 'text', text: CUT },
  { ref: 'c.jsonl#L7', speaker: 'lead', kind: 'tool', tool: 'Bash', input: 'cat log.jsonl', output: PATHS },
  ...calm(8, 12),
])}, { title: 'lead · Run 2' })
</script>`)

describe('the search in folded text', () => {
  test("a transcript: a word on a long block's line 15 and one in a folded tool call's output, counted, ticked and shown; Show less folds it again; Reset leaves it open", async () => {
    const { page: p, frame } = await framed(FOLDED_TRANSCRIPT)
    const NOTES_TURN = '[data-anchor="s.jsonl#L9"]'
    const TOOL_TURN = '[data-anchor="s.jsonl#L18"]'
    // folded, the long block shows six lines as drawn, its lines wrapping
    const lines = await frame().evaluate((sel) => {
      const b = document.querySelector(sel + ' .thimble-turn-block') as HTMLElement
      return b.getBoundingClientRect().height / parseFloat(getComputedStyle(b).lineHeight)
    }, NOTES_TURN)
    assert.ok(lines > 5.5 && lines < 6.5, `six lines show: ${lines}`)
    // a word on line 15 of the long block: counted once, gone to, in view inside its turn, ticked where it stands
    await typeIn(frame, 'kestrel')
    assert.deepEqual(await frame().evaluate(() => [(window as any).search.count, document.querySelector('.thimble-search-count')!.textContent]), [1, '1 of 1'])
    await frame().locator('.thimble-search-input').press('Enter')
    await p.waitForTimeout(200)
    assert.deepEqual(await currentIn(frame, NOTES_TURN, '#turns'), { text: 'kestrel', within: true, shown: true })
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#turns', null), 'kestrel')
    // Show less folds the block again: still counted, ticked where the block stands, not drawn
    await frame().locator(`${NOTES_TURN} .thimble-turn-more`).click()
    await p.waitForTimeout(200)
    const folded = await frame().evaluate((sel) => ({
      hidden: (document.querySelector(sel + ' [data-thimble-fold]') as HTMLElement).hidden,
      count: (window as any).search.count,
      current: (CSS as any).highlights.has('thimble-search-current'),
    }), NOTES_TURN)
    assert.deepEqual(folded, { hidden: true, count: 1, current: false })
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#turns', `${NOTES_TURN} .thimble-turn-block`), 'kestrel folded')
    // a word only on line 9 of a folded tool call's output: counted; going to it opens the turn, as a click does, and
    // its output's lines past the sixth
    await typeIn(frame, 'osprey')
    assert.equal(await frame().evaluate(() => (window as any).search.count), 1)
    await frame().locator('.thimble-search-input').press('Enter')
    await p.waitForTimeout(200)
    assert.deepEqual(await currentIn(frame, `${TOOL_TURN} .thimble-turn-result`, '#turns'), { text: 'osprey', within: true, shown: true })
    assert.deepEqual(await frame().evaluate(() => (window as any).opened), ['s.jsonl#L18'])
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#turns', null), 'osprey')
    // Reset empties the search and leaves the turn open as the search opened it
    await frame().locator('.thimble-reset').click()
    await p.waitForTimeout(200)
    const after = await frame().evaluate((sel) => ({
      text: (document.querySelector('.thimble-search-input') as HTMLInputElement).value,
      count: (window as any).search.count,
      open: !!document.querySelector(sel + ' .thimble-turn-result'),
      whole: !(document.querySelector(sel + ' .thimble-turn-result [data-thimble-fold]') as HTMLElement).hidden,
    }), TOOL_TURN)
    assert.deepEqual(after, { text: '', count: 0, open: true, whole: true })
    await p.close()
  })

  test("a record: a word under a folded value three levels deep and one on a long string's line 12, counted, ticked and shown; Show less folds it again; Reset leaves it open", async () => {
    const { page: p, frame } = await framed(FOLDED_RECORD)
    // the word three levels deep, under a folded value, and once at the top: typing goes to the one at the top, and the
    // folded one is counted and ticked where its fold stands
    const SOURCE = '[data-fold="/meta/source"]'
    assert.equal(await frame().evaluate((s) => document.querySelector(s)!.getAttribute('aria-expanded'), SOURCE), 'false')
    await typeIn(frame, 'heron')
    assert.deepEqual(await frame().evaluate(() => [(window as any).search.count, (window as any).search.at]), [2, 0])
    await p.waitForTimeout(150)
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#rec', `${SOURCE} + .thimble-record-sum`), 'heron folded', 2)
    // Enter goes to it: its value opens, and the match shows in the record
    await frame().locator('.thimble-search-input').press('Enter')
    await p.waitForTimeout(200)
    assert.deepEqual(await currentIn(frame, '#rec .thimble-record', '#rec'), { text: 'heron', within: true, shown: true })
    assert.deepEqual(await frame().evaluate((s) => [(window as any).search.at, document.querySelector(s)!.getAttribute('aria-expanded')], SOURCE), [1, 'true'])
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#rec', null), 'heron', 2)
    // a word on line 12 of a long string
    await typeIn(frame, 'plover')
    assert.deepEqual(await frame().evaluate(() => [(window as any).search.count, document.querySelector('.thimble-search-count')!.textContent]), [1, '1 of 1'])
    await frame().locator('.thimble-search-input').press('Enter')
    await p.waitForTimeout(200)
    assert.deepEqual(await currentIn(frame, '#rec .thimble-record', '#rec'), { text: 'plover', within: true, shown: true })
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#rec', null), 'plover')
    // Show less folds the string again: still counted, ticked where the string stands, not drawn
    await frame().locator('[data-long="/notes"]').click()
    await p.waitForTimeout(200)
    const folded = await frame().evaluate(() => ({
      hidden: (document.querySelector('[data-fold-long="/notes"]') as HTMLElement).hidden,
      count: (window as any).search.count,
      current: (CSS as any).highlights.has('thimble-search-current'),
    }))
    assert.deepEqual(folded, { hidden: true, count: 1, current: false })
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#rec', '.thimble-record-text'), 'plover folded')
    // Reset empties the search and leaves open the value the search opened
    await frame().locator('.thimble-reset').click()
    await p.waitForTimeout(200)
    const after = await frame().evaluate(() => ({
      text: (document.querySelector('.thimble-search-input') as HTMLInputElement).value,
      count: (window as any).search.count,
      open: document.querySelector('[data-fold="/meta/source"]')!.getAttribute('aria-expanded'),
    }))
    assert.deepEqual(after, { text: '', count: 0, open: 'true' })
    await p.close()
  })

  test("a word past a long block's sixth line as drawn, though on its third: counted, ticked on its block, and shown once gone to; a block of long paths shows six lines", async () => {
    const { page: p, frame } = await framed(CUT_TRANSCRIPT)
    const CUT_TURN = '[data-anchor="c.jsonl#L6"]'
    // each folded block shows six lines as drawn, whatever its lines wrap to: the words past them are cut by its height
    const shown = await frame().evaluate(() =>
      [...document.querySelectorAll('.thimble-turn-fold.is-folded > .thimble-turn-block')].map((b) => {
        const cs = getComputedStyle(b)
        return (b.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight)
      }),
    )
    assert.equal(shown.length, 2)
    for (const n of shown) assert.ok(n > 5.5 && n < 7, `six lines show: ${shown}`)
    // the word in the short turn is gone to; the one cut from view is counted and ticked on its block
    await typeIn(frame, 'dunlin')
    assert.deepEqual(await frame().evaluate(() => [(window as any).search.count, (window as any).search.at]), [2, 0])
    await p.waitForTimeout(150)
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#turns', `${CUT_TURN} .thimble-turn-block`), 'dunlin cut', 2)
    // Enter goes to it: its block shows whole, and the match shows inside its turn and the box that scrolls
    await frame().locator('.thimble-search-input').press('Enter')
    await p.waitForTimeout(200)
    assert.deepEqual(await currentIn(frame, `${CUT_TURN} .thimble-turn-block`, '#turns'), { text: 'dunlin', within: true, shown: true })
    assert.equal(await frame().evaluate((sel) => document.querySelector(sel + ' .thimble-turn-more')!.textContent, CUT_TURN), 'Show less')
    tickAt(await ticksDrawn(frame), await placeIn(frame, '#turns', null), 'dunlin', 2)
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
          modes: [w.wide.mode, w.narrow.mode, w.padded.mode],
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
      // a mount whose padding leaves its lines too little width, as the side panel's body, is inline
      assert.deepEqual(got.modes, ['split', 'inline', 'inline'])
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

  test("a patch: its file's head and each hunk's line across both sides, its lines numbered from the hunk's line", async () => {
    const { page: p, frame } = await framed(PATCHED)
    const got = await frame().evaluate(() => {
      const w = window as any
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
      const diff = box('#wide .thimble-diff')
      const hunks = [...document.querySelectorAll('#wide .thimble-diff-hunk')].map((h) => h.getBoundingClientRect())
      const first = document.querySelector('#wide .thimble-diff-row')!
      return {
        modes: [w.wide.mode, w.narrow.mode],
        head: [box('#wide .thimble-diff-file').width, diff.width],
        hunks: hunks.map((h) => Math.round(h.width) === Math.round(diff.width)),
        numbers: [...first.querySelectorAll('.thimble-diff-no')].map((n) => getComputedStyle(n, '::before').content),
        tint: getComputedStyle(document.querySelector('#wide .thimble-diff-hunk')!).backgroundColor,
      }
    })
    assert.deepEqual(got.modes, ['split', 'inline'])
    assert.equal(Math.round(got.head[0]), Math.round(got.head[1]))
    assert.deepEqual(got.hunks, [true, true])
    assert.deepEqual(got.numbers, ['"112"', '"112"'])
    assert.notEqual(got.tint, 'rgba(0, 0, 0, 0)')
    await p.close()
  })
})
