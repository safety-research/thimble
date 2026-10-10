// The view kit's search, table and diff (backend/app/viewer_search.js, viewer_table.js, viewer_diff.js) in a real
// browser, each page holding the view in a sandboxed frame as ViewerFrame does, in the theme's own tokens: a table of
// 20,000 rows draws only those near its view and keeps them as it scrolls, opens and sorts within a bound far above what
// it takes, and its strip shows Color by's colours of every row; the search washes every match on screen and the current
// one more strongly, puts a lane of ticks on the list's strip (with no Color by, on a strip of its own), and a click on a
// tick goes to that match; a table beside the side panel keeps its first column of text, drops columns in their order
// rather than draw a cell under the strip, and draws them again when the panel closes; the diff sets the two versions
// side by side, a changed line level with the line it became, inline in a narrow mount, and its tints follow the paper.
// What the parts decide without layout is tests/public/data-kit.test.ts.
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
<div id="padded" style="box-sizing:border-box;width:800px;padding:0 40px"></div>
<script>
window.wide = thimble.diff({ mount: '#wide', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)} })
window.narrow = thimble.diff({ mount: '#narrow', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)} })
window.padded = thimble.diff({ mount: '#padded', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)} })
</script>`, dark)

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
})
