// The view kit's search, table and diff (backend/app/viewer_search.js, viewer_table.js, viewer_diff.js), in a jsdom
// window of their own with the rest of the kit as views.frame_document loads it. Each works alone on plain records, with
// no Color by, time range or side panel: the search finds text case ignored across a record's inline elements and never
// in the kit's own controls, steps through the matches and wraps, finds in the rows a list gives it and in a fold it
// opens, puts its ticks on the list's strip, and Reset empties it; the table draws only the rows near its view, sorts by a
// click on a column's head with the rows with no value last, hides what Filter by does not keep, gives Color by its bars
// and the counts of every row, opens a row in the side panel and keeps its sort; the diff aligns the lines, marks the
// words that changed, folds the unchanged stretches with Show more and Show less, and draws side by side or inline.
// Layout (the highlights, the strip's ticks drawn, the table's rows as it scrolls, the diff's columns) is
// tests/public/browser/view-data.test.ts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const APP = path.resolve(__dirname, '../../../backend/app')
const read = (n: string) => readFileSync(path.join(APP, n), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
// the kit as views.frame_document loads it
const KIT =
  script(read('viewer_bridge.js')) +
  script(`window.__thimbleLabelOrder = ${read('label_order.json')}`) +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_search.js', 'viewer_table.js', 'viewer_diff.js', 'viewer_range.js'].map((n) => script(read(n))).join('')

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any; [k: string]: any }
const doc = () => dom.window.document
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)
const texts = (sel: string) => [...doc().querySelectorAll(sel)].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())

async function load(body: string, kept?: object) {
  const page = `<!doctype html><html><head>${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}${KIT}</head><body>${body}</body></html>`
  dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  sent = []
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  await wait()
}
afterEach(() => dom?.window.close())

/** types into the search's box as the analyst does, and waits for the search to run */
async function type(text: string, sel = '.thimble-search-input') {
  const input = doc().querySelector(sel) as HTMLInputElement
  input.value = text
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await wait(200)
}
function key(el: Element, k: string, opts: object = {}) {
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }))
}

const CHAT = [
  { ref: 'chat.jsonl#L1', who: 'ana', text: 'The <i>gale</i> may delay the ferry' },
  { ref: 'chat.jsonl#L2', who: 'bo', text: 'ok' },
  { ref: 'chat.jsonl#L3', who: 'cy', text: 'GALE warning: gale force 8' },
  { ref: 'chat.jsonl#L4', who: 'gale', text: 'lunch?' },
]
const chatHtml = () =>
  CHAT.map((m) => `<div class="msg" data-anchor="${m.ref}"><b data-thimble-chrome>${m.who}</b> <span>${m.text}</span><button class="btn btn-ghost">gale</button></div>`).join('')

describe('the search', () => {
  test('alone on a list: finds the text case ignored, across inline elements, never in a head, an action button or a control; steps and wraps', async () => {
    await load(`<div class="top"><span id="search"></span></div><div id="list" style="overflow-y:auto">${chatHtml()}</div>`)
    const w = win()
    w.changes = []
    w.eval(`window.search = thimble.search({ mount: '#search', in: '#list', placeholder: 'Search the chat', onChange: (s) => window.changes.push(s.text) })`)
    const input = doc().querySelector('.thimble-search-input') as HTMLInputElement
    expect(input.placeholder).toBe('Search the chat')
    // nothing typed: no count, no steps
    expect(texts('.thimble-search-count')).toEqual([''])
    expect([...doc().querySelectorAll('.thimble-search-step')].every((b) => (b as HTMLButtonElement).hidden)).toBe(true)
    await type('gale')
    // "The gale" (its word in <i>), then "GALE" and "gale" in one message; not the speaker "gale" (the page's head) nor
    // the action button's text
    expect(w.search.count).toBe(3)
    expect(w.search.at).toBe(0)
    expect(texts('.thimble-search-count')).toEqual(['1 of 3'])
    expect(w.changes).toEqual(['gale'])
    // a phrase across an inline element is one match
    await type('the gale may')
    expect(w.search.count).toBe(1)
    await type('gale')
    key(input, 'Enter')
    expect(w.search.at).toBe(1)
    key(input, 'Enter')
    key(input, 'Enter')
    expect(w.search.at).toBe(0) // wrapped
    key(input, 'Enter', { shiftKey: true })
    expect(w.search.at).toBe(2)
    expect(texts('.thimble-search-count')).toEqual(['3 of 3'])
    ;(doc().querySelector('.thimble-search-step[data-step="-1"]') as HTMLElement).click()
    expect(w.search.at).toBe(1)
    // has() for a page that filters by it; nothing searched keeps everything
    expect(w.search.has('A Gale!')).toBe(true)
    expect(w.search.has('calm')).toBe(false)
    await type('zzz')
    expect(texts('.thimble-search-count')).toEqual(['No results'])
    // Escape empties the box, and the page hears it
    key(input, 'Escape')
    expect(input.value).toBe('')
    expect(w.search.count).toBe(0)
    expect(w.changes.at(-1)).toBe('')
    expect(w.search.has('calm')).toBe(true)
  })

  test("the page drawn again: its matches found again, the current one kept by its record; the list's strip gets the ticks", async () => {
    await load(`<div class="top"><span id="search"></span></div><div id="list" style="overflow-y:auto">${chatHtml()}</div>`)
    const w = win()
    w.eval(`window.search = thimble.search({ mount: '#search', in: '#list' })`)
    // the list has the kit's strip from the start, a plain scrollbar with no Color by
    const strip = () => doc().querySelector('.thimble-colour-strip') as HTMLElement
    expect(strip()).not.toBe(null)
    expect(strip().hasAttribute('data-plain')).toBe(true)
    await type('gale')
    w.search.go(2)
    expect(w.search.at).toBe(2)
    // the search's lane on the strip: no longer a plain scrollbar
    await wait(40)
    expect(strip().hasAttribute('data-plain')).toBe(false)
    // a new message above: the matches found again, the current one still the third message's second
    const list = doc().getElementById('list')!
    list.insertAdjacentHTML('afterbegin', '<div class="msg" data-anchor="chat.jsonl#L0"><span>a gale at dawn</span></div>')
    await wait(60)
    expect(w.search.count).toBe(4)
    expect(w.search.at).toBe(3)
    // the box emptied: the lane goes and the strip is plain again
    await type('')
    await wait(40)
    expect(strip().hasAttribute('data-plain')).toBe(true)
  })

  test('the rows of a list that draws only those in view: counted in every row, a step brings its row into view', async () => {
    await load(`<div class="top"><span id="search"></span></div><div id="rows" style="overflow-y:auto"></div>`)
    const w = win()
    w.went = []
    w.eval(`window.search = thimble.search({ mount: '#search' })`)
    const rowTexts = Array.from({ length: 1000 }, (_, i) => (i % 100 === 7 ? 'Gale on row ' + i + '\nand a gale' : 'row ' + i))
    w.search.rows({ texts: rowTexts, refs: rowTexts.map((_: string, i: number) => 'r#L' + (i + 1)), go: (i: number) => w.went.push(i), box: '#rows' })
    await type('gale')
    expect(w.search.count).toBe(20)
    w.search.step(1)
    w.search.step(1)
    expect(w.went.at(-1)).toBe(107)
    // each part of a row ('\n' between them) is searched alone: no match across two cells
    await type('7\nand')
    expect(w.search.count).toBe(0)
    // past MOST matches the count says so; a search of this many rows waits a little longer for typing to pause
    w.search.rows({ texts: Array.from({ length: 25000 }, () => 'a'), go: () => {}, box: '#rows' })
    await type('a')
    await wait(200)
    expect(w.search.count).toBe(20000)
    expect(texts('.thimble-search-count')).toEqual(['1 of 20,000+'])
  })

  test('a match in a fold: counted, and going to it sends the fold `thimble-unfold`, which the part opens', async () => {
    await load(`<div class="top"><span id="search"></span></div><div id="list"><p>a gale</p><div data-thimble-fold hidden><p>more gale here</p></div></div>`)
    const w = win()
    w.eval(`
      window.search = thimble.search({ mount: '#search', in: '#list' })
      document.querySelector('[data-thimble-fold]').addEventListener('thimble-unfold', (e) => { e.target.hidden = false; window.opened = true })
    `)
    await type('gale')
    expect(w.search.count).toBe(2)
    expect(w.opened).toBeUndefined()
    w.search.step(1)
    expect(w.opened).toBe(true)
    expect(w.search.at).toBe(1)
    // a hidden element that is no fold is not searched
    doc().getElementById('list')!.insertAdjacentHTML('beforeend', '<p hidden>gale</p>')
    await wait(60)
    expect(w.search.count).toBe(2)
  })

  test("Reset, in Color by's row, empties the box and tells the page once", async () => {
    await load(`<div class="top"><span id="search"></span><span id="colour"></span></div><div id="list">${chatHtml()}</div>`)
    const w = win()
    w.changes = []
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'who', title: 'Who' }] })
      window.search = thimble.search({ mount: '#search', in: '#list', onChange: (s) => window.changes.push(s.text) })
    `)
    await type('gale')
    await wait(60)
    const reset = doc().querySelector('.thimble-reset') as HTMLButtonElement
    expect(reset.hidden).toBe(false)
    reset.click()
    await wait()
    expect((doc().querySelector('.thimble-search-input') as HTMLInputElement).value).toBe('')
    expect(w.search.count).toBe(0)
    expect(w.changes).toEqual(['gale', ''])
  })
})

const T0 = Date.UTC(2026, 3, 1, 9) / 1000
const MAIL = Array.from({ length: 5000 }, (_, i) => ({
  ref: 'mail.jsonl#L' + (i + 1),
  from: ['ana', 'bo', 'cy'][i % 3],
  subject: i === 4998 ? 'Gale warning' : 'Note ' + i,
  size: i === 10 ? null : (i * 7919) % 1000,
  t: T0 + i * 60,
  folder: ['Inbox', 'Ops'][i % 2],
}))
const COLUMNS = [
  { name: 'from', title: 'From', width: 120 },
  { name: 'subject', title: 'Subject' },
  { name: 'size', title: 'Size', type: 'number' },
  { name: 't', title: 'Date', type: 'time' },
]

describe('the table', () => {
  test('alone: draws only the rows near its view, each a record with its anchor; a click on a head sorts, again the other way, no value last', async () => {
    await load(`<div id="list" style="height:400px"></div>`)
    const w = win()
    w.MAIL = MAIL
    w.eval(`window.table = thimble.table({ mount: '#list', rows: window.MAIL, columns: ${JSON.stringify(COLUMNS)} })`)
    const rows = () => [...doc().querySelectorAll('.thimble-table-row')] as HTMLElement[]
    expect(texts('.thimble-table-th')).toEqual(['From', 'Subject', 'Size', 'Date'])
    expect(rows().length).toBeGreaterThan(10)
    expect(rows().length).toBeLessThan(100)
    const first = rows()[0]
    expect(first.getAttribute('data-anchor')).toBe('mail.jsonl#L1')
    expect(first.getAttribute('data-thimble-row')).toBe('0')
    expect(first.hasAttribute('data-colour')).toBe(false)
    expect([...first.children].map((c) => c.textContent)).toEqual(['ana', 'Note 0', '0', '2026-04-01 09:00'])
    expect((doc().querySelector('.thimble-table-body') as HTMLElement).style.height).toBe(5000 * 28 + 'px')
    // the view's checks count every row it holds as shown, since it anchors each one it draws
    expect(w.thimble.__held()).toBe(5000)
    // a table made again on the same mount takes its place; the one before draws nothing more there
    const before = w.table
    w.eval(`window.table = thimble.table({ mount: '#list', rows: window.MAIL.slice(0, 3), columns: ${JSON.stringify(COLUMNS)} })`)
    before.draw(w.MAIL)
    expect(doc().querySelectorAll('.thimble-table-row')).toHaveLength(3)
    w.table.draw(w.MAIL)
    // numbers sort as numbers, the largest first; the row with no size last
    ;(doc().querySelector('[data-col="size"]') as HTMLElement).click()
    expect(w.table.sort).toEqual({ by: 'size', desc: true })
    expect(doc().querySelector('[data-col="size"]')!.getAttribute('aria-sort')).toBe('descending')
    const sizes = w.table.rows.map((r: any) => r.size)
    expect(sizes[0]).toBe(999)
    expect(sizes.at(-1)).toBe(null)
    ;(doc().querySelector('[data-col="size"]') as HTMLElement).click()
    expect(w.table.sort).toEqual({ by: 'size', desc: false })
    expect(w.table.rows[0].size).toBe(0)
    expect(w.table.rows.at(-1).size).toBe(null)
    // text from A, ties in the rows' own order
    ;(doc().querySelector('[data-col="from"]') as HTMLElement).click()
    expect(w.table.sort).toEqual({ by: 'from', desc: false })
    expect(w.table.rows.slice(0, 3).map((r: any) => r.ref)).toEqual(['mail.jsonl#L1', 'mail.jsonl#L4', 'mail.jsonl#L7'])
    // the sort is kept per view
    expect((of('colour').at(-1)!.state as any).parts['table:list']).toEqual({ sort: { by: 'from', desc: false } })
  })

  test("with Color by, Filter by, the side panel and the search: bars, every row counted, rows hidden, a row opened, matches in rows out of view", async () => {
    await load(`<div class="top"><span id="search"></span><span id="filter"></span><span id="colour"></span></div><div id="body" style="height:400px"><div id="list"></div></div>`)
    const w = win()
    w.MAIL = MAIL
    w.opened = []
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'folder', title: 'Folder' }] })
      window.filter = thimble.filterBy({ mount: '#filter', fields: [{ name: 'from', title: 'From' }], onChange: () => window.table.draw() })
      window.side = thimble.side({ mount: '#body' })
      window.search = thimble.search({ mount: '#search' })
      window.table = thimble.table({
        mount: '#list', rows: window.MAIL, columns: ${JSON.stringify(COLUMNS)}, side, filter, search,
        details: (m) => ({ title: m.subject, sub: m.from, html: '<p class="mail">' + m.ref + '</p>' }),
        onOpen: (m) => window.opened.push(m.ref),
      })
    `)
    await wait(120)
    const row = (i: number) => doc().querySelector(`.thimble-table-row[data-thimble-row="${i}"]`) as HTMLElement
    expect(row(0).getAttribute('data-colour')).toBe('Inbox')
    expect(row(1).getAttribute('data-colour')).toBe('Ops')
    // the chips count every row, not only those drawn
    expect(texts('.thimble-colour-chip')).toEqual(['Inbox2,500', 'Ops2,500'])
    // Filter by hides the rows it does not keep
    w.filter.choose('from')
    w.filter.toggle('bo')
    await wait()
    expect(w.table.rows.length).toBe(3333)
    expect(w.table.rows.some((r: any) => r.from === 'bo')).toBe(false)
    expect(w.thimble.__held()).toBe(3333)
    // a click opens a row in the side panel with its details; the page hears it
    row(1).click()
    expect(w.side.isOpen).toBe(true)
    expect(w.side.ref).toBe('mail.jsonl#L3')
    expect(doc().querySelector('.thimble-side-title')!.textContent).toBe('Note 2')
    expect(doc().querySelector('.thimble-side-body .mail')!.textContent).toBe('mail.jsonl#L3')
    expect(w.opened).toEqual(['mail.jsonl#L3'])
    expect(row(1).classList.contains('active')).toBe(true)
    // ↓ moves the chosen row, and the open side panel follows it; Enter opens it
    const mount = doc().getElementById('list')!
    key(mount, 'ArrowDown')
    expect(w.table.selected).toBe('mail.jsonl#L4')
    expect(w.side.ref).toBe('mail.jsonl#L4')
    expect(w.opened).toEqual(['mail.jsonl#L3', 'mail.jsonl#L4'])
    key(mount, 'Enter')
    expect(w.side.ref).toBe('mail.jsonl#L4')
    // the search finds in every row, drawn or not, and a step brings the row in
    await type('gale warning')
    expect(w.search.count).toBe(1)
    expect(w.search.at).toBe(0)
    // a citation reveals its row
    expect(w.table.reveal('mail.jsonl#L7')).toBe(true)
    expect(w.table.selected).toBe('mail.jsonl#L7')
    expect(w.table.reveal('mail.jsonl#L2')).toBe(false) // hidden by Filter by
  })

  test('plain records with no ref: a click chooses the row and ↓ moves on from it; no anchor', async () => {
    await load(`<div id="list" style="height:300px"></div>`)
    const w = win()
    w.eval(`window.table = thimble.table({ mount: '#list', rows: [{ n: 3, w: 'c' }, { n: 1, w: 'a' }, { n: 2, w: 'b' }], columns: ['w', { name: 'n', type: 'number' }], sort: 'n' })`)
    expect(texts('.thimble-table-th')).toEqual(['w', 'n'])
    expect(texts('.thimble-table-row')).toEqual(['a1', 'b2', 'c3'])
    const rows = () => [...doc().querySelectorAll('.thimble-table-row')] as HTMLElement[]
    expect(rows()[0].hasAttribute('data-anchor')).toBe(false)
    rows()[1].click()
    expect(rows().map((r) => r.classList.contains('active'))).toEqual([false, true, false])
    key(doc().getElementById('list')!, 'ArrowDown')
    expect(rows().map((r) => r.classList.contains('active'))).toEqual([false, false, true])
    expect(w.table.selected).toBe(null)
  })

  test('the sort it opens with, the one kept, and Reset putting back the first', async () => {
    const kept = { parts: { 'table:list': { sort: { by: 'subject', desc: true } } } }
    await load(`<div class="top"><span id="colour"></span></div><div id="list" style="height:300px"></div>`, kept)
    const w = win()
    w.MAIL = MAIL.slice(0, 50)
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'folder', title: 'Folder' }] })
      window.table = thimble.table({ mount: '#list', rows: window.MAIL, columns: ${JSON.stringify(COLUMNS)}, sort: { by: 't', desc: true } })
    `)
    expect(w.table.sort).toEqual({ by: 'subject', desc: true })
    await wait(80)
    ;(doc().querySelector('.thimble-table-row[data-thimble-row="2"]') as HTMLElement).click()
    expect(w.table.selected).not.toBe(null)
    const reset = doc().querySelector('.thimble-reset') as HTMLButtonElement
    expect(reset.hidden).toBe(false)
    reset.click()
    await wait()
    expect(w.table.sort).toEqual({ by: 't', desc: true })
    expect(w.table.rows[0].ref).toBe('mail.jsonl#L50')
    // and no row is left chosen
    expect(w.table.selected).toBe(null)
    expect(doc().querySelector('.thimble-table-row.active')).toBe(null)
  })

  test('times in milliseconds read as times; the checks count a list given refs only once its rows carry them', async () => {
    await load(`<span id="colour"></span><div id="list" style="height:300px"></div><div id="other" style="height:300px;overflow:auto"><p>no anchor</p></div>`)
    const w = win()
    const t = Date.UTC(2026, 3, 1, 9, 30) / 1000
    w.eval(`window.table = thimble.table({ mount: '#list', rows: [{ ref: 'a#L1', t: ${t} }, { ref: 'a#L2', t: ${t * 1000} }], columns: [{ name: 't', type: 'time' }] })`)
    expect(texts('.thimble-table-row')).toEqual(['2026-04-01 09:30', '2026-04-01 09:30'])
    expect(w.thimble.__held()).toBe(2)
    // a strip given rows and refs on a list that anchors none of them is not counted
    w.eval(`thimble.colorBy({ mount: '#colour' }).strip('#other', { rows: ['x', 'y', 'z'], refs: ['b#L1', 'b#L2', 'b#L3'] })`)
    expect(w.thimble.__held()).toBe(2)
    // and is once it draws them anchored
    doc().getElementById('other')!.innerHTML = '<p data-anchor="b#L2">y</p>'
    expect(w.thimble.__held()).toBe(5)
  })
})

const BEFORE = ['# Memory', '', '- Ana runs the timetable.', '- Bo handles billing.', ...Array.from({ length: 20 }, (_, i) => `- note ${i + 1}`), '- Cy is the harbor master.', '- Old line to drop.'].join('\n')
const AFTER = ['# Memory', '', '- Ana runs the timetable and the roster.', '- Bo handles billing.', ...Array.from({ length: 20 }, (_, i) => `- note ${i + 1}`), '- Dee is the harbor master.', '- A brand new line.', '- Another.'].join('\n')

describe('the diff', () => {
  test('side by side: lines aligned, changed words marked, a removed line beside the added one set against it, the unchanged stretch folded', async () => {
    await load(`<div id="d"></div>`)
    const w = win()
    w.eval(`window.diff = thimble.diff({ mount: '#d', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)}, mode: 'split', titles: ['Rev 4', 'Rev 5'], ref: 'mem.jsonl#L5' })`)
    const root = doc().querySelector('.thimble-diff') as HTMLElement
    expect(root.classList.contains('thimble-diff-split')).toBe(true)
    expect(root.getAttribute('data-anchor')).toBe('mem.jsonl#L5')
    expect(texts('.thimble-diff-head > span')).toEqual(['Rev 4', 'Rev 5'])
    expect(w.diff.mode).toBe('split')
    // three lines changed, one removed and two added (the pair that is not alike counts in both)
    expect(w.diff.removed).toBe(3)
    expect(w.diff.added).toBe(4)
    expect(w.diff.changes).toBe(2)
    // the changed line: its words marked on each side
    expect(texts('del.thimble-diff-w')).toEqual(['Cy'])
    expect(texts('ins.thimble-diff-w')).toEqual(['and the roster', 'Dee'])
    const changed = [...doc().querySelectorAll('.thimble-diff-row')].find((r) => r.querySelector('ins.thimble-diff-w'))!
    expect([...changed.querySelectorAll('.thimble-diff-no')].map((n) => n.getAttribute('data-n'))).toEqual(['3', '3'])
    // a removed line and an added one not alike: whole lines, side by side; the last added line beside an empty side
    const last = [...doc().querySelectorAll('.thimble-diff-row')].slice(-2)
    expect(last.map((r) => [...r.querySelectorAll('.thimble-diff-tx')].map((t) => t.className.replace('thimble-diff-tx ', '') + ':' + t.textContent))).toEqual([
      ['thimble-diff-del:- Old line to drop.', 'thimble-diff-ins:- A brand new line.'],
      ['thimble-diff-none:', 'thimble-diff-ins:- Another.'],
    ])
    // the line numbers and signs are the style's alone: no text of theirs
    expect(changed.querySelector('.thimble-diff-no')!.textContent).toBe('')
    // notes 3 to 17 are folded, in the page but hidden; Show more opens them and Show less folds them again
    expect(texts('.thimble-diff-gap .thimble-diff-n')).toEqual(['15 unchanged lines'])
    expect(texts('.thimble-diff-more')).toEqual(['Show more'])
    const fold = doc().querySelector('[data-thimble-fold]') as HTMLElement
    expect(fold.hidden).toBe(true)
    expect(fold.querySelectorAll('.thimble-diff-row')).toHaveLength(15)
    ;(doc().querySelector('.thimble-diff-more') as HTMLElement).click()
    expect(fold.hidden).toBe(false)
    expect(texts('.thimble-diff-more')).toEqual(['Show less'])
    ;(doc().querySelector('.thimble-diff-more') as HTMLElement).click()
    expect(fold.hidden).toBe(true)
    // the search opens it
    fold.dispatchEvent(new dom.window.CustomEvent('thimble-unfold', { bubbles: true }))
    expect(fold.hidden).toBe(false)
    w.diff.expand(false)
    expect(fold.hidden).toBe(true)
  })

  test('inline: the old line over the new one; the context it keeps; a page created and both empty', async () => {
    await load(`<div id="d"></div>`)
    const w = win()
    w.eval(`window.diff = thimble.diff({ mount: '#d', before: ${JSON.stringify(BEFORE)}, after: ${JSON.stringify(AFTER)}, mode: 'inline', context: 1 })`)
    expect(w.diff.mode).toBe('inline')
    // the first line, too short a stretch to fold, then a line of context, the changed line and a line of context
    const rows = [...doc().querySelectorAll('.thimble-diff > .thimble-diff-row')].slice(0, 5)
    expect(rows.map((r) => r.querySelector('.thimble-diff-tx')!.className.replace('thimble-diff-tx ', ''))).toEqual(['thimble-diff-same', 'thimble-diff-same', 'thimble-diff-del', 'thimble-diff-ins', 'thimble-diff-same'])
    expect(rows.map((r) => [...r.querySelectorAll('.thimble-diff-no')].map((n) => n.getAttribute('data-n')))).toEqual([['1', '1'], ['2', '2'], ['3', null], [null, '3'], ['4', '4']])
    // one line of context: notes 1 to 19 fold
    expect(texts('.thimble-diff-gap .thimble-diff-n')).toEqual(['19 unchanged lines'])
    // a page created: every line added, inline even where `auto` would set the versions side by side; the same text:
    // one fold of it all
    const created = w.thimble.diff({ mount: doc().createElement('div'), before: null, after: 'one' })
    expect(created.mode).toBe('inline')
    w.diff.set({ before: null, after: 'one\ntwo\n' })
    expect(texts('.thimble-diff-ins')).toEqual(['one', 'two'])
    expect(w.diff.added).toBe(2)
    expect(w.diff.removed).toBe(0)
    w.diff.set({ before: BEFORE, after: BEFORE, context: 3 })
    expect(w.diff.changes).toBe(0)
    expect(texts('.thimble-diff-gap .thimble-diff-n')).toEqual(['26 unchanged lines'])
    w.diff.set({ before: '', after: '' })
    expect(texts('.thimble-diff-empty')).toEqual(['Both versions are empty'])
    // a diff made again on the same mount takes its place: the one before draws nothing more there
    const again = w.thimble.diff({ mount: '#d', before: 'a', after: 'b', mode: 'inline' })
    w.diff.set({ before: 'x', after: 'y' })
    expect(texts('.thimble-diff-tx')).toEqual(['a', 'b'])
    expect(again.removed).toBe(1)
  })

  test('long texts align quickly: a change in the middle of thousands of lines, and two texts with little in common', async () => {
    await load(`<div id="d"></div>`)
    const w = win()
    const a = Array.from({ length: 6000 }, (_, i) => `line ${i}`)
    const b = a.slice()
    b[3000] = 'line 3000 changed'
    b.splice(4000, 0, 'inserted')
    const t0 = Date.now()
    w.eval(`window.diff = thimble.diff({ mount: '#d', before: ${JSON.stringify(a.join('\n'))}, after: ${JSON.stringify(b.join('\n'))}, mode: 'split' })`)
    expect(w.diff.added).toBe(2)
    expect(w.diff.removed).toBe(1)
    expect(w.diff.changes).toBe(2)
    // most of no line in common past the common ends, too large for the table: unique lines anchor it
    const c = Array.from({ length: 3000 }, (_, i) => `x ${(i * 7) % 3000}`)
    const d = Array.from({ length: 3000 }, (_, i) => `x ${(i * 11) % 3000}`)
    w.diff.set({ before: c.join('\n'), after: d.join('\n') })
    expect(w.diff.added).toBeGreaterThan(0)
    expect(Date.now() - t0).toBeLessThan(8000)
  })
})
