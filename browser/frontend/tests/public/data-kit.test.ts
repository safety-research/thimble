// The view kit's search, table and diff (backend/app/viewer_search.js, viewer_table.js, viewer_diff.js), in a jsdom
// window of their own with the rest of the kit as views.frame_document loads it. Each works alone on plain records, with
// no Color by, time range or side panel: the search finds text case ignored across a record's inline elements and never
// in the kit's own controls, steps through the matches and wraps, finds in a fold it opens, reads the page into an index
// and then only what changed, and steps through every part on screen in order; the table draws only the rows near its
// view, sorts by a click on a column's head with the rows with no value last, hides what Filter by does not keep, gives
// Color by its bars and the counts of every row, opens a row in the side panel, keeps its sort, and writes amounts and
// identifiers each in its own way; the diff aligns the lines, marks the words that changed, folds the unchanged
// stretches, draws side by side or inline, and draws a patch, each file under its head and each hunk numbered from its
// @@ line; the text (viewer_text.js, with the markdown parser of src/lib/kitMarkdown.ts) turns mentions into links that
// open their record, shows raw HTML as text and takes every link's address off. The messages (viewer_messages.js)
// share a head between one author's messages that follow each other within five minutes with the same parent on one
// day, and fold quoted mail and a long body.
// Layout (the highlights, the strip's ticks drawn, the table's rows as it scrolls, the diff's columns, the text's look
// and its quotes) is tests/public/browser/view-data.test.ts and view-text.test.ts, and the messages' is
// tests/public/browser/kit-messages.test.ts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'

const APP = path.resolve(__dirname, '../../../backend/app')
const read = (n: string) => readFileSync(path.join(APP, n), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
// the kit as views.frame_document loads it
const KIT =
  script(read('viewer_bridge.js')) +
  script(`window.__thimbleLabelOrder = ${read('label_order.json')}`) +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_messages.js', 'viewer_search.js', 'viewer_table.js', 'viewer_diff.js', 'viewer_record.js', 'viewer_range.js'].map((n) => script(read(n))).join('')

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
    // and is once it shows: the search hears `hidden` change
    ;(doc().querySelector('#list > p[hidden]') as HTMLElement).hidden = false
    await wait(60)
    expect(w.search.count).toBe(3)
    // typing goes to the first match, opening the fold it is in
    const fold = doc().querySelector('[data-thimble-fold]') as HTMLElement
    fold.hidden = true
    w.opened = undefined
    await type('more gale')
    expect(w.search.at).toBe(0)
    expect(w.opened).toBe(true)
  })

  test("the page read once into an index, then only what changed read again: it finds what a search that reads the page afresh finds", async () => {
    const rec = (i: number, text: string) => `<div class="rec" data-anchor="log.jsonl#L${i}"><b data-thimble-chrome>who ${i}</b> <span>${text}</span></div>`
    await load(`<style>.gone{display:none}</style><div class="top"><span id="search"></span><span id="fresh"></span></div>
<div id="list">${Array.from({ length: 6 }, (_, i) => rec(i + 1, i % 2 ? 'a gale at sea' : 'calm water')).join('')}</div>`)
    const w = win()
    // the elements each read starts from
    w.eval(`
      window.walks = []
      const walker = document.createTreeWalker.bind(document)
      document.createTreeWalker = (root, ...rest) => (window.walks.push(root), walker(root, ...rest))
      window.search = thimble.search({ mount: '#search', in: '#list' })
      window.fresh = thimble.search({ mount: '#fresh', in: '#list' })
    `)
    const list = doc().getElementById('list')!
    const at = (i: number) => doc().querySelector(`[data-anchor="log.jsonl#L${i}"]`) as HTMLElement
    const name = (e: Element) => e.id || e.getAttribute('data-anchor') || e.tagName
    // the search's count of `needle` and the elements it read to find it, beside the count of a search that reads the
    // page whole (refresh)
    const find = (needle: string) => {
      const n = w.walks.length
      w.search.set(needle)
      const read = w.walks.slice(n).map(name)
      w.fresh.refresh()
      w.fresh.set(needle)
      return { count: w.search.count, read, whole: w.fresh.count }
    }
    expect(find('gale')).toEqual({ count: 3, read: ['list'], whole: 3 })
    // found again with nothing read: the index holds the page
    expect(find('calm')).toEqual({ count: 3, read: [], whole: 3 })
    // a record drawn again in its place: that record read
    at(2).replaceWith(Object.assign(doc().createElement('div'), { innerHTML: rec(2, 'a storm, then calm') }).firstChild!)
    expect(find('calm')).toEqual({ count: 4, read: ['log.jsonl#L2'], whole: 4 })
    // a text changed: the record its text runs in
    ;(at(4).querySelector('span')!.firstChild as Text).data = 'calm again'
    expect(find('calm')).toEqual({ count: 5, read: ['log.jsonl#L4'], whole: 5 })
    // a record added, and one taken away, which needs no read
    list.insertAdjacentHTML('beforeend', rec(7, 'calm and a gale'))
    expect(find('gale')).toEqual({ count: 2, read: ['log.jsonl#L7'], whole: 2 })
    at(1).remove()
    expect(find('calm')).toEqual({ count: 5, read: [], whole: 5 })
    // hidden, by the attribute, a class or the label filter: left out
    at(3).hidden = true
    at(5).classList.add('gone')
    at(7).setAttribute('data-thimble-drop', 'hide')
    expect(find('calm')).toEqual({ count: 2, read: ['log.jsonl#L3', 'log.jsonl#L5', 'log.jsonl#L7'], whole: 2 })
    at(5).classList.remove('gone')
    expect(find('calm')).toEqual({ count: 3, read: ['log.jsonl#L5'], whole: 3 })
    // a phrase across an inline element added in the text
    at(4).querySelector('span')!.innerHTML = 'a <i>gale</i> warning'
    expect(find('gale warning')).toEqual({ count: 1, read: ['log.jsonl#L4'], whole: 1 })
    // a block put in between the words splits the phrase, and taken out joins it again: the record they run in read
    const span = at(4).querySelector('span')!
    const block = span.insertBefore(Object.assign(doc().createElement('div'), { textContent: 'storm' }), span.lastChild)
    expect(find('gale warning')).toEqual({ count: 0, read: ['log.jsonl#L4'], whole: 0 })
    block.remove()
    expect(find('gale warning')).toEqual({ count: 1, read: ['log.jsonl#L4'], whole: 1 })
    // the list drawn again whole: the page read again whole
    list.innerHTML = Array.from({ length: 80 }, (_, i) => rec(i + 1, i % 4 ? 'calm' : 'a gale')).join('')
    expect(find('gale')).toEqual({ count: 20, read: ['list'], whole: 20 })
    // typing reads the page a slice at a time once the box has the focus, and finds in what it read
    list.insertAdjacentHTML('afterbegin', rec(0, 'gale force'))
    ;(doc().querySelector('#search .thimble-search-input') as HTMLInputElement).dispatchEvent(new dom.window.FocusEvent('focus'))
    await type('gale f')
    expect(w.search.count).toBe(1)
  })

  test("every part on screen: a table's rows and the messages beside it, in the order they stand, the table's drawn rows counted once; a step goes from the table into the messages", async () => {
    await load(`<div class="top"><span id="search"></span></div><div id="body"><div id="list" style="height:300px"></div><div id="thread"></div></div>`)
    const w = win()
    w.ROWS = [{ ref: 'mail.jsonl#L1', subject: 'gale at noon' }, { ref: 'mail.jsonl#L2', subject: 'calm' }, { ref: 'mail.jsonl#L3', subject: 'a gale' }]
    w.MSGS = [
      { ref: 'chat.jsonl#L1', author: 'ana', text: 'the gale is near', t: T0 },
      { ref: 'chat.jsonl#L2', author: 'bo', text: 'ok', t: T0 + 60 },
      { ref: 'chat.jsonl#L3', author: 'gale', text: 'gale force 8', t: T0 + 120 },
    ]
    w.eval(`
      window.search = thimble.search({ mount: '#search' })
      window.table = thimble.table({ mount: '#list', rows: ROWS, search, columns: [{ name: 'subject', title: 'Subject' }] })
      thimble.messages({ mount: '#thread' }).draw(MSGS)
    `)
    await type('gale')
    // two rows and two messages (not the author's name, the messages' own head)
    expect(w.search.count).toBe(4)
    expect(w.search.at).toBe(0)
    w.search.go(1)
    w.search.step(1)
    expect(w.search.at).toBe(2)
    const sel = w.getSelection()!.getRangeAt(0)
    expect(sel.startContainer.parentElement!.closest('[data-anchor]')!.getAttribute('data-anchor')).toBe('chat.jsonl#L1')
    // a word only the messages hold (each strip's ticks are tests/public/browser/view-data.test.ts)
    await type('near')
    expect([w.search.count, w.search.at]).toEqual([1, 0])
    await type('gale')
    // a new message is found too
    w.eval(`thimble.messages({ mount: '#thread' }).draw(MSGS.concat([{ ref: 'chat.jsonl#L4', author: 'cy', text: 'gale gone', t: ${T0 + 180} }]))`)
    await wait(60)
    expect(w.search.count).toBe(5)
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
    expect(first.hasAttribute('data-color')).toBe(false)
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
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'folder', title: 'Folder' }], initial: 'folder' })
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
    expect(row(0).getAttribute('data-color')).toBe('Inbox')
    expect(row(1).getAttribute('data-color')).toBe('Ops')
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

  test("numbers: amounts with thousands separators, identifiers as they are (type 'id', or a name or title that names one); the search, the side panel, a card and the record viewer find and write an identifier as it is", async () => {
    await load(`<div class="top"><span id="search"></span></div><div id="body" style="height:300px"><div id="list"></div></div><div id="cards"></div><div id="rec"></div>`)
    const w = win()
    w.PRS = [
      { ref: 'forge.db#prs/67028', number: 67028, title: 'Fix the parser', additions: 12345, year: 2024, line: 10234, review: 4501, ratio: 1234.5, parentPRNumber: 66990, lineCount: 23456, turn: 12001 },
      { ref: 'forge.db#prs/9001', number: 9001, title: 'Docs', additions: 7, year: 2023, line: 3, review: 900, ratio: 0.5, parentPRNumber: 8999, lineCount: 12, turn: 3 },
    ]
    w.eval(`
      window.side = thimble.side({ mount: '#body' })
      window.search = thimble.search({ mount: '#search' })
      window.table = thimble.table({ mount: '#list', rows: PRS, side, search, columns: [
        { name: 'number', title: 'PR #', type: 'number' },
        { name: 'title', title: 'Title' },
        { name: 'additions', title: 'Added', type: 'number' },
        { name: 'year', title: 'Year', type: 'number' },
        { name: 'line', title: 'At', type: 'number' },
        { name: 'review', title: 'Review', type: 'id' },
        { name: 'ratio', title: 'Ratio', type: 'number' },
        { name: 'parentPRNumber', type: 'number' },
        { name: 'lineCount', type: 'number' },
        { name: 'turn', title: 'Turn', type: 'number' },
      ] })
      document.getElementById('cards').innerHTML = thimble.recordCard({ ref: PRS[0].ref, key: PRS[0].number, meta: PRS[0].year, title: PRS[0].title })
      thimble.record({ mount: '#rec', value: PRS[0], ref: PRS[0].ref })
    `)
    // a name's last word tells, an acronym's end among its words: parentPRNumber names a pull request, lineCount counts,
    // and a turn is written as the transcript writes its number
    const first = ['67028', 'Fix the parser', '12,345', '2024', '10234', '4501', '1,234.5', '66990', '23,456', '12001']
    expect(texts('.thimble-table-row[data-thimble-row="0"] .thimble-table-td')).toEqual(first)
    // an identifier is laid out and sorted as a number
    expect(doc().querySelector('.thimble-table-row .thimble-table-td')!.classList.contains('thimble-table-number')).toBe(true)
    w.table.sortBy('review', false)
    expect(w.table.rows.map((r: any) => r.review)).toEqual([900, 4501])
    // the search finds it as it is written, in every part on screen: the table's row, the card's key, and the record
    // viewer's number and its ref
    await type('67028')
    expect(w.search.count).toBe(4)
    // the side panel's default details, a card and the record viewer write it alike
    w.table.open('forge.db#prs/67028')
    expect(texts('.thimble-table-fields dd')).toEqual(first)
    expect(texts('#cards .thimble-card-key')).toEqual(['67028'])
    expect(texts('#cards .thimble-card-meta')).toEqual(['2024'])
    // the record viewer writes each value as the record holds it
    expect(texts('#rec .thimble-record-val')).toEqual(expect.arrayContaining(['67028', '12345', '2024', '1234.5']))
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

})

// a change as git writes it: a file changed in two hunks (a removed line that starts with `--` among its lines, the
// last line without a newline), a file renamed with a line changed, a file created, a binary file, and a signature after
// the last hunk, as git format-patch ends a mail
const PATCH = [
  'diff --git a/brindle/parse.py b/brindle/parse.py',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/brindle/parse.py',
  '+++ b/brindle/parse.py',
  '@@ -88,4 +88,4 @@ def next_weekday(start, weekday):',
  '     """The first `weekday` after `start`."""',
  '-    days = (weekday - start.weekday()) % 7',
  '+    days = (weekday - start.weekday() - 1) % 7 + 1',
  '-- a line that starts with two dashes',
  '     return start + timedelta(days=days)',
  '@@ -120,2 +120,3 @@ class Parser:',
  '     def close(self):',
  '-        pass',
  '\\ No newline at end of file',
  '+        self.done = True',
  '+        return self',
  '\\ No newline at end of file',
  'diff --git a/docs/old.md b/docs/new.md',
  'similarity index 90%',
  'rename from docs/old.md',
  'rename to docs/new.md',
  '--- a/docs/old.md',
  '+++ b/docs/new.md',
  '@@ -1 +1 @@',
  '-# Old title',
  '+# New title',
  'diff --git a/tests/test_parse.py b/tests/test_parse.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/tests/test_parse.py',
  '@@ -0,0 +1,2 @@',
  '+def test_next_weekday():',
  '+    assert True',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '-- ',
  '2.44.0',
].join('\n')

describe('the diff of a patch', () => {
  test('each file it names under its head, each hunk under its @@ line, its lines numbered from it; what follows the last hunk left out', async () => {
    await load(`<div id="d"></div>`)
    const w = win()
    w.eval(`window.diff = thimble.diff({ mount: '#d', patch: ${JSON.stringify(PATCH)}, mode: 'inline', ref: 'runs/r1/events.jsonl#L12' })`)
    expect(doc().querySelector('.thimble-diff')!.getAttribute('data-anchor')).toBe('runs/r1/events.jsonl#L12')
    expect(texts('.thimble-diff-path')).toEqual(['brindle/parse.py', 'docs/old.md → docs/new.md', 'tests/test_parse.py', 'logo.png'])
    expect(texts('.thimble-diff-count')).toEqual(['+3 −3', '+1 −1', '+2 −0'])
    expect(texts('.thimble-diff-empty')).toEqual(['Binary file, not shown'])
    // each hunk's line: its range the diff's own wording, its heading the file's text
    expect(texts('.thimble-diff-hunk')).toEqual(['@@ -88,4 +88,4 @@ def next_weekday(start, weekday):', '@@ -120,2 +120,3 @@ class Parser:', '@@ -1 +1 @@', '@@ -0,0 +1,2 @@'])
    expect([...doc().querySelectorAll('.thimble-diff-range')].every((e) => e.hasAttribute('data-thimble-chrome'))).toBe(true)
    expect(doc().querySelector('.thimble-diff-heading')!.hasAttribute('data-thimble-chrome')).toBe(false)
    // the first hunk: numbered from 88 on both sides, the changed line marked word by word, the line that starts with
    // `--` a removed line of its own
    const rows = [...doc().querySelectorAll('.thimble-diff-row')]
    const line = (r: Element) => {
      const tx = r.querySelector('.thimble-diff-tx')!
      return [...r.querySelectorAll('.thimble-diff-no')].map((n) => n.getAttribute('data-n')).concat(tx.className.replace('thimble-diff-tx thimble-diff-', '') + ':' + tx.textContent)
    }
    expect(rows.slice(0, 5).map(line)).toEqual([
      ['88', '88', 'same:    """The first `weekday` after `start`."""'],
      ['89', null, 'del:    days = (weekday - start.weekday()) % 7'],
      [null, '89', 'ins:    days = (weekday - start.weekday() - 1) % 7 + 1'],
      ['90', null, 'del:- a line that starts with two dashes'],
      ['91', '90', 'same:    return start + timedelta(days=days)'],
    ])
    expect(texts('#d ins.thimble-diff-w')[0]).toBe('- 1')
    // the second hunk from 120, its lines without a newline at the end read as lines
    expect(rows.slice(5, 9).map(line)).toEqual([
      ['120', '120', 'same:    def close(self):'],
      ['121', null, 'del:        pass'],
      [null, '121', 'ins:        self.done = True'],
      [null, '122', 'ins:        return self'],
    ])
    // a file created: its lines from 1; the signature is no line of the diff
    expect(rows.slice(-2).map(line)).toEqual([[null, '1', 'ins:def test_next_weekday():'], [null, '2', 'ins:    assert True']])
    expect(doc().querySelector('#d')!.textContent).not.toContain('2.44.0')
    expect([w.diff.added, w.diff.removed, w.diff.changes]).toEqual([6, 4, 4])
  })

})

describe('the text', () => {
  // the kit as views.frame_document loads it, with the markdown parser bundled as vite build bundles it (kit/markdown.js)
  let textKit = ''
  beforeAll(async () => {
    const out = await build({
      entryPoints: [path.resolve(__dirname, '../../src/lib/kitMarkdown.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      logLevel: 'error',
    })
    textKit =
      script(read('viewer_bridge.js')) +
      script(`window.__thimbleLabelOrder = ${read('label_order.json')}`) +
      script(read('viewer_colour.js')) +
      script(read('viewer_controls.js')) +
      script(out.outputFiles[0].text) +
      ['viewer_text.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_search.js', 'viewer_range.js'].map((n) => script(read(n))).join('')
  })
  async function loadText(body = '<div id="t"></div>') {
    dom = new JSDOM(`<!doctype html><html><head>${textKit}</head><body>${body}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
    sent = []
    dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
    await wait()
  }
  /** the text's html drawn in #t, as a page puts it there */
  const drawn = (html: string) => {
    doc().getElementById('t')!.innerHTML = html
    return doc().querySelector('#t > .thimble-text') as HTMLElement
  }
  const links = (root: Element) => [...root.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('data-thimble-ref') ?? a.getAttribute('title'), a.className])

  test('mentions: each match a link that opens its ref, in markdown and plain text; never in code or a link; a ref of null leaves the text', async () => {
    await loadText()
    const w = win()
    w.eval(`window.mentions = [{ match: /#(\\d+)/, ref: (m) => (m[1] === '13' ? null : 'view:forge/pull/' + m[1]) }, { match: /@agent-\\d+/g, ref: (m) => 'view:board/' + m[0].slice(1) }]`)
    const text = 'Fixes #12 and #13, not `#14` or [#15](view:forge/pull/99). Ping @agent-08 about #16.'
    const md = drawn(w.thimble.text.html(text, { mentions: w.mentions }))
    expect(links(md)).toEqual([
      ['#12', 'view:forge/pull/12', 'thimble-text-ref'],
      ['#15', 'view:forge/pull/99', 'thimble-text-ref'],
      ['@agent-08', 'view:board/agent-08', 'thimble-text-ref'],
      ['#16', 'view:forge/pull/16', 'thimble-text-ref'],
    ])
    expect(md.querySelector('code')!.textContent).toBe('#14')
    expect(md.textContent).toBe('Fixes #12 and #13, not #14 or #15. Ping @agent-08 about #16.')
    // a click opens the record, and goes no further: the card the text is in does not open
    let cardClicks = 0
    doc().getElementById('t')!.addEventListener('click', () => cardClicks++)
    ;(md.querySelector('a') as HTMLElement).click()
    expect(of('navigate').map((m) => m.ref)).toEqual(['view:forge/pull/12'])
    expect(cardClicks).toBe(0)
    // Enter on a link opens it too, a link to a keyboard and a screen reader, and the card does not take the key
    let cardKeys = 0
    doc().getElementById('t')!.addEventListener('keydown', () => cardKeys++)
    expect([...md.querySelectorAll('a')].map((a) => [a.getAttribute('role'), a.getAttribute('tabindex')])).toEqual(Array(4).fill(['link', '0']))
    md.querySelectorAll('a')[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(of('navigate').map((m) => m.ref)).toEqual(['view:forge/pull/12', 'view:board/agent-08'])
    expect(cardKeys).toBe(0)
    // plain text: the same links, the backticks as written
    const plain = drawn(w.thimble.text.html(text, { format: 'plain', mentions: w.mentions }))
    expect(links(plain).map((l) => l[0])).toEqual(['#12', '#14', '#15', '@agent-08', '#16'])
    expect(plain.textContent).toBe(text)
  })

  test('escaping: raw HTML shows as text; a ref, an address and an alt are attributes as given; no link keeps its address', async () => {
    await loadText()
    const w = win()
    const raw = '<b onclick="window.pwned = 1">hi</b> & <script>window.pwned = 2</script>\n\n<img src=x onerror="window.pwned = 3">'
    for (const format of ['markdown', 'plain']) {
      const root = drawn(w.thimble.text.html(raw, { format, ref: 'odd "name" <x>.jsonl#L1' }))
      expect(root.querySelectorAll('b, script, img, [onclick], [onerror]').length).toBe(0)
      expect(root.textContent).toContain('<b onclick="window.pwned = 1">hi</b> & <script>window.pwned = 2</script>')
      expect(root.getAttribute('data-anchor')).toBe('odd "name" <x>.jsonl#L1')
    }
    expect(w.pwned).toBeUndefined()
    // links: a URL shows its address and opens nothing, a view's ref and a corpus path open in thimble, read from the
    // folder of the record's file, a place in the text goes there; an image is its alt text
    const md = '[site](https://example.org/a?b=1) [bad](javascript:window.pwned=4) [pr](view:forge/pull/3) [up](../notes/a.md#L2) [top](/docs/b.md) [here](./c%20d.md) www.example.com ![a "harbor"](http://img.example/x.png)[^1]\n\n[^1]: a note'
    const root = drawn(w.thimble.text.html(md, { ref: 'runs/r1/log.jsonl#L5' }))
    expect(root.querySelectorAll('[href], [src], img').length).toBe(0)
    expect(links(root).slice(0, 7)).toEqual([
      ['site', 'https://example.org/a?b=1', 'thimble-text-url'],
      ['bad', 'javascript:window.pwned=4', 'thimble-text-url'],
      ['pr', 'view:forge/pull/3', 'thimble-text-ref'],
      ['up', 'runs/notes/a.md#L2', 'thimble-text-ref'],
      ['top', 'docs/b.md', 'thimble-text-ref'],
      ['here', 'runs/r1/c d.md', 'thimble-text-ref'],
      ['www.example.com', 'http://www.example.com', 'thimble-text-url'],
    ])
    const chip = root.querySelector('.thimble-text-img')!
    expect([chip.className, chip.textContent, chip.getAttribute('title')]).toEqual(['chip chip-sans chip-tone-neutral thimble-text-img', 'a "harbor"', 'http://img.example/x.png'])
    ;(root.querySelectorAll('a')[1] as HTMLElement).click()
    expect(w.pwned).toBeUndefined()
    expect(of('navigate')).toEqual([])
    // the footnote's mark goes to its note, in the text
    expect(root.querySelector('[data-thimble-jump]')!.textContent).toBe('1')
    // a part of a path is decoded before its `..` is taken: an encoded `..` goes up, never past the corpus folder
    const up = drawn(w.thimble.text.html('[esc](%2E%2E/%2E%2E/%2E%2E/x.md) [deep](a/%2e%2e/b%20c.md#L2)', { ref: 'runs/r1/log.jsonl#L5' }))
    expect(links(up)).toEqual([
      ['esc', 'x.md', 'thimble-text-ref'],
      ['deep', 'runs/r1/b c.md#L2', 'thimble-text-ref'],
    ])
  })

})

describe('the messages', () => {
  // 23:30 on Thursday 27 August 2026, so that midnight comes half an hour in
  const T = Date.UTC(2026, 7, 27, 23, 30) / 1000
  const heads = () => [...doc().querySelectorAll('.thimble-msg')].map((e) => [e.getAttribute('data-anchor'), e.classList.contains('is-cont') ? 'same head' : 'head', e.classList.contains('is-reply') ? 'reply' : ''])

  test('the grouping rule: one author, the same parent, within five minutes on one day share a head; anything else starts a new one', async () => {
    await load('<div id="c"></div>')
    const w = win()
    w.eval('window.conv = thimble.messages({ mount: "#c" })')
    w.conv.draw([
      { ref: 'm#1', t: T, author: 'ana', text: 'one' },
      { ref: 'm#2', t: T + 300, author: 'ana', text: 'five minutes on' },
      { ref: 'm#3', t: T + 601, author: 'ana', text: 'five minutes and a second after the one before' },
      { ref: 'm#4', t: T + 610, author: 'bo', text: 'another author' },
      { ref: 'm#5', t: T + 620, author: 'bo', kind: 'event', icon: 'approve', said: 'approved it' },
      { ref: 'm#6', t: T + 630, author: 'bo', text: 'after an event' },
      { ref: 'm#7', t: T + 640, author: 'bo', parent: 'gone#1', text: 'another parent, which is not drawn' },
      { ref: 'm#8', t: T + 650, author: 'bo', parent: 'gone#1', text: 'the same parent' },
      { ref: 'm#9', t: T + 1790, author: 'cy', text: '23:59:50' },
      { ref: 'm#10', t: T + 1810, author: 'cy', text: '00:00:10, another day' },
      { ref: 'm#11', author: 'dee', text: 'no time' },
      { ref: 'm#12', author: 'dee', text: 'no time either' },
    ], { title: '# ferries' })
    expect(heads()).toEqual([
      ['m#1', 'head', ''], ['m#2', 'same head', ''], ['m#3', 'head', ''], ['m#4', 'head', ''], ['m#5', 'head', ''],
      ['m#6', 'head', ''], ['m#7', 'head', ''], ['m#8', 'same head', ''], ['m#9', 'head', ''], ['m#10', 'head', ''],
      ['m#11', 'head', ''], ['m#12', 'same head', ''],
    ])
    // a message under a shared head draws no head and no avatar, but stays its own record with its time
    const second = doc().querySelector('[data-anchor="m#2"]')!
    expect([second.querySelector('.thimble-msg-head'), second.querySelector('.avatar')]).toEqual([null, null])
    expect(second.getAttribute('data-t')).toBe(String(T + 300))
    expect(second.getAttribute('data-anchor-text')).toBe('five minutes on')
    expect(texts('[data-anchor="m#1"] .thimble-msg-head')).toEqual(['ana23:30'])
    expect(doc().querySelector('[data-anchor="m#1"] .thimble-msg-time')!.getAttribute('title')).toBe('2026-08-27 23:30:00')
    // a date line opens each day; the header names the list and counts its messages and events
    expect(texts('.thimble-msg-day')).toEqual(['Thu, Aug 27, 2026', 'Fri, Aug 28, 2026'])
    expect(doc().querySelector('[data-anchor="m#10"]')!.previousElementSibling!.className).toBe('thimble-msg-day')
    expect(texts('.thimble-msg-header')).toEqual(['# ferries11 messages · 1 event'])
    expect([...doc().querySelectorAll('.thimble-msg-header, .thimble-msg-day, .thimble-msg-head')].every((e) => e.hasAttribute('data-thimble-chrome'))).toBe(true)
  })

  test('folds: quoted mail behind "…", a long body behind Show more, their text kept hidden in the page; a pick, set and reveal', async () => {
    await load('<div id="c"></div>')
    const w = win()
    w.picked = []
    w.eval('window.conv = thimble.messages({ mount: "#c", format: "plain", onPick: (m) => window.picked.push(m.ref) })')
    const long = Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\n')
    w.conv.draw([
      { ref: 'q#1', t: T, author: 'Ana Reyes', to: 'Gus Adeyemi', title: 'Re: crossing', text: 'Yes, by Thursday.\n\nOn Tue, Gus Adeyemi wrote:\n> Can you confirm?\n>\n> Thanks' },
      { ref: 'q#2', t: T + 3600, author: 'Gus Adeyemi', text: '> a line quoted with no "wrote:" before it\nstays as it is' },
      { ref: 'q#3', t: T + 7200, author: 'Gus Adeyemi', text: long },
    ])
    const fold = doc().querySelector('[data-anchor="q#1"] .thimble-msg-fold') as HTMLElement
    expect([fold.hidden, fold.hasAttribute('data-thimble-fold'), fold.textContent]).toEqual([true, true, 'On Tue, Gus Adeyemi wrote:\n> Can you confirm?\n>\n> Thanks'])
    expect(texts('[data-anchor="q#1"] .thimble-msg-body > .thimble-msg-text')).toEqual(['Yes, by Thursday.'])
    expect(texts('[data-anchor="q#1"] .thimble-msg-to')).toEqual(['to Gus Adeyemi'])
    expect(texts('[data-anchor="q#1"] .thimble-msg-subject')).toEqual(['Re: crossing'])
    expect(doc().querySelector('[data-anchor="q#2"] .thimble-msg-fold')).toBeNull()
    // the "…" opens the quote and folds it again; it is no pick
    const dots = () => doc().querySelector('[data-anchor="q#1"] .thimble-msg-dots') as HTMLElement
    dots().click()
    expect([(doc().querySelector('[data-anchor="q#1"] .thimble-msg-fold') as HTMLElement).hidden, dots().getAttribute('aria-expanded')]).toEqual([false, 'true'])
    dots().click()
    expect((doc().querySelector('[data-anchor="q#1"] .thimble-msg-fold') as HTMLElement).hidden).toBe(true)
    expect(w.picked).toEqual([])
    // thirty lines: the first eight show, the rest hidden in a fold with Show more under it
    const rest = () => doc().querySelector('[data-anchor="q#3"] .thimble-msg-rest') as HTMLElement | null
    expect([rest()!.hidden, rest()!.hasAttribute('data-thimble-fold')]).toEqual([true, true])
    expect(texts('[data-anchor="q#3"] .thimble-msg-body > .thimble-msg-text')[0].split(' line').length).toBe(8)
    expect(rest()!.textContent).toContain('line 30')
    const more = () => doc().querySelector('[data-anchor="q#3"] .thimble-msg-more') as HTMLElement
    expect([more().textContent, more().getAttribute('aria-expanded')]).toEqual(['Show more', 'false'])
    more().click()
    expect([rest(), more().textContent]).toEqual([null, 'Show less'])
    expect(texts('[data-anchor="q#3"] .thimble-msg-text')).toEqual([long.replace(/\n/g, ' ')])
    more().click()
    expect(rest()!.hidden).toBe(true)
    // the search, or a citation, opens a fold with thimble-unfold
    doc().querySelector('[data-anchor="q#1"] .thimble-msg-fold')!.dispatchEvent(new w.CustomEvent('thimble-unfold', { bubbles: true }))
    expect((doc().querySelector('[data-anchor="q#1"] .thimble-msg-fold') as HTMLElement).hidden).toBe(false)
    // a click on a message picks it, as Enter on it does
    ;(doc().querySelector('[data-anchor="q#2"] .thimble-msg-text') as HTMLElement).click()
    key(doc().querySelector('[data-anchor="q#1"]')!, 'Enter')
    expect(w.picked).toEqual(['q#2', 'q#1'])
    // reveal opens every fold of a message; set gives it its whole text
    expect(w.conv.reveal('q#3')).toBe(true)
    expect([rest(), doc().querySelector('[data-anchor="q#3"]')!.classList.contains('thimble-msg-hit')]).toEqual([null, true])
    expect(w.conv.reveal('nope')).toBe(false)
    w.conv.set('q#2', { text: 'the whole text' })
    expect(texts('[data-anchor="q#2"] .thimble-msg-text')).toEqual(['the whole text'])
  })

})
